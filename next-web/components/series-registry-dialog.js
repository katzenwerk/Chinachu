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
  const tidSearch = searchField('作品名・TIDで絞り込み'), localSearch = searchField('シリーズ名で絞り込み');
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
      if (!details.open || row.loaded || row.loading) return;
      row.loading = true; body.textContent = 'EP情報を読み込んでいます…';
      const generation = row.generation;
      try {
        const data = await loadSeriesDictionary({ tid: row.item.tid, dictionaryGeneration: generation, signal });
        if (disposed || generation !== row.generation || !details.isConnected) return;
        const count = document.createElement('p'); count.textContent = `EP ${data.episodeCount}件`;
        const list = document.createElement('ul');
        for (const episode of data.episodes) {
          const entry = document.createElement('li'); entry.textContent = `EP ${episode.episode}${episode.subtitle ? ' · ' + episode.subtitle : ''}`; list.append(entry);
        }
        if (!data.episodes.length) { const empty = document.createElement('p'); empty.textContent = '辞書にEP情報はありません。'; body.replaceChildren(count, empty); }
        else body.replaceChildren(count, list);
        row.loaded = true;
      } catch (error) { if (!disposed && generation === row.generation && details.isConnected && !signal.aborted) body.textContent = `EP情報を取得できませんでした: ${error.message}（開き直すと再取得します）`; }
      finally { if (generation === row.generation) row.loading = false; }
    });
    return row;
  }
  async function searchTid(number = 1, isCurrent = () => true, retry = true) {
    const current = ++tidSequence, query = tidSearch.field.value.trim(); previous.disabled = next.disabled = true;
    try {
      const data = await loadSeriesDictionary({ q: query, page: number, dictionaryGeneration: number === 1 ? undefined : dictionaryGeneration, signal });
      if (disposed || current !== tidSequence || query !== tidSearch.field.value.trim() || !isCurrent()) return;
      page = data.pagination.page; dictionaryGeneration = data.dictionaryGeneration;
      tidStatus.textContent = ''; tidCount.textContent = `${data.pagination.total}件 · ${page} / ${Math.max(1, data.pagination.totalPages)}ページ`;
      reconcile(tidList, data.results, tidRows, item => item.tid, titleRow, (row, item) => {
        if (row.generation !== dictionaryGeneration) { row.generation = dictionaryGeneration; row.loaded = false; row.loading = false; row.root.open = false; row.body.replaceChildren(); }
        row.item = item; row.summary.textContent = `${item.title} · TID ${item.tid}`;
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
  for (const [kind, label] of [['tid', 'TID登録一覧'], ['local', 'オリジナル登録一覧']]) {
    const tab = button(label, () => {
      active = kind; tidPanel.hidden = kind !== 'tid'; localPanel.hidden = kind !== 'local'; previous.hidden = next.hidden = kind !== 'tid';
      for (const node of tabs.children) node.setAttribute('aria-selected', String(node === tab));
      if (kind === 'local' && localDirty) searchLocal();
    });
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(kind === 'tid')); tabs.append(tab);
  }
  tidPanel.append(tidSearch.wrap, tidCount, tidList, tidStatus); localPanel.append(localSearch.wrap, localCount, localList, remove, localStatus);
  root.append(header, tabs, tidPanel, localPanel, pagination); searchTid();
  return { root, refreshLocal() { localDirty = true; if (active === 'local') searchLocal(); },
    dispose() { disposed = true; tidSequence++; localSequence++; tidWatch.dispose(); localWatch.dispose(); } };
}
