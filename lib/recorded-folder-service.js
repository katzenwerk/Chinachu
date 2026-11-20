'use strict';
const { createJobs } = require('./recorded-folder-jobs');
const { locations, readOptional, conflict, pendingId } = require('./recorded-folder-maintenance');
function createService({ root, operatorRequest, getSeries, cleanerBusy, onChanged }) {
  let applying = false, starting = false, lastOperatorJob = null;
  const evaluations = createJobs({ root });
  async function request(input) {
    const remote = await operatorRequest({ folderOrganize: true, action: 'state' });
    if (remote.version !== 1) throw conflict('Operatorを更新・再起動してください。');
    if (remote.job && remote.job.id !== lastOperatorJob && ['complete', 'failed'].includes(remote.job.status)) {
      lastOperatorJob = remote.job.id;
      onChanged();
    }
    applying = remote.busy;
    const paths = locations(root);
    if (input.action === 'state') {
      const local = evaluations.get();
      const remoteJob = remote.job && (!local || remote.job.startedAt >= (local.startedAt || 0)) ? remote.job : null;
      const job = remote.busy || applying ? remote.job : local?.status === 'running' ? local : remoteJob || local;
      return { version: 1, pending: remote.pending, busy: remote.busy || evaluations.isBusy(), job,
        result: job?.action === 'evaluate' ? job.result : job?.status === 'complete' ? readOptional(paths.result) : null };
    }
    if (starting || applying || evaluations.isBusy() || cleanerBusy()) throw conflict('振り分けまたは台帳整理の処理中です。');
    starting = true;
    try {
      if (input.action === 'evaluate') {
        const series = getSeries();
        if (!series) throw conflict('シリーズ情報を準備しています。完了後に評価してください。');
        return evaluations.start('evaluate', { options: { repairPaths: input.repairPaths === true }, series });
      }
      if (input.action === 'apply') {
        const preview = readOptional(paths.preview), series = getSeries();
        if (input.confirm !== true || !preview || preview.id !== input.previewId || !series || series.generation !== preview.series.generation) throw conflict('評価結果またはシリーズ情報が変わりました。再評価してください。');
        if (!preview.results.some(item => item.action !== 'none')) throw conflict('適用できる候補はありません。');
      } else if (input.action !== 'recover' || input.confirm !== true) throw conflict('操作内容が不正です。');
      const result = await operatorRequest({ folderOrganize: true, action: input.action, previewId: input.previewId });
      applying = true;
      return result;
    } finally { starting = false; }
  }
  return { request, pendingId: () => pendingId(root) };
}
module.exports = { createService };
