'use strict';

// Read-only PCR/TOT observation for a saved 188-byte ARIB MPEG-TS stream.
// PCR discontinuities are *candidates* for lost time, not proof of lost video.

const PCR_MODULUS = 2 ** 33 * 300;
const PCR_HZ = 27000000;
const MJD_UNIX_ORIGIN_MS = Date.UTC(1858, 10, 17);

function crc32Mpeg(section) {
  let crc = 0xffffffff;
  for (const byte of section) {
    crc = (crc ^ (byte << 24)) >>> 0;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    }
  }
  return crc >>> 0;
}

function bcd(byte) {
  const tens = byte >> 4;
  const ones = byte & 0x0f;
  return tens <= 9 && ones <= 9 ? tens * 10 + ones : null;
}

function parseTot(section) {
  if (section.length < 14 || section[0] !== 0x73 || (section[1] & 0x80)) return null;
  const sectionLength = ((section[1] & 0x0f) << 8) | section[2];
  if (section.length !== sectionLength + 3 || sectionLength < 11) return null;
  const descriptorLength = ((section[8] & 0x0f) << 8) | section[9];
  if (descriptorLength + 14 !== section.length || crc32Mpeg(section) !== 0) return null;
  const mjd = (section[3] << 8) | section[4];
  const hours = bcd(section[5]);
  const minutes = bcd(section[6]);
  const seconds = bcd(section[7]);
  if (hours === null || minutes === null || seconds === null ||
      hours > 23 || minutes > 59 || seconds > 59) return null;
  // ARIB STD-B10 TOT carries a JST calendar, unlike DVB's UTC naming.
  // Store its calendar fields as a UTC-shaped number purely for formatting.
  // Do NOT add UTC+9 again when displaying.
  return MJD_UNIX_ORIGIN_MS + mjd * 86400000 +
    hours * 3600000 + minutes * 60000 + seconds * 1000;
}

function formatJst(jstCalendarMs) {
  if (jstCalendarMs === null || !Number.isFinite(jstCalendarMs)) return '-';
  return new Date(jstCalendarMs).toISOString().slice(0, 19).replace('T', ' ').replace(/-/g, '/');
}

