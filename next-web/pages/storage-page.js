import { invalidateResources, loadResources } from '../services/api-client.js';
import { buildStorageViewModels, resolveRecordedStorage } from '../services/storage-model.js';
import { isReservationDisplayTarget } from '../services/reservation-model.js';
import { loadRecordedResultsWithStoragePaths } from '../services/recorded-results-client.js';
import { refreshStorageCapacity, retryStorageData, subscribeStorageData } from '../services/storage-store.js';
import { createStorageCard } from '../components/storage-card.js';
import { openCleanerDialog } from '../components/cleaner-dialog.js';
import { subscribeRecordedNotifications, subscribeReservationNotifications } from '../services/realtime-client.js';

export function renderStoragePage(container) {
  let active = true;
  let storageState = { status: 'loading', data: null, error: null };
  let related = null;
  let relatedError = null;
  let relatedRequest = null;
  let relatedRefreshPending = false;
  let feedback = '';
  let panel = null;
  const cards = new Map();

  const isActive = () => active && container.isConnected;

  function renderLoading() {
    container.innerHTML = '<div class="panel storage-message"><h2>Storage情報を取得しています</h2><p>取得済みのストレージ情報を読み込んでいます。</p></div>';
  }

  function renderError(error) {
    const message = document.createElement('div');
    message.className = 'panel storage-message';
    message.innerHTML = '<h2>Storage情報を取得できませんでした</h2><p></p><button class="button" type="button">再試行</button>';
    message.querySelector('p').textContent = String(error?.message || error);
    message.querySelector('button').addEventListener('click', () => {
      retryStorageData();
      loadRelated(true);
    }, { once: true });
    container.replaceChildren(message);
  }

  async function handleManualRefresh(model) {
    const accepted = window.confirm(`${model.name} の容量情報を再測定します。休止中のディスクが起動する場合があります。実行しますか？`);
    if (!accepted) return;
    feedback = `${model.name} の容量情報を更新しています…`;
    try {
      await refreshStorageCapacity(model.refreshStorageId);
      feedback = `${model.name} の容量情報を更新しました。`;
    } catch (error) {
      feedback = String(error?.message || error);
    } finally {
      if (isActive()) render();
    }
  }

  function render() {
    if (!isActive()) return;
    if (storageState.data === null || related === null) {
      const error = storageState.data === null && storageState.status === 'error'
        ? storageState.error
        : relatedError;
      if (error) renderError(error); else renderLoading();
      return;
    }
    const now = Date.now();
    const models = buildStorageViewModels({ storage: storageState.data, ...related,
      reserves: related.reserves.filter(program => isReservationDisplayTarget(program, now)) }, now);
    const unassignedRecorded = related.recordedResults.filter(item => !resolveRecordedStorage(storageState.data, item)).length;
    if (!panel) {
      panel = document.createElement('section');
      panel.className = 'panel storage-page-panel';
      panel.setAttribute('aria-label', 'ストレージ一覧');
      panel.innerHTML = `
        <div class="storage-snapshot-warning" hidden>Storage情報を更新できないため、最後に取得した情報を表示しています。</div>
        <div class="storage-grid" id="storage-grid"></div>
        <p class="storage-page-note">空き容量は録画中に自動更新されます。録画中以外は、休止中のHDDを起動させないため、概算値を表示しています。<BR>最新の空き容量を確認する場合は、各カード右上の更新ボタンを押してください。※手動更新により、休止中のHDDが起動する場合があります。</p>
        <div class="storage-management-row"><p>録画台帳と登録録画フォルダの所在を明示操作で照合します。</p><button class="button" data-open-cleaner type="button">台帳整理</button></div>
        <p class="storage-page-note" data-unassigned hidden></p>
        <p class="storage-refresh-feedback" role="status" ${feedback ? '' : 'hidden'}></p>`;
      panel.querySelector('[data-open-cleaner]').addEventListener('click', openCleanerDialog);
      container.replaceChildren(panel);
    }
    panel.querySelector('.storage-snapshot-warning').hidden = storageState.status !== 'error' && !relatedError;
    const unassigned = panel.querySelector('[data-unassigned]');
    unassigned.hidden = unassignedRecorded === 0;
    const unassignedText = `保存済み情報から登録録画先を特定できない録画済み ${unassignedRecorded}件は、録画先別の件数に含めていません。`;
    if (unassigned.textContent !== unassignedText) unassigned.textContent = unassignedText;
    const grid = panel.querySelector('#storage-grid');
    const keys = new Set(models.map(model => model.id));
    for (const [key, card] of cards) {
      if (keys.has(key)) continue;
      card.element.remove(); cards.delete(key);
    }
    if (models.length === 0) {
      if (!grid.querySelector('.storage-message')) grid.innerHTML = '<div class="storage-message is-embedded"><h2>録画先がありません</h2><p>Storage APIに録画先が登録されていません。</p></div>';
    } else {
      grid.querySelector('.storage-message')?.remove();
      let cursor = grid.firstChild;
      models.forEach(model => {
        let card = cards.get(model.id);
        if (!card) { card = createStorageCard(model, { onRefresh: handleManualRefresh }); cards.set(model.id, card); }
        else card.update(model);
        if (card.element === cursor) cursor = cursor.nextSibling;
        else grid.insertBefore(card.element, cursor);
      });
    }
    panel.querySelector('.storage-refresh-feedback').textContent = feedback;
    panel.querySelector('.storage-refresh-feedback').hidden = !feedback;
  }

  function loadRelated(force = false) {
    if (relatedRequest !== null) {
      relatedRefreshPending ||= force;
      return relatedRequest;
    }
    if (force) invalidateResources(['rules', 'reserves']);
    relatedError = null;
    relatedRequest = Promise.all([
      loadResources(['rules', 'reserves']),
      loadRecordedResultsWithStoragePaths({ results: ['recorded'], limit: 200 })
    ]).then(([result, recordedResults]) => {
      if (!Array.isArray(result.rules) || !Array.isArray(result.reserves)) {
        throw new Error('Storage related API response is invalid');
      }
      related = {
        rules: result.rules,
        reserves: result.reserves,
        recordedResults
      };
    }).catch(error => {
      relatedError = error;
    }).finally(() => {
      relatedRequest = null;
      render();
      if (relatedRefreshPending && isActive()) {
        relatedRefreshPending = false;
        void loadRelated(true);
      }
    });
    return relatedRequest;
  }

  renderLoading();
  loadRelated();
  const unsubscribeStorage = subscribeStorageData(state => {
    storageState = state;
    render();
  });
  const refreshRelated = () => { if (isActive()) void loadRelated(true); };
  const unsubscribeReserves = subscribeReservationNotifications(refreshRelated);
  const unsubscribeRecorded = subscribeRecordedNotifications(refreshRelated);

  return () => {
    active = false;
    unsubscribeReserves();
    unsubscribeRecorded();
    unsubscribeStorage();
  };
}
