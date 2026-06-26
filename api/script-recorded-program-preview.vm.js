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

	var found = findRecordedProgramWithMatchFallback(request.param.id);
	var program = found.program;
	
	if (program === null) return response.error(404);
	
	if (!data.status.feature.previewer) return response.error(403);
	
	if (program.tuner && program.tuner.isScrambling) return response.error(409);
	
	if (!hasRecordedFile(program)) return response.error(410);
	
	response.head(200);
	
	var width  = request.query.width;
	var height = request.query.height;
	
	if (request.query.size && (request.query.size.match(/^[1-9][0-9]{0,3}x[1-9][0-9]{0,3}$/) !== null)) {
		width  = request.query.size.split('x')[0];
		height = request.query.size.split('x')[1];
	}

	width = parseInt(width, 10).toString(10);
	height = parseInt(height, 10).toString(10);
	if (width === 'NaN' || width === '0') width = '320';
	if (height === 'NaN' || height === '0') height = '180';
	
	width = parseInt(width, 10).toString(10);
	height = parseInt(height, 10).toString(10);
	if (width === 'NaN' || width === '0') width = '320';
	if (height === 'NaN' || height === '0') height = '180';
	
	var vcodec = 'mjpeg';
	
	if (request.query.type && (request.query.type === 'jpg')) { vcodec = 'mjpeg'; }
	if (request.query.type && (request.query.type === 'png')) { vcodec = 'png'; }
	if (request.type === 'jpg') { vcodec = 'mjpeg'; }
	if (request.type === 'png') { vcodec = 'png'; }
	if (request.type === 'txt') { vcodec = 'mjpeg'; }
	
	var pos = request.query.pos || '5';
	
	pos = (parseInt(pos, 10) - 1.5).toString(10);
	
	var ffmpeg = child_process.exec(
		(
			'ffmpeg -f mpegts -ss ' + pos + ' -r 10 -i "' + program.recorded + '" -ss 1.5 -r 10 -frames:v 1' +
			' -c:v ' + vcodec + ' -an -f image2 -s ' + width + 'x' + height + ' -map 0:0 -y pipe:1'
		)
		,
		{
			encoding: 'binary',
			maxBuffer: 3200000
		}
		,
		function(err, stdout, stderr) {
			if (err) {
				util.log(err);
				return response.error(503);
			}
			
			if (request.type === 'txt') {
				if (vcodec === 'mjpeg') {
					response.end('data:image/jpeg;base64,' + Buffer.from(stdout, 'binary').toString('base64'));
				} else if (vcodec === 'png') {
					response.end('data:image/png;base64,' + Buffer.from(stdout, 'binary').toString('base64'));
				}
			} else {
				response.end(stdout, 'binary');
			}
			clearTimeout(timeout);
		}
	);
	
	var timeout = setTimeout(function() {
		ffmpeg.kill('SIGKILL');
	}, 3000);

})();
