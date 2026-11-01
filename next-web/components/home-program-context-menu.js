// 番組・予約・録画中の操作。録画結果には recorded-context-menu を使う。
import { openProgramDetailDialog } from './program-detail-dialog.js';
import { loadProgramActionContext } from '../services/program-actions.js';
import { reservationActionLabel, seriesCorrectionActions } from '../services/program-detail-model.js';
import { openRecordingLiveOverlay } from '../services/live-player-adapter.js';
import { seriesEventHref } from '../services/series-event-model.js';
import { reserveProgram, setReserveSkip, unreserveProgram } from '../services/timetable-client.js';

let nextHomeSubmenuId = 0;
const pendingReservations = new Set();

async function runReservationAction(item) {
  const action = item.actionContext?.model.actions.reservation;
  if (!action || pendingReservations.has(item.id)) return;
  pendingReservations.add(item.id);
  let applied = false;
  try {
    if (action === 'reserve' || action === 'reserve-now') {
      if (!await reserveProgram(item.id, { confirmReservation: true })) return;
    } else {
      const { model } = await loadProgramActionContext(item.id);
      if (model.actions.reservation !== action) throw new Error('番組の状態が変わったため、この操作は実行できません。');
      if (!window.confirm(`${model.title}\n\n「${reservationActionLabel(action)}」を実行しますか？`)) return;
      if (action === 'unreserve') await unreserveProgram(item.id);
      else if (action === 'skip' || action === 'unskip') await setReserveSkip(item.id, action === 'skip');
    }
    applied = true;
    await item.refresh?.(true);
  } catch (error) {
    window.alert(`${applied ? '操作は完了しましたが、表示の更新に失敗しました: ' : '操作できませんでした: '}${String(error?.message || error)}`);
  } finally {
    pendingReservations.delete(item.id);
  }
}

