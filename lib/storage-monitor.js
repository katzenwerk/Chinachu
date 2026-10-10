'use strict';

const DEFAULT_CHECK_INTERVAL_MS = 20000;

function destinationToken(destination) {
	return destination && (destination.id ? 'id:' + destination.id : 'path:' + destination.path);
}

function uniquePush(values, value) {
	if (value !== null && typeof value !== 'undefined' && value !== '' && !values.includes(value)) {
		values.push(value);
	}
}

class StorageMonitor {
	constructor(options) {
		options = options || {};
		this.inspect = options.inspect;
		this.now = typeof options.now === 'function' ? options.now : Date.now;
		this.checkIntervalMs = Number(options.checkIntervalMs) > 0 ?
			Number(options.checkIntervalMs) : DEFAULT_CHECK_INTERVAL_MS;
		this.inspectOptions = options.inspectOptions || {};
		this.groups = new Map();
		this.destinations = new Map();
		this.destinationMeta = new Map();
		this.unknownDestinations = new Map();
		this.revision = 0;
	}

	_isFresh(group, now) {
		return group && Number(group.capacityCheckedAt) > 0 &&
			now - group.capacityCheckedAt < this.checkIntervalMs;
	}

	_invalidateGroup(filesystemKey) {
		if (!filesystemKey) return;
		this.groups.delete(filesystemKey);
	}

	_checkIdentity(destination) {
		return this.inspect(destination, Object.assign({}, this.inspectOptions, {
			checkCapacity: false
		}));
	}

	check(destination, options) {
		options = options || {};
		const now = typeof options.now === 'number' ? options.now : this.now();
		const token = destinationToken(destination);
		if (token) this.destinationMeta.set(token, destination);
		const previous = token ? this.destinations.get(token) : null;
		const previousUnknown = token ? this.unknownDestinations.get(token) : null;
		if (!options.force && previousUnknown && now - previousUnknown.identityCheckedAt < this.checkIntervalMs) {
			return previousUnknown;
		}

		if (previous) {
			const cachedGroup = this.groups.get(previous.filesystemKey);
			const refreshAfterMs = Number(options.refreshAfterMs);
			const refreshRequested = Number.isFinite(refreshAfterMs) && refreshAfterMs >= 0 && cachedGroup &&
				now - cachedGroup.capacityCheckedAt >= refreshAfterMs;
			if (!options.force && !refreshRequested && this._isFresh(cachedGroup, now)) {
				this._mergeDestination(cachedGroup, destination, null);
				return cachedGroup;
			}
		}

		const identity = this._checkIdentity(destination);
		if (!identity || !identity.canWrite || !identity.filesystemKey) {
			if (previous) this._invalidateGroup(previous.filesystemKey);
			if (token) this.destinations.delete(token);
			const unknown = this._recordUnknown(destination, identity, now);
			unknown.revision = ++this.revision;
			if (token) this.unknownDestinations.set(token, unknown);
			return unknown;
		}

		if (previous && (previous.filesystemKey !== identity.filesystemKey ||
			previous.mountFingerprint !== identity.mountFingerprint)) {
			this._invalidateGroup(previous.filesystemKey);
		}

		if (token) {
			this.destinations.set(token, {
				filesystemKey: identity.filesystemKey,
				mountFingerprint: identity.mountFingerprint
			});
			this.unknownDestinations.delete(token);
		}

		let group = this.groups.get(identity.filesystemKey);
		if (group && this._isFresh(group, now)) {
			const destinationCount = group.destinations.length;
			this._mergeDestination(group, destination, identity);
			if (group.destinations.length !== destinationCount) group.revision = ++this.revision;
			return group;
		}

		const health = this.inspect(destination, Object.assign({}, this.inspectOptions, {
			checkCapacity: true,
			now: now
		}));
		if (!health || !health.canWrite || !health.capacityReliable ||
			health.filesystemKey !== identity.filesystemKey ||
			health.mountFingerprint !== identity.mountFingerprint) {
			this._invalidateGroup(identity.filesystemKey);
			const unknown = this._recordUnknown(destination, health || identity, now);
			unknown.revision = ++this.revision;
			if (token) this.unknownDestinations.set(token, unknown);
			return unknown;
		}

		group = {
			filesystemKey: health.filesystemKey,
			filesystemId: health.filesystemId,
			recordedDirIds: [],
			destinations: [],
			roots: [],
			mountFingerprints: [],
			phase: health.lowSpacePhase,
			status: health.status,
			detail: health.detail,
			availableBytes: health.available,
			totalBytes: health.total,
			usedBytes: health.used,
			capacityCheckedAt: health.capacityCheckedAt || now,
			stopNewRecordings: health.lowSpacePhase === 'cleanup',
			warningNotifiedAt: group && group.warningNotifiedAt || 0,
			cleanupNotifiedAt: group && group.cleanupNotifiedAt || 0,
			identitySource: health.identitySource,
			mountPoint: health.mountPoint,
			mountSource: health.mountSource,
			filesystemType: health.filesystemType
		};
		group.revision = ++this.revision;
		this._mergeDestination(group, destination, health);
		this.groups.set(group.filesystemKey, group);
		return group;
	}

