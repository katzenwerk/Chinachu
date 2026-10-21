import { deleteRecordedProgram, loadProgramDetail, ProgramDetailError } from './program-detail-client.js';
import { buildProgramDetailModel } from './program-detail-model.js';

const deleting = new Set();

// 右クリックからの削除。共通詳細と同じモデルで削除可否を確認するが、詳細モーダルは生成しない。
export async function deleteRecordedFromContext({ key = null, recordedId = null } = {}) {
  const identity = key || recordedId;
  if (!identity) throw new ProgramDetailError('invalid-request', '録画対象を特定できません');
  if (deleting.has(identity)) return null;
  deleting.add(identity);
  try {
    const detail = await loadProgramDetail({ key, id: recordedId });
    const model = buildProgramDetailModel(detail);
    const allowed = model.actions.deleteRecording;
    if (!allowed) throw new ProgramDetailError('delete-unavailable', '削除できる録画ファイルがありません');
    // 履歴と録画の紐付けが変化していても、別の録画を誤削除しない。
    if (recordedId && allowed.recordedId !== recordedId) {
      throw new ProgramDetailError('recording-mismatch', '録画対象が変更されています。画面を更新して確認してください');
    }
    if (!window.confirm(`${model.title}\n\n録画ファイルを削除します。録画履歴・元の保存先・保存済みサムネイルは台帳整理まで保持されます。この操作は元に戻せません。`)) {
      return null;
    }
    return await deleteRecordedProgram(allowed.recordedId);
  } finally {
    deleting.delete(identity);
  }
}
