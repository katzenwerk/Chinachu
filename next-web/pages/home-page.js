import { getUiScalePercent, getUiZoom, setUiScalePercent } from '../services/ui-scale.js';
import { invalidateResources, loadResource } from '../services/api-client.js';
import { appendMobileContextButton } from '../components/mobile-layout.js';
import { createHomeProgramContextMenu } from '../components/home-program-context-menu.js';
import { openRuleEditorDialog, programRuleSeed } from '../components/rule-editor-dialog.js';
import { createRecordedContextMenu } from '../components/recorded-context-menu.js';
import { deleteRecordedFromContext } from '../services/recorded-delete-action.js';
import { ruleAction } from '../services/program-detail-model.js';
import { buildNextReservationTimelineView, nextReservationDisplayBoundaryDelay } from '../services/reservation-model.js';
import { subscribeMatchNotifications, subscribeReservationNotifications } from '../services/realtime-client.js';
import { subscribeStorageData } from '../services/storage-store.js';
import { buildStorageWarnings, buildHomeStorageWarning } from '../services/storage-model.js';
import { mountRecordingList } from '../components/recording-list.js';
import { openProgramDetailDialog } from '../components/program-detail-dialog.js';
import { createChannelLogo } from '../components/channel-logo.js';
import { createProgramHover, setProgramHover } from '../components/program-hover.js';
import { applyStorageWarning } from '../components/storage-warning.js';
import { buildRecentRecordedModels, createRecordedCard } from '../components/recorded-card.js';
import { openRecordedPlaybackOverlay } from '../services/live-player-adapter.js';
import { loadRecordedResultsPage } from '../services/recorded-results-client.js';

const RECENT_RECORDED_FETCH_LIMIT = 50;
const RECENT_RECORDED_DISPLAY_LIMIT = 10;
const HOME_RESERVATION_DISPLAY_LIMIT = 10;
const HOME_RESERVATION_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const HOME_CUSTOM_DEFAULTS = Object.freeze({
  recordingWidth: 350,
  recordedWidth: 245,
  recordedColumns: 2,
  reservationTitleSize: 14
});
const HOME_CUSTOM_RESERVATION_MIN_WIDTH = 280;

// Home layout is a per-browser preference; it does not modify server config or recordings.
const HOME_CUSTOM_STORAGE_KEY = 'chinachu.home.c-settings.v1';

function readHomeCustomSettings() {
  try {
    const settings = JSON.parse(window.localStorage.getItem(HOME_CUSTOM_STORAGE_KEY));
    if (!settings || typeof settings !== 'object') return { ...HOME_CUSTOM_DEFAULTS };
    const result = { ...HOME_CUSTOM_DEFAULTS };
    const allowed = {
      recordingWidth: [210, 350, 5],
      recordedWidth: [170, 310, 5],
      recordedColumns: [2, 4, 1],
      reservationTitleSize: [12, 16, 1]
    };
    for (const [name, [min, max, step]] of Object.entries(allowed)) {
      const value = settings[name];
      if (typeof value === 'number' && Number.isInteger(value)
        && value >= min && value <= max && (value - min) % step === 0) result[name] = value;
    }
    return result;
  } catch (_) {
    return { ...HOME_CUSTOM_DEFAULTS };
  }
}

function saveHomePreference(key, value) {
  try { window.localStorage.setItem(key, value); } catch (_) { /* Private-mode storage may be unavailable. */ }
}

function createHomeHeaderSettings() {
  const details = document.createElement('details');
  details.className = 'home-header-settings';
  details.innerHTML = `
    <summary>⚙ 表示設定</summary>
    <div class="home-header-settings-panel">
      <label class="home-layout-customize-field">
        <span>UI表示倍率 <output data-ui-scale-output>100%</output></span>
        <input type="range" min="70" max="120" step="5" value="100" data-ui-scale aria-label="UI表示倍率">
      </label>
      <div class="home-layout-customizer">
        <div class="home-header-settings-title">ホームの表示調整</div>
        <div class="home-layout-customize-panel">
          <label class="home-layout-customize-field">
            <span>録画中の幅 <output data-custom-output="recordingWidth">350px</output></span>
            <input type="range" min="210" max="350" step="5" value="350" data-custom-setting="recordingWidth">
          </label>
          <label class="home-layout-customize-field">
            <span>録画済み1枚の幅 <output data-custom-output="recordedWidth">245px</output></span>
            <input type="range" min="170" max="310" step="5" value="245" data-custom-setting="recordedWidth">
          </label>
          <label class="home-layout-customize-field">
            <span>録画済みの横並び数</span>
            <select data-custom-setting="recordedColumns">
              <option value="2">2列</option>
              <option value="3">3列</option>
              <option value="4">4列</option>
            </select>
          </label>
          <label class="home-layout-customize-field">
            <span>予約タイトル <output data-custom-output="reservationTitleSize">14px</output></span>
            <input type="range" min="12" max="16" step="1" value="14" data-custom-setting="reservationTitleSize">
          </label>
          <p class="home-layout-customize-status" role="status" hidden></p>
          <button class="button home-layout-customize-reset" type="button">初期値に戻す</button>
        </div>
      </div>
    </div>`;
  const scaleInput = details.querySelector('[data-ui-scale]');
  const scaleOutput = details.querySelector('[data-ui-scale-output]');
  const syncScale = () => {
    scaleInput.value = String(getUiScalePercent());
    scaleOutput.textContent = `${getUiScalePercent()}%`;
  };
  syncScale();
  scaleInput.addEventListener('input', () => {
    scaleOutput.textContent = `${scaleInput.value}%`;
  });
  scaleInput.addEventListener('change', () => {
    setUiScalePercent(Number(scaleInput.value));
    syncScale();
  });
  return details;
}

