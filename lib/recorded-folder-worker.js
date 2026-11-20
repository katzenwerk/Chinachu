'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const maintenance = require('./recorded-folder-maintenance');
(async () => {
  const { root, action, requestId } = workerData;
  const paths = maintenance.locations(root);
  if (action !== 'run') throw new Error('Unknown folder operation');
  const input = maintenance.readOptional(paths.request);
  if (!input || input.id !== requestId) throw maintenance.conflict('振り分けの開始情報が変わりました。もう一度実行してください。');
  const progress = value => parentPort.postMessage({ progress: value });
  const result = await maintenance.run(root, input.series, progress);
  maintenance.persist(paths.result, result);
  parentPort.postMessage({ result });
})().catch(error => parentPort.postMessage({ error: { message: error.publicMessage || error.message, statusCode: error.statusCode || 500 } }));
