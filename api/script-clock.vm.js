(function() {
	var serverNow = Date.now();
	var result = {
		serverTimeMs: serverNow,
		timeZone: null,
		timezoneOffsetMinutes: new Date(serverNow).getTimezoneOffset(),
		runtime: {
			chinachuRoot: define.REPOSITORY_ROOT,
			nodeExecutable: define.NODE_EXECUTABLE
		},
		broadcastClock: {
			available: false,
			status: 'unobserved',
			warningActive: false,
			nextAttemptAt: null,
			updatedAt: null,
			lastSuccess: null,
			lastResult: null
		}
	};

	try {
		result.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
	} catch (_) {}

	try {
		var state = JSON.parse(fs.readFileSync(define.BROADCAST_CLOCK_STATE_FILE, 'utf8'));
		if (!state || state.schemaVersion !== 1) throw new Error('invalid state');
		var lastSuccess = state.lastSuccess;
		if (!lastSuccess || (typeof lastSuccess.diffMs !== 'number' && typeof lastSuccess.diffSeconds !== 'number')) {
			lastSuccess = state.lastResult;
		}
		var diffMs = lastSuccess && Number.isFinite(lastSuccess.diffMs)
			? lastSuccess.diffMs
			: lastSuccess && Number.isFinite(lastSuccess.diffSeconds)
				? lastSuccess.diffSeconds * 1000
				: null;
		var observedAt = lastSuccess && Date.parse(lastSuccess.observedAt);
		if (!Number.isFinite(diffMs) || !Number.isFinite(observedAt) ||
			['TDT', 'TOT'].indexOf(lastSuccess.source) === -1 || Number(lastSuccess.sampleCount) < 5) {
			lastSuccess = null;
		}
		result.broadcastClock = {
			available: true,
			status: typeof state.status === 'string' ? state.status : 'unknown',
			warningActive: state.status !== 'disabled' && lastSuccess !== null && (diffMs <= -3000 || diffMs >= 3000),
			nextAttemptAt: state.status !== 'disabled' && Number.isFinite(Number(state.nextAttemptAt)) ? Number(state.nextAttemptAt) : null,
			updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : null,
			lastSuccess: lastSuccess === null ? null : Object.assign({}, lastSuccess, { diffMs: diffMs }),
			lastResult: state.lastResult || null
		};
	} catch (error) {
		if (error.code !== 'ENOENT') result.broadcastClock.status = 'unavailable';
	}

	response.head(200);
	response.end(JSON.stringify(result, null, '  '));
})();
