const URL = '/api/recorded/auto-analysis.json';
let latest = null;
const listeners = new Set();

async function request(action, signal) {
  const reading = action === 'auto-status';
  const response = await fetch(URL, {
    method: reading ? 'GET' : 'POST',
    headers: { Accept: 'application/json', ...(!reading ? { 'Content-Type': 'application/json' } : {}) },
    cache: 'no-store', signal, ...(!reading ? { body: JSON.stringify({ action }) } : {})
  });
  const value = await response.json();
  if (!response.ok || value?.autoAnalysisVersion !== 1) {
    throw new Error(value?.message || '自動TS解析の状態を取得できませんでした。');
  }
  latest = value;
  listeners.forEach(listener => listener(value));
  return value;
}

export const loadAutoTsStatus = signal => request('auto-status', signal);
export const requestAutoTsAction = action => request(action);
export const getAutoTsStatus = () => latest;
export function subscribeAutoTsStatus(listener) {
  listeners.add(listener);
  if (latest) listener(latest);
  return () => listeners.delete(listener);
}
