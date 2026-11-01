import { mountRecordingList } from '../components/recording-list.js';
import { createHomeProgramContextMenu } from '../components/home-program-context-menu.js';
import { openProgramDetailDialog } from '../components/program-detail-dialog.js';
import { copyProgramTitle, programSearchUrl } from '../services/program-actions.js';
import { retryRecordingData } from '../services/recording-store.js';

export function renderRecordingPage(container) {
  const page = document.createElement('div');
  page.className = 'recording-page';
  page.innerHTML = '<section class="panel recording-page-panel" aria-label="録画中番組一覧"><div class="recording-page-content"></div></section>';
  container.replaceChildren(page);
  const menu = createHomeProgramContextMenu({
    onAction(action, item) {
      if (action === 'rule') return openProgramDetailDialog({ id: item.id, initialAction: 'rule', onChanged: retryRecordingData });
      if (action === 'copy-title') return void copyProgramTitle(item.title).catch(error => window.alert(String(error?.message || error)));
      if (action === 'search-google' || action === 'search-wikipedia') {
        window.open(programSearchUrl(action === 'search-google' ? 'google' : 'wikipedia', item.title), '_blank', 'noopener');
      }
    }
  });
  const dispose = mountRecordingList(page.querySelector('.recording-page-content'), {
    showStorageWarnings: true,
    onContextMenu({ model, program }, point) {
      menu.open({ kind: 'recording', id: model.id, title: model.title, model, program, refresh: retryRecordingData }, point);
    }
  });
  return () => { menu.destroy(); dispose(); };
}
