'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const storageHealth = require('./storage-health');
const matchDetailResolver = require('./match-detail-resolver');
const reservationStore = require('./reservation-store');
const recordedThumbnail = require('./recorded-thumbnail');

const DEFAULT_EXTENSIONS = ['.ts', '.m2ts'];
const MISSING_POLICIES = new Set(['report', 'keep-history', 'remove-history']);

function normalizeOptions(options) {
	options = options || {};
	const missingPolicy = MISSING_POLICIES.has(options.missingPolicy) ? options.missingPolicy : 'report';
	return {
		checkLocations: options.checkLocations !== false,
		normalizeLocations: options.checkLocations !== false && options.normalizeLocations === true,
		missingPolicy,
		cleanupMissed: missingPolicy === 'remove-history' && options.cleanupMissed === true,
		selectedIds: options.selectedIds || null
	};
}

function cloneJson(value) {
	return JSON.parse(JSON.stringify(value));
}

function readArray(file, fileSystem) {
	fileSystem = fileSystem || fs;
	const value = JSON.parse(fileSystem.readFileSync(file, 'utf8') || '[]');
	if (!Array.isArray(value)) throw new TypeError(path.basename(file) + ' must contain an array');
	return value;
}

function readArraySnapshot(file, fileSystem) {
	fileSystem = fileSystem || fs;
	const before = fileSystem.statSync(file);
	const text = fileSystem.readFileSync(file, 'utf8') || '[]';
	const after = fileSystem.statSync(file);
	if (before.size !== after.size || Number(before.mtimeMs) !== Number(after.mtimeMs)) {
		throw new Error(path.basename(file) + ' changed while it was being read');
	}
	const value = JSON.parse(text);
	if (!Array.isArray(value)) throw new TypeError(path.basename(file) + ' must contain an array');
	return {
		value,
		signature: {
			path: file,
			size: after.size,
			mtimeMs: Number(after.mtimeMs),
			sha256: crypto.createHash('sha256').update(text).digest('hex')
		}
	};
}

function verifySourceSignatures(signatures, fileSystem) {
	fileSystem = fileSystem || fs;
	return Object.entries(signatures || {}).map(([name, expected]) => {
		try {
			const text = fileSystem.readFileSync(expected.path, 'utf8');
			const stat = fileSystem.statSync(expected.path);
			const actual = {
				size: stat.size,
				mtimeMs: Number(stat.mtimeMs),
				sha256: crypto.createHash('sha256').update(text).digest('hex')
			};
			return { name, fresh: actual.size === expected.size && actual.mtimeMs === expected.mtimeMs && actual.sha256 === expected.sha256 };
		} catch (error) {
			return { name, fresh: false, error: error.message };
		}
	});
}

function stringValue(value) {
	return typeof value === 'string' ? value : '';
}

function positiveNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : 0;
}

function programIds(program) {
	const ids = [];
	['id', 'recordedId', 'origId', 'programId'].forEach(field => {
		const value = stringValue(program && program[field]);
		if (value && !ids.includes(value)) ids.push(value);
	});
	return ids;
}

function recordedPath(program) {
	return stringValue(program && (program.recorded || program.path));
}

function canonicalKey(program) {
	return matchDetailResolver.makeCanonicalKey(program);
}

function sameLedgerItem(a, b) {
	const aKey = canonicalKey(a);
	const bKey = canonicalKey(b);
	if (aKey && bKey) return aKey === bKey;
	const aIds = programIds(a);
	return aIds.length > 0 && programIds(b).some(id => aIds.includes(id));
}

function matchEntryMatchesProgram(entry, program) {
	const normalized = matchDetailResolver.normalizeMatchEntry(entry);
	const key = canonicalKey(program);
	if (key && normalized.key) return key === normalized.key;
	const ids = programIds(program);
	const recordedId = normalized.recording && normalized.recording.recordedId;
	return Boolean(recordedId && ids.includes(recordedId));
}

function matchEntryIds(entry) {
	const normalized = matchDetailResolver.normalizeMatchEntry(entry);
	return normalized.recording && normalized.recording.recordedId ? [normalized.recording.recordedId] : [];
}

function isDeletedMatchEntry(entry) {
	const deletion = matchDetailResolver.normalizeMatchEntry(entry).deletion;
	return Boolean(deletion && deletion.reason !== 'recorded-missing');
}

