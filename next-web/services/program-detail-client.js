import { invalidateResources, loadResource } from './api-client.js';
import { refreshStorageCapacity } from './storage-store.js';

export class ProgramDetailError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProgramDetailError';
    this.code = code;
    this.details = details;
  }
}

function validText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function programIds(program) {
  return ['id', 'recordedId', 'origId', 'programId']
    .map(key => validText(program?.[key]))
    .filter(Boolean);
}

function findProgram(programs, id) {
  return (Array.isArray(programs) ? programs : []).find(program => programIds(program).includes(id)) || null;
}

function findProgramByIdentity(programs, id, key) {
  return (Array.isArray(programs) ? programs : []).find(program =>
    (id !== null && programIds(program).includes(id)) || (key !== null && canonicalProgramKey(program) === key)) || null;
}

function canonicalProgramKey(program) {
  const channelId = validText(program?.channel?.id);
  const start = Number(program?.start);
  const seconds = Number(program?.seconds);
  return channelId !== null && Number.isFinite(start) && start > 0 && Number.isFinite(seconds) && seconds > 0
    ? `${channelId}|${start}|${seconds}`
    : null;
}

async function loadRules() {
  try {
    const rules = await loadResource('rules');
    return Array.isArray(rules) ? rules : [];
  } catch (_) {
    return [];
  }
}

async function readJson(response, label) {
  if (!response.ok) throw new ProgramDetailError('http-error', `${label}を取得できませんでした (HTTP ${response.status})`);
  try {
    return await response.json();
  } catch (_) {
    throw new ProgramDetailError('invalid-response', `${label}の応答形式が不正です`);
  }
}

async function readOptionalJson(response) {
  try {
    return await response.json();
  } catch (_) {
    return null;
  }
}

async function loadResolvedMatch(key, signal) {
  const response = await fetch(`/api/match.json?mode=item&key=${encodeURIComponent(key)}&resolve=1`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    credentials: 'same-origin',
    signal
  });
  if (response.status === 404) throw new ProgramDetailError('not-found', '指定された番組履歴が見つかりません');
  const result = await readJson(response, '番組履歴');
  if (!result?.match || !result?.program || !result?.resolution) {
    throw new ProgramDetailError('invalid-response', '番組履歴の応答形式が不正です');
  }
  return result;
}

async function loadProgramById(id, signal) {
  const response = await fetch(`/api/program/${encodeURIComponent(id)}.json`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    credentials: 'same-origin',
    signal
  });
  if (response.status === 404) return null;
  return readJson(response, '番組情報');
}

async function loadResolvedMatchById(id, signal) {
  const response = await fetch(`/api/match.json?mode=item&id=${encodeURIComponent(id)}&resolve=1&strict=1`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    credentials: 'same-origin',
    signal
  });
  if (response.status === 404) return null;
  if (response.status === 409) {
    const result = await readOptionalJson(response);
    throw new ProgramDetailError('ambiguous-history', 'この番組IDに対応する履歴が複数あるため、自動選択できません', {
      id, keys: Array.isArray(result?.keys) ? result.keys : []
    });
  }
  const result = await readJson(response, '番組履歴');
  if (!result?.match || !result?.program || !result?.resolution) {
    throw new ProgramDetailError('invalid-response', '番組履歴の応答形式が不正です');
  }
  return result;
}

export function programDetailUrl({ key = null, id = null } = {}) {
  const params = new URLSearchParams();
  if (validText(key) !== null) params.set('key', validText(key));
  if (validText(id) !== null) params.set('id', validText(id));
  if (params.size === 0) return null;
  return `#program?${params}`;
}

const pendingRecordingStops = new Set();

