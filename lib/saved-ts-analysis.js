'use strict';

const path = require('path');
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const COUNTERS = ['ccErrorEvents', 'teiPackets', 'syncErrorEvents', 'invalidHeaderPackets', 'pcrGapEvents', 'pcrBackwards'];
const NUMBERS = [...COUNTERS, 'fileSizeBytes', 'inputBytes', 'packetTotal', 'duplicatePackets', 'syncDiscardedBytes',
  'discontinuityPackets', 'trailingBytes', 'pcrSamples', 'pcrGapThresholdMs', 'pcrLowDataGapEvents', 'pcrResets',
  'pcrExplicitResets', 'totValidSections', 'elapsedMs'];

function invalid(message) {
  const error = new Error(message);
  Object.assign(error, { publicMessage: message, statusCode: 400, code: 'invalid_analysis' });
  throw error;
}
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function count(value) { return Number.isSafeInteger(value) && value >= 0; }
function completed(result) {
  return result?.completed === true && ['NO_FINDINGS', 'SUSPECT'].includes(result.status);
}

// Shared by Operator and external registration; never reads the recording.
function normalizeResult(input) {
  const result = JSON.parse(JSON.stringify(input));
  delete result.pidSummary;
  delete result.file;
  const pids = Object.entries(result.ccErrorsByPid || {}).sort((a, b) => b[1] - a[1]);
  result.ccErrorsByPid = Object.fromEntries(pids.slice(0, 256));
  result.pidResultsTruncated = result.pidResultsTruncated === true || pids.length > 256;
  result.ccSamples = (result.ccSamples || []).slice(0, 10);
  result.pcrGapSamples = (result.pcrGapSamples || []).slice(0, 10);
  result.samplesLimited = true;
  return result;
}

