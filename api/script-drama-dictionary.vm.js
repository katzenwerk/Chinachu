(function() {
	if (!data.status.feature.configurator) return response.error(403);
	response.head(200);
	response.end(JSON.stringify(getDramaDictionaryStatus()));
})();