function createRecordingSection() {
  const panel = document.createElement('section');
  panel.className = 'panel home-recording-panel';
  panel.setAttribute('aria-labelledby', 'home-recording-heading');
  panel.innerHTML = `
    <div class="home-panel-heading">
      <h2 id="home-recording-heading">録画中の番組</h2>
      <a class="home-panel-link" href="#recording">録画中へ</a>
    </div>
    <div class="home-recording-content"><p class="home-section-message">録画情報を取得しています</p></div>`;
  return panel;
}

function mountRecordingSection(container, isActive, onContextMenu) {
  const panel = createRecordingSection();
  const content = panel.querySelector('.home-recording-content');

  container.replaceChildren(panel);
  return mountRecordingList(content, {
    showStorageWarnings: true,
    cardVariant: 'home',
    onContextMenu,
    compactEmpty: true,
    onCountChange(value, status) {
      if (!isActive()) return;
      panel.classList.toggle('is-empty', status === 'ready' && value === 0);
    }
  });
}

function createReservationSection() {
  const panel = document.createElement('section');
  panel.className = 'panel home-reservation-panel';
  panel.setAttribute('aria-labelledby', 'home-reservation-heading');
  panel.innerHTML = `
    <div class="home-panel-heading">
      <h2 id="home-reservation-heading">次の予約</h2>
      <a class="home-panel-link" href="#reserves">予約一覧へ</a>
    </div>
    <div class="home-reservation-content"><p class="home-section-message">予約情報を取得しています</p></div>`;
  return panel;
}

function reservationTimelineRowSignature(model) {
  return JSON.stringify({
    detailUrl: model.detailUrl,
    title: model.timelineTitle,
    hover: model.hover,
    channelLogoUrl: model.channelLogoUrl,
    channelName: model.channelName,
    channelFallbackText: model.channelFallbackText,
    channelTooltip: model.channelTooltip,
    durationText: model.durationText,
    storageNotice: model.storageNotice
  });
}

function sameChildOrder(parent, keys, attribute) {
  const children = Array.from(parent.children);
  return children.length === keys.length
    && children.every((child, index) => child.dataset[attribute] === keys[index]);
}

