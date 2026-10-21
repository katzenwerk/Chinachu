'use strict';

const fs = require('fs');
const path = require('path');

const matchDeletionHistory = require('./match-deletion-history');
const storageHealth = require('./storage-health');

function getPhase(freeMB, cleanupThresholdMB, warningThresholdMB, warningEnabled) {
	if (freeMB < cleanupThresholdMB) {
		return 'cleanup';
	}

	if (warningEnabled === true && Number.isFinite(warningThresholdMB) &&
		warningThresholdMB > cleanupThresholdMB && freeMB < warningThresholdMB) {
		return 'warning';
	}

	return null;
}

function stopCurrentRecordings(recording, stopRecording, shouldStop, onUnknown) {
	recording.slice().forEach(program => {
		const decision = typeof shouldStop === 'function' ? shouldStop(program) : true;
		if (decision === true) {
			stopRecording(program.id, 'LOW STORAGE');
		} else if (decision === null && typeof onUnknown === 'function') {
			onUnknown(program);
		}
	});
}

function normalizeAction(value) {
	return value === 'remove' || value === 'stop-new' ? value : 'stop';
}

function shouldStopCurrentRecordings(action, cleanupFailed) {
	return action === 'stop' || (action === 'remove' && cleanupFailed === true);
}

function isCleanupTargetFile(filePath) {
	const ext = path.extname(filePath).toLowerCase();
	return ext === '.ts' || ext === '.m2ts';
}

function filesystemKeyFromStat(stats) {
	const filesystemId = stats && storageHealth.linuxDeviceId(stats.dev);
	return filesystemId ? 'linux-dev:' + filesystemId : null;
}

