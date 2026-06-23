(function () {
	'use strict';

	var file = './data/match.json';

	if (!fs.existsSync(file)) {
		response.head(200);
		response.end('[]');
		return;
	}

	response.head(200);
	response.end(fs.readFileSync(file, { encoding: 'utf8' }));
}());