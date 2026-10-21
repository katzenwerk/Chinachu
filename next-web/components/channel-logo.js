function normalizedText(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' ? fallback : text;
}

export function createChannelLogo(initialModel = {}, options = {}) {
  const variant = options.variant === 'thumbnail' ? 'thumbnail' : 'list';
  const focusable = options.focusable === true;
  const element = document.createElement('span');
  element.className = `channel-logo is-${variant}`;
  element.setAttribute('role', 'img');
  if (focusable) element.tabIndex = 0;
  element.innerHTML = `
    <img class="channel-logo-image" hidden alt="">
    <span class="channel-logo-fallback"></span>`;

  const image = element.querySelector('.channel-logo-image');
  const fallback = element.querySelector('.channel-logo-fallback');
  let currentUrl = null;

  image.addEventListener('load', () => {
    if (image.getAttribute('src') !== currentUrl) return;
    image.hidden = false;
    fallback.hidden = true;
  });
  image.addEventListener('error', () => {
    if (image.getAttribute('src') !== currentUrl) return;
    image.hidden = true;
    fallback.hidden = false;
  });

  function update(model = {}) {
    const name = normalizedText(model.name, '放送局名未取得');
    const fallbackText = normalizedText(model.fallbackText, name);
    const tooltipText = normalizedText(model.tooltip, name);
    const nextUrl = normalizedText(model.url) || null;
    element.setAttribute('aria-label', tooltipText);
    element.title = tooltipText;
    fallback.textContent = fallbackText;
    if (nextUrl === currentUrl) return;
    currentUrl = nextUrl;
    image.hidden = true;
    fallback.hidden = nextUrl !== null;
    if (nextUrl === null) image.removeAttribute('src');
    else image.src = nextUrl;
  }

  function dispose() {
    currentUrl = null;
    image.removeAttribute('src');
  }

  update(initialModel);
  return { element, update, dispose };
}
