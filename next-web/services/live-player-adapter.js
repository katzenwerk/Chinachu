import { loadResource } from './api-client.js';
import { createLiveProgramController } from './live-program-controller.js';
import { subscribeScheduleNotifications } from './realtime-client.js';

const livePlayerModuleUrl = new URL('../lib/live-player.js', import.meta.url).href;
const recordedPlayerModuleUrl = new URL('../lib/recorded-player.js', import.meta.url).href;

let activeOverlay = null;
let requestGeneration = 0;

export function recordedPlaybackErrorText(error) {
  const detail = String(error?.message || error || '原因不明');
  const status = Number(error?.status || error?.statusCode);
  const fileMissing = status === 404 || status === 410 || /(?:HTTP|status(?: code)?[=: ]+)\s*(?:404|410)\b/i.test(detail);
  return `${fileMissing ? 'ファイルなし' : '再生エラー'}: ${detail}`;
}

export function isRecordedCompatPlaybackAvailable(nav = typeof navigator === 'undefined' ? null : navigator) {
  if (!nav) return false;
  const userAgent = String(nav.userAgent || '');
  const vendor = String(nav.vendor || '');
  const userAgentData = nav.userAgentData || null;
  const platform = String(userAgentData?.platform || nav.platform || '');
  const mobileOrTv = userAgentData?.mobile === true ||
    /(?:Android|Mobile|Silk|Kindle|KF[A-Z0-9]+|AFT[A-Z0-9]*|Smart-?TV|SMART-TV|HbbTV|Tizen|Web0S|WebOS|NetCast)/i.test(userAgent);
  if (mobileOrTv) return true;
  const safari = /Safari\//.test(userAgent) && /Apple Computer/i.test(vendor) &&
    !/(?:Chrome|Chromium|CriOS|Edg|EdgiOS|OPR|FxiOS|Firefox)/i.test(userAgent);
  if (safari) return true;
  return !(/(?:Windows|Win32|Win64|MacIntel|macOS|Linux|Chrome OS)/i.test(platform) ||
    /(?:Windows NT|Macintosh|X11|CrOS)/i.test(userAgent));
}

export function closeActiveLiveOverlay() {
  requestGeneration += 1;
  const overlay = activeOverlay;
  activeOverlay = null;
  if (overlay) overlay.close();
}

export async function openRecordingLiveOverlay(model) {
  if (!model.liveChannel) throw new Error('ライブ視聴に必要なチャンネル情報がありません');
  closeActiveLiveOverlay();
  const generation = ++requestGeneration;
  const module = await import(livePlayerModuleUrl);
  if (generation !== requestGeneration) return null;

  let overlay = null;
  let programController = null;
  overlay = module.openLiveOverlay(model.liveChannel.id, {
    apiBaseUrl: '/api/',
    channelName: model.liveChannel.name,
    managedProgramInfo: true,
    onClose: () => {
      programController?.dispose();
      if (activeOverlay === overlay) activeOverlay = null;
    }
  });
  if (generation !== requestGeneration) {
    overlay.close();
    return null;
  }
  programController = createLiveProgramController({
    channelId: model.liveChannel.id,
    initialSchedule: Array.isArray(model.liveSchedule) ? model.liveSchedule : [{
      id: model.liveChannel.id,
      programs: model.liveProgram ? [model.liveProgram] : []
    }],
    loadSchedule: () => loadResource('schedule', { force: true }),
    subscribeSchedule: subscribeScheduleNotifications,
    onProgram: (program, update) => overlay.setProgramInfo(program, update)
  });
  if (!Array.isArray(model.liveSchedule)) programController.refreshSchedule();
  activeOverlay = overlay;
  return overlay;
}

export function openChasePlaybackOverlay(model) {
  if (!model?.id) throw new Error('追っかけ再生に必要な番組情報がありません');
  return openRecordedPlaybackOverlay({ ...model, playable: true, recordedId: model.id, chase: true });
}

