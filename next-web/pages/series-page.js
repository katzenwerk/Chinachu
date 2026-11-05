import { createChannelLogo } from '../components/channel-logo.js';
import { createProgramHover, programHoverInfo, setProgramHover } from '../components/program-hover.js';
import { appendMobileContextButton } from '../components/mobile-layout.js';
import { openProgramDetailDialog } from '../components/program-detail-dialog.js';
import { openSeriesBulkCorrectionDialog, openSeriesCorrectionDialog } from '../components/series-correction-dialog.js';
import { createSeriesContextMenu } from '../components/series-context-menu.js';
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
    button.innerHTML = `<svg class="icon" aria-hidden="true" viewBox="0 0 24 24">${icon}</svg>`;
    button.addEventListener('click', () => onChange(value));
    controls.append(button);
  }
  return controls;
}

function makeDataButton(dialog, availability) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `button series-data-button is-${availability?.status || 'unknown'}`;
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
  button.className = 'button series-data-button';
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

function appendSeriesMenuButton(host, item, context) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'series-item-menu-button';
  button.textContent = '⋯';
  button.title = `${text(item.title, 'シリーズ')}の操作`;
  button.setAttribute('aria-label', button.title);
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    const rect = button.getBoundingClientRect();
    context.openSeriesMenu({ kind: 'series', tid: item.tid, hidden: item.hidden === true, series: item }, {
      x: rect.right, y: rect.bottom
    });
  });
  host.append(button);
}

