'use strict';

const fs = require('fs');
const path = require('path');

const MOUNTINFO_PATH = '/proc/self/mountinfo';

function decodeMountField(value) {
	return String(value || '').replace(/\\([0-7]{3})/g, function (_, octal) {
		return String.fromCharCode(parseInt(octal, 8));
	});
}

function normalizePath(value) {
	return path.resolve(String(value || ''));
}

// Linux dev_t uses a split major/minor bit layout. The resulting value is a
// runtime identity only; it must not be persisted as a physical disk ID.
function linuxDeviceId(dev) {
	let value;
	try {
		value = typeof dev === 'bigint' ? dev : BigInt(dev);
	} catch (_) {
		return null;
	}
	if (value < 0n) {
		return null;
	}

	const major = ((value >> 8n) & 0xfffn) | ((value >> 32n) & 0xfffff000n);
	const minor = (value & 0xffn) | ((value >> 12n) & 0xffffff00n);
	return major.toString() + ':' + minor.toString();
}

function statPath(targetPath, fsImpl) {
	try {
		return fsImpl.statSync(targetPath, { bigint: true });
	} catch (error) {
		// Small test doubles and old Node-compatible fs implementations may not
		// accept the bigint option. Preserve their original error when possible.
		if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'ELOOP')) {
			throw error;
		}
		return fsImpl.statSync(targetPath);
	}
}

function inodeId(stat) {
	if (!stat || typeof stat.ino === 'undefined') {
		return null;
	}
	try {
		return String(stat.ino);
	} catch (_) {
		return null;
	}
}

function isWithin(parentPath, childPath) {
	const relative = path.relative(parentPath, childPath);
	return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function parseMountInfo(contents) {
	return String(contents || '').split('\n').reduce(function (mounts, line) {
		if (!line) {
			return mounts;
		}

		const separator = line.indexOf(' - ');
		if (separator === -1) {
			return mounts;
		}

		const before = line.slice(0, separator).split(' ');
		const after = line.slice(separator + 3).split(' ');
		if (before.length < 6 || after.length < 2) {
			return mounts;
		}

		mounts.push({
			mountId: before[0],
			parentId: before[1],
			filesystemId: before[2],
			root: decodeMountField(before[3]),
			mountPoint: normalizePath(decodeMountField(before[4])),
			mountOptions: before[5].split(','),
			filesystemType: after[0],
			source: decodeMountField(after[1]),
			superOptions: (after[2] || '').split(',')
		});

		return mounts;
	}, []).sort(function (a, b) {
		return b.mountPoint.length - a.mountPoint.length;
	});
}

function readMountInfo(fsImpl) {
	try {
		return {
			available: true,
			mounts: parseMountInfo(fsImpl.readFileSync(MOUNTINFO_PATH, 'utf8')),
			error: null
		};
	} catch (error) {
		return {
			available: false,
			mounts: [],
			error: error
		};
	}
}

function findMount(mounts, targetPath) {
	const normalized = normalizePath(targetPath);
	return mounts.find(function (mount) {
		return isWithin(mount.mountPoint, normalized);
	}) || null;
}

function findExactMount(mounts, targetPath) {
	const normalized = normalizePath(targetPath);
	return mounts.find(function (mount) {
		return mount.mountPoint === normalized;
	}) || null;
}

function findBrokenLink(targetPath, fsImpl) {
	const absolute = normalizePath(targetPath);
	const parsed = path.parse(absolute);
	const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
	let current = parsed.root;

	for (let i = 0; i < parts.length; i++) {
		current = path.join(current, parts[i]);
		let stat;
		try {
			stat = fsImpl.lstatSync(current);
		} catch (error) {
			if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
				return false;
			}
			if (error.code === 'ELOOP') {
				return true;
			}
			throw error;
		}

		if (stat.isSymbolicLink()) {
			try {
				fsImpl.realpathSync(current);
			} catch (error) {
				if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'ELOOP') {
					return true;
				}
				throw error;
			}
		}
	}

	return false;
}

