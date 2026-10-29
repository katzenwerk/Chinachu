const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 3500;
const DEFAULT_LONG_OUTAGE_MS = 60000;
const DEFAULT_RESUME_GRACE_MS = 2000;

export function createWuiConnectionMonitor(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch.bind(globalThis);
  const now = options.now || Date.now;
  const schedule = options.setTimeout || globalThis.setTimeout.bind(globalThis);
  const cancel = options.clearTimeout || globalThis.clearTimeout.bind(globalThis);
  const documentRef = options.document || globalThis.document;
  const intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const longOutageMs = options.longOutageMs || DEFAULT_LONG_OUTAGE_MS;
  const resumeGraceMs = options.resumeGraceMs || DEFAULT_RESUME_GRACE_MS;
  const listeners = new Set();
  let timer = null;
  let timeout = null;
  let inFlight = null;
  let probeController = null;
  let probeSequence = 0;
  let started = false;
  let socketStatus = 'unknown';
  let subscribeSocket = options.subscribeSocket || null;
  let unsubscribeSocket = null;
  let suspended = false;
  let resumeGraceTimer = null;
  let resumeGraceActive = false;
  let offlineBeforeSuspend = false;
  let transitionSequence = 0;
  let state = {
    status: 'checking', failures: 0, instanceId: null, startedAt: null,
    disconnectedAt: null, prolonged: false, transition: null
  };

  function emit() { listeners.forEach(listener => listener(state)); }
  function update(values) { state = { ...state, ...values }; emit(); }
  function transition(kind) { return { id: ++transitionSequence, kind, at: now() }; }
  function scheduleNext(delay = intervalMs) {
    if (suspended) return;
    cancel(timer);
    timer = schedule(() => probe(), delay);
  }
  function validPayload(value) {
    return value?.schemaVersion === 1 && typeof value.instanceId === 'string' && value.instanceId !== ''
      && Number.isFinite(value.startedAt);
  }

  function invalidateProbe() {
    probeSequence += 1;
    probeController?.abort();
    probeController = null;
    inFlight = null;
    cancel(timeout);
    timeout = null;
  }

  async function probe() {
    if (inFlight) return inFlight;
    if (suspended) return state;
    if (documentRef?.hidden) { scheduleNext(); return state; }
    const controller = new AbortController();
    const requestSequence = ++probeSequence;
    probeController = controller;
    timeout = schedule(() => controller.abort(), timeoutMs);
    const request = (async () => {
      try {
        const response = await fetchImpl(`/api/wui-alive.json?probe=${now()}`, {
          method: 'GET', headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
          cache: 'no-store', signal: controller.signal
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        if (!validPayload(payload)) throw new Error('Invalid liveness response');
        if (requestSequence !== probeSequence) return state;
        if (socketStatus === 'disconnected') {
          update({ prolonged: state.disconnectedAt !== null && now() - state.disconnectedAt >= longOutageMs });
          return state;
        }
        const hadIdentity = state.instanceId !== null;
        const wasOffline = state.status === 'offline';
        const changed = hadIdentity && state.instanceId !== payload.instanceId;
        update({
          status: 'online', failures: 0, instanceId: payload.instanceId, startedAt: payload.startedAt,
          disconnectedAt: null, prolonged: false,
          transition: changed ? transition('started') : (wasOffline ? transition('reconnected') : null)
        });
      } catch (error) {
        if (requestSequence !== probeSequence) return state;
        const failures = state.failures + 1;
        const offline = failures >= 2;
        const disconnectedAt = offline ? (state.disconnectedAt || now()) : state.disconnectedAt;
        const firstOffline = offline && state.status !== 'offline';
        update({
          status: offline ? 'offline' : state.status,
          failures,
          disconnectedAt,
          prolonged: offline && now() - disconnectedAt >= longOutageMs,
          transition: firstOffline ? transition('disconnected') : null
        });
      } finally {
        if (requestSequence === probeSequence) {
          cancel(timeout);
          timeout = null;
          probeController = null;
          inFlight = null;
          if (started) scheduleNext();
        }
      }
      return state;
    })();
    inFlight = request;
    return request;
  }

  function clearResumeGrace() {
    cancel(resumeGraceTimer);
    resumeGraceTimer = null;
    resumeGraceActive = false;
  }

  function markSocketDisconnected() {
    if (documentRef?.hidden) return;
    const firstOffline = state.status !== 'offline';
    const disconnectedAt = state.disconnectedAt || now();
    update({
      status: 'offline', failures: Math.max(2, state.failures), disconnectedAt,
      prolonged: now() - disconnectedAt >= longOutageMs,
      transition: firstOffline ? transition('disconnected') : null
    });
    if (started) scheduleNext();
  }

  function scheduleResumeConfirmation() {
    cancel(resumeGraceTimer);
    resumeGraceTimer = schedule(() => {
      resumeGraceTimer = null;
      resumeGraceActive = false;
      if (started && !suspended && socketStatus === 'disconnected') markSocketDisconnected();
    }, resumeGraceMs);
  }

  function handleSocket(socketState) {
    if (!socketState || socketState.status === 'idle' || socketState.status === 'unavailable') return;
    if (socketState.status === 'disconnected') {
      socketStatus = 'disconnected';
      invalidateProbe();
      if (suspended || documentRef?.hidden) return;
      if (resumeGraceActive) {
        update({ status: 'checking', failures: 0, disconnectedAt: null, prolonged: false, transition: null });
        scheduleResumeConfirmation();
        return;
      }
      markSocketDisconnected();
      return;
    }
    if (socketState.status === 'connected') {
      socketStatus = 'connected';
      clearResumeGrace();
      invalidateProbe();
      probe();
    }
  }

  function attachSocket() {
    if (!started || unsubscribeSocket !== null || typeof subscribeSocket !== 'function') return;
    unsubscribeSocket = subscribeSocket(handleSocket);
  }

  function handleVisibility() {
    if (!documentRef?.hidden) {
      cancel(timer);
      timer = null;
      if (socketStatus === 'disconnected') {
        update({ status: 'checking', failures: 0, disconnectedAt: null, prolonged: false, transition: null });
        resumeGraceActive = true;
        scheduleResumeConfirmation();
      }
      probe();
    }
  }
  function start() {
    if (started) return;
    started = true;
    documentRef?.addEventListener?.('visibilitychange', handleVisibility);
    attachSocket();
    probe();
  }
  function suspend() {
    if (!started || suspended) return;
    suspended = true;
    offlineBeforeSuspend = state.status === 'offline';
    cancel(timer);
    timer = null;
    clearResumeGrace();
    invalidateProbe();
  }
  function resume() {
    if (!started || !suspended) return;
    suspended = false;
    if (offlineBeforeSuspend) {
      offlineBeforeSuspend = false;
      if (socketStatus === 'connected') probe();
      else scheduleNext(0);
      return;
    }
    offlineBeforeSuspend = false;
    resumeGraceActive = true;
    update({ status: 'checking', failures: 0, disconnectedAt: null, prolonged: false, transition: null });
    scheduleResumeConfirmation();
    probe();
  }
  function stop() {
    started = false;
    suspended = false;
    offlineBeforeSuspend = false;
    cancel(timer);
    timer = null;
    clearResumeGrace();
    invalidateProbe();
    unsubscribeSocket?.();
    unsubscribeSocket = null;
    documentRef?.removeEventListener?.('visibilitychange', handleVisibility);
  }
  return {
    subscribe(listener) {
      listeners.add(listener);
      start();
      listener(state);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
      };
    },
    probe,
    getState() { return state; },
    setSocketSubscriber(subscriber) {
      unsubscribeSocket?.();
      unsubscribeSocket = null;
      subscribeSocket = typeof subscriber === 'function' ? subscriber : null;
      attachSocket();
    },
    suspend,
    resume,
    start,
    stop
  };
}

export function connectionActivityForTransition(event) {
  if (event?.kind === 'started') return { kind: 'wui-started', title: 'WUIが起動しました' };
  if (event?.kind === 'reconnected') return { kind: 'wui-reconnected', title: 'WUIに再接続しました' };
  return null;
}

const monitor = createWuiConnectionMonitor();
export const subscribeWuiConnection = listener => monitor.subscribe(listener);
export const checkWuiConnectionNow = () => monitor.probe();
export const getWuiConnectionState = () => monitor.getState();
export const setWuiConnectionSocketSubscriber = subscriber => monitor.setSocketSubscriber(subscriber);
export const suspendWuiConnectionMonitoring = () => monitor.suspend();
export const resumeWuiConnectionMonitoring = () => monitor.resume();