function createReservationTimelineRenderer() {
  const timeline = document.createElement('div');
  timeline.className = 'home-reservation-timeline';
  const groupStates = new Map();
  const rowStates = new Map();

  function createGroupState(group) {
    const slot = document.createElement('section');
    slot.className = 'home-reservation-timeline-slot';
    slot.dataset.groupKey = group.key;
    const date = document.createElement('div');
    date.className = 'home-reservation-timeline-date';
    const time = document.createElement('time');
    time.className = 'home-reservation-timeline-time';
    const point = document.createElement('span');
    point.className = 'home-reservation-timeline-point';
    point.setAttribute('aria-hidden', 'true');
    const inlineDate = document.createElement('span');
    inlineDate.className = 'home-reservation-timeline-inline-date';
    const clock = document.createElement('span');
    clock.className = 'home-reservation-timeline-clock';
    time.append(point, inlineDate, clock);
    const separator = document.createElement('span');
    separator.className = 'home-reservation-timeline-separator';
    separator.setAttribute('aria-hidden', 'true');
    const track = document.createElement('span');
    track.className = 'home-reservation-timeline-track';
    track.setAttribute('aria-hidden', 'true');
    const items = document.createElement('div');
    items.className = 'home-reservation-timeline-items';
    slot.append(date, time, separator, track, items);
    return { element: slot, date, time, inlineDate, clock, items };
  }

  function createRowState(model) {
    const row = document.createElement('div');
    row.className = 'home-reservation-timeline-row';
    row.dataset.reservationKey = model.key;
    const channelLogo = createChannelLogo({}, { variant: 'list', focusable: true });
    const title = document.createElement(model.detailUrl === null ? 'span' : 'a');
    title.className = 'home-reservation-timeline-title';
    const meta = document.createElement('span');
    meta.className = 'home-reservation-timeline-meta';
    const warning = document.createElement('span');
    warning.className = 'home-reservation-timeline-warning storage-warning is-align-right';
    warning.hidden = true;
    warning.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-alert"></use></svg><span class="storage-warning-text" hidden></span><span class="storage-warning-tip" role="tooltip"></span>';
    const duration = document.createElement('span');
    duration.className = 'home-reservation-timeline-duration';
    meta.append(warning, duration);
    row.append(channelLogo.element, title, meta);
    appendMobileContextButton(row);
    return { element: row, channelLogo, title, warning, duration, signature: null };
  }

  function updateRowState(state, model) {
    const signature = reservationTimelineRowSignature(model);
    if (signature === state.signature) return;

    const needsLink = model.detailUrl !== null;
    if ((state.title.tagName === 'A') !== needsLink) {
      const replacement = document.createElement(needsLink ? 'a' : 'span');
      replacement.className = 'home-reservation-timeline-title';
      state.title.replaceWith(replacement);
      state.title = replacement;
    }
    if (state.title.textContent !== model.timelineTitle) state.title.textContent = model.timelineTitle;
    setProgramHover(state.title, model.hover);
    if (needsLink && state.title.getAttribute('href') !== model.detailUrl) state.title.href = model.detailUrl;
    state.channelLogo.update({
      url: model.channelLogoUrl,
      name: model.channelName,
      fallbackText: model.channelFallbackText,
      tooltip: model.channelTooltip
    });
    applyStorageWarning(state.warning, model.storageNotice);
    const durationText = model.durationText || '';
    if (state.duration.textContent !== durationText) state.duration.textContent = durationText;
    state.signature = signature;
  }

  function render(groups) {
    const activeElement = document.activeElement;
    const activeRow = activeElement?.closest?.('.home-reservation-timeline-row') || null;
    const activeReservationKey = activeRow?.dataset.reservationKey || null;
    const activeRowKeys = new Set();
    const activeGroupKeys = new Set();
    const orderedGroupStates = [];
    let previousDateKey = null;

    groups.forEach(group => {
      let groupState = groupStates.get(group.key);
      if (!groupState) {
        groupState = createGroupState(group);
        groupStates.set(group.key, groupState);
      }
      activeGroupKeys.add(group.key);
      orderedGroupStates.push(groupState);

      const showDate = group.dateKey !== previousDateKey;
      if (groupState.date.hidden === showDate) groupState.date.hidden = !showDate;
      if (groupState.date.textContent !== group.dateText) groupState.date.textContent = group.dateText;
      if (groupState.inlineDate.hidden === showDate) groupState.inlineDate.hidden = !showDate;
      if (groupState.inlineDate.textContent !== group.dateText) groupState.inlineDate.textContent = group.dateText;
      groupState.element.classList.toggle('is-first-of-date', showDate);
      groupState.element.classList.toggle('has-multiple', group.items.length > 1);
      const dateTime = new Date(group.start).toISOString();
      if (groupState.time.dateTime !== dateTime) groupState.time.dateTime = dateTime;
      if (groupState.clock.textContent !== group.timeText) groupState.clock.textContent = group.timeText;

      const orderedRows = group.items.map(model => {
        let rowState = rowStates.get(model.key);
        if (!rowState) {
          rowState = createRowState(model);
          rowStates.set(model.key, rowState);
        }
        activeRowKeys.add(model.key);
        updateRowState(rowState, model);
        return rowState.element;
      });
      const rowKeys = group.items.map(model => model.key);
      if (!sameChildOrder(groupState.items, rowKeys, 'reservationKey')) {
        groupState.items.append(...orderedRows);
      }
      previousDateKey = group.dateKey;
    });

    rowStates.forEach((state, key) => {
      if (activeRowKeys.has(key)) return;
      state.channelLogo.dispose();
      state.element.remove();
      rowStates.delete(key);
    });
    groupStates.forEach((state, key) => {
      if (activeGroupKeys.has(key)) return;
      state.element.remove();
      groupStates.delete(key);
    });

    const groupKeys = groups.map(group => group.key);
    if (!sameChildOrder(timeline, groupKeys, 'groupKey')) {
      timeline.append(...orderedGroupStates.map(state => state.element));
    }

    if (activeReservationKey !== null && activeElement?.isConnected && document.activeElement !== activeElement) {
      activeElement.focus({ preventScroll: true });
    }
  }

  function dispose() {
    rowStates.forEach(state => state.channelLogo.dispose());
    rowStates.clear();
    groupStates.clear();
  }

  return { element: timeline, render, dispose };
}

