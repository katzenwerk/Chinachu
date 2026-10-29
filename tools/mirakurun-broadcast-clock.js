#!/usr/bin/env node
'use strict';
/**
 * Mirakurun Broadcast Clock Sync
 *
 * Mirakurunのチャンネル全体streamから放送波時刻（TOT/TDT）を読み取り、
 * OS時刻との差分を確認し、必要に応じてchronyで時計補正するツールです。
 *
 * 主な用途：
 *   - オフライン環境での時計合わせ
 *   - 録画サーバ起動直後の時刻補正
 *   - RTCずれ、BIOS時計初期化時の復旧
 *
 * 通常実行：
 *   sudo node tools/mirakurun-broadcast-clock.js \
 *     --url "http://<Mirakurun>:40772/api/channels/GR/23/stream?decode=0" \
 *     --priority 0 \
 *     --use-chrony \
 *     --adjust
 *
 * 注意：
 *   - SID指定ではなく、チャンネル全体streamを使用してください。
 *   - chrony.conf に manual 設定が必要です。
 *   - 録画中の実行は避けることを推奨します。
 *
 * --use-chrony / --adjust を指定しない場合は読み取り専用です。
 */


/**
 * Mirakurun Broadcast Clock Probe + chronyc settime/makestep
 *
 * Purpose:
 *   Read MPEG-TS stream from Mirakurun and extract broadcast time
 *   from TDT/TOT on PID 0x0014.
 *
 * Policy:
 *   Trust broadcast time.
 *   If abs(system time - broadcast time) >= 1 second, adjust the clock.
 *   Large steps are allowed by default for offline/RTC-reset recovery.
 *
 * Important:
 *   For Japanese ISDB/ARIB broadcast, TDT/TOT time is handled as JST wall-clock time.
 *   This script converts that JST time into a JavaScript Date correctly.
 *
 * Default:
 *   Check only. It does NOT adjust system time unless:
 *     --use-chrony --adjust
 *   is specified.
 *
 * Chrony adjustment:
 *   1. chronyc settime "YYYY-MM-DD HH:mm:ss"
 *   2. chronyc makestep
 *   3. Re-read broadcast time and report post-adjust diff
 *
 * Requirements:
 *   chrony.conf needs:
 *     manual
 *
 * Usage:
 *   node tools/mirakurun-broadcast-clock.js \
 *     --url "http://127.0.0.1:40772/api/channels/GR/23/stream?decode=0" \
 *     --priority 0
 *
 * Dry-run:
 *   node tools/mirakurun-broadcast-clock.js \
 *     --url "http://127.0.0.1:40772/api/channels/GR/23/stream?decode=0" \
 *     --priority 0 \
 *     --use-chrony \
 *     --dry-run
 *
 * Actual adjustment:
 *   sudo node tools/mirakurun-broadcast-clock.js \
 *     --url "http://127.0.0.1:40772/api/channels/GR/23/stream?decode=0" \
 *     --priority 0 \
 *     --use-chrony \
 *     --adjust
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { execFileSync } = require('child_process');

function parseArgs(argv) {
  const args = {
    url: null,
    mirakurunUrl: null,
    mirakurunSocket: null,
    grChannel: null,
    socketPath: null,
    requestPath: null,
    chinachuGuardDir: null,
    reserveGuardSec: 600,
    priority: null,
    samples: 5,
    timeout: 60000,
    json: true,

    useChrony: false,
    dryRun: false,
    adjust: false,
    showCommand: false,

    minAdjustSec: 1,
    maxAdjustSec: 3153600000, // 100 years
    makestepAfterSettime: true,
    verifyAfterAdjust: true,
    verifyWaitMs: 2000
  };

  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];

    if (key === '--url') {
      args.url = argv[++i];
    } else if (key === '--mirakurun-url') {
      args.mirakurunUrl = argv[++i];
    } else if (key === '--mirakurun-socket') {
      args.mirakurunSocket = argv[++i];
    } else if (key === '--gr-channel') {
      args.grChannel = argv[++i];
    } else if (key === '--socket-path') {
      args.socketPath = argv[++i];
    } else if (key === '--request-path') {
      args.requestPath = argv[++i];
    } else if (key === '--chinachu-guard-dir') {
      args.chinachuGuardDir = argv[++i];
    } else if (key === '--reserve-guard-sec') {
      args.reserveGuardSec = Number(argv[++i]);
    } else if (key === '--priority') {
      args.priority = Number(argv[++i]);
    } else if (key === '--samples') {
      args.samples = Number(argv[++i]);
    } else if (key === '--timeout') {
      args.timeout = Number(argv[++i]);
    } else if (key === '--plain') {
      args.json = false;
    } else if (key === '--use-chrony') {
      args.useChrony = true;
    } else if (key === '--dry-run') {
      args.dryRun = true;
    } else if (key === '--adjust') {
      args.adjust = true;
    } else if (key === '--show-command') {
      args.showCommand = true;
    } else if (key === '--min-adjust-sec') {
      args.minAdjustSec = Number(argv[++i]);
    } else if (key === '--max-adjust-sec') {
      args.maxAdjustSec = Number(argv[++i]);
    } else if (key === '--no-makestep') {
      args.makestepAfterSettime = false;
    } else if (key === '--no-verify-after-adjust') {
      args.verifyAfterAdjust = false;
    } else if (key === '--verify-wait-ms') {
      args.verifyWaitMs = Number(argv[++i]);
    } else if (key === '--help' || key === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${key}`);
    }
  }

  const hasSocketTarget = Boolean(args.socketPath || args.requestPath);
  const targetCount = Number(Boolean(args.url)) + Number(Boolean(args.mirakurunUrl)) +
    Number(Boolean(args.mirakurunSocket)) + Number(hasSocketTarget);
  if (targetCount !== 1) {
    throw new Error('Specify one of --mirakurun-url, --mirakurun-socket, --url, or both --socket-path and --request-path');
  }
  if (hasSocketTarget && (!args.socketPath || !args.requestPath || args.requestPath.charAt(0) !== '/')) {
    throw new Error('--socket-path and an absolute --request-path are required together');
  }
  if (args.priority !== null && (!Number.isInteger(args.priority) || args.priority < 0)) {
    throw new Error('--priority must be an integer >= 0');
  }
  if (args.mirakurunUrl) {
    const protocol = new URL(args.mirakurunUrl).protocol;
    if (protocol !== 'http:' && protocol !== 'https:') throw new Error('--mirakurun-url must use http or https');
  }
  if (args.mirakurunSocket !== null && String(args.mirakurunSocket).trim() === '') {
    throw new Error('--mirakurun-socket must not be empty');
  }
  if (args.grChannel !== null && ((!args.mirakurunUrl && !args.mirakurunSocket) || String(args.grChannel).trim() === '')) {
    throw new Error('--gr-channel requires --mirakurun-url or --mirakurun-socket and a channel value');
  }
  if (args.chinachuGuardDir !== null && String(args.chinachuGuardDir).trim() === '') {
    throw new Error('--chinachu-guard-dir must not be empty');
  }
  if (!Number.isInteger(args.reserveGuardSec) || args.reserveGuardSec < 0) {
    throw new Error('--reserve-guard-sec must be an integer >= 0');
  }

  if (!Number.isInteger(args.samples) || args.samples < 1) {
    throw new Error('--samples must be a positive integer');
  }

  if (!Number.isInteger(args.timeout) || args.timeout < 1000) {
    throw new Error('--timeout must be an integer >= 1000');
  }

  if (!Number.isFinite(args.minAdjustSec) || args.minAdjustSec < 0) {
    throw new Error('--min-adjust-sec must be a number >= 0');
  }

  if (!Number.isFinite(args.maxAdjustSec) || args.maxAdjustSec <= 0) {
    throw new Error('--max-adjust-sec must be a number > 0');
  }

  if (args.minAdjustSec > args.maxAdjustSec) {
    throw new Error('--min-adjust-sec must be <= --max-adjust-sec');
  }

  if (!Number.isInteger(args.verifyWaitMs) || args.verifyWaitMs < 0) {
    throw new Error('--verify-wait-ms must be an integer >= 0');
  }

  if (args.adjust && args.dryRun) {
    throw new Error('Do not specify --adjust and --dry-run together');
  }

  if (args.adjust && !args.useChrony) {
    throw new Error('--adjust requires --use-chrony');
  }

  return args;
}

function printHelp() {
  console.log(`
Mirakurun Broadcast Clock Probe + chronyc settime/makestep

Usage:
  node tools/mirakurun-broadcast-clock.js --mirakurun-url <base-url> [--gr-channel <channel>] [options]
  node tools/mirakurun-broadcast-clock.js --mirakurun-socket <socket-path> [--gr-channel <channel>] [options]
  node tools/mirakurun-broadcast-clock.js --url <channel-stream-url> [options]

Example:
  node tools/mirakurun-broadcast-clock.js \\
    --url "http://127.0.0.1:40772/api/channels/GR/23/stream?decode=0" \\
    --priority 0

Dry-run:
  node tools/mirakurun-broadcast-clock.js \\
    --url "http://127.0.0.1:40772/api/channels/GR/23/stream?decode=0" \\
    --priority 0 \\
    --use-chrony \\
    --dry-run

Actual adjustment:
  sudo node tools/mirakurun-broadcast-clock.js \\
    --url "http://127.0.0.1:40772/api/channels/GR/23/stream?decode=0" \\
    --priority 0 \\
    --use-chrony \\
    --adjust

Options:
  --mirakurun-url             Mirakurun base URL; automatically select a free GR channel
  --mirakurun-socket          Mirakurun Unix socket; automatically select a free GR channel
  --gr-channel                Physical GR channel to use with --mirakurun-url
  --url                       Mirakurun channel stream URL
  --socket-path               Mirakurun Unix socket path (use with --request-path)
  --request-path              Channel stream request path (use with --socket-path)
  --priority                  X-Mirakurun-Priority integer >= 0
  --samples                   Number of TDT/TOT samples to collect. Default: 5
  --timeout                   Timeout in milliseconds. Default: 60000
  --plain                     Print simple text instead of JSON
  --chinachu-guard-dir        Check Chinachu recording/reserves and Mirakurun tuners before use
  --reserve-guard-sec         Minimum time before next recording. Default: 600

Chrony options:
  --use-chrony                Enable chrony decision output
  --dry-run                   Show commands but do not execute
  --adjust                    Execute adjustment if needed
  --show-command              Always show command candidate
  --min-adjust-sec            Minimum absolute diff seconds for adjustment. Default: 1
  --max-adjust-sec            Maximum absolute diff seconds for adjustment. Default: 3153600000
  --no-makestep               Do not run chronyc makestep after chronyc settime
  --no-verify-after-adjust    Do not re-check broadcast time after adjustment
  --verify-wait-ms            Wait before post-adjust verification. Default: 2000
`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class GuardSkipError extends Error {
  constructor(reason, jsonOutput) {
    super(reason);
    this.name = 'GuardSkipError';
    this.code = 'BROADCAST_CLOCK_GUARD_SKIP';
    this.jsonOutput = jsonOutput;
  }
}

function readGuardJson(filename, options) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    throw new GuardSkipError(`guard state unavailable: ${filename}: ${error.message}`, options.json);
  }
  if (!Array.isArray(value)) {
    throw new GuardSkipError(`guard state is not an array: ${filename}`, options.json);
  }
  return value;
}

function getLocalGuardReason(options, now = Date.now()) {
  if (!options.chinachuGuardDir) return null;
  const root = path.resolve(String(options.chinachuGuardDir));
  const recording = readGuardJson(path.join(root, 'data', 'recording.json'), options);
  if (recording.length > 0) return 'recording-active';

  const reserves = readGuardJson(path.join(root, 'data', 'reserves.json'), options);
  const guardMs = options.reserveGuardSec * 1000 + options.timeout;
  for (const program of reserves) {
    if (!program || program.isSkip === true || !Number.isFinite(Number(program.start)) || !Number.isFinite(Number(program.end))) continue;
    if (Number(program.end) <= now) continue;
    if (Number(program.start) - now < guardMs) return 'recording-reserved-within-guard';
  }
  return null;
}

function throwIfLocalGuardUnsafe(options) {
  const reason = getLocalGuardReason(options);
  if (reason) throw new GuardSkipError(reason, options.json);
}

function getTargetChannelType(options) {
  const target = options.url ? new URL(options.url).pathname : String(options.requestPath || '').split('?')[0];
  const match = target.match(/\/channels\/([^/]+)\//);
  if (!match) throw new GuardSkipError('cannot determine channel type for tuner guard', options.json);
  return decodeURIComponent(match[1]);
}

function getMirakurunApiTarget(options, resource) {
  if (options.url) {
    const target = new URL(options.url);
    const apiIndex = target.pathname.indexOf('/api/');
    if (apiIndex === -1) throw new GuardSkipError('cannot determine Mirakurun API root for tuner guard', options.json);
    target.pathname = target.pathname.slice(0, apiIndex) + '/api/' + resource;
    target.search = '';
    return { url: target };
  }
  const requestPath = String(options.requestPath || '').split('?')[0];
  const apiIndex = requestPath.indexOf('/api/');
  if (apiIndex === -1) throw new GuardSkipError('cannot determine Mirakurun API root for tuner guard', options.json);
  return {
    socketPath: options.socketPath,
    requestPath: requestPath.slice(0, apiIndex) + '/api/' + resource
  };
}

function requestMirakurunJson(options, resource) {
  return new Promise((resolve, reject) => {
    const target = getMirakurunApiTarget(options, resource);
    const client = target.url && target.url.protocol === 'https:' ? https : http;
    const requestOptions = target.url || { socketPath: target.socketPath, path: target.requestPath };
    let settled = false;
    const req = client.get(requestOptions, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size <= 1024 * 1024) chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(formatHttpError(res.statusCode, res.statusMessage, Buffer.concat(chunks).toString('utf8'), size > 1024 * 1024)));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(new Error(`invalid Mirakurun ${resource} response: ${error.message}`));
        }
      });
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error(`Mirakurun ${resource} request timed out`));
    }, 3000);
    req.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

function buildMirakurunApiSeedUrl(baseUrl) {
  const target = new URL(baseUrl);
  const basePath = target.pathname.replace(/\/+$/, '');
  target.pathname = (basePath.endsWith('/api') ? basePath : basePath + '/api') + '/status';
  target.search = '';
  return target;
}

async function resolveAutomaticStreamTarget(options) {
  if (!options.mirakurunUrl && !options.mirakurunSocket) return;
  const lookupOptions = options.mirakurunUrl
    ? { ...options, url: buildMirakurunApiSeedUrl(options.mirakurunUrl).toString() }
    : { ...options, socketPath: String(options.mirakurunSocket), requestPath: '/api/status' };
  let channels;
  let tuners;
  try {
    [channels, tuners] = await Promise.all([
      requestMirakurunJson(lookupOptions, 'channels'),
      requestMirakurunJson(lookupOptions, 'tuners')
    ]);
  } catch (error) {
    throw new GuardSkipError(`Mirakurun channel/tuner state unavailable: ${error.message}`, options.json);
  }
  const freeGrTuner = Array.isArray(tuners) && tuners.some(tuner => tuner &&
    tuner.isAvailable === true && tuner.isFree === true && Array.isArray(tuner.users) && tuner.users.length === 0 &&
    Array.isArray(tuner.types) && tuner.types.includes('GR'));
  if (!freeGrTuner) throw new GuardSkipError('no confirmed free GR tuner', options.json);

  const requested = options.grChannel === null ? null : String(options.grChannel);
  const channel = Array.isArray(channels) ? channels.find(item => item && item.type === 'GR' &&
    (typeof item.channel === 'string' || typeof item.channel === 'number') &&
    (requested === null || String(item.channel) === requested)) : null;
  if (!channel) {
    throw new GuardSkipError(requested === null ? 'no GR channel is available' : `configured channel GR/${requested} is unavailable`, options.json);
  }

  if (options.mirakurunUrl) {
    const streamUrl = buildMirakurunApiSeedUrl(options.mirakurunUrl);
    const apiIndex = streamUrl.pathname.indexOf('/api/');
    streamUrl.pathname = streamUrl.pathname.slice(0, apiIndex) + '/api/channels/GR/' + encodeURIComponent(String(channel.channel)) + '/stream';
    streamUrl.search = '?decode=0';
    options.url = streamUrl.toString();
  } else {
    options.socketPath = String(options.mirakurunSocket);
    options.requestPath = '/api/channels/GR/' + encodeURIComponent(String(channel.channel)) + '/stream?decode=0';
  }
  options.resolvedChannel = { type: 'GR', channel: String(channel.channel), name: channel.name || null };
}

async function assertGuardSafe(options, includeTuner) {
  if (!options.chinachuGuardDir) return;
  throwIfLocalGuardUnsafe(options);
  if (!includeTuner) return;
  let tuners;
  try {
    tuners = await requestMirakurunJson(options, 'tuners');
  } catch (error) {
    throw new GuardSkipError(`tuner state unavailable: ${error.message}`, options.json);
  }
  const type = getTargetChannelType(options);
  const available = Array.isArray(tuners) && tuners.some(tuner => tuner &&
    tuner.isAvailable === true && tuner.isFree === true && Array.isArray(tuner.users) && tuner.users.length === 0 &&
    Array.isArray(tuner.types) && tuner.types.includes(type));
  if (!available) throw new GuardSkipError(`no confirmed free ${type} tuner`, options.json);
}

function bcdToInt(byte) {
  const high = (byte >> 4) & 0x0f;
  const low = byte & 0x0f;

  if (high > 9 || low > 9) {
    throw new Error(`Invalid BCD byte: 0x${byte.toString(16)}`);
  }

  return high * 10 + low;
}

/**
 * Decode MJD + BCD time used in TDT/TOT.
 *
 * For Japanese ISDB/ARIB broadcast:
 *   The time value should be treated as JST wall-clock time.
 *
 * JavaScript Date stores time internally as UTC milliseconds.
 * Therefore, if the broadcast field says:
 *   2026-06-27 00:25:14 JST
 *
 * The Date object should represent:
 *   2026-06-26T15:25:14.000Z
 */
function decodeMjdBcdJstAsDate(buf, offset) {
  if (buf.length < offset + 5) {
    throw new Error('JST_time field is too short');
  }

  const mjd = (buf[offset] << 8) | buf[offset + 1];
  const hour = bcdToInt(buf[offset + 2]);
  const minute = bcdToInt(buf[offset + 3]);
  const second = bcdToInt(buf[offset + 4]);

  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error(`Invalid time: ${hour}:${minute}:${second}`);
  }

  // MJD 40587 = 1970-01-01.
  // Convert JST wall-clock milliseconds to UTC milliseconds by subtracting 9 hours.
  const unixDays = mjd - 40587;

  const jstWallClockMs =
    unixDays * 86400 * 1000 +
    hour * 3600 * 1000 +
    minute * 60 * 1000 +
    second * 1000;

  return new Date(jstWallClockMs - 9 * 3600 * 1000);
}

function formatJst(date) {
  const jst = new Date(date.getTime() + 9 * 3600 * 1000);

  const yyyy = jst.getUTCFullYear();
  const mm = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(jst.getUTCDate()).padStart(2, '0');
  const hh = String(jst.getUTCHours()).padStart(2, '0');
  const mi = String(jst.getUTCMinutes()).padStart(2, '0');
  const ss = String(jst.getUTCSeconds()).padStart(2, '0');

  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+09:00`;
}

function formatJstForCommand(date) {
  const jst = new Date(date.getTime() + 9 * 3600 * 1000);

  const yyyy = jst.getUTCFullYear();
  const mm = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(jst.getUTCDate()).padStart(2, '0');
  const hh = String(jst.getUTCHours()).padStart(2, '0');
  const mi = String(jst.getUTCMinutes()).padStart(2, '0');
  const ss = String(jst.getUTCSeconds()).padStart(2, '0');

  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function shellQuote(text) {
  return `"${String(text).replace(/(["\\$`])/g, '\\$1')}"`;
}

function extractTsPayload(packet) {
  if (packet.length !== 188) {
    return null;
  }

  if (packet[0] !== 0x47) {
    return null;
  }

  const payloadUnitStart = (packet[1] & 0x40) !== 0;
  const pid = ((packet[1] & 0x1f) << 8) | packet[2];
  const adaptationFieldControl = (packet[3] >> 4) & 0x03;

  // 0: reserved
  // 2: adaptation field only, no payload
  if (adaptationFieldControl === 0 || adaptationFieldControl === 2) {
    return {
      pid,
      payloadUnitStart,
      payload: Buffer.alloc(0)
    };
  }

  let offset = 4;

  // 3: adaptation field followed by payload
  if (adaptationFieldControl === 3) {
    const adaptationLength = packet[offset];
    offset += 1 + adaptationLength;
  }

  if (offset >= 188) {
    return {
      pid,
      payloadUnitStart,
      payload: Buffer.alloc(0)
    };
  }

  return {
    pid,
    payloadUnitStart,
    payload: packet.slice(offset)
  };
}

function getSectionTotalLength(section) {
  if (section.length < 3) {
    return null;
  }

  const sectionLength = ((section[1] & 0x0f) << 8) | section[2];

  return 3 + sectionLength;
}

function parseTdtTotSection(section) {
  if (section.length < 8) {
    return null;
  }

  const tableId = section[0];

  // TDT = 0x70
  // TOT = 0x73
  if (tableId !== 0x70 && tableId !== 0x73) {
    return null;
  }

  const totalLength = getSectionTotalLength(section);

  if (totalLength === null || section.length < totalLength) {
    return null;
  }

  const broadcastTime = decodeMjdBcdJstAsDate(section, 3);

  return {
    source: tableId === 0x70 ? 'TDT' : 'TOT',
    broadcastTime
  };
}