function findNearestExistingPath(targetPath, fsImpl) {
	let current = normalizePath(targetPath);
	while (true) {
		try {
			statPath(current, fsImpl);
			return current;
		} catch (error) {
			if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
				return null;
			}
		}

		const parent = path.dirname(current);
		if (parent === current) {
			return null;
		}
		current = parent;
	}
}

function getExpectedMount(storage) {
	if (!storage || typeof storage.expectedMount !== 'string' || storage.expectedMount.trim() === '') {
		return null;
	}
	return normalizePath(storage.expectedMount.trim());
}

function getDestinations(config) {
	const destinations = [];
	const seen = new Map();

	function add(destination) {
		if (!destination.path || typeof destination.path !== 'string') {
			return;
		}
		const normalized = normalizePath(destination.path);
		const expectedMount = getExpectedMount(destination.storage);
		if (seen.has(normalized)) {
			const existing = seen.get(normalized);
			if (destination.id && !existing.aliasIds.includes(destination.id)) {
				existing.aliasIds.push(destination.id);
			}
			if (existing.expectedMount === null && expectedMount !== null) {
				existing.expectedMount = expectedMount;
				existing.protected = true;
			} else if (expectedMount !== null && existing.expectedMount !== expectedMount) {
				existing.expectedMountConflict = true;
			}
			return;
		}
		const item = Object.assign({}, destination, {
			configuredPath: destination.path,
			path: normalized,
			expectedMount: expectedMount,
			protected: expectedMount !== null,
			aliasIds: destination.id ? [ destination.id ] : []
		});
		seen.set(normalized, item);
		destinations.push(item);
	}

	add({
		id: null,
		name: 'Default',
		path: config.recordedDir,
		storage: config.recordedStorage || null,
		isDefault: true
	});

	if (Array.isArray(config.recordedDirs)) {
		config.recordedDirs.forEach(function (destination) {
			if (!destination || typeof destination !== 'object') {
				return;
			}
			add({
				id: destination.id || null,
				name: destination.name || destination.id || destination.path,
				path: destination.path,
				storage: destination.storage || null,
				isDefault: false
			});
		});
	}

	return destinations;
}

function numberOrNull(value) {
	const number = Number(value);
	return Number.isFinite(number) && number >= 0 ? number : null;
}

