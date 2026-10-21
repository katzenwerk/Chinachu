function programEnd(program) {
  const explicitEnd = Number(program?.end);
  if (Number.isFinite(explicitEnd)) return explicitEnd;
  const start = Number(program?.start);
  const seconds = Number(program?.seconds);
  return Number.isFinite(start) && Number.isFinite(seconds) ? start + seconds * 1000 : NaN;
}

export function findCurrentChannelProgram(schedule, channelId, now) {
  const channel = Array.isArray(schedule) ? schedule.find(item => item?.id === channelId) : null;
  if (!channel) return null;
  return (channel.programs || []).find(program => {
    const start = Number(program?.start);
    const end = programEnd(program);
    return Number.isFinite(start) && Number.isFinite(end) && start <= now && now < end;
  }) || null;
}

function nextBoundary(schedule, channelId, now, currentProgram) {
  if (currentProgram) return programEnd(currentProgram);
  const channel = Array.isArray(schedule) ? schedule.find(item => item?.id === channelId) : null;
  const starts = (channel?.programs || [])
    .map(program => Number(program?.start))
    .filter(start => Number.isFinite(start) && start > now);
  return starts.length ? Math.min(...starts) : null;
}

function programSignature(program) {
  if (!program) return 'null';
  return JSON.stringify([
    program.id ?? null,
    program.key ?? null,
    program.title ?? null,
    program.fullTitle ?? null,
    program.description ?? null,
    program.detail ?? null,
    Number(program.start),
    programEnd(program)
  ]);
}

export function createLiveProgramController({
  channelId,
  initialSchedule = [],
  loadSchedule,
  subscribeSchedule,
  onProgram,
  clock = () => Date.now(),
  setTimer = (callback, delay) => window.setTimeout(callback, delay),
  clearTimer = timer => window.clearTimeout(timer),
  documentRef = typeof document === 'undefined' ? null : document
}) {
  let schedule = Array.isArray(initialSchedule) ? initialSchedule : [];
  let timer = null;
  let disposed = false;
  let signature = null;
  let refreshPending = null;
  const MAX_TIMER_DELAY = 2147483647;

  const clearBoundaryTimer = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };

  const evaluate = ({ reason = 'boundary', rebaseProgress = false } = {}) => {
    if (disposed) return;
    clearBoundaryTimer();
    const now = clock();
    const program = findCurrentChannelProgram(schedule, channelId, now);
    const nextSignature = programSignature(program);
    const changed = nextSignature !== signature;
    signature = nextSignature;
    if (changed || rebaseProgress) onProgram?.(program, { now, changed, rebaseProgress, reason });

    const boundary = nextBoundary(schedule, channelId, now, program);
    if (Number.isFinite(boundary)) {
      const delay = Math.max(0, Math.min(MAX_TIMER_DELAY, boundary - now));
      timer = setTimer(() => {
        timer = null;
        evaluate({ reason: 'boundary', rebaseProgress: true });
      }, delay);
    }
  };

  const refreshSchedule = () => {
    if (disposed || typeof loadSchedule !== 'function') return Promise.resolve();
    if (refreshPending) return refreshPending;
    refreshPending = Promise.resolve()
      .then(() => loadSchedule())
      .then(nextSchedule => {
        if (disposed) return;
        schedule = Array.isArray(nextSchedule) ? nextSchedule : [];
        evaluate({ reason: 'schedule', rebaseProgress: true });
      })
      .catch(() => {})
      .finally(() => { refreshPending = null; });
    return refreshPending;
  };

  const visibilityChanged = () => {
    if (documentRef?.visibilityState === 'visible') {
      evaluate({ reason: 'visibility', rebaseProgress: true });
    }
  };
  const unsubscribeSchedule = typeof subscribeSchedule === 'function'
    ? subscribeSchedule(refreshSchedule)
    : null;
  documentRef?.addEventListener?.('visibilitychange', visibilityChanged);
  evaluate({ reason: 'initial', rebaseProgress: true });

  return {
    refreshSchedule,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearBoundaryTimer();
      unsubscribeSchedule?.();
      documentRef?.removeEventListener?.('visibilitychange', visibilityChanged);
    }
  };
}
