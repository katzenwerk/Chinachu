(function() {

	if (['wui', 'operator', 'scheduler', 'mirakurun'].indexOf(request.param.name) === -1) {
		return response.error(404);
	}

	if (request.param.name === 'mirakurun') {
		var upstream = null;
		var closed = false;
		request.once('close', function() {
			closed = true;
			if (upstream) {
				upstream.unpipe(response);
				upstream.destroy();
			}
		});
		return mirakurun.getLogStream().then(function(stream) {
			if (closed) {
				stream.destroy();
				return;
			}
			upstream = stream;
			response.head(200);
			if (typeof response.flushHeaders === 'function') response.flushHeaders();
			stream.pipe(response);
			stream.once('error', function() { if (!closed) response.end(); });
		}).catch(function() {
			if (!closed) response.error(502);
		});
	}

	let filename = "";
	switch (request.param.name) {
		case "wui":
			filename = define.WUI_LOG_FILE;
			break;
		case "scheduler":
			filename = define.SCHEDULER_LOG_FILE;
			break;
		case "operator":
			filename = define.OPERATOR_LOG_FILE;
			break;
	}

	if (!fs.existsSync(filename)) {
		response.head(204);
		response.end('');
		return;
	}

	response.head(200);

	if (!request.query || request.query.padding !== '0') {
		response.write(new Array(1024).join(' '));
	} else if (typeof response.flushHeaders === 'function') {
		response.flushHeaders();
	}

	var hasRequestedLines = request.query && request.query.lines !== undefined;
	var requestedLines = hasRequestedLines ? parseInt(request.query.lines, 10) : 100;
	var initialLines = Number.isFinite(requestedLines) ? Math.max(0, Math.min(300, requestedLines)) : 300;
	var followMode = request.query && request.query.follow === 'rotation' ? '-F' : '-f';
	var tailf = child_process.spawn('tail', [followMode, '-n', String(initialLines), filename]);
	children.push(tailf.pid);

	tailf.stdout.pipe(response);

	tailf.on('exit', function(code) {
		response.end();
	});

	request.on('close', function() {
		tailf.kill('SIGKILL');
	});

})();
