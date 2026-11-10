const recordingListeners = new Set();
const reservationListeners = new Set();
const recordedListeners = new Set();
const matchListeners = new Set();
const scheduleListeners = new Set();
const seriesListeners = new Set();
const connectionListeners = new Set();
let socket = null;
let authRefreshPending = false;
let connectionSequence = 0;
let connectionState = { status: 'idle', reason: null, id: 0 };

function emitConnection(status, reason = null) {
  connectionState = { status, reason, id: ++connectionSequence };
  connectionListeners.forEach(listener => listener(connectionState));
}

function disconnectIfUnused() {
  if (recordingListeners.size !== 0 || reservationListeners.size !== 0 || recordedListeners.size !== 0 || matchListeners.size !== 0 || scheduleListeners.size !== 0
      || seriesListeners.size !== 0 || connectionListeners.size !== 0 || socket === null) return;
  socket.off('notify-recording');
  socket.off('notify-reserves');
  socket.off('notify-recorded');
  socket.off('notify-match');
  socket.off('notify-schedule');
  socket.off('notify-series');
  socket.off('notify-series-status');
  socket.off('connect');
  socket.off('disconnect');
  socket.off('auth-expired');
  socket.off('auth-refresh');
  socket.disconnect();
  socket = null;
  emitConnection('idle', 'client-unused');
}

function connect() {
  if (socket !== null || typeof window.io !== 'function') return;
  try {
    emitConnection('connecting');
    socket = window.io(window.location.origin, {
      path: '/socket.io',
      transports: ['polling', 'websocket']
    });
    socket.on('notify-recording', () => {
      recordingListeners.forEach(listener => listener());
    });
    socket.on('notify-reserves', () => {
      reservationListeners.forEach(listener => listener());
    });
    socket.on('notify-recorded', () => {
      recordedListeners.forEach(listener => listener());
    });
    socket.on('notify-match', () => {
      matchListeners.forEach(listener => listener());
    });
    socket.on('notify-schedule', () => {
      scheduleListeners.forEach(listener => listener());
    });
    socket.on('notify-series', update => seriesListeners.forEach(listener => listener(update)));
    socket.on('notify-series-status', () => seriesListeners.forEach(listener => listener({ statusOnly: true })));
    socket.on('connect', () => emitConnection('connected'));
    socket.on('disconnect', reason => {
      if (reason === 'io server disconnect' && authRefreshPending) {
        authRefreshPending = false;
        const disconnected = socket;
        disconnected.off();
        socket = null;
        emitConnection('disconnected', reason);
        window.setTimeout(connect, 0);
        return;
      }
      if (reason === 'io server disconnect') {
        window.location.reload();
        return;
      }
      emitConnection(reason === 'io client disconnect' ? 'idle' : 'disconnected', reason || null);
    });
    socket.on('auth-expired', () => window.location.reload());
    socket.on('auth-refresh', () => { authRefreshPending = true; });
  } catch (_) {
    socket = null;
    emitConnection('unavailable');
  }
}

export function subscribeRecordingNotifications(listener) {
  recordingListeners.add(listener);
  connect();
  return () => {
    recordingListeners.delete(listener);
    disconnectIfUnused();
  };
}

// A temporary disconnect needs fresh data, not a new route and page instance.
export function refreshRealtimeData() {
  const listeners = new Set([
    ...recordingListeners, ...reservationListeners, ...recordedListeners,
    ...matchListeners, ...scheduleListeners
  ]);
  listeners.forEach(listener => listener());
}

export function subscribeSeriesNotifications(listener) {
  seriesListeners.add(listener);
  connect();
  return () => {
    seriesListeners.delete(listener);
    disconnectIfUnused();
  };
}

export function subscribeReservationNotifications(listener) {
  reservationListeners.add(listener);
  connect();
  return () => {
    reservationListeners.delete(listener);
    disconnectIfUnused();
  };
}

export function subscribeRecordedNotifications(listener) {
  recordedListeners.add(listener);
  connect();
  return () => {
    recordedListeners.delete(listener);
    disconnectIfUnused();
  };
}

export function subscribeMatchNotifications(listener) {
  matchListeners.add(listener);
  connect();
  return () => {
    matchListeners.delete(listener);
    disconnectIfUnused();
  };
}

export function subscribeScheduleNotifications(listener) {
  scheduleListeners.add(listener);
  connect();
  return () => {
    scheduleListeners.delete(listener);
    disconnectIfUnused();
  };
}

export function subscribeRealtimeConnection(listener) {
  connectionListeners.add(listener);
  connect();
  listener(connectionState);
  return () => {
    connectionListeners.delete(listener);
    disconnectIfUnused();
  };
}
