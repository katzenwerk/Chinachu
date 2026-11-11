import { applyResultWarningTooltip } from './storage-warning.js';
import { createChannelLogo } from './channel-logo.js';
import { openRuleEditorDialog, programRuleSeed } from './rule-editor-dialog.js';
import { deleteRecordedProgram, loadProgramDetail, ProgramDetailError, stopRecordingProgram } from '../services/program-detail-client.js';
import { buildProgramDetailModel, programSeriesContext, reservationActionLabel, seriesCorrectionActions } from '../services/program-detail-model.js';
import { reserveProgram, setReserveSkip, unreserveProgram } from '../services/timetable-client.js';
import { openRecordedPlaybackOverlay, openRecordingLiveOverlay } from '../services/live-player-adapter.js';
import { copyProgramTitle, programSearchUrl } from '../services/program-actions.js';
import { invalidateResources } from '../services/api-client.js';
import { subscribeSeriesNotifications, subscribeMatchNotifications, subscribeRecordedNotifications, subscribeRecordingNotifications, subscribeReservationNotifications } from '../services/realtime-client.js';
import { applySeriesThumbnail, loadSeriesProjection } from '../services/series-client.js';
import { buildSeriesEventIndex, seriesEventHref } from '../services/series-event-model.js';
import { openSeriesCorrectionDialog } from './series-correction-dialog.js';
import { openRecordedMaintenanceDialog, createSavedTsSummary } from './recorded-maintenance-dialog.js';
import { loadRecordedThumbnailStatus, requestRecordedThumbnail, recordedThumbnailImageUrl,
  notifyRecordedThumbnailReady } from '../services/recorded-thumbnail-client.js';

let activeDialog = null;

function addFact(list, label, value, className = '') {
  if (value === null || value === undefined || value === '') return;
  const term = document.createElement('dt');
  const description = document.createElement('dd');
  term.textContent = label;
  description.textContent = value;
  if (className) description.className = className;
  list.append(term, description);
}

function formatParsedProgramValue(value) {
  if (value === undefined || value === null || value === '') return '未取得';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch (_) {
    return String(value);
  }
}

function errorText(error) {
  return error instanceof ProgramDetailError ? error.message : String(error?.message || error);
}

function searchLink(label, href) {
  const link = document.createElement('a');
  link.className = 'button';
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = label;
  return link;
}

function createDescription(model) {
  const section = document.createElement('section');
  section.className = 'program-modal-description';
  const values = [];
  if (model.summary) values.push(['概要', model.summary]);
  if (model.detail && model.detail !== model.summary) values.push(['詳細', model.detail]);
  if (values.length === 0) values.push(['番組情報', '番組情報はありません。']);
  values.forEach(([label, value]) => {
    const block = document.createElement('section');
    const heading = document.createElement('h3');
    const text = document.createElement('p');
    heading.textContent = label;
    text.textContent = value;
    block.append(heading, text);
    section.append(block);
  });
  if (model.attributes.length) {
    const attributes = document.createElement('div');
    attributes.className = 'program-detail-attributes';
    model.attributes.forEach(value => {
      const badge = document.createElement('span');
      badge.textContent = value;
      attributes.append(badge);
    });
    section.append(attributes);
  }
  if (model.overlappingReservations !== null) {
    const overlap = document.createElement('section');
    const heading = document.createElement('h3');
    heading.textContent = '同時間帯に重なる予約';
    const note = document.createElement('p');
    note.textContent = '放送時間が重なる予約です。実際のチューナー不足の原因を特定するものではありません。';
    const list = document.createElement('ul');
    model.overlappingReservations.forEach(item => {
      const entry = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button';
      button.textContent = `${item.title} · ${item.channel} · ${item.dateTime}`;
      button.disabled = !item.id;
      button.dataset.programId = item.id || '';
      button.addEventListener('click', () => openProgramDetailDialog({ id: item.id }));
      entry.append(button);
      list.append(entry);
    });
    if (!model.overlappingReservations.length) note.textContent += ' 現在の予約一覧に該当する予約はありません。';
    overlap.className = 'program-modal-overlaps';
    overlap.append(heading, note, list);
    section.append(overlap);
  }
  return section;
}

function createRecordingStatusTags(statuses) {
  const tags = document.createElement('div');
  tags.className = 'program-recording-status-tags';
  (Array.isArray(statuses) ? statuses : []).forEach(status => {
    const tag = document.createElement('span');
    tag.className = `program-recording-status-tag is-${status.kind || 'confirmed'} is-${status.tone || 'warning'}`;
    tag.textContent = status.label;
    if (['drop', 'saved-ts'].includes(status.key)) applyResultWarningTooltip(tag, status.description || status.label);
    else tag.title = status.description || status.label;
    tags.append(tag);
  });
  return tags;
}

function createTsDropSummary(summary) {
  if (summary === null) return null;
  const section = document.createElement('section');
  section.className = 'program-ts-drop-summary';
  const heading = document.createElement('h4');
  const facts = document.createElement('dl');
  heading.textContent = 'Operator TS監視';
  addFact(facts, 'CC異常合計', summary.ccErrorTotal === null ? '不明' : `${summary.ccErrorTotal.toLocaleString('ja-JP')}件`);
  if (summary.pids.length === 0) {
    addFact(facts, 'PID別CC異常', 'なし');
  } else {
    summary.pids.forEach(entry => addFact(facts, `PID ${entry.label}`, `${entry.count.toLocaleString('ja-JP')}件`));
  }
  if (summary.totalsMatch === false) {
    addFact(facts, '集計整合', `不一致（PID別合計 ${summary.pidTotal.toLocaleString('ja-JP')}件）`);
  }
  section.append(heading, facts);
  return section;
}

