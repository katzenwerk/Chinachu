'use strict';

const TS_PACKET_SIZE = 188;
const NULL_PID = 0x1fff;
const REQUIRED_SYNC_PACKETS = 3;
const CC_ERROR_SAMPLE_LIMIT = 10;

function finiteMilliseconds(nanoseconds) {
	return Number(nanoseconds) / 1e6;
}

class TsDropAnalyzer {
	constructor(options) {
		options = options || {};
		this.now = typeof options.now === 'function' ? options.now : Date.now;
		this.hrtime = typeof options.hrtime === 'function' ? options.hrtime : process.hrtime.bigint;
		this.startedAt = this.now();
		this.startedNanoseconds = this.hrtime();
		this.packetTotal = 0;
		this.analyzedBytes = 0;
		this.inputBytes = 0;
		this.nullPackets = 0;
		this.teiPackets = 0;
		this.scrambledPackets = 0;
		this.discontinuityPackets = 0;
		this.duplicatePackets = 0;
		this.invalidHeaderPackets = 0;
		this.ccErrorEvents = 0;
		this.ccErrorsByPid = new Map();
		this.ccErrorSamples = [];
		this.syncErrorEvents = 0;
		this.syncRecoveries = 0;
		this.syncDiscardedBytes = 0;
		this.processingNanoseconds = 0n;
		this.maxChunkProcessingNanoseconds = 0n;
		this.pidState = new Map();
		this.pending = Buffer.alloc(0);
		this.synchronized = false;
		this.searchingAfterLoss = false;
		this.stopped = false;
		this.stopReason = null;
		this.finished = false;
	}

	push(chunk) {
		if (this.stopped || this.finished || chunk === null || typeof chunk === 'undefined') return;
		if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
			throw new TypeError('TS analyzer accepts Buffer or Uint8Array chunks');
		}

