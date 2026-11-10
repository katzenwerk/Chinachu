import { createAppShell } from './components/app-shell.js';
import { installProgramDetailDialogLinks } from './components/program-detail-dialog.js';
import { renderHomePage } from './pages/home-page.js';
import { renderRecordingPage } from './pages/recording-page.js';
import { renderRecordedPage } from './pages/recorded-page.js';
import { renderReservesPage } from './pages/reserves-page.js';
import { renderConflictsPage } from './pages/conflicts-page.js';
import { renderStoragePage } from './pages/storage-page.js';
import { renderLogPage } from './pages/log-page.js';
import { renderProgramDetailPage } from './pages/program-detail-page.js';
import { renderCleanerPage } from './pages/cleaner-page.js';
import { renderGuidePage } from './pages/guide-page.js';
import { renderSearchPage } from './pages/search-page.js';
import { renderSettingsPage } from './pages/settings-page.js';
import { renderRulesPage } from './pages/rules-page.js';
import { renderSeriesPage } from './pages/series-page.js';
import { invalidateResources, loadResource } from './services/api-client.js';
import { refreshRealtimeData, subscribeMatchNotifications, subscribeRealtimeConnection, subscribeReservationNotifications, subscribeRecordedNotifications } from './services/realtime-client.js';
import { subscribeRecordingData } from './services/recording-store.js';
import { loadAutoTsStatus, subscribeAutoTsStatus } from './services/auto-ts-analysis-client.js';
import { loadRecordedResultsCounts } from './services/recorded-results-client.js';
import { pushSystemActivity, subscribeNotificationCenter } from './services/notification-store.js';
import {
  checkWuiConnectionNow,
  connectionActivityForTransition,
  resumeWuiConnectionMonitoring,
  setWuiConnectionSocketSubscriber,
  subscribeWuiConnection,
  suspendWuiConnectionMonitoring
} from './services/wui-connection-monitor.js';
import { loadServiceControl } from './services/service-control-client.js';
import { serviceGeneration, serviceGenerationChanged } from './services/service-restart-model.js';
import { completePendingRestart, subscribePendingRestart } from './services/service-restart-store.js';
import { initializeAuthentication, logout } from './services/auth-client.js';
import { refreshBroadcastClock, subscribeBroadcastClock } from './services/broadcast-clock-store.js';

const appRoot = document.querySelector('#app');
const authentication = await initializeAuthentication(appRoot);
const shell = createAppShell(appRoot);
shell.setAuthentication(authentication.enabled === true, logout);
const unsubscribeBroadcastClock = subscribeBroadcastClock(state => shell.setServerClockState(state));
const unsubscribeAutoTsStatus = subscribeAutoTsStatus(status => shell.setAutoTsStatus(status));
let autoTsPollTimer = null;
let autoTsPolling = false;
let autoTsActive = true;
async function refreshAutoTsStatus() {
  if (!autoTsActive || autoTsPolling) return;
  clearTimeout(autoTsPollTimer);
  autoTsPolling = true;
  let nextDelay = 60000;
  try {
    const status = await loadAutoTsStatus();
    nextDelay = status.enabled ? status.state === 'running' ? 3000 : 30000 : 120000;
  } catch (_) {
    // An older Operator may not implement this feature yet.
  } finally {
    autoTsPolling = false;
    if (autoTsActive) autoTsPollTimer = setTimeout(refreshAutoTsStatus, nextDelay);
  }
}
void refreshAutoTsStatus();
const unsubscribeAutoTsRecorded = subscribeRecordedNotifications(() => { void refreshAutoTsStatus(); });
window.addEventListener('chinachu-auth-state', event => shell.setAuthentication(event.detail?.enabled === true, logout));
const uninstallProgramDetailDialogLinks = installProgramDetailDialogLinks();
setWuiConnectionSocketSubscriber(subscribeRealtimeConnection);
const unsubscribeRecordingCount = subscribeRecordingData(state => {
  shell.setRecordingCount(state.status === 'ready' ? state.programs.length : 0);
});
let reservationCountRefresh = null;
let reservationCountRefreshQueued = false;
let reservationCountForceQueued = false;
let reservationCountGeneration = 0;
let recordedCountRefresh = null;
let recordedCountRefreshQueued = false;
let recordedCountGeneration = 0;

