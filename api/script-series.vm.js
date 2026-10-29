(function () {
	'use strict';

	if (!seriesService || typeof seriesService.getSnapshot !== 'function') {
		return response.error(501);
	}

	try {
		if (request.url.match(/^\/api\/series\/search\.json(?:\?|$)/)) {
			if (request.method !== 'GET') return response.error(405);
			var query = typeof request.query.q === 'string' ? request.query.q : '';
			if (!query.trim()) return response.error(400);
			response.head(200);
			response.end(JSON.stringify({ schemaVersion: 1, results: seriesService.searchTitles(query, 20) }));
			return;
		}
		if (request.url.match(/^\/api\/series\/preview\.json(?:\?|$)/)) {
			if (request.method !== 'POST') return response.error(405);
			response.head(200);
			response.end(JSON.stringify({ schemaVersion: 1, result: seriesService.previewManualSelection(request.query || {}) }));
			return;
		}
		if (request.url.match(/^\/api\/series\/override\.json(?:\?|$)/)) {
			var result;
			if (request.method === 'POST') result = seriesService.setManualOverride(request.query || {});
			else if (request.method === 'DELETE') result = seriesService.removeManualOverride(request.query && request.query.eventKey);
			else return response.error(405);
			response.head(200);
			response.end(JSON.stringify({ schemaVersion: 1, result: result }));
			return;
		}
		if (request.url.match(/^\/api\/series\/override-bulk\.json(?:\?|$)/)) {
			if (request.method !== 'POST') return response.error(405);
			if (typeof seriesService.setManualOverrides !== 'function') return response.error(501);
			var bulkResult = seriesService.setManualOverrides(request.query || {});
			response.head(200);
			response.end(JSON.stringify({ schemaVersion: 1, result: bulkResult }));
			return;
		}
		if (request.url.match(/^\/api\/series\/work-rule\.json(?:\?|$)/)) {
			if (request.method !== 'DELETE') return response.error(405);
			response.head(200);
			response.end(JSON.stringify({ schemaVersion: 1, result: seriesService.removeWorkRule(request.query || {}) }));
			return;
		}
		if (request.url.match(/^\/api\/series\/hidden\.json(?:\?|$)/)) {
			if (request.method !== 'POST') return response.error(405);
			if (typeof seriesService.setSeriesHidden !== 'function') return response.error(501);
			var hiddenResult = seriesService.setSeriesHidden(request.query || {});
			response.head(200);
			response.end(JSON.stringify({ schemaVersion: 1, result: hiddenResult }));
			return;
		}
		if (request.method !== 'GET') return response.error(405);
		var snapshot = seriesService.getSnapshot();
		response.head(200);
		response.end(JSON.stringify(snapshot));
	} catch (error) {
		util.log('SERIES API: ' + (error && error.stack || error));
		return response.error(error && error.statusCode || 500);
	}
})();
