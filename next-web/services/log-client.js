const HISTORY_PATH = '/api/log/history.json';
const VALID_NAMES = new Set(['operator', 'scheduler', 'wui', 'mirakurun']);
const HISTORY_NAMES = new Set(['operator', 'scheduler', 'wui']);

function assertName(name) {
  if (!VALID_NAMES.has(name)) throw new Error('不明なログ種別です');
}

async function requestJson(url, signal) {
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

export async function listLogFiles(name, signal) {
  assertName(name);
  if (!HISTORY_NAMES.has(name)) return [];
  const result = await requestJson(`${HISTORY_PATH}?name=${encodeURIComponent(name)}`, signal);
  if (!result || !Array.isArray(result.files)) throw new Error('ログ履歴APIの応答が不正です');
  return result.files;
}

export async function loadRecentLog(name, signal) {
  assertName(name);
  const url = `/api/log/${encodeURIComponent(name)}.txt`;
  const response = await fetch(url, { method: 'GET', cache: 'no-store', signal });
  if (response.status === 204) return [];
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const text = await response.text();
  return text === '' ? [] : text.split(/\r?\n/).filter((line, index, values) => line !== '' || index < values.length - 1);
}

export async function loadLogChunk(id, options = {}) {
  const params = new URLSearchParams({ id, lines: String(options.lines || 300) });
  if (Number.isFinite(options.before)) params.set('before', String(options.before));
  const result = await requestJson(`${HISTORY_PATH}?${params}`, options.signal);
  if (!result || !Array.isArray(result.lines)) throw new Error('ログ履歴APIの応答が不正です');
  return result;
}

export function openLogStream(name, handlers = {}) {
  assertName(name);
  const controller = new AbortController();
  let stopped = false;

  (async () => {
    handlers.onStatus?.('connecting');
    const url = `/api/log/${encodeURIComponent(name)}/stream.txt?lines=300&follow=rotation&padding=0`;
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (response.status === 204) {
      handlers.onStatus?.('empty');
      return;
    }
    if (!response.ok || !response.body) throw new Error(`${url} returned HTTP ${response.status}`);
    handlers.onStatus?.('connected');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    while (!stopped) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() || '';
      if (parts.length > 0) handlers.onLines?.(parts);
    }
    pending += decoder.decode();
    if (!stopped && pending !== '') handlers.onLines?.([pending]);
    if (!stopped) handlers.onStatus?.('disconnected');
  })().catch(error => {
    if (error?.name !== 'AbortError' && !stopped) handlers.onError?.(error);
  });

  return () => {
    stopped = true;
    controller.abort();
  };
}