function isWithin(root, target) {
	const relative = path.relative(root, target);
	return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function normalizedExtensions(config, recorded) {
	const extensions = new Set(DEFAULT_EXTENSIONS);
	const configured = path.extname(stringValue(config && config.recordedFormat)).toLowerCase();
	if (configured) extensions.add(configured);
	(Array.isArray(recorded) ? recorded : []).forEach(program => {
		const extension = path.extname(recordedPath(program)).toLowerCase();
		if (extension) extensions.add(extension);
	});
	return extensions;
}

function prepareDestinations(config, selectedIds) {
	const selected = selectedIds && selectedIds.length ? new Set(selectedIds) : null;
	const raw = storageHealth.getDestinations(config || {}).filter(destination => {
		if (!selected) return true;
		const tokens = [destination.id === null ? 'default' : destination.id].concat(destination.aliasIds || []);
		return tokens.some(token => selected.has(token));
	});
	const sorted = raw.slice().sort((a, b) => a.path.length - b.path.length);
	const roots = [];
	const covered = [];

	sorted.forEach(destination => {
		const parent = roots.find(root => isWithin(root.path, destination.path));
		if (parent) {
			covered.push({ destination, coveredBy: parent.id });
			return;
		}
		roots.push(destination);
	});

	return { roots, covered, configured: raw };
}

function inspectRoots(config, options) {
	options = options || {};
	const fileSystem = options.fs || fs;
	const prepared = prepareDestinations(config, options.selectedIds);
	const roots = prepared.roots.map(destination => {
		const inspection = storageHealth.inspectDestination(destination, {
			fs: fileSystem,
			checkCapacity: false,
			mountInfo: options.mountInfo,
			platform: options.platform
		});
		return { destination, inspection };
	});
	return Object.assign(prepared, { roots });
}

function indexFiles(rootState, extensions, options) {
	options = options || {};
	const fileSystem = options.fs || fs;
	const onProgress = typeof options.onProgress === 'function' ? options.onProgress : function () {};
	const byPath = new Map();
	const byName = new Map();
	const files = [];
	const rootReports = [];
	let visitedDirectories = 0;
	let skippedSymlinks = 0;
	let skippedFilesystems = 0;

	rootState.roots.forEach(root => {
		const rootStartedAt = process.hrtime.bigint();
		const destination = root.destination;
		const inspection = root.inspection;
		const report = {
			id: destination.id === null ? 'default' : destination.id,
			name: destination.name,
			path: destination.path,
			status: inspection.status,
			detail: inspection.detail,
			filesystemKey: inspection.filesystemKey,
			files: 0,
			durationMs: 0,
			complete: inspection.status === 'ok'
		};
		rootReports.push(report);
		if (!report.complete) {
			report.durationMs = Number(process.hrtime.bigint() - rootStartedAt) / 1e6;
			return;
		}

		let rootStat;
			try {
				rootStat = fileSystem.lstatSync(destination.path);
				if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
					report.complete = false;
					report.status = 'unsafe-root';
					report.durationMs = Number(process.hrtime.bigint() - rootStartedAt) / 1e6;
					return;
			}
		} catch (error) {
			report.complete = false;
			report.status = 'unavailable';
			report.detail = error.message;
			report.durationMs = Number(process.hrtime.bigint() - rootStartedAt) / 1e6;
			return;
		}

		const rootDevice = String(rootStat.dev);
		const queue = [destination.path];
		while (queue.length > 0) {
			const directory = queue.pop();
			visitedDirectories++;
			let entries;
			try {
				entries = fileSystem.readdirSync(directory, { withFileTypes: true });
			} catch (error) {
				report.complete = false;
				report.status = 'incomplete';
				report.detail = error.message;
				continue;
			}

			entries.forEach(entry => {
				const filename = path.join(directory, entry.name);
				if (!isWithin(destination.path, filename)) return;
				let stat;
				try { stat = fileSystem.lstatSync(filename); } catch (error) {
					report.complete = false;
					report.status = 'incomplete';
					report.detail = error.message;
					return;
				}
				if (stat.isSymbolicLink()) {
					skippedSymlinks++;
					return;
				}
				if (String(stat.dev) !== rootDevice) {
					skippedFilesystems++;
					return;
				}
				if (stat.isDirectory()) {
					queue.push(filename);
					return;
				}
				if (!stat.isFile() || !extensions.has(path.extname(entry.name).toLowerCase())) return;
				const item = {
					path: path.resolve(filename),
					name: entry.name,
					extension: path.extname(entry.name).toLowerCase(),
					rootId: report.id,
					rootPath: destination.path
				};
				files.push(item);
				byPath.set(item.path, item);
				if (!byName.has(item.name)) byName.set(item.name, []);
				byName.get(item.name).push(item);
				report.files++;
			});
			onProgress({ phase: 'indexing', rootId: report.id, visitedDirectories, files: files.length });
		}
		report.durationMs = Number(process.hrtime.bigint() - rootStartedAt) / 1e6;
	});

	return {
		files,
		byPath,
		byName,
		roots: rootReports,
		complete: rootReports.length > 0 && rootReports.every(root => root.complete),
		visitedDirectories,
		skippedSymlinks,
		skippedFilesystems,
		coveredRoots: rootState.covered.map(item => ({
			id: item.destination.id === null ? 'default' : item.destination.id,
			path: item.destination.path,
			coveredBy: item.coveredBy === null ? 'default' : item.coveredBy
		}))
	};
}

function findSplitCandidates(filename, index) {
	const extension = path.extname(filename);
	const stem = filename.slice(0, -extension.length);
	const pattern = new RegExp('^' + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:[._-](?:part)?\\d+)' + extension.replace('.', '\\.') + '$', 'i');
	return index.files.filter(file => pattern.test(file.name));
}

function makeImpact(program, ledgers, missingPolicy) {
	const reserves2 = ledgers.reserves2.filter(item => sameLedgerItem(item, program));
	const matches = ledgers.match.filter(item => matchEntryMatchesProgram(item, program));
	if (missingPolicy === 'keep-history') {
		return {
			recorded: 1,
			reserves: 0,
			reserves2: 0,
			matchKeep: matches.length,
			matchRemove: 0,
			updates: ['recorded.json', matches.length ? 'match.json' : null].filter(Boolean),
			note: 'reserves2 is retained as historical detail; match deletion reason would be missing-cleanup.'
		};
	}
	if (missingPolicy === 'remove-history') {
		return {
			recorded: 1,
			reserves: 0,
			reserves2: reserves2.length,
			matchKeep: 0,
			matchRemove: matches.length,
			updates: ['recorded.json', reserves2.length ? 'reserves2.json' : null,
				matches.length ? 'match.json' : null].filter(Boolean),
			note: 'reserves2 removal is required to prevent the same history from being regenerated.'
		};
	}
	return { recorded: 0, reserves: 0, reserves2: 0, matchKeep: 0, matchRemove: 0, updates: [], note: null };
}

