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

function writeMatchItems(items) {
	var file = getMatchDataFile();
	fs.writeFileSync(file, JSON.stringify(items));
}

function cloneJson(value) {
	if (value == null || typeof value !== 'object') {
		return value;
	}

	return JSON.parse(JSON.stringify(value));
}

function addCandidate(candidates, value) {
	if (typeof value === 'undefined' || value === null || String(value) === '') {
		return;
	}

	value = String(value);
	if (candidates.indexOf(value) === -1) {
		candidates.push(value);
	}
}

function getRecordedIdCandidates(item) {
	var candidates = [];
	var program = item && item.program || {};
	var result = item && item.recordingResult || item && item.recorded || {};
	var snapshot = result && result.snapshot || {};

	addCandidate(candidates, item && item.key);
	addCandidate(candidates, program.id);
	addCandidate(candidates, program.origId);
	addCandidate(candidates, program.programId);
	addCandidate(candidates, result.id);
	addCandidate(candidates, result.recordedId);
	addCandidate(candidates, result.origId);
	addCandidate(candidates, result.programId);
	addCandidate(candidates, snapshot.id);
	addCandidate(candidates, snapshot.origId);
	addCandidate(candidates, snapshot.programId);
	addCandidate(candidates, snapshot.recordedId);

	return candidates;
}

function isMatchItemForRecordedId(item, id) {
	return getRecordedIdCandidates(item).indexOf(String(id)) !== -1;
}

function buildRecordedProgramFromMatch(item) {
	var program = item && item.program || {};
	var result = item && item.recordingResult || item && item.recorded || null;
	var snapshot = result && result.snapshot || {};
	var output;
	var recordedPath;
	var id;

	if (!result || typeof result !== 'object') {
		return null;
	}

	recordedPath = result.recorded || result.path || snapshot.recorded || snapshot.path || program.recorded || program.path || '';
	id = result.recordedId || result.id || result.programId || result.origId || snapshot.id || snapshot.programId || program.id || program.programId || item.key || '';

	output = Object.assign({}, cloneJson(program) || {}, cloneJson(snapshot) || {}, cloneJson(result) || {});
	output.id = id;
	output.origId = output.origId || result.origId || result.programId || program.origId || program.programId || id;
	output.programId = output.programId || result.programId || program.programId || output.origId || id;
	output.recordedId = result.recordedId || result.id || id;
	output.recorded = recordedPath;
	output.path = recordedPath;
	output.title = output.title || program.title || result.title || item.key || '';
	output.fullTitle = output.fullTitle || program.fullTitle || output.title || '';
	output.channel = output.channel || program.channel || result.channel || item.channel || {};
	output.tuner = output.tuner || result.tuner || snapshot.tuner || null;
	output.command = output.command || result.command || snapshot.command || '';
	output._isMatchFallback = true;
	output._matchKey = item.key || '';

	return output;
}

function findRecordedProgramWithMatchFallback(id) {
	var program = chinachu.getProgramById(id, data.recorded);
	var items;
	var i;
	var fromMatch;

	if (program !== null) {
		return {
			program: program,
			source: 'recorded',
			matchItem: null,
			matchIndex: -1
		};
	}

	items = readMatchItems();
	for (i = 0; i < items.length; i++) {
		if (!isMatchItemForRecordedId(items[i], id)) {
			continue;
		}

		fromMatch = buildRecordedProgramFromMatch(items[i]);
		if (fromMatch && fromMatch.recorded) {
			return {
				program: fromMatch,
				source: 'match',
				matchItem: items[i],
				matchIndex: i
			};
		}
	}

	return {
		program: null,
		source: null,
		matchItem: null,
		matchIndex: -1
	};
}

function hasRecordedFile(program) {
	return !!(program && program.recorded && fs.existsSync(program.recorded));
}

function updateMatchRecordingDeleted(id, recordedPath) {
	var items = readMatchItems();
	var now = Date.now();
	var changed = false;

	items.forEach(function(item) {
		var result = item && item.recordingResult || item && item.recorded || null;
		var snapshot = result && result.snapshot || null;
		var path = result && (result.recorded || result.path) || snapshot && (snapshot.recorded || snapshot.path) || '';

		if (!result || typeof result !== 'object') {
			return;
		}

		if (!isMatchItemForRecordedId(item, id) && (!recordedPath || path !== recordedPath)) {
			return;
		}

		result.fileExists = false;
		result.cleanupState = 'deleted';
		result.deletedAt = now;

		if (snapshot && typeof snapshot === 'object') {
			snapshot.fileExists = false;
			snapshot.cleanupState = 'deleted';
			snapshot.deletedAt = now;
		}

		if (item.program && typeof item.program === 'object') {
			item.program.fileExists = false;
			item.program.cleanupState = 'deleted';
			item.program.deletedAt = now;
		}

		changed = true;
	});

	if (changed) {
		writeMatchItems(items);
	}

	return changed;
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
			if (hasRecordedFile(program)) {
				fs.unlinkSync(program.recorded);
			}

			if (found.source === 'recorded') {
				data.recorded = (function() {
					var array = [];

					data.recorded.forEach(function(a) {
						if (a.id !== program.id) {
							array.push(a);
						}
					});

					return array;
				})();

				fs.writeFileSync(define.RECORDED_DATA_FILE, JSON.stringify(data.recorded));
			}

			updateMatchRecordingDeleted(request.param.id, program.recorded);

			response.head(200);
			response.end('{}');
			return;
	}

})();
