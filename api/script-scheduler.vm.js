(function() {
	var SCHEDULER_ALREADY_RUNNING_EXIT_CODE = 76;

	switch (request.method) {
		case 'GET':
			res();
			return;

		case 'PUT':
			if (request.query.ruleUid) {
				if (!request.query.ruleSnapshot || request.query.ruleSnapshot.ruleUid !== request.query.ruleUid) {
					return response.error(400);
				}
				ruleStore.scheduleReservations(define.REPOSITORY_ROOT, request.query.ruleSnapshot).then(function(result) {
					if (!result.historyUpdated) return response.error(503);
					response.head(200);
					response.end(JSON.stringify({ time: Date.now(), quick: true,
						conflicts: result.reserves.filter(function(program) { return program.isConflict; }),
						reserves: result.reserves.filter(function(program) { return !program.isConflict && !program.isSkip; }) }));
				}, function(error) {
					response.error(ruleStore.httpStatus(error));
				});
				return;
			}
			child_process.exec('./chinachu update', function(err, stdout, stderr) {
				if (err) {
					if (err.code === SCHEDULER_ALREADY_RUNNING_EXIT_CODE) return response.error(409);
					return response.error(err.code === 75 ? 503 : 500);
				}

				res();
			});
			return;
	}
	
	function res() {
		if (request.type === 'json') {
		
			var result = {
				time     : 0,
				conflicts: [],
				reserves : []
			};
			
			if (!fs.existsSync(define.SCHEDULER_LOG_FILE)) {
				response.head(204);
				response.end(JSON.stringify(result));
				return;
			}
			
			result.time = fs.statSync(define.SCHEDULER_LOG_FILE).mtime.getTime();
			
			var schedulerLog  = child_process.execSync('/bin/bash -c \'sed "/RUNNING SCHEDULER\\./q" <\(nice -n 19 tac "' + define.SCHEDULER_LOG_FILE + '"\)\' 2>/dev/null', {
				encoding: 'utf8'
			});
			
			var lines = schedulerLog.split('\n');
			
			for (var k = 0; k < lines.length; k++) {
				var line = lines[k] || '';
				
				if ((line.match('CONFLICT:') !== null) || (line.match('RESERVE:') !== null)) {
					var id = line.match(/(RESERVE|CONFLICT): ([a-z0-9-]+)/)[2];
					var t  = line.match(/(RESERVE|CONFLICT): ([a-z0-9-]+)/)[1];
					var f  = null;
					
					for (var i = 0; i < data.schedule.length; i++) {
						for (var j = 0; j < data.schedule[i].programs.length; j++) {
							if (data.schedule[i].programs[j].id === id) {
								f = data.schedule[i].programs[j];
								break;
							}
						}
						if (f !== null) { break; }
					}
					
					if (t === 'CONFLICT') {
						result.conflicts.push(f);
					}
					if (t === 'RESERVE') {
						result.reserves.push(f);
					}
				}
			}
			
			result.conflicts.reverse();
			result.reserves.reverse();
			
			response.head(200);
			response.end(JSON.stringify(result, null, '  '));
			
		} else {
			
			if (!fs.existsSync(define.SCHEDULER_LOG_FILE)) {
				response.head(204);
				response.end('');
				return;
			}
			
			response.head(200);
			response.end(fs.readFileSync(define.SCHEDULER_LOG_FILE, 'ascii'));
			
		}
	}

})();
