(function() {
	var channelExists = data.schedule.some(function(item) { return item.id === request.param.chid; });
	if (!channelExists) return response.error(404);
	var filename = request.param.asset + '.' + request.type;
	var asset = mediaDelivery.getLiveAsset(request.param.chid, request.param.session, filename);
	if (!asset) return response.error(404);
	mediaDelivery.sendFile(request, response, asset.path);
}());
