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

// Reuse the existing tooltip panel, with focus/tap access for result labels.
export function applyResultWarningTooltip(element, description) {
  const label = element.textContent;
  element.classList.add('storage-warning', 'result-warning-label');
  element.tabIndex = 0;
  element.setAttribute('role', 'button');
  element.setAttribute('aria-label', `${label}。${description}`);
  const tip = document.createElement('span');
  tip.className = 'storage-warning-tip'; tip.setAttribute('role', 'tooltip'); tip.textContent = description;
  element.append(tip);
  const position = () => {
    const anchor = element.getBoundingClientRect(), panel = tip.getBoundingClientRect();
    const margin = 12, gap = 7;
    tip.style.left = `${Math.max(margin, Math.min(anchor.right - panel.width, window.innerWidth - panel.width - margin))}px`;
    const above = anchor.top - panel.height - gap;
    tip.style.top = `${Math.max(margin, Math.min(above >= margin ? above : anchor.bottom + gap, window.innerHeight - panel.height - margin))}px`;
  };
  element.addEventListener('mouseenter', position);
  element.addEventListener('focus', position);
  element.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); element.focus(); position(); });
  element.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); element.focus(); }
  });
}
