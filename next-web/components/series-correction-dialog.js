import {
  previewSeriesSelection, removeSeriesOverride, removeSeriesWorkRule, saveSeriesOverride,
  saveSeriesOverridesBulk, searchSeriesTitles, loadSeriesProjection
} from '../services/series-client.js';

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

function selectionValue(value) {
  return /^local:[a-f0-9]{24}$/u.test(String(value)) ? String(value) : positiveInteger(value);
}
function selectionInput(value) { return typeof value === 'string' ? { seriesId: value } : { tid: value }; }
function candidateId(item) { return item.id?.startsWith('local:') ? item.id : Number(item.tid); }
function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function automaticEpisode(event) {
  if (event.resolution?.episodeConfirmed !== true) return null;
  const links = event.resolution?.automatic?.episodeLinks;
  if (!Array.isArray(links) || links.length !== 1 || links[0].kind !== 'episode') return null;
  const match = String(links[0].identity || '').match(/^(?:dict|prog|epg):(\d+)$/u);
  return match ? Number(match[1]) : null;
}

function candidateOptions(event, candidates) {
  const values = new Map();
  for (const candidate of candidates || []) {
    const tid = Number(candidate.tid);
    if (Number.isInteger(tid) && tid > 0) values.set(tid, {
      tid, title: text(candidate.title, `TID ${tid}`), firstYear: candidate.firstYear || null
    });
  }
  for (const tid of event.resolution?.candidateTids || []) {
    const number = Number(tid);
    if (Number.isInteger(number) && !values.has(number)) values.set(number, { tid: number, title: `TID ${number}`, firstYear: null });
  }
  for (const tid of [event.resolution?.selectedTid, event.resolution?.manual?.tid]) {
    const number = Number(tid);
    if (Number.isInteger(number) && !values.has(number)) values.set(number, { tid: number, title: `TID ${number}`, firstYear: null });
  }
  if (event.resolution?.manual?.seriesId?.startsWith('local:')) {
    const manual = event.resolution.manual; values.set(manual.seriesId, { id: manual.seriesId, tid: null, title: manual.title || 'オリジナルシリーズ' });
  }
  for (const item of candidates || []) if (item.id?.startsWith('local:')) values.set(item.id, item);
  return Array.from(values.values());
}

