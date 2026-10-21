var runtime = typeof wuiRuntime !== 'undefined' ? wuiRuntime : data.status.__nextWuiRuntime;
if (!runtime) {
	runtime = {
		instanceId: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
		startedAt: Date.now()
	};
	Object.defineProperty(data.status, '__nextWuiRuntime', {
		value: runtime,
		enumerable: false,
		configurable: false,
		writable: false
	});
}

response.head(200);
response.end(JSON.stringify({
	schemaVersion: 1,
	instanceId: runtime.instanceId,
	startedAt: runtime.startedAt,
	checkedAt: Date.now()
}));
