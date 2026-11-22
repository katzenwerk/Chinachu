import { createProgramHover, setProgramHover } from './program-hover.js';
import { applyStorageWarning, applyResultWarningTooltip } from './storage-warning.js';
import { createChannelLogo } from './channel-logo.js';
import { appendMobileContextButton } from './mobile-layout.js';

const rowStates = new WeakMap();

function mobileWarningLabel(status) {
  if (status.key === 'head-shortage') return '頭切れ疑い';
  if (status.key === 'tail-shortage') return '尻切れ疑い';
  if (status.key === 'saved-ts') {
    const findings = ['CC', 'GAP'].filter(value => status.label.includes(value));
    return findings.length ? findings.join('/') : status.label.replace(/^Analyze:\s*/, '');
  }
  return status.label;
}

function setText(element, value) {
  if (element.textContent === value) return false;
  element.textContent = value;
  return true;
}

function tagsForModel(model) {
  return [
    ...(model.storageTag === null ? [] : [{ ...model.storageTag, key: 'storage' }]),
    ...model.tags.filter(tag => tag.key !== 'skip'),
    ...(model.recordingWarnings || [])
      .filter(status => status.key !== 'missed' || model.primaryStatus?.key !== 'missed')
      .map(status => ({
        key: 'recording-status',
        statusKey: status.key,
        mobileLabel: mobileWarningLabel(status),
        resultTooltip: ['drop', 'saved-ts'].includes(status.key),
        label: status.label,
        description: status.description,
        kind: status.kind,
        tone: status.tone
      }))
  ];
}

export function updateReservationListRow(row, model) {
  const state = rowStates.get(row);
  if (!state) throw new Error('Reservation list row state is missing');
  const signature = JSON.stringify(model);
  if (state.signature === signature) return false;
  state.signature = signature;
  state.model = model;
  row.dataset.reservationKey = model.key;
  row.classList.toggle('is-skip', model.isSkip === true);
  const link = row.querySelector('.reservation-list-link');
  if (link && link.getAttribute('href') !== model.detailUrl) link.href = model.detailUrl;

  setText(row.querySelector('.reservation-list-date span'), model.dateText);
  setText(row.querySelector('time'), model.timeText);
  state.channelLogo.update({
    url: model.channelLogoUrl,
    name: model.channelName,
    fallbackText: model.channelFallbackText,
    tooltip: model.channelTooltip
  });

  const program = row.querySelector('.reservation-list-program');
  const title = row.querySelector('h2');
  program.querySelector('.reservation-list-skip-status').hidden = model.isSkip !== true;
  const currentStatus = program.querySelector('.reservation-list-primary-status');
  if (model.primaryStatus === null || model.primaryStatus === undefined) {
    currentStatus?.remove();
    program.classList.remove('has-primary-status');
  } else {
    const status = currentStatus || document.createElement('span');
    status.className = `reservation-list-tag reservation-list-primary-status is-status-${model.primaryStatus.key}`;
    setText(status, model.primaryStatus.label);
    if (!currentStatus) program.insertBefore(status, title);
    program.classList.add('has-primary-status');
  }
  setText(title, model.displayTitle);
  setText(row.querySelector('.reservation-list-category'), model.category);
  applyStorageWarning(row.querySelector('.reservation-list-storage-warning'), model.storageNotice);

  const tags = tagsForModel(model);
  if (state.compactMobile) {
    const header = row.querySelector('.compact-mobile-row-header');
    const meta = row.querySelector('.compact-mobile-row-meta');
    header.replaceChildren();
    meta.replaceChildren();
    const date = document.createElement('span');
    date.textContent = `${model.dateText} ${model.timeText}`;
    header.append(date);
    const category = document.createElement('span');
    category.textContent = [model.channelName, model.category].filter(Boolean).join(' · ');
    meta.append(category);
    if (model.storageNotice) {
      const warning = row.querySelector('.reservation-list-storage-warning').cloneNode(true);
      applyStorageWarning(warning, model.storageNotice);
      meta.append(warning);
    }
    const statuses = model.primaryStatus ? [model.primaryStatus] : [];
    if (model.isSkip) statuses.push({ key: 'skip', label: 'スキップ' });
    [...statuses, ...tags.filter(tag => !tag.statusKey || tag.statusKey !== model.primaryStatus?.key)].forEach(tag => {
      const element = document.createElement('span');
      element.className = `reservation-list-tag is-${tag.key}${tag.kind ? ` is-${tag.kind}` : ''}${tag.tone ? ` is-${tag.tone}` : ''}`;
      element.textContent = tag.mobileLabel || tag.label;
      if (tag.resultTooltip || tag.statusKey) applyResultWarningTooltip(element, [tag.label, tag.description].filter(Boolean).join('。'));
      else if (tag.description) element.title = tag.description;
      header.append(element);
    });
    const button = row.querySelector('.mobile-context-button');
    button.textContent = model.fullTitle || model.displayTitle;
    button.title = button.textContent;
    button.setAttribute('aria-label', `${button.textContent}の操作メニュー`);
  }
  const tagsSignature = JSON.stringify(tags);
  if (state.tagsSignature !== tagsSignature) {
    state.tagsSignature = tagsSignature;
    row.querySelector('.reservation-list-tag-items').replaceChildren(...tags.map(tag => {
      const element = document.createElement('span');
      element.className = `reservation-list-tag is-${tag.key}${tag.kind ? ` is-${tag.kind}` : ''}${tag.tone ? ` is-${tag.tone}` : ''}`;
      element.textContent = tag.label;
      if (tag.resultTooltip) applyResultWarningTooltip(element, tag.description || tag.label);
      else if (tag.description) element.title = tag.description;
      return element;
    }));
  }
  return true;
}

