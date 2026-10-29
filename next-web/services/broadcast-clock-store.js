const listeners = new Set();
let state = { status: 'loading', data: null, error: null };
let refreshRequest = null;
let refreshTimer = null;
let visibilityInstalled = false;

function emit() {
  listeners.forEach(listener => listener(state));
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    if (document.hidden) scheduleRefresh(); else refreshBroadcastClock();
  }, 60000);
}

function handleVisibilityChange() {
  if (!document.hidden) refreshBroadcastClock();
}

export function refreshBroadcastClock() {
  if (refreshRequest !== null) return refreshRequest;
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  refreshRequest = fetch('/api/clock.json', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: controller.signal
  }).then(response => {
    if (!response.ok) throw new Error(`/api/clock.json returned HTTP ${response.status}`);
    return response.json();
  }).then(payload => {
    const receivedAt = performance.now();
    if (!Number.isFinite(payload?.serverTimeMs)) throw new Error('Clock API response is invalid');
    state = {
      status: 'ready',
      data: {
        ...payload,
        synchronizedServerTimeMs: payload.serverTimeMs + (receivedAt - startedAt) / 2,
        synchronizedAtPerformanceMs: receivedAt
      },
      error: null
    };
    emit();
  }).catch(error => {
    state = { status: 'error', data: state.data, error };
    emit();
  }).finally(() => {
    clearTimeout(timeout);
    refreshRequest = null;
    scheduleRefresh();
  });
  return refreshRequest;
}

function start() {
  if (!visibilityInstalled) {
    document.addEventListener('visibilitychange', handleVisibilityChange);
    visibilityInstalled = true;
  }
  refreshBroadcastClock();
}

function stopIfUnused() {
  if (listeners.size !== 0) return;
  clearTimeout(refreshTimer);
  refreshTimer = null;
  if (visibilityInstalled) {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    visibilityInstalled = false;
  }
}

export function subscribeBroadcastClock(listener) {
  listeners.add(listener);
  start();
  listener(state);
  return () => {
    listeners.delete(listener);
    stopIfUnused();
  };
}
