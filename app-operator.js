/*!
 *  Chinachu Task Operator Service (chinachu-operator)
 *
 *  Copyright (c) 2016 Yuki KAN and Chinachu Project Contributors
 *  https://chinachu.moe/
**/
'use strict';

process.env.PATH = `${__dirname}/usr/bin:${process.env.PATH}`;

const CONFIG_FILE = __dirname + '/config.json';
const RESERVES_DATA_FILE  = __dirname + '/data/reserves.json';
const RESERVES2_DATA_FILE = __dirname + '/data/reserves2.json';
const RECORDING_DATA_FILE = __dirname + '/data/recording.json';
const RECORDED_DATA_FILE  = __dirname + '/data/recorded.json';
const MATCH_DATA_FILE     = __dirname + '/data/match.json';

// 標準モジュールのロード
const path = require('path');
const url = require('url');
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

// 終了処理
process.on('SIGQUIT', () => {
	setTimeout(() => {
		process.exit(0);
	}, 0);
});

// 例外処理
process.on('uncaughtException', (err) => {
	console.error('uncaughtException: ' + err.stack);
});

// 追加モジュールのロード
const dateFormat = require('dateformat');
// Node.js 18.15.0 以降の fs.statfs() を使用するため diskusage は不要
const nodemailer = require("nodemailer");
const sendmail = require("nodemailer-sendmail-transport");
const chinachu = require('chinachu-common');
const mirakurun = new (require("mirakurun").default)();

//
let reserves = [];
let recorded = [];
let recording = [];

// 設定の読み込み
const pkg = require("./package.json");
const config = require(CONFIG_FILE);

// settings
const schedulerIntervalTime = 1000 * 60 * 10;// 最長10分毎
const notifyIntervalTime = 1000 * 60 * 60 * 3;// 3時間毎
const prepTime = getHandoffPrepMillis();// 録画開始前の準備猶予
const recordingExpireGraceTime = 1000 * 60 * 5;// 終了後5分で録画中固着を掃除
const recordingPriority = config.recordingPriority || 2;
const conflictedPriority = config.conflictedPriority || 1;
const storageLowSpaceThresholdMB = config.storageLowSpaceThresholdMB || 3000;// 3 GB
const storageLowSpaceAction = config.storageLowSpaceAction || "remove"; // "none" | "stop" | "remove"
const storageLowSpaceNotifyTo = config.storageLowSpaceNotifyTo;// e-mail address
const storageLowSpaceCommand = config.storageLowSpaceCommand || null;// command

// 録画境界の準備猶予を取得する
// 未指定時は従来互換の20秒、指定時は0〜60秒の範囲で使用する
function getHandoffPrepMillis() {
	const seconds = Number(config.handoffPrepSeconds);

	if (!Number.isFinite(seconds) || seconds < 0) {
		return 1000 * 20;
	}

	return Math.min(seconds, 60) * 1000;
}

// setuid
if (process.platform !== "win32") {
	if (process.getuid() === 0) {
		if (typeof config.gid === "string" || typeof config.gid === "number") {
			process.setgid(config.gid);
		} else {
			process.setgid('video');
		}
		if (typeof config.uid === "string" || typeof config.uid === "number") {
			process.setuid(config.uid);
		} else {
			console.error("[fatal] 'uid' required in config.");
			process.exit(1);
		}
	}
}

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

mirakurun.userAgent = `Chinachu/${pkg.version} (operator)`;
mirakurun.priority = recordingPriority;

console.info(mirakurun);

// sendmail
const transporter = nodemailer.createTransport(sendmail());

// 初回起動や clean 環境向けに、不足している台帳JSONだけを作成する
ensureJsonArrayFile(RESERVES_DATA_FILE);
ensureJsonArrayFile(RESERVES2_DATA_FILE);
ensureJsonArrayFile(RECORDING_DATA_FILE);
ensureJsonArrayFile(RECORDED_DATA_FILE);
ensureJsonArrayFile(MATCH_DATA_FILE);

