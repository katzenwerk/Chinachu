'use strict';

const path = require('path');
const matchDetailResolver = require('./match-detail-resolver');

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

function isAlreadyDeleted(item) {
	if (Number(item && item.schemaVersion) === 2) return Boolean(item.deletion && item.deletion.reason !== 'recorded-missing');
	const result = item && (item.recordingResult || item.recorded) || {};
	const snapshot = result && result.snapshot || {};
	const program = item && item.program || {};
	return [result, snapshot, program].some(value => value &&
		(value.cleanupState === 'deleted' || value.deleted === true));
}

function findTargets(items, options) {
	options = options || {};
	const recorded = (Array.isArray(options.recordedEntries) ? options.recordedEntries : []).filter(Boolean);
	// The file operation must already have identified a single current recorded.json row.
	if (recorded.length !== 1) return [];
	const target = recorded[0];
	const recordedId = target.id === undefined || target.id === null ? '' : String(target.id);
	const key = matchDetailResolver.makeCanonicalKey(target);
	if (!recordedId || !key || !target.recorded || options.requestedId &&
		!getValueIds(target).includes(String(options.requestedId)) || options.path &&
		path.resolve(options.path) !== path.resolve(target.recorded)) return [];

	return (Array.isArray(items) ? items : []).filter(item => {
		const normalized = matchDetailResolver.normalizeMatchEntry(item);
		if (normalized.key !== key) return false;
		const recordedReference = normalized.recording || normalized.fileMissing;
		if (recordedReference && recordedReference.recordedId) {
			return recordedReference.recordedId === recordedId;
		}
		// Legacy history may hold the recording ID in its result/snapshot.
		return getEntryIds(item).includes(recordedId);
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
		delete item.fileMissing;
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

	// A deletion write can touch the whole match array. Strip legacy recording
	// paths from every entry before any caller persists that array.
	if (Array.isArray(items)) items.forEach((entry, index) => {
		items[index] = matchDetailResolver.withoutRecordingPaths(entry);
	});
	return { changed: true, matched: 1, ambiguous: false, reason: null };
}

module.exports = {
	findTargets,
	getEntryIds,
	markDeleted
};
