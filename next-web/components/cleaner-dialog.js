import { applyCleanerPlan, loadCleanerState, startCleanerScan } from '../services/cleaner-client.js';

let currentDialog = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function milliseconds(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${(number / 1000).toFixed(1)}秒` : '--';
}

function resultList(result, classes, automatic = true, actions = null) {
  const rows = (result?.results || []).filter(item => item.automatic === automatic &&
    (actions ? actions.includes(item.action) : classes.includes(item.classification)));
  if (rows.length === 0) return '<p class="cleaner-dialog-empty">対象はありません。</p>';
  const visible = rows.slice(0, 100);
  return `${rows.length > visible.length ? `<p class="cleaner-dialog-note">先頭${visible.length}件を表示しています。</p>` : ''}<ul class="cleaner-dialog-result-list">${visible.map(item => `<li>
    <strong>${escapeHtml(item.title || item.id || '(タイトルなし)')}</strong>
    <code>${escapeHtml(item.originalPath || '--')}</code>
    ${item.newPath ? `<span>→</span><code>${escapeHtml(item.newPath)}</code>` : ''}
    <small>${escapeHtml(item.ledger || '')}${item.reason ? ` / ${escapeHtml(item.reason)}` : ''}</small>
  </li>`).join('')}</ul>`;
}

export function openCleanerDialog() {
  if (currentDialog?.isConnected) {
    if (!currentDialog.open) currentDialog.showModal();
    currentDialog.focus();
    return currentDialog;
  }

  const dialog = document.createElement('dialog');
  dialog.className = 'cleaner-dialog';
  dialog.setAttribute('aria-labelledby', 'cleaner-dialog-title');
  document.body.append(dialog);
  currentDialog = dialog;

  let state = null;
  let error = null;
  let loading = true;
  let starting = false;
  let step = 'settings';
  let checkLocations = true;
  let pathRepair = true;
  let cleanupMissing = true;
  let cleanupMissed = false;
  let pollTimer = null;

  const schedulePoll = () => {
    clearTimeout(pollTimer);
    if (!dialog.isConnected || state?.job?.status !== 'running') return;
    pollTimer = window.setTimeout(refresh, 1000);
  };

  function renderHeader() {
    return `<header class="cleaner-dialog-header"><div><h2 id="cleaner-dialog-title">台帳整理</h2><p>録画ファイルと台帳を照合し、不要な情報を整理します。</p></div><button class="cleaner-dialog-close" type="button" aria-label="閉じる">×</button></header>`;
  }

  function settingsBody() {
    const roots = state?.roots || [];
    return `<div class="cleaner-dialog-body">
      <p>対象：登録済みの録画フォルダ（${roots.length}件）</p>
      <div class="cleaner-warning" role="note"><strong>HDD走査の注意</strong><span>突合を開始すると全録画フォルダとサブフォルダを1回列挙します。休止中のHDDが起動する場合があります。</span></div>
      <fieldset class="cleaner-dialog-options"><legend>オプション</legend>
        <label><input data-cleaner-location-check type="checkbox" ${checkLocations ? 'checked' : ''}><span><strong>録画ファイルの所在確認</strong><small>登録録画フォルダを走査し、recorded.json と実ファイルを照合</small></span></label>
        <label><input data-cleaner-path-repair type="checkbox" ${pathRepair ? 'checked' : ''} ${checkLocations ? '' : 'disabled'}><span><strong>録画ファイルのパス修復</strong><small>別フォルダで一意に見つかった同名録画の台帳パスを修復</small></span></label>
        <label><input data-cleaner-cleanup type="checkbox" ${cleanupMissing ? 'checked' : ''}><span><strong>不要な録画台帳の整理</strong><small>不在が確定した recorded.json、録画台帳不整合履歴、削除済みmatch、終了済みスキップ履歴を整理</small></span></label>
        <label class="cleaner-dialog-suboption"><input data-cleaner-cleanup-missed type="checkbox" ${cleanupMissed ? 'checked' : ''} ${cleanupMissing ? '' : 'disabled'}><span><strong>録画実績のない過去予約も整理する</strong><small>停電・容量不足・録画処理の失敗などにより、録画実績が残っていない過去予約を整理します。原因が不明なものも含みます。</small></span></label>
      </fieldset>
      <details class="cleaner-dialog-roots"><summary>対象フォルダを確認</summary>${roots.map(root => `<code>${escapeHtml(root.path)}</code>`).join('') || '<p>登録録画フォルダがありません。</p>'}</details>
      <p class="cleaner-dialog-note">録画ファイル、未登録TS、CSV、現在・未来の予約は変更しません。</p>
    </div><footer class="cleaner-dialog-footer"><button class="button" data-cleaner-close type="button">閉じる</button><button class="button primary" data-cleaner-scan type="button" ${starting || checkLocations && roots.length === 0 ? 'disabled' : ''}>${starting ? '開始中…' : '候補を確認'}</button></footer>`;
  }

  function progressBody(job) {
    const apply = job?.type === 'apply';
    return `<div class="cleaner-dialog-body cleaner-dialog-progress" aria-live="polite">
      <div class="cleaner-progress-spinner" aria-hidden="true"></div>
      <h3>${apply ? '台帳を再確認して整理しています' : '録画フォルダを列挙しています'}</h3>
      <p>${escapeHtml(job?.progress?.phase || 'queued')} / ${Number(job?.progress?.files || 0).toLocaleString('ja-JP')}ファイル / ${Number(job?.progress?.visitedDirectories || 0).toLocaleString('ja-JP')}ディレクトリ</p>
      <small>モーダルを閉じても処理は継続します。多重起動はバックエンドで拒否されます。</small>
    </div><footer class="cleaner-dialog-footer"><button class="button" data-cleaner-close type="button">閉じる</button></footer>`;
  }

  function previewBody(job) {
    const result = job.result;
    const summary = result.summary;
    const held = ['ambiguous', 'review', 'uninspected', 'deletedMatchHeld', 'recordedMissingHistoryHeld',
      'recordedMissingUninspected', 'skippedHistoryHeld', 'missedHistoryHeld']
      .reduce((total, key) => total + Number(summary[key] || 0), 0);
    const repair = result.results.filter(item => item.automatic && (item.action === 'normalize-location' || item.action === 'sync-match-path')).length;
    const recordedRemovals = result.results.filter(item => item.automatic && item.action === 'remove-history').length;
    const actionable = result.results.filter(item => item.automatic).length;
    const canApply = result.applyAvailable && result.index.complete && !result.options.selectedIds && actionable > 0;
    const cleanupItems = [
      { label: 'パス修復候補', count: repair, classes: [], actions: ['normalize-location', 'sync-match-path'] },
      { label: 'recorded整理候補', count: recordedRemovals, classes: ['missing'] },
      { label: '録画台帳不整合履歴候補', count: Number(summary.recordedMissingHistory || 0), classes: ['recorded-missing-history'] },
      { label: '削除済みmatch候補', count: Number(summary.deletedMatch || 0), classes: ['deleted-match'] },
      { label: '過去スキップ履歴候補', count: Number(summary.skippedHistory || 0), classes: ['skipped-history'] },
      ...(result.options.cleanupMissed ? [{ label: '未録画履歴候補', count: Number(summary.missedHistory || 0), classes: ['missed-history'] }] : [])
    ].filter(item => item.count > 0);
    return `<div class="cleaner-dialog-body">
      <section class="cleaner-dialog-summary cleaner-dialog-summary-primary" aria-label="整理候補">
        <div class="is-total"><span>整理対象合計</span><strong>${actionable.toLocaleString('ja-JP')}件</strong></div>
        ${cleanupItems.map(item => `<div><span>${item.label}</span><strong>${item.count.toLocaleString('ja-JP')}件</strong></div>`).join('')}
      </section>
      <section class="cleaner-dialog-meta" aria-label="突合の補助情報">
        <span>正常 ${Number(summary.ok || 0).toLocaleString('ja-JP')}件</span>
        <span>TSファイル ${Number(result.index.files || 0).toLocaleString('ja-JP')}件</span>
        <span>録画台帳 ${Number(summary.total || 0).toLocaleString('ja-JP')}件</span>
        ${Number(summary.recordedMissingFound || 0) > 0 ? `<span>実ファイル発見で保持 ${Number(summary.recordedMissingFound).toLocaleString('ja-JP')}件</span>` : ''}
        ${held > 0 ? `<span class="is-held">判定保留 ${held.toLocaleString('ja-JP')}件</span>` : ''}
      </section>
      <section class="cleaner-dialog-timing"><h3>処理時間</h3><dl><div><dt>TSファイル列挙</dt><dd>${milliseconds(result.timings?.enumerationMs)}</dd></div><div><dt>台帳突合</dt><dd>${milliseconds(result.timings?.reconciliationMs)}</dd></div><div><dt>合計</dt><dd>${milliseconds(result.timings?.totalMs)}</dd></div></dl></section>
      ${cleanupItems.map(item => `<details><summary>${item.label} ${item.count.toLocaleString('ja-JP')}件</summary>${resultList(result, item.classes, true, item.actions)}</details>`).join('')}
      ${held > 0 ? `<details class="cleaner-dialog-held"><summary>判定保留 ${held.toLocaleString('ja-JP')}件</summary>${resultList(result, ['ambiguous', 'review', 'uninspected', 'deleted-match-held', 'recorded-missing-history-held', 'recorded-missing-uninspected', 'skipped-history-held', 'missed-history-held'], false)}</details>` : ''}
      ${result.index.complete ? '' : '<p class="cleaner-dialog-danger">走査が完了していない録画先があるため、整理実行はできません。</p>'}
      <p class="cleaner-dialog-warning">CSV有効化前の古い録画履歴は月別CSVに保存されていない可能性があります。CSVは今回の整理対象ではありません。</p>
    </div><footer class="cleaner-dialog-footer"><button class="button" data-cleaner-back type="button">戻る</button><button class="button is-danger" data-cleaner-apply type="button" ${canApply ? '' : 'disabled'}>整理を実行</button></footer>`;
  }

  function completeBody(job) {
    const result = job.result;
    const counts = result.counts || {};
    return `<div class="cleaner-dialog-body">
      <h3>台帳整理が完了しました</h3>
      <section class="cleaner-dialog-summary">
        ${[['パス修復成功', counts.pathRepaired], ['整理番組', counts.programsRemoved], ['recorded由来', counts.recordedHistoryRemoved], ['録画台帳不整合由来', counts.recordedMissingHistoryRemoved], ['削除済みmatch由来', counts.deletedMatchHistoryRemoved], ['過去スキップ由来', counts.skippedHistoryRemoved], ['未録画履歴由来', counts.missedHistoryRemoved], ['recorded削除', counts.recordedRemoved], ['reserves2削除', counts.reserves2Removed], ['match削除', counts.matchRemoved], ['サムネイル削除', counts.thumbnailDeleted], ['保留', counts.held], ['失敗', result.errors]].map(([label, value]) => `<div><span>${label}</span><strong>${Number(value || 0).toLocaleString('ja-JP')}件</strong></div>`).join('')}
      </section>
      <section class="cleaner-dialog-timing"><h3>処理時間</h3><dl><div><dt>再列挙</dt><dd>${milliseconds(result.timings?.enumerationMs)}</dd></div><div><dt>台帳突合</dt><dd>${milliseconds(result.timings?.reconciliationMs)}</dd></div><div><dt>台帳更新</dt><dd>${milliseconds(result.timings?.ledgerUpdateMs ?? result.durationMs)}</dd></div><div><dt>合計</dt><dd>${milliseconds(result.timings?.totalMs)}</dd></div></dl></section>
      ${result.thumbnailErrors?.length ? `<details><summary>サムネイル削除エラー ${result.thumbnailErrors.length}件</summary><ul class="cleaner-dialog-result-list">${result.thumbnailErrors.map(item => `<li><strong>${escapeHtml(item.id)}</strong><small>${escapeHtml(item.code)} / ${escapeHtml(item.message)}</small></li>`).join('')}</ul></details>` : ''}
      <p class="cleaner-dialog-note">台帳更新完了後に、整理対象のサムネイルだけを削除しました。</p>
    </div><footer class="cleaner-dialog-footer"><button class="button primary" data-cleaner-close type="button">閉じる</button></footer>`;
  }

  function render() {
    if (!dialog.isConnected) return;
    const job = state?.job;
    let body;
    if (loading) body = '<div class="cleaner-dialog-body cleaner-dialog-progress"><p>台帳整理の状態を読み込んでいます…</p></div>';
    else if (error) body = `<div class="cleaner-dialog-body"><h3>台帳整理を利用できません</h3><p class="cleaner-dialog-danger">${escapeHtml(error.message || error)}</p></div><footer class="cleaner-dialog-footer"><button class="button" data-cleaner-retry type="button">再試行</button></footer>`;
    else if (job?.status === 'running') body = progressBody(job);
    else if (job?.status === 'failed') body = `<div class="cleaner-dialog-body"><h3>処理に失敗しました</h3><p class="cleaner-dialog-danger">${escapeHtml(job.error?.message || '不明なエラー')}</p></div><footer class="cleaner-dialog-footer"><button class="button" data-cleaner-back type="button">戻る</button></footer>`;
    else if (step === 'complete' && job?.type === 'apply' && job?.status === 'complete') body = completeBody(job);
    else if (step === 'preview' && job?.type === 'scan' && job?.result) body = previewBody(job);
    else body = settingsBody();
    dialog.innerHTML = renderHeader() + body;

    dialog.querySelector('.cleaner-dialog-close')?.addEventListener('click', () => dialog.close());
    dialog.querySelectorAll('[data-cleaner-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
    dialog.querySelector('[data-cleaner-retry]')?.addEventListener('click', refresh);
    dialog.querySelector('[data-cleaner-back]')?.addEventListener('click', () => { state.job = null; step = 'settings'; render(); });
    dialog.querySelector('[data-cleaner-location-check]')?.addEventListener('change', event => {
      pathRepair = dialog.querySelector('[data-cleaner-path-repair]')?.checked !== false;
      cleanupMissing = dialog.querySelector('[data-cleaner-cleanup]')?.checked !== false;
      cleanupMissed = dialog.querySelector('[data-cleaner-cleanup-missed]')?.checked === true;
      checkLocations = event.currentTarget.checked;
      if (!checkLocations) pathRepair = false;
      render();
    });
    dialog.querySelector('[data-cleaner-cleanup]')?.addEventListener('change', event => {
      cleanupMissed = dialog.querySelector('[data-cleaner-cleanup-missed]')?.checked === true;
      cleanupMissing = event.currentTarget.checked;
      if (!cleanupMissing) cleanupMissed = false;
      render();
    });
    dialog.querySelector('[data-cleaner-scan]')?.addEventListener('click', async () => {
      checkLocations = dialog.querySelector('[data-cleaner-location-check]')?.checked !== false;
      pathRepair = dialog.querySelector('[data-cleaner-path-repair]')?.checked !== false;
      if (!checkLocations) pathRepair = false;
      cleanupMissing = dialog.querySelector('[data-cleaner-cleanup]')?.checked !== false;
      cleanupMissed = cleanupMissing && dialog.querySelector('[data-cleaner-cleanup-missed]')?.checked === true;
      starting = true;
      render();
      try {
        const jobState = await startCleanerScan({
          checkLocations,
          normalizeLocations: pathRepair,
          missingPolicy: cleanupMissing ? 'remove-history' : 'report',
          cleanupMissed,
          selectedIds: null
        });
        state.job = jobState;
        step = 'preview';
      } catch (scanError) {
        error = scanError;
      } finally {
        starting = false;
        render();
        schedulePoll();
      }
    });
    dialog.querySelector('[data-cleaner-apply]')?.addEventListener('click', async () => {
      try {
        step = 'complete';
        state.job = await applyCleanerPlan(job.id);
        render();
        schedulePoll();
      } catch (applyError) {
        error = applyError;
        render();
      }
    });
  }

  async function refresh() {
    if (!dialog.isConnected) return;
    try {
      state = await loadCleanerState();
      error = null;
    } catch (loadError) {
      error = loadError;
    } finally {
      loading = false;
      render();
      schedulePoll();
    }
  }

  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    clearTimeout(pollTimer);
    dialog.remove();
    if (currentDialog === dialog) currentDialog = null;
  }, { once: true });
  dialog.showModal();
  refresh();
  return dialog;
}
