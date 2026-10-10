(function() {
	switch (request.method) {
		case 'GET':
			var storageThresholds = storageLow.resolveStorageThresholds(config);
			var warningEnabled = storageThresholds.warningEnabled;
			var action = storageLow.normalizeAction(config.storageLowSpaceAction);
			var cleanupThresholdMB = storageThresholds.cleanupThresholdMB;
			var warningThresholdMB = storageThresholds.warningThresholdMB;
			var configured = storageHealth.getDestinations(config);
			var runtimeState = storageRuntimeState.readCompatibleSnapshot(fs, define.STORAGE_STATE_FILE, {
				action: action,
				cleanupMB: cleanupThresholdMB,
				warningMB: warningThresholdMB,
				warningEnabled: warningEnabled
			});

			var observedByToken = {};
			if (runtimeState) {
				runtimeState.storages.forEach(function (storage) {
					var destination = configured.find(function (item) {
						return storageRuntimeState.matchesDestination(storage, item);
					});
					if (!destination) return;
					var token = storage.id ? 'id:' + storage.id : 'path:' + path.resolve(storage.path || storage.configuredPath || '');
					observedByToken[token] = storage;
				});
			}

			var currentWindowMs = 30000;
			var now = Date.now();
			var storageUsage = configured.map(function (destination) {
				var token = destination.id ? 'id:' + destination.id : 'path:' + path.resolve(destination.path);
				var observed = observedByToken[token];
				var storage = observed ? Object.assign({}, observed) : {
					id: destination.id || null,
					name: destination.name,
					path: destination.path,
					configuredPath: destination.configuredPath,
					expectedMount: destination.expectedMount,
					status: 'unobserved',
					detail: 'Capacity has not been checked by an Operator storage event.',
					capacityReliable: false,
					capacityCheckedAt: null,
					total: null,
					used: null,
					available: null,
					lowSpacePhase: null,
					stopNewRecordings: false
				};
				storage.id = destination.id || null;
				storage.name = destination.name;
				storage.path = destination.path;
				storage.configuredPath = destination.configuredPath;
				storage.expectedMount = destination.expectedMount;
				storage.lowStorageManaged = true;
				storage.recorded = null;
				storage.capacityStale = !storage.capacityCheckedAt || now - storage.capacityCheckedAt > currentWindowMs;
				storage.observedStatus = storage.status;
				storage.observedLowSpacePhase = storage.lowSpacePhase || null;
				storage.lowSpaceCurrent = storage.status === 'low-space' && !storage.capacityStale;
				if (storage.capacityStale && storage.capacityCheckedAt) {
					storage.status = 'stale';
					storage.lowSpacePhase = null;
					storage.stopNewRecordings = false;
				}
				if (!storage.capacityCheckedAt && storage.identityCheckedAt && now - storage.identityCheckedAt > currentWindowMs &&
					storage.status !== 'unobserved') {
					storage.status = 'stale';
					storage.stopNewRecordings = false;
				}
				return storage;
			});

			var defaultStorage = storageUsage.find(function (storage) {
				return storage.id === null;
			}) || storageUsage[0] || {};
			var result = {
				schemaVersion: 3,
				storages: storageUsage,
				thresholds: {
					warningEnabled: warningEnabled,
					warningMB: warningThresholdMB,
					cleanupMB: cleanupThresholdMB,
					action: action,
					configuredAction: typeof config.storageLowSpaceAction === 'string' ? config.storageLowSpaceAction : null,
					warningIntervalMinutes: storageLow.resolvePositiveNumber(config.storageLowSpaceWarningIntervalMinutes, 180),
					criticalIntervalMinutes: storageLow.resolvePositiveNumber(config.storageLowSpaceCriticalNotifyIntervalMinutes, 180)
				},
				// File totals are intentionally not recomputed here: doing so would wake every recording filesystem.
				recorded: null,
				size: defaultStorage.total === undefined ? null : defaultStorage.total,
				used: defaultStorage.used === undefined ? null : defaultStorage.used,
				avail: defaultStorage.available === undefined ? null : defaultStorage.available
			};

			response.head(200);
			response.end(JSON.stringify(result, null, '  '));
			return;

		case 'POST':
			var refreshRequest = request.query || {};
			storageRefreshIpc.request({
				socketPath: define.STORAGE_REFRESH_SOCKET,
				timeoutMs: 120000
			}, refreshRequest).then(function (result) {
				response.head(200);
				response.end(JSON.stringify(result, null, '  '));
			}).catch(function (error) {
				var statusCode = Number(error && error.statusCode);
				if (!statusCode || statusCode < 400 || statusCode > 599) statusCode = 500;
				response.head(statusCode);
				response.end(JSON.stringify({
					error: error && error.code || 'refresh_failed',
					message: error && error.publicMessage || '容量情報を更新できませんでした。'
				}, null, '  '));
			});
			return;
	}
})();