function mountReservationSection(container, isActive, onContextMenu) {
  const panel = createReservationSection();
  const content = panel.querySelector('.home-reservation-content');
  const programHover = createProgramHover(content);
  let latestPrograms = [];
  let storageData = null;
  let disposed = false;
  let refreshPromise = null;
  let refreshQueued = false;
  let forceQueued = false;
  let displayBoundaryTimer = null;
  const timelineRenderer = createReservationTimelineRenderer();
  let hasReservationSnapshot = false;

  timelineRenderer.element.addEventListener('click', event => {
    const link = event.target.closest?.('a[href*="#program?"]');
    if (!link || event.defaultPrevented) return;
    event.preventDefault();
    const query = new URLSearchParams(link.href.split('?')[1] || '');
    openProgramDetailDialog({ id: query.get('id'), onChanged: () => requestRefresh(true) });
  });

  container.replaceChildren(panel);
  const openContext = event => {
    const row = event.target.closest?.('.home-reservation-timeline-row[data-reservation-key]');
    if (!row || !content.contains(row)) return;
    const program = latestPrograms.find(value => value?.id && value.id === row.dataset.reservationKey);
    if (!program) return;
    event.preventDefault();
    const rect = row.getBoundingClientRect();
    onContextMenu?.({ kind: 'reservation', id: program.id, title: program.title || program.fullTitle || '', program },
      event.type === 'contextmenu' ? { x: event.clientX, y: event.clientY } : { x: rect.left + 16, y: rect.top + 16 }, requestRefresh);
  };
  const keyboardContext = event => {
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) openContext(event);
  };
  content.addEventListener('contextmenu', openContext);
  content.addEventListener('keydown', keyboardContext);

  function renderPrograms(programs) {
    hasReservationSnapshot = true;
    panel.querySelector('[data-refresh-error]')?.remove();
    latestPrograms = programs;
    const now = Date.now();
    const options = {
      storageData,
      windowMs: HOME_RESERVATION_WINDOW_MS,
      maxItems: HOME_RESERVATION_DISPLAY_LIMIT
    };
    const timelineView = buildNextReservationTimelineView(programs, now, {
      ...options,
      maxGroups: HOME_RESERVATION_DISPLAY_LIMIT
    });
    // Timeline groups can contain multiple programs with the same start time.
    // Cap the program rows rather than the number of start-time groups.
    let remaining = HOME_RESERVATION_DISPLAY_LIMIT;
    const visibleGroups = [];
    for (const group of timelineView.groups) {
      if (remaining === 0) break;
      const items = group.items.slice(0, remaining);
      if (items.length === 0) continue;
      visibleGroups.push({ ...group, items });
      remaining -= items.length;
    }
    timelineRenderer.render(visibleGroups);
    if (visibleGroups.length === 0) {
      if (content.firstElementChild?.textContent !== '今後の予約はありません') content.innerHTML = '<p class="home-section-message">今後の予約はありません</p>';
      return;
    }
    if (timelineRenderer.element.parentElement !== content) content.replaceChildren(timelineRenderer.element);
  }

  function scheduleDisplayBoundary() {
    window.clearTimeout(displayBoundaryTimer);
    const delay = nextReservationDisplayBoundaryDelay(latestPrograms);
    if (delay === null) return;
    displayBoundaryTimer = window.setTimeout(() => {
      if (disposed || !isActive()) return;
      renderPrograms(latestPrograms);
      scheduleDisplayBoundary();
    }, Math.min(delay, 2147483647));
  }

  function renderError(error) {
    if (hasReservationSnapshot) {
      const notice = panel.querySelector('[data-refresh-error]') || document.createElement('p');
      notice.dataset.refreshError = '';
      notice.setAttribute('role', 'status');
      notice.textContent = `予約情報を更新できませんでした（前回の表示を保持）: ${error.message || error}`;
      if (!notice.isConnected) panel.append(notice);
      return;
    }
    latestPrograms = [];
    window.clearTimeout(displayBoundaryTimer);
    const message = document.createElement('div');
    message.className = 'reservation-list-error';
    message.innerHTML = '<p>予約情報を取得できませんでした</p><small></small><button class="button" type="button">再試行</button>';
    message.querySelector('small').textContent = String(error.message || error);
    message.querySelector('button').addEventListener('click', () => requestRefresh(true), { once: true });
    content.replaceChildren(message);
  }

  function requestRefresh(force = false) {
    if (disposed || !isActive()) return Promise.resolve();
    refreshQueued = true;
    forceQueued = forceQueued || force;
    if (refreshPromise !== null) return refreshPromise;
    refreshPromise = (async () => {
      while (refreshQueued && !disposed && isActive()) {
        const shouldForce = forceQueued;
        refreshQueued = false;
        forceQueued = false;
        if (shouldForce) invalidateResources(['reserves']);
        try {
          const programs = await loadResource('reserves');
          if (!Array.isArray(programs)) throw new Error('Reserves API response is invalid');
          if (!disposed && isActive()) {
            renderPrograms(programs);
            scheduleDisplayBoundary();
          }
        } catch (error) {
          if (!disposed && isActive()) renderError(error);
        }
      }
    })().finally(() => {
      refreshPromise = null;
      if (refreshQueued && !disposed && isActive()) requestRefresh();
    });
    return refreshPromise;
  }

  const unsubscribe = subscribeReservationNotifications(() => requestRefresh(true));
  const unsubscribeStorage = subscribeStorageData(state => {
    if (disposed || !isActive() || state.data === null) return;
    storageData = state.data;
    if (latestPrograms.length !== 0) renderPrograms(latestPrograms);
  });
  const timer = window.setInterval(() => {
    if (!disposed && isActive() && latestPrograms.length !== 0) renderPrograms(latestPrograms);
  }, 60000);
  requestRefresh();

  return () => {
    disposed = true;
    unsubscribe();
    unsubscribeStorage();
    content.removeEventListener('contextmenu', openContext);
    content.removeEventListener('keydown', keyboardContext);
    window.clearInterval(timer);
    window.clearTimeout(displayBoundaryTimer);
    timelineRenderer.dispose();
    programHover.dispose();
  };
}

function createRecentRecordedSection() {
  const panel = document.createElement('section');
  panel.className = 'panel home-recorded-panel';
  panel.setAttribute('aria-labelledby', 'home-recorded-heading');
  panel.innerHTML = `
    <div class="home-panel-heading">
      <h2 id="home-recorded-heading">最近の録画結果</h2>
      <a class="home-panel-link" href="#recorded">録画結果へ</a>
    </div>
    <div class="home-recorded-content"><p class="home-section-message">録画結果を取得しています</p></div>`;
  return panel;
}

