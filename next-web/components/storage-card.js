function escapeText(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[character]);
}

function icon() {
  return '<svg class="icon"><use href="#icon-storage"></use></svg>';
}

function statusBadge(model) {
  const label = { warning: '容量注意', low: '容量不足', normal: '正常', unobserved: '容量未取得' }[model.state.key]
    || (model.state.key === 'stale' && model.free === '未取得' ? '容量未取得' : model.state.label);
  const description = model.state.stale ? `${label}（前回確認時の参考値）` : label;
  return `<span class="storage-status-badge is-${escapeText(model.state.key)}" title="${escapeText(description)}" aria-label="${escapeText(description)}">${escapeText(label)}</span>`;
}

function usageBar(model) {
  const value = model.usagePercent === null ? 0 : Number(model.usagePercent);
  const label = model.usagePercent === null ? '使用率 未取得' : `使用率 ${model.usagePercent}%`;
  const closeClass = model.thresholdMarkersClose ? ' is-close' : '';
  const warningMarker = model.warningMarker === null ? '' : `<span class="storage-threshold-marker is-warning${closeClass}" style="left:${model.warningMarker}%" title="Warning：空き${escapeText(model.warningThreshold)}未満" aria-hidden="true"></span>`;
  const lowMarker = model.lowMarker === null ? '' : `<span class="storage-threshold-marker is-low${closeClass}" style="left:${model.lowMarker}%" title="Low：空き${escapeText(model.lowThreshold)}未満" aria-hidden="true"></span>`;
  return `<div class="storage-usage-wrap"><div class="storage-usage-bar is-${escapeText(model.state.key)}" role="progressbar" aria-label="${escapeText(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}"><i style="width:${value}%"></i></div>${warningMarker}${lowMarker}</div>`;
}

function note(model) {
  const notes = [...model.notes, ...(model.lowThreshold === '対象外' ? ['容量不足対策の対象外です。'] : [])].filter(line => line !== '空き容量に注意してください。' && !line.startsWith('最終確認：') && line !== '容量情報はまだ取得されていません。');
  if (notes.length === 0) return '';
  return `<div class="storage-note is-${escapeText(model.state.key)}">${notes.map((line, index) => index === notes.length - 1 && (line.includes('停止中') || line.includes('録画禁止中')) ? `<strong>${escapeText(line)}</strong>` : `<span>${escapeText(line)}</span>`).join('')}</div>`;
}

function storageCardMarkup(model, onRefresh) {
  return `
    <div class="storage-card-head">
      <div class="storage-drive-icon">${icon()}</div>
      <div class="storage-card-ident"><div><h2 title="${escapeText(model.path)}">${escapeText(model.name)}</h2>${statusBadge(model)}</div><p>${escapeText(model.path)}</p></div>
      <div class="storage-card-tools"><time class="storage-card-checked" title="最終確認：${escapeText(model.checkedAt)}" aria-label="最終確認：${escapeText(model.checkedAgo)}">${escapeText(model.checkedAgo)}</time><button class="storage-refresh" type="button" ${onRefresh === null ? 'disabled' : ''} title="現在の容量情報を確認" aria-label="${escapeText(model.name)} の現在の容量情報を確認">↻</button></div>
    </div>
    <div class="storage-primary-metric"><div><span>空き容量</span><strong>${model.total === '未取得' ? '未取得' : `${escapeText(model.free)} / ${escapeText(model.total)}`}</strong></div><div><span>使用率</span><strong>${model.usagePercent === null ? '未取得' : `${escapeText(model.usagePercent)}%`}</strong></div></div>
    ${usageBar(model)}
    <div class="storage-card-footer">${note(model)}<div class="storage-links"><a href="${model.ruleHref}" data-filter-link>ルール ${model.ruleCount}</a><a href="${model.reserveHref}" data-filter-link>予約 ${model.reserveCount}</a><a href="${model.recordedHref}" data-filter-link>録画済み ${model.recordedCount}</a></div></div>`;
}

export function createStorageCard(model, { onRefresh = null } = {}) {
  let currentModel = model;
  let signature = JSON.stringify(model);
  const article = document.createElement('article');
  article.className = `storage-card is-${model.state.key}${model.state.stale ? ' is-reference' : ''}`;
  article.innerHTML = storageCardMarkup(model, onRefresh);
  if (onRefresh !== null) {
    const button = article.querySelector('.storage-refresh');
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.classList.add('is-loading');
      try {
        await onRefresh(currentModel);
      } finally {
        button.disabled = false;
        button.classList.remove('is-loading');
      }
    });
  }
  function update(next) {
    currentModel = next;
    const nextSignature = JSON.stringify(next);
    if (signature === nextSignature) return;
    signature = nextSignature;
    article.className = `storage-card is-${next.state.key}${next.state.stale ? ' is-reference' : ''}`;
    const template = document.createElement('div');
    template.innerHTML = storageCardMarkup(next, onRefresh);
    for (const selector of ['.storage-card-ident h2', '.storage-card-ident p', '.storage-status-badge',
      '.storage-card-checked',
      '.storage-primary-metric strong', '.storage-links a']) {
      const oldNodes = article.querySelectorAll(selector);
      template.querySelectorAll(selector).forEach((incoming, index) => {
        const retained = oldNodes[index];
        if (retained.textContent !== incoming.textContent) retained.textContent = incoming.textContent;
        for (const attribute of incoming.attributes) {
          if (retained.getAttribute(attribute.name) !== attribute.value) retained.setAttribute(attribute.name, attribute.value);
        }
      });
    }
    for (const selector of ['.storage-usage-wrap']) {
      const retained = article.querySelector(selector), incoming = template.querySelector(selector);
      if (retained.outerHTML !== incoming.outerHTML) retained.replaceWith(incoming);
    }
    const retainedNote = article.querySelector('.storage-note');
    const incomingNote = template.querySelector('.storage-note');
    if (!incomingNote) retainedNote?.remove();
    else if (!retainedNote) article.querySelector('.storage-card-footer').prepend(incomingNote);
    else if (retainedNote.outerHTML !== incomingNote.outerHTML) retainedNote.replaceWith(incomingNote);
    article.querySelector('.storage-refresh').setAttribute('aria-label', `${next.name} の現在の容量情報を確認`);
  }
  return { element: article, update };
}
