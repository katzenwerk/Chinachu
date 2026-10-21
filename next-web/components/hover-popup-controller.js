const DEFAULT_OPEN_DELAY_MS = 200;
const DEFAULT_CLOSE_DELAY_MS = 10000;

export function createHoverPopupController({
  root,
  trigger,
  panel,
  openDelay = DEFAULT_OPEN_DELAY_MS,
  closeDelay = DEFAULT_CLOSE_DELAY_MS,
  hover = true,
  onOpen = null,
  onClose = null
}) {
  let openTimer = null;
  let closeTimer = null;
  let opened = false;
  let openSource = null;

  function clearOpenTimer() {
    window.clearTimeout(openTimer);
    openTimer = null;
  }

  function clearCloseTimer() {
    window.clearTimeout(closeTimer);
    closeTimer = null;
  }

  function setOpen(next, source = 'programmatic') {
    clearOpenTimer();
    clearCloseTimer();
    if (opened === next) return;
    opened = next;
    openSource = next ? source : null;
    panel.hidden = !next;
    root.classList.toggle('is-open', next);
    trigger.setAttribute('aria-expanded', String(next));
    if (next) onOpen?.(source); else onClose?.(source);
  }

  function scheduleOpen(event) {
    if (event.pointerType && event.pointerType !== 'mouse') return;
    clearCloseTimer();
    if (opened || openTimer !== null) return;
    openTimer = window.setTimeout(() => {
      openTimer = null;
      setOpen(true, 'hover');
    }, openDelay);
  }

  function scheduleClose(event) {
    if (event?.pointerType && event.pointerType !== 'mouse') return;
    clearOpenTimer();
    clearCloseTimer();
    if (!opened || root.contains(document.activeElement)) return;
    closeTimer = window.setTimeout(() => {
      closeTimer = null;
      if (!root.matches(':hover') && !root.contains(document.activeElement)) setOpen(false, 'timeout');
    }, closeDelay);
  }

  function handleTriggerClick(event) {
    event.preventDefault();
    if (opened && openSource === 'hover') {
      clearOpenTimer();
      clearCloseTimer();
      openSource = 'click';
      return;
    }
    setOpen(!opened, 'click');
  }

  function handleDocumentPointerDown(event) {
    if (opened && !root.contains(event.target)) setOpen(false, 'outside');
  }

  function handleDocumentKeyDown(event) {
    if (event.key !== 'Escape' || !opened) return;
    event.preventDefault();
    setOpen(false, 'escape');
    trigger.focus();
  }

  function handleFocusOut() {
    window.setTimeout(() => {
      if (!root.contains(document.activeElement)) scheduleClose();
    }, 0);
  }

  if (hover) {
    trigger.addEventListener('pointerenter', scheduleOpen);
    root.addEventListener('pointerenter', clearCloseTimer);
    root.addEventListener('pointerleave', scheduleClose);
  }
  root.addEventListener('focusin', clearCloseTimer);
  root.addEventListener('focusout', handleFocusOut);
  trigger.addEventListener('click', handleTriggerClick);
  document.addEventListener('pointerdown', handleDocumentPointerDown, true);
  document.addEventListener('keydown', handleDocumentKeyDown);

  return {
    isOpen() { return opened; },
    open(source = 'programmatic') { setOpen(true, source); },
    close(source = 'programmatic') { setOpen(false, source); },
    destroy() {
      clearOpenTimer();
      clearCloseTimer();
      if (hover) {
        trigger.removeEventListener('pointerenter', scheduleOpen);
        root.removeEventListener('pointerenter', clearCloseTimer);
        root.removeEventListener('pointerleave', scheduleClose);
      }
      root.removeEventListener('focusin', clearCloseTimer);
      root.removeEventListener('focusout', handleFocusOut);
      trigger.removeEventListener('click', handleTriggerClick);
      document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
      document.removeEventListener('keydown', handleDocumentKeyDown);
      if (opened) setOpen(false, 'destroy');
    }
  };
}

export { DEFAULT_CLOSE_DELAY_MS, DEFAULT_OPEN_DELAY_MS };
