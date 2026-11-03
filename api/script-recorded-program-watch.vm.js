
function readMatchItems() {
	var file = define.MATCH_DATA_FILE || './data/match.json';
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
} else if (program._recordedDeleted || program.fileMissing) {
	response.error(410);
} else {
	init();
}

function init() {

	if (!data.status.feature.streamer) return response.error(403);

	if (program.tuner && program.tuner.isScrambling) return response.error(409);

	if (!hasRecordedFile(program)) return response.error(410);
	if (request.method === 'HEAD' && !(request.type === 'mp4' && request.query.profile === 'compat')) {
		return response.error(405);
	}

	if (request.type === 'xspf') {
		renderXspf();
		return;
	}

	if (request.type === 'mp4' && request.query.profile === 'compat') {
		var cache;
		var closed = false;
		try {
			cache = mediaDelivery.acquireRecorded(program.recorded);
		} catch (error) {
			util.log('[media-delivery] recorded cache startup failed: ' + error.message);
			return response.error(500);
		}
		var release = function() {
			if (closed) return;
			closed = true;
			cache.release();
		};
		response.once('close', release);
		response.once('finish', release);
		cache.promise.then(function(filename) {
			if (closed) return;
			mediaDelivery.sendFile(request, response, filename);
		}).catch(function(error) {
			util.log('[media-delivery] recorded cache failed: ' + error.message);
			if (!closed && !response.headersSent) response.error(500);
		});
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
			var isCompatProfile = request.type === 'mp4' && request.query.profile === 'compat';
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

			if (!isCompatProfile && config.vaapiEnabled === true) {
				args.push("-vaapi_device", config.vaapiDevice || '/dev/dri/renderD128');
				args.push("-hwaccel", "vaapi");
				args.push("-hwaccel_output_format", "yuv420p");
			}

			args.push('-i', 'pipe:0');
			if (isCompatProfile) args.push('-map', '0:v:0', '-map', '0:a:0?');

			if (d.t) { args.push('-t', d.t); }

			args.push('-threads', '0');

			if (!isCompatProfile && config.vaapiEnabled === true) {
				let scale = "";
				if (d.s) {
					let [width, height] = d.s.split("x");
					scale = `,scale_vaapi=w=${width}:h=${height}`;
				}
				args.push("-vf", `format=nv12|vaapi,hwupload,deinterlace_vaapi${scale}`);
				args.push("-aspect", "16:9")
			} else if (isCompatProfile) {
				args.push('-filter:v', 'yadif=mode=send_frame:parity=auto:deint=interlaced');
			} else {
				args.push('-filter:v', 'yadif');
			}

			if (d['c:v']) {
				if (!isCompatProfile && config.vaapiEnabled === true) {
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
			} else if (isCompatProfile && d['c:a'] === 'aac') {
				args.push('-b:a', '128k');
			}

			if (d['c:v'] === 'h264') {
				if (isCompatProfile) {
					args.push('-profile:v', 'high', '-level:v', '4.0', '-pix_fmt', 'yuv420p');
					args.push('-preset', 'superfast', '-tune', 'zerolatency', '-threads:v', '2');
					args.push('-crf', '21', '-maxrate:v', '8M', '-bufsize:v', '16M');
					args.push('-g', '60', '-keyint_min', '60', '-sc_threshold', '0');
				} else {
					args.push('-profile:v', 'baseline');
					args.push('-preset', 'ultrafast');
					args.push('-tune', 'fastdecode,zerolatency');
				}
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

			response.once('close', function() {
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

				response.once('close', function() {
					if (response.writableFinished) return;
					ffmpeg.stdout.removeAllListeners('data');
					ffmpeg.stderr.removeAllListeners('data');
					ffmpeg.kill('SIGKILL');
				});
			}

			return;
	}//<--switch

}
