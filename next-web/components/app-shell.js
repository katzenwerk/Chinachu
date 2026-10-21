import { createToastQueue } from './toast-queue.js';

const icon = (name, small = false) => `<svg class="icon${small ? ' icon-small' : ''}"><use href="#icon-${name}"></use></svg>`;

const sprite = `
  <svg class="symbol-sprite" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
    <symbol id="icon-home" viewBox="0 0 24 24"><path d="m3 10 9-7 9 7v10H3zM9 21v-7h6v7"/></symbol>
    <symbol id="icon-guide" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v16m8-16v16"/></symbol>
    <symbol id="icon-record" viewBox="0 0 24 24"><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></symbol>
    <symbol id="icon-film" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18m10-18v18M3 8h4m-4 8h4m10-8h4m-4 8h4"/></symbol>
    <symbol id="icon-calendar" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18"/></symbol>
    <symbol id="icon-rule" viewBox="0 0 24 24"><path d="M4 5h16l-6 7v6l-4 2v-8z"/></symbol>
    <symbol id="icon-status" viewBox="0 0 24 24"><path d="M2 12h5l3-8 4 16 3-8h5"/></symbol>
    <symbol id="icon-storage" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 15h10m-2-6h2"/></symbol>
    <symbol id="icon-log" viewBox="0 0 24 24"><path d="M6 3h12v18H6zM9 8h6m-6 4h6m-6 4h4"/></symbol>
    <symbol id="icon-settings" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M10 2h4l1 3 3 1 3-1 2 4-2 2v2l2 2-2 4-3-1-3 1-1 3h-4l-1-3-3-1-3 1-2-4 2-2v-2L1 9l2-4 3 1 3-1z"/></symbol>
    <symbol id="icon-menu" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18m3-13h6m-6 4h6m-6 4h6"/></symbol>
    <symbol id="icon-search" viewBox="0 0 24 24"><circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/></symbol>
    <symbol id="icon-alert" viewBox="0 0 24 24"><path d="m12 3 10 18H2zM12 9v5m0 4h.01"/></symbol>
    <symbol id="icon-bell" viewBox="0 0 24 24"><path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5zM10 20h4"/></symbol>
    <symbol id="icon-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M19 5l-1.5 1.5m-11 11L5 19"/></symbol>
  </svg>`;

const primaryItems = [
  ['home', 'home', 'ホーム'],
  ['guide', 'guide', '番組表'],
  ['search', 'search', '番組検索'],
  ['recording', 'record', '録画中'],
  ['rules', 'rule', 'ルール'],
  ['reserves', 'calendar', '予約一覧'],
  ['recorded', 'film', '録画結果']
];
const adminItems = [
  ['storage', 'storage', 'ストレージ'],
  ['log', 'log', 'サービスとログ']
];
const SIDEBAR_PIN_STORAGE_KEY = 'chinachu.next.sidebarPinned';

function navItem([route, iconName, label]) {
  const href = route === 'storage' ? '#storage' : `#${route}`;
  const recordingIndicators = route === 'recording'
    ? '<span class="badge nav-count-badge" id="recording-count-badge" hidden></span><span class="nav-status-dot" id="recording-status-dot" aria-hidden="true" hidden></span>'
    : '';
  const recordedIndicators = route === 'recorded'
    ? '<span class="badge nav-count-badge recorded-count-badge" id="recorded-count-badge" title="録画実績 / 未録画" hidden><span class="recorded-count-success"></span><span class="recorded-count-separator" aria-hidden="true">/</span><span class="recorded-count-missed"></span></span>'
    : '';
  const reservationIndicators = route === 'reserves'
    ? '<span class="badge nav-count-badge" id="reservation-count-badge" hidden></span><span class="nav-status-dot" id="reservation-status-dot" aria-hidden="true" hidden></span>'
    : '';
  return `<a class="nav-item" href="${href}" data-route="${route}">${icon(iconName)}<span class="nav-label">${label}</span>${recordingIndicators}${recordedIndicators}${reservationIndicators}</a>`;
}

