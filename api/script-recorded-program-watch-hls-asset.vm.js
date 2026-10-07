(function() {
	var filename = request.param.asset + '.' + request.type;
	var asset = mediaDelivery.getRecordedHlsAsset(request.param.id, request.param.session, filename);
	if (!asset) return response.error(404);
	mediaDelivery.sendFile(request, response, asset.path);
}());
