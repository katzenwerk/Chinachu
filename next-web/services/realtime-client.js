const recordingListeners = new Set();
const reservationListeners = new Set();
const recordedListeners = new Set();
const matchListeners = new Set();
const scheduleListeners = new Set();
const seriesListeners = new Set();
const connectionListeners = new Set();
let socket = null;
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
  socket.off('connect');
  socket.off('disconnect');
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
    socket.on('notify-series', () => seriesListeners.forEach(listener => listener()));
    socket.on('connect', () => emitConnection('connected'));
    socket.on('disconnect', reason => {
      emitConnection(reason === 'io client disconnect' ? 'idle' : 'disconnected', reason || null);
    });
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
