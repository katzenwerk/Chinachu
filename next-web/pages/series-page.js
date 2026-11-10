import { createChannelLogo } from '../components/channel-logo.js';
import { createProgramHover, programHoverInfo, setProgramHover } from '../components/program-hover.js';
import { appendMobileContextButton } from '../components/mobile-layout.js';
import { openProgramDetailDialog } from '../components/program-detail-dialog.js';
import { openSeriesBulkCorrectionDialog, openSeriesCorrectionDialog } from '../components/series-correction-dialog.js';
import { createSeriesContextMenu } from '../components/series-context-menu.js';
import { createRecordedContextMenu } from '../components/recorded-context-menu.js';
import { createHomeProgramContextMenu } from '../components/home-program-context-menu.js';
import { openRecordedPlaybackOverlay } from '../services/live-player-adapter.js';
import { recordedResultWarnings } from '../services/recorded-result-warnings.js';
import { loadSeriesProjection, loadSeriesStatus, removeSeriesOverride, setSeriesHidden } from '../services/series-client.js';
import { buildSeriesEventIndex, seriesEventHref } from '../services/series-event-model.js';
import { subscribeRecordedThumbnailReady } from '../services/recorded-thumbnail-client.js';
import {
  subscribeMatchNotifications, subscribeRecordedNotifications, subscribeReservationNotifications, subscribeSeriesNotifications
} from '../services/realtime-client.js';

const SIZE_KEY = 'chinachu.next.series.cardSize';
const COLUMNS_KEY = 'chinachu.next.series.columns';
const VIEW_KEY = 'chinachu.next.series.view';
const TABS = new Set(['all', 'reservations', 'recordings', 'attention']);

const dateTimeFormatter = new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function dateTime(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? dateTimeFormatter.format(new Date(number)) : '日時未取得';
}

function createAvailabilityDialog(availability) {
  const dialog = document.createElement('dialog');
  dialog.className = 'series-data-dialog';
  const header = document.createElement('div');
  header.className = 'series-data-dialog-heading';
  const heading = document.createElement('h2');
  heading.textContent = '辞書・放送情報の取得状態';
  const beta = document.createElement('span');
  beta.className = 'badge series-beta-badge';
  beta.textContent = 'Beta';
  header.append(heading, beta);
  const purpose = document.createElement('p');
  purpose.className = 'series-data-description';
  purpose.textContent = 'しょぼいカレンダーの作品・話数・副題などを参照し、番組情報を補完します。取得済みの情報は、インターネットに接続できない場合も利用できます。';
  const message = document.createElement('p');
  message.className = `series-availability is-${availability?.status || 'unknown'}`;
  message.textContent = availability?.message || '放送情報は利用可能です。';
  const technical = availability?.technical;
  const coverage = Array.isArray(technical?.coverage) ? technical.coverage : [];
  const starts = coverage.map(item => Number(item.startMs)).filter(Number.isFinite);
  const ends = coverage.map(item => Number(item.endMs)).filter(Number.isFinite);
  const range = starts.length && ends.length
    ? `${dateTime(Math.min(...starts))} ～ ${dateTime(Math.max(...ends))}` : '未取得';
  const error = technical?.lastError;
  const list = document.createElement('dl');
  const dictionary = availability?.dictionaryStatus;
  for (const [label, value] of [
    ['作品辞書', dictionary?.message || (availability?.dictionary === 'disabled' ? '連携無効' : '状態未取得')],
    ['辞書取得件数', dictionary?.total !== null && dictionary?.total !== undefined
      ? `${dictionary.completed} / ${dictionary.total}作品` : '未取得'],
    ['辞書登録作品数', String(dictionary?.published?.counts?.titles ?? 0)],
    ['辞書最終成功', dictionary?.published?.lastSuccessAt ? dateTime(dictionary.published.lastSuccessAt) : 'なし'],
    ['辞書次回試行', dictionary?.nextAttemptAt ? dateTime(dictionary.nextAttemptAt) : '処理中または未定'],
    ['辞書最終失敗', dictionary?.lastError ? dictionary.lastError.message : 'なし'],
    ['状態', technical?.updating ? `取得中${technical.updateKind ? ` (${technical.updateKind})` : ''}` : '待機中'],
    ['最終成功', technical?.lastSuccessAt ? dateTime(technical.lastSuccessAt) : 'なし'],
    ['取得済み範囲', range],
    ['対象ChID', technical?.targetChIds?.length ? technical.targetChIds.join(', ') : 'なし'],
    ['保存番組数', String(technical?.programCount ?? 0)],
    ['直近更新件数', String(technical?.lastUpdateCount ?? 0)],
    ['次回差分取得', technical?.nextDeltaAt ? dateTime(technical.nextDeltaAt) : '未定'],
    ['次回完全取得', technical?.nextFullAt ? dateTime(technical.nextFullAt) : '未定'],
    ['最終失敗', error ? `${dateTime(error.at)} ${text(error.message, error.code || '原因不明')}` : 'なし']
  ]) {
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    description.textContent = value;
    list.append(term, description);
  }
  const actions = document.createElement('div');
  actions.className = 'series-data-dialog-actions';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'button primary';
  close.textContent = '閉じる';
  close.addEventListener('click', () => dialog.close());
  actions.append(close);
  dialog.append(header, purpose, message);
  list.hidden = !technical && !dictionary;
  dialog.append(list, actions);
  dialog.updateAvailability = next => {
    const fresh = createAvailabilityDialog(next);
    const nextMessage = fresh.querySelector('.series-availability');
    message.className = nextMessage.className;
    message.textContent = nextMessage.textContent;
    const values = [...fresh.querySelectorAll('dd')];
    [...list.querySelectorAll('dd')].forEach((entry, index) => {
      if (entry.textContent !== values[index]?.textContent) entry.textContent = values[index]?.textContent || '';
    });
    list.hidden = fresh.querySelector('dl').hidden;
  };
  return dialog;
}

function readPreference(key, allowed, fallback) {
  try {
    const value = window.localStorage.getItem(key);
    return allowed.includes(value) ? value : fallback;
  } catch (_) {
    return fallback;
  }
}

function writePreference(key, value) {
  try { window.localStorage.setItem(key, value); } catch (_) {}
}

function link(href, label, className = '') {
  const element = document.createElement('a');
  element.href = href;
  element.className = className;
  element.textContent = label;
  return element;
}

function makeTabs(active) {
  const tabs = document.createElement('div');
  tabs.className = 'series-tabs';
  tabs.setAttribute('role', 'tablist');
  for (const [key, label] of [['all', 'すべて'], ['recordings', '録画済み'], ['reservations', '予約'], ['attention', '要確認']]) {
    const item = link(`#series?tab=${key}`, label);
    item.setAttribute('role', 'tab');
    item.setAttribute('aria-selected', String(active === key));
    tabs.append(item);
  }
  return tabs;
}

function makeViewSwitch(active, onChange) {
  const controls = document.createElement('div');
  controls.className = 'recorded-view-switch series-view-switch';
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', '表示形式');
  for (const [value, label, icon] of [
    ['list', 'リスト表示', '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'],
    ['card', 'カード表示', '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>']
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(active === value));
    button.dataset.seriesView = value;
    button.innerHTML = `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24">${icon}</svg>`;
    button.addEventListener('click', () => onChange(value));
    controls.append(button);
  }
  return controls;
}

function makeDataButton(dialog, availability) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `button series-data-button series-availability-button is-${availability?.status || 'unknown'}`;
  button.textContent = 'データ取得状態';
  button.addEventListener('click', () => dialog.showModal());
  return button;
}