function pathUpdatePreview(program, matchEntries, targetPath, destination, includeRecorded) {
	const updates = [];
	if (includeRecorded) updates.push({ ledger: 'recorded.json', index: null, fields: ['recorded'].concat(
		Object.prototype.hasOwnProperty.call(program, 'path') ? ['path'] : [],
		Object.prototype.hasOwnProperty.call(program, 'recordedDirId') ? ['recordedDirId'] : [],
		Object.prototype.hasOwnProperty.call(program, 'recordedDir') ? ['recordedDir'] : []
	), path: targetPath, recordedDirId: destination ? destination.id : null,
		recordedDir: destination ? destination.configuredPath : null });
	matchEntries.forEach(entry => {
		const fields = [];
		if (Number(entry && entry.schemaVersion) === 2) {
			fields.push('recording.path');
		} else {
			if (entry.program) fields.push('program.recorded', 'program.path');
			if (entry.recordingResult) fields.push('recordingResult.recorded', 'recordingResult.path');
			if (entry.recordingResult && entry.recordingResult.snapshot) {
				fields.push('recordingResult.snapshot.recorded', 'recordingResult.snapshot.path');
			}
		}
		updates.push({ ledger: 'match.json', key: matchDetailResolver.normalizeMatchEntry(entry).key, fields, path: targetPath });
	});
	return updates;
}