// 録画中リストをクリア
fs.writeFileSync(RECORDING_DATA_FILE, '[]');

// 保存先ディレクトリが存在しない場合には作成
if (!fs.existsSync(config.recordedDir)) {
	util.log('MKDIR: ' + config.recordedDir);
	fs.mkdirSync(config.recordedDir, { recursive: true });
}

// Tweeter (Experimental)
// mtwitter は旧Twitter API時代の依存であり、Node.js 24運用では本体起動から切り離す。
// operTweeter 設定が残っていても録画処理本体は継続し、通知のみ無効扱いにする。
if (config.operTweeter) {
	util.log('WARNING: operTweeter is disabled. mtwitter support has been detached from operator runtime.');
}

let clock = Date.now();
let scheduler = null;
let scheduled = 0;
let stChecked = 0;
let stNotified = 0;
let recordingChecked = 0;

// メインループ
setInterval(() => {

	clock = Date.now();

	for (let i = 0, l = reserves.length; i < l; i++) {
		reservesChecker(reserves[i]);
	}
}, 1000 * 3);

// 裏ループ
setInterval(() => {

	if ((scheduler === null) && (clock - scheduled > schedulerIntervalTime)) {
		startScheduler();
		scheduled = clock;
	}

	if (clock - stChecked > 1000 * 20) {
		storageChecker();
		stChecked = clock;
	}

	if (clock - recordingChecked > 1000 * 30) {
		recordingStaleChecker();
		recordingChecked = clock;
	}
}, 1000 * 6);

// 予約時間チェック
function reservesChecker(program) {

	// スキップする
	if (program.isSkip) {
		return;
	}

	// 予約時間超過
	if (clock > program.end) {
		return;
	}

	// 予約準備時間内
	if (program.start - clock < prepTime) {
		if (isRecording(program) === false) {
			prepRecord(program);
		}
	}
}

// 録画中か
function isRecording(program) {

	for (let i = 0, l = recording.length; i < l; i++) {
		if (recording[i].id === program.id) {
			return true;
		}
	}

	return false;
}

// 録画したか
function isRecorded(program) {

	for (let i = 0, l = recorded.length; i < l; i++) {
		if (recorded[i].id === program.id && clock < recorded[i].end) {
			return true;
		}
	}

	return false;
}

// 録画中の番組を更新
function recordingUpdater(program) {

	for (let i = 0, l = recording.length; i < l; i++) {
		if (recording[i].id === program.id) {
			for (let k in program) {
				if (program.hasOwnProperty(k)) {
					recording[i][k] = program[k];
				}
			}
			return;
		}
	}
}

// スケジューラーを停止
function stopScheduler() {
	process.removeListener('SIGINT',  stopScheduler);
	process.removeListener('SIGQUIT', stopScheduler);
	process.removeListener('SIGTERM', stopScheduler);

	if (scheduler === null) { return; }

	scheduler.kill('SIGQUIT');
	util.log('KILL: SIGQUIT -> Scheduler (pid=' + scheduler.pid + ')');
}

// スケジューラーを開始
function startScheduler() {
	if (scheduler !== null) { return; }

	var output, finalize;

	scheduler = child_process.spawn('./chinachu', [ 'update' ]);
	util.log('SPAWN: ./chinachu update (pid=' + scheduler.pid + ')');

	// ログ用
	output = fs.createWriteStream('./log/scheduler', { flags: 'a' });
	util.log('STREAM: ./log/scheduler');

	finalize = function () {

		util.log('EXIT: node app-scheduler.js (pid=' + scheduler.pid + ')');

		try {
			process.removeListener('SIGINT', stopScheduler);
			process.removeListener('SIGQUIT', stopScheduler);
			process.removeListener('SIGTERM', stopScheduler);
		} catch (e) {}

		try { output.end(); } catch (ee) {}

		scheduler = null;
	};

	scheduler.stdout.on('data', function (data) {
		try {
			output.write(data);
		} catch (e) {
			util.log('ERROR: Scheduler -> Abort (' + e + ')');
			finalize();
		}
	});

	scheduler.once('exit', finalize);

	process.once('SIGINT', stopScheduler);
	process.once('SIGQUIT', stopScheduler);
	process.once('SIGTERM', stopScheduler);
}