function createTitlePicker({ initialCandidates = [], currentTid = null, initialQuery = '', onSelection = () => {} }) {
  const searchLabel = document.createElement('label');
  searchLabel.textContent = '作品名・TIDで検索';
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = '作品名またはTIDを入力';
  search.autocomplete = 'off';
  search.value = initialQuery;
  searchLabel.append(search);
  const searchStatus = document.createElement('p');
  searchStatus.className = 'series-correction-status';
  const tidLabel = document.createElement('label');
  tidLabel.textContent = '紐づけ候補';
  const tidSelect = document.createElement('select');
  tidSelect.required = true;
  tidLabel.append(tidSelect);
  const initial = initialCandidates.filter(item => selectionValue(candidateId(item)) !== null);
  const known = new Map(initial.map(item => [candidateId(item), item]));
  let selectedTid = selectionValue(currentTid);
  let searchTimer = null;
  let searchSequence = 0;

  function replaceCandidates(items) {
    const current = [];
    const seen = new Set();
    for (const source of items || []) {
      const tid = candidateId(source);
      if (selectionValue(tid) === null || seen.has(tid)) continue;
      const item = { ...source, title: text(source.title, `TID ${tid}`) };
      known.set(tid, item);
      seen.add(tid);
      current.push(item);
    }
    if (selectedTid !== null && !seen.has(selectedTid)) {
      current.unshift(known.get(selectedTid) || { tid: selectedTid, title: `TID ${selectedTid}`, firstYear: null });
    }
    tidSelect.replaceChildren(new Option('作品を選択してください', ''));
    for (const item of current) {
      const suffix = item.firstYear ? ` (${item.firstYear})` : '';
      tidSelect.add(new Option(`${item.title}${suffix} · ${item.id?.startsWith('local:') ? 'オリジナル' : 'TID ' + item.tid}`, String(candidateId(item))));
    }
    tidSelect.value = selectedTid === null ? '' : String(selectedTid);
  }

  async function runSearch() {
    window.clearTimeout(searchTimer);
    const query = search.value.trim();
    const sequence = ++searchSequence;
    if (!query) {
      replaceCandidates(initial);
      searchStatus.textContent = '';
      return;
    }
    searchStatus.textContent = '検索中…';
    try {
      const results = await searchSeriesTitles(query);
      if (sequence !== searchSequence || !search.isConnected) return;
      replaceCandidates(results);
      searchStatus.textContent = results.length ? `${results.length}件の候補を表示しています。` : '一致する作品はありません。';
    } catch (error) {
      if (sequence !== searchSequence) return;
      replaceCandidates([]);
      searchStatus.textContent = error.message;
    }
  }

  let composing = false;
  search.addEventListener('compositionstart', () => { composing = true; searchSequence++; window.clearTimeout(searchTimer); });
  search.addEventListener('compositionend', () => { composing = false; runSearch(); });
  search.addEventListener('input', event => {
    if (composing || event.isComposing) return;
    window.clearTimeout(searchTimer);
    searchSequence++;
    if (!search.value.trim()) {
      runSearch();
      return;
    }
    searchTimer = window.setTimeout(runSearch, 250);
  });
  tidSelect.addEventListener('change', () => {
    selectedTid = selectionValue(tidSelect.value);
    onSelection(selectedTid, selectedTid === null ? null : known.get(selectedTid) || null);
  });
  replaceCandidates(initial);
  return {
    searchLabel,
    searchStatus,
    tidLabel,
    select: tidSelect,
    runInitial: runSearch,
    selectedCandidate() {
      return selectedTid === null ? null : known.get(selectedTid) || null;
    },
    dispose() {
      window.clearTimeout(searchTimer);
      searchSequence++;
    }
  };
}

