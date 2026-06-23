/*!
 *  Chinachu Task Scheduler (chinachu-scheduler)
 *
 *  Copyright (c) 2016 Yuki KAN and Chinachu Project Contributors
 *  https://chinachu.moe/
**/
'use strict';

const PID_FILE = __dirname + '/data/scheduler.pid';

const CONFIG_FILE = __dirname + '/config.json';
const RULES_FILE = __dirname + '/rules.json';
const RESERVES_DATA_FILE = __dirname + '/data/reserves.json';
const RESERVES2_DATA_FILE = __dirname + '/data/reserves2.json';
const RECORDED_DATA_FILE = __dirname + '/data/recorded.json';
const MATCH_DATA_FILE = __dirname + '/data/match.json';
const SCHEDULE_DATA_FILE = __dirname + '/data/schedule.json';

// 標準モジュールのロード
const path = require('path');
const url = require("url");
const fs = require('fs');
const util = require('util');

// Node.js 24 では util.log が存在しないため、旧Chinachu互換のログ関数を補う
if (typeof util.log !== 'function') {
	util.log = function () {
		console.log(new Date().toISOString() + ' - ' + Array.prototype.join.call(arguments, ' '));
	};
}
const child_process = require('child_process');

// ディレクトリチェック
if (!fs.existsSync('./data/') || !fs.existsSync('./log/') || !fs.existsSync('./web/')) {
	console.error('必要なディレクトリが存在しないか、カレントワーキングディレクトリが不正です。');
	process.exit(1);
}

// 追加モジュールのロード
const opts = require('opts');
const dateFormat = require('dateformat');
const chinachu = require('chinachu-common');
const mirakurun = new (require("mirakurun").default)();

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

// Mirakurun Client
const mirakurunPath = config.mirakurunPath || config.schedulerMirakurunPath || "http+unix://%2Fvar%2Frun%2Fmirakurun.sock/";

if (/(?:\/|\+)unix:/.test(mirakurunPath) === true) {
	const standardFormat = /^http\+unix:\/\/([^\/]+)(\/?.*)$/;
	const legacyFormat = /^http:\/\/unix:([^:]+):?(.*)$/;

	if (standardFormat.test(mirakurunPath) === true) {
		mirakurun.socketPath = mirakurunPath.replace(standardFormat, "$1").replace(/%2F/g, "/");
		mirakurun.basePath = path.join(mirakurunPath.replace(standardFormat, "$2"), mirakurun.basePath);
	} else {
		mirakurun.socketPath = mirakurunPath.replace(legacyFormat, "$1");
		mirakurun.basePath = path.join(mirakurunPath.replace(legacyFormat, "$2"), mirakurun.basePath);
	}
} else {
	const urlObject = url.parse(mirakurunPath);
	mirakurun.host = urlObject.hostname;
	mirakurun.port = urlObject.port;
	mirakurun.basePath = path.join(urlObject.pathname, mirakurun.basePath);
}

mirakurun.userAgent = `Chinachu/${pkg.version} (scheduler)`;

console.info(mirakurun);

// スケジュール
var schedule = [];
if (fs.existsSync(SCHEDULE_DATA_FILE)) {
	try {
		schedule = JSON.parse(fs.readFileSync(SCHEDULE_DATA_FILE, { encoding: 'utf8' }));

		if (schedule instanceof Array === false) {
			util.log('WARNING: `' + SCHEDULE_DATA_FILE + '`の内容が不正です');
			schedule = [];
		}
	} catch (e) {
		util.log('WARNING: `' + SCHEDULE_DATA_FILE + '`のロードに失敗しました');
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
		util.log('WARNING: `' + PID_FILE + '`の削除に失敗しました: ' + e.message);
	}
}

