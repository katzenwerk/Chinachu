'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const maintenance = require('./recorded-folder-maintenance');

// WUI owns evaluations; Operator owns file changes and pauses its post-processing.
function createJobs({ root, canStart = () => {}, onDone = () => {}, compact = false }) {
  let job = null, worker = null;
  function get() {
    if (!job) return null;
    const value = { ...job };
    if (compact) delete value.result;
    return value;
  }
  function start(action, input = {}) {
    if (worker !== null) throw maintenance.conflict('振り分けの処理中です。完了後に再操作してください。');
    canStart(action);
    job = { id: randomUUID(), startedAt: Date.now(), action, status: 'running', progress: { phase: '開始中' }, result: null, error: null };
    const id = job.id;
    try { worker = new Worker(path.join(__dirname, 'recorded-folder-worker.js'), { workerData: { root, action, ...input } }); }
    catch (error) { job.status = 'failed'; job.error = { message: error.message }; throw error; }
    const finish = error => {
      if (job.id !== id || job.status !== 'running') return;
      job.status = error ? 'failed' : 'complete';
      job.error = error ? { message: error.message } : null;
      // The worker may still be releasing its transaction lock. Resume only on exit.
    };
    worker.on('message', message => {
      if (job.id !== id) return;
      if (message.progress) job.progress = message.progress;
      if (message.error) finish(message.error);
      if (message.result) { job.result = message.result; finish(); }
    });
    worker.on('error', finish);
    worker.on('exit', () => {
      if (job.status === 'running') finish(new Error('処理が中断されました。未完了操作を確認してください。'));
      worker = null;
      onDone();
    });
    return get();
  }
  return { get, start, isBusy: () => worker !== null,
    pending: () => maintenance.pendingId(root) !== null };
}
module.exports = { createJobs };
