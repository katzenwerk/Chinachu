(function() {
	try {
		if (request.method === 'GET') {
			response.head(200);
			response.end(JSON.stringify(wuiConfigStore.read(define.WUI_CONFIG_FILE)));
			return;
		}
		if (request.method === 'PUT') {
			var updated = wuiConfigStore.update(define.WUI_CONFIG_FILE, request.query || {});
			response.head(200);
			response.end(JSON.stringify(updated));
			return;
		}
		response.error(405);
	} catch (error) {
		util.log('WUI CONFIG: ' + (error && error.stack || error));
		response.error(error && /must be/.test(error.message) ? 400 : 500);
	}
})();
