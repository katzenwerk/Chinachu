import { dismissProgramHover } from '../components/program-hover.js';
import { createReservationListRenderer } from '../components/reservation-list-row.js';
import { createHoverPopupController } from '../components/hover-popup-controller.js';
import { createHomeProgramContextMenu } from '../components/home-program-context-menu.js';
import { openRuleEditorDialog, programRuleSeed } from '../components/rule-editor-dialog.js';
import { createMonthCalendar } from '../components/month-calendar.js';
import { openProgramDetailDialog } from '../components/program-detail-dialog.js';
import { invalidateResources, loadResource } from '../services/api-client.js';
import { buildReservationListModels, filterReservationListModels, findReservationDateJumpTarget, nextReservationDisplayBoundaryDelay } from '../services/reservation-model.js';
import { subscribeReservationNotifications, subscribeSeriesNotifications } from '../services/realtime-client.js';
import { subscribeStorageData } from '../services/storage-store.js';
import { ruleAction } from '../services/program-detail-model.js';
import { loadSeriesProjection } from '../services/series-client.js';
import { buildSeriesTitleIndex, canonicalProgramKey } from '../services/program-title.js';

function normalizeStatus(value) {
  return ['normal', 'skip', 'conflict'].includes(value) ? value : 'all';
}

export function renderReservesPage(container, query = new URLSearchParams(), { setHeaderActions = () => {} } = {}) {
  let active = true;
  let models = [];
  let latestPrograms = [];
  let storageData = null;
  let seriesTitleIndex = new Map();
  let status = normalizeStatus(query.get('status'));
  let search = query.get('search') || '';
  let ruleUid = query.get('ruleUid') || null;
  let ruleId = ruleUid === null ? query.get('rule') : null;
  let channelId = query.get('channelId') || null;
  let refreshPromise = null;
  let refreshQueued = false;
  let forceQueued = false;
  let searchComposing = false;
  let pendingJumpKey = null;
  let jumpHighlightTimer = null;
  let jumpMessageTimer = null;
  let displayBoundaryTimer = null;
  let refreshGeneration = 0;
  const preferredRuleUids = new Map();
  let ruleDialog = null;

  const page = document.createElement('div');
  page.className = 'reserves-page';
  page.innerHTML = `
    <section class="reserves-view" aria-label="予約一覧">
      <div class="reserves-controls">
        <div class="panel reserves-controls-panel" hidden>
          <p class="reserves-jump-feedback" role="status" hidden></p>
          <div class="reserves-rule-filter" hidden><span></span><a href="#reserves">絞り込みを解除</a></div>
        </div>
      </div>
      <div class="panel reserves-list-panel">
        <div class="reserves-list-content" aria-live="polite"><p class="reserves-message">予約情報を取得しています</p></div>
      </div>
    </section>`;
  container.replaceChildren(page);

  const toolbar = document.createElement('div');
  toolbar.className = 'reserves-toolbar reserves-header-toolbar';
  toolbar.innerHTML = `
    <label class="reserves-search"><input type="search" placeholder="番組名・放送局などを検索" aria-label="予約を検索" autocomplete="off"></label>
    <div class="reserves-date-jump-host"></div>
    <div class="reserves-filter list-control-popup reserves-target-filter">
      <button class="reserves-filter-control list-control-popup-trigger" type="button" aria-haspopup="true" aria-expanded="false"><span>対象：</span><strong></strong></button>
      <div class="list-control-popup-panel reserves-target-menu" hidden>
        <label><input type="radio" name="reserves-target" value="all"><span>すべて</span></label>
        <label><input type="radio" name="reserves-target" value="normal"><span>通常</span></label>
        <label><input type="radio" name="reserves-target" value="skip"><span>スキップ</span></label>
        <label><input type="radio" name="reserves-target" value="conflict"><span>競合</span></label>
      </div>
    </div>
    <span class="reserves-count" aria-label="予約件数">--</span>`;
  setHeaderActions(toolbar);

  const controls = page.querySelector('.reserves-controls');
  const controlsPanel = page.querySelector('.reserves-controls-panel');
  const count = toolbar.querySelector('.reserves-count');
  toolbar.prepend(count);
  const searchInput = toolbar.querySelector('.reserves-search input');
  const dateJumpHost = toolbar.querySelector('.reserves-date-jump-host');
  const jumpFeedback = page.querySelector('.reserves-jump-feedback');
  const targetFilter = toolbar.querySelector('.reserves-target-filter');
  const targetTrigger = targetFilter.querySelector('.reserves-filter-control');
  const targetSummary = targetTrigger.querySelector('strong');
  const targetPanel = targetFilter.querySelector('.reserves-target-menu');
  const targetInputs = Array.from(targetFilter.querySelectorAll('input[type="radio"]'));
  const ruleFilter = page.querySelector('.reserves-rule-filter');
  const content = page.querySelector('.reserves-list-content');
  const listRenderer = createReservationListRenderer(content);
  function updateControlsVisibility() {
    controls.hidden = jumpFeedback.hidden && ruleFilter.hidden;
    controlsPanel.hidden = controls.hidden;
  }

  searchInput.value = search;
  function updateTargetControl() {
    targetInputs.forEach(input => { input.checked = input.value === status; });
    targetSummary.textContent = targetInputs.find(input => input.value === status)?.nextElementSibling?.textContent || 'すべて';
  }
  updateTargetControl();
  function updateScopedFilter() {
    const labels = [];
    if (ruleUid !== null) labels.push(`ruleUid: ${ruleUid}`);
    else if (ruleId !== null) labels.push(`ルール番号: ${ruleId}`);
    if (channelId !== null) labels.push(`放送局ID: ${channelId}`);
    ruleFilter.querySelector('span').textContent = `${labels.join(' / ')} で絞り込み中`;
    ruleFilter.hidden = labels.length === 0;
    updateControlsVisibility();
  }
  updateScopedFilter();

  function isActive() {
    return active && page.isConnected;
  }

  function updateHash() {
    const params = new URLSearchParams(query);
    const setOrDelete = (key, value, defaultValue) => {
      if (value === defaultValue || value === '') params.delete(key); else params.set(key, String(value));
    };
    setOrDelete('search', search, '');
    setOrDelete('status', status, 'all');
    setOrDelete('ruleUid', ruleUid, null);
    setOrDelete('rule', ruleId, null);
    setOrDelete('channelId', channelId, null);
    params.delete('limit');
    params.delete('page');
    const suffix = params.toString();
    history.replaceState(null, '', `#reserves${suffix ? `?${suffix}` : ''}`);
  }

  function currentFilteredModels() {
    const scoped = filterReservationListModels(models, { search, ruleUid, ruleId, channelId });
    return {
      scoped,
      filtered: filterReservationListModels(scoped, { status })
    };
  }

  function showJumpFeedback(message) {
    window.clearTimeout(jumpMessageTimer);
    jumpFeedback.textContent = message;
    jumpFeedback.hidden = false;
    updateControlsVisibility();
    jumpMessageTimer = window.setTimeout(() => {
      jumpFeedback.hidden = true;
      updateControlsVisibility();
    }, 4200);
  }

  function focusJumpTarget(list) {
    if (pendingJumpKey === null) return;
    const key = pendingJumpKey;
    pendingJumpKey = null;
    window.requestAnimationFrame(() => {
      if (!isActive()) return;
      const target = Array.from(list.children).find(row => row.dataset.reservationKey === key);
      if (!target) return;
      window.clearTimeout(jumpHighlightTimer);
      target.classList.add('is-jump-target');
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      jumpHighlightTimer = window.setTimeout(() => target.classList.remove('is-jump-target'), 2400);
    });
  }

  function renderList({ preserveScroll = false } = {}) {
    if (!isActive()) return;
    const { filtered } = currentFilteredModels();
    count.textContent = `${filtered.length}件`;
    if (models.length === 0) {
      listRenderer.clear();
      content.innerHTML = '<p class="reserves-message">現在、予約はありません</p>';
      updateHash();
      return;
    }
    if (filtered.length === 0) {
      listRenderer.clear();
      content.innerHTML = '<p class="reserves-message">条件に一致する予約はありません</p>';
      updateHash();
      return;
    }
    const list = listRenderer.element;
    listRenderer.render(filtered, { preserveScroll });
    updateHash();
    focusJumpTarget(list);
  }

  function scheduleDisplayBoundary() {
    window.clearTimeout(displayBoundaryTimer);
    const delay = nextReservationDisplayBoundaryDelay(latestPrograms);
    if (delay === null) return;
    displayBoundaryTimer = window.setTimeout(() => {
      if (!isActive()) return;
      models = buildReservationListModels(latestPrograms, { storageData, seriesTitleIndex });
      renderList({ preserveScroll: true });
      scheduleDisplayBoundary();
    }, Math.min(delay, 2147483647));
  }

  function applySearchInput() {
    const nextSearch = searchInput.value;
    if (nextSearch === search) return;
    search = nextSearch;
    renderList();
  }

  function jumpToDate(value) {
    const { filtered } = currentFilteredModels();
    const target = findReservationDateJumpTarget(filtered, value);
    if (target === null) {
      showJumpFeedback('現在の検索・絞り込み結果には、指定日以降の予約がありません');
      return;
    }
    pendingJumpKey = target.model.key;
    focusJumpTarget(content.querySelector('.reservation-list'));
    showJumpFeedback(target.model.dateValue === value
      ? `${target.model.dateText}の最初の予約へ移動しました`
      : `${target.model.dateText}の予約へ移動しました（指定日以降で最も近い予約）`);
  }

  function renderError(error) {
    latestPrograms = [];
    listRenderer.clear();
    window.clearTimeout(displayBoundaryTimer);
    count.textContent = '取得失敗';
    const message = document.createElement('div');
    message.className = 'reserves-error';
    message.innerHTML = '<p>予約情報を取得できませんでした</p><small></small><button class="button" type="button">再試行</button>';
    message.querySelector('small').textContent = String(error?.message || error);
    message.querySelector('button').addEventListener('click', () => requestRefresh(true), { once: true });
    content.replaceChildren(message);
  }

  function requestRefresh(force = false) {
    if (!isActive()) return Promise.resolve();
    refreshGeneration += 1;
    refreshQueued = true;
    forceQueued = forceQueued || force;
    if (refreshPromise !== null) return refreshPromise;
    refreshPromise = (async () => {
      while (refreshQueued && isActive()) {
        const generation = refreshGeneration;
        const shouldForce = forceQueued;
        refreshQueued = false;
        forceQueued = false;
        if (shouldForce) invalidateResources(['reserves']);
        try {
          const programs = await loadResource('reserves');
          const seriesSnapshot = await loadSeriesProjection({
            eventKeys: programs.map(canonicalProgramKey)
          }).catch(() => null);
          if (!isActive()) return;
          if (generation !== refreshGeneration) continue;
          latestPrograms = programs;
          if (seriesSnapshot !== null) {
            seriesTitleIndex = buildSeriesTitleIndex(seriesSnapshot);
          }
          models = buildReservationListModels(latestPrograms, { storageData, seriesTitleIndex });
          renderList({ preserveScroll: true });
          scheduleDisplayBoundary();
        } catch (error) {
          if (isActive() && generation === refreshGeneration) renderError(error);
        }
      }
    })().finally(() => {
      refreshPromise = null;
      if (refreshQueued && isActive()) requestRefresh();
    });
    return refreshPromise;
  }

  searchInput.addEventListener('compositionstart', () => {
    searchComposing = true;
  });
  searchInput.addEventListener('compositionend', () => {
    searchComposing = false;
    applySearchInput();
  });
  searchInput.addEventListener('input', event => {
    if (searchComposing || event.isComposing) return;
    applySearchInput();
  });
  targetInputs.forEach(input => input.addEventListener('change', () => {
    if (!input.checked) return;
    status = normalizeStatus(input.value);
    updateTargetControl();
    targetPopup.close('selection');
    renderList();
  }));
  page.addEventListener('click', event => {
    const link = event.target.closest?.('a[href*="#program?"]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const hash = new URL(link.href, location.href).hash;
    if (!hash.startsWith('#program?')) return;
    event.preventDefault();
    const detailQuery = new URLSearchParams(hash.slice('#program?'.length));
    openProgramDetailDialog({
      key: detailQuery.get('key'),
      id: detailQuery.get('id'),
      onChanged: () => requestRefresh(true)
    });
  });


  const showContextError = error => window.alert(`操作できませんでした: ${String(error?.message || error)}`);

  async function resolveContextRule(item) {
    // 古いruleIdやタイトルの曖昧一致から編集するルールを推測しない。
    invalidateResources(['rules']);
    const rules = await loadResource('rules');
    const program = item.program;
    const meta = program.reservationMeta || {};
    const action = ruleAction({
      ruleUid: program.ruleUid || meta.ruleUid || null,
      ruleId: program.ruleId ?? meta.ruleId,
      isManualReserved: program.isManualReserved === true || meta.isManualReserved === true
    }, rules, preferredRuleUids.get(item.id));
    if (action.mode === 'unavailable' && action.ruleUid &&
        action.label === '関連ルールは現在の一覧にありません') return { mode: 'create' };
    return action;
  }

  function openContextRule(item) {
    const action = item.ruleAction;
    if (!['create', 'edit'].includes(action?.mode) || ruleDialog?.open) return;
    const program = item.program;
    let editor = null;
    editor = openRuleEditorDialog({
      row: action.mode === 'edit' ? { index: action.index, uid: action.ruleUid, rule: action.rule } : null,
      initialRule: action.mode === 'create' ? programRuleSeed({
        title: program.title || program.fullTitle || item.title,
        type: program.channel?.type,
        channel: program.channel?.id,
        category: program.category
      }) : null,
      title: action.mode === 'edit' ? `ルール #${action.index + 1} を編集` : 'ルールを作成',
      onSaved: async result => {
        if (result.mode === 'create' && result.rule?.ruleUid) preferredRuleUids.set(item.id, result.rule.ruleUid);
        invalidateResources(['rules']);
        await requestRefresh(true);
      },
      onDeleted: async () => {
        preferredRuleUids.delete(item.id);
        invalidateResources(['rules']);
        await requestRefresh(true);
      },
      onClose: () => { if (ruleDialog === editor) ruleDialog = null; }
    });
    ruleDialog = editor;
  }

  async function copyContextTitle(title) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(title);
    const field = document.createElement('textarea');
    field.value = title;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.append(field);
    field.select();
    const copied = document.execCommand('copy');
    field.remove();
    if (!copied) throw new Error('クリップボードへのコピーに失敗しました');
  }

  function applyContextFilter(action, item) {
    const program = item?.program;
    if (action === 'filter-title') {
      const title = String(program?.title || program?.fullTitle || item?.title || '').trim();
      if (!title) return;
      search = title;
      searchInput.value = title;
    } else if (action === 'filter-channel') {
      const id = program?.channel?.id;
      if (id === undefined || id === null || id === '') return;
      channelId = String(id);
    } else if (action === 'filter-rule') {
      const uid = program?.ruleUid || program?.reservationMeta?.ruleUid;
      if (!uid) return;
      ruleUid = String(uid);
      ruleId = null;
    } else if (action === 'filter-clear') {
      search = '';
      searchInput.value = '';
      channelId = null;
      ruleUid = null;
      ruleId = null;
    } else return;
    updateScopedFilter();
    renderList();
  }

  ruleFilter.querySelector('a').addEventListener('click', event => {
    event.preventDefault();
    applyContextFilter('filter-clear');
  });

  const contextMenu = createHomeProgramContextMenu({
    enableFilter: true,
    resolveRule: resolveContextRule,
    onAction(action, item) {
      if (!isActive()) return;
      if (action.startsWith('filter-')) return applyContextFilter(action, item);
      if (action === 'copy-title') return void copyContextTitle(item.title).catch(showContextError);
      if (action === 'search-google' || action === 'search-wikipedia') {
        const url = action === 'search-google'
          ? `https://www.google.com/search?q=${encodeURIComponent(item.title)}`
          : `https://ja.wikipedia.org/wiki/${encodeURIComponent(item.title)}`;
        window.open(url, '_blank', 'noopener');
        return;
      }
      if (action === 'rule') {
        if (item.ruleAction?.mode === 'unavailable') {
          openProgramDetailDialog({ id: item.id, onChanged: () => requestRefresh(true) });
        } else openContextRule(item);
        return;
      }
    }
  });

  function openRowContext(event) {
    const row = event.target.closest?.('.reservation-list-row[data-reservation-key]');
    if (!row || !content.contains(row)) return;
    const model = models.find(value => value.key === row.dataset.reservationKey);
    if (!model?.id) return;
    const program = latestPrograms.find(value => value?.id != null && String(value.id) === model.id);
    if (!program) return;
    event.preventDefault();
    dismissProgramHover();
    const rect = row.getBoundingClientRect();
    const point = event.type === 'contextmenu'
      ? { x: event.clientX, y: event.clientY }
      : { x: rect.left + 16, y: rect.top + 16 };
    contextMenu.open({ kind: 'reservation', id: model.id,
      title: program.title || program.fullTitle || '', program, refresh: () => requestRefresh(true) }, point);
  }

  content.addEventListener('contextmenu', openRowContext);
  const keyboardContext = event => {
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) openRowContext(event);
  };
  content.addEventListener('keydown', keyboardContext);

  const calendar = createMonthCalendar(dateJumpHost, { onSelect: jumpToDate });
  const targetPopup = createHoverPopupController({
    root: targetFilter,
    trigger: targetTrigger,
    panel: targetPanel,
    hover: false
  });
  const unsubscribe = subscribeReservationNotifications(() => requestRefresh(true));
  const unsubscribeSeries = subscribeSeriesNotifications(update => {
    if (update?.generation) requestRefresh();
  });
  const unsubscribeStorage = subscribeStorageData(state => {
    if (!isActive() || state.data === null) return;
    storageData = state.data;
    if (latestPrograms.length === 0) return;
    models = buildReservationListModels(latestPrograms, { storageData, seriesTitleIndex });
    renderList({ preserveScroll: true });
    scheduleDisplayBoundary();
  });
  requestRefresh();

  return () => {
    active = false;
    listRenderer.dispose();
    dismissProgramHover();
    content.removeEventListener('contextmenu', openRowContext);
    content.removeEventListener('keydown', keyboardContext);
    contextMenu.destroy();
    calendar.destroy();
    targetPopup.destroy();
    setHeaderActions();
    unsubscribe();
    unsubscribeSeries();
    unsubscribeStorage();
    window.clearTimeout(jumpHighlightTimer);
    window.clearTimeout(jumpMessageTimer);
    window.clearTimeout(displayBoundaryTimer);
  };
}
