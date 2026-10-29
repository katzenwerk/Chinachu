import { createChannelLogo } from './channel-logo.js';
import { openRuleEditorDialog, programRuleSeed } from './rule-editor-dialog.js';
import { deleteRecordedProgram, loadProgramDetail, ProgramDetailError } from '../services/program-detail-client.js';
import { buildProgramDetailModel } from '../services/program-detail-model.js';
import { reserveProgram, setReserveSkip, unreserveProgram } from '../services/timetable-client.js';
import { openRecordedPlaybackOverlay, openRecordingLiveOverlay } from '../services/live-player-adapter.js';
import { copyProgramTitle, programSearchUrl } from '../services/program-actions.js';
import { invalidateResources } from '../services/api-client.js';
import { subscribeMatchNotifications, subscribeRecordedNotifications, subscribeRecordingNotifications, subscribeReservationNotifications } from '../services/realtime-client.js';

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

function actionLabel(action) {
  return {
    reserve: '録画予約', 'reserve-now': '今から録画', unreserve: '予約取消', skip: 'スキップ', unskip: 'スキップ解除'
  }[action] || '';
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
  return section;
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

function createManagement(model) {
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
    addFact(facts, model.deletion.kind === 'unknown' ? '確認状態' : '削除理由', model.deletion.reason);
    if (model.deletion.kind !== 'unknown') addFact(facts, '削除日時', model.deletion.deletedAt || '日時情報なし');
  }
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
  if (tsDropSummary) aside.append(tsDropSummary);
  aside.append(notices, createRecordingStatusTags(model.recordingWarnings), id);
  return aside;
}

function createThumbnail(model, onPlay) {
  const url = model.media.kind === 'recording' ? model.media.previewUrl : model.media.thumbnailUrl;
  if (!url) return null;
  const interactive = model.media.kind === 'recording' || model.media.playable;
  const frame = document.createElement(interactive ? 'button' : 'div');
  if (interactive) frame.type = 'button';
  frame.className = 'program-modal-thumbnail';
  if (interactive) frame.setAttribute('aria-label', `${model.title}を${model.media.kind === 'recording' ? 'ライブ視聴' : '再生'}`);
  const image = document.createElement('img');
  image.src = url;
  image.alt = `${model.title}のサムネイル`;
  image.addEventListener('error', () => frame.remove(), { once: true });
  frame.append(image);
  if (interactive) {
    const play = document.createElement('span');
    play.textContent = '▶';
    play.setAttribute('aria-hidden', 'true');
    frame.append(play);
    frame.addEventListener('click', onPlay);
  }
  return frame;
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
  let latestDetail = null;
  let preferredRuleUid = null;
  let boundaryTimer = null;
  let ruleDialog = null;
  let pendingInitialAction = ['rule', 'delete'].includes(initialAction) ? initialAction : null;
  const reloadFromNotification = resources => {
    if (disposed || !dialog.open) return;
    invalidateResources(resources);
    load();
  };
  const unsubscribeReservation = subscribeReservationNotifications(() => reloadFromNotification(['reserves', 'rules']));
  const unsubscribeRecording = subscribeRecordingNotifications(() => reloadFromNotification(['recording', 'reserves']));
  const unsubscribeRecorded = subscribeRecordedNotifications(() => reloadFromNotification(['recorded', 'recording']));
  const unsubscribeMatch = subscribeMatchNotifications(() => load());

  function showFeedback(message, error = false) {
    const feedback = dialog.querySelector('footer [role="status"]');
    if (!feedback) return;
    feedback.textContent = message || '';
    feedback.classList.toggle('is-error', error);
  }

  async function refreshAfterMutation() {
    await load();
    if (disposed) return;
    await onChanged?.();
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
      if (!disposed && dialog.open && latestDetail) render(buildProgramDetailModel({ ...latestDetail, preferredRuleUid }));
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

  async function mutate(model, action) {
    if (busy || !model.programId) return;
    busy = true;
    setMutationControlsDisabled(true);
    showFeedback('');
    try {
      if (action === 'reserve' || action === 'reserve-now') await reserveProgram(model.programId);
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

  async function render(model) {
    logo?.dispose();
    const article = document.createElement('article');
    const header = document.createElement('header');
    header.innerHTML = '<div class="program-modal-channel"><span></span><div><p></p><div class="program-modal-title"><span class="program-modal-status"></span><span class="program-modal-status-reason" hidden></span><h2></h2></div></div></div><button class="guide-close" type="button" aria-label="閉じる">×</button>';
    logo = createChannelLogo({ name: model.channel.name, url: model.channel.logoUrl }, { variant: 'list' });
    header.querySelector('.program-modal-channel > span').replaceWith(logo.element);
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
    const thumbnail = createThumbnail(model, () => play(model).catch(() => {}));
    if (thumbnail) right.append(thumbnail);
    right.append(createManagement(model));
    body.append(createDescription(model), right);

    const footer = document.createElement('footer');
    footer.innerHTML = '<div class="program-modal-primary"></div><div class="program-modal-search"></div><div class="program-modal-danger"></div><p role="status"></p>';
    const primary = footer.querySelector('.program-modal-primary');
    const search = footer.querySelector('.program-modal-search');
    const danger = footer.querySelector('.program-modal-danger');
    const feedback = footer.querySelector('[role="status"]');
    const normalProgram = model.phase.key === 'program';
    if (model.actions.reservation) {
      const button = document.createElement('button');
      button.className = 'button primary';
      button.type = 'button';
      button.textContent = actionLabel(model.actions.reservation);
      button.addEventListener('click', () => mutate(model, model.actions.reservation));
      primary.append(button);
    }
    if (model.media.liveModel) {
      const button = document.createElement('button');
      button.className = 'button primary';
      button.type = 'button';
      button.textContent = 'LIVE視聴';
      button.addEventListener('click', () => play(model).catch(cause => { feedback.textContent = errorText(cause); }));
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
      searchLink(normalProgram ? 'Wikipedia検索' : 'Wikipedia', normalProgram ? programSearchUrl('wikipedia', model.title) : `https://ja.wikipedia.org/w/index.php?search=${encodeURIComponent(model.title)}`)
    );
    if (model.actions.deleteRecording) {
      const remove = document.createElement('button');
      remove.className = 'button is-danger';
      remove.type = 'button';
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
    dialog.querySelector('article').replaceWith(article);
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
        await render(model);
        if (pendingInitialAction !== null) {
          const action = pendingInitialAction;
          pendingInitialAction = null;
          if (action === 'rule') {
            if (model.actions.rule.mode === 'unavailable') showFeedback(model.actions.rule.label || 'ルールを操作できません', true);
            else openRuleEditor(model);
          } else if (action === 'delete') {
            // 既存の確認ダイアログ・削除安全条件・更新処理をそのまま利用する。
            const remove = dialog.querySelector('.program-modal-danger button');
            if (remove) remove.click();
            else showFeedback('削除できる録画ファイルがありません', true);
          }
        }
      }
    } catch (cause) {
      if (disposed || requestController.signal.aborted || cause?.name === 'AbortError') return;
      const error = document.createElement('div');
      error.className = 'program-modal-loading is-error';
      error.textContent = errorText(cause);
      dialog.querySelector('article').replaceChildren(error);
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
    controller?.abort();
    window.clearTimeout(boundaryTimer);
    ruleDialog?.close();
    unsubscribeReservation();
    unsubscribeRecording();
    unsubscribeRecorded();
    unsubscribeMatch();
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
