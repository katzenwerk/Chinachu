'use strict';

const path = require('path');

function getPhase(freeMB, cleanupThresholdMB, warningThresholdMB) {
	if (freeMB < cleanupThresholdMB) {
		return 'cleanup';
	}

	if (freeMB < warningThresholdMB) {
		return 'warning';
	}

	return null;
}

function stopCurrentRecordings(recording, stopRecording) {
	recording.slice().forEach(program => stopRecording(program.id, 'LOW STORAGE'));
}

function addCandidate(candidates, value) {
	if (typeof value === 'undefined' || value === null || String(value) === '') {
		return;
	}

	value = String(value);
	if (!candidates.includes(value)) {
		candidates.push(value);
	}
}

function getRecordedIdCandidates(recordedEntries) {
	const candidates = [];

	(recordedEntries || []).forEach(entry => {
		addCandidate(candidates, entry && entry.id);
		addCandidate(candidates, entry && entry.origId);
		addCandidate(candidates, entry && entry.programId);
		addCandidate(candidates, entry && entry.recordedId);
	});

	return candidates;
}

function matchItemHasRecordedId(item, recordedIds) {
	const program = item && item.program || {};
	const result = item && (item.recordingResult || item.recorded) || {};
	const snapshot = result && result.snapshot || {};
	const candidates = [];

	addCandidate(candidates, item && item.key);
	[ program, result, snapshot ].forEach(value => {
		addCandidate(candidates, value && value.id);
		addCandidate(candidates, value && value.origId);
		addCandidate(candidates, value && value.programId);
		addCandidate(candidates, value && value.recordedId);
	});

	return candidates.some(id => recordedIds.includes(id));
}

function getMatchRecordingPath(item) {
	const program = item && item.program || {};
	const result = item && (item.recordingResult || item.recorded) || {};
	const snapshot = result && result.snapshot || {};

	return result.recorded || result.path || snapshot.recorded || snapshot.path || program.recorded || program.path || '';
}

function markMatchRecordingDeleted(items, recordedEntries, filePath, deletedAt, cleanupReason) {
	const recordedIds = getRecordedIdCandidates(recordedEntries);
	const resolvedFilePath = path.resolve(filePath);
	let changed = false;

	if (recordedIds.length === 0) {
		return false;
	}

	(items || []).forEach(item => {
		const result = item && (item.recordingResult || item.recorded) || null;
		const snapshot = result && result.snapshot || null;
		const matchPath = getMatchRecordingPath(item);
		const pathMatches = matchPath && path.resolve(matchPath) === resolvedFilePath;

		if (!result || typeof result !== 'object') {
			return;
		}

		if (!pathMatches && !matchItemHasRecordedId(item, recordedIds)) {
			return;
		}

		[ result, snapshot, item.program ].forEach(value => {
			if (!value || typeof value !== 'object') {
				return;
			}

			value.fileExists = false;
			value.cleanupState = 'deleted';
			value.deletedAt = deletedAt;
			value.cleanupReason = cleanupReason;
		});

		changed = true;
	});

	return changed;
}

module.exports = {
	getPhase,
	markMatchRecordingDeleted,
	stopCurrentRecordings
};