export function createAppShell(root) {
  const desktopSidebar = window.matchMedia('(hover: hover) and (pointer: fine)');
  const readSidebarPinned = () => {
    try {
      return window.localStorage.getItem(SIDEBAR_PIN_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  };
  let sidebarPinned = desktopSidebar.matches && readSidebarPinned();
  const initialSidebar = desktopSidebar.matches && !sidebarPinned ? 'compact' : 'open';
  const initialToggleLabel = desktopSidebar.matches
    ? (sidebarPinned
      ? 'サイドバーの固定を解除。現在：固定表示'
      : 'サイドバーを固定表示。現在：自動収納（ホバーで展開）')
    : 'メニューを閉じる';
  root.innerHTML = `${sprite}
    <header class="app-header">
      <div class="header-heading">
        <a class="brand" href="#home" aria-label="Chinachu ホーム">
          <span class="brand-wordmark">Chinachu</span>
          <svg class="brand-thorn" viewBox="0 0 12 18" aria-hidden="true" focusable="false">
            <path d="M2 1V17M2 4.5L10 9 2 13.5"/>
          </svg>
        </a>
        <div class="header-page-title"><h1 id="page-title">ストレージ</h1></div>
      </div>
      <div class="header-page-actions" id="header-page-actions"></div>
      <form class="header-program-search" id="header-program-search" role="search" aria-label="番組検索" hidden>
        <label class="header-program-search-label"><span class="header-search-caption">番組を検索</span><input type="search" name="q" maxlength="120" placeholder="番組を検索…" autocomplete="off" aria-label="番組名・キーワード"></label>
        <button type="submit" class="header-program-search-button" aria-label="番組を検索" title="番組を検索">${icon('search', true)}</button>
      </form>
      <div class="header-common-actions">
        <button class="icon-button" id="theme-toggle" type="button" aria-label="ダークテーマへ切替" title="テーマ切替">${icon('sun')}</button>
        <button class="icon-button notification-button" id="notification-button" type="button" aria-label="通知" title="通知" aria-controls="notification-panel" aria-expanded="false">${icon('bell')}<span class="notification-count" hidden></span></button>
      </div>
    </header>
    <div class="app-shell" id="app-shell" data-sidebar="${initialSidebar}">
      <div class="sidebar-track"><aside class="sidebar" id="sidebar" aria-label="メインメニュー">
        <div class="sidebar-control-row">
          <button class="sidebar-toggle" id="sidebar-toggle" type="button" aria-controls="sidebar" aria-expanded="${initialSidebar === 'open'}" aria-label="${initialToggleLabel}" title="${initialToggleLabel}">${icon('menu')}</button>
          <span class="sidebar-version" id="sidebar-version" hidden></span>
        </div>
        <nav class="sidebar-nav">${primaryItems.map(navItem).join('')}</nav>
        <div class="sidebar-separator"></div>
        <nav class="sidebar-nav">${adminItems.map(navItem).join('')}</nav>
        <div class="sidebar-bottom"><div class="sidebar-separator"></div>${navItem(['settings','settings','設定'])}</div>
      </aside></div>
      <main class="main-content">
        <div id="page-outlet"></div>
      </main>
    </div>
    <div class="wui-connection-overlay" id="wui-connection-overlay" role="alertdialog" aria-modal="true" aria-labelledby="wui-connection-title" hidden>
      <div class="wui-connection-message">
        <h2 id="wui-connection-title">WUIに接続できません</h2>
        <p class="wui-connection-detail">再接続を確認しています…</p>
        <div class="wui-connection-actions" hidden>
          <button class="button wui-connection-retry" type="button">接続を再確認</button>
          <button class="button wui-connection-reload" type="button">画面を再読み込み</button>
        </div>
      </div>
    </div>
    <aside class="notification-panel" id="notification-panel" aria-label="通知" hidden>
      <section><h2>未解決の警告</h2><div class="notification-issues"></div></section>
      <section><h2>最近の動作</h2><div class="notification-activities"></div></section>
    </aside>
    <div class="sidebar-toggle-tooltip" id="sidebar-toggle-tooltip" role="tooltip" hidden><strong></strong><span></span></div>
    <div class="toast" id="toast" role="status" aria-live="polite"></div>`;

  const shell = root.querySelector('#app-shell');
  const sidebar = root.querySelector('#sidebar');
  const toggle = root.querySelector('#sidebar-toggle');
  const toggleTooltip = root.querySelector('#sidebar-toggle-tooltip');
  const headerSearch = root.querySelector('#header-program-search');
  const headerSearchInput = headerSearch.querySelector('input');
  const headerSearchButton = headerSearch.querySelector('button');
  const narrowSearch = window.matchMedia('(max-width: 1250px)');
  headerSearchButton.addEventListener('click', event => {
    if (!narrowSearch.matches || headerSearch.classList.contains('is-expanded')) return;
    event.preventDefault();
    headerSearch.classList.add('is-expanded');
    headerSearchInput.focus();
  });
  headerSearch.addEventListener('submit', event => {
    event.preventDefault();
    const query = headerSearchInput.value.trim();
    headerSearch.classList.remove('is-expanded');
    window.location.hash = `#search${query ? `?q=${encodeURIComponent(query)}` : ''}`;
  });
  headerSearch.addEventListener('keydown', event => {
    if (event.key === 'Escape') { headerSearch.classList.remove('is-expanded'); headerSearchButton.focus(); }
  });
  document.addEventListener('pointerdown', event => {
    if (!headerSearch.contains(event.target)) headerSearch.classList.remove('is-expanded');
  });
  const themeToggle = root.querySelector('#theme-toggle');
  const notificationButton = root.querySelector('#notification-button');
  const notificationPanel = root.querySelector('#notification-panel');
  const notificationCount = notificationButton.querySelector('.notification-count');
  const connectionOverlay = root.querySelector('#wui-connection-overlay');
  const connectionTitle = connectionOverlay.querySelector('#wui-connection-title');
  const connectionDetail = connectionOverlay.querySelector('.wui-connection-detail');
  const connectionActions = connectionOverlay.querySelector('.wui-connection-actions');
  let connectionRetryHandler = null;
  let sidebarHovered = false;
  let sidebarKeyboardPreview = false;
  let suppressSidebarPreview = desktopSidebar.matches && !sidebarPinned;
  let suppressSidebarFocusPreview = desktopSidebar.matches && !sidebarPinned;
  let suppressSidebarToggleHover = desktopSidebar.matches;
  let suppressSidebarToggleFocus = desktopSidebar.matches;
  const toast = root.querySelector('#toast');
  const toastQueue = createToastQueue({
    show({ message, level }) {
      const markerLevel = level === 'warning' ? 'warning' : (level === 'error' || level === 'low' ? 'error' : 'activity');
      toast.textContent = message;
      toast.classList.toggle('is-warning', markerLevel === 'warning');
      toast.classList.toggle('is-error', markerLevel === 'error');
      toast.classList.add('is-visible');
    },
    hide() {
      toast.classList.remove('is-visible');
    }
  });
  let notificationPulseToken = 0;
  let currentNotificationIssues = [];
  let currentConnectionState = null;
  let currentRestartState = null;

  fetch('/api/diagnostics.json', {
    headers: { Accept: 'application/json' }
  }).then(response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }).then(report => {
    const version = report?.basic?.data?.chinachuVersion;
    if (typeof version !== 'string' || version.trim() === '') return;
    const versionElement = root.querySelector('#sidebar-version');
    versionElement.textContent = version;
    versionElement.hidden = false;
  }).catch(() => {});

  function updateSidebarToggle(expanded) {
    toggle.setAttribute('aria-expanded', String(expanded));
    const action = desktopSidebar.matches
      ? (sidebarPinned ? 'サイドバーの固定を解除' : 'サイドバーを固定表示')
      : (expanded ? 'メニューを閉じる' : 'メニューを開く');
    const state = sidebarPinned ? '現在：固定表示' : '現在：自動収納（ホバーで展開）';
    toggle.setAttribute('aria-label', desktopSidebar.matches ? `${action}。${state}` : action);
    if (desktopSidebar.matches) toggle.removeAttribute('title'); else toggle.title = action;
    toggleTooltip.querySelector('strong').textContent = action;
    toggleTooltip.querySelector('span').textContent = state;
  }

  function showSidebarToggleTooltip() {
    if (!desktopSidebar.matches) return;
    updateSidebarToggle(shell.dataset.sidebar !== 'compact' || sidebar.classList.contains('is-preview-open'));
    toggleTooltip.hidden = false;
  }

  function hideSidebarToggleTooltip() {
    toggleTooltip.hidden = true;
  }

  function setSidebar(compact) {
    shell.dataset.sidebar = compact ? 'compact' : 'open';
    updateSidebarToggle(!compact);
  }

  function saveSidebarPinned() {
    try {
      window.localStorage.setItem(SIDEBAR_PIN_STORAGE_KEY, String(sidebarPinned));
    } catch {}
  }

  function renderDesktopSidebar() {
    if (sidebarPinned) {
      sidebar.classList.remove('is-preview-open');
      setSidebar(false);
      return;
    }
    shell.dataset.sidebar = 'compact';
    const preview = !suppressSidebarPreview && (sidebarHovered || sidebarKeyboardPreview);
    sidebar.classList.toggle('is-preview-open', preview);
    updateSidebarToggle(preview);
  }

  function resetDesktopSidebar() {
    sidebarHovered = false;
    sidebarKeyboardPreview = false;
    suppressSidebarPreview = false;
    sidebar.classList.remove('is-preview-open');
    renderDesktopSidebar();
  }

  function suspendTransientSidebarPreview() {
    hideSidebarToggleTooltip();
    suppressSidebarToggleHover = desktopSidebar.matches;
    suppressSidebarToggleFocus = desktopSidebar.matches;
    if (!desktopSidebar.matches || sidebarPinned) return;
    sidebarHovered = false;
    sidebarKeyboardPreview = false;
    suppressSidebarPreview = true;
    suppressSidebarFocusPreview = true;
    renderDesktopSidebar();
  }

  function resumeTransientSidebarPreview() {
    hideSidebarToggleTooltip();
    if (desktopSidebar.matches && !toggle.matches(':hover')) suppressSidebarToggleHover = false;
    if (!desktopSidebar.matches || sidebarPinned) return;
    sidebarHovered = false;
    sidebarKeyboardPreview = false;
    if (!sidebar.matches(':hover')) suppressSidebarPreview = false;
    renderDesktopSidebar();
  }

  function handleVisibilityChange() {
    if (document.hidden) suspendTransientSidebarPreview(); else resumeTransientSidebarPreview();
  }

  function applySidebarMode() {
    if (desktopSidebar.matches) {
      sidebarPinned = readSidebarPinned();
      sidebarHovered = false;
      sidebarKeyboardPreview = false;
      suppressSidebarPreview = !sidebarPinned;
      suppressSidebarFocusPreview = !sidebarPinned;
      suppressSidebarToggleHover = true;
      suppressSidebarToggleFocus = true;
      hideSidebarToggleTooltip();
      sidebar.classList.remove('is-preview-open');
      renderDesktopSidebar();
      window.requestAnimationFrame(resumeTransientSidebarPreview);
      return;
    }
    sidebarPinned = false;
    sidebarHovered = false;
    sidebarKeyboardPreview = false;
    suppressSidebarPreview = false;
    suppressSidebarFocusPreview = false;
    suppressSidebarToggleHover = false;
    suppressSidebarToggleFocus = false;
    hideSidebarToggleTooltip();
    sidebar.classList.remove('is-preview-open');
    setSidebar(false);
  }

  function showToast(message, duration = 2200, level = 'activity') {
    toastQueue.enqueue(message, duration, level);
  }

  function closeNotifications() {
    if (notificationPanel.hidden) return;
    notificationPanel.hidden = true;
    notificationButton.setAttribute('aria-expanded', 'false');
    toastQueue.resume();
  }

  function renderNotificationIndicator() {
    const hasError = currentNotificationIssues.some(issue => issue?.level === 'error' || issue?.level === 'low');
    const hasWarning = currentNotificationIssues.some(issue => issue?.level === 'warning');
    const unresolvedCount = currentNotificationIssues.filter(issue => issue?.level === 'error' || issue?.level === 'low' || issue?.level === 'warning').length;
    notificationCount.textContent = '';
    notificationCount.classList.toggle('is-error', hasError);
    notificationCount.classList.toggle('is-warning', !hasError && hasWarning);
    notificationCount.hidden = !hasError && !hasWarning;
    notificationButton.setAttribute('aria-label', unresolvedCount === 0 ? '通知' : `通知、未解決の警告${unresolvedCount}件`);
  }

  function renderConnectionOverlay() {
    const offline = currentConnectionState?.status === 'offline';
    const restarting = currentRestartState?.target === 'wui'
      && ['accepted', 'running', 'reconnecting'].includes(currentRestartState.state);
    connectionOverlay.hidden = !offline && !restarting;
    if (connectionOverlay.hidden) return;
    const prolonged = currentConnectionState?.prolonged === true;
    connectionTitle.textContent = restarting ? 'WUIを再起動しています' : 'WUIに接続できません';
    connectionDetail.textContent = prolonged
      ? '接続を確認できません。再確認または画面の再読み込みを試してください。'
      : '再接続を確認しています…';
    connectionActions.hidden = !prolonged;
  }

  function notificationItem(item, activity = false) {
    const link = document.createElement('a');
    link.className = activity ? `notification-item is-activity ${item.kind || ''}` : `notification-item is-${item.level || 'warning'}`;
    link.href = item.href || '#home';
    const title = document.createElement('strong');
    title.textContent = activity ? item.title : `${item.name}：${item.message}`;
    link.append(title);
    if (!activity && item.detail) {
      const detail = document.createElement('span');
      detail.textContent = item.detail;
      link.append(detail);
    }
    if (activity && Number.isFinite(item.at)) {
      const time = document.createElement('time');
      time.dateTime = new Date(item.at).toISOString();
      time.textContent = new Date(item.at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
      link.append(time);
    }
    link.addEventListener('click', closeNotifications);
    return link;
  }

  function renderNotificationItems(container, items, emptyText, activity = false) {
    if (items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'notification-empty';
      empty.textContent = emptyText;
      container.replaceChildren(empty);
      return;
    }
    container.replaceChildren(...items.map(item => notificationItem(item, activity)));
  }

  toggle.addEventListener('click', () => {
    if (desktopSidebar.matches) {
      sidebarKeyboardPreview = false;
      sidebarPinned = !sidebarPinned;
      sidebarHovered = !sidebarPinned && sidebar.matches(':hover');
      suppressSidebarPreview = false;
      suppressSidebarFocusPreview = !sidebarPinned;
      saveSidebarPinned();
      renderDesktopSidebar();
      return;
    }
    const compact = shell.dataset.sidebar === 'compact';
    setSidebar(!compact);
  });
  toggle.addEventListener('mouseenter', () => {
    if (!suppressSidebarToggleHover) showSidebarToggleTooltip();
  });
  toggle.addEventListener('mouseleave', () => {
    suppressSidebarToggleHover = false;
    hideSidebarToggleTooltip();
  });
  toggle.addEventListener('focus', () => {
    if (!suppressSidebarToggleFocus && toggle.matches(':focus-visible')) showSidebarToggleTooltip();
  });
  toggle.addEventListener('blur', hideSidebarToggleTooltip);
  sidebar.addEventListener('pointerenter', () => {
    if (!desktopSidebar.matches) return;
    sidebarHovered = true;
    renderDesktopSidebar();
  });
  sidebar.addEventListener('pointerleave', () => {
    if (!desktopSidebar.matches) return;
    resetDesktopSidebar();
  });
  sidebar.addEventListener('focusin', event => {
    if (!desktopSidebar.matches) return;
    sidebarKeyboardPreview = !suppressSidebarFocusPreview
      && event.target instanceof Element
      && event.target.matches(':focus-visible');
    if (sidebarKeyboardPreview) suppressSidebarPreview = false;
    renderDesktopSidebar();
  });
  sidebar.addEventListener('focusout', event => {
    if (!desktopSidebar.matches || sidebar.contains(event.relatedTarget)) return;
    sidebarKeyboardPreview = false;
    renderDesktopSidebar();
  });
  document.addEventListener('visibilitychange', handleVisibilityChange);
  document.addEventListener('keydown', event => {
    if (desktopSidebar.matches && event.key === 'Tab') {
      suppressSidebarFocusPreview = false;
      suppressSidebarToggleFocus = false;
    }
  });
  window.addEventListener('blur', suspendTransientSidebarPreview);
  window.addEventListener('focus', resumeTransientSidebarPreview);
  desktopSidebar.addEventListener('change', applySidebarMode);
  themeToggle.addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme !== 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    themeToggle.setAttribute('aria-label', dark ? 'ライトテーマへ切替' : 'ダークテーマへ切替');
  });
  notificationButton.addEventListener('click', () => {
    const open = notificationPanel.hidden;
    if (open) toastQueue.pause();
    notificationPanel.hidden = !open;
    notificationButton.setAttribute('aria-expanded', String(open));
    if (!open) toastQueue.resume();
  });
  notificationButton.addEventListener('animationend', () => notificationButton.classList.remove('is-alerting'));
  connectionOverlay.querySelector('.wui-connection-retry').addEventListener('click', () => connectionRetryHandler?.());
  connectionOverlay.querySelector('.wui-connection-reload').addEventListener('click', () => window.location.reload());
  document.addEventListener('click', event => {
    if (notificationPanel.hidden || notificationPanel.contains(event.target) || notificationButton.contains(event.target)) return;
    closeNotifications();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeNotifications();
  });
  updateSidebarToggle(initialSidebar === 'open');
  window.requestAnimationFrame(resumeTransientSidebarPreview);

  return {
    outlet: root.querySelector('#page-outlet'),
    title: root.querySelector('#page-title'),
    showToast,
    setPageActions(element = null) {
      const host = root.querySelector('#header-page-actions');
      host.replaceChildren(...(element ? [element] : []));
    },
    setConnectionRetryHandler(handler) {
      connectionRetryHandler = typeof handler === 'function' ? handler : null;
    },
    setConnectionState(connectionState) {
      currentConnectionState = connectionState;
      renderConnectionOverlay();
    },
    setServiceRestartState(restartState) {
      currentRestartState = restartState;
      renderConnectionOverlay();
    },
    setNotifications(notificationState) {
      const issues = Array.isArray(notificationState?.issues) ? notificationState.issues : [];
      const activities = Array.isArray(notificationState?.activities) ? notificationState.activities : [];
      currentNotificationIssues = issues;
      renderNotificationIndicator();
      renderNotificationItems(root.querySelector('.notification-issues'), issues, '未解決の警告はありません');
      renderNotificationItems(root.querySelector('.notification-activities'), activities, '最近の動作はありません', true);
      if (Number.isInteger(notificationState?.pulseToken) && notificationState.pulseToken > notificationPulseToken) {
        notificationPulseToken = notificationState.pulseToken;
        notificationButton.classList.remove('is-alerting');
        void notificationButton.offsetWidth;
        notificationButton.classList.add('is-alerting');
      }
    },
    setRecordingCount(count) {
      const badge = root.querySelector('#recording-count-badge');
      const dot = root.querySelector('#recording-status-dot');
      const visible = Number.isInteger(count) && count > 0;
      badge.textContent = visible ? String(count) : '';
      badge.hidden = !visible;
      dot.hidden = !visible;
    },
    setRecordedCounts(counts) {
      const badge = root.querySelector('#recorded-count-badge');
      const link = root.querySelector('[data-route="recorded"]');
      const recorded = counts?.recorded;
      const missed = counts?.missed;
      const visible = Number.isInteger(recorded) && recorded >= 0 && Number.isInteger(missed) && missed >= 0;
      badge.querySelector('.recorded-count-success').textContent = visible ? String(recorded) : '';
      badge.querySelector('.recorded-count-missed').textContent = visible ? String(missed) : '';
      badge.hidden = !visible;
      link.setAttribute('aria-label', visible
        ? `録画結果、録画実績${recorded}件、未録画${missed}件`
        : '録画結果、録画実績 / 未録画');
    },
    setReservationCounts(count, conflictCount) {
      const badge = root.querySelector('#reservation-count-badge');
      const dot = root.querySelector('#reservation-status-dot');
      const visible = Number.isInteger(count) && count >= 0;
      const hasConflicts = Number.isInteger(conflictCount) && conflictCount > 0;
      badge.textContent = visible ? String(count) : '';
      badge.hidden = !visible;
      badge.classList.toggle('badge-alert', hasConflicts);
      dot.hidden = !hasConflicts;
      dot.classList.toggle('nav-status-dot-alert', hasConflicts);
    },
    setActiveRoute(route) {
      headerSearch.hidden = route !== 'home' && route !== 'guide';
      headerSearch.classList.remove('is-expanded');
      root.querySelectorAll('[data-route]').forEach(item => {
        const active = item.dataset.route === route;
        item.classList.toggle('is-active', active);
        if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
      });
    }
  };
}
