'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_RETRY_MS = 10;
const DEFAULT_STALE_MS = 30000;

function wait(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLock(lockPath) {
	try {
		return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
	} catch (_) {
		return null;
	}
}

function inspectLock(lockPath) {
	let text;
	try {
		text = fs.readFileSync(lockPath, 'utf8');
	} catch (error) {
		return { readable: false, owner: null, error: error };
	}

	try {
		return { readable: true, owner: JSON.parse(text), error: null };
	} catch (error) {
		// crashでmetadataが途中の場合は、stale時間経過後に回収可能とする。
		return { readable: true, owner: null, error: error };
	}
}

function processStartIdentity(pid) {
	if (process.platform !== 'linux') {
		return null;
	}

	try {
		const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
		const commandEnd = stat.lastIndexOf(')');
		if (commandEnd === -1) {
			return null;
		}
		const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
		return fields[19] || null;
	} catch (_) {
		return null;
	}
}

function processExists(pid) {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}

	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error && error.code !== 'ESRCH';
	}
}

function ownerIsRunning(owner) {
	const pid = Number(owner && owner.pid);
	if (!Number.isInteger(pid) || pid <= 0 || !processExists(pid)) {
		return false;
	}

	if (owner.processStart) {
		const currentStart = processStartIdentity(pid);
		if (currentStart !== null) {
			return currentStart === owner.processStart;
		}
	}

	// process start identityが取得できない環境では、稼働中PIDを時間だけで回収しない。
	return true;
}

function sameFileIdentity(left, right) {
	return !!left && !!right && left.dev === right.dev && left.ino === right.ino;
}

function unlinkOwnedLock(lockPath, owner, identity) {
	let currentOwner;
	let currentIdentity;

	try {
		currentOwner = readLock(lockPath);
		currentIdentity = fs.statSync(lockPath);
	} catch (error) {
		if (error && error.code === 'ENOENT') {
			return true;
		}
		throw error;
	}

	if (owner && owner.token) {
		if (!currentOwner || currentOwner.token !== owner.token) {
			return false;
		}
	} else if (!sameFileIdentity(identity, currentIdentity)) {
		return false;
	}

	if (identity && !sameFileIdentity(identity, currentIdentity)) {
		return false;
	}

	try {
		fs.unlinkSync(lockPath);
		return true;
	} catch (error) {
		if (error && error.code === 'ENOENT') {
			return true;
		}
		throw error;
	}
}

function removeStaleLock(lockPath, staleMs) {
	let stat;

	try {
		stat = fs.statSync(lockPath);
	} catch (error) {
		return error && error.code === 'ENOENT';
	}

	if (Date.now() - stat.mtimeMs < staleMs) {
		return false;
	}

	const inspected = inspectLock(lockPath);
	if (!inspected.readable) {
		return false;
	}
	const owner = inspected.owner;
	if (ownerIsRunning(owner)) {
		return false;
	}

	return unlinkOwnedLock(lockPath, owner, stat);
}

function acquire(filePath, options) {
	options = options || {};
	const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
	const retryMs = Number.isFinite(options.retryMs) ? options.retryMs : DEFAULT_RETRY_MS;
	const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : DEFAULT_STALE_MS;
	const lockPath = filePath + '.lock';
	const deadline = Date.now() + Math.max(0, timeoutMs);

	while (true) {
		let fd;
		let identity;
		const owner = {
			pid: process.pid,
			processStart: processStartIdentity(process.pid),
			token: crypto.randomBytes(16).toString('hex'),
			createdAt: Date.now()
		};
		try {
			fd = fs.openSync(lockPath, 'wx', 0o600);
			identity = fs.fstatSync(fd);
			fs.writeFileSync(fd, JSON.stringify(owner));
			fs.fsyncSync(fd);
			return {
				lockPath: lockPath,
				owner: owner,
				release: function () {
					try {
						fs.closeSync(fd);
					} finally {
						unlinkOwnedLock(lockPath, owner, identity);
					}
				}
			};
		} catch (error) {
			if (fd !== undefined) {
				try { fs.closeSync(fd); } catch (_) {}
				unlinkOwnedLock(lockPath, owner, identity);
			}
			if (!error || error.code !== 'EEXIST') {
				throw error;
			}
		}

		if (removeStaleLock(lockPath, staleMs)) {
			continue;
		}

		if (Date.now() >= deadline) {
			const error = new Error('timed out waiting for reservation lock: ' + lockPath);
			error.code = 'RESERVATION_LOCK_TIMEOUT';
			throw error;
		}

		wait(Math.max(1, Math.min(retryMs, deadline - Date.now())));
	}
}

function syncDirectory(directory) {
	let fd;
	try {
		fd = fs.openSync(directory, 'r');
		fs.fsyncSync(fd);
		return true;
	} catch (_) {
		// directory fsync非対応環境ではrenameの原子性までを保証範囲とする。
		return false;
	} finally {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch (_) {}
		}
	}
}

function writeArrayAtomic(filePath, value) {
	if (!Array.isArray(value)) {
		throw new Error('reservation data is not an array: ' + filePath);
	}

	const directory = path.dirname(filePath);
	const temporaryPath = path.join(
		directory,
		'.' + path.basename(filePath) + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp'
	);
	let fd;
	let renamed = false;
	let mode = 0o600;

	try {
		try {
			mode = fs.statSync(filePath).mode & 0o777;
		} catch (error) {
			if (!error || error.code !== 'ENOENT') {
				throw error;
			}
		}

		fd = fs.openSync(temporaryPath, 'wx', mode);
		fs.writeFileSync(fd, JSON.stringify(value));
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;

		fs.renameSync(temporaryPath, filePath);
		renamed = true;
		syncDirectory(directory);
	} finally {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch (_) {}
		}
		if (!renamed) {
			try { fs.unlinkSync(temporaryPath); } catch (error) {
				if (!error || error.code !== 'ENOENT') {
					throw error;
				}
			}
		}
	}
}

function ensureArrayFile(filePath) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	return withLock(filePath, function () {
		if (fs.existsSync(filePath)) {
			return false;
		}
		writeArrayAtomic(filePath, []);
		return true;
	});
}

function withLock(filePath, callback, options) {
	const lock = acquire(filePath, options);
	try {
		return callback();
	} finally {
		lock.release();
	}
}

function readArray(filePath) {
	const value = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '') || '[]');
	if (!Array.isArray(value)) {
		throw new Error('reservation data is not an array: ' + filePath);
	}
	return value;
}

module.exports = {
	acquire,
	ensureArrayFile,
	readArray,
	writeArrayAtomic,
	withLock
};
