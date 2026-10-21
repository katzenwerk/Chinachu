const STORAGE_KEY = 'chinachu.next.service-restart';
const listeners = new Set();
let completionSequence = 0;

function readPending() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (value && (value.target === 'operator' || value.target === 'wui') && Number(value.deadline) > Date.now()) return value;
    localStorage.removeItem(STORAGE_KEY);
  } catch (_) {}
  return null;
}

let state = { pending: readPending(), completion: null };
function emit() { listeners.forEach(listener => listener(state)); }

export function getPendingRestart() { return state.pending; }

export function setPendingRestart(pending) {
  state = { ...state, pending, completion: null };
  try {
    if (pending) localStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
    else localStorage.removeItem(STORAGE_KEY);
  } catch (_) {}
  emit();
}

export function completePendingRestart(succeeded, message, options = {}) {
  const pending = state.pending;
  if (!pending) return false;
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  state = {
    pending: null,
    completion: {
      id: ++completionSequence,
      target: pending.target,
      succeeded: succeeded === true,
      message,
      notify: options.notify !== false,
      at: Date.now()
    }
  };
  emit();
  return true;
}

export function subscribePendingRestart(listener) {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

window.addEventListener('storage', event => {
  if (event.key !== STORAGE_KEY) return;
  state = { ...state, pending: readPending(), completion: null };
  emit();
});
