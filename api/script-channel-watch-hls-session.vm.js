(function() {
	var channelExists = data.schedule.some(function(item) { return item.id === request.param.chid; });
	if (!channelExists) return response.error(404);
	if (!mediaDelivery.stopLiveSession(request.param.session, 'client close')) return response.error(404);
	response.head(200);
	response.end(JSON.stringify({ stopped: true }));
}());