function buildPlan(options) {
	options = options || {};
	const normalizedOptions = normalizeOptions(options);
	const totalStartedAt = process.hrtime.bigint();
	const config = options.config || {};
	const ledgers = {
		recorded: Array.isArray(options.recorded) ? options.recorded : [],
		recording: Array.isArray(options.recording) ? options.recording : [],
		reserves: Array.isArray(options.reserves) ? options.reserves : [],
		reserves2: Array.isArray(options.reserves2) ? options.reserves2 : [],
		match: Array.isArray(options.match) ? options.match : []
	};
	const missingPolicy = normalizedOptions.missingPolicy;
	const cleanupMissed = normalizedOptions.cleanupMissed;
	const checkLocations = normalizedOptions.checkLocations;
	const normalizeLocations = normalizedOptions.normalizeLocations;
	const extensions = normalizedExtensions(config, ledgers.recorded);
	const roots = checkLocations ? inspectRoots(config, options) : Object.assign(prepareDestinations(config, options.selectedIds), { roots: [] });
	const enumerationStartedAt = process.hrtime.bigint();
	const index = checkLocations ? indexFiles(roots, extensions, options) : {
		files: [], byPath: new Map(), byName: new Map(), roots: [], complete: true,
		visitedDirectories: 0, skippedSymlinks: 0, skippedFilesystems: 0,
		coveredRoots: roots.covered.map(item => ({
			id: item.destination.id === null ? 'default' : item.destination.id,
			path: item.destination.path,
			coveredBy: item.coveredBy === null ? 'default' : item.coveredBy
		}))
	};
	const enumerationMs = Number(process.hrtime.bigint() - enumerationStartedAt) / 1e6;
	const reconciliationStartedAt = process.hrtime.bigint();
	const activePaths = new Set(ledgers.recording.map(recordedPath).filter(Boolean).map(value => path.resolve(value)));
	const activeIds = new Set(ledgers.recording.flatMap(programIds));
	const referencedPaths = new Set();
	const results = [];

	ledgers.recorded.forEach((program, itemIndex) => {
		const originalPath = recordedPath(program);
		const absolutePath = originalPath ? path.resolve(originalPath) : '';
		const ids = programIds(program);
		const title = program.fullTitle || program.title || '';
		const base = originalPath ? path.basename(originalPath) : '';
		const isActive = activePaths.has(absolutePath) || ids.some(id => activeIds.has(id));
		const isResumePending = program && program.operatorResumePending === true;
		const isCurrentOrFuture = positiveNumber(program && program.end) >= Date.now() ||
			ledgers.reserves.some(item => sameLedgerItem(item, program) && positiveNumber(item.end) >= Date.now());
		const current = absolutePath && index.byPath.get(absolutePath);
		const sameName = base ? (index.byName.get(base) || []) : [];
		const splits = base ? findSplitCandidates(base, index) : [];
		const matchingMatchEntries = ledgers.match.filter(entry => matchEntryMatchesProgram(entry, program));
		const matchPaths = Array.from(new Set(matchingMatchEntries.map(entry => {
			const normalized = matchDetailResolver.normalizeMatchEntry(entry);
			return normalized.recording && normalized.recording.path || '';
		}).filter(Boolean).map(value => path.resolve(value))));
		const ledgerPathMismatch = Boolean(absolutePath && matchPaths.some(value => value !== absolutePath));
		let classification;
		let candidates = [];
		let action = 'none';
		let automatic = false;
		let reason = '';

		if (!checkLocations) {
			classification = 'unchecked';
			reason = 'recording location check was not selected';
		} else if (current) {
			classification = 'ok';
			referencedPaths.add(current.path);
			candidates = sameName.filter(item => item.path !== current.path);
			if (ledgerPathMismatch) {
				action = normalizeLocations ? 'sync-match-path' : 'preview-match-path';
				automatic = normalizeLocations;
				reason = 'recorded path exists but match path differs';
			} else {
				reason = candidates.length ? 'recorded path exists; same-name files are informational only' : 'recorded path exists';
			}
		} else if (isActive || isResumePending || isCurrentOrFuture) {
			classification = 'recording';
			reason = isActive ? 'active or finalizing recording is never changed' :
				isResumePending ? 'resume-pending recording is never changed' : 'current or future reservation is never changed';
		} else if (sameName.length > 0) {
			candidates = sameName.map(candidate => Object.assign({}, candidate, { evidence: ['unique-same-filename'] }));
			candidates.forEach(candidate => referencedPaths.add(candidate.path));
			if (sameName.length > 1) {
				classification = 'ambiguous';
				reason = 'multiple same-name candidates';
			} else {
				classification = 'relocated';
				automatic = normalizeLocations;
				action = normalizeLocations ? 'normalize-location' : 'preview-location';
				reason = candidates[0].evidence.join(', ');
			}
		} else if (!index.complete) {
			classification = 'uninspected';
			reason = 'one or more selected recording roots were not completely scanned';
		} else {
			classification = 'missing';
			action = missingPolicy === 'report' ? 'report-missing' : missingPolicy;
			automatic = missingPolicy !== 'report';
			reason = 'all selected recording roots were scanned and no candidate was found';
		}

		const destination = candidates.length === 1 ? roots.configured.find(root => isWithin(root.path, candidates[0].path)) : null;
		const impact = classification === 'missing' ? makeImpact(program, ledgers, missingPolicy) :
			classification === 'relocated' ? {
				recorded: 0, reserves: 0, reserves2: 0, matchKeep: 0, matchRemove: 0,
				updates: ['recorded.json'].concat(ledgers.match.some(entry => matchEntryMatchesProgram(entry, program)) ? ['match.json'] : []),
				note: 'reserves2 destination metadata remains the original reservation destination.'
			} : makeImpact(program, ledgers, 'report');
		const pathTarget = classification === 'relocated' && candidates[0] ? candidates[0].path :
			ledgerPathMismatch && current ? current.path : null;

		results.push({
			ledger: 'recorded.json',
			index: itemIndex,
			id: ids[0] || null,
			ids,
			key: canonicalKey(program) || null,
			title,
			originalPath: originalPath || null,
			newPath: classification === 'relocated' && candidates[0] ? candidates[0].path : null,
			newRecordedDirId: destination ? (destination.id === null ? null : destination.id) : null,
			newRecordedDir: destination ? destination.configuredPath : null,
			ledgerPathMismatch,
			matchPaths,
			pathUpdates: pathTarget ? pathUpdatePreview(program, matchingMatchEntries, pathTarget, destination,
				classification === 'relocated') : [],
			classification,
			action,
			automatic,
			reason,
			candidates,
			splitCandidates: splits,
			impact
		});
	});

	const scheduledMatchEntries = new Set();
	const scheduledHistoryKeys = new Set();
	results.filter(item => item.automatic && item.action === 'remove-history').forEach(item => {
		if (item.key) scheduledHistoryKeys.add(item.key);
		ledgers.match.forEach((entry, entryIndex) => {
			if (planMatchesMatch(item, entry)) scheduledMatchEntries.add(entryIndex);
		});
	});
	ledgers.match.forEach((entry, entryIndex) => {
		if (scheduledMatchEntries.has(entryIndex)) return;
		const normalized = matchDetailResolver.normalizeMatchEntry(entry);
		const recordedMissing = Boolean(normalized.deletion && normalized.deletion.reason === 'recorded-missing');
		const deleted = isDeletedMatchEntry(entry);
		const skipped = normalized.status === 'SKIPPED_ONLY' && missingPolicy === 'remove-history';
		const missed = normalized.status === 'MISSED' && cleanupMissed;
		if (!recordedMissing && !deleted && !skipped && !missed) return;
		if (normalized.key && scheduledHistoryKeys.has(normalized.key)) return;
		const isCurrentOrFuture = positiveNumber(normalized.end) >= Date.now() || ledgers.reserves.some(program =>
			planMatchesProgram({ key: normalized.key, ids: matchEntryIds(entry) }, program) && positiveNumber(program.end) >= Date.now());
		const ids = matchEntryIds(entry);
		const hasEnded = positiveNumber(normalized.end) > 0 && positiveNumber(normalized.end) < Date.now();
		const hasRecordedLedger = ledgers.recorded.some(program => planMatchesProgram({ key: normalized.key, ids }, program));
		const isActive = ledgers.recording.some(program => planMatchesProgram({ key: normalized.key, ids }, program)) ||
			ids.some(id => activeIds.has(id)) || Boolean(normalized.recording && normalized.recording.path &&
			activePaths.has(path.resolve(normalized.recording.path)));
		const recordedMissingPath = recordedMissing && normalized.recording && normalized.recording.path ?
			path.resolve(normalized.recording.path) : '';
		const recordedMissingFile = checkLocations && recordedMissingPath ? index.byPath.get(recordedMissingPath) : null;
		const hasStableIdentity = Boolean(normalized.key || (deleted || recordedMissing) && ids.length > 0);
		const locationDecisionComplete = !checkLocations || index.complete;
		const automatic = missingPolicy === 'remove-history' && hasStableIdentity &&
			(deleted || recordedMissing || hasEnded) && !hasRecordedLedger && !isCurrentOrFuture && !isActive &&
			(!recordedMissing || locationDecisionComplete && !recordedMissingFile);
		const kind = recordedMissing ? 'recorded-missing-history' :
			deleted ? 'deleted-match' : skipped ? 'skipped-history' : 'missed-history';
		const action = recordedMissing ? 'remove-recorded-missing-history' :
			deleted ? 'remove-deleted-match' : skipped ? 'remove-skipped-history' : 'remove-missed-history';
		const classification = recordedMissingFile ? 'recorded-missing-found' :
			recordedMissing && checkLocations && !index.complete ? 'recorded-missing-uninspected' :
			automatic ? kind : isActive || isCurrentOrFuture ? kind + '-pending' :
				hasRecordedLedger ? kind + '-retained' : kind + '-held';
		const reserves2Affected = automatic ? ledgers.reserves2.filter(program =>
			planMatchesProgram({ key: normalized.key, ids }, program)).length : 0;
		if (normalized.key) scheduledHistoryKeys.add(normalized.key);
		results.push({
			ledger: 'match.json',
			index: entryIndex,
			id: ids[0] || null,
			ids,
			key: normalized.key || null,
			title: normalized.fullTitle || '',
			originalPath: normalized.recording && normalized.recording.path || null,
			newPath: null,
			classification,
			action: automatic ? action : 'none',
			automatic,
			reason: recordedMissingFile ? 'the exact recording.path exists in the scanned file index' :
				recordedMissing && checkLocations && !index.complete ? 'one or more selected recording roots were not completely scanned' :
				isActive ? 'active or finalizing recording is never changed' :
				isCurrentOrFuture ? 'current or future reservation is never changed' :
				hasRecordedLedger ? 'a recorded.json entry still refers to this history' :
				!hasStableIdentity ? 'a stable canonical identity is required before history can be removed' :
				!deleted && !recordedMissing && !hasEnded ? 'a confirmed broadcast end is required before history can be removed' :
					recordedMissing && !checkLocations ? 'recording location check was not selected; no file-presence claim was made' :
					recordedMissing ? 'all selected recording roots were scanned and the exact recording.path was not found' :
					deleted ? 'explicitly deleted match history' :
						skipped ? 'ended skipped reservation history' : 'ended reservation without recorded evidence',
			candidates: [], splitCandidates: [], ledgerPathMismatch: false, matchPaths: [], pathUpdates: [],
			impact: {
				recorded: 0,
				reserves: 0,
				reserves2: reserves2Affected,
				matchKeep: 0,
				matchRemove: automatic ? 1 : 0,
				updates: automatic ? [reserves2Affected ? 'reserves2.json' : null, 'match.json'].filter(Boolean) : [],
				note: 'The matching historical reserves2 entry is removed when present so the cleaned history is not regenerated.'
			}
		});
	});

	const summary = {
		total: ledgers.recorded.length,
		ok: results.filter(item => item.classification === 'ok').length,
		relocated: results.filter(item => item.classification === 'relocated').length,
		review: results.filter(item => item.classification === 'review').length,
		ambiguous: results.filter(item => item.classification === 'ambiguous').length,
		missing: results.filter(item => item.classification === 'missing').length,
		recording: results.filter(item => item.classification === 'recording').length,
		uninspected: results.filter(item => item.classification === 'uninspected').length,
		unchecked: results.filter(item => item.classification === 'unchecked').length,
		deletedMatch: results.filter(item => item.classification === 'deleted-match').length,
		deletedMatchHeld: results.filter(item => item.classification === 'deleted-match-held').length,
		recordedMissingHistory: results.filter(item => item.classification === 'recorded-missing-history').length,
		recordedMissingHistoryHeld: results.filter(item => item.classification === 'recorded-missing-history-held').length,
		recordedMissingFound: results.filter(item => item.classification === 'recorded-missing-found').length,
		recordedMissingUninspected: results.filter(item => item.classification === 'recorded-missing-uninspected').length,
		skippedHistory: results.filter(item => item.classification === 'skipped-history').length,
		skippedHistoryHeld: results.filter(item => item.classification === 'skipped-history-held').length,
		missedHistory: results.filter(item => item.classification === 'missed-history').length,
		missedHistoryHeld: results.filter(item => item.classification === 'missed-history-held').length,
		removalPrograms: new Set(results.filter(item => item.automatic && [
			'remove-history', 'remove-recorded-missing-history', 'remove-deleted-match', 'remove-skipped-history', 'remove-missed-history'
		].includes(item.action)).map(item => item.key || (item.ids || []).join('|') || item.id).filter(Boolean)).size,
		ledgerMismatch: results.filter(item => item.ledgerPathMismatch).length,
		duplicateHints: results.filter(item => item.candidates.length > 1 || item.classification === 'ok' && item.candidates.length > 0).length,
		splitHints: results.filter(item => item.splitCandidates.length > 0).length,
		unregisteredFiles: index.files.filter(file => !referencedPaths.has(file.path)).length,
		recordedRemove: results.reduce((sum, item) => sum + item.impact.recorded, 0),
		reservesAffected: results.reduce((sum, item) => sum + item.impact.reserves, 0),
		reserves2Affected: results.reduce((sum, item) => sum + item.impact.reserves2, 0),
		matchKeep: results.reduce((sum, item) => sum + item.impact.matchKeep, 0),
		matchRemove: results.reduce((sum, item) => sum + item.impact.matchRemove, 0)
	};
	const reconciliationMs = Number(process.hrtime.bigint() - reconciliationStartedAt) / 1e6;
	const timings = {
		enumerationMs,
		reconciliationMs,
		totalMs: Number(process.hrtime.bigint() - totalStartedAt) / 1e6,
		roots: index.roots.map(root => ({ id: root.id, path: root.path, durationMs: root.durationMs }))
	};

	const plan = {
		schemaVersion: 1,
		createdAt: Date.now(),
		dryRun: true,
		applyAvailable: true,
		options: { checkLocations, normalizeLocations, missingPolicy, cleanupMissed, selectedIds: normalizedOptions.selectedIds },
		sourceSignatures: options.sourceSignatures || null,
		extensions: Array.from(extensions).sort(),
		roots: index.roots,
		coveredRoots: index.coveredRoots,
		index: {
			files: index.files.length,
			visitedDirectories: index.visitedDirectories,
			skippedSymlinks: index.skippedSymlinks,
			skippedFilesystems: index.skippedFilesystems,
			complete: index.complete
		},
		timings,
		summary,
		results,
		unregisteredFiles: {
			count: summary.unregisteredFiles,
			action: 'none'
		},
		safety: {
			filesModified: false,
			ledgersModified: false,
			unregisteredFileAction: 'none',
			applyNote: 'Application requires unchanged ledgers and an identical re-scan immediately before writing.'
		}
	};
	plan.planToken = createPlanToken(plan);
	return plan;
}