export function openSeriesCorrectionDialog({
  event, candidates = [], seriesContext = null, onChanged = () => {}, focusEpisode = false
}) {
  if (!event?.key) return null;
  const dialog = document.createElement('dialog');
  dialog.className = 'series-correction-dialog';
  const form = document.createElement('form');
  form.method = 'dialog';
  const heading = document.createElement('h2');
  heading.textContent = 'シリーズの紐づけを修正';
  const target = document.createElement('p');
  target.className = 'series-correction-target';
  target.textContent = `${text(event.title, 'タイトル未取得')} · ${dateTime(event.start)} · ${text(event.channel?.name, '局名未取得')}`;
  const evidence = document.createElement('dl');
  evidence.className = 'series-correction-evidence';
  const autoTid = event.resolution?.automatic?.tid ?? event.resolution?.selectedTid;
  const autoEpisode = automaticEpisode(event);
  for (const [label, value] of [
    ['自動判定', autoTid ? `TID ${autoTid}${autoEpisode ? `・EP ${autoEpisode}` : '・EP未確定'}` : '未確定'],
    ['現在', event.resolution?.manual?.active ? `手動 TID ${event.resolution.manual.tid}${event.resolution.manual.episode ? `・EP ${event.resolution.manual.episode}` : '・EP未指定'}` : '自動判定を使用']
  ]) {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value;
    evidence.append(dt, dd);
  }

  const currentTid = event.resolution?.manual?.seriesId?.startsWith('local:') ? event.resolution.manual.seriesId : event.resolution?.manual?.tid ?? autoTid;
  const picker = createTitlePicker({
    initialCandidates: candidateOptions(event, candidates),
    currentTid,
    initialQuery: text(event.title, text(event.fullTitle, '')),
    onSelection: () => refreshPreview({ tidChanged: true })
  });
  const tidSelect = picker.select;

  const episodeLabel = document.createElement('label');
  episodeLabel.textContent = 'EP番号（未指定可）';
  const episode = document.createElement('input');
  episode.type = 'number';
  episode.min = '1';
  episode.step = '1';
  episode.inputMode = 'numeric';
  const manualEpisode = positiveInteger(event.resolution?.manual?.episode);
  const currentAutomaticEpisode = event.resolution?.manual?.active ?
    seriesContext?.episodeConfirmed && !seriesContext?.multipleEpisodeConfirmed ?
      positiveInteger(seriesContext.episode) : Number(currentTid) === Number(autoTid) ? autoEpisode : null :
    seriesContext?.episodeConfirmed ? positiveInteger(seriesContext.episode) : autoEpisode;
  episode.value = manualEpisode || currentAutomaticEpisode || '';
  episodeLabel.append(episode);
  const episodeStatus = document.createElement('p');
  episodeStatus.className = 'series-correction-episode-status';
  const subtitlePreview = document.createElement('p');
  subtitlePreview.className = 'series-correction-subtitle-preview';
  const workRuleStatus = document.createElement('p');
  workRuleStatus.className = 'series-correction-work-rule-status';
  const activeWorkRule = seriesContext?.workRule || event.resolution?.workRule || null;
  workRuleStatus.textContent = activeWorkRule?.active ?
    `${activeWorkRule.serviceName || '同一放送局'}の同じ作品系統へTID ${activeWorkRule.tid}を適用中です。` : '';
  let episodeExplicit = manualEpisode !== null;
  let previewSequence = 0;
  let contextToken = event.correctionToken || null;
  let ruleToken = event.ruleToken || null;
  let validationToken = null;
  let changedContext = null;
  let saving = false;

  function initialEpisodeStatus() {
    if (manualEpisode !== null) return `EP ${manualEpisode}を手動指定中です。`;
    if (currentAutomaticEpisode !== null) return `EP ${currentAutomaticEpisode}は自動確定値です。表示だけでは手動EPとして保存しません。`;
    const hint = positiveInteger(seriesContext?.episodeHint ?? event.episode);
    return hint === null ? 'EPは未確定です。' : `EPG話数 #${hint} は候補です。確定EPではありません。`;
  }
  episodeStatus.textContent = initialEpisodeStatus();

  async function refreshPreview({ tidChanged = false, episodeChanged = false } = {}) {
    validationToken = null;
    save.disabled = true;
    remove.disabled = true;
    removeWorkRule.disabled = true;
    const tid = selectionValue(tidSelect.value);
    if (tid === null) {
      subtitlePreview.textContent = '';
      return;
    }
    if (tidChanged) {
      episodeExplicit = false;
      episode.value = '';
      episodeStatus.textContent = '選択した作品についてEPを確認しています…';
    } else if (episodeChanged) {
      episodeExplicit = true;
      episodeStatus.textContent = episode.value ? '入力したEPを手動指定として保存します。' : 'EPを未指定として保存します。';
    }
    const sequence = ++previewSequence;
    try {
      const preview = await previewSeriesSelection({
        eventKey: event.key,
        generation: event.generation,
        contextToken,
        ...selectionInput(tid),
        episode: episodeExplicit && episode.value ? Number(episode.value) : null
      });
      if (sequence !== previewSequence || !dialog.isConnected) return;
      episode.disabled = typeof tid === 'string';
      if (typeof tid === 'string') episodeExplicit = false;
      if (!episodeExplicit && !preview.episodeConfirmed) episode.value = '';
      if (!episodeExplicit && preview.episodeConfirmed) {
        episode.value = String(preview.episode);
        episodeStatus.textContent = `EP ${preview.episode}を既存データから確認しました。表示だけでは手動EPとして保存しません。`;
      } else if (tidChanged && preview.multipleEpisode) {
        episodeStatus.textContent = '複数話情報のため、単一EPには補完しません。';
      } else if (tidChanged && preview.episodeHint) {
        episodeStatus.textContent = `EPG話数 #${preview.episodeHint} は候補です。確定EPではありません。`;
      } else if (tidChanged) {
        episodeStatus.textContent = preview.contradiction ?
          '既存の放送情報と矛盾するためEPを補完しません。' : 'この作品ではEPを安全に特定できません。';
      }
      if (!episodeExplicit && !preview.episodeConfirmed) {
        episodeStatus.textContent = preview.contradiction ? '既存の放送情報と矛盾するためEPを補完しません。' :
          preview.multipleEpisode ? '複数話情報のため、単一EPには補完しません。' :
          preview.episodeHint ? `EPG話数 #${preview.episodeHint} は候補です。確定EPではありません。` : 'EPは未確定です。';
      }
      const dictionarySubtitle = episodeExplicit ? preview.requestedSubtitle : preview.dictionarySubtitle;
      subtitlePreview.textContent = dictionarySubtitle ? `辞書副題: ${dictionarySubtitle}` : '';
      workRuleStatus.textContent = preview.workRuleProposal?.reason || '';
      contextToken = preview.contextToken;
      validationToken = preview.validationToken;
      save.disabled = saving || !validationToken;
      remove.disabled = saving;
      removeWorkRule.disabled = saving;
    } catch (error) {
      if (sequence !== previewSequence) return;
      episodeStatus.textContent = error.message;
      subtitlePreview.textContent = '';
      validationToken = null;
      save.disabled = true;
      reconfirm.hidden = false;
      if (error.status === 409) {
        changedContext = error;
        remove.disabled = true;
        removeWorkRule.disabled = true;
        if (error.currentContext) {
          message.textContent = `最新: ${text(error.currentContext.fullTitle, error.currentContext.title || '')} · ${error.currentContext.manual ? `手動 TID ${error.currentContext.manual.tid}` : '個別補正なし'}。入力は保持しています。`;
        }
      }
    }
  }

  episode.addEventListener('input', () => refreshPreview({ episodeChanged: true }));

  const message = document.createElement('p');
  message.className = 'series-correction-message';
  message.setAttribute('role', 'alert');
  const actions = document.createElement('div');
  actions.className = 'series-correction-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'button';
  cancel.textContent = 'キャンセル';
  cancel.addEventListener('click', () => dialog.close());
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'button danger';
  remove.textContent = 'このイベントの手動補正を解除';
  remove.hidden = event.resolution?.manual?.active !== true;
  const removeWorkRule = document.createElement('button');
  removeWorkRule.type = 'button';
  removeWorkRule.className = 'button danger';
  removeWorkRule.textContent = '同局・同作品への対応を解除';
  removeWorkRule.hidden = !activeWorkRule?.id;
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'button primary';
  save.textContent = '保存';
  save.disabled = true;
  const reconfirm = document.createElement('button');
  reconfirm.type = 'button';
  reconfirm.className = 'button';
  reconfirm.textContent = '最新の条件で再プレビュー';
  reconfirm.hidden = true;
  reconfirm.addEventListener('click', async () => {
    if (changedContext && !changedContext.contextToken) {
      message.textContent = '対象イベントを確認できません。最新の一覧から開き直してください。';
      return;
    }
    if (changedContext) {
      contextToken = changedContext.contextToken;
      const rule = changedContext.currentContext?.rules?.find(rule => rule.id === activeWorkRule?.id);
      if (changedContext.currentContext) remove.hidden = !changedContext.currentContext.manual;
      if (!rule && activeWorkRule) removeWorkRule.hidden = true;
      if (rule) {
        ruleToken = rule.token;
        workRuleStatus.textContent = `最新の作品ルール: TID ${rule.tid}`;
      }
    }
    changedContext = null;
    reconfirm.hidden = true;
    await refreshPreview();
    remove.disabled = !validationToken;
    removeWorkRule.disabled = !validationToken;
  });
  actions.append(removeWorkRule, remove, reconfirm, cancel, save);
  form.append(
    heading, target, evidence, picker.searchLabel, picker.searchStatus, picker.tidLabel,
    episodeLabel, episodeStatus, subtitlePreview, workRuleStatus, message, actions
  );
  dialog.append(form);
  document.body.append(dialog);

  async function run(action) {
    saving = true;
    for (const button of actions.querySelectorAll('button')) button.disabled = true;
    message.textContent = '';
    try {
      await action();
      dialog.close();
      await onChanged(event.key);
    } catch (error) {
      message.textContent = error.message;
      for (const button of actions.querySelectorAll('button')) button.disabled = false;
      validationToken = null;
      save.disabled = true;
      reconfirm.hidden = false;
      if (error.status === 409) {
        changedContext = error;
        remove.disabled = true;
        removeWorkRule.disabled = true;
        if (error.currentContext) message.textContent += ` 最新: ${text(error.currentContext.fullTitle, error.currentContext.title || '')}。入力を保持しています。`;
      }
    } finally { saving = false; }
  }
  form.addEventListener('submit', submitEvent => {
    submitEvent.preventDefault();
    if (!tidSelect.value || !validationToken || saving) {
      message.textContent = '作品を選択してください。';
      tidSelect.focus();
      return;
    }
    run(() => saveSeriesOverride({
      eventKey: event.key,
      generation: event.generation,
      validationToken,
      ...selectionInput(selectionValue(tidSelect.value)),
      episode: typeof selectionValue(tidSelect.value) !== 'string' && episodeExplicit && episode.value !== '' ? Number(episode.value) : null
    }));
  });
  remove.addEventListener('click', () => run(() => removeSeriesOverride(event.key, { generation: event.generation, contextToken })));
  removeWorkRule.addEventListener('click', () => {
    if (!window.confirm('この放送局・同作品系統へのTID対応を解除し、通常の自動判定へ戻します。\n個別の手動補正は維持されます。')) return;
    run(() => removeSeriesWorkRule(activeWorkRule.id, { generation: event.generation, eventKey: event.key, contextToken, ruleToken }));
  });
  dialog.addEventListener('close', () => {
    picker.dispose();
    dialog.remove();
  }, { once: true });
  dialog.showModal();
  picker.runInitial();
  if (tidSelect.value) refreshPreview();
  if (focusEpisode) window.requestAnimationFrame(() => episode.focus());
  return dialog;
}

