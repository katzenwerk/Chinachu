'use strict';

const path = require('path');

function addUnique(values, value) {
	if (typeof value === 'undefined' || value === null || String(value) === '') return;
	value = String(value);
	if (!values.includes(value)) values.push(value);
}

function getValueIds(value) {
	const ids = [];
	addUnique(ids, value && value.id);
	addUnique(ids, value && value.recordedId);
	addUnique(ids, value && value.origId);
	addUnique(ids, value && value.programId);
	return ids;
}

function getTargetIds(recordedEntries, requestedId) {
	const ids = [];
	addUnique(ids, requestedId);
	(Array.isArray(recordedEntries) ? recordedEntries : []).forEach(entry => {
		getValueIds(entry).forEach(id => addUnique(ids, id));
	});
	return ids;
}

function getEntryIds(item) {
	const ids = [];
	const program = item && (item.program || item.reserve) || {};
	const result = item && (item.recordingResult || item.recorded) || {};
	const snapshot = result && result.snapshot || {};
	const recording = item && item.recording || {};
	addUnique(ids, item && item.key);
	getValueIds(recording).concat(getValueIds(program), getValueIds(result), getValueIds(snapshot))
		.forEach(id => addUnique(ids, id));
	return ids;
}

function getEntryPath(item) {
	const recording = item && item.recording || {};
	const program = item && (item.program || item.reserve) || {};
	const result = item && (item.recordingResult || item.recorded) || {};
	const snapshot = result && result.snapshot || {};
	return recording.path || result.recorded || result.path || snapshot.recorded || snapshot.path ||
		program.recorded || program.path || '';
}

function samePath(left, right) {
	if (typeof left !== 'string' || !left || typeof right !== 'string' || !right) return false;
	return path.resolve(left) === path.resolve(right);
}

function isAlreadyDeleted(item) {
	if (Number(item && item.schemaVersion) === 2) return Boolean(item.deletion);
	const result = item && (item.recordingResult || item.recorded) || {};
	const snapshot = result && result.snapshot || {};
	const program = item && item.program || {};
	return [result, snapshot, program].some(value => value &&
		(value.cleanupState === 'deleted' || value.deleted === true));
}

function findTargets(items, options) {
	options = options || {};
	const targetIds = getTargetIds(options.recordedEntries, options.requestedId);
	const targetPath = options.path || '';
	if (!targetPath || targetIds.length === 0) return [];

	return (Array.isArray(items) ? items : []).filter(item => {
		const entryPath = getEntryPath(item);
		const entryIds = getEntryIds(item);
		return samePath(entryPath, targetPath) &&
			entryIds.length > 0 && entryIds.some(id => targetIds.includes(id));
	});
}

function markDeleted(items, options) {
	options = options || {};
	const targets = findTargets(items, options);
	if (targets.length !== 1) {
		return {
			changed: false,
			matched: targets.length,
			ambiguous: targets.length > 1,
			reason: targets.length > 1 ? 'ambiguous-target' : 'target-not-found'
		};
	}

	const item = targets[0];
	if (isAlreadyDeleted(item)) {
		return { changed: false, matched: 1, ambiguous: false, reason: 'already-deleted' };
	}

	const deletedAt = Number(options.deletedAt) > 0 ? Number(options.deletedAt) : Date.now();
	const reason = typeof options.reason === 'string' && options.reason ? options.reason : null;
	if (Number(item.schemaVersion) === 2) {
		item.deletion = { deletedAt, reason };
	} else {
		const result = item && (item.recordingResult || item.recorded) || null;
		const snapshot = result && result.snapshot || null;
		[result, snapshot, item.program].forEach(value => {
			if (!value || typeof value !== 'object') return;
			value.fileExists = false;
			value.cleanupState = 'deleted';
			value.deletedAt = deletedAt;
			value.cleanupReason = reason;
		});
	}

	return { changed: true, matched: 1, ambiguous: false, reason: null };
}

module.exports = {
	findTargets,
	getEntryIds,
	getEntryPath,
	markDeleted
};