function mountRecentRecordedSection(container, isActive, onContextMenu) {
  const panel = createRecentRecordedSection();
  const content = panel.querySelector('.home-recorded-content');
  const grid = document.createElement('div');
  grid.className = 'recorded-recent-grid';
  const cards = new Map();
  let contextItems = new Map();
  let disposed = false;
  let refreshPromise = null;
  let refreshQueued = false;
  let requestController = null;

  container.replaceChildren(panel);

  function clearCards() {
    cards.forEach(card => card.dispose());
    cards.clear();
    grid.replaceChildren();
  }

  function renderItems(items) {
    panel.querySelector('[data-refresh-error]')?.remove();
    const models = buildRecentRecordedModels(items, RECENT_RECORDED_DISPLAY_LIMIT);
    contextItems = new Map(items.filter(item => typeof item?.key === 'string').map(item => [item.key, item]));
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
            openProgramDetailDialog({
              key: query.get('key'),
              id: query.get('id'),
              onChanged: requestRefresh
            });
          }
        });
        cards.set(model.key, card);
      } else {
        card.update(model);
      }
      return card.element;
    });
    const currentKeys = Array.from(grid.children).map(card => card.dataset.recordedKey);
    const orderChanged = currentKeys.length !== models.length ||
      currentKeys.some((key, index) => key !== models[index].key);
    if (orderChanged) {
      let cursor = grid.firstChild;
      for (const element of elements) {
        if (element === cursor) cursor = cursor.nextSibling;
        else grid.insertBefore(element, cursor);
      }
    }
    if (models.length === 0) {
      if (content.firstElementChild?.textContent !== '再生可能な録画結果はありません') content.innerHTML = '<p class="home-section-message">再生可能な録画結果はありません</p>';
    } else if (!grid.isConnected) {
      content.replaceChildren(grid);
    }
  }

  function renderError(error) {
    if (grid.isConnected) {
      const notice = panel.querySelector('[data-refresh-error]') || document.createElement('p');
      notice.dataset.refreshError = '';
      notice.setAttribute('role', 'status');
      notice.textContent = `録画結果を更新できませんでした（前回の表示を保持）: ${error.message || error}`;
      if (!notice.isConnected) panel.append(notice);
      return;
    }
    const message = document.createElement('div');
    message.className = 'recording-list-error';
    message.innerHTML = '<p>録画結果を取得できませんでした</p><small></small><button class="button" type="button">再試行</button>';
    message.querySelector('small').textContent = String(error?.message || error);
    message.querySelector('button').addEventListener('click', requestRefresh, { once: true });
    content.replaceChildren(message);
  }

  function requestRefresh() {
    if (disposed || !isActive()) return Promise.resolve();
    refreshQueued = true;
    if (refreshPromise !== null) return refreshPromise;
    refreshPromise = (async () => {
      while (refreshQueued && !disposed && isActive()) {
        refreshQueued = false;
        const controller = new AbortController();
        requestController = controller;
        try {
          const result = await loadRecordedResultsPage({
            page: 1,
            limit: RECENT_RECORDED_FETCH_LIMIT,
            results: ['recorded', 'deleted'],
            signal: controller.signal
          });
          if (!disposed && isActive() && requestController === controller) renderItems(result.items);
        } catch (error) {
          if (!disposed && isActive() && error?.name !== 'AbortError') renderError(error);
        } finally {
          if (requestController === controller) requestController = null;
        }
      }
    })().finally(() => {
      refreshPromise = null;
      if (refreshQueued && !disposed && isActive()) requestRefresh();
    });
    return refreshPromise;
  }

  const openContext = event => {
    const card = event.target.closest?.('.recorded-card[data-recorded-key]');
    if (!card || !content.contains(card)) return;
    const item = contextItems.get(card.dataset.recordedKey);
    if (!item) return;
    event.preventDefault();
    const rect = card.getBoundingClientRect();
    const point = event.type === 'contextmenu'
      ? { x: event.clientX, y: event.clientY }
      : { x: rect.left + 16, y: rect.top + 16 };
    onContextMenu?.(item, point, requestRefresh);
  };
  const keyboardContext = event => {
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) openContext(event);
  };
  content.addEventListener('contextmenu', openContext);
  content.addEventListener('keydown', keyboardContext);

  const unsubscribe = subscribeMatchNotifications(requestRefresh);
  requestRefresh();

  return () => {
    disposed = true;
    requestController?.abort();
    unsubscribe();
    content.removeEventListener('contextmenu', openContext);
    content.removeEventListener('keydown', keyboardContext);
    clearCards();
  };
}

