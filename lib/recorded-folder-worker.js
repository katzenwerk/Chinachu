'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const maintenance = require('./recorded-folder-maintenance');
(async () => {
  const { root, action } = workerData;
  const paths = maintenance.locations(root);
  const progress = value => parentPort.postMessage({ progress: value });
  let result;
  if (action === 'evaluate') {
    result = await maintenance.evaluate(root, workerData.options, workerData.series, progress);
    maintenance.persist(paths.preview, result);
  } else if (action === 'apply') {
    const preview = maintenance.readOptional(paths.preview);
    if (!preview || preview.id !== workerData.previewId) throw maintenance.conflict('評価結果が更新されました。再評価してください。');
    result = await maintenance.apply(root, preview, progress);
    maintenance.persist(paths.result, result);
  } else if (action === 'recover') {
    result = await maintenance.recover(root);
    maintenance.persist(paths.result, result);
  } else throw new Error('Unknown folder operation');
  parentPort.postMessage({ result });
})().catch(error => parentPort.postMessage({ error: { message: error.publicMessage || error.message, statusCode: error.statusCode || 500 } }));