		const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		if (input.length === 0) return;
		this.inputBytes += input.length;
		const started = this.hrtime();
		try {
			this._consume(input);
		} finally {
			const elapsed = this.hrtime() - started;
			this.processingNanoseconds += elapsed;
			if (elapsed > this.maxChunkProcessingNanoseconds) this.maxChunkProcessingNanoseconds = elapsed;
		}
	}

	stop(reason) {
		if (!this.stopped) {
			this.stopped = true;
			this.stopReason = String(reason || 'stopped');
		}
		return this.snapshot();
	}

	finish(options) {
		options = options || {};
		this.finished = true;
		if (!this.stopped && options.complete === false) {
			this.stopReason = String(options.reason || 'input-ended-before-analysis-completed');
		}
		return this.snapshot({ requestedComplete: options.complete !== false });
	}

	performance() {
		const wallTimeMs = Math.max(0, finiteMilliseconds(this.hrtime() - this.startedNanoseconds));
		const processingTimeMs = finiteMilliseconds(this.processingNanoseconds);
		return {
			wallTimeMs,
			processingTimeMs,
			maxChunkProcessingMs: finiteMilliseconds(this.maxChunkProcessingNanoseconds),
			processingRatio: wallTimeMs > 0 ? processingTimeMs / wallTimeMs : 0
		};
	}

	snapshot(options) {
		options = options || {};
		const performance = this.performance();
		const requestedComplete = options.requestedComplete !== false;
		const trailingBytes = this.pending.length;
		const complete = this.finished && requestedComplete && !this.stopped &&
			this.packetTotal > 0 && trailingBytes === 0;
		const stopReason = complete ? null : this.stopReason ||
			(this.finished && requestedComplete && this.packetTotal === 0 ? 'no-ts-packets' :
				trailingBytes > 0 ? 'trailing-or-unsynchronized-bytes' : null);
		return {
			schemaVersion: 1,
			source: 'operator-ts',
			packetSize: TS_PACKET_SIZE,
			startedAt: new Date(this.startedAt).toISOString(),
			checkedAt: new Date(this.now()).toISOString(),
			completed: complete,
			stopReason,
			inputBytes: this.inputBytes,
			analyzedBytes: this.analyzedBytes,
			packetTotal: this.packetTotal,
			ccErrorEvents: this.ccErrorEvents,
			ccErrorsByPid: Object.fromEntries(Array.from(this.ccErrorsByPid.entries()).map(([pid, count]) => [String(pid), count])),
			ccErrorSampleLimit: CC_ERROR_SAMPLE_LIMIT,
			ccErrorSamples: this.ccErrorSamples.map(sample => ({ ...sample })),
			ccErrorSamplesTruncated: this.ccErrorEvents > this.ccErrorSamples.length,
			teiPackets: this.teiPackets,
			scrambledPackets: this.scrambledPackets,
			nullPackets: this.nullPackets,
			discontinuityPackets: this.discontinuityPackets,
			duplicatePackets: this.duplicatePackets,
			invalidHeaderPackets: this.invalidHeaderPackets,
			syncErrorEvents: this.syncErrorEvents,
			syncRecoveries: this.syncRecoveries,
			syncDiscardedBytes: this.syncDiscardedBytes,
			trailingBytes,
			processingTimeMs: performance.processingTimeMs,
			maxChunkProcessingMs: performance.maxChunkProcessingMs,
			wallTimeMs: performance.wallTimeMs,
			processingRatio: performance.processingRatio
		};
	}

	_consume(chunk) {
		const data = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
		let offset = 0;
		this.pending = Buffer.alloc(0);

		while (offset < data.length) {
			if (!this.synchronized) {
				const syncOffset = this._findSyncOffset(data, offset);
				if (syncOffset === -1) {
					const remaining = data.length - offset;
					const keep = Math.min(remaining, TS_PACKET_SIZE * (REQUIRED_SYNC_PACKETS - 1));
					const discarded = remaining - keep;
					if (discarded > 0) this._recordSyncLoss(discarded);
					this.pending = Buffer.from(data.subarray(data.length - keep));
					return;
				}
				if (syncOffset > offset) this._recordSyncLoss(syncOffset - offset);
				if (this.searchingAfterLoss) this.syncRecoveries++;
				this.searchingAfterLoss = false;
				this.synchronized = true;
				offset = syncOffset;
			}

			if (data.length - offset < TS_PACKET_SIZE) break;
			if (data[offset] !== 0x47) {
				this._recordSyncLoss(1);
				this.synchronized = false;
				this.pidState.clear();
				offset++;
				continue;
			}

			this._parsePacket(data.subarray(offset, offset + TS_PACKET_SIZE));
			offset += TS_PACKET_SIZE;
		}

		if (offset < data.length) this.pending = Buffer.from(data.subarray(offset));
	}

	_findSyncOffset(data, start) {
		const last = data.length - TS_PACKET_SIZE * (REQUIRED_SYNC_PACKETS - 1);
		for (let offset = start; offset < last; offset++) {
			if (data[offset] === 0x47 && data[offset + TS_PACKET_SIZE] === 0x47 &&
				data[offset + TS_PACKET_SIZE * 2] === 0x47) return offset;
		}
		return -1;
	}

	_recordSyncLoss(bytes) {
		if (!this.searchingAfterLoss) this.syncErrorEvents++;
		this.searchingAfterLoss = true;
		this.syncDiscardedBytes += bytes;
	}

	_recordCcError(pid, previousCc, expectedCc, actualCc) {
		this.ccErrorEvents++;
		this.ccErrorsByPid.set(pid, (this.ccErrorsByPid.get(pid) || 0) + 1);
		if (this.ccErrorSamples.length >= CC_ERROR_SAMPLE_LIMIT) return;

		const observedAt = this.now();
		this.ccErrorSamples.push({
			observedAt: new Date(observedAt).toISOString(),
			elapsedMs: Math.max(0, observedAt - this.startedAt),
			pid,
			previousCc,
			expectedCc,
			actualCc,
			deltaMod16: (actualCc - expectedCc + 16) & 0x0f
		});
	}

	_parsePacket(packet) {
		this.packetTotal++;
		this.analyzedBytes += TS_PACKET_SIZE;

		const tei = (packet[1] & 0x80) !== 0;
		const pid = ((packet[1] & 0x1f) << 8) | packet[2];
		const scrambling = (packet[3] >> 6) & 0x03;
		const adaptationControl = (packet[3] >> 4) & 0x03;
		const continuityCounter = packet[3] & 0x0f;
		const hasAdaptation = adaptationControl === 2 || adaptationControl === 3;
		const hasPayload = adaptationControl === 1 || adaptationControl === 3;
		let discontinuity = false;

		if (tei) this.teiPackets++;
		if (scrambling !== 0) this.scrambledPackets++;
		if (pid === NULL_PID) {
			this.nullPackets++;
			return;
		}
		if (adaptationControl === 0) {
			this.invalidHeaderPackets++;
			this.pidState.delete(pid);
			return;
		}
		if (hasAdaptation) {
			const adaptationLength = packet[4];
			if (5 + adaptationLength > TS_PACKET_SIZE || (adaptationControl === 3 && adaptationLength > 182)) {
				this.invalidHeaderPackets++;
				this.pidState.delete(pid);
				return;
			}
			discontinuity = adaptationLength > 0 && (packet[5] & 0x80) !== 0;
		}
		if (tei) {
			this.pidState.delete(pid);
			return;
		}
		if (discontinuity) {
			this.discontinuityPackets++;
			this.pidState.delete(pid);
			this.pidState.set(pid, { continuityCounter, hasPayload });
			return;
		}

		const previous = this.pidState.get(pid);
		if (previous) {
			const expected = hasPayload ? (previous.continuityCounter + 1) & 0x0f : previous.continuityCounter;
			if (hasPayload && previous.hasPayload && continuityCounter === previous.continuityCounter) {
				this.duplicatePackets++;
			} else if (continuityCounter !== expected) {
				this._recordCcError(pid, previous.continuityCounter, expected, continuityCounter);
			}
		}
		this.pidState.set(pid, { continuityCounter, hasPayload });
	}
}

module.exports = {
	NULL_PID,
	TS_PACKET_SIZE,
	TsDropAnalyzer
};
