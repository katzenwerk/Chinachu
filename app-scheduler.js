/*!
 *  Chinachu Task Scheduler (chinachu-scheduler)
 *
 *  Copyright (c) 2016 Yuki KAN and Chinachu Project Contributors
 *  https://chinachu.moe/
**/
'use strict';

const PID_FILE = __dirname + '/data/scheduler.pid';

const SCHEDULER_STATE_FILE = __dirname + '/data/scheduler-state.json';
const LEGACY_SCHEDULER_STATE_FILE = __dirname + '/data/epg-scheduler-state.json';

const CONFIG_FILE = __dirname + '/config.json';
const RULES_FILE = __dirname + '/rules.json';
const RESERVES_DATA_FILE = __dirname + '/data/reserves.json';
const RESERVES2_DATA_FILE = __dirname + '/data/reserves2.json';
const RECORDED_DATA_FILE = __dirname + '/data/recorded.json';
const MATCH_DATA_FILE = __dirname + '/data/match.json';
const SCHEDULE_DATA_FILE = __dirname + '/data/schedule.json';

// 標準モジュールのロード
const path = require('path');
const fs = require('fs');
const util = require('util');
const schedulerState = require('./lib/scheduler-state');
const schedulerPreflight = require('./lib/operator-scheduler-preflight');
const schedulerStartedAt = Date.now();

function formatJstLogTime() {
	const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
	const yyyy = d.getUTCFullYear().toString();
	const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
	const dd = d.getUTCDate().toString().padStart(2, '0');
	const hh = d.getUTCHours().toString().padStart(2, '0');
	const ii = d.getUTCMinutes().toString().padStart(2, '0');
	const ss = d.getUTCSeconds().toString().padStart(2, '0');

	return yyyy + '/' + mm + '/' + dd + ' ' + hh + ':' + ii + ':' + ss;
}

function schedulerLog() {
	console.log(formatJstLogTime() + ' - ' + Array.prototype.join.call(arguments, ' '));
}

// Node.js 24 では util.log が存在しないため、旧Chinachu互換のログ関数を補う
// 既存の util.log がある環境では上書きしない
if (typeof util.log !== 'function') {
	util.log = schedulerLog;
}
const child_process = require('child_process');
const matchOutput = require('./lib/match-output');

// ディレクトリチェック
if (!fs.existsSync('./data/') || !fs.existsSync('./log/') || !fs.existsSync('./web/')) {
	console.error('必要なディレクトリが存在しないか、カレントワーキングディレクトリが不正です。');
	process.exit(1);
}

// 追加モジュールのロード
const opts = require('opts');
const dateFormat = require('dateformat').default;
const chinachu = require('chinachu-common');
const mirakurun = new (require("mirakurun").default)();
const mirakurunConnection = require('./lib/mirakurun-connection');

// 引数
opts.parse([
	{
		short: 's',
		long: 'simulation',
		description: 'シミュレーション。実際には保存されません',
		value: false,
		required: false
	}
], true);

// 設定の読み込み
const pkg = require("./package.json");
const config = require(CONFIG_FILE);
const rules = JSON.parse(fs.readFileSync(RULES_FILE, { encoding: 'utf8' }) || '[]');
let reserves = null;//まだ読み込まない
let tuners = null;
const schedulerBaselines = schedulerState.emptyBaselines();
let reservesReadIdentity = null;
let reservesOutputIdentity = null;
let reservesReadFingerprint = null;
let reservesChangedDuringRun = false;

schedulerBaselines.config = schedulerPreflight.createFileBaseline(CONFIG_FILE, config);
schedulerBaselines.rules = schedulerPreflight.createFileBaseline(RULES_FILE, rules);

// Mirakurun Client
const mirakurunPath = mirakurunConnection.configureClient(mirakurun, config);

mirakurun.userAgent = `Chinachu/${pkg.version} (scheduler)`;

console.info(mirakurun);

// スケジュール
var schedule = [];
if (fs.existsSync(SCHEDULE_DATA_FILE)) {
	try {
		schedule = JSON.parse(fs.readFileSync(SCHEDULE_DATA_FILE, { encoding: 'utf8' }));

		if (schedule instanceof Array === false) {
			schedulerLog('WARNING: `' + SCHEDULE_DATA_FILE + '`の内容が不正です');
			schedule = [];
		}
	} catch (e) {
		schedulerLog('WARNING: `' + SCHEDULE_DATA_FILE + '`のロードに失敗しました');
		schedule = [];
	}
}

// PID file operation
function createPidFile() {
	fs.writeFileSync(PID_FILE, process.pid.toString(10));
}

function deletePidFile() {
	try {
		if (fs.existsSync(PID_FILE)) {
			fs.unlinkSync(PID_FILE);
		}
	} catch (e) {
		schedulerLog('WARNING: `' + PID_FILE + '`の削除に失敗しました: ' + e.message);
	}
}

// scheduler is running?
function isRunning(callback) {

	if (fs.existsSync(PID_FILE) === true) {
		var pid = fs.readFileSync(PID_FILE, { encoding: 'utf8' });
		pid = pid.trim();

		if (/^[0-9]+$/.test(pid) === false) {
			schedulerLog('WARNING: `' + PID_FILE + '`の内容が不正です');
			deletePidFile();
			callback(false);
			return void 0;
		}

		child_process.execFile('ps', ['h', '-p', pid], function (err, stdout) {

			if (stdout === '') {
				deletePidFile();
				callback(false);
			} else {
				callback(true);
			}
		});
	} else {
		callback(false);
	}

	return void 0;
}

// (function) write json atomically
function writeJsonAtomic(file, data) {
	var tmp = file + '.' + process.pid + '.tmp';

	try {
		fs.writeFileSync(tmp, JSON.stringify(data));
		fs.renameSync(tmp, file);
	} catch (e) {
		try {
			if (fs.existsSync(tmp)) {
				fs.unlinkSync(tmp);
			}
		} catch (_) {}

		throw e;
	}
}

