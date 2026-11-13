// Read-only, finite byte ranges for one recording take. No paths in responses.
(function() {
	if (!data.status.feature.filer || !data.status.feature.streamer) return response.error(403);
	var fd = null;
	function fail(code) {
		if (fd !== null) { fs.closeSync(fd); fd = null; }
		return response.error(code);
	}
	function readLedger(file) {
		var value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
		if (!Array.isArray(value)) throw new Error('invalid ledger');
		return value;
	}
	try {
		// Read current ledgers rather than an older WUI watcher snapshot.
		var recording = readLedger(define.RECORDING_DATA_FILE);
		var recorded = readLedger(define.RECORDED_DATA_FILE);
		var id = String(request.param.id);
		var query = request.query || {};
		var active = recording.filter(function(p) { return String(p.id) === id; });
		var saved = recorded.filter(function(p) { return String(p.id) === id; });
		if (active.length > 1 || saved.length > 1) return fail(409);
		var program = active[0] || saved[0];
		if (!program) return fail(404);
		var started = Number(program.operatorRecordingStart);
		if (!Number.isFinite(started) || started <= 0 || !program.recorded) return fail(503);
		if ((query.recordingStart && String(started) !== String(query.recordingStart)) ||
			(query.programStart && String(program.start) !== String(query.programStart))) return fail(409);
		if (program.fileMissing || program._recordedDeleted || (program.tuner && program.tuner.isScrambling)) return fail(409);
		var completed = saved[0] && Number(saved[0].operatorRecordingStart) === started &&
			saved[0].start === program.start && saved[0].channel && program.channel &&
			String(saved[0].channel.id) === String(program.channel.id) ? saved[0] : null;
		var candidates = [active[0] && active[0].recorded,
			active[0] && active[0]._operatorFilenameFinalTarget, completed && completed.recorded];
		var stat = null;
		var identity = null;
		for (var index = 0; index < candidates.length; index++) {
			var candidate = candidates[index];
			if (typeof candidate !== 'string' || !candidate || candidates.indexOf(candidate) !== index) continue;
			try {
				fd = fs.openSync(candidate, 'r');
				stat = fs.fstatSync(fd);
				identity = String(stat.dev) + ':' + String(stat.ino) + ':' + String(stat.birthtimeMs);
				if (!stat.isFile() || (query.identity && query.identity !== identity)) {
					fs.closeSync(fd); fd = null; continue;
				}
				break;
			} catch (error) {
				if (fd !== null) { fs.closeSync(fd); fd = null; }
				if (error.code !== 'ENOENT') throw error;
			}
		}
		if (fd === null) return fail(query.identity ? 409 : 503);
		// A saved row plus a short close/finalization grace precedes final EOF.
		// The client additionally requires the completed size to remain stable.
		var complete = Boolean(completed && completed.operatorRecordingEnd &&
			completed.operatorResumePending !== true && !active[0] &&
			Date.now() - Number(completed.operatorRecordingEnd) >= 2000);
		response.setHeader('cache-control', 'no-store');
		if (request.type === 'json') {
			fs.closeSync(fd); fd = null;
			response.setHeader('content-type', 'application/json; charset=utf-8');
			response.head(200);
			return response.end(JSON.stringify({ size: stat.size, complete: complete,
				identity: identity, recordingStart: started }));
		}
		var range = /^bytes=(\d*)-(\d*)$/i.exec(String(request.headers.range || '').trim());
		if (!range || (!range[1] && !range[2])) return fail(400);
		var start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
		var end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
		response.setHeader('accept-ranges', 'bytes');
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= stat.size ||
			start > end || (!range[1] && Number(range[2]) === 0)) {
			fs.closeSync(fd); fd = null;
			response.setHeader('content-range', 'bytes */' + stat.size);
			response.setHeader('content-length', 0);
			response.head(416);
			return response.end();
		}
		// Finite responses bound both network retries and per-viewer read-ahead.
		end = Math.min(end, start + 4 * 1024 * 1024 - 1);
		var stream = fs.createReadStream(null, { fd: fd, autoClose: true, start: start, end: end });
		fd = null;
		response.setHeader('content-type', 'video/mp2t');
		response.setHeader('content-range', 'bytes ' + start + '-' + end + '/' + stat.size);
		response.setHeader('content-length', end - start + 1);
		response.head(206);
		response.once('close', function() { stream.destroy(); });
		stream.once('error', function() { response.destroy(); });
		stream.pipe(response);
	} catch (_) {
		// A failed ledger read is never interpreted as an empty/completed ledger.
		fail(503);
	}
})();
