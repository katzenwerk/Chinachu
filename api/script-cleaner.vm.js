(function() {
	function booleanValue(value) {
		return value === true || value === 'true' || value === '1';
	}

	function availableRoots() {
		return ledgerCleaner.prepareDestinations(config).configured.map(function(destination) {
			return {
				id: destination.id === null ? 'default' : destination.id,
				name: destination.name,
				path: destination.configuredPath,
				expectedMount: destination.expectedMount
			};
		});
	}

	if (request.method === 'GET') {
		response.head(200);
		response.end(JSON.stringify({
			schemaVersion: 1,
			applyAvailable: true,
			roots: availableRoots(),
			job: ledgerCleanerJobs.get()
		}));
		return;
	}

	if (request.url.match(/^\/api\/cleaner\/apply\.json(?:\?|$)/)) {
		try {
			var applyInput = request.query || {};
			if (!booleanValue(applyInput.confirm) || typeof applyInput.previewId !== 'string') return response.error(400);
			var applyJob = ledgerCleanerJobs.apply(applyInput.previewId);
			response.head(202);
			response.end(JSON.stringify(applyJob));
		} catch (applyError) {
			if (applyError && applyError.statusCode === 409) return response.error(409);
			util.log('LEDGER CLEANER APPLY: ' + (applyError && applyError.stack || applyError));
			return response.error(500);
		}
		return;
	}

	if (!request.url.match(/^\/api\/cleaner\/scan\.json(?:\?|$)/)) return response.error(400);
	try {
		var input = request.query || {};
		var missingPolicy = typeof input.missingPolicy === 'string' ? input.missingPolicy : 'report';
		if (!ledgerCleaner.MISSING_POLICIES.has(missingPolicy)) return response.error(400);
		var selectedIds = Array.isArray(input.selectedIds) ? input.selectedIds.filter(function(id) {
			return typeof id === 'string' && id !== '';
		}) : null;
		var job = ledgerCleanerJobs.start(ledgerCleaner.normalizeOptions({
			checkLocations: input.checkLocations !== false && input.checkLocations !== 'false' && input.checkLocations !== '0',
			normalizeLocations: booleanValue(input.normalizeLocations),
			missingPolicy: missingPolicy,
			cleanupMissed: booleanValue(input.cleanupMissed),
			selectedIds: selectedIds && selectedIds.length ? selectedIds : null
		}));
		response.head(202);
		response.end(JSON.stringify(job));
	} catch (error) {
		if (error && error.statusCode === 409) return response.error(409);
		util.log('LEDGER CLEANER: ' + (error && error.stack || error));
		return response.error(500);
	}
})();
