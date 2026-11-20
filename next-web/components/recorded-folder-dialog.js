let currentDialog = null;
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const ACTIONS = { move: '振り分け移動', repair: 'パス修復のみ', none: '対象外・判定不可' };
const ORDERS = { filename: 'ファイル名 → 作品名 → 過去実績', title: '作品名 → ファイル名 → 過去実績', history: '過去実績 → ファイル名 → 作品名' };

export function openRecordedFolderDialog() {
  if (currentDialog?.isConnected) { currentDialog.focus(); return currentDialog; }
  const dialog = document.createElement('dialog');
  dialog.className = 'cleaner-dialog';
  dialog.setAttribute('aria-labelledby', 'recorded-folder-title');
  currentDialog = dialog;
  let state = null, repairPaths = false, sending = false, error = '', timer = null;
  async function request(input) {
    const response = await fetch('/api/recorded-folder.json', input ? {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, cache: 'no-store', body: JSON.stringify(input)
    } : { headers: { Accept: 'application/json' }, cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    return result;
  }
  async function refresh() {
    try { state = await request(); error = ''; }
    catch (failure) { error = failure.message; }
    if (!dialog.isConnected) return;
    render();
    clearTimeout(timer);
    if (state?.busy) timer = window.setTimeout(refresh, 1000);
  }
  async function act(input) {
    if (sending) return;
    sending = true; error = ''; render();
    try { await request(input); await refresh(); }
    catch (failure) { error = failure.message; }
    finally { sending = false; if (dialog.isConnected) render(); }
  }
  function resultsHtml() {
    const rows = state?.result?.results || [];
    if (!rows.length) return state?.job?.status === 'complete' ? '<p>対象はありません。</p>' : '';
    const preview = state.job.action === 'evaluate';
    const groups = preview ? [
      ['振り分け移動', rows.filter(row => row.action === 'move')],
      ['パス修復のみ', rows.filter(row => row.action === 'repair')],
      ['対象外・判定不可', rows.filter(row => row.action === 'none' && row.status !== 'failed')],
      ['確認失敗', rows.filter(row => row.status === 'failed')]
    ] : [
      ['適用済み', rows.filter(row => row.status === 'complete')],
      ['復旧が必要', rows.filter(row => row.status === 'recovery')],
      ['未適用・対象外', rows.filter(row => !['complete', 'recovery'].includes(row.status))]
    ];
    return groups.map(([label, items]) => `<details class="help-details" ${label === '対象外・判定不可' ? '' : 'open'}><summary>${label}：${items.length}件</summary>
      <ul class="cleaner-dialog-result-list">${items.map(row => `<li><strong>${escape(row.title || row.id)} / ${ACTIONS[row.action] || ''}</strong>
      <code>${escape(row.oldPath)}</code>${row.currentPath && row.currentPath !== row.oldPath ? `<small>現在：${escape(row.currentPath)}</small>` : ''}
      ${row.newPath ? `<code>→ ${escape(row.newPath)}</code>` : ''}<small>${escape(row.reason)}</small></li>`).join('')}</ul></details>`).join('');
  }
  function render() {
    const busy = sending || state?.busy;
    const preview = state?.job?.action === 'evaluate' && state.job.status === 'complete' && state.result?.options.repairPaths === repairPaths ? state.result : null;
    const moves = preview?.results.filter(row => row.action === 'move').length || 0;
    const repairs = preview?.results.filter(row => row.action === 'repair').length || 0;
    dialog.innerHTML = `<header class="cleaner-dialog-header"><div><h2 id="recorded-folder-title">録画フォルダの振り分け</h2>
      <p>登録済み録画先の直下にある終了済み録画を、既存サブフォルダへ振り分けます。</p></div>
      <button class="cleaner-dialog-close" data-close type="button" aria-label="閉じる">×</button></header>
      <div class="cleaner-dialog-body"><p>検索・絞り込みにかかわらず、録画先直下の全対象を評価します。</p>
      <fieldset class="cleaner-dialog-options" ${busy ? 'disabled' : ''}><legend>オプション</legend>
      <label><input data-repair type="checkbox" ${repairPaths ? 'checked' : ''}><span><strong>保存パスも確認・修復する</strong>
      <small>同じ録画先のサブフォルダも捜索します。手動移動済みなら台帳パスだけを修復します。</small></span></label></fieldset>
      <p class="cleaner-dialog-note">OFFでも対象ファイルと直下のフォルダを確認します。HDDが起動する場合があります。移動成功分の台帳パスはチェックに関係なく更新します。</p>
      <p class="cleaner-dialog-note">${preview ? `判定順：${escape(ORDERS[preview.order] || ORDERS.filename)}。` : ''}フォルダ作成・別録画先への移動・履歴削除は行いません。</p>
      ${state?.pending ? '<p class="cleaner-warning">未完了の操作があります。「未完了を復旧」で対象と台帳を確認して復旧してください。</p>' : ''}
      <p role="status">${escape(error || state?.job?.error?.message || (state?.busy ? `処理中：${state.job?.progress?.phase || '開始中'}。閉じても処理は継続します。` : ''))}</p>
      ${resultsHtml()}</div>
      <footer class="cleaner-dialog-footer"><button class="button" data-close type="button">閉じる</button>
      ${state?.pending ? `<button class="button" data-recover type="button" ${busy ? 'disabled' : ''}>未完了を復旧</button>` : ''}
      <button class="button" data-refresh type="button" ${busy ? 'disabled' : ''}>状態を更新</button>
      <button class="button" data-evaluate type="button" ${busy || !state || state.pending ? 'disabled' : ''}>評価する</button>
      ${preview && moves + repairs ? `<button class="button primary" data-apply type="button" ${busy || state.pending ? 'disabled' : ''}>適用する（移動${moves}・修復${repairs}件）</button>` : ''}</footer>`;
    dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
    dialog.querySelector('[data-repair]').addEventListener('change', event => {
      repairPaths = event.target.checked;
      // A changed option always requires another evaluation.
      if (state?.job?.action === 'evaluate') { state.result = null; render(); }
    });
    dialog.querySelector('[data-evaluate]').addEventListener('click', () => act({ action: 'evaluate', repairPaths }));
    dialog.querySelector('[data-refresh]').addEventListener('click', refresh);
    dialog.querySelector('[data-apply]')?.addEventListener('click', () => act({ action: 'apply', previewId: preview.id, confirm: true }));
    dialog.querySelector('[data-recover]')?.addEventListener('click', () => act({ action: 'recover', confirm: true }));
  }
  dialog.addEventListener('close', () => { clearTimeout(timer); dialog.remove(); currentDialog = null; }, { once: true });
  document.body.append(dialog); render(); dialog.showModal(); refresh();
  return dialog;
}
