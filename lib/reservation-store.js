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

	const inspected = inspectLock(lockPath);
	if (!inspected.readable) {
		return false;
	}
	const owner = inspected.owner;
	if (ownerIsRunning(owner)) {
		return false;
	}
	// A killed worker cannot release its lock. A complete owner record whose
	// process is gone (or whose PID was reused) is safe to reclaim immediately.
	// Incomplete metadata still needs the original stale interval.
	const knownOwner = owner && Number.isInteger(owner.pid) && owner.pid > 0 &&
		typeof owner.token === 'string' && owner.token.length > 0 && Number.isFinite(owner.createdAt);
	if (!knownOwner && Date.now() - stat.mtimeMs < staleMs) return false;

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

// Reuse the same lock ownership/stale-lock rules without blocking an event loop
// while another process owns the ledger. Callbacks perform a short transaction.
async function withLockAsync(filePath, callback, options) {
	options = options || {};
	const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
	const retryMs = Number.isFinite(options.retryMs) ? options.retryMs : DEFAULT_RETRY_MS;
	const deadline = Date.now() + Math.max(0, timeoutMs);
	let lock;
	while (!lock) {
		try {
			lock = acquire(filePath, Object.assign({}, options, { timeoutMs: 0 }));
		} catch (error) {
			if (error.code !== 'RESERVATION_LOCK_TIMEOUT' || Date.now() >= deadline) throw error;
			await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(retryMs, deadline - Date.now()))));
		}
	}
	try {
		return await callback();
	} finally {
		lock.release();
	}
}

function readArray(filePath) {
	const value = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
	if (!Array.isArray(value)) {
		throw new Error('reservation data is not an array: ' + filePath);
	}
	return value;
}

function updateArrayAtomic(filePath, callback, options) {
	options = options || {};
	return withLock(filePath, function () {
		let current;
		try {
			current = readArray(filePath);
		} catch (error) {
			if (!options.createIfMissing || !error || error.code !== 'ENOENT') {
				throw error;
			}
			current = [];
		}
		const updated = callback(current);
		const output = updated === undefined ? current : updated;
		writeArrayAtomic(filePath, output);
		return output;
	}, options.lock);
}

// The normal Scheduler and direct reservation updates use the same allocator.
function reservationGroupKey(program) {
	return JSON.stringify([program.channel.type, program.channel.channel, program.start, program.end, program.title]);
}

// Protection is opt-in; legacy boundary settings do not imply protection.
function isRecordingHandoffProtected(program) {
	return program?.recordingHandoffProtected === true;
}

