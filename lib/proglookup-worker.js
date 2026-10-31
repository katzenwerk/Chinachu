'use strict';

const { parentPort, workerData } = require('worker_threads');
try {
	if (workerData.action === 'parse') {
		parentPort.postMessage({ value: require('./proglookup-updater').parseProgLookupXml(workerData.payload) });
	} else {
		const store = require('./proglookup-store').createProgLookupStore({ path: workerData.path });
		const state = store.getStateSnapshot();
		if (state.loadError) throw new Error('ProgLookup cache cannot be read: ' + state.loadError);
		let value;
		if (workerData.action === 'apply') {
			workerData.payload.items = require('./proglookup-updater').uniquePrograms(workerData.payload.items);
			value = Object.assign(store.applyUpdate(workerData.payload), { itemCount: workerData.payload.items.length });
		} else if (workerData.action === 'request') store.recordRequest(workerData.payload.kind, workerData.payload.at);
		else if (workerData.action === 'failure') store.recordFailure(workerData.payload.error, workerData.payload.nextAt);
		else if (workerData.action !== 'load') throw new Error('unknown ProgLookup worker action');
		const next = store.getStateSnapshot();
		parentPort.postMessage(workerData.action === 'load' || workerData.action === 'apply' ?
			{ value, document: store.exportDocument() } : { value, state: next.state, generation: next.generation });
	}
} catch (error) {
	parentPort.postMessage({ error: { message: error.message, code: error.code, resultCode: error.resultCode } });
}
parentPort.close();
