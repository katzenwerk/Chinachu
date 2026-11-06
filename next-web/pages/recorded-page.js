import { dismissProgramHover } from '../components/program-hover.js';
import { createReservationListRenderer } from '../components/reservation-list-row.js';
import { headerCompactMedia } from '../components/mobile-layout.js';
import { createHoverPopupController } from '../components/hover-popup-controller.js';
import {
  loadAllRecordedResults,
  loadRecordedResultsWithStoragePaths,
  loadMatchRecordingPaths,
  loadRecordedResultsPage
} from '../services/recorded-results-client.js';
import { buildRecordedResultModels } from '../services/recorded-result-model.js';
import { hasRecordedResultWarnings } from '../services/recorded-result-warnings.js';
import { buildRecordedCardModels, createRecordedCard } from '../components/recorded-card.js';
import { buildRecordedResultsCsv, recordedResultsCsvFilename } from '../services/recorded-results-csv.js';
import { openRecordedPlaybackOverlay } from '../services/live-player-adapter.js';
import { openProgramDetailDialog } from '../components/program-detail-dialog.js';
import { deleteRecordedFromContext } from '../services/recorded-delete-action.js';
import { createRecordedContextMenu } from '../components/recorded-context-menu.js';
import { subscribeMatchNotifications, subscribeSeriesNotifications } from '../services/realtime-client.js';
import { openCleanerDialog } from '../components/cleaner-dialog.js';
import { loadSeriesProjection } from '../services/series-client.js';
import { buildSeriesTitleIndex } from '../services/program-title.js';
import { buildSeriesEventIndex, seriesEventHref } from '../services/series-event-model.js';
import { loadResource } from '../services/api-client.js';
import { resolveRecordedStorage, resolveStorageFilter } from '../services/storage-model.js';

const SEARCH_DELAY_MS = 280;
const AUTO_LOAD_DISTANCE_PX = 200;
const AUTO_LOAD_ROOT_MARGIN = `0px 0px ${AUTO_LOAD_DISTANCE_PX}px 0px`;
const RESULT_OPTIONS = [
  ['recorded', '録画済み'],
  ['deleted', '削除済み'],
  ['missing', '行方不明'],
  ['missed', '未録画・NG'],
  ['skipped', 'スキップ']
];
const DEFAULT_RESULTS = ['recorded', 'deleted', 'missing', 'missed'];
// Attention mode always checks all result categories except intentionally skipped ones.
const ATTENTION_RESULTS = RESULT_OPTIONS.map(([value]) => value).filter(value => value !== 'skipped');
const ATTENTION_DESCRIPTION = '録画済み・削除済み・未録画／NG（スキップを除く）の分類から、注意が記録された結果だけを表示します。\n例：未録画、容量不足による中断、DROP検出、録画ファイル欠損。DROPは必ずしも映像破損を意味しません。';
const RESULT_VALUES = new Set(RESULT_OPTIONS.map(([value]) => value));
const LIST_PAGE_SIZE = 50;
const CARD_PAGE_SIZE = 25;
const VIEW_STORAGE_KEY = 'chinachu.next.recordedView';
const RESULTS_STORAGE_KEY = 'chinachu.next.recordedResults';

function readStoredView() {
  try { return localStorage.getItem(VIEW_STORAGE_KEY) === 'card' ? 'card' : 'list'; } catch { return 'list'; }
}

function readSelectedResults(query) {
  if (query.has('results')) {
    return new Set((query.get('results') || '').split(',').filter(value => RESULT_VALUES.has(value)));
  }
  try {
    const stored = localStorage.getItem(RESULTS_STORAGE_KEY);
    if (stored === null) return new Set(DEFAULT_RESULTS);
    const values = JSON.parse(stored);
    return new Set(Array.isArray(values) ? values.filter(value => RESULT_VALUES.has(value)) : DEFAULT_RESULTS);
  } catch {
    return new Set(DEFAULT_RESULTS);
  }
}

function storePreference(key, value) {
  try { localStorage.setItem(key, value); } catch (_) {}
}

function appendUnique(target, additions) {
  const keys = new Set(target.map(item => item?.key).filter(Boolean));
  additions.forEach(item => {
    if (item?.key && keys.has(item.key)) return;
    if (item?.key) keys.add(item.key);
    target.push(item);
  });
  return target;
}

