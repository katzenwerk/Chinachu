import { viewportCssPixels } from '../services/ui-scale.js';
import { isRecordedResultPlayable } from '../services/recorded-result-warnings.js';

// 録画結果・実績の共通操作。追加情報が必要な場合だけprepareItemで表示前に取得する。
let nextSubmenuId = 0;

export function createRecordedContextMenu({ onAction, prepareItem }) {
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
    <button type="button" role="menuitem" data-action="series-view">シリーズを確認</button>
    <button type="button" role="menuitem" data-action="series-change">シリーズを変更</button>
    <button type="button" role="menuitem" data-action="series-episode">話数を修正</button>
    <button type="button" role="menuitem" data-action="series-remove" class="is-danger">手動指定を解除</button>
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
  let generation = 0;
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
    submenu.style.left = viewportCssPixels(Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin)));
    submenu.style.top = viewportCssPixels(Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin)));
  }

  function position(x, y) {
    menu.style.left = '0px';
    menu.style.top = '0px';
    const rect = menu.getBoundingClientRect();
    menu.style.left = viewportCssPixels(Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)));
    menu.style.top = viewportCssPixels(Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)));
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
    generation++;
    clearMenuFocus();
    menu.hidden = true;
    selected = null;
    toggleFilters(false);
  }

  function open(item, point) {
    if (destroyed) return;
    close();
    selected = item;
    if (typeof prepareItem !== 'function') return show(item, point);
    const current = generation;
    return Promise.resolve().then(() => prepareItem(item)).then(ready => {
      if (destroyed || current !== generation) return;
      show(ready, point);
    }).catch(error => {
      if (destroyed || current !== generation) return;
      close();
      window.alert(`メニューを取得できませんでした: ${error?.message || error}`);
    });
  }

  function show(item, { x, y }) {
    selected = item;
    toggleFilters(false);
    menu.querySelector('[data-action="filter"]').hidden = item?.hideFilter === true;
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
    const series = item?.seriesContext;
    menu.querySelector('[data-action="series-view"]').disabled = !series?.seriesId;
    const change = menu.querySelector('[data-action="series-change"]');
    change.disabled = !series?.eventKey;
    change.textContent = series?.tidConfirmed || series?.seriesId?.startsWith('local:') ? 'シリーズを変更' : 'シリーズに紐づけ';
    menu.querySelector('[data-action="series-episode"]').disabled = !series?.seriesId || series.seriesId.startsWith('local:');
    menu.querySelector('[data-action="series-remove"]').hidden = series?.manual !== true;
    menu.hidden = false;
    position(x, y);
  }

  function clickAction(event) {
    const button = event.target.closest?.('button[data-action]');
    if (!button || button.disabled || button.hidden || selected === null) return;
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
    if (selected && !menu.contains(event.target) && !submenu.contains(event.target)) close();
  }
  function onKeyDown(event) {
    if (!selected) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (menu.hidden) return;
    if ((event.key === 'Enter' || event.key === ' ') &&
        !menu.contains(document.activeElement) && !submenu.contains(document.activeElement)) {
      event.preventDefault();
      event.stopPropagation();
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
      .filter(button => !button.disabled && !button.hidden);
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