function externalAnalysis(input) {
  if (!object(input) || Buffer.byteLength(JSON.stringify(input)) > MAX_INPUT_BYTES) invalid('解析結果は2 MiB以内のJSONオブジェクトで指定してください。');
  const raw = input.result;
  if (!object(raw) || !completed(raw) || raw.stopReason != null || raw.error != null) invalid('正常に完了したNO_FINDINGS / SUSPECTだけ登録できます。');
  if (typeof input.path !== 'string' || !path.isAbsolute(input.path) || input.path.includes('\0') ||
      typeof raw.file !== 'string' || !path.isAbsolute(raw.file) || raw.file.includes('\0') ||
      path.resolve(input.path) !== path.resolve(raw.file)) invalid('対象絶対パスとJSONのfileが一致しません。');
  if (!object(input.file) || !count(input.file.size) || input.file.size <= 0 || raw.fileSizeBytes !== input.file.size ||
      raw.inputBytes !== raw.fileSizeBytes || !count(raw.packetTotal) || raw.packetTotal === 0 ||
      raw.packetTotal * 188 > raw.inputBytes || raw.trailingBytes !== 0) invalid('ファイルサイズ・読み取り量・完了結果が整合しません。');
  if (typeof raw.analyzerBlobSha !== 'string' || !/^[0-9a-f]{40}$/i.test(raw.analyzerBlobSha)) invalid('analyzerBlobShaが不正です。');
  for (const key of COUNTERS) if (!count(raw[key])) invalid(`${key}は0以上の整数が必要です。`);
  const suspect = COUNTERS.some(key => raw[key] > 0);
  if ((raw.status === 'SUSPECT') !== suspect) invalid('異常件数とstatusが一致しません。');
  if (!object(raw.ccErrorsByPid) || Object.entries(raw.ccErrorsByPid).some(([pid, value]) =>
    !/^(0|[1-9]\d{0,3})$/.test(pid) || Number(pid) > 8191 || !count(value)) ||
    Object.values(raw.ccErrorsByPid).reduce((sum, value) => sum + value, 0) !== raw.ccErrorEvents) invalid('PID別CC件数が不正です。');
  const result = { status: raw.status, completed: true, stopReason: null, analyzerBlobSha: raw.analyzerBlobSha,
    ccErrorsByPid: raw.ccErrorsByPid };
  for (const key of NUMBERS) {
    if (raw[key] === undefined) continue;
    if (!count(raw[key])) invalid(`${key}が不正です。`);
    result[key] = raw[key];
  }
  if (raw.pcrLowDataGapEvents !== undefined && raw.pcrLowDataGapEvents > raw.pcrGapEvents) invalid('低データ量の件数が時間飛び件数を超えています。');
  if (raw.ccKinds !== undefined) {
    const keys = ['counter-jump', 'repeat-changed', 'repeat-excess'];
    if (!object(raw.ccKinds) || keys.some(key => !count(raw.ccKinds[key])) ||
        keys.reduce((sum, key) => sum + raw.ccKinds[key], 0) !== raw.ccErrorEvents) invalid('CC種別の件数が不正です。');
    result.ccKinds = Object.fromEntries(keys.map(key => [key, raw.ccKinds[key]]));
  }
  if (raw.pcrPid !== undefined) {
    if (raw.pcrPid !== null && (typeof raw.pcrPid !== 'string' || !/^0x[0-9a-f]{4}$/i.test(raw.pcrPid) || parseInt(raw.pcrPid, 16) >= 8191)) invalid('PCR PIDが不正です。');
    result.pcrPid = raw.pcrPid;
  }
  if (raw.readMiBPerSecond !== undefined) {
    if (raw.readMiBPerSecond !== null && (!Number.isFinite(raw.readMiBPerSecond) || raw.readMiBPerSecond < 0)) invalid('読み取り速度が不正です。');
    result.readMiBPerSecond = raw.readMiBPerSecond;
  }
  for (const [key, limit] of [['ccSamples', 20], ['pcrGapSamples', 100]]) {
    const samples = raw[key] === undefined ? [] : raw[key];
    if (!Array.isArray(samples) || samples.length > limit || samples.length > raw[key === 'ccSamples' ? 'ccErrorEvents' : 'pcrGapEvents'] || samples.some(sample => !object(sample) ||
      Object.values(sample).some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value)) ||
      Object.values(sample).some(value => typeof value === 'number' && !Number.isFinite(value)) ||
      Object.values(sample).some(value => typeof value === 'string' && value.length > 4096) ||
      ['byteOffset', 'fromOffset', 'toOffset'].some(name => sample[name] !== undefined &&
        (!count(sample[name]) || sample[name] >= raw.fileSizeBytes)))) invalid(`${key}が不正です。`);
    for (const sample of samples) {
      if (key === 'ccSamples' && (!count(sample.byteOffset) || !count(sample.pid) || sample.pid >= 8191 ||
          ['previousCc', 'expectedCc', 'actualCc'].some(name => !count(sample[name]) || sample[name] > 15))) invalid('CCサンプルの位置・PID・CC値が不正です。');
      if (key === 'pcrGapSamples' && (!count(sample.fromOffset) || !count(sample.toOffset) || sample.fromOffset >= sample.toOffset ||
          !Number.isFinite(sample.deltaMs) || sample.deltaMs <= 0)) invalid('GAPサンプルの位置・時間差が不正です。');
    }
    result[key] = samples;
    if (raw[`${key}Truncated`] !== undefined && typeof raw[`${key}Truncated`] !== 'boolean') invalid(`${key}Truncatedが不正です。`);
    result[`${key}Truncated`] = raw[`${key}Truncated`] === true;
  }
  const file = { path: path.resolve(input.path), size: input.file.size };
  if (input.file.path !== undefined && input.file.path !== input.path) invalid('file.pathと対象パスが一致しません。');
  for (const key of ['dev', 'ino', 'mtimeMs']) {
    if (input.file[key] === undefined) continue;
    if (!Number.isFinite(input.file[key]) || input.file[key] < 0 || key !== 'mtimeMs' && !count(input.file[key])) invalid(`${key}が不正です。`);
    file[key] = input.file[key];
  }
  const analysis = { file, result: normalizeResult(result) };
  if (input.analyzedAt !== undefined) {
    if (typeof input.analyzedAt !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(input.analyzedAt)) invalid('analyzedAtはタイムゾーン付き日時で指定してください。');
    const at = Date.parse(input.analyzedAt);
    if (!Number.isFinite(at) || at <= 0 || at > Date.now()) invalid('analyzedAtが不正です。');
    analysis.checkedAt = at;
  }
  return analysis;
}

module.exports = { MAX_INPUT_BYTES, completed, normalizeResult, externalAnalysis };
