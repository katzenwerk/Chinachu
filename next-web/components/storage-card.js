function escapeText(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[character]);
}

function icon() {
  return '<svg class="icon"><use href="#icon-storage"></use></svg>';
}

function statusBadge(model) {
  return `<span class="storage-status-badge is-${escapeText(model.state.key)}">${escapeText(model.state.label)}</span>`;
}

function usageBar(model) {
  const value = model.usagePercent === null ? 0 : Number(model.usagePercent);
  const label = model.usagePercent === null ? '使用率 未取得' : `使用率 ${model.usagePercent}%`;
  const closeClass = model.thresholdMarkersClose ? ' is-close' : '';
  const warningMarker = model.warningMarker === null ? '' : `<span class="storage-threshold-marker is-warning${closeClass}" style="left:${model.warningMarker}%" title="Warning：空き${escapeText(model.warningThreshold)}以下" aria-hidden="true"></span>`;
  const lowMarker = model.lowMarker === null ? '' : `<span class="storage-threshold-marker is-low${closeClass}" style="left:${model.lowMarker}%" title="Low：空き${escapeText(model.lowThreshold)}以下" aria-hidden="true"></span>`;
  return `<div class="storage-usage-wrap"><div class="storage-usage-bar is-${escapeText(model.state.key)}" role="progressbar" aria-label="${escapeText(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}"><i style="width:${value}%"></i></div>${warningMarker}${lowMarker}</div>`;
}

function thresholdValues(model) {
  const warning = model.warningThreshold === null ? '' : `<span class="is-warning">Warning閾値：<strong>${escapeText(model.warningThreshold)}</strong></span>`;
  const low = model.lowThreshold === '対象外' ? '' : `<span class="is-low">Low閾値：<strong>${escapeText(model.lowThreshold)}</strong></span>`;
  if (!warning && !low) return '';
  return `<div class="storage-threshold-values">${warning}${low}</div>`;
}

function note(model) {
  if (model.notes.length === 0) return '';
  return `<div class="storage-note is-${escapeText(model.state.key)}">${model.notes.map((line, index) => index === model.notes.length - 1 && (line.includes('停止中') || line.includes('録画禁止中')) ? `<strong>${escapeText(line)}</strong>` : `<span>${escapeText(line)}</span>`).join('')}</div>`;
}

export function createStorageCard(model, { onRefresh = null } = {}) {
  const article = document.createElement('article');
  article.className = `storage-card is-${model.state.key}${model.state.stale ? ' is-reference' : ''}`;
  article.innerHTML = `
    <div class="storage-card-head">
      <div class="storage-drive-icon">${icon()}</div>
      <div class="storage-card-ident"><div><h2>${escapeText(model.name)}</h2>${statusBadge(model)}</div><p>${escapeText(model.path)}</p></div>
      <div class="storage-card-tools"><time><span class="storage-checked-label">最終確認</span><span class="storage-checked-value">${escapeText(model.checkedAt)}</span><span class="storage-checked-ago">${escapeText(model.checkedAgo)}</span></time><button class="storage-refresh" type="button" ${onRefresh === null ? 'disabled' : ''} title="現在の容量情報を確認" aria-label="${escapeText(model.name)} の現在の容量情報を確認">↻</button></div>
    </div>
    <div class="storage-primary-metric"><div><span>空き容量</span><strong>${escapeText(model.free)}</strong></div><div><span>使用率</span><strong>${model.usagePercent === null ? '未取得' : `${escapeText(model.usagePercent)}%`}</strong></div></div>
    ${usageBar(model)}
    <div class="storage-values"><div><span>使用量：</span><strong>${escapeText(model.usage)}</strong></div>${thresholdValues(model)}</div>
    <div class="storage-card-footer">${note(model)}<div class="storage-links"><a href="${model.ruleHref}" data-filter-link>対象ルール ${model.ruleCount}件</a><a href="${model.reserveHref}" data-filter-link>録画予定 ${model.reserveCount}件</a></div></div>`;
  if (onRefresh !== null) {
    const button = article.querySelector('.storage-refresh');
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.classList.add('is-loading');
      try {
        await onRefresh(model);
      } finally {
        button.disabled = false;
        button.classList.remove('is-loading');
      }
    });
  }
  return article;
}