function formatPCR(milliseconds) {
  if (milliseconds === null || !Number.isFinite(milliseconds) || milliseconds < 0) return '-';
  const ms = Math.floor(milliseconds);
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor(ms / 60000) % 60;
  const seconds = Math.floor(ms / 1000) % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

class BroadcastClock {
  constructor(options = {}) {
    this.pcrPid = options.pcrPid ?? null;
    this.onPcrGap = options.onPcrGap || (() => {});
    this.gapThresholdMs = options.gapThresholdMs ?? 2000;
    this.pcrSamples = 0;
    this.latestPcrMs = null;
    this.segment = 1;
    this.lastPcrTicks = null;
    this.lastPcrOffset = null;
    this.pendingExplicitReset = false;
    this.pcrGaps = 0;
    this.pcrLowDataGaps = 0;
    this.pcrResets = 0;
    this.pcrExplicitResets = 0;
    this.pcrBackwards = 0;
    this.normalRates = [];
    this.rateCursor = 0;
    this.totJstMs = null;
    this.totValidSections = 0;
    this.totPending = Buffer.alloc(0);
    this.lastTotCc = null;
  }

  observe(packet, fileOffset) {
    const pid = ((packet[1] & 0x1f) << 8) | packet[2];
    const afc = (packet[3] >> 4) & 3;
    if ((packet[1] & 0x80) || afc === 0) {
      if (pid === 0x14) this.totPending = Buffer.alloc(0);
      return;
    }
    if (afc === 2 || afc === 3) {
      const length = packet[4];
      const valid = length <= (afc === 3 ? 182 : 183);
      if (valid && length >= 1) {
        const flags = packet[5];
        if ((flags & 0x80) && pid === this.pcrPid) this.pendingExplicitReset = true;
        if (length >= 7 && (flags & 0x10)) {
          this.observePcr(packet, pid, fileOffset);
        }
      }
    }
    if (pid === 0x14 && (afc === 1 || afc === 3)) this.observeTotPacket(packet, afc);
  }

  observePcr(packet, pid, offset) {
    if (this.pcrPid !== null && pid !== this.pcrPid) return;
    const base = packet[6] * 2 ** 25 + packet[7] * 2 ** 17 +
      packet[8] * 2 ** 9 + packet[9] * 2 + (packet[10] >> 7);
    const ext = ((packet[10] & 1) << 8) | packet[11];
    if (ext >= 300) return;
    const ticks = base * 300 + ext;
    if (this.pcrPid === null) this.pcrPid = pid;
    this.pcrSamples++;

    if (this.lastPcrTicks === null) {
      this.lastPcrTicks = ticks;
      this.lastPcrOffset = offset;
      this.latestPcrMs = 0;
      this.pendingExplicitReset = false;
      return;
    }
    let tickDiff = ticks - this.lastPcrTicks;
    if (tickDiff < -PCR_MODULUS / 2) tickDiff += PCR_MODULUS;
    else if (tickDiff > PCR_MODULUS / 2) tickDiff -= PCR_MODULUS;
    const diffMs = tickDiff * 1000 / PCR_HZ;
    const bytesBetween = offset - this.lastPcrOffset;

    if (this.pendingExplicitReset || diffMs < 0) {
      this.pcrResets++;
      if (this.pendingExplicitReset) this.pcrExplicitResets++;
      else this.pcrBackwards++;
      // Do not stitch unrelated clock epochs into one artificial duration.
      this.segment++;
      this.latestPcrMs = 0;
      this.normalRates = [];
      this.rateCursor = 0;
      this.pendingExplicitReset = false;
    } else {
      const beforeMs = this.latestPcrMs;
      const expectedRate = this.normalRates.length >= 6 ? median(this.normalRates) : null;
      const observedRate = diffMs > 0 ? bytesBetween * 1000 / diffMs : null;
      this.latestPcrMs += diffMs;
      if (diffMs >= this.gapThresholdMs) {
        this.pcrGaps++;
        const ratio = expectedRate && observedRate !== null ? observedRate / expectedRate : null;
        // A low data-rate ratio makes the candidate stronger, but neither
        // ratio nor PCR alone proves that pictures/audio frames are missing.
        if (ratio !== null && ratio < 0.25) this.pcrLowDataGaps++;
        this.onPcrGap({ pid, segment: this.segment, deltaMs: diffMs,
          beforeMs, afterMs: this.latestPcrMs,
          fromOffset: this.lastPcrOffset, toOffset: offset, bytesBetween,
          apparentMbps: observedRate === null ? null : observedRate * 8 / 1e6,
          normalMbps: expectedRate === null ? null : expectedRate * 8 / 1e6,
          rateRatio: ratio, lowData: ratio !== null && ratio < 0.25,
          totJstMs: this.totJstMs });
      } else if (diffMs >= 10 && diffMs <= 1000 && bytesBetween > 0 && observedRate > 0) {
        // Learn the usual aggregate TS byte rate from *normal* PCR steps only.
        if (this.normalRates.length < 32) this.normalRates.push(observedRate);
        else { this.normalRates[this.rateCursor] = observedRate; this.rateCursor = (this.rateCursor + 1) % 32; }
      }
    }
    this.lastPcrTicks = ticks;
    this.lastPcrOffset = offset;
  }

  observeTotPacket(packet, afc) {
    const payloadOffset = afc === 3 ? 5 + packet[4] : 4;
    if (payloadOffset >= 188) return;
    const cc = packet[3] & 15;
    const start = !!(packet[1] & 0x40);
    if (this.lastTotCc !== null && cc !== ((this.lastTotCc + 1) & 0x0f) && cc !== this.lastTotCc) {
      this.totPending = Buffer.alloc(0);
    }
    this.lastTotCc = cc;
    if (start) {
      const pointer = packet[payloadOffset];
      const sectionOffset = payloadOffset + 1 + pointer;
      if (sectionOffset > 188) { this.totPending = Buffer.alloc(0); return; }
      if (this.totPending.length > 0 && pointer > 0) {
        this.appendTotBytes(packet.subarray(payloadOffset + 1, sectionOffset));
      }
      this.totPending = Buffer.alloc(0);
      this.appendTotBytes(packet.subarray(sectionOffset));
    } else if (this.totPending.length > 0) {
      this.appendTotBytes(packet.subarray(payloadOffset));
    }
  }

  appendTotBytes(bytes) {
    if (bytes.length === 0) return;
    this.totPending = this.totPending.length ? Buffer.concat([this.totPending, bytes]) : Buffer.from(bytes);
    while (this.totPending.length >= 3) {
      if (this.totPending[0] === 0xff) { this.totPending = Buffer.alloc(0); return; }
      const len = ((this.totPending[1] & 0x0f) << 8) | this.totPending[2];
      if (len < 5 || len > 1021) { this.totPending = Buffer.alloc(0); return; }
      const total = len + 3;
      if (this.totPending.length < total) return;
      const section = this.totPending.subarray(0, total);
      const value = parseTot(section);
      if (value !== null) { this.totJstMs = value; this.totValidSections++; }
      this.totPending = Buffer.from(this.totPending.subarray(total));
    }
  }
}

module.exports = { BroadcastClock, formatPCR, formatJst };