function isReasonableSample(prev, current) {
  if (!prev) {
    return true;
  }

  const deltaMs = current.broadcastTime.getTime() - prev.broadcastTime.getTime();

  // Same second can appear more than once.
  // A small negative tolerance is allowed, but large backward jumps are rejected.
  return deltaMs >= -1000 && deltaMs <= 30000;
}

function formatHttpError(statusCode, statusMessage, body, truncated) {
  const details = [];
  const text = String(body || '').trim();

  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.reason === 'string' && parsed.reason) {
        details.push(parsed.reason);
      }
      if (parsed && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
        details.push(JSON.stringify(parsed.errors));
      }
      if (details.length === 0 && parsed && typeof parsed.message === 'string' && parsed.message) {
        details.push(parsed.message);
      }
      if (details.length === 0 && parsed && typeof parsed.error === 'string' && parsed.error) {
        details.push(parsed.error);
      }
      if (details.length === 0) {
        details.push(text);
      }
    } catch (_) {
      details.push(text);
    }
  }

  let detail = details.join('; ').replace(/\s+/g, ' ').slice(0, 2048);
  if (truncated) {
    detail += detail ? ' [response truncated]' : 'response truncated';
  }

  return `HTTP ${statusCode}${statusMessage ? ` ${statusMessage}` : ''}${detail ? `: ${detail}` : ''}`;
}

