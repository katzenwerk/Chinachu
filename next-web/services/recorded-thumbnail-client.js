const TERMINAL_FAILURES = new Set(['source-missing', 'failed']);
const readyListeners = new Set();

export function subscribeRecordedThumbnailReady(listener) {
  readyListeners.add(listener);
  return () => readyListeners.delete(listener);
}

export function notifyRecordedThumbnailReady(recordedId, updatedAt) {
  readyListeners.forEach(listener => listener({ recordedId, updatedAt }));
}

function thumbnailBaseUrl(recordedId) {
  return `/api/recorded/${encodeURIComponent(recordedId)}/thumbnail`;
}

export function recordedThumbnailImageUrl(recordedId, cacheKey = null) {
  const url = `${thumbnailBaseUrl(recordedId)}.jpg`;
  return cacheKey === null ? url : `${url}?_n=${encodeURIComponent(cacheKey)}`;
}

async function readJson(response, fallbackMessage) {
  let body = null;
  try { body = await response.json(); } catch (_) {}
  if (!response.ok) {
    const error = new Error(body?.message || `${fallbackMessage} (HTTP ${response.status})`);
    error.status = response.status;
    error.code = body?.error || body?.reason || null;
    error.thumbnailStatus = body?.status || null;
    throw error;
  }
  return body || {};
}

export async function requestRecordedThumbnail(recordedId, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(`${thumbnailBaseUrl(recordedId)}.json`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    signal: options.signal
  });
  return readJson(response, 'サムネイル生成を要求できませんでした');
}

export async function loadRecordedThumbnailStatus(recordedId, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(`${thumbnailBaseUrl(recordedId)}.json`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    signal: options.signal
  });
  return readJson(response, 'サムネイル生成状態を取得できませんでした');
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error('Aborted');
      error.name = 'AbortError';
      reject(error);
      return;
    }
    const timer = window.setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      window.clearTimeout(timer);
      const error = new Error('Aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
}

export async function generateAndWaitForRecordedThumbnail(recordedId, options = {}) {
  const intervalMs = Number.isFinite(options.intervalMs) ? Math.max(250, options.intervalMs) : 1000;
  const maxChecks = Number.isInteger(options.maxChecks) ? Math.max(1, options.maxChecks) : 30;
  const waitImpl = options.waitImpl || wait;
  const notify = typeof options.onStatus === 'function' ? options.onStatus : () => {};
  let state = await requestRecordedThumbnail(recordedId, options);
  notify(state);
  if (state.status === 'complete') return state;
  if (TERMINAL_FAILURES.has(state.status)) return state;
  if (state.status !== 'queued' && state.status !== 'processing') return state;

  for (let index = 0; index < maxChecks; index += 1) {
    await waitImpl(intervalMs, options.signal);
    state = await loadRecordedThumbnailStatus(recordedId, options);
    notify(state);
    if (state.status === 'complete' || TERMINAL_FAILURES.has(state.status)) return state;
    if (state.status !== 'queued' && state.status !== 'processing') return state;
  }
  return { ...state, status: 'failed', available: false, reason: 'status-timeout' };
}