// (function) read json array
function readJsonArray(file, options) {
	var text;
	var data;

	options = options || {};

	if (!fs.existsSync(file)) {
		if (options.createIfMissing) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, '[]');
			schedulerLog('INIT JSON: ' + file);
		}

		return [];
	}

	try {
		text = fs.readFileSync(file, { encoding: 'utf8' }).replace(/^\uFEFF/, '');
		data = JSON.parse(text || '[]');
	} catch (e) {
		if (options.allowInvalid) {
			schedulerLog('WARNING: `' + file + '`のロードに失敗しました: ' + e.message);
			return [];
		}

		throw e;
	}

	if (data instanceof Array === false) {
		if (options.allowInvalid) {
			schedulerLog('WARNING: `' + file + '`の内容が配列ではありません');
			return [];
		}

		throw new Error('`' + file + '`の内容が配列ではありません');
	}

	return data;
}


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

// (function) normalize allowEndLack
function normalizeAllowEndLack(value) {
	return value === true;
}

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
	reserve.allowEndLack = normalizeAllowEndLack(rule.allowEndLack);

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
function remakeReserves2(currentReserves2, activeReserves, now) {
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

// (function) remake reserves
function outputReserves() {
	schedulerLog('WRITE: ' + RESERVES_DATA_FILE);

	var now = new Date().getTime();
	var array = [];

	reserves.forEach(function (reserve) {
		if (reserve.end < now) { return; }

		array.push(reserve);
	});

	try {
		if (!schedulerPreflight.sameFileIdentity(
			schedulerPreflight.fileIdentity(RESERVES_DATA_FILE),
			reservesReadIdentity
		) || schedulerPreflight.fingerprint(
			schedulerPreflight.projectReserves(readJsonArray(RESERVES_DATA_FILE))
		) !== reservesReadFingerprint) {
			reservesChangedDuringRun = true;
		}
	} catch (_) {
		reservesChangedDuringRun = true;
	}

	// Chinachu本体・Web側の更新検知互換性を優先し、元版と同じ直接書き込みにする
	fs.writeFileSync(RESERVES_DATA_FILE, JSON.stringify(array));
	reservesOutputIdentity = schedulerPreflight.fileIdentity(RESERVES_DATA_FILE);
	if (!reservesChangedDuringRun) {
		schedulerBaselines.reserves = schedulerPreflight.createFileBaseline(
			RESERVES_DATA_FILE,
			schedulerPreflight.projectReserves(array)
		);
	}

	// reserves2 は副次出力。失敗しても本体の reserves.json 更新と後続フックを止めない
	try {
		schedulerLog('WRITE: ' + RESERVES2_DATA_FILE);

		var currentReserves2 = readJsonArray(RESERVES2_DATA_FILE, { createIfMissing: true });
		var reserves2Array = remakeReserves2(currentReserves2, array, now);

		writeJsonAtomic(RESERVES2_DATA_FILE, reserves2Array);
	} catch (e) {
		schedulerLog('WARNING: `' + RESERVES2_DATA_FILE + '`の保存に失敗しました: ' + (e && e.stack ? e.stack : e));
	}
}

// (function) emit child process output with scheduler timestamp
function emitChildProcessOutput(commandProcess, prefix) {
	var stdoutLines;
	var stderrLines;
	var compacted;

	if (!commandProcess) {
		return;
	}

	compacted = prefix === 'MATCH' ? matchOutput.compactKeepRecordedStatus(commandProcess.stdout || '') : null;
	stdoutLines = compacted ? compacted.lines : String(commandProcess.stdout || '').split(/\r?\n/).map(function (line) {
		return line.trim();
	}).filter(Boolean);

	stderrLines = String(commandProcess.stderr || '').split(/\r?\n/).map(function (line) {
		return line.trim();
	}).filter(Boolean);

	stdoutLines.forEach(function (line) {
		if (/^saved:\s*/.test(line)) {
			schedulerLog((prefix || 'CHILD') + ' WRITE: ' + line.replace(/^saved:\s*/, ''));
			return;
		}

		schedulerLog((prefix || 'CHILD') + ': ' + line);
	});

	if (compacted && compacted.keepRecordedOverMissed > 0) {
		schedulerLog((prefix || 'CHILD') + ': keep_recorded_over_missed=' + compacted.keepRecordedOverMissed);
	}

	stderrLines.forEach(function (line) {
		schedulerLog((prefix || 'CHILD') + ' STDERR: ' + line);
	});
}

// (function) update match ledger
function updateMatchLedger() {
	var appMatchingFile = __dirname + '/app-matching.js';
	var recordedDataFile = RECORDED_DATA_FILE;
	var matchDataFile = MATCH_DATA_FILE;
	var commandProcess;

	try {
		if (!fs.existsSync(appMatchingFile)) {
			schedulerLog('WARNING: `' + appMatchingFile + '`が存在しないため match.json 更新をスキップしました');
			return;
		}

		var recordedForBaseline = readJsonArray(recordedDataFile, { createIfMissing: true });
		schedulerBaselines.recorded = schedulerPreflight.createFileBaseline(recordedDataFile, recordedForBaseline);
		readJsonArray(RESERVES2_DATA_FILE, { createIfMissing: true });
		readJsonArray(matchDataFile, { createIfMissing: true });

		schedulerLog('RUN: ' + appMatchingFile);

		commandProcess = child_process.spawnSync(process.execPath, [
			appMatchingFile,
			'--recorded', recordedDataFile,
			'--reserves2', RESERVES2_DATA_FILE,
			'--output', matchDataFile,
			'--config', CONFIG_FILE
		], {
			cwd: __dirname,
			encoding: 'utf8',
			stdio: [ 'ignore', 'pipe', 'pipe' ]
		});

		emitChildProcessOutput(commandProcess, 'MATCH');

		if (commandProcess.error) {
			throw commandProcess.error;
		}

		if (commandProcess.status !== 0) {
			schedulerLog('WARNING: match.json の更新に失敗しました: exit status=' + commandProcess.status);
		}
	} catch (e) {
		schedulerLog('WARNING: match.json の更新に失敗しました: ' + (e && e.stack ? e.stack : e));
	}
}

// (function) persist the common successful scheduler boundary
function recordSchedulerSuccess() {
	try {
		try {
			if (!schedulerPreflight.sameFileIdentity(
				schedulerPreflight.fileIdentity(RESERVES_DATA_FILE),
				reservesOutputIdentity
			) || !schedulerBaselines.reserves || schedulerPreflight.fingerprint(
				schedulerPreflight.projectReserves(readJsonArray(RESERVES_DATA_FILE))
			) !== schedulerBaselines.reserves.hash) {
				schedulerBaselines.reserves = null;
			}
		} catch (_) {
			schedulerBaselines.reserves = null;
		}
		const stateStore = new schedulerState.SchedulerStateStore(SCHEDULER_STATE_FILE, {
			legacyFilePath: LEGACY_SCHEDULER_STATE_FILE
		});
		stateStore.recordSchedulerSuccess(schedulerStartedAt, Date.now(), schedulerBaselines);
	} catch (error) {
		schedulerLog('WARNING: scheduler state save failed: ' + (error && error.message ? error.message : String(error)));
	}
}

// (function) run epgEnd hook
function runEpgEndCommand() {
	if (config.epgEndCommand) {
		const commandProcess = child_process.spawn(config.epgEndCommand, [process.pid, RULES_FILE, RESERVES_DATA_FILE, SCHEDULE_DATA_FILE]);
		schedulerLog('SPAWN: ' + config.epgEndCommand + ' (pid=' + commandProcess.pid + ')');
	}
}

// scheduler
function scheduler() {

	var i, j, k, l, a;
	var commandProcess;

	schedulerLog('RUNNING SCHEDULER.');

	// schedulerStartフック
	if (!opts.get('s')) {
		if (config.schedulerStartCommand) {
			commandProcess = child_process.spawnSync(config.schedulerStartCommand, [process.pid, RULES_FILE, RESERVES_DATA_FILE, SCHEDULE_DATA_FILE]);
			schedulerLog('SPAWN: ' + config.schedulerStartCommand + ' (pid=' + commandProcess.pid + ')');
		}
	}

	// IDが重複しているかチェックするだけ
	var idMap = {};
	schedule.forEach(function (ch) {
		ch.programs.forEach(function (p) {
			if (idMap[p.id]) {
				schedulerLog('**WARNING**: ' + p.id + ' is duplicated!');
				console.log(JSON.stringify(idMap[p.id], null, '  '), JSON.stringify(p, null, '  '));
			} else {
				idMap[p.id] = p;
			}
		});
	});

	reserves = readJsonArray(RESERVES_DATA_FILE, { createIfMissing: true });//読み込む
	reservesReadIdentity = schedulerPreflight.fileIdentity(RESERVES_DATA_FILE);
	reservesReadFingerprint = schedulerPreflight.fingerprint(schedulerPreflight.projectReserves(reserves));

	var typeNum = {};

	tuners.forEach(tuner => {
		tuner.types.forEach(type => {
			if (typeof typeNum[type] === 'undefined') {
				typeNum[type] = 1;
			} else {
				typeNum[type]++;
			}
		});
	});

	schedulerLog('TUNERS: ' + JSON.stringify(typeNum));

	// matching
	var matches = [];

	schedule.forEach(function (ch) {
		ch.programs.forEach(function (p) {
			if (chinachu.isMatchedProgram(rules, p, config.normalizationForm)) {
				matches.push(p);
			}
		});
	});

	reserves.forEach(function (reserve) {
		var i, l;
		if (reserve.isManualReserved) {
			if (reserve.start + 86400000 > Date.now()) {
				for (i = 0, l = matches.length; i < l; i++) {
					if (matches[i].id === reserve.id) {
						// ルールと重複していた場合、ルール予約が手動予約に優先するよう、matchesにpushせずreturnする
						schedulerLog('OVERRIDEBYRULE: ' + reserve.id + ' ' + dateFormat(new Date(reserve.start), 'isoDateTime') + ' [' + reserve.channel.name + '] ' + reserve.title);
						return;
					}
				}
				var isOneseg = reserve['1seg'] === true;
				reserve = chinachu.getProgramById(reserve.id, schedule) || reserve;
				reserve.isManualReserved = true;
				if (isOneseg === true) {
					reserve['1seg'] = true;
				}
				matches.push(reserve);
			}
			return;
		}
		if (reserve.isSkip) {
			for (i = 0, l = matches.length; i < l; i++) {
				if (matches[i].id === reserve.id) {
					matches[i].isSkip = true;
					break;
				}
			}
			return;
		}
	});

	// sort
	matches.sort(function (a, b) {
		return a.start - b.start;
	});

	// duplicates
	var duplicateCount = 0;
	for (i = 0; i < matches.length; i++) {
		a = matches[i];

		for (j = 0; j < matches.length; j++) {
			var b = matches[j];

			if (b.isDuplicate || b.isSkip) { continue; }

			if (a.id === b.id) { continue; }
			if (a.channel.type !== b.channel.type) { continue; }
			if (a.channel.channel !== b.channel.channel) { continue; }
			if (a.start !== b.start) { continue; }
			if (a.end !== b.end) { continue; }
			if (a.title !== b.title) { continue; }

			// 最終的にsidの若い方を選択させる
			if (parseInt(a.channel.sid, 10) < parseInt(b.channel.sid, 10)) { continue; }

			schedulerLog('DUPLICATE: ' + a.id + ' ' + dateFormat(new Date(a.start), 'isoDateTime') + ' [' + a.channel.name + '] ' + a.title);
			a.isDuplicate = true;

			++duplicateCount;
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
			// conflict フック
			if (config.conflictCommand) {
				commandProcess = child_process.spawn(config.conflictCommand, [process.pid, a.id, dateFormat(new Date(a.start), 'isoDateTime'), a.channel.name, a.title, JSON.stringify(a)]);
				schedulerLog('SPAWN: ' + config.conflictCommand + ' (pid=' + commandProcess.pid + ')');
			}
		}
	}

	// reserve
	reserves = [];
	var reservedCount = 0;
	var skipCount     = 0;
	for (i = 0; i < matches.length; i++) {
		a = matches[i];

		if (!a.isDuplicate) {
			// 予約へルール由来の情報を継承する
			a.allowEndLack = false;
			for (let j = rules.length - 1; j >= 0; j--) {
				const rule = rules[j];
				if (chinachu.programMatchesRule(rule, a, config.normalizationForm)) {
					applyRuleReserveOptions(a, rule, j);
					break;
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


	// results
	schedulerLog('MATCHES: ' + matches.length.toString(10));
	schedulerLog('DUPLICATES: ' + duplicateCount.toString(10));
	schedulerLog('CONFLICTS: ' + conflictCount.toString(10));
	schedulerLog('SKIPS: ' + skipCount.toString(10));
	schedulerLog('RESERVES: ' + reservedCount.toString(10));

	if (!opts.get('s')) {
		outputReserves();
		updateMatchLedger();
		// schedulerEnd フック
		if (config.schedulerEndCommand) {
			commandProcess = child_process.spawn(config.schedulerEndCommand, [process.pid, RULES_FILE, RESERVES_DATA_FILE, SCHEDULE_DATA_FILE, matches.length.toString(10), duplicateCount.toString(10), conflictCount.toString(10), skipCount.toString(10), reservedCount.toString(10)]);
			schedulerLog('SPAWN: ' + config.schedulerEndCommand + ' (pid=' + commandProcess.pid + ')');
		}

		recordSchedulerSuccess();
	}

	// プロセス終了
	process.exit(0);
}

// (function) program converter
const flagBracketsRE = /\[.{1,2}\]|【.】|\(.{1,2}\)/g;
const flagExtractRE = /(?:【|\[|\()(.{1,2})(?:】|\]|\))/;
const flagRE = /新|終|再|字|デ|解|無|二|S|SS|初|生|Ｎ|映|多|双/;
const flagUniRE = /🈟|🈡|🈞|🈑|🈓|🈖|🈚|🈔|🅂|🅍|🈠|🈢|🄽|🈙|🈕|🈒/g;

// episode parser
// 4桁まで対応: #1000 など
const jpEpisodeNumberRE = '[0-9０-９]{1,4}|[〇零一壱壹二弐貳三参參四五六七八九十拾百]{1,10}';
const jpEpisodeUnitRE = '[話回幕怪章番]';

const singleEpisodePatterns = [
	{
		kind: 'hash',
		re: /[#＃♯]\s*[0-9０-９]{1,4}(?:[.．][0-9０-９]+)?/i
	},
	{
		kind: 'dai-unit',
		re: new RegExp('第\\s*(?:' + jpEpisodeNumberRE + ')\\s*' + jpEpisodeUnitRE, 'i')
	},
	{
		kind: 'episode',
		re: /Episode\s*[.．]?\s*[0-9０-９]{1,4}/i
	},
	{
		kind: 'ep',
		re: /Ep\s*[.．]?\s*[0-9０-９]{1,4}/i
	},
	{
		kind: 'chapter',
		re: /Chapter\s*[.．]?\s*[0-9０-９]{1,4}/i
	},
	{
		kind: 'lesson',
		re: /Lesson\s*[.．]?\s*[0-9０-９]{1,4}/i
	},
	{
		kind: 'mission',
		re: /作戦\s*[0-9０-９]{1,4}/i
	}
];

function stripPrivateUseMarks(value) {
	return String(value || '').replace(/[\uE000-\uF8FF]/g, '').trim();
}

function toHalfWidthDigits(value) {
	return String(value || '').replace(/[０-９]/g, function (ch) {
		return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
	});
}

function parseKanjiEpisodeNumber(value) {
	const digitMap = {
		'〇': 0, '零': 0,
		'一': 1, '壱': 1, '壹': 1,
		'二': 2, '弐': 2, '貳': 2,
		'三': 3, '参': 3, '參': 3,
		'四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9
	};

	let total = 0;
	let current = 0;
	let seen = false;

	for (const ch of String(value || '')) {
		if (Object.prototype.hasOwnProperty.call(digitMap, ch)) {
			current = digitMap[ch];
			seen = true;
			continue;
		}

		if (ch === '十' || ch === '拾') {
			total += (current || 1) * 10;
			current = 0;
			seen = true;
			continue;
		}

		if (ch === '百') {
			total += (current || 1) * 100;
			current = 0;
			seen = true;
			continue;
		}

		return null;
	}

	return seen ? total + current : null;
}

function episodeNumberFromToken(token) {
	const ascii = toHalfWidthDigits(token).replace(/．/g, '.');
	const digitMatch = ascii.match(/[0-9]{1,4}(?:\.[0-9]+)?/);

	if (digitMatch) {
		return digitMatch[0].indexOf('.') !== -1
			? parseFloat(digitMatch[0])
			: parseInt(digitMatch[0], 10);
	}

	const kanjiMatch = String(token || '').match(/[〇零一壱壹二弐貳三参參四五六七八九十拾百]+/);
	if (kanjiMatch) {
		return parseKanjiEpisodeNumber(kanjiMatch[0]);
	}

	return null;
}

function normalizeEpisodeSpec(value) {
	return toHalfWidthDigits(value)
		.replace(/．/g, '.')
		.replace(/[#＃♯]/g, '')
		.replace(/[\s　]+/g, '')
		.replace(/[，、・&＆]/g, ',')
		.replace(/[－~〜～]/g, '-')
		.replace(/ova/ig, 'OVA');
}

function findMultiEpisodeMarker(text) {
	const source = String(text || '');
	let matched;

	// #3,4 / #25-#36 / #01-13,OVA / #62-65,65.5,66-70
	// 先頭の # 以降を「複数話指定式」としてまとめて保持する。
	const hashAtom = '(?:[0-9０-９]{1,4}(?:[.．][0-9０-９]+)?|OVA)';
	const hashMultiRE = new RegExp(
		'[#＃♯]\\s*(' + hashAtom + '(?:\\s*(?:[,，、・&＆]|[-－~〜～])\\s*(?:[#＃♯]\\s*)?' + hashAtom + ')+)',
		'i'
	);

	matched = source.match(hashMultiRE);
	if (matched && matched.index !== undefined) {
		return {
			kind: 'hash-multi-spec',
			index: matched.index,
			end: matched.index + matched[0].length,
			token: matched[0],
			episode: normalizeEpisodeSpec(matched[1]),
			isMulti: true
		};
	}

	// 第12～22話 / 第12-22話
	matched = source.match(
		/第\s*([0-9０-９]{1,4})\s*[-－~〜～]\s*([0-9０-９]{1,4})\s*話/
	);
	if (matched && matched.index !== undefined) {
		return {
			kind: 'dai-range',
			index: matched.index,
			end: matched.index + matched[0].length,
			token: matched[0],
			episode: normalizeEpisodeSpec(matched[1] + '-' + matched[2]),
			isMulti: true
		};
	}

	// 12～22話 / 12-22話
	matched = source.match(
		/(^|[\s　])([0-9０-９]{1,4})\s*[-－~〜～]\s*([0-9０-９]{1,4})\s*話/
	);
	if (matched && matched.index !== undefined) {
		const index = matched.index + matched[1].length;
		return {
			kind: 'bare-range-wa',
			index: index,
			end: matched.index + matched[0].length,
			token: source.slice(index, matched.index + matched[0].length),
			episode: normalizeEpisodeSpec(matched[2] + '-' + matched[3]),
			isMulti: true
		};
	}

	return null;
}

function findBareWaEpisodeMarker(text) {
	const source = String(text || '');
	const re = /([0-9０-９]{1,4})\s*話/g;
	let matched;

	while ((matched = re.exec(source)) !== null) {
		const before = source.slice(Math.max(0, matched.index - 10), matched.index);

		if (/全\s*$/.test(before)) {
			continue;
		}

		if (/[0-9０-９]\s*[-－~〜～]\s*$/.test(before)) {
			continue;
		}

		if (/第\s*[0-9０-９]{1,4}\s*[-－~〜～]\s*$/.test(before)) {
			continue;
		}

		return {
			kind: 'bare-wa',
			index: matched.index,
			end: matched.index + matched[0].length,
			token: matched[0],
			episode: episodeNumberFromToken(matched[0]),
			isMulti: false
		};
	}

	return null;
}

function findBareNumberEpisodeMarker(text) {
	const source = String(text || '');
	const re = /(^|[\s　])([0-9０-９]{1,4})(?=[\s　]+)([\s　]+)(.+)$/g;
	let matched;

	while ((matched = re.exec(source)) !== null) {
		const number = matched[2];
		const tail = String(matched[4] || '').trim();
		const numberIndex = matched.index + matched[1].length;
		const prefix = source.slice(0, numberIndex).trim();

		if (!prefix || !tail) {
			continue;
		}

		if (/[-－~〜～]\s*$/.test(prefix) || /^[\-－~〜～]/.test(tail)) {
			continue;
		}

		if (/^[%％]/.test(tail)) {
			continue;
		}

		// "...～2　13" のように作品名末尾が数字なら推測しない
		if (/[0-9０-９]$/.test(prefix)) {
			continue;
		}

		// Season 3 #12 の 3 など、シーズン/シリーズ番号は bare-number 扱いしない。
		if (/(?:\bseason|シーズン|シリーズ)\s*$/i.test(prefix) || /第\s*$/.test(prefix)) {
			continue;
		}

		return {
			kind: 'bare-number',
			index: numberIndex,
			end: numberIndex + number.length,
			token: number,
			episode: parseInt(toHalfWidthDigits(number), 10),
			isMulti: false
		};
	}

	return null;
}

function findColonEpisodeMarker(text) {
	const source = String(text || '');
	const re = /([0-9０-９]{1,4})\s*[:：](?=\s*\S)/g;
	let matched;

	while ((matched = re.exec(source)) !== null) {
		const prefix = source.slice(0, matched.index).trim();

		if (!prefix) {
			continue;
		}

		// Season 3: ... などのシーズン番号は episode とみなさない。
		if (/(?:\bseason|シーズン|シリーズ)\s*$/i.test(prefix) || /第\s*$/.test(prefix)) {
			continue;
		}

		return {
			kind: 'colon',
			index: matched.index,
			end: matched.index + matched[0].length,
			token: matched[0],
			episode: episodeNumberFromToken(matched[1]),
			isMulti: false
		};
	}

	return null;
}

function findParenthesizedEpisodeMarker(text) {
	const source = String(text || '');
	const matched = source.match(/[（(]\s*[0-9０-９]{1,4}\s*[）)]/i);

	if (!matched || matched.index === undefined) {
		return null;
	}

	return {
		kind: 'paren',
		index: matched.index,
		end: matched.index + matched[0].length,
		token: matched[0],
		episode: episodeNumberFromToken(matched[0]),
		isMulti: false
	};
}

function findSingleEpisodeMarker(text) {
	const source = String(text || '');
	let best = null;

	// #12 / 第12話 / Episode12 などの明示マーカーを最優先する。
	// 括弧数字 (12) / （12） はここには含めず、後段の fallback に回す。
	// これにより "ゲゲゲの鬼太郎（1971） #17" の （1971）を episode と誤認しない。
	for (const pattern of singleEpisodePatterns) {
		const matched = source.match(pattern.re);

		if (!matched || matched.index === undefined) {
			continue;
		}

		if (!best || matched.index < best.index) {
			best = {
				kind: pattern.kind,
				index: matched.index,
				end: matched.index + matched[0].length,
				token: matched[0],
				episode: episodeNumberFromToken(matched[0]),
				isMulti: false
			};
		}
	}

	// "12話" も明示的な話数表記として扱う。
	const bareWa = findBareWaEpisodeMarker(source);
	if (bareWa && (!best || bareWa.index < best.index)) {
		best = bareWa;
	}

	if (best) {
		return best;
	}

	// "44:CLOUDY BEACH" のような「話数:副題」形式。
	// bare-number より明示度が高いが、Season 3: ... は除外する。
	const colon = findColonEpisodeMarker(source);
	if (colon) {
		return colon;
	}

	// 括弧数字は NHK 等で使われる補助的な話数表記として fallback 扱い。
	// 他に明示的な話数が無い場合だけ採用する。
	const paren = findParenthesizedEpisodeMarker(source);
	if (paren) {
		return paren;
	}

	// bare-number は最後の fallback。
	// これにより "Season 3 #12" の 3 が #12 より優先されることを防ぐ。
	return findBareNumberEpisodeMarker(source);
}

function findEpisodeMarker(text) {
	const source = String(text || '');
	const multi = findMultiEpisodeMarker(source);
	const single = findSingleEpisodeMarker(source);

	// 複数話表記が先に現れるなら、単話より優先する
	if (multi && (!single || multi.index <= single.index)) {
		return multi;
	}

	return single;
}

function isBroadcastMetadata(value) {
	const text = stripPrivateUseMarks(value);

	if (text === '') {
		return true;
	}

	if (/^[◆◇]/.test(text)) {
		return true;
	}

	return false;
}

function subtitleFromTail(value) {
	let text = stripPrivateUseMarks(value)
		.replace(/^[\s　:：\-－―—・]+/, '')
		.trim();

	// episode 直後の短い括弧付き放送フラグは subtitle にしない。
	// 例: #94(二) / #94（二）
	const leadingFlag = text.match(/^[\[【(（]([^\]】)）]{1,2})[\]】)）]\s*/);
	if (leadingFlag && leadingFlag[1].split('').every(function (ch) { return flagRE.test(ch); })) {
		text = text.slice(leadingFlag[0].length).trim();
	}

	if (text === '' || isBroadcastMetadata(text)) {
		return '';
	}

	const quoted = text.match(/^[「『【]([^」』】]+)[」』】]/);
	if (quoted) {
		return quoted[1].trim();
	}

	if (text.length <= 60) {
		return text;
	}

	return '';
}

function episodeSpecContains(episode, candidate) {
	if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
		return false;
	}

	if (typeof episode === 'number') {
		return episode === candidate;
	}

	if (typeof episode !== 'string' || episode.trim() === '') {
		return false;
	}

	const spec = normalizeEpisodeSpec(episode);
	const parts = spec.split(',');

	for (const rawPart of parts) {
		const part = rawPart.trim();

		if (part === '' || /^OVA$/i.test(part)) {
			continue;
		}

		const range = part.match(/^([0-9]+(?:\.[0-9]+)?)-([0-9]+(?:\.[0-9]+)?)$/);
		if (range) {
			const start = parseFloat(range[1]);
			const end = parseFloat(range[2]);
			if (candidate >= Math.min(start, end) && candidate <= Math.max(start, end)) {
				return true;
			}
			continue;
		}

		const single = part.match(/^([0-9]+(?:\.[0-9]+)?)$/);
		if (single && parseFloat(single[1]) === candidate) {
			return true;
		}
	}

	return false;
}

function getDetailLeadLines(detail, limit) {
	return String(detail || '')
		.split(/\r?\n/)
		.map(function (line) { return stripPrivateUseMarks(line).trim(); })
		.filter(function (line) { return line !== ''; })
		.slice(0, limit || 5);
}

function summarizeSubTitles(values) {
	const unique = [];

	for (const value of values) {
		const text = stripPrivateUseMarks(value).trim();
		if (text !== '' && unique.indexOf(text) === -1) {
			unique.push(text);
		}
	}

	if (unique.length === 0) {
		return '';
	}

	if (unique.length === 1) {
		return unique[0];
	}

	if (unique.length === 2) {
		return unique[0] + '／' + unique[1];
	}

	return unique[0] + '／' + unique[1] + '／他';
}

function collectMatchingEpisodeSubtitles(detail, episode) {
	if (episode === null || typeof episode === 'undefined') {
		return [];
	}

	const lines = getDetailLeadLines(detail, 5);
	const found = [];

	function add(candidate, subtitle) {
		if (!episodeSpecContains(episode, candidate)) {
			return;
		}

		const text = stripPrivateUseMarks(subtitle).trim();
		if (text !== '' && found.indexOf(text) === -1) {
			found.push(text);
		}
	}

	for (const line of lines) {
		let matched;
		let quotedFound = false;

		// #2「副題」 / #39「A」 #40「B」
		const hashQuotedRE = /[#＃♯]\s*([0-9０-９]{1,4}(?:[.．][0-9０-９]+)?)\s*[「『【]([^」』】]+)[」』】]/g;
		while ((matched = hashQuotedRE.exec(line)) !== null) {
			quotedFound = true;
			add(episodeNumberFromToken(matched[1]), matched[2]);
		}

		// 第2話「副題」 / 第2話【副題】
		const daiQuotedRE = /第\s*([0-9０-９]{1,4})\s*[話回幕怪章番]\s*[「『【]([^」』】]+)[」』】]/g;
		while ((matched = daiQuotedRE.exec(line)) !== null) {
			quotedFound = true;
			add(episodeNumberFromToken(matched[1]), matched[2]);
		}

		if (quotedFound) {
			continue;
		}

		// 複数話の説明が1行内に並ぶ形式。
		// 例: 『#1 偶然から生まれた大ヒット商品/#2 バービー vs G.I.ジョー』
		// episode が複数指定のときだけ使い、該当する話数の副題だけを拾う。
		if (typeof episode === 'string' && /[,\-]/.test(episode)) {
			const inlineHashRE = /[#＃♯]\s*([0-9０-９]{1,4}(?:[.．][0-9０-９]+)?)\s+([^\r\n]+?)(?=\s*\/\s*[#＃♯]\s*[0-9０-９]|\s*[#＃♯]\s*[0-9０-９]|[」』】]|$)/g;
			let inlineMatched;
			while ((inlineMatched = inlineHashRE.exec(line)) !== null) {
				add(
					episodeNumberFromToken(inlineMatched[1]),
					inlineMatched[2].replace(/[\s　\/]+$/, '')
				);
			}

			if (found.length > 0) {
				continue;
			}
		}

		// #13 見上げて覗いて探して、次！
		matched = line.match(/^[#＃♯]\s*([0-9０-９]{1,4}(?:[.．][0-9０-９]+)?)\s+(.+)$/);
		if (matched) {
			add(episodeNumberFromToken(matched[1]), subtitleFromTail(matched[2]));
			continue;
		}

		// 第8話 泥の河は乾える ...
		matched = line.match(/^第\s*([0-9０-９]{1,4})\s*[話回幕怪章番]\s+(.+)$/);
		if (matched) {
			add(episodeNumberFromToken(matched[1]), subtitleFromTail(matched[2]));
		}
	}

	return found;
}

function subtitleFromMatchingEpisodeLine(value, episode) {
	return summarizeSubTitles(collectMatchingEpisodeSubtitles(value, episode));
}

function angleBracketSubtitle(value) {
	const text = stripPrivateUseMarks(value);
	const matched = text.match(/^[<＜]([^>＞]{1,100})[>＞]/);

	if (!matched) {
		return '';
	}

	return matched[1].trim();
}

function quotedSubtitle(value) {
	const text = stripPrivateUseMarks(value);
	const matched = text.match(/.{3,}[「『【]([^」』】]+)[」』】].*/);

	if (!matched) {
		return '';
	}

	return matched[1].trim();
}

function stripMultiBroadcastSuffix(value) {
	let text = String(value || '').trim();

	// 複数話/範囲放送だと判定できたときだけ、
	// 作品名末尾の放送形態語を控えめに除去する。
	// 例: "SAKAMOTO DAYS 一挙放送" -> "SAKAMOTO DAYS"
	text = text.replace(
		/[ 　]*(?:一挙(?:放送)?|まとめて放送|全話放送|連続放送)(?:[ 　]*[（(][0-9０-９]+[）)])?[ 　]*$/,
		''
	).trim();

	return text;
}

function splitProgramTitleAndEpisode(rawTitle, detail, flags) {
	const titleSource = String(rawTitle || '')
		.replace(flagBracketsRE, '')
		.replace(flagUniRE, '')
		.trim();
	const detailLeadLines = getDetailLeadLines(detail, 5);
	const detailFirstLine = detailLeadLines.length > 0 ? detailLeadLines[0] : '';
	const titleMarker = findEpisodeMarker(titleSource);

	let title = titleSource;
	let subtitle = '';
	let weakTitleTailSubtitle = '';
	let episode = null;
	let hasMulti = false;

	// title を最優先
	if (titleMarker) {
		if (titleMarker.isMulti) {
			hasMulti = true;
			title = titleSource.slice(0, titleMarker.index).trim() || titleSource;
			title = stripMultiBroadcastSuffix(title);

			// 複数話放送は episode に表示用の指定式をそのまま保持する。
			// 例: "3,4", "25-36", "62-65,65.5,66-70"
			episode = titleMarker.episode;
		} else if (titleMarker.episode !== null) {
			title = titleSource.slice(0, titleMarker.index).trim() || titleSource;
			episode = titleMarker.episode;

			const titleTail = titleSource.slice(titleMarker.end);
			const normalizedTitleTail = stripPrivateUseMarks(titleTail)
				.replace(/^[\s　:：\-－―—・]+/, '')
				.trim();

			// 「44:CLOUDY BEACH」の colon 形式と、
			// 「#12「副題」」の明示引用は title 側の強い副題候補として採用する。
			if (titleMarker.kind === 'colon' || /^[「『【]/.test(normalizedTitleTail)) {
				subtitle = subtitleFromTail(titleTail);
			} else {
				// 「#152 ★日本初放送エピソード」のような単なる後続文字列は
				// detail に episode 一致の副題が無い場合だけ最後に使う。
				weakTitleTailSubtitle = subtitleFromTail(titleTail);
			}
		}
	}

	// title に明示話数がない場合のみ detail を補助的に見る
	if (episode === null && !hasMulti) {
		const detailMarker = findEpisodeMarker(detailFirstLine);

		if (detailMarker) {
			// detail に連続した複数話指定式が明示されている場合は、
			// 表示用 episode としてその式を保持する。
			if (detailMarker.isMulti) {
				hasMulti = true;
				episode = detailMarker.episode;
				subtitle = '';
			} else if (detailMarker.episode !== null) {
				episode = detailMarker.episode;
				subtitle = subtitleFromTail(detailFirstLine.slice(detailMarker.end));
			}
		}
	}

	// detail 冒頭の数行から、episode と一致する明示話数行を副題候補にする。
	// 単話: #13 見上げて覗いて探して、次！ / #2「僕は大人のなりかけ」
	// 複数: #39「A」 #40「B」 -> A／B、3件以上 -> A／B／他
	if (subtitle === '' && episode !== null) {
		subtitle = summarizeSubTitles(collectMatchingEpisodeSubtitles(detail, episode));
	}

	// detail 先頭の ＜...＞ / <...> は副題・見出し表記として補助的に使う。
	if (!hasMulti && subtitle === '') {
		subtitle = angleBracketSubtitle(detailFirstLine);
	}

	// 単話の場合だけ副題の引用部を補助的に使う
	if (!hasMulti && subtitle === '') {
		subtitle = quotedSubtitle(detailFirstLine);
	}

	if (!hasMulti && subtitle === '') {
		subtitle = quotedSubtitle(titleSource);
	}

	// title の episode 後ろに残った単なる文字列は最弱の fallback。
	// detail 側の episode 一致副題や ＜...＞、引用副題を必ず優先する。
	if (!hasMulti && subtitle === '' && weakTitleTailSubtitle !== '') {
		subtitle = weakTitleTailSubtitle;
	}

	// [新] は明示話数も複数話表記もない場合だけ最後の fallback として 1。
	// [初] は各話の初回放送にも付くため episode 推測には使わない。
	if (episode === null && !hasMulti && flags.has('新') === true) {
		episode = 1;
	}

	return {
		title: title,
		subTitle: stripPrivateUseMarks(subtitle),
		episode: episode
	};
}

function convertPrograms(p, ch) {
	const programs = [];

	for (const c of p) {
		if (c.title === "") {
			continue;
		}

		let title = "";
		let subtitle = "";
		let epinum = null;
		const flags = new Set();

		// 理題 (flag)
		{
			const flagsSource = c.title
				.replace(/\[無料\]/g, "[無]")
				.replace(/\[生放送\]/g, "[生]");

			const matchedFlags = flagsSource.match(flagBracketsRE) || [];
			for (const matchedFlag of matchedFlags) {
				const flag = matchedFlag.match(flagExtractRE)[1];
				if (flagRE.test(flag) === true) {
					flags.add(flag);
				}
			}
		}

		// 理題 (flag) Unicode ARIB外字対応
		{
			const matchedFlags = c.title.match(flagUniRE) || [];
			for (const matchedFlag of matchedFlags) {
				flags.add(matchedFlag.normalize("NFKC"));
			}
		}

		// title / subtitle / episode
		{
			const parsed = splitProgramTitleAndEpisode(c.title, c.detail, flags);

			title = parsed.title;
			subtitle = parsed.subTitle;
			epinum = parsed.episode;
		}

		// オブジェクト作成
		const programData = c;
		programData.channel = ch;
		programData.title = title;
		programData.subTitle = subtitle;
		programData.episode = epinum;
		programData.flags = [...flags];

		programs.push(programData);
	}

	return programs;
}

function writeOut(s, callback) {

	schedule = s;

	schedule.sort(function (a, b) {
		if (a.n === b.n) {
			return a.sid - b.sid;
		} else {
			return a.n - b.n;
		}
	});

	if (!opts.get('s')) {
		fs.writeFileSync(SCHEDULE_DATA_FILE, JSON.stringify(schedule));
		schedulerLog('WRITE: ' + SCHEDULE_DATA_FILE);
	}

	callback();
}

// experimental
function getEpgFromMirakurun(path) {

	child_process.execSync('renice -n 19 -p ' + process.pid);

	schedulerLog('GETTING EPG from Mirakurun.');

	// new schedule
	const s = [];

	let channels = [];

	mirakurun.getServices()
		.then(services => {
			schedulerBaselines.services = schedulerPreflight.createValueBaseline(
				schedulerPreflight.projectServices(services)
			);

			schedulerLog('Mirakurun is OK.');
			schedulerLog('Mirakurun -> services: ' + services.length);

			const excludeServices = config.excludeServices || [];
			for (let i = 0; i < services.length; i++) {
				if (excludeServices.indexOf(services[i].id) !== -1) {
					services.splice(i, 1);
					i--;
				}
			}

			schedulerLog('Mirakurun -> services: ' + services.length + ' (excluded)');

			const serviceOrder = config.serviceOrder || [];
			let insertCount = 0;
			serviceOrder.forEach((id) => {
				const i = services.findIndex(service => service.id === id);
				if (i !== -1) {
					const [service] = services.splice(i, 1);
					services.splice(insertCount, 0, service);
					++insertCount;
				}
			});

			schedulerLog('Mirakurun -> sorted services: ' + insertCount);

			channels = services.map((service, i) => {
				return {
					type: service.channel.type,
					channel: service.channel.channel,
					name: service.name,
					id: service.id.toString(36),
					sid: service.serviceId,
					nid: service.networkId,
					hasLogoData: service.hasLogoData
				};
			});

			for (let i = 0, l = channels.length; i < l; i++) {
				channels[i].n = i;
			}

			return mirakurun.getPrograms();
		})
		.then(programs => {

			schedulerLog('Mirakurun -> programs: ' + programs.length);

			channels.forEach(channel => {
				mirakurunProgramsToLegacyPrograms(channel, programs);
			});

			return mirakurun.getTuners();
		})
		.then(_tuners => {

			tuners = _tuners;
			schedulerBaselines.tuners = schedulerPreflight.createValueBaseline(
				schedulerPreflight.projectTuners(tuners)
			);

			schedulerLog('Mirakurun -> tuners: ' + tuners.length);

			writeOut(channels, function () {
				runEpgEndCommand();
				scheduler();
			});
		})
		.catch(e => {

			schedulerLog('Mirakurun -> Error:');
			console.error(e);
			process.exit(1);
		});
}

const genreTable = {
	0x0: 'news',
	0x1: "sports",
	0x2: "information",
	0x3: "drama",
	0x4: "music",
	0x5: "variety",
	0x6: "cinema",
	0x7: "anime",
	0x8: "documentary",// new
	0x9: "theater",// new
	0xA: "hobby",// new
	0xB: "welfare",// new
	0xC: "etc",
	0xD: "etc",
	0xE: "etc",
	0xF: "etc"
};

function mirakurunProgramsToLegacyPrograms(ch, programs) {

	const programme = programs
		.filter(program => program.networkId === ch.nid && program.serviceId === ch.sid)
		.map(program => {

			const ret = {
				id: program.id.toString(36),
				category: program.genres ? genreTable[program.genres[0].lv1] : "etc",
				title: program.name || "",
				fullTitle: program.name || "",
				detail: program.description || "",
				start: program.startAt,
				end: program.startAt + program.duration,
				seconds: program.duration / 1000
			};

			if (program.extended) {
				ret.description = program.description;
				ret.extra = program.extended;

				for (let key in program.extended) {
					ret.detail += `\n◇${key}\n${program.extended[key]}`;
				}

				ret.detail = ret.detail.trim();
			}

			return ret;
		});

	ch.programs = convertPrograms(programme, JSON.parse(JSON.stringify(ch)));
}

// 既に実行中か
isRunning(running => {

	if (running) {
		console.error('ERROR: Scheduler is already running.');
		process.exit(1);
	} else {
		createPidFile();

		process.on('exit', () => deletePidFile());

		// EPGデータを取得または番組表を読み込む
		if (config.epgStartCommand) {
			const commandProcess = child_process.spawnSync(config.epgStartCommand, [process.pid, RULES_FILE, RESERVES_DATA_FILE, SCHEDULE_DATA_FILE]);
			schedulerLog('SPAWN: ' + config.epgStartCommand + ' (pid=' + commandProcess.pid + ')');
		}

		getEpgFromMirakurun(mirakurunPath);
	}
});
