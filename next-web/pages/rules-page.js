import { createChannelLogo } from '../components/channel-logo.js';
import { headerCompactMedia as createHeaderCompactMedia, appendMobileContextButton } from '../components/mobile-layout.js';
import { openRuleEditorDialog } from '../components/rule-editor-dialog.js';
import { createRulesContextMenu } from '../components/rules-context-menu.js';
import { applyStorageWarning } from '../components/storage-warning.js';
import { buildReservationStorageDisplay, itemMatchesStorage, resolveStorageFilter } from '../services/storage-model.js';
import { retryStorageData, subscribeStorageData } from '../services/storage-store.js';
import {
  buildRuleChannelMap, buildRuleRows, categoryLabel, filterRuleRows
} from '../services/rule-model.js';
import {
  deleteRulesByUid, loadRuleRecordingCounts, loadRulesPageData, runScheduler, setRuleEnabledByUid
} from '../services/rules-client.js';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function list(value) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function logoUrl(channel) {
  return text(channel?.id)
    ? `/api/channel/${encodeURIComponent(channel.id)}/logo.png`
    : null;
}

function buildReservationChannelMap(reserves) {
  const channels = new Map();
  (Array.isArray(reserves) ? reserves : []).forEach(program => {
    const channel = program?.channel;
    if (text(channel?.id) && !channels.has(channel.id)) channels.set(channel.id, channel);
  });
  return channels;
}