function actionableProjection(plan) {
	return {
		options: plan.options,
		sources: Object.fromEntries(Object.entries(plan.sourceSignatures || {}).map(([name, value]) => [name, value.sha256])),
		results: (plan.results || []).filter(item => item.automatic).map(item => ({
			key: item.key,
			id: item.id,
			ids: item.ids,
			originalPath: item.originalPath,
			newPath: item.newPath,
			newRecordedDirId: item.newRecordedDirId,
			newRecordedDir: item.newRecordedDir,
			classification: item.classification,
			action: item.action
		}))
	};
}

function createPlanToken(plan) {
	return crypto.createHash('sha256').update(JSON.stringify(actionableProjection(plan))).digest('hex');
}

function allSignaturesFresh(signatures, fileSystem) {
	const checks = verifySourceSignatures(signatures, fileSystem);
	const stale = checks.filter(item => !item.fresh);
	if (stale.length > 0) {
		const error = new Error('Ledger data changed after preview: ' + stale.map(item => item.name).join(', '));
		error.code = 'CLEANER_PLAN_STALE';
		error.checks = checks;
		throw error;
	}
	return checks;
}

function planMatchesProgram(item, program) {
	const key = canonicalKey(program);
	if (item.key && key) return item.key === key;
	const ids = Array.isArray(item.ids) ? item.ids : [item.id].filter(Boolean);
	return ids.length > 0 && programIds(program).some(id => ids.includes(id));
}

