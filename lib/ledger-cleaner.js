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
		normalizeLocations: missingPolicy !== 'report' && options.checkLocations !== false && options.normalizeLocations === true,
		missingPolicy,
		cleanupMissed: missingPolicy === 'remove-history' && options.cleanupMissed === true,
		selectedIds: options.selectedIds || null
	};
}

function cloneJson(value) {
	return JSON.parse(JSON.stringify(value));
}

function readArray(file, fileSystem = fs, descriptor = file) {
	const value = JSON.parse(fileSystem.readFileSync(descriptor, 'utf8') || '[]');
	if (!Array.isArray(value)) throw new TypeError(path.basename(file) + ' must contain an array');
	return value;
}

function readArraySnapshot(file, fileSystem) {
	const fd = fileSystem.openSync(file, 'r');
	try {
		// Atomic replacement leaves this descriptor on a complete version.
		const before = fileSystem.fstatSync(fd);
		const value = readArray(file, fileSystem, fd);
		const after = fileSystem.fstatSync(fd);
		if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
			throw new Error(path.basename(file) + ' changed while it was being read');
		}
		return value;
	} finally {
		fileSystem.closeSync(fd);
	}
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
	return stringValue(program && program.recorded);
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
	const reference = normalized.recording || normalized.fileMissing;
	return reference && reference.recordedId ? [reference.recordedId] : [];
}

function createIdentityIndex(values, describe) {
	const byKey = new Map();
	const byId = new Map();
	const byIdWithoutKey = new Map();
	const descriptors = values.map((value, index) => {
		const identity = describe(value, index);
		const descriptor = Object.assign({ value, index }, identity, {
			key: stringValue(identity.key),
			ids: Array.from(new Set((identity.ids || []).filter(Boolean)))
		});
		if (descriptor.key) {
			if (!byKey.has(descriptor.key)) byKey.set(descriptor.key, []);
			byKey.get(descriptor.key).push(descriptor);
		}
		descriptor.ids.forEach(id => {
			if (!byId.has(id)) byId.set(id, []);
			byId.get(id).push(descriptor);
			if (!descriptor.key) {
				if (!byIdWithoutKey.has(id)) byIdWithoutKey.set(id, []);
				byIdWithoutKey.get(id).push(descriptor);
			}
		});
		return descriptor;
	});
	return { descriptors, byKey, byId, byIdWithoutKey };
}

function createProgramIndex(programs) {
	return createIdentityIndex(programs, program => ({ key: canonicalKey(program), ids: programIds(program) }));
}

function createMatchIndex(entries) {
	return createIdentityIndex(entries, entry => {
		const normalized = matchDetailResolver.normalizeMatchEntry(entry);
		return {
			key: normalized.key,
			ids: (normalized.recording || normalized.fileMissing || {}).recordedId ? [(normalized.recording || normalized.fileMissing).recordedId] : [],
			normalized
		};
	});
}

function findIdentityDescriptors(index, key, ids) {
	const matches = [];
	const seen = new Set();
	function append(descriptors) {
		(descriptors || []).forEach(descriptor => {
			if (seen.has(descriptor.index)) return;
			seen.add(descriptor.index);
			matches.push(descriptor);
		});
	}
	key = stringValue(key);
	ids = Array.from(new Set((ids || []).filter(Boolean)));
	if (key) {
		append(index.byKey.get(key));
		ids.forEach(id => append(index.byIdWithoutKey.get(id)));
	} else {
		ids.forEach(id => append(index.byId.get(id)));
	}
	return matches.sort((a, b) => a.index - b.index);
}

// Mutations require the same recording identity, not merely the same broadcast key.
// If an ID is absent, a key match is usable only when it is unique in both ledgers.
function sameIndexedIdentity(source, target, sourceIndex, targetIndex) {
	if (source.key && target.key && source.key !== target.key) return false;
	const sourceId = (source.ids || [])[0];
	const targetId = (target.ids || [])[0];
	if (sourceId && targetId) return sourceId === targetId;
	if (!source.key || source.key !== target.key) return false;
	return (sourceIndex.byKey.get(source.key) || []).length === 1 &&
		(targetIndex.byKey.get(target.key) || []).length === 1;
}

// Per-plan indexes: rebuilt from the same captured ledgers, never cached across jobs.
function pathIndex(descriptors, getPath) {
	const paths = new Map();
	for (const descriptor of descriptors) {
		const value = getPath(descriptor);
		if (!value) continue;
		const absolute = path.resolve(value);
		if (!paths.has(absolute)) paths.set(absolute, []);
		paths.get(absolute).push(descriptor);
	}
	return paths;
}

