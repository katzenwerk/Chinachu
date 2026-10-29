import { invalidateResources, loadResource } from '../services/api-client.js';
import { headerCompactMedia, appendMobileContextButton } from '../components/mobile-layout.js';
import { openProgramDetailDialog } from '../components/program-detail-dialog.js';
import { createChannelLogo } from '../components/channel-logo.js';
import { openRuleEditorDialog, programRuleSeed } from '../components/rule-editor-dialog.js';
import { createGuideProgramMenu } from './guide-page.js';
import { ruleAction } from '../services/program-detail-model.js';
import { subscribeRecordingNotifications, subscribeReservationNotifications, subscribeScheduleNotifications } from '../services/realtime-client.js';
import { reserveProgram, setReserveSkip, unreserveProgram } from '../services/timetable-client.js';
import { programState } from '../services/timetable-model.js';
import { searchSchedule } from '../services/program-search-model.js';
import { channelDetailText, channelIdentifier, channelLogoUrl } from '../services/recording-model.js';

const PAGE_SIZE = 50;
const TYPES = ['GR', 'BS', 'CS'];
const DATE_FORMAT = new Intl.DateTimeFormat('ja-JP', { month: '2-digit', day: '2-digit', weekday: 'short' });
const TIME_FORMAT = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const CATEGORY_LABELS = { anime: 'アニメ', news: 'ニュース', information: '情報', sports: 'スポーツ', variety: 'バラエティ', drama: 'ドラマ', cinema: '映画', music: '音楽', theater: '演劇' };

