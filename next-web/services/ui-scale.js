const STORAGE_KEY = 'chinachu.ui.scale.v1';
let currentPercent = 100;

function validPercent(value) {
  return Number.isInteger(value) && value >= 70 && value <= 120 && value % 5 === 0;
}

function applyScale() {
  document.documentElement.style.setProperty('--wui-zoom', String(getUiZoom()));
  document.documentElement.style.zoom = String(getUiZoom());
}

export function initializeUiScale() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
    currentPercent = validPercent(saved) ? saved : 100;
  } catch (_) {
    currentPercent = 100;
  }
  applyScale();
}

export function getUiScalePercent() { return currentPercent; }
export function getUiZoom() { return currentPercent / 100; }

export function setUiScalePercent(value) {
  currentPercent = validPercent(value) ? value : 100;
  applyScale();
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(currentPercent)); } catch (_) {}
  // Existing viewport measurements (Guide and open overlays) must follow the new size.
  window.dispatchEvent(new Event('resize'));
}

// Pointer/DOMRect coordinates are visual CSS pixels; fixed left/top use pre-zoom pixels.
export function viewportCssPixels(value) { return `${value / getUiZoom()}px`; }
