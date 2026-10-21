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