function option(value, label) {
  const result = document.createElement('option');
  result.value = value;
  result.textContent = label;
  return result;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function linkedRuleProgram(program, reserves) {
  const matches = (Array.isArray(reserves) ? reserves : []).filter(reserve =>
    (text(reserve?.id) && reserve.id === program.id) ||
    (text(reserve?.channel?.id) && reserve.channel.id === program?.channel?.id &&
      Number(reserve.start) === Number(program.start) && Number(reserve.seconds) === Number(program.seconds))
  );
  if (matches.length > 1) return null;
  const reserve = matches[0];
  if (!reserve) return program;
  return {
    ...program,
    ruleUid: text(reserve.ruleUid) || text(reserve.reservationMeta?.ruleUid),
    ruleId: reserve.ruleId ?? reserve.reservationMeta?.ruleId,
    isManualReserved: reserve.isManualReserved === true || reserve.reservationMeta?.isManualReserved === true
  };
}

export function renderSearchPage(container, initialParams = new URLSearchParams(), { setHeaderActions = () => {} } = {}) {
  let disposed = false;
  let schedule = [];
  let reserves = [];
  let recording = [];
  let hasReservationData = false;
  let pageIndex = 0;
  let latestRequest = 0;
  let contextMenu = null;
  let ruleDialog = null;
  let defaultUpcomingOnly = initialParams.size === 0;
  const preferredRuleUids = new Map();
  const releases = [];

  const section = document.createElement('section');
  section.className = 'panel program-search-page';
  section.innerHTML = `<div class="program-search-result-heading"></div>
    <div class="program-search-results" data-results></div>
    <div class="program-search-pagination" data-pagination hidden><button class="button" type="button" data-prev>前へ</button><span data-page></span><button class="button" type="button" data-next>次へ</button></div>`;
  container.replaceChildren(section);

  const toolbar = document.createElement('div');
  toolbar.className = 'program-search-header';
  toolbar.innerHTML = `<details class="program-search-header-controls" open>
    <summary>検索操作</summary>
    <form class="program-search-header-form" role="search" aria-label="番組検索条件">
      <fieldset class="guide-types"><legend>放送波</legend>${TYPES.map(type => `<label><input type="checkbox" value="${type}" checked>${type}</label>`).join('')}</fieldset>
      <select data-filter="category" aria-label="ジャンル"><option value="">全ジャンル</option></select>
      <input type="search" name="q" maxlength="120" autocomplete="off" placeholder="番組名・キーワード" aria-label="番組名・キーワード">
    </form>
  </details><span class="program-search-header-count" data-count aria-live="polite">取得中…</span>`;
  setHeaderActions(toolbar);

  const controls = toolbar.querySelector('.program-search-header-controls');
  const form = toolbar.querySelector('form');
  const keyword = form.querySelector('[name="q"]');
  const category = form.querySelector('[data-filter="category"]');
  const waveChecks = [...form.querySelectorAll('.guide-types input')];
  const count = toolbar.querySelector('[data-count]');
  toolbar.prepend(count);
  const resultsHost = section.querySelector('[data-results]');
  const pagination = section.querySelector('[data-pagination]');
  keyword.value = initialParams.get('q') || '';

  const compactMedia = headerCompactMedia(1100);
  const setCompact = event => { controls.open = !event.matches; };
  setCompact(compactMedia);
  compactMedia.addEventListener('change', setCompact);

  function closeMenu() {
    contextMenu?.remove();
    contextMenu = null;
  }

  function redraw() {
    if (disposed) return;
    closeMenu();
    const query = keyword.value.trim();
    const waves = waveChecks.filter(check => check.checked).map(check => check.value);
    const found = searchSchedule(schedule, { query, types: waves, category: category.value })
      .filter(entry => !defaultUpcomingOnly || Number(entry.program?.end || (entry.start + Number(entry.program?.seconds || 0) * 1000)) > Date.now());
    const total = found.length;
    pageIndex = Math.min(pageIndex, Math.max(0, Math.ceil(total / PAGE_SIZE) - 1));
    count.textContent = `${total}件`;
    resultsHost.replaceChildren();
    pagination.hidden = total <= PAGE_SIZE;
    if (total === 0) {
      const message = document.createElement('p');
      message.className = 'program-search-empty';
      message.textContent = '条件に一致する番組はありません。';
      resultsHost.append(message);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const entry of found.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE)) {
      const { program, channel } = entry;
      const state = hasReservationData ? programState(program, reserves, recording) : { key: 'unknown', label: '状態未確認' };
      const row = document.createElement('article');
      row.className = `program-search-row is-${state.key}`;
      const date = document.createElement('span');
      date.className = 'program-search-date';
      date.textContent = DATE_FORMAT.format(entry.start).replace(/\s/g, '');
      const time = document.createElement('time');
      time.className = 'program-search-time';
      time.dateTime = new Date(entry.start).toISOString();
      const end = Number(program.end) > Number(entry.start)
        ? Number(program.end)
        : Number(program.seconds) > 0 ? Number(entry.start) + Number(program.seconds) * 1000 : null;
      const extraDays = end !== null && end - Number(entry.start) >= 24 * 60 * 60 * 1000
        ? `（+${Math.floor((end - Number(entry.start)) / (24 * 60 * 60 * 1000))}日）` : '';
      time.textContent = `${TIME_FORMAT.format(entry.start)}–${end === null ? '未取得' : TIME_FORMAT.format(end)}${extraDays}`;
      const displayChannel = { ...channel, ...(program.channel || {}) };
      const stationName = displayChannel.name || String(displayChannel.id || '放送局不明');
      const logo = createChannelLogo({
        url: channelLogoUrl(displayChannel),
        name: stationName,
        fallbackText: channelIdentifier(displayChannel) || stationName,
        tooltip: channelDetailText(displayChannel)
      }, { variant: 'list' });
      const station = logo.element;
      station.classList.add('program-search-station');
      const details = document.createElement('div');
      details.className = 'program-search-info';
      const head = document.createElement('div');
      head.className = 'program-search-info-head';
      const title = document.createElement('strong');
      title.textContent = program.fullTitle || program.title || 'タイトル未取得';
      // 「未予約」は通常状態なので表示しない。その他は予約一覧と同じピル型タグを使う。
      if (state.key !== 'none') {
        const status = document.createElement('span');
        status.className = `reservation-list-tag program-search-status is-${state.key}`;
        status.textContent = state.label;
        head.append(status);
      }
      head.append(title);
      const sub = document.createElement('small');
      sub.textContent = String(program.description || program.detail || '').trim().replace(/\s+/g, ' ').slice(0, 160);
      details.append(head, sub);
      row.append(date, time, station, details);
      if (program.id) {
        appendMobileContextButton(row);
        row.classList.add('is-actionable');
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-label', `${state.label} ${title.textContent} ${stationName} ${date.textContent} ${time.textContent} 詳細を開く`);
        const openDetail = () => openProgramDetailDialog({ id: program.id, onChanged: reloadReservations });
        row.addEventListener('click', openDetail);
        row.addEventListener('keydown', event => {
          if (event.target === row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openDetail(); }
        });
        row.addEventListener('contextmenu', event => {
          event.preventDefault();
          event.stopPropagation();
          closeMenu();
          const displayProgram = { ...program, channel: displayChannel };
          contextMenu = createGuideProgramMenu({
            program: displayProgram, state, x: event.clientX, y: event.clientY,
            onAction: action => runAction(program, action),
            resolveRule: async () => {
              invalidateResources(['rules']);
              const rules = await loadResource('rules');
              const linked = linkedRuleProgram(displayProgram, reserves);
              if (linked === null) return { mode: 'unavailable', label: '関連する予約を一意に特定できません' };
              const result = ruleAction(linked, rules, preferredRuleUids.get(program.id));
              if (result.mode === 'unavailable' && result.ruleUid && result.label === '関連ルールは現在の一覧にありません') return { mode: 'create' };
              return result;
            },
            onRule: action => openRuleAction(displayProgram, action)
          });
        });
      }
      fragment.append(row);
    }
    resultsHost.append(fragment);
    pagination.querySelector('[data-page]').textContent = `${pageIndex + 1} / ${Math.ceil(total / PAGE_SIZE)}ページ`;
    pagination.querySelector('[data-prev]').disabled = pageIndex === 0;
    pagination.querySelector('[data-next]').disabled = (pageIndex + 1) * PAGE_SIZE >= total;
  }

  async function reloadReservations() {
    const request = ++latestRequest;
    try {
      const [latestReserves, latestRecording] = await Promise.all([
        loadResource('reserves', { force: true }), loadResource('recording', { force: true })
      ]);
      if (disposed || request !== latestRequest) return;
      reserves = Array.isArray(latestReserves) ? latestReserves : [];
      recording = Array.isArray(latestRecording) ? latestRecording : [];
      hasReservationData = true;
      redraw();
    } catch (_) {
      if (!disposed && request === latestRequest) { hasReservationData = false; redraw(); }
    }
  }

  async function runAction(program, action) {
    const messages = { reserve: 'この番組を録画予約しますか？', unreserve: 'この手動予約を取り消しますか？', skip: 'このルール予約をスキップしますか？', unskip: 'スキップを取り消しますか？' };
    if (!messages[action] || !window.confirm(messages[action])) return;
    try {
      if (action === 'reserve') await reserveProgram(program.id);
      if (action === 'unreserve') await unreserveProgram(program.id);
      if (action === 'skip') await setReserveSkip(program.id, true);
      if (action === 'unskip') await setReserveSkip(program.id, false);
      await reloadReservations();
    } catch (error) { window.alert(String(error?.message || error)); }
  }

  function openRuleAction(program, action) {
    if (!action || action.mode === 'unavailable') {
      openProgramDetailDialog({ id: program.id, onChanged: reloadReservations });
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
        if (result.mode === 'create' && text(result.rule?.ruleUid)) preferredRuleUids.set(program.id, result.rule.ruleUid);
        await reloadReservations();
      },
      onDeleted: async () => {
        preferredRuleUids.delete(program.id);
        await reloadReservations();
      }
    });
  }

  function populateFilters() {
    const categories = new Set();
    for (const channel of schedule) for (const program of channel.programs || []) if (program.category) categories.add(String(program.category));
    for (const code of [...categories].sort()) category.append(option(code, CATEGORY_LABELS[code] || code));
  }

  function navigateKeyword() {
    defaultUpcomingOnly = false;
    const query = keyword.value.trim();
    const nextHash = `#search${query ? `?q=${encodeURIComponent(query)}` : ''}`;
    if (window.location.hash !== nextHash) window.history.pushState(null, '', nextHash);
    pageIndex = 0;
    redraw();
  }

  let keywordTimer = null;
  form.addEventListener('submit', event => {
    event.preventDefault();
    window.clearTimeout(keywordTimer);
    keywordTimer = null;
    navigateKeyword();
  });
  keyword.addEventListener('input', () => {
    window.clearTimeout(keywordTimer);
    keywordTimer = window.setTimeout(() => {
      keywordTimer = null;
      if (!disposed) navigateKeyword();
    }, 250);
  });
  for (const check of waveChecks) check.addEventListener('change', () => { defaultUpcomingOnly = false; pageIndex = 0; redraw(); });
  category.addEventListener('change', () => { defaultUpcomingOnly = false; pageIndex = 0; redraw(); });
  pagination.querySelector('[data-prev]').addEventListener('click', () => { pageIndex -= 1; redraw(); });
  pagination.querySelector('[data-next]').addEventListener('click', () => { pageIndex += 1; redraw(); });
  const outsidePointer = event => { if (!contextMenu?.contains(event.target)) closeMenu(); };
  const escape = event => { if (event.key === 'Escape') closeMenu(); };
  const onHistory = () => {
    if (disposed || !window.location.hash.startsWith('#search')) return;
    keyword.value = new URLSearchParams(window.location.hash.split('?')[1] || '').get('q') || '';
    defaultUpcomingOnly = false;
    pageIndex = 0;
    redraw();
  };
  document.addEventListener('pointerdown', outsidePointer, true);
  document.addEventListener('keydown', escape, true);
  window.addEventListener('popstate', onHistory);
  window.addEventListener('scroll', closeMenu, true);

  releases.push(subscribeReservationNotifications(() => { if (!disposed) void reloadReservations(); }));
  releases.push(subscribeRecordingNotifications(() => { if (!disposed) void reloadReservations(); }));
  releases.push(subscribeScheduleNotifications(() => {
    loadResource('schedule', { force: true }).then(value => {
      if (disposed) return;
      schedule = Array.isArray(value) ? value : [];
      const selectedCategory = category.value;
      category.replaceChildren(option('', '全ジャンル'));
      populateFilters();
      if ([...category.options].some(item => item.value === selectedCategory)) category.value = selectedCategory;
      redraw();
    }).catch(() => {});
  }));

  loadResource('schedule').then(value => {
    if (disposed) return;
    schedule = Array.isArray(value) ? value : [];
    populateFilters();
    redraw();
    void reloadReservations();
  }).catch(error => {
    if (disposed) return;
    count.textContent = '番組表を取得できません';
    const message = document.createElement('p');
    message.className = 'program-search-empty';
    message.textContent = String(error?.message || error);
    resultsHost.replaceChildren(message);
  });

  return () => {
    disposed = true;
    window.clearTimeout(keywordTimer);
    latestRequest += 1;
    closeMenu();
    ruleDialog?.close?.();
    compactMedia.removeEventListener('change', setCompact);
    document.removeEventListener('pointerdown', outsidePointer, true);
    document.removeEventListener('keydown', escape, true);
    window.removeEventListener('popstate', onHistory);
    window.removeEventListener('scroll', closeMenu, true);
    releases.forEach(release => release?.());
    setHeaderActions();
  };
}
