'use strict';

const fs = require('fs');
const path = require('path');

const MAX_UNIX_SOCKET_PATH_BYTES = 107;

function getUid(runtimeProcess) {
	if (!runtimeProcess || typeof runtimeProcess.getuid !== 'function') {
		throw new Error('runtime UID is unavailable');
	}
	const uid = runtimeProcess.getuid();
	if (!Number.isInteger(uid) || uid < 0) throw new Error('runtime UID is invalid');
	return uid;
}

function ensurePrivateDirectory(directory, options) {
	const fileSystem = options.fs;
	const uid = options.uid;
	fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const stat = fileSystem.lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error('runtime path is not a directory: ' + directory);
	}
	if (Number.isInteger(stat.uid) && stat.uid !== uid) {
		throw new Error('runtime directory is owned by another user: ' + directory);
	}
	if ((stat.mode & 0o777) !== 0o700) fileSystem.chmodSync(directory, 0o700);
	return directory;
}

function assertSocketPath(socketPath) {
	if (Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_PATH_BYTES) {
		throw new Error('Unix socket path is too long: ' + socketPath);
	}
	return socketPath;
}

function resolveRuntimeDirectory(rootDir, options) {
	options = options || {};
	const runtimeProcess = options.process || process;
	const fileSystem = options.fs || fs;
	const environment = options.env || runtimeProcess.env || {};
	const uid = getUid(runtimeProcess);
	const configured = typeof environment.CHINACHU_RUNTIME_DIR === 'string'
		? environment.CHINACHU_RUNTIME_DIR.trim() : '';
	let directory;

	if (configured) {
		if (!path.isAbsolute(configured)) {
			throw new Error('CHINACHU_RUNTIME_DIR must be an absolute path');
		}
		directory = path.resolve(configured);
	} else {
		directory = path.join(path.resolve(rootDir), '.runtime');
	}

	return ensurePrivateDirectory(directory, { fs: fileSystem, uid: uid });
}

function resolveRuntimePaths(rootDir, options) {
	const directory = resolveRuntimeDirectory(rootDir, options);
	return Object.freeze({
		directory: directory,
		schedulerPid: path.join(directory, 'scheduler.pid'),
		storageRefreshSocket: assertSocketPath(path.join(directory, 'storage-refresh.sock')),
		recordedThumbnailSocket: assertSocketPath(path.join(directory, 'recorded-thumbnail.sock'))
	});
}

module.exports = {
	MAX_UNIX_SOCKET_PATH_BYTES: MAX_UNIX_SOCKET_PATH_BYTES,
	resolveRuntimeDirectory: resolveRuntimeDirectory,
	resolveRuntimePaths: resolveRuntimePaths
};
