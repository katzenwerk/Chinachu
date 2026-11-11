(function() {
	return mirakurun.getTuners().then(function(tuners) {
		if (!Array.isArray(tuners) || !tuners.every(function(tuner) {
			return tuner && Array.isArray(tuner.types) && tuner.types.length > 0 &&
				tuner.types.every(function(type) { return typeof type === 'string' && type.trim() !== ''; });
		})) {
			throw new Error('Invalid tuner response');
		}
		response.head(200);
		response.end(JSON.stringify(tuners.map(function(tuner) {
			return { types: tuner.types,
				name: typeof tuner.name === 'string' && tuner.name.trim() ? tuner.name.trim() : null,
				index: Number.isInteger(tuner.index) && tuner.index >= 0 ? tuner.index : null };
		})));
	}).catch(function() {
		response.error(502);
	});
})();
