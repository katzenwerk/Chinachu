'use strict';

const fs = require('fs');
const path = require('path');
const matchDetailResolver = require('./match-detail-resolver');
const reservationStore = require('./reservation-store');

const SCHEMA_VERSION = 2;
const DEFAULT_RECORDED_MISSING_GRACE_MS = 10 * 60 * 1000;
const RECORDED_STATUSES = new Set(['RECORDED', 'RECORDED_UNTRACKED']);

function cloneJson(value) {
	return value === null || typeof value !== 'object' ? value : JSON.parse(JSON.stringify(value));
}

function addId(ids, value) {
	if (typeof value === 'undefined' || value === null || String(value) === '') return;
	value = String(value);
	if (!ids.includes(value)) ids.push(value);
}

function getProgramIds(program) {
	const ids = [];
	addId(ids, program && program.id);
	addId(ids, program && program.recordedId);
	addId(ids, program && program.origId);
	addId(ids, program && program.programId);
	return ids;
}

function getRecordingIds(entry) {
	const normalized = matchDetailResolver.normalizeMatchEntry(entry);
	return getProgramIds(normalized.recording || {});
}

function isV2Entry(entry) {
	return Number(entry && entry.schemaVersion) === SCHEMA_VERSION;
}

function isAllV2(entries) {
	return Array.isArray(entries) && entries.every(isV2Entry);
}

function inspectRuleUidCandidates(entry) {
	entry = entry && typeof entry === 'object' ? entry : {};
	const reservationMeta = entry.reservationMeta && typeof entry.reservationMeta === 'object' ?
		entry.reservationMeta : {};
	const program = entry.program && typeof entry.program === 'object' ? entry.program : {};
	const reserve = entry.reserve && typeof entry.reserve === 'object' ? entry.reserve : {};
	const recorded = entry.recorded && typeof entry.recorded === 'object' ? entry.recorded : {};
	const recordingResult = entry.recordingResult && typeof entry.recordingResult === 'object' ?
		entry.recordingResult : {};
	const recordingSnapshot = recordingResult.snapshot && typeof recordingResult.snapshot === 'object' ?
		recordingResult.snapshot : {};
	const recordedSnapshot = recorded.snapshot && typeof recorded.snapshot === 'object' ?
		recorded.snapshot : {};
	const inputs = [
		['ruleUid', entry.ruleUid],
		['reservationMeta.ruleUid', reservationMeta.ruleUid],
		['program.ruleUid', program.ruleUid],
		['reserve.ruleUid', reserve.ruleUid],
		['recorded.ruleUid', recorded.ruleUid],
		['recordingResult.ruleUid', recordingResult.ruleUid],
		['recordingResult.snapshot.ruleUid', recordingSnapshot.ruleUid],
		['recorded.snapshot.ruleUid', recordedSnapshot.ruleUid]
	];
	const candidates = [];
	const invalidSources = [];
	const normalizedSources = [];

	inputs.forEach(input => {
		const source = input[0];
		const value = input[1];
		if (typeof value === 'undefined' || value === null) return;
		if (typeof value !== 'string' || !value.trim()) {
			invalidSources.push(source);
			return;
		}

		const normalized = value.trim();
		if (normalized !== value) normalizedSources.push(source);
		candidates.push({ source, value: normalized });
	});

	const values = [];
	candidates.forEach(candidate => {
		if (!values.includes(candidate.value)) values.push(candidate.value);
	});

	return {
		ruleUid: values.length === 1 ? values[0] : null,
		conflict: values.length > 1,
		values,
		candidates,
		invalidSources,
		normalizedSources
	};
}

function requiresRuleUidCorrection(entry, inspection) {
	if (!isV2Entry(entry)) return true;
	if (!Object.prototype.hasOwnProperty.call(entry, 'ruleUid')) return true;
	if (entry.ruleUid === null) return inspection.ruleUid !== null;
	if (typeof entry.ruleUid !== 'string' || !entry.ruleUid.trim()) return true;
	return entry.ruleUid !== inspection.ruleUid;
}

function createMigrationDiagnostics(total) {
	return {
		total: Number.isFinite(Number(total)) ? Number(total) : 0,
		converted: 0,
		normalV2: 0,
		ruleUidConflicts: 0,
		ruleUidNulled: 0,
		otherCorrections: 0,
		fatalErrors: 0,
		warnings: []
	};
}