function readBroadcastTime(options) {
  return new Promise((resolve, reject) => {
    const streamUrl = options.url ? new URL(options.url) : null;
    const client = streamUrl && streamUrl.protocol === 'https:' ? https : http;
    const requestOptions = {};
    if (options.priority !== null && options.priority !== undefined) {
      requestOptions.headers = { 'X-Mirakurun-Priority': String(options.priority) };
    }

    const samples = [];
    let leftover = Buffer.alloc(0);

    // Section reconstruction buffer for PID 0x0014.
    let pendingSection = null;
    let pendingExpectedLength = null;

    let req = null;
    let finished = false;
    let guardTimer = null;

    const timeoutTimer = setTimeout(() => {
      cleanup();

      reject(new Error(`Timeout: no enough TDT/TOT samples within ${options.timeout}ms`));
    }, options.timeout);

    function cleanup() {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timeoutTimer);
      if (guardTimer !== null) clearInterval(guardTimer);

      if (req) {
        req.destroy();
      }
    }

    if (options.chinachuGuardDir) {
      guardTimer = setInterval(() => {
        if (finished) return;
        try {
          throwIfLocalGuardUnsafe(options);
        } catch (error) {
          cleanup();
          reject(error);
        }
      }, 1000);
      guardTimer.unref?.();
    }

    function acceptSample(sample) {
      const prev = samples.length > 0 ? samples[samples.length - 1] : null;

      if (!isReasonableSample(prev, sample)) {
        return;
      }

      samples.push(sample);

      if (samples.length >= options.samples) {
        const last = samples[samples.length - 1];
        const systemTime = new Date();
        const diffMs = systemTime.getTime() - last.broadcastTime.getTime();

        cleanup();

        resolve({
          ok: true,
          source: last.source,
          broadcastTime: last.broadcastTime,
          broadcastTimeUtc: last.broadcastTime,
          broadcastTimeJst: formatJst(last.broadcastTime),
          systemTime,
          systemTimeJst: formatJst(systemTime),
          diffMs,
          samples: samples.map((s) => ({
            source: s.source,
            broadcastTimeUtc: s.broadcastTime.toISOString(),
            broadcastTimeJst: formatJst(s.broadcastTime)
          })),
          action: 'check-only'
        });
      }
    }

    function feedSectionBytes(payload, payloadUnitStart) {
      if (payload.length === 0) {
        return;
      }

      if (payloadUnitStart) {
        const pointerField = payload[0];
        const sectionStart = 1 + pointerField;

        if (sectionStart >= payload.length) {
          return;
        }

        pendingSection = Buffer.from(payload.slice(sectionStart));
        pendingExpectedLength = getSectionTotalLength(pendingSection);
      } else if (pendingSection) {
        pendingSection = Buffer.concat([pendingSection, payload]);
        pendingExpectedLength = getSectionTotalLength(pendingSection);
      } else {
        return;
      }

      if (pendingExpectedLength !== null && pendingSection.length >= pendingExpectedLength) {
        const section = pendingSection.slice(0, pendingExpectedLength);
        const parsed = parseTdtTotSection(section);

        pendingSection = null;
        pendingExpectedLength = null;

        if (parsed) {
          acceptSample(parsed);
        }
      }
    }

    const handleResponse = (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const errorChunks = [];
        const errorBodyLimit = 16 * 1024;
        let errorBodySize = 0;
        let errorBodyTruncated = false;

        res.on('data', (chunk) => {
          if (finished || errorBodySize >= errorBodyLimit) {
            errorBodyTruncated = true;
            return;
          }
          const remaining = errorBodyLimit - errorBodySize;
          const part = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
          errorChunks.push(part);
          errorBodySize += part.length;
          if (part.length < chunk.length) {
            errorBodyTruncated = true;
          }
        });
        res.on('end', () => {
          if (finished) {
            return;
          }
          const message = formatHttpError(
            res.statusCode,
            res.statusMessage,
            Buffer.concat(errorChunks).toString('utf8'),
            errorBodyTruncated
          );
          cleanup();
          reject(new Error(message));
        });
        return;
      }

      res.on('data', (chunk) => {
        if (finished) {
          return;
        }

        leftover = Buffer.concat([leftover, chunk]);

        while (leftover.length >= 188) {
          const packet = leftover.slice(0, 188);
          leftover = leftover.slice(188);

          const parsedPacket = extractTsPayload(packet);

          if (!parsedPacket) {
            // Try to recover TS sync.
            const nextSync = leftover.indexOf(0x47);

            if (nextSync >= 0) {
              leftover = leftover.slice(nextSync);
            } else {
              leftover = Buffer.alloc(0);
            }

            continue;
          }

          // TDT/TOT PID
          if (parsedPacket.pid !== 0x0014) {
            continue;
          }

          feedSectionBytes(parsedPacket.payload, parsedPacket.payloadUnitStart);
        }
      });

      res.on('end', () => {
        if (finished) {
          return;
        }

        cleanup();

        reject(new Error('Stream ended before enough samples were collected'));
      });
    };

    if (streamUrl) {
      req = client.get(streamUrl, requestOptions, handleResponse);
    } else {
      req = client.get({
        socketPath: options.socketPath,
        path: options.requestPath,
        ...requestOptions
      }, handleResponse);
    }

    req.on('error', (err) => {
      if (finished) {
        return;
      }

      cleanup();
      reject(err);
    });
  });
}

