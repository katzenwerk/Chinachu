import { invalidateResources, loadResources } from './api-client.js';

async function json(response, label) {
  if (!response.ok) throw new Error(`${label}に失敗しました (HTTP ${response.status})`);
  return response.json();
}

export async function loadTimetableData(options = {}) {
  const resources = await loadResources(['schedule', 'reserves', 'recording', 'rules'], options);
  return {
    schedule: Array.isArray(resources.schedule) ? resources.schedule : [],
    reserves: Array.isArray(resources.reserves) ? resources.reserves : [],
    recording: Array.isArray(resources.recording) ? resources.recording : [],
    rules: Array.isArray(resources.rules) ? resources.rules : []
  };
}

export function refreshTimetableData(names) {
  invalidateResources(names);
  return loadTimetableData();
}

export function loadWuiConfig() {
  return fetch('/api/wui-config.json', { headers: { Accept: 'application/json' }, cache: 'no-store' })
    .then(response => response.status === 404
      ? { version: 1, timetable: { channelWidth: 150, hourHeight: 180 } }
      : json(response, 'WUI設定の取得'))
    .catch(error => ({
      version: 1,
      timetable: { channelWidth: 150, hourHeight: 180 },
      loadWarning: error.message
    }));
}

export function saveTimetableConfig(timetable) {
  return fetch('/api/wui-config.json', {
    method: 'PUT', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ timetable })
  }).then(response => json(response, 'WUI設定の保存'));
}

async function mutate(url, method, label, body = null) {
  const response = await fetch(url, {
    method, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  await json(response, label);
  invalidateResources(['reserves', 'rules']);
}

export const reserveProgram = id => mutate(`/api/program/${encodeURIComponent(id)}.json`, 'PUT', '録画予約');
export const unreserveProgram = id => mutate(`/api/reserves/${encodeURIComponent(id)}.json`, 'DELETE', '予約取消');
export const setReserveSkip = (id, skip) => mutate(`/api/reserves/${encodeURIComponent(id)}/${skip ? 'skip' : 'unskip'}.json`, 'PUT', skip ? 'スキップ' : 'スキップ取消');
export const createRule = rule => mutate('/api/rules.json', 'POST', 'ルール作成', rule);
