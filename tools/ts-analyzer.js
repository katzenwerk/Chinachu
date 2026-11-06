#!/usr/bin/env node
'use strict';

// Offline, read-only tool. The current Chinachu TS parser is loaded directly;
// supplemental CC-repeat validation and PCR-gap inspection live only here.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { BroadcastClock, formatPCR, formatJst } = require('./ts-time-reader');

const READ_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_CC_SAMPLES = 20;
const MAX_GAP_SAMPLES = 100;
const NULL_PID = 0x1fff;

const hexPid = value => `0x${value.toString(16).toUpperCase().padStart(4, '0')}`;
const hexOffset = value => `0x${value.toString(16).toUpperCase()}`;
const shortNumber = value => value === null ? '-' : value.toFixed(3);

function usage() {
  console.log(`Usage:
  ./tools/ts-analyzer [--analyzer PATH] [--pcr-gap-ms 2000] FILE.ts [MORE.ts ...]
  ./tools/ts-analyzer [--analyzer PATH] --summary --dir DIRECTORY
  ./tools/ts-analyzer [--analyzer PATH] --events FILE.ts
  ./tools/ts-analyzer [--analyzer PATH] --json FILE.ts

Options:
  --analyzer PATH       Path to lib/ts-drop-analyzer.js
  --dir DIRECTORY       Scan regular .ts files immediately inside directory (no recursion)
  --summary             One result line per file; no event timeline
  --events              Show legacy one-line CC/PCR events
  --json                JSON Lines, including first 20 CC and 100 PCR-gap samples
  --pcr-gap-ms N        Report adjacent-PCR jumps >= N ms (default 2000)
  --pcr-pid PID         Select PCR PID explicitly (e.g. 0x0140), otherwise first observed
  --help                Print this help

This is a standalone read-only tool: input files are only read, never modified.
PCR gaps are candidates for missing timeline data, not proof of dropped video.`);
}

