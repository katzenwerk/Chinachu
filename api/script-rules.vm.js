(function() {
	
	switch (request.method) {
		case 'GET':
			try {
				var currentRules = ruleStore.readRules(define.RULES_FILE);
				ruleStore.replaceMemory(data.rules, currentRules);
				response.head(200);
				response.end(JSON.stringify(currentRules, null, '  '));
			} catch (error) {
				response.error(ruleStore.httpStatus(error));
			}
			return;
		
		case 'POST':
			var newRule = request.query;
			if (typeof newRule === 'string') {
				try {
					newRule = JSON.parse(request.query);
				} catch (e) {
					return response.error(400);
				}
			}
			if (JSON.stringify(newRule) === '{}') {
				response.error(400);
			} else {
				if (typeof newRule.reserve_titles_mode !== 'undefined' &&
						newRule.reserve_titles_mode !== 'or' && newRule.reserve_titles_mode !== 'and') {
					return response.error(400);
				}
				if (newRule.isEnabled === false) {
					newRule.isDisabled = true;
				}
				delete newRule.isEnabled;

				try {
					var result = ruleStore.updateRules(define.RULES_FILE, function(updatedRules) {
						ruleStore.normalizeRecordingHandoff(newRule);
						updatedRules.push(newRule);
						return newRule;
					});
					ruleStore.replaceMemory(data.rules, result.rules);
				} catch (error) {
					return response.error(ruleStore.httpStatus(error));
				}
				
				// Saving the rule succeeded. Report reservation failure separately so callers
				// retry the calculation, never POST the rule a second time.
				ruleStore.scheduleReservations(define.REPOSITORY_ROOT, newRule).then(function(result) {
					finish({ success: result.historyUpdated, reservedCount: result.reservedCount,
						conflictCount: result.conflictCount, error: result.warning || null });
				}, function(error) {
					finish({ success: false, error: error.message });
				});
				function finish(reservationUpdate) {
					response.head(201);
					response.end(JSON.stringify(Object.assign({}, newRule, { reservationUpdate: reservationUpdate })));
				}
			}
			return;
	}

})();