function isWithin(parentPath, childPath) {
	const relative = path.relative(parentPath, childPath);
	return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function uniqueRoots(roots) {
	const result = [];
	Array.from(new Set((roots || []).filter(Boolean).map(root => path.resolve(root))))
		.sort((left, right) => left.length - right.length || left.localeCompare(right))
		.forEach(root => {
			if (!result.some(parent => isWithin(parent, root))) result.push(root);
		});
	return result;
}

function reportScanError(options, operation, targetPath, error) {
	if (typeof options.onError === 'function') options.onError(operation, targetPath, error);
}

function hasSymlinkComponent(fsImpl, targetPath, options, operation) {
	const absolute = path.resolve(targetPath);
	const parsed = path.parse(absolute);
	const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
	let current = parsed.root;
	for (let index = 0; index < parts.length; index++) {
		current = path.join(current, parts[index]);
		try {
			if (fsImpl.lstatSync(current, { bigint: true }).isSymbolicLink()) return true;
		} catch (error) {
			reportScanError(options, operation, current, error);
			return true;
		}
	}
	return false;
}

// Candidate discovery is deliberately ledger-independent. It only walks
// configured recording roots that still belong to the low filesystem.
function findCleanupCandidates(options) {
	options = options || {};
	const fsImpl = options.fs || fs;
	const filesystemKey = options.filesystemKey;
	const protectedPaths = new Set(Array.from(options.protectedPaths || []).map(filePath => path.resolve(filePath)));
	const candidates = new Map();
	if (!filesystemKey) return [];

	uniqueRoots(options.roots).forEach(root => {
		let rootStats;
		if (hasSymlinkComponent(fsImpl, root, options, 'root-path-stat')) return;
		try {
			rootStats = fsImpl.lstatSync(root, { bigint: true });
		} catch (error) {
			reportScanError(options, 'root-stat', root, error);
			return;
		}
		if (rootStats.isSymbolicLink() || !rootStats.isDirectory() || filesystemKeyFromStat(rootStats) !== filesystemKey) return;

		const pending = [ root ];
		while (pending.length > 0) {
			const directory = pending.pop();
			let names;
			try {
				names = fsImpl.readdirSync(directory);
			} catch (error) {
				reportScanError(options, 'read-dir', directory, error);
				continue;
			}

			names.forEach(name => {
				const filePath = path.join(directory, name);
				let stats;
				try {
					stats = fsImpl.lstatSync(filePath, { bigint: true });
				} catch (error) {
					reportScanError(options, 'entry-stat', filePath, error);
					return;
				}
				if (stats.isSymbolicLink() || filesystemKeyFromStat(stats) !== filesystemKey) return;
				if (stats.isDirectory()) {
					pending.push(filePath);
					return;
				}
				if (!stats.isFile() || !isCleanupTargetFile(filePath) || protectedPaths.has(path.resolve(filePath))) return;
				candidates.set(path.resolve(filePath), {
					path: filePath,
					root: root,
					name: path.relative(root, filePath),
					mtimeMs: Number(stats.mtimeMs),
					size: Number(stats.size)
				});
			});
		}
	});

	const sorted = Array.from(candidates.values()).sort((left, right) =>
		left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
	const limit = Number(options.limit);
	return Number.isFinite(limit) && limit > 0 ? sorted.slice(0, limit) : sorted;
}

// Recheck scope, symlinks, filesystem identity, extension and active-file
// protection immediately before Operator performs unlinkSync().
function validateCleanupCandidate(candidate, options) {
	options = options || {};
	const fsImpl = options.fs || fs;
	const filePath = candidate && path.resolve(candidate.path || '');
	const roots = uniqueRoots(options.roots);
	const root = roots.find(value => isWithin(value, filePath));
	const protectedPaths = new Set(Array.from(options.protectedPaths || []).map(value => path.resolve(value)));
	if (!candidate || !filePath || !root || !options.filesystemKey || protectedPaths.has(filePath) || !isCleanupTargetFile(filePath)) {
		return null;
	}

	const relative = path.relative(root, filePath);
	let current = root;
	const parts = relative.split(path.sep).filter(Boolean);
	let rootStats;
	if (hasSymlinkComponent(fsImpl, root, options, 'delete-root-path-stat')) return null;
	try {
		rootStats = fsImpl.lstatSync(root, { bigint: true });
	} catch (error) {
		reportScanError(options, 'delete-root-stat', root, error);
		return null;
	}
	if (rootStats.isSymbolicLink() || !rootStats.isDirectory() ||
		filesystemKeyFromStat(rootStats) !== options.filesystemKey) return null;
	for (let index = 0; index < parts.length; index++) {
		current = path.join(current, parts[index]);
		let stats;
		try {
			stats = fsImpl.lstatSync(current, { bigint: true });
		} catch (error) {
			reportScanError(options, 'delete-stat', current, error);
			return null;
		}
		if (stats.isSymbolicLink() || filesystemKeyFromStat(stats) !== options.filesystemKey) return null;
		if (index < parts.length - 1 && !stats.isDirectory()) return null;
		if (index === parts.length - 1) {
			if (!stats.isFile()) return null;
			return Object.assign({}, candidate, {
				path: current,
				root: root,
				name: path.relative(root, current),
				mtimeMs: Number(stats.mtimeMs),
				size: Number(stats.size)
			});
		}
	}
	return null;
}

function resolvePositiveNumber(value, fallback) {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveStorageThresholds(config) {
	config = config || {};
	const cleanupThresholdMB = resolvePositiveNumber(config.storageLowSpaceThresholdMB, 3000);
	const warningThresholdMB = resolvePositiveNumber(config.storageLowSpaceWarningThresholdMB, null);
	const legacyWarningDisabled = config.storageLowSpaceWarningEnabled === false;

	return {
		cleanupThresholdMB,
		warningThresholdMB,
		warningEnabled: !legacyWarningDisabled && warningThresholdMB !== null &&
			warningThresholdMB > cleanupThresholdMB,
		legacyWarningDisabled
	};
}

function shouldBlockRecordingStart(runtime, filesystemId) {
	return Boolean(runtime && runtime.stopNewRecordings === true && runtime.targetFilesystemId &&
		filesystemId && runtime.targetFilesystemId === filesystemId);
}

function markMatchRecordingDeleted(items, recordedEntries, filePath, deletedAt, cleanupReason) {
	return matchDeletionHistory.markDeleted(items, {
		recordedEntries,
		path: filePath,
		deletedAt,
		reason: cleanupReason
	}).changed;
}

module.exports = {
	getPhase,
	findCleanupCandidates,
	isCleanupTargetFile,
	markMatchRecordingDeleted,
	normalizeAction,
	resolvePositiveNumber,
	resolveStorageThresholds,
	shouldBlockRecordingStart,
	shouldStopCurrentRecordings,
	validateCleanupCandidate,
	stopCurrentRecordings
};
