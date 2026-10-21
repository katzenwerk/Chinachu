import { createChannelLogo } from '../components/channel-logo.js';
import { invalidateResources, loadResource } from '../services/api-client.js';
import { openProgramDetailDialog } from '../components/program-detail-dialog.js';
import { openRuleEditorDialog, programRuleSeed } from '../components/rule-editor-dialog.js';
import { closeActiveLiveOverlay, openRecordingLiveOverlay } from '../services/live-player-adapter.js';
import { channelDetailText } from '../services/recording-model.js';
import { programDetailUrl } from '../services/program-detail-client.js';
import { ruleAction } from '../services/program-detail-model.js';
import {
  loadTimetableData, loadWuiConfig, refreshTimetableData, reserveProgram, saveTimetableConfig,
  setReserveSkip, unreserveProgram
} from '../services/timetable-client.js';
import {
  subscribeRecordingNotifications, subscribeReservationNotifications, subscribeScheduleNotifications
} from '../services/realtime-client.js';
import {
  broadcastDayStart, dateInputValue, dayStartFromInput, guideDisplayRange,
  programContentLayout, programFlagPresentation, programPosition, programState, programTitlePresentation,
  TIMETABLE_DEFAULTS, TIMETABLE_LIMITS
} from '../services/timetable-model.js';

const DAY_MS = 86400000;
const AXIS_WIDTH = 68;
const HEADER_HEIGHT = 60;
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

