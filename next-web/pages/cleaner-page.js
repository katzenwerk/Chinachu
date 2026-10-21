import { openCleanerDialog } from '../components/cleaner-dialog.js';

export function renderCleanerPage(container) {
  let active = true;
  const panel = document.createElement('section');
  panel.className = 'panel cleaner-launcher';
  panel.innerHTML = `
    <h2>台帳整理</h2>
    <p>録画ファイルと台帳の突合、パス修復、削除済み台帳の整理をモーダルで実行します。</p>
    <button class="button primary" type="button">台帳整理を開く</button>`;
  panel.querySelector('button').addEventListener('click', openCleanerDialog);
  container.replaceChildren(panel);
  queueMicrotask(() => {
    if (active && panel.isConnected) openCleanerDialog();
  });
  return () => { active = false; };
}
