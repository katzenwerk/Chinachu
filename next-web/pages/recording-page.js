import { mountRecordingList } from '../components/recording-list.js';

export function renderRecordingPage(container) {
  const page = document.createElement('div');
  page.className = 'recording-page';
  page.innerHTML = '<section class="panel recording-page-panel" aria-label="録画中番組一覧"><div class="recording-page-content"></div></section>';
  container.replaceChildren(page);
  return mountRecordingList(page.querySelector('.recording-page-content'), { showStorageWarnings: true });
}
