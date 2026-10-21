import { invalidateResources, loadResource } from './api-client.js';

export const STORAGE_REFRESH_INTERVAL_MS = 15000;

const listeners = new Set();
let state = { status: 'loading', data: null, error: null, loadedAt: null };
let refreshPromise = null;
let refreshQueued = false;
let forceQueued = false;
let timer = null;

function emit() {
  listeners.forEach(listener => listener(state));
}

function requestRefresh(force = false) {
  refreshQueued = true;
  forceQueued = forceQueued || force;
  if (refreshPromise !== null) return refreshPromise;
  refreshPromise = (async () => {
    while (refreshQueued) {
      const shouldForce = forceQueued;
      refreshQueued = false;
      forceQueued = false;
      if (shouldForce) invalidateResources(['storage']);
      try {
        const data = await loadResource('storage');
        if (!data || !Array.isArray(data.storages)) throw new Error('Storage API response is invalid');
        state = { status: 'ready', data, error: null, loadedAt: Date.now() };
      } catch (error) {
        state = { ...state, status: 'error', error };
      }
      emit();
    }
  })().finally(() => {
    refreshPromise = null;
    if (refreshQueued) requestRefresh();
  });
  return refreshPromise;
}

function start() {
  if (timer !== null) return;
  requestRefresh(state.data !== null);
  timer = window.setInterval(() => requestRefresh(true), STORAGE_REFRESH_INTERVAL_MS);
}

function stopIfUnused() {
  if (listeners.size !== 0 || timer === null) return;
  window.clearInterval(timer);
  timer = null;
}

export function subscribeStorageData(listener) {
  listeners.add(listener);
  start();
  listener(state);
  return () => {
    listeners.delete(listener);
    stopIfUnused();
  };
}

export function retryStorageData() {
  return requestRefresh(true);
}

export async function refreshStorageCapacity(storageId) {
  const response = await fetch('/api/storage/refresh.json', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ storageId: storageId || null })
  });
  let result = null;
  try { result = await response.json(); } catch (_) {}
  if (!response.ok) throw new Error(result?.message || `容量情報の更新に失敗しました（HTTP ${response.status}）`);
  await requestRefresh(true);
  return result;
}
