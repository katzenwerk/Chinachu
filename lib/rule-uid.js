'use strict';

const crypto = require('crypto');

function validateRuleUids(rules) {
	if (!Array.isArray(rules)) {
		throw new TypeError('rules must be an array');
	}

	const seen = new Map();
	rules.forEach((rule, index) => {
		if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
			throw new TypeError('rule at index ' + index + ' must be an object');
		}
		if (typeof rule.ruleUid === 'undefined') {
			return;
		}
		if (typeof rule.ruleUid !== 'string' || rule.ruleUid.trim() === '') {
			const error = new TypeError('ruleUid at index ' + index + ' must be a non-empty string');
			error.code = 'RULE_UID_INVALID';
			throw error;
		}
		if (seen.has(rule.ruleUid)) {
			const error = new Error('duplicate ruleUid at indexes ' + seen.get(rule.ruleUid) + ' and ' + index);
			error.code = 'RULE_UID_DUPLICATE';
			throw error;
		}
		seen.set(rule.ruleUid, index);
	});

	return seen;
}

function ensureRuleUids(rules) {
	const seen = validateRuleUids(rules);
	let assigned = 0;
	let existing = 0;

	rules.forEach(rule => {
		if (typeof rule.ruleUid !== 'undefined') {
			existing++;
			return;
		}

		let uid;
		do {
			uid = crypto.randomUUID();
		} while (seen.has(uid));

		rule.ruleUid = uid;
		seen.set(uid, assigned);
		assigned++;
	});

	return { assigned, existing };
}

module.exports = {
	ensureRuleUids,
	validateRuleUids
};
