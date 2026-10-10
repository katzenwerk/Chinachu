'use strict';

const path = require('path');

function destinationToken(destination) {
	return destination && (destination.id ? 'id:' + destination.id : 'path:' + path.resolve(destination.path));
}

function matchesDestination(storage, destination) {
	if (!storage || !destination) return false;
	if ((storage.id || null) !== (destination.id || null)) return false;
	const storedPath = storage.configuredPath || storage.path;
	const configuredPath = destination.configuredPath || destination.path;
	if (!storedPath || !configuredPath || path.resolve(storedPath) !== path.resolve(configuredPath)) return false;
	return (storage.expectedMount || null) === (destination.expectedMount || null);
}

function isCompatible(state, options) {
	options = options || {};
	return !!state && state.schemaVersion === 3 && state.action === options.action &&
		!!state.thresholds && state.thresholds.cleanupMB === options.cleanupMB &&
		state.thresholds.warningMB === options.warningMB &&
		state.thresholds.warningEnabled === options.warningEnabled &&
		Array.isArray(state.storages);
}

function readCompatibleSnapshot(fsImpl, filename, options) {
	try {
		const state = JSON.parse(fsImpl.readFileSync(filename, 'utf8'));
		return isCompatible(state, options) ? state : null;
	} catch (_) {
		return null;
	}
}

function atomicWriteJson(fsImpl, filename, value) {
	const temporary = path.join(path.dirname(filename), '.' + path.basename(filename) + '.tmp');
	let fd = null;
	try {
		const json = JSON.stringify(value);
		fd = fsImpl.openSync(temporary, 'w', 0o600);
		fsImpl.writeFileSync(fd, json, 'utf8');
		if (typeof fsImpl.fsyncSync === 'function') fsImpl.fsyncSync(fd);
		fsImpl.closeSync(fd);
		fd = null;
		fsImpl.renameSync(temporary, filename);
	} catch (error) {
		if (fd !== null) {
			try { fsImpl.closeSync(fd); } catch (_) {}
		}
		try { fsImpl.unlinkSync(temporary); } catch (_) {}
		throw error;
	}
}

module.exports = {
	atomicWriteJson: atomicWriteJson,
	destinationToken: destinationToken,
	isCompatible: isCompatible,
	matchesDestination: matchesDestination,
	readCompatibleSnapshot: readCompatibleSnapshot
};