function createHiddenSeriesDialog(items, onRestore) {
  const dialog = document.createElement('dialog');
  dialog.className = 'series-data-dialog series-hidden-dialog';
  const heading = document.createElement('h2');
  heading.textContent = '非表示シリーズ';
  const list = document.createElement('div');
  list.className = 'series-hidden-list';
  const rows = new Map();
  const pendingRemovals = new Map();
  dialog.updateItems = (nextItems, manualGeneration = 0) => {
    const wanted = new Set();
    for (const item of nextItems) {
      const tid = Number(item.tid);
      if (pendingRemovals.has(tid)) {
        if (manualGeneration < pendingRemovals.get(tid)) continue;
        pendingRemovals.delete(tid);
      }
      wanted.add(tid);
      let entry = rows.get(tid);
      if (!entry) {
        const row = document.createElement('div');
        row.className = 'series-hidden-row';
        const label = document.createElement('div');
        const title = document.createElement('strong');
        const id = document.createElement('span');
        id.textContent = `TID ${tid}`;
        label.append(title, id);
        const restore = document.createElement('button');
        restore.type = 'button';
        restore.className = 'button';
        restore.textContent = '再表示';
        restore.addEventListener('click', async () => {
          restore.disabled = true;
          try {
            const result = await onRestore(tid);
            pendingRemovals.set(tid, result.manualGeneration);
            rows.get(tid)?.row.remove();
            row.remove(); rows.delete(tid);
            if (!list.childElementCount) dialog.close();
          } catch (error) {
            restore.disabled = false;
            window.alert(`シリーズを再表示できませんでした: ${error.message}`);
          }
        });
        row.append(label, restore);
        entry = { row, title };
        rows.set(tid, entry);
        list.append(row);
      }
      entry.title.textContent = text(item.title, '作品名未取得');
    }
    for (const [tid, entry] of rows) {
      if (!wanted.has(tid)) { entry.row.remove(); rows.delete(tid); }
    }
  };
  dialog.updateItems(items);
  const actions = document.createElement('div');
  actions.className = 'series-data-dialog-actions';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'button primary';
  close.textContent = '閉じる';
  close.addEventListener('click', () => dialog.close());
  actions.append(close);
  dialog.append(heading, list, actions);
  return dialog;
}

function makeHiddenSeriesButton(dialog, count) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button series-data-button series-hidden-button';
  button.textContent = `非表示（${count}）`;
  button.addEventListener('click', () => dialog.showModal());
  return button;
}

function makeHeaderActions({
  tab, viewMode, availability, dialog, hiddenDialog, hiddenSeries = [], searchControl = null,
  onViewChange, detailControls = []
}) {
  const actions = document.createElement('div');
  actions.className = 'series-header-toolbar';
  if (tab) {
    const primary = document.createElement('div');
    primary.className = 'series-header-primary';
    primary.append(makeTabs(tab));
    if (tab !== 'attention') primary.append(makeViewSwitch(viewMode, onViewChange));

    const secondary = document.createElement('div');
    secondary.className = 'series-header-secondary';
    if (hiddenSeries.length) secondary.append(makeHiddenSeriesButton(hiddenDialog, hiddenSeries.length));
    secondary.append(makeDataButton(dialog, availability));
    if (searchControl) secondary.append(searchControl);

    actions.append(primary, secondary);
  } else if (detailControls.length) {
    const detail = document.createElement('div');
    detail.className = 'series-header-detail';
    for (const control of detailControls) detail.append(control);
    actions.append(detail);
  }
  return actions;
}

function seriesRows(data, tab) {
  return tab === 'attention' ? data.attention : data.series;
}

function seriesHref(data, item, tab) {
  const seriesId = item.id && data.series.some(series => series.id === item.id) ? item.id : item.seriesId || null;
  const eventKey = item.firstEventKey || item.events?.[0]?.key;
  return seriesId ? `#series?tab=${tab}&id=${encodeURIComponent(seriesId)}` :
    eventKey ? `#series?tab=attention&event=${encodeURIComponent(eventKey)}` : `#series?tab=${tab}`;
}

function knownEpisodeCount(item) {
  if (Number.isInteger(item.counts?.knownEpisodes)) return item.counts.knownEpisodes;
  return new Set((item.episodes || []).filter(episode => episode.confirmed && episode.number !== null)
    .map(episode => episode.number)).size;
}

function seriesEpisodeSummary(item) {
  const latest = Number.isInteger(item.latestAvailableEpisode) ? `${item.latestAvailableEpisode}話` : '—';
  return `EP${knownEpisodeCount(item)}話　最新${latest}`;
}

// Keep the entry itself stable; handlers always read the latest series object.
const seriesListStates = new WeakMap();

function setContent(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

function appendSeriesMenuButton(host, state) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'series-item-menu-button';
  button.textContent = '⋯';
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    const item = state.item;
    const rect = button.getBoundingClientRect();
    state.context.openSeriesMenu({ kind: 'series', tid: item.tid, hidden: item.hidden === true, series: item }, {
      x: rect.right, y: rect.bottom
    });
  });
  host.append(button);
  state.menuButton = button;
}

function attachSeriesOperations(target, state) {
  const open = ({ x, y }) => {
    const item = state.item;
    state.context.openSeriesMenu({ kind: 'series', tid: item.tid, hidden: item.hidden === true, series: item }, { x, y });
  };
  target.addEventListener('contextmenu', event => {
    event.preventDefault();
    event.stopPropagation();
    open({ x: event.clientX, y: event.clientY });
  });
  target.addEventListener('keydown', event => {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = target.getBoundingClientRect();
    open({ x: rect.left + Math.min(rect.width, 48), y: rect.top + Math.min(rect.height, 40) });
  });
}

function seriesListMeta(item, tab) {
  if (tab === 'attention') return `${item.label} · ${item.eventCount ?? item.events.length}件${item.progLookupLabel ? ` · ${item.progLookupLabel}` : ''}${item.candidateTids?.length ? ` · TID候補 ${item.candidateTids.join(', ')}` : ''}`;
  const recordings = item.counts.currentRecordings;
  const missing = item.counts.missingRecordings ? ` · 行方不明 ${item.counts.missingRecordings}件` : '';
  if (tab === 'reservations') {
    return `${seriesEpisodeSummary(item)} · ${item.counts.reservations}件予約 · 録画 ${recordings}件${missing} · 次回 ${dateTime(item.nextReservationAt)}${item.nextReservationChannel ? ` · ${item.nextReservationChannel}` : ''}`;
  }
  if (tab === 'recordings') {
    return `${seriesEpisodeSummary(item)} · ${recordings}件録画 · 予約 ${item.counts.reservations}件 · 最終録画 ${dateTime(item.latestRecordingAt)}`;
  }
  if (tab === 'all') return `${seriesEpisodeSummary(item)} · 録画 ${recordings}件${missing} · 予約 ${item.counts.reservations}件`;
  return `${item.label} · ${item.eventCount ?? item.events.length}件${item.progLookupLabel ? ` · ${item.progLookupLabel}` : ''}${item.candidateTids?.length ? ` · TID候補 ${item.candidateTids.join(', ')}` : ''}`;
}

function syncAttentionSelection(state) {
  const selection = state.selection;
  if (!selection) return;
  const selected = state.context.selectedAttentionEvents;
  const count = selection.keys.filter(key => selected.has(key)).length;
  selection.checkbox.checked = selection.keys.length > 0 && count === selection.keys.length;
  selection.checkbox.indeterminate = count > 0 && count < selection.keys.length;
  for (const [key, input] of selection.individual) input.checked = selected.has(key);
}

function appendAttentionSelection(entry, state) {
  const host = document.createElement('div');
  host.className = 'series-attention-selection';
  const label = document.createElement('label');
  label.className = 'series-attention-select-all';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  const labelText = document.createElement('span');
  label.append(checkbox, labelText);
  host.append(label);
  checkbox.addEventListener('change', () => {
    state.context.changeAttentionSelection(state.selection.keys, checkbox.checked);
  });
  state.selection = { host, checkbox, labelText, keys: [], signature: null, details: null, individual: [] };
  entry.prepend(host);
}

