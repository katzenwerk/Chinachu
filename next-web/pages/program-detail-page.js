import { createChannelLogo } from '../components/channel-logo.js';
import { deleteRecordedProgram, loadProgramDetail, ProgramDetailError } from '../services/program-detail-client.js';
import { buildProgramDetailModel } from '../services/program-detail-model.js';
import {
  isRecordedCompatPlaybackAvailable,
  mountRecordedPlayback,
  openRecordingLiveOverlay,
  recordedPlaybackErrorText
} from '../services/live-player-adapter.js';

function addDefinition(list, label, value) {
  if (value === null || value === undefined || value === '') return;
  const term = document.createElement('dt');
  const description = document.createElement('dd');
  term.textContent = label;
  description.textContent = value;
  list.append(term, description);
}

async function copyText(value) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement('textarea');
  input.value = value;
  input.setAttribute('readonly', '');
  input.className = 'program-detail-copy-source';
  document.body.append(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('copy failed');
}

function renderRecordingPath(container, pathInfo) {
  if (pathInfo === null) return;
  const block = document.createElement('section');
  block.className = 'program-detail-recording-path';
  block.innerHTML = '<div><h4></h4><button class="button" type="button">コピー</button></div><code></code><p role="status" hidden></p>';
  block.querySelector('h4').textContent = pathInfo.label;
  block.querySelector('code').textContent = pathInfo.value;
  const button = block.querySelector('button');
  const status = block.querySelector('[role="status"]');
  button.hidden = pathInfo.copyValue === null;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await copyText(pathInfo.copyValue);
      status.textContent = '保存先をコピーしました';
      status.className = 'is-success';
    } catch (_) {
      status.textContent = '保存先をコピーできませんでした';
      status.className = 'is-error';
    } finally {
      status.hidden = false;
      button.disabled = false;
    }
  });
  container.append(block);
}

function createDescription(model) {
  const description = document.createElement('section');
  description.className = 'panel program-detail-description';
  description.innerHTML = '<h3>番組情報</h3><section><h4>概要</h4><p></p></section><section><h4>詳細</h4><p></p></section><div class="program-detail-attributes"></div>';
  description.querySelector(':scope > section:first-of-type > p').textContent = model.summary || '番組概要はありません。';
  description.querySelector(':scope > section:last-of-type > p').textContent = model.detail || '番組詳細はありません。';
  const attributes = description.querySelector('.program-detail-attributes');
  model.attributes.forEach(attribute => {
    const badge = document.createElement('span');
    badge.textContent = attribute;
    attributes.append(badge);
  });
  return description;
}