function buildChronycSettimeCommand(broadcastTime) {
  const timeText = formatJstForCommand(broadcastTime);

  return {
    localTimeForSettime: timeText,
    argv: ['chronyc', 'settime', timeText],
    command: `chronyc settime ${shellQuote(timeText)}`,
    note: 'This is JST wall-clock time for chronyc settime. The OS timezone should be Asia/Tokyo.'
  };
}

function buildChronycMakestepCommand() {
  return {
    argv: ['chronyc', 'makestep'],
    command: 'chronyc makestep',
    note: 'Run after settime to step the system clock immediately.'
  };
}

function buildChronyDecision(result, options) {
  const diffSec = result.diffMs / 1000;
  const absDiffSec = Math.abs(diffSec);

  if (absDiffSec < options.minAdjustSec) {
    return {
      shouldAdjust: false,
      reason: `diff ${absDiffSec.toFixed(3)} sec is below min-adjust-sec ${options.minAdjustSec}`
    };
  }

  if (absDiffSec > options.maxAdjustSec) {
    return {
      shouldAdjust: false,
      reason: `diff ${absDiffSec.toFixed(3)} sec is above max-adjust-sec ${options.maxAdjustSec}`
    };
  }

  return {
    shouldAdjust: true,
    reason: `diff ${absDiffSec.toFixed(3)} sec is within adjust range`
  };
}

