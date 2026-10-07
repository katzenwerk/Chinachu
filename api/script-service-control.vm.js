(function() {
	function send(code, value) {
		response.head(code);
		response.end(JSON.stringify(value, null, '  '));
	}

	if (request.method === 'GET') {
		return serviceControl.inspect().then(function(report) {
			send(200, report);
		}).catch(function() {
			send(500, { error: 'inspection_failed', message: 'サービス管理情報を確認できません' });
		});
	}

	if (request.method === 'POST') {
		return serviceControl.prepareRestart(request.param.target).then(function(operation) {
			send(202, { accepted: true, operation: operation });
			serviceControl.startPreparedRestart(operation.id);
		}).catch(function(error) {
			var statusCode = error && Number(error.statusCode);
			if (!statusCode || statusCode < 400 || statusCode > 599) statusCode = 500;
			send(statusCode, {
				error: error && error.code || 'restart_failed',
				message: error && error.publicMessage || '再起動要求を受け付けられません'
			});
		});
	}

	response.error(405);
})();
