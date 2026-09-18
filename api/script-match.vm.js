(function () {
	'use strict';

	var file = './data/match.json';
	var mode = request.query && request.query.mode || '';
	var isSummary = mode === 'summary';
	var isItem = mode === 'item';
	var isList = mode === 'list';
	var limit = 16;
	var items;
	var now = Date.now();

	function getMatchProgram(item) {
		return item && (item.program || item.recorded || item.reserve) || {};
	}

	function getRecordingResult(item) {
		return item && (item.recordingResult || item.recorded) || {};
	}

	function getMatchEnd(item) {
		var program = getMatchProgram(item);
		var start = Number(program.start || 0);
		var seconds = Number(program.seconds || 0);

		return Number(program.end || 0) || (start + (seconds * 1000));
	}

	function isPastMatch(item) {
		var end = getMatchEnd(item);

		return end > 0 && now > end;
	}

	function toFiniteNumber(value) {
		var number = Number(value);

		return isFinite(number) ? number : 0;
	}

	function isDeletedMatchItem(item) {
		var result = getRecordingResult(item);
		var program = getMatchProgram(item);

		return (result && (result.cleanupState === 'deleted' || result.deleted === true)) ||
			(program && (program.cleanupState === 'deleted' || program.deleted === true));
	}

	function isMissingMatchItem(item) {
		var result = getRecordingResult(item);
		var program = getMatchProgram(item);

		return (result && (result.cleanupState === 'missing' || result.fileExists === false)) ||
			(program && (program.cleanupState === 'missing' || program.fileExists === false));
	}

	function isDeletedOrMissingMatchItem(item) {
		return isDeletedMatchItem(item) || isMissingMatchItem(item);
	}

	function hasRecordedResult(item) {
		var result = getRecordingResult(item);
		var program = getMatchProgram(item);
		var path = result && (result.path || result.recorded) || program && program.recorded || '';
		var actualSeconds = toFiniteNumber(result && result.operatorActualSeconds || program && program.operatorActualSeconds);

		if (isDeletedOrMissingMatchItem(item)) {
			return false;
		}

		return !!path || actualSeconds > 0 || item.status === 'RECORDED' || item.status === 'RECORDED_UNTRACKED';
	}

	function getMatchKind(item) {
		if (hasRecordedResult(item)) {
			if (!isPastMatch(item)) {
				return null;
			}

			return isDeletedOrMissingMatchItem(item) ? 'DELETED' : 'RECORDED';
		}

		if (item.status === 'RECORDED') {
			if (!isPastMatch(item)) {
				return null;
			}

			return isDeletedOrMissingMatchItem(item) ? 'DELETED' : 'RECORDED';
		}

		if (item.status === 'SKIPPED_ONLY' || (item.recd_flg && item.recd_flg.isSkip === true)) {
			return isPastMatch(item) ? 'SKIPPED' : null;
		}

		if (item.status === 'MISSED') {
			return isPastMatch(item) ? 'NG' : null;
		}

		if (!isPastMatch(item)) {
			return null;
		}

		if (item.recd_flg &&
				item.recd_flg.hasReserve === true &&
				item.recd_flg.hasRecorded === false &&
				item.recd_flg.isSkip === false) {
			return 'NG';
		}

		if (item.status && item.status !== 'RESERVED') {
			return 'NG';
		}

		return null;
	}

	function matchItemHasId(item, id) {
		var program = getMatchProgram(item);
		var result = getRecordingResult(item);
		var candidates = [
			program.id,
			program.origId,
			program.programId,
			result.id,
			result.recordedId,
			result.origId,
			result.programId
		];
		var i;

		if (!id) {
			return false;
		}

		for (i = 0; i < candidates.length; i++) {
			if (typeof candidates[i] !== 'undefined' && candidates[i] !== null && String(candidates[i]) === id) {
				return true;
			}
		}

		return false;
	}

	function makeRecordedIndexes() {
		var recorded = data && Array.isArray(data.recorded) ? data.recorded : [];
		var byId = {};
		var bySignature = {};

		recorded.forEach(function (program) {
			var channel = program && program.channel || {};
			var id = program && program.id;
			var start = Number(program && program.start || 0);
			var seconds = Number(program && program.seconds || 0);
			var channelId = channel.id || '';
			var signature;

			if (typeof id !== 'undefined' && id !== null && id !== '') {
				byId[String(id)] = program;
			}

			if (start > 0 && channelId) {
				signature = [start, seconds, channelId].join('|');
				bySignature[signature] = program;
			}
		});

		return {
			byId: byId,
			bySignature: bySignature
		};
	}

	function findRecordedProgram(item, indexes) {
		var program = getMatchProgram(item);
		var result = getRecordingResult(item);
		var id = result.id || result.recordedId || result.origId || program.id || program.origId || null;
		var start = Number(result.start || program.start || 0);
		var seconds = Number(result.seconds || program.seconds || 0);
		var channel = result.channel || program.channel || item.channel || {};
		var signature;

		if (id && indexes.byId[String(id)]) {
			return indexes.byId[String(id)];
		}

		if (start > 0 && channel.id) {
			signature = [start, seconds, channel.id].join('|');
			if (indexes.bySignature[signature]) {
				return indexes.bySignature[signature];
			}
		}

		return null;
	}

	function pickOperatorValue(source, result, key, fallback) {
		if (source && typeof source[key] !== 'undefined' && source[key] !== null && source[key] !== '') {
			return source[key];
		}

		if (result && typeof result[key] !== 'undefined' && result[key] !== null && result[key] !== '') {
			return result[key];
		}

		if (fallback && typeof fallback[key] !== 'undefined' && fallback[key] !== null && fallback[key] !== '') {
			return fallback[key];
		}

		return 0;
	}

	function getMirakurunDropTotal(drop) {
		var total;
		var pidMap;

		if (!drop || typeof drop !== 'object') {
			return null;
		}

		if (typeof drop.dropTotal !== 'undefined' && drop.dropTotal !== null && drop.dropTotal !== '') {
			total = Number(drop.dropTotal);
			return isFinite(total) ? total : null;
		}

		if (Array.isArray(drop.pids)) {
			total = 0;
			drop.pids.forEach(function (pid) {
				total += Number(pid && pid.drop || 0) || 0;
			});
			return total;
		}

		pidMap = drop.pidDrops || drop.dropsByPid || drop.dropPids;
		if (pidMap && typeof pidMap === 'object') {
			total = 0;
			Object.keys(pidMap).forEach(function (pid) {
				total += Number(pidMap[pid]) || 0;
			});
			return total;
		}

		return null;
	}

	function compactMirakurunDrop(source, result, fallback) {
		var drop = null;
		var total;

		if (source && source.mirakurunDrop && typeof source.mirakurunDrop === 'object') {
			drop = source.mirakurunDrop;
		} else if (result && result.mirakurunDrop && typeof result.mirakurunDrop === 'object') {
			drop = result.mirakurunDrop;
		} else if (fallback && fallback.mirakurunDrop && typeof fallback.mirakurunDrop === 'object') {
			drop = fallback.mirakurunDrop;
		}

		if (!drop) {
			return null;
		}

		total = getMirakurunDropTotal(drop);

		return {
			dropTotal: total,
			packetTotal: drop.packetTotal,
			tunerName: drop.tunerName,
			checkedAt: drop.checkedAt
		};
	}

	function buildListItem(item, kind, indexes) {
		var source = getMatchProgram(item);
		var result = getRecordingResult(item);
		var recordedProgram = kind === 'RECORDED' ? findRecordedProgram(item, indexes) : null;
		var channel = item.channel || source.channel || result.channel || {};
		var end = getMatchEnd(item);
		var id = source.id || source.origId || source.programId || result.id || result.recordedId || result.origId || null;
		var recordedId = result.id || result.recordedId || result.origId || (recordedProgram && recordedProgram.id) || null;
		var seconds = Number(source.seconds || result.seconds || 0);

		if (!seconds && source.start && end) {
			seconds = Math.floor((end - Number(source.start)) / 1000);
		}

		return {
			_listSlim: true,
			_matchItem: {
				key: item.key || ''
			},
			_matchKind: kind,
			id: id,
			_recordedId: recordedId,
			start: Number(source.start || result.start || 0),
			seconds: seconds,
			operatorRecordingStart: pickOperatorValue(source, result, 'operatorRecordingStart', recordedProgram),
			operatorRecordingEnd: pickOperatorValue(source, result, 'operatorRecordingEnd', recordedProgram),
			operatorActualSeconds: pickOperatorValue(source, result, 'operatorActualSeconds', recordedProgram),
			recordedDurationSeconds: pickOperatorValue(source, result, 'recordedDurationSeconds', recordedProgram),
			operatorAbort: source.operatorAbort === true || result.operatorAbort === true || !!(recordedProgram && recordedProgram.operatorAbort === true),
			operatorEndLack: source.operatorEndLack === true || result.operatorEndLack === true || !!(recordedProgram && recordedProgram.operatorEndLack === true),
			mirakurunDrop: compactMirakurunDrop(source, result, recordedProgram),
			title: source.title || result.title || '-',
			fullTitle: source.fullTitle || source.title || result.fullTitle || result.title || '-',
			detail: source.detail || result.detail || result.description || '',
			flags: Array.isArray(source.flags) ? source.flags : [],
			subTitle: source.subTitle,
			episode: source.episode,
			channel: {
				id: channel.id || '-',
				name: channel.name || '-',
				type: channel.type || '-'
			},
			isManualReserved: source.isManualReserved === true
		};
	}

	if (isSummary && request.query && typeof request.query.limit !== 'undefined') {
		limit = parseInt(request.query.limit, 10);
		if (isNaN(limit)) {
			limit = 16;
		}
		limit = Math.max(0, Math.min(limit, 16));
	}

	if (!fs.existsSync(file)) {
		if (isSummary) {
			response.head(200);
			response.end(JSON.stringify({
				counts: { recorded: 0, ng: 0 },
				items: [],
				hasMore: false
			}));
			return;
		}

		if (isList || mode === '') {
			response.head(200);
			response.end('[]');
			return;
		}

		if (isItem) {
			response.error(404);
			return;
		}

		response.error(400);
		return;
	}

	if (mode === '') {
		response.head(200);
		response.end(fs.readFileSync(file, { encoding: 'utf8' }));
		return;
	}

	if (!isSummary && !isItem && !isList) {
		response.error(400);
		return;
	}

	try {
		if (typeof matchCache !== 'undefined' && matchCache && typeof matchCache.getItems === 'function') {
			items = matchCache.getItems();
		} else {
			// 旧 app-wui.js との一時的な組み合わせでも動作できるよう、従来読み込みをfallbackとして残す。
			items = JSON.parse(fs.readFileSync(file, { encoding: 'utf8' }).replace(/^\uFEFF/, '') || '[]');
		}
	} catch (e) {
		response.error(500);
		return;
	}

	if (!Array.isArray(items)) {
		response.error(500);
		return;
	}

	if (isItem) {
		var requestedKey = request.query && request.query.key ? String(request.query.key) : '';
		var requestedId = request.query && request.query.id ? String(request.query.id) : '';
		var found = null;
		var i;

		try {
			requestedKey = decodeURIComponent(requestedKey);
		} catch (e) {}

		try {
			requestedId = decodeURIComponent(requestedId);
		} catch (e) {}

		if (!requestedKey && !requestedId) {
			response.error(400);
			return;
		}

		for (i = 0; i < items.length; i++) {
			if (requestedKey && items[i] && items[i].key === requestedKey) {
				found = items[i];
				break;
			}
		}

		if (!found && requestedId) {
			for (i = 0; i < items.length; i++) {
				if (matchItemHasId(items[i] || {}, requestedId)) {
					found = items[i];
					break;
				}
			}
		}

		if (!found) {
			response.error(404);
			return;
		}

		response.head(200);
		response.end(JSON.stringify(found));
		return;
	}

	if (isList) {
		var indexes = makeRecordedIndexes();
		var listItems = [];

		items.forEach(function (item) {
			var kind = getMatchKind(item || {});

			if (kind === null) {
				return;
			}

			listItems.push(buildListItem(item, kind, indexes));
		});

		response.head(200);
		response.end(JSON.stringify(listItems));
		return;
	}

	var counts = { recorded: 0, ng: 0 };
	var history = [];

	items.forEach(function (item) {
		var program = getMatchProgram(item);
		var start = Number(program.start || 0);
		var seconds = Number(program.seconds || 0);
		var end = Number(program.end || 0) || (start + (seconds * 1000));

		if (end <= 0 || now <= end) {
			return;
		}

		if (item.status === 'RECORDED') {
			counts.recorded++;
		} else if (item.status === 'MISSED') {
			counts.ng++;
		} else {
			return;
		}

		if (limit > 0) {
			history.push(item);
		}
	});

	if (limit > 0) {
		history.sort(function (a, b) {
			var pa = getMatchProgram(a);
			var pb = getMatchProgram(b);
			return Number(pb.start || 0) - Number(pa.start || 0);
		});
		history = history.slice(0, limit).map(function (item) {
			var program = getMatchProgram(item);
			var channel = item.channel || program.channel || {};

			return {
				key: item.key,
				status: item.status,
				channel: {
					id: channel.id || '-',
					name: channel.name || '-',
					type: channel.type || '-'
				},
				program: {
					start: program.start || 0,
					end: program.end || 0,
					seconds: program.seconds || 0,
					title: program.title || '-',
					fullTitle: program.fullTitle || program.title || '-',
					detail: program.detail || '',
					flags: Array.isArray(program.flags) ? program.flags : [],
					episode: program.episode,
					category: program.category || 'etc'
				}
			};
		});
	}

	response.head(200);
	response.end(JSON.stringify({
		counts: counts,
		items: history,
		hasMore: (counts.recorded + counts.ng) > history.length
	}));
}());