export async function openRecordedPlaybackOverlay(model) {
  if (!model?.playable || !model.recordedId) throw new Error('この録画は再生できません');
  closeActiveLiveOverlay();
  const generation = ++requestGeneration;
  const module = await import(recordedPlayerModuleUrl);
  if (generation !== requestGeneration) return null;

  const overlay = document.createElement('div');
  overlay.className = 'program-live-overlay recorded-playback-overlay';
  overlay.tabIndex = -1;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', `${model.title}の録画再生`);
  overlay.innerHTML = `
    <div class="program-live-panel recorded-playback-panel">
      <div class="program-live-header recorded-playback-header">
        <div class="program-live-header-content"><div class="recorded-playback-title"></div><div class="recorded-playback-status" role="status"></div></div>
        <button class="chinachu-live-player-close" type="button" aria-label="録画再生を閉じる" title="閉じる">×</button>
      </div>
      <div class="recorded-playback-frame"></div>
    </div>`;
  overlay.querySelector('.recorded-playback-title').textContent = model.chase ? `${model.title}（追っかけ再生）` : model.title;
  if (model.chase) overlay.setAttribute('aria-label', `${model.title}の追っかけ再生`);
  const status = overlay.querySelector('.recorded-playback-status');
  const frame = overlay.querySelector('.recorded-playback-frame');
  const closeButton = overlay.querySelector('.chinachu-live-player-close');
  document.body.append(overlay);

  let player = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (activeOverlay?.overlay === overlay) activeOverlay = null;
    player?.destroy();
    overlay.removeEventListener('click', closeFromBackdrop);
    overlay.removeEventListener('keydown', closeFromKeyboard);
    closeButton.removeEventListener('click', close);
    window.removeEventListener('pagehide', close);
    overlay.remove();
  };
  const closeFromBackdrop = event => {
    if (event.target === overlay) close();
  };
  const closeFromKeyboard = event => {
    if (event.key === 'Escape' && !document.fullscreenElement) close();
  };
  overlay.addEventListener('click', closeFromBackdrop);
  overlay.addEventListener('keydown', closeFromKeyboard);
  closeButton.addEventListener('click', close);
  window.addEventListener('pagehide', close, { once: true });
  activeOverlay = { close, overlay };

  const encodedId = encodeURIComponent(model.recordedId);
  const chaseQuery = new URLSearchParams();
  if (model.recordingStart) chaseQuery.set('recordingStart', String(model.recordingStart));
  if (model.programStart) chaseQuery.set('programStart', String(model.programStart));
  const chaseBase = `/api/recording/${encodedId}/chase`;
  const chaseSuffix = chaseQuery.size ? `?${chaseQuery}` : '';
  const chaseStatusUrl = model.chase ? new URL(`${chaseBase}.json${chaseSuffix}`, document.baseURI).href : undefined;
  player = module.createRecordedPlayer(frame, {
    chaseStatusUrl,
    compatUrl: model.chase ? undefined : `/api/recorded/${encodedId}/watch.mp4?profile=compat`,
    compatHlsUrl: model.chase ? undefined : `/api/recorded/${encodedId}/watch-hls.json?profile=compat`,
    onStatus: text => { if (!closed) status.textContent = text; },
    onEnded: () => { if (!closed) status.textContent = '再生が終了しました'; },
    onError: error => { if (!closed) status.textContent = recordedPlaybackErrorText(error); }
  });
  try {
    overlay.focus({ preventScroll: true });
  } catch (_) {
    overlay.focus();
  }
  try {
    await player.load(model.chase ? new URL(`${chaseBase}.m2ts${chaseSuffix}`, document.baseURI).href : `/api/recorded/${encodedId}/file.m2ts`);
  } catch (error) {
    if (!closed) status.textContent = recordedPlaybackErrorText(error);
  }
  return { close, player, overlay };
}

export async function mountRecordedPlayback(frame, model, { mode = 'standard', onEnded, onError } = {}) {
  if (!model?.playable || !model.recordedId) throw new Error('この録画は再生できません');
  const module = await import(recordedPlayerModuleUrl);
  const encodedId = encodeURIComponent(model.recordedId);
  const player = module.createRecordedPlayer(frame, {
    compatUrl: `/api/recorded/${encodedId}/watch.mp4?profile=compat`,
    compatHlsUrl: `/api/recorded/${encodedId}/watch-hls.json?profile=compat`,
    onEnded: typeof onEnded === 'function' ? onEnded : () => {},
    onError: typeof onError === 'function' ? onError : () => {}
  });
  try {
    if (mode === 'compat') await player.loadCompat();
    else await player.load(`/api/recorded/${encodedId}/file.m2ts`);
    return player;
  } catch (error) {
    player.destroy();
    throw error;
  }
}
