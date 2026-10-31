(async function () {
	'use strict';
	if (!seriesService || typeof seriesService.request !== 'function') return response.error(501);
	try {
		var route = request.url.split('?')[0];
		var input = request.query || {};
		var command;
		var views = { '/api/series.json': 'full', '/api/series/overview.json': 'overview',
			'/api/series/detail.json': 'series', '/api/series/attention.json': 'attention',
			'/api/series/event.json': 'event', '/api/series/events.json': 'events' };
		if (views[route]) {
			if (request.method !== (views[route] === 'events' ? 'POST' : 'GET')) return response.error(405);
			command = 'view';
			input = Object.assign({}, input, { mode: views[route] });
		} else if (route === '/api/series/status.json') command = 'status';
		else if (route === '/api/series/search.json') {
			if (typeof input.q !== 'string' || !input.q.trim()) return response.error(400);
			command = 'searchTitles';
		} else if (route === '/api/series/preview.json') command = 'previewManualSelection';
		else if (route === '/api/series/override.json') command = request.method === 'DELETE' ? 'removeManualOverride' : 'setManualOverride';
		else if (route === '/api/series/override-bulk.json') command = 'setManualOverrides';
		else if (route === '/api/series/work-rule.json') command = 'removeWorkRule';
		else if (route === '/api/series/hidden.json') command = 'setSeriesHidden';
		else return response.error(404);
		var body = await seriesService.request(command, input);
		response.head(200);
		response.end(body);
	} catch (error) {
		util.log('SERIES API: ' + (error && error.stack || error));
		response.head(error && error.statusCode || 500);
		response.end(JSON.stringify({ schemaVersion: 1, error: { message: error.message, code: error.code || 'series-api-failed', contextToken: error.contextToken || null, currentContext: error.currentContext || null } }));
	}
})();
