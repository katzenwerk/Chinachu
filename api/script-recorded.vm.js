switch (request.method) {
case 'GET':
	response.head(200);
	response.end(JSON.stringify(data.recorded));
	break;

case 'PUT':
	try {
		data.recorded = reservationStore.updateArrayAtomic(define.RECORDED_DATA_FILE, function(current) {
			return current.filter(function(a) { return fs.existsSync(a.recorded); });
		});
	} catch (error) {
		response.error(500);
		break;
	}
	
	response.head(200);
	response.end(JSON.stringify(data.recorded, null, '  '));
	break;
}