function downloadCsv(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function renderRecordedPage(container, query = new URLSearchParams(), { setHeaderActions = () => {} } = {}) {
  let active = true;
  let search = query.get('search') || '';
  let ruleUid = query.get('ruleUid') || null;
  let channelId = query.get('channelId') || null;
  let storageToken = query.get('storage') || null;
  let storageData = null;
  let selectedResults = readSelectedResults(query);
  let viewMode = readStoredView();
  let warningsOnly = false;
  let tsIssuesOnly = query.get('tsIssues') === '1';
  let filteredCache = null;
  let items = [];
  let seriesTitleIndex = new Map();
  let seriesEventIndex = new Map();
  let total = 0;
  let currentPage = 0;
  let totalPages = 0;
  let loading = false;
  let exporting = false;
  let searchComposing = false;
  let searchTimer = null;
  let requestSequence = 0;
  let requestController = null;
  let exportController = null;
  let refreshPromise = null;
  let refreshQueued = false;
  let autoLoadArmed = false;
  let autoLoadBlocked = false;
  let initialPageLoaded = false;
  const viewStates = {
    list: { items: [], total: 0, currentPage: 0, totalPages: 0, loaded: false },
    card: { items: [], total: 0, currentPage: 0, totalPages: 0, loaded: false }
  };

  const page = document.createElement('div');
  page.className = 'recorded-page';
  page.innerHTML = `
    <section class="reserves-view recorded-results-view" aria-label="録画結果一覧">
      <div class="reserves-controls">
        <div class="panel reserves-controls-panel">
          <div class="reserves-toolbar recorded-results-toolbar">
            <label class="reserves-search"><input type="search" placeholder="番組名・放送局などを検索" aria-label="録画結果を検索" autocomplete="off"></label>
            <div class="recorded-view-switch" role="group" aria-label="表示形式">
              <button type="button" data-recorded-view="list" aria-pressed="true" title="リスト表示"><svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg></button>
              <button type="button" data-recorded-view="card" aria-pressed="false" title="カード表示"><svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg></button>
            </div>
            <div class="reserves-filter list-control-popup recorded-results-filter">
              <button class="reserves-filter-control list-control-popup-trigger" type="button" aria-haspopup="true" aria-expanded="false"><span>対象</span><strong></strong></button>
              <div class="list-control-popup-panel recorded-results-filter-menu" hidden>
                ${RESULT_OPTIONS.map(([value, label]) => `<label><input type="checkbox" data-recorded-result value="${value}"><span>${label}</span></label>`).join('')}
                <div class="recorded-results-warning-divider" role="separator"></div>
                <label class="recorded-results-warning-option"><input type="checkbox" value="attention"><span>⚠ 注意ありのみ</span></label>
                <label class="recorded-results-ts-option"><input type="checkbox" value="tsIssues"><span>DROP／TS異常ありのみ</span></label>
              </div>
            </div>
            <button class="button recorded-results-csv" type="button">CSV出力</button>
	            <button class="button recorded-results-cleaner" type="button">台帳整理</button>
            <span class="reserves-count" aria-label="録画結果件数">--</span>
          </div>
          <p class="reserves-jump-feedback recorded-results-export-feedback" role="status" hidden></p>
          <div class="reserves-rule-filter" hidden><span></span><a href="#recorded">絞り込みを解除</a></div>
        </div>
      </div>
      <div class="panel reserves-list-panel">
        <div class="reserves-list-content" aria-live="polite"><p class="reserves-message">録画結果を取得しています</p></div>
        <div class="recorded-results-more" hidden>
          <div><p class="recorded-results-feedback" role="status" hidden></p><span class="recorded-results-loading" hidden>読み込み中…</span><button class="button recorded-results-load-more" type="button">もっと見る</button></div>
        </div>
      </div>
    </section>`;
  container.replaceChildren(page);

  // Move the existing controls into the shared green header without rebuilding them.
  // Keep export feedback and scoped-filter status in the content area.
  const controls = page.querySelector('.reserves-controls');
  const toolbar = controls.querySelector('.recorded-results-toolbar');
  const exportFeedback = controls.querySelector('.recorded-results-export-feedback');
  const ruleFilter = controls.querySelector('.reserves-rule-filter');
  controls.replaceWith(exportFeedback, ruleFilter);

  const headerToolbar = document.createElement('div');
  headerToolbar.className = 'recorded-header-toolbar';
  headerToolbar.innerHTML = '<details class="recorded-header-controls" open><summary>録画結果操作</summary><div class="recorded-header-content"></div></details>';
  const headerControls = headerToolbar.querySelector('.recorded-header-controls');
  headerToolbar.querySelector('.recorded-header-content').append(toolbar);
  // Search -> filter -> result count -> view switch -> export/maintenance.
  const viewSwitch = toolbar.querySelector('.recorded-view-switch');
  toolbar.insertBefore(toolbar.querySelector('.recorded-results-filter'), viewSwitch);
  toolbar.insertBefore(toolbar.querySelector('.reserves-count'), viewSwitch);

  const count = toolbar.querySelector('.reserves-count');
  toolbar.prepend(count);
  const searchInput = toolbar.querySelector('.reserves-search input');
  const viewButtons = Array.from(toolbar.querySelectorAll('[data-recorded-view]'));
  const filter = toolbar.querySelector('.recorded-results-filter');
  const filterTrigger = filter.querySelector('.reserves-filter-control');
  const filterSummary = filterTrigger.querySelector('strong');
  const filterPanel = filter.querySelector('.recorded-results-filter-menu');
  const filterInputs = Array.from(filter.querySelectorAll('input[data-recorded-result]'));
  const attentionInput = filter.querySelector('.recorded-results-warning-option input');
  const tsIssuesInput = filter.querySelector('.recorded-results-ts-option input');
  const attentionOption = filter.querySelector('.recorded-results-warning-option');
  const filterLabel = filterTrigger.querySelector('span');
  attentionOption.title = ATTENTION_DESCRIPTION;
  attentionInput.setAttribute('aria-label', '注意ありのみ（スキップを除く3種類から抽出）');
  const csvButton = toolbar.querySelector('.recorded-results-csv');
  const cleanerButton = toolbar.querySelector('.recorded-results-cleaner');
  const content = page.querySelector('.reserves-list-content');
  const listRenderer = createReservationListRenderer(content);
  const cardGrid = document.createElement('div');
  cardGrid.className = 'recorded-results-card-grid';
  const cards = new Map();
  const more = page.querySelector('.recorded-results-more');
  const moreButton = more.querySelector('.recorded-results-load-more');
  const feedback = more.querySelector('.recorded-results-feedback');
  const loadingIndicator = more.querySelector('.recorded-results-loading');
  setHeaderActions(headerToolbar);

  const compactHeader = headerCompactMedia(1300);
  const syncHeaderLayout = () => { headerControls.open = !compactHeader.matches; };
  compactHeader.addEventListener('change', syncHeaderLayout);
  syncHeaderLayout();
  const closeHeaderOnOutsideClick = event => {
    if (compactHeader.matches && headerControls.open && !headerControls.contains(event.target)) {
      headerControls.open = false;
    }
  };
  const closeHeaderOnEscape = event => {
    if (event.key === 'Escape' && compactHeader.matches && headerControls.open) {
      headerControls.open = false;
      headerControls.querySelector('summary').focus();
    }
  };
  document.addEventListener('pointerdown', closeHeaderOnOutsideClick);
  document.addEventListener('keydown', closeHeaderOnEscape);
  searchInput.value = search;
  function updateScopedFilters() {
    const labels = [];
    if (ruleUid !== null) labels.push(`ruleUid: ${ruleUid}`);
    if (channelId !== null) labels.push(`放送局ID: ${channelId}`);
    if (storageToken !== null) {
      const storage = resolveStorageFilter(storageData, storageToken);
      labels.push(`録画先: ${storage ? `${storage.name || storage.id || 'Default'} (${storage.configuredPath || storage.path})` : storageToken}`);
    }
    ruleFilter.hidden = labels.length === 0;
    ruleFilter.querySelector('span').textContent = labels.length ? `${labels.join(' / ')} で絞り込み中` : '';
  }
  updateScopedFilters();
	  storePreference(RESULTS_STORAGE_KEY, JSON.stringify(Array.from(selectedResults)));
	  cleanerButton.addEventListener('click', openCleanerDialog);

  function isActive() {
    return active && page.isConnected;
  }

  function selectedResultValues() {
    return RESULT_OPTIONS.map(([value]) => value).filter(value => selectedResults.has(value));
  }

  function resultValues() {
    return warningsOnly || tsIssuesOnly ? ATTENTION_RESULTS.slice() : selectedResultValues();
  }

  function invalidateFilteredCache() {
    filteredCache = null;
  }

  function matchesScopedResult(item) {
    const storage = resolveStorageFilter(storageData, storageToken);
    return (!channelId || String(item?.channel?.id ?? '') === channelId) &&
      (!warningsOnly || hasRecordedResultWarnings(item)) &&
      (storageToken === null || storage !== null && resolveRecordedStorage(storageData, item) === storage);
  }

  async function loadResults(options) {
    options = { ...options, tsIssues: tsIssuesOnly };
    if (!warningsOnly && !channelId && storageToken === null) return loadRecordedResultsPage(options);
    if (storageToken !== null && storageData === null) {
      const data = await loadResource('storage');
      if (!Array.isArray(data?.storages)) throw new Error('Storage API response is invalid');
      storageData = data;
      if (isActive()) updateScopedFilters();
    }
    const key = JSON.stringify({ search: options.search || '', ruleUid: options.ruleUid || '',
      results: options.results || [], channelId, warningsOnly, tsIssuesOnly, storageToken });
    if (filteredCache === null || filteredCache.key !== key) {
      const loadAll = storageToken === null ? loadAllRecordedResults : loadRecordedResultsWithStoragePaths;
      const promise = loadAll({
        search: options.search,
        ruleUid: options.ruleUid,
        results: options.results,
        limit: 200,
        signal: options.signal
      }).then(allItems => allItems.filter(matchesScopedResult));
      filteredCache = { key, promise };
      promise.catch(() => {
        if (filteredCache?.promise === promise) filteredCache = null;
      });
    }
    const filtered = await filteredCache.promise;
    const pageNumber = Math.max(1, Number(options.page) || 1);
    const pageSize = Math.max(1, Number(options.limit) || LIST_PAGE_SIZE);
    const offset = (pageNumber - 1) * pageSize;
    return {
      items: filtered.slice(offset, offset + pageSize),
      total: filtered.length,
      page: pageNumber,
      pageSize,
      totalPages: filtered.length === 0 ? 0 : Math.ceil(filtered.length / pageSize)
    };
  }

  function saveViewState() {
    viewStates[viewMode] = {
      items: items.slice(), total, currentPage, totalPages, loaded: initialPageLoaded
    };
  }

  function restoreViewState() {
    const state = viewStates[viewMode];
    items = state.items.slice();
    total = state.total;
    currentPage = state.currentPage;
    totalPages = state.totalPages;
    initialPageLoaded = state.loaded;
  }

  function clearCards() {
    cards.forEach(card => card.dispose());
    cards.clear();
    cardGrid.replaceChildren();
  }

  function renderCards() {
    const models = buildRecordedCardModels(items, { seriesTitleIndex });
    const activeKeys = new Set(models.map(model => model.key));
    cards.forEach((card, key) => {
      if (activeKeys.has(key)) return;
      card.dispose();
      card.element.remove();
      cards.delete(key);
    });
    const elements = models.map(model => {
      let card = cards.get(model.key);
      if (!card) {
        card = createRecordedCard(model, {
          onWatch: openRecordedPlaybackOverlay,
          onOpenDetail: selected => {
            const query = new URLSearchParams(selected.detailUrl.split('?')[1] || '');
            openProgramDetailDialog({ key: query.get('key'), id: query.get('id'), onChanged: requestDynamicRefresh });
          }
        });
        cards.set(model.key, card);
      } else {
        card.update(model);
      }
      return card.element;
    });
    cardGrid.append(...elements);
    content.replaceChildren(cardGrid);
  }

  function updateFilterControl() {
    filterInputs.forEach(input => { input.checked = warningsOnly || tsIssuesOnly
      ? ATTENTION_RESULTS.includes(input.value) : selectedResults.has(input.value); });
    attentionInput.checked = warningsOnly;
    tsIssuesInput.checked = tsIssuesOnly;
    filter.classList.toggle('is-warning-only', warningsOnly || tsIssuesOnly);
    const selectedLabels = RESULT_OPTIONS
      .filter(([value]) => selectedResults.has(value))
      .map(([, label]) => label);
    filterLabel.textContent = warningsOnly ? '⚠ 注意あり' : tsIssuesOnly ? 'DROP／TS異常' : '対象';
    filterSummary.hidden = warningsOnly || tsIssuesOnly;
    filterSummary.textContent = warningsOnly || tsIssuesOnly ? '' : `${selectedLabels.length}/${RESULT_OPTIONS.length}`;
    filterTrigger.title = warningsOnly ? ATTENTION_DESCRIPTION : tsIssuesOnly ? 'Mirakurun DROPまたはTS解析で異常を検出した録画のみ表示します。解析失敗は含めません。' : '';
    filterTrigger.setAttribute('aria-label', warningsOnly
      ? '対象フィルター: 注意ありのみ（スキップ以外の分類から抽出）'
      : tsIssuesOnly ? '対象フィルター: DROP／TS異常ありのみ'
      : `対象フィルター: ${selectedLabels.length === 0 ? '選択なし' : selectedLabels.join('、')}`);
  }

  function updateViewControl() {
    page.dataset.recordedView = viewMode;
    viewButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.recordedView === viewMode)));
  }

  function updateHash() {
    const params = new URLSearchParams();

    if (ruleUid !== null) params.set('ruleUid', ruleUid);
    if (channelId !== null) params.set('channelId', channelId);
    if (storageToken !== null) params.set('storage', storageToken);
    if (tsIssuesOnly) params.set('tsIssues', '1');
    // Preserve the user's manual selection in the URL while attention mode is temporary.
    const values = selectedResultValues();
    if (values.join(',') !== DEFAULT_RESULTS.join(',')) params.set('results', values.join(','));
    const suffix = params.toString();
    history.replaceState(null, '', `#recorded${suffix ? `?${suffix}` : ''}`);
  }

  function updateCount() {
    count.textContent = `${total}件`;
  }

  function updateMore() {
    const hasMore = currentPage < totalPages;
    more.hidden = !hasMore && !(loading && items.length > 0);
    loadingIndicator.hidden = !loading;
    moreButton.hidden = loading;
    moreButton.disabled = loading;
    moreButton.textContent = 'もっと見る';
  }

  function scheduleAutoLoadArming() {
    window.requestAnimationFrame(() => {
      if (!isActive() || !initialPageLoaded || autoLoadBlocked || loading || more.hidden || currentPage >= totalPages) return;
      if (more.getBoundingClientRect().top <= window.innerHeight + AUTO_LOAD_DISTANCE_PX) {
        autoLoadArmed = false;
        loadPage(false);
        return;
      }
      autoLoadArmed = true;
    });
  }

  function renderItems({ preserveScroll = false } = {}) {
    updateCount();
    if (items.length === 0) {
      listRenderer.clear();
      clearCards();
      content.innerHTML = '<p class="reserves-message">条件に一致する録画結果はありません</p>';
      updateMore();
      return;
    }
    if (viewMode === 'card') {
      listRenderer.clear();
      renderCards();
    } else {
      clearCards();
      listRenderer.render(buildRecordedResultModels(items, { seriesTitleIndex }), { preserveScroll });
    }
    updateMore();
  }

  function renderInitialError(error) {
    count.textContent = '取得失敗';
    listRenderer.clear();
    const message = document.createElement('div');
    message.className = 'reserves-error';
    message.innerHTML = '<p>録画結果を取得できませんでした</p><small></small><button class="button" type="button">再試行</button>';
    message.querySelector('small').textContent = String(error?.message || error);
    message.querySelector('button').addEventListener('click', () => loadPage(true), { once: true });
    content.replaceChildren(message);
    more.hidden = true;
  }

  async function loadPage(reset = false) {
    if (!isActive() || loading && !reset) return;
    if (reset) {
      requestController?.abort();
      autoLoadArmed = false;
      autoLoadBlocked = false;
      initialPageLoaded = false;
      items = [];
      listRenderer.clear();
      clearCards();
      total = 0;
      currentPage = 0;
      totalPages = 0;
      count.textContent = '--';
      content.innerHTML = '<p class="reserves-message">録画結果を取得しています</p>';
      updateHash();
    }
    const sequence = ++requestSequence;
    const controller = new AbortController();
    requestController = controller;
    loading = true;
    feedback.hidden = true;
    updateMore();
    try {
      const resultPromise = loadResults({
        page: reset ? 1 : currentPage + 1,
        limit: viewMode === 'card' ? CARD_PAGE_SIZE : LIST_PAGE_SIZE,
        search,
        ruleUid,
        results: resultValues(),
        signal: controller.signal
      });
      const result = await resultPromise;
      const nextItems = reset ? result.items.slice() : appendUnique(items.slice(), result.items);
      const seriesSnapshot = await loadSeriesProjection({ signal: controller.signal,
        eventKeys: nextItems.map(item => item.key) }).catch(() => null);
      if (!isActive() || sequence !== requestSequence) return;
      if (seriesSnapshot !== null) {
        seriesTitleIndex = buildSeriesTitleIndex(seriesSnapshot);
        seriesEventIndex = buildSeriesEventIndex(seriesSnapshot);
      }
      items = reset ? result.items.slice() : appendUnique(items.slice(), result.items);
      total = result.total;
      currentPage = result.page;
      totalPages = result.totalPages;
      initialPageLoaded = true;
      saveViewState();
      autoLoadBlocked = false;
      renderItems();
    } catch (error) {
      if (!isActive() || sequence !== requestSequence || error?.name === 'AbortError') return;
      if (items.length === 0) {
        renderInitialError(error);
      } else {
        autoLoadBlocked = true;
        feedback.textContent = `続きを取得できませんでした: ${String(error?.message || error)}`;
        feedback.hidden = false;
        more.hidden = false;
      }
    } finally {
      if (sequence === requestSequence) {
        loading = false;
        requestController = null;
        updateMore();
        scheduleAutoLoadArming();
      }
    }
  }

  async function reloadVisiblePages() {
    if (!isActive()) return;
    const pagesToReload = Math.max(1, currentPage);
    requestController?.abort();
    const sequence = ++requestSequence;
    const controller = new AbortController();
    requestController = controller;
    loading = true;
    feedback.hidden = true;
    updateMore();
    try {
      const refreshed = [];
      let lastResult = null;
      for (let pageNumber = 1; pageNumber <= pagesToReload; pageNumber += 1) {
        const result = await loadResults({
          page: pageNumber,
          limit: viewMode === 'card' ? CARD_PAGE_SIZE : LIST_PAGE_SIZE,
          search,
          ruleUid,
          results: resultValues(),
          signal: controller.signal
        });
        appendUnique(refreshed, result.items);
        lastResult = result;
        if (pageNumber >= result.totalPages) break;
      }
      const seriesSnapshot = await loadSeriesProjection({ signal: controller.signal,
        eventKeys: refreshed.map(item => item.key) }).catch(() => null);
      if (!isActive() || sequence !== requestSequence || lastResult === null) return;
      if (seriesSnapshot !== null) {
        seriesTitleIndex = buildSeriesTitleIndex(seriesSnapshot);
        seriesEventIndex = buildSeriesEventIndex(seriesSnapshot);
      }
      items = refreshed;
      total = lastResult.total;
      currentPage = Math.min(pagesToReload, lastResult.totalPages || 1);
      totalPages = lastResult.totalPages;
      saveViewState();
      renderItems({ preserveScroll: true });
    } catch (error) {
      if (!isActive() || sequence !== requestSequence || error?.name === 'AbortError') return;
      feedback.textContent = `更新できませんでした: ${String(error?.message || error)}`;
      feedback.hidden = false;
      more.hidden = false;
    } finally {
      if (sequence === requestSequence) {
        loading = false;
        requestController = null;
        updateMore();
        scheduleAutoLoadArming();
      }
    }
  }

  function requestDynamicRefresh() {
    viewStates[viewMode === 'list' ? 'card' : 'list'].loaded = false;
    refreshQueued = true;
    if (refreshPromise !== null) return refreshPromise;
    refreshPromise = (async () => {
      while (refreshQueued && isActive()) {
        refreshQueued = false;
        await reloadVisiblePages();
      }
    })().finally(() => {
      refreshPromise = null;
      if (refreshQueued && isActive()) requestDynamicRefresh();
    });
    return refreshPromise;
  }

  function scheduleSearch() {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      const nextSearch = searchInput.value;
      if (nextSearch === search) return;
      search = nextSearch;
      invalidateFilteredCache();
      viewStates.list.loaded = false;
      viewStates.card.loaded = false;
      loadPage(true);
    }, SEARCH_DELAY_MS);
  }

  async function exportCsv() {
    if (exporting || !isActive()) return;
    window.clearTimeout(searchTimer);
    if (searchInput.value !== search) {
      search = searchInput.value;
      await loadPage(true);
    }
    exporting = true;
    csvButton.disabled = true;
    csvButton.textContent = 'CSV作成中…';
    exportFeedback.hidden = true;
    const controller = new AbortController();
    exportController = controller;
    try {
      if (storageToken !== null && storageData === null) {
        const data = await loadResource('storage');
        if (!Array.isArray(data?.storages)) throw new Error('Storage API response is invalid');
        storageData = data;
      }
      const [allItems, recordingPaths] = await Promise.all([
        loadAllRecordedResults({
          search,
          ruleUid,
          results: resultValues(),
          tsIssues: tsIssuesOnly,
          signal: controller.signal
        }),
        loadMatchRecordingPaths({ signal: controller.signal })
      ]);
      if (!isActive()) return;
      const exportItems = allItems.map(item => ({ ...item,
        storageRecordingPath: item.recordingPath || recordingPaths.get(item.key) || null
      })).filter(matchesScopedResult)
        .map(item => ({
          ...item,
          recordingPath: recordingPaths.get(item?.key) || item?.recordingPath || ''
        }));
      downloadCsv(buildRecordedResultsCsv(exportItems), recordedResultsCsvFilename());
      exportFeedback.textContent = `${exportItems.length}件をCSVへ出力しました`;
      exportFeedback.hidden = false;
    } catch (error) {
      if (!isActive() || error?.name === 'AbortError') return;
      exportFeedback.textContent = `CSVを出力できませんでした: ${String(error?.message || error)}`;
      exportFeedback.hidden = false;
    } finally {
      if (exportController === controller) exportController = null;
      exporting = false;
      if (isActive()) {
        csvButton.disabled = false;
        csvButton.textContent = 'CSV出力';
      }
    }
  }

  function showContextError(error) {
    exportFeedback.textContent = `操作できませんでした: ${String(error?.message || error)}`;
    exportFeedback.hidden = false;
  }

  function applyContextFilter(action, item) {
    if (action === 'filter-title') {
      // 作品の同一性までは推測せず、現行APIのタイトル文字列検索を使う。
      search = String(item.title || item.fullTitle || '').trim();
      if (!search) return;
      searchInput.value = search;
      window.clearTimeout(searchTimer);
    } else if (action === 'filter-channel') {
      if (!item.channel?.id) return;
      channelId = String(item.channel.id);
    } else if (action === 'filter-rule') {
      if (!item.ruleUid) return;
      ruleUid = item.ruleUid;
    } else if (action === 'filter-clear') {
      tsIssuesOnly = false;
      warningsOnly = false;
      ruleUid = null;
      channelId = null;
      storageToken = null;
      search = '';
      searchInput.value = '';
      window.clearTimeout(searchTimer);
    }
    updateScopedFilters();
    invalidateFilteredCache();
    viewStates.list.loaded = false;
    viewStates.card.loaded = false;
    loadPage(true);
  }

  function openContextDetail(item, initialAction = null) {
    openProgramDetailDialog({
      key: typeof item?.key === 'string' ? item.key : null,
      id: typeof item?.recordedId === 'string' ? item.recordedId : null,
      initialAction,
      onChanged: requestDynamicRefresh
    });
  }

  async function copyRecordedContextTitle(title) {
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

  const contextMenu = createRecordedContextMenu({
    onAction(action, item) {
      if (!isActive()) return;
      if (action.startsWith('filter-')) return applyContextFilter(action, item);
      if (action === 'series-view') {
        const href = seriesEventHref(item.seriesContext, 'recordings');
        if (href) window.location.hash = href;
        return;
      }
      if (['series-change', 'series-episode', 'series-remove'].includes(action)) {
        openProgramDetailDialog({
          key: item.key,
          id: item.recordedId,
          initialAction: action,
          onChanged: requestDynamicRefresh
        });
        return;
      }
      if (action === 'copy-title') {
        const title = (typeof item?.fullTitle === 'string' && item.fullTitle.trim()) ||
          (typeof item?.title === 'string' && item.title.trim()) || '';
        if (!title) return;
        void copyRecordedContextTitle(title).catch(showContextError);
        return;
      }
      if (action === 'search-google' || action === 'search-wikipedia') {
        const title = (typeof item?.title === 'string' && item.title.trim()) ||
          (typeof item?.fullTitle === 'string' && item.fullTitle.trim()) || '';
        if (!title) return;
        const url = action === 'search-google'
          ? `https://www.google.com/search?q=${encodeURIComponent(title)}`
          : `https://ja.wikipedia.org/wiki/${encodeURIComponent(title)}`;
        window.open(url, '_blank', 'noopener');
        return;
      }
      if (action === 'detail') return openContextDetail(item);
      if (action === 'rule') return openContextDetail(item, action);
      if (action === 'delete') {
        void deleteRecordedFromContext({ key: item.key, recordedId: item.recordedId })
          .then(async result => {
            if (!result || !isActive()) return;
            invalidateFilteredCache();
            viewStates.list.loaded = false;
            viewStates.card.loaded = false;
            await requestDynamicRefresh();
            if (result.storageRefreshError) {
              exportFeedback.textContent = `録画ファイルは削除しましたが、容量表示の更新に失敗しました: ${result.storageRefreshError}`;
              exportFeedback.hidden = false;
            }
          })
          .catch(showContextError);
        return;
      }
      if (action === 'play') {
        openRecordedPlaybackOverlay({
          playable: true,
          recordedId: item.recordedId,
          title: item.fullTitle || item.title || 'タイトル未取得'
        }).catch(showContextError);
      } else if (action === 'download') {
        // 通常の詳細画面と同じ録画ファイルAPI。HDDアクセスは利用者の操作時だけ。
        const link = document.createElement('a');
        link.href = `/api/recorded/${encodeURIComponent(item.recordedId)}/file.m2ts`;
        link.download = '';
        link.hidden = true;
        document.body.append(link);
        link.click();
        link.remove();
      }
    }
  });

  function contextTarget(event) {
    const row = event.target.closest?.('.recorded-card[data-recorded-key], .reservation-list-row[data-reservation-key]');
    if (!row || !content.contains(row)) return null;
    const key = row.dataset.recordedKey || row.dataset.reservationKey;
    const item = items.find(value => value?.key === key) || null;
    if (!item) return null;
    const seriesContext = seriesEventIndex.get(item.key) || {
      eventKey: item.key,
      event: { ...item, key: item.key, resolution: null },
      seriesId: null,
      tidConfirmed: false,
      manual: false,
      candidates: []
    };
    return { ...item, seriesContext };
  }
  content.addEventListener('contextmenu', event => {
    const item = contextTarget(event);
    if (!item) return;
    event.preventDefault();
    dismissProgramHover();
    contextMenu.open(item, { x: event.clientX, y: event.clientY });
  });
  content.addEventListener('keydown', event => {
    if (!(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) return;
    const item = contextTarget(event);
    if (!item) return;
    event.preventDefault();
    const rect = event.target.getBoundingClientRect();
    contextMenu.open(item, { x: rect.left + 16, y: rect.top + 16 });
  });

  searchInput.addEventListener('compositionstart', () => {
    searchComposing = true;
  });
  searchInput.addEventListener('compositionend', () => {
    searchComposing = false;
    scheduleSearch();
  });
  searchInput.addEventListener('input', event => {
    if (searchComposing || event.isComposing) return;
    scheduleSearch();
  });
  function onResultsFilterChanged() {
    invalidateFilteredCache();
    viewStates.list.loaded = false;
    viewStates.card.loaded = false;
    updateFilterControl();
    loadPage(true);
  }

  filterInputs.forEach(input => input.addEventListener('change', () => {
    // A manual category edit leaves attention mode and starts from the displayed 3/4.
    warningsOnly = false;
    tsIssuesOnly = false;
    selectedResults = new Set(filterInputs.filter(item => item.checked).map(item => item.value));
    storePreference(RESULTS_STORAGE_KEY, JSON.stringify(Array.from(selectedResults)));
    onResultsFilterChanged();
  }));
  attentionInput.addEventListener('change', () => {
    // Do not overwrite the user's saved categories. Turning this off restores them.
    warningsOnly = attentionInput.checked;
    if (warningsOnly) tsIssuesOnly = false;
    onResultsFilterChanged();
  });
  tsIssuesInput.addEventListener('change', () => {
    tsIssuesOnly = tsIssuesInput.checked;
    if (tsIssuesOnly) warningsOnly = false;
    onResultsFilterChanged();
  });
  viewButtons.forEach(button => button.addEventListener('click', () => {
    const nextView = button.dataset.recordedView;
    if (nextView === viewMode || !['list', 'card'].includes(nextView)) return;
    if (loading) {
      requestController?.abort();
      invalidateFilteredCache();
    }
    saveViewState();
    viewMode = nextView;
    storePreference(VIEW_STORAGE_KEY, viewMode);
    restoreViewState();
    updateViewControl();
    updateHash();
    if (initialPageLoaded) renderItems();
    else loadPage(true);
  }));
  csvButton.addEventListener('click', exportCsv);
  moreButton.addEventListener('click', () => {
    autoLoadBlocked = false;
    loadPage(false);
  });

  const autoLoadObserver = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(entries => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      if (!entry.isIntersecting) {
        if (initialPageLoaded) autoLoadArmed = true;
        return;
      }
      if (!initialPageLoaded || !autoLoadArmed || autoLoadBlocked || loading || currentPage >= totalPages) return;
      autoLoadArmed = false;
      loadPage(false);
    }, { root: null, rootMargin: AUTO_LOAD_ROOT_MARGIN, threshold: 0 })
    : null;

  updateFilterControl();
  updateViewControl();
  const filterPopup = createHoverPopupController({ root: filter, trigger: filterTrigger, panel: filterPanel });
  autoLoadObserver?.observe(more);
  const unsubscribe = subscribeMatchNotifications(() => {
    invalidateFilteredCache();
    requestDynamicRefresh();
  });
  const unsubscribeSeries = subscribeSeriesNotifications(update => {
    if (update?.generation) requestDynamicRefresh();
  });
  loadPage(true);

  return () => {
    active = false;
    listRenderer.dispose();
    requestController?.abort();
    exportController?.abort();
    window.clearTimeout(searchTimer);
    compactHeader.removeEventListener('change', syncHeaderLayout);
    document.removeEventListener('pointerdown', closeHeaderOnOutsideClick);
    document.removeEventListener('keydown', closeHeaderOnEscape);
    autoLoadObserver?.disconnect();
    filterPopup.destroy();
    contextMenu.destroy();
    setHeaderActions();
    unsubscribe();
    unsubscribeSeries();
    clearCards();
    dismissProgramHover();
  };
}
