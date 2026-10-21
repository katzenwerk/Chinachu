(function () {
	'use strict';

	var file = './data/match.json';
	var mode = request.query && request.query.mode || '';
	var isSummary = mode === 'summary';
	var isItem = mode === 'item';
	var isList = mode === 'list';
	var isPage = mode === 'page';
	var isRuleRecordingCounts = mode === 'rule-recording-counts';
	var isResultCounts = mode === 'result-counts';
	var shouldResolve = request.query && String(request.query.resolve || '') === '1';
	var strictItemLookup = request.query && String(request.query.strict || '') === '1';
	var limit = 16;
	var items;
	var detailResolver = null;

	function addCandidate(candidates, value) {
		if (typeof value === 'undefined' || value === null || String(value) === '') return;
		value = String(value);
		if (candidates.indexOf(value) === -1) candidates.push(value);
	}

	function matchItemHasId(item, id) {
		var program = item && (item.program || item.reserve) || {};
		var result = item && (item.recordingResult || item.recorded) || {};
		var snapshot = result && result.snapshot || {};
		var recording = item && item.recording || {};
		var candidates = [];

		addCandidate(candidates, recording.recordedId);
		[program, result, snapshot].forEach(function(value) {
			addCandidate(candidates, value && value.id);
			addCandidate(candidates, value && value.recordedId);
			addCandidate(candidates, value && value.origId);
			addCandidate(candidates, value && value.programId);
		});
		return !!id && candidates.indexOf(String(id)) !== -1;
	}

	function readOptionalArray(filePath) {
		var value;
		if (!filePath || !fs.existsSync(filePath)) return [];
		try {
			value = JSON.parse(fs.readFileSync(filePath, { encoding: 'utf8' }).replace(/^\uFEFF/, '') || '[]');
		} catch (e) {
			return [];
		}
		return Array.isArray(value) ? value : [];
	}

	function getDetailResolver() {
		if (detailResolver !== null) return detailResolver;
		if (typeof matchDetailResolver === 'undefined' || !matchDetailResolver ||
				typeof matchDetailResolver.createDetailResolver !== 'function') return null;
		var reserves2Source = Number(matchDetailResolver.PAGE_FILTER_VERSION) >= 2 ?
			function() { return readOptionalArray(define.RESERVES2_DATA_FILE); } :
			readOptionalArray(define.RESERVES2_DATA_FILE);
		detailResolver = matchDetailResolver.createDetailResolver({
			recorded: data && Array.isArray(data.recorded) ? data.recorded : [],
			reserves2: reserves2Source,
			reserves: data && Array.isArray(data.reserves) ? data.reserves : [],
			schedule: data && Array.isArray(data.schedule) ? data.schedule : []
		});
		return detailResolver;
	}

	function buildResultCounts(items) {
		if (typeof matchDetailResolver.buildResultCounts === 'function') {
			return matchDetailResolver.buildResultCounts(items, { now: Date.now() });
		}
		var counts = { recorded: 0, deleted: 0, missed: 0, skipped: 0 };
		var now = Date.now();
		items.forEach(function(entry) {
			var normalized = matchDetailResolver.normalizeMatchEntry(entry || {});
			if (!normalized.end || now <= normalized.end || normalized.status === 'RESERVED') return;
			if (normalized.status === 'MISSED') counts.missed++;
			else if (normalized.status === 'SKIPPED_ONLY') counts.skipped++;
			else if (normalized.status === 'RECORDED' || normalized.status === 'RECORDED_UNTRACKED') {
				if (normalized.deletion && normalized.deletion.reason !== 'recorded-missing') counts.deleted++;
				else counts.recorded++;
			}
		});
		return counts;
	}

	function buildRuleRecordingCounts(items, resolver) {
		if (typeof matchDetailResolver.buildRuleRecordingCounts === 'function') {
			return matchDetailResolver.buildRuleRecordingCounts(items, resolver, { now: Date.now() });
		}

		// Keep the VM script usable until a later WUI restart refreshes the required module cache.
		var counts = {};
		var seenKeys = {};
		var counted = 0;
		var withoutRuleUid = 0;
		var now = Date.now();
		items.forEach(function(entry, index) {
			var normalized = matchDetailResolver.normalizeMatchEntry(entry || {});
			if (normalized.status !== 'RECORDED' && normalized.status !== 'RECORDED_UNTRACKED') return;
			if (!normalized.end || now <= normalized.end) return;
			var key = normalized.key || 'item-' + index;
			if (seenKeys[key]) return;
			seenKeys[key] = true;
			var resolved = resolver.resolve(entry || {});
			var ruleUid = resolved && resolved.program && resolved.program.ruleUid;
			ruleUid = typeof ruleUid === 'undefined' || ruleUid === null ? '' : String(ruleUid).trim();
			if (!ruleUid) {
				withoutRuleUid++;
				return;
			}
			counts[ruleUid] = (counts[ruleUid] || 0) + 1;
			counted++;
		});
		return { counts: counts, counted: counted, withoutRuleUid: withoutRuleUid, total: counted + withoutRuleUid };
	}

	if (isSummary && request.query && typeof request.query.limit !== 'undefined') {
		limit = parseInt(request.query.limit, 10);
		if (isNaN(limit)) limit = 16;
		limit = Math.max(0, Math.min(limit, 16));
	}

	if (!fs.existsSync(file)) {
		if (isRuleRecordingCounts) {
			response.head(200);
			response.end(JSON.stringify({ counts: {}, counted: 0, withoutRuleUid: 0, total: 0 }));
			return;
		}
		if (isResultCounts) {
			response.head(200);
			response.end(JSON.stringify({ counts: { recorded: 0, deleted: 0, missed: 0, skipped: 0 } }));
			return;
		}
		if (isSummary) {
			response.head(200);
			response.end(JSON.stringify({ counts: { recorded: 0, ng: 0 }, items: [], hasMore: false }));
			return;
		}
		if (isList || mode === '') {
			response.head(200);
			response.end('[]');
			return;
		}
		if (isPage) {
			try {
				var emptyPage = matchDetailResolver.buildPage([], null, {
					page: request.query && request.query.page,
					limit: request.query && request.query.limit,
					search: request.query && request.query.search,
					status: request.query && request.query.status,
					results: request.query && request.query.results,
					ruleUid: request.query && request.query.ruleUid
				});
				response.head(200);
				response.end(JSON.stringify(emptyPage));
			} catch (e) {
				response.error(e && e.name === 'RangeError' ? 400 : 500);
			}
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

	if (!isSummary && !isItem && !isList && !isPage && !isRuleRecordingCounts && !isResultCounts) {
		response.error(400);
		return;
	}

	try {
		if (typeof matchCache !== 'undefined' && matchCache && typeof matchCache.getItems === 'function') {
			items = matchCache.getItems();
		} else {
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
		var idMatches = [];
		try { requestedKey = decodeURIComponent(requestedKey); } catch (e) {}
		try { requestedId = decodeURIComponent(requestedId); } catch (e) {}
		if (!requestedKey && !requestedId) {
			response.error(400);
			return;
		}
		found = items.find(function(item) { return requestedKey && item && item.key === requestedKey; }) || null;
		if (!found && requestedId) {
			idMatches = items.filter(function(item) { return matchItemHasId(item || {}, requestedId); });
			if (strictItemLookup) {
				var distinctKeys = [];
				idMatches.forEach(function(item) {
					var key = item && item.key || '';
					if (distinctKeys.indexOf(key) === -1) distinctKeys.push(key);
				});
				if (distinctKeys.length > 1) {
					response.head(409);
					response.end(JSON.stringify({ code: 'ambiguous-history', keys: distinctKeys }));
					return;
				}
			}
			found = idMatches[0] || null;
		}
		if (!found) {
			response.error(404);
			return;
		}
		if (shouldResolve) {
			var itemResolver = getDetailResolver();
			if (itemResolver === null) {
				response.error(501);
				return;
			}
			response.head(200);
			response.end(JSON.stringify(itemResolver.resolve(found)));
			return;
		}
		response.head(200);
		response.end(JSON.stringify(found));
		return;
	}

	if (isResultCounts) {
		response.head(200);
		response.end(JSON.stringify({ counts: buildResultCounts(items) }));
		return;
	}

	var resolver = getDetailResolver();
	if (resolver === null) {
		response.error(501);
		return;
	}

	if (isRuleRecordingCounts) {
		response.head(200);
		response.end(JSON.stringify(buildRuleRecordingCounts(items, resolver)));
		return;
	}

	if (isList) {
		response.head(200);
		response.end(JSON.stringify(matchDetailResolver.buildList(items, resolver, { now: Date.now() })));
		return;
	}

	if (isPage) {
		try {
			var pageResult = matchDetailResolver.buildPage(items, resolver, {
				now: Date.now(),
				page: request.query && request.query.page,
				limit: request.query && request.query.limit,
				search: request.query && request.query.search,
				status: request.query && request.query.status,
				results: request.query && request.query.results,
				ruleUid: request.query && request.query.ruleUid
			});
			response.head(200);
			response.end(JSON.stringify(pageResult));
		} catch (e) {
			if (e && e.name === 'RangeError') {
				response.error(400);
				return;
			}
			response.error(500);
		}
		return;
	}

	response.head(200);
	response.end(JSON.stringify(matchDetailResolver.buildSummary(items, resolver, {
		now: Date.now(),
		limit: limit
	})));
}());