function planMatchesMatch(item, entry) {
	const normalized = matchDetailResolver.normalizeMatchEntry(entry);
	if (item.key && normalized.key) return item.key === normalized.key;
	const ids = Array.isArray(item.ids) ? item.ids : [item.id].filter(Boolean);
	return Boolean(normalized.recording && normalized.recording.recordedId && ids.includes(normalized.recording.recordedId));
}

function updateRecordedPath(program, item) {
	program.recorded = item.newPath;
	if (Object.prototype.hasOwnProperty.call(program, 'path')) program.path = item.newPath;
	if (Object.prototype.hasOwnProperty.call(program, 'recordedDirId')) program.recordedDirId = item.newRecordedDirId;
	if (Object.prototype.hasOwnProperty.call(program, 'recordedDir')) program.recordedDir = item.newRecordedDir;
}

function updatePathContainer(container, newPath) {
	if (!container || typeof container !== 'object') return false;
	let changed = false;
	if (Object.prototype.hasOwnProperty.call(container, 'recorded')) { container.recorded = newPath; changed = true; }
	if (Object.prototype.hasOwnProperty.call(container, 'path')) { container.path = newPath; changed = true; }
	return changed;
}

function updateMatchPath(entry, newPath) {
	if (Number(entry && entry.schemaVersion) === 2 && entry.recording && typeof entry.recording === 'object') {
		entry.recording.path = newPath;
		return true;
	}
	let changed = updatePathContainer(entry && entry.program, newPath);
	changed = updatePathContainer(entry && entry.recorded, newPath) || changed;
	changed = updatePathContainer(entry && entry.recordingResult, newPath) || changed;
	changed = updatePathContainer(entry && entry.recordingResult && entry.recordingResult.snapshot, newPath) || changed;
	return changed;
}