function inspectDestination(destination, options) {
	options = options || {};
	const fsImpl = options.fs || fs;
	const platform = options.platform || process.platform;
	const mountInfo = options.mountInfo || (platform === 'linux' ? readMountInfo(fsImpl) : {
		available: false,
		mounts: [],
		error: null
	});
	const checkCapacity = options.checkCapacity !== false;
	const result = {
		id: destination.id,
		name: destination.name,
		path: destination.path,
		configuredPath: destination.configuredPath,
		resolvedPath: null,
		expectedMount: destination.expectedMount,
		protected: destination.expectedMount !== null,
		status: 'unknown',
		detail: null,
		capacityReliable: false,
		total: null,
		used: null,
		available: null,
		lowSpacePhase: null,
		mountPoint: null,
		mountSource: null,
		filesystemType: null,
		filesystemId: null,
		filesystemKey: null,
		mountFingerprint: null,
		rootIdentity: null,
		identitySource: null,
		capacityCheckedAt: null,
		canCreate: false,
		canWrite: false
	};
	let pathStat;
	if (destination.expectedMountConflict) {
		result.status = 'unknown';
		result.detail = 'The same recording path has conflicting expectedMount settings.';
		return result;
	}

	try {
		pathStat = statPath(destination.path, fsImpl);
		result.resolvedPath = normalizePath(fsImpl.realpathSync(destination.path));
	} catch (error) {
		try {
			if (findBrokenLink(destination.path, fsImpl)) {
				result.status = 'broken-link';
				result.detail = 'The configured path contains a broken or circular symbolic link.';
				return result;
			}
		} catch (linkError) {
			result.detail = linkError.message;
			return result;
		}

		if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
			result.status = 'missing';
			result.detail = 'The recording destination does not exist.';
		} else if (error.code === 'ELOOP') {
			result.status = 'broken-link';
			result.detail = 'The configured path contains a circular symbolic link.';
		} else {
			result.detail = error.message;
		}
	}

	let identityStat = pathStat;
	let nearestExistingPath = null;
	if (!identityStat && destination.expectedMount !== null) {
		nearestExistingPath = findNearestExistingPath(destination.path, fsImpl);
		if (nearestExistingPath) {
			try {
				identityStat = statPath(nearestExistingPath, fsImpl);
			} catch (_) {}
		}
	}
	const statFilesystemId = identityStat && platform === 'linux' ? linuxDeviceId(identityStat.dev) : null;
	if (statFilesystemId) {
		result.filesystemKey = 'linux-dev:' + statFilesystemId;
		result.filesystemId = statFilesystemId;
		result.identitySource = 'stat.dev';
		result.rootIdentity = pathStat ? result.filesystemKey + ':ino:' + inodeId(pathStat) : null;
	}

	let expectedMount = null;
	if (destination.expectedMount !== null) {
		if (!mountInfo.available) {
			result.status = 'unknown';
			result.detail = 'Linux mount information is unavailable; the expected mount cannot be verified.';
			return result;
		}

		expectedMount = findExactMount(mountInfo.mounts, destination.expectedMount);
		if (!expectedMount) {
			result.status = 'not-mounted';
			result.detail = 'The configured expectedMount is not present in /proc/self/mountinfo.';
			return result;
		}
		if (expectedMount.mountOptions.includes('ro') || expectedMount.superOptions.includes('ro')) {
			result.status = 'read-only';
			result.detail = 'The expected filesystem is mounted read-only.';
			return result;
		}

		const relationPath = result.resolvedPath || destination.path;
		if (!isWithin(destination.expectedMount, relationPath)) {
			result.status = 'wrong-storage';
			result.detail = 'The recording destination is outside the configured expectedMount.';
			return result;
		}

		const existingPath = result.resolvedPath || nearestExistingPath || findNearestExistingPath(destination.path, fsImpl);
		const actualForExistingPath = existingPath ? findMount(mountInfo.mounts, existingPath) : null;
		if (!actualForExistingPath) {
			result.status = 'unknown';
			result.detail = 'The filesystem containing the recording destination could not be identified.';
			return result;
		}
		if (actualForExistingPath.filesystemId !== expectedMount.filesystemId ||
			actualForExistingPath.mountPoint !== expectedMount.mountPoint) {
			result.status = 'wrong-storage';
			result.detail = 'The recording destination resolves to a different mounted filesystem.';
			return result;
		}
		if (!statFilesystemId || statFilesystemId !== actualForExistingPath.filesystemId) {
			result.status = 'unknown';
			result.detail = 'stat.dev does not match the mounted filesystem identity.';
			result.filesystemId = null;
			result.filesystemKey = null;
			result.rootIdentity = null;
			return result;
		}
		result.canCreate = true;
	}

	if (!pathStat) {
		return result;
	}
	if (!pathStat.isDirectory()) {
		result.status = 'unknown';
		result.detail = 'The recording destination is not a directory.';
		return result;
	}

	const actualMount = mountInfo.available ? findMount(mountInfo.mounts, result.resolvedPath) : null;
	if (actualMount) {
		if (!statFilesystemId || statFilesystemId !== actualMount.filesystemId) {
			result.status = 'unknown';
			result.detail = 'stat.dev does not match the longest-prefix mountinfo entry.';
			result.filesystemId = null;
			result.filesystemKey = null;
			result.rootIdentity = null;
			return result;
		}
		result.mountPoint = actualMount.mountPoint;
		result.mountSource = actualMount.source;
		result.filesystemType = actualMount.filesystemType;
		result.filesystemId = statFilesystemId;
		result.filesystemKey = 'linux-dev:' + statFilesystemId;
		result.identitySource = 'stat.dev+mountinfo';
		result.mountFingerprint = [
			actualMount.filesystemId,
			actualMount.mountId,
			actualMount.parentId,
			actualMount.root,
			actualMount.mountPoint,
			actualMount.source,
			actualMount.filesystemType,
			actualMount.mountOptions.join(','),
			actualMount.superOptions.join(',')
		].join('|');
		if (actualMount.mountOptions.includes('ro') || actualMount.superOptions.includes('ro')) {
			result.status = 'read-only';
			result.detail = 'The filesystem is mounted read-only.';
			return result;
		}
	} else if (destination.expectedMount !== null) {
		result.status = 'unknown';
		result.detail = 'The mounted filesystem could not be identified.';
		return result;
	} else if (!statFilesystemId) {
		result.status = 'unknown';
		result.detail = platform === 'linux' ?
			'The runtime filesystem identity could not be obtained from stat.dev.' :
			'Filesystem identity is not inferred on this platform.';
		return result;
	} else {
		// Without expectedMount this is only a runtime grouping fallback. It
		// cannot prove that an unmounted path did not fall back to its parent.
		result.mountFingerprint = 'runtime-fallback|' + result.filesystemKey;
	}

	try {
		fsImpl.accessSync(destination.path, fs.constants.W_OK);
	} catch (error) {
		result.status = error.code === 'EROFS' ? 'read-only' : 'unknown';
		result.detail = error.code === 'EROFS' ? 'The filesystem is read-only.' : 'The recording destination is not writable: ' + error.message;
		return result;
	}

	result.canCreate = true;
	result.canWrite = true;
	if (!checkCapacity) {
		result.status = 'ok';
		return result;
	}

	if (typeof fsImpl.statfsSync !== 'function') {
		result.canWrite = false;
		result.detail = 'fs.statfsSync is unavailable.';
		return result;
	}

	try {
		const stats = fsImpl.statfsSync(destination.path);
		const blockSize = numberOrNull(stats.bsize || stats.frsize);
		const blocks = numberOrNull(stats.blocks);
		const freeBlocks = numberOrNull(stats.bfree);
		const availableBlocks = numberOrNull(stats.bavail);
		if (blockSize === null || blocks === null || freeBlocks === null || availableBlocks === null) {
			throw new Error('statfs returned invalid capacity values');
		}
		result.total = blocks * blockSize;
		result.available = availableBlocks * blockSize;
		result.used = result.total - freeBlocks * blockSize;
		result.capacityReliable = Number.isFinite(result.total) && result.total > 0 &&
			Number.isFinite(result.used) && Number.isFinite(result.available);
		if (!result.capacityReliable) {
			throw new Error('statfs returned unusable capacity values');
		}
		result.capacityCheckedAt = typeof options.now === 'number' ? options.now : Date.now();
	} catch (error) {
		result.total = null;
		result.used = null;
		result.available = null;
		result.capacityReliable = false;
		result.detail = error.message;
		return result;
	}

	const cleanupMB = Number(options.cleanupThresholdMB);
	const warningMB = Number(options.warningThresholdMB);
	const availableMB = result.available / 1024 / 1024;
	if (Number.isFinite(cleanupMB) && cleanupMB > 0 && availableMB < cleanupMB) {
		result.lowSpacePhase = 'cleanup';
	} else if (options.warningEnabled === true && Number.isFinite(warningMB) && warningMB > cleanupMB && availableMB < warningMB) {
		result.lowSpacePhase = 'warning';
	}

	result.status = result.lowSpacePhase ? 'low-space' : 'ok';
	return result;
}

