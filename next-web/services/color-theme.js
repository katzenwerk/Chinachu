// Loaded synchronously in <head>, before styles, to avoid a default-theme flash.
(() => {
  const key = 'chinachu.ui.theme.v1';
  const palettes = Object.freeze([
    ['thorn', 'Thorn Standard'], ['gamma', 'Gamma Classic'], ['garnet', 'Garnet Red'],
    ['indigo', 'Indigo'], ['teal', 'Deep Teal'], ['violet', 'Smoky Violet'],
    ['terra', 'Terracotta'], ['saffron', 'Saffron'], ['tangerine', 'Tangerine'],
    ['signal-ember', 'Signal Ember', 'duo'],
    ['carbon-citron', 'Carbon Citron', 'duo'],
    ['slate-cyan', 'Slate Cyan', 'duo'],
    ['ink-coral', 'Ink Coral', 'duo'],
    ['asphalt-orchid', 'Asphalt Orchid', 'duo'],
    ['black-rose', 'Black Rose', 'duo'],
    ['forest-ice', 'Forest Ice', 'duo'],
    ['choco-mint', 'Choco Mint', 'duo'],
    ['cocoa-mint', 'Cocoa Mint', 'duo'],
    ['matcha-olive', 'Matcha Olive', 'duo'],
    ['cocoa-sky', 'Cocoa Sky', 'duo'],
    ['aubergine-sage', 'Aubergine Sage', 'duo'],
    ['bordeaux-ice', 'Bordeaux Ice', 'duo'],
    ['forest-coral', 'Forest Coral', 'duo'],
    ['blueberry-cream', 'Blueberry Cream', 'duo'],
    ['night-sakura', 'Night Sakura', 'duo']
  ]);
  const initial = { palette: 'thorn', mode: 'light' };
  function valid(value) {
    return value && palettes.some(([id]) => id === value.palette) && ['light', 'dark'].includes(value.mode);
  }
  let current = initial;
  try {
    const saved = JSON.parse(window.localStorage.getItem(key));
    if (saved && ['light', 'dark'].includes(saved.mode)) {
      current = { palette: valid(saved) ? saved.palette : initial.palette, mode: saved.mode };
    }
  } catch (_) { /* Unavailable storage uses the initial palette. */ }
  function apply() {
    document.documentElement.dataset.palette = current.palette;
    document.documentElement.dataset.theme = current.mode;
    document.documentElement.dataset.paletteStyle = palettes.find(([id]) => id === current.palette)[2] || 'single';
  }
  apply();
  window.chinachuTheme = Object.freeze({
    palettes,
    get: () => ({ ...current }),
    set(value) {
      current = valid(value) ? { palette: value.palette, mode: value.mode } : initial;
      apply();
      try { window.localStorage.setItem(key, JSON.stringify(current)); } catch (_) {}
      window.dispatchEvent(new CustomEvent('chinachu-theme-change'));
    }
  });
})();
