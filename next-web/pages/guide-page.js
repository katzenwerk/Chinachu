import { getUiZoom } from '../services/ui-scale.js';
import { createProgramHover, programHoverInfo, setProgramHover } from '../components/program-hover.js';
import { createChannelLogo } from '../components/channel-logo.js';
import { createMonthCalendar } from '../components/month-calendar.js';
import { createHomeProgramContextMenu } from '../components/home-program-context-menu.js';
import { headerCompactMedia as createHeaderCompactMedia } from '../components/mobile-layout.js';
import { invalidateResources, loadResource } from '../services/api-client.js';
import { openProgramDetailDialog } from '../components/program-detail-dialog.js';
import { openRuleEditorDialog, programRuleSeed } from '../components/rule-editor-dialog.js';
import { closeActiveLiveOverlay } from '../services/live-player-adapter.js';
import { copyProgramTitle, programActionTitle, programSearchUrl } from '../services/program-actions.js';
import { channelDetailText } from '../services/recording-model.js';
import { programDetailUrl } from '../services/program-detail-client.js';
import { CONFLICT_DESCRIPTION, ruleAction } from '../services/program-detail-model.js';
import {
  loadTimetableData, loadWuiConfig, refreshTimetableData, saveTimetableConfig
} from '../services/timetable-client.js';
import {
  subscribeRecordingNotifications, subscribeReservationNotifications, subscribeScheduleNotifications
} from '../services/realtime-client.js';
import {
  broadcastDayStart, dayStartFromInput, guideDisplayRange,
  programContentLayout, programFlagPresentation, programPosition, programState, programTitlePresentation,
  TIMETABLE_DEFAULTS, TIMETABLE_LIMITS
} from '../services/timetable-model.js';

const DAY_MS = 86400000;
const AXIS_WIDTH = 48;
const HEADER_HEIGHT = 36;
const TYPES = ['GR', 'BS', 'CS', 'SKY'];
const HIDDEN_CHANNELS_STORAGE_KEY = 'chinachu.next.guide.hiddenChannels.v1';

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(timestamp));
}

function programFlagsHtml(flags) {
  const seen = new Set();
  return (flags || []).map(programFlagPresentation).filter(flag => {
    if (!flag || seen.has(flag.label)) return false;
    seen.add(flag.label);
    return true;
  }).map(flag => `<span class="guide-program-flag is-${flag.tone}">${escapeHtml(flag.label)}</span>`).join('');
}

function logoUrl(channel) {
  return channel?.hasLogoData === true && text(channel.id) ? `/api/channel/${encodeURIComponent(channel.id)}/logo.png` : null;
}

function loadHiddenChannelIds() {
  try {
    const value = JSON.parse(window.localStorage.getItem(HIDDEN_CHANNELS_STORAGE_KEY) || '[]');
    return new Set(Array.isArray(value) ? value.filter(item => typeof item === 'string' && item !== '') : []);
  } catch {
    return new Set();
  }
}

function saveHiddenChannelIds(values) {
  window.localStorage.setItem(HIDDEN_CHANNELS_STORAGE_KEY, JSON.stringify([...values]));
}

function openRuleDialog(program, onSaved, onDeleted, action) {
  return openRuleEditorDialog({
    row: action.mode === 'edit' ? { index: action.index, uid: action.ruleUid, rule: action.rule } : null,
    initialRule: action.mode === 'create' ? programRuleSeed({
      title: program.title || program.fullTitle,
      type: program.channel?.type,
      channel: program.channel?.id,
      category: program.category
    }) : null,
    title: action.mode === 'edit' ? `ルール #${action.index + 1} を編集` : 'ルールを作成',
    onSaved,
    onDeleted
  });
}

function ruleProgram(program, reserves) {
  const candidates = (Array.isArray(reserves) ? reserves : []).filter(reserve => {
    if (text(reserve?.id) && text(program?.id) && reserve.id === program.id) return true;
    return text(reserve?.channel?.id) && reserve.channel.id === program?.channel?.id &&
      Number(reserve.start) === Number(program.start) && Number(reserve.seconds) === Number(program.seconds);
  });
  if (candidates.length > 1) return null;
  const reserve = candidates[0];
  if (!reserve) return program;
  return {
    ...program,
    ruleUid: text(reserve.ruleUid) || text(reserve.reservationMeta?.ruleUid),
    ruleId: reserve.ruleId ?? reserve.reservationMeta?.ruleId,
    isManualReserved: reserve.isManualReserved === true || reserve.reservationMeta?.isManualReserved === true
  };
}