// 番組ログ用
function printProgram(program) {
	return `#${program.id} ${dateFormat(new Date(program.start), "isoDateTime")} [${program.channel.name}] ${program.title}`
}

// ストレージ容量取得
// Node.js 18.15.0 以降の fs.statfs() を使用し、diskusage 依存を避ける
function getDiskUsage(targetPath, callback) {
	if (typeof fs.statfs !== 'function') {
		callback(new Error('fs.statfs is not available. Node.js v18.15.0 or later is required.'));
		return;
	}

	fs.statfs(targetPath, (err, stats) => {
		if (err) {
			callback(err);
			return;
		}

		const blockSize = stats.bsize || stats.frsize;

		callback(null, {
			available: stats.bavail * blockSize,
			free: stats.bfree * blockSize,
			total: stats.blocks * blockSize
		});
	});
}

// 録画中リストを書き込む
function writeRecordingData() {
	fs.writeFileSync(RECORDING_DATA_FILE, JSON.stringify(recording));
	util.log('WRITE: ' + RECORDING_DATA_FILE);
}

// match.json を更新する
function updateMatchLedger(reason) {
	const appMatchingFile = __dirname + '/app-matching.js';
	let commandProcess;

	try {
		if (!fs.existsSync(appMatchingFile)) {
			util.log('WARNING: `' + appMatchingFile + '`が存在しないため match.json 更新をスキップしました');
			return;
		}

		ensureJsonArrayFile(RECORDED_DATA_FILE);
		ensureJsonArrayFile(RESERVES2_DATA_FILE);
		ensureJsonArrayFile(MATCH_DATA_FILE);

		util.log('RUN: ' + appMatchingFile + (reason ? ' (' + reason + ')' : ''));

		commandProcess = child_process.spawnSync(process.execPath, [
			appMatchingFile,
			'--recorded', RECORDED_DATA_FILE,
			'--reserves2', RESERVES2_DATA_FILE,
			'--old-match', MATCH_DATA_FILE,
			'--output', MATCH_DATA_FILE,
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

// JSON配列ファイルが未作成の場合だけ初期化する
// 既存ファイルが壊れている場合は上書きせず、各読み込み側の検知に任せる
function ensureJsonArrayFile(file) {
	if (fs.existsSync(file)) {
		return;
	}

	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, '[]');
	util.log('INIT JSON: ' + file);
}


// 録画保存先パスを取得する
function getRecordedPath(program) {
	return config.recordedDir + chinachu.formatRecordedName(program, program.recordedFormat || config.recordedFormat, {
		replaceEnclosingCharacters: config.recordedNameReplaceEnclosingCharacters === true ||
			config.needToReplaceEnclosingCharacters === true,
		enclosingCharacterMap: config.recordedNameEnclosingCharacterMap || null
	});
}

// 録画保存先HDDを事前に起こす
function wakeRecordedStorage(program) {
	let wakeFile = null;

	try {
		const recPath = program ? getRecordedPath(program) : path.join(config.recordedDir, '.chinachu-wakeup');
		const targetDir = path.dirname(recPath);

		if (!fs.existsSync(targetDir)) {
			util.log('MKDIR: ' + targetDir);
			fs.mkdirSync(targetDir, { recursive: true });
		}

		wakeFile = program ? recPath + '.chinachu-wakeup.tmp' : path.join(targetDir, '.chinachu-wakeup');

		fs.writeFileSync(wakeFile, [
			Date.now(),
			program ? program.id : '',
			program ? program.title : ''
		].join('\t'));
		fs.unlinkSync(wakeFile);

		util.log('WAKE: recorded storage ' + wakeFile);
	} catch (e) {
		try {
			if (wakeFile && fs.existsSync(wakeFile)) {
				fs.unlinkSync(wakeFile);
			}
		} catch (_) {}

		util.log('WARNING: recorded storage wake failed: ' + e.message);
	}
}

// 録画中番組をNG扱いにする
function markRecordingNg(program, reason) {
	if (!program) {
		return;
	}

	try {
		Object.defineProperty(program, '_operatorNg', {
			enumerable: false,
			configurable: true,
			value: reason || 'NG RECORDING'
		});
	} catch (e) {
		// 既に定義済みの場合は無視する
	}
}

// 録画中リストから削除する
function removeRecording(programId, reason) {
	let changed = false;

	for (let i = recording.length - 1; i >= 0; i--) {
		if (recording[i].id !== programId) {
			continue;
		}

		util.log((reason || 'REMOVE RECORDING') + ': ' + printProgram(recording[i]));
		recording.splice(i, 1);
		changed = true;
	}

	if (changed) {
		writeRecordingData();
	}
}

// ストリームを安全に中止する
function safeAbortStream(stream, reason) {
	if (!stream) {
		return;
	}

	try {
		if (typeof stream.unpipe === 'function') {
			stream.unpipe();
		}
	} catch (e) {
		util.log('WARNING: stream unpipe failed: ' + e.message);
	}

	try {
		if (stream.req && typeof stream.req.abort === 'function') {
			stream.req.abort();
		} else if (typeof stream.destroy === 'function') {
			stream.destroy();
		}
	} catch (e) {
		util.log('WARNING: ' + (reason || 'stream abort') + ' failed: ' + e.message);
	}
}

// 末尾切れ許可を確認する
function isEndLackAllowed(program) {
	return program && program.allowEndLack === true;
}

// 同一チャンネルの予約か確認する
function isSameChannelProgram(a, b) {
	if (!a || !b || !a.channel || !b.channel) {
		return false;
	}

	return (
		a.channel.type === b.channel.type &&
		String(a.channel.channel || '') === String(b.channel.channel || '') &&
		String(a.channel.sid || '') === String(b.channel.sid || '')
	);
}

// チャンネル切替のため末尾切れ候補になる録画を探す
// この段階では候補検出だけ行い、録画停止はしない
function findHandoffEndLackCandidate(nextProgram) {
	for (let i = 0, l = recording.length; i < l; i++) {
		const current = recording[i];

		if (!current || current.id === nextProgram.id) {
			continue;
		}

		if (!current._stream || current._operatorNg) {
			continue;
		}

		if (!isEndLackAllowed(current)) {
			continue;
		}

		if (isSameChannelProgram(current, nextProgram)) {
			continue;
		}

		if (!current.end || current.end - clock > prepTime) {
			continue;
		}

		return current;
	}

	return null;
}

// 録画中のまま固着した番組を掃除する
function recordingStaleChecker() {
	for (let i = recording.length - 1; i >= 0; i--) {
		const program = recording[i];

		if (!program || !program.end) {
			continue;
		}

		if (clock <= program.end + recordingExpireGraceTime) {
			continue;
		}

		markRecordingNg(program, 'NG RECORDING');

		if (program._stream) {
			safeAbortStream(program._stream, 'NG recording abort');
		}

		removeRecording(program.id, 'NG RECORDING');
	}
}

// 録画準備
function prepRecord(program) {

	if (clock > program.end) {
		return;
	}

	wakeRecordedStorage(program);

	util.log('PREPARE: ' + printProgram(program));

	// set priority
	mirakurun.priority = program.priority = program.priority || (program.isConflict ? conflictedPriority : recordingPriority);

	const handoffCandidate = findHandoffEndLackCandidate(program);
	if (handoffCandidate) {
		util.log('HANDOFF CANDIDATE: ' + printProgram(handoffCandidate) + ' -> ' + printProgram(program));
	}

	// get stream
	mirakurun.getProgramStream(parseInt(program.id, 36), true)
		.then(stream => {
			if (program._operatorNg || !isRecording(program) || clock > program.end) {
				util.log('DROP STREAM: ' + printProgram(program));
				safeAbortStream(stream, 'drop stream');
				return;
			}

			doRecord(program, stream);
		})
		.catch(err => {

			if (program._stream) {
				// 既に録画開始
				return;
			}

			if (err.req) {
				util.log("ERROR: " + printProgram(program), err.req.path, err.statusCode, err.statusMessage);
			} else {
				util.log("ERROR: " + printProgram(program), err.address, err.code);
			}

			const failedHandoffCandidate = findHandoffEndLackCandidate(program);
			if (failedHandoffCandidate) {
				util.log('HANDOFF READY: ' + printProgram(failedHandoffCandidate) + ' -> ' + printProgram(program));
			}

			// リトライ
			setTimeout(() => {
				const recordingIndex = recording.indexOf(program);
				if (recordingIndex !== -1) {
					recording.splice(recordingIndex, 1);
					writeRecordingData();
				}
			}, 5000);
		});

	recording.push(program);
	writeRecordingData();
}

// 録画実行
function doRecord(program, stream) {

	if (program._operatorNg || !isRecording(program) || clock > program.end) {
		util.log('DROP RECORD: ' + printProgram(program));
		safeAbortStream(stream, 'drop record');
		return;
	}

	util.log('RECORD: ' + printProgram(program));

	// dummy
	program.tuner = {
		name: `Mirakurun (${mirakurun.host ? mirakurun.host : "UnixSocket"})`,
		command: "*",
		isScrambling: false
	};
	program.command = `mirakurun type=${program.channel.type} url=${stream.req.path} priority=${program.priority}`;// dummy
	program.pid = -1;// dummy

	// 保存先パス
	const recPath = getRecordedPath(program);
	program.recorded = recPath;

	// 保存先ディレクトリ
	const recDirPath = path.dirname(recPath);
	if (!fs.existsSync(recDirPath)) {
		util.log('MKDIR: ' + recDirPath);
		fs.mkdirSync(recDirPath, { recursive: true });
	}

	// 保存ストリーム
	const recFile = fs.createWriteStream(recPath, { flags: 'a' });
	util.log('STREAM: ' + recPath);
	stream.pipe(recFile);

	// 録画プロセス終了時処理
	stream.once('end', finalize);

	// 終了シグナル時処理
	process.on('SIGINT', finalize);
	process.on('SIGQUIT', finalize);
	process.on('SIGTERM', finalize);

	// 状態更新
	writeRecordingData();

	// 内部用
	Object.defineProperty(program, "_stream", {
		enumerable: false,
		value: stream
	});

	// お片付け
	let finalized = false;
	function finalize() {

		if (finalized) {
			return;
		}
		finalized = true;

		safeAbortStream(stream, 'recording finalize');

		process.removeListener('SIGINT', finalize);
		process.removeListener('SIGQUIT', finalize);
		process.removeListener('SIGTERM', finalize);

		// 書き込みストリームを閉じる
		recFile.end();

		// 状態を更新
		delete program.pid;

		const isNgRecording = !!program._operatorNg;

		if (!isNgRecording) {
			for (let i = 0, l = recorded.length; i < l; i++) {
				if (recorded[i].id === program.id) {
					if (recorded[i].recorded === program.recorded) {
						recorded.splice(i, 1);
					} else {
						recorded[i].id += '-' + recorded[i].start.toString(36);
					}
					break;
				}
			}
			recorded.push(program);
			fs.writeFileSync(RECORDED_DATA_FILE, JSON.stringify(recorded));
			util.log('WRITE: ' + RECORDED_DATA_FILE);
			updateMatchLedger('recorded finalize');
		} else {
			util.log(program._operatorNg + ': ' + printProgram(program));
		}

		const recordingIndex = recording.indexOf(program);
		if (recordingIndex !== -1) {
			recording.splice(recordingIndex, 1);
		}
		writeRecordingData();
		if (program.isManualReserved) {
			for (let i = 0, l = reserves.length; i < l; i++) {
				if (reserves[i].id === program.id) {
					reserves.splice(i, 1);
					fs.writeFileSync(RESERVES_DATA_FILE, JSON.stringify(reserves));
					util.log('WRITE: ' + RESERVES_DATA_FILE);
					break;
				}
			}
		}

		// ポストプロセス
		if (!isNgRecording && config.recordedCommand) {
			const postProcess = child_process.spawn(config.recordedCommand, [recPath, JSON.stringify(program)]);
			util.log('SPAWN: ' + config.recordedCommand + ' (pid=' + postProcess.pid + ')');
		}

		util.log('FIN: ' + printProgram(program));
	}
}

// 録画中止
function stopRecording(programId, reason) {

	const program = recording.find(program => program.id === programId);

	if (program) {
		markRecordingNg(program, reason || 'ABORT RECORDING');
	}

	if (program && program._stream) {
		safeAbortStream(program._stream, reason || 'ABORT RECORDING');
	}
}

// ストレージチェック
function storageChecker() {

	getDiskUsage(config.recordedDir, (err, info) => {
		if (err) {
			util.log('WARNING: Storage check failed: ' + err.message);
			return;
		}

		const freeMB = info.available / 1024 / 1024;
		if (freeMB < storageLowSpaceThresholdMB) {
			stChecked = 0;// すぐに再チェックするため
			util.log(`ALERT: Storage Low Space! (${freeMB} MB < ${storageLowSpaceThresholdMB} MB)`);

			// 1. 指定コマンド実行
			if (storageLowSpaceCommand) {
				const command = child_process.spawn(storageLowSpaceCommand);
				util.log('SPAWN: ' + storageLowSpaceCommand + ' (pid=' + command.pid + ')');
			}

			// 2. アクション
			if (storageLowSpaceAction === "stop") {
				// 録画停止
				recording.forEach(program => stopRecording(program.id, 'LOW STORAGE'));
			} else if (storageLowSpaceAction === "remove") {
				// 削除
				if (recorded.length > 0) {
					const program = recorded.shift();
					if (fs.existsSync(program.recorded) === true) {
						fs.unlinkSync(program.recorded);
					}
					fs.writeFileSync(RECORDED_DATA_FILE, JSON.stringify(recorded));
					util.log('WRITE: ' + RECORDED_DATA_FILE);
					updateMatchLedger('recorded cleanup');
				}
			}

			// 3. メール通知
			if (storageLowSpaceNotifyTo && clock - stNotified > notifyIntervalTime) {
				stNotified = clock;

				transporter.sendMail({
					from: "Chinachu <chinachu@localhost>",
					to: storageLowSpaceNotifyTo,
					subject: "[Chinachu] ALERT: Storage Low Space!",
					text: `Current Free Space is ${freeMB} MB.\nThreshold is ${storageLowSpaceThresholdMB} MB.`
				}, (err, info) => {
					if (err) {
						console.log(err);
					}
				});
			}
		}
	});
}

// ファイル更新監視: ./data/reserves.json
chinachu.jsonWatcher(
	RESERVES_DATA_FILE,
	(err, data, mes) => {
		if (err) {
			console.error(err);
			return;
		}

		reserves = data;
		util.log(mes);

		if (recording.length > 0) {
			reserves.forEach(recordingUpdater);

			fs.writeFileSync(RECORDING_DATA_FILE, JSON.stringify(recording));
			util.log('WRITE: ' + RECORDING_DATA_FILE);
		}
	},
	{ create: [], now: true }
);

// ファイル更新監視: ./data/recorded.json
chinachu.jsonWatcher(
	RECORDED_DATA_FILE,
	(err, data, mes) => {
		if (err) {
			console.error(err);
			return;
		}

		recorded = data;
		util.log(mes);
	},
	{ create: [], now: true }
);

// ファイル更新監視: ./data/recording.json
chinachu.jsonWatcher(
	RECORDING_DATA_FILE,
	(err, data, mes) => {
		if (err) {
			console.error(err);
			return;
		}

		// 録画中止処理
		data.filter(program => !!program.abort).forEach(program => {
			stopRecording(program.id, 'ABORT RECORDING');
			removeRecording(program.id, 'ABORT RECORDING');
		});
	},
	{ create: [], now: false }
);
