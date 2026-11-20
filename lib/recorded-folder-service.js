'use strict';
const { randomUUID } = require('node:crypto');
const { locations, readOptional, persist, conflict, pendingId } = require('./recorded-folder-maintenance');
function createService({ root, operatorRequest, getSeries, cleanerBusy, onChanged }) {
  let starting = false, lastOperatorJob = null;
  async function request(input) {
    const remote = await operatorRequest({ folderOrganize: true, action: 'state' });
    if (remote.version !== 1) throw conflict('Operatorを更新・再起動してください。');
    if (input.action === 'state' && remote.job && remote.job.id !== lastOperatorJob && ['complete', 'failed'].includes(remote.job.status)) {
      lastOperatorJob = remote.job.id;
      onChanged();
    }
    const paths = locations(root);
    if (input.action === 'state') {
      return { version: 1, pending: remote.pending, busy: remote.busy || starting, seriesReady: getSeries() !== null, job: remote.job,
        result: remote.job?.status === 'complete' ? readOptional(paths.result) : null };
    }
    if (input.action !== 'run') throw conflict('操作内容が不正です。画面を再読み込みしてください。');
    if (starting || remote.busy || cleanerBusy()) throw conflict('振り分けまたは台帳整理の処理中です。');
    starting = true;
    try {
      const series = getSeries();
      if (!series) throw conflict('シリーズ情報を準備しています。完了後に振り分けてください。');
      const id = randomUUID();
      // The existing Operator socket accepts small messages; do not send the full series index over IPC.
      persist(paths.request, { id, series });
      return await operatorRequest({ folderOrganize: true, action: 'run', requestId: id });
    } finally { starting = false; }
  }
  return { request, pendingId: () => pendingId(root) };
}
module.exports = { createService };
