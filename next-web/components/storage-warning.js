import { viewportCssPixels } from '../services/ui-scale.js';
let activeResultTooltip = null;

export function applyStorageWarning(element, notice) {
  element.hidden = notice === null;
  element.classList.toggle('is-strong', notice?.strong === true);
  const text = element.querySelector('.storage-warning-text');
  const tip = element.querySelector('.storage-warning-tip');
  text.textContent = notice?.label || '';
  tip.textContent = notice?.tooltip || '';
  element.setAttribute('aria-label', notice === null ? '' : `${notice.label}。${notice.tooltip}`);
  if (notice !== null && element.closest('a') === null) element.tabIndex = 0;
  else element.removeAttribute('tabindex');
}

// Use the top layer so result tooltips also escape clipped cards and dialogs.
export function applyResultWarningTooltip(element, description) {
  const label = element.textContent;
  element.classList.add('storage-warning', 'result-warning-label');
  element.tabIndex = 0;
  element.setAttribute('role', 'button');
  element.setAttribute('aria-label', `${label}。${description}`);
  const tip = element.querySelector('.storage-warning-tip') || document.createElement('span');
  tip.className = 'storage-warning-tip'; tip.setAttribute('role', 'tooltip'); tip.textContent = description;
  tip.setAttribute('popover', 'manual');
  element.append(tip);
  const position = () => {
    if (activeResultTooltip !== tip && activeResultTooltip?.matches(':popover-open')) activeResultTooltip.hidePopover();
    if (!tip.matches(':popover-open')) tip.showPopover();
    activeResultTooltip = tip;
    const anchor = element.getBoundingClientRect(), panel = tip.getBoundingClientRect();
    const margin = 12, gap = 7;
    tip.style.left = viewportCssPixels(Math.max(margin, Math.min(anchor.right - panel.width, window.innerWidth - panel.width - margin)));
    const above = anchor.top - panel.height - gap;
    tip.style.top = viewportCssPixels(Math.max(margin, Math.min(above >= margin ? above : anchor.bottom + gap, window.innerHeight - panel.height - margin)));
  };
  const close = () => {
    if (tip.matches(':popover-open')) tip.hidePopover();
    if (activeResultTooltip === tip) activeResultTooltip = null;
  };
  element.addEventListener('mouseenter', position);
  element.addEventListener('focus', position);
  element.addEventListener('mouseleave', () => { if (!element.matches(':focus-within')) close(); });
  element.addEventListener('blur', close);
  element.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); element.focus(); position(); });
  element.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); element.focus(); position(); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  });
}
