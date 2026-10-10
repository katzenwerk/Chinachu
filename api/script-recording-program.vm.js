(function() {

	var program = chinachu.getProgramById(request.param.id, data.recording);

	if (program === null) return response.error(404);

	switch (request.method) {
		case 'GET':
			response.head(200);
			response.end(JSON.stringify(program, null, '  '));
			return;

		case 'DELETE':
			child_process.exec('node app-cli.js -mode stop -id ' + program.id, function(err, stdout, stderr) {
				if (err) return response.error(err.code === 73 ? 503 : 500);

				response.head(200);
				response.end('{}');
			});
			return;
	}

})();