function attachSeriesOperations(target, item, context) {
  const open = ({ x, y }) => context.openSeriesMenu({
    kind: 'series', tid: item.tid, hidden: item.hidden === true, series: item
  }, { x, y });
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

function renderSeriesList(host, data, tab, search, viewMode = 'list', context = {}) {
  const rows = seriesRows(data, tab);
  host.replaceChildren();
  host.className = viewMode === 'card' && tab !== 'attention' ? 'series-card-grid' : 'series-list';
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'series-empty';
    empty.textContent = data.availability?.reason === 'syobocal-disabled' ?
      'しょぼいカレンダーの情報利用がOFFのため、シリーズは表示されません。' :
      data.availability?.dictionaryStatus?.usable === false ? data.availability.dictionaryStatus.message :
      search ? '検索条件に一致する項目はありません。' : '表示できる項目はありません。';
    host.append(empty);
    return;
  }
  for (const item of rows) {
    const href = seriesHref(data, item, tab);
    if (viewMode === 'card' && tab !== 'attention') {
      const entry = document.createElement('article');
      entry.className = 'series-list-card-entry';
      const card = document.createElement('a');
      card.className = 'series-list-card';
      card.href = href;
      attachSeriesOperations(card, item, context);
      const media = document.createElement('div');
      media.className = 'series-list-card-media';
      if (item.representativeThumbnailUrl) {
        const image = document.createElement('img');
        image.src = item.representativeThumbnailUrl;
        image.loading = 'lazy';
        image.decoding = 'async';
        image.alt = '';
        media.append(image);
      } else {
        media.classList.add('is-empty');
        media.textContent = '画像なし';
      }
      const body = document.createElement('div');
      body.className = 'series-list-card-body';
      const primary = document.createElement('div');
      primary.className = 'series-list-card-primary';
      const title = document.createElement('strong');
      title.textContent = text(item.title, '作品名未取得');
      title.title = title.textContent;
      const tid = document.createElement('span');
      tid.textContent = item.tid === null ? '—' : String(item.tid);
      tid.setAttribute('aria-label', item.tid === null ? 'ローカルシリーズ' : `TID ${item.tid}`);
      const summary = document.createElement('div');
      summary.className = 'series-list-card-summary';
      summary.textContent = `${seriesEpisodeSummary(item)} · 録画 ${item.counts.currentRecordings}件${item.counts.missingRecordings ? ` · 行方不明 ${item.counts.missingRecordings}件` : ''} · 予約 ${item.counts.reservations}件`;
      primary.append(title, tid);
      body.append(primary, summary);
      card.append(media, body);
      entry.append(card);
      appendSeriesMenuButton(entry, item, context);
      host.append(entry);
      continue;
    }
    const entry = document.createElement('div');
    entry.className = 'series-list-entry';
    const row = document.createElement('a');
    row.className = 'series-list-row';
    row.href = href;
    if (tab !== 'attention') attachSeriesOperations(row, item, context);
    const body = document.createElement('div');
    body.className = 'series-list-main';
    const title = document.createElement('strong');
    title.textContent = text(item.title, '作品名未取得');
    const meta = document.createElement('span');
    if (tab === 'reservations') {
      meta.textContent = `${seriesEpisodeSummary(item)} · ${item.counts.reservations}件予約 · 録画 ${item.counts.currentRecordings}件${item.counts.missingRecordings ? ` · 行方不明 ${item.counts.missingRecordings}件` : ''} · 次回 ${dateTime(item.nextReservationAt)}${item.nextReservationChannel ? ` · ${item.nextReservationChannel}` : ''}`;
    } else if (tab === 'recordings') {
      meta.textContent = `${seriesEpisodeSummary(item)} · ${item.counts.currentRecordings}件録画 · 予約 ${item.counts.reservations}件 · 最終録画 ${dateTime(item.latestRecordingAt)}`;
    } else if (tab === 'all') {
      meta.textContent = `${seriesEpisodeSummary(item)} · 録画 ${item.counts.currentRecordings}件${item.counts.missingRecordings ? ` · 行方不明 ${item.counts.missingRecordings}件` : ''} · 予約 ${item.counts.reservations}件`;
    } else {
      meta.textContent = `${item.label} · ${item.eventCount ?? item.events.length}件${item.progLookupLabel ? ` · ${item.progLookupLabel}` : ''}${item.candidateTids?.length ? ` · TID候補 ${item.candidateTids.join(', ')}` : ''}`;
    }
    body.append(title, meta);
    row.append(body);
    entry.append(row);
    if (tab !== 'attention') appendSeriesMenuButton(entry, item, context);
    host.append(entry);
  }
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
  button.addEventListener('click', () => context.openDetail(seriesContext));
  button.addEventListener('contextmenu', eventObject => {
    eventObject.preventDefault();
    context.openMenu(seriesContext, { x: eventObject.clientX, y: eventObject.clientY });
  });
  button.addEventListener('keydown', eventObject => {
    if (eventObject.key === 'ContextMenu' || eventObject.key === 'F10' && eventObject.shiftKey) {
      eventObject.preventDefault();
      const rect = button.getBoundingClientRect();
      context.openMenu(seriesContext, { x: rect.left + 16, y: rect.top + 16 });
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

function renderSeriesDetail(host, series, tab, context) {
  let cardSize = readPreference(SIZE_KEY, ['small', 'medium', 'large'], 'medium');
  let columns = readPreference(COLUMNS_KEY, ['auto', '3', '4', '5', '6'], 'auto');
  host.replaceChildren();
  const back = link(`#series?tab=${tab}`, '← 一覧へ戻る', 'series-back-link');
  const header = document.createElement('section');
  header.className = 'panel series-detail-header';
  const image = document.createElement('div');
  image.className = 'series-representative-image';
  if (series.representativeThumbnailUrl) {
    const preview = document.createElement('img');
    preview.src = series.representativeThumbnailUrl;
    preview.alt = '';
    image.append(preview);
  } else image.textContent = '画像なし';
  const info = document.createElement('div');
  info.className = 'series-detail-info';
  const titleLine = document.createElement('div');
  titleLine.className = 'series-detail-title';
  const heading = document.createElement('h2');
  heading.textContent = series.title;
  titleLine.append(heading);
  if (series.hidden === true) {
    const hiddenBadge = document.createElement('span');
    hiddenBadge.className = 'badge series-hidden-badge';
    hiddenBadge.textContent = '非表示中';
    titleLine.append(hiddenBadge);
  }
  const tid = document.createElement('p');
  tid.className = 'series-detail-tid';
  tid.textContent = series.tid === null ? 'ローカルシリーズ' : `TID ${series.tid}`;
  const counts = document.createElement('div');
  counts.className = 'series-detail-counts';
  for (const label of [
    `録画 ${series.counts.currentRecordings}件`, ...(series.counts.missingRecordings ? [`行方不明 ${series.counts.missingRecordings}件`] : []), `予約 ${series.counts.reservations}件`,
    `取得済みEP ${series.counts.currentEpisodes ?? series.counts.episodes}件`,
    `辞書登録EP ${series.counts.dictionaryEpisodes ?? 0}件`, `イベント確定EP ${series.counts.episodes}件`,
    `EP未確定 ${series.counts.episodeUnresolved}件`
  ]) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = label;
    counts.append(badge);
  }
  info.append(titleLine, tid, counts);
  if (series.description) {
    const description = document.createElement('p');
    description.className = 'series-detail-description';
    description.textContent = series.description;
    info.append(description);
  }
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
  hiddenButton.textContent = series.hidden ? 'シリーズを再表示' : 'シリーズを非表示';
  hiddenButton.hidden = !Number.isInteger(Number(series.tid)) || Number(series.tid) <= 0;
  hiddenButton.addEventListener('click', () => context.setHidden(series.tid, !series.hidden));
  const grid = document.createElement('section');
  grid.className = 'series-episode-grid';
  function renderGrid() {
    context.closeHover();
    grid.dataset.size = cardSize;
    grid.dataset.columns = columns;
    grid.replaceChildren(...series.episodes.map(episode => createEpisodeCard(episode, cardSize, {
      ...context,
      seriesId: series.id,
      candidates: [{ tid: series.tid, title: series.title }]
    })));
    const selected = grid.querySelector('.series-event-logo-entry.is-selected');
    if (selected) window.requestAnimationFrame(() => selected.scrollIntoView({ block: 'nearest' }));
  }
  sizeSelect.addEventListener('change', () => {
    cardSize = sizeSelect.value;
    writePreference(SIZE_KEY, cardSize);
    renderGrid();
  });
  columnSelect.addEventListener('change', () => {
    columns = columnSelect.value;
    writePreference(COLUMNS_KEY, columns);
    renderGrid();
  });
  renderGrid();
  host.append(back, header, grid);
  return { sizeSelect, columnSelect, hiddenButton };
}

function renderAttentionDetail(host, group, context) {
  host.replaceChildren();
  const back = link('#series?tab=attention', '← 要確認一覧へ戻る', 'series-back-link');
  const header = document.createElement('section');
  header.className = 'panel series-attention-detail';
  const heading = document.createElement('h2');
  heading.textContent = group.title;
  const description = document.createElement('p');
  description.textContent = `${group.label} · ${group.events.length}件${group.progLookupLabel ? ` · ${group.progLookupLabel}` : ''}`;
  const candidates = document.createElement('p');
  candidates.className = 'series-attention-candidates';
  candidates.textContent = group.candidates?.length
    ? `紐づけ候補: ${group.candidates.map(item => `${item.title} (TID ${item.tid})`).join(' / ')}`
    : '既存候補なし。作品辞書検索から指定できます。';
  const actions = document.createElement('div');
  actions.className = 'series-attention-actions';
  const bulk = document.createElement('button');
  bulk.type = 'button';
  bulk.className = 'button primary';
  bulk.textContent = 'まとめて紐づけ';
  bulk.addEventListener('click', () => context.openBulk(group));
  actions.append(bulk);
  header.append(heading, description, candidates, actions);
  const list = document.createElement('section');
  list.className = 'series-attention-events';
  for (const event of group.events) {
    const card = document.createElement('article');
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
    appendEventLogo(logoHost, event, { ...context, candidates: group.candidates || [] });
    card.append(logoHost);
    list.append(card);
  }
  host.append(back, header, list);
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
      onChanged() {
        const nextHash = '#series?tab=attention';
        if (window.location.hash === nextHash) scheduleRefresh(0);
        else window.location.hash = nextHash;
      }
    });
  }

  const contextMenu = createSeriesContextMenu({
    onAction(action, context) {
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
  });

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
    const button = headerActions?.querySelector('.series-data-button');
    if (button) button.className = `button series-data-button is-${data.availability?.status || 'unknown'}`;
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
    hiddenDialog.updateItems(hiddenSeries, data.manualGeneration || 0);
    updateState(data);
    const dialog = dataDialog;
    const actions = makeHeaderActions({
      tab: config.showTabs === false ? null : tab,
      viewMode,
      availability: data.availability,
      dialog,
      hiddenDialog,
      hiddenSeries,
      searchControl: config.searchControl || null,
      onViewChange(nextView) {
        if (nextView === viewMode) return;
        viewMode = nextView;
        writePreference(VIEW_KEY, viewMode);
        config.onViewChange?.();
      },
      detailControls: config.detailControls || []
    });
    headerActions = actions;
    setHeaderActions(actions.childElementCount ? actions : null);
  }

  function renderOverview(data) {
    const oldSearch = headerActions?.querySelector('input[type="search"]');
    const focused = oldSearch && document.activeElement === oldSearch;
    const selection = focused ? [oldSearch.selectionStart, oldSearch.selectionEnd] : null;
    container.replaceChildren();
    const searchLabel = document.createElement('label');
    searchLabel.className = 'series-header-search';
    const search = document.createElement('input');
    search.type = 'search';
    search.value = searchValue;
    search.placeholder = '作品名・番組名を検索';
    search.setAttribute('aria-label', '作品名・番組名を検索');
    search.autocomplete = 'off';
    const list = document.createElement('section');
    searchLabel.append(search);
    container.append(list);
    const render = () => renderSeriesList(list, data, tab, searchValue, viewMode, {
      openSeriesMenu: contextMenu.open
    });
    let searchComposing = false;
    const applySearch = () => {
      searchValue = search.value;
      reloadList(200);
    };
    search.addEventListener('compositionstart', () => { searchComposing = true; });
    search.addEventListener('compositionend', () => {
      searchComposing = false;
      applySearch();
    });
    search.addEventListener('input', event => {
      if (searchComposing || event.isComposing) return;
      applySearch();
    });
    render();
    const pagination = data.pagination;
    if (pagination) {
      const footer = document.createElement('div');
      footer.className = 'series-pagination';
      const count = document.createElement('p');
      count.textContent = `${pagination.total}件中 ${seriesRows(data, tab).length}件表示 · ${pagination.page}/${Math.max(1, pagination.totalPages)}ページ`;
      footer.append(count);
      if (pagination.hasMore) {
        const more = document.createElement('button');
        more.className = 'button';
        more.type = 'button';
        more.textContent = 'もっと見る';
        more.addEventListener('click', () => { if (!loading) { more.disabled = true; load(true); } });
        footer.append(more);
      }
      container.append(footer);
    }
    installHeader(data, { searchControl: searchLabel, onViewChange: () => reloadList() });
    if (focused) {
      search.focus();
      if (selection[0] !== null) search.setSelectionRange(...selection);
    }
  }

  async function load(append = false) {
    if (loading) { refreshQueued = true; return; }
    loading = true;
    const current = ++sequence;
    const requestedQuery = listKey();
    const isList = !selectedId && !eventKey;
    const page = append && listData?.pagination ? listData.pagination.page + 1 : 1;
    try {
      let data = await loadSeriesProjection({ signal: controller.signal, id: selectedId || undefined, event: eventKey || undefined,
        filter: tab, view: viewMode, q: searchValue, page, generation: append ? renderedGeneration : undefined });
      if (controller.signal.aborted || current !== sequence) return;
      if (isList && requestedQuery !== listKey()) { refreshQueued = true; return; }
      if (!append && renderedGeneration === data.generation && (!isList || renderedQuery === requestedQuery)) {
        updateState(data);
        return;
      }
      if (append) {
        if (!listData || listData.generation !== data.generation || renderedQuery !== requestedQuery) { reloadList(); return; }
        data = { ...data, series: [...listData.series, ...data.series], attention: [...listData.attention, ...data.attention] };
      }
      renderedGeneration = data.generation;
      programHover.close();
      renderedQuery = requestedQuery;
      if (isList) listData = data;
      const eventIndex = buildSeriesEventIndex(data);
      const eventContext = {
        closeHover: programHover.close,
        eventIndex,
        selectedEventKey: eventKey,
        openDetail,
        openMenu: contextMenu.open,
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
        const controls = renderSeriesDetail(container, selected, tab, eventContext);
        installHeader(data, {
          showTabs: false,
          detailControls: [controls.sizeSelect, controls.columnSelect, controls.hiddenButton]
        });
        return;
      }
      const attentionTarget = eventKey
        ? data.attention.find(item => (item.events || []).some(event => event.key === eventKey)) : null;
      if (attentionTarget) {
        renderAttentionDetail(container, attentionTarget, eventContext);
        installHeader(data, { showTabs: false });
        return;
      }
      if (selectedId || eventKey) {
        const message = document.createElement('section');
        message.className = 'panel series-empty';
        const text = document.createElement('p');
        text.textContent = '対象のシリーズ・イベントは現在の一覧にありません。';
        message.append(text, link(`#series?tab=${tab}`, '一覧へ戻る'));
        container.replaceChildren(message);
        installHeader(data, { showTabs: false });
        return;
      }
      renderOverview(data);
    } catch (error) {
      if (controller.signal.aborted || current !== sequence) return;
      if (error.status === 409) { reloadList(); return; }
      renderedGeneration = null;
      container.innerHTML = '<section class="panel series-loading is-error"><h2>シリーズ情報を表示できません</h2><p></p></section>';
      container.querySelector('p').textContent = error?.message || String(error);
      setHeaderActions();
    } finally {
      loading = false;
      if (refreshQueued && !controller.signal.aborted) { refreshQueued = false; scheduleRefresh(0); }
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
    unsubscribers.forEach(unsubscribe => unsubscribe());
    contextMenu.destroy();
    dataDialog?.remove();
    hiddenDialog?.remove();
    setHeaderActions();
  };
}
