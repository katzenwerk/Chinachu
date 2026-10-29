import { createRecordingCard } from './recording-card.js';
import { appendMobileContextButton } from './mobile-layout.js';
import { closeActiveLiveOverlay, openRecordingLiveOverlay } from '../services/live-player-adapter.js';
import { buildRecordingViewModels } from '../services/recording-model.js';
import { retryRecordingData, subscribeRecordingData } from '../services/recording-store.js';
import { subscribeStorageData } from '../services/storage-store.js';

export function mountRecordingList(container, {
  onCountChange = () => {},
  showStorageWarnings = false,
  cardVariant = 'default',
  compactEmpty = false,
  onContextMenu = null
} = {}) {
  const cards = new Map();
  let latestPrograms = [];
  let disposed = false;
  let storageData = null;
  const contextModels = new Map();

  function clearCards() {
    cards.forEach(card => card.dispose());
    cards.clear();
    contextModels.clear();
  }

  function renderPrograms(programs) {
    latestPrograms = programs;
    const models = buildRecordingViewModels(programs, Date.now(), { storageData });
    contextModels.clear();
    models.forEach(model => {
      const source = programs.find(program => program.id === model.id);
      contextModels.set(model.key, { model, program: source });
    });
    onCountChange(models.length, 'ready');
    const activeKeys = new Set(models.map(model => model.key));
    cards.forEach((card, key) => {
      if (activeKeys.has(key)) return;
      card.dispose();
      cards.delete(key);
    });
    if (models.length === 0) {
      if (compactEmpty) container.replaceChildren();
      else container.innerHTML = '<p class="home-section-message">現在録画中の番組はありません</p>';
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'recording-grid';
    models.forEach(model => {
      let card = cards.get(model.key);
      if (!card) {
        card = createRecordingCard(model, { onWatch: openRecordingLiveOverlay, variant: cardVariant });
        if (typeof onContextMenu === 'function') appendMobileContextButton(card.element, card.element.querySelector('.recording-home-actions') || card.element);
        cards.set(model.key, card);
      } else {
        card.update(model);
      }
      if (typeof onContextMenu === 'function') card.element.dataset.homeRecordingKey = model.key;
      grid.append(card.element);
    });
    container.replaceChildren(grid);
  }

  function renderError(error) {
    latestPrograms = [];
    clearCards();
    onCountChange(null, 'error');
    const message = document.createElement('div');
    message.className = 'recording-list-error';
    message.innerHTML = '<p>録画情報を取得できませんでした</p><small></small><button class="button" type="button">再試行</button>';
    message.querySelector('small').textContent = String(error.message || error);
    message.querySelector('button').addEventListener('click', () => retryRecordingData(), { once: true });
    container.replaceChildren(message);
  }

  function renderState(nextState) {
    if (disposed || !container.isConnected) return;
    if (nextState.status === 'ready') {
      renderPrograms(nextState.programs);
      return;
    }
    if (nextState.status === 'error') {
      renderError(nextState.error);
      return;
    }
    onCountChange(null, 'loading');
    container.innerHTML = '<p class="home-section-message">録画情報を取得しています</p>';
  }

  function updateDynamicValues() {
    if (disposed || !container.isConnected || latestPrograms.length === 0) return;
    buildRecordingViewModels(latestPrograms, Date.now(), { storageData }).forEach(model => {
      const card = cards.get(model.key);
      if (!card) return;
      card.updateDynamic(model);
      card.refreshPreview();
    });
  }

  function openContext(event) {
    if (typeof onContextMenu !== 'function') return;
    const card = event.target.closest?.('.recording-card[data-home-recording-key]');
    if (!card || !container.contains(card)) return;
    const item = contextModels.get(card.dataset.homeRecordingKey);
    if (!item?.model?.id) return;
    event.preventDefault();
    const rect = card.getBoundingClientRect();
    const point = event.type === 'contextmenu'
      ? { x: event.clientX, y: event.clientY }
      : { x: rect.left + 16, y: rect.top + 16 };
    onContextMenu(item, point);
  }
  const keyboardContext = event => {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
    openContext(event);
  };
  if (typeof onContextMenu === 'function') {
    container.addEventListener('contextmenu', openContext);
    container.addEventListener('keydown', keyboardContext);
  }

  const unsubscribe = subscribeRecordingData(renderState);
  const timer = window.setInterval(updateDynamicValues, 30000);
  let unsubscribeStorage = null;
  if (showStorageWarnings) {
    unsubscribeStorage = subscribeStorageData(state => {
      if (disposed || state.data === null) return;
      storageData = state.data;
      if (latestPrograms.length !== 0) renderPrograms(latestPrograms);
    });
  }

  return () => {
    disposed = true;
    unsubscribe();
    container.removeEventListener('contextmenu', openContext);
    container.removeEventListener('keydown', keyboardContext);
    unsubscribeStorage?.();
    window.clearInterval(timer);
    clearCards();
    closeActiveLiveOverlay();
  };
}
