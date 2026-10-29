// Keep in sync with styles/mobile.css; short landscape phones also use the shell.
export const MOBILE_QUERY = '(max-width: 640px), (max-width: 940px) and (max-height: 500px) and (pointer: coarse)';

// Tablet header popovers become inline toolbars on phones, using the same DOM.
export function headerCompactMedia(maxWidth) {
  const compact = window.matchMedia(`(max-width: ${maxWidth}px)`);
  const mobile = window.matchMedia(MOBILE_QUERY);
  const listeners = new Map();
  const media = {
    get matches() { return compact.matches && !mobile.matches; },
    addEventListener(type, listener) {
      const notify = () => listener(media);
      listeners.set(listener, notify);
      compact.addEventListener(type, notify);
      mobile.addEventListener(type, notify);
    },
    removeEventListener(type, listener) {
      const notify = listeners.get(listener);
      if (!notify) return;
      compact.removeEventListener(type, notify);
      mobile.removeEventListener(type, notify);
      listeners.delete(listener);
    }
  };
  return media;
}

// Reuse right-click handlers, permissions and confirmation dialogs.
export function appendMobileContextButton(target, host = target) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mobile-context-button';
  button.textContent = '…';
  button.setAttribute('aria-label', '操作メニュー');
  button.setAttribute('aria-haspopup', 'menu');
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    const rect = button.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom
    }));
  });
  host.append(button);
  return button;
}