function updateAttentionSelection(state, item) {
  const selection = state.selection;
  if (!selection) return;
  const events = (item.selectionEvents || []).filter(event => event?.key);
  const signature = JSON.stringify(events);
  if (signature !== selection.signature) {
    selection.signature = signature;
    selection.keys = events.map(event => event.key);
    selection.host.hidden = events.length === 0;
    setContent(selection.labelText, `選択 (${events.length}件)`);
    selection.individual = [];
    if (events.length > 1) {
      if (!selection.details) {
        selection.details = document.createElement('details');
        selection.details.className = 'series-attention-select-details';
        const summary = document.createElement('summary');
        summary.textContent = '個別に選択';
        selection.details.append(summary);
        selection.host.append(selection.details);
      }
      const details = selection.details;
      const summary = details.querySelector('summary');
      const labels = events.map(event => {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        const description = document.createElement('span');
        description.textContent = `${text(event.fullTitle, text(event.title, '番組名未取得'))} · ${dateTime(event.start)}${event.channelName ? ` · ${event.channelName}` : ''}`;
        label.append(input, description);
        input.addEventListener('change', () => state.context.changeAttentionSelection([event.key], input.checked));
        selection.individual.push([event.key, input]);
        return label;
      });
      const options = document.createElement('div');
      options.className = 'series-attention-select-options';
      options.append(...labels);
      details.replaceChildren(summary, options);
    } else if (selection.details) {
      selection.details.remove();
      selection.details = null;
    }
  }
  syncAttentionSelection(state);
}

function createSeriesListEntry(cardMode, tab) {
  const entry = document.createElement(cardMode ? 'article' : 'div');
  entry.className = cardMode ? 'series-list-card-entry' : 'series-list-entry';
  if (tab === 'attention') entry.classList.add('is-attention');
  const link = document.createElement('a');
  link.className = cardMode ? 'series-list-card' : 'series-list-row';
  const state = { item: null, context: null, link, title: null, summary: null, menuButton: null, media: null, tid: null, thumbnailUrl: undefined, selection: null };
  seriesListStates.set(entry, state);
  if (cardMode) {
    attachSeriesOperations(link, state);
    const media = document.createElement('div');
    media.className = 'series-list-card-media';
    const body = document.createElement('div');
    body.className = 'series-list-card-body';
    const primary = document.createElement('div');
    primary.className = 'series-list-card-primary';
    state.title = document.createElement('strong');
    state.tid = document.createElement('span');
    state.summary = document.createElement('div');
    state.summary.className = 'series-list-card-summary';
    primary.append(state.title, state.tid);
    body.append(primary, state.summary);
    link.append(media, body);
    entry.append(link);
    state.media = media;
  } else {
    if (tab !== 'attention') attachSeriesOperations(link, state);
    const body = document.createElement('div');
    body.className = 'series-list-main';
    state.title = document.createElement('strong');
    state.summary = document.createElement('span');
    body.append(state.title, state.summary);
    link.append(body);
    entry.append(link);
  }
  if (tab === 'attention') appendAttentionSelection(entry, state);
  else appendSeriesMenuButton(entry, state);
  return entry;
}

function updateSeriesListEntry(entry, item, data, tab, context) {
  const state = seriesListStates.get(entry);
  state.item = item;
  state.context = context;
  const href = seriesHref(data, item, tab);
  if (state.link.getAttribute('href') !== href) state.link.setAttribute('href', href);
  const title = text(item.title, '作品名未取得');
  setContent(state.title, title);
  setContent(state.summary, state.media
    ? `${seriesEpisodeSummary(item)} · 録画 ${item.counts.currentRecordings}件${item.counts.missingRecordings ? ` · 行方不明 ${item.counts.missingRecordings}件` : ''} · 予約 ${item.counts.reservations}件`
    : seriesListMeta(item, tab));
  if (state.menuButton) {
    const label = `${title}の操作`;
    state.menuButton.title = label;
    state.menuButton.setAttribute('aria-label', label);
  }
  if (tab === 'attention') updateAttentionSelection(state, item);
  if (!state.media) return;
  state.title.title = title;
  const tid = item.tid === null ? '—' : String(item.tid);
  setContent(state.tid, tid);
  state.tid.setAttribute('aria-label', item.tid === null ? 'ローカルシリーズ' : `TID ${item.tid}`);
  const thumbnail = item.representativeThumbnailUrl || null;
  if (thumbnail === state.thumbnailUrl) return;
  state.thumbnailUrl = thumbnail;
  if (!thumbnail) {
    state.media.classList.add('is-empty');
    state.media.textContent = '画像なし';
    return;
  }
  state.media.classList.remove('is-empty');
  const image = state.media.querySelector('img') || document.createElement('img');
  image.loading = 'lazy';
  image.decoding = 'async';
  image.alt = '';
  if (image.getAttribute('src') !== thumbnail) image.src = thumbnail;
  if (image.parentNode !== state.media) state.media.replaceChildren(image);
}

function seriesListKey(item, tab, index) {
  const id = tab === 'attention'
    ? item.id ?? item.firstEventKey ?? item.events?.[0]?.key
    : item.id ?? item.tid;
  return `${tab}:${id ?? `row-${index}`}`;
}

// Preserve the visible item when rows are inserted or removed above it.
function seriesScrollAnchor(host) {
  if (!host.isConnected) return null;
  const element = Array.from(host.children).find(row => {
    if (!row.dataset.seriesKey) return false;
    const rect = row.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight;
  });
  return element ? { host, element, key: element.dataset.seriesKey, top: element.getBoundingClientRect().top } : null;
}

function reconcileSeriesChildren(host, desired) {
  const wanted = new Set(desired);
  for (const child of Array.from(host.children)) if (!wanted.has(child)) child.remove();
  let cursor = host.firstChild;
  for (const child of desired) {
    if (child === cursor) cursor = cursor.nextSibling;
    else host.insertBefore(child, cursor);
  }
}

function keepSeriesAnchor(anchor) {
  if (!anchor) return;
  const element = anchor.element.isConnected ? anchor.element
    : Array.from(anchor.host.children).find(child => child.dataset.seriesKey === anchor.key);
  if (!element?.isConnected) return;
  const delta = element.getBoundingClientRect().top - anchor.top;
  if (delta) window.scrollBy({ top: delta, behavior: 'auto' });
}

function renderSeriesList(host, data, tab, search, viewMode = 'list', context = {}) {
  const rows = seriesRows(data, tab);
  const cardMode = viewMode === 'card' && tab !== 'attention';
  const mode = `${tab}:${cardMode ? 'card' : 'list'}`;
  if (host.dataset.seriesMode !== mode) {
    host.dataset.seriesMode = mode;
    host.replaceChildren();
  }
  host.className = cardMode ? 'series-card-grid' : 'series-list';
  if (!rows.length) {
    const message = data.availability?.reason === 'syobocal-disabled'
      ? 'しょぼいカレンダーの情報利用がOFFのため、シリーズは表示されません。'
      : data.availability?.dictionaryStatus?.usable === false ? data.availability.dictionaryStatus.message
        : search ? '検索条件に一致する項目はありません。' : '表示できる項目はありません。';
    let empty = host.querySelector('.series-empty');
    if (!empty) { empty = document.createElement('p'); empty.className = 'series-empty'; host.replaceChildren(empty); }
    setContent(empty, message);
    return;
  }
  const anchor = seriesScrollAnchor(host);
  const existing = new Map(Array.from(host.children).filter(entry => entry.dataset.seriesKey)
    .map(entry => [entry.dataset.seriesKey, entry]));
  const keysSeen = new Map();
  const entries = rows.map((item, index) => {
    const identity = seriesListKey(item, tab, index);
    const occurrence = keysSeen.get(identity) || 0;
    keysSeen.set(identity, occurrence + 1);
    const key = occurrence ? `${identity}:${occurrence}` : identity;
    const entry = existing.get(key) || createSeriesListEntry(cardMode, tab);
    entry.dataset.seriesKey = key;
    updateSeriesListEntry(entry, item, data, tab, context);
    return entry;
  });
  reconcileSeriesChildren(host, entries);
  keepSeriesAnchor(anchor);
}

function recordingWarnings(recording) {
  return recordedResultWarnings(recording).filter(warning =>
    !['deleted', 'recorded-unknown', 'path-unknown'].includes(warning.key));
}