// scheduler is running?
function isRunning(callback) {

	if (fs.existsSync(PID_FILE) === true) {
		var pid = fs.readFileSync(PID_FILE, { encoding: 'utf8' });
		pid = pid.trim();

		if (/^[0-9]+$/.test(pid) === false) {
			util.log('WARNING: `' + PID_FILE + '`の内容が不正です');
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
			util.log('INIT JSON: ' + file);
		}

		return [];
	}

	try {
		text = fs.readFileSync(file, { encoding: 'utf8' }).replace(/^\uFEFF/, '');
		data = JSON.parse(text || '[]');
	} catch (e) {
		if (options.allowInvalid) {
			util.log('WARNING: `' + file + '`のロードに失敗しました: ' + e.message);
			return [];
		}

		throw e;
	}

	if (data instanceof Array === false) {
		if (options.allowInvalid) {
			util.log('WARNING: `' + file + '`の内容が配列ではありません');
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

// (function) apply reserve option from matched rule
function applyRuleReserveOptions(reserve, rule, fallbackRuleId) {
	if (!reserve || !rule) {
		return;
	}

	reserve.ruleId = rule.id !== undefined ? rule.id : fallbackRuleId;
	reserve.allowEndLack = normalizeAllowEndLack(rule.allowEndLack);

	if (typeof rule.recorded_format !== 'undefined') {
		reserve.recordedFormat = rule.recorded_format;
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

	util.log('RESERVES2 RETENTION DAYS: ' + (keepDays > 0 ? keepDays : 'disabled'));

	/*
	 * reserves2 の扱い:
	 *   - 過去分(end < now)は reserves2RetentionDays 以内なら保持する
	 *   - reserves2RetentionDays より前に終了したものは削除する
	 *   - reserves2RetentionDays が 0 の場合は整理しない
	 *   - 現在/未来分(end >= now)は activeReserves、つまり reserves.json と同じ内容を正とする
	 *
	 * これにより、未来の予約ルール変更・解除で reserves.json から消えたものは
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
	util.log('WRITE: ' + RESERVES_DATA_FILE);

	var now = new Date().getTime();
	var array = [];

	reserves.forEach(function (reserve) {
		if (reserve.end < now) { return; }

		array.push(reserve);
	});

	// Chinachu本体・Web側の更新検知互換性を優先し、元版と同じ直接書き込みにする
	fs.writeFileSync(RESERVES_DATA_FILE, JSON.stringify(array));

	// reserves2 は副次出力。失敗しても本体の reserves.json 更新と後続フックを止めない
	try {
		util.log('WRITE: ' + RESERVES2_DATA_FILE);

		var currentReserves2 = readJsonArray(RESERVES2_DATA_FILE, { createIfMissing: true });
		var reserves2Array = remakeReserves2(currentReserves2, array, now);

		writeJsonAtomic(RESERVES2_DATA_FILE, reserves2Array);
	} catch (e) {
		util.log('WARNING: `' + RESERVES2_DATA_FILE + '`の保存に失敗しました: ' + (e && e.stack ? e.stack : e));
	}
}

// (function) update match ledger
function updateMatchLedger() {
	var appMatchingFile = __dirname + '/app-matching.js';
	var recordedDataFile = RECORDED_DATA_FILE;
	var matchDataFile = MATCH_DATA_FILE;
	var commandProcess;

	try {
		if (!fs.existsSync(appMatchingFile)) {
			util.log('WARNING: `' + appMatchingFile + '`が存在しないため match.json 更新をスキップしました');
			return;
		}

		readJsonArray(recordedDataFile, { createIfMissing: true });
		readJsonArray(RESERVES2_DATA_FILE, { createIfMissing: true });
		readJsonArray(matchDataFile, { createIfMissing: true });

		util.log('RUN: ' + appMatchingFile);

		commandProcess = child_process.spawnSync(process.execPath, [
			appMatchingFile,
			'--recorded', recordedDataFile,
			'--reserves2', RESERVES2_DATA_FILE,
			'--output', matchDataFile,
			'--config', CONFIG_FILE
		], {
			cwd: __dirname,
			stdio: 'inherit'
		});

		if (commandProcess.error) {
			throw commandProcess.error;
		}

		if (commandProcess.status !== 0) {
			util.log('WARNING: match.json の更新に失敗しました: exit status=' + commandProcess.status);
		}
	} catch (e) {
		util.log('WARNING: match.json の更新に失敗しました: ' + (e && e.stack ? e.stack : e));
	}
}

// (function) run epgEnd hook
function runEpgEndCommand() {
	if (config.epgEndCommand) {
		const commandProcess = child_process.spawn(config.epgEndCommand, [process.pid, RULES_FILE, RESERVES_DATA_FILE, SCHEDULE_DATA_FILE]);
		util.log('SPAWN: ' + config.epgEndCommand + ' (pid=' + commandProcess.pid + ')');
	}
}

// scheduler
function scheduler() {

	var i, j, k, l, a;
	var commandProcess;

	util.log('RUNNING SCHEDULER.');

	// schedulerStartフック
	if (!opts.get('s')) {
		if (config.schedulerStartCommand) {
			commandProcess = child_process.spawnSync(config.schedulerStartCommand, [process.pid, RULES_FILE, RESERVES_DATA_FILE, SCHEDULE_DATA_FILE]);
			util.log('SPAWN: ' + config.schedulerStartCommand + ' (pid=' + commandProcess.pid + ')');
		}
	}

	// IDが重複しているかチェックするだけ
	var idMap = {};
	schedule.forEach(function (ch) {
		ch.programs.forEach(function (p) {
			if (idMap[p.id]) {
				util.log('**WARNING**: ' + p.id + ' is duplicated!');
				console.log(JSON.stringify(idMap[p.id], null, '  '), JSON.stringify(p, null, '  '));
			} else {
				idMap[p.id] = p;
			}
		});
	});

	reserves = readJsonArray(RESERVES_DATA_FILE, { createIfMissing: true });//読み込む

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

	util.log('TUNERS: ' + JSON.stringify(typeNum));

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
						util.log('OVERRIDEBYRULE: ' + reserve.id + ' ' + dateFormat(new Date(reserve.start), 'isoDateTime') + ' [' + reserve.channel.name + '] ' + reserve.title);
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

			util.log('DUPLICATE: ' + a.id + ' ' + dateFormat(new Date(a.start), 'isoDateTime') + ' [' + a.channel.name + '] ' + a.title);
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
			util.log('!CONFLICT: ' + a.id + ' ' + dateFormat(new Date(a.start), 'isoDateTime') + ' [' + a.channel.name + '] ' + a.title);

			++conflictCount;
			// conflict フック
			if (config.conflictCommand) {
				commandProcess = child_process.spawn(config.conflictCommand, [process.pid, a.id, dateFormat(new Date(a.start), 'isoDateTime'), a.channel.name, a.title, JSON.stringify(a)]);
				util.log('SPAWN: ' + config.conflictCommand + ' (pid=' + commandProcess.pid + ')');
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
				util.log('!!!SKIP: ' + a.id + ' ' + dateFormat(new Date(a.start), 'isoDateTime') + ' [' + a.channel.name + '] ' + a.title);
				++skipCount;
			} else if (!a.isConflict) {
				util.log('RESERVE: ' + a.id + ' ' + dateFormat(new Date(a.start), 'isoDateTime') + ' [' + a.channel.name + '] ' + a.title);
				++reservedCount;
			} else {
				// 競合したときのログは既に出力済み
			}
		}
	}


	// results
	util.log('MATCHES: ' + matches.length.toString(10));
	util.log('DUPLICATES: ' + duplicateCount.toString(10));
	util.log('CONFLICTS: ' + conflictCount.toString(10));
	util.log('SKIPS: ' + skipCount.toString(10));
	util.log('RESERVES: ' + reservedCount.toString(10));

	if (!opts.get('s')) {
		outputReserves();
		updateMatchLedger();
		// schedulerEnd フック
		if (config.schedulerEndCommand) {
			commandProcess = child_process.spawn(config.schedulerEndCommand, [process.pid, RULES_FILE, RESERVES_DATA_FILE, SCHEDULE_DATA_FILE, matches.length.toString(10), duplicateCount.toString(10), conflictCount.toString(10), skipCount.toString(10), reservedCount.toString(10)]);
			util.log('SPAWN: ' + config.schedulerEndCommand + ' (pid=' + commandProcess.pid + ')');
		}
	}

	// プロセス終了
	process.exit(0);
}

// (function) program converter
const flagBracketsRE = /\[.{1,2}\]|【.】|\(.{1,2}\)/g;
const flagExtractRE = /(?:【|\[|\()(.{1,2})(?:】|\]|\))/;
const flagRE = /新|終|再|字|デ|解|無|二|S|SS|初|生|Ｎ|映|多|双/;
const flagUniRE = /🈟|🈡|🈞|🈑|🈓|🈖|🈚|🈔|🅂|🅍|🈠|🈢|🄽|🈙|🈕|🈒/g;
const subtitleRE = /.{3,}([「【]([^」】]+)[」】]).*/;
const subtitleExRE = /(?:[#＃♯][0-9０-９]{1,3}|[第][0-9０-９]{1,3}[話回])(?:[ 　「]+)([^「」]+)(?:[」]?)/;
const subtitleExExRE = /[「【][^」】]+[」】]/g;
const epinumRE = /[#＃♯][0-9０-９]{1,3}|[第][0-9０-９]{1,3}[話回]|（[0-9０-９]{1,3}）/g;
const epinumExRE = /[#＃♯][0-9０-９]{1,3}|[第][0-9０-９]{1,3}[話回]/;

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

		// 理題 (title)
		{
			title = c.title.replace(flagBracketsRE, "").replace(flagUniRE, "").trim();
		}

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

		// 理題 (subtitle)
		{
			const title = c.title.replace(flagBracketsRE, "");
			const detail = c.detail.split("\n")[0];

			const matchedSubtitleExInTitle = title.match(subtitleExRE);
			if (matchedSubtitleExInTitle) {
				subtitle = matchedSubtitleExInTitle[1];
			}

			if (subtitle === "") {
				const matchedSubtitleExInDetail = detail.match(subtitleExRE);
				if (matchedSubtitleExInDetail && matchedSubtitleExInDetail[1].length < 30) {
					subtitle = matchedSubtitleExInDetail[1];
				}
			}

			if (subtitle === "") {
				const matchedSubtitleInTitle = title.match(subtitleRE);
				if (matchedSubtitleInTitle) {
					subtitle = matchedSubtitleInTitle[2];
				}
			}

			if (subtitle === "") {
				const matchedSubtitleExExInDetail = detail.match(subtitleExExRE);
				if (matchedSubtitleExExInDetail && matchedSubtitleExExInDetail.length === 1) {
					subtitle = matchedSubtitleExExInDetail[0];
				}
			}

			if (subtitle !== "") {
				subtitle = subtitle
					.trim()
					.replace(/^[「【]/, "")
					.replace(/[」】]$/, "")
					.trim();
			}
		}

		// 理題 (epinum)
		{
			let epinumStr = "";

			const matchedEpinumInTitle = c.title.match(epinumRE);
			if (matchedEpinumInTitle) {
				epinumStr = matchedEpinumInTitle[0];
			}

			if (epinumStr === "") {
				const detail = c.detail.split("\n")[0];
				const matchedEpinumExInDetail = detail.match(epinumExRE);
				if (matchedEpinumExInDetail) {
					epinumStr = matchedEpinumExInDetail[0];
				}
			}

			if (epinumStr !== "") {
				epinumStr = epinumStr.match(/[0-9０-９]+/)[0];
				epinumStr = epinumStr
					.replace(/０/g, "0")
					.replace(/１/g, "1")
					.replace(/２/g, "2")
					.replace(/３/g, "3")
					.replace(/４/g, "4")
					.replace(/５/g, "5")
					.replace(/６/g, "6")
					.replace(/７/g, "7")
					.replace(/８/g, "8")
					.replace(/９/g, "9");

				epinum = parseInt(epinumStr, 10);
			}

			if (epinum === null && flags.has('新') === true) {
				epinum = 1;
			}
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
		util.log('WRITE: ' + SCHEDULE_DATA_FILE);
	}

	callback();
}

// experimental
function getEpgFromMirakurun(path) {

	child_process.execSync('renice -n 19 -p ' + process.pid);

	util.log('GETTING EPG from Mirakurun.');

	// new schedule
	const s = [];

	let channels = [];

	mirakurun.getServices()
		.then(services => {

			util.log('Mirakurun is OK.');
			util.log('Mirakurun -> services: ' + services.length);

			const excludeServices = config.excludeServices || [];
			for (let i = 0; i < services.length; i++) {
				if (excludeServices.indexOf(services[i].id) !== -1) {
					services.splice(i, 1);
					i--;
				}
			}

			util.log('Mirakurun -> services: ' + services.length + ' (excluded)');

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

			util.log('Mirakurun -> sorted services: ' + insertCount);

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

			util.log('Mirakurun -> programs: ' + programs.length);

			channels.forEach(channel => {
				mirakurunProgramsToLegacyPrograms(channel, programs);
			});

			return mirakurun.getTuners();
		})
		.then(_tuners => {

			tuners = _tuners;

			util.log('Mirakurun -> tuners: ' + tuners.length);

			writeOut(channels, function () {
				runEpgEndCommand();
				scheduler();
			});
		})
		.catch(e => {

			util.log('Mirakurun -> Error:');
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
			util.log('SPAWN: ' + config.epgStartCommand + ' (pid=' + commandProcess.pid + ')');
		}

		getEpgFromMirakurun(mirakurunPath);
	}
});
