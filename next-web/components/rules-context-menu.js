import { viewportCssPixels } from '../services/ui-scale.js';
// ルール一覧の操作。右クリック直後は自動フォーカスしない。
export function createRulesContextMenu({ onAction }) {
  const menu = document.createElement('div');
  menu.className = 'rules-context-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'ルールの操作');
  menu.hidden = true;
  menu.innerHTML = `
    <button type="button" role="menuitem" data-action="edit">ルール編集</button>
    <button type="button" role="menuitem" data-action="toggle"></button>
    <hr role="separator">
    <button type="button" role="menuitem" data-action="reserves">予約一覧を表示</button>
    <button type="button" role="menuitem" data-action="recorded">録画実績を表示</button>
    <hr role="separator">
    <button type="button" role="menuitem" data-action="duplicate">ルールを複製</button>
    <hr role="separator">
    <button class="is-danger" type="button" role="menuitem" data-action="delete">ルール削除…</button>`;
  document.body.append(menu);
  const buttons = [...menu.querySelectorAll('button[data-action]')];
  let selected = null;
  let destroyed = false;

  function close() {
    if (menu.contains(document.activeElement)) document.activeElement.blur();
    menu.hidden = true;
    selected = null;
  }

  function open(row, { x, y }) {
    if (destroyed || !row) return;
    close();
    selected = row;
    menu.querySelector('[data-action="toggle"]').textContent = row.enabled ? '無効にする' : '有効にする';
    for (const action of ['toggle', 'reserves', 'recorded', 'delete']) {
      menu.querySelector(`[data-action="${action}"]`).disabled = !row.uid;
    }
    menu.hidden = false;
    menu.style.left = '0px';
    menu.style.top = '0px';
    const bounds = menu.getBoundingClientRect();
    menu.style.left = viewportCssPixels(Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)));
    menu.style.top = viewportCssPixels(Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8)));
  }

  menu.addEventListener('click', event => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled || button.hidden || !selected) return;
    const row = selected;
    const action = button.dataset.action;
    close();
    onAction(action, row);
  });
  function outsidePointer(event) {
    if (!menu.hidden && !menu.contains(event.target)) close();
  }
  function keyboard(event) {
    if (menu.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    // 右クリック前に行へフォーカスが残っていてもEnterで編集を起動させない。
    if ((event.key === 'Enter' || event.key === ' ') && !menu.contains(document.activeElement)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const available = buttons.filter(button => !button.disabled);
    if (!available.length) return;
    const index = available.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 :
      index === -1 ? (event.key === 'ArrowDown' ? 0 : available.length - 1) :
      (index + (event.key === 'ArrowDown' ? 1 : -1) + available.length) % available.length;
    event.preventDefault();
    available[next].focus({ preventScroll: true });
  }
  function scroll(event) { if (event.target !== menu) close(); }
  document.addEventListener('pointerdown', outsidePointer, true);
  document.addEventListener('keydown', keyboard, true);
  window.addEventListener('scroll', scroll, true);
  window.addEventListener('resize', close);
  return {
    open, close,
    destroy() {
      destroyed = true;
      close();
      document.removeEventListener('pointerdown', outsidePointer, true);
      document.removeEventListener('keydown', keyboard, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', close);
      menu.remove();
    }
  };
}