function runChronycSettime(broadcastTime, options) {
  const built = buildChronycSettimeCommand(broadcastTime);

  if (options.dryRun || options.showCommand) {
    return {
      executed: false,
      ...built,
      output: null
    };
  }

  let output = '';
  let errorOutput = '';

  try {
    output = execFileSync(built.argv[0], built.argv.slice(1), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    return {
      executed: true,
      ...built,
      output: output.trim()
    };
  } catch (err) {
    if (err.stdout) {
      output = String(err.stdout);
    }

    if (err.stderr) {
      errorOutput = String(err.stderr);
    }

    return {
      executed: false,
      ...built,
      error: err.message,
      stdout: output.trim(),
      stderr: errorOutput.trim()
    };
  }
}

function runChronycMakestep(options) {
  const built = buildChronycMakestepCommand();

  if (options.dryRun || options.showCommand) {
    return {
      executed: false,
      ...built,
      output: null
    };
  }

  let output = '';
  let errorOutput = '';

  try {
    output = execFileSync(built.argv[0], built.argv.slice(1), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    return {
      executed: true,
      ...built,
      output: output.trim()
    };
  } catch (err) {
    if (err.stdout) {
      output = String(err.stdout);
    }

    if (err.stderr) {
      errorOutput = String(err.stderr);
    }

    return {
      executed: false,
      ...built,
      error: err.message,
      stdout: output.trim(),
      stderr: errorOutput.trim()
    };
  }
}

async function applyChronyIfNeeded(result, options) {
  if (!options.useChrony && !options.showCommand) {
    return null;
  }

  const decision = buildChronyDecision(result, options);
  const commandCandidate = {
    settime: buildChronycSettimeCommand(result.broadcastTime),
    makestep: buildChronycMakestepCommand()
  };

  const chronyResult = {
    method: 'chronyc settime + chronyc makestep',
    policy: 'trust-broadcast-time',
    minAdjustSec: options.minAdjustSec,
    maxAdjustSec: options.maxAdjustSec,
    commandCandidate,
    decision
  };

  if (options.showCommand) {
    chronyResult.settime = {
      executed: false,
      ...commandCandidate.settime,
      output: null
    };

    chronyResult.makestep = {
      executed: false,
      ...commandCandidate.makestep,
      output: null
    };

    return chronyResult;
  }

  if (options.dryRun && decision.shouldAdjust) {
    chronyResult.settime = runChronycSettime(result.broadcastTime, {
      ...options,
      dryRun: true
    });

    if (options.makestepAfterSettime) {
      chronyResult.makestep = runChronycMakestep({
        ...options,
        dryRun: true
      });
    }

    return chronyResult;
  }

  if (options.adjust && decision.shouldAdjust) {
    chronyResult.settime = runChronycSettime(result.broadcastTime, {
      ...options,
      dryRun: false
    });

    if (options.makestepAfterSettime) {
      chronyResult.makestep = runChronycMakestep({
        ...options,
        dryRun: false
      });
    }

    return chronyResult;
  }

  chronyResult.settime = {
    executed: false,
    ...commandCandidate.settime,
    output: null
  };

  if (options.makestepAfterSettime) {
    chronyResult.makestep = {
      executed: false,
      ...commandCandidate.makestep,
      output: null
    };
  }

  return chronyResult;
}

async function verifyAfterAdjust(options) {
  if (options.verifyWaitMs > 0) {
    await sleep(options.verifyWaitMs);
  }

  await assertGuardSafe(options, true);

  const verifyOptions = {
    ...options,
    samples: options.samples,
    timeout: options.timeout
  };

  const result = await readBroadcastTime(verifyOptions);

  return {
    ok: result.ok,
    source: result.source,
    broadcastTimeUtc: result.broadcastTimeUtc.toISOString(),
    broadcastTimeJst: result.broadcastTimeJst,
    systemTime: result.systemTime.toISOString(),
    systemTimeJst: result.systemTimeJst,
    diffMs: result.diffMs,
    diffSeconds: result.diffMs / 1000,
    sampleCount: result.samples.length,
    samples: result.samples
  };
}

async function main() {
  const args = parseArgs(process.argv);
  await resolveAutomaticStreamTarget(args);
  await assertGuardSafe(args, true);
  const result = await readBroadcastTime(args);
  if (args.adjust) await assertGuardSafe(args, false);
  const adjustResult = await applyChronyIfNeeded(result, args);

  let postAdjustCheck = null;

  if (
    args.adjust &&
    args.useChrony &&
    args.verifyAfterAdjust &&
    adjustResult &&
    adjustResult.decision &&
    adjustResult.decision.shouldAdjust
  ) {
    postAdjustCheck = await verifyAfterAdjust(args);
  }

  if (args.json) {
    console.log(JSON.stringify({
      ok: result.ok,
      channel: args.resolvedChannel || null,
      source: result.source,
      broadcastTimeUtc: result.broadcastTimeUtc.toISOString(),
      broadcastTimeJst: result.broadcastTimeJst,
      systemTime: result.systemTime.toISOString(),
      systemTimeJst: result.systemTimeJst,
      diffMs: result.diffMs,
      diffSeconds: result.diffMs / 1000,
      sampleCount: result.samples.length,
      samples: result.samples,
      action: result.action,
      adjust: adjustResult,
      postAdjustCheck
    }, null, 2));
  } else {
    if (args.resolvedChannel) console.log(`channel             : ${args.resolvedChannel.type}/${args.resolvedChannel.channel}${args.resolvedChannel.name ? ` ${args.resolvedChannel.name}` : ''}`);
    console.log(`source              : ${result.source}`);
    console.log(`broadcastTime UTC   : ${result.broadcastTimeUtc.toISOString()}`);
    console.log(`broadcastTime JST   : ${result.broadcastTimeJst}`);
    console.log(`systemTime UTC      : ${result.systemTime.toISOString()}`);
    console.log(`systemTime JST      : ${result.systemTimeJst}`);
    console.log(`diffMs              : ${result.diffMs}`);
    console.log(`diffSeconds         : ${result.diffMs / 1000}`);
    console.log(`action              : ${result.action}`);

    if (adjustResult) {
      console.log(`adjust.method       : ${adjustResult.method}`);
      console.log(`adjust.policy       : ${adjustResult.policy}`);
      console.log(`adjust.shouldAdjust : ${adjustResult.decision.shouldAdjust}`);
      console.log(`adjust.reason       : ${adjustResult.decision.reason}`);

      if (adjustResult.commandCandidate) {
        console.log(`candidate.settime   : ${adjustResult.commandCandidate.settime.command}`);
        console.log(`candidate.makestep  : ${adjustResult.commandCandidate.makestep.command}`);
      }

      if (adjustResult.settime) {
        console.log(`settime.executed    : ${adjustResult.settime.executed}`);
        console.log(`settime.command     : ${adjustResult.settime.command}`);

        if (adjustResult.settime.output) {
          console.log(`settime.output      : ${adjustResult.settime.output}`);
        }

        if (adjustResult.settime.error) {
          console.log(`settime.error       : ${adjustResult.settime.error}`);
          console.log(`settime.stderr      : ${adjustResult.settime.stderr}`);
        }
      }

      if (adjustResult.makestep) {
        console.log(`makestep.executed   : ${adjustResult.makestep.executed}`);
        console.log(`makestep.command    : ${adjustResult.makestep.command}`);

        if (adjustResult.makestep.output) {
          console.log(`makestep.output     : ${adjustResult.makestep.output}`);
        }

        if (adjustResult.makestep.error) {
          console.log(`makestep.error      : ${adjustResult.makestep.error}`);
          console.log(`makestep.stderr     : ${adjustResult.makestep.stderr}`);
        }
      }
    }

    if (postAdjustCheck) {
      console.log(`post.ok             : ${postAdjustCheck.ok}`);
      console.log(`post.broadcast JST  : ${postAdjustCheck.broadcastTimeJst}`);
      console.log(`post.system JST     : ${postAdjustCheck.systemTimeJst}`);
      console.log(`post.diffSeconds    : ${postAdjustCheck.diffSeconds}`);
    }
  }
}

main().catch((err) => {
  if (err && err.code === 'BROADCAST_CLOCK_GUARD_SKIP') {
    if (err.jsonOutput === false) {
      console.log('guard.skipped       : true');
      console.log(`guard.reason        : ${err.message}`);
    } else {
      console.log(JSON.stringify({ ok: false, skipped: true, reason: err.message }, null, 2));
    }
    process.exit(0);
  }
  console.error(JSON.stringify({
    ok: false,
    error: err.message
  }, null, 2));

  process.exit(1);
});