function buildLedgerOutputs(ledgers, plan) {
	const output = {
		recorded: cloneJson(ledgers.recorded),
		reserves2: cloneJson(ledgers.reserves2),
		match: cloneJson(ledgers.match)
	};
	const counts = {
		pathRepaired: 0, recordedRemoved: 0, matchRemoved: 0, reserves2Removed: 0,
		programsRemoved: 0, recordedHistoryRemoved: 0, deletedMatchHistoryRemoved: 0,
		recordedMissingHistoryRemoved: 0, skippedHistoryRemoved: 0, missedHistoryRemoved: 0,
		thumbnailDeleted: 0, thumbnailRetained: 0, thumbnailFailed: 0, held: 0
	};
	const thumbnailIds = new Set();
	const removedPrograms = new Set();
	function countRemovedProgram(item, field) {
		const identity = item.key || (item.ids || []).join('|') || item.id;
		if (!identity || removedPrograms.has(identity)) return;
		removedPrograms.add(identity);
		counts.programsRemoved++;
		counts[field]++;
	}

	(plan.results || []).filter(item => item.action === 'normalize-location' || item.action === 'sync-match-path').forEach(item => {
		if (!item.automatic) {
			return;
		}
		if (item.action === 'normalize-location') {
			output.recorded.filter(program => planMatchesProgram(item, program)).forEach(program => updateRecordedPath(program, item));
		}
		output.match.forEach(entry => {
			if (planMatchesMatch(item, entry)) updateMatchPath(entry, item.newPath || item.originalPath);
		});
		counts.pathRepaired++;
	});

	(plan.results || []).filter(item => item.automatic && item.action === 'remove-history').forEach(item => {
		const beforeRecorded = output.recorded.length;
		const beforeReserves2 = output.reserves2.length;
		const beforeMatch = output.match.length;
		output.match.filter(entry => planMatchesMatch(item, entry)).forEach(entry => matchEntryIds(entry).forEach(id => thumbnailIds.add(id)));
		output.recorded = output.recorded.filter(program => !planMatchesProgram(item, program));
		output.reserves2 = output.reserves2.filter(program => !planMatchesProgram(item, program));
		output.match = output.match.filter(entry => !planMatchesMatch(item, entry));
		counts.recordedRemoved += beforeRecorded - output.recorded.length;
		counts.reserves2Removed += beforeReserves2 - output.reserves2.length;
		counts.matchRemoved += beforeMatch - output.match.length;
		if (beforeRecorded !== output.recorded.length || beforeReserves2 !== output.reserves2.length || beforeMatch !== output.match.length) {
			countRemovedProgram(item, 'recordedHistoryRemoved');
		}
	});

	(plan.results || []).filter(item => item.automatic && [
		'remove-recorded-missing-history', 'remove-deleted-match', 'remove-skipped-history', 'remove-missed-history'
	].includes(item.action)).forEach(item => {
		const beforeReserves2 = output.reserves2.length;
		const beforeMatch = output.match.length;
		output.match.filter(entry => planMatchesMatch(item, entry)).forEach(entry => matchEntryIds(entry).forEach(id => thumbnailIds.add(id)));
		output.reserves2 = output.reserves2.filter(program => !planMatchesProgram(item, program));
		output.match = output.match.filter(entry => !planMatchesMatch(item, entry));
		counts.reserves2Removed += beforeReserves2 - output.reserves2.length;
		counts.matchRemoved += beforeMatch - output.match.length;
		if (beforeReserves2 !== output.reserves2.length || beforeMatch !== output.match.length) {
			countRemovedProgram(item, item.action === 'remove-recorded-missing-history' ? 'recordedMissingHistoryRemoved' :
				item.action === 'remove-deleted-match' ? 'deletedMatchHistoryRemoved' :
				item.action === 'remove-skipped-history' ? 'skippedHistoryRemoved' : 'missedHistoryRemoved');
		}
	});

	(plan.results || []).forEach(item => {
		if (!item.automatic && ['ambiguous', 'review', 'uninspected', 'deleted-match-held',
			'recorded-missing-history-held', 'recorded-missing-uninspected',
			'skipped-history-held', 'missed-history-held'].includes(item.classification)) counts.held++;
	});

	return { output, counts, thumbnailIds: Array.from(thumbnailIds) };
}

function cleanupRemovedThumbnails(rootDir, built, fileSystem) {
	const thumbnailDirectory = path.join(rootDir, 'data', 'thumbnails');
	const errors = [];
	built.thumbnailIds.forEach(id => {
		const stillReferenced = built.output.recorded.some(program => programIds(program).includes(id)) ||
			built.output.reserves2.some(program => programIds(program).includes(id)) ||
			built.output.match.some(entry => matchEntryIds(entry).includes(id));
		if (stillReferenced) {
			built.counts.thumbnailRetained++;
			return;
		}
		try {
			const outcome = recordedThumbnail.removeStoredThumbnail(thumbnailDirectory, id, fileSystem);
			if (outcome.removed) built.counts.thumbnailDeleted++;
		} catch (error) {
			built.counts.thumbnailFailed++;
			errors.push({ id, code: error.code || 'thumbnail-delete-failed', message: error.message });
		}
	});
	return errors;
}

function writeTextDurable(file, text, fileSystem) {
	fileSystem = fileSystem || fs;
	const descriptor = fileSystem.openSync(file, 'wx', 0o600);
	try {
		fileSystem.writeFileSync(descriptor, text);
		fileSystem.fsyncSync(descriptor);
	} finally {
		fileSystem.closeSync(descriptor);
	}
}

function writeManifest(file, value, fileSystem) {
	fileSystem = fileSystem || fs;
	const temporary = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
	fileSystem.writeFileSync(temporary, JSON.stringify(value, null, 2));
	fileSystem.renameSync(temporary, file);
}

