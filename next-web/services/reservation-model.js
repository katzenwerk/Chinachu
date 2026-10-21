import { channelDetailText, channelIdentifier, channelLogoUrl } from './recording-model.js';
import { buildReservationStorageDisplay } from './storage-model.js';
import { programDetailUrl } from './program-detail-client.js';

export const NEXT_RESERVATION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const NEXT_RESERVATION_MAX_ITEMS = 8;
export const NEXT_RESERVATION_MAX_GROUPS = 5;
export const RESERVATION_DISPLAY_LEAD_MS = 30 * 1000;

const dateFormatter = new Intl.DateTimeFormat('ja-JP', {
  month: '2-digit',
  day: '2-digit'
});
const timeFormatter = new Intl.DateTimeFormat('ja-JP', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});
const listTimeFormatter = new Intl.DateTimeFormat('ja-JP', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});
const listDateFormatter = new Intl.DateTimeFormat('ja-JP', {
  month: '2-digit',
  day: '2-digit',
  weekday: 'short'
});

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function reservationEnd(program, start) {
  if (finite(program.end) && program.end > start) return program.end;
  return finite(program.seconds) && program.seconds > 0 ? start + program.seconds * 1000 : null;
}

function formatTime(value) {
  return value === null ? '未取得' : timeFormatter.format(new Date(value));
}

function formatListTime(value) {
  return value === null ? '未取得' : listTimeFormatter.format(new Date(value));
}

function validText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function normalizeSearchText(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('ja-JP');
}

function normalizeDisplayText(value, preserveLineBreaks = false) {
  const text = validText(value);
  if (text === null) return null;
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
    .map(line => line.replace(/[\t\f\v ]+/g, ' ').trim())
    .filter(Boolean);
  return lines.join(preserveLineBreaks ? '\n' : ' ');
}

function formatListDate(value) {
  return value === null ? '日付未取得' : listDateFormatter.format(new Date(value)).replace(/\s/g, '');
}

