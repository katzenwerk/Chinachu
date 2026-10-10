'use strict';

const { StorageMonitor } = require('./storage-monitor');

function createSingleFlight(operation) {
	let active = false;
	return function run(request) {
		if (active) {
			const error = new Error('容量情報の更新がすでに実行中です。');
			error.code = 'refresh_busy';
			error.statusCode = 409;
			error.publicMessage = error.message;
			return Promise.reject(error);
		}
		active = true;
		return Promise.resolve().then(() => operation(request)).finally(() => {
			active = false;
		});
	};
}

function collect(destinations, options) {
	options = options || {};
	const monitor = new StorageMonitor({
		inspect: options.inspect,
		checkIntervalMs: options.checkIntervalMs || 20000,
		inspectOptions: options.inspectOptions || {}
	});
	const failures = [];
	destinations.forEach(destination => {
		try {
			const result = monitor.check(destination, { now: options.now ? options.now() : Date.now(), force: true });
			if (!result || !result.filesystemKey || !result.capacityCheckedAt) {
				failures.push({
					id: destination.id || null,
					name: destination.name,
					status: result && result.status || 'unknown',
					message: result && result.detail || '容量情報を取得できませんでした。'
				});
			}
		} catch (error) {
			failures.push({
				id: destination.id || null,
				name: destination.name,
				status: 'unknown',
				message: error.message
			});
		}
	});
	const failedIds = new Set(failures.map(item => item.id || null));
	const states = monitor.getDestinationStates().filter(state =>
		state.capacityReliable === true && !failedIds.has(state.id || null)
	).map(state => Object.assign({}, state, {
		// A manual observation is display data, never an operational recording decision.
		stopNewRecordings: false
	}));
	return {
		states: states,
		failures: failures,
		groups: monitor.toJSON()
	};
}

module.exports = {
	collect: collect,
	createSingleFlight: createSingleFlight
};
