import { requestSeriesRename } from '../services/series-client.js';
import { pushSystemActivity } from '../services/notification-store.js';

export function openSeriesRenameDialog(series, trigger) {
  const dialog = document.createElement('dialog');
  dialog.className = 'cleaner-dialog recorded-folder-dialog';
  dialog.setAttribute('aria-labelledby', 'series-rename-title');
  dialog.innerHTML = `<header class="cleaner-dialog-header"><h2 id="series-rename-title">ファイル名整理</h2></header>
    <div class="cleaner-dialog-body"><p data-series></p><p data-status role="status"></p>
    <ul class="cleaner-dialog-result-list"></ul></div>
    <footer class="cleaner-dialog-footer"><button class="button" type="button" data-close>閉じる</button>
    <button class="button primary button-with-spinner" type="button" data-run>ファイル名を変更</button></footer>`;
  dialog.querySelector('[data-series]').textContent = series.title;
  const status = dialog.querySelector('[data-status]');
  const list = dialog.querySelector('ul');
  const run = dialog.querySelector('[data-run]');
  const close = dialog.querySelector('[data-close]');
  const seriesId = series.id;
  let preview = null;
  let working = false;
  function setWorking(value) {
    working = value;
    trigger.disabled = value;
    close.disabled = value;
    run.disabled = value || !preview?.count;
    for (const button of [trigger, run]) {
      button.classList.toggle('is-running', value);
      button.setAttribute('aria-busy', String(value));
    }
  }
  function display(rows) {
    list.replaceChildren(...rows.filter(row => row.status !== 'unchanged').map(row => {
      const item = document.createElement('li');
      if (row.before) {
        const name = document.createElement('code');
        name.textContent = row.before;
        item.append(name);
      }
      if (row.after) {
        const name = document.createElement('code');
        name.textContent = '→ ' + row.after;
        item.append(name);
      }
      if (row.reason) {
        const reason = document.createElement('small');
        reason.textContent = row.reason;
        item.append(reason);
      }
      return item;
    }));
  }
  async function loadPreview() {
    status.textContent = '変更前後のファイル名を確認しています…';
    setWorking(true);
    try {
      preview = await requestSeriesRename({ action: 'rename-preview', seriesId });
      status.textContent = preview.count ? `対象 ${preview.count}件。変更前後のファイル名を確認してください。` : '変更できる録画ファイルはありません。';
      display(preview.rows);
    } catch (error) {
      status.textContent = error.message;
    } finally { setWorking(false); }
  }
  run.addEventListener('click', async () => {
    if (working || !preview?.count) return;
    setWorking(true);
    status.textContent = 'ファイル名を変更しています…';
    try {
      const { job } = await requestSeriesRename({ action: 'rename-run', seriesId, token: preview.token });
      preview = null;
      let state;
      do {
        await new Promise(resolve => window.setTimeout(resolve, 1000));
        state = await requestSeriesRename({ action: 'rename-state', jobId: job.id });
      } while (state.busy);
      if (state.job.status !== 'complete' || !state.result) throw new Error(state.job.error?.message || '改名結果を取得できませんでした。');
      const completed = state.result.filter(row => row.status === 'complete').length;
      const failed = state.result.filter(row => ['failed', 'recovery', 'unapplied'].includes(row.status)).length;
      status.textContent = `改名完了 ${completed}件${failed ? `、未完了 ${failed}件` : ''}。`;
      display(state.result);
      if (completed) pushSystemActivity('recorded', 'シリーズのファイル名整理', '#series?id=' + encodeURIComponent(seriesId), status.textContent);
    } catch (error) {
      status.textContent = error.message;
    } finally { setWorking(false); }
  });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (working) event.preventDefault(); });
  dialog.addEventListener('close', () => { dialog.remove(); trigger.focus(); }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
  loadPreview();
}
