(function() {
	if (!request.url.match(/^\/api\/log\/history\.json(?:\?|$)/)) return response.error(400);
	try {
		var options = {
			repositoryRoot: define.REPOSITORY_ROOT,
			logDir: define.LOG_DIR,
			operatorStdout: define.OPERATOR_LOG_FILE,
			operatorStderr: define.OPERATOR_ERROR_LOG_FILE,
			scheduler: define.SCHEDULER_LOG_FILE,
			wuiStdout: define.WUI_LOG_FILE,
			wuiStderr: define.WUI_ERROR_LOG_FILE
		};
		var result;
		if (request.query && request.query.id) {
			result = logHistory.readChunk(options, {
				id: request.query.id,
				before: request.query.before,
				lines: request.query.lines
			});
		} else {
			result = { files: logHistory.listFiles(options, request.query && request.query.name) };
		}
		response.head(200);
		response.end(JSON.stringify(result));
	} catch (error) {
		if (error && error.statusCode) return response.error(error.statusCode);
		util.log(error);
		return response.error(500);
	}
})();