export function createReservationListRow(model, { compactMobile = false } = {}) {
  const row = document.createElement('div');
  row.className = 'reservation-list-row';
  row.innerHTML = `
    <div class="reservation-list-date"><span></span></div>
    <div class="reservation-list-time"><time></time></div>
    <span class="reservation-list-logo-slot"></span>
    <div class="reservation-list-program"><span class="reservation-list-tag reservation-list-skip-status is-skip" hidden>スキップ</span><h2></h2><div class="reservation-list-submeta"><span class="reservation-list-category"></span><span class="reservation-list-storage-warning storage-warning" hidden><span aria-hidden="true">⚠</span><span class="reservation-list-storage-warning-text storage-warning-text"></span><span class="storage-warning-tip" role="tooltip"></span></span></div></div>
    <div class="reservation-list-tags"><span class="reservation-list-tag-items"></span></div>`;

  const channelLogo = createChannelLogo({}, { variant: 'list' });
  row.querySelector('.reservation-list-logo-slot').replaceWith(channelLogo.element);
  if (model.detailUrl !== null) {
    const link = document.createElement('a');
    link.className = 'reservation-list-link';
    link.append(...row.childNodes);
    row.append(link);
    row.addEventListener('click', event => {
      if (event.target === row) link.click();
    });
  }
  appendMobileContextButton(row);
  if (compactMobile) {
    row.classList.add('has-compact-mobile-layout');
    for (const name of ['header', 'meta']) {
      const element = document.createElement('div');
      element.className = `compact-mobile-row-${name}`;
      row.append(element);
    }
  }
  const state = { model, signature: null, channelLogo, tagsSignature: null, compactMobile };
  rowStates.set(row, state);
  setProgramHover(row.querySelector('h2'), () => state.model.hover);
  updateReservationListRow(row, model);
  return row;
}

function captureScrollAnchor(list) {
  if (!list.isConnected) return null;
  const row = Array.from(list.children).find(element => element.getBoundingClientRect().bottom > 0);
  if (!row) return null;
  return { key: row.dataset.reservationKey, top: row.getBoundingClientRect().top };
}

export function createReservationListRenderer(content, options = {}) {
  const list = document.createElement('div');
  list.className = 'reservation-list';
  const rows = new Map();
  const programHover = createProgramHover(list);

  return {
    element: list,
    dispose() { programHover.dispose(); rows.clear(); list.replaceChildren(); },
    clear() {
      programHover.close();
      rows.clear();
      list.replaceChildren();
    },
    render(models, { preserveScroll = false } = {}) {
      const anchor = preserveScroll ? captureScrollAnchor(list) : null;
      const keys = models.map(model => model.key);
      const activeKeys = new Set(keys);
      let changed = false;

      rows.forEach((row, key) => {
        if (activeKeys.has(key)) return;
        if (row.querySelector('[aria-describedby="program-hover"]')) programHover.close();
        row.remove();
        rows.delete(key);
        changed = true;
      });

      const elements = models.map(model => {
        let row = rows.get(model.key);
        if (!row) {
          row = createReservationListRow(model, options);
          rows.set(model.key, row);
          changed = true;
        } else if (updateReservationListRow(row, model)) {
          changed = true;
        }
        return row;
      });
      const currentKeys = Array.from(list.children).map(row => row.dataset.reservationKey);
      const orderChanged = currentKeys.length !== keys.length || currentKeys.some((key, index) => key !== keys[index]);
      if (orderChanged) {
        let cursor = list.firstChild;
        for (const element of elements) {
          if (element === cursor) cursor = cursor.nextSibling;
          else list.insertBefore(element, cursor);
        }
        changed = true;
      }
      if (!list.isConnected) {
        content.replaceChildren(list);
        changed = true;
      }
      if (anchor !== null && changed) {
        window.requestAnimationFrame(() => {
          const row = rows.get(anchor.key);
          if (!row?.isConnected) return;
          const delta = row.getBoundingClientRect().top - anchor.top;
          if (delta !== 0) window.scrollBy({ top: delta, behavior: 'auto' });
        });
      }
      return changed;
    }
  };
}