function refreshReservationCounts(force = false) {
  reservationCountGeneration += 1;
  reservationCountRefreshQueued = true;
  reservationCountForceQueued = reservationCountForceQueued || force;
  if (reservationCountRefresh !== null) return reservationCountRefresh;
  reservationCountRefresh = (async () => {
    while (reservationCountRefreshQueued) {
      const shouldForce = reservationCountForceQueued;
      const generation = reservationCountGeneration;
      reservationCountRefreshQueued = false;
      reservationCountForceQueued = false;
      try {
        const programs = await loadResource('reserves', { force: shouldForce });
        if (!Array.isArray(programs)) throw new Error('Reserves API response is invalid');
        if (generation === reservationCountGeneration) {
          shell.setReservationCounts(
            programs.length,
            programs.filter(program => program?.isConflict === true).length
          );
        }
      } catch (_) {}
    }
  })().finally(() => {
    reservationCountRefresh = null;
    if (reservationCountRefreshQueued) refreshReservationCounts();
  });
  return reservationCountRefresh;
}

const unsubscribeReservationCount = subscribeReservationNotifications(() => refreshReservationCounts(true));
refreshReservationCounts();

function refreshRecordedCount() {
  recordedCountGeneration += 1;
  recordedCountRefreshQueued = true;
  if (recordedCountRefresh !== null) return recordedCountRefresh;
  recordedCountRefresh = (async () => {
    while (recordedCountRefreshQueued) {
      const generation = recordedCountGeneration;
      recordedCountRefreshQueued = false;
      try {
        const counts = await loadRecordedResultsCounts();
        if (generation === recordedCountGeneration) shell.setRecordedCounts(counts);
      } catch (_) {}
    }
  })().finally(() => {
    recordedCountRefresh = null;
    if (recordedCountRefreshQueued) refreshRecordedCount();
  });
  return recordedCountRefresh;
}

const unsubscribeRecordedCount = subscribeMatchNotifications(refreshRecordedCount);
refreshRecordedCount();
let recordedCountConnected = false;
const unsubscribeRecordedCountReconnect = subscribeRealtimeConnection(connectionState => {
  if (connectionState.status !== 'connected') return;
  if (recordedCountConnected) refreshRecordedCount();
  recordedCountConnected = true;
});
let lastToastId = null;
const unsubscribeNotifications = subscribeNotificationCenter(state => {
  shell.setNotifications(state);
  if (state.toast?.id && state.toast.id !== lastToastId) {
    lastToastId = state.toast.id;
    const recordingEvent = state.toast.kind === 'recording-start' || state.toast.kind === 'recording-complete';
    shell.showToast(recordingEvent && state.toast.kind === 'recording-complete' ? state.toast : state.toast.text,
      recordingEvent ? 4000 : 10000, state.toast.level);
  }
});
const routeTitles = {
  home: 'ホーム',
  guide: '番組表',
  search: '番組検索',
  recording: '録画中',
  recorded: '録画結果',
  reserves: '予約一覧',
  conflicts: '予約タイムライン',
  rules: 'ルール',
  series: 'シリーズ',
  status: 'ステータス',
  storage: 'ストレージ',
  log: 'サービスとログ',
  settings: '設定',
  program: '番組詳細',
  cleaner: '台帳整理'
};
let disposeCurrentPage = null;
let routeReady = false;
let lastConnectionTransition = 0;
let lastRestartCompletion = 0;
let restartPollTimer = null;
let restartPollBusy = false;
let pendingRestartState = null;

