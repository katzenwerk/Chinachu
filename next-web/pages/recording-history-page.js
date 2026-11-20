import { createHoverPopupController } from '../components/hover-popup-controller.js';

const RESULTS = ['録画完了', '録画失敗', '録画漏れ', 'スキップ'];
const COLUMNS = ['日時', '放送局', '番組タイトル', '結果', '特記事項', '録画ファイルパス'];
const PAGE_SIZE = 100;

export function renderRecordingHistoryPage(host) {
  let active = true;
  let controller = null;
  let generation = 0;
  let rows = [];
  let loadedFile = '';
  let pageIndex = 0;
  let selectedResults = new Set(RESULTS);
  host.innerHTML = `
    <div class="log-toolbar csv-toolbar">
      <label class="log-selection"><span class="visually-hidden">CSVファイル</span><select aria-label="CSVファイル" disabled></select></label>
      <div class="reserves-filter list-control-popup recorded-results-filter csv-result-filter">
        <button class="reserves-filter-control list-control-popup-trigger" type="button" aria-haspopup="true" aria-expanded="false"><span>対象</span><strong></strong></button>
        <div class="list-control-popup-panel recorded-results-filter-menu" hidden>
          ${RESULTS.map(value => `<label><input type="checkbox" value="${value}" checked><span>${value}</span></label>`).join('')}
        </div>
      </div>
      <label class="log-search"><span class="visually-hidden">CSV検索</span><input type="search" placeholder="タイトル・放送局・特記事項などを検索" aria-label="CSV検索"></label>
      <button type="button" class="button csv-refresh">更新</button>
      <button type="button" class="button csv-download" disabled>CSV保存</button>
    </div>
    <p class="csv-note">録画時点の記録です。特記事項の空欄は記載時点で特記事項なしを表し、TS解析後に補完する場合があります。削除・行方不明への状態変更は反映しません。</p>
    <p class="csv-status" role="status"></p>
    <div class="csv-table-scroll" tabindex="0" aria-label="録画履歴CSV">
      <table class="csv-table"><thead><tr>${COLUMNS.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody></tbody></table>
    </div>
    <div class="csv-pager"><button type="button" class="button csv-prev">前へ</button><span></span><button type="button" class="button csv-next">次へ</button></div>`;
  const select = host.querySelector('.log-selection select');
  const resultFilter = host.querySelector('.csv-result-filter');
  const filterTrigger = resultFilter.querySelector('button');
  const filterPanel = resultFilter.querySelector('.recorded-results-filter-menu');
  const filterInputs = Array.from(filterPanel.querySelectorAll('input'));
  const filterPopup = createHoverPopupController({ root: resultFilter, trigger: filterTrigger, panel: filterPanel });
  const search = host.querySelector('input[type="search"]');
  const status = host.querySelector('.csv-status');
  const body = host.querySelector('tbody');
  const download = host.querySelector('.csv-download');
  const previous = host.querySelector('.csv-prev');
  const next = host.querySelector('.csv-next');
  const pager = host.querySelector('.csv-pager span');

  function render() {
    const needle = search.value.trim().toLocaleLowerCase('ja-JP');
    const labels = RESULTS.filter(value => selectedResults.has(value));
    filterTrigger.querySelector('strong').textContent = `${labels.length}/${RESULTS.length}`;
    filterTrigger.setAttribute('aria-label', `対象フィルター: ${labels.length ? labels.join('、') : '選択なし'}`);
    const filtered = rows.filter(row => selectedResults.has(row[4]) &&
      (!needle || row.slice(1).some(value => value.toLocaleLowerCase('ja-JP').includes(needle))));
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    pageIndex = Math.min(pageIndex, pages - 1);
    const fragment = document.createDocumentFragment();
    for (const row of filtered.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE)) {
      const tr = document.createElement('tr');
      for (const value of row.slice(1)) {
        const td = document.createElement('td');
        td.textContent = value;
        tr.append(td);
      }
      fragment.append(tr);
    }
    body.replaceChildren(fragment);
    previous.disabled = pageIndex === 0;
    next.disabled = pageIndex + 1 >= pages;
    pager.textContent = `${filtered.length} / ${rows.length}件 · ${pageIndex + 1} / ${pages}ページ`;
    if (loadedFile) status.textContent = filtered.length ? '' : '条件に一致する記録はありません。';
  }

  async function request(params, signal) {
    const response = await fetch(`/api/recording-history.json?${params}`, {
      headers: { Accept: 'application/json' }, cache: 'no-store', signal
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
    return data;
  }

  async function load(refreshFiles = false) {
    controller?.abort();
    const requestController = new AbortController();
    controller = requestController;
    const token = ++generation;
    rows = [];
    loadedFile = '';
    download.disabled = true;
    select.disabled = true;
    render();
    status.textContent = 'CSVを読み込み中…';
    try {
      if (refreshFiles) {
        const catalog = await request(new URLSearchParams(), requestController.signal);
        if (!active || token !== generation) return;
        if (!Array.isArray(catalog.files)) throw new Error('CSV一覧の応答が不正です。');
        const selected = select.value;
        const options = catalog.files.map(filename => {
          const option = document.createElement('option'); option.value = filename; option.textContent = filename; return option;
        });
        select.replaceChildren(...options);
        if (catalog.files.includes(selected)) select.value = selected;
      }
      if (!select.value) { status.textContent = '保存済みのCSVはありません。'; return; }
      const data = await request(new URLSearchParams({ file: select.value }), requestController.signal);
      if (!active || token !== generation) return;
      if (!Array.isArray(data.rows) || data.rows.some(row => !Array.isArray(row) || row.length !== 7 || row.some(value => typeof value !== 'string'))) {
        throw new Error('CSV内容の応答が不正です。');
      }
      rows = data.rows;
      loadedFile = data.filename;
      pageIndex = 0;
      download.disabled = false;
      render();
    } catch (error) {
      if (error.name !== 'AbortError' && active && token === generation) status.textContent = `取得失敗：${error.message} 「更新」で再試行できます。`;
    } finally {
      if (active && token === generation) select.disabled = !select.options.length;
    }
  }

  select.addEventListener('change', () => load());
  filterPanel.addEventListener('change', () => {
    selectedResults = new Set(filterInputs.filter(input => input.checked).map(input => input.value));
    pageIndex = 0;
    render();
  });
  search.addEventListener('input', () => { pageIndex = 0; render(); });
  host.querySelector('.csv-refresh').addEventListener('click', () => load(true));
  previous.addEventListener('click', () => { pageIndex--; render(); });
  next.addEventListener('click', () => { pageIndex++; render(); });
  download.addEventListener('click', () => {
    // Download the complete selected file, independent of the display filters.
    const cell = value => {
      const text = /^[\t\r\n ]*[=+\-@]/.test(value) ? `'${value}` : value;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const header = ['key', 'start', 'channel', 'title', 'result', 'remarks', 'recordedPath'];
    const text = '\uFEFF' + [header, ...rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = loadedFile;
    document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  render();
  load(true);
  return () => { active = false; generation++; controller?.abort(); filterPopup.destroy(); host.replaceChildren(); };
}