function seriesDecisionLabel(context, error) {
  if (error) return 'シリーズ情報取得失敗';
  if (context?.seriesId?.startsWith('local:')) return 'オリジナルシリーズ・手動関連付け';
  if (!context?.tidConfirmed) return 'TID未確定';
  if (context.manual) {
    const automaticTid = Number(context.event?.resolution?.automatic?.tid);
    const tidAlsoAutomatic = Number.isInteger(automaticTid) && automaticTid === Number(context.tid);
    if (context.manualEpisode !== null) return tidAlsoAutomatic ?
      'TID自動確定・EP手動指定' : 'TID手動確定・EP手動指定';
    const prefix = tidAlsoAutomatic ? 'TID自動確定（手動補正あり）' : 'TID手動確定';
    if (context.episodeSource === 'epg' && context.multipleEpisodeConfirmed) return `${prefix}・EPG複数話数から確定`;
    if (context.episodeSource === 'epg' && context.episodeConfirmed) return `${prefix}・EPG話数から確定`;
    if (context.multipleEpisodeConfirmed) return `${prefix}・複数EP自動確定`;
    if (context.episodeConfirmed) return `${prefix}・EP自動確定`;
    return `${prefix}・EP未確定`;
  }
  if (context.workRule?.active && context.episodeSource === 'epg') return context.multipleEpisodeConfirmed ?
    '同局作品ルールでTID確定・EPG複数話数から確定' : context.episodeConfirmed ?
      '同局作品ルールでTID確定・EPG話数から確定' : '同局作品ルールでTID確定・EP未確定';
  if (context.workRule?.active) return context.multipleEpisodeConfirmed ?
    '同局作品ルールでTID確定・複数EP自動確定' : context.episodeConfirmed ?
      '同局作品ルールでTID確定・EP自動確定' : '同局作品ルールでTID確定・EP未確定';
  if (context.episodeSource === 'epg' && context.multipleEpisodeConfirmed) return 'TID自動確定・EPG複数話数から確定';
  if (context.multipleEpisodeConfirmed) return 'TID自動確定・複数EP確定';
  if (context.episodeSource === 'epg' && context.episodeConfirmed) return 'TID自動確定・EPG話数から確定';
  return context.episodeConfirmed ? 'TID・EP自動確定' : 'TID自動確定・EP未確定';
}

function createManagement(model, seriesContext, seriesError) {
  const aside = document.createElement('aside');
  aside.className = 'program-modal-management';
  const heading = document.createElement('h3');
  heading.textContent = '管理情報';
  const facts = document.createElement('dl');
  if (model.recordingInfo) {
    addFact(facts, '予定時間', model.recordingInfo.plannedDuration);
    addFact(facts, '録画時間', model.recordingInfo.actualDuration);
    addFact(facts, 'ファイルパス', model.recordingInfo.path, 'program-modal-file-path');
    addFact(facts, '関連ルール', model.relatedRule || 'なし');
  } else {
    addFact(facts, '番組状態', model.phase.label);
    addFact(facts, '予約種別', model.reservation?.type);
    addFact(facts, 'スキップ・競合', model.reservation?.warnings?.join('・'));
    addFact(facts, '関連ルール', model.reservation?.rule || model.actions.rule.label || 'なし');
    addFact(facts, '保存先', model.reservation?.destination);
  }
  if (model.deletion) {
    addFact(facts, model.deletion.kind === 'unknown' ? '台帳情報' : '削除理由', model.deletion.reason);
    if (model.deletion.kind !== 'unknown') addFact(facts, '削除日時', model.deletion.deletedAt || '日時情報なし');
  }
  if (model.operatorRecording) {
    addFact(facts, '使用チューナー', model.operatorRecording.tunerLabel);
    addFact(facts, '録画開始（Operator）', model.operatorRecording.startLabel);
    addFact(facts, '録画終了（Operator）', model.operatorRecording.endLabel);
  }
  addFact(facts, '所属作品', seriesContext?.seriesTitle || '未確定');
  addFact(facts, 'TID', seriesContext?.seriesId?.startsWith('local:') ? '対象外（オリジナル）' : seriesContext?.tidConfirmed ? String(seriesContext.tid) : '未確定');
  addFact(facts, '話数', seriesContext?.episodeConfirmed ? seriesContext.episodeLabel :
    seriesContext?.episodeHint ? `未確定（EPG #${seriesContext.episodeHint}）` : '未確定');
  addFact(facts, '判定', seriesDecisionLabel(seriesContext, seriesError));
  const analysis = document.createElement('section');
  analysis.className = 'program-modal-analysis';
  const analysisHeading = document.createElement('h4');
  analysisHeading.textContent = 'thorn番組解析';
  const analysisFacts = document.createElement('dl');
  addFact(analysisFacts, '解析タイトル', formatParsedProgramValue(model.parsedProgram?.title));
  addFact(analysisFacts, '解析副題', formatParsedProgramValue(model.parsedProgram?.subTitle));
  addFact(analysisFacts, '解析話数', formatParsedProgramValue(model.parsedProgram?.episode));
  analysis.append(analysisHeading, analysisFacts);
  const notices = document.createElement('div');
  notices.className = 'program-detail-notices';
  [...model.warnings].filter(Boolean).forEach(value => {
    const notice = document.createElement('p');
    notice.textContent = value;
    notices.append(notice);
  });
  const id = document.createElement('small');
  id.className = 'program-modal-id';
  id.textContent = `番組ID: ${model.programId || '未取得'}`;
  const tsDropSummary = createTsDropSummary(model.tsDropInfo);
  aside.append(heading, facts);
  aside.append(analysis);
  if (tsDropSummary) aside.append(tsDropSummary);
  const savedTsSummary = createSavedTsSummary(model.savedTsAnalysis);
  if (savedTsSummary) aside.append(savedTsSummary);
  if (seriesError) {
    const notice = document.createElement('p');
    notice.textContent = 'シリーズ情報を取得できませんでした。通常の番組情報は引き続き利用できます。';
    notices.append(notice);
  }
  aside.append(notices, createRecordingStatusTags(model.recordingWarnings), id);
  return aside;
}

