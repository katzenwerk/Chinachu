'use strict';

const { parentPort, workerData } = require('worker_threads');
const preflight = require('./operator-scheduler-preflight');
const { SchedulerStateStore } = require('./scheduler-state');

const pending = new Map();
parentPort.on('message', message => {
	const request = pending.get(message.name);
	if (!request) return;
	pending.delete(message.name);
	if (message.error) request.reject(new Error(message.error));
	else request.resolve(message.value);
});
function fetch(name) {
	return new Promise((resolve, reject) => {
		pending.set(name, { resolve, reject });
		parentPort.postMessage({ type: 'fetch', name });
	});
}
function identities() {
	return Object.fromEntries(Object.entries(workerData.paths).map(([name, filename]) => {
		try { return [name, preflight.fileIdentity(filename)]; } catch (_) { return [name, null]; }
	}));
}

const before = identities();
const checker = new preflight.OperatorSchedulerPreflight({
	paths: workerData.paths,
	stateStore: new SchedulerStateStore(workerData.paths.state, { legacyFilePath: workerData.legacyStatePath }),
	fetchJobs: () => fetch('jobs'), fetchServices: () => fetch('services'), fetchTuners: () => fetch('tuners'),
	maxStalenessMs: workerData.maxStalenessMs,
	now: () => workerData.now
});
checker.check().then(value => {
	const after = identities();
	const changed = Object.keys(before).filter(name => !preflight.sameFileIdentity(before[name], after[name]));
	parentPort.postMessage({ type: 'result', value, identities: after, changed });
}).catch(error => parentPort.postMessage({ type: 'failed', error: error.message }))
	.finally(() => parentPort.close());
