(function() {

	var num = parseInt(request.param.num, 10);
	if (!Number.isInteger(num) || num < 0) return response.error(404);

	function expectedRuleUid() {
		var value = request.headers['x-chinachu-rule-uid'];
		return typeof value === 'string' && value !== '' ? value : null;
	}

	function refreshRules() {
		var latestRules = ruleStore.readRules(define.RULES_FILE);
		ruleStore.replaceMemory(data.rules, latestRules);
		return latestRules;
	}

	switch (request.method) {
		case 'GET':
			try {
				var currentRules = refreshRules();
				var currentIndex = ruleStore.findIndex(currentRules, { index: num });
				response.head(200);
				response.end(JSON.stringify(currentRules[currentIndex], null, '  '));
			} catch (error) {
				response.error(ruleStore.httpStatus(error));
			}
			return;

		case 'PUT':
			var putRuleUid = expectedRuleUid();
			if (putRuleUid === null) return response.error(428);

			var newRule = request.query;
			if (!request.headers['content-type'] || request.headers['content-type'].match(/^application\/json/) === null) {
				return response.error(400);
			}
			if (JSON.stringify(newRule) === '{}') return response.error(400);

			try {
				var putResult = ruleStore.updateRules(define.RULES_FILE, function(updatedRules) {
					var index = ruleStore.findUniqueIndex(updatedRules, putRuleUid);
					var currentRule = updatedRules[index];
					if (typeof newRule.reserve_titles_mode === 'undefined' && typeof currentRule.reserve_titles_mode !== 'undefined') {
						newRule.reserve_titles_mode = currentRule.reserve_titles_mode;
					}
					if (typeof newRule.reserve_titles_mode !== 'undefined' &&
							newRule.reserve_titles_mode !== 'or' && newRule.reserve_titles_mode !== 'and') {
						throw ruleStore.targetError('RULE_TARGET_INVALID', 'reserve_titles_mode is invalid');
					}
					if (newRule.isEnabled === false) newRule.isDisabled = true;
					delete newRule.isEnabled;
					if (newRule.recordingHandoffProtected === undefined && typeof currentRule.recordingHandoffProtected === 'boolean') {
						newRule.recordingHandoffProtected = currentRule.recordingHandoffProtected;
					}
					ruleStore.normalizeRecordingHandoff(newRule);
					newRule.ruleUid = currentRule.ruleUid;
					updatedRules.splice(index, 1, newRule);
					return newRule;
				});
				ruleStore.replaceMemory(data.rules, putResult.rules);
				response.head(200);
				response.end(JSON.stringify(putResult.value));
			} catch (error) {
				response.error(ruleStore.httpStatus(error));
			}
			return;

		case 'DELETE':
			var deleteRuleUid = expectedRuleUid();
			if (deleteRuleUid === null) return response.error(428);

			try {
				var beforeDelete = ruleStore.readRules(define.RULES_FILE);
				ruleStore.findUniqueIndex(beforeDelete, deleteRuleUid);
			} catch (error) {
				return response.error(ruleStore.httpStatus(error));
			}

			child_process.execFile(define.NODE_EXECUTABLE, [
				path.resolve(define.REPOSITORY_ROOT, 'app-cli.js'),
				'-mode', 'rule', '--remove', '--rule-uid', deleteRuleUid
			], { cwd: define.REPOSITORY_ROOT }, function(err) {
				if (err) {
					if (err.code === ruleStore.CLI_EXIT_TARGET_CONFLICT) return response.error(409);
					if (err.code === ruleStore.CLI_EXIT_LOCK_TIMEOUT) return response.error(503);
					return response.error(500);
				}

				try {
					var latestRules = refreshRules();
					response.head(200);
					response.end(JSON.stringify({
						deleted: true,
						deletedRuleUid: deleteRuleUid,
						rules: latestRules,
						refreshPending: false
					}));
				} catch (refreshError) {
					response.head(200);
					response.end(JSON.stringify({
						deleted: true,
						deletedRuleUid: deleteRuleUid,
						rules: null,
						refreshPending: true
					}));
				}
			});
			return;
	}

})();