function parseArgs(argv) {
  const opts = { analyzer: null, dirs: [], files: [],
    summary: false, events: false, json: false, progress: false, gapThresholdMs: 2000, pcrPid: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--progress') { opts.progress = true; continue; }
    if (arg === '--summary') { opts.summary = true; continue; }
    if (arg === '--events' || arg === '--verbose') { opts.events = true; continue; }
    if (['--analyzer', '--dir', '--pcr-gap-ms', '--pcr-pid'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--analyzer') opts.analyzer = value;
      else if (arg === '--dir') opts.dirs.push(value);
      else if (arg === '--pcr-gap-ms') {
        const milliseconds = Number(value);
        if (!Number.isInteger(milliseconds) || milliseconds < 100 || milliseconds > 60000) {
          throw new Error('--pcr-gap-ms must be an integer from 100 to 60000');
        }
        opts.gapThresholdMs = milliseconds;
      } else {
        const pid = /^0x[0-9a-f]+$/i.test(value) ? parseInt(value, 16) :
          /^\d+$/.test(value) ? Number(value) : NaN;
        if (!Number.isInteger(pid) || pid < 0 || pid >= NULL_PID) {
          throw new Error('--pcr-pid must be between 0 and 0x1FFE');
        }
        opts.pcrPid = pid;
      }
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    opts.files.push(arg);
  }
  if (Number(opts.json) + Number(opts.summary) + Number(opts.events) > 1) {
    throw new Error('--json, --summary and --events cannot be combined');
  }
  if (!opts.files.length && !opts.dirs.length) throw new Error('Specify a .ts file or --dir.');
  return opts;
}

function locateAnalyzer(explicitPath) {
  const paths = explicitPath ? [explicitPath] : [
    path.join(process.cwd(), 'lib/ts-drop-analyzer.js'),
    path.join(__dirname, '../lib/ts-drop-analyzer.js'),
    ...(process.env.CHINACHU_HOME ? [path.join(process.env.CHINACHU_HOME, 'lib/ts-drop-analyzer.js')] : []),
    ...(process.env.HOME ? [path.join(process.env.HOME, 'Chinachu/lib/ts-drop-analyzer.js')] : [])
  ];
  for (const filename of paths) {
    const resolved = path.resolve(filename);
    try { if (fs.statSync(resolved).isFile()) return resolved; }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  throw new Error('Cannot find lib/ts-drop-analyzer.js; use --analyzer /path/to/file.js');
}

function gitBlobSha(filename) {
  const bytes = fs.readFileSync(filename);
  return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

async function collectTargets(opts) {
  const list = [];
  const seen = new Set();
  function add(value) {
    const resolved = path.resolve(value);
    if (!seen.has(resolved)) { seen.add(resolved); list.push(resolved); }
  }
  opts.files.forEach(add);
  for (const dirname of opts.dirs) {
    const entries = await fs.promises.readdir(path.resolve(dirname), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'ja'))) {
      if (entry.isFile() && /\.ts$/i.test(entry.name)) add(path.join(dirname, entry.name));
    }
  }
  return list;
}

function samePacketExceptPcr(previous, current) {
  if (previous.equals(current)) return true;
  // H.222.0 permits a PCR value to change in an otherwise identical repeated packet.
  const pA = (previous[3] >> 4) & 3;
  const pB = (current[3] >> 4) & 3;
  if ((pA !== 2 && pA !== 3) || pA !== pB ||
      previous[4] < 7 || current[4] < 7 ||
      !(previous[5] & 0x10) || !(current[5] & 0x10)) return false;
  return previous.subarray(0, 6).equals(current.subarray(0, 6)) &&
    previous.subarray(12).equals(current.subarray(12));
}

function makeFileAnalyzer(BaseAnalyzer, emit, opts) {
  return class FileAnalyzer extends BaseAnalyzer {
    constructor() {
      super();
      this.clock = new BroadcastClock({
        pcrPid: opts.pcrPid, gapThresholdMs: opts.gapThresholdMs,
        onPcrGap: event => this.recordPcrGap(event)
      });
      this.pidPackets = new Uint32Array(8192);
      this.pidLastCc = new Uint8Array(8192);
      this.pidSeen = new Uint8Array(8192);
      this.pidOrder = [];
      this.previousPacketByPid = new Map();
      this.sameCcRunByPid = new Uint16Array(8192);
      this.currentOffset = 0;
      this.ccFileSamples = [];
      this.ccKinds = { 'counter-jump': 0, 'repeat-changed': 0, 'repeat-excess': 0 };
      this.gapSamples = [];
      this.emit = emit;
    }

    _parsePacket(packet, offset = 0) {
      // The engine supplies a chunk plus packet offset; this offline extension
      // also supports engines that supplied an individual packet Buffer.
      packet = packet.subarray(offset, offset + 188);
      this.currentOffset = this.analyzedBytes + this.syncDiscardedBytes;
      const pid = ((packet[1] & 0x1f) << 8) | packet[2];
      const cc = packet[3] & 15;
      const afc = (packet[3] >> 4) & 3;
      const hasPayload = afc === 1 || afc === 3;
      const valid = afc !== 0 &&
        !(packet[1] & 0x80) &&
        (afc !== 3 || packet[4] <= 182) &&
        (afc !== 2 || packet[4] <= 183);
      const explicitDiscontinuity = (afc === 2 || afc === 3) &&
        packet[4] > 0 && (packet[5] & 0x80);
      const prevState = this.pidState.get(pid);
      const prevPacket = this.previousPacketByPid.get(pid);
      const sameCc = pid !== NULL_PID && valid && hasPayload &&
        !explicitDiscontinuity && prevState?.hasPayload &&
        prevState.continuityCounter === cc && prevPacket;

      if (pid !== NULL_PID) {
        if (!this.pidSeen[pid]) { this.pidSeen[pid] = 1; this.pidOrder.push(pid); }
        this.pidPackets[pid]++;
        this.pidLastCc[pid] = cc;
      }
      this.clock.observe(packet, this.currentOffset);
      const duplicatesBefore = this.duplicatePackets;
      super._parsePacket(packet);

      if (sameCc && this.duplicatePackets > duplicatesBefore) {
        const equivalent = samePacketExceptPcr(prevPacket, packet);
        const excessive = this.sameCcRunByPid[pid] >= 1;
        if (!equivalent || excessive) {
          // thorn.31 counts every unchanged CC as a duplicate, even with
          // changed bytes. Replace that classification, without editing it.
          this.duplicatePackets--;
          this._recordCcError(pid, cc, (cc + 1) & 15, cc,
            equivalent ? 'repeat-excess' : 'repeat-changed');
        }
        this.sameCcRunByPid[pid] = Math.min(65535, this.sameCcRunByPid[pid] + 1);
      } else if (pid !== NULL_PID) {
        this.sameCcRunByPid[pid] = 0;
      }

      if (pid !== NULL_PID && valid && !explicitDiscontinuity) {
        const buffer = prevPacket || Buffer.allocUnsafe(188);
        packet.copy(buffer);
        if (!prevPacket) this.previousPacketByPid.set(pid, buffer);
      }
    }

    _recordCcError(pid, previousCc, expectedCc, actualCc, kind = 'counter-jump') {
      super._recordCcError(pid, previousCc, expectedCc, actualCc);
      this.ccKinds[kind]++;
      const occurrence = this.ccErrorsByPid.get(pid);
      const event = {
        byteOffset: this.currentOffset, pid, occurrence, kind,
        previousCc, expectedCc, actualCc,
        pcr: formatPCR(this.clock.latestPcrMs),
        tot: formatJst(this.clock.totJstMs)
      };
      if (this.ccFileSamples.length < MAX_CC_SAMPLES) this.ccFileSamples.push(event);
      this.emit({ type: 'cc', ...event });
    }

    recordPcrGap(event) {
      const sample = {
        ...event,
        pid: hexPid(event.pid),
        fromPcr: formatPCR(event.beforeMs),
        toPcr: formatPCR(event.afterMs),
        fromOffsetHex: hexOffset(event.fromOffset),
        toOffsetHex: hexOffset(event.toOffset),
        tot: formatJst(event.totJstMs)
      };
      delete sample.totJstMs;
      if (this.gapSamples.length < MAX_GAP_SAMPLES) this.gapSamples.push(sample);
      this.emit({ type: 'gap', ...sample });
    }

    _recordSyncLoss(bytes) {
      if (!this.searchingAfterLoss) {
        this.emit({ type: 'sync', byteOffset: this.analyzedBytes + this.syncDiscardedBytes,
          pcr: formatPCR(this.clock.latestPcrMs), tot: formatJst(this.clock.totJstMs) });
      }
      return super._recordSyncLoss(bytes);
    }
  };
}

// Chronological display follows packet/file order, not PCR sorting.
// The detail event is emitted as soon as the input chunk is analyzed.
const CC_LABELS = {
  'counter-jump': '番号飛び',
  'repeat-changed': '同一CC・内容違い',
  'repeat-excess': '重複過多'
};

function formatLegacyEvent(event) {
  if (event.type === 'cc') {
    return [`CC : PID ${hexPid(event.pid)} , ${event.occurrence} Event , PCR ${event.pcr} , ` +
      `TOT ${event.tot} , +${hexOffset(event.byteOffset)} , KIND ${event.kind}`];
  }
  if (event.type === 'gap') {
    return [`PCR_GAP? PID ${event.pid} , ${event.fromPcr} -> ${event.toPcr}` +
      ` , DELTA ${(event.deltaMs / 1000).toFixed(3)}s` +
      ` , BYTES ${event.bytesBetween} , ${event.fromOffsetHex} -> ${event.toOffsetHex}` +
      ` , RATE ${event.rateRatio === null ? 'unknown' : (event.rateRatio * 100).toFixed(1) + '% of baseline'}` +
      ` , LOW_DATA ${event.lowData ? 'yes' : 'unconfirmed'} , TOT ${event.tot}`];
  }
  return [`SYNC : offset +${hexOffset(event.byteOffset)} , loss`];
}

function formatTimelineEvent(event, state) {
  const lines = [];
  // TOT is held until a newer valid section arrives; print only on change.
  // This avoids repeating the same last-observed clock value on each CC row.
  if (event.tot && event.tot !== '-' && event.tot !== state.lastTot) {
    if (state.lastTot !== null) lines.push('');
    lines.push(`  --- TOT ${event.tot} (直近の受信値) ---`);
    state.lastTot = event.tot;
  }
  if (event.type === 'cc') {
    lines.push(`  ${event.pcr.padEnd(13)} CC    ${hexPid(event.pid)}  ` +
      `${String(event.occurrence).padStart(2)}回目  ` +
      `+${hexOffset(event.byteOffset).padEnd(12)} ${CC_LABELS[event.kind] || event.kind}`);
  } else if (event.type === 'gap') {
    const ratio = event.rateRatio === null ? '-' : `${(event.rateRatio * 100).toFixed(1)}%`;
    const lowData = event.lowData ? 'データ量低下の疑い' : 'データ量低下は未確認';
    lines.push('');
    lines.push(`  >>> PCR時間飛び  ${event.fromPcr} -> ${event.toPcr}  (+${(event.deltaMs / 1000).toFixed(3)}秒)`);
    lines.push(`      ${lowData} / 通常区間比 ${ratio} / PCR PID ${event.pid}`);
    lines.push(`      位置 ${event.fromOffsetHex} -> ${event.toOffsetHex}  (${event.bytesBetween.toLocaleString('en-US')} bytes)`);
    lines.push('');
  } else if (event.type === 'sync') {
    lines.push(`  ${event.pcr.padEnd(13)} SYNC  -       -    +${hexOffset(event.byteOffset)}  同期異常`);
  }
  return lines;
}

async function inspectFile(filename, BaseAnalyzer, opts, displayMode) {
  const stat = await fs.promises.lstat(filename);
  if (!stat.isFile()) throw new Error('Not a regular file; symbolic links are not followed');
  const eventBuffer = [];
  const timelineState = { lastTot: null, eventCount: 0 };
  const Analyzer = makeFileAnalyzer(BaseAnalyzer, displayMode ? event => eventBuffer.push(event) : () => {}, opts);
  const analyzer = new Analyzer();
  const start = performance.now();
  const stream = fs.createReadStream(filename, { highWaterMark: READ_CHUNK_BYTES });
  let reportedBytes = 0;
  let reportedAt = 0;
  let readBytes = 0;
  try {
    for await (const chunk of stream) {
      analyzer.push(chunk);
      readBytes += chunk.length;
      const now = performance.now();
      if (opts.progress && readBytes - reportedBytes >= 32 * 1024 * 1024 && now - reportedAt >= 1000) {
        process.stderr.write(`TS_PROGRESS ${readBytes}\n`);
        reportedBytes = readBytes;
        reportedAt = now;
      }
      if (eventBuffer.length) {
        const lines = [];
        for (const event of eventBuffer) {
          timelineState.eventCount++;
          lines.push(...(displayMode === 'legacy' ? formatLegacyEvent(event) :
            formatTimelineEvent(event, timelineState)));
        }
        process.stdout.write(lines.join('\n') + '\n');
        eventBuffer.length = 0;
      }
    }
  } catch (err) {
    stream.destroy();
    throw err;
  }
  if (displayMode === 'timeline' && !timelineState.eventCount) {
    console.log('  表示対象の異常イベントなし');
  }
  if (opts.progress) process.stderr.write(`TS_PROGRESS ${readBytes}\n`);
  const parsed = analyzer.finish();
  const elapsedMs = performance.now() - start;
  const pidSummary = analyzer.pidOrder.map(pid => ({
    pid: hexPid(pid), lastCc: `0x${analyzer.pidLastCc[pid].toString(16).toUpperCase().padStart(2, '0')}`,
    events: parsed.ccErrorsByPid[String(pid)] || 0,
    packets: analyzer.pidPackets[pid]
  }));
  const suspect = parsed.ccErrorEvents || parsed.teiPackets || parsed.syncErrorEvents ||
    parsed.invalidHeaderPackets || analyzer.clock.pcrGaps || analyzer.clock.pcrBackwards;
  return {
    file: filename,
    status: !parsed.completed ? 'INCOMPLETE' : suspect ? 'SUSPECT' : 'NO_FINDINGS',
    completed: parsed.completed, stopReason: parsed.stopReason,
    fileSizeBytes: stat.size, inputBytes: parsed.inputBytes, packetTotal: parsed.packetTotal,
    ccErrorEvents: parsed.ccErrorEvents, ccErrorsByPid: parsed.ccErrorsByPid,
    ccKinds: analyzer.ccKinds, ccSamples: analyzer.ccFileSamples,
    ccSamplesTruncated: parsed.ccErrorEvents > MAX_CC_SAMPLES,
    duplicatePackets: parsed.duplicatePackets,
    teiPackets: parsed.teiPackets,
    syncErrorEvents: parsed.syncErrorEvents,
    syncDiscardedBytes: parsed.syncDiscardedBytes,
    invalidHeaderPackets: parsed.invalidHeaderPackets,
    discontinuityPackets: parsed.discontinuityPackets,
    trailingBytes: parsed.trailingBytes,
    pcrPid: analyzer.clock.pcrSamples ? hexPid(analyzer.clock.pcrPid) : null,
    pcrSamples: analyzer.clock.pcrSamples,
    pcrGapThresholdMs: opts.gapThresholdMs,
    pcrGapEvents: analyzer.clock.pcrGaps,
    pcrLowDataGapEvents: analyzer.clock.pcrLowDataGaps,
    pcrResets: analyzer.clock.pcrResets,
    pcrExplicitResets: analyzer.clock.pcrExplicitResets,
    pcrBackwards: analyzer.clock.pcrBackwards,
    pcrGapSamples: analyzer.gapSamples,
    pcrGapSamplesTruncated: analyzer.clock.pcrGaps > MAX_GAP_SAMPLES,
    totValidSections: analyzer.clock.totValidSections,
    pidSummary,
    elapsedMs: Math.round(elapsedMs),
    readMiBPerSecond: elapsedMs > 0 ? Number((parsed.inputBytes / 1048576 / (elapsedMs / 1000)).toFixed(2)) : null
  };
}

function printDetail(result) {
  console.log();
  for (const pid of result.pidSummary) {
    console.log(`${pid.pid} : ${pid.lastCc} : ${pid.events} CC Event(s) : ${pid.packets} Total`);
  }
  console.log(`- 終了します. ( CC ${result.ccErrorEvents}, ` +
    `PCR-GAP ${result.pcrGapEvents} [LOW_DATA ${result.pcrLowDataGapEvents}], ` +
    `PCR-RESET ${result.pcrResets}, TEI ${result.teiPackets}, ` +
    `SYNC ${result.syncErrorEvents}, BadHdr ${result.invalidHeaderPackets}, ` +
    `PCR-PID ${result.pcrPid ?? '-'}, TOT ${result.totValidSections}, ` +
    `${(result.elapsedMs / 1000).toFixed(2)}s, ${result.readMiBPerSecond} MiB/s` +
    `${result.completed ? '' : `, INCOMPLETE ${result.stopReason}` } )`);
}

// Human-readable default: put the diagnosis first. Detailed packet events are
// available with --events; JSON and scanner logic are unchanged.
function printCompact(result) {
  const scanStatus = !result.completed ? '解析未完了' :
    result.pcrLowDataGapEvents > 0 ? '要確認（時間飛び＋データ量低下）' :
    result.pcrGapEvents > 0 ? '要確認（PCR時間飛び候補）' :
    result.pcrBackwards > 0 ? '要確認（PCR逆行）' :
    result.ccErrorEvents || result.teiPackets || result.syncErrorEvents || result.invalidHeaderPackets ?
      '要確認（TSパケット異常）' : '検出した異常なし';
  const kinds = result.ccKinds;
  const bytesMiB = (result.inputBytes / 1048576).toFixed(1);
  console.log('\n【解析サマリー】');
  console.log(`ファイル   : ${path.basename(result.file)}`);
  console.log(`判定       : ${scanStatus}`);
  console.log(`時間飛び   : ${result.pcrGapEvents}件（うちデータ量低下 ${result.pcrLowDataGapEvents}件）`);
  console.log(`CC異常     : ${result.ccErrorEvents}件` +
    (result.ccErrorEvents ? `（番号飛び ${kinds['counter-jump']} / 同一CC・内容違い ${kinds['repeat-changed']} / 重複過多 ${kinds['repeat-excess']}）` : ''));
  console.log(`その他     : TEI ${result.teiPackets} / 同期異常 ${result.syncErrorEvents} / ヘッダー不正 ${result.invalidHeaderPackets}`);
  console.log(`解析       : ${bytesMiB} MiB / ${(result.elapsedMs / 1000).toFixed(2)}秒 / ${result.readMiBPerSecond ?? '-'} MiB/s`);
  if (!result.completed) console.log(`未完了理由 : ${result.stopReason || '不明'}`);
  if (!result.pcrSamples) console.log('PCR        : 未検出（時間飛びは評価不可）');

  if (result.pcrGapEvents) {
    console.log('\n【PCR時間飛び候補】');
    for (const [index, gap] of result.pcrGapSamples.slice(0, 5).entries()) {
      const seconds = (gap.deltaMs / 1000).toFixed(3);
      const ratio = gap.rateRatio === null ? '比較不可' : `通常区間比 ${(gap.rateRatio * 100).toFixed(1)}%`;
      console.log(`  ${index + 1}. ${gap.fromPcr} → ${gap.toPcr}  (+${seconds}秒)`);
      console.log(`     ${gap.lowData ? 'データ量低下の疑い' : 'データ量低下は未確認'} / ${ratio} / PCR PID ${gap.pid}`);
      console.log(`     位置 ${gap.fromOffsetHex} → ${gap.toOffsetHex}`);
    }
    if (result.pcrGapEvents > 5) {
      console.log(`  ... ほか ${result.pcrGapEvents - 5}件（--events または --json で確認）`);
    }
  }

  if (result.ccErrorEvents) {
    const pids = result.pidSummary.filter(item => item.events)
      .sort((a, b) => b.events - a.events || a.pid.localeCompare(b.pid));
    console.log('\n【CC異常のあるPID】');
    const visible = pids.slice(0, 8);
    console.log('  ' + visible.map(item => `${item.pid} ${item.events}件`).join(' / '));
    if (pids.length > visible.length) console.log(`  ... ほか ${pids.length - visible.length} PID`);
  }
  if (result.pcrResets) {
    console.log(`\nPCR時計切替 : ${result.pcrResets}件（時間飛び候補とは別集計）`);
  }
  console.log('\n旧形式の個別ログは --events、機械処理用は --json を指定してください。');
  console.log('※ PCR時間飛びとCC異常は、CPU・電波・HDDの原因を単独では確定しません。');
  console.log('');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();
  const analyzerPath = locateAnalyzer(opts.analyzer);
  const sha = gitBlobSha(analyzerPath);
  const { TsDropAnalyzer } = require(analyzerPath);
  if (typeof TsDropAnalyzer !== 'function') throw new Error('TsDropAnalyzer export not found');
  const targets = await collectTargets(opts);
  if (!targets.length) throw new Error('No .ts files in the specified targets');
  const counts = { SUSPECT: 0, NO_FINDINGS: 0, INCOMPLETE: 0, ERROR: 0 };
  for (const filename of targets) {
    if (opts.events) console.log(`- TS Analyzer (legacy events): ${filename}`);
    else if (!opts.json && !opts.summary) {
      console.log('\n=== TS Analyzer ===');
      console.log(`ファイル : ${path.basename(filename)}`);
      console.log('\n【異常の時系列（ファイル内の読み取り順）】');
      console.log('  PCR時刻       種別  PID      回数   オフセット      内容');
    }
    try {
      const result = await inspectFile(filename, TsDropAnalyzer, opts,
        opts.events ? 'legacy' : opts.json || opts.summary ? null : 'timeline');
      counts[result.status]++;
      if (opts.json) console.log(JSON.stringify({ ...result, analyzerBlobSha: sha }));
      else if (opts.summary) {
        console.log(`${result.status} | CC ${result.ccErrorEvents} | ` +
          `PCR-GAP ${result.pcrGapEvents} [LOW_DATA ${result.pcrLowDataGapEvents}] | ` +
          `TEI ${result.teiPackets} | ${result.readMiBPerSecond} MiB/s | ${filename}`);
      } else if (opts.events) printDetail(result);
      else printCompact(result);
    } catch (err) {
      counts.ERROR++;
      if (opts.json) console.log(JSON.stringify({ file: filename, status: 'ERROR', error: err.message }));
      else console.error(`ERROR ${filename}: ${err.message}`);
    }
  }
  if (targets.length > 1 && !opts.json) console.error(`Finished: ${JSON.stringify(counts)}`);
  process.exitCode = counts.ERROR || counts.INCOMPLETE ? 2 : counts.SUSPECT ? 1 : 0;
}

main().catch(err => { console.error(`TS Analyzer: ${err.message}`); process.exitCode = 3; });
