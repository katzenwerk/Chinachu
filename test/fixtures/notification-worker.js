'use strict';

const fs = require('fs');

const markerPath = process.argv[2];
process.on('SIGTERM', function() {});

fs.appendFileSync(markerPath, 'started\n');
process.stdin.resume();
setInterval(function() {}, 1000);
