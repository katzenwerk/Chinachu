'use strict';

const reservationStore = require('./reservation-store');
const ruleUid = require('./rule-uid');
const childProcess = require('child_process');
const path = require('path');

const CLI_EXIT_LOCK_TIMEOUT = 73;
const CLI_EXIT_TARGET_CONFLICT = 74;

function targetError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

function findUniqueIndex(rules, uid) {
	if (typeof uid !== 'string' || uid.trim() === '') {
		throw targetError('RULE_TARGET_INVALID', 'ruleUid must be a non-empty string');
	}

	const indexes = [];
	rules.forEach(function (rule, index) {
		if (rule && rule.ruleUid === uid) indexes.push(index);
	});

	if (indexes.length === 0) {
		throw targetError('RULE_TARGET_NOT_FOUND', 'ruleUid was not found: ' + uid);
	}
	if (indexes.length !== 1) {
		throw targetError('RULE_UID_DUPLICATE', 'ruleUid is not unique: ' + uid);
	}
	return indexes[0];
}

function findIndex(rules, options) {
	options = options || {};
	if (typeof options.ruleUid !== 'undefined' && options.ruleUid !== null && options.ruleUid !== '') {
		return findUniqueIndex(rules, options.ruleUid);
	}

	const index = Number(options.index);
	if (!Number.isInteger(index) || index < 0 || index >= rules.length) {
		throw targetError('RULE_TARGET_NOT_FOUND', 'rule index was not found: ' + options.index);
	}
	return index;
}

function readRules(filePath) {
	return reservationStore.withLock(filePath, function () {
		const rules = reservationStore.readArray(filePath);
		ruleUid.validateRuleUids(rules);
		return rules;
	});
}

function ensureRuleFile(filePath) {
	return reservationStore.withLock(filePath, function () {
		const rules = reservationStore.readArray(filePath);
		const ensured = ruleUid.ensureRuleUids(rules);
		if (ensured.assigned > 0) reservationStore.writeArrayAtomic(filePath, rules);
		return { rules: rules, assigned: ensured.assigned, existing: ensured.existing };
	});
}

function updateRules(filePath, callback, options) {
	options = options || {};
	return reservationStore.withLock(filePath, function () {
		const rules = reservationStore.readArray(filePath);
		const before = ruleUid.ensureRuleUids(rules);
		const value = callback(rules);
		const after = ruleUid.ensureRuleUids(rules);
		if (options.write !== false) reservationStore.writeArrayAtomic(filePath, rules);
		return {
			rules: rules,
			value: value,
			assigned: before.assigned + after.assigned,
			existing: after.existing
		};
	});
}

function normalizeRecordingHandoff(rule) {
	if (rule.recordingHandoffProtected !== undefined && typeof rule.recordingHandoffProtected !== 'boolean') {
		throw targetError('RULE_TARGET_INVALID', 'recordingHandoffProtected must be a boolean');
	}
	rule.recordingHandoffProtected = reservationStore.isRecordingHandoffProtected(rule);
	delete rule.recordingBoundaryPolicy;
	delete rule.allowEndLack;
	return rule;
}

function replaceMemory(target, latest) {
	if (!Array.isArray(target) || !Array.isArray(latest)) return;
	target.splice.apply(target, [0, target.length].concat(latest));
}

function httpStatus(error) {
	if (!error) return 500;
	if (error.code === 'RULE_TARGET_NOT_FOUND') return 404;
	if (error.code === 'RULE_TARGET_CONFLICT' || error.code === 'RULE_UID_DUPLICATE') return 409;
	if (error.code === 'RULE_TARGET_INVALID' || error.code === 'RULE_UID_INVALID') return 400;
	if (error.code === 'RESERVATION_LOCK_TIMEOUT') return 503;
	return 500;
}

// Keep reservation calculation and its held locks outside the WUI event loop.
function scheduleReservations(root, snapshot) {
	return new Promise((resolve, reject) => {
		childProcess.execFile(process.execPath, [
			path.join(root, 'app-cli.js'), '-mode', 'rule-reserves',
			'--rule-uid', snapshot.ruleUid, '--rule-snapshot', JSON.stringify(snapshot)
		], { cwd: root, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				error.message = String(stderr || error.message).trim();
				try {
					const detail = JSON.parse(stderr);
					error.message = detail.message;
					error.code = detail.code;
				} catch (_) {
					if (error.code === CLI_EXIT_LOCK_TIMEOUT) error.code = 'RESERVATION_LOCK_TIMEOUT';
					else if (error.code === CLI_EXIT_TARGET_CONFLICT) error.code = 'RULE_TARGET_CONFLICT';
				}
				return reject(error);
			}
			try { resolve(JSON.parse(stdout)); } catch (parseError) { reject(parseError); }
		});
	});
}

module.exports = {
	normalizeRecordingHandoff,
	scheduleReservations,
	CLI_EXIT_LOCK_TIMEOUT,
	CLI_EXIT_TARGET_CONFLICT,
	ensureRuleFile,
	findIndex,
	findUniqueIndex,
	httpStatus,
	readRules,
	replaceMemory,
	targetError,
	updateRules
};
