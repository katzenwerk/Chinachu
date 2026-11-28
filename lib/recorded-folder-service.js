'use strict';
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { locations, readOptional, persist, conflict, pendingId, evaluateRename } = require('./recorded-folder-maintenance');
const { candidates, validFormat } = require('./recorded-series-name');

function renameRows(rows) {
  return rows.map(row => ({ before: row.oldPath && path.basename(row.oldPath), after: row.newPath && path.basename(row.newPath),
    status: row.status, reason: row.reason }));
}

function createService({ root, operatorRequest, getSeries, getSeriesDetail, cleanerBusy, onChanged }) {
  let starting = false, lastOperatorJob = null;
  const previews = new Map();
  async function request(input) {
    const remote = await operatorRequest({ folderOrganize: true, action: 'state' });
    if (remote.version !== 1) throw conflict('Operatorを更新・再起動してください。');
    if ((input.action === 'state' || input.action === 'rename-state') && !remote.busy && remote.job &&
        remote.job.id !== lastOperatorJob && ['complete', 'failed'].includes(remote.job.status)) {
      lastOperatorJob = remote.job.id;
      onChanged();
    }
    const paths = locations(root);
    if (input.action === 'state') {
      const job = remote.job?.action === 'rename' ? null : remote.job;
      return { version: 1, pending: remote.pending, busy: remote.busy || starting, seriesReady: remote.pending || getSeries() !== null, job,
        result: job?.status === 'complete' ? readOptional(paths.result) : null };
    }
    if (['rename-preview', 'rename-run', 'rename-state'].includes(input.action)) {
      if (remote.seriesRename !== true) throw conflict('ファイル名整理を利用するにはOperatorの更新が必要です。');
      if (input.action === 'rename-state') {
        if (remote.job?.action !== 'rename' || input.jobId !== remote.job.id) throw conflict('ファイル名整理の実行結果を確認できません。');
        const result = remote.job.status === 'complete' && !remote.busy ? readOptional(paths.result) : null;
        return { busy: remote.busy, job: remote.job, result: result && renameRows(result.results) };
      }
      if (remote.pending) throw conflict('未完了の処理があります。録画ファイルの振り分け画面から復旧してください。');
      if (input.action === 'rename-preview') {
        if (typeof input.seriesId !== 'string' || !input.seriesId || input.seriesId.length > 256) throw conflict('シリーズ指定が不正です。');
        const series = await getSeriesDetail(input.seriesId);
        const plan = await evaluateRename(root, candidates(series));
        const token = randomUUID();
        if (previews.size >= 16) previews.delete(previews.keys().next().value);
        previews.set(token, { seriesId: series.id, plan, expiresAt: Date.now() + 5 * 60_000 });
        return { token, rows: renameRows(plan.results), count: plan.results.filter(row => row.status === 'ready').length };
      }
    } else if (input.action !== 'run') throw conflict('操作内容が不正です。画面を再読み込みしてください。');
    if (starting || remote.busy || cleanerBusy()) throw conflict('振り分けまたは台帳整理の処理中です。');
    starting = true;
    try {
      const id = randomUUID();
      if (input.action === 'rename-run') {
        const preview = previews.get(input.token);
        if (!preview || preview.seriesId !== input.seriesId || preview.expiresAt < Date.now()) {
          previews.delete(input.token);
          throw conflict('プレビューの期限が切れました。もう一度確認してください。');
        }
        const latest = new Map(candidates(await getSeriesDetail(preview.seriesId)).map(entry => [entry.id, JSON.stringify(entry)]));
        const plan = { ...preview.plan, results: preview.plan.results.map(row =>
          row.action === 'rename' && latest.get(row.id) !== JSON.stringify(row.entry) ?
            { ...row, action: 'none', status: 'failed', reason: 'プレビュー後にシリーズ・話数の紐づけが変わりました。' } : row) };
        if (!plan.results.some(row => row.action === 'rename')) throw conflict('改名できる対象がありません。もう一度プレビューしてください。');
        persist(paths.request, { id, plan });
        const result = await operatorRequest({ folderOrganize: true, action: 'rename', requestId: id });
        previews.delete(input.token);
        return result;
      }
      const series = getSeries();
      if (!series && !remote.pending) throw conflict('シリーズ情報を準備しています。完了後に振り分けてください。');
      // The existing Operator socket accepts small messages; do not send the full series index over IPC.
      persist(paths.request, { id, series });
      return await operatorRequest({ folderOrganize: true, action: 'run', requestId: id });
    } finally { starting = false; }
  }
  return { request, validRenameFormat: validFormat, pendingId: () => pendingId(root) };
}
module.exports = { createService };
