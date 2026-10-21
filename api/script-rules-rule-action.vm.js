(function() {

	if (request.method !== 'PUT') return;

	var expectedRuleUid = request.headers['x-chinachu-rule-uid'];
	if (typeof expectedRuleUid !== 'string' || expectedRuleUid === '') return response.error(428);

	var actionFlag = null;
	switch (request.param.action) {
		case 'enable':
			actionFlag = '--enable';
			break;
		case 'disable':
			actionFlag = '--disable';
			break;
		default:
			return response.error(404);
	}

	try {
		var currentRules = ruleStore.readRules(define.RULES_FILE);
		ruleStore.findUniqueIndex(currentRules, expectedRuleUid);
	} catch (error) {
		return response.error(ruleStore.httpStatus(error));
	}

	child_process.execFile(define.NODE_EXECUTABLE, [
		path.resolve(define.REPOSITORY_ROOT, 'app-cli.js'),
		'-mode', 'rule', actionFlag, '--rule-uid', expectedRuleUid
	], { cwd: define.REPOSITORY_ROOT }, function(err) {
		if (err) {
			if (err.code === ruleStore.CLI_EXIT_TARGET_CONFLICT) return response.error(409);
			if (err.code === ruleStore.CLI_EXIT_LOCK_TIMEOUT) return response.error(503);
			return response.error(500);
		}

		try {
			var latestRules = ruleStore.readRules(define.RULES_FILE);
			ruleStore.replaceMemory(data.rules, latestRules);
			response.head(200);
			response.end(JSON.stringify({ rules: latestRules }));
		} catch (refreshError) {
			response.error(ruleStore.httpStatus(refreshError));
		}
	});

})();