function scheduleRestartPoll(delay = 0) {
  clearTimeout(restartPollTimer);
  if (pendingRestartState) restartPollTimer = setTimeout(pollPendingRestart, delay);
}

async function pollPendingRestart() {
  if (!pendingRestartState || restartPollBusy) return;
  if (Date.now() > pendingRestartState.deadline) {
    completePendingRestart(false, '復旧状態を確認できません');
    return;
  }
  restartPollBusy = true;
  try {
    const report = await loadServiceControl();
    const pending = pendingRestartState;
    const operation = report.operations?.[pending.target];
    const target = report.targets?.[pending.target];
    if (operation && pending.id && operation.id === pending.id && operation.state === 'failed') {
      completePendingRestart(false, operation.message || '再起動に失敗しました');
    } else if (pending.target === 'operator' && target?.operable === true && target.status === 'online'
      && serviceGenerationChanged(pending.before, serviceGeneration(target))) {
      completePendingRestart(true, 'Operatorの再起動後の稼働を確認しました');
    }
  } catch (_) {
    // A liveness failure is handled separately; never convert a transient GET failure into PM2 unavailability.
  } finally {
    restartPollBusy = false;
    if (pendingRestartState) scheduleRestartPoll(1500);
  }
}

const unsubscribeRestartState = subscribePendingRestart(restartState => {
  pendingRestartState = restartState.pending;
  shell.setServiceRestartState(pendingRestartState);
  if (restartState.completion && restartState.completion.id !== lastRestartCompletion) {
    lastRestartCompletion = restartState.completion.id;
    const completion = restartState.completion;
    if (completion.target === 'operator' && completion.succeeded) {
      pushSystemActivity('operator-restarted', 'Operatorが再起動しました', '#log');
    } else if (!completion.succeeded && completion.notify !== false) {
      pushSystemActivity('service-restart-error', completion.message || 'サービスの再起動を確認できません', '#log');
    }
  }
  scheduleRestartPoll();
});

shell.setConnectionRetryHandler(checkWuiConnectionNow);
const unsubscribeWuiConnection = subscribeWuiConnection(connectionState => {
  shell.setConnectionState(connectionState);
  if (connectionState.status === 'connected') refreshBroadcastClock();
  const event = connectionState.transition;
  if (!event || event.id === lastConnectionTransition) return;
  lastConnectionTransition = event.id;
  const activity = connectionActivityForTransition(event);
  if (activity) pushSystemActivity(activity.kind, activity.title, '#log');
  if ((event.kind === 'started' || event.kind === 'reconnected') && pendingRestartState?.target === 'wui') {
    completePendingRestart(true, event.kind === 'started' ? 'WUIの起動を確認しました' : 'WUIへの再接続を確認しました');
  }
  // A new WUI process may serve updated client code and version metadata.
  // Re-rendering the route alone keeps the old JavaScript modules in memory.
  if (event.kind === 'started') {
    window.location.reload();
    return;
  }
  if (routeReady && event.kind === 'reconnected') {
    invalidateResources();
    refreshRealtimeData();
  }
});

let currentPageName = null;
let currentPageSearch = '';