function seriesEventContext(event, context) {
  return context.eventIndex.get(event.key) || {
    eventKey: event.key, event, seriesId: context.seriesId || null,
    candidates: context.candidates || [], manual: event.resolution?.manual?.active === true
  };
}

function eventWarnings(event) {
  const unique = new Map();
  for (const recording of event.recordings || []) {
    for (const warning of recordingWarnings(recording)) unique.set(warning.key, warning);
  }
  return Array.from(unique.values());
}

function eventStates(event, seriesContext) {
  const states = [];
  if (event.reservation) states.push('予約');
  for (const label of new Set((event.recordings || []).map(recording => text(recording.statusLabel)).filter(Boolean))) {
    states.push(label);
  }
  if (seriesContext.manual) states.push('手動補正');
  return states.length ? states : ['履歴'];
}

function eventTooltip(event, seriesContext, warnings = eventWarnings(event)) {
  return [
    text(event.channel?.name, '放送局名未取得'),
    dateTime(event.start),
    eventStates(event, seriesContext).join(' · '),
    ...warnings.map(warning => `△ ${warning.label}: ${warning.description}`)
  ].join('\n');
}

function appendEventLogo(host, event, context, options = {}) {
  const seriesContext = seriesEventContext(event, context);
  const warnings = eventWarnings(event);
  const tooltip = eventTooltip(event, seriesContext, warnings);
  const wrapper = document.createElement('span');
  wrapper.className = 'series-event-logo-entry';
  wrapper.dataset.seriesEventKey = event.key;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'series-recording-logo';
  button.setAttribute('aria-label', `${tooltip.replaceAll('\n', '、')}。詳細を表示`);
  const logo = createChannelLogo({
    name: event.channel?.name,
    fallbackText: event.channel?.name,
    tooltip,
    url: event.channel?.logoUrl
  }, { variant: 'thumbnail' });
  logo.element.removeAttribute('title');
  setProgramHover(button, programHoverInfo(event, {
    channelLogoUrl: event.channel?.logoUrl,
    statuses: [...eventStates(event, seriesContext), ...warnings]
  }));
  button.append(logo.element);
  if (warnings.length) {
    const warning = document.createElement('span');
    warning.className = 'series-recording-warning';
    warning.textContent = '△';
    warning.setAttribute('aria-hidden', 'true');
    button.append(warning);
  }
  if ((options.kind === 'recording' || !options.kind && !event.reservation) &&
      event.recordings?.length && event.recordings.every(recording => recording.deleted)) {
    button.classList.add('is-deleted');
  }
  button.addEventListener('click', () => context.openDetail(context.eventIndex?.get(event.key) || seriesEventContext(event, context)));
  button.addEventListener('contextmenu', eventObject => {
    eventObject.preventDefault();
    context.openEventMenu(context.eventIndex?.get(event.key) || seriesEventContext(event, context), { x: eventObject.clientX, y: eventObject.clientY }, options.kind);
  });
  button.addEventListener('keydown', eventObject => {
    if (eventObject.key === 'ContextMenu' || eventObject.key === 'F10' && eventObject.shiftKey) {
      eventObject.preventDefault();
      const rect = button.getBoundingClientRect();
      context.openEventMenu(context.eventIndex?.get(event.key) || seriesEventContext(event, context), { x: rect.left + 16, y: rect.top + 16 }, options.kind);
    }
  });
  wrapper.append(button);
  appendMobileContextButton(button, wrapper);
  if (context.selectedEventKey === event.key) wrapper.classList.add('is-selected');
  host.append(wrapper);
  return wrapper;
}

function eventTimeLabel(event) {
  return `${dateTime(event.start)} · ${text(event.channel?.name, '局名未取得')}`;
}

function appendOverflowEvent(host, event, context, kind) {
  const row = document.createElement('div');
  row.className = 'series-event-overflow-row';
  appendEventLogo(row, event, context, { kind });
  const label = document.createElement('span');
  label.textContent = eventTimeLabel(event);
  row.append(label);
  host.append(row);
}

function appendEventRow(host, label, count, events, context, kind) {
  if (!events.length) return;
  const row = document.createElement('div');
  row.className = `series-event-row is-${kind}`;
  const heading = document.createElement('span');
  heading.className = 'series-event-row-label';
  heading.textContent = `${label} ${count}件`;
  const logos = document.createElement('div');
  logos.className = 'series-recording-logos';
  const limit = 3;
  events.slice(0, limit).forEach(event => appendEventLogo(logos, event, context, { kind }));
  const omitted = events.slice(limit);
  if (omitted.length) {
    const overflow = document.createElement('details');
    overflow.className = 'series-event-overflow';
    const summary = document.createElement('summary');
    summary.className = 'series-recording-more';
    summary.textContent = `+${omitted.length}`;
    summary.setAttribute('aria-label', `${label}の残り${omitted.length}件を表示`);
    const panel = document.createElement('div');
    panel.className = 'series-event-overflow-panel';
    omitted.forEach(event => appendOverflowEvent(panel, event, context, kind));
    overflow.append(summary, panel);
    logos.append(overflow);
  }
  row.append(heading, logos);
  host.append(row);
}

function recordingEventOrder(left, right) {
  const leftDeleted = left.recordings?.every(recording => recording.deleted) === true;
  const rightDeleted = right.recordings?.every(recording => recording.deleted) === true;
  if (leftDeleted !== rightDeleted) return leftDeleted ? 1 : -1;
  return Number(right.start || 0) - Number(left.start || 0);
}

function createEpisodeCard(episode, size, context) {
  const card = document.createElement('article');
  card.className = 'series-episode-card';
  const media = document.createElement('div');
  media.className = 'series-episode-media';
  if (episode.thumbnailUrl) {
    const image = document.createElement('img');
    image.src = episode.thumbnailUrl;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.alt = '';
    media.append(image);
  } else {
    media.textContent = '画像なし';
    media.classList.add('is-empty');
  }
  const body = document.createElement('div');
  body.className = 'series-episode-body';
  const heading = document.createElement('strong');
  heading.textContent = episode.label;
  const subtitle = document.createElement('span');
  subtitle.className = 'series-episode-subtitle';
  subtitle.textContent = episode.virtual ?
    `${episode.displaySubtitle ? `${episode.displaySubtitle} · ` : ''}録画・予約の記録なし` :
    text(episode.displaySubtitle, episode.confirmed ? '副題未取得' : episode.status || '判定保留');
  body.append(heading, subtitle);
  if (!episode.virtual) {
    const eventRows = document.createElement('div');
    eventRows.className = 'series-event-rows';
    const recordingEvents = episode.events.filter(event => event.recordings?.length)
      .sort(recordingEventOrder);
    const reservationEvents = episode.events.filter(event => event.reservation !== null)
      .sort((left, right) => Number(left.start || 0) - Number(right.start || 0));
    appendEventRow(eventRows, '録画履歴', episode.recordings.length, recordingEvents, context, 'recording');
    appendEventRow(eventRows, '予約', episode.reservations.length, reservationEvents, context, 'reservation');
    if (eventRows.childElementCount) body.append(eventRows);
  }
  if (episode.virtual) card.classList.add('is-virtual');
  card.append(media, body);
  return card;
}

function episodeKey(episode, index) {
  return String(episode.id ?? episode.key ?? episode.number ?? episode.label ?? `row-${index}`);
}

function seriesContentSignature(item) {
  // Server generation changes are not themselves visible changes. Event actions
  // resolve their fresh context at click time instead of retaining old tokens.
  return JSON.stringify(item, (key, value) => key === 'generation' ? undefined : value);
}

