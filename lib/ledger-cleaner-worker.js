'use strict';

const { parentPort, workerData } = require('worker_threads');
const cleaner = require('./ledger-cleaner');

try {
	let result;
	if (workerData.action === 'apply') {
		parentPort.postMessage({ type: 'progress', progress: { phase: 'revalidating', files: 0, visitedDirectories: 0 } });
		result = cleaner.applyPlan(workerData.rootDir, workerData.plan);
	} else {
		const ledgers = cleaner.loadLedgers(workerData.rootDir);
		result = cleaner.buildPlan(Object.assign({}, ledgers, workerData.request, {
			onProgress(progress) {
				parentPort.postMessage({ type: 'progress', progress });
			}
		}));
	}
	parentPort.postMessage({ type: 'result', result });
} catch (error) {
	parentPort.postMessage({
		type: 'error',
		error: { message: error.message, code: error.code || null }
	});
}
