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
						updatedRules.push(newRule);
						return newRule;
					});
					ruleStore.replaceMemory(data.rules, result.rules);
				} catch (error) {
					return response.error(ruleStore.httpStatus(error));
				}
				
				response.head(201);
				response.end(JSON.stringify(newRule));
			}
			return;
	}

})();
