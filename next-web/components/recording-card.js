import { openChasePlaybackOverlay } from '../services/live-player-adapter.js';
import { applyStorageWarning } from './storage-warning.js';
import { createChannelLogo } from './channel-logo.js';
import { createProgramHover, setProgramHover } from './program-hover.js';

function previewUrl(model) {
  return `/api/recording/${encodeURIComponent(model.id)}/preview.jpg?width=480&height=270&_n=${Date.now()}`;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('録画プレビューを読み込めませんでした'));
    image.src = url;
  });
}

export function createRecordingCard(initialModel, { onWatch, variant = 'default' } = {}) {
  const homeVariant = variant === 'home';
  const playbackActions = `<div class="recording-playback-actions">
    <button class="button recording-live-button" type="button"><svg class="icon icon-small" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4.9 16.1C1 12.2 1 5.8 4.9 1.9M7.8 4.7a6.14 6.14 0 0 0-.8 7.5"/><circle cx="12" cy="9" r="2"/><path d="M16.2 4.8c2 2 2.26 5.11.8 7.47M19.1 1.9a9.96 9.96 0 0 1 0 14.1M9.5 18h5m-6.5 4 4-11 4 11"/></svg><span>LIVE視聴</span></button>
    <button class="button recording-chase-button" type="button"><svg class="icon icon-small" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 9.003a1 1 0 0 1 1.517-.859l4.997 2.997a1 1 0 0 1 0 1.718l-4.997 2.997A1 1 0 0 1 9 14.996z"/><circle cx="12" cy="12" r="10"/></svg><span>追っかけ再生</span></button>
  </div>`;
  const article = document.createElement('article');
  article.className = `recording-card${homeVariant ? ' is-home-overlay' : ''}`;
  article.innerHTML = homeVariant ? `
    <div class="recording-thumbnail">
      <div class="recording-placeholder" aria-hidden="true"><svg class="icon"><use href="#icon-record"></use></svg></div>
      <img class="recording-preview-image" hidden alt="">
      <span class="recording-card-header">
        <span class="recording-channel-logo-slot"></span>
        <span class="recording-title-overlay"></span>
      </span>
      <span class="recording-state-badge"></span>
      <div class="recording-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100"><i></i></div>
    </div>
    <div class="recording-home-footer">
      <strong class="mobile-card-title"></strong>
      <span class="mobile-recording-state mobile-only"></span>
      <span class="recording-broadcast"></span>
      <span class="recording-home-actions">
        <span class="recording-storage-warning storage-warning is-align-right" hidden><span aria-hidden="true">⚠</span><span class="storage-warning-text"></span><span class="storage-warning-tip" role="tooltip"></span></span>
      </span>
      ${playbackActions}
      <a class="recording-detail" href=""><span aria-hidden="true">ⓘ</span> 詳細</a>
    </div>
    <p class="recording-watch-error" role="status" hidden></p>` : `
    <div class="recording-thumbnail">
      <div class="recording-placeholder" aria-hidden="true"><svg class="icon"><use href="#icon-record"></use></svg></div>
      <img class="recording-preview-image" hidden alt="">
      <span class="recording-channel-logo-slot"></span>
      <div class="recording-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100"><i></i></div>
    </div>
    <div class="recording-card-body">
      <h3></h3>
      <p class="recording-program-meta"></p>
      <p class="recording-storage-warning storage-warning" hidden><span aria-hidden="true">⚠</span><span class="storage-warning-text"></span><span class="storage-warning-tip" role="tooltip"></span></p>
      <div class="recording-card-meta"><span class="recording-status" hidden></span><span class="recording-elapsed"></span><span class="recording-remaining"></span></div>
      ${playbackActions}
      <a class="recording-detail" href="">詳細</a>
      <p class="recording-watch-error" role="status" hidden></p>
    </div>`;

  const image = article.querySelector('.recording-preview-image');
  const channelLogo = createChannelLogo({}, { variant: 'thumbnail', focusable: true });
  article.querySelector('.recording-channel-logo-slot').replaceWith(channelLogo.element);
  const placeholder = article.querySelector('.recording-placeholder');
  const progress = article.querySelector('.recording-progress');
  const progressBar = progress.querySelector('i');
  const watchButton = article.querySelector('.recording-live-button');
  const watchError = article.querySelector('.recording-watch-error');
  const title = article.querySelector(homeVariant ? '.recording-title-overlay' : 'h3');
  const storageWarning = article.querySelector('.recording-storage-warning');
  const stateBadge = article.querySelector('.recording-state-badge');
  const detailLink = article.querySelector('.recording-detail');
  const chaseButton = article.querySelector('.recording-chase-button');
  const opening = { live: false, chase: false };
  let currentModel = initialModel;
  const programHover = createProgramHover(article);
  article.querySelectorAll('h3,.recording-title-overlay,.mobile-card-title,.recording-detail').forEach(target => setProgramHover(target, () => currentModel.hover));
  let currentPreviewKey = null;
  let previewController = null;
  let activeObjectUrl = null;
  let disposed = false;

  function updateChannelLogo(model) {
    channelLogo.update({
      url: model.channelLogoUrl,
      name: model.channelName,
      fallbackText: model.channelIdentifier || model.channelName,
      tooltip: model.channelTooltip
    });
  }

  function updateDynamic(model) {
    const value = model.progress === null ? 0 : model.progress;
    progressBar.style.width = `${value}%`;
    progress.setAttribute('aria-label', model.progress === null ? '録画進捗 未取得' : `録画進捗 ${model.progressText}`);
    progress.setAttribute('aria-valuenow', String(value));
    if (homeVariant) {
      const stateText = model.status === 'preparing' ? model.statusText : model.remainingText;
      stateBadge.textContent = stateText;
      article.querySelector('.mobile-recording-state').textContent = stateText;
      stateBadge.setAttribute('aria-label', model.status === 'preparing' ? '録画準備中' : stateText);
    } else {
      article.querySelector('.recording-elapsed').textContent = model.elapsedText;
      article.querySelector('.recording-remaining').textContent = model.remainingText;
    }
  }

  async function requestPreview(model, force = false) {
    if (disposed || model.previewKey === null) return;
    if (!force && model.previewKey === currentPreviewKey) return;
    if (previewController !== null) {
      if (model.previewKey === currentPreviewKey) return;
      previewController.abort();
    }

    currentPreviewKey = model.previewKey;
    const requestedKey = model.previewKey;
    const controller = new AbortController();
    previewController = controller;
    let nextObjectUrl = null;
    try {
      const response = await fetch(previewUrl(model), {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      nextObjectUrl = URL.createObjectURL(await response.blob());
      await loadImage(nextObjectUrl);
      if (disposed || controller.signal.aborted || currentPreviewKey !== requestedKey) return;
      const previousObjectUrl = activeObjectUrl;
      activeObjectUrl = nextObjectUrl;
      nextObjectUrl = null;
      image.src = activeObjectUrl;
      image.alt = `${model.title}の録画プレビュー`;
      image.hidden = false;
      placeholder.hidden = true;
      if (previousObjectUrl) URL.revokeObjectURL(previousObjectUrl);
    } catch (error) {
      if (error.name !== 'AbortError' && image.hidden) placeholder.hidden = false;
    } finally {
      if (nextObjectUrl) URL.revokeObjectURL(nextObjectUrl);
      if (previewController === controller) previewController = null;
    }
  }

  function refreshPreview() {
    if (disposed || currentModel.previewKey === null || previewController !== null) return;
    const bounds = article.getBoundingClientRect();
    if (bounds.bottom < 0 || bounds.top > window.innerHeight) return;
    requestPreview(currentModel, true);
  }

  function update(model) {
    currentModel = model;
    article.dataset.recordingId = model.id || '';
    title.textContent = model.title;
    detailLink.href = model.detailUrl || '';
    detailLink.hidden = model.detailUrl === null;
    detailLink.setAttribute('aria-label', `${model.title}の詳細`);
    if (homeVariant) {
      article.querySelector('.mobile-card-title').textContent = model.title;
      article.querySelector('.recording-broadcast').textContent = model.broadcastText;
    } else {
      article.querySelector('.recording-program-meta').textContent = model.channelMetaText;
    }
    applyStorageWarning(storageWarning, model.storageNotice);
    if (!homeVariant) {
      const status = article.querySelector('.recording-status');
      status.className = `recording-status is-${model.status}`;
      status.textContent = model.statusText;
      status.hidden = model.status !== 'preparing';
    }
    updatePlaybackButtons();
    updateChannelLogo(model);
    updateDynamic(model);
    requestPreview(model);
  }

  function dispose() {
    disposed = true;
    programHover.dispose();
    if (previewController) previewController.abort();
    previewController = null;
    if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = null;
    channelLogo.dispose();
  }

  function updatePlaybackButtons() {
    watchButton.disabled = opening.live || !currentModel.liveChannel || typeof onWatch !== 'function';
    chaseButton.disabled = opening.chase || !currentModel.chaseModel;
  }

  async function startPlayback(kind) {
    const button = kind === 'live' ? watchButton : chaseButton;
    if (disposed || button.disabled) return;
    opening[kind] = true;
    updatePlaybackButtons();
    watchError.hidden = true;
    try {
      if (kind === 'live') await onWatch(currentModel);
      else await openChasePlaybackOverlay(currentModel.chaseModel);
    } catch (error) {
      if (!disposed) {
        const label = kind === 'live' ? 'LIVE視聴' : '追っかけ再生';
        watchError.textContent = `${label}を開始できませんでした: ${error.message || error}`;
        watchError.hidden = false;
      }
    } finally {
      opening[kind] = false;
      if (!disposed) updatePlaybackButtons();
    }
  }
  watchButton.addEventListener('click', () => startPlayback('live'));
  chaseButton.addEventListener('click', () => startPlayback('chase'));

  update(initialModel);
  return { element: article, update, updateDynamic, refreshPreview, dispose };
}
