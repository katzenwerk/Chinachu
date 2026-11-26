import { listLocalSeries, createLocalSeries, deleteLocalSeries, searchSeriesTitles, loadSeriesDictionary } from '../services/series-client.js';

function searchField(label) {
  const wrap = document.createElement('label'); wrap.textContent = label;
  const field = document.createElement('input'); field.type = 'search'; field.autocomplete = 'off'; field.maxLength = 256;
  wrap.append(field); return { wrap, field };
}
function button(label, action) {
  const node = document.createElement('button'); node.type = 'button'; node.className = 'button'; node.textContent = label;
  node.addEventListener('click', action); return node;
}
// Shared IME/debounce handling; replies are accepted only for the current input revision.
function followInput(field, search) {
  let timer, revision = 0, composing = false;
  const schedule = () => {
    revision++; window.clearTimeout(timer);
    const current = revision;
    timer = window.setTimeout(() => search(() => !composing && current === revision), 250);
  };
  field.addEventListener('compositionstart', () => { composing = true; revision++; window.clearTimeout(timer); });
  field.addEventListener('compositionend', () => { composing = false; schedule(); });
  field.addEventListener('input', event => { if (!composing && !event.isComposing) schedule(); });
  return { composing: () => composing, dispose() { revision++; window.clearTimeout(timer); } };
}
function reconcile(host, entries, state, key, create, update) {
  const wanted = new Set(entries.map(key));
  for (const [id, row] of state) if (!wanted.has(id)) { row.root.remove(); state.delete(id); }
  let cursor = host.firstChild;
  for (const entry of entries) {
    const id = key(entry);
    let row = state.get(id);
    if (!row) { row = create(entry); state.set(id, row); }
    update(row, entry);
    if (row.root === cursor) cursor = cursor.nextSibling;
    else host.insertBefore(row.root, cursor);
  }
}

const DICTIONARY_LABELS = {
  syobocal: 'しょぼいカレンダー', bangumi: 'Bangumi', 'bangumi-wikipedia': 'Bangumi / Wikipedia', wikipedia: 'Wikipedia'
};
export function additionalSeason(title, season) {
  if (!season) return '';
  const normalized = String(title || '').normalize('NFKC');
  const same = new RegExp(`(?:season\\s*|シーズン\\s*|シリーズ\\s*|第\\s*)0*${season}(?!\\d)|(?:^|[^\\d])0*${season}(?:st|nd|rd|th)\\s*season|[^\\d]0*${season}$`, 'iu');
  return same.test(normalized) ? '' : `シーズン ${season}`;
}