async function route() {
  const raw = window.location.hash.slice(1) || 'home';
  const [name, queryString = ''] = raw.split('?');
  const query = new URLSearchParams(queryString);
  const searchKey = name === 'search' ? 'q' : 'search';
  if (currentPageName === name) {
    const input = document.querySelector('#header-page-actions input[type="search"]') || shell.outlet.querySelector('input[type="search"]');
    if (input) currentPageSearch = input.value;
    if (!query.has(searchKey)) query.set(searchKey, currentPageSearch);
  } else {
    currentPageSearch = '';
  }
  if (query.has(searchKey)) currentPageSearch = query.get(searchKey) || '';
  // A search supplied by a link is consumed once, not retained in browser history.
  const addressQuery = new URLSearchParams(queryString);
  if (addressQuery.has(searchKey)) {
    addressQuery.delete(searchKey);
    history.replaceState(null, '', `#${name}${addressQuery.size ? `?${addressQuery}` : ''}`);
  }
  currentPageName = name;
  if (disposeCurrentPage !== null) {
    disposeCurrentPage();
    disposeCurrentPage = null;
  }
  shell.setPageActions();
  shell.setActiveRoute(name);
  shell.title.textContent = routeTitles[name] || '未実装';
  const page = document.createElement('div');
  shell.outlet.replaceChildren(page);
  if (name === 'home') {
    disposeCurrentPage = renderHomePage(page, { setHeaderActions: shell.setPageActions });
    return;
  }
  if (name === 'guide') {
    disposeCurrentPage = renderGuidePage(page, { setHeaderActions: shell.setPageActions });
    return;
  }
  if (name === 'search') {
    disposeCurrentPage = renderSearchPage(page, query, { setHeaderActions: shell.setPageActions });
    return;
  }
  if (name === 'recording') {
    disposeCurrentPage = renderRecordingPage(page);
    return;
  }
  if (name === 'recorded') {
    disposeCurrentPage = renderRecordedPage(page, query, {
      setHeaderActions: shell.setPageActions
    });
    return;
  }
  if (name === 'reserves') {
    disposeCurrentPage = renderReservesPage(page, query, {
      setHeaderActions: shell.setPageActions
    });
    return;
  }
  if (name === 'conflicts') {
    disposeCurrentPage = renderConflictsPage(page);
    return;
  }
  if (name === 'rules') {
    disposeCurrentPage = renderRulesPage(page, query, {
      setHeaderActions: shell.setPageActions,
      showToast: shell.showToast
    });
    return;
  }
  if (name === 'series') {
    disposeCurrentPage = renderSeriesPage(page, query, {
      setHeaderActions: shell.setPageActions
    });
    return;
  }
  if (name === 'storage') {
    disposeCurrentPage = renderStoragePage(page);
    return;
  }
  if (name === 'log') {
    disposeCurrentPage = renderLogPage(page, query);
    return;
  }
  // Keep existing #postprocess bookmarks working after moving Task into the log screen.
  if (name === 'postprocess') {
    history.replaceState(null, '', '#log?tab=task');
    shell.setActiveRoute('log');
    shell.title.textContent = routeTitles.log;
    disposeCurrentPage = renderLogPage(page, new URLSearchParams('tab=task'));
    return;
  }
  if (name === 'program') {
    disposeCurrentPage = renderProgramDetailPage(page, query);
    return;
  }
  if (name === 'cleaner') {
    disposeCurrentPage = renderCleanerPage(page);
    return;
  }
  if (name === 'settings') {
    disposeCurrentPage = renderSettingsPage(page);
    return;
  }
  page.innerHTML = '<section class="panel empty-page"><h2>この画面は現在準備中です</h2></section>';
  routeReady = true;
}

window.addEventListener('hashchange', route);
window.addEventListener('pagehide', event => {
  if (event.persisted) {
    suspendWuiConnectionMonitoring();
    return;
  }
  if (disposeCurrentPage !== null) disposeCurrentPage();
  unsubscribeRecordingCount();
  autoTsActive = false;
  clearTimeout(autoTsPollTimer);
  unsubscribeAutoTsRecorded();
  unsubscribeAutoTsStatus();
  unsubscribeReservationCount();
  unsubscribeRecordedCount();
  unsubscribeRecordedCountReconnect();
  unsubscribeNotifications();
  unsubscribeWuiConnection();
  unsubscribeRestartState();
  unsubscribeBroadcastClock();
  uninstallProgramDetailDialogLinks();
  clearTimeout(restartPollTimer);
});
window.addEventListener('pageshow', event => {
  if (event.persisted) resumeWuiConnectionMonitoring();
});
	if (!window.location.hash) history.replaceState(null, '', '#home');
route().finally(() => { routeReady = true; });
