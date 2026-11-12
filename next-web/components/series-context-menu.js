import { viewportCssPixels } from '../services/ui-scale.js';
export function createSeriesContextMenu({ onAction }) {
  const menu = document.createElement('div');
  menu.className = 'recorded-context-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'シリーズイベントの操作');
  menu.hidden = true;
  menu.innerHTML = `
    <button type="button" role="menuitem" data-action="detail">詳細を表示</button>
    <button type="button" role="menuitem" data-action="series-view">シリーズを確認</button>
    <div class="recorded-context-separator" role="separator"></div>
    <button type="button" role="menuitem" data-action="series-change">シリーズを変更</button>
    <button type="button" role="menuitem" data-action="series-episode">話数を修正</button>
    <button type="button" role="menuitem" class="is-danger" data-action="series-remove">手動指定を解除</button>
    <button type="button" role="menuitem" data-action="series-hidden">シリーズを非表示</button>`;
  document.body.append(menu);
  const buttons = Array.from(menu.querySelectorAll('button[data-action]'));
  let selected = null;
  let destroyed = false;

  function close() {
    if (menu.contains(document.activeElement)) document.activeElement.blur();
    menu.hidden = true;
    selected = null;
  }
  function open(item, { x, y }) {
    if (destroyed) return;
    close();
    selected = item;
    const seriesOnly = item?.kind === 'series';
    menu.querySelector('[data-action="detail"]').hidden = seriesOnly;
    menu.querySelector('[data-action="detail"]').disabled = !item?.event?.key;
    menu.querySelector('[data-action="series-view"]').hidden = seriesOnly;
    menu.querySelector('[data-action="series-view"]').disabled = !item?.seriesId;
    menu.querySelector('[data-action="series-change"]').hidden = seriesOnly;
    menu.querySelector('[data-action="series-change"]').disabled = !item?.event?.key;
    menu.querySelector('[data-action="series-episode"]').hidden = seriesOnly;
    menu.querySelector('[data-action="series-episode"]').disabled = !item?.seriesId || item.seriesId.startsWith('local:');
    menu.querySelector('[data-action="series-remove"]').hidden = seriesOnly || item?.manual !== true;
    menu.querySelector('.recorded-context-separator').hidden = seriesOnly;
    const hiddenButton = menu.querySelector('[data-action="series-hidden"]');
    hiddenButton.hidden = !seriesOnly || !Number.isInteger(Number(item?.tid)) || Number(item?.tid) <= 0;
    hiddenButton.textContent = item?.hidden ? 'シリーズを再表示' : 'シリーズを非表示';
    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    menu.style.left = viewportCssPixels(Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)));
    menu.style.top = viewportCssPixels(Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)));
  }
  menu.addEventListener('click', event => {
    const button = event.target.closest?.('button[data-action]');
    if (!button || button.disabled || button.hidden || selected === null) return;
    const item = selected;
    const action = button.dataset.action;
    close();
    onAction(action, item);
  });
  const outside = event => { if (!menu.hidden && !menu.contains(event.target)) close(); };
  const keydown = event => {
    if (menu.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && !menu.contains(document.activeElement)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const available = buttons.filter(button => !button.disabled && !button.hidden);
    const index = available.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 :
      index < 0 ? (event.key === 'ArrowUp' ? available.length - 1 : 0) :
      (index + (event.key === 'ArrowDown' ? 1 : -1) + available.length) % available.length;
    event.preventDefault();
    available[next]?.focus({ preventScroll: true });
  };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', keydown, true);
  const scroll = event => { if (event.target !== menu) close(); };
  window.addEventListener('scroll', scroll, true);
  window.addEventListener('resize', close);
  return {
    open, close,
    destroy() {
      destroyed = true;
      close();
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', keydown, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', close);
      menu.remove();
    }
  };
}