async function copyText(value) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const input = document.createElement('textarea');
  input.value = value;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.append(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('copy failed');
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

export function createGuideProgramMenu({ program, state, x, y, onAction, resolveRule, onRule, host = document.body }) {
  document.querySelector('.guide-context-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'guide-context-menu';
  menu.setAttribute('role', 'menu');
  const items = [];
  let ruleChoice = null;
  let ruleButton = null;
  if (state.key === 'none') items.push(['録画予約', () => onAction('reserve')]);
  if (state.key === 'manual') items.push(['予約取消', () => onAction('unreserve')]);
  if (['rule', 'conflict'].includes(state.key)) items.push(['この予約をスキップ', () => onAction('skip')]);
  if (state.key === 'skip') items.push(['スキップを取消', () => onAction('unskip')]);
  if (state.key !== 'recording') items.push(['ルール', () => onRule(ruleChoice), 'rule']);
  items.push(['番組詳細を開く', () => { location.hash = programDetailUrl({ id: program.id }); }]);
  items.push(null);
  items.push(['タイトルをコピー', () => copyText(program.title || '')]);
  items.push(null);
  items.push(['Googleで検索', () => window.open(`https://www.google.com/search?q=${encodeURIComponent(program.title || '')}`, '_blank', 'noopener')]);
  items.push(['Wikipediaで検索', () => window.open(`https://ja.wikipedia.org/wiki/${encodeURIComponent(program.title || '')}`, '_blank', 'noopener')]);
  items.forEach(item => {
    if (item === null) {
      const separator = document.createElement('hr');
      separator.setAttribute('role', 'separator');
      menu.append(separator);
      return;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.textContent = item[0];
    if (item[2] === 'rule') {
      ruleButton = button;
      button.disabled = true;
    }
    button.addEventListener('click', async () => {
      menu.remove();
      try { await item[1](); } catch (_) {}
    });
    menu.append(button);
  });
  host.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - rect.height - 8))}px`;
  if (ruleButton) {
    Promise.resolve().then(resolveRule).then(action => {
      if (!menu.isConnected) return;
      ruleChoice = action;
      ruleButton.disabled = false;
      ruleButton.textContent = action.mode === 'edit' ? 'ルール編集' :
        action.mode === 'create' ? 'ルール作成' : '関連ルールを確認';
      if (action.mode === 'unavailable') ruleButton.title = action.label || '';
    }).catch(error => {
      if (!menu.isConnected) return;
      ruleButton.textContent = 'ルールを取得できません';
      ruleButton.title = String(error?.message || error);
      ruleButton.disabled = true;
    });
  }
  return menu;
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
    scroll.scrollLeft = originLeft - dx;
    scroll.scrollTop = originTop - dy;
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
  const preferredRuleUids = new Map();
  let refreshSequence = 0;
  let headerCompactMedia = null;
  let headerCompactListener = null;
  const pendingRealtimeResources = new Set();
  const realtimeDisposers = [];

  container.className = 'guide-page';
  container.innerHTML = '<section class="panel guide-loading"><p>番組表を読み込んでいます…</p></section>';

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

  async function runAction(program, action) {
    const messages = { reserve: 'この番組を録画予約しますか？', unreserve: 'この手動予約を取り消しますか？', skip: 'このルール予約をスキップしますか？', unskip: 'スキップを取り消しますか？' };
    if (!window.confirm(messages[action])) return;
    if (action === 'reserve') await reserveProgram(program.id);
    if (action === 'unreserve') await unreserveProgram(program.id);
    if (action === 'skip') await setReserveSkip(program.id, true);
    if (action === 'unskip') await setReserveSkip(program.id, false);
    await refreshState();
  }

  function renderGrid(preserveScroll = false) {
    const scroll = container.querySelector('.guide-scroll');
    const previous = preserveScroll && scroll ? { left: scroll.scrollLeft, top: scroll.scrollTop } : null;
    logoHandles.forEach(handle => handle.dispose());
    logoHandles = [];
    const channels = data.schedule.filter(channel => visibleTypes.has(channel.type) && !hiddenChannelIds.has(text(channel.id)));
    const hourHeight = config.hourHeight;
    const channelWidth = config.channelWidth;
    const bodyHeight = (displayRange.end - displayRange.start) / 3600000 * hourHeight;
    const canvasWidth = AXIS_WIDTH + channels.length * channelWidth;
    const canvas = document.createElement('div');
    canvas.className = 'guide-canvas';
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${HEADER_HEIGHT + bodyHeight}px`;
    canvas.style.setProperty('--guide-axis', `${AXIS_WIDTH}px`);
    canvas.style.setProperty('--guide-header', `${HEADER_HEIGHT}px`);
    canvas.style.setProperty('--guide-hour', `${hourHeight}px`);
    const header = document.createElement('div');
    header.className = 'guide-channel-row';
    header.style.width = `${canvasWidth}px`;
    header.style.gridTemplateColumns = `${AXIS_WIDTH}px repeat(${channels.length},${channelWidth}px)`;
    header.innerHTML = '<div class="guide-corner">時刻</div>';
    channels.forEach(channel => {
      const cell = document.createElement('div');
      cell.className = 'guide-channel';
      const tooltip = channelDetailText(channel);
      cell.title = tooltip;
      cell.setAttribute('aria-label', tooltip);
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
    const halfHourCount = Math.round((displayRange.end - displayRange.start) / (30 * 60000));
    for (let half = 0; half <= halfHourCount; half++) {
      const timestamp = displayRange.start + half * 30 * 60000;
      const y = half * hourHeight / 2;
      const line = document.createElement('div');
      line.className = `guide-grid-line${half % 2 === 0 ? ' is-hour' : ''}`;
      line.style.top = `${HEADER_HEIGHT + y}px`;
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
    channels.forEach((channel, channelIndex) => {
      (channel.programs || []).forEach(program => {
        const position = programPosition(program, displayRange.start, hourHeight, displayRange.end);
        if (!position) return;
        const displayProgram = {
          ...program,
          channel: { ...channel, ...(program.channel || {}) }
        };
        const state = programState(program, data.reserves, data.recording);
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = `guide-program category-${text(program.category, 'etc')} is-${state.key}`;
        cell.style.left = `${AXIS_WIDTH + channelIndex * channelWidth + 1}px`;
        cell.style.top = `${HEADER_HEIGHT + position.top + 1}px`;
        cell.style.width = `${channelWidth - 2}px`;
        const renderedHeight = Math.max(2, position.height - 2);
        const contentLayout = programContentLayout(renderedHeight, channelWidth);
        cell.style.height = `${renderedHeight}px`;
        cell.title = programTitlePresentation(program.fullTitle || program.title || '');
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
        cell.addEventListener('click', () => openProgramDetailDialog({ id: program.id, onChanged: refreshState }));
        cell.addEventListener('contextmenu', event => {
          event.preventDefault();
          event.stopPropagation();
          createGuideProgramMenu({ program: displayProgram, state, x: event.clientX, y: event.clientY,
            onAction: action => runAction(program, action),
            resolveRule: async () => {
              invalidateResources(['rules']);
              const rules = await loadResource('rules');
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
        });
        canvas.append(cell);
      });
    });
    const now = Date.now();
    if (now >= displayRange.start && now < displayRange.end) {
      const line = document.createElement('div');
      line.className = 'guide-now-line';
      line.style.top = `${HEADER_HEIGHT + (now - displayRange.start) / 3600000 * hourHeight}px`;
      line.style.left = `${AXIS_WIDTH}px`;
      line.style.width = `${canvasWidth - AXIS_WIDTH}px`;
      canvas.append(line);
    }
    const host = container.querySelector('.guide-scroll');
    host.replaceChildren(canvas);
    if (previous) {
      host.scrollLeft = previous.left;
      host.scrollTop = previous.top;
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
        <fieldset class="guide-types"><legend>放送種別</legend>${availableTypes.map(type => `<label><input type="checkbox" value="${type}" checked>${type}</label>`).join('')}</fieldset>
        <div class="guide-date-controls"><button class="button" data-prev type="button"${dayStart <= currentDayStart ? ' disabled' : ''}>前日</button><input data-date type="date" min="${dateInputValue(currentDayStart)}" value="${dateInputValue(dayStart)}"><button class="button" data-next type="button">翌日</button><button class="button" data-now type="button">現在時刻</button></div>
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
    const controls = toolbar.querySelector('.guide-header-controls');
    headerCompactMedia = window.matchMedia('(max-width: 1100px)');
    headerCompactListener = event => { controls.open = !event.matches; };
    controls.open = !headerCompactMedia.matches;
    headerCompactMedia.addEventListener('change', headerCompactListener);
    const width = toolbar.querySelector('[data-width]');
    const height = toolbar.querySelector('[data-height]');
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
      const anchorTime = displayRange.start + Math.max(0, scroll.scrollTop - HEADER_HEIGHT) / config.hourHeight * 3600000;
      config = { channelWidth: Number(width.value), hourHeight: Number(height.value) };
      toolbar.querySelector('[data-width-output]').textContent = `${config.channelWidth}px`;
      toolbar.querySelector('[data-height-output]').textContent = `${config.hourHeight}px`;
      renderGrid(true);
      scroll.scrollTop = HEADER_HEIGHT + (anchorTime - displayRange.start) / 3600000 * config.hourHeight;
    };
    width.addEventListener('input', liveScale);
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
      toolbar.querySelector('[data-date]').min = dateInputValue(latestCurrentDayStart);
      toolbar.querySelector('[data-date]').value = dateInputValue(dayStart);
      toolbar.querySelector('[data-prev]').disabled = dayStart <= latestCurrentDayStart;
      renderGrid();
    };
    toolbar.querySelector('[data-prev]').addEventListener('click', () => selectDay(dayStart - DAY_MS));
    toolbar.querySelector('[data-next]').addEventListener('click', () => selectDay(dayStart + DAY_MS));
    toolbar.querySelector('[data-date]').addEventListener('change', event => {
      const value = dayStartFromInput(event.target.value);
      if (value !== null) selectDay(value);
    });
    toolbar.querySelector('[data-now]').addEventListener('click', () => {
      selectDay(broadcastDayStart());
      container.querySelector('.guide-scroll').scrollTop = Math.max(0, HEADER_HEIGHT + (Date.now() - displayRange.start) / 3600000 * config.hourHeight - 160);
    });
    toolbar.querySelector('[data-reset]').addEventListener('click', () => {
      config = { ...TIMETABLE_DEFAULTS };
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
    scroll.addEventListener('scroll', () => document.querySelector('.guide-context-menu')?.remove(), { passive: true });
    dragDispose = enableMouseDragScroll(scroll);
    renderGrid();
    scroll.scrollTop = Math.max(0, HEADER_HEIGHT + (Date.now() - displayRange.start) / 3600000 * config.hourHeight - 160);
  }

  Promise.all([loadTimetableData(), loadWuiConfig()]).then(([loaded, wuiConfig]) => {
    if (disposed) return;
    data = loaded;
    config = { ...TIMETABLE_DEFAULTS, ...(wuiConfig.timetable || {}) };
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
    const menu = document.querySelector('.guide-context-menu');
    if (event.key === 'Escape') menu?.remove();
    if (event.type === 'pointerdown' && menu && !menu.contains(event.target)) menu.remove();
  };
  document.addEventListener('keydown', dismissMenu);
  document.addEventListener('pointerdown', dismissMenu);
  return () => {
    disposed = true;
    clearInterval(minuteTimer);
    realtimeDisposers.forEach(dispose => dispose());
    if (headerCompactMedia && headerCompactListener) headerCompactMedia.removeEventListener('change', headerCompactListener);
    setHeaderActions();
    dragDispose?.();
    logoHandles.forEach(handle => handle.dispose());
    closeActiveLiveOverlay();
    document.querySelector('.guide-context-menu')?.remove();
    document.querySelector('.guide-program-dialog')?.close();
    ruleDialog?.close();
    document.removeEventListener('keydown', dismissMenu);
    document.removeEventListener('pointerdown', dismissMenu);
  };
}
