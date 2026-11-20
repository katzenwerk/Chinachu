let currentDialog = null;
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const ACTIONS = { move: 'ファイル移動', repair: '録画履歴のパス修正' };

export function openRecordedFolderDialog() {
  if (currentDialog?.isConnected) { currentDialog.focus(); return currentDialog; }
  const dialog = document.createElement('dialog');
  dialog.className = 'cleaner-dialog recorded-folder-dialog';
  dialog.setAttribute('aria-labelledby', 'recorded-folder-title');
  currentDialog = dialog;
  let state = null, sending = false, error = '', timer = null, refreshSequence = 0;
  let displayJobId = null;
  async function request(input) {
    const response = await fetch('/api/recorded-folder.json', input ? {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, cache: 'no-store', body: JSON.stringify(input)
    } : { headers: { Accept: 'application/json' }, cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
    return result;
  }
  async function refresh() {
    const sequence = ++refreshSequence;
    try {
      const result = await request();
      if (sequence !== refreshSequence) return;
      // Adopt an already running job, but never a previously completed result.
      if (displayJobId === null && result.busy && result.job?.status === 'running') displayJobId = result.job.id;
      state = result; error = '';
    } catch (failure) { if (sequence === refreshSequence) error = failure.message; }
    if (!dialog.isConnected || sequence !== refreshSequence) return;
    render();
    clearTimeout(timer);
    if (!state || state.busy || state.seriesReady !== true) timer = window.setTimeout(refresh, 1000);
  }
  async function organize() {
    if (sending || state?.busy || state?.seriesReady !== true) return;
    ++refreshSequence;
    clearTimeout(timer);
    sending = true; error = '';
    displayJobId = null;
    render();
    try {
      const started = await request({ action: 'run' });
      displayJobId = started.job.id;
      await refresh();
    } catch (failure) {
      await refresh();
      error = failure.message;
    }
    finally { sending = false; if (dialog.isConnected) render(); }
  }
  function resultsHtml() {
    if (sending || state?.busy || !displayJobId || state?.job?.id !== displayJobId ||
        !['complete', 'failed'].includes(state.job.status)) return '';
    if (state.job.status === 'complete' && !state.result) return '';
    const rows = state?.result?.results || [];
    // These are the planned changes, in the same execution order as apply().
    // A recovery stops execution; subsequent unapplied rows were never attempted.
    const actions = rows.filter(row => row.action === 'move' || row.action === 'repair')
      .sort((a, b) => Number(b.action === 'move') - Number(a.action === 'move'));
    const recoveryIndex = actions.findIndex(row => row.status === 'recovery');
    const groups = [
      ['ファイル移動', actions.filter(row => row.status === 'complete' && row.action === 'move')],
      ['録画履歴のパス修正', actions.filter(row => row.status === 'complete' && row.action === 'repair')],
      ['処理エラー', actions.filter((row, index) => ['failed', 'recovery'].includes(row.status) ||
        row.status === 'unapplied' && (recoveryIndex < 0 || index < recoveryIndex))]
    ];
    const jobFailed = state.job.status === 'failed';
    if (!jobFailed && groups.every(([, items]) => items.length === 0)) return '<p role="status">変更はありませんでした。</p>';
    return '<h3>振り分け結果</h3>' + groups.filter(([, items]) => items.length > 0).map(([label, items]) => `<details class="help-details"><summary>${label}：${items.length}件</summary>
      <ul class="cleaner-dialog-result-list">${items.map(row => `<li><strong>${escape(row.title || row.id)} / ${ACTIONS[row.action] || ''}</strong>
      <code>${escape(row.oldPath)}</code>${row.currentPath && row.currentPath !== row.oldPath ? `<small>確認した保存先：${escape(row.currentPath)}</small>` : ''}
      ${row.newPath ? `<code>→ ${escape(row.newPath)}</code>` : ''}<small>${row.status === 'recovery' ? '復旧が必要 / ' : ''}${escape(row.reason)}</small></li>`).join('')}</ul></details>`).join('') +
      (jobFailed ? `<details class="help-details" open><summary>ジョブエラー：1件</summary><p>${escape(state.job.error?.message || '処理が異常終了または中断しました。')}</p></details>` : '');
  }
  function render() {
    const busy = sending || state?.busy;
    const preparing = state?.seriesReady !== true;
    const statusMessage = busy ? `振り分け中… ${sending ? '開始中' : state?.job?.progress?.phase || '開始中'}。閉じても処理は継続します。` :
      preparing ? state ? 'シリーズ情報を準備しています。準備が完了すると実行できます。' : '実行条件を確認しています…' : '';
    dialog.innerHTML = `<header class="cleaner-dialog-header"><div><h2 id="recorded-folder-title">録画ファイルの振り分け</h2></div></header>
      <div class="cleaner-dialog-body"><p>録画先に作品名などのサブフォルダをあらかじめ作成しておくと、フォルダ名に合う録画ファイルをまとめて振り分けられます。</p>
      <p>あわせて録画履歴の保存先も全件確認し、実際のファイルの場所と異なる場合は、ファイルを特定できたものだけ登録パスを修正します。</p>
      <p class="cleaner-dialog-note">※ 移動対象は録画先の直下にあるファイルのみです。サブフォルダ内のファイルは移動しません。</p>
      ${state?.pending && !busy ? '<p class="cleaner-dialog-note">未完了の処理は、次の「振り分けを実行」で保存先と履歴を確認して復旧します。</p>' : ''}
      <p role="status">${escape(error || statusMessage)}</p>
      ${resultsHtml()}</div>
      <footer class="cleaner-dialog-footer"><button class="button" data-close type="button">閉じる</button>
      <button class="button primary" data-organize type="button" ${busy || preparing ? 'disabled' : ''}>${busy ? '振り分け中…' : '振り分けを実行'}</button></footer>`;
    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    dialog.querySelector('[data-organize]').addEventListener('click', organize);
  }
  dialog.addEventListener('close', () => { ++refreshSequence; clearTimeout(timer); dialog.remove(); currentDialog = null; }, { once: true });
  document.body.append(dialog); render(); dialog.showModal(); refresh();
  return dialog;
}