// Preserve display nodes and key links to other programmes by their target ID.
// Patch their existing nodes so nested scrollers, open details and focus survive.
function updateDetailSection(current, next) {
  const identity = node => node.nodeType === Node.TEXT_NODE ? '#text' :
    `${node.nodeName}:${node.className}:${node.matches('dt') ? node.textContent :
      node.matches('details') ? node.querySelector(':scope > summary')?.textContent : node.dataset.programId || ''}`;
  const available = Array.from(current.childNodes);
  let cursor = current.firstChild;
  for (const incoming of Array.from(next.childNodes)) {
    const index = available.findIndex(node => identity(node) === identity(incoming));
    const retained = index < 0 ? null : available.splice(index, 1)[0];
    const node = retained || incoming;
    if (node === cursor) cursor = cursor.nextSibling;
    else current.insertBefore(node, cursor);
    if (!retained) continue;
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue !== incoming.nodeValue) node.nodeValue = incoming.nodeValue;
      continue;
    }
    const runtimeAttribute = name => name === 'open' && node.matches('details') ||
      name === 'style' && node.matches('[popover]');
    for (const attribute of Array.from(node.attributes)) {
      if (!runtimeAttribute(attribute.name) && !incoming.hasAttribute(attribute.name)) node.removeAttribute(attribute.name);
    }
    for (const attribute of Array.from(incoming.attributes)) {
      if (!runtimeAttribute(attribute.name) && node.getAttribute(attribute.name) !== attribute.value) node.setAttribute(attribute.name, attribute.value);
    }
    updateDetailSection(node, incoming);
  }
  for (const node of available) node.remove();
}

function createThumbnail(model, onPlay, { onError = null, cacheKey = null, liveUrl = null } = {}) {
  const live = Boolean(model.media.livePreviewUrl);
  const url = live ? liveUrl : model.media.kind === 'recording' ? model.media.previewUrl
    : model.media.thumbnailUrl && recordedThumbnailImageUrl(model.media.recordedId, cacheKey);
  if (!url && !live) return null;
  const interactive = live || model.media.kind === 'recording' || model.media.playable;
  const frame = document.createElement(interactive ? 'button' : 'div');
  if (interactive) frame.type = 'button';
  frame.className = 'program-modal-thumbnail';
  if (interactive) frame.setAttribute('aria-label', `${model.title}を${live || model.media.kind === 'recording' ? 'ライブ視聴' : '再生'}`);
  if (url) {
    const image = document.createElement('img');
    image.src = url;
    image.alt = `${model.title}のサムネイル`;
    image.addEventListener('error', () => onError ? onError() : frame.remove(), { once: true });
    frame.append(image);
  } else {
    frame.classList.add('is-empty');
    const label = document.createElement('p');
    label.textContent = 'サムネイルなし';
    frame.append(label);
  }
  if (interactive) {
    const play = document.createElement('span');
    play.textContent = '▶';
    play.setAttribute('aria-hidden', 'true');
    frame.append(play);
    frame.addEventListener('click', onPlay);
  }
  return frame;
}

function thumbnailSourceKey(media) {
  return JSON.stringify([
    media?.kind, media?.recordedId, media?.livePreviewUrl,
    media?.previewUrl?.split('&_n=')[0], media?.thumbnailUrl,
    media?.visible, media?.playable
  ]);
}

