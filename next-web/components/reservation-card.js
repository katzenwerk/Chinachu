import { applyStorageWarning } from './storage-warning.js';
import { createChannelLogo } from './channel-logo.js';
import { setProgramHover } from './program-hover.js';

export function createReservationCard(model, { onOpenDetail } = {}) {
  let currentModel = model;
  let signature = null;
  const article = document.createElement('article');
  article.className = 'reservation-card';
  article.innerHTML = `
    <div class="reservation-card-top">
      <div class="reservation-card-schedule">
        <span class="reservation-card-logo-slot"></span>
        <div class="reservation-datetime"><span></span><time></time></div>
      </div>
      <span class="reservation-storage-warning storage-warning is-align-right" hidden><span aria-hidden="true">⚠</span><span class="storage-warning-text"></span><span class="storage-warning-tip" role="tooltip"></span></span>
    </div>
    <h3><button class="reservation-card-title" type="button"></button></h3>
    <div class="reservation-meta"><span class="reservation-kind"></span></div>`;
  const channelLogo = createChannelLogo({
    url: model.channelLogoUrl,
    name: model.channelName,
    fallbackText: model.channelFallbackText,
    tooltip: model.channelTooltip
  }, { variant: 'thumbnail', focusable: true });
  article.querySelector('.reservation-card-logo-slot').replaceWith(channelLogo.element);
  const title = article.querySelector('.reservation-card-title');
  setProgramHover(title, () => currentModel.hover);
  title.addEventListener('click', () => onOpenDetail?.(currentModel));
  function update(next) {
    currentModel = next;
    const nextSignature = JSON.stringify(next);
    if (signature === nextSignature) return;
    signature = nextSignature;
    article.dataset.reservationKey = next.key;
    channelLogo.update({ url: next.channelLogoUrl, name: next.channelName,
      fallbackText: next.channelFallbackText, tooltip: next.channelTooltip });
    article.querySelector('.reservation-datetime span').textContent = next.dateText;
    article.querySelector('time').textContent = next.timeText;
    title.textContent = next.title;
    title.disabled = next.detailUrl === null || typeof onOpenDetail !== 'function';
    applyStorageWarning(article.querySelector('.reservation-storage-warning'), next.storageNotice);
    article.querySelector('.reservation-kind').textContent = next.reservationTypeText;
  }
  update(model);
  return { element: article, update, dispose: () => channelLogo.dispose() };
}
