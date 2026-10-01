(function() {
	
	var num = parseInt(request.param.num, 10).toString(10);
	var rule = data.rules[num] || null;
	
	if (rule === null) return response.error(404);
	
	switch (request.method) {
		case 'GET':
			response.head(200);
			response.end(JSON.stringify(rule, null, '  '));
			return;
		
		case 'PUT':
			var newRule = request.query;
			if (request.headers['content-type'].match(/^application\/json/) === null) {
				response.error(400);
			} else if (JSON.stringify(newRule) === '{}') {
				response.error(400);
			} else {
				if (newRule.isEnabled === false) {
					newRule.isDisabled = true;
				}
				delete newRule.isEnabled;

				var index = data.rules.indexOf(rule);
				var updatedRules = data.rules.slice();
				if (typeof rule.ruleUid === 'undefined') {
					delete newRule.ruleUid;
				} else {
					newRule.ruleUid = rule.ruleUid;
				}
				updatedRules.splice(index, 1, newRule);
				try {
					ruleUid.ensureRuleUids(updatedRules);
					data.rules.splice(index, 1, newRule);
					fs.writeFileSync(define.RULES_FILE, JSON.stringify(data.rules, null, '  '));
				} catch (error) {
					return response.error(error.code === 'RULE_UID_DUPLICATE' ? 409 : error.code === 'RULE_UID_INVALID' ? 400 : 500);
				}
				
				response.head(200);
				response.end(JSON.stringify(newRule));
			}
			return;
		
		case 'DELETE':
			child_process.exec('node app-cli.js -mode rule --remove -n ' + num, function(err, stdout, stderr) {
				if (err) return response.error(500);
				
				response.head(200);
				response.end('{}');
			});
			return;
	}

})();