export async function stopRecordingProgram(id) {
  id = validText(id);
  if (id === null) throw new ProgramDetailError('invalid-request', '番組IDがありません');
  if (pendingRecordingStops.has(id)) throw new ProgramDetailError('stop-pending', '録画中止を要求中です。');
  pendingRecordingStops.add(id);
  try {
    const response = await fetch(`/api/recording/${encodeURIComponent(id)}.json`, {
      method: 'DELETE', headers: { Accept: 'application/json' }, credentials: 'same-origin'
    });
    if (!response.ok) throw new ProgramDetailError('stop-failed', `録画中止を要求できませんでした (HTTP ${response.status})`);
    invalidateResources(['recording', 'reserves']);
  } finally {
    pendingRecordingStops.delete(id);
  }
}

export async function deleteRecordedProgram(recordedId, { signal } = {}) {
  recordedId = validText(recordedId);
  if (recordedId === null) throw new ProgramDetailError('invalid-request', '録画IDがありません');
  const response = await fetch(`/api/recorded/${encodeURIComponent(recordedId)}.json`, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    credentials: 'same-origin',
    signal
  });
  const result = await readOptionalJson(response);
  if (!response.ok) {
    throw new ProgramDetailError(result?.code || 'delete-failed', result?.message || `録画を削除できませんでした (HTTP ${response.status})`, {
      status: response.status,
      result
    });
  }
  if (!result || result.status !== 'complete' || result.fileDeleted !== true || result.matchUpdated !== true) {
    throw new ProgramDetailError('invalid-delete-response', '削除結果を確認できませんでした', { result });
  }
  invalidateResources(['recorded', 'storage']);
  if (result.storageRefresh?.targetKnown === true) {
    try {
      await refreshStorageCapacity(result.storageRefresh.storageId ?? null);
    } catch (error) {
      result.storageRefreshError = String(error?.message || error);
    }
  }
  return result;
}

export async function loadProgramDetail({ key = null, id = null, signal } = {}) {
  key = validText(key);
  id = validText(id);
  if (key !== null) {
    const [resolved, recording, reserves, recorded, scheduled, rules] = await Promise.all([
      loadResolvedMatch(key, signal),
      loadResource('recording'),
      loadResource('reserves'),
      loadResource('recorded'),
      id === null ? Promise.resolve(null) : loadProgramById(id, signal),
      loadRules()
    ]);
    const current = [
      ['recording', findProgramByIdentity(recording, id, key)],
      ['reserves', findProgramByIdentity(reserves, id, key)],
      ['recorded', findProgramByIdentity(recorded, id, key)],
      ['schedule', scheduled && canonicalProgramKey(scheduled) === key ? scheduled : null]
    ].find(([, program]) => program !== null);
    return {
      ...resolved,
      program: current ? current[1] : resolved.program,
      currentSource: current ? current[0] : null,
      historyAmbiguous: false,
      reserves,
      rules
    };
  }
  if (id === null) throw new ProgramDetailError('invalid-request', '番組のkeyまたはidが必要です');

  const [recording, reserves, recorded, scheduled, rules] = await Promise.all([
    loadResource('recording'),
    loadResource('reserves'),
    loadResource('recorded'),
    loadProgramById(id, signal),
    loadRules()
  ]);
  const current = [
    ['recording', findProgram(recording, id)],
    ['reserves', findProgram(reserves, id)],
    ['recorded', findProgram(recorded, id)],
    ['schedule', scheduled]
  ].find(([, program]) => program !== null);

  const currentKey = current ? canonicalProgramKey(current[1]) : null;
  if (currentKey !== null) {
    let resolved = null;
    try { resolved = await loadResolvedMatch(currentKey, signal); }
    catch (error) { if (error?.code !== 'not-found') throw error; }
    if (resolved !== null) {
      return {
        ...resolved,
        program: current[1],
        currentSource: current[0],
        historyAmbiguous: false,
        reserves,
        rules
      };
    }
  }

  if (current) {
    return {
      match: null,
      program: current[1],
      resolution: null,
      currentSource: current[0],
      historyAmbiguous: false,
      reserves,
      rules
    };
  }

  const resolved = await loadResolvedMatchById(id, signal);
  if (resolved !== null) {
    return { ...resolved, currentSource: null, historyAmbiguous: false, reserves, rules };
  }

  throw new ProgramDetailError('not-found', '指定された番組が見つかりません');
}
