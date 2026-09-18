'use strict';

const fs = require('fs');

const markerPath = process.argv[2];
const mode = process.argv[3];
const delayMs = Number(process.argv[4]) || 10;

if (mode === 'ignore-term') {
	process.on('SIGTERM', function() {});
}

fs.appendFileSync(markerPath, 'started\n');
process.stdin.resume();

if (mode === 'ignore-term') {
	setInterval(function() {}, 1000);
} else if (mode === 'hang') {
	setInterval(function() {}, 1000);
} else {
	setTimeout(() => {
		process.exit(mode === 'nonzero' ? 7 : 0);
	}, delayMs);
}