function buildMigrationDiagnostics(entries, inspections) {
	const diagnostics = createMigrationDiagnostics(entries.length);

	entries.forEach((entry, index) => {
		const inspection = inspections[index];
		if (isV2Entry(entry)) {
			if (!requiresRuleUidCorrection(entry, inspection)) diagnostics.normalV2++;
		} else {
			diagnostics.converted++;
		}

		if (inspection.conflict) {
			diagnostics.ruleUidConflicts++;
			diagnostics.ruleUidNulled++;
			diagnostics.warnings.push({
				code: 'ruleUid-conflict',
				index,
				key: matchDetailResolver.normalizeMatchEntry(entry).key,
				candidates: inspection.candidates.map(candidate => ({
					source: candidate.source,
					value: candidate.value
				}))
			});
			return;
		}

		if (inspection.ruleUid === null && inspection.invalidSources.length > 0) {
			diagnostics.ruleUidNulled++;
		}
		if (inspection.invalidSources.length > 0 || inspection.normalizedSources.length > 0) {
			diagnostics.otherCorrections++;
		}
	});

	return diagnostics;
}

function assertWriterReady(entries, schemaVersion) {
	if (Number(schemaVersion) === SCHEMA_VERSION && !isAllV2(entries)) {
		throw new Error('match v2 writer requires a completed v2fix');
	}
	return true;
}

function toV2Entry(entry) {
	const normalized = matchDetailResolver.normalizeMatchEntry(entry);
	const ruleUid = inspectRuleUidCandidates(entry).ruleUid;
	return {
		schemaVersion: SCHEMA_VERSION,
		key: normalized.key,
		status: normalized.status,
		start: normalized.start,
		end: normalized.end,
		fullTitle: normalized.fullTitle,
		ruleUid,
		recording: normalized.recording ? {
			recordedId: normalized.recording.recordedId,
			path: normalized.recording.path
		} : null,
		deletion: normalized.deletion ? {
			deletedAt: normalized.deletion.deletedAt,
			reason: normalized.deletion.reason
		} : null
	};
}

function validateV2Entry(entry, index) {
	if (!isV2Entry(entry)) throw new Error('match v2 schema expected at index ' + index);
	if (!matchDetailResolver.parseCanonicalKey(entry.key)) {
		throw new Error('invalid canonical match key at index ' + index);
	}
	if (typeof entry.status !== 'string' || !entry.status) {
		throw new Error('match status is required at index ' + index);
	}
	if (!Number.isFinite(Number(entry.start)) || Number(entry.start) <= 0 ||
		!Number.isFinite(Number(entry.end)) || Number(entry.end) < Number(entry.start)) {
		throw new Error('invalid match time at index ' + index);
	}
	if (entry.recording !== null && (!entry.recording || typeof entry.recording !== 'object')) {
		throw new Error('invalid match recording at index ' + index);
	}
	if (entry.deletion !== null && (!entry.deletion || typeof entry.deletion !== 'object')) {
		throw new Error('invalid match deletion at index ' + index);
	}
	if (typeof entry.ruleUid !== 'undefined' && entry.ruleUid !== null &&
		(typeof entry.ruleUid !== 'string' || !entry.ruleUid.trim())) {
		throw new Error('invalid match ruleUid at index ' + index);
	}
	return true;
}

function validateConversion(before, after) {
	if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) {
		throw new Error('match v2 conversion changed the entry count');
	}

	before.forEach((entry, index) => {
		validateV2Entry(after[index], index);
		const oldValue = matchDetailResolver.normalizeMatchEntry(entry);
		const newValue = matchDetailResolver.normalizeMatchEntry(after[index]);
		const expectedRuleUid = inspectRuleUidCandidates(entry).ruleUid;
		if (oldValue.key !== newValue.key) throw new Error('match key changed at index ' + index);
		if (oldValue.status !== newValue.status) throw new Error('match status changed at index ' + index);
		if (oldValue.start !== newValue.start) throw new Error('match start changed at index ' + index);
		if (oldValue.end !== newValue.end) throw new Error('match end changed at index ' + index);
		if (oldValue.fullTitle !== newValue.fullTitle) throw new Error('match fullTitle changed at index ' + index);
		if (JSON.stringify(oldValue.recording) !== JSON.stringify(newValue.recording)) {
			throw new Error('match recording changed at index ' + index);
		}
		if (JSON.stringify(oldValue.deletion) !== JSON.stringify(newValue.deletion)) {
			throw new Error('match deletion changed at index ' + index);
		}
		if (expectedRuleUid !== newValue.ruleUid) {
			throw new Error('match ruleUid was not normalized at index ' + index);
		}
	});

	return true;
}