function renderDramaWork(body, work) {
  const { bangumi, wikipedia, episodes, season } = work;
  const lines = document.createElement('div');
  const sourceOf = source => source?.page_id ? 'Wikipedia' : source ? 'Bangumi' : '';
  const from = (value, source) => [value, source && `[${source}]`].filter(Boolean).join(' ');
  function line(label, value) {
    if (!value) return;
    const node = document.createElement('p');
    node.textContent = `${label} ${value}`;
    lines.append(node);
  }
  const names = wikipedia ? [wikipedia.article_work_name, wikipedia.title].filter(Boolean) : [];
  if (bangumi && names.some(name => name !== bangumi.name)) line('Wikipedia作品名', names.find(name => name !== bangumi.name));
  if (work.aliases.length) line('別名', [...new Set(work.aliases.map(alias => from(alias.value, sourceOf(alias.source))))].join(' / '));
  line('シーズン', season);
  if (bangumi?.date && bangumi.date !== '0000-00-00') line('放送・公開開始', from(bangumi.date, 'Bangumi'));
  if (wikipedia?.first_air_date && wikipedia?.last_air_date) {
    line('放送期間', from(`${wikipedia.first_air_date} 〜 ${wikipedia.last_air_date}`, 'Wikipedia'));
  } else if (wikipedia?.first_air_date) line('放送開始', from(wikipedia.first_air_date, 'Wikipedia'));
  else if (wikipedia?.last_air_date) line('放送終了', from(wikipedia.last_air_date, 'Wikipedia'));
  const airYear = wikipedia?.first_air_year || wikipedia?.year;
  if (airYear && !wikipedia.first_air_date) line('放送年', from(airYear, 'Wikipedia'));
  if (bangumi?.broadcasters?.length) line('放送局', from(bangumi.broadcasters.join('、'), 'Bangumi'));
  if (wikipedia?.broadcast_channels?.length) line('放送局', from(wikipedia.broadcast_channels.join('、'), 'Wikipedia'));
  const totals = [bangumi?.total && from(bangumi.total, 'Bangumi'), wikipedia?.declared_episode_count &&
    from(wikipedia.declared_episode_count, 'Wikipedia')].filter(Boolean);
  if (totals.length) line('総話数', totals.join(' / '));
  const links = document.createElement('p');
  function link(label, href, hostname) {
    if (!href) return;
    const url = new URL(href, 'https://ja.wikipedia.org');
    if (url.protocol !== 'https:' || url.hostname !== hostname) return;
    const node = document.createElement('a');
    node.textContent = label; node.href = url.href; node.target = '_blank'; node.rel = 'noopener noreferrer';
    if (links.childNodes.length) links.append(' / ');
    links.append(node);
  }
  if (bangumi) link('Bangumi', `https://bgm.tv/subject/${bangumi.id}`, 'bgm.tv');
  link('Wikipedia（出典の版）', wikipedia?.source?.revision_url, 'ja.wikipedia.org');
  if (links.childNodes.length) lines.append(links);

  const list = document.createElement('ul');
  const ranges = document.createElement('ul');
  for (const episode of episodes) {
    const { bangumi: bg, wikipedia: wp, number } = episode;
    const range = wp?.kind === 'range';
    const kind = range ? '週・範囲' : wp?.kind === 'special' || bg?.type === 1 ? '特別編' :
      wp?.kind === 'normal' || bg?.type === 0 ? '通常話' : 'その他';
    const row = document.createElement('li');
    const heading = document.createElement('strong');
    const label = range ? [wp.week_label, wp.label].filter(Boolean).filter((v, i, values) => values.indexOf(v) === i).join(' / ') :
      wp?.label || (number == null ? '' : (kind === '通常話' ? `第${number}話` : String(number)));
    heading.textContent = [kind, label].filter(Boolean).join(' · ');
    row.append(heading);
    const fields = [];
    if (episode.subtitle) fields.push('副題 ' + from(episode.subtitle.value, sourceOf(episode.subtitle.source)));
    for (const candidate of [episode.originalSubtitleCandidate, episode.subtitleCandidate].filter(Boolean)) {
      fields.push('副題候補 ' + from(candidate.value, sourceOf(candidate.source)));
    }
    if (bg?.name_cn && bg.name_cn !== episode.subtitle?.value) fields.push('中国語表記 ' + from(bg.name_cn, 'Bangumi'));
    if (bg?.name && ![bg.name_cn, episode.subtitle?.value, episode.originalSubtitleCandidate?.value].includes(bg.name)) {
      fields.push('登録表記 ' + from(bg.name, 'Bangumi'));
    }
    if (episode.epgSubtitle) fields.push('ラテ欄 ' + from(episode.epgSubtitle.value, sourceOf(episode.epgSubtitle.source)));
    for (const item of episode.streamingSubtitles) fields.push(`配信用副題（${item.label}） ` + from(item.value, sourceOf(item.source)));
    if (episode.airdate) fields.push('放送日 ' + from(episode.airdate.value, sourceOf(episode.airdate.source)));
    if (episode.airdateConflict.length) fields.push('放送日（出典間で相違） ' +
      episode.airdateConflict.map(item => from(item.value, sourceOf(item.source))).join(' / '));
    if (range) {
      const period = wp.broadcast_range?.filter(Boolean).join(' 〜 ');
      if (period) fields.push('放送期間 ' + from(period, 'Wikipedia'));
    }
    for (const value of fields) {
      const field = document.createElement('div'); field.textContent = value; row.append(field);
    }
    if (wp?.source?.revision_id && wp.source.revision_id !== wikipedia?.source?.revision_id) {
      const sourceLink = document.createElement('a');
      sourceLink.href = 'https://ja.wikipedia.org/w/index.php?oldid=' + encodeURIComponent(wp.source.revision_id);
      sourceLink.textContent = 'Wikipedia 各話の出典'; sourceLink.target = '_blank'; sourceLink.rel = 'noopener noreferrer';
      row.append(' ', sourceLink);
    }
    (range ? ranges : list).append(row);
  }
  line('各話情報', `${list.children.length}件`);
  body.replaceChildren(lines);
  if (list.children.length) body.append(list);
  if (ranges.children.length) {
    const title = document.createElement('p');
    title.textContent = `週・範囲情報 ${ranges.children.length}件`;
    body.append(title, ranges);
  }
}