export function openSeriesBulkCorrectionDialog({ group, onChanged = () => {} }) {
  let events = Array.isArray(group?.events) ? group.events.filter(event => event?.key) : [];
  if (!group || events.length === 0) return null;
  let eventKeys = events.map(event => event.key);
  const dialog = document.createElement('dialog');
  dialog.className = 'series-correction-dialog series-bulk-correction-dialog';
  const form = document.createElement('form');
  form.method = 'dialog';
  const heading = document.createElement('h2');
  heading.textContent = group.id ? '要確認グループをまとめて紐づけ' : '選択した番組をまとめて紐づけ';
  const target = document.createElement('p');
  target.className = 'series-correction-target';
  target.textContent = `${text(group.title, 'タイトル未取得')} · ${events.length}件へ共通のTIDだけを指定します。`;
  let picker;

  const confirmation = document.createElement('p');
  confirmation.className = 'series-bulk-confirmation';
  function updateConfirmation() {
    const selected = picker.selectedCandidate();
    const tid = selected && candidateId(selected);
    confirmation.textContent = selected ?
      `${events.length}件を「${text(selected.title, `TID ${tid}`)}」（${typeof tid === 'string' ? 'オリジナル' : 'TID ' + tid}）へ紐づけます。${typeof tid === 'string' ? 'EP指定は不要です。' : 'EPはイベントごとに再評価します。'}` :
      '一括指定する作品を選択してください。';
  }
  picker = createTitlePicker({
    initialCandidates: group.candidates || [],
    initialQuery: group.id ? text(events[0]?.title, text(group.title, '')) : '',
    onSelection: updateConfirmation
  });
  const tidSelect = picker.select;
  updateConfirmation();

  const eventList = document.createElement('ol');
  eventList.className = 'series-bulk-targets';
  for (const event of events) {
    const item = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = text(event.fullTitle, event.title || 'タイトル未取得');
    const meta = document.createElement('span');
    const episode = typeof event.episode === 'undefined' || event.episode === null || event.episode === '' ?
      '解析話数なし' : `解析話数 ${String(event.episode)}`;
    meta.textContent = `${dateTime(event.start)} · ${text(event.channel?.name, '局名未取得')} · ${episode}`;
    item.append(title, meta);
    eventList.append(item);
  }

  const message = document.createElement('p');
  message.className = 'series-correction-message';
  message.setAttribute('role', 'alert');
  const actions = document.createElement('div');
  actions.className = 'series-correction-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'button';
  cancel.textContent = 'キャンセル';
  cancel.addEventListener('click', () => dialog.close());
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'button primary';
  save.textContent = `${events.length}件をまとめて紐づけ`;
  const refreshTargets = document.createElement('button');
  refreshTargets.type = 'button';
  refreshTargets.className = 'button';
  refreshTargets.textContent = '最新の対象を確認';
  refreshTargets.hidden = true;
  refreshTargets.addEventListener('click', async () => {
    refreshTargets.disabled = true;
    try {
      const data = await loadSeriesProjection(group.id ? { groupId: group.id } : { eventKeys });
      if (group.id) {
        const latest = data.attention.find(item => item.id === group.id);
        if (!latest?.events?.length) throw new Error('このグループは変更・消滅しました。最新の一覧から開き直してください。');
        group = latest;
        events = latest.events;
        eventKeys = events.map(event => event.key);
      } else {
        const latest = new Map(data.attention.flatMap(item => (item.events || []).map(event => [event.key, event])));
        if (eventKeys.some(key => !latest.has(key))) {
          throw new Error('選択した番組が要確認一覧から変更されました。最新の一覧から選び直してください。');
        }
        events = eventKeys.map(key => latest.get(key));
        group = { ...group, events, generation: data.generation,
          dictionaryGeneration: data.attention[0]?.dictionaryGeneration };
      }
      target.textContent = `${text(group.title)} · 最新の対象 ${events.length}件`;
      eventList.replaceChildren(...events.map(event => {
        const item = document.createElement('li');
        item.textContent = `${text(event.fullTitle, event.title)} · ${dateTime(event.start)} · ${text(event.channel?.name)}`;
        return item;
      }));
      updateConfirmation();
      save.textContent = `${events.length}件をまとめて紐づけ`;
      save.disabled = false;
      message.textContent = '対象を更新しました。選択TIDと対象を確認して保存してください。';
      refreshTargets.hidden = true;
    } catch (error) { message.textContent = error.message; }
    finally { refreshTargets.disabled = false; }
  });
  actions.append(cancel, refreshTargets, save);
  form.append(
    heading, target, picker.searchLabel, picker.searchStatus, picker.tidLabel,
    confirmation, eventList, message, actions
  );
  dialog.append(form);
  document.body.append(dialog);

  form.addEventListener('submit', async submitEvent => {
    submitEvent.preventDefault();
    const tid = selectionValue(tidSelect.value);
    if (tid === null) {
      message.textContent = '作品を選択してください。';
      tidSelect.focus();
      return;
    }
    for (const button of actions.querySelectorAll('button')) button.disabled = true;
    message.textContent = '';
    try {
      await saveSeriesOverridesBulk({ groupId: group.id, eventKeys, ...selectionInput(tid), generation: group.generation, dictionaryGeneration: group.dictionaryGeneration });
      dialog.close();
      await onChanged({ conflict: false });
    } catch (error) {
      if (error.status === 409) {
        message.textContent = error.message + ' 選択TIDを保持しています。最新の対象を確認してください。';
        cancel.disabled = false;
        refreshTargets.disabled = false;
        refreshTargets.hidden = false;
        return;
      }
      if (error.resultUnknown) {
        dialog.close();
        try {
          await onChanged({ responseUnknown: true });
        } catch (_refreshError) {
          // The save result remains unknown; never retry the POST automatically.
        }
        window.alert('保存APIの応答を確認できませんでした。自動再送はしていません。最新の一覧を確認してから再操作してください。');
        return;
      }
      message.textContent = error.message;
      for (const button of actions.querySelectorAll('button')) button.disabled = false;
    }
  });
  dialog.addEventListener('close', () => {
    picker.dispose();
    dialog.remove();
  }, { once: true });
  dialog.showModal();
  picker.runInitial();
  return dialog;
}
