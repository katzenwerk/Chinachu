import { invalidateResources, loadResource } from './api-client.js';
import { subscribeRecordingNotifications } from './realtime-client.js';

const listeners = new Set();
let state = { status: 'loading', programs: null, error: null };
let unsubscribeRealtime = null;
let refreshPromise = null;
let refreshQueued = false;
let forceQueued = false;

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
      if (shouldForce) invalidateResources(['recording']);
      try {
        const programs = await loadResource('recording');
        if (!Array.isArray(programs)) throw new Error('Recording API response is invalid');
        state = { status: 'ready', programs, error: null };
      } catch (error) {
        state = { status: 'error', programs: null, error };
      }
      emit();
    }
  })().finally(() => {
    refreshPromise = null;
    if (refreshQueued) requestRefresh();
  });
  return refreshPromise;
}

function ensureStarted() {
  if (unsubscribeRealtime !== null) return;
  unsubscribeRealtime = subscribeRecordingNotifications(() => requestRefresh(true));
  requestRefresh();
}

export function subscribeRecordingData(listener) {
  listeners.add(listener);
  ensureStarted();
  listener(state);
  return () => listeners.delete(listener);
}

export function retryRecordingData() {
  return requestRefresh(true);
}
