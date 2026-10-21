(function() {

	if (['wui', 'operator', 'scheduler', 'mirakurun'].indexOf(request.param.name) === -1) {
		return response.error(404);
	}

	if (request.param.name === 'mirakurun') {
		return mirakurun.getLog().then(function(data) {
			response.head(200);
			response.end(String(data || ''));
		}).catch(function() {
			response.error(502);
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

	fs.readFile(filename, function(err, data) {
		if (err) {
			util.log(err);
			return response.error(500);
		}

		response.end(data);
	});

})();