function evaluateReservations(matches, tuners, rules, config, options) {
	options = options || {};
	const schedulerLog = options.log || function () {};
	const chinachu = require('chinachu-common');
	const dateFormat = require('dateformat').default;
	var i, j, k, l, a;

	// (function) normalize recorded directory path
	function normalizeRecordedDir(dir) {
		dir = String(dir || '').trim();

		if (dir === '') {
			return '';
		}

		return dir.replace(/\/+$/, '') + '/';
	}

	// (function) resolve recorded directory from config.recordedDirs
	function resolveRecordedDir(recordedDirId) {
		var dirs = config.recordedDirs;
		var i;
		var dir;

		recordedDirId = String(recordedDirId || '').trim();

		if (recordedDirId === '') {
			return '';
		}

		if (dirs instanceof Array === false) {
			return '';
		}

		for (i = 0; i < dirs.length; i++) {
			dir = dirs[i];

			if (!dir || String(dir.id || '') !== recordedDirId) {
				continue;
			}

			if (typeof dir.path === 'string' && dir.path.trim() !== '') {
				return normalizeRecordedDir(dir.path);
			}

			return '';
		}

		return '';
	}

	// (function) apply reserve option from matched rule
	function applyRuleReserveOptions(reserve, rule, fallbackRuleId) {
		var recordedDirId;
		var recordedDir;

		if (!reserve || !rule) {
			return;
		}

		reserve.ruleId = rule.id !== undefined ? rule.id : fallbackRuleId;
		reserve.ruleIdSource = rule.id !== undefined ? 'id' : 'index';
		if (typeof rule.ruleUid !== 'undefined') {
			reserve.ruleUid = rule.ruleUid;
		}
		reserve.recordingHandoffProtected = isRecordingHandoffProtected(rule);
		delete reserve.recordingBoundaryPolicy;
		delete reserve.allowEndLack;

		if (typeof rule.recorded_format !== 'undefined') {
			reserve.recordedFormat = rule.recorded_format;
		}

		if (typeof rule.recordedDirId === 'string' && rule.recordedDirId.trim() !== '') {
			recordedDirId = rule.recordedDirId.trim();
			recordedDir = resolveRecordedDir(recordedDirId);

			reserve.recordedDirId = recordedDirId;

			if (recordedDir !== '') {
				reserve.recordedDir = recordedDir;
			} else {
				schedulerLog('WARNING: recordedDirId `' + recordedDirId + '` was not found or invalid. fallback to default recordedDir.');
			}
		}
	}

	// sort
	matches.sort(function (a, b) {
		return a.start - b.start;
	});

	// duplicates
	var duplicateCount = 0;
	for (i = 0; i < matches.length; i++) {
		a = matches[i];
		if (a.isManualReserved || a.isSkip) { continue; }

		for (j = 0; j < matches.length; j++) {
			var b = matches[j];

			if (b.isDuplicate) { continue; }

			if (a.id === b.id) { continue; }
			if (a.channel.type !== b.channel.type) { continue; }
			if (a.channel.channel !== b.channel.channel) { continue; }
			if (a.start !== b.start) { continue; }
			if (a.end !== b.end) { continue; }
			if (a.title !== b.title) { continue; }

			// 明示的な手動予約を自動予約より優先する。
			if (b.isManualReserved) {
				// 下の共通処理で自動予約側だけを重複扱いにする。
			} else if (b.isSkip) {
				// 下の共通処理で非Skip側だけを重複扱いにする。
			} else {
				// 従来どおりsidの若い方を選択させる
				if (parseInt(a.channel.sid, 10) < parseInt(b.channel.sid, 10)) { continue; }
			}

			schedulerLog('DUPLICATE: ' + a.id + ' ' + dateFormat(new Date(a.start), 'isoDateTime') + ' [' + a.channel.name + '] ' + a.title);
			a.isDuplicate = true;

			++duplicateCount;
			break;
		}
	}

	// check conflict
	var conflictCount = 0;
	var tunerThreads  = [];
	for (i = 0; i < tuners.length; i++) {
		tunerThreads.push([]);
	}
	for (i = 0; i < matches.length; i++) {
		a = matches[i];

		if (a.isDuplicate || a.isSkip) { continue; }

		a.isConflict = true;

		for (k = 0; k < tuners.length; k++) {
			if (tuners[k].types.indexOf(a.channel.type) !== -1) {
				var aIsConflictInTuner = false;
				for (l = 0; l < tunerThreads[k].length; l++) {
					if (!((tunerThreads[k][l].end <= a.start) || (tunerThreads[k][l].start >= a.end))) {
						aIsConflictInTuner = true;
						break;
					}
				}

				if (aIsConflictInTuner) {
					continue;
				} else {
					tunerThreads[k].push(a);
					a.isConflict = false;
					break;
				}
			}
		}

		if (!a.isConflict) {
			continue;
		} else {
			schedulerLog('!CONFLICT: ' + a.id + ' ' + dateFormat(new Date(a.start), 'isoDateTime') + ' [' + a.channel.name + '] ' + a.title);

			++conflictCount;
			if (options.onConflict) options.onConflict(a);
		}
	}

	// reserve
	var reserves = [];
	var reservedCount = 0;
	var skipCount     = 0;
	for (i = 0; i < matches.length; i++) {
		a = matches[i];

		if (!a.isDuplicate) {
			if (!options.preserveRuleOptions || !options.preserveRuleOptions.has(a.id)) {
				// 予約へルール由来の情報を継承する
				a.recordingHandoffProtected = false;
				delete a.allowEndLack;
				delete a.recordingBoundaryPolicy;
				for (let j = rules.length - 1; j >= 0; j--) {
					const rule = rules[j];
					if (chinachu.programMatchesRule(rule, a, config.normalizationForm)) {
						applyRuleReserveOptions(a, rule, j);
						break;
					}
				}
			}

			a.programId = a.id;
			reserves.push(a);

			if (a.isSkip) {
				schedulerLog('!!!SKIP: ' + a.id + ' ' + dateFormat(new Date(a.start), 'isoDateTime') + ' [' + a.channel.name + '] ' + a.title);
				++skipCount;
			} else if (!a.isConflict) {
				schedulerLog('RESERVE: ' + a.id + ' ' + dateFormat(new Date(a.start), 'isoDateTime') + ' [' + a.channel.name + '] ' + a.title);
				++reservedCount;
			} else {
				// 競合したときのログは既に出力済み
			}
		}
	}

	return { reserves, matches: matches.length, duplicateCount, conflictCount, skipCount, reservedCount };
}

