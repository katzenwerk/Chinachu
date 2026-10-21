import { isRecordedResultPlayable } from '../services/recorded-result-warnings.js';

// 録画結果一覧専用。番組情報の取得や削除権限の判定は呼び出し元・詳細モーダルに委ねる。
let nextSubmenuId = 0;

export function createRecordedContextMenu({ onAction }) {
  const menu = document.createElement('div');
  menu.className = 'recorded-context-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '録画結果の操作');
  menu.hidden = true;
  menu.innerHTML = `
    <button type="button" role="menuitem" data-action="play">再生</button>
    <button type="button" role="menuitem" data-action="download">ダウンロード</button>
    <div class="recorded-context-separator" role="separator"></div>
    <button type="button" role="menuitem" data-action="rule">ルール</button>
    <button type="button" role="menuitem" data-action="filter" aria-expanded="false" aria-haspopup="menu">絞り込み <span aria-hidden="true">▸</span></button>
    <button type="button" role="menuitem" data-action="detail">詳細</button>
    <div class="recorded-context-separator" role="separator"></div>
    <button type="button" role="menuitem" data-action="copy-title">タイトルをコピー</button>
    <button type="button" role="menuitem" data-action="search-google">Googleで検索</button>
    <button type="button" role="menuitem" data-action="search-wikipedia">Wikipediaで検索</button>
    <div class="recorded-context-separator" role="separator"></div>
    <button type="button" role="menuitem" class="is-danger" data-action="delete">削除…</button>`;
  // メインメニュー内のスクロール領域で切り取られないよう、サブメニューはbody直下に置く。
  const submenu = document.createElement('div');
  submenu.className = 'recorded-context-submenu';
  submenu.setAttribute('role', 'menu');
  submenu.setAttribute('aria-label', '絞り込み条件');
  submenu.id = `recorded-context-submenu-${++nextSubmenuId}`;
  submenu.hidden = true;
  submenu.innerHTML = `
    <button type="button" role="menuitem" data-action="filter-title">このタイトルで検索</button>
    <button type="button" role="menuitem" data-action="filter-channel">この放送局で絞り込み</button>
    <button type="button" role="menuitem" data-action="filter-rule">このルールで絞り込み</button>
    <div class="recorded-context-separator" role="separator"></div>
    <button type="button" role="menuitem" data-action="filter-clear">絞り込みを解除</button>`;
  document.body.append(menu, submenu);
  const filterButton = menu.querySelector('[data-action="filter"]');
  filterButton.setAttribute('aria-controls', submenu.id);
  const menuButtons = Array.from(menu.querySelectorAll('button[data-action]'));
  const submenuButtons = Array.from(submenu.querySelectorAll('button[data-action]'));
  let selected = null;
  let destroyed = false;

  function positionSubmenu() {
    // 右側を優先。収まらない場合は左側へ、狭い画面では上下へ退避する。
    const margin = 8;
    const gap = 4;
    const parent = menu.getBoundingClientRect();
    const trigger = filterButton.getBoundingClientRect();
    const rect = submenu.getBoundingClientRect();
    let x;
    let y = trigger.top;
    if (parent.right + gap + rect.width <= window.innerWidth - margin) {
      x = parent.right + gap;
    } else if (parent.left - gap - rect.width >= margin) {
      x = parent.left - gap - rect.width;
    } else {
      x = parent.left;
      y = trigger.bottom + gap;
      if (y + rect.height > window.innerHeight - margin) y = trigger.top - gap - rect.height;
    }
    submenu.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin))}px`;
    submenu.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin))}px`;
  }

  function position(x, y) {
    menu.style.left = '0px';
    menu.style.top = '0px';
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    if (!submenu.hidden) positionSubmenu();
  }

  function toggleFilters(open, focusFirst = false) {
    submenu.hidden = !open;
    filterButton.setAttribute('aria-expanded', String(open));
    if (open) {
      positionSubmenu();
      if (focusFirst) submenuButtons.find(button => !button.disabled)?.focus({ preventScroll: true });
    }
  }

  function clearMenuFocus() {
    if (menu.contains(document.activeElement) || submenu.contains(document.activeElement)) {
      document.activeElement.blur();
    }
  }

  function close() {
    clearMenuFocus();
    menu.hidden = true;
    selected = null;
    toggleFilters(false);
  }

  function open(item, { x, y }) {
    if (destroyed) return;
    clearMenuFocus();
    selected = item;
    toggleFilters(false);
    const playable = isRecordedResultPlayable(item);
    menu.querySelector('[data-action="play"]').disabled = !playable;
    menu.querySelector('[data-action="download"]').disabled = !playable;
    menu.querySelector('[data-action="delete"]').disabled = !playable;
    submenu.querySelector('[data-action="filter-channel"]').disabled = !item?.channel?.id;
    submenu.querySelector('[data-action="filter-rule"]').disabled = !item?.ruleUid;
    submenu.querySelector('[data-action="filter-title"]').disabled = !(item?.title || item?.fullTitle);
    const hasTitle = Boolean((typeof item?.title === 'string' && item.title.trim()) ||
      (typeof item?.fullTitle === 'string' && item.fullTitle.trim()));
    for (const action of ['copy-title', 'search-google', 'search-wikipedia']) {
      menu.querySelector(`[data-action="${action}"]`).disabled = !hasTitle;
    }
    menu.hidden = false;
    position(x, y);
  }

  function clickAction(event) {
    const button = event.target.closest?.('button[data-action]');
    if (!button || button.disabled || selected === null) return;
    const action = button.dataset.action;
    if (action === 'filter') {
      toggleFilters(true, true);
      return;
    }
    const item = selected;
    close();
    onAction(action, item);
  }
  menu.addEventListener('click', clickAction);
  submenu.addEventListener('click', clickAction);

  menu.addEventListener('pointerover', event => {
    if (event.pointerType !== 'mouse' || menu.hidden) return;
    const button = event.target.closest?.('button[data-action]');
    if (!button) return;
    if (button === filterButton) toggleFilters(true);
    else if (!submenu.hidden) toggleFilters(false);
  });

  function onPointerDown(event) {
    if (!menu.hidden && !menu.contains(event.target) && !submenu.contains(event.target)) close();
  }
  function onKeyDown(event) {
    if (menu.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'ArrowLeft' && !submenu.hidden) {
      event.preventDefault();
      toggleFilters(false);
      filterButton.focus({ preventScroll: true });
      return;
    }
    if (event.key === 'ArrowRight' && document.activeElement === filterButton) {
      event.preventDefault();
      toggleFilters(true, true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const available = (submenu.contains(document.activeElement) && !submenu.hidden ? submenuButtons : menuButtons)
      .filter(button => !button.disabled);
    const index = available.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1 :
      index < 0 ? (event.key === 'ArrowUp' ? available.length - 1 : 0) :
      (index + (event.key === 'ArrowDown' ? 1 : -1) + available.length) % available.length;
    event.preventDefault();
    available[next]?.focus({ preventScroll: true });
  }
  function onScroll(event) {
    if (event.target !== menu && event.target !== submenu) close();
  }
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', close);

  return {
    open,
    close,
    destroy() {
      destroyed = true;
      close();
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
      menu.remove();
      submenu.remove();
    }
  };
}