export function createHomeStorageWarningRenderer(host) {
  let card = null, heading, list, link, remaining, signature = null;
  const rows = new Map();
  return model => {
    const next = JSON.stringify(model);
    if (signature === next) return;
    signature = next;
    if (!model) { host.replaceChildren(); card = null; rows.clear(); return; }
    if (!card) {
      card = document.createElement('section'); card.setAttribute('role', 'status');
      const header = document.createElement('div'); header.className = 'home-storage-capacity-heading';
      const icon = document.createElement('span'); icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = '<svg class="icon"><use href="#icon-alert"></use></svg>';
      heading = document.createElement('h2'); header.append(icon, heading);
      list = document.createElement('div');
      link = document.createElement('a'); link.className = 'home-storage-capacity-link';
      remaining = document.createElement('p'); remaining.className = 'home-storage-capacity-remaining';
      header.append(link); card.append(header, list, remaining); host.append(card);
    }
    card.className = 'panel home-storage-capacity-card is-' + model.level;
    heading.textContent = model.title;
    const wanted = new Set(model.entries.map(entry => entry.id));
    for (const [id, row] of rows) if (!wanted.has(id)) { row.root.remove(); rows.delete(id); }
    let cursor = list.firstChild;
    for (const item of model.entries) {
      let row = rows.get(item.id);
      if (!row) {
        const root = document.createElement('div');
        const info = document.createElement('div'); info.className = 'home-storage-capacity-info';
        const name = document.createElement('strong'), free = document.createElement('span');
        const gauge = document.createElement('meter'); gauge.min = 0; gauge.max = 100;
        const note = document.createElement('p');
        info.append(name, free); root.append(info, gauge, note); list.append(root);
        row = { root, name, free, gauge, note }; rows.set(item.id, row);
      }
      row.root.className = 'home-storage-capacity-row is-' + item.level;
      row.name.textContent = item.name; row.name.title = item.name;
      row.free.textContent = '空き ' + item.free;
      row.gauge.hidden = item.usagePercent === null;
      if (item.usagePercent !== null) {
        row.gauge.value = Number(item.usagePercent);
        row.gauge.setAttribute('aria-label', `${item.name} 使用率 ${item.usagePercent}%`);
        row.gauge.title = `使用率 ${item.usagePercent}%`;
      }
      const note = item.note?.startsWith('参考値') ? '' : item.note;
      row.note.textContent = note || ''; row.note.hidden = !note;
      if (row.root === cursor) cursor = cursor.nextSibling;
      else list.insertBefore(row.root, cursor);
    }
    link.href = model.href;
    link.textContent = 'ストレージを確認';
    remaining.textContent = model.remaining ? `ほか${model.remaining}件` : '';
    remaining.hidden = !model.remaining;
  };
}

