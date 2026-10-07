(function() {
	var force = request.query && (request.query.refresh === '1' || request.query.refresh === 'true');

	return healthDiagnostics.collect({ force: force }).then(function(report) {
		response.head(200);
		response.end(JSON.stringify(report, null, '  '));
	}).catch(function() {
		response.error(500);
	});
})();
