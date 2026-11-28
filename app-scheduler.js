/*!
 *  Chinachu Task Scheduler (chinachu-scheduler)
 *
 *  Copyright (c) 2016 Yuki KAN and Chinachu Project Contributors
 *  https://chinachu.moe/
**/
'use strict';

const SCHEDULER_STATE_FILE = __dirname + '/data/scheduler-state.json';
const LEGACY_SCHEDULER_STATE_FILE = __dirname + '/data/epg-scheduler-state.json';

const CONFIG_FILE = __dirname + '/config.json';
const RULES_FILE = __dirname + '/rules.json';
const RESERVES_DATA_FILE = __dirname + '/data/reserves.json';
const RESERVES2_DATA_FILE = __dirname + '/data/reserves2.json';
const { flagBracketsRE, flagExtractRE, flagRE, flagUniRE, splitProgramTitleAndEpisode } = require('./lib/program-episode');
const RECORDING_DATA_FILE = __dirname + '/data/recording.json';
const RECORDED_DATA_FILE = __dirname + '/data/recorded.json';
const MATCH_DATA_FILE = __dirname + '/data/match.json';
const SCHEDULE_DATA_FILE = __dirname + '/data/schedule.json';
const ALREADY_RUNNING_EXIT_CODE = 76;
const RESERVES_CHANGED_EXIT_CODE = 75;

// 標準モジュールのロード
const path = require('path');
const fs = require('fs');
const util = require('util');
const schedulerState = require('./lib/scheduler-state');
const schedulerPreflight = require('./lib/operator-scheduler-preflight');
const reservationStore = require('./lib/reservation-store');
const runtimePathsModule = require('./lib/runtime-paths');
const schedulerStartedAt = Date.now();

let runtimePaths;
try {
	runtimePaths = runtimePathsModule.resolveRuntimePaths(__dirname);
} catch (error) {
	console.error('[fatal] failed to prepare runtime directory: ' + error.message);
	process.exit(1);
}
const PID_FILE = runtimePaths.schedulerPid;

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
if (!fs.existsSync('./data/') || !fs.existsSync('./log/')) {
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
reservationStore.ensureArrayFile(RESERVES_DATA_FILE);
let reserves = reservationStore.readArray(RESERVES_DATA_FILE);
let tuners = null;
const schedulerBaselines = schedulerState.emptyBaselines();
let reservesOutputIdentity = null;
const rulesReadFingerprint = schedulerPreflight.fingerprint(rules);
const rulesReadIdentity = schedulerPreflight.fileIdentity(RULES_FILE);
const reservesReadFingerprint = schedulerPreflight.fingerprint(reserves);
const reservesReadIdentity = schedulerPreflight.fileIdentity(RESERVES_DATA_FILE);

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
	const descriptor = fs.openSync(PID_FILE, 'wx', 0o600);
	try {
		fs.writeFileSync(descriptor, process.pid.toString(10));
	} finally {
		fs.closeSync(descriptor);
	}
}

function deletePidFile(expectedPid) {
	try {
		if (!fs.existsSync(PID_FILE)) return;
		const current = fs.readFileSync(PID_FILE, { encoding: 'utf8' }).trim();
		if (typeof expectedPid !== 'undefined' && current !== String(expectedPid)) return;
		fs.unlinkSync(PID_FILE);
	} catch (e) {
		schedulerLog('WARNING: `' + PID_FILE + '`の削除に失敗しました: ' + e.message);
	}
}