export function renderHomePage(container, options = {}) {
  let active = true;
  const page = document.createElement('div');
  const storageSafetyHost = document.createElement('div');
  const recordingHost = document.createElement('div');
  const reservationHost = document.createElement('div');
  const recordedHost = document.createElement('div');
  page.className = 'home-page is-layout-c';
  storageSafetyHost.className = 'home-storage-safety-host';
  recordingHost.className = 'home-recording-host';
  const reservationColumn = document.createElement('div');
  reservationColumn.className = 'home-reservation-host';
  const capacityHost = document.createElement('div');
  capacityHost.className = 'home-storage-capacity-host';
  reservationColumn.append(capacityHost, reservationHost);
  const updateCapacityWarning = createHomeStorageWarningRenderer(capacityHost);
  recordedHost.className = 'home-recorded-host';
  page.append(storageSafetyHost, recordingHost, reservationColumn, recordedHost);
  container.replaceChildren(page);

  const headerSettings = createHomeHeaderSettings();
  options.setHeaderActions?.(headerSettings);

  const isActive = () => active && page.isConnected;
  const preferredRuleUids = new Map();
  let ruleDialog = null;
  const showActionError = error => window.alert(`操作できませんでした: ${String(error?.message || error)}`);

  function openDetail(id, key = null, initialAction = null, onChanged = null) {
    if (!id && !key) return;
    openProgramDetailDialog({ id, key, initialAction, onChanged });
  }

  function resolveHomeRule(item, context) {
    // 番組名の曖昧一致や旧ruleIdの配列位置を、編集対象の決定に使わない。
    const rules = context.detail.rules;
    const program = item.program || {};
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

  function openHomeRuleEditor(item) {
    const action = item.ruleAction;
    if (!['create', 'edit'].includes(action?.mode) || ruleDialog?.open) return;
    const program = item.program || {};
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
        await item.refresh?.(true);
      },
      onDeleted: async () => {
        preferredRuleUids.delete(item.id);
        invalidateResources(['rules']);
        await item.refresh?.(true);
      },
      onClose: () => { if (ruleDialog === editor) ruleDialog = null; }
    });
    ruleDialog = editor;
  }

  async function copyTitle(title) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(title);
    const input = document.createElement('textarea');
    input.value = title;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    if (!copied) throw new Error('クリップボードへのコピーに失敗しました');
  }

  function searchWeb(action, title) {
    if (!title) return;
    const url = action === 'search-google'
      ? `https://www.google.com/search?q=${encodeURIComponent(title)}`
      : `https://ja.wikipedia.org/wiki/${encodeURIComponent(title)}`;
    window.open(url, '_blank', 'noopener');
  }

  const homeProgramMenu = createHomeProgramContextMenu({
    resolveRule: resolveHomeRule,
    onAction(action, item) {
      if (!isActive()) return;
      if (action === 'copy-title') return void copyTitle(item.title).catch(showActionError);
      if (action === 'search-google' || action === 'search-wikipedia') return searchWeb(action, item.title);
      if (action === 'rule') {
        if (item.ruleAction?.mode === 'unavailable') return openDetail(item.id, null, null, item.refresh);
        return openHomeRuleEditor(item);
      }
    }
  });

  const recentRecordedMenu = createRecordedContextMenu({
    onAction(action, item) {
      if (!isActive()) return;
      if (action.startsWith('filter-')) {
        const params = new URLSearchParams();
        if (action === 'filter-title') params.set('search', String(item.title || item.fullTitle || ''));
        if (action === 'filter-channel' && item.channel?.id) params.set('channelId', item.channel.id);
        if (action === 'filter-rule' && item.ruleUid) params.set('ruleUid', item.ruleUid);
        const query = params.toString();
        location.hash = `#recorded${query ? '?' + query : ''}`;
        return;
      }
      if (action === 'copy-title') {
        return void copyTitle(String(item.fullTitle || item.title || '').trim()).catch(showActionError);
      }
      if (action === 'search-google' || action === 'search-wikipedia') {
        return searchWeb(action, String(item.title || item.fullTitle || ''));
      }
      if (action === 'detail' || action === 'rule') {
        return openDetail(item.recordedId || null, item.key || null,
          action === 'rule' ? action : null, item.refresh);
      }
      if (action === 'delete') {
        void deleteRecordedFromContext({ key: item.key, recordedId: item.recordedId })
          .then(async result => {
            if (!result) return;
            await item.refresh?.();
            if (result.storageRefreshError) {
              window.alert(`録画ファイルは削除しましたが、容量表示の更新に失敗しました: ${result.storageRefreshError}`);
            }
          })
          .catch(showActionError);
        return;
      }
      if (action === 'play') {
        return void openRecordedPlaybackOverlay({
          playable: true, recordedId: item.recordedId,
          title: item.fullTitle || item.title || 'タイトル未取得'
        }).catch(showActionError);
      }
      if (action === 'download') {
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

  function openHomeContext(item, point, refresh = null) {
    if (!isActive()) return;
    recentRecordedMenu.close();
    homeProgramMenu.open({ ...item, refresh }, point);
  }
  function openRecentContext(item, point, refresh) {
    if (!isActive()) return;
    homeProgramMenu.close();
    recentRecordedMenu.open({ ...item, refresh }, point);
  }
  const disposeRecording = mountRecordingSection(recordingHost, isActive, ({ model, program }, point) =>
    openHomeContext({ kind: 'recording', id: model.id, title: model.title, model, program }, point));
  const disposeReservations = mountReservationSection(reservationHost, isActive, openHomeContext);
  const disposeRecorded = mountRecentRecordedSection(recordedHost, isActive, openRecentContext);
  const unsubscribeStorageSafety = subscribeStorageData(state => {
    if (!active || !page.isConnected || state.data === null) return;
    updateCapacityWarning(buildHomeStorageWarning(state.data, state.status === 'error'));
    const issues = buildStorageWarnings(state.data).filter(issue =>
      issue.code === 'system-filesystem' || issue.code === 'storage-safety-unknown'
    );
    if (issues.length === 0) {
      storageSafetyHost.replaceChildren();
      return;
    }
    const alert = document.createElement('section');
    alert.className = 'home-storage-safety-alert';
    alert.setAttribute('role', 'alert');
    const body = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = '録画先エラー：録画を禁止しています';
    const list = document.createElement('ul');
    issues.forEach(issue => {
      const item = document.createElement('li');
      const target = issue.path ? `${issue.name}（${issue.path}）` : issue.name;
      item.textContent = `${target}：${issue.detail}`;
      list.append(item);
    });
    const link = document.createElement('a');
    link.href = '#storage';
    link.textContent = 'Storageを確認';
    body.append(title, list);
    alert.append(body, link);
    storageSafetyHost.replaceChildren(alert);
  });
  const customizeStatus = headerSettings.querySelector('.home-layout-customize-status');
  const customizeReset = headerSettings.querySelector('.home-layout-customize-reset');
  const customInputs = Array.from(headerSettings.querySelectorAll('[data-custom-setting]'));
  let customSettings = readHomeCustomSettings();
  let observedLayoutWidth = page.clientWidth;

  function customLayoutMetrics(settings) {
    const recordingPanel = page.querySelector('.home-recording-panel');
    const recordingContent = page.querySelector('.home-recording-content');
    const recordedPanel = page.querySelector('.home-recorded-panel');
    const recordedContent = page.querySelector('.home-recorded-content');
    const recordedGrid = page.querySelector('.recorded-recent-grid');
    const pageStyle = window.getComputedStyle(page);
    const pageGap = Number.parseFloat(pageStyle.columnGap) || 0;
    const recordingChrome = recordingPanel && recordingContent
      ? Math.max(0, (recordingPanel.getBoundingClientRect().width - recordingContent.getBoundingClientRect().width) / getUiZoom())
      : 30;
    const recordedChrome = recordedPanel && recordedContent
      ? Math.max(0, (recordedPanel.getBoundingClientRect().width - recordedContent.getBoundingClientRect().width) / getUiZoom())
      : 30;
    const cardGap = recordedGrid
      ? Number.parseFloat(window.getComputedStyle(recordedGrid).columnGap) || 0
      : pageGap;
    const recordingHostWidth = settings.recordingWidth + recordingChrome;
    const recordedHostWidth = settings.recordedWidth * settings.recordedColumns
      + cardGap * (settings.recordedColumns - 1) + recordedChrome;
    const requiredWidth = HOME_CUSTOM_RESERVATION_MIN_WIDTH + recordingHostWidth
      + recordedHostWidth + pageGap * 2;
    return {
      availableWidth: page.clientWidth,
      requiredWidth,
      recordingHostWidth,
      recordedHostWidth
    };
  }

  function syncCustomControls() {
    customInputs.forEach(input => {
      input.value = String(customSettings[input.dataset.customSetting]);
    });
    headerSettings.querySelector('[data-custom-output="recordingWidth"]').textContent = `${customSettings.recordingWidth}px`;
    headerSettings.querySelector('[data-custom-output="recordedWidth"]').textContent = `${customSettings.recordedWidth}px`;
    headerSettings.querySelector('[data-custom-output="reservationTitleSize"]').textContent = `${customSettings.reservationTitleSize}px`;
  }

  function showCustomStatus(message = '') {
    customizeStatus.hidden = message === '';
    customizeStatus.textContent = message;
  }

  function applyCustomSettings(nextSettings, { allowResponsiveFallback = false } = {}) {
    const metrics = customLayoutMetrics(nextSettings);
    const fits = metrics.requiredWidth <= metrics.availableWidth;
    if (!fits && !allowResponsiveFallback) {
      showCustomStatus(`この組み合わせには約${Math.ceil(metrics.requiredWidth)}px必要です（現在${Math.floor(metrics.availableWidth)}px）。値は変更していません。`);
      syncCustomControls();
      return false;
    }

    customSettings = { ...nextSettings };
    page.style.setProperty('--home-c-recording-card-width', `${customSettings.recordingWidth}px`);
    page.style.setProperty('--home-c-recorded-card-width', `${customSettings.recordedWidth}px`);
    page.style.setProperty('--home-c-recorded-columns', String(customSettings.recordedColumns));
    page.style.setProperty('--home-c-reservation-title-size', `${customSettings.reservationTitleSize}px`);
    page.style.setProperty('--home-c-recording-host-width', `${metrics.recordingHostWidth}px`);
    page.style.setProperty('--home-c-recorded-host-width', `${metrics.recordedHostWidth}px`);
    page.classList.toggle('is-custom-narrow', !fits);
    showCustomStatus(fits
      ? ''
      : `現在の表示幅では必要な約${Math.ceil(metrics.requiredWidth)}pxを確保できないため、安全な縦配置で表示しています。`);
    syncCustomControls();
    return true;
  }

  customInputs.forEach(input => {
    input.addEventListener('input', () => {
      const nextSettings = {
        ...customSettings,
        [input.dataset.customSetting]: Number(input.value)
      };
      if (applyCustomSettings(nextSettings, {
        allowResponsiveFallback: page.classList.contains('is-custom-narrow')
      })) saveHomePreference(HOME_CUSTOM_STORAGE_KEY, JSON.stringify(customSettings));
    });
  });
  customizeReset.addEventListener('click', () => {
    if (applyCustomSettings({ ...HOME_CUSTOM_DEFAULTS }, { allowResponsiveFallback: true })) {
      saveHomePreference(HOME_CUSTOM_STORAGE_KEY, JSON.stringify(customSettings));
    }
  });
  const handleOutsidePointer = event => {
    if (headerSettings.open && !headerSettings.contains(event.target)) headerSettings.open = false;
  };
  const handleEscape = event => {
    if (event.key === 'Escape' && headerSettings.open) {
      headerSettings.open = false;
      headerSettings.querySelector('summary').focus();
    }
  };
  document.addEventListener('pointerdown', handleOutsidePointer);
  document.addEventListener('keydown', handleEscape);
  // Root zoom can change measured panel borders without changing the page's CSS width.
  const handleLayoutResize = () => applyCustomSettings(customSettings, { allowResponsiveFallback: true });
  window.addEventListener('resize', handleLayoutResize);
  const layoutResizeObserver = new ResizeObserver(entries => {
    const nextWidth = Math.round(entries[0]?.contentRect.width || page.clientWidth);
    if (nextWidth === observedLayoutWidth) return;
    observedLayoutWidth = nextWidth;
    applyCustomSettings(customSettings, { allowResponsiveFallback: true });
  });
  layoutResizeObserver.observe(page);
  applyCustomSettings(customSettings, { allowResponsiveFallback: true });

  return () => {
    active = false;
    document.removeEventListener('pointerdown', handleOutsidePointer);
    document.removeEventListener('keydown', handleEscape);
    window.removeEventListener('resize', handleLayoutResize);
    layoutResizeObserver.disconnect();
    headerSettings.remove();
    disposeRecording();
    disposeReservations();
    disposeRecorded();
    homeProgramMenu.destroy();
    recentRecordedMenu.destroy();
    ruleDialog?.close();
    unsubscribeStorageSafety();
  };
}
