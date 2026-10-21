(function() {


function getMatchDataFile() {
	if (define.MATCH_DATA_FILE) {
		return define.MATCH_DATA_FILE;
	}

	return './data/match.json';
}

function readMatchItems() {
	var file = getMatchDataFile();
	var json;

	if (!fs.existsSync(file)) {
		return [];
	}

	try {
		json = JSON.parse(fs.readFileSync(file, { encoding: 'utf8' }).replace(/^\uFEFF/, '') || '[]');
	} catch (e) {
		return [];
	}

	return Array.isArray(json) ? json : [];
}

function readOptionalArray(file) {
	var json;
	if (!file || !fs.existsSync(file)) return [];
	try {
		json = JSON.parse(fs.readFileSync(file, { encoding: 'utf8' }).replace(/^\uFEFF/, '') || '[]');
	} catch (e) {
		return [];
	}
	return Array.isArray(json) ? json : [];
}

function findRecordedProgramWithMatchFallback(id) {
	return matchDetailResolver.resolveRecordedProgram(id, readMatchItems(), {
		recorded: data && Array.isArray(data.recorded) ? data.recorded : [],
		reserves2: readOptionalArray(define.RESERVES2_DATA_FILE),
		reserves: data && Array.isArray(data.reserves) ? data.reserves : [],
		schedule: data && Array.isArray(data.schedule) ? data.schedule : []
	});
}

function hasRecordedFile(program) {
	return !!(program && program.recorded && fs.existsSync(program.recorded));
}

function programHasId(value, id) {
	return ['id', 'recordedId', 'origId', 'programId'].some(function(key) {
		return value && value[key] !== undefined && value[key] !== null && String(value[key]) === String(id);
	});
}

function samePath(left, right) {
	return typeof left === 'string' && left !== '' && typeof right === 'string' && right !== '' &&
		path.resolve(left) === path.resolve(right);
}

function findRecordedStorageDestination(program, recordedPath) {
	if (program && (program.recordedDirId || program.recordedDir)) {
		return storageHealth.findDestination(config, program);
	}
	if (!recordedPath) return null;
	var resolved = path.resolve(recordedPath);
	var candidates = storageHealth.getDestinations(config).filter(function(destination) {
		var relative = path.relative(path.resolve(destination.path), resolved);
		return relative !== '' && relative !== '..' && relative.indexOf('..' + path.sep) !== 0 && !path.isAbsolute(relative);
	}).sort(function(left, right) {
		return path.resolve(right.path).length - path.resolve(left.path).length;
	});
	return candidates[0] || null;
}

function targetAlreadyDeleted(item) {
	if (Number(item && item.schemaVersion) === 2) return Boolean(item.deletion);
	var result = item && (item.recordingResult || item.recorded) || {};
	var snapshot = result && result.snapshot || {};
	var legacyProgram = item && item.program || {};
	return [result, snapshot, legacyProgram].some(function(value) {
		return value && (value.cleanupState === 'deleted' || value.deleted === true);
	});
}

function sendDeletionResult(statusCode, result) {
	response.setHeader('Content-Type', 'application/json; charset=utf-8');
	response.head(statusCode);
	response.end(JSON.stringify(result));
}

function discardThumbnailGeneration(id) {
	if (typeof storageRefreshIpc === 'undefined' || !storageRefreshIpc ||
		typeof storageRefreshIpc.request !== 'function' || !define.RECORDED_THUMBNAIL_SOCKET) return;
	storageRefreshIpc.request({
		socketPath: define.RECORDED_THUMBNAIL_SOCKET,
		timeoutMs: 5000
		}, { id: String(id), action: 'cancel' }).catch(function(error) {
		util.log('WARNING: Recording was deleted but thumbnail generation cancellation failed: ' + id +
			' (' + (error && error.message || error) + ')');
	});
}

function deletionFailure(code, message, statusCode, result) {
	var error = new Error(message);
	error.code = code;
	error.statusCode = statusCode;
	error.deletionResult = result;
	return error;
}

function deleteRecordedProgram(id) {
	var result = {
		status: 'failed',
		code: null,
		fileDeleted: false,
		matchUpdated: false,
		recordedUpdated: false,
		thumbnail: { status: 'retained', reason: null }
	};
	var recordedFile = define.RECORDED_DATA_FILE;
	var matchFile = getMatchDataFile();
	var recordedPath = '';
	var storageDestination = null;

	try {
		reservationStore.withLock(recordedFile, function() {
			var recordedItems = reservationStore.readArray(recordedFile);
			var recordedTargets = recordedItems.filter(function(value) { return programHasId(value, id); });
			if (recordedTargets.length !== 1) {
				throw deletionFailure(recordedTargets.length > 1 ? 'ambiguous-recorded-target' : 'recorded-target-not-found',
					recordedTargets.length > 1 ? '録画台帳の対象が複数あるため削除を中止しました。' : '現在の録画台帳に削除対象がありません。',
					409, result);
			}

			var current = recordedTargets[0];
			recordedPath = typeof current.recorded === 'string' && current.recorded ? current.recorded : '';
			storageDestination = findRecordedStorageDestination(current, recordedPath);
			if (!recordedPath || !programHasId(program, id) || !samePath(recordedPath, program && program.recorded)) {
				throw deletionFailure('invalid-recorded-path', '録画台帳の保存先が不正なため削除を中止しました。', 409, result);
			}
			if ((Array.isArray(data.recording) ? data.recording : []).some(function(value) {
				return programHasId(value, id) || samePath(value && value.recorded, recordedPath);
			})) {
				throw deletionFailure('recording-active', '現在録画中のファイルは削除できません。', 409, result);
			}
			if (!fs.existsSync(recordedPath)) {
				throw deletionFailure('recorded-file-missing', '録画ファイルが見つからないため削除を実行していません。', 410, result);
			}
			var stat = fs.statSync(recordedPath);
			if (stat && typeof stat.isFile === 'function' && !stat.isFile()) {
				throw deletionFailure('recorded-path-not-file', '録画保存先が通常ファイルではないため削除を中止しました。', 409, result);
			}

			reservationStore.withLock(matchFile, function() {
				var matchItems = reservationStore.readArray(matchFile);
				var targets = matchDeletionHistory.findTargets(matchItems, {
					recordedEntries: [current],
					requestedId: id,
					path: recordedPath
				});
				if (targets.length !== 1) {
					throw deletionFailure(targets.length > 1 ? 'ambiguous-target' : 'target-not-found',
						targets.length > 1 ? '対応する録画履歴が複数あるため削除を中止しました。' : '対応する録画履歴がないため削除を中止しました。',
						409, result);
				}
				if (targetAlreadyDeleted(targets[0])) {
					throw deletionFailure('already-deleted', '録画履歴は既に削除済みです。', 409, result);
				}

				try {
					fs.unlinkSync(recordedPath);
					result.fileDeleted = true;
				} catch (error) {
					throw deletionFailure('file-delete-failed', '録画ファイルを削除できませんでした。', 500, result);
				}

				var outcome = matchDeletionHistory.markDeleted(matchItems, {
					recordedEntries: [current],
					requestedId: id,
					path: recordedPath,
					deletedAt: Date.now(),
					reason: 'manual'
				});
				if (!outcome.changed) {
					throw deletionFailure('match-update-conflict', '録画ファイルは削除されましたが、録画履歴を更新できませんでした。', 500, result);
				}
				try {
					reservationStore.writeArrayAtomic(matchFile, matchItems);
					result.matchUpdated = true;
				} catch (error) {
					throw deletionFailure('match-update-failed', '録画ファイルは削除されましたが、録画履歴の保存に失敗しました。再削除しないでください。', 500, result);
				}

				var remaining = recordedItems.filter(function(value) { return value !== current; });
				try {
					reservationStore.writeArrayAtomic(recordedFile, remaining);
					result.recordedUpdated = true;
				} catch (error) {
					throw deletionFailure('recorded-update-failed', '録画ファイルと履歴は削除済みですが、録画台帳の更新に失敗しました。再削除しないでください。', 500, result);
				}
			});
		});
	} catch (error) {
		result = error.deletionResult || result;
		result.status = result.fileDeleted ? 'partial' : 'failed';
		result.code = error.code || 'delete-failed';
		result.message = error.message || '録画を削除できませんでした。';
		if (result.fileDeleted) {
			util.log('ERROR: RECORDED DELETE PARTIAL id=' + id + ' fileDeleted=' + result.fileDeleted +
				' matchUpdated=' + result.matchUpdated + ' recordedUpdated=' + result.recordedUpdated +
				' path=' + (recordedPath || '') + ' error=' + result.code);
		}
		return { statusCode: error.statusCode || 500, result: result };
	}

	discardThumbnailGeneration(id);
	result.status = 'complete';
	result.code = null;
	result.storageRefresh = storageDestination ? {
		targetKnown: true,
		storageId: storageDestination.id || null
	} : {
		targetKnown: false,
		storageId: null
	};
	result.message = '録画ファイルを削除しました。サムネイルは履歴整理まで保持します。';
	return { statusCode: 200, result: result };
}

	var found = findRecordedProgramWithMatchFallback(request.param.id);
	var program = found.program;

	if (program === null) return response.error(404);

	program.isRemoved = !hasRecordedFile(program);
	program._recordedSource = found.source;

	switch (request.method) {
		case 'GET':
			response.head(200);
			response.end(JSON.stringify(program, null, '  '));
			return;

		case 'DELETE':
			var deletion = deleteRecordedProgram(request.param.id);
			sendDeletionResult(deletion.statusCode, deletion.result);
			return;
	}

})();
