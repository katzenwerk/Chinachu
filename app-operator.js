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
const fs = require('fs');
const util = require('util');

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

function operatorLog() {
	console.log(formatJstLogTime() + ' - ' + Array.prototype.join.call(arguments, ' '));
}

// Node.js 24 では util.log が存在しないため、旧Chinachu互換のログ関数を補う
// 既存の util.log がある環境では上書きしない
if (typeof util.log !== 'function') {
	util.log = operatorLog;
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
const endLackMaxSeconds = getEndLackMaxSeconds();// LACKで削ってよい最大秒数
const recordingExpireGraceTime = 1000 * 60 * 5;// 終了後5分で録画中固着を掃除
const recordingPriority = config.recordingPriority || 2;
const conflictedPriority = config.conflictedPriority || 1;
const storageLowSpaceThresholdMB = config.storageLowSpaceThresholdMB || 3000;// 3 GB
const storageLowSpaceAction = config.storageLowSpaceAction || "remove"; // "none" | "stop" | "remove"
const storageLowSpaceNotifyTo = config.storageLowSpaceNotifyTo;// e-mail address
const storageLowSpaceCommand = config.storageLowSpaceCommand || null;// command
const recordedStorageWakeupBeforeSec = getRecordedStorageWakeupBeforeSec();// 録画開始前HDD起動秒数。0/null/未指定は無効
const recordedStorageWakeupBeforeTime = recordedStorageWakeupBeforeSec * 1000;


// 録画境界の準備猶予を取得する
// 未指定時は従来互換の20秒、指定時は0〜60秒の範囲で使用する
function getHandoffPrepMillis() {
	const seconds = Number(config.handoffPrepSeconds);

	if (!Number.isFinite(seconds) || seconds < 0) {
		return 1000 * 20;
	}

	return Math.min(seconds, 60) * 1000;
}

// LACKで削ってよい最大秒数を取得する
// 未指定時は30秒、指定時も0〜60秒の範囲に丸める。
function getEndLackMaxSeconds() {
	const seconds = Number(config.endLackMaxSeconds);

	if (!Number.isFinite(seconds) || seconds < 0) {
		return 30;
	}

	return Math.min(seconds, 60);
}

// 録画開始前HDD起動秒数を取得する
// 0 / null / undefined / 空文字 / 数値不正は無効として扱う。
// 1以上の数値は秒単位で使用する。
function getRecordedStorageWakeupBeforeSec() {
	if (config.recordedStorageWakeupBeforeSec === null || typeof config.recordedStorageWakeupBeforeSec === 'undefined') {
		return 0;
	}

	const seconds = Number(config.recordedStorageWakeupBeforeSec);

	if (!Number.isFinite(seconds) || seconds <= 0) {
		return 0;
	}

	return Math.floor(seconds);
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
	const urlObject = new URL(mirakurunPath);
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
	operatorLog('MKDIR: ' + config.recordedDir);
	fs.mkdirSync(config.recordedDir, { recursive: true });
}

// Tweeter (Experimental)
// mtwitter は旧Twitter API時代の依存であり、Node.js 24運用では本体起動から切り離す。
// operTweeter 設定が残っていても録画処理本体は継続し、通知のみ無効扱いにする。
if (config.operTweeter) {
	operatorLog('WARNING: operTweeter is disabled. mtwitter support has been detached from operator runtime.');
}

let clock = Date.now();
let scheduler = null;
let scheduled = 0;
let stChecked = 0;
let stNotified = 0;
let recordingChecked = 0;
let recordedStorageWakeupHistory = {};


// メインループ
setInterval(() => {

	clock = Date.now();

	wakeReservedRecordedStorage();

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

	// すでに録画済みとして確定した番組は、同一放送時間内で再準備しない。
	// 手動中止や LACK は短縮録画済みとして recorded.json に残すため、
	// ここで再 PREPARE / 再 RECORD を防ぐ。
	if (isRecorded(program)) {
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
// reserves.json 側の状態を recording.json 側へ丸ごと逆流させない。
// recording は「現在録画中の実行状態」であり、isSkip などの予約判断フラグは持ち込まない。
// 録画開始後に反映してよい可能性が高い番組メタ情報・録画条件だけを限定的に同期する。
function recordingUpdater(program) {

	const copyKeys = [
		'title',
		'fullTitle',
		'detail',
		'description',
		'extra',
		'category',
		'channel',
		'flags',
		'subTitle',
		'episode',
		'start',
		'end',
		'seconds',
		'recordedFormat',
		'recordedDir',
		'recordedDirId',
		'allowEndLack',
		'priority'
	];

	for (let i = 0, l = recording.length; i < l; i++) {
		if (recording[i].id === program.id) {
			copyKeys.forEach(k => {
				if (program.hasOwnProperty(k)) {
					recording[i][k] = program[k];
				}
			});
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
	operatorLog('KILL: SIGQUIT -> Scheduler (pid=' + scheduler.pid + ')');
}

// スケジューラーを開始
function startScheduler() {
	if (scheduler !== null) { return; }

	var output, finalize;

	scheduler = child_process.spawn('./chinachu', [ 'update' ]);
	operatorLog('SPAWN: ./chinachu update (pid=' + scheduler.pid + ')');

	// ログ用
	output = fs.createWriteStream('./log/scheduler', { flags: 'a' });
	operatorLog('STREAM: ./log/scheduler');

	finalize = function () {

		operatorLog('EXIT: node app-scheduler.js (pid=' + scheduler.pid + ')');

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
			operatorLog('ERROR: Scheduler -> Abort (' + e + ')');
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
	operatorLog('WRITE: ' + RECORDING_DATA_FILE);
}

let matchLedgerUpdateTimer = null;
let matchLedgerUpdateReason = '';

function scheduleMatchLedgerUpdate(reason) {
	matchLedgerUpdateReason = reason || matchLedgerUpdateReason || 'scheduled';

	if (matchLedgerUpdateTimer !== null) {
		return;
	}

	matchLedgerUpdateTimer = setTimeout(() => {
		const runReason = matchLedgerUpdateReason;

		matchLedgerUpdateTimer = null;
		matchLedgerUpdateReason = '';
		updateMatchLedger(runReason);
	}, Number(config.matchUpdateDelayMs) >= 0 ? Number(config.matchUpdateDelayMs) : 3000);
}

function compactMatchOutput(stdout) {
	const lines = String(stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
	const summary = {};
	let keepRecordedOverMissed = 0;
	let cleanup = null;
	let oldNgRemoved = null;
	let inSummary = false;
	let messages = [];

	lines.forEach(line => {
		let m;

		if (line === 'KEEP_RECORDED_STATUS: RECORDED over MISSED') {
			keepRecordedOverMissed++;
			return;
		}

		if (line === '---- match summary ----') {
			inSummary = true;
			return;
		}

		m = line.match(/^MATCH_PRUNE_OLD_NG removed=(\d+)/);
		if (m) {
			oldNgRemoved = Number(m[1]);
			return;
		}

		m = line.match(/^RECORDED_HISTORY_CLEANUP days=(\d+) cutoff=(.+?) keep=(\d+) removed=(\d+)/);
		if (m) {
			cleanup = {
			days: Number(m[1]),
			cutoff: m[2],
			keep: Number(m[3]),
			removed: Number(m[4])
			};
			return;
		}

		m = line.match(/^([a-zA-Z0-9_()]+):\s*(.*)$/);
		if (inSummary && m) {
			summary[m[1]] = m[2];
			return;
		}

		messages.push(line);
	});

	if (Object.keys(summary).length > 0 || keepRecordedOverMissed > 0 || cleanup || oldNgRemoved !== null) {
		const parts = [];

		if (typeof summary.total !== 'undefined') { parts.push('total=' + summary.total); }
		if (typeof summary.recorded_all !== 'undefined') { parts.push('recorded=' + summary.recorded_all); }
		if (typeof summary.reserves2_all !== 'undefined') { parts.push('reserves2=' + summary.reserves2_all); }
		if (keepRecordedOverMissed > 0) { parts.push('keep_recorded_over_missed=' + keepRecordedOverMissed); }
		if (oldNgRemoved !== null) { parts.push('prune_old_ng=' + oldNgRemoved); }
		if (cleanup) { parts.push('cleanup_keep=' + cleanup.keep); parts.push('cleanup_removed=' + cleanup.removed); }
		if (typeof summary.saved !== 'undefined') { parts.push('saved=' + summary.saved); }

		if (parts.length > 0) {
			operatorLog('MATCH: updated ' + parts.join(' '));
		}

		if (config.matchVerbose === true) {
			const verboseParts = [];

			[ 'initial_build', 'read_days', 'keep_days', 'keep_months_compat', 'recorded_win', 'reserves2_win', 'window_by_key', 'reserves2_key_fallback', 'reserves2_key_mismatch', 'update_cutoff_day_start(JST)', 'keep_cutoff_month_start(JST)' ].forEach(key => {
				if (typeof summary[key] !== 'undefined') {
					verboseParts.push(key + '=' + summary[key]);
				}
			});

			if (cleanup) {
				verboseParts.push('cleanup_days=' + cleanup.days);
				verboseParts.push('cleanup_cutoff=' + cleanup.cutoff);
			}

			if (verboseParts.length > 0) {
				operatorLog('MATCH: detail ' + verboseParts.join(' '));
			}
		}
	}

	messages.forEach(line => {
		operatorLog('MATCH: ' + line);
	});
}

function emitMatchProcessOutput(commandProcess) {
	if (!commandProcess) {
		return;
	}

	compactMatchOutput(commandProcess.stdout || '');

	String(commandProcess.stderr || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).forEach(line => {
		operatorLog('MATCH STDERR: ' + line);
	});
}

// match.json を更新する
function updateMatchLedger(reason) {
	const appMatchingFile = __dirname + '/app-matching.js';
	let commandProcess;

	try {
		if (!fs.existsSync(appMatchingFile)) {
			operatorLog('WARNING: `' + appMatchingFile + '`が存在しないため match.json 更新をスキップしました');
			return;
		}

		ensureJsonArrayFile(RECORDED_DATA_FILE);
		ensureJsonArrayFile(RESERVES2_DATA_FILE);
		ensureJsonArrayFile(MATCH_DATA_FILE);

		operatorLog('RUN: ' + appMatchingFile + (reason ? ' (' + reason + ')' : ''));

		commandProcess = child_process.spawnSync(process.execPath, [
			appMatchingFile,
			'--recorded', RECORDED_DATA_FILE,
			'--reserves2', RESERVES2_DATA_FILE,
			'--old-match', MATCH_DATA_FILE,
			'--output', MATCH_DATA_FILE,
			'--config', CONFIG_FILE
		], {
			cwd: __dirname,
			encoding: 'utf8',
			stdio: [ 'ignore', 'pipe', 'pipe' ]
		});

		emitMatchProcessOutput(commandProcess);

		if (commandProcess.error) {
			throw commandProcess.error;
		}

		if (commandProcess.status !== 0) {
			operatorLog('WARNING: match.json の更新に失敗しました: exit status=' + commandProcess.status);
		}
	} catch (e) {
		operatorLog('WARNING: match.json の更新に失敗しました: ' + (e && e.stack ? e.stack : e));
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
	operatorLog('INIT JSON: ' + file);
}


// 録画保存先ディレクトリを正規化する
function normalizeRecordedDir(dir) {
	dir = String(dir || '').trim();

	if (dir === '') {
		return '';
	}

	return dir.replace(/\/+$/, '') + '/';
}

// 録画ファイル名を保存先ディレクトリからの相対パスとして正規化する
function normalizeRecordedName(name) {
	name = String(name || '').trim();

	// recordedFormat 側の先頭スラッシュは絶対パス扱いにせず、保存先配下の相対パスとして扱う
	return name.replace(/^\/+/, '');
}

// 録画保存先ディレクトリと録画ファイル名を結合する
function joinRecordedPath(dir, name) {
	dir = normalizeRecordedDir(dir);
	name = normalizeRecordedName(name);

	return dir + name;
}

// 録画保存先ディレクトリを取得する
function getRecordedDir(program) {
	if (program && typeof program.recordedDir === 'string' && program.recordedDir.trim() !== '') {
		return normalizeRecordedDir(program.recordedDir);
	}

	return normalizeRecordedDir(config.recordedDir);
}

// 録画保存先パスを取得する
function getRecordedPath(program) {
	const recordedName = chinachu.formatRecordedName(program, program.recordedFormat || config.recordedFormat, {
		replaceEnclosingCharacters: config.recordedNameReplaceEnclosingCharacters === true ||
			config.needToReplaceEnclosingCharacters === true,
		enclosingCharacterMap: config.recordedNameEnclosingCharacterMap || null
	});

	return joinRecordedPath(getRecordedDir(program), recordedName);
}

// 録画保存先HDDを起こす対象か確認する
function shouldWakeRecordedStorage(program) {
	if (recordedStorageWakeupBeforeTime <= 0) {
		return false;
	}

	if (!program || !program.id || !program.start) {
		return false;
	}

	if (program.isSkip) {
		return false;
	}

	if (clock > program.end) {
		return false;
	}

	if (isRecorded(program) || isRecording(program)) {
		return false;
	}

	if (recordedStorageWakeupHistory[program.id]) {
		return false;
	}

	const remainTime = program.start - clock;

	return remainTime > 0 && remainTime <= recordedStorageWakeupBeforeTime;
}

// 録画保存先HDD起動履歴を掃除する
function cleanupRecordedStorageWakeupHistory() {
	const activeProgramIds = {};

	for (let i = 0, l = reserves.length; i < l; i++) {
		if (reserves[i] && reserves[i].id && clock <= reserves[i].end) {
			activeProgramIds[reserves[i].id] = true;
		}
	}

	Object.keys(recordedStorageWakeupHistory).forEach(id => {
		if (!activeProgramIds[id]) {
			delete recordedStorageWakeupHistory[id];
		}
	});
}

// 録画保存先HDDを起こす
// 実録画ファイル名の末尾に一時ファイル名を付け、短い内容を書き込んですぐ削除する。
function wakeRecordedStorage(program) {
	let wakeFile = null;

	try {
		const recPath = getRecordedPath(program);
		const targetDir = path.dirname(recPath);

		if (!fs.existsSync(targetDir)) {
			operatorLog('MKDIR: ' + targetDir);
			fs.mkdirSync(targetDir, { recursive: true });
		}

		wakeFile = recPath + '.chinachu-wakeup.tmp';

		fs.writeFileSync(wakeFile, [
			Date.now(),
			program.id,
			program.title || ''
		].join('\t'));
		fs.unlinkSync(wakeFile);

		operatorLog('WAKE: recorded storage ' + wakeFile);
		return true;
	} catch (e) {
		try {
			if (wakeFile && fs.existsSync(wakeFile)) {
				fs.unlinkSync(wakeFile);
			}
		} catch (_) {}

		operatorLog('WARNING: recorded storage wake failed: ' + e.message);
		return false;
	}
}

// 予約一覧から、録画開始前HDD起動対象を巡回する
function wakeReservedRecordedStorage() {
	if (recordedStorageWakeupBeforeTime <= 0) {
		return;
	}

	cleanupRecordedStorageWakeupHistory();

	for (let i = 0, l = reserves.length; i < l; i++) {
		const program = reserves[i];

		if (!shouldWakeRecordedStorage(program)) {
			continue;
		}

		if (wakeRecordedStorage(program)) {
			recordedStorageWakeupHistory[program.id] = true;
		}
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

		operatorLog((reason || 'REMOVE RECORDING') + ': ' + printProgram(recording[i]));
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
		operatorLog('WARNING: stream unpipe failed: ' + e.message);
	}

	try {
		if (stream.req && typeof stream.req.abort === 'function') {
			stream.req.abort();
		} else if (typeof stream.destroy === 'function') {
			stream.destroy();
		}
	} catch (e) {
		operatorLog('WARNING: ' + (reason || 'stream abort') + ' failed: ' + e.message);
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
// stream取得失敗後だけ呼び出し、終了直前の allowEndLack 録画だけを対象にする。
function findHandoffEndLackCandidate(nextProgram) {
	return getHandoffEndLackCandidateInfo(nextProgram).candidate;
}

function getHandoffEndLackCandidateInfo(nextProgram) {
	let candidate = null;
	let candidateRemainSeconds = Infinity;
	let skipped = null;
	let skippedRemainSeconds = Infinity;

	for (let i = 0, l = recording.length; i < l; i++) {
		const current = recording[i];
		const remainSeconds = getEarlyFinishSeconds(current, clock);

		if (!current || current.id === (nextProgram && nextProgram.id)) {
			continue;
		}

		if (!current._stream || current._operatorNg || current._operatorEndLack) {
			continue;
		}

		if (!isEndLackAllowed(current)) {
			continue;
		}

		if (isSameChannelProgram(current, nextProgram)) {
			continue;
		}

		// 既に終了時刻を過ぎている番組はLACKではなく通常終了/固着掃除側に任せる。
		if (!current.end || Number(current.end) <= clock) {
			continue;
		}

		if (remainSeconds <= endLackMaxSeconds) {
			if (!candidate || remainSeconds < candidateRemainSeconds) {
				candidate = current;
				candidateRemainSeconds = remainSeconds;
			}
			continue;
		}

		if (!skipped || remainSeconds < skippedRemainSeconds) {
			skipped = current;
			skippedRemainSeconds = remainSeconds;
		}
	}

	return {
		candidate: candidate,
		candidateRemainSeconds: candidateRemainSeconds,
		skipped: skipped,
		skippedRemainSeconds: skippedRemainSeconds
	};
}

function logHandoffEndLackSkip(info, nextProgram) {
	if (!info || !info.skipped) {
		return;
	}

	operatorLog('HANDOFF END LACK SKIP: tuner shortage but candidate remains ' +
		formatSecondsForLog(info.skippedRemainSeconds) + ', over limit ' +
		formatSecondsForLog(endLackMaxSeconds) + ': ' +
		printProgram(info.skipped) + (nextProgram ? ' -> ' + printProgram(nextProgram) : ''));
}

function isTunerShortageError(err) {
	const statusCode = Number(err && err.statusCode || 0);
	const text = [
		err && err.code,
		err && err.statusMessage,
		err && err.message,
		err && err.body
	].join(' ').toLowerCase();

	if (statusCode === 409 || statusCode === 503) {
		return true;
	}

	return /tuner|busy|resource|conflict|unavailable|priority/.test(text);
}

function getEarlyFinishSeconds(program, at) {
	const end = Number(program && program.end || 0);
	const finishAt = Number(at || Date.now());

	if (!end || finishAt >= end) {
		return 0;
	}

	return Math.ceil((end - finishAt) / 1000);
}

function formatSecondsForLog(seconds) {
	seconds = Math.max(0, Math.floor(Number(seconds) || 0));

	if (seconds >= 60) {
		return Math.floor(seconds / 60) + '分' + ('0' + (seconds % 60)).slice(-2) + '秒';
	}

	return seconds + '秒';
}

function markRecordingAborted(program, reason) {
	if (!program || program._operatorAbort) {
		return;
	}

	program._operatorAbort = true;
	program.operatorAbort = true;
	program.operatorAbortAt = Date.now();
	program.operatorAbortReason = reason || 'ABORT RECORDING';
}

function finishRecordingForEndLack(currentProgram, nextProgram) {
	const finishAt = Date.now();
	const earlySeconds = getEarlyFinishSeconds(currentProgram, finishAt);

	if (!currentProgram || currentProgram._operatorEndLack) {
		return false;
	}

	currentProgram._operatorEndLack = true;
	currentProgram.operatorEndLack = true;
	currentProgram.operatorEndLackAt = finishAt;
	currentProgram.operatorEndLackReason = 'HANDOFF_TUNER';
	currentProgram.operatorEndLackByProgramId = nextProgram && nextProgram.id || '';
	currentProgram.operatorEndLackEarlySeconds = earlySeconds;

	operatorLog('HANDOFF END LACK: tuner shortage, finish ' + formatSecondsForLog(earlySeconds) + ' early for tuner handoff: ' +
		printProgram(currentProgram) + (nextProgram ? ' -> ' + printProgram(nextProgram) : ''));

	if (typeof currentProgram._operatorFinalize === 'function') {
		currentProgram._operatorFinalize();
		return true;
	}

	if (currentProgram._stream) {
		safeAbortStream(currentProgram._stream, 'handoff end lack');
		return true;
	}

	return false;
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

	if (!program.operatorPrepareStart) {
		program.operatorPrepareStart = Date.now();
	}

	operatorLog('PREPARE: ' + printProgram(program));

	// set priority
	mirakurun.priority = program.priority = program.priority || (program.isConflict ? conflictedPriority : recordingPriority);

	// LACKはここでは実行しない。
	// まず通常どおりstream取得を試し、チューナー不足等で失敗した場合だけ終了直前の録画を短縮する。

	// get stream
	mirakurun.getProgramStream(parseInt(program.id, 36), true)
		.then(stream => {
			if (program._operatorNg || !isRecording(program) || clock > program.end) {
				operatorLog('DROP STREAM: ' + printProgram(program));
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
				operatorLog("ERROR: " + printProgram(program), err.req.path, err.statusCode, err.statusMessage);
			} else {
				operatorLog("ERROR: " + printProgram(program), err.address, err.code);
			}

			if (isTunerShortageError(err)) {
				const handoffInfo = getHandoffEndLackCandidateInfo(program);
				if (handoffInfo.candidate) {
					if (finishRecordingForEndLack(handoffInfo.candidate, program)) {
						const recordingIndex = recording.indexOf(program);
						if (recordingIndex !== -1) {
							recording.splice(recordingIndex, 1);
							writeRecordingData();
						}

						// 旧録画をLACKで閉じた直後だけ、次番組のstream取得を即再試行する。
						setTimeout(() => {
							clock = Date.now();
							if (clock <= program.end && !isRecording(program) && !isRecorded(program)) {
								prepRecord(program);
							}
						}, 500);
						return;
					}
				} else {
					logHandoffEndLackSkip(handoffInfo, program);
				}
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
		operatorLog('DROP RECORD: ' + printProgram(program));
		safeAbortStream(stream, 'drop record');
		return;
	}

	operatorLog('RECORD: ' + printProgram(program));

	if (!program.operatorRecordingStart) {
		program.operatorRecordingStart = Date.now();
	}

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
		operatorLog('MKDIR: ' + recDirPath);
		fs.mkdirSync(recDirPath, { recursive: true });
	}

	// 保存ストリーム
	const recFile = fs.createWriteStream(recPath, { flags: 'a' });
	operatorLog('STREAM: ' + recPath);
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
		configurable: true,
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

		if (!program.operatorRecordingEnd) {
			program.operatorRecordingEnd = Date.now();
		}

		if (program.operatorRecordingStart && program.operatorRecordingEnd > program.operatorRecordingStart) {
			program.operatorActualSeconds = Math.floor((program.operatorRecordingEnd - program.operatorRecordingStart) / 1000);
		}

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
			operatorLog('WRITE: ' + RECORDED_DATA_FILE);
			scheduleMatchLedgerUpdate('recorded finalize');
		} else {
			operatorLog(program._operatorNg + ': ' + printProgram(program));
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
					operatorLog('WRITE: ' + RESERVES_DATA_FILE);
					break;
				}
			}
		}

		// ポストプロセス
		if (!isNgRecording && config.recordedCommand) {
			const postProcess = child_process.spawn(config.recordedCommand, [recPath, JSON.stringify(program)]);
			operatorLog('SPAWN: ' + config.recordedCommand + ' (pid=' + postProcess.pid + ')');
		}

		if (program._operatorEndLack) {
			operatorLog('FIN END LACK: ' + printProgram(program));
		} else if (program._operatorAbort) {
			operatorLog('FIN ABORT SHORT: ' + printProgram(program));
		} else {
			operatorLog('FIN: ' + printProgram(program));
		}
	}

	Object.defineProperty(program, "_operatorFinalize", {
		enumerable: false,
		configurable: true,
		value: finalize
	});
}

// 録画中止
// gamma系の挙動に寄せ、ストリーム開始後の中止は NG ではなく短縮録画済みとして確定する。
function stopRecording(programId, reason) {

	const program = recording.find(program => program.id === programId);
	const abortReason = reason || 'ABORT RECORDING';

	if (!program) {
		return;
	}

	markRecordingAborted(program, abortReason);

	if (typeof program._operatorFinalize === 'function') {
		operatorLog('ABORT RECORDING: short recorded: ' + printProgram(program));
		program._operatorFinalize();
		return;
	}

	if (program._stream) {
		operatorLog('ABORT RECORDING: short recorded: ' + printProgram(program));
		safeAbortStream(program._stream, abortReason);
		return;
	}

	// ストリーム取得前は録画ファイルが存在しないため、従来どおり NG 側で落とす。
	markRecordingNg(program, abortReason);
	removeRecording(program.id, abortReason);
}


// 容量不足時の削除対象拡張子か確認する
function isStorageCleanupTargetFile(filePath) {
	const ext = path.extname(filePath).toLowerCase();
	return ext === '.ts' || ext === '.m2ts';
}

// 現在録画中の保存先パス一覧を取得する
function getRecordingPathSet() {
	const paths = new Set();

	for (let i = 0, l = recording.length; i < l; i++) {
		if (!recording[i] || !recording[i].recorded) {
			continue;
		}

		paths.add(path.resolve(recording[i].recorded));
	}

	return paths;
}

// config.recordedDir 直下の古い録画ファイルを1件探す
// サブディレクトリ、シンボリックリンク、リンク先、別マウント配下は追わない
function findOldestRecordedFileInRecordedDir() {
	const baseDir = config.recordedDir;
	let entries;
	let oldest = null;
	const recordingPaths = getRecordingPathSet();

	try {
		entries = fs.readdirSync(baseDir);
	} catch (e) {
		operatorLog('WARNING: Storage cleanup scan failed: ' + e.message);
		return null;
	}

	for (let i = 0, l = entries.length; i < l; i++) {
		const filePath = path.join(baseDir, entries[i]);
		let stats;

		try {
			stats = fs.lstatSync(filePath);
		} catch (e) {
			operatorLog('WARNING: Storage cleanup stat failed: ' + filePath + ' (' + e.message + ')');
			continue;
		}

		if (!stats.isFile()) {
			continue;
		}

		if (stats.isSymbolicLink && stats.isSymbolicLink()) {
			continue;
		}

		if (!isStorageCleanupTargetFile(filePath)) {
			continue;
		}

		if (recordingPaths.has(path.resolve(filePath))) {
			continue;
		}

		if (oldest === null || stats.mtimeMs < oldest.mtimeMs) {
			oldest = {
				path: filePath,
				mtimeMs: stats.mtimeMs,
				size: stats.size
			};
		}
	}

	return oldest;
}

// 実ファイル削除後、recorded.json 側に同一パスの記録が残っていれば整合更新する
// 削除対象の選定には recorded 台帳を使わない
function removeRecordedLedgerEntriesByPath(filePath) {
	const resolvedFilePath = path.resolve(filePath);
	let changed = false;

	for (let i = recorded.length - 1; i >= 0; i--) {
		if (!recorded[i] || !recorded[i].recorded) {
			continue;
		}

		if (path.resolve(recorded[i].recorded) !== resolvedFilePath) {
			continue;
		}

		recorded.splice(i, 1);
		changed = true;
	}

	if (changed) {
		fs.writeFileSync(RECORDED_DATA_FILE, JSON.stringify(recorded));
		operatorLog('WRITE: ' + RECORDED_DATA_FILE);
		scheduleMatchLedgerUpdate('recorded cleanup');
	}
}

// 容量不足時に config.recordedDir 直下の最古 ts/m2ts を1件削除する
function removeOldestRecordedFileInRecordedDir() {
	const target = findOldestRecordedFileInRecordedDir();

	if (!target) {
		operatorLog('WARNING: Storage cleanup target not found in recordedDir root.');
		return false;
	}

	try {
		fs.unlinkSync(target.path);
		operatorLog('REMOVE: Storage cleanup -> ' + target.path + ' (' + target.size + ' bytes)');
		removeRecordedLedgerEntriesByPath(target.path);
		return true;
	} catch (e) {
		operatorLog('WARNING: Storage cleanup remove failed: ' + target.path + ' (' + e.message + ')');
		return false;
	}
}

// ストレージチェック
function storageChecker() {

	getDiskUsage(config.recordedDir, (err, info) => {
		if (err) {
			operatorLog('WARNING: Storage check failed: ' + err.message);
			return;
		}

		const freeMB = info.available / 1024 / 1024;
		if (freeMB < storageLowSpaceThresholdMB) {
			stChecked = 0;// すぐに再チェックするため
			operatorLog(`ALERT: Storage Low Space! (${freeMB} MB < ${storageLowSpaceThresholdMB} MB)`);

			// 1. 指定コマンド実行
			if (storageLowSpaceCommand) {
				const command = child_process.spawn(storageLowSpaceCommand);
				operatorLog('SPAWN: ' + storageLowSpaceCommand + ' (pid=' + command.pid + ')');
			}

			// 2. アクション
			if (storageLowSpaceAction === "stop") {
				// 録画停止
				recording.forEach(program => stopRecording(program.id, 'LOW STORAGE'));
			} else if (storageLowSpaceAction === "remove") {
				// config.recordedDir 直下の最古 ts/m2ts を1件削除する
				removeOldestRecordedFileInRecordedDir();
			} else if (storageLowSpaceAction === "none") {
				operatorLog('STORAGE LOW SPACE ACTION: none');
			} else {
				operatorLog('WARNING: Unknown storageLowSpaceAction: ' + storageLowSpaceAction);
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
		operatorLog(mes);

		if (recording.length > 0) {
			reserves.forEach(recordingUpdater);

			fs.writeFileSync(RECORDING_DATA_FILE, JSON.stringify(recording));
			operatorLog('WRITE: ' + RECORDING_DATA_FILE);
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
		operatorLog(mes);
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
		// stopRecording() 側で、ストリーム開始後は短縮録画済みとして finalize する。
		// ここで先に recording から消すと recorded.json へ即時反映されないため、削除は finalize に任せる。
		data.filter(program => !!program.abort).forEach(program => {
			stopRecording(program.id, 'ABORT RECORDING');
		});
	},
	{ create: [], now: false }
);

