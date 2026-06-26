
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

function escapeXmlText(value) {
	return String(value || '')
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;");
}

function getProgramTitleForXspf(program) {
	return program && (
		program.title ||
		program.fullTitle ||
		program.subTitle ||
		program.id ||
		request.param.id
	) || request.param.id || 'recorded';
}

function renderXspf() {
	var ext = request.query.ext || 'm2ts';
	var prefix = request.query.prefix || '';
	var search = '';
	var target;
	var title;
	var body;

	try {
		search = new URL(request.url, 'http://localhost').search;
	} catch (e) {
		search = '';
	}

	target = prefix + 'watch.' + ext + search;
	title = escapeXmlText(getProgramTitleForXspf(program));

	body = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<playlist version="1" xmlns="http://xspf.org/ns/0/">',
		'<trackList>',
		'<track>',
		'<location>' + escapeXmlText(target) + '</location>',
		'<title>' + title + '</title>',
		'</track>',
		'</trackList>',
		'</playlist>',
		''
	].join('\n');

	response.setHeader('content-disposition', 'attachment; filename="' + encodeURIComponent(program.id || request.param.id || 'recorded') + '.xspf"');
	response.head(200);
	response.end(body);
}

var found = findRecordedProgramWithMatchFallback(request.param.id);
var program = found.program;

if (program === null) {
	response.error(404);
} else {
	init();
}

function init() {

	if (!data.status.feature.streamer) return response.error(403);

	if (program.tuner && program.tuner.isScrambling) return response.error(409);

	if (!hasRecordedFile(program)) return response.error(410);

	if (request.type === 'xspf') {
		renderXspf();
		return;
	}

	// probing
	child_process.exec('ffprobe -v 0 -show_format -of json "' + program.recorded + '"', function (err, std) {

		if (err) {
			util.log("error", err);
			return response.error(500);
		}

		try {
			main(JSON.parse(std));
		} catch (e) {
			return response.error(500);
		}
	});
}