export function renderRulesPage(container, query = new URLSearchParams(), { setHeaderActions = () => {}, showToast = () => {} } = {}) {
  let active = true;
  let rows = [];
  let data = null;
  let storageData = null;
  let storageError = null;
  let storageToken = query.get('storage') || null;
  let listChannelMap = new Map();
  let search = query.get('search') || '';
  let status = ['enabled', 'disabled'].includes(query.get('status')) ? query.get('status') : 'all';
  let openRuleUid = query.get('ruleUid') || null;
  let openDialog = null;
  let logoHandles = [];
  let refreshRevision = 0;
  let schedulerRunning = false;
  let deleting = false;
  let togglingRule = false;
  let pendingDeleteTargets = [];
  const selectedRuleUids = new Set();
  const controller = new AbortController();
  const rowByElement = new WeakMap();

  const page = document.createElement('div');
  page.className = 'rules-page';
  page.innerHTML = `
    <div class="reserves-rule-filter" hidden><span></span><a href="#rules">絞り込みを解除</a></div>
    <section class="panel rules-list-panel"><div class="rules-list" aria-live="polite"><p class="rules-message">ルールを取得しています</p></div></section>
    <dialog class="rules-action-dialog rules-scheduler-dialog">
      <article><header><h2>スケジューラーの実行</h2></header><div class="rules-action-dialog-body"><p>全てのルールと手動予約から競合を検出し、スケジューリングを行います。</p><p class="rules-scheduler-progress" role="status" aria-live="polite" hidden>スケジューラーを実行しています…</p><p class="rules-action-feedback" role="status" hidden></p></div><footer><button class="button" data-cancel type="button">キャンセル</button><button class="button is-primary" data-confirm type="button">実行</button></footer></article>
    </dialog>
    <dialog class="rules-action-dialog rules-delete-dialog">
      <article><header><h2>選択したルールを削除</h2></header><div class="rules-action-dialog-body"><p class="rules-delete-summary"></p><div class="rules-delete-targets"><ul></ul></div><p class="rules-action-feedback" role="status" hidden></p></div><footer><button class="button" data-cancel type="button">キャンセル</button><button class="button is-danger" data-confirm type="button">削除</button></footer></article>
    </dialog>`;
  container.replaceChildren(page);

  const headerControls = document.createElement('details');
  headerControls.className = 'rules-header-controls';
  headerControls.open = true;
  headerControls.innerHTML = `<summary>ルール操作</summary><div class="rules-toolbar">
    <span class="rules-shown">--</span>
    <button class="button rules-create" type="button">ルール追加</button>
    <button class="button rules-delete" type="button" disabled>削除（0）</button>
    <button class="button rules-scheduler" type="button">スケジューラー実行</button>
    <label class="rules-status"><select aria-label="ルールの状態"><option value="all">すべて</option><option value="enabled">有効</option><option value="disabled">無効</option></select></label>
    <label class="rules-search"><input type="search" placeholder="タイトル・ジャンル・放送局など" aria-label="ルールを検索" autocomplete="off"></label>
  </div>`;
  setHeaderActions(headerControls);
  const headerCompactMedia = createHeaderCompactMedia(1100);
  const headerCompactListener = event => { headerControls.open = !event.matches; };
  headerControls.open = !headerCompactMedia.matches;
  headerCompactMedia.addEventListener('change', headerCompactListener);

  const searchInput = headerControls.querySelector('.rules-search input');
  const statusSelect = headerControls.querySelector('.rules-status select');
  const shown = headerControls.querySelector('.rules-shown');
  headerControls.querySelector('.rules-toolbar').prepend(shown);
  const createButton = headerControls.querySelector('.rules-create');
  const schedulerButton = headerControls.querySelector('.rules-scheduler');
  const deleteButton = headerControls.querySelector('.rules-delete');
  const listHost = page.querySelector('.rules-list');
  const storageFilter = page.querySelector('.reserves-rule-filter');
  storageFilter.querySelector('a').addEventListener('click', event => {
    event.preventDefault();
    storageToken = null;
    clearSelection();
    renderRows();
  });
  const schedulerDialog = page.querySelector('.rules-scheduler-dialog');
  const deleteDialog = page.querySelector('.rules-delete-dialog');
  searchInput.value = search;
  statusSelect.value = status;

  function updateHash() {
    const params = new URLSearchParams();

    if (status !== 'all') params.set('status', status);
    if (openRuleUid) params.set('ruleUid', openRuleUid);
    if (storageToken !== null) params.set('storage', storageToken);
    history.replaceState(null, '', `#rules${params.size ? `?${params}` : ''}`);
  }

  function disposeLogos() {
    logoHandles.forEach(handle => handle.dispose());
    logoHandles = [];
  }

  function clearSelection() {
    selectedRuleUids.clear();
  }

  function updateSelectionControls(table, filtered) {
    const selectable = filtered.filter(row => row.uid);
    const selectedVisible = selectable.filter(row => selectedRuleUids.has(row.uid));
    const selectAll = table?.querySelector('.rule-select-all') || null;
    if (selectAll) {
      const syncSelectAll = () => {
        if (!selectAll.isConnected) return;
        const selectedCount = selectable.filter(row => selectedRuleUids.has(row.uid)).length;
        const allSelected = selectable.length > 0 && selectedCount === selectable.length;
        const partlySelected = selectedCount > 0 && selectedCount < selectable.length;
        selectAll.disabled = selectable.length === 0;
        selectAll.checked = allSelected;
        selectAll.setAttribute('aria-checked', partlySelected ? 'mixed' : allSelected ? 'true' : 'false');
        selectAll.indeterminate = partlySelected;
      };
      syncSelectAll();
      window.requestAnimationFrame(syncSelectAll);
    }
    table?.querySelectorAll('.rule-row').forEach(item => {
      const checkbox = item.querySelector('.rule-select');
      const selected = checkbox?.dataset.ruleUid && selectedRuleUids.has(checkbox.dataset.ruleUid);
      if (checkbox) checkbox.checked = selected;
      item.classList.toggle('is-selected', Boolean(selected));
    });
    deleteButton.textContent = `削除（${selectedRuleUids.size}）`;
    deleteButton.disabled = selectedRuleUids.size === 0 || deleting;
  }

  function currentFilteredRows() {
    const filtered = filterRuleRows(rows, { search, status });
    if (storageToken === null) return filtered;
    const storage = resolveStorageFilter(storageData, storageToken);
    return filtered.filter(row => itemMatchesStorage(row.rule, storage, false));
  }

  function renderRows() {
    if (!active) return;
    disposeLogos();
    contextMenu.close();
    const storage = resolveStorageFilter(storageData, storageToken);
    storageFilter.hidden = storageToken === null;
    storageFilter.querySelector('span').textContent = storageToken === null ? ''
      : `録画先: ${storage ? `${storage.name || storage.id || 'Default'} (${storage.configuredPath || storage.path})` : storageToken} で絞り込み中`;
    if (storageToken !== null && storageData === null) {
      shown.textContent = '--件';
      listHost.innerHTML = '<p class="rules-message"></p>';
      listHost.firstElementChild.textContent = storageError
        ? `録画先情報を取得できませんでした: ${storageError.message}` : '録画先情報を取得しています';
      if (storageError) {
        const retry = document.createElement('button');
        retry.className = 'button';
        retry.textContent = '再試行';
        retry.addEventListener('click', () => retryStorageData());
        listHost.append(retry);
      }
      updateHash();
      return;
    }
    const filtered = currentFilteredRows();
    shown.textContent = `${filtered.length}件`;
    if (!filtered.length) {
      listHost.innerHTML = `<p class="rules-message">${rows.length ? '条件に一致するルールはありません' : 'ルールはありません'}</p>`;
      updateSelectionControls(null, filtered);
      updateHash();
      return;
    }
    const table = document.createElement('div');
    table.className = 'rule-table';
    table.innerHTML = '<div class="rule-table-head"><label class="rule-select-cell"><input class="rule-select-all" type="checkbox" aria-label="表示中のルールをすべて選択"></label><span>#</span><span>予約</span><span>録画実績</span><span>状態</span><span>条件</span><span>対象局</span></div>';
    const selectAll = table.querySelector('.rule-select-all');
    selectAll.addEventListener('change', () => {
      filtered.forEach(row => {
        if (!row.uid) return;
        if (selectAll.checked) selectedRuleUids.add(row.uid); else selectedRuleUids.delete(row.uid);
      });
      updateSelectionControls(table, filtered);
    });
    filtered.forEach(row => {
      const item = document.createElement('div');
      item.className = `rule-row${row.enabled ? '' : ' is-disabled'}`;
      rowByElement.set(item, row);
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.setAttribute('aria-label', `ルール ${row.index + 1} を編集`);
      item.innerHTML = `
        <label class="rule-select-cell"><input class="rule-select" type="checkbox"></label>
        <span class="rule-order"></span><a class="rule-count rule-reserves"></a>
        <a class="rule-count rule-recorded"></a><span class="rule-state"></span>
        <span class="rule-main"><strong></strong><span class="rule-main-meta"><small></small><span class="rule-storage-warning storage-warning" hidden><span aria-hidden="true">⚠</span><span class="storage-warning-text"></span><span class="storage-warning-tip" role="tooltip"></span></span></span></span>
        <span class="rule-channels"></span>`;
      appendMobileContextButton(item);
      const checkbox = item.querySelector('.rule-select');
      checkbox.dataset.ruleUid = row.uid;
      checkbox.setAttribute('aria-label', `ルール ${row.index + 1} を選択`);
      checkbox.disabled = !row.uid;
      checkbox.title = row.uid ? '一括操作の対象に選択' : 'ruleUidがないため一括操作では選択できません';
      checkbox.addEventListener('click', event => event.stopPropagation());
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedRuleUids.add(row.uid); else selectedRuleUids.delete(row.uid);
        updateSelectionControls(table, filtered);
      });
      item.querySelector('.rule-order').textContent = String(row.index + 1);
      item.querySelector('.rule-state').textContent = row.enabled ? '有効' : '無効';
      item.querySelector('.rule-state').classList.add(row.enabled ? 'is-enabled' : 'is-disabled');
      item.querySelector('.rule-main strong').textContent = row.summary;
      applyStorageWarning(item.querySelector('.rule-storage-warning'), row.enabled
        ? buildReservationStorageDisplay(storageData, row.rule).notice
        : null);
      const categories = list(row.rule.categories).map(categoryLabel);
      item.querySelector('.rule-main small').textContent = [list(row.rule.types).join('・'), categories.join('・')].filter(Boolean).join(' / ') || '放送波・ジャンル指定なし';
      const channelHost = item.querySelector('.rule-channels');
      if (!row.channelIds.length) channelHost.textContent = '全局';
      else {
        row.channelIds.slice(0, 3).forEach(id => {
          const channel = listChannelMap.get(id) || { id, name: id };
          const handle = createChannelLogo({ name: channel?.name || id, fallbackText: channel?.name || id, tooltip: channel?.name || id, url: logoUrl(channel) }, { variant: 'list', focusable: true });
          logoHandles.push(handle);
          channelHost.append(handle.element);
        });
        if (row.channelIds.length > 3) {
          const more = document.createElement('small');
          more.textContent = `+${row.channelIds.length - 3}`;
          channelHost.append(more);
        }
      }
      const reserves = item.querySelector('.rule-reserves');
      reserves.href = row.uid ? `#reserves?ruleUid=${encodeURIComponent(row.uid)}` : '#reserves';
      reserves.textContent = `${row.reservationCount}件`;
      reserves.classList.toggle('is-zero', row.reservationCount === 0);
      reserves.title = row.uid ? 'このルールの予約を表示' : '識別子がないため厳密な絞り込みはできません';
      const recorded = item.querySelector('.rule-recorded');
      recorded.dataset.ruleUid = row.uid;
      recorded.href = row.uid ? `#recorded?ruleUid=${encodeURIComponent(row.uid)}&results=recorded%2Cdeleted` : '#recorded';
      recorded.textContent = row.achievementCount === null ? '—' : `${row.achievementCount}件`;
      recorded.classList.toggle('is-zero', row.achievementCount === 0);
      recorded.classList.toggle('is-pending', row.achievementCount === null);
      recorded.title = !row.uid ? '識別子がないため厳密な絞り込みはできません' :
        row.achievementCount === null ? '録画実績を取得中です' : 'このルールの録画実績を表示';
      const show = () => showEditor(row);
      item.addEventListener('click', event => { if (!event.target.closest('a,button,input,label,.storage-warning')) show(); });
      item.addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && event.target === item) { event.preventDefault(); show(); } });
      table.append(item);
    });
    listHost.replaceChildren(table);
    updateSelectionControls(table, filtered);
    updateHash();
  }

  function updateAchievementCells(failed = false) {
    listHost.querySelectorAll('.rule-recorded').forEach(recorded => {
      const row = rows.find(candidate => candidate.uid === recorded.dataset.ruleUid);
      if (!row?.uid) return;
      recorded.textContent = row.achievementCount === null ? '—' : `${row.achievementCount}件`;
      recorded.classList.toggle('is-zero', row.achievementCount === 0);
      recorded.classList.toggle('is-pending', row.achievementCount === null);
      recorded.title = failed ? '録画実績を取得できませんでした' :
        row.achievementCount === null ? '録画実績を取得中です' : 'このルールの録画実績を表示';
    });
  }

  function closeDialog() {
    openDialog?.close();
  }

  function showEditor(row = null, copyFrom = null) {
    if (row?.uid) { openRuleUid = row.uid; updateHash(); }
    closeDialog();
    let editor = null;
    editor = openRuleEditorDialog({
      row,
      initialRule: copyFrom?.rule || null,
      title: row ? 'ルール #' + (row.index + 1) + ' を編集' :
        copyFrom ? `ルール #${copyFrom.index + 1} を複製（新規作成）` : 'ルールを追加',
      onSaved: async ({ schedulerRan, schedulerResult, schedulerError }) => {
        // A refresh while ruleUid remains set would reopen this editor after saving.
        openRuleUid = null;
        updateHash();
        const result = await refresh(true);
        if (!result.ok) throw result.error;
        if (schedulerRan) {
          const conflicts = Array.isArray(schedulerResult?.conflicts) ? schedulerResult.conflicts.length : Number(schedulerResult?.conflictCount) || 0;
          showToast(conflicts ? `保存と予約更新が完了しました（競合 ${conflicts}件）` : '保存と予約更新が完了しました', 5000, conflicts ? 'warning' : 'activity');
        } else if (!schedulerError) {
          showToast(row ? 'ルールを保存しました' : 'ルールを保存しました。すぐに反映する場合はスケジューラーを実行してください。', row ? 3500 : 5000, 'activity');
        }
      },
      onDeleted: async () => {
        openRuleUid = null;
        updateHash();
        const result = await refresh(true);
        if (!result.ok) throw result.error;
        showToast('ルールを削除しました', 3500, 'activity');
      },
      onClose: () => {
        if (openDialog !== editor) return;
        openDialog = null;
        if (openRuleUid) { openRuleUid = null; updateHash(); }
      }
    });
    openDialog = editor;
  }

  function resetActionFeedback(dialog) {
    const feedback = dialog.querySelector('.rules-action-feedback');
    feedback.hidden = true;
    feedback.textContent = '';
    return feedback;
  }

  function openSchedulerDialog() {
    if (schedulerRunning) return;
    resetActionFeedback(schedulerDialog);
    schedulerDialog.querySelector('.rules-scheduler-progress').hidden = true;
    schedulerDialog.querySelector('[data-confirm]').disabled = false;
    schedulerDialog.querySelector('[data-cancel]').disabled = false;
    schedulerDialog.showModal();
  }

  function openDeleteDialog(onlyRuleUid = null) {
    if (deleting || (onlyRuleUid === null && selectedRuleUids.size === 0)) return;
    pendingDeleteTargets = rows
      .filter(row => row.uid && (onlyRuleUid === null ? selectedRuleUids.has(row.uid) : row.uid === onlyRuleUid))
      .sort((left, right) => right.index - left.index);
    if (pendingDeleteTargets.length === 0) return;
    deleteDialog.querySelector('.rules-delete-summary').textContent = `${pendingDeleteTargets.length}件のルールを削除します。`;
    const targetList = deleteDialog.querySelector('.rules-delete-targets ul');
    targetList.replaceChildren(...pendingDeleteTargets.map(row => {
      const item = document.createElement('li');
      const number = document.createElement('strong');
      const summary = document.createElement('span');
      number.textContent = `ルール #${row.index + 1}`;
      summary.textContent = row.summary;
      item.append(number, summary);
      return item;
    }));
    resetActionFeedback(deleteDialog);
    deleteDialog.querySelector('[data-confirm]').disabled = false;
    deleteDialog.querySelector('[data-cancel]').disabled = false;
    deleteDialog.querySelector('[data-cancel]').textContent = 'キャンセル';
    deleteDialog.showModal();
  }

  schedulerDialog.addEventListener('cancel', event => {
    if (schedulerRunning) event.preventDefault();
  });
  schedulerDialog.querySelector('[data-cancel]').addEventListener('click', () => schedulerDialog.close());
  schedulerDialog.querySelector('[data-confirm]').addEventListener('click', async () => {
    if (schedulerRunning) return;
    schedulerRunning = true;
    const confirmButton = schedulerDialog.querySelector('[data-confirm]');
    const cancelButton = schedulerDialog.querySelector('[data-cancel]');
    const feedback = resetActionFeedback(schedulerDialog);
    const progress = schedulerDialog.querySelector('.rules-scheduler-progress');
    progress.textContent = 'スケジューラーを実行しています…';
    progress.hidden = false;
    confirmButton.disabled = true;
    confirmButton.classList.add('is-running');
    confirmButton.textContent = '実行中…';
    cancelButton.disabled = true;
    schedulerButton.disabled = true;
    schedulerButton.textContent = '実行中…';
    try {
      const result = await runScheduler();
      if (!active) return;
      const conflicts = Array.isArray(result?.conflicts) ? result.conflicts.length : 0;
      progress.textContent = '予約情報とルール一覧を更新しています…';
      const refreshResult = await refresh(true);
      if (!active) return;
      schedulerDialog.close();
      if (!refreshResult.ok) {
        showToast(`スケジューラーは完了しましたが、ルール一覧の更新に失敗しました: ${refreshResult.error.message}`, 7000, 'error');
      } else {
        showToast(conflicts > 0 ? `スケジューラーが完了しました（競合 ${conflicts}件）` : 'スケジューラーが完了しました', 5000, conflicts > 0 ? 'warning' : 'activity');
      }
    } catch (error) {
      if (!active) return;
      feedback.textContent = error.message;
      feedback.hidden = false;
      confirmButton.disabled = false;
      cancelButton.disabled = false;
      showToast(error.message, 5000, 'error');
    } finally {
      schedulerRunning = false;
      progress.hidden = true;
      confirmButton.classList.remove('is-running');
      confirmButton.textContent = '実行';
      schedulerButton.disabled = false;
      schedulerButton.textContent = 'スケジューラー実行';
    }
  });

  deleteDialog.addEventListener('cancel', event => { if (deleting) event.preventDefault(); });
  deleteDialog.querySelector('[data-cancel]').addEventListener('click', () => deleteDialog.close());
  deleteDialog.querySelector('[data-confirm]').addEventListener('click', async () => {
    if (deleting || pendingDeleteTargets.length === 0) return;
    deleting = true;
    const confirmButton = deleteDialog.querySelector('[data-confirm]');
    const cancelButton = deleteDialog.querySelector('[data-cancel]');
    const feedback = resetActionFeedback(deleteDialog);
    feedback.textContent = `ルールを削除しています（0 / ${pendingDeleteTargets.length}件）…`;
    feedback.classList.add('is-progress');
    feedback.hidden = false;
    confirmButton.classList.add('is-running');
    confirmButton.disabled = true;
    cancelButton.disabled = true;
    updateSelectionControls(listHost.querySelector('.rule-table'), currentFilteredRows());
    try {
      const result = await deleteRulesByUid(pendingDeleteTargets.map(row => row.uid), {
        onProgress({ deleted, total }) {
          feedback.textContent = `${deleted} / ${total}件を削除しました。続けて処理しています…`;
          feedback.hidden = false;
        }
      });
      if (!active) return;
      clearSelection();
      feedback.textContent = 'ルール一覧を更新しています…';
      const refreshResult = await refresh(true);
      deleteDialog.close();
      if (refreshResult.ok) {
        showToast(`${result.deletedRuleUids.length}件のルールを削除しました`, 5000);
      } else {
        showToast(`${result.deletedRuleUids.length}件のルールは削除されましたが、一覧更新に失敗しました: ${refreshResult.error.message}`, 7000, 'error');
      }
    } catch (error) {
      if (!active) return;
      clearSelection();
      const refreshResult = await refresh(true);
      feedback.classList.remove('is-progress');
      feedback.textContent = `削除を停止しました。${error.message}${refreshResult.ok ? '' : `。一覧更新にも失敗しました: ${refreshResult.error.message}`}`;
      feedback.hidden = false;
      cancelButton.disabled = false;
      cancelButton.textContent = '閉じる';
      showToast(feedback.textContent, 7000, 'error');
    } finally {
      deleting = false;
      feedback.classList.remove('is-progress');
      confirmButton.classList.remove('is-running');
      updateSelectionControls(listHost.querySelector('.rule-table'), currentFilteredRows());
    }
  });

  async function refresh(force = false) {
    const revision = ++refreshRevision;
    const achievementRequest = loadRuleRecordingCounts({ signal: controller.signal })
      .then(result => ({ result }), error => ({ error }));
    try {
      data = await loadRulesPageData({ force, signal: controller.signal });
      if (!active || revision !== refreshRevision) return { ok: true, superseded: true };
      listChannelMap = buildReservationChannelMap(data.reserves);
      const channelMap = listChannelMap;
      rows = buildRuleRows(data.rules, data.reserves, null, channelMap);
      clearSelection();
      renderRows();
      if (openRuleUid) {
        const target = rows.find(row => row.uid === openRuleUid);
        if (target) showEditor(target);
      }

      const achievement = await achievementRequest;
      if (!active || revision !== refreshRevision) return { ok: true, superseded: true };
      if (achievement.error) {
        if (achievement.error?.name === 'AbortError') return { ok: true, aborted: true };
        updateAchievementCells(true);
        return { ok: true, achievementError: achievement.error };
      }
      rows.forEach(row => {
        row.achievementCount = row.uid ? Number(achievement.result.counts[row.uid]) || 0 : 0;
      });
      updateAchievementCells();
      return { ok: true };
    } catch (error) {
      if (!active || error?.name === 'AbortError') return { ok: true, aborted: true };
      listHost.innerHTML = '<div class="rules-error"><p>ルール情報を取得できませんでした</p><small></small><button class="button" type="button">再試行</button></div>';
      listHost.querySelector('small').textContent = error.message;
      listHost.querySelector('button').addEventListener('click', () => refresh(true), { once: true });
      return { ok: false, error };
    }
  }

  const contextMenu = createRulesContextMenu({ onAction: (action, row) => {
    if (!active) return;
    if (action === 'edit') { showEditor(row); return; }
    if (action === 'duplicate') { showEditor(null, row); return; }
    if (action === 'reserves' && row.uid) {
      location.hash = `#reserves?ruleUid=${encodeURIComponent(row.uid)}`;
      return;
    }
    if (action === 'recorded' && row.uid) {
      location.hash = `#recorded?ruleUid=${encodeURIComponent(row.uid)}&results=recorded%2Cdeleted`;
      return;
    }
    if (action === 'delete' && row.uid) { openDeleteDialog(row.uid); return; }
    if (action === 'toggle' && row.uid) void toggleRule(row);
  }});
  listHost.addEventListener('contextmenu', event => {
    const item = event.target.closest?.('.rule-row');
    if (!item || !listHost.contains(item)) return;
    const row = rowByElement.get(item);
    if (!row) return;
    event.preventDefault();
    contextMenu.open(row, { x: event.clientX, y: event.clientY });
  });

  async function toggleRule(row) {
    if (togglingRule || deleting || schedulerRunning || !row.uid) return;
    togglingRule = true;
    try {
      // indexは削除/追加で変動するため操作直前にruleUidで再解決する。
      await setRuleEnabledByUid(row.uid, row.enabled);
      if (!active) return;
      const result = await refresh(true);
      if (!result.ok) showToast(`ルールの状態は変更されましたが、一覧更新に失敗しました: ${result.error.message}`, 7000, 'error');
    } catch (error) {
      if (!active) return;
      const result = await refresh(true);
      showToast(`${error.message}${result.ok ? '' : `（一覧更新にも失敗: ${result.error.message}）`}`, 7000, 'error');
    } finally {
      togglingRule = false;
    }
  }

  searchInput.addEventListener('input', () => { search = searchInput.value; clearSelection(); renderRows(); });
  statusSelect.addEventListener('change', () => { status = statusSelect.value; clearSelection(); renderRows(); });
  createButton.addEventListener('click', () => showEditor());
  schedulerButton.addEventListener('click', openSchedulerDialog);
  deleteButton.addEventListener('click', () => openDeleteDialog());
  const unsubscribeStorage = subscribeStorageData(state => {
    if (!active) return;
    storageError = state.error;
    storageData = state.data;
    if (storageToken !== null) {
      if (data !== null) renderRows();
      return;
    }
    if (storageData === null) return;
    listHost.querySelectorAll('.rule-row').forEach(item => {
      const row = rowByElement.get(item);
      applyStorageWarning(item.querySelector('.rule-storage-warning'), row.enabled
        ? buildReservationStorageDisplay(storageData, row.rule).notice
        : null);
    });
  });
  refresh().catch(() => {});

  return () => {
    active = false;
    unsubscribeStorage();
    controller.abort();
    contextMenu.destroy();
    headerCompactMedia.removeEventListener('change', headerCompactListener);
    setHeaderActions();
    disposeLogos();
    openRuleUid = null;
    openDialog?.close();
    if (schedulerDialog.open) schedulerDialog.close();
    if (deleteDialog.open) deleteDialog.close();
  };
}