function isWithin(root, target) {
	const relative = path.relative(root, target);
	return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function fileIdentity(stat) {
	return [String(stat.dev), String(stat.ino)].join(':');
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
	const splitByOriginalName = new Map();
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
			identity: rootIdentity(root),
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
					rootPath: destination.path,
					identity: fileIdentity(stat)
				};
				files.push(item);
				byPath.set(item.path, item);
				if (!byName.has(item.name)) byName.set(item.name, []);
				byName.get(item.name).push(item);
				const stem = item.name.slice(0, item.extension ? -item.extension.length : undefined);
				const split = item.extension && stem.match(/^(.*)[._-](?:part)?\d+$/i);
				if (split) {
					const originalName = (split[1] + item.extension).toLowerCase();
					if (!splitByOriginalName.has(originalName)) splitByOriginalName.set(originalName, []);
					splitByOriginalName.get(originalName).push(item);
				}
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
		splitByOriginalName,
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
	return index.splitByOriginalName.get(filename.toLowerCase()) || [];
}

function makeImpact(program, indexes, missingPolicy) {
	if (missingPolicy === 'report') {
		return { recorded: 0, reserves: 0, reserves2: 0, matchKeep: 0, matchRemove: 0, updates: [], note: null };
	}
	const reserves2 = findIdentityDescriptors(indexes.reserves2, program.key, program.ids)
		.filter(item => sameIndexedIdentity(program, item, indexes.recorded, indexes.reserves2));
	const matches = findIdentityDescriptors(indexes.match, program.key, program.ids)
		.filter(item => sameIndexedIdentity(program, item, indexes.recorded, indexes.match));
	if (missingPolicy === 'keep-history') {
		return {
			recorded: 0,
			reserves: 0,
			reserves2: 0,
			matchKeep: matches.length,
			matchRemove: 0,
			updates: matches.length ? ['match.json'] : [],
			note: 'History is retained; confirmed absence is stored only in match.fileMissing.'
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

function pathUpdatePreview(program, targetPath, destination) {
	return [{ ledger: 'recorded.json', index: null, fields: ['recorded'].concat(
		Object.prototype.hasOwnProperty.call(program, 'path') ? ['path'] : [],
		Object.prototype.hasOwnProperty.call(program, 'recordedDirId') ? ['recordedDirId'] : [],
		Object.prototype.hasOwnProperty.call(program, 'recordedDir') ? ['recordedDir'] : []
	), path: targetPath, recordedDirId: destination ? destination.id : null,
		recordedDir: destination ? destination.configuredPath : null }];
}

function scanLocations(config, recorded, options) {
	const { checkLocations } = options;
	const extensions = normalizedExtensions(config, recorded);
	const roots = checkLocations ? inspectRoots(config, options) : Object.assign(prepareDestinations(config, options.selectedIds), { roots: [] });
	const enumerationStartedAt = process.hrtime.bigint();
	const index = checkLocations ? indexFiles(roots, extensions, options) : {
		files: [], byPath: new Map(), byName: new Map(), splitByOriginalName: new Map(), roots: [], complete: true,
		visitedDirectories: 0, skippedSymlinks: 0, skippedFilesystems: 0,
		coveredRoots: roots.covered.map(item => ({
			id: item.destination.id === null ? 'default' : item.destination.id,
			path: item.destination.path,
			coveredBy: item.coveredBy === null ? 'default' : item.coveredBy
		}))
	};
	return { roots, index, extensions, enumerationMs: Number(process.hrtime.bigint() - enumerationStartedAt) / 1e6 };
}

function buildPlan(options = {}) {
	const startedAt = process.hrtime.bigint();
	const settings = normalizeOptions(options);
	const ledgers = {};
	for (const name of ['recorded', 'recording', 'reserves', 'reserves2', 'match']) {
		ledgers[name] = Array.isArray(options[name]) ? options[name] : [];
	}
	const scan = scanLocations(options.config || {}, ledgers.recorded, { ...options, ...settings });
	const reconciliationStartedAt = process.hrtime.bigint();
	const { results, referencedPaths } = reconcileLedgers(ledgers, settings, scan);
	return previewPlan(ledgers, settings, scan, results, referencedPaths, startedAt, reconciliationStartedAt);
}

function reconcileLedgers(ledgers, settings, { roots, index }, approved) {
	const { missingPolicy, cleanupMissed, checkLocations, normalizeLocations } = settings;
	const ledgerIndexes = {
		recorded: createProgramIndex(ledgers.recorded),
		recording: createProgramIndex(ledgers.recording),
		reserves: createProgramIndex(ledgers.reserves),
		reserves2: createProgramIndex(ledgers.reserves2),
		match: createMatchIndex(ledgers.match)
	};
	const recordedPathClaims = pathIndex(ledgerIndexes.recorded.descriptors, item => recordedPath(item.value));
	const recordedNameCounts = new Map();
	for (const claims of recordedPathClaims.values()) {
		const name = path.basename(recordedPath(claims[0].value));
		recordedNameCounts.set(name, (recordedNameCounts.get(name) || 0) + claims.length);
	}
	const activePaths = new Set(ledgerIndexes.recording.descriptors.map(descriptor => recordedPath(descriptor.value))
		.filter(Boolean).map(value => path.resolve(value)));
	const now = Date.now();
	const isActiveRecording = descriptor => ledgerIndexes.recording.byKey.has(descriptor.key) ||
		descriptor.ids.some(id => ledgerIndexes.recording.byId.has(id));
	const isLive = item => Math.max(positiveNumber(item.value.end),
		matchDetailResolver.parseCanonicalKey(item.key)?.end || 0) >= now;
	const hasLiveReservation = descriptor => (ledgerIndexes.reserves.byKey.get(descriptor.key) || []).some(isLive) ||
		descriptor.ids.some(id => (ledgerIndexes.reserves.byId.get(id) || []).some(isLive));
	const isApproved = (ledger, descriptor) => !approved || approved.has(sourceIdentity(ledger, descriptor));
	const referencedPaths = new Set();
	const results = [];

	ledgerIndexes.recorded.descriptors.forEach(descriptor => {
		if (!isApproved('recorded.json', descriptor)) return;
		const program = descriptor.value;
		const itemIndex = descriptor.index;
		const originalPath = recordedPath(program);
		const absolutePath = originalPath ? path.resolve(originalPath) : '';
		const ids = descriptor.ids;
		const title = program.fullTitle || program.title || '';
		const base = originalPath ? path.basename(originalPath) : '';
		const isActive = activePaths.has(absolutePath) || isActiveRecording(descriptor);
		const isResumePending = program && program.operatorResumePending === true;
		const isCurrentOrFuture = isLive(descriptor) || hasLiveReservation(descriptor);
		const current = absolutePath && index.byPath.get(absolutePath);
		const sameName = base ? (index.byName.get(base) || []) : [];
		const splits = base ? findSplitCandidates(base, index) : [];
		const matchingMatchDescriptors = findIdentityDescriptors(ledgerIndexes.match, descriptor.key, ids)
			.filter(item => matchDetailResolver.matchesRecordedProgram(item.value, program));
		const terminal = matchingMatchDescriptors.some(item => matchDetailResolver.isExplicitDeletion(item.value));
		if (terminal) return; // Deleted recordings are never searched, repaired, or restored.
		let classification;
		let candidates = [];
		let action = 'none';
		let automatic = false;
		let reason = '';

		if (!checkLocations) {
			classification = 'unchecked';
			reason = 'recording location check was not selected';
		} else if (isActive || isResumePending || isCurrentOrFuture) {
			if (current) referencedPaths.add(current.path);
			classification = 'recording';
			reason = isActive ? 'active or finalizing recording is never changed' :
				isResumePending ? 'resume-pending recording is never changed' : 'current or future reservation is never changed';
		} else if (current) {
			classification = 'ok';
			referencedPaths.add(current.path);
			candidates = sameName.filter(item => item.path !== current.path);
			reason = candidates.length ? 'recorded path exists; same-name files are informational only' : 'recorded path exists';
		} else if (sameName.length > 0) {
			candidates = sameName.map(candidate => Object.assign({}, candidate, { evidence: ['unique-same-filename'] }));
			candidates.forEach(candidate => referencedPaths.add(candidate.path));
			if (sameName.length > 1 || splits.length || recordedNameCounts.get(base) > 1 ||
				activePaths.has(candidates[0].path) || recordedPathClaims.has(candidates[0].path)) {
				classification = 'ambiguous';
				reason = 'the candidate has competing files or a ledger claim';
			} else {
				classification = 'relocated';
				automatic = normalizeLocations;
				action = normalizeLocations ? 'normalize-location' : 'preview-location';
				reason = candidates[0].evidence.join(', ');
			}
		} else if (splits.length || (recordedPathClaims.get(absolutePath) || []).length > 1) {
			classification = 'ambiguous';
			reason = 'split files or duplicate ledger paths require review';
		} else if (!index.complete || !absolutePath || !roots.configured.some(root => isWithin(root.path, absolutePath))) {
			classification = 'uninspected';
			reason = 'the recording location was outside the completed scan scope';
		} else {
			classification = 'missing';
			action = missingPolicy === 'report' ? 'report-missing' : missingPolicy;
			automatic = missingPolicy !== 'report';
			reason = 'all selected recording roots were scanned and no candidate was found';
		}

		if (missingPolicy !== 'report') {
			const matchDescriptor = matchingMatchDescriptors.length === 1 ? matchingMatchDescriptors[0] : null;
			const match = matchDescriptor && matchDescriptor.normalized;
			const reference = match && (match.recording || match.fileMissing);
			const conflictingPath = (recordedPathClaims.get(absolutePath) || []).some(other => other.index !== itemIndex);
			const identified = Boolean(!conflictingPath && matchDescriptor && Number(matchDescriptor.value.schemaVersion) === 2 &&
				match.key && match.key === descriptor.key && reference && reference.recordedId &&
				reference.recordedId === String(program.id));
			const safeScope = roots.configured.some(root => isWithin(root.path, absolutePath)) &&
				!index.skippedSymlinks && !index.skippedFilesystems;
			if (classification === 'missing' && missingPolicy === 'keep-history') {
				automatic = Boolean(identified && safeScope && !splits.length && !match.fileMissing);
				action = automatic ? 'mark-file-missing' : 'none';
				if (!automatic && !(identified && match.fileMissing)) { classification = 'uninspected'; reason = 'file identity or complete search scope cannot be confirmed'; }
			} else if (identified && match.fileMissing &&
				(classification === 'ok' || classification === 'relocated' && normalizeLocations)) {
				const foundPath = classification === 'ok' ? absolutePath : candidates[0].path;
				const claimed = (recordedPathClaims.get(foundPath) || []).some(other => other.index !== itemIndex);
				if (!claimed && sameName.length <= 1 && !splits.length) { action = 'restore-file'; automatic = true; }
			}
			if (match?.fileMissing && action !== 'restore-file' && action === 'normalize-location') {
				action = 'none'; automatic = false; classification = 'review';
				reason = 'missing recording requires unambiguous verified recovery';
			}
		}
		const destination = candidates.length === 1 ? roots.configured.find(root => isWithin(root.path, candidates[0].path)) : null;
		const impact = classification === 'missing' ? makeImpact(descriptor, ledgerIndexes, missingPolicy) :
			classification === 'relocated' ? {
				recorded: 0, reserves: 0, reserves2: 0, matchKeep: 0, matchRemove: 0,
				updates: ['recorded.json'],
				note: 'reserves2 destination metadata remains the original reservation destination.'
			} : makeImpact(descriptor, ledgerIndexes, 'report');
		const pathTarget = classification === 'relocated' && candidates[0] ? candidates[0].path : null;
		const targetFile = pathTarget ? candidates[0] : current;

		results.push({
			ledger: 'recorded.json',
			index: itemIndex,
			id: ids[0] || null,
			ids,
			key: descriptor.key || null,
			title,
			originalPath: originalPath || null,
			newPath: classification === 'relocated' && candidates[0] ? candidates[0].path : null,
			newRecordedDirId: destination ? (destination.id === null ? null : destination.id) : null,
			newRecordedDir: destination ? destination.configuredPath : null,
			fileIdentity: targetFile ? targetFile.identity : null,
			ledgerPathMismatch: false,
			matchPaths: [],
			pathUpdates: pathTarget ? pathUpdatePreview(program, pathTarget, destination) : [],
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
	results.filter(item => item.automatic && item.action === 'remove-history').forEach(item => {
		findIdentityDescriptors(ledgerIndexes.match, item.key, item.ids)
			.filter(descriptor => sameIndexedIdentity(item, descriptor, ledgerIndexes.recorded, ledgerIndexes.match))
			.forEach(descriptor => scheduledMatchEntries.add(descriptor.index));
	});
	ledgerIndexes.match.descriptors.forEach(descriptor => {
		if (!isApproved('match.json', descriptor)) return;
		const entry = descriptor.value;
		const entryIndex = descriptor.index;
		if (scheduledMatchEntries.has(entryIndex)) return;
		const normalized = descriptor.normalized;
		// Match-only history has no authoritative recording file path. Do not
		// infer an absence or restore a recorded.json row from old match data.
		const recordedMissing = Boolean(normalized.deletion && normalized.deletion.reason === 'recorded-missing');
		const deleted = Boolean(normalized.deletion && normalized.deletion.reason !== 'recorded-missing');
		const skipped = normalized.status === 'SKIPPED_ONLY' && missingPolicy === 'remove-history';
		const missed = normalized.status === 'MISSED' && cleanupMissed;
		if (!recordedMissing && !deleted && !skipped && !missed) return;

		const ids = descriptor.ids;
		const isCurrentOrFuture = isLive(descriptor) || normalized.end >= now || hasLiveReservation(descriptor);
		const hasEnded = positiveNumber(normalized.end) > 0 && positiveNumber(normalized.end) < now;
		const hasRecordedLedger = findIdentityDescriptors(ledgerIndexes.recorded, normalized.key, ids)
			.some(program => sameIndexedIdentity(descriptor, program, ledgerIndexes.match, ledgerIndexes.recorded));
		const isActive = isActiveRecording(descriptor);
		const hasStableIdentity = Boolean(normalized.key || deleted && ids.length > 0);
		// A recorded-missing row may be cleared as history, without claiming that its file is absent.
		const uniqueMissingHistory = !recordedMissing || Boolean(normalized.key &&
			(ledgerIndexes.match.byKey.get(normalized.key) || []).length === 1);
		const automatic = missingPolicy === 'remove-history' && hasStableIdentity && uniqueMissingHistory &&
			(deleted || hasEnded) && !hasRecordedLedger && !isCurrentOrFuture && !isActive;
		const kind = recordedMissing ? 'recorded-missing-history' :
			deleted ? 'deleted-match' : skipped ? 'skipped-history' : 'missed-history';
		const action = recordedMissing ? 'remove-recorded-missing-history' :
			deleted ? 'remove-deleted-match' : skipped ? 'remove-skipped-history' : 'remove-missed-history';
		const classification = automatic ? kind : isActive || isCurrentOrFuture ? kind + '-pending' :
				hasRecordedLedger ? kind + '-retained' : kind + '-held';
		const reserves2Affected = automatic ?
			findIdentityDescriptors(ledgerIndexes.reserves2, normalized.key, ids)
				.filter(item => sameIndexedIdentity(descriptor, item, ledgerIndexes.match, ledgerIndexes.reserves2)).length : 0;
		results.push({
			ledger: 'match.json',
			index: entryIndex,
			id: ids[0] || null,
			ids,
			key: normalized.key || null,
			title: normalized.fullTitle || '',
			originalPath: null,
			newPath: null,
			classification,
			action: automatic ? action : 'none',
			automatic,
			reason: isActive ? 'active or finalizing recording is never changed' :
				isCurrentOrFuture ? 'current or future reservation is never changed' :
				hasRecordedLedger ? 'a recorded.json entry still refers to this history' :
				!hasStableIdentity || !uniqueMissingHistory ? 'a unique canonical identity is required before history can be removed' :
				recordedMissing ? 'match-only history cleanup; no file absence or location is inferred' :
				!deleted && !recordedMissing && !hasEnded ? 'a confirmed broadcast end is required before history can be removed' :
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

	const actions = new Map();
	for (const item of results) {
		if (!item.automatic) continue;
		const source = item.ledger === 'recorded.json' ? 'recorded' : 'match';
		const descriptor = ledgerIndexes[source].descriptors[item.index];
		const identity = sourceIdentity(item.ledger, descriptor);
		const duplicates = (descriptor.key ? ledgerIndexes[source].byKey.get(descriptor.key) :
			(ledgerIndexes[source].byId.get(item.id) || []))
			.filter(other => sourceIdentity(item.ledger, other) === identity);
		const targets = relatedTargets(item, ledgerIndexes);
		const protectedTarget = targets.reserves2.some(target => !positiveNumber(target.value.end) ||
			isLive(target) || target.value.operatorResumePending === true ||
			isActiveRecording(target) || hasLiveReservation(target)) ||
			(item.action === 'remove-history' && targets.match.some(target =>
				isLive(target) || target.normalized.end >= now || isActiveRecording(target) || hasLiveReservation(target)));
		if ((!item.key && !item.id) || duplicates.length !== 1 || protectedTarget) {
			item.automatic = false;
			item.action = 'none';
			item.classification = 'review';
			item.reason = 'the ledger identity is ambiguous or a related entry is protected';
			item.impact = makeImpact(descriptor, ledgerIndexes, 'report');
			continue;
		}
		item.scope = targetScope(targets);
		actions.set(item, targets);
	}
	return { results, referencedPaths, ledgerIndexes, actions };
}

function previewPlan(ledgers, settings, { index, extensions, enumerationMs }, results, referencedPaths, startedAt, reconciliationStartedAt) {
	const summary = {
		total: ledgers.recorded.length,
		ok: results.filter(item => item.classification === 'ok').length,
		relocated: results.filter(item => item.classification === 'relocated').length,
		review: results.filter(item => item.classification === 'review').length,
		ambiguous: results.filter(item => item.classification === 'ambiguous').length,
		fileStates: results.filter(item => item.automatic && ['mark-file-missing', 'restore-file'].includes(item.action)).length,
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
		].includes(item.action)).map(item => [item.key || '', item.id || (item.ids || []).join('|')].join('|')).filter(Boolean)).size,
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
		totalMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
		roots: index.roots.map(root => ({ id: root.id, path: root.path, durationMs: root.durationMs }))
	};

	const plan = {
		schemaVersion: 1,
		createdAt: Date.now(),
		dryRun: true,
		applyAvailable: true,
		options: settings,
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
			applyNote: 'Only reviewed actions that remain safe in the latest ledgers and filesystem are applied.'
		}
	};
	plan.planToken = createPlanToken(plan);
	return plan;
}

function sourceIdentity(ledger, descriptor) {
	return JSON.stringify([ledger, descriptor.key || null, descriptor.ids[0] || null]);
}

function relatedDescriptors(item, indexes, ledger) {
	const source = item.ledger === 'recorded.json' ? indexes.recorded : indexes.match;
	return findIdentityDescriptors(indexes[ledger], item.key, item.ids)
		.filter(target => sameIndexedIdentity(item, target, source, indexes[ledger]));
}

function relatedTargets(item, indexes) {
	const source = item.ledger === 'recorded.json' ? indexes.recorded : indexes.match;
	const related = ledger => relatedDescriptors(item, indexes, ledger);
	const removal = item.action.startsWith('remove-');
	return {
		recorded: item.ledger === 'recorded.json' ? [source.descriptors[item.index]] : [],
		reserves2: removal ? related('reserves2') : [],
		match: item.ledger === 'match.json' ? [source.descriptors[item.index]] :
			['mark-file-missing', 'restore-file'].includes(item.action)
				? related('match').filter(target => target.key === item.key && target.ids[0] === item.id)
				: related('match')
	};
}

function targetScope(targets) {
	return Object.fromEntries(['reserves2', 'match'].map(ledger => [ledger,
		targets[ledger].map(target => sourceIdentity(ledger, target)).sort()]));
}

function createPlanToken(plan) {
	return crypto.createHash('sha256').update(JSON.stringify({
		options: plan.options,
		complete: plan.index?.complete,
		roots: plan.roots.map(root => [root.path, root.identity]),
		results: plan.results.filter(item => item.automatic).map(item => [
			sourceIdentity(item.ledger, item), item.action, item.originalPath,
			item.newPath, item.newRecordedDirId, item.newRecordedDir, item.fileIdentity, item.scope
		])
	})).digest('hex');
}

function updateRecordedPath(program, item) {
	program.recorded = item.newPath;
	if (Object.prototype.hasOwnProperty.call(program, 'path')) program.path = item.newPath;
	if (Object.prototype.hasOwnProperty.call(program, 'recordedDirId')) program.recordedDirId = item.newRecordedDirId;
	if (Object.prototype.hasOwnProperty.call(program, 'recordedDir')) program.recordedDir = item.newRecordedDir;
}


const HELD_CLASSIFICATIONS = new Set(['ambiguous', 'review', 'uninspected', 'deleted-match-held',
	'recorded-missing-history-held', 'recorded-missing-uninspected', 'skipped-history-held', 'missed-history-held']);

function buildLedgerOutputs(ledgers, actions, held) {
	const output = {};
	const counts = {
		fileMissing: 0, fileRestored: 0, pathRepaired: 0, recordedRemoved: 0, matchRemoved: 0, reserves2Removed: 0,
		programsRemoved: 0, recordedHistoryRemoved: 0, deletedMatchHistoryRemoved: 0,
		recordedMissingHistoryRemoved: 0, skippedHistoryRemoved: 0, missedHistoryRemoved: 0,
		thumbnailDeleted: 0, thumbnailRetained: 0, thumbnailFailed: 0, held
	};
	const thumbnailIds = new Set();
	const removedPrograms = new Set();
	const changedLedgers = new Set();
	const removals = { recorded: new Map(), reserves2: new Map(), match: new Map() };
	const paths = new Map();
	const facts = new Map();
	for (const [item, targets] of actions) {
		if (item.action.startsWith('remove-')) {
			for (const ledger of Object.keys(removals)) {
				for (const target of targets[ledger]) removals[ledger].set(target.index, target);
			}
			const identity = JSON.stringify([item.key, item.id]);
			if (removedPrograms.has(identity)) continue;
			removedPrograms.add(identity);
			counts.programsRemoved++;
			const field = {
				'remove-history': 'recordedHistoryRemoved',
				'remove-recorded-missing-history': 'recordedMissingHistoryRemoved',
				'remove-deleted-match': 'deletedMatchHistoryRemoved',
				'remove-skipped-history': 'skippedHistoryRemoved',
				'remove-missed-history': 'missedHistoryRemoved'
			}[item.action];
			counts[field]++;
			continue;
		}
		if (item.newPath) paths.set(targets.recorded[0].index, item);
		for (const target of targets.match) facts.set(target.index, item);
	}

	for (const ledger of Object.keys(removals)) {
		output[ledger] = [];
		ledgers[ledger].forEach((value, index) => {
			const removal = removals[ledger].get(index);
			if (removal) {
				counts[ledger + 'Removed']++;
				changedLedgers.add(ledger);
				if (ledger === 'match') removal.ids.forEach(id => thumbnailIds.add(id));
				return;
			}
			if (ledger === 'recorded' && paths.has(index)) {
				value = cloneJson(value);
				updateRecordedPath(value, paths.get(index));
				counts.pathRepaired++;
				changedLedgers.add(ledger);
			}
			if (ledger === 'match' && facts.has(index)) {
				const item = facts.get(index);
				const entry = matchDetailResolver.withoutRecordingPaths(value);
				if (item.action === 'mark-file-missing') {
					entry.fileMissing = { recordedId: item.id, checkedAt: Date.now() };
					counts.fileMissing++;
				} else if (item.action === 'restore-file') {
					entry.recording = { ...entry.recording, recordedId: item.id };
					delete entry.fileMissing;
					counts.fileRestored++;
				}
				if (JSON.stringify(entry) !== JSON.stringify(value)) changedLedgers.add(ledger);
				value = entry;
			}
			output[ledger].push(value);
		});
	}

	return { output, counts, thumbnailIds: Array.from(thumbnailIds), changedLedgers };
}

function cleanupRemovedThumbnails(rootDir, built, fileSystem) {
	const thumbnailDirectory = path.join(rootDir, 'data', 'thumbnails');
	const errors = [];
	const referencedIds = new Set();
	built.output.recorded.forEach(program => programIds(program).forEach(id => referencedIds.add(id)));
	built.output.reserves2.forEach(program => programIds(program).forEach(id => referencedIds.add(id)));
	built.output.match.forEach(entry => matchEntryIds(entry).forEach(id => referencedIds.add(id)));
	built.thumbnailIds.forEach(id => {
		if (referencedIds.has(id)) {
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

function ledgerFiles(rootDir) {
	return Object.fromEntries(['recorded', 'recording', 'reserves', 'reserves2', 'match']
		.map(name => [name, path.join(rootDir, 'data', name + '.json')]));
}

function readConfig(rootDir, fileSystem) {
	return JSON.parse(fileSystem.readFileSync(path.join(rootDir, 'config.json'), 'utf8'));
}

async function withCleanerLocks(files, prepare, callback) {
	let scan = prepare();
	let deadline = Date.now() + 45000;
	// Scheduler locks reserves before reserves2. Operator's recording snapshot
	// is published under its own lock and never acquires other locks inside it.
	const order = ['maintenance', 'recorded', 'reserves', 'reserves2', 'match', 'recording'];
	let contention;
	while (!contention || Date.now() < deadline) {
		const locks = [];
		let blocked;
		try {
			for (const name of order) {
				try {
					locks.push(reservationStore.acquire(files[name], { timeoutMs: 0 }));
				} catch (error) {
					if (error.code !== 'RESERVATION_LOCK_TIMEOUT' || Date.now() >= deadline) throw error;
					contention = error;
					blocked = name;
					break;
				}
			}
			if (!blocked) return callback(scan);
		} finally {
			while (locks.length) locks.pop().release();
		}
		await reservationStore.withLockAsync(files[blocked], () => {}, { timeoutMs: deadline - Date.now(), retryMs: 100 });
		if (Date.now() >= deadline) break;
		// Changes elsewhere in the tree (including new same-name candidates)
		// cannot be inferred from an lstat of the previously selected path.
		// The scan runs without locks and does not consume the lock wait budget.
		const scanStartedAt = Date.now();
		scan = prepare();
		deadline += Date.now() - scanStartedAt;
	}
	throw contention;
}

function rootIdentity(root) {
	const { inspection } = root;
	return [inspection.rootIdentity, inspection.mountFingerprint, inspection.resolvedPath];
}

function sameRoots(reports, roots) {
	const byPath = new Map(roots.map(root => [root.destination.path, root]));
	return reports.length === roots.length && reports.every(report => {
		const root = byPath.get(report.path);
		return root?.inspection.status === 'ok' && JSON.stringify(report.identity) === JSON.stringify(rootIdentity(root));
	});
}

function checkLocation(file, roots, fileSystem, expectedIdentity) {
	if (!file) return 'unsafe';
	const absolute = path.resolve(file);
	const root = roots.find(item => isWithin(item.destination.path, absolute));
	if (!root) return 'unsafe';
	const rootPath = root.destination.path;
	let parent = rootPath;
	try {
		const stat = fileSystem.lstatSync(rootPath);
		if (!stat.isDirectory()) return 'unsafe';
		const relative = path.relative(rootPath, absolute);
		if (!relative) return 'unsafe';
		const parts = relative.split(path.sep);
		for (const [index, part] of parts.entries()) {
			parent = path.join(parent, part);
			const entry = fileSystem.lstatSync(parent);
			if (stat.dev !== entry.dev) return 'unsafe';
			if (index === parts.length - 1) {
				return entry.isFile() && (!expectedIdentity || expectedIdentity === fileIdentity(entry)) ? 'file' : 'unsafe';
			}
			if (!entry.isDirectory()) return 'unsafe';
		}
	} catch (error) {
		if (error.code === 'ENOENT' && parent !== rootPath) return 'absent';
	}
	return 'unsafe';
}

function scopeIncludes(approved, targets) {
	return Object.keys(targets).every(ledger => {
		const remaining = new Map();
		for (const identity of approved[ledger]) remaining.set(identity, (remaining.get(identity) || 0) + 1);
		return targets[ledger].every(identity => {
			const count = remaining.get(identity);
			if (!count) return false;
			remaining.set(identity, count - 1);
			return true;
		});
	});
}

function selectActions(ledgers, expected, scan, currentRoots, fileSystem) {
	const { roots } = currentRoots;
	const approved = new Map(expected.results.filter(item => item.automatic)
		.map(item => [sourceIdentity(item.ledger, item), item]));
	const { results, ledgerIndexes, actions } = reconcileLedgers(ledgers, expected.options, { ...scan, roots: currentRoots }, approved);
	const byIdentity = new Map(results.map(item => [sourceIdentity(item.ledger, item), item]));
	const locationSafe = scan.index.complete && sameRoots(scan.index.roots, roots) && sameRoots(expected.roots, roots);
	const selected = new Map();
	let held = expected.results.filter(item => !item.automatic && HELD_CLASSIFICATIONS.has(item.classification)).length;
	for (const [identity, reviewed] of approved) {
		const item = byIdentity.get(identity);
		const targets = actions.get(item);
		const unchangedPath = item?.originalPath === reviewed.originalPath;
		const sameAction = targets && item.action === reviewed.action && unchangedPath &&
			item.newPath === reviewed.newPath && item.newRecordedDirId === reviewed.newRecordedDirId &&
			item.newRecordedDir === reviewed.newRecordedDir && item.fileIdentity === reviewed.fileIdentity;
		const isRecorded = reviewed.ledger === 'recorded.json';
		if (sameAction && scopeIncludes(reviewed.scope, item.scope)) {
			if (!isRecorded || locationSafe && (item.newPath
				? checkLocation(item.originalPath, roots, fileSystem) === 'absent' &&
					checkLocation(item.newPath, roots, fileSystem, item.fileIdentity) === 'file'
				: checkLocation(item.originalPath, roots, fileSystem, item.fileIdentity) === (item.action === 'restore-file' ? 'file' : 'absent'))) {
				selected.set(item, targets);
				continue;
			}
		}

		const source = isRecorded ? ledgerIndexes.recorded : ledgerIndexes.match;
		const candidates = reviewed.id ? (source.byId.get(reviewed.id) || []) : (source.byKey.get(reviewed.key) || []);
		if (!item && candidates.length === 0 && reviewed.action.startsWith('remove-')) {
			// An already removed source is a no-op if its approved dependent
			// rows are also gone. Retain any incomplete cross-ledger cleanup.
			if (!relatedDescriptors(reviewed, ledgerIndexes, 'reserves2').length &&
				(!isRecorded || !relatedDescriptors(reviewed, ledgerIndexes, 'match').length)) continue;
		}
		if (item && locationSafe) {
			const located = item.classification === 'ok' &&
				checkLocation(item.originalPath, roots, fileSystem) === 'file';
			if (reviewed.action === 'normalize-location' && located) continue;
			if (reviewed.action === 'restore-file' && located &&
				relatedDescriptors(reviewed, ledgerIndexes, 'match').some(target =>
					target.key === reviewed.key && target.ids[0] === reviewed.id &&
					target.normalized.recording && !target.normalized.fileMissing && !target.normalized.deletion)) continue;
			if (reviewed.action === 'mark-file-missing' && unchangedPath && item.classification === 'missing' &&
				!item.automatic && !item.candidates.length &&
				checkLocation(item.originalPath, roots, fileSystem) === 'absent') continue;
		}
		held++;
	}
	return buildLedgerOutputs(ledgers, selected, held);
}

async function applyPlan(rootDir, expected, options = {}) {
	const fileSystem = options.fs || fs;
	const startedAt = process.hrtime.bigint();
	if (!expected?.planToken || expected.planToken !== createPlanToken(expected)) {
		throw new Error('A valid cleaner preview is required');
	}
	if (expected.options.missingPolicy === 'report') throw new Error('Report mode is read-only');
	if (expected.index?.complete !== true || expected.options.selectedIds) {
		throw new Error('Every registered recording root must be scanned successfully before apply');
	}

	const files = ledgerFiles(rootDir);
	const maintenance = path.join(rootDir, 'data/recorded-file-maintenance');
	let enumerationMs = 0;
	const { built, changedLedgers, reconciliationMs, ledgerUpdateMs } = await withCleanerLocks({ ...files, maintenance }, () => {
		const scan = scanLocations(readConfig(rootDir, fileSystem), readArraySnapshot(files.recorded, fileSystem),
			{ ...expected.options, fs: fileSystem });
		enumerationMs += scan.enumerationMs;
		return scan;
	}, scan => {
		if (require('./recorded-folder-maintenance').pendingId(rootDir) !== null) {
			throw new Error('未完了の振り分けを復旧してから台帳整理を適用してください。');
		}
		const updateStartedAt = process.hrtime.bigint();
		const ledgers = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, readArray(file, fileSystem)]));
		const roots = expected.options.checkLocations
			? inspectRoots(readConfig(rootDir, fileSystem), { fs: fileSystem }) : scan.roots;
		const built = selectActions(ledgers, expected, scan, roots, fileSystem);
		const reconciliationMs = Number(process.hrtime.bigint() - updateStartedAt) / 1e6;
		const changedLedgers = ['recorded', 'reserves2', 'match'].filter(name => built.changedLedgers.has(name));
		const written = [];
		try {
			for (const name of changedLedgers) {
				reservationStore.writeArrayAtomic(files[name], built.output[name]);
				written.push(name);
			}
		} catch (error) {
			const rollbackErrors = [];
			for (const name of written.reverse()) {
				try { reservationStore.writeArrayAtomic(files[name], ledgers[name]); }
				catch (rollbackError) { rollbackErrors.push(name + ': ' + rollbackError.message); }
			}
			if (rollbackErrors.length) {
				error.rollbackErrors = rollbackErrors;
				error.message += '; rollback failed: ' + rollbackErrors.join(', ');
			}
			throw error;
		}
		return { built, changedLedgers, reconciliationMs,
			ledgerUpdateMs: Number(process.hrtime.bigint() - updateStartedAt) / 1e6 };
	});
	const thumbnailErrors = built.thumbnailIds.length ? cleanupRemovedThumbnails(rootDir, built, fileSystem) : [];
	return {
		status: 'complete', planToken: expected.planToken, counts: built.counts,
		errors: thumbnailErrors.length, thumbnailErrors, changedLedgers, durationMs: ledgerUpdateMs,
		timings: { enumerationMs, reconciliationMs, ledgerUpdateMs, totalMs: Number(process.hrtime.bigint() - startedAt) / 1e6 }
	};
}

function loadLedgers(rootDir, fileSystem = fs) {
	const ledgers = Object.fromEntries(Object.entries(ledgerFiles(rootDir))
		.map(([name, file]) => [name, readArraySnapshot(file, fileSystem)]));
	return { config: readConfig(rootDir, fileSystem), ...ledgers };
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
	sameLedgerItem
};
