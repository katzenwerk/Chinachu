(function() {
	if (!mediaDelivery.stopRecordedHlsSession(request.param.id, request.param.session, 'client close')) {
		return response.error(404);
	}
	response.head(200);
	response.end(JSON.stringify({ stopped: true }));
}());