function groupInspections(inspections) {
	const groups = [];
	const byKey = new Map();

	(inspections || []).forEach(function (inspection) {
		const key = inspection && inspection.filesystemKey;
		if (!key) {
			groups.push({
				filesystemKey: null,
				recordedDirIds: inspection && inspection.id ? [ inspection.id ] : [],
				destinations: inspection ? [ inspection.configuredPath || inspection.path ] : [],
				roots: inspection && inspection.resolvedPath ? [ inspection.resolvedPath ] : [],
				mountFingerprints: inspection && inspection.mountFingerprint ? [ inspection.mountFingerprint ] : [],
				members: inspection ? [ inspection ] : []
			});
			return;
		}

		let group = byKey.get(key);
		if (!group) {
			group = {
				filesystemKey: key,
				recordedDirIds: [],
				destinations: [],
				roots: [],
				mountFingerprints: [],
				rootIdentities: [],
				members: []
			};
			byKey.set(key, group);
			groups.push(group);
		}

		group.members.push(inspection);
		[ inspection.id ].concat(inspection.aliasIds || []).forEach(function (id) {
			if (id && !group.recordedDirIds.includes(id)) group.recordedDirIds.push(id);
		});
		const destinationPath = inspection.configuredPath || inspection.path;
		if (destinationPath && !group.destinations.includes(destinationPath)) group.destinations.push(destinationPath);
		if (inspection.resolvedPath && !group.roots.includes(inspection.resolvedPath)) group.roots.push(inspection.resolvedPath);
		if (inspection.rootIdentity && !group.rootIdentities.includes(inspection.rootIdentity)) group.rootIdentities.push(inspection.rootIdentity);
		if (inspection.mountFingerprint && !group.mountFingerprints.includes(inspection.mountFingerprint)) {
			group.mountFingerprints.push(inspection.mountFingerprint);
		}
	});

	groups.forEach(function (group) {
		group.mountFingerprints.sort();
		group.mountFingerprint = group.mountFingerprints.length ? group.mountFingerprints.join('||') : null;
	});
	return groups;
}