export function openOriginalSeriesDialog({ signal, onChanged }) {
  const dialog = document.createElement('dialog'); dialog.className = 'series-data-dialog series-registry-dialog';
  const heading = document.createElement('h2'); heading.textContent = 'オリジナル追加';
  const header = document.createElement('header'); header.className = 'series-registry-heading';
  header.append(heading, button('閉じる', () => dialog.close()));
  const { wrap, field } = searchField('シリーズ名');
  const candidatesHeading = document.createElement('h3'); candidatesHeading.textContent = '既存のシリーズ候補';
  const results = document.createElement('ul'); results.className = 'series-registry-results';
  const explanation = document.createElement('p'); explanation.textContent = '既存候補とは別に登録';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  let disposed = false, sequence = 0;
  const create = button('この名前で登録', async () => {
    if (watch.composing() || !field.value.trim() || create.disabled) return;
    create.disabled = true;
    try {
      const result = await createLocalSeries(field.value.trim(), { signal });
      if (disposed) return;
      status.textContent = result.result.existing ? `「${result.result.title}」は登録済みです。` : `「${result.result.title}」を登録しました。`;
      await search(); onChanged();
    } catch (error) { if (!disposed && !signal.aborted) status.textContent = error.message; }
    finally { create.disabled = false; }
  });
  create.classList.add('primary');
  async function search(isCurrent = () => true) {
    const current = ++sequence, query = field.value.trim();
    try {
      const items = query ? await searchSeriesTitles(query, { signal }) : [];
      if (disposed || current !== sequence || query !== field.value.trim() || !isCurrent()) return;
      results.replaceChildren();
      for (const item of items) {
        const row = document.createElement('li'); row.textContent = `${item.title} · ${item.kind === 'local' ? 'オリジナル' : 'TID ' + item.tid}`; results.append(row);
      }
      if (!items.length) { const row = document.createElement('li'); row.textContent = query ? '一致する候補はありません。' : '入力すると候補を表示します。'; results.append(row); }
    } catch (error) { if (!disposed && current === sequence && isCurrent() && !signal.aborted) status.textContent = error.message; }
  }
  const watch = followInput(field, search);
  const abort = () => dialog.close(); signal.addEventListener('abort', abort, { once: true });
  dialog.addEventListener('close', () => { disposed = true; sequence++; watch.dispose(); signal.removeEventListener('abort', abort); dialog.remove(); }, { once: true });
  dialog.append(header, wrap, candidatesHeading, results, explanation, create, status);
  document.body.append(dialog); dialog.showModal(); search();
  return dialog;
}