function main(avinfo) {

	if (request.query.debug) {
		util.log(JSON.stringify(avinfo, null, '  '));
		util.log(JSON.stringify(request.headers, null, '  '));
	}

	switch (request.type) {
		case 'xspf':
			renderXspf();
			return;

		case 'm2ts':
		case 'mp4':
			util.log('STREAMING: ' + request.url);

			var d = {
				ss   : request.query.ss     || '2',  //start(seconds)
				t    : request.query.t      || null, //duration(seconds)
				s    : request.query.s      || null, //size(WxH)
				f    : request.query.f      || null, //format
				'c:v': request.query['c:v'] || null, //vcodec
				'c:a': request.query['c:a'] || null, //acodec
				'b:v': request.query['b:v'] || null, //bitrate
				'b:a': request.query['b:a'] || null, //ab
				ar   : request.query.ar     || null, //ar(Hz)
				r    : request.query.r      || null  //rate(fps)
			};

			if (parseInt(d.ss, 10) < 2) {
				d.ss = '2';
			}

			if (parseInt(d.ss, 10) > parseFloat(avinfo.format.duration)) {
				return response.error(416);
			}

			// Convert humanized size String to Bitrate
			var bitrate = 0;
			var videoBitrate = 0;
			var audioBitrate = 0;
			if (d['b:v'] !== null) {
				if (d['b:v'].match(/^[0-9]+k$/i)) {
					videoBitrate = parseInt(d['b:v'].match(/^([0-9]+)k$/i)[1], 10) * 1024;
				} else if (d['b:v'].match(/^[0-9]+m$/i)) {
					videoBitrate = parseInt(d['b:v'].match(/^([0-9]+)m$/i)[1], 10) * 1024 * 1024;
				}
				if (d['c:a'] === 'copy' || d['b:a'] === null) {
					d['c:a'] = null;
					d['b:a'] = '96k';
				}
			}
			if (d['b:a'] !== null) {
				if (d['b:a'].match(/^[0-9]+k$/i)) {
					audioBitrate = parseInt(d['b:a'].match(/^([0-9]+)k$/i)[1], 10) * 1024;
				} else if (d['b:a'].match(/^[0-9]+m$/i)) {
					audioBitrate = parseInt(d['b:a'].match(/^([0-9]+)m$/i)[1], 10) * 1024 * 1024;
				}
			}
			if (videoBitrate !== 0 && audioBitrate !== 0) {
				bitrate = videoBitrate + audioBitrate;
			}

			// Caluculate Total Size
			var isize    = parseInt(avinfo.format.size, 10);
			var ibitrate = parseFloat(avinfo.format.bit_rate);
			var tsize    = 0;
			if (bitrate === 0) {
				bitrate = ibitrate;
				tsize = isize;
			} else {
				tsize = bitrate / 8 * parseFloat(avinfo.format.duration);
			}
			if (d.t) {
				tsize = tsize / parseFloat(avinfo.format.duration) * parseInt(d.t, 10);
			} else {
				tsize -= bitrate / 8 * (parseInt(d.ss, 10) - 2);
			}
			tsize = Math.floor(tsize);

			if (request.query.mode == 'download') {
				var pi = path.parse(program.recorded);
				response.setHeader('Content-disposition', 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(pi.name + '.' + request.query.ext));
			}

			// Ranges Support
			var range = {
				start: parseInt(ibitrate / 8 * (parseInt(d.ss, 10) - 2), 10)
			};
			range.start = range.start - (range.start % 188);

			if (request.type === 'm2ts') {
				if (request.headers.range) {
					var bytes = request.headers.range.replace(/bytes=/, '').split('-');
					var rStart = parseInt(bytes[0], 10);
					var rEnd   = parseInt(bytes[1], 10) || tsize - 2;

					range.start = Math.round(rStart / bitrate * ibitrate);
					range.end   = Math.round(rEnd / bitrate * ibitrate);
					if (range.start > isize || range.end > isize) {
						return response.error(416);
					}

					response.setHeader('Content-Range', 'bytes ' + rStart + '-' + rEnd + '/' + tsize);
					response.setHeader('Content-Length', rEnd - rStart + 1);

					response.head(206);
				} else {
					response.setHeader('Accept-Ranges', 'bytes');
					response.setHeader('Content-Length', tsize);

					response.head(200);
				}
			} else {
				response.head(200);
			}

			switch (request.type) {
				case 'm2ts':
					d.f = 'mpegts';
					d['c:v'] = d['c:v'] || 'copy';
					d['c:a'] = d['c:a'] || 'copy';
					break;
				case 'mp4':
					d.f = 'mp4';
					d['c:v'] = d['c:v'] || 'h264';
					d['c:a'] = d['c:a'] || 'aac';
					break;
			}

			var args = [];

			if (!request.query.debug) args.push('-v', '0');

			if (config.vaapiEnabled === true) {
				args.push("-vaapi_device", config.vaapiDevice || '/dev/dri/renderD128');
				args.push("-hwaccel", "vaapi");
				args.push("-hwaccel_output_format", "yuv420p");
			}

			args.push('-i', 'pipe:0');

			if (d.t) { args.push('-t', d.t); }

			args.push('-threads', '0');

			if (config.vaapiEnabled === true) {
				let scale = "";
				if (d.s) {
					let [width, height] = d.s.split("x");
					scale = `,scale_vaapi=w=${width}:h=${height}`;
				}
				args.push("-vf", `format=nv12|vaapi,hwupload,deinterlace_vaapi${scale}`);
				args.push("-aspect", "16:9")
			} else {
				args.push('-filter:v', 'yadif');
			}

			if (d['c:v']) {
				if (config.vaapiEnabled === true) {
					if (d['c:v'] === "mpeg2video") {
						d['c:v'] = "mpeg2_vaapi";
					}
					if (d['c:v'] === "h264") {
						d['c:v'] = "h264_vaapi";
					}
				}
				args.push('-c:v', d['c:v']);
			}
			if (d['c:a']) args.push('-c:a', d['c:a']);

			if (d.s) {
				if (config.vaapiEnabled !== true) {
					args.push('-s', d.s);
				}
			}
			if (d.r)  args.push('-r', d.r);
			if (d.ar) args.push('-ar', d.ar);

			if (d['b:v']) {
				args.push('-b:v', d['b:v']);
				args.push('-minrate:v', d['b:v'], '-maxrate:v', d['b:v']);
				args.push('-bufsize:v', videoBitrate * 8);
			}
			if (d['b:a']) {
				args.push('-b:a', d['b:a'], '-minrate:a', d['b:a'], '-maxrate:a', d['b:a']);
				args.push('-bufsize:a', audioBitrate * 8);
			}

			if (d['c:v'] === 'h264') {
				args.push('-profile:v', 'baseline');
				args.push('-preset', 'ultrafast');
				args.push('-tune', 'fastdecode,zerolatency');
			}
			if (d['c:v'] === 'h264_vaapi') {
				args.push('-profile', '77');
				args.push('-level', '41');
			}

			if (d.f === 'mp4') {
				args.push('-movflags', 'frag_keyframe+empty_moov+faststart+default_base_moof');
			}

			args.push('-y', '-f', d.f, 'pipe:1');

			var readStream = fs.createReadStream(program.recorded, range || {});

			request.on('close', function() {
				readStream.destroy();
			});

			if (d['c:v'] === 'copy' && d['c:a'] === 'copy' && !d.t) {
				readStream.pipe(response);
			} else {
				var ffmpeg = child_process.spawn('ffmpeg', args);
				children.push(ffmpeg.pid);
				util.log('SPAWN: ffmpeg ' + args.join(' ') + ' (pid=' + ffmpeg.pid + ')');

				ffmpeg.stdout.pipe(response);

				readStream.pipe(ffmpeg.stdin);

				ffmpeg.stderr.on('data', function(d) {
					util.log('#ffmpeg: ' + d);
				});

				ffmpeg.on('exit', function() {
					response.end();
				});

				request.on('close', function() {
					ffmpeg.stdout.removeAllListeners('data');
					ffmpeg.stderr.removeAllListeners('data');
					ffmpeg.kill('SIGKILL');
				});
			}

			return;
	}//<--switch

}
