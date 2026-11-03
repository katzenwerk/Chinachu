(function() {
	var channel = data.schedule.find(function(item) { return item.id === request.param.chid; });
	if (!channel) return response.error(404);
	if (!data.status.feature.streamer || !data.status.feature.previewer) return response.error(403);
	// Validate the exact broadcast interval so an old dialog cannot capture a later show.
	var now = Date.now();
	var start = Number(request.query.start);
	var end = Number(request.query.end);
	var program = (channel.programs || []).find(function(item) {
		return item.id === request.query.id && Number(item.start) === start && Number(item.end) === end;
	});
	if (!program || !(start <= now && now < end)) return response.error(409);
	// Reuse the existing watchers' readiness and in-memory arrays, never read the HDD here.
	if (!data.reservationTimingReady || !Array.isArray(data.reserves) || !Array.isArray(data.recording)) {
		return response.error(503);
	}
	if (data.recording.some(function(item) { return item.id === program.id; })) return response.error(409);
	var serviceId = parseInt(channel.id, 36);
	if (!Number.isSafeInteger(serviceId) || serviceId <= 0) return response.error(400);
	// Same normalization as Operator getHandoffPrepMillis(): recording is requested
	// at program.start - prepTime, not at the broadcast start or the HDD wakeup time.
	var prepSeconds = Number(config.handoffPrepSeconds);
	var prepMillis = Number.isFinite(prepSeconds) && prepSeconds >= 0 ? Math.min(prepSeconds, 60) * 1000 : 20000;
	for (var i = 0; i < data.reserves.length; i++) {
		var reserve = data.reserves[i];
		if (!reserve) return response.error(503);
		if (reserve.isSkip || data.recording.some(function(item) { return item.id === reserve.id; })) continue;
		var recordingStart = Number(reserve.start) - prepMillis;
		if (!Number.isFinite(recordingStart) || Number(reserve.start) <= 0) return response.error(503);
		var untilStart = recordingStart - now;
		if (untilStart >= 0 && untilStart <= 60000) {
			response.setHeader('Cache-Control', 'no-store');
			response.setHeader('X-Chinachu-Preview-Skipped', 'recording-start-soon');
			response.head(204);
			return response.end();
		}
	}
	channelPreview(serviceId, response, end - now);
})();