export function createHomeProgramContextMenu({ onAction, resolveRule, enableFilter = false }) {
  const menu = document.createElement('div');
  menu.className = 'recorded-context-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '番組の操作');
  menu.hidden = true;
  menu.innerHTML = `
    <button type="button" role="menuitem" data-action="primary" hidden></button>
    <button type="button" role="menuitem" data-action="live" hidden>LIVE視聴</button>
    <button type="button" role="menuitem" data-action="stop" class="is-danger" hidden>録画中止</button>
    <button type="button" role="menuitem" data-action="detail">番組詳細を開く</button>
    <button type="button" role="menuitem" data-action="rule" disabled>ルールを確認中…</button>
    ${enableFilter ? '<button type="button" role="menuitem" data-action="filter" aria-haspopup="menu" aria-expanded="false">絞り込み <span aria-hidden="true">▸</span></button>' : ''}
    <div class="recorded-context-separator" role="separator"></div>
    <button type="button" role="menuitem" data-action="series-view">シリーズを見る</button>
    <button type="button" role="menuitem" data-action="series-change">シリーズを変更</button>
    <button type="button" role="menuitem" data-action="series-episode">話数を修正</button>
    <button type="button" role="menuitem" data-action="series-remove" class="is-danger">手動指定を解除</button>
    <div class="recorded-context-separator" role="separator"></div>
    <button type="button" role="menuitem" data-action="copy-title">タイトルをコピー</button>
    <div class="recorded-context-separator" role="separator"></div>
    <button type="button" role="menuitem" data-action="search-google">Google検索</button>
    <button type="button" role="menuitem" data-action="search-wikipedia">Wikipedia検索</button>`;
  const submenu = enableFilter ? document.createElement('div') : null;
  if (submenu) {
    submenu.className = 'recorded-context-submenu';
    submenu.setAttribute('role', 'menu');
    submenu.setAttribute('aria-label', '予約の絞り込み条件');
    submenu.id = `reservation-context-submenu-${++nextHomeSubmenuId}`;
    submenu.hidden = true;
    submenu.innerHTML = `
      <button type="button" role="menuitem" data-action="filter-title">このタイトルで検索</button>
      <button type="button" role="menuitem" data-action="filter-channel">この放送局で絞り込み</button>
      <button type="button" role="menuitem" data-action="filter-rule">このルールで絞り込み</button>
      <div class="recorded-context-separator" role="separator"></div>
      <button type="button" role="menuitem" data-action="filter-clear">絞り込みを解除</button>`;
  }
  document.body.append(menu);
  if (submenu) document.body.append(submenu);
  const filterButton = enableFilter ? menu.querySelector('[data-action="filter"]') : null;
  filterButton?.setAttribute('aria-controls', submenu.id);
  const submenuButtons = submenu ? Array.from(submenu.querySelectorAll('button[data-action]')) : [];
  const primary = menu.querySelector('[data-action="primary"]');
  const rule = menu.querySelector('[data-action="rule"]');
  let selected = null;
  let generation = 0;
  let destroyed = false;

  function positionSubmenu() {
    if (!submenu || submenu.hidden) return;
    const margin = 8;
    const gap = 2;
    const parent = menu.getBoundingClientRect();
    const trigger = filterButton.getBoundingClientRect();
    const rect = submenu.getBoundingClientRect();
    let x = parent.right + gap;
    let y = trigger.top;
    if (x + rect.width > window.innerWidth - margin) {
      x = parent.left - gap - rect.width;
      if (x < margin) {
        x = parent.left;
        y = trigger.bottom + gap;
        if (y + rect.height > window.innerHeight - margin) y = trigger.top - gap - rect.height;
      }
    }
    submenu.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin))}px`;
    submenu.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin))}px`;
  }

  function toggleFilters(open, focusFirst = false) {
    if (!submenu) return;
    submenu.hidden = !open;
    filterButton.setAttribute('aria-expanded', String(open));
    if (open) {
      positionSubmenu();
      if (focusFirst) submenuButtons.find(button => !button.disabled)?.focus({ preventScroll: true });
    }
  }

  function close() {
    generation += 1;
    if (menu.contains(document.activeElement) || submenu?.contains(document.activeElement)) document.activeElement.blur();
    menu.hidden = true;
    toggleFilters(false);
    selected = null;
  }

  function positionMenu(x, y) {
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  }

  function open(item, { x, y }) {
    if (destroyed) return;
    close();
    selected = item;
    item.actionContext = null;
    toggleFilters(false);
    for (const action of ['primary', 'live', 'stop']) menu.querySelector(`[data-action="${action}"]`).hidden = true;
    menu.querySelector('[data-action="detail"]').disabled = !item.id;
    const hasTitle = typeof item.title === 'string' && item.title.trim() !== '';
    for (const action of ['copy-title', 'search-google', 'search-wikipedia']) {
      menu.querySelector(`[data-action="${action}"]`).disabled = !hasTitle;
    }
    for (const action of ['series-view', 'series-change', 'series-episode', 'series-remove']) menu.querySelector(`[data-action="${action}"]`).hidden = true;
    if (submenu) {
      const channelId = item.program?.channel?.id;
      const meta = item.program?.reservationMeta;
      const uid = item.program?.ruleUid || meta?.ruleUid;
      submenu.querySelector('[data-action="filter-title"]').disabled = !hasTitle;
      submenu.querySelector('[data-action="filter-channel"]').disabled = channelId == null || channelId === '';
      submenu.querySelector('[data-action="filter-rule"]').disabled = !uid;
    }
    rule.disabled = true;
    rule.title = '';
    rule.textContent = 'ルールを確認中…';
    menu.hidden = false;
    menu.style.left = '0px';
    menu.style.top = '0px';
    positionMenu(x, y);
    const current = generation;
    loadProgramActionContext(item.id).then(async context => {
      if (destroyed || menu.hidden || current !== generation) return;
      item.actionContext = context;
      const { model, seriesContext: series } = context;
      primary.hidden = model.actions.reservation === null;
      primary.textContent = reservationActionLabel(model.actions.reservation);
      primary.disabled = false;
      const live = menu.querySelector('[data-action="live"]');
      live.hidden = model.media.liveModel === null;
      const stop = menu.querySelector('[data-action="stop"]');
      stop.hidden = model.actions.stopRecording === null;
      stop.disabled = model.actions.stopRecording?.requested === true;
      menu.querySelector('[data-action="series-view"]').hidden = !series?.seriesId;
      seriesCorrectionActions(series).forEach(action => {
        const button = menu.querySelector(`[data-action="${action.action}"]`);
        button.hidden = false;
        button.textContent = action.label;
      });
      positionMenu(x, y);
      let result = model.actions.rule;
      if (typeof resolveRule === 'function' && result.mode !== 'unavailable') result = await resolveRule(item);
      if (destroyed || menu.hidden || current !== generation) return;
      item.ruleAction = result;
      rule.disabled = model.actions.rule.mode === 'unavailable' || result.mode === 'unavailable';
      rule.textContent = model.phase.key === 'program' && result.mode === 'create' ? 'ルール作成' : 'ルール';
      rule.title = result.label || '';
      positionMenu(x, y);
    }).catch(error => {
      if (destroyed || menu.hidden || current !== generation) return;
      rule.textContent = 'ルールを取得できません';
      rule.title = String(error?.message || error);
      rule.disabled = true;
    });
  }

  menu.addEventListener('click', event => {
    const button = event.target.closest?.('button[data-action]');
    if (!button || button.disabled || selected === null) return;
    const item = selected;
    const action = button.dataset.action;
    if (action === 'filter') {
      toggleFilters(true, true);
      return;
    }
    close();
    const context = item.actionContext;
    if (action === 'primary') {
      void runReservationAction(item);
      return;
    }
    if (action === 'detail' || action === 'stop' || action.startsWith('series-')) {
      if (action === 'series-view') {
        const href = seriesEventHref(context?.seriesContext, context?.model.phase.key === 'reserved' ? 'reservations' : 'recordings');
        if (href) window.location.hash = href;
      } else {
        openProgramDetailDialog({ id: item.id, onChanged: item.refresh,
          initialAction: action === 'detail' ? null : action });
      }
      return;
    }
    if (action === 'live') {
      openRecordingLiveOverlay(context.model.media.liveModel).catch(error => window.alert(String(error?.message || error)));
      return;
    }
    onAction(action, item);
  });
  submenu?.addEventListener('click', event => {
    const button = event.target.closest?.('button[data-action]');
    if (!button || button.disabled || !selected) return;
    const item = selected;
    const action = button.dataset.action;
    close();
    onAction(action, item);
  });
  menu.addEventListener('pointerover', event => {
    if (!submenu || event.pointerType !== 'mouse' || menu.hidden) return;
    const button = event.target.closest?.('button[data-action]');
    if (!button) return;
    if (button === filterButton) toggleFilters(true);
    else if (!submenu.hidden) toggleFilters(false);
  });
  const outsidePointer = event => {
    if (!menu.hidden && !menu.contains(event.target) && !submenu?.contains(event.target)) close();
  };
  const keydown = event => {
    if (menu.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'ArrowLeft' && submenu && !submenu.hidden) {
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
    const choices = (submenu?.contains(document.activeElement) && !submenu.hidden
      ? submenuButtons : Array.from(menu.querySelectorAll('button[data-action]')))
      .filter(button => !button.disabled && !button.hidden);
    if (!choices.length) return;
    const index = choices.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 :
      index < 0 ? (event.key === 'ArrowUp' ? choices.length - 1 : 0) :
      (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
    event.preventDefault();
    choices[next].focus({ preventScroll: true });
  };
  document.addEventListener('pointerdown', outsidePointer, true);
  document.addEventListener('keydown', keydown, true);
  window.addEventListener('scroll', close, true);
  window.addEventListener('resize', close);

  return {
    element: menu,
    open, close,
    destroy() {
      destroyed = true;
      close();
      document.removeEventListener('pointerdown', outsidePointer, true);
      document.removeEventListener('keydown', keydown, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      menu.remove();
      submenu?.remove();
    }
  };
}