function renderSeriesDetail(host, series, tab, context) {
  let cardSize = readPreference(SIZE_KEY, ['small', 'medium', 'large'], 'medium');
  let columns = readPreference(COLUMNS_KEY, ['auto', '3', '4', '5', '6'], 'auto');
  let currentSeries = series;
  const eventContext = { ...context, seriesId: series.id, candidates: [{ tid: series.tid, title: series.title }] };
  const episodeCards = new Map();
  host.replaceChildren();
  const back = link(`#series?tab=${tab}`, '← 一覧へ戻る', 'series-back-link');
  const header = document.createElement('section');
  header.className = 'panel series-detail-header';
  const image = document.createElement('div');
  image.className = 'series-representative-image';
  const info = document.createElement('div');
  info.className = 'series-detail-info';
  const titleLine = document.createElement('div');
  titleLine.className = 'series-detail-title';
  const heading = document.createElement('h2');
  const hiddenBadge = document.createElement('span');
  hiddenBadge.className = 'badge series-hidden-badge';
  hiddenBadge.textContent = '非表示中';
  titleLine.append(heading);
  const tid = document.createElement('p');
  tid.className = 'series-detail-tid';
  const counts = document.createElement('div');
  counts.className = 'series-detail-counts';
  const description = document.createElement('p');
  description.className = 'series-detail-description';
  info.append(titleLine, tid, counts);
  header.append(image, info);

  const sizeSelect = document.createElement('select');
  sizeSelect.setAttribute('aria-label', 'カードサイズ');
  for (const [value, label] of [['small', '小'], ['medium', '中'], ['large', '大']]) sizeSelect.add(new Option(`サイズ: ${label}`, value));
  sizeSelect.value = cardSize;
  const columnSelect = document.createElement('select');
  columnSelect.setAttribute('aria-label', '列数');
  for (const value of ['auto', '3', '4', '5', '6']) columnSelect.add(new Option(value === 'auto' ? '列数: 自動' : `列数: ${value}列`, value));
  columnSelect.value = columns;
  const hiddenButton = document.createElement('button');
  hiddenButton.type = 'button';
  hiddenButton.className = 'button series-data-button';
  hiddenButton.addEventListener('click', () => eventContext.setHidden(currentSeries.tid, !currentSeries.hidden));
  const grid = document.createElement('section');
  grid.className = 'series-episode-grid';

  function updateHeader() {
    setContent(heading, currentSeries.title);
    if (currentSeries.hidden === true) {
      if (!hiddenBadge.isConnected) titleLine.append(hiddenBadge);
    } else hiddenBadge.remove();
    setContent(tid, currentSeries.tid === null ? 'ローカルシリーズ' : `TID ${currentSeries.tid}`);
    const labels = [
      `録画 ${currentSeries.counts.currentRecordings}件`,
      ...(currentSeries.counts.missingRecordings ? [`行方不明 ${currentSeries.counts.missingRecordings}件`] : []),
      `予約 ${currentSeries.counts.reservations}件`,
      `取得済みEP ${currentSeries.counts.currentEpisodes ?? currentSeries.counts.episodes}件`,
      `辞書登録EP ${currentSeries.counts.dictionaryEpisodes ?? 0}件`,
      `イベント確定EP ${currentSeries.counts.episodes}件`,
      `EP未確定 ${currentSeries.counts.episodeUnresolved}件`
    ];
    if (counts.dataset.values !== JSON.stringify(labels)) {
      counts.dataset.values = JSON.stringify(labels);
      counts.replaceChildren(...labels.map(label => {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = label;
        return badge;
      }));
    }
    if (currentSeries.description) {
      setContent(description, currentSeries.description);
      if (!description.isConnected) info.append(description);
    } else description.remove();
    const thumbnail = currentSeries.representativeThumbnailUrl || null;
    if (image.dataset.thumbnail !== (thumbnail || '')) {
      image.dataset.thumbnail = thumbnail || '';
      if (thumbnail) {
        const preview = document.createElement('img');
        preview.src = thumbnail;
        preview.alt = '';
        image.replaceChildren(preview);
      } else image.textContent = '画像なし';
    }
    hiddenButton.textContent = currentSeries.hidden ? 'シリーズを再表示' : 'シリーズを非表示';
    hiddenButton.hidden = !Number.isInteger(Number(currentSeries.tid)) || Number(currentSeries.tid) <= 0;
  }

  function renderGrid(firstRender = false, previousAnchor = null) {
    grid.dataset.size = cardSize;
    grid.dataset.columns = columns;
    const anchor = firstRender ? null : previousAnchor || seriesScrollAnchor(grid);
    const nextCards = new Map();
    const keysSeen = new Map();
    const cards = currentSeries.episodes.map((episode, index) => {
      const identity = episodeKey(episode, index);
      const occurrence = keysSeen.get(identity) || 0;
      keysSeen.set(identity, occurrence + 1);
      const key = occurrence ? `${identity}:${occurrence}` : identity;
      const signature = seriesContentSignature(episode);
      const old = episodeCards.get(key);
      let card;
      if (old && old.signature === signature) card = old.card;
      else {
        card = createEpisodeCard(episode, cardSize, eventContext);
        if (old) {
          const prior = old.card.querySelectorAll('details.series-event-overflow');
          const next = card.querySelectorAll('details.series-event-overflow');
          prior.forEach((detail, i) => { if (next[i]) next[i].open = detail.open; });
        }
      }
      card.dataset.seriesKey = key;
      nextCards.set(key, { card, signature });
      return card;
    });
    reconcileSeriesChildren(grid, cards);
    episodeCards.clear();
    nextCards.forEach((value, key) => episodeCards.set(key, value));
    keepSeriesAnchor(anchor);
    if (firstRender) {
      const selected = grid.querySelector('.series-event-logo-entry.is-selected');
      if (selected) window.requestAnimationFrame(() => selected.scrollIntoView({ block: 'nearest' }));
    }
  }

  sizeSelect.addEventListener('change', () => {
    cardSize = sizeSelect.value;
    writePreference(SIZE_KEY, cardSize);
    grid.dataset.size = cardSize;
  });
  columnSelect.addEventListener('change', () => {
    columns = columnSelect.value;
    writePreference(COLUMNS_KEY, columns);
    grid.dataset.columns = columns;
  });
  updateHeader();
  renderGrid(true);
  host.append(back, header, grid);
  return {
    root: grid, seriesId: series.id, sizeSelect, columnSelect, hiddenButton,
    update(nextSeries, nextContext) {
      const anchor = seriesScrollAnchor(grid);
      currentSeries = nextSeries;
      Object.assign(eventContext, nextContext, {
        seriesId: nextSeries.id, candidates: [{ tid: nextSeries.tid, title: nextSeries.title }]
      });
      updateHeader();
      renderGrid(false, anchor);
    }
  };
}

function renderAttentionDetail(host, group, context) {
  let currentGroup = group;
  const eventContext = { ...context, candidates: group.candidates || [] };
  const eventCards = new Map();
  host.replaceChildren();
  const back = link('#series?tab=attention', '← 要確認一覧へ戻る', 'series-back-link');
  const header = document.createElement('section');
  header.className = 'panel series-attention-detail';
  const heading = document.createElement('h2');
  const description = document.createElement('p');
  const candidates = document.createElement('p');
  candidates.className = 'series-attention-candidates';
  const actions = document.createElement('div');
  actions.className = 'series-attention-actions';
  const bulk = document.createElement('button');
  bulk.type = 'button';
  bulk.className = 'button primary';
  bulk.textContent = 'まとめて紐づけ';
  bulk.addEventListener('click', () => eventContext.openBulk(currentGroup));
  actions.append(bulk);
  header.append(heading, description, candidates, actions);
  const list = document.createElement('section');
  list.className = 'series-attention-events';
  host.append(back, header, list);

  function update(nextGroup, nextContext) {
    const anchor = seriesScrollAnchor(list);
    currentGroup = nextGroup;
    Object.assign(eventContext, nextContext, { candidates: nextGroup.candidates || [] });
    setContent(heading, nextGroup.title);
    setContent(description, `${nextGroup.label} · ${nextGroup.events.length}件${nextGroup.progLookupLabel ? ` · ${nextGroup.progLookupLabel}` : ''}`);
    setContent(candidates, nextGroup.candidates?.length
      ? `紐づけ候補: ${nextGroup.candidates.map(item => `${item.title} (TID ${item.tid})`).join(' / ')}`
      : '既存候補なし。作品辞書検索から指定できます。');
    const nextCards = new Map();
    const cards = nextGroup.events.map((event, index) => {
      const key = String(event.key ?? `row-${index}`);
      const signature = seriesContentSignature(event);
      const old = eventCards.get(key);
      let card;
      if (old && old.signature === signature) card = old.card;
      else {
        card = document.createElement('article');
        card.className = 'panel series-attention-event';
        const title = document.createElement('strong');
        title.textContent = text(event.fullTitle, event.title || 'タイトル未取得');
        const meta = document.createElement('span');
        meta.textContent = `${dateTime(event.start)} · ${text(event.channel?.name, '局名未取得')}`;
        const subtitle = document.createElement('span');
        subtitle.textContent = event.subTitle ? `副題: ${event.subTitle}` : '副題なし';
        card.append(title, meta, subtitle);
        const logoHost = document.createElement('div');
        logoHost.className = 'series-recording-logos';
        appendEventLogo(logoHost, event, eventContext);
        card.append(logoHost);
      }
      card.dataset.seriesKey = key;
      nextCards.set(key, { card, signature });
      return card;
    });
    reconcileSeriesChildren(list, cards);
    eventCards.clear();
    nextCards.forEach((value, key) => eventCards.set(key, value));
    keepSeriesAnchor(anchor);
  }
  update(group, context);
  return { root: list, groupId: group.id, update };
}