export function createSeriesRegistryView({ signal, onChanged, onBack }) {
  const root = document.createElement('section'); root.className = 'panel series-registry-view';
  const heading = document.createElement('h2'); heading.textContent = '登録一覧';
  const header = document.createElement('header'); header.className = 'series-registry-heading';
  header.append(heading, button('シリーズへ戻る', onBack));
  const tabs = document.createElement('div'); tabs.className = 'series-registry-tabs'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '登録一覧の種別');
  const tidPanel = document.createElement('div'), localPanel = document.createElement('div');
  tidPanel.setAttribute('role', 'tabpanel'); localPanel.setAttribute('role', 'tabpanel'); localPanel.hidden = true;
  const tidSearch = searchField('作品名・別名で検索（TIDも入力可）'), localSearch = searchField('シリーズ名で絞り込み');
  const sourceLabel = document.createElement('label'); sourceLabel.textContent = '辞書';
  const source = document.createElement('select');
  for (const [id, label] of [['all', 'すべて'], ['syobocal', 'しょぼいカレンダー'], ['drama', '実写辞書']]) {
    source.append(new Option(label, id));
  }
  sourceLabel.append(source);
  const tidList = document.createElement('div'), localList = document.createElement('div');
  const tidCount = document.createElement('p'), localCount = document.createElement('p');
  const tidStatus = document.createElement('p'), localStatus = document.createElement('p');
  tidStatus.setAttribute('role', 'status'); localStatus.setAttribute('role', 'status');
  const pagination = document.createElement('div'); pagination.className = 'series-registry-pagination';
  let active = 'tid', disposed = false, tidSequence = 0, localSequence = 0, page = 1, dictionaryGeneration;
  let items = [], manualGeneration, selected = new Set(), localDirty = true;
  const tidRows = new Map(), localRows = new Map();
  const previous = button('前へ', () => searchTid(page - 1));
  const next = button('次へ', () => searchTid(page + 1));
  const reload = button('再読み込み', () => active === 'tid' ? searchTid(page) : searchLocal());
  pagination.append(previous, next, reload);
  function fail(error, status) { if (!disposed && !signal.aborted) status.textContent = error.message; }
  function titleRow(item) {
    const details = document.createElement('details'); details.className = 'series-registry-tid-row';
    const summary = document.createElement('summary'), body = document.createElement('div');
    details.append(summary, body);
    const row = { root: details, summary, body, generation: dictionaryGeneration, loaded: false, loading: false, item };
    details.addEventListener('toggle', async () => {
      if (!details.open || (row.loaded && row.item.source === 'syobocal') || row.loading) return;
      row.loading = true; body.textContent = '各話情報を読み込んでいます…';
      const generation = row.generation;
      try {
        const data = await loadSeriesDictionary(row.item.source === 'syobocal' ?
          { tid: row.item.tid, signal } : { id: row.item.id, browse: true, signal });
        if (disposed || generation !== row.generation || !details.isConnected) return;
        if (data.work) { renderDramaWork(body, data.work); return; }
        const count = document.createElement('p'); count.textContent = `EP ${data.episodeCount}件`;
        const list = document.createElement('ul');
        for (const episode of data.episodes) {
          const entry = document.createElement('li'); entry.textContent = `EP ${episode.episode}${episode.subtitle ? ' · ' + episode.subtitle : ''}`; list.append(entry);
        }
        if (!data.episodes.length) { const empty = document.createElement('p'); empty.textContent = '辞書にEP情報はありません。'; body.replaceChildren(count, empty); }
        else body.replaceChildren(count, list);
        row.loaded = true;
      } catch (error) { if (!disposed && generation === row.generation && details.isConnected && !signal.aborted) body.textContent = `各話情報を取得できませんでした: ${error.message}（開き直すと再取得します）`; }
      finally { if (generation === row.generation) row.loading = false; }
    });
    return row;
  }
  async function searchTid(number = 1, isCurrent = () => true, retry = true) {
    const current = ++tidSequence, query = tidSearch.field.value.trim(); previous.disabled = next.disabled = true;
    try {
      const data = await loadSeriesDictionary({ q: query, page: number, browse: true, source: source.value,
        dictionaryGeneration: number === 1 ? undefined : dictionaryGeneration, signal });
      if (disposed || current !== tidSequence || query !== tidSearch.field.value.trim() || !isCurrent()) return;
      page = data.pagination.page; dictionaryGeneration = data.dictionaryGeneration;
      tidStatus.textContent = ''; tidCount.textContent = `${data.pagination.total}件 · ${page} / ${Math.max(1, data.pagination.totalPages)}ページ`;
      reconcile(tidList, data.results, tidRows, item => item.id, titleRow, (row, item) => {
        if (row.generation !== dictionaryGeneration) { row.generation = dictionaryGeneration; row.loaded = false; row.loading = false; row.root.open = false; row.body.replaceChildren(); }
        row.item = item;
        row.summary.textContent = [item.title, DICTIONARY_LABELS[item.source], item.tid && `TID ${item.tid}`,
          item.firstYear && `${item.firstYear}年`, additionalSeason(item.title, item.season)].filter(Boolean).join(' · ');
      });
      previous.disabled = page <= 1; next.disabled = !data.pagination.hasMore;
    } catch (error) {
      if (disposed || current !== tidSequence || !isCurrent()) return;
      if (error.status === 409 && retry) return searchTid(1, isCurrent, false);
      fail(error, tidStatus);
    }
  }
  const remove = button('選択した登録を削除', async () => {
    const targets = items.filter(item => selected.has(item.id));
    if (!targets.length || !window.confirm(`${targets.map(item => item.title).join('\n')}\n\n${targets.length}件の定義と関連付け ${targets.reduce((n, item) => n + item.associationCount, 0)}件を削除します。録画ファイル・録画履歴は削除しません。`)) return;
    remove.disabled = true;
    try { await deleteLocalSeries(targets.map(item => item.id), manualGeneration, { signal }); localStatus.textContent = '選択した登録と関連付けを削除しました。'; selected.clear(); onChanged(); }
    catch (error) { fail(error, localStatus); }
    finally { searchLocal(); }
  });
  remove.classList.add('is-danger'); remove.disabled = true;
  async function searchLocal(isCurrent = () => true) {
    const current = ++localSequence, query = localSearch.field.value.trim();
    try {
      const data = await listLocalSeries(query, { signal });
      if (disposed || current !== localSequence || query !== localSearch.field.value.trim() || !isCurrent()) return;
      localDirty = false; items = data.results; manualGeneration = data.manualGeneration;
      selected = new Set([...selected].filter(id => items.some(item => item.id === id)));
      localCount.textContent = `${items.length}件の登録`;
      reconcile(localList, items, localRows, item => item.id, item => {
        const label = document.createElement('label'); label.className = 'series-registry-local-row';
        const check = document.createElement('input'); check.type = 'checkbox';
        const text = document.createElement('span'); label.append(check, text);
        check.addEventListener('change', () => { if (check.checked) selected.add(item.id); else selected.delete(item.id); remove.disabled = !selected.size; });
        return { root: label, check, text };
      }, (row, item) => { row.check.checked = selected.has(item.id); row.text.textContent = `${item.title} · 録画 ${item.recordingCount}件 · 関連付け ${item.associationCount}件`; });
      remove.disabled = !selected.size;
    } catch (error) { if (current === localSequence && isCurrent()) fail(error, localStatus); }
  }
  const tidWatch = followInput(tidSearch.field, guard => searchTid(1, guard));
  const localWatch = followInput(localSearch.field, searchLocal);
  source.addEventListener('change', () => searchTid(1));
  for (const [kind, label] of [['tid', '作品辞書'], ['local', 'オリジナル登録一覧']]) {
    const tab = button(label, () => {
      active = kind; tidPanel.hidden = kind !== 'tid'; localPanel.hidden = kind !== 'local'; previous.hidden = next.hidden = kind !== 'tid';
      for (const node of tabs.children) node.setAttribute('aria-selected', String(node === tab));
      if (kind === 'local' && localDirty) searchLocal();
    });
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(kind === 'tid')); tabs.append(tab);
  }
  tidPanel.append(tidSearch.wrap, sourceLabel, tidCount, tidList, tidStatus); localPanel.append(localSearch.wrap, localCount, localList, remove, localStatus);
  root.append(header, tabs, tidPanel, localPanel, pagination); searchTid();
  return { root, refreshLocal() { localDirty = true; if (active === 'local') searchLocal(); },
    dispose() { disposed = true; tidSequence++; localSequence++; tidWatch.dispose(); localWatch.dispose(); } };
}
