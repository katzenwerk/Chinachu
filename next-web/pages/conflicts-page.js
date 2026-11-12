import { invalidateResources, loadResource } from '../services/api-client.js';
import { createMonthCalendar } from '../components/month-calendar.js';
import { createProgramHover, programHoverInfo, setProgramHover } from '../components/program-hover.js';
import { channelLogoUrl } from '../services/recording-model.js';
import { reservationTags } from '../services/reservation-model.js';
import { openProgramDetailDialog } from '../components/program-detail-dialog.js';
import { programDetailUrl } from '../services/program-detail-client.js';
import { operatorRecordingInfo } from '../services/recorded-result-warnings.js';
import { subscribeRecordedNotifications, subscribeReservationNotifications } from '../services/realtime-client.js';
import { createGuideProgramMenu } from './guide-page.js';
import { openRuleEditorDialog, programRuleSeed } from '../components/rule-editor-dialog.js';
import { ruleAction } from '../services/program-detail-model.js';

const HOUR_MS = 60 * 60 * 1000;
const TIMELINE_DURATION_MS = 3 * HOUR_MS;
const TIMELINE_STEP_MS = 30 * 60 * 1000;
const QUARTER_HOUR_MS = 15 * 60 * 1000;
const dateTimeFormat = new Intl.DateTimeFormat('ja-JP', {
  month: '2-digit', day: '2-digit', weekday: 'short',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const timeFormat = new Intl.DateTimeFormat('ja-JP', {
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const dayFormat = new Intl.DateTimeFormat('ja-JP', {
  month: '2-digit', day: '2-digit'
});

function interval(program) {
  const start = Number(program?.start);
  const explicitEnd = Number(program?.end);
  const duration = Number(program?.seconds);
  const end = explicitEnd > start ? explicitEnd : start + duration * 1000;
  return Number.isFinite(start) && start > 0 && Number.isFinite(end) && end > start
    ? { start, end } : null;
}

function titleOf(program) {
  return String(program?.fullTitle || program?.title || 'タイトル未取得');
}

function channelOf(program) {
  const channel = program?.channel || {};
  return [channel.type, channel.name].filter(Boolean).join(' / ') || '放送局未取得';
}

function channelKey(program) {
  const channel = program?.channel || {};
  const type = String(channel.type || '');
  if (channel.id !== undefined && channel.id !== null && String(channel.id) !== '') {
    return `${type}|id:${channel.id}`;
  }
  if (channel.channel !== undefined && channel.channel !== null && channel.sid !== undefined && channel.sid !== null) {
    return `${type}|ch:${channel.channel}|sid:${channel.sid}`;
  }
  if (channel.name) return `${type}|name:${channel.name}`;
  // No channel identity: never combine unrelated reservations into one lane.
  return `${type}|unknown:${program?.id || ''}`;
}

function timeRange(period) {
  const endText = dayFormat.format(period.start) === dayFormat.format(period.end)
    ? timeFormat.format(period.end) : dateTimeFormat.format(period.end);
  return `${dateTimeFormat.format(period.start)}–${endText}`;
}

function detailLink(program) {
  const id = String(program?.id || '');
  if (!id) return null;
  const link = document.createElement('a');
  link.className = 'conflict-program-link';
  link.href = programDetailUrl({ id });
  link.textContent = '番組詳細';
  return link;
}

function timelineRange(period, offsetHours = 0) {
  // Short conflicts stay near the centre. For long programmes focus on the
  // first 30 minutes instead of jumping several hours into the broadcast.
  const center = period.start + Math.min((period.end - period.start) / 2, HOUR_MS / 2);
  const start = Math.round((center - TIMELINE_DURATION_MS / 2) / QUARTER_HOUR_MS) * QUARTER_HOUR_MS
    + offsetHours * HOUR_MS;
  return { start, end: start + TIMELINE_DURATION_MS, step: TIMELINE_STEP_MS };
}

function timelineEntries(programs, range) {
  return programs.flatMap(program => {
    if (program?.isSkip === true) return [];
    const period = interval(program);
    return period && period.start < range.end && period.end > range.start ? [{ program, period }] : [];
  }).sort((a, b) => a.period.start - b.period.start || a.period.end - b.period.end);
}

function bookingLoadSegments(entries, range) {
  const boundaries = [...new Set([range.start, range.end, ...entries.flatMap(entry => [
    Math.max(range.start, entry.period.start), Math.min(range.end, entry.period.end)
  ])])].sort((a, b) => a - b);
  return boundaries.slice(0, -1).map((start, index) => ({
    start, end: boundaries[index + 1],
    // [start, end): 23:45に終了した予約は23:45以降に含めない。
    programs: entries.filter(entry => entry.period.start <= start && entry.period.end > start)
  }));
}

async function loadTuners() {
  const response = await fetch('/api/tuners.json', {
    headers: { Accept: 'application/json' }, cache: 'no-store'
  });
  if (!response.ok) throw new Error(`チューナー情報を取得できません (HTTP ${response.status})`);
  const tuners = await response.json();
  if (!Array.isArray(tuners) || !tuners.every(tuner =>
    Array.isArray(tuner?.types) && tuner.types.length > 0 &&
    tuner.types.every(type => typeof type === 'string' && type.trim()))) {
    throw new Error('チューナー情報の形式が正しくありません');
  }
  return tuners.map(tuner => ({ types: [...new Set(tuner.types.map(type => type.trim()))] }));
}

// Same capacity principle as the reservation preflight: for every group of
// broadcast types, compare required reservations with the union of compatible
// physical tuners. This avoids counting a shared BS/CS tuner twice.
function capacityIssue(programs, tuners) {
  if (tuners === null) return null;
  const counts = new Map();
  for (const entry of programs) {
    const type = entry.program?.channel?.type;
    if (typeof type !== 'string' || !type.trim()) return null;
    const normalized = type.trim();
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }
  const types = [...counts.keys()];
  const shortages = [];
  for (let mask = 1; mask < (1 << types.length); mask++) {
    const group = types.filter((_, index) => mask & (1 << index));
    const demand = group.reduce((sum, type) => sum + counts.get(type), 0);
    const capacity = tuners.filter(tuner => group.some(type => tuner.types.includes(type))).length;
    if (demand > capacity) shortages.push({ mask, group, demand, capacity });
  }
  // Mark only the smallest failing groups. A GR-only shortage must not
  // unnecessarily color an unrelated BS row red.
  const minimal = shortages.filter(item => !shortages.some(other =>
    other.mask !== item.mask && (other.mask & item.mask) === other.mask));
  return {
    overCapacity: shortages.length > 0,
    affectedTypes: new Set(minimal.flatMap(item => item.group)),
    detail: minimal.map(item => `${item.group.join('＋')} ${item.demand}本／対応${item.capacity}台`).join('、')
  };
}

function placeTimelineEntry(group, entry) {
  let track = group.tracks.find(items => !items.length || items[items.length - 1].period.end <= entry.period.start);
  if (!track) { track = []; group.tracks.push(track); }
  track.push(entry);
}

function timelineTracks(entries) {
  const channels = new Map();
  for (const entry of entries) {
    const key = channelKey(entry.program);
    if (!channels.has(key)) channels.set(key, { label: channelOf(entry.program), tracks: [] });
    const channel = channels.get(key);
    placeTimelineEntry(channel, entry);
  }
  return [...channels.values()];
}

function historyTracks(programs, tuners, range) {
  const identifiedTuners = (tuners || []).filter(tuner => tuner.name || Number.isInteger(tuner.index) && tuner.index >= 0);
  const unidentifiedList = tuners === null || identifiedTuners.length !== tuners.length;
  const rows = identifiedTuners.map((tuner, index) => ({ key: `registered:${index}`, label: tuner.name || `チューナー番号 ${tuner.index ?? '未取得'}`,
    tuner, tracks: [[]] }));
  const historical = new Map();
  const unknown = { key: 'unknown', label: '割当不明', tracks: [[]] };
  let unavailable = 0;
  const entries = programs.flatMap(program => {
    const info = operatorRecordingInfo(program);
    if (info.start === null || info.end === null || info.end <= info.start) { unavailable++; return []; }
    return info.start < range.end && info.end > range.start
      ? [{ program, info, period: { start: info.start, end: info.end } }] : [];
  }).sort((a, b) => a.period.start - b.period.start || a.period.end - b.period.end);
  for (const entry of entries) {
    const { tunerName: name, tunerIndex: index } = entry.info;
    const matches = rows.filter(row => (index === null || row.tuner.index === index) &&
      (name === null || row.tuner.name === name));
    let row;
    if (name === null && index === null || matches.length > 1) row = unknown;
    else if (matches.length === 1) row = matches[0];
    else {
      const key = JSON.stringify([name, index]);
      if (!historical.has(key)) historical.set(key, { key: `past:${key}`, label: `${entry.info.tunerLabel}（${unidentifiedList ? '一覧照合不可' : '現在の一覧外'}）`, tracks: [] });
      row = historical.get(key);
    }
    placeTimelineEntry(row, entry);
  }
  return { rows: [...rows, ...historical.values(), ...(unknown.tracks[0].length ? [unknown] : [])], unavailable, unidentifiedList };
}

function createTimeline(programs, target, targetPeriod, offsetHours, onShift, onContextMenu, general = null, tuners = null) {
  const actual = general?.history === true;
  const range = general === null ? timelineRange(targetPeriod, offsetHours) : {
    start: general.start,
    end: general.start + TIMELINE_DURATION_MS,
    step: TIMELINE_STEP_MS
  };
  const duration = range.end - range.start;
  const history = actual ? historyTracks(programs, tuners, range) : null;
  const entries = actual ? [] : timelineEntries(programs, range);
  const tracks = actual ? history.rows : timelineTracks(entries);
  const segments = actual ? [] : bookingLoadSegments(entries, range);
  segments.forEach(segment => { segment.capacity = capacityIssue(segment.programs, tuners); });
  const overCapacitySegments = segments.filter(segment => segment.capacity?.overCapacity === true);
  const ticks = [];
  for (let at = range.start; at <= range.end; at += range.step) ticks.push(at);
  const position = at => `${(at - range.start) / duration * 100}%`;

  const wrapper = document.createElement('section');
  wrapper.className = 'conflicts-timeline-section';
  const title = document.createElement('h4');
  title.textContent = actual ? 'チューナー別録画実績（3時間表示）' : general === null ? '競合周辺の予約タイムライン（3時間表示）' : '通常の予約タイムライン（3時間表示）';
  const legend = document.createElement('p');
  legend.className = 'conflicts-timeline-note';
  legend.textContent = actual ? 'Operatorの録画開始・終了処理時刻です。TSパケットの先頭・末尾時刻や、チューナーの確保・解放・切替時刻ではありません。' : tuners !== null
    ? '赤い予約バー：Schedulerの競合判定。薄赤の背景・赤い本数帯：GR・BS・CSなどの対応放送波と共用関係を考慮した収容超過の推定区間。録画不能の確定ではありません。'
    : '赤い予約バー：Schedulerの競合判定。チューナー情報を取得できないため、時間帯別の収容超過は判定できません。';
  const controls = document.createElement('div');
  controls.className = 'conflicts-timeline-controls';
  const previous = document.createElement('button');
  previous.type = 'button';
  previous.className = 'button conflicts-timeline-nav';
  previous.textContent = '◀ 1時間前へ';
  previous.addEventListener('click', () => onShift(-1));
  const rangeLabel = document.createElement('span');
  rangeLabel.className = 'conflicts-timeline-range-label';
  rangeLabel.textContent = timeRange(range);
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'button conflicts-timeline-nav';
  reset.textContent = general === null ? '初期位置へ戻る' : '現在へ戻る';
  reset.disabled = general === null ? offsetHours === 0 : general.isCurrent;
  reset.addEventListener('click', () => general === null ? onShift(-offsetHours) : general.onReset());
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'button conflicts-timeline-nav';
  next.textContent = '1時間後へ ▶';
  next.addEventListener('click', () => onShift(1));
  if (general !== null && !general.omitCalendar) {
    const startLabel = document.createElement('div');
    startLabel.className = 'conflicts-timeline-date-label';
    startLabel.textContent = '表示開始';
    const pickerHost = document.createElement('div');
    startLabel.append(pickerHost);
    controls.append(startLabel);
    const calendar = createMonthCalendar(pickerHost, {
      mode: 'datetime',
      value: new Date(general.start),
      onSelect: general.onStartChange
    });
    general.onCalendarCreated?.(calendar);
  }
  controls.append(previous, rangeLabel, reset, next);
  wrapper.append(title, legend, controls);

  const scroller = document.createElement('div');
  scroller.className = 'conflicts-timeline-scroll';
  const chart = document.createElement('div');
  chart.className = 'conflicts-timeline-chart';

  const header = document.createElement('div');
  header.className = 'conflicts-timeline-row is-header';
  const leftHead = document.createElement('div');
  leftHead.className = 'conflicts-timeline-label';
  leftHead.textContent = actual ? '物理チューナー' : '放送局';
  const axis = document.createElement('div');
  axis.className = 'conflicts-timeline-axis';
  ticks.forEach((at, index) => {
    const mark = document.createElement('time');
    mark.className = 'conflicts-timeline-tick';
    if (index === 0) mark.classList.add('is-first');
    if (index === ticks.length - 1) mark.classList.add('is-last');
    mark.style.left = position(at);
    const date = new Date(at);
    mark.dateTime = date.toISOString();
    mark.textContent = (index > 0 && dayFormat.format(at) !== dayFormat.format(at - range.step)
      ? `${dayFormat.format(at)} ` : '') + timeFormat.format(at);
    axis.append(mark);
  });
  header.append(leftHead, axis);
  chart.append(header);

  const focusedId = String(target?.id || '');
  tracks.forEach(channel => channel.tracks.forEach((track, trackIndex) => {
    if (actual && trackIndex > 0) return;
    const row = document.createElement('div');
    row.className = 'conflicts-timeline-row';
    if (actual) row.dataset.historyRow = channel.key;
    const label = document.createElement('div');
    label.className = 'conflicts-timeline-label';
    label.textContent = channel.label + (trackIndex > 0 ? `（${trackIndex + 1}段目）` : '');
    const plot = document.createElement('div');
    plot.className = 'conflicts-timeline-plot';
    if (actual) plot.style.height = `${channel.tracks.length * 37}px`;
    ticks.forEach(at => {
      const line = document.createElement('span');
      line.className = 'conflicts-timeline-gridline';
      line.style.left = position(at);
      plot.append(line);
    });
    overCapacitySegments.forEach(segment => {
      const background = document.createElement('span');
      background.className = 'conflicts-timeline-overcapacity-range';
      background.style.left = position(segment.start);
      background.style.width = `${(segment.end - segment.start) / duration * 100}%`;
      plot.append(background);
    });

    (actual ? channel.tracks : [track]).forEach((lane, laneIndex) => lane.forEach((entry, index) => {
      const id = String(entry.program?.id || '');
      const link = id ? document.createElement('a') : document.createElement('span');
      link.className = 'conflicts-timeline-bar';
      if (actual) link.style.top = `${7 + laneIndex * 37}px`;
      if (!actual && entry.program.isConflict === true) link.classList.add('is-conflict');
      if (focusedId && id === focusedId) link.classList.add('is-focused');
      const previous = lane[index - 1];
      const next = lane[index + 1];
      if (previous && (actual ? previous.period.end === entry.period.start : Math.abs(previous.period.end - entry.period.start) <= 1000)) link.classList.add('is-joined-left');
      if (next && (actual ? entry.period.end === next.period.start : Math.abs(entry.period.end - next.period.start) <= 1000)) link.classList.add('is-joined-right');
      if (entry.period.start < range.start) link.classList.add('is-clipped-left');
      if (entry.period.end > range.end) link.classList.add('is-clipped-right');
      const visibleStart = Math.max(entry.period.start, range.start);
      const visibleEnd = Math.min(entry.period.end, range.end);
      link.style.left = position(visibleStart);
      link.style.width = `${(visibleEnd - visibleStart) / duration * 100}%`;
      const name = titleOf(entry.program);
      link.textContent = name;
      const hover = programHoverInfo(entry.program, { channelLogoUrl: channelLogoUrl(entry.program.channel), statuses: actual ? [] : reservationTags(entry.program) });
      if (actual) {
        link.classList.add('is-actual');
        link.dataset.historySignature = JSON.stringify([name, entry.program.channel, entry.info, entry.program.category]);
        hover.description = `放送局・チャンネル：${channelOf(entry.program)}${entry.program.channel?.channel ? ` / ${entry.program.channel.channel}` : ''}\n使用チューナー：${entry.info.tunerLabel}\n録画開始（Operator）：${entry.info.startLabel}\n録画終了（Operator）：${entry.info.endLabel}`;
        // Do not present the programme's scheduled interval as an actual interval.
        hover.start = null; hover.end = null;
      }
      setProgramHover(link, hover);
      if (id) link.href = programDetailUrl({ id });
      link.setAttribute('aria-label', `${name}、${timeRange(entry.period)}、${channelOf(entry.program)}${entry.program.isConflict ? '、競合判定' : ''}`);
      if (actual) link.setAttribute('aria-label', `${name}、${hover.description.replaceAll('\n', '、')}`);
      if (id && actual) link.addEventListener('click', event => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        openProgramDetailDialog({ id });
      });
      if (id && !actual) {
        const openContext = event => {
          event.preventDefault();
          event.stopPropagation();
          const rect = link.getBoundingClientRect();
          const point = event.type === 'contextmenu' && (event.clientX || event.clientY)
            ? event : { clientX: rect.left + 16, clientY: rect.top + 16 };
          onContextMenu(entry.program, point);
        };
        link.addEventListener('contextmenu', openContext);
        link.addEventListener('keydown', event => {
          if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) openContext(event);
        });
      }
      plot.append(link);
    }));
    row.append(label, plot);
    chart.append(row);
  }));

  if (actual ? tracks.every(row => row.tracks.every(track => track.length === 0)) : tracks.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'conflicts-timeline-empty';
    empty.textContent = actual ? 'この時間帯に表示できる録画実績はありません。' : 'この時間帯に予約はありません。';
    chart.append(empty);
  }
  // Show the booking-count rows in the same chart and scroll area as the
  // reservations. Each column now uses exactly the same time scale.
  if (!actual) appendBookingLoadRows(chart, entries, segments, range, ticks, position);
  scroller.append(chart);
  wrapper.append(scroller);
  const footer = document.createElement('p');
  footer.className = 'conflicts-timeline-note';
  footer.textContent = actual ? `左クリック：番組詳細${history.unavailable ? `。実績時刻が不足または不正な録画 ${history.unavailable}件は非表示です。` : ''}${history.unidentifiedList ? ' チューナー一覧の識別情報が未取得のため、記録された識別情報を表示しています。' : ''}` : general === null
    ? '左クリック：番組詳細　右クリック：番組表と同じ操作メニュー。薄赤の背景は、対応放送波と共用を考慮した収容超過の推定区間です。'
    : '左クリック：番組詳細　右クリック：番組表と同じ操作メニュー。予約本数は使用台数や録画実績とは異なります。';
  wrapper.append(footer);
  return wrapper;
}

function appendBookingLoadRows(chart, entries, segments, range, ticks, position) {
  const activeTypes = new Set(entries.map(entry => entry.program?.channel?.type?.trim()).filter(Boolean));
  const types = ['GR', 'BS', 'CS', 'SKY'].filter(type => activeTypes.delete(type));
  types.push(...[...activeTypes].sort());
  const rows = [{ label: '全予約', type: null }, ...types.map(type => ({ label: type, type }))];
  const peak = Math.max(0, ...segments.map(segment => segment.programs.length));
  const duration = range.end - range.start;

  const headingRow = document.createElement('div');
  headingRow.className = 'conflicts-timeline-row is-load-heading';
  const headingLabel = document.createElement('div');
  headingLabel.className = 'conflicts-timeline-label';
  headingLabel.textContent = '同時予約本数';
  const headingDetail = document.createElement('div');
  headingDetail.className = 'conflicts-load-heading-detail';
  headingDetail.textContent = `最大 ${peak}本（予約の本数であり、チューナーの使用台数ではありません）`;
  headingRow.append(headingLabel, headingDetail);
  chart.append(headingRow);

  rows.forEach(row => {
    const line = document.createElement('div');
    line.className = 'conflicts-timeline-row is-load';
    const label = document.createElement('div');
    label.className = 'conflicts-timeline-label';
    label.textContent = row.label;
    const band = document.createElement('div');
    band.className = 'conflicts-timeline-plot';
    ticks.forEach(at => {
      const gridline = document.createElement('span');
      gridline.className = 'conflicts-timeline-gridline';
      gridline.style.left = position(at);
      band.append(gridline);
    });
    segments.forEach(segment => {
      const count = row.type === null ? segment.programs.length :
        segment.programs.filter(entry => entry.program?.channel?.type === row.type).length;
      if (count === 0) return;
      const block = document.createElement('span');
      block.className = 'conflicts-load-segment';
      block.style.left = position(segment.start);
      block.style.width = `${(segment.end - segment.start) / duration * 100}%`;
      const overCapacity = row.type === null
        ? segment.capacity?.overCapacity === true
        : segment.capacity?.affectedTypes.has(row.type) === true;
      block.style.background = overCapacity ? 'var(--danger)' :
        `color-mix(in srgb, var(--brand) ${Math.min(94, 58 + count * 9)}%, var(--panel))`;
      block.title = `${timeRange(segment)}：${row.label} ${count}本${overCapacity ? `（収容超過の推定：${segment.capacity.detail}）` : ''}`;
      if (segment.end - segment.start >= duration / 22) block.textContent = String(count);
      band.append(block);
    });
    line.append(label, band);
    chart.append(line);
  });
}

function createConflictCard(program, period, programs, offsetHours, onShift, onContextMenu, tuners) {
  const card = document.createElement('section');
  card.className = 'panel conflict-card';
  const heading = document.createElement('div');
  heading.className = 'conflict-card-heading';
  const identity = document.createElement('div');
  identity.className = 'conflict-card-identity';
  const badge = document.createElement('span');
  badge.className = 'conflict-mark';
  badge.textContent = '競合判定';
  const title = document.createElement('h3');
  title.textContent = titleOf(program);
  const meta = document.createElement('p');
  meta.textContent = `${timeRange(period)} · ${channelOf(program)}`;
  identity.append(badge, title, meta);
  heading.append(identity);
  const link = detailLink(program);
  if (link) heading.append(link);
  card.append(heading, createTimeline(programs, program, period, offsetHours, onShift, onContextMenu, null, tuners));
  return card;
}

export function renderConflictsPage(container, { setHeaderActions = () => {} } = {}) {
  let active = true;
  let generation = 0;
  let expiryTimer = null;
  let programs = null;
  let tuners = null;
  let activeMenu = null;
  let ruleDialog = null;
  const preferredRuleUids = new Map();
  const timelineOffsets = new Map();
  let overviewStart = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  let overviewCalendar = null;
  let mode = 'reservation';
  let historyPrograms = null;
  let historyRequest = null;
  let historyGeneration = 0;
  let historyDirty = true;
  let historySignature = null;
  let historyCalendar = null;

  const tabs = document.createElement('div');
  tabs.className = 'conflicts-mode-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'タイムライン表示');
  for (const [value, label] of [['reservation', '予約'], ['history', '実績']]) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'button';
    button.setAttribute('role', 'tab'); button.dataset.mode = value;
    button.setAttribute('aria-selected', String(value === mode));
    button.textContent = label;
    button.addEventListener('click', () => {
      if (mode === value) return;
      programHover.close(); activeMenu?.remove(); activeMenu = null;
      mode = value;
      tabs.querySelectorAll('button').forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.mode === mode)));
      intro.hidden = content.hidden = overview.hidden = mode === 'history';
      historyHost.hidden = mode !== 'history';
      if (mode === 'history') { renderHistory(); void refreshHistory(); }
      else render();
    });
    tabs.append(button);
  }
  setHeaderActions(tabs);

  const page = document.createElement('div');
  page.className = 'conflicts-page';
  const programHover = createProgramHover(page);
  const intro = document.createElement('section');
  intro.className = 'panel conflicts-intro';
  const heading = document.createElement('h2');
  heading.textContent = '予約タイムライン';
  const count = document.createElement('strong');
  count.className = 'conflicts-count';
  count.textContent = '確認中';
  const description = document.createElement('p');
  description.textContent = '競合が予測された予約の前後と、指定日時の予約状況を表示します。時間帯別の収容超過は対応放送波から推定し、実際のチューナー割当は再現していません。';
  intro.append(heading, count, description);
  const content = document.createElement('div');
  content.className = 'conflicts-content';
  const status = document.createElement('p');
  status.className = 'conflicts-message';
  status.textContent = '予約情報を取得しています…';
  content.append(status);
  const overview = document.createElement('section');
  overview.className = 'panel conflicts-overview';
  const historyHost = document.createElement('section');
  historyHost.className = 'panel conflicts-history';
  historyHost.hidden = true;
  page.append(intro, content, overview, historyHost);
  container.replaceChildren(page);

  function changeOverviewStart(timestamp) {
    overviewStart = timestamp;
    if (mode === 'history') renderHistory(); else render();
  }

  function renderHistory() {
    if (!active || mode !== 'history') return;
    if (historyPrograms === null) {
      if (!historyHost.firstChild) historyHost.textContent = '録画実績を取得しています…';
      return;
    }
    const range = { start: overviewStart, end: overviewStart + TIMELINE_DURATION_MS };
    const history = historyTracks(historyPrograms, tuners, range);
    const signature = JSON.stringify([overviewStart, Math.floor(Date.now() / HOUR_MS), history, tuners]);
    if (signature === historySignature) return;
    const current = historyHost.querySelector('.conflicts-timeline-section');
    const incoming = createTimeline(historyPrograms, null, null, 0,
      delta => changeOverviewStart(overviewStart + delta * HOUR_MS), null, {
        history: true, start: overviewStart, omitCalendar: Boolean(current),
        isCurrent: overviewStart === Math.floor(Date.now() / HOUR_MS) * HOUR_MS,
        onStartChange: changeOverviewStart,
        onReset: () => changeOverviewStart(Math.floor(Date.now() / HOUR_MS) * HOUR_MS),
        onCalendarCreated: calendar => { historyCalendar = calendar; }
      }, tuners);
    if (!current) historyHost.replaceChildren(incoming);
    else {
      const chart = current.querySelector('.conflicts-timeline-chart');
      const key = row => row.dataset.historyRow || row.className;
      const rows = new Map(Array.from(chart.children).map(row => [key(row), row]));
      const desired = Array.from(incoming.querySelector('.conflicts-timeline-chart').children).map(row => {
        const retained = rows.get(key(row));
        if (!retained) return row;
        const comparison = retained.cloneNode(true);
        comparison.querySelectorAll('[aria-describedby="program-hover"]').forEach(target => target.removeAttribute('aria-describedby'));
        if (comparison.outerHTML === row.outerHTML) return retained;
        closeRemovedHover(retained);
        return row;
      });
      const wanted = new Set(desired);
      for (const row of Array.from(chart.children)) if (!wanted.has(row)) { closeRemovedHover(row); row.remove(); }
      let cursor = chart.firstChild;
      for (const row of desired) {
        if (row === cursor) cursor = cursor.nextSibling;
        else chart.insertBefore(row, cursor);
      }
      current.querySelector('.conflicts-timeline-range-label').textContent = incoming.querySelector('.conflicts-timeline-range-label').textContent;
      current.querySelectorAll('.conflicts-timeline-nav')[1].disabled = incoming.querySelectorAll('.conflicts-timeline-nav')[1].disabled;
      current.querySelector('.conflicts-timeline-note').textContent = incoming.querySelector('.conflicts-timeline-note').textContent;
      current.lastElementChild.textContent = incoming.lastElementChild.textContent;
      if (historyHost.dataset.start !== String(overviewStart)) historyCalendar.setValue(new Date(overviewStart));
    }
    historyHost.dataset.start = String(overviewStart);
    historySignature = signature;
  }

  function refreshHistory() {
    if (!active || mode !== 'history' || historyRequest || !historyDirty) return historyRequest;
    historyDirty = false;
    const current = historyGeneration;
    historyRequest = loadResource('recorded', { force: true }).then(result => {
      if (!active || current !== historyGeneration) return;
      if (!Array.isArray(result)) throw new Error('録画実績データの形式が正しくありません');
      historyPrograms = result;
      historyHost.querySelector('[data-history-error]')?.remove();
      renderHistory();
    }).catch(error => {
      if (!active) return;
      historyDirty = true;
      const notice = historyHost.querySelector('[data-history-error]') || document.createElement('p');
      notice.dataset.historyError = ''; notice.className = 'conflicts-message';
      notice.textContent = `録画実績を取得できませんでした: ${error.message}`;
      if (historyPrograms === null) historyHost.replaceChildren(notice);
      else if (!notice.isConnected) historyHost.append(notice);
    }).finally(() => {
      historyRequest = null;
      if (active && current !== historyGeneration) void refreshHistory();
    });
    return historyRequest;
  }

  function clearExpiryTimer() {
    if (expiryTimer !== null) window.clearTimeout(expiryTimer);
    expiryTimer = null;
  }

  function openProgramMenu(program, event) {
    activeMenu?.remove();
    activeMenu = createGuideProgramMenu({
      program,
      x: event.clientX,
      y: event.clientY,
      onChanged: () => refresh(true),
      resolveRule: context => {
        const rules = context.detail.rules;
        const linked = {
          ...program,
          ruleUid: program.ruleUid || program.reservationMeta?.ruleUid,
          ruleId: program.ruleId ?? program.reservationMeta?.ruleId,
          isManualReserved: program.isManualReserved === true || program.reservationMeta?.isManualReserved === true
        };
        const action = ruleAction(linked, rules, preferredRuleUids.get(program.id));
        // 番組表と同じ扱い：削除済みのUIDで別のルールを選ばせない。
        if (action.mode === 'unavailable' && action.ruleUid &&
            action.label === '関連ルールは現在の一覧にありません') return { mode: 'create' };
        return action;
      },
      onRule: action => {
        if (action.mode === 'unavailable') {
          location.hash = programDetailUrl({ id: program.id });
          return;
        }
        ruleDialog = openRuleEditorDialog({
          row: action.mode === 'edit' ? { index: action.index, uid: action.ruleUid, rule: action.rule } : null,
          initialRule: action.mode === 'create' ? programRuleSeed({
            title: program.title || program.fullTitle,
            type: program.channel?.type,
            channel: program.channel?.id,
            category: program.category
          }) : null,
          title: action.mode === 'edit' ? `ルール #${action.index + 1} を編集` : 'ルールを作成',
          onSaved: async result => {
            if (result.mode === 'create' && result.rule?.ruleUid) {
              preferredRuleUids.set(program.id, result.rule.ruleUid);
            }
            await refresh(true);
          },
          onDeleted: async () => {
            preferredRuleUids.delete(program.id);
            await refresh(true);
          }
        });
      }
    });
    activeMenu.dataset.programId = String(program.id || '');
    activeMenu.dataset.programSignature = JSON.stringify(program);
  }

  const conflictCards = new Map();
  let overviewSignature = null;
  function closeRemovedHover(element) {
    if (element.querySelector('[aria-describedby="program-hover"]')) programHover.close();
  }
  function render() {
    if (!active || programs === null || mode !== 'reservation') return;
    const now = Date.now();
    const conflicts = programs.filter(program => program?.isConflict === true && program.isSkip !== true &&
      interval(program)?.end > now).sort((a, b) => interval(a).start - interval(b).start);
    clearExpiryTimer();
    if (activeMenu && activeMenu.dataset.programSignature !== JSON.stringify(programs.find(program => String(program.id || '') === activeMenu.dataset.programId))) {
      activeMenu.remove(); activeMenu = null;
    }
    count.textContent = `競合 ${conflicts.length}件`;
    const desired = [];
    const keys = new Set();
    conflicts.forEach(program => {
      const id = String(program.id || '');
      keys.add(id);
      const offsetHours = timelineOffsets.get(id) || 0;
      const period = interval(program);
      const signature = JSON.stringify([program, timelineEntries(programs, timelineRange(period, offsetHours)), tuners, offsetHours]);
      let entry = conflictCards.get(id);
      if (entry?.signature !== signature) {
        const element = createConflictCard(program, period, programs, offsetHours, delta => {
          timelineOffsets.set(id, (timelineOffsets.get(id) || 0) + delta);
          render();
        }, openProgramMenu, tuners);
        if (entry) { closeRemovedHover(entry.element); entry.element.replaceWith(element); }
        entry = { element, signature };
        conflictCards.set(id, entry);
      }
      desired.push(entry.element);
    });
    for (const [id, entry] of conflictCards) {
      if (keys.has(id)) continue;
      closeRemovedHover(entry.element);
      entry.element.remove(); conflictCards.delete(id); timelineOffsets.delete(id);
    }
    if (!conflicts.length) {
      if (content.querySelector('.conflicts-message')?.textContent !== '現在、未終了の競合予約はありません。') {
        const empty = document.createElement('p');
        empty.className = 'panel conflicts-message';
        empty.textContent = '現在、未終了の競合予約はありません。';
        content.replaceChildren(empty);
      }
    } else {
      content.querySelector('.conflicts-message')?.remove();
      let cursor = content.firstChild;
      for (const element of desired) {
        if (element === cursor) cursor = cursor.nextSibling;
        else content.insertBefore(element, cursor);
      }
    }

    const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS;
    const nextOverviewSignature = JSON.stringify([overviewStart, currentHour, tuners,
      timelineEntries(programs, { start: overviewStart, end: overviewStart + TIMELINE_DURATION_MS })]);
    if (overviewSignature !== nextOverviewSignature) {
      closeRemovedHover(overview);
      overviewCalendar?.destroy();
      overviewCalendar = null;
      overview.replaceChildren(createTimeline(programs, null, null, 0, delta => {
        changeOverviewStart(overviewStart + delta * HOUR_MS);
      }, openProgramMenu, {
        start: overviewStart,
        isCurrent: overviewStart === currentHour,
        onStartChange: changeOverviewStart,
        onReset: () => changeOverviewStart(Math.floor(Date.now() / HOUR_MS) * HOUR_MS),
        onCalendarCreated: calendar => { overviewCalendar = calendar; }
      }, tuners));
      overviewSignature = nextOverviewSignature;
    }

    const endTimes = programs.map(program => interval(program)?.end).filter(end => end > now);
    if (endTimes.length) {
      expiryTimer = window.setTimeout(render, Math.min(Math.min(...endTimes) - now + 20, 0x7fffffff));
    }
  }

  function refresh(force = false) {
    const current = ++generation;
    if (force) invalidateResources(['reserves']);
    Promise.all([loadResource('reserves'), loadTuners().catch(() => null)]).then(([result, availableTuners]) => {
      if (!active || current !== generation) return;
      if (!Array.isArray(result)) throw new Error('予約データの形式が正しくありません');
      programs = result;
      tuners = availableTuners;
      render();
      renderHistory();
    }).catch(() => {
      if (!active || current !== generation) return;
      if (programs !== null) {
        count.textContent = '更新失敗（前回の表示を保持）';
        return;
      }
      clearExpiryTimer();
      count.textContent = '取得失敗';
      const message = document.createElement('p');
      message.className = 'panel conflicts-message';
      message.textContent = '予約情報を更新できません。再度ページを開くか、接続状態をご確認ください。';
      content.replaceChildren(message);
      overviewCalendar?.destroy();
      overviewCalendar = null;
      overview.replaceChildren();
    });
  }

  const unsubscribe = subscribeReservationNotifications(() => refresh(true));
  const unsubscribeRecorded = subscribeRecordedNotifications(() => {
    invalidateResources(['recorded']);
    historyGeneration++;
    historyDirty = true;
    void refreshHistory();
  });
  refresh();
  return () => {
    active = false;
    programHover.dispose();
    generation++;
    clearExpiryTimer();
    activeMenu?.remove();
    overviewCalendar?.destroy();
    historyCalendar?.destroy();
    ruleDialog?.close();
    unsubscribe();
    unsubscribeRecorded();
    setHeaderActions();
  };
}
