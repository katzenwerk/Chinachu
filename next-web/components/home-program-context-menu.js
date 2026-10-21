// ホームの録画中・次の予約用。録画結果には既存の recorded-context-menu を使う。
let nextHomeSubmenuId = 0;

export function createHomeProgramContextMenu({ onAction, resolveRule, enableFilter = false }) {
  const menu = document.createElement('div');
  menu.className = 'recorded-context-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '番組の操作');
  menu.hidden = true;
  menu.innerHTML = `
    <button type="button" role="menuitem" data-action="primary"></button>
    <button type="button" role="menuitem" data-action="rule" disabled>ルールを確認中…</button>
    ${enableFilter ? '<button type="button" role="menuitem" data-action="filter" aria-haspopup="menu" aria-expanded="false">絞り込み <span aria-hidden="true">▸</span></button>' : ''}
    <button type="button" role="menuitem" data-action="detail">番組詳細を開く</button>
    <div class="recorded-context-separator" role="separator"></div>
    <button type="button" role="menuitem" data-action="copy-title">タイトルをコピー</button>
    <div class="recorded-context-separator" role="separator"></div>
    <button type="button" role="menuitem" data-action="search-google">Googleで検索</button>
    <button type="button" role="menuitem" data-action="search-wikipedia">Wikipediaで検索</button>`;
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

  function open(item, { x, y }) {
    if (destroyed) return;
    close();
    selected = item;
    toggleFilters(false);
    if (item.kind === 'recording') {
      primary.textContent = 'LIVE視聴';
      primary.disabled = item.model?.status !== 'recording' || !item.model?.liveChannel;
    } else {
      primary.textContent = item.program?.isSkip === true ? 'スキップを取消' :
        item.program?.isManualReserved === true ? '予約取消' : 'この予約をスキップ';
      primary.disabled = !item.id;
    }
    menu.querySelector('[data-action="detail"]').disabled = !item.id;
    const hasTitle = typeof item.title === 'string' && item.title.trim() !== '';
    for (const action of ['copy-title', 'search-google', 'search-wikipedia']) {
      menu.querySelector(`[data-action="${action}"]`).disabled = !hasTitle;
    }
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
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    const current = generation;
    Promise.resolve().then(() => resolveRule(item)).then(result => {
      if (destroyed || menu.hidden || current !== generation) return;
      item.ruleAction = result;
      rule.disabled = false;
      rule.textContent = result.mode === 'edit' ? 'ルール編集' :
        result.mode === 'create' ? 'ルール作成' : '関連ルールを確認';
      rule.title = result.label || '';
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
      .filter(button => !button.disabled);
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
