const CONTROL_ICONS = {
	// Official Lucide SVG geometry: https://lucide.dev/icons/captions and captions-off.
	captions: '<rect width="18" height="14" x="3" y="5" rx="2" ry="2"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/>',
	'captions-off': '<path d="M10.5 5H19a2 2 0 0 1 2 2v8.5"/><path d="M17 11h-.5"/><path d="M19 19H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2"/><path d="m2 2 20 20"/><path d="M7 11h4"/><path d="M7 15h2.5"/>',
	film: '<use href="#icon-film"/>',
	maximize: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
	minimize: '<path d="M3 8h5V3m8 0v5h5M8 21v-5H3m13 5v-5h5"/>',
	close: '<path d="m6 6 12 12M6 18 18 6"/>'
};
export function setControlLabel(button, label, icon) {
	button.title = label;
	button.setAttribute('aria-label', label);
	button.classList.toggle('program-live-compat', icon === 'film');
	button.innerHTML = `<svg class="program-live-control-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${CONTROL_ICONS[icon]}</svg><span class="program-live-control-label" aria-hidden="true">${label}</span>${icon === 'film' ? '<span class="program-live-compat-short" aria-hidden="true">互換</span>' : ''}`;
}
