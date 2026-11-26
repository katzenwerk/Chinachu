import { deleteRecordedProgram, loadProgramDetail, ProgramDetailError } from './program-detail-client.js';
import { buildProgramDetailModel } from './program-detail-model.js';

const deleting = new Map();
const listeners = new Set();
const resultListeners = new Set();

export function isRecordedDeletionPending(recordedId) {
  return deleting.has(String(recordedId ?? '').trim());
}

function pendingOperations() {
  return [...deleting.values()].filter(operation => operation.phase !== 'checking');
}

function notifyPending() {
  const snapshot = pendingOperations();
  listeners.forEach(listener => listener(snapshot));
}

export function subscribeRecordedDeletions(listener) {
  listeners.add(listener);
  listener(pendingOperations());
  return () => listeners.delete(listener);
}

export function subscribeRecordedDeletionResults(listener) {
  resultListeners.add(listener);
  return () => resultListeners.delete(listener);
}

export function receiveRecordedDeletionProgress({ token, phase } = {}) {
  if (phase !== 'lock-waiting' && phase !== 'deleting') return;
  const operation = [...deleting.values()].find(item => item.token === token && item.token !== null);
  if (!operation || operation.phase === phase) return;
  operation.phase = phase;
  notifyPending();
}

function notifyResult({ recordedId, title }, message, level, fileDeleted = false) {
  resultListeners.forEach(listener => listener({ recordedId, fileDeleted, message: `「${title}」 ${message}`, level }));
}

async function runDeletion({ recordedId, title, signal, resolve, confirmed }) {
  const id = String(recordedId ?? '').trim();
  if (signal?.aborted || deleting.has(id)) return null;
  const initialHash = window.location.hash;
  const abandoned = () => signal?.aborted || window.location.hash !== initialHash;
  const operation = { recordedId: id, title: title || id || '録画', phase: 'checking', token: null };
  const release = () => {
    if (deleting.get(id) !== operation) return;
    deleting.delete(id);
    notifyPending();
  };
  if (!id) {
    notifyResult(operation, '録画対象を特定できません。', 'error');
    return null;
  }
  deleting.set(id, operation);
  signal?.addEventListener('abort', release, { once: true });
  notifyPending();
  let result;
  try {
    if (resolve) operation.title = await resolve();
    if (abandoned()) return null;
    if (!confirmed && !window.confirm(`${operation.title}\n\n録画ファイルを削除します。録画履歴・元の保存先・保存済みサムネイルは台帳整理まで保持されます。この操作は元に戻せません。`)) {
      return null;
    }

    // From confirmation onward, the request and its result outlive the initiating view.
    signal?.removeEventListener('abort', release);
    operation.token = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    operation.phase = 'requesting';
    notifyPending();

    result = await deleteRecordedProgram(id, operation.token);
  } catch (error) {
    if (operation.phase === 'checking' && abandoned()) return null;
    const failure = error?.details?.result;
    notifyResult(operation, error?.message || '録画ファイルを削除できませんでした。',
      failure?.fileDeleted ? 'warning' : 'error', failure?.fileDeleted === true);
    return failure || null;
  } finally {
    signal?.removeEventListener('abort', release);
    release();
  }
  notifyResult(operation, result.message || '録画ファイルを削除しました。', 'activity', true);
  void result.storageRefreshPending?.then(error => {
    if (error) notifyResult(operation, `削除後の容量表示を更新できませんでした。 ${error}`, 'warning');
  });
  return result;
}

export function deleteRecordedFromContext({ key = null, recordedId, fullTitle, title }, { signal } = {}) {
  return runDeletion({
    recordedId,
    title: fullTitle || title,
    signal,
    async resolve() {
      const detail = await loadProgramDetail({ key, id: recordedId, signal });
      const model = buildProgramDetailModel(detail);
      const allowed = model.actions.deleteRecording;
      if (!allowed) throw new ProgramDetailError('delete-unavailable', '削除できる録画ファイルがありません。');
      if (allowed.recordedId !== String(recordedId)) {
        throw new ProgramDetailError('recording-mismatch', '録画対象が変更されています。画面を更新して確認してください。');
      }
      return model.title;
    }
  });
}

export function deleteRecordingFromDetail({ recordedId, title, signal, confirmed = false }) {
  return runDeletion({ recordedId, title, signal, confirmed });
}
