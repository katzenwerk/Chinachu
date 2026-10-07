(function() {
	function addCandidate(candidates, value) {
		if (typeof value === 'undefined' || value === null || String(value) === '') return;
		value = String(value);
		if (candidates.indexOf(value) === -1) candidates.push(value);
	}

	function matchCandidates(item) {
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

	function findRecorded() {
		var program = chinachu.getProgramById(request.param.id, data.recorded);
		if (program !== null) return program;
		var file = define.MATCH_DATA_FILE || './data/match.json';
		var items;
		try {
			items = JSON.parse(fs.readFileSync(file, { encoding: 'utf8' }).replace(/^\uFEFF/, '') || '[]');
		} catch (_) {
			return null;
		}
		if (!Array.isArray(items)) return null;
		for (var i = 0; i < items.length; i++) {
			if (matchCandidates(items[i]).indexOf(String(request.param.id)) === -1) continue;
			var sourceProgram = items[i].program || {};
			var result = items[i].recordingResult || items[i].recorded || null;
			var snapshot = result && result.snapshot || {};
			if (!result || typeof result !== 'object') continue;
			var recorded = result.recorded || result.path || snapshot.recorded || snapshot.path || sourceProgram.recorded || sourceProgram.path || '';
			if (!recorded) continue;
			return {
				recorded: recorded,
				tuner: result.tuner || snapshot.tuner || sourceProgram.tuner || null
			};
		}
		return null;
	}

	if (!data.status.feature.streamer) return response.error(403);
	if (request.query.profile !== 'compat') return response.error(400);
	var program = findRecorded();
	if (program === null) return response.error(404);
	if (program.tuner && program.tuner.isScrambling) return response.error(409);
	if (!program.recorded || !fs.existsSync(program.recorded)) return response.error(410);

	mediaDelivery.createRecordedHlsSession(request.param.id, program.recorded).then(function(session) {
		var base = './watch-hls/' + encodeURIComponent(session.id) + '/';
		response.head(200);
		response.end(JSON.stringify({
			session: session.id,
			playlist: base + session.playlist,
			close: './watch-hls/' + encodeURIComponent(session.id) + '.json'
		}));
	}).catch(function(error) {
		util.log('[media-delivery] recorded HLS startup failed recorded=' + request.param.id + ': ' + error.message);
		if (!response.headersSent) response.error(error.statusCode || 503);
	});
}());