function isSchedulerProcess(pid) {
	try {
		process.kill(pid, 0);
	} catch (error) {
		if (error && error.code === 'ESRCH') return false;
		return true;
	}
	if (process.platform !== 'linux') return true;
	try {
		const argv = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').filter(Boolean);
		const script = argv.find(argument => /(^|\/)app-scheduler\.js$/.test(argument));
		if (!script) return false;
		const cwd = fs.realpathSync('/proc/' + pid + '/cwd');
		const resolved = path.isAbsolute(script) ? path.resolve(script) : path.resolve(cwd, script);
		return resolved === path.resolve(__filename);
	} catch (_) {
		// If identity cannot be inspected, fail closed and preserve the existing PID file.
		return true;
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

		if (isSchedulerProcess(Number(pid))) {
			callback(true);
		} else {
			deletePidFile(pid);
			callback(false);
		}
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


// (function) remake reserves
function outputReserves() {
	schedulerLog('WRITE: ' + RESERVES_DATA_FILE);

	var now = new Date().getTime();
	var array = [];

	reserves.forEach(function (reserve) {
		if (reserve.end < now) { return; }

		array.push(reserve);
	});

	// Every writer acquires rules before reserves; retain both locks through save.
	reservationStore.withLock(RULES_FILE, function () {
		reservationStore.withLock(RESERVES_DATA_FILE, function () {
			// reservation output lock acquired
			var latestReserves = reservationStore.readArray(RESERVES_DATA_FILE);
			if (!schedulerPreflight.sameFileIdentity(rulesReadIdentity, schedulerPreflight.fileIdentity(RULES_FILE)) ||
				schedulerPreflight.fingerprint(reservationStore.readArray(RULES_FILE)) !== rulesReadFingerprint ||
				!schedulerPreflight.sameFileIdentity(reservesReadIdentity, schedulerPreflight.fileIdentity(RESERVES_DATA_FILE)) ||
				schedulerPreflight.fingerprint(latestReserves) !== reservesReadFingerprint) {
				var changedError = new Error('rules.json or reserves.json changed while scheduler was running');
				changedError.code = 'RESERVES_CHANGED_DURING_RUN';
				// A reservation-only change may be invisible to the periodic projection.
				// Invalidate the existing baseline so the next periodic preflight retries.
				try {
					const stateStore = new schedulerState.SchedulerStateStore(SCHEDULER_STATE_FILE, {
						legacyFilePath: LEGACY_SCHEDULER_STATE_FILE
					});
					stateStore.update(state => {
						state.baselines.reserves = null;
						return state;
					});
				} catch (error) {
					schedulerLog('WARNING: scheduler baseline invalidation failed: ' + error.message);
				}
				throw changedError;
			}

			// 完全な一時fileを同一filesystem上でrenameし、途中書き込みを公開しない。
			reservationStore.writeArrayAtomic(RESERVES_DATA_FILE, array);
			reservesOutputIdentity = schedulerPreflight.fileIdentity(RESERVES_DATA_FILE);
			schedulerBaselines.reserves = schedulerPreflight.createFileBaseline(
				RESERVES_DATA_FILE,
				schedulerPreflight.projectReserves(array)
			);

			// reserves2 は副次出力。失敗しても本体の reserves.json 更新と後続フックを止めない
			try {
				schedulerLog('WRITE: ' + RESERVES2_DATA_FILE);

				reservationStore.updateArrayAtomic(RESERVES2_DATA_FILE, function (currentReserves2) {
					return reservationStore.remakeReserves2(currentReserves2, array, now, config, schedulerLog);
				}, { createIfMissing: true });
			} catch (e) {
				schedulerLog('WARNING: `' + RESERVES2_DATA_FILE + '`の保存に失敗しました: ' + (e && e.stack ? e.stack : e));
			}
		});
	});
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
				'--recording', RECORDING_DATA_FILE,
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
			if (chinachu.isMatchedProgram(rules, p, config.normalizationForm, config.epgTitleHalfWidthEnabled)) {
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

	var result = reservationStore.evaluateReservations(matches, tuners, rules, config, {
		log: schedulerLog,
		onConflict: function (program) {
			if (!config.conflictCommand) return;
			commandProcess = child_process.spawn(config.conflictCommand, [process.pid, program.id, dateFormat(new Date(program.start), 'isoDateTime'), program.channel.name, program.title, JSON.stringify(program)]);
			schedulerLog('SPAWN: ' + config.conflictCommand + ' (pid=' + commandProcess.pid + ')');
		}
	});
	reserves = result.reserves;
	var duplicateCount = result.duplicateCount;
	var conflictCount = result.conflictCount;
	var skipCount = result.skipCount;
	var reservedCount = result.reservedCount;

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
function formatEpgTitle(value) {
	const symbols = { '　': ' ', '!': '！', '?': '？', '*': '＊', '<': '＜', '>': '＞', '＃': '#', '♯': '#' };
	return value.replace(/[Ａ-Ｚａ-ｚ０-９　!?*<>＃♯]/g, character =>
		symbols[character] || String.fromCharCode(character.charCodeAt(0) - 0xFEE0));
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
		const flagsTitle = c.title;
		if (config.epgTitleHalfWidthEnabled === true) {
			c.title = formatEpgTitle(c.title);
			c.fullTitle = c.title;
		}

		// 理題 (flag)
		{
			const flagsSource = flagsTitle
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
			const matchedFlags = flagsTitle.match(flagUniRE) || [];
			for (const matchedFlag of matchedFlags) {
				flags.add(matchedFlag.normalize("NFKC"));
			}
		}

		// title / subtitle / episode
		{
			const parsed = splitProgramTitleAndEpisode(c.title, c.detail, flags, c.description);

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
		writeJsonAtomic(SCHEDULE_DATA_FILE, schedule);
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
			if (e && e.code === 'RESERVES_CHANGED_DURING_RUN') {
				schedulerLog('RESERVATION UPDATE CONFLICT: retry with the latest rules.json and reserves.json');
				console.error(e.message);
				process.exit(RESERVES_CHANGED_EXIT_CODE);
				return;
			}

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
		process.exit(ALREADY_RUNNING_EXIT_CODE);
	} else {
		try {
			createPidFile();
		} catch (error) {
			if (error && error.code === 'EEXIST') {
				console.error('ERROR: Scheduler runtime lock was acquired by another process.');
				process.exit(ALREADY_RUNNING_EXIT_CODE);
			}
			throw error;
		}

		process.on('exit', () => deletePidFile(process.pid));

		// EPGデータを取得または番組表を読み込む
		if (config.epgStartCommand) {
			const commandProcess = child_process.spawnSync(config.epgStartCommand, [process.pid, RULES_FILE, RESERVES_DATA_FILE, SCHEDULE_DATA_FILE]);
			schedulerLog('SPAWN: ' + config.epgStartCommand + ' (pid=' + commandProcess.pid + ')');
		}

		getEpgFromMirakurun(mirakurunPath);
	}
});
