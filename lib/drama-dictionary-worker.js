'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { runSource, snapshot } = require('./drama-dictionary');
const { openStore } = require('./drama-store');

const abort = new AbortController();
parentPort.on('message', message => {
	if (message === 'cancel') abort.abort();
});

(async () => {
	try {
		if (workerData.source) {
			const result = await runSource(workerData.source, { ...workerData.options, signal: abort.signal,
				notify: progress => parentPort.postMessage({ progress }) });
			parentPort.postMessage({ snapshot: result });
		} else {
			const store = openStore(workerData.options.database, true);
			try { parentPort.postMessage({ snapshot: snapshot(store) }); } finally { store.close(); }
		}
	} catch (error) {
		parentPort.postMessage({ error: error.message });
	} finally {
		parentPort.close();
	}
})();
