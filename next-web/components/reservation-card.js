import { applyStorageWarning } from './storage-warning.js';
import { createChannelLogo } from './channel-logo.js';
import { setProgramHover } from './program-hover.js';

export function createReservationCard(model, { onOpenDetail } = {}) {
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
  article.querySelector('.reservation-datetime span').textContent = model.dateText;
  article.querySelector('time').textContent = model.timeText;
  const title = article.querySelector('.reservation-card-title');
  title.textContent = model.title;
  setProgramHover(title, model.hover);
  title.disabled = model.detailUrl === null || typeof onOpenDetail !== 'function';
  title.addEventListener('click', () => onOpenDetail?.(model));
  applyStorageWarning(article.querySelector('.reservation-storage-warning'), model.storageNotice);
  article.querySelector('.reservation-kind').textContent = model.reservationTypeText;
  return article;
}
