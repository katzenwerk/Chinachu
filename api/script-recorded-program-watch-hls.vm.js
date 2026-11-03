(function() {
	function readOptionalArray(file) {
		var json;
		if (!file || !fs.existsSync(file)) return [];
		try {
			json = JSON.parse(fs.readFileSync(file, { encoding: 'utf8' }).replace(/^\uFEFF/, '') || '[]');
		} catch (_) {
			return [];
		}
		return Array.isArray(json) ? json : [];
	}

	function findRecorded() {
		var items = readOptionalArray(define.MATCH_DATA_FILE || './data/match.json');
		return matchDetailResolver.resolveRecordedProgram(request.param.id, items, {
			recorded: data && Array.isArray(data.recorded) ? data.recorded : [],
			reserves2: readOptionalArray(define.RESERVES2_DATA_FILE),
			reserves: data && Array.isArray(data.reserves) ? data.reserves : [],
			schedule: data && Array.isArray(data.schedule) ? data.schedule : []
		}).program;
	}

	if (!data.status.feature.streamer) return response.error(403);
	if (request.query.profile !== 'compat') return response.error(400);
	var program = findRecorded();
	if (program === null) return response.error(404);
	if (program._recordedDeleted || program.fileMissing) return response.error(410);
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
