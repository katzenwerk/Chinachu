import { helpContent } from './help-content.js';

export function renderHelpPage(container, query) {
  container.innerHTML = `<article class="help-page">${helpContent}</article>`;
  const scrollToSection = id => {
    const section = [...container.querySelectorAll('.help-section, .help-topic')].find(item => item.id === id);
    if (!section) return;
    section.focus({ preventScroll: true });
    section.scrollIntoView({ block: 'start' });
  };
  const onClick = event => {
    const link = event.target.closest('[data-help-section]');
    if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    // Keep the whole document mounted when moving through its table of contents.
    history.replaceState(null, '', link.getAttribute('href'));
    scrollToSection(link.dataset.helpSection);
  };
  container.addEventListener('click', onClick);
  const frame = requestAnimationFrame(() => scrollToSection(query.get('section')));
  return () => {
    cancelAnimationFrame(frame);
    container.removeEventListener('click', onClick);
  };
}