function inspectAll(config, options) {
	options = options || {};
	const fsImpl = options.fs || fs;
	const mountInfo = options.mountInfo || readMountInfo(fsImpl);
	return getDestinations(config).map(function (destination) {
		return inspectDestination(destination, Object.assign({}, options, {
			fs: fsImpl,
			mountInfo: mountInfo
		}));
	});
}

function findDestination(config, program) {
	const destinations = getDestinations(config);
	if (program && program.recordedDirId) {
		const byId = destinations.find(function (destination) {
			return destination.id === program.recordedDirId || destination.aliasIds.includes(program.recordedDirId);
		});
		if (byId) {
			if (typeof program.recordedDir === 'string' && program.recordedDir.trim() !== '' &&
				normalizePath(program.recordedDir) !== byId.path) {
				return Object.assign({}, byId, {
					configuredPath: program.recordedDir,
					path: normalizePath(program.recordedDir)
				});
			}
			return byId;
		}
	}

	if (program && typeof program.recordedDir === 'string' && program.recordedDir.trim() !== '') {
		const recordedPath = normalizePath(program.recordedDir);
		const byPath = destinations.find(function (destination) {
			return destination.path === recordedPath;
		});
		if (byPath) {
			return byPath;
		}
		return {
			id: program.recordedDirId || null,
			name: program.recordedDirId || program.recordedDir,
			configuredPath: program.recordedDir,
			path: recordedPath,
			expectedMount: null,
			protected: false,
			aliasIds: []
		};
	}

	return destinations.find(function (destination) {
		return destination.isDefault;
	}) || null;
}

module.exports = {
	findMount: findMount,
	groupInspections: groupInspections,
	linuxDeviceId: linuxDeviceId,
	parseMountInfo: parseMountInfo,
	getDestinations: getDestinations,
	inspectDestination: inspectDestination,
	inspectAll: inspectAll,
	findDestination: findDestination
};