	_recordUnknown(destination, health, now) {
		return {
			filesystemKey: null,
			filesystemId: null,
			recordedDirIds: destination && destination.id ? [ destination.id ] : [],
			destinations: destination ? [ destination.configuredPath || destination.path ] : [],
			roots: [],
			mountFingerprints: [],
			phase: null,
			status: health && health.status || 'unknown',
			detail: health && health.detail || 'Storage identity could not be verified.',
			availableBytes: null,
			totalBytes: null,
			usedBytes: null,
			capacityCheckedAt: null,
			identityCheckedAt: now,
			stopNewRecordings: true,
			canCreate: health && health.canCreate === true
		};
	}

	_mergeDestination(group, destination, health) {
		uniquePush(group.recordedDirIds, destination && destination.id);
		(destination && destination.aliasIds || []).forEach(id => uniquePush(group.recordedDirIds, id));
		uniquePush(group.destinations, destination && (destination.configuredPath || destination.path));
		uniquePush(group.roots, health && health.resolvedPath);
		uniquePush(group.mountFingerprints, health && health.mountFingerprint);
		group.mountFingerprints.sort();
		group.mountFingerprint = group.mountFingerprints.join('||') || null;
	}

	getByDestination(destination) {
		const cached = this.destinations.get(destinationToken(destination));
		return cached ? this.groups.get(cached.filesystemKey) || null : null;
	}

	get(filesystemKey) {
		return this.groups.get(filesystemKey) || null;
	}

	setNotificationTime(filesystemKey, phase, value) {
		const group = this.groups.get(filesystemKey);
		if (!group) return;
		if (phase === 'warning') group.warningNotifiedAt = value;
		if (phase === 'cleanup') group.cleanupNotifiedAt = value;
	}

	toJSON() {
		return Array.from(this.groups.values()).map(group => Object.assign({}, group, {
			recordedDirIds: group.recordedDirIds.slice(),
			destinations: group.destinations.slice(),
			roots: group.roots.slice(),
			mountFingerprints: group.mountFingerprints.slice()
		}));
	}

	getDestinationStates() {
		const states = [];
		this.destinationMeta.forEach((destination, token) => {
			const cached = this.destinations.get(token);
			const group = cached && this.groups.get(cached.filesystemKey);
			const state = group || this.unknownDestinations.get(token);
			if (!state) return;
			states.push(Object.assign({}, state, {
				id: destination.id || null,
				name: destination.name,
				path: destination.path,
				configuredPath: destination.configuredPath || destination.path,
				expectedMount: destination.expectedMount || null,
				capacityReliable: group ? Number(group.capacityCheckedAt) > 0 : false,
				total: group ? group.totalBytes : null,
				used: group ? group.usedBytes : null,
				available: group ? group.availableBytes : null,
				lowSpacePhase: group ? group.phase : null
			}));
		});
		return states;
	}

	getRevision() {
		return this.revision;
	}
}

module.exports = {
	DEFAULT_CHECK_INTERVAL_MS: DEFAULT_CHECK_INTERVAL_MS,
	StorageMonitor: StorageMonitor,
	destinationToken: destinationToken
};