function createRecordingStatusTags(statuses) {
  const tags = document.createElement('div');
  tags.className = 'program-recording-status-tags';
  (Array.isArray(statuses) ? statuses : []).forEach(status => {
    const tag = document.createElement('span');
    tag.className = `program-recording-status-tag is-${status.kind || 'confirmed'} is-${status.tone || 'warning'}`;
    tag.textContent = status.label;
    tag.title = status.description || status.label;
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
  heading.textContent = 'TS DROP解析';
  addDefinition(facts, 'CC異常合計', summary.ccErrorTotal === null ? '不明' : `${summary.ccErrorTotal.toLocaleString('ja-JP')}件`);
  if (summary.pids.length === 0) {
    addDefinition(facts, 'PID別CC異常', 'なし');
  } else {
    summary.pids.forEach(entry => addDefinition(facts, `PID ${entry.label}`, `${entry.count.toLocaleString('ja-JP')}件`));
  }
  if (summary.totalsMatch === false) {
    addDefinition(facts, '集計整合', `不一致（PID別合計 ${summary.pidTotal.toLocaleString('ja-JP')}件）`);
  }
  section.append(heading, facts);
  return section;
}

function createFacts(model, recordingLayout = false) {
  const facts = document.createElement('aside');
  facts.className = 'panel program-detail-facts';
  facts.innerHTML = `<h3>${recordingLayout ? '録画情報' : '状態'}</h3><dl class="program-detail-primary-facts"></dl>`;
  const primary = facts.querySelector('dl');
  if (recordingLayout && model.recordingInfo) {
    addDefinition(primary, '予定時間', model.recordingInfo.plannedDuration);
    addDefinition(primary, '録画時間', model.recordingInfo.actualDuration);
    addDefinition(primary, '関連ルール', model.relatedRule || 'なし');
    renderRecordingPath(facts, model.recordingPath);
    if (model.reservation !== null) {
      const reservation = document.createElement('dl');
      reservation.className = 'program-detail-secondary-facts';
      addDefinition(reservation, '予約種別', model.reservation.type);
      addDefinition(reservation, '保存先', model.reservation.destination);
      facts.append(reservation);
    }
    const technical = document.createElement('details');
    technical.className = 'program-detail-technical';
    technical.innerHTML = '<summary>履歴・情報源</summary><dl></dl>';
    addDefinition(technical.querySelector('dl'), 'match履歴', model.matchStatus || 'なし');
    addDefinition(technical.querySelector('dl'), '情報源', model.source || '不明');
    facts.append(technical);
  } else {
    addDefinition(primary, '番組状態', model.state.label);
    addDefinition(primary, 'match履歴', model.matchStatus || 'なし');
    addDefinition(primary, '情報源', model.source || '不明');
    if (model.reservation !== null) {
      addDefinition(primary, '予約種別', model.reservation.type);
      addDefinition(primary, '関連ルール', model.reservation.rule || 'なし');
      addDefinition(primary, '保存先', model.reservation.destination);
    }
    renderRecordingPath(facts, model.recordingPath);
  }
  if (model.deletion !== null) {
    const deletion = document.createElement('dl');
    deletion.className = 'program-detail-secondary-facts';
    addDefinition(deletion, model.deletion.kind === 'unknown' ? '確認状態' : '削除理由', model.deletion.reason);
    if (model.deletion.kind !== 'unknown') addDefinition(deletion, '削除日時', model.deletion.deletedAt || '日時情報なし');
    facts.append(deletion);
  }
  const tsDropSummary = createTsDropSummary(model.tsDropInfo);
  if (tsDropSummary) facts.append(tsDropSummary);
  const notices = document.createElement('div');
  notices.className = 'program-detail-notices';
  [...model.warnings, ...(model.reservation?.warnings || [])].filter(Boolean).forEach(value => {
    const notice = document.createElement('p');
    notice.textContent = value;
    notices.append(notice);
  });
  facts.append(notices, createRecordingStatusTags(model.recordingWarnings));
  return facts;
}

function createHeaderActions(model, onDelete) {
  const wrapper = document.createElement('div');
  wrapper.className = 'program-detail-header-actions';
  if (model.actions.deleteRecording === null) return { element: wrapper, dispose() {} };

  wrapper.innerHTML = `
    <button class="button program-detail-more" type="button" aria-label="番組操作" aria-haspopup="menu" aria-expanded="false">…</button>
    <div class="program-detail-action-menu" role="menu" hidden>
      <button type="button" role="menuitem">録画ファイルを削除</button>
    </div>
    <p class="program-detail-action-feedback" role="status" hidden></p>
    <dialog class="program-detail-delete-dialog">
      <form method="dialog">
        <h2>録画ファイルを削除</h2>
        <p class="program-detail-delete-title"></p>
        <dl><dt>記録されている保存先</dt><dd><code></code></dd></dl>
        <ul>
	          <li>録画ファイルを削除します。</li>
	          <li>録画履歴・元の保存先・保存済みサムネイルは台帳整理まで保持します。</li>
          <li>ファイル削除は元に戻せません。</li>
        </ul>
        <div class="program-detail-delete-actions">
          <button class="button" value="cancel">キャンセル</button>
          <button class="button is-danger" value="delete">削除する</button>
        </div>
      </form>
    </dialog>`;

  const trigger = wrapper.querySelector('.program-detail-more');
  const menu = wrapper.querySelector('.program-detail-action-menu');
  const deleteButton = menu.querySelector('button');
  const feedback = wrapper.querySelector('.program-detail-action-feedback');
  const dialog = wrapper.querySelector('dialog');
  const confirmButton = dialog.querySelector('[value="delete"]');
  let deleting = false;

  function setMenu(open) {
    menu.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
  }
  trigger.addEventListener('click', () => setMenu(menu.hidden));
  deleteButton.addEventListener('click', () => {
    setMenu(false);
    dialog.querySelector('.program-detail-delete-title').textContent = model.title;
    dialog.querySelector('code').textContent = model.actions.deleteRecording.path;
    dialog.returnValue = '';
    dialog.showModal();
  });
  dialog.addEventListener('close', async () => {
    if (dialog.returnValue !== 'delete' || deleting) return;
    deleting = true;
    trigger.disabled = true;
    confirmButton.disabled = true;
    feedback.hidden = false;
    feedback.className = 'program-detail-action-feedback';
    feedback.textContent = '録画ファイルを削除しています…';
    try {
      const result = await onDelete(model.actions.deleteRecording.recordedId);
      if (result?.thumbnail?.status === 'failed') {
        feedback.className = 'program-detail-action-feedback is-warning';
        feedback.textContent = result.message;
      }
    } catch (error) {
      const result = error instanceof ProgramDetailError ? error.details?.result : null;
      feedback.className = 'program-detail-action-feedback is-error';
      feedback.textContent = result?.fileDeleted
        ? `${error.message} 録画ファイルは削除済みのため、削除を再実行しないでください。`
        : errorMessage(error);
      if (!result?.fileDeleted) {
        deleting = false;
        trigger.disabled = false;
        confirmButton.disabled = false;
      }
    }
  });
  return {
    element: wrapper,
    dispose() {
      if (dialog.open) dialog.close();
    }
  };
}

function renderMedia(model) {
  const section = document.createElement('section');
  section.className = 'panel program-detail-media';
  const frame = document.createElement('div');
  frame.className = 'program-detail-media-frame';
  const poster = document.createElement(model.media.playable || model.media.liveModel !== null ? 'button' : 'div');
  poster.className = 'program-detail-media-poster';
  if (poster instanceof HTMLButtonElement) {
    poster.type = 'button';
    poster.setAttribute('aria-label', model.media.kind === 'recording' ? `${model.title}をライブ視聴` : `${model.title}を再生`);
  }
  const fallback = document.createElement('div');
  fallback.className = 'program-detail-media-fallback';
  fallback.innerHTML = '<span aria-hidden="true">映像</span><strong></strong><small></small>';

  if (model.media.kind === 'recording') {
    fallback.querySelector('strong').textContent = '録画中';
    fallback.querySelector('small').textContent = model.media.previewUrl === null
      ? '録画プレビューを利用できません'
      : '録画プレビューを取得しています';
  } else {
    fallback.querySelector('strong').textContent = '保存済みサムネイル';
    fallback.querySelector('small').textContent = model.media.thumbnailUrl === null
      ? '利用できる保存済みサムネイルはありません'
      : 'サムネイルが未生成の場合は代替表示になります';
  }
  poster.append(fallback);

  const imageUrl = model.media.kind === 'recording' ? model.media.previewUrl : model.media.thumbnailUrl;
  if (imageUrl !== null) {
    const image = document.createElement('img');
    image.className = 'program-detail-media-image';
    image.alt = model.media.kind === 'recording'
      ? `${model.title}の録画プレビュー`
      : `${model.title}の保存済みサムネイル`;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('load', () => {
      image.classList.add('is-ready');
      fallback.hidden = true;
    });
    image.addEventListener('error', () => {
      image.classList.remove('is-ready');
      fallback.hidden = false;
      if (model.media.kind === 'recording') {
        fallback.querySelector('small').textContent = '録画プレビューを表示できません';
      }
    });
    image.src = imageUrl;
    poster.append(image);
  }
  if (model.media.playable || model.media.liveModel !== null) {
    const play = document.createElement('span');
    play.className = 'program-detail-media-play';
    play.setAttribute('aria-hidden', 'true');
    play.textContent = '▶';
    poster.append(play);
  }
  frame.append(poster);

  const actions = document.createElement('div');
  actions.className = 'program-detail-media-actions';
  const status = document.createElement('p');
  status.className = 'program-detail-media-status';
  status.setAttribute('role', 'status');
  let player = null;
  let disposed = false;
  let attempt = 0;
  const actionControls = [];

  function setActionsDisabled(disabled) {
    actionControls.forEach(control => { control.disabled = disabled; });
  }
  function restorePoster(message = '') {
    attempt += 1;
    player?.destroy();
    player = null;
    frame.classList.remove('is-playing');
    frame.replaceChildren(poster);
    status.textContent = message;
    setActionsDisabled(false);
  }
  async function startRecordedPlayback(mode = 'standard') {
    if (disposed || !model.media.playable) return;
    const currentAttempt = ++attempt;
    player?.destroy();
    player = null;
    const playerHost = document.createElement('div');
    playerHost.className = 'program-detail-player-host';
    frame.classList.add('is-playing');
    frame.replaceChildren(playerHost);
    setActionsDisabled(true);
    status.textContent = mode === 'compat' ? '互換プレーヤーを準備しています' : 'プレーヤーを準備しています';
    try {
      const nextPlayer = await mountRecordedPlayback(playerHost, {
        playable: true,
        recordedId: model.media.recordedId
      }, {
        mode,
        onEnded: () => { if (!disposed && currentAttempt === attempt) restorePoster('再生が終了しました'); },
        onError: error => { if (!disposed && currentAttempt === attempt) restorePoster(recordedPlaybackErrorText(error)); }
      });
      if (disposed || currentAttempt !== attempt) {
        nextPlayer.destroy();
        return;
      }
      player = nextPlayer;
      status.textContent = mode === 'compat' ? '互換再生中' : '';
    } catch (error) {
      if (!disposed && currentAttempt === attempt) restorePoster(recordedPlaybackErrorText(error));
    } finally {
      if (!disposed && currentAttempt === attempt) setActionsDisabled(false);
    }
  }
  async function startRecordingPlayback() {
    if (disposed || model.media.liveModel === null) return;
    setActionsDisabled(true);
    status.textContent = 'ライブ視聴を準備しています';
    try {
      await openRecordingLiveOverlay(model.media.liveModel);
      if (!disposed) status.textContent = '';
    } catch (error) {
      if (!disposed) status.textContent = `ライブ視聴を開始できませんでした: ${error.message || error}`;
    } finally {
      if (!disposed) setActionsDisabled(false);
    }
  }
  const primaryAction = model.media.kind === 'recording' ? startRecordingPlayback : startRecordedPlayback;
  if (poster instanceof HTMLButtonElement) poster.addEventListener('click', () => primaryAction());

  if (model.media.playable) {
    const playButton = document.createElement('button');
    playButton.className = 'button is-primary';
    playButton.type = 'button';
    playButton.textContent = '再生';
    playButton.addEventListener('click', () => startRecordedPlayback());
    actions.append(playButton);
    actionControls.push(playButton);
    if (isRecordedCompatPlaybackAvailable()) {
      const compatButton = document.createElement('button');
      compatButton.className = 'button';
      compatButton.type = 'button';
      compatButton.textContent = '互換再生';
      compatButton.title = 'FFmpeg互換再生（字幕・文字スーパーなし）';
      compatButton.addEventListener('click', () => startRecordedPlayback('compat'));
      actions.append(compatButton);
      actionControls.push(compatButton);
    }
  } else if (model.media.liveModel !== null) {
    const watchButton = document.createElement('button');
    watchButton.className = 'button is-primary';
    watchButton.type = 'button';
    watchButton.textContent = 'ライブ視聴';
    watchButton.addEventListener('click', startRecordingPlayback);
    actions.append(watchButton);
    actionControls.push(watchButton);
  }
  if (model.media.downloadUrl !== null) {
    const download = document.createElement('a');
    download.className = 'button';
    download.href = model.media.downloadUrl;
    download.download = '';
    download.textContent = 'ダウンロード';
    actions.append(download);
  }
  section.append(frame);
  if (actions.childElementCount !== 0) section.append(actions);
  section.append(status);
  return {
    element: section,
    dispose() {
      disposed = true;
      attempt += 1;
      player?.destroy();
      player = null;
    }
  };
}

function renderDetail(container, model, onDelete) {
  container.replaceChildren();
  container.className = `program-detail-page is-${model.state.key}`;

  const header = document.createElement('section');
  header.className = 'panel program-detail-header';
  const channelLogo = createChannelLogo({}, { variant: 'list', focusable: true });
  channelLogo.update({
    url: model.channel.logoUrl,
    name: model.channel.name,
    fallbackText: model.channel.name,
    tooltip: [model.channel.name, model.channel.meta].filter(Boolean).join(' / ')
  });
  const heading = document.createElement('div');
  heading.className = 'program-detail-heading';
  heading.innerHTML = '<div class="program-detail-statuses"></div><h2></h2><p class="program-detail-broadcast"></p>';
  heading.querySelector('h2').textContent = model.title;
  heading.querySelector('.program-detail-broadcast').textContent = `${model.dateTime} · ${model.duration}`;
  const statuses = heading.querySelector('.program-detail-statuses');
  const state = document.createElement('span');
  state.className = `program-detail-status is-${model.state.key}`;
  state.textContent = model.state.label;
  statuses.append(state);
  const channel = document.createElement('div');
  channel.className = 'program-detail-channel';
  const channelText = document.createElement('div');
  channelText.innerHTML = '<strong></strong><span></span>';
  channelText.querySelector('strong').textContent = model.channel.name;
  channelText.querySelector('span').textContent = model.channel.meta;
  channel.append(channelLogo.element, channelText);
  const headerSide = document.createElement('div');
  headerSide.className = 'program-detail-header-side';
  const headerActions = createHeaderActions(model, onDelete);
  headerSide.append(channel, headerActions.element);
  header.append(heading, headerSide);
  container.append(header);

  const recordingLayout = model.media.visible;
  let mediaView = null;
  if (recordingLayout) {
    const lead = document.createElement('div');
    lead.className = 'program-detail-recording-layout';
    mediaView = renderMedia(model);
    lead.append(mediaView.element, createFacts(model, true));
    container.append(lead, createDescription(model));
  } else {
    const body = document.createElement('div');
    body.className = 'program-detail-grid';
    body.append(createDescription(model), createFacts(model));
    container.append(body);
  }

  return () => {
    mediaView?.dispose();
    headerActions.dispose();
    channelLogo.dispose();
  };
}

function errorMessage(error) {
  if (error instanceof ProgramDetailError) return error.message;
  return `番組詳細を取得できませんでした: ${error?.message || error}`;
}

export function renderProgramDetailPage(container, query = new URLSearchParams()) {
  let disposed = false;
  let disposeView = null;
  let controller = null;

  async function load() {
    controller?.abort();
    controller = new AbortController();
    container.className = 'program-detail-page';
    container.innerHTML = '<section class="panel program-detail-message"><p>番組詳細を取得しています</p></section>';
    try {
      const detail = await loadProgramDetail({
        key: query.get('key'),
        id: query.get('id'),
        signal: controller.signal
      });
      if (disposed || controller.signal.aborted) return;
      disposeView?.();
      disposeView = renderDetail(container, buildProgramDetailModel(detail), async recordedId => {
        const result = await deleteRecordedProgram(recordedId, { signal: controller.signal });
        if (!disposed && !controller.signal.aborted) await load();
        return result;
      });
    } catch (error) {
      if (disposed || error?.name === 'AbortError') return;
      const message = document.createElement('section');
      message.className = 'panel program-detail-message is-error';
      message.innerHTML = '<h2>番組詳細を表示できません</h2><p></p><button class="button" type="button">再試行</button>';
      message.querySelector('p').textContent = errorMessage(error);
      message.querySelector('button').addEventListener('click', load, { once: true });
      container.replaceChildren(message);
    }
  }

  load();
  return () => {
    disposed = true;
    controller?.abort();
    disposeView?.();
  };
}
