(function() {

	// Logos are service resources, including services excluded from the schedule.
	var chid = request.param.chid;
	var serviceId = parseInt(chid, 36);
	if (!/^[0-9a-z]+$/i.test(chid) || !Number.isSafeInteger(serviceId) || serviceId <= 0) return response.error(404);

	switch (request.type) {
		case 'png':
			// get logo
			mirakurun.getLogoImage(serviceId)
				.then(buffer => {
					response.head(200);
					response.end(buffer, 'binary');
				})
				.catch(err => {
					if (err.req) {
						return response.error(err.statusCode);
					} else {
						return response.error(503);
					}
				});
			break;
	}//<--switch
}());