export function renderSeriesPage(container, query = new URLSearchParams(), options = {}) {
  const controller = new AbortController();
  const setHeaderActions = typeof options.setHeaderActions === 'function' ? options.setHeaderActions : () => {};
  let tab = TABS.has(query.get('tab')) ? query.get('tab') : 'all';
  let viewMode = readPreference(VIEW_KEY, ['list', 'card'], 'list');
  let searchValue = query.get('search') || '';
  const selectedId = query.get('id');
  const eventKey = query.get('event');
  let sequence = 0;
  let refreshTimer = null;
  let dataDialog = null;
  let hiddenDialog = null;
  let headerActions = null;
  let availabilityKey = null;
  let renderedGeneration = null;
  let loading = false;
  let refreshQueued = false;
  let listData = null;
  let renderedQuery = null;
  let searchTimer = null;
  let overviewView = null;
  let detailView = null;
  let attentionView = null;
  let autoLoadObserver = null;
  let autoLoadBlocked = false;
  let loadError = '';
  let visibleCount = 25;
  const selectedAttentionEvents = new Set();
  const listKey = () => JSON.stringify([tab, viewMode, searchValue]);
  function reloadList(delay = 0) {
    renderedQuery = null;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => scheduleRefresh(0), delay);
  }
  container.className = 'series-page';
  container.innerHTML = '<section class="panel series-loading"><p>シリーズ情報を生成しています…</p></section>';
  const programHover = createProgramHover(container);

  function afterCorrection(key) {
    const nextHash = `#series?tab=${tab}&event=${encodeURIComponent(key)}`;
    if (window.location.hash === nextHash) scheduleRefresh(0);
    else window.location.hash = nextHash;
  }

  function openDetail(context) {
    openProgramDetailDialog({ key: context.eventKey, onChanged: () => scheduleRefresh(0) });
  }

  function openCorrection(context, focusEpisode = false) {
    openSeriesCorrectionDialog({
      event: context.event,
      candidates: context.candidates,
      seriesContext: context,
      focusEpisode,
      onChanged: afterCorrection
    });
  }

  function openBulk(group) {
    openSeriesBulkCorrectionDialog({
      group,
      onChanged(result) {
        if (!result?.responseUnknown) selectedAttentionEvents.clear();
        const nextHash = '#series?tab=attention';
        if (window.location.hash === nextHash) scheduleRefresh(0);
        else window.location.hash = nextHash;
      }
    });
  }

  function handleSeriesAction(action, context) {
      if (action === 'detail') return openDetail(context);
      if (action === 'series-view') {
        const href = seriesEventHref(context, tab === 'attention' ? 'recordings' : tab);
        if (href) window.location.hash = href;
        return;
      }
      if (action === 'series-change') return openCorrection(context, false);
      if (action === 'series-episode') return openCorrection(context, true);
      if (action === 'series-remove' && context.manual &&
          window.confirm('このイベントの手動指定を解除し、自動判定へ戻しますか？')) {
        removeSeriesOverride(context.eventKey, { generation: context.event?.generation, contextToken: context.event?.correctionToken }).then(() => afterCorrection(context.eventKey))
          .catch(error => window.alert(`手動指定を解除できませんでした: ${error.message}`));
      }
      if (action === 'series-hidden' && context.kind === 'series') {
        updateHidden(context.tid, !context.hidden);
      }
  }
  const contextMenu = createSeriesContextMenu({ onAction: handleSeriesAction });
  const showMenuError = error => window.alert(String(error?.message || error));
  function copyEventTitle(title) {
    if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(title).catch(showMenuError);
    else window.prompt('タイトルをコピー', title);
  }
  function searchEventTitle(action, title) {
    const url = action === 'search-google'
      ? `https://www.google.com/search?q=${encodeURIComponent(title)}`
      : `https://ja.wikipedia.org/wiki/${encodeURIComponent(title)}`;
    window.open(url, '_blank', 'noopener');
  }
  const recordedContextMenu = createRecordedContextMenu({
    onAction(action, item) {
      if (action.startsWith('series-')) return handleSeriesAction(action, item.seriesContext);
      if (action === 'detail' || action === 'rule' || action === 'delete') {
        openProgramDetailDialog({ key: item.key, id: item.recordedId,
          initialAction: action === 'detail' ? null : action, onChanged: () => scheduleRefresh(0) });
      } else if (action === 'play') {
        void openRecordedPlaybackOverlay({ playable: true, recordedId: item.recordedId,
          title: item.fullTitle || item.title || 'タイトル未取得' }).catch(showMenuError);
      } else if (action === 'download') {
        const anchor = document.createElement('a');
        anchor.href = `/api/recorded/${encodeURIComponent(item.recordedId)}/file.m2ts`;
        anchor.download = '';
        anchor.hidden = true;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      } else if (action === 'copy-title') copyEventTitle(item.fullTitle || item.title || '');
      else if (action === 'search-google' || action === 'search-wikipedia')
        searchEventTitle(action, item.title || item.fullTitle || '');
    }
  });
  const programContextMenu = createHomeProgramContextMenu({
    onAction(action, item) {
      if (action === 'rule') openProgramDetailDialog({ id: item.id, initialAction: 'rule',
        onChanged: () => scheduleRefresh(0) });
      else if (action === 'copy-title') copyEventTitle(item.title || '');
      else if (action === 'search-google' || action === 'search-wikipedia')
        searchEventTitle(action, item.title || '');
    }
  });
  function openEventMenu(context, point, kind) {
    contextMenu.close();
    recordedContextMenu.close();
    programContextMenu.close();
    const event = context?.event;
    const recordings = event?.recordings || [];
    if (kind === 'recording' && recordings.length === 1 &&
        recordings[0].recordedId && !recordings[0].deleted) {
      recordedContextMenu.open({ ...recordings[0], key: event.key,
        recordedId: recordings[0].recordedId, title: event.title, fullTitle: event.fullTitle,
        channel: event.channel, seriesContext: context, hideFilter: true }, point);
    } else if (kind === 'reservation' && event?.reservation && event.ids?.length === 1) {
      programContextMenu.open({ id: event.ids[0], title: event.fullTitle || event.title,
        program: { channel: { id: event.channel?.id } }, refresh: () => scheduleRefresh(0) }, point);
    } else contextMenu.open(context, point);
  }

  async function updateHidden(tid, hidden) {
    if (hidden && !window.confirm('このシリーズを録画・予約の一覧から非表示にしますか？')) return;
    try {
      await setSeriesHidden(tid, hidden);
      scheduleRefresh(0);
    } catch (error) {
      window.alert(`シリーズの表示設定を変更できませんでした: ${error.message}`);
    }
  }

  function updateState(data) {
    const key = JSON.stringify(data.availability);
    if (key === availabilityKey) return;
    availabilityKey = key;
    dataDialog?.updateAvailability(data.availability);
    const button = headerActions?.querySelector('.series-availability-button');
    if (button) button.className = `button series-data-button series-availability-button is-${data.availability?.status || 'unknown'}`;
  }

  function syncHeaderData(data) {
    if (!dataDialog || !hiddenDialog) return;
    const hiddenSeries = Array.isArray(data.hiddenSeries) ? data.hiddenSeries : [];
    hiddenDialog.updateItems(hiddenSeries, data.manualGeneration || 0);
    updateState(data);
    const secondary = headerActions?.querySelector('.series-header-secondary');
    if (!secondary) return;
    let hiddenButton = secondary.querySelector('.series-hidden-button');
    if (!hiddenSeries.length) hiddenButton?.remove();
    else if (hiddenButton) setContent(hiddenButton, `非表示（${hiddenSeries.length}）`);
    else {
      hiddenButton = makeHiddenSeriesButton(hiddenDialog, hiddenSeries.length);
      secondary.insertBefore(hiddenButton, secondary.querySelector('.series-availability-button'));
    }
  }

  function installHeader(data, config = {}) {
    if (!dataDialog) {
      dataDialog = createAvailabilityDialog(data.availability);
      hiddenDialog = createHiddenSeriesDialog([], async tid => {
        const result = await setSeriesHidden(tid, false);
        scheduleRefresh(0);
        return result;
      });
      document.body.append(dataDialog, hiddenDialog);
    }
    const hiddenSeries = Array.isArray(data.hiddenSeries) ? data.hiddenSeries : [];
    const actions = makeHeaderActions({
      tab: config.showTabs === false ? null : tab,
      viewMode,
      availability: data.availability,
      dialog: dataDialog,
      hiddenDialog,
      hiddenSeries,
      searchControl: config.searchControl || null,
      onViewChange(nextView) {
        if (nextView === viewMode) return;
        viewMode = nextView;
        writePreference(VIEW_KEY, viewMode);
        headerActions?.querySelectorAll('[data-series-view]').forEach(button => {
          button.setAttribute('aria-pressed', String(button.dataset.seriesView === viewMode));
        });
        config.onViewChange?.();
      },
      detailControls: config.detailControls || []
    });
    headerActions = actions;
    setHeaderActions(actions.childElementCount ? actions : null);
    syncHeaderData(data);
  }

  function updateOverviewPagination() {
    if (!overviewView || !listData) return;
    const pagination = listData.pagination;
    overviewView.footer.hidden = !pagination && !loadError;
    if (pagination) {
      const displayed = Math.min(visibleCount, seriesRows(listData, tab).length);
      setContent(overviewView.count, `${pagination.total}件中 ${displayed}件表示 · ${Math.max(1, Math.ceil(displayed / 25))}/${Math.max(1, Math.ceil(pagination.total / 25))}ページ`);
      overviewView.more.hidden = displayed >= seriesRows(listData, tab).length && !pagination.hasMore;
      overviewView.more.disabled = loading;
      setContent(overviewView.more, loading ? '読み込み中…' : 'もっと見る');
    }
    overviewView.error.hidden = !loadError;
    if (loadError) setContent(overviewView.error, loadError);
  }

  function showNextSeriesBatch() {
    if (controller.signal.aborted || loading || !listData || renderedQuery !== listKey()) return;
    const available = seriesRows(listData, tab).length;
    if (visibleCount < available) {
      visibleCount = Math.min(visibleCount + 25, available);
      renderOverview(listData);
      window.requestAnimationFrame(maybeAutoLoad);
    } else if (listData.pagination?.hasMore) void load(true);
  }

  function maybeAutoLoad() {
    if (controller.signal.aborted || loading || autoLoadBlocked || !overviewView || !listData ||
        renderedQuery !== listKey() || renderedGeneration !== listData.generation) return;
    if (visibleCount >= seriesRows(listData, tab).length && !listData.pagination?.hasMore) return;
    const rect = overviewView.footer.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight + 500) return;
    showNextSeriesBatch();
  }

  function updateAttentionSelectionCount() {
    const controls = overviewView?.selectionControls;
    if (!controls) return;
    const count = selectedAttentionEvents.size;
    setContent(controls.count, `${count}件を選択中`);
    setContent(controls.bulk, `${count}件をまとめて紐づけ`);
    controls.bulk.disabled = count === 0;
    controls.clear.disabled = count === 0;
  }

  function changeAttentionSelection(keys, checked) {
    for (const key of keys) {
      if (checked) selectedAttentionEvents.add(key);
      else selectedAttentionEvents.delete(key);
    }
    for (const entry of overviewView?.list.children || []) {
      const state = seriesListStates.get(entry);
      if (state?.selection) syncAttentionSelection(state);
    }
    updateAttentionSelectionCount();
  }

  async function openSelectedBulk() {
    const eventKeys = Array.from(selectedAttentionEvents);
    if (!eventKeys.length) return;
    try {
      const data = await loadSeriesProjection({ eventKeys, signal: controller.signal });
      if (controller.signal.aborted) return;
      const events = new Map(data.attention.flatMap(group => (group.events || []).map(event => [event.key, event])));
      if (eventKeys.some(key => !events.has(key))) {
        throw new Error('選択中に要確認の対象が変更されました。最新の一覧で選び直してください。');
      }
      const candidates = new Map();
      for (const group of data.attention) {
        for (const candidate of group.candidates || []) candidates.set(candidate.tid, candidate);
      }
      openBulk({
        id: null, title: '選択した番組', events: eventKeys.map(key => events.get(key)),
        candidates: Array.from(candidates.values()), generation: data.generation,
        dictionaryGeneration: data.attention[0]?.dictionaryGeneration
      });
    } catch (error) {
      if (!controller.signal.aborted) window.alert(`一括補正の対象を取得できませんでした: ${error.message}`);
    }
  }

  function renderOverview(data) {
    if (!overviewView) {
      container.replaceChildren();
      const searchLabel = document.createElement('label');
      searchLabel.className = 'series-header-search';
      const search = document.createElement('input');
      search.type = 'search';
      search.value = searchValue;
      search.placeholder = '作品名・番組名を検索';
      search.setAttribute('aria-label', '作品名・番組名を検索');
      search.autocomplete = 'off';
      searchLabel.append(search);
      const list = document.createElement('section');
      const footer = document.createElement('div');
      footer.className = 'series-pagination';
      const count = document.createElement('p');
      const error = document.createElement('p');
      error.className = 'series-pagination-error';
      error.setAttribute('role', 'status');
      error.hidden = true;
      const more = document.createElement('button');
      more.className = 'button';
      more.type = 'button';
      more.textContent = 'もっと見る';
      more.addEventListener('click', () => {
        if (loading) return;
        autoLoadBlocked = false;
        showNextSeriesBatch();
      });
      footer.append(count, error, more);
      let selectionControls = null;
      if (tab === 'attention') {
        const bar = document.createElement('div');
        bar.className = 'series-attention-selection-bar';
        const selectedCount = document.createElement('span');
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'button';
        clear.textContent = '選択解除';
        clear.addEventListener('click', () => changeAttentionSelection(Array.from(selectedAttentionEvents), false));
        const bulk = document.createElement('button');
        bulk.type = 'button';
        bulk.className = 'button primary';
        bulk.addEventListener('click', openSelectedBulk);
        bar.append(selectedCount, clear, bulk);
        container.append(bar);
        selectionControls = { count: selectedCount, clear, bulk };
      }
      container.append(list, footer);
      let searchComposing = false;
      const applySearch = () => {
        searchValue = search.value;
        reloadList(200);
      };
      search.addEventListener('compositionstart', () => { searchComposing = true; });
      search.addEventListener('compositionend', () => { searchComposing = false; applySearch(); });
      search.addEventListener('input', event => {
        if (searchComposing || event.isComposing) return;
        applySearch();
      });
      overviewView = { list, footer, count, error, more, selectionControls };
      updateAttentionSelectionCount();
      installHeader(data, { searchControl: searchLabel, onViewChange: () => reloadList() });
      if (typeof IntersectionObserver !== 'undefined') {
        autoLoadObserver = new IntersectionObserver(entries => {
          if (entries.some(entry => entry.isIntersecting)) maybeAutoLoad();
        }, { root: null, rootMargin: '500px 0px', threshold: 0 });
        autoLoadObserver.observe(footer);
      } else window.addEventListener('scroll', maybeAutoLoad, { passive: true });
    } else syncHeaderData(data);
    renderSeriesList(overviewView.list, {
      ...data, series: data.series.slice(0, visibleCount), attention: data.attention.slice(0, visibleCount)
    }, tab, searchValue, viewMode, {
      openSeriesMenu: contextMenu.open, selectedAttentionEvents, changeAttentionSelection
    });
    updateAttentionSelectionCount();
    updateOverviewPagination();
  }

  async function load(append = false) {
    if (controller.signal.aborted) return;
    if (loading) { if (!append) refreshQueued = true; return; }
    if (append && (!listData?.pagination?.hasMore || renderedQuery !== listKey())) return;
    loading = true;
    updateOverviewPagination();
    const current = ++sequence;
    const requestedQuery = listKey();
    const isList = !selectedId && !eventKey;
    const previousPages = isList && renderedQuery === requestedQuery ? Math.max(1, listData?.pagination?.page || 1) : 1;
    const page = append ? listData.pagination.page + 1 : 1;
    try {
      let data = await loadSeriesProjection({ signal: controller.signal, id: selectedId || undefined, event: eventKey || undefined,
        filter: tab, view: viewMode, q: searchValue, page, generation: append ? renderedGeneration : undefined });
      if (controller.signal.aborted || current !== sequence) return;
      if (isList && requestedQuery !== listKey()) { refreshQueued = true; return; }
      if (!append && renderedGeneration === data.generation && (!isList || renderedQuery === requestedQuery)) {
        syncHeaderData(data);
        return;
      }
      if (append) {
        if (!listData || listData.generation !== data.generation || renderedQuery !== requestedQuery) {
          refreshQueued = true;
          return;
        }
        data = { ...data, series: [...listData.series, ...data.series], attention: [...listData.attention, ...data.attention] };
      } else if (isList && previousPages > 1) {
        // Rebuild the *data* for all pages already opened, without replacing their DOM.
        // Pin generation so that pages from different snapshots are never mixed.
        let lastPage = data;
        const series = data.series.slice();
        const attention = data.attention.slice();
        for (let number = 2; number <= previousPages && lastPage.pagination?.hasMore; number += 1) {
          lastPage = await loadSeriesProjection({ signal: controller.signal, filter: tab, view: viewMode,
            q: searchValue, page: number, generation: data.generation });
          if (controller.signal.aborted || current !== sequence) return;
          if (requestedQuery !== listKey()) { refreshQueued = true; return; }
          series.push(...lastPage.series);
          attention.push(...lastPage.attention);
        }
        data = { ...lastPage, series, attention };
      }
      if (isList && !append && renderedQuery !== requestedQuery) visibleCount = 25;
      if (isList && append) visibleCount += 25;
      renderedGeneration = data.generation;
      renderedQuery = requestedQuery;
      if (isList) listData = data;
      loadError = '';
      const eventIndex = buildSeriesEventIndex(data);
      const eventContext = {
        closeHover: programHover.close,
        eventIndex,
        selectedEventKey: eventKey,
        openDetail,
        openMenu: contextMenu.open,
        openEventMenu,
        openBulk,
        setHidden: updateHidden
      };
      let selected = selectedId ? data.series.find(item => item.id === selectedId) : null;
      if (!selected && eventKey) {
        selected = data.series.find(item => (item.episodes || []).some(episode =>
          episode.events.some(event => event.key === eventKey))) || null;
        if (!selected) tab = 'attention';
      }
      if (selected) {
        attentionView = null;
        if (detailView && detailView.seriesId === selected.id && detailView.root.isConnected) {
          detailView.update(selected, eventContext);
          syncHeaderData(data);
        } else {
          detailView = renderSeriesDetail(container, selected, tab, eventContext);
          installHeader(data, {
            showTabs: false,
            detailControls: [detailView.sizeSelect, detailView.columnSelect, detailView.hiddenButton]
          });
        }
        return;
      }
      const attentionTarget = eventKey
        ? data.attention.find(item => (item.events || []).some(event => event.key === eventKey)) : null;
      if (attentionTarget) {
        detailView = null;
        if (attentionView && attentionView.groupId === attentionTarget.id && attentionView.root.isConnected) {
          attentionView.update(attentionTarget, eventContext);
          syncHeaderData(data);
        } else {
          attentionView = renderAttentionDetail(container, attentionTarget, eventContext);
          installHeader(data, { showTabs: false });
        }
        return;
      }
      if (selectedId || eventKey) {
        detailView = null;
        attentionView = null;
        const message = document.createElement('section');
        message.className = 'panel series-empty';
        const label = document.createElement('p');
        label.textContent = '対象のシリーズ・イベントは現在の一覧にありません。';
        message.append(label, link(`#series?tab=${tab}`, '一覧へ戻る'));
        container.replaceChildren(message);
        installHeader(data, { showTabs: false });
        return;
      }
      renderOverview(data);
    } catch (error) {
      if (controller.signal.aborted || current !== sequence) return;
      if (error.status === 409) { renderedGeneration = null; refreshQueued = true; return; }
      if (append) autoLoadBlocked = true;
      loadError = `${append ? '続きを読み込めませんでした' : '更新できませんでした'}: ${error?.message || String(error)}`;
      if (overviewView) updateOverviewPagination();
      else {
        container.innerHTML = '<section class="panel series-loading is-error"><h2>シリーズ情報を表示できません</h2><p></p></section>';
        container.querySelector('p').textContent = error?.message || String(error);
        setHeaderActions();
      }
    } finally {
      loading = false;
      updateOverviewPagination();
      if (refreshQueued && !controller.signal.aborted) { refreshQueued = false; scheduleRefresh(0); }
      else if (isList && overviewView) window.requestAnimationFrame(maybeAutoLoad);
    }
  }

  function scheduleRefresh(delay = 200) {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => load(), delay);
  }

  async function checkStatus() {
    if (loading) { refreshQueued = true; return; }
    try {
      const state = await loadSeriesStatus({ signal: controller.signal });
      if (controller.signal.aborted) return;
      if (state.generation === renderedGeneration) updateState(state);
      else scheduleRefresh(0);
    } catch (error) {
      if (controller.signal.aborted) return;
      updateState({ availability: { status: 'stale', message: `取得状態を確認できませんでした: ${error.message}` } });
    }
  }

  const unsubscribers = [
    subscribeRecordedThumbnailReady(() => {
      renderedGeneration = null;
      scheduleRefresh(0);
    }),
    subscribeSeriesNotifications(update => update?.statusOnly ? checkStatus() : scheduleRefresh()),
    subscribeReservationNotifications(() => scheduleRefresh()),
    subscribeRecordedNotifications(() => scheduleRefresh()),
    subscribeMatchNotifications(() => scheduleRefresh())
  ];
  const pollTimer = window.setInterval(checkStatus, 60000);
  load();

  return () => {
    programHover.dispose();
    controller.abort();
    window.clearTimeout(refreshTimer);
    window.clearTimeout(searchTimer);
    window.clearInterval(pollTimer);
    autoLoadObserver?.disconnect();
    if (!autoLoadObserver) window.removeEventListener('scroll', maybeAutoLoad);
    unsubscribers.forEach(unsubscribe => unsubscribe());
    contextMenu.destroy();
    recordedContextMenu.destroy();
    programContextMenu.destroy();
    dataDialog?.remove();
    hiddenDialog?.remove();
    setHeaderActions();
  };
}