function applyPlan(rootDir, expectedPlan, options) {
	options = options || {};
	const fileSystem = options.fs || fs;
	const applyStartedAt = process.hrtime.bigint();
	if (!expectedPlan || !expectedPlan.planToken || expectedPlan.planToken !== createPlanToken(expectedPlan)) {
		throw new Error('A valid cleaner preview is required');
	}
	if (!expectedPlan.index || expectedPlan.index.complete !== true || expectedPlan.options.selectedIds) {
		throw new Error('Every registered recording root must be scanned successfully before apply');
	}
	if (expectedPlan.options.missingPolicy === 'keep-history') {
		throw new Error('History-preserving cleanup is not supported by this apply operation');
	}

	allSignaturesFresh(expectedPlan.sourceSignatures, fileSystem);
	const current = loadLedgers(rootDir, fileSystem);
	const refreshed = buildPlan(Object.assign({}, current, expectedPlan.options, { fs: fileSystem }));
	if (refreshed.planToken !== expectedPlan.planToken) {
		const error = new Error('Filesystem or ledger decisions changed after preview');
		error.code = 'CLEANER_PLAN_STALE';
		throw error;
	}

	const files = {
		recorded: path.join(rootDir, 'data/recorded.json'),
		reserves2: path.join(rootDir, 'data/reserves2.json'),
		match: path.join(rootDir, 'data/match.json')
	};
	const locks = [];
	const ledgerUpdateStartedAt = process.hrtime.bigint();
	try {
		['recorded', 'reserves2', 'match'].forEach(name => locks.push(reservationStore.acquire(files[name])));
		allSignaturesFresh(expectedPlan.sourceSignatures, fileSystem);
		const lockedLedgers = {
			recorded: readArray(files.recorded, fileSystem),
			reserves2: readArray(files.reserves2, fileSystem),
			match: readArray(files.match, fileSystem)
		};
		const built = buildLedgerOutputs(lockedLedgers, refreshed);
		const changedNames = Object.keys(files).filter(name => JSON.stringify(lockedLedgers[name]) !== JSON.stringify(built.output[name]));
		if (changedNames.length === 0) {
			return { status: 'complete', planToken: expectedPlan.planToken, counts: built.counts,
				errors: 0, thumbnailErrors: [], changedLedgers: [], backupDirectory: null,
				durationMs: Number(process.hrtime.bigint() - ledgerUpdateStartedAt) / 1e6,
				timings: Object.assign({}, refreshed.timings, {
					ledgerUpdateMs: Number(process.hrtime.bigint() - ledgerUpdateStartedAt) / 1e6,
					totalMs: Number(process.hrtime.bigint() - applyStartedAt) / 1e6
				}) };
		}

		const transactionId = new Date().toISOString().replace(/[-:.TZ]/g, '') + '-' + expectedPlan.planToken.slice(0, 10);
		const backupDirectory = path.join(rootDir, 'data', 'ledger-cleaner-backups', transactionId);
		fileSystem.mkdirSync(backupDirectory, { recursive: true });
		const manifestFile = path.join(backupDirectory, 'manifest.json');
		const backupNames = changedNames.filter(name => name !== 'match');
		const manifest = {
			schemaVersion: 1, transactionId, status: 'prepared', planToken: expectedPlan.planToken,
			createdAt: Date.now(), changedLedgers: changedNames, backedUpLedgers: backupNames,
			completedLedgers: [], error: null
		};
		backupNames.forEach(name => writeTextDurable(path.join(backupDirectory, name + '.json'),
			JSON.stringify(lockedLedgers[name]), fileSystem));
		writeManifest(manifestFile, manifest, fileSystem);

		try {
			changedNames.forEach(name => {
				reservationStore.writeArrayAtomic(files[name], built.output[name]);
				manifest.completedLedgers.push(name);
				manifest.status = 'writing';
				writeManifest(manifestFile, manifest, fileSystem);
			});
			manifest.status = 'complete';
			manifest.completedAt = Date.now();
			writeManifest(manifestFile, manifest, fileSystem);
		} catch (error) {
			const rollbackErrors = [];
			changedNames.forEach(name => {
				try { reservationStore.writeArrayAtomic(files[name], lockedLedgers[name]); }
				catch (rollbackError) { rollbackErrors.push(name + ': ' + rollbackError.message); }
			});
			manifest.status = rollbackErrors.length ? 'rollback-failed' : 'rolled-back';
			manifest.error = error.message;
			manifest.rollbackErrors = rollbackErrors;
			writeManifest(manifestFile, manifest, fileSystem);
			throw error;
		}

		const thumbnailErrors = cleanupRemovedThumbnails(rootDir, built, fileSystem);
		const ledgerUpdateMs = Number(process.hrtime.bigint() - ledgerUpdateStartedAt) / 1e6;
		return {
			status: 'complete', planToken: expectedPlan.planToken, counts: built.counts,
			errors: thumbnailErrors.length, thumbnailErrors,
			changedLedgers: changedNames, backupDirectory,
			durationMs: ledgerUpdateMs,
			timings: Object.assign({}, refreshed.timings, {
				ledgerUpdateMs,
				totalMs: Number(process.hrtime.bigint() - applyStartedAt) / 1e6
			})
		};
	} finally {
		while (locks.length > 0) locks.pop().release();
	}
}

function loadLedgers(rootDir, fileSystem) {
	fileSystem = fileSystem || fs;
	const files = {
		recorded: path.join(rootDir, 'data/recorded.json'),
		recording: path.join(rootDir, 'data/recording.json'),
		reserves: path.join(rootDir, 'data/reserves.json'),
		reserves2: path.join(rootDir, 'data/reserves2.json'),
		match: path.join(rootDir, 'data/match.json')
	};
	const snapshots = {};
	Object.keys(files).forEach(name => { snapshots[name] = readArraySnapshot(files[name], fileSystem); });
	return {
		config: JSON.parse(fileSystem.readFileSync(path.join(rootDir, 'config.json'), 'utf8')),
		recorded: snapshots.recorded.value,
		recording: snapshots.recording.value,
		reserves: snapshots.reserves.value,
		reserves2: snapshots.reserves2.value,
		match: snapshots.match.value,
		sourceSignatures: Object.fromEntries(Object.entries(snapshots).map(([name, snapshot]) => [name, snapshot.signature]))
	};
}

module.exports = {
	MISSING_POLICIES,
	applyPlan,
	buildPlan,
	canonicalKey,
	cloneJson,
	createPlanToken,
	inspectRoots,
	loadLedgers,
	matchEntryMatchesProgram,
	normalizeOptions,
	prepareDestinations,
	readArray,
	readArraySnapshot,
	sameLedgerItem,
	verifySourceSignatures
};
