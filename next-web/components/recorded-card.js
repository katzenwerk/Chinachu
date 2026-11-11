import { applyResultWarningTooltip } from './storage-warning.js';
import { createChannelLogo } from './channel-logo.js';
import { appendMobileContextButton } from './mobile-layout.js';
import { programDetailUrl } from '../services/program-detail-client.js';
import { channelDetailText } from '../services/recording-model.js';
import { isRecordedResultPlayable, recordedResultWarnings, recordedFileState, savedTsResultInfo } from '../services/recorded-result-warnings.js';
import { buildProgramDisplayTitle } from '../services/program-title.js';
import { createProgramHover, programHoverInfo, setProgramHover } from './program-hover.js';
import { recordedThumbnailImageUrl, subscribeRecordedThumbnailReady } from '../services/recorded-thumbnail-client.js';

const dateFormatter = new Intl.DateTimeFormat('ja-JP', {
  month: '2-digit',
  day: '2-digit'
});
const timeFormatter = new Intl.DateTimeFormat('ja-JP', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function formatDateTime(start, end) {
  if (finitePositive(start) === null || finitePositive(end) === null) return '放送日時未取得';
  return `${dateFormatter.format(new Date(start))} ${timeFormatter.format(new Date(start))}–${timeFormatter.format(new Date(end))}`;
}

function formatDuration(seconds) {
  if (finitePositive(seconds) === null) return null;
  const wholeSeconds = Math.floor(Number(seconds));
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const rest = wholeSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`;
}

function channelLogoUrl(channel) {
  const id = text(channel?.id);
  return id && channel?.hasLogoData === true ? `/api/channel/${encodeURIComponent(id)}/logo.png` : null;
}

function thumbnailUrl(recordedId) {
  return `/api/recorded/${encodeURIComponent(recordedId)}/thumbnail.jpg`;
}

function detailUrl(item, recordedId) {
  const key = text(item?.key);
  return programDetailUrl(key !== '' ? { key, id: recordedId } : { id: recordedId });
}

function cardState(item) {
  if (recordedFileState(item) === 'deleted') return { key: 'deleted', label: '削除済み' };
  if (recordedFileState(item) === 'missing') return { key: 'file-missing', label: '行方不明' };
  if (item?.status === 'MISSED') return { key: 'missed', label: '未録画' };
  if (item?.status === 'SKIPPED_ONLY') return { key: 'skipped', label: 'スキップ' };
  return { key: 'recorded', label: null };
}

function savedTsCardSummary(saved) {
  const result = saved?.result;
  if (!result) return null;
  const info = savedTsResultInfo(saved);
  const parts = [];
  for (const [key, label] of [['ccErrorEvents', 'DROP疑い'], ['pcrGapEvents', '時間飛び疑い'],
    ['teiPackets', 'TEI'], ['syncErrorEvents', '同期異常疑い'], ['invalidHeaderPackets', 'ヘッダー異常'], ['pcrBackwards', 'PCR逆行']]) {
    if (Number.isFinite(result[key]) && result[key] > 0) parts.push(`${label} ${result[key].toLocaleString('ja-JP')}件`);
  }
  const labels = { NO_FINDINGS: '解析:OK', SUSPECT: '解析:異常', ERROR: '解析:失敗' };
  const label = result.completed === false && result.status !== 'ERROR' ? '解析:未完了' : labels[result.status];
  if (!label) return null;
  return { label, findings: info.findings || result.status === 'ERROR' || result.completed === false,
    description: `TS解析：${parts.length ? parts.join(' / ') : info.label}${info.description ? '\n' + info.description : ''}` };
}

function toRecordedCardModel(item, index, options = {}) {
  const recordedId = text(item?.recordedId);
  const state = cardState(item);
  const recordedDuration = finitePositive(item?.recordedDurationSeconds);
  const operatorDuration = finitePositive(item?.operatorActualSeconds);
  const channelName = text(item?.channel?.name, '放送局未取得');
  const displayTitle = buildProgramDisplayTitle(item, options.seriesTitleIndex);
  return {
    key: text(item?.key, recordedId || `recorded-card-${index}`),
    recordedId,
    detailUrl: detailUrl(item, recordedId),
    thumbnailUrl: recordedId && (item?.status === 'RECORDED' || item?.status === 'RECORDED_UNTRACKED')
      ? thumbnailUrl(recordedId)
      : null,
    fileState: state.key,
    stateLabel: state.label,
    playable: isRecordedResultPlayable(item),
    channelLogoUrl: channelLogoUrl(item?.channel),
    channelTooltip: channelDetailText(item?.channel),
    title: displayTitle.text,
    hover: programHoverInfo(item, { channelLogoUrl: channelLogoUrl(item?.channel), statuses: [state.label, ...recordedResultWarnings(item)] }),
    titleSource: displayTitle.source,
    episodeSource: displayTitle.episodeSource || null,
    channelName,
    channelLabel: [channelName, text(item?.channel?.type)].filter(Boolean).join(' / '),
    broadcastText: formatDateTime(item?.start, item?.end),
    durationText: formatDuration(recordedDuration || operatorDuration),
    recordingWarnings: recordedResultWarnings(item),
    savedTsSummary: savedTsCardSummary(item?.savedTsAnalysis)
  };
}

export function buildRecordedCardModels(items, options = {}) {
  return (Array.isArray(items) ? items : []).map((item, index) => toRecordedCardModel(item, index, options));
}

export function buildRecentRecordedModels(items, limit = 10, options = {}) {
  return (Array.isArray(items) ? items : [])
    .filter(item => (item?.status === 'RECORDED' || item?.status === 'RECORDED_UNTRACKED') &&
      text(item.recordedId) !== '')
    .sort((left, right) => {
      const leftEnd = finitePositive(left.operatorRecordingEnd) || finitePositive(left.end) || 0;
      const rightEnd = finitePositive(right.operatorRecordingEnd) || finitePositive(right.end) || 0;
      if (leftEnd !== rightEnd) return rightEnd - leftEnd;
      return String(left.key || '').localeCompare(String(right.key || ''));
    })
    .slice(0, limit)
    // Home and recorded results must use the same card model for identical entries.
    .map((item, index) => toRecordedCardModel(item, index, options));
}

export function createRecordedCard(initialModel, { onWatch, onOpenDetail } = {}) {
  const article = document.createElement('article');
  article.className = 'recorded-card';
  article.innerHTML = `
    <button class="recorded-card-thumbnail" type="button">
      <div class="recorded-card-placeholder" aria-hidden="true"><svg class="icon"><use href="#icon-film"></use></svg></div>
      <img class="recorded-card-preview" loading="lazy" decoding="async" alt="">
      <span class="recorded-card-header">
        <span class="recorded-card-channel-logo-slot"></span>
        <span class="recorded-card-title-overlay"></span>
      </span>
      <span class="recorded-card-play" aria-hidden="true"><span></span></span>
      <span class="recorded-card-duration-badge" aria-label="" hidden></span>
    </button>
    <div class="recorded-card-meta">
      <strong class="mobile-card-title"></strong>
      <span class="recorded-card-broadcast"></span>
      <span class="recorded-card-observations"></span><span class="recorded-card-actions"><span class="recorded-result-warning storage-warning is-align-right" hidden><span aria-hidden="true">⚠</span><span class="storage-warning-tip" role="tooltip"></span></span><a class="recorded-card-detail" href=""><span aria-hidden="true">ⓘ</span> 詳細</a></span>
    </div>`;

  appendMobileContextButton(article, article.querySelector('.recorded-card-actions'));
  const thumbnail = article.querySelector('.recorded-card-thumbnail');
  const preview = article.querySelector('.recorded-card-preview');
  const placeholder = article.querySelector('.recorded-card-placeholder');
  const channelLogo = createChannelLogo({}, { variant: 'thumbnail' });
  article.querySelector('.recorded-card-channel-logo-slot').replaceWith(channelLogo.element);
  const title = article.querySelector('.recorded-card-title-overlay');
  const duration = article.querySelector('.recorded-card-duration-badge');
  const play = article.querySelector('.recorded-card-play');
  const detailLink = article.querySelector('.recorded-card-detail');
  const warning = article.querySelector('.recorded-result-warning');
  applyResultWarningTooltip(warning, '');
  let currentModel = initialModel;
  const programHover = createProgramHover(article);
  article.querySelectorAll('.recorded-card-title-overlay,.mobile-card-title,.recorded-card-detail').forEach(target => setProgramHover(target, () => currentModel.hover));
  let currentThumbnailUrl = null;
  let signature = null;
  const unsubscribeThumbnail = subscribeRecordedThumbnailReady(({ recordedId, updatedAt }) => {
    if (String(currentModel.recordedId) !== String(recordedId) || !currentModel.thumbnailUrl) return;
    currentThumbnailUrl = recordedThumbnailImageUrl(recordedId, updatedAt || Date.now());
    preview.src = currentThumbnailUrl;
  });

  preview.addEventListener('load', () => {
    if (preview.getAttribute('src') !== currentThumbnailUrl) return;
    preview.classList.add('is-ready');
    placeholder.hidden = true;
  });
  preview.addEventListener('error', () => {
    if (preview.getAttribute('src') !== currentThumbnailUrl) return;
    preview.classList.remove('is-ready');
    placeholder.hidden = false;
  });
  function update(model) {
    const nextSignature = JSON.stringify(model);
    if (signature === nextSignature) return false;
    signature = nextSignature;
    currentModel = model;
    article.dataset.recordedKey = model.key;
    article.dataset.fileState = model.fileState;
    article.className = `recorded-card is-${model.fileState}`;
    const canOpenDetail = !model.playable && model.detailUrl && typeof onOpenDetail === 'function';
    thumbnail.disabled = !model.playable && !canOpenDetail;
    thumbnail.setAttribute('aria-label', model.playable ? `${model.title}を再生` : `${model.title}の詳細`);
    thumbnail.title = model.playable ? '録画を再生' : (canOpenDetail ? '番組詳細を表示' : '再生できません');
    play.hidden = !model.playable;
    title.textContent = model.title;
    article.querySelector('.mobile-card-title').textContent = model.title;
    detailLink.href = model.detailUrl;
    detailLink.setAttribute('aria-label', `${model.title}の詳細`);
    const observations = (model.recordingWarnings || []).filter(item => item.key === 'drop');
    if (model.savedTsSummary) observations.push({ ...model.savedTsSummary, key: 'saved-ts' });
    const observationHost = article.querySelector('.recorded-card-observations');
    const existingObservations = new Map(Array.from(observationHost.children).map(tag => [tag.dataset.observationKey, tag]));
    const observationElements = observations.map(item => {
      const signature = JSON.stringify(item);
      const retained = existingObservations.get(item.key);
      if (retained?.dataset.observationSignature === signature) return retained;
      const tag = document.createElement('span'); tag.textContent = item.label;
      tag.dataset.observationKey = item.key;
      tag.dataset.observationSignature = signature;
      if (item.key === 'saved-ts') tag.className = `recorded-card-analysis${item.findings ? ' is-warning' : ''}`;
      applyResultWarningTooltip(tag, item.description || item.label); return tag;
    });
    const wantedObservations = new Set(observationElements);
    for (const tag of Array.from(observationHost.children)) if (!wantedObservations.has(tag)) tag.remove();
    let observationCursor = observationHost.firstChild;
    for (const tag of observationElements) {
      if (tag === observationCursor) observationCursor = observationCursor.nextSibling;
      else observationHost.insertBefore(tag, observationCursor);
    }
    const otherWarnings = (model.recordingWarnings || []).filter(item => !['drop', 'saved-ts'].includes(item.key));
    const warningLabels = otherWarnings.map(item => item.label);
    const warningDescriptions = otherWarnings.map(item => item.description || item.label);
    warning.hidden = warningLabels.length === 0;
    warning.classList.toggle('is-deleted', model.fileState === 'deleted');
    warning.querySelector('[aria-hidden="true"]').textContent = model.fileState === 'deleted' ? '✕' : '⚠';
    warning.setAttribute('aria-label', warningLabels.length === 0 ? '' : warningDescriptions.join('\n'));
    warning.querySelector('.storage-warning-tip').textContent = warningDescriptions.join('\n');
    if (warningLabels.length === 0) warning.removeAttribute('tabindex');
    else warning.tabIndex = 0;
    article.querySelector('.recorded-card-broadcast').textContent = model.broadcastText;
    const badgeText = model.stateLabel || model.durationText;
    duration.textContent = badgeText || '';
    duration.setAttribute('aria-label', model.stateLabel || (model.durationText === null ? '' : `実録画時間 ${model.durationText}`));
    duration.hidden = badgeText === null || badgeText === undefined;

    if (currentThumbnailUrl !== model.thumbnailUrl) {
      currentThumbnailUrl = model.thumbnailUrl;
      preview.classList.remove('is-ready');
      placeholder.hidden = false;
      preview.alt = `${model.title}のサムネイル`;
      if (model.thumbnailUrl === null) preview.removeAttribute('src');
      else preview.src = model.thumbnailUrl;
    }
    channelLogo.update({
      url: model.channelLogoUrl,
      name: model.channelName,
      fallbackText: model.channelName,
      tooltip: model.channelTooltip
    });
    return true;
  }

  thumbnail.addEventListener('click', async () => {
    if (!currentModel.playable) {
      if (currentModel.detailUrl && typeof onOpenDetail === 'function') onOpenDetail(currentModel);
      return;
    }
    if (typeof onWatch !== 'function') return;
    thumbnail.disabled = true;
    try {
      await onWatch(currentModel);
    } catch (error) {
      thumbnail.title = `再生を開始できませんでした: ${error?.message || error}`;
    } finally {
      thumbnail.disabled = !currentModel.playable && typeof onOpenDetail !== 'function';
    }
  });
  detailLink.addEventListener('click', event => {
    if (typeof onOpenDetail !== 'function') return;
    event.preventDefault();
    onOpenDetail(currentModel);
  });

  update(initialModel);
  return {
    element: article,
    update,
    dispose() {
      programHover.dispose();
      unsubscribeThumbnail();
      preview.removeAttribute('src');
      channelLogo.dispose();
    }
  };
}