// (function) make reserves2 key
function makeReserves2Key(program) {
	if (!program) {
		return '';
	}

	var key = program.key;

	if (typeof key === 'string' && key !== '') {
		return key;
	}

	var channel = program.channel || {};
	var channelId = channel.id || program.channelId || '';
	var start = parseInt(program.start, 10);
	var seconds = parseInt(program.seconds, 10);

	if (!channelId || !start || !seconds) {
		return '';
	}

	return [channelId, start, seconds].join('|');
}

// (function) decorate reserves2 entry
function decorateReserves2Entry(reserve, now) {
	var entry = Object.assign({}, reserve);
	var key = makeReserves2Key(entry);

	entry.source = entry.source || 'scheduler';
	entry.origId = entry.origId || entry.programId || entry.id || '';
	entry.key = key;
	entry.snapshotAt = now;
	entry.updatedAt = now;

	return entry;
}

// (function) remake reserves2
function remakeReserves2(currentReserves2, activeReserves, now, config, schedulerLog) {
	schedulerLog = schedulerLog || function () {};
	// (function) get retention days from config
	function getRetentionDays(name, defaultDays) {
		var value = Number(config[name]);

		if (!Number.isFinite(value)) {
			return defaultDays;
		}

		value = Math.floor(value);

		if (value < 0) {
			return defaultDays;
		}

		return value;
	}


	var keepDays = getRetentionDays('reserves2RetentionDays', 365);
	var keepMillis = keepDays > 0 ? keepDays * 24 * 60 * 60 * 1000 : 0;
	var threshold = keepMillis > 0 ? now - keepMillis : 0;
	var map = {};

	schedulerLog('RESERVES2 RETENTION DAYS: ' + (keepDays > 0 ? keepDays : 'disabled'));

	/*
	 * reserves2 の扱い:
	 *   - reserves2 は reserves.json に準拠する
	 *   - ただし、reserves.json から落ちた過去分(end < now)だけは履歴として保持する
	 *   - 過去分(end < now)は reserves2RetentionDays 以内なら保持する
	 *   - reserves2RetentionDays より前に終了したものは削除する
	 *   - reserves2RetentionDays が 0 の場合は整理しない
	 *   - 現在/未来分(end >= now)は activeReserves、つまり reserves.json と同じ内容を正とする
	 *
	 * 最終的な reserves2 は「過去履歴 + 現在の reserves.json」という形になる。
	 * これにより、予約ルール変更・解除で reserves.json から消えた未終了分は
	 * reserves2 側にも残り続けない。
	 */
	currentReserves2.forEach(function (reserve) {
		if (!reserve) {
			return;
		}

		var end = parseInt(reserve.end, 10);

		if (!end) {
			return;
		}

		if (keepMillis > 0 && end < threshold) {
			return;
		}

		if (end >= now) {
			return;
		}

		var key = makeReserves2Key(reserve);

		if (!key) {
			return;
		}

		reserve.key = key;
		map[key] = reserve;
	});

	activeReserves.forEach(function (reserve) {
		if (!reserve) {
			return;
		}

		var key = makeReserves2Key(reserve);

		if (!key) {
			return;
		}

		map[key] = decorateReserves2Entry(reserve, now);
	});

	return Object.keys(map).map(function (key) {
		return map[key];
	}).sort(function (a, b) {
		return parseInt(a.start || 0, 10) - parseInt(b.start || 0, 10);
	});
}