let activeGuideMenu = null;

function closeGuideProgramMenu() {
  activeGuideMenu?.destroy();
  activeGuideMenu = null;
}

export function createGuideProgramMenu({ program, x, y, resolveRule, onRule, onChanged }) {
  closeGuideProgramMenu();
  const menu = createHomeProgramContextMenu({
    resolveRule: (item, context) => resolveRule(context),
    onAction(action, item) {
      if (action === 'rule') return onRule(item.ruleAction);
      if (action === 'copy-title') return void copyProgramTitle(item.title).catch(error => window.alert(String(error?.message || error)));
      if (action === 'search-google' || action === 'search-wikipedia') {
        window.open(programSearchUrl(action === 'search-google' ? 'google' : 'wikipedia', item.title), '_blank', 'noopener');
      }
    }
  });
  activeGuideMenu = menu;
  menu.open({ id: program.id, title: programActionTitle(program), program, refresh: onChanged }, { x, y });
  return {
    dataset: menu.element.dataset,
    contains: target => menu.element.contains(target),
    remove() {
      menu.destroy();
      if (activeGuideMenu === menu) activeGuideMenu = null;
    }
  };
}

function enableMouseDragScroll(scroll) {
  const threshold = 6;
  let pointerId = null;
  let originX = 0;
  let originY = 0;
  let originLeft = 0;
  let originTop = 0;
  let dragging = false;
  let suppressClick = false;

  const reset = event => {
    if (pointerId === null || (event?.pointerId !== undefined && event.pointerId !== pointerId)) return;
    if (dragging) {
      suppressClick = true;
      window.setTimeout(() => { suppressClick = false; }, 0);
    }
    pointerId = null;
    dragging = false;
    scroll.classList.remove('is-dragging');
  };
  const pointerDown = event => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    pointerId = event.pointerId;
    originX = event.clientX;
    originY = event.clientY;
    originLeft = scroll.scrollLeft;
    originTop = scroll.scrollTop;
    dragging = false;
    suppressClick = false;
  };
  const pointerMove = event => {
    if (event.pointerId !== pointerId) return;
    const dx = event.clientX - originX;
    const dy = event.clientY - originY;
    if (!dragging && Math.hypot(dx, dy) < threshold) return;
    if (!dragging) {
      dragging = true;
      scroll.classList.add('is-dragging');
      scroll.setPointerCapture?.(pointerId);
    }
    event.preventDefault();
    scroll.scrollLeft = originLeft - dx / getUiZoom();
    scroll.scrollTop = originTop - dy / getUiZoom();
  };
  const click = event => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const blur = () => reset();
  scroll.addEventListener('pointerdown', pointerDown);
  scroll.addEventListener('pointermove', pointerMove);
  scroll.addEventListener('pointerup', reset);
  scroll.addEventListener('pointercancel', reset);
  scroll.addEventListener('lostpointercapture', reset);
  scroll.addEventListener('click', click, true);
  window.addEventListener('blur', blur);
  return () => {
    scroll.removeEventListener('pointerdown', pointerDown);
    scroll.removeEventListener('pointermove', pointerMove);
    scroll.removeEventListener('pointerup', reset);
    scroll.removeEventListener('pointercancel', reset);
    scroll.removeEventListener('lostpointercapture', reset);
    scroll.removeEventListener('click', click, true);
    window.removeEventListener('blur', blur);
  };
}