function hasIdIntersection(left, right) {
	return left.some(id => right.includes(id));
}

function programMatchesEntry(entry, program) {
	const normalized = matchDetailResolver.normalizeMatchEntry(entry);
	const entryKey = normalized.key;
	const programKey = matchDetailResolver.makeCanonicalKey(program);
	const entryIds = getRecordingIds(normalized);
	const programIds = getProgramIds(program);

	if (entryKey && programKey) return entryKey === programKey;
	return entryIds.length > 0 && programIds.length > 0 && hasIdIntersection(entryIds, programIds);
}

function markRecordedMissing(entries, recordedList, options) {
	options = options || {};
	if (options.recordedReadOk !== true) return entries;

	const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
	const graceMs = Number.isFinite(Number(options.graceMs)) && Number(options.graceMs) >= 0 ?
		Number(options.graceMs) : DEFAULT_RECORDED_MISSING_GRACE_MS;
	const active = Array.isArray(options.recordingList) ? options.recordingList : [];
	const recorded = Array.isArray(recordedList) ? recordedList : [];

	return (Array.isArray(entries) ? entries : []).map(entry => {
		const output = toV2Entry(entry);
		if (!RECORDED_STATUSES.has(output.status) || !output.recording || output.deletion !== null) return output;
		if (recorded.some(program => programMatchesEntry(output, program))) return output;
		if (active.some(program => programMatchesEntry(output, program))) return output;
		if (output.end > 0 && nowMs < output.end + graceMs) return output;
		output.deletion = { deletedAt: null, reason: 'recorded-missing' };
		return output;
	});
}

function formatBackupTimestamp(nowMs) {
	return new Date(nowMs).toISOString().replace(/[-:.TZ]/g, '');
}

function writeBackup(sourceFile, backupFile, fileSystem, reuseMatchingBackup) {
	fileSystem = fileSystem || fs;
	try {
		fileSystem.copyFileSync(sourceFile, backupFile, fs.constants.COPYFILE_EXCL);
	} catch (error) {
		if (!reuseMatchingBackup || !error || error.code !== 'EEXIST') throw error;
		const source = fileSystem.readFileSync(sourceFile);
		const backup = fileSystem.readFileSync(backupFile);
		if (!Buffer.from(source).equals(Buffer.from(backup))) {
			throw new Error('existing match v1 backup differs from the current source: ' + backupFile);
		}
	}
	return backupFile;
}

function runV2Fix(options) {
	options = options || {};
	const matchFile = options.matchFile;
	const store = options.reservationStore || reservationStore;
	const fileSystem = options.fs || fs;
	const legacyOnly = options.legacyOnly === true;
	const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();

	if (!matchFile) throw new Error('matchFile is required');

	return store.withLock(matchFile, () => {
		let diagnostics = createMigrationDiagnostics(0);
		try {
			const original = store.readArray(matchFile);
			const inspections = original.map(inspectRuleUidCandidates);
			diagnostics = buildMigrationDiagnostics(original, inspections);
			const needsRuleUidCorrection = original.some((entry, index) =>
				requiresRuleUidCorrection(entry, inspections[index]));
			if (isAllV2(original) && (legacyOnly || !needsRuleUidCorrection)) {
				original.forEach(validateV2Entry);
				return Object.assign({ changed: false, skipped: true, backupFile: null }, diagnostics);
			}

			const converted = original.map(toV2Entry);
			validateConversion(original, converted);
			converted.forEach(validateV2Entry);

			const backupFile = options.backupFile || matchFile + '.v1-backup-' + formatBackupTimestamp(nowMs);
			writeBackup(matchFile, backupFile, fileSystem, options.reuseMatchingBackup === true);
			store.writeArrayAtomic(matchFile, converted);

			return Object.assign({
				changed: true,
				skipped: false,
				backupFile
			}, diagnostics);
		} catch (error) {
			diagnostics.fatalErrors++;
			error.matchV2Diagnostics = diagnostics;
			throw error;
		}
	});
}

module.exports = {
	SCHEMA_VERSION,
	DEFAULT_RECORDED_MISSING_GRACE_MS,
	assertWriterReady,
	getProgramIds,
	inspectRuleUidCandidates,
	isAllV2,
	isV2Entry,
	markRecordedMissing,
	programMatchesEntry,
	runV2Fix,
	toV2Entry,
	validateConversion,
	validateV2Entry
};
