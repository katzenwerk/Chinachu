(function() {
	var channel = null;

	data.schedule.forEach(function(item) {
		if (item.id === request.param.chid) channel = item;
	});
	if (channel === null) return response.error(404);
	if (!data.status.feature.streamer) return response.error(403);
	if (request.query.profile !== 'compat') return response.error(400);

	mediaDelivery.createLiveSession(channel.id).then(function(session) {
		var base = './watch-hls/' + encodeURIComponent(session.id) + '/';
		response.head(200);
		response.end(JSON.stringify({
			session: session.id,
			playlist: base + session.playlist,
			close: './watch-hls/' + encodeURIComponent(session.id) + '.json'
		}));
	}).catch(function(error) {
		util.log('[media-delivery] live startup failed channel=' + channel.id + ': ' + error.message);
		if (!response.headersSent) response.error(error.statusCode || 503);
	});
}());