function formatDateInputValue(value) {
  if (value === null) return null;
  const date = new Date(value);
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function reservationTags(program) {
  const tags = [];
  if (program.isSkip === true) tags.push({ key: 'skip', label: 'スキップ' });
  if (program.isConflict === true) tags.push({ key: 'conflict', label: '競合' });
  tags.push(program.isManualReserved === true
    ? { key: 'manual', label: '手動予約' }
    : { key: 'rule', label: 'ルール予約' });
  return tags;
}

export function isReservationDisplayTarget(program, now = Date.now()) {
  return finite(program?.start) && finite(now) && program.start - now >= RESERVATION_DISPLAY_LEAD_MS;
}

export function nextReservationDisplayBoundaryDelay(programs, now = Date.now()) {
  if (!Array.isArray(programs) || !finite(now)) return null;
  const delays = programs
    .filter(program => isReservationDisplayTarget(program, now))
    .map(program => program.start - now - RESERVATION_DISPLAY_LEAD_MS);
  if (delays.length === 0) return null;
  return Math.max(1, Math.min(...delays) + 1);
}

export function buildReservationListModels(programs, options = {}) {
  if (!Array.isArray(programs)) throw new Error('Reserves API response is invalid');
  const now = finite(options.now) ? options.now : Date.now();
  return programs.filter(program => isReservationDisplayTarget(program, now))
    .sort((a, b) => (Number(a?.start) || 0) - (Number(b?.start) || 0)).map((program, index) => {
    const start = finite(program?.start) && program.start > 0 ? program.start : null;
    const end = start === null ? null : reservationEnd(program, start);
    const channel = program?.channel && typeof program.channel === 'object' ? program.channel : {};
    const identifier = channelIdentifier(channel);
    const channelName = validText(channel.name);
    const fullTitle = validText(program?.fullTitle) || validText(program?.title) || 'タイトル未取得';
    const longDurationDays = start !== null && end !== null && end - start >= 24 * 60 * 60 * 1000
      ? Math.floor((end - start) / (24 * 60 * 60 * 1000))
      : 0;
    const durationNotice = longDurationDays > 0 ? `（+${longDurationDays}日）` : '';
    const id = validText(program?.id);
    const category = validText(program?.category) || 'ジャンル未取得';
    const storageDisplay = buildReservationStorageDisplay(options.storageData, program);
    const searchText = [
      fullTitle,
      validText(program?.title),
      validText(program?.subTitle),
      validText(program?.description),
      validText(program?.detail),
      channelName,
      identifier,
      category
    ].filter(Boolean).map(normalizeSearchText).join('\n');
    return {
      key: id || `reservation-list-${start || 'unknown'}-${index}`,
      id,
      detailUrl: programDetailUrl({ id }),
      fullTitle,
      displayTitle: normalizeDisplayText(fullTitle) || 'タイトル未取得',
      detail: normalizeDisplayText(program?.detail, true),
      category,
      start,
      dateValue: formatDateInputValue(start),
      dateText: formatListDate(start),
      timeText: `${formatListTime(start)}–${formatListTime(end)}${durationNotice}`,
      channelName: channelName || 'チャンネル未取得',
      channelId: channel.id === undefined || channel.id === null || channel.id === '' ? null : String(channel.id),
      channelIdentifier: identifier,
      channelLogoUrl: channelLogoUrl(channel),
      channelFallbackText: identifier || channelName || '不明',
      channelTooltip: channelDetailText(channel),
      searchText,
      tags: reservationTags(program),
      storageTag: storageDisplay.tag,
      storageNotice: storageDisplay.notice,
      isSkip: program?.isSkip === true,
      isConflict: program?.isConflict === true,
      isManualReserved: program?.isManualReserved === true,
      ruleUid: validText(program?.ruleUid) || validText(program?.reservationMeta?.ruleUid),
      ruleId: program?.ruleId === undefined || program.ruleId === null ? null : String(program.ruleId)
    };
  });
}

export function filterReservationListModels(models, filters = {}) {
  const search = normalizeSearchText(validText(filters.search) || '');
  const status = ['normal', 'skip', 'conflict'].includes(filters.status) ? filters.status : 'all';
  const ruleUid = validText(filters.ruleUid);
  const channelId = filters.channelId === undefined || filters.channelId === null || filters.channelId === ''
    ? null : String(filters.channelId);
  const ruleId = filters.ruleId === undefined || filters.ruleId === null || filters.ruleId === ''
    ? null
    : String(filters.ruleId);
  return models.filter(model => {
    if (ruleUid !== null && model.ruleUid !== ruleUid) return false;
    if (channelId !== null && model.channelId !== channelId) return false;
    if (ruleUid === null && ruleId !== null && model.ruleId !== ruleId) return false;
    if (search !== '' && !model.searchText.includes(search)) return false;
    if (status === 'normal' && (model.isSkip || model.isConflict)) return false;
    if (status === 'skip' && !model.isSkip) return false;
    if (status === 'conflict' && !model.isConflict) return false;
    return true;
  });
}

export function findReservationDateJumpTarget(models, dateValue) {
  if (typeof dateValue !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return null;
  const [year, month, day] = dateValue.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  const startOfDay = date.getTime();
  if (!Number.isFinite(startOfDay)) return null;
  const index = models.findIndex(model => finite(model.start) && model.start >= startOfDay);
  return index === -1 ? null : { index, model: models[index] };
}

export function paginateReservationListModels(models, pageNumber = 1, pageSize = 25) {
  const size = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 25;
  const totalPages = Math.max(1, Math.ceil(models.length / size));
  const page = Math.min(Math.max(1, Number.isInteger(pageNumber) ? pageNumber : 1), totalPages);
  const offset = (page - 1) * size;
  return {
    page,
    pageSize: size,
    total: models.length,
    totalPages,
    first: models.length === 0 ? 0 : offset + 1,
    last: Math.min(offset + size, models.length),
    items: models.slice(offset, offset + size)
  };
}

export function buildNextReservationView(programs, now = Date.now(), options = {}) {
  if (!Array.isArray(programs)) throw new Error('Reserves API response is invalid');
  const windowMs = finite(options.windowMs) && options.windowMs > 0
    ? options.windowMs
    : NEXT_RESERVATION_WINDOW_MS;
  const maxItems = Number.isInteger(options.maxItems) && options.maxItems > 0
    ? options.maxItems
    : NEXT_RESERVATION_MAX_ITEMS;
  const windowEnd = now + windowMs;
  const eligible = programs.filter(program => {
    const start = program && program.start;
    return isReservationDisplayTarget(program, now) && start <= windowEnd &&
      program.isSkip !== true && program.isConflict !== true &&
      !(finite(program.operatorRecordingStart) && program.operatorRecordingStart > 0);
  }).sort((a, b) => a.start - b.start);

  return {
    total: eligible.length,
    items: eligible.slice(0, maxItems).map((program, index) => {
      const channel = program.channel && typeof program.channel === 'object' ? program.channel : {};
      const identifier = channelIdentifier(channel);
      const start = program.start;
      const end = reservationEnd(program, start);
      const storageDisplay = buildReservationStorageDisplay(options.storageData, program);
      return {
        key: typeof program.id === 'string' && program.id !== '' ? program.id : `reservation-${start}-${index}`,
        detailUrl: programDetailUrl({ id: program.id }),
        start,
        dateText: dateFormatter.format(new Date(start)),
        timeText: `${formatTime(start)}–${formatTime(end)}`,
        timelineDateKey: formatDateInputValue(start),
        timelineDateText: formatListDate(start),
        timelineTimeText: formatListTime(start),
        durationText: end === null ? null : `${Math.max(1, Math.round((end - start) / 60000))}分`,
        title: String(program.title || program.fullTitle || 'タイトル未取得'),
        timelineTitle: String(program.fullTitle || program.title || 'タイトル未取得'),
        channelName: String(channel.name || 'チャンネル未取得'),
        channelText: [String(channel.name || 'チャンネル未取得'), identifier].filter(Boolean).join(' · '),
        channelLogoUrl: channelLogoUrl(channel),
        channelFallbackText: String(channel.name || identifier || 'チャンネル未取得'),
        channelTooltip: channelDetailText(channel),
        reservationTypeText: program.isManualReserved === true ? '手動予約' : 'ルール予約',
        storageNotice: storageDisplay.notice
      };
    })
  };
}

export function buildNextReservationTimelineView(programs, now = Date.now(), options = {}) {
  const maxGroups = Number.isInteger(options.maxGroups) && options.maxGroups > 0
    ? options.maxGroups
    : NEXT_RESERVATION_MAX_GROUPS;
  const view = buildNextReservationView(programs, now, {
    ...options,
    maxItems: Number.MAX_SAFE_INTEGER
  });
  const groups = [];

  view.items.forEach(item => {
    let group = groups[groups.length - 1];
    if (!group || group.start !== item.start) {
      group = {
        key: `${item.timelineDateKey || 'unknown'}-${item.start}`,
        start: item.start,
        dateKey: item.timelineDateKey,
        dateText: item.timelineDateText,
        timeText: item.timelineTimeText,
        items: []
      };
      groups.push(group);
    }
    group.items.push(item);
  });

  return {
    total: view.total,
    groups: groups.slice(0, maxGroups)
  };
}
