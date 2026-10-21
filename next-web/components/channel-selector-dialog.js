import { createChannelLogo } from './channel-logo.js';

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function logoUrl(channel) {
  return channel?.hasLogoData === true && text(channel.id)
    ? `/api/channel/${encodeURIComponent(channel.id)}/logo.png`
    : null;
}

export function openChannelSelector({ title = '放送局を選択', channels = [], selectedIds = [] } = {}) {
  return new Promise(resolve => {
    const unique = new Map();
    channels.forEach(channel => {
      const id = text(channel?.id);
      if (id && !unique.has(id)) unique.set(id, channel);
    });
    const ordered = Array.from(unique.values());
    const selected = new Set(selectedIds.map(text).filter(Boolean));
    const logoHandles = [];
    let completed = false;

    const dialog = document.createElement('dialog');
    dialog.className = 'channel-selector-dialog';
    dialog.innerHTML = `<article>
      <header><h2></h2><button type="button" class="rule-dialog-close" aria-label="閉じる">×</button></header>
      <div class="channel-selector-toolbar">
        <label><span>放送局を検索</span><input type="search" autocomplete="off" placeholder="局名・ID・チャンネル"></label>
        <label><span>放送波</span><select><option value="">すべて</option></select></label>
      </div>
      <p class="channel-selector-count"></p>
      <div class="channel-selector-grid"></div>
      <footer><button type="button" class="button selector-cancel">キャンセル</button><button type="button" class="button is-primary selector-apply">反映</button></footer>
    </article>`;
    dialog.querySelector('h2').textContent = title;
    const search = dialog.querySelector('input[type="search"]');
    const typeSelect = dialog.querySelector('select');
    const grid = dialog.querySelector('.channel-selector-grid');
    const count = dialog.querySelector('.channel-selector-count');
    Array.from(new Set(ordered.map(channel => text(channel.type)).filter(Boolean))).forEach(type => {
      const option = document.createElement('option');
      option.value = type;
      option.textContent = type;
      typeSelect.append(option);
    });

    function finish(value) {
      if (completed) return;
      completed = true;
      logoHandles.forEach(handle => handle.dispose());
      dialog.close();
      dialog.remove();
      resolve(value);
    }

    function render() {
      logoHandles.splice(0).forEach(handle => handle.dispose());
      grid.replaceChildren();
      const keyword = search.value.trim().toLocaleLowerCase('ja');
      const filtered = ordered.filter(channel => {
        if (typeSelect.value && text(channel.type) !== typeSelect.value) return false;
        const haystack = [channel.name, channel.id, channel.channel, channel.type, channel.sid, channel.nid]
          .map(text).join(' ').toLocaleLowerCase('ja');
        return !keyword || haystack.includes(keyword);
      });
      filtered.forEach(channel => {
        const id = text(channel.id);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `channel-selector-item${selected.has(id) ? ' is-selected' : ''}`;
        button.setAttribute('aria-pressed', selected.has(id) ? 'true' : 'false');
        const handle = createChannelLogo({
          name: text(channel.name) || id,
          fallbackText: text(channel.name) || id,
          tooltip: text(channel.name) || id,
          url: logoUrl(channel)
        }, { variant: 'list', focusable: false });
        logoHandles.push(handle);
        const info = document.createElement('span');
        info.className = 'channel-selector-info';
        const name = document.createElement('strong');
        name.textContent = text(channel.name) || id;
        const meta = document.createElement('small');
        meta.textContent = `${text(channel.type) || '-'} / ch ${text(channel.channel) || '-'} / sid ${text(channel.sid) || '-'} / ${id}`;
        info.append(name, meta);
        button.append(handle.element, info);
        button.addEventListener('click', () => {
          if (selected.has(id)) selected.delete(id); else selected.add(id);
          button.classList.toggle('is-selected', selected.has(id));
          button.setAttribute('aria-pressed', selected.has(id) ? 'true' : 'false');
          count.textContent = `表示 ${filtered.length}局 / 選択 ${selected.size}局`;
        });
        grid.append(button);
      });
      count.textContent = `表示 ${filtered.length}局 / 選択 ${selected.size}局`;
    }

    search.addEventListener('input', render);
    typeSelect.addEventListener('change', render);
    dialog.querySelector('.selector-apply').addEventListener('click', () => {
      const result = ordered.map(channel => text(channel.id)).filter(id => selected.has(id));
      selected.forEach(id => { if (!unique.has(id)) result.push(id); });
      finish(result);
    });
    dialog.querySelector('.selector-cancel').addEventListener('click', () => finish(null));
    dialog.querySelector('.rule-dialog-close').addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    dialog.addEventListener('click', event => { if (event.target === dialog) finish(null); });
    document.body.append(dialog);
    render();
    dialog.showModal();
    search.focus();
  });
}