export function openProgramDetailDialog({ key = null, id = null, onChanged, initialAction = null } = {}) {
  activeDialog?.close();
  const dialog = document.createElement('dialog');
  dialog.className = 'program-detail-dialog';
  dialog.setAttribute('aria-label', '番組詳細');
  dialog.innerHTML = '<article><div class="program-modal-loading">番組詳細を取得しています…</div></article>';
  document.body.append(dialog);
  dialog.showModal();
  activeDialog = dialog;
  let disposed = false;
  let controller = null;
  let logo = null;
  let busy = false;
  let stopRequested = false;
  let lastFooterSignature = null;
  let latestDetail = null;
  let latestSeriesContext = null;
  let latestSeriesError = null;
  let preferredRuleUid = null;
  let boundaryTimer = null;
  let notificationTimer = null;
  let lastRenderSignature = null;
  let lastHeaderSignature = null;
  const thumbnailController = new AbortController();
  let thumbnailTimer = null;
  let thumbnailView = null;
  let thumbnailId = null;
  let thumbnailState = null;
  let thumbnailMissing = false;
  let thumbnailChecked = false;
  let thumbnailChecking = false;
  let thumbnailRequestPending = false;
  let thumbnailError = '';
  let thumbnailAnnounced = false;
  let livePreviewController = null;
  let livePreviewUrl = null;
  let livePreviewAttempted = false;
  let livePreviewNotice = '';
  let ruleDialog = null;
  let maintenanceDialog = null;
  let pendingInitialAction = ['reserve', 'reserve-now', 'unreserve', 'skip', 'unskip', 'rule', 'delete', 'stop', 'series-change', 'series-episode', 'series-remove'].includes(initialAction)
    ? initialAction : null;
  const reloadFromNotification = resources => {
    if (disposed || !dialog.open) return;
    if (resources) invalidateResources(resources);
    window.clearTimeout(notificationTimer);
    notificationTimer = window.setTimeout(load, 200);
  };
  const unsubscribeReservation = subscribeReservationNotifications(() => reloadFromNotification(['reserves', 'rules']));
  const unsubscribeRecording = subscribeRecordingNotifications(() => reloadFromNotification(['recording', 'reserves']));
  const unsubscribeRecorded = subscribeRecordedNotifications(() => reloadFromNotification(['recorded', 'recording']));
  const unsubscribeMatch = subscribeMatchNotifications(() => reloadFromNotification());
  const unsubscribeSeries = subscribeSeriesNotifications(update => {
    if (update?.generation) reloadFromNotification();
  });

  function showFeedback(message, error = false) {
    const feedback = dialog.querySelector('footer [role="status"]');
    if (!feedback) return;
    feedback.textContent = message || '';
    feedback.classList.toggle('is-error', error);
  }

  function thumbnailFailure(state) {
    return state?.message || ({
      'output-unavailable': '画像の保存先を利用できません。',
      'ffmpeg-failed': 'FFmpegで画像を作成できませんでした。',
      timeout: '画像作成が時間内に完了しませんでした。',
      'publish-failed': '画像を保存できませんでした。',
      'queue-expired': '作成待ちが期限切れになりました。',
      'queue-full': '生成キューが混雑しています。',
      'operator-stopping': 'Operator停止中です。',
      'recorded-file-missing': '録画ファイルが見つかりません。',
      'recorded-file-deleted': '録画ファイルは削除されています。'
    })[state?.reason] || state?.reason || '画像を作成できませんでした。';
  }

  function renderThumbnail() {
    if (!thumbnailView || disposed) return;
    const { model, host } = thumbnailView;
    const signature = JSON.stringify([thumbnailSourceKey(model.media), livePreviewUrl, livePreviewNotice,
      thumbnailMissing, thumbnailState?.status, thumbnailState?.updatedAt, thumbnailState?.reason, thumbnailState?.message, thumbnailRequestPending,
      thumbnailChecking && !['queued', 'processing'].includes(thumbnailState?.status), thumbnailError]);
    if (host.dataset.thumbnailView === signature) return;
    host.dataset.thumbnailView = signature;
    host.replaceChildren();
    if (model.media.livePreviewUrl) {
      host.append(createThumbnail(model, () => play(thumbnailView?.model || model).catch(() => {}), {
        liveUrl: livePreviewUrl,
        onError: () => {
          if (disposed || thumbnailView?.host !== host) return;
          clearLivePreview();
          renderThumbnail();
        }
      }));
      if (livePreviewNotice) {
        const notice = document.createElement('p');
        notice.className = 'program-detail-action-feedback';
        notice.setAttribute('role', 'status');
        notice.textContent = livePreviewNotice;
        host.append(notice);
      }
      if (!livePreviewAttempted) {
        livePreviewAttempted = true;
        const captureController = new AbortController();
        livePreviewController = captureController;
        fetch(model.media.livePreviewUrl, {
          cache: 'no-store', credentials: 'same-origin', signal: captureController.signal
        }).then(async response => {
          if (disposed || captureController.signal.aborted || !thumbnailView?.model.media.livePreviewUrl) return;
          if (response.status === 204 && response.headers.get('X-Chinachu-Preview-Skipped') === 'recording-start-soon') {
            livePreviewNotice = '録画開始が近いためプレビューを省略しました。';
            renderThumbnail();
            return;
          }
          if (!response.ok) return;
          const blob = await response.blob();
          if (disposed || captureController.signal.aborted || !thumbnailView?.model.media.livePreviewUrl) return;
          livePreviewUrl = URL.createObjectURL(blob);
          renderThumbnail();
        }).catch(() => {});
      }
      return;
    }
    if (model.media.kind === 'recording' || model.media.thumbnailUrl && !thumbnailMissing) {
      const image = createThumbnail(model, () => play(thumbnailView?.model || model).catch(() => {}), {
        cacheKey: thumbnailState?.status === 'complete' ? thumbnailState.updatedAt || Date.now() : null,
        onError: model.media.kind === 'recorded' ? () => {
          if (thumbnailView?.host !== host || disposed) return;
          thumbnailMissing = true;
          renderThumbnail();
          if (model.media.canCreateThumbnail && !thumbnailChecked && !thumbnailChecking) checkThumbnail();
        } : null
      });
      if (image) host.append(image);
      return;
    }
    if (!model.media.visible || model.media.kind !== 'recorded') return;
    const placeholder = document.createElement('div');
    placeholder.className = 'program-modal-thumbnail is-empty';
    const label = document.createElement('p');
    label.textContent = 'サムネイルなし';
    placeholder.append(label);
    if (model.media.canCreateThumbnail) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button';
      const status = thumbnailState?.status;
      const queued = status === 'queued' || status === 'processing';
      button.disabled = thumbnailRequestPending || thumbnailChecking || queued;
      button.textContent = thumbnailRequestPending ? '受付中…' : status === 'queued' ? '作成待ち'
        : status === 'processing' ? '作成中' : status === 'complete' ? '画像を再読込'
          : status === 'failed' || status === 'source-missing' ? '再試行' : '作成';
      button.addEventListener('click', () => {
        if (status === 'complete') {
          thumbnailMissing = false;
          thumbnailState.updatedAt = Date.now();
          renderThumbnail();
        } else createMissingThumbnail();
      });
      const feedback = document.createElement('small');
      feedback.setAttribute('role', 'status');
      feedback.textContent = thumbnailError || (status === 'failed' || status === 'source-missing'
        ? thumbnailFailure(thumbnailState) : status === 'complete' ? '画像を読み込めませんでした。'
          : thumbnailChecking && !queued ? '生成状態を確認しています…' : '');
      placeholder.append(button, feedback);
    }
    host.append(placeholder);
  }

  function clearLivePreview() {
    livePreviewController?.abort();
    livePreviewController = null;
    if (livePreviewUrl) URL.revokeObjectURL(livePreviewUrl);
    livePreviewUrl = null;
    livePreviewNotice = '';
  }

  function applyThumbnailState(state) {
    thumbnailState = state;
    thumbnailError = '';
    if (state.status === 'complete' && state.available === true) {
      thumbnailMissing = false;
      if (!thumbnailAnnounced) {
        thumbnailAnnounced = true;
        applySeriesThumbnail(thumbnailId, recordedThumbnailImageUrl(thumbnailId, state.updatedAt || Date.now()));
        notifyRecordedThumbnailReady(thumbnailId, state.updatedAt);
        Promise.resolve().then(() => onChanged?.()).catch(cause => {
          if (!disposed) showFeedback(`画像は作成されましたが、一覧を更新できませんでした: ${errorText(cause)}`, true);
        });
      }
    }
    renderThumbnail();
    window.clearTimeout(thumbnailTimer);
    if (state.status === 'queued' || state.status === 'processing') {
      thumbnailTimer = window.setTimeout(checkThumbnail, 1000);
    }
  }

  async function checkThumbnail() {
    if (disposed || thumbnailChecking || !thumbnailId) return;
    const id = thumbnailId;
    thumbnailChecking = true;
    renderThumbnail();
    try {
      const state = await loadRecordedThumbnailStatus(id, { signal: thumbnailController.signal });
      if (disposed || thumbnailId !== id) return;
      thumbnailChecked = true;
      thumbnailChecking = false;
      applyThumbnailState(state);
    } catch (cause) {
      if (disposed || thumbnailId !== id || cause?.name === 'AbortError') return;
      thumbnailChecked = true;
      thumbnailChecking = false;
      thumbnailError = errorText(cause);
      renderThumbnail();
      if (['queued', 'processing'].includes(thumbnailState?.status)) {
        thumbnailTimer = window.setTimeout(checkThumbnail, 1000);
      }
    }
  }

  async function createMissingThumbnail() {
    if (disposed || thumbnailRequestPending || thumbnailChecking ||
      !thumbnailView?.model.media.canCreateThumbnail || ['queued', 'processing'].includes(thumbnailState?.status)) return;
    const id = thumbnailId;
    thumbnailRequestPending = true;
    thumbnailError = '';
    renderThumbnail();
    try {
      const state = await requestRecordedThumbnail(id, { signal: thumbnailController.signal });
      if (disposed || thumbnailId !== id) return;
      thumbnailRequestPending = false;
      applyThumbnailState(state);
    } catch (cause) {
      if (disposed || thumbnailId !== id || cause?.name === 'AbortError') return;
      thumbnailRequestPending = false;
      applyThumbnailState({ status: cause.thumbnailStatus || 'failed', reason: cause.code, message: errorText(cause) });
    }
  }

  async function refreshAfterMutation() {
    const loaded = await load();
    if (disposed) return;
    await onChanged?.();
    return loaded;
  }

  function setMutationControlsDisabled(disabled) {
    dialog.querySelectorAll('footer button').forEach(button => {
      if (disabled) {
        button.dataset.busyDisabled = button.disabled ? '1' : '0';
        button.disabled = true;
      } else {
        if (!Object.prototype.hasOwnProperty.call(button.dataset, 'busyDisabled')) return;
        button.disabled = button.dataset.busyDisabled === '1';
        delete button.dataset.busyDisabled;
      }
    });
  }

  function scheduleBoundary(model) {
    window.clearTimeout(boundaryTimer);
    boundaryTimer = null;
    const now = Date.now();
    const next = [model.broadcast?.start, model.broadcast?.end]
      .map(Number).filter(value => Number.isFinite(value) && value > now).sort((a, b) => a - b)[0];
    if (!Number.isFinite(next)) return;
    boundaryTimer = window.setTimeout(() => {
      boundaryTimer = null;
      if (!disposed && dialog.open && latestDetail) {
        render(buildProgramDetailModel({ ...latestDetail, preferredRuleUid }), latestSeriesContext, latestSeriesError);
      }
    }, Math.min(2147483647, Math.max(0, next - now + 20)));
  }

  function openRuleEditor(model) {
    const action = model.actions.rule;
    if (!['create', 'edit'].includes(action.mode) || ruleDialog?.open) return;
    let editor = null;
    editor = openRuleEditorDialog({
      row: action.mode === 'edit' ? { index: action.index, uid: action.ruleUid, rule: action.rule } : null,
      initialRule: action.mode === 'create' ? programRuleSeed(model.ruleSeed) : null,
      title: action.mode === 'create' ? 'ルールを作成' : `ルール #${action.index + 1} を編集`,
      onSaved: async result => {
        if (result.mode === 'create') preferredRuleUid = result.rule?.ruleUid || null;
        await refreshAfterMutation();
      },
      onDeleted: async () => {
        if (preferredRuleUid === action.ruleUid) preferredRuleUid = null;
        await refreshAfterMutation();
      },
      onClose: () => { if (ruleDialog === editor) ruleDialog = null; }
    });
    ruleDialog = editor;
  }

  const close = () => dialog.close();
  const play = async model => {
    close();
    if (model.media.playable) {
      await openRecordedPlaybackOverlay({ playable: true, recordedId: model.media.recordedId, title: model.title });
    } else if (model.media.liveModel) {
      await openRecordingLiveOverlay(model.media.liveModel);
    }
  };

  async function mutate(model, action, confirmReservation = false) {
    if (busy || !model.programId) return;
    busy = true;
    setMutationControlsDisabled(true);
    showFeedback('');
    try {
      if (action === 'reserve' || action === 'reserve-now') {
        if (!await reserveProgram(model.programId, { confirmReservation })) return;
      }
      if (action === 'unreserve') await unreserveProgram(model.programId);
      if (action === 'skip') await setReserveSkip(model.programId, true);
      if (action === 'unskip') await setReserveSkip(model.programId, false);
      await refreshAfterMutation();
    } catch (cause) {
      showFeedback(errorText(cause), true);
    } finally {
      busy = false;
      setMutationControlsDisabled(false);
    }
  }

  async function stopRecording(model) {
    if (busy || stopRequested || latestDetail?.program?.abort === true || model.phase.key !== 'recording') return;
    if (!window.confirm(`${model.title}\n\n録画を中止しますか？\nストリーム開始後は、そこまでの録画が短縮録画として保存されます。準備中は録画ファイルが残らず、手動予約は取り消され、ルール予約はNG扱いになります。ルール予約はスキップされます。\n録画ファイルの削除とは別の操作です。`)) return;
    busy = true;
    setMutationControlsDisabled(true);
    showFeedback('録画中止を要求しています…');
    try {
      await stopRecordingProgram(model.programId);
      stopRequested = true;
      const refreshed = await refreshAfterMutation();
      if (refreshed && latestDetail?.currentSource === 'recording') showFeedback('録画中止を要求しました。終了処理の完了を待っています。');
    } catch (cause) {
      showFeedback(`${stopRequested ? '録画中止要求は成功しましたが、表示の更新に失敗しました。' : ''}${errorText(cause)}`, true);
    } finally {
      busy = false;
      setMutationControlsDisabled(false);
      const stop = dialog.querySelector('[data-stop-recording]');
      if (stop) stop.disabled = stopRequested || latestDetail?.program?.abort === true;
    }
  }

  function openSeriesCorrection(context, focusEpisode = false) {
    if (!context?.event?.key) return;
    openSeriesCorrectionDialog({
      event: context.event,
      candidates: context.candidates,
      seriesContext: context,
      focusEpisode,
      onChanged: refreshAfterMutation
    });
  }

  async function render(model, seriesContext = null, seriesError = null) {
    const renderSignature = JSON.stringify([{
      ...model, media: { ...model.media, previewUrl: model.media.previewUrl?.split('&_n=')[0] }
    }, seriesContext, seriesError?.message || null, stopRequested, latestDetail?.program?.abort === true]);
    if (lastRenderSignature === renderSignature) return;
    const oldArticle = dialog.querySelector('article');
    const oldBody = oldArticle.querySelector(':scope > .program-modal-body');
    const oldRight = oldBody?.querySelector(':scope > .program-modal-right');
    const oldThumbnailView = thumbnailView;
    const oldThumbnailKey = oldThumbnailView ? thumbnailSourceKey(oldThumbnailView.model.media) : null;
    const previousLogo = logo;
    const article = document.createElement('article');
    const header = document.createElement('header');
    const headerSignature = JSON.stringify([model.channel, model.dateTime, model.phase, model.title]);
    header.innerHTML = '<div class="program-modal-channel"><span></span><div><p></p><div class="program-modal-title"><span class="program-modal-status"></span><span class="program-modal-status-reason" hidden></span><h2></h2></div></div></div><button class="guide-close" type="button" aria-label="閉じる">×</button>';
    const nextLogo = createChannelLogo({ name: model.channel.name, url: model.channel.logoUrl }, { variant: 'list' });
    header.querySelector('.program-modal-channel > span').replaceWith(nextLogo.element);
    header.querySelector('p').textContent = `${model.channel.name} · ${model.dateTime}`;
    const status = header.querySelector('.program-modal-status');
    status.textContent = model.phase.label;
    status.dataset.state = model.phase.key;
    const reason = header.querySelector('.program-modal-status-reason');
    reason.hidden = !model.phase.reason;
    reason.textContent = model.phase.reason?.label || '';
    reason.dataset.reason = model.phase.reason?.key || '';
    header.querySelector('h2').textContent = model.title;
    header.querySelector('.guide-close').addEventListener('click', close);

    const body = document.createElement('div');
    body.className = 'program-modal-body';
    const right = document.createElement('div');
    right.className = 'program-modal-right';
    if (thumbnailId !== model.media.recordedId) {
      window.clearTimeout(thumbnailTimer);
      thumbnailId = model.media.recordedId;
      thumbnailState = null;
      thumbnailMissing = false;
      thumbnailChecked = false;
      thumbnailChecking = false;
      thumbnailRequestPending = false;
      thumbnailError = '';
      thumbnailAnnounced = false;
    }
    const thumbnailHost = document.createElement('div');
    if (!model.media.livePreviewUrl) clearLivePreview();
    right.append(thumbnailHost);
    const management = createManagement(model, seriesContext, seriesError);
    const description = createDescription(model);
    right.append(management);
    body.append(description, right);

    const footer = document.createElement('footer');
    footer.innerHTML = '<div class="program-modal-primary"></div><div class="program-modal-search"></div><div class="program-modal-danger"></div><p role="status"></p>';
    const primary = footer.querySelector('.program-modal-primary');
    const search = footer.querySelector('.program-modal-search');
    const danger = footer.querySelector('.program-modal-danger');
    const feedback = footer.querySelector('[role="status"]');
    if (stopRequested || (model.phase.key === 'recording' && latestDetail?.program?.abort === true)) {
      feedback.textContent = model.phase.key === 'recording'
        ? '録画中止要求済みです。終了処理の完了を待っています。'
        : '録画中一覧から外れました。最終結果は録画結果・履歴で確認してください。';
    }
    const normalProgram = model.phase.key === 'program';
    if (model.actions.reservation) {
      const button = document.createElement('button');
      button.className = 'button primary';
      button.type = 'button';
      button.textContent = reservationActionLabel(model.actions.reservation);
      button.addEventListener('click', () => mutate(model, model.actions.reservation));
      primary.append(button);
    }
    if (model.media.liveModel) {
      const button = document.createElement('button');
      button.className = 'button primary';
      button.type = 'button';
      button.textContent = 'Live視聴';
      button.addEventListener('click', () => openRecordingLiveOverlay(model.media.liveModel).catch(cause => { feedback.textContent = errorText(cause); }));
      primary.append(button);
    }
    if (model.media.playable) {
      const button = document.createElement('button');
      button.className = 'button primary';
      button.type = 'button';
      button.textContent = '再生';
      button.addEventListener('click', () => play(model).catch(cause => { feedback.textContent = errorText(cause); }));
      primary.append(button);
    }
    if (model.media.downloadUrl) {
      const download = document.createElement('a');
      download.className = 'button';
      download.href = model.media.downloadUrl;
      download.download = '';
      download.textContent = 'ダウンロード';
      primary.append(download);
    }
    const rule = document.createElement('button');
    rule.className = 'button';
    rule.type = 'button';
    rule.textContent = normalProgram && model.actions.rule.mode === 'create' ? 'ルール作成' : 'ルール';
    rule.title = model.actions.rule.label || '';
    rule.disabled = model.actions.rule.mode === 'unavailable';
    rule.addEventListener('click', () => openRuleEditor(model));
    primary.append(rule);
    if (seriesContext?.seriesId) {
      const viewSeries = document.createElement('button');
      viewSeries.className = 'button';
      viewSeries.type = 'button';
      viewSeries.textContent = 'シリーズを見る';
      viewSeries.addEventListener('click', () => {
        const href = seriesEventHref(seriesContext, model.phase.key === 'reserved' ? 'reservations' : 'recordings');
        if (!href) return;
        close();
        window.location.hash = href;
      });
      primary.append(viewSeries);
    }
    let maintenanceAdded = false;
    const appendMaintenance = () => {
      if (!model.actions.recordedMaintenance || maintenanceAdded) return;
      maintenanceAdded = true;
      const check = document.createElement('button');
      check.className = 'button'; check.type = 'button'; check.textContent = 'メンテナンス';
      check.addEventListener('click', () => {
        if (maintenanceDialog?.open) return;
        maintenanceDialog = openRecordedMaintenanceDialog({ id: model.actions.recordedMaintenance.recordedId,
          title: model.title, onUpdated: refreshAfterMutation,
          getRecordingWarnings: () => latestDetail ? buildProgramDetailModel(latestDetail).recordingWarnings : model.recordingWarnings });
      });
      primary.append(check);
    };
    const seriesChange = seriesCorrectionActions(seriesContext).find(action => action.action === 'series-change');
    if (seriesChange) {
      const changeSeries = document.createElement('button');
      changeSeries.className = 'button';
      changeSeries.type = 'button';
      changeSeries.textContent = seriesChange.label;
      changeSeries.addEventListener('click', () => openSeriesCorrection(seriesContext, false));
      primary.append(changeSeries);
    }
    appendMaintenance();
    if (normalProgram) {
      const copy = document.createElement('button');
      copy.className = 'button';
      copy.type = 'button';
      copy.textContent = 'タイトルをコピー';
      copy.addEventListener('click', () => copyProgramTitle(model.title).catch(cause => showFeedback(errorText(cause), true)));
      search.append(copy);
    }
    search.append(
      searchLink('Google検索', normalProgram ? programSearchUrl('google', model.title) : `https://www.google.com/search?q=${encodeURIComponent(model.title)}`),
      searchLink('Wikipedia検索', programSearchUrl('wikipedia', model.title))
    );
    if (model.actions.stopRecording !== null) {
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.className = 'button is-danger';
      stop.dataset.stopRecording = '';
      stop.textContent = '録画中止';
      stop.disabled = stopRequested || model.actions.stopRecording.requested;
      stop.addEventListener('click', () => stopRecording(model));
      danger.append(stop);
    }
    if (model.actions.deleteRecording) {
      const remove = document.createElement('button');
      remove.className = 'button is-danger';
      remove.type = 'button';
      remove.dataset.deleteRecording = '';
      remove.textContent = '削除';
      remove.addEventListener('click', async () => {
        if (busy || !window.confirm(`${model.title}\n\n録画ファイルを削除します。録画履歴・元の保存先・保存済みサムネイルは台帳整理まで保持されます。この操作は元に戻せません。`)) return;
        busy = true;
        setMutationControlsDisabled(true);
        feedback.textContent = '録画ファイルを削除しています…';
        try {
          const result = await deleteRecordedProgram(model.actions.deleteRecording.recordedId, { signal: controller?.signal });
          feedback.textContent = result.message || '削除しました';
          await refreshAfterMutation();
          if (result.storageRefreshError) showFeedback(`録画ファイルは削除しました。容量表示の更新に失敗しました: ${result.storageRefreshError}`, true);
        } catch (cause) {
          feedback.textContent = errorText(cause);
          feedback.classList.add('is-error');
        } finally { busy = false; setMutationControlsDisabled(false); }
      });
      danger.append(remove);
    }
    article.append(header, body, footer);
    const nextFooterSignature = JSON.stringify([
      model.title, model.programId, model.phase.key, model.actions,
      model.media.liveModel, model.media.playable, model.media.recordedId,
      model.media.downloadUrl, seriesContext?.seriesId, seriesContext?.event?.key,
      seriesCorrectionActions(seriesContext), stopRequested, latestDetail?.program?.abort === true
    ]);
    if (oldBody && oldRight && oldThumbnailView?.host?.parentElement === oldRight) {
      // スクロール領域と画像要素は維持し、変更部分だけ差し替える。
      const oldHeader = oldArticle.querySelector(':scope > header');
      if (oldHeader && lastHeaderSignature === headerSignature) {
        nextLogo.dispose();
      } else {
        previousLogo?.dispose();
        logo = nextLogo;
        if (oldHeader) oldHeader.replaceWith(header);
        else oldArticle.prepend(header);
      }
      const oldDescription = oldBody.querySelector(':scope > .program-modal-description');
      if (oldDescription?.outerHTML !== description.outerHTML) {
        if (oldDescription) {
          updateDetailSection(oldDescription, description);
        } else oldBody.prepend(description);
      }
      const oldManagement = oldRight.querySelector(':scope > .program-modal-management');
      if (oldManagement) {
        updateDetailSection(oldManagement, management);
      } else oldRight.append(management);

      const oldFooter = oldArticle.querySelector(':scope > footer');
      if (!oldFooter || lastFooterSignature !== nextFooterSignature) {
        const previousFeedback = oldFooter?.querySelector('[role="status"]');
        if (!feedback.textContent && previousFeedback?.textContent) {
          feedback.textContent = previousFeedback.textContent;
          feedback.classList.toggle('is-error', previousFeedback.classList.contains('is-error'));
        }
        if (oldFooter) oldFooter.replaceWith(footer);
        else oldArticle.append(footer);
      }
      thumbnailView = { model, host: oldThumbnailView.host };
      if (oldThumbnailKey !== thumbnailSourceKey(model.media)) renderThumbnail();
    } else {
      previousLogo?.dispose();
      logo = nextLogo;
      thumbnailView = { model, host: thumbnailHost };
      oldArticle.replaceWith(article);
      renderThumbnail();
    }
    lastFooterSignature = nextFooterSignature;
    lastHeaderSignature = headerSignature;
    lastRenderSignature = renderSignature;
    if (busy) setMutationControlsDisabled(true);
    scheduleBoundary(model);
  }

  async function load() {
    controller?.abort();
    const requestController = new AbortController();
    controller = requestController;
    try {
      const detail = await loadProgramDetail({ key, id, signal: requestController.signal });
      if (!disposed && !requestController.signal.aborted) {
        latestDetail = detail;
        const model = buildProgramDetailModel({ ...detail, preferredRuleUid });
        let seriesContext = null;
        let seriesError = null;
        try {
          const snapshot = await loadSeriesProjection({ signal: requestController.signal, eventKeys: model.eventKey ? [model.eventKey] : [] });
          seriesContext = programSeriesContext(model, detail.program, model.eventKey ? buildSeriesEventIndex(snapshot).get(model.eventKey) || null : null);
        } catch (cause) {
          if (requestController.signal.aborted || cause?.name === 'AbortError') return;
          seriesError = cause;
        }
        if (disposed || requestController.signal.aborted) return;
        latestSeriesContext = seriesContext;
        latestSeriesError = seriesError;
        await render(model, seriesContext, seriesError);
        if (pendingInitialAction !== null) {
          const action = pendingInitialAction;
          pendingInitialAction = null;
          if (['reserve', 'reserve-now', 'unreserve', 'skip', 'unskip'].includes(action)) {
            if (model.actions.reservation === action) {
              if (action === 'reserve' || action === 'reserve-now') await mutate(model, action, true);
              else if (window.confirm(`${model.title}\n\n「${reservationActionLabel(action)}」を実行しますか？`)) await mutate(model, action);
            } else showFeedback('番組の状態が変わったため、この操作は実行できません。', true);
          } else if (action === 'rule') {
            if (model.actions.rule.mode === 'unavailable') showFeedback(model.actions.rule.label || 'ルールを操作できません', true);
            else openRuleEditor(model);
          } else if (action === 'delete') {
            // 既存の確認ダイアログ・削除安全条件・更新処理をそのまま利用する。
            const remove = dialog.querySelector('[data-delete-recording]');
            if (remove) remove.click();
            else showFeedback('削除できる録画ファイルがありません', true);
          } else if (action === 'stop') {
            const stop = dialog.querySelector('[data-stop-recording]');
            if (stop) stop.click();
            else showFeedback('この番組は現在録画中ではありません。', true);
          } else if (action === 'series-change' || action === 'series-episode' || action === 'series-remove') {
            if (seriesContext?.event?.key) openSeriesCorrection(seriesContext, action === 'series-episode');
            else showFeedback('このイベントのシリーズ情報を操作できません', true);
          }
        }
        return true;
      }
    } catch (cause) {
      if (disposed || requestController.signal.aborted || cause?.name === 'AbortError') return;
      const message = `${stopRequested ? '録画中止要求済みです。状態を取得できませんでした: ' : ''}${errorText(cause)}`;
      if (dialog.querySelector('.program-modal-body')) showFeedback(message, true);
      else {
        const error = document.createElement('div');
        error.className = 'program-modal-loading is-error';
        error.textContent = message;
        dialog.querySelector('article').replaceChildren(error);
      }
      return false;
    }
  }

  // A pointer drag beginning in the dialog must not count as a backdrop click.
  let backdropPointerDown = false;
  dialog.addEventListener('pointerdown', event => {
    backdropPointerDown = event.button === 0 && event.target === dialog;
  });
  dialog.addEventListener('pointerup', event => {
    backdropPointerDown = backdropPointerDown && event.target === dialog;
  });
  dialog.addEventListener('click', event => {
    if (backdropPointerDown && event.target === dialog) close();
    backdropPointerDown = false;
  });
  dialog.addEventListener('close', () => {
    disposed = true;
    maintenanceDialog?.close();
    controller?.abort();
    thumbnailController.abort();
    clearLivePreview();
    window.clearTimeout(thumbnailTimer);
    thumbnailView = null;
    window.clearTimeout(boundaryTimer);
    window.clearTimeout(notificationTimer);
    ruleDialog?.close();
    unsubscribeReservation();
    unsubscribeRecording();
    unsubscribeRecorded();
    unsubscribeMatch();
    unsubscribeSeries();
    logo?.dispose();
    dialog.remove();
    if (activeDialog === dialog) activeDialog = null;
  }, { once: true });
  load();
  return { close, dialog, reload: load };
}

export function installProgramDetailDialogLinks(root = document) {
  const listener = event => {
    const link = event.target.closest?.('a[href*="#program?"]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const hash = new URL(link.href, location.href).hash;
    if (!hash.startsWith('#program?')) return;
    event.preventDefault();
    const query = new URLSearchParams(hash.slice('#program?'.length));
    openProgramDetailDialog({ key: query.get('key'), id: query.get('id') });
  };
  root.addEventListener('click', listener);
  return () => root.removeEventListener('click', listener);
}