// Only tuner capabilities are fetched. EPG and Matching stay on their normal paths.
async function scheduleReservations(root, options) {
	options = options || {};
	const chinachu = require('chinachu-common');
	const ruleStore = require('./rule-store');
	const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
	const client = new (require(require.resolve('mirakurun', { paths: [root] })).default)();
	require('./mirakurun-connection').configureClient(client, config);
	const tuners = await client.getTuners();
	if (!Array.isArray(tuners) || tuners.some(tuner => !tuner || !Array.isArray(tuner.types))) {
		throw new Error('Mirakurun tuners response is invalid');
	}
	const rulesPath = path.join(root, 'rules.json');
	const reservesPath = path.join(root, 'data/reserves.json');
	const historyPath = path.join(root, 'data/reserves2.json');
	return withLockAsync(rulesPath, () => withLockAsync(reservesPath, () => {
		const rules = readArray(rulesPath);
		let addedRule = null;
		if (options.ruleUid) {
			addedRule = rules[ruleStore.findUniqueIndex(rules, options.ruleUid)];
			if (!options.ruleSnapshot || JSON.stringify(addedRule) !== JSON.stringify(options.ruleSnapshot)) {
				throw ruleStore.targetError('RULE_TARGET_CONFLICT', '保存後にルールが変更されました。通常Schedulerで再評価してください');
			}
		}
		const schedule = JSON.parse(fs.readFileSync(path.join(root, 'data/schedule.json'), 'utf8').replace(/^\uFEFF/, ''));
		if (!Array.isArray(schedule) || schedule.some(channel => !channel || !Array.isArray(channel.programs))) {
			throw new Error('schedule.json is not a valid program table');
		}
		const previousReserves = readArray(reservesPath);
		const current = JSON.parse(JSON.stringify(previousReserves));
		const oldTarget = options.targetId ? chinachu.getProgramById(options.targetId, current) : null;
		const operationResult = options.mutate ? options.mutate(current, schedule) : null;
		const newTarget = options.targetId ? chinachu.getProgramById(options.targetId, current) : null;
		const groups = new Set();
		const newMatchIds = new Set();
		if (oldTarget) groups.add(reservationGroupKey(oldTarget));
		if (newTarget) groups.add(reservationGroupKey(newTarget));
		// The cached EPG may already have moved the target and its duplicate group.
		const latestTarget = options.targetId ? chinachu.getProgramById(options.targetId, schedule) : null;
		if (latestTarget) groups.add(reservationGroupKey(latestTarget));
		if (addedRule) {
			schedule.forEach(channel => channel.programs.forEach(program => {
				if (chinachu.programMatchesRule(addedRule, program, config.normalizationForm)) {
					groups.add(reservationGroupKey(program));
					newMatchIds.add(program.id);
				}
			}));
		}
		const byId = new Map(current.map(program => [program.id, program]));
		const seen = new Set();
		const preserveRuleOptions = new Set();
		const matches = [];
		// Scan the saved table, but consult old rules only for affected duplicate groups.
		schedule.forEach(channel => channel.programs.forEach(program => {
			const existing = byId.get(program.id);
			let candidate = null;
			if (newMatchIds.has(program.id) || (groups.has(reservationGroupKey(program)) &&
				chinachu.isMatchedProgram(rules, program, config.normalizationForm))) {
				candidate = Object.assign({}, program);
				if (existing && !existing.isManualReserved && existing.isSkip) candidate.isSkip = true;
			} else if (existing && !existing.isManualReserved) {
				candidate = Object.assign({}, existing);
				preserveRuleOptions.add(candidate.id);
			}
			if (candidate && !seen.has(candidate.id)) {
				matches.push(candidate);
				seen.add(candidate.id);
			}
		}));
		current.forEach(program => {
			if (seen.has(program.id)) return; // As in the normal Scheduler, a rule wins the same ID.
			let candidate;
			if (program.isManualReserved) {
				if (program.start + 86400000 <= Date.now()) return;
				candidate = Object.assign({}, program);
				if (groups.has(reservationGroupKey(program))) {
					Object.assign(candidate, chinachu.getProgramById(program.id, schedule) || program);
				}
				candidate.isManualReserved = true;
				if (program['1seg'] === true) candidate['1seg'] = true;
			} else {
				candidate = Object.assign({}, program);
			}
			matches.push(candidate);
			seen.add(candidate.id);
			if (!groups.has(reservationGroupKey(candidate))) preserveRuleOptions.add(candidate.id);
		});
		matches.forEach(program => {
			delete program.isDuplicate;
			delete program.isConflict;
		});
		const result = evaluateReservations(matches, tuners, rules, config, { preserveRuleOptions });
		const now = Date.now();
		result.reserves = result.reserves.filter(program => program.end >= now);
		result.operationResult = operationResult;
		result.historyUpdated = true;
		const nextById = new Map(result.reserves.map(program => [program.id, program]));
		const historyFirst = options.historyFirst || previousReserves.some(program => {
			const next = nextById.get(program.id);
			return !next || Boolean(next.isSkip) !== Boolean(program.isSkip);
		});
		function buildHistory(history) {
			if (options.updateHistory) options.updateHistory(operationResult, history);
			const manualKeys = new Set(history.filter(entry => entry && entry.source === 'manual').map(makeReserves2Key));
			const updated = remakeReserves2(history, result.reserves, now, config);
			updated.forEach(entry => {
				if (entry.isManualReserved && manualKeys.has(makeReserves2Key(entry))) entry.source = 'manual';
			});
			return updated;
		}
		if (historyFirst) {
			// Destructive changes must retain their retry source until history is durable.
			return withLockAsync(historyPath, () => {
				let previousHistory;
				try { previousHistory = readArray(historyPath); } catch (error) {
					if (error.code !== 'ENOENT') throw error;
					previousHistory = [];
				}
				const history = buildHistory(JSON.parse(JSON.stringify(previousHistory)));
				writeArrayAtomic(historyPath, history);
				try {
					writeArrayAtomic(reservesPath, result.reserves);
				} catch (error) {
					try { writeArrayAtomic(historyPath, previousHistory); } catch (rollbackError) {
						error.message += '; reserves.json は未変更ですが履歴の復元にも失敗しました。書込エラーを解消して同じ操作を再試行してください: ' + rollbackError.message;
					}
					throw error;
				}
				return result;
			});
		}
		// Ordinary additions still publish the active reservation first.
		writeArrayAtomic(reservesPath, result.reserves);
		try {
			updateArrayAtomic(historyPath, buildHistory, { createIfMissing: true });
		} catch (error) {
			result.historyUpdated = false;
			result.warning = 'reserves.json は更新済みですが reserves2.json を更新できませんでした: ' + error.message;
		}
		return result;
	}));
}

module.exports = {
	isRecordingHandoffProtected,
	scheduleReservations,
	evaluateReservations,
	remakeReserves2,
	acquire,
	ensureArrayFile,
	readArray,
	updateArrayAtomic,
	writeArrayAtomic,
	withLock,
	withLockAsync
};
