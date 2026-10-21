// Display toast messages in arrival order without replacing an active message.
// Pause while the notification panel is open, preserving the active message.
export function createToastQueue({ show, hide, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, gapMs = 500 }) {
  const pending = [];
  let active = null;
  let timer = null;
  let deadline = 0;
  let remaining = 0;
  let paused = false;

  function schedule(delay, callback) {
    deadline = now() + delay;
    timer = setTimer(() => {
      timer = null;
      callback();
    }, delay);
  }

  function displayNext() {
    if (paused || active !== null || timer !== null || pending.length === 0) return;
    active = pending.shift();
    remaining = active.duration;
    show(active);
    schedule(remaining, finishActive);
  }

  function finishActive() {
    hide();
    active = null;
    // Keep a visible break between notifications, including bursts.
    schedule(gapMs, displayNext);
  }

  return {
    enqueue(message, duration, level) {
      pending.push({ message, duration: Number.isFinite(duration) ? Math.max(0, duration) : 2200, level });
      displayNext();
    },
    pause() {
      if (paused) return;
      paused = true;
      if (active === null) return;
      remaining = Math.max(0, deadline - now());
      clearTimer(timer);
      timer = null;
      hide();
    },
    resume() {
      if (!paused) return;
      paused = false;
      if (active !== null) {
        show(active);
        schedule(remaining, finishActive);
      } else {
        displayNext();
      }
    }
  };
}