export function renderGuidePage(container, { setHeaderActions = () => {} } = {}) {
  let disposed = false;
  let data = null;
  let config = { ...TIMETABLE_DEFAULTS };
  let configLoadWarning = null;
  let dayStart = broadcastDayStart();
  let displayRange = guideDisplayRange(dayStart);
  let visibleTypes = new Set(TYPES);
  const hiddenChannelIds = loadHiddenChannelIds();
  let logoHandles = [];
  let minuteTimer = null;
  let dragDispose = null;
  let ruleDialog = null;
  let dateCalendar = null;
  let customChannelWidth = false;
  let renderedHourHeight = config.hourHeight;
  let layoutSignature = '';
  let layoutFrame = null;
  let layoutObserver = null;
  let weeklyChannel = null;
  let normalView = null;
  const preferredRuleUids = new Map();
  let refreshSequence = 0;
  let headerCompactMedia = null;
  let headerCompactListener = null;
  const pendingRealtimeResources = new Set();
  const realtimeDisposers = [];

  container.className = 'guide-page';
  container.innerHTML = '<section class="panel guide-loading"><p>番組表を読み込んでいます…</p></section>';
  const programHover = createProgramHover(container);

  function gridRange() {
    return weeklyChannel ? { start: dayStart, end: dayStart + DAY_MS } : displayRange;
  }

  function gridColumns() {
    if (weeklyChannel) {
      const channel = data.schedule.find(item => item.id === weeklyChannel.id) || { ...weeklyChannel, programs: [] };
      return Array.from({ length: 8 }, (_, index) => ({ channel, start: dayStart + index * DAY_MS, end: dayStart + (index + 1) * DAY_MS }));
    }
    return data.schedule.filter(channel => visibleTypes.has(channel.type) && !hiddenChannelIds.has(text(channel.id)))
      .map(channel => ({ channel, ...displayRange }));
  }

  function updateWeeklyControls() {
    const toolbar = document.querySelector('.guide-header-toolbar');
    toolbar.classList.toggle('is-weekly', !!weeklyChannel);
    toolbar.querySelector('[data-week-back]').hidden = !weeklyChannel;
    const label = toolbar.querySelector('[data-week-label]');
    label.hidden = !weeklyChannel;
    label.textContent = weeklyChannel ? `${weeklyChannel.name}：週間番組表（8日分）` : '';
    toolbar.querySelector('.guide-types').hidden = !!weeklyChannel;
    toolbar.querySelector('.guide-channel-visibility').hidden = !!weeklyChannel;
    toolbar.querySelector('[data-width]').disabled = !!weeklyChannel;
  }

  function openWeekly(channel) {
    const scroll = container.querySelector('.guide-scroll');
    normalView = { left: scroll.scrollLeft, top: scroll.scrollTop, dayStart, displayRange };
    weeklyChannel = { id: channel.id, name: channel.name };
    closeGuideProgramMenu();
    updateWeeklyControls();
    renderGrid();
    scroll.scrollLeft = 0;
    scroll.scrollTop = 0;
  }

  async function refreshState(resources = ['reserves']) {
    const sequence = ++refreshSequence;
    const latest = await refreshTimetableData(resources);
    if (disposed || sequence !== refreshSequence) return;
    data = latest;
    renderGrid(true);
  }

  function handleRealtime(resources) {
    if (!data) {
      resources.forEach(name => pendingRealtimeResources.add(name));
      return;
    }
    refreshState(resources).catch(() => {});
  }

  realtimeDisposers.push(
    subscribeReservationNotifications(() => handleRealtime(['reserves'])),
    subscribeRecordingNotifications(() => handleRealtime(['recording', 'reserves'])),
    subscribeScheduleNotifications(() => handleRealtime(['schedule']))
  );

  function measureLayout(scroll, channelCount) {
    scroll.classList.toggle('is-weekly', !!weeklyChannel);
    const scrollbarWidth = Math.max(0, scroll.offsetWidth - scroll.clientWidth - 2);
    scroll.style.maxWidth = weeklyChannel ? `${AXIS_WIDTH + 8 * 190 + 2 + scrollbarWidth}px` : '';
    const main = container.closest('.main-content');
    const bottomPadding = main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 12;
    const availableHeight = Math.max(0, (window.innerHeight - scroll.getBoundingClientRect().top) / getUiZoom() - bottomPadding);
    scroll.style.height = `${availableHeight}px`;
    const range = gridRange();
    const hours = (range.end - range.start) / 3600000;
    return {
      hourHeight: Math.max(config.hourHeight, Math.floor(Math.max(0, scroll.clientHeight - HEADER_HEIGHT) / hours * 1000) / 1000),
      channelWidth: weeklyChannel ? Math.max(150, Math.min(190, (scroll.clientWidth - AXIS_WIDTH) / 8))
        : customChannelWidth || channelCount === 0 ? config.channelWidth
        : Math.max(config.channelWidth, (scroll.clientWidth - AXIS_WIDTH) / channelCount)
    };
  }

  function scheduleLayout() {
    programHover.close();
    if (disposed || !data || layoutFrame !== null) return;
    layoutFrame = window.requestAnimationFrame(() => {
      layoutFrame = null;
      const scroll = container.querySelector('.guide-scroll');
      if (!scroll) return;
      const channelCount = gridColumns().length;
      const layout = measureLayout(scroll, channelCount);
      if (JSON.stringify(layout) !== layoutSignature) renderGrid(true);
    });
  }

  const programCells = new Map();
  let structureSignature = null;
  function renderGrid(preserveScroll = false) {
    const scroll = container.querySelector('.guide-scroll');
    const previous = preserveScroll && scroll ? { left: scroll.scrollLeft, top: scroll.scrollTop,
      hourHeight: renderedHourHeight } : null;
    const columns = gridColumns();
    const range = gridRange();
    const layout = measureLayout(scroll, columns.length);
    const { hourHeight, channelWidth } = layout;
    layoutSignature = JSON.stringify(layout);
    renderedHourHeight = hourHeight;
    const widthOutput = document.querySelector('.guide-header-toolbar [data-width-output]');
    const heightOutput = document.querySelector('.guide-header-toolbar [data-height-output]');
    if (widthOutput) widthOutput.textContent = weeklyChannel ? `${Math.round(channelWidth)}px（週間表示）`
      : `${config.channelWidth}px${channelWidth > config.channelWidth ? `（表示 ${Math.round(channelWidth)}px）` : ''}`;
    if (heightOutput) heightOutput.textContent = `${config.hourHeight}px${hourHeight > config.hourHeight ? `（表示 ${Math.round(hourHeight)}px）` : ''}`;
    const bodyHeight = (range.end - range.start) / 3600000 * hourHeight;
    const canvasWidth = AXIS_WIDTH + columns.length * channelWidth;
    const nextStructure = JSON.stringify([layout, range, columns.map(({ channel, start, end }) =>
      [{ ...channel, programs: undefined }, start, end]), !!weeklyChannel]);
    let canvas = scroll.querySelector('.guide-canvas');
    const rebuild = !canvas || nextStructure !== structureSignature;
    if (rebuild) {
      programHover.close();
      logoHandles.forEach(handle => handle.dispose());
      logoHandles = [];
      programCells.clear();
      canvas = document.createElement('div');
      canvas.className = 'guide-canvas';
      canvas.classList.toggle('is-weekly', !!weeklyChannel);
      canvas.style.width = `${canvasWidth}px`;
      canvas.style.height = `${HEADER_HEIGHT + bodyHeight}px`;
      canvas.style.setProperty('--guide-axis', `${AXIS_WIDTH}px`);
      canvas.style.setProperty('--guide-header', `${HEADER_HEIGHT}px`);
      canvas.style.setProperty('--guide-hour', `${hourHeight}px`);
      const header = document.createElement('div');
      header.className = 'guide-channel-row';
      header.style.width = `${canvasWidth}px`;
      header.style.gridTemplateColumns = `${AXIS_WIDTH}px repeat(${columns.length},${channelWidth}px)`;
      header.innerHTML = '<div class="guide-corner"></div>';
      columns.forEach(({ channel, start }) => {
        const cell = document.createElement(weeklyChannel ? 'div' : 'button');
        cell.className = 'guide-channel';
        if (weeklyChannel) {
          cell.textContent = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' }).format(new Date(start));
          cell.classList.add('guide-week-date');
          cell.title = '04:00 〜 翌04:00';
          header.append(cell);
          return;
        }
        cell.type = 'button';
        const tooltip = channelDetailText(channel);
        cell.title = tooltip;
        cell.setAttribute('aria-label', `${tooltip}。週間番組表を表示`);
        cell.addEventListener('click', () => openWeekly(channel));
        const logo = createChannelLogo({ name: channel.name, url: logoUrl(channel), tooltip }, { variant: 'list' });
        logoHandles.push(logo);
        const name = document.createElement('span');
        name.textContent = channel.name;
        cell.append(logo.element, name);
        header.append(cell);
      });
      canvas.append(header);
      const axis = document.createElement('div');
      axis.className = 'guide-time-axis';
      axis.style.height = `${bodyHeight}px`;
      const halfHourCount = Math.round((range.end - range.start) / (30 * 60000));
      for (let half = 0; half <= halfHourCount; half++) {
        const timestamp = range.start + half * 30 * 60000;
        const y = half * hourHeight / 2;
        const line = document.createElement('div');
        line.className = `guide-grid-line${half % 2 === 0 ? ' is-hour' : ''}`;
        line.style.top = `${HEADER_HEIGHT + y - (half === halfHourCount ? 1 : 0)}px`;
        line.style.left = `${AXIS_WIDTH}px`;
        line.style.width = `${canvasWidth - AXIS_WIDTH}px`;
        canvas.append(line);
        if (half % 2 === 0 && half < halfHourCount) {
          const label = document.createElement('time');
          label.style.top = `${y}px`;
          label.textContent = formatTime(timestamp);
          axis.append(label);
        }
      }
      canvas.append(axis);
      structureSignature = nextStructure;
    }
    const activeKeys = new Set();
    columns.forEach(({ channel, start, end }, channelIndex) => {
      let programCount = 0;
      (channel.programs || []).forEach(program => {
        const position = programPosition(program, start, hourHeight, end);
        if (!position) return;
        programCount += 1;
        const displayProgram = {
          ...program,
          channel: { ...channel, programs: undefined, ...(program.channel || {}) }
        };
        const state = programState(program, data.reserves, data.recording);
        const key = `${channel.id}|${start}|${program.id}|${program.start}`;
        activeKeys.add(key);
        let entry = programCells.get(key);
        if (!entry) {
          entry = { cell: document.createElement('button'), signature: null };
          programCells.set(key, entry);
        }
        entry.program = program;
        entry.displayProgram = displayProgram;
        const cell = entry.cell;
        const signature = JSON.stringify([displayProgram, state, position]);
        if (entry.signature === signature) return;
        const initial = entry.signature === null;
        entry.signature = signature;
        cell.type = 'button';
        cell.className = `guide-program category-${text(program.category, 'etc')} is-${state.key}`;
        cell.style.left = `${AXIS_WIDTH + channelIndex * channelWidth + 1}px`;
        cell.style.top = `${HEADER_HEIGHT + position.top + 1}px`;
        cell.style.width = `${channelWidth - 2}px`;
        const renderedHeight = Math.max(2, position.height - 2);
        const contentLayout = programContentLayout(renderedHeight, channelWidth);
        cell.style.height = `${renderedHeight}px`;
        if (contentLayout.mode !== 'normal') cell.classList.add(`is-${contentLayout.mode}`);
        const episode = program.episode === null || program.episode === undefined ? '' : String(program.episode).trim();
        const subtitle = text(program.subTitle) || (episode ? `第${episode}話` : '');
        const displayTitle = [text(programTitlePresentation(program.title), 'タイトル未取得'), programTitlePresentation(subtitle)].filter(Boolean).join(' ');
        const flags = contentLayout.showFlags ? programFlagsHtml(program.flags) : '';
        const title = `<strong class="guide-program-title" style="--guide-title-lines:${contentLayout.titleLines}"><time>${formatTime(program.start)}</time> ${flags}${flags ? ' ' : ''}<span>${escapeHtml(displayTitle)}</span></strong>`;
        const description = contentLayout.descriptionLines > 0 && text(program.description || program.detail)
          ? `<small class="guide-program-description" style="--guide-description-lines:${contentLayout.descriptionLines}">${escapeHtml(program.description || program.detail)}</small>`
          : '';
        cell.innerHTML = contentLayout.mode === 'tiny' ? '' : title + description;
        cell.setAttribute('aria-label', `${formatTime(program.start)} ${state.key === 'none' ? '' : `${state.label} `}${displayTitle}`);
        setProgramHover(cell, programHoverInfo(displayProgram, { channelLogoUrl: logoUrl(channel),
          statuses: state.key === 'none' ? [] : [state.label] }));
        if (initial) {
          cell.addEventListener('click', () => openProgramDetailDialog({ id: entry.program.id, onChanged: refreshState }));
          const openContext = event => {
            const program = entry.program;
            const displayProgram = entry.displayProgram;
            programHover.close();
            event.preventDefault();
            event.stopPropagation();
            const rect = cell.getBoundingClientRect();
            const point = event.type === 'contextmenu' && (event.clientX || event.clientY)
              ? { x: event.clientX, y: event.clientY } : { x: rect.left + 16, y: rect.top + 16 };
            createGuideProgramMenu({ program: displayProgram, ...point,
              onChanged: () => refreshState(['recording', 'reserves']),
              resolveRule: context => {
                const rules = context.detail.rules;
                const linked = ruleProgram(displayProgram, data.reserves);
                if (linked === null) return { mode: 'unavailable', label: '関連する予約を一意に特定できません' };
                const action = ruleAction(linked, rules, preferredRuleUids.get(program.id));
                // A deleted rule's UID must never select another rule by list position.
                if (action.mode === 'unavailable' && action.ruleUid &&
                    action.label === '関連ルールは現在の一覧にありません') return { mode: 'create' };
                return action;
              },
              onRule: action => {
                if (action.mode === 'unavailable') {
                  location.hash = programDetailUrl({ id: program.id });
                  return;
                }
                ruleDialog = openRuleDialog(displayProgram, async result => {
                  if (result.mode === 'create' && text(result.rule?.ruleUid)) {
                    preferredRuleUids.set(program.id, result.rule.ruleUid);
                  }
                  await refreshState();
                }, async () => {
                  preferredRuleUids.delete(program.id);
                  await refreshState();
                }, action);
              } });
          };
          cell.addEventListener('contextmenu', openContext);
          cell.addEventListener('keydown', event => {
            if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) openContext(event);
          });
        }
        if (cell.parentElement !== canvas) canvas.append(cell);
      });
      if (weeklyChannel && programCount === 0 && !canvas.querySelector(`[data-empty-column="${channelIndex}"]`)) {
        const empty = document.createElement('p');
        empty.className = 'guide-week-empty';
        empty.dataset.emptyColumn = String(channelIndex);
        empty.textContent = 'データ未取得';
        empty.style.left = `${AXIS_WIDTH + channelIndex * channelWidth}px`;
        empty.style.width = `${channelWidth}px`;
        empty.style.top = `${HEADER_HEIGHT + 12}px`;
        canvas.append(empty);
      }
      if (programCount > 0) canvas.querySelector(`[data-empty-column="${channelIndex}"]`)?.remove();
    });
    for (const [key, entry] of programCells) {
      if (activeKeys.has(key)) continue;
      if (entry.cell.getAttribute('aria-describedby') === 'program-hover') programHover.close();
      entry.cell.remove(); programCells.delete(key);
    }
    const now = Date.now();
    const currentColumn = columns.findIndex(column => now >= column.start && now < column.end);
    if (currentColumn !== -1) {
      const line = canvas.querySelector('.guide-now-line') || document.createElement('div');
      line.className = 'guide-now-line';
      line.style.top = `${HEADER_HEIGHT + (now - columns[currentColumn].start) / 3600000 * hourHeight}px`;
      line.style.left = `${AXIS_WIDTH + (weeklyChannel ? currentColumn * channelWidth : 0)}px`;
      line.style.width = `${weeklyChannel ? channelWidth : canvasWidth - AXIS_WIDTH}px`;
      if (!line.parentElement) canvas.append(line);
    } else canvas.querySelector('.guide-now-line')?.remove();
    const host = container.querySelector('.guide-scroll');
    if (rebuild) host.replaceChildren(canvas);
    if (previous && rebuild) {
      host.scrollLeft = previous.left;
      host.scrollTop = previous.top === 0 ? 0 : HEADER_HEIGHT +
        Math.max(0, previous.top - HEADER_HEIGHT) / previous.hourHeight * hourHeight;
    }
  }

  function renderPage() {
    const availableTypes = TYPES.filter(type => data.schedule.some(channel => channel.type === type));
    const currentDayStart = broadcastDayStart();
    container.innerHTML = '<section class="guide-scroll" aria-label="番組表"></section>';
    const toolbar = document.createElement('div');
    toolbar.className = 'guide-header-toolbar';
    toolbar.innerHTML = `<details class="guide-header-controls" open>
      <summary>番組表操作</summary>
      <div class="guide-toolbar-content">
        <button class="button" data-week-back type="button" hidden>通常番組表へ戻る</button><strong data-week-label hidden></strong>
        <fieldset class="guide-types"><legend>放送種別</legend>${availableTypes.map(type => `<label><input type="checkbox" value="${type}" checked>${type}</label>`).join('')}</fieldset>
        <div class="guide-date-controls"><button class="button" data-prev type="button"${dayStart <= currentDayStart ? ' disabled' : ''}>前日</button><div data-date-picker></div><button class="button" data-next type="button">翌日</button><button class="button" data-now type="button">現在時刻</button></div>
        <details class="guide-display-settings"><summary>表示調整</summary><div>
          <label>列幅 <output data-width-output>${config.channelWidth}px</output><input data-width type="range" min="${TIMETABLE_LIMITS.channelWidth[0]}" max="${TIMETABLE_LIMITS.channelWidth[1]}" step="${TIMETABLE_LIMITS.channelWidth[2]}" value="${config.channelWidth}"></label>
          <label>1時間の高さ <output data-height-output>${config.hourHeight}px</output><input data-height type="range" min="${TIMETABLE_LIMITS.hourHeight[0]}" max="${TIMETABLE_LIMITS.hourHeight[1]}" step="${TIMETABLE_LIMITS.hourHeight[2]}" value="${config.hourHeight}"></label>
          <section class="guide-channel-visibility"><div><strong>表示チャンネル</strong><button class="button" data-show-all type="button">すべて表示</button></div><p>このブラウザの番組表だけに反映します。</p><div data-channel-list></div></section>
          <p data-config-status role="status" class="${configLoadWarning ? 'is-error' : ''}">${escapeHtml(configLoadWarning || '')}</p>
          <div class="guide-display-actions"><button class="button" data-reset type="button">初期値へ戻す</button><button class="button primary" data-save type="button">保存</button></div>
        </div></details>
      </div>
    </details>`;
    setHeaderActions(toolbar);
    dateCalendar?.destroy();
    dateCalendar = createMonthCalendar(toolbar.querySelector('[data-date-picker]'), {
      mode: 'date',
      value: new Date(dayStart),
      minDate: new Date(currentDayStart),
      onSelect: date => {
        const value = dayStartFromInput(date);
        if (value !== null) selectDay(value);
      }
    });
    const controls = toolbar.querySelector('.guide-header-controls');
    headerCompactMedia = createHeaderCompactMedia(1100);
    headerCompactListener = event => { controls.open = !event.matches; };
    controls.open = !headerCompactMedia.matches;
    headerCompactMedia.addEventListener('change', headerCompactListener);
    const width = toolbar.querySelector('[data-width]');
    const height = toolbar.querySelector('[data-height]');
    toolbar.querySelector('[data-week-back]').addEventListener('click', () => {
      if (!normalView) return;
      weeklyChannel = null;
      dayStart = normalView.dayStart;
      displayRange = normalView.displayRange;
      dateCalendar.setValue(new Date(dayStart));
      toolbar.querySelector('[data-prev]').disabled = dayStart <= broadcastDayStart();
      updateWeeklyControls();
      renderGrid();
      const scroll = container.querySelector('.guide-scroll');
      scroll.scrollLeft = normalView.left;
      scroll.scrollTop = normalView.top;
      normalView = null;
    });
    const renderChannelChoices = () => {
      const listHost = toolbar.querySelector('[data-channel-list]');
      const groups = availableTypes.map(type => {
        const channels = data.schedule.filter(channel => channel.type === type && text(channel.id));
        if (channels.length === 0) return null;
        const group = document.createElement('fieldset');
        const legend = document.createElement('legend');
        legend.textContent = type;
        group.append(legend);
        channels.forEach(channel => {
          const id = text(channel.id);
          const label = document.createElement('label');
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.value = id;
          input.checked = !hiddenChannelIds.has(id);
          const name = document.createElement('span');
          name.textContent = text(channel.name, id);
          label.append(input, name);
          group.append(label);
        });
        return group;
      }).filter(Boolean);
      listHost.replaceChildren(...groups);
    };
    renderChannelChoices();
    const liveScale = () => {
      const scroll = container.querySelector('.guide-scroll');
      const previousTop = scroll.scrollTop;
      const anchorTime = displayRange.start + Math.max(0, scroll.scrollTop - HEADER_HEIGHT) / renderedHourHeight * 3600000;
      config = { channelWidth: Number(width.value), hourHeight: Number(height.value) };
      toolbar.querySelector('[data-width-output]').textContent = `${config.channelWidth}px`;
      toolbar.querySelector('[data-height-output]').textContent = `${config.hourHeight}px`;
      renderGrid(true);
      scroll.scrollTop = previousTop === 0 ? 0 : HEADER_HEIGHT + (anchorTime - displayRange.start) / 3600000 * renderedHourHeight;
    };
    width.addEventListener('input', () => { customChannelWidth = true; liveScale(); });
    height.addEventListener('input', liveScale);
    toolbar.querySelector('.guide-types').addEventListener('change', event => {
      if (!(event.target instanceof HTMLInputElement)) return;
      event.target.checked ? visibleTypes.add(event.target.value) : visibleTypes.delete(event.target.value);
      renderGrid(true);
    });
    toolbar.querySelector('[data-channel-list]').addEventListener('change', event => {
      if (!(event.target instanceof HTMLInputElement)) return;
      event.target.checked ? hiddenChannelIds.delete(event.target.value) : hiddenChannelIds.add(event.target.value);
      try { saveHiddenChannelIds(hiddenChannelIds); } catch (_) {}
      renderGrid(true);
    });
    toolbar.querySelector('[data-show-all]').addEventListener('click', () => {
      hiddenChannelIds.clear();
      try { saveHiddenChannelIds(hiddenChannelIds); } catch (_) {}
      renderChannelChoices();
      renderGrid(true);
    });
    const selectDay = value => {
      const latestCurrentDayStart = broadcastDayStart();
      dayStart = Math.max(value, latestCurrentDayStart);
      displayRange = guideDisplayRange(dayStart);
      dateCalendar.setMinDate(new Date(latestCurrentDayStart));
      dateCalendar.setValue(new Date(dayStart));
      toolbar.querySelector('[data-prev]').disabled = dayStart <= latestCurrentDayStart;
      renderGrid(true);
    };
    toolbar.querySelector('[data-prev]').addEventListener('click', () => selectDay(dayStart - DAY_MS));
    toolbar.querySelector('[data-next]').addEventListener('click', () => selectDay(dayStart + DAY_MS));
    toolbar.querySelector('[data-now]').addEventListener('click', () => {
      selectDay(broadcastDayStart());
      container.querySelector('.guide-scroll').scrollTop = Math.max(0, HEADER_HEIGHT + (Date.now() - displayRange.start) / 3600000 * renderedHourHeight - 160);
    });
    toolbar.querySelector('[data-reset]').addEventListener('click', () => {
      config = { ...TIMETABLE_DEFAULTS };
      customChannelWidth = false;
      width.value = config.channelWidth;
      height.value = config.hourHeight;
      liveScale();
    });
    toolbar.querySelector('[data-save]').addEventListener('click', async event => {
      const button = event.currentTarget;
      const status = toolbar.querySelector('[data-config-status]');
      button.disabled = true;
      try {
        const result = await saveTimetableConfig(config);
        status.textContent = '表示設定を保存しました。';
        status.className = 'is-success';
      } catch (cause) {
        status.textContent = cause.message;
        status.className = 'is-error';
      } finally { button.disabled = false; }
    });
    const scroll = container.querySelector('.guide-scroll');
    scroll.addEventListener('scroll', () => { closeGuideProgramMenu(); programHover.close(); }, { passive: true });
    dragDispose = enableMouseDragScroll(scroll);
    renderGrid();
    layoutObserver = new ResizeObserver(scheduleLayout);
    layoutObserver.observe(scroll);
    layoutObserver.observe(container);
    layoutObserver.observe(toolbar);
    window.addEventListener('resize', scheduleLayout);
    scroll.scrollTop = Math.max(0, HEADER_HEIGHT + (Date.now() - displayRange.start) / 3600000 * renderedHourHeight - 160);
  }

  Promise.all([loadTimetableData(), loadWuiConfig()]).then(([loaded, wuiConfig]) => {
    if (disposed) return;
    data = loaded;
    config = { ...TIMETABLE_DEFAULTS, ...(wuiConfig.timetable || {}) };
    customChannelWidth = config.channelWidth !== TIMETABLE_DEFAULTS.channelWidth;
    configLoadWarning = wuiConfig.loadWarning ? `保存済み設定を取得できないため初期値で表示しています。${wuiConfig.loadWarning}` : null;
    renderPage();
    minuteTimer = window.setInterval(() => renderGrid(true), 60000);
    if (pendingRealtimeResources.size > 0) {
      const resources = [...pendingRealtimeResources];
      pendingRealtimeResources.clear();
      refreshState(resources).catch(() => {});
    }
  }).catch(cause => {
    if (!disposed) container.innerHTML = `<section class="panel empty-page"><h2>番組表を読み込めません</h2><p>${escapeHtml(cause.message)}</p></section>`;
  });

  const dismissMenu = event => {
    const menu = activeGuideMenu;
    if (event.key === 'Escape') closeGuideProgramMenu();
    if (event.type === 'pointerdown' && menu && !menu.element.contains(event.target)) closeGuideProgramMenu();
  };
  document.addEventListener('keydown', dismissMenu);
  document.addEventListener('pointerdown', dismissMenu);
  return () => {
    disposed = true;
    programHover.dispose();
    clearInterval(minuteTimer);
    layoutObserver?.disconnect();
    if (layoutFrame !== null) window.cancelAnimationFrame(layoutFrame);
    window.removeEventListener('resize', scheduleLayout);
    realtimeDisposers.forEach(dispose => dispose());
    if (headerCompactMedia && headerCompactListener) headerCompactMedia.removeEventListener('change', headerCompactListener);
    setHeaderActions();
    dragDispose?.();
    dateCalendar?.destroy();
    logoHandles.forEach(handle => handle.dispose());
    closeActiveLiveOverlay();
    closeGuideProgramMenu();
    document.querySelector('.guide-program-dialog')?.close();
    ruleDialog?.close();
    document.removeEventListener('keydown', dismissMenu);
    document.removeEventListener('pointerdown', dismissMenu);
  };
}
