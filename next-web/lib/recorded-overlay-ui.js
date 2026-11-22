import { MOBILE_QUERY } from '../components/mobile-layout.js';
import { setControlLabel } from './player-control-icons.js';

// Presentation only: the existing player owns media, controls and their actions.
export function mountRecordedOverlayUi({ stage, picture, controls, captionsButton, speedSelect,
  compatButton, fullscreenButton, status, retryButton, programInfo, onClose }) {
  stage.classList.add('recorded-overlay-stage');
  controls.classList.add('program-live-controls');
  status.classList.add('program-live-status');
  retryButton.classList.add('recorded-overlay-retry');
  const chrome = document.createElement('div');
  chrome.className = 'program-live-chrome is-description-open';
  const header = document.createElement('div');
  header.className = 'program-live-header';
  const content = document.createElement('div');
  content.className = 'program-live-header-content';
  const info = document.createElement('div');
  info.className = 'program-live-meta';
  const channel = document.createElement('div');
  channel.className = 'program-live-channel';
  if (programInfo.channelLogoUrl) {
    const logo = document.createElement('img');
    logo.className = 'program-live-channel-logo';
    logo.alt = '';
    logo.src = programInfo.channelLogoUrl;
    logo.addEventListener('error', () => { logo.hidden = true; }, { once: true });
    channel.append(logo);
  }
  if (programInfo.channelName) {
    const name = document.createElement('strong');
    name.className = 'program-live-channel-name';
    name.textContent = programInfo.channelName;
    channel.append(name);
  }
  const kind = document.createElement('span');
  kind.className = 'program-live-label';
  kind.textContent = programInfo.kind;
  channel.append(kind);
  const title = document.createElement('div');
  title.className = 'program-live-program';
  title.textContent = programInfo.title;
  info.append(channel, title);
  if (programInfo.detail) {
    const detail = document.createElement('div');
    detail.className = 'program-live-description';
    detail.textContent = programInfo.detail;
    info.append(detail);
  }
  content.append(info);
  header.append(content);
  const buttons = document.createElement('div');
  buttons.className = 'program-live-button-group';
  buttons.append(captionsButton);
  if (speedSelect) buttons.append(speedSelect);
  buttons.append(compatButton, fullscreenButton);
  if (retryButton.parentElement) buttons.append(retryButton);
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  setControlLabel(closeButton, '閉じる', 'close');
  buttons.append(closeButton);
  controls.replaceChildren(buttons, status);
  chrome.append(header, controls);

  const mobile = window.matchMedia(MOBILE_QUERY);
  const coarse = window.matchMedia('(pointer: coarse)');
  const portrait = window.matchMedia('(orientation: portrait)');
  const isPhone = () => mobile.matches && coarse.matches;
  let timer = null, hovered = false, pressed = false;
  const disposers = [];
  const listen = (target, event, handler) => {
    target.addEventListener(event, handler);
    disposers.push(() => target.removeEventListener(event, handler));
  };
  const show = () => {
    window.clearTimeout(timer);
    stage.classList.add('is-ui-visible');
    if (isPhone() && portrait.matches) return;
    timer = window.setTimeout(() => {
      if (hovered || pressed || controls.querySelector(':focus-visible')) return;
      stage.classList.remove('is-ui-visible');
    }, 3000);
  };
  const layout = () => {
    const outside = isPhone() && portrait.matches;
    stage.classList.toggle('is-touch-live', isPhone());
    stage.classList.toggle('is-portrait-live', outside);
    if (outside) stage.append(chrome); else picture.append(chrome);
    hovered = false;
    pressed = false;
    show();
  };
  for (const media of [mobile, coarse, portrait]) listen(media, 'change', layout);
  for (const event of ['pointermove', 'pointerdown', 'keydown']) listen(stage, event, show);
  for (const event of ['focusin', 'focusout']) listen(controls, event, show);
  for (const button of buttons.children) {
    listen(button, 'pointerenter', event => {
      if (event.pointerType !== 'mouse' || isPhone()) return;
      hovered = true;
      show();
    });
    listen(button, 'pointerleave', event => {
      if (event.pointerType !== 'mouse' || isPhone()) return;
      hovered = false;
      show();
    });
  }
  listen(controls, 'pointerdown', () => { pressed = true; show(); });
  const release = () => { if (pressed) { pressed = false; show(); } };
  listen(window, 'pointerup', release);
  listen(window, 'pointercancel', release);
  listen(closeButton, 'click', onClose);
  layout();
  return {
    show,
    destroy() {
      window.clearTimeout(timer);
      for (const dispose of disposers) dispose();
      chrome.remove();
    }
  };
}
