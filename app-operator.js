/*!
 *  Chinachu Task Operator Service (chinachu-operator)
 *
 *  Copyright (c) 2016 Yuki KAN and Chinachu Project Contributors
 *  https://chinachu.moe/
**/
'use strict';

process.env.PATH = `${__dirname}/usr/bin:${process.env.PATH}`;

const CONFIG_FILE = __dirname + '/config.json';
const RULES_FILE = __dirname + '/rules.json';
const SCHEDULE_DATA_FILE = __dirname + '/data/schedule.json';
const RESERVES_DATA_FILE  = __dirname + '/data/reserves.json';
const RESERVES2_DATA_FILE = __dirname + '/data/reserves2.json';
const RECORDING_DATA_FILE = __dirname + '/data/recording.json';
const RECORDED_DATA_FILE  = __dirname + '/data/recorded.json';
const MATCH_DATA_FILE     = __dirname + '/data/match.json';
const STORAGE_STATE_FILE  = __dirname + '/data/storage-state.json';
const STORAGE_REFRESH_SOCKET = __dirname + '/data/storage-refresh.sock';
const SCHEDULER_STATE_FILE = __dirname + '/data/scheduler-state.json';
const LEGACY_SCHEDULER_STATE_FILE = __dirname + '/data/epg-scheduler-state.json';

// 標準モジュールのロード
const path = require('path');
const fs = require('fs');
const util = require('util');
const http = require('http');
const https = require('https');

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

// 例外処理
process.on('uncaughtException', (err) => {
	console.error('uncaughtException: ' + err.stack);
});

// 追加モジュールのロード
const dateFormat = require('dateformat').default;
// Node.js 18.15.0 以降の fs.statfs() を使用するため diskusage は不要
const notification = require('./lib/notification');
const recordingAttempt = require('./lib/recording-attempt');
const storageLow = require('./lib/storage-low');
const storageHealth = require('./lib/storage-health');
const { StorageMonitor } = require('./lib/storage-monitor');
const storageRuntimeState = require('./lib/storage-runtime-state');
const storageRefreshIpc = require('./lib/storage-refresh-ipc');
const storageManualRefresh = require('./lib/storage-manual-refresh');
const matchOutput = require('./lib/match-output');
const runtimePrivileges = require('./lib/runtime-privileges');
const mirakurunConnection = require('./lib/mirakurun-connection');
const mirakurunDropWatch = require('./lib/mirakurun-drop-watch');
const mirakurunEpgJobWatch = require('./lib/mirakurun-epg-job-watch');
const mirakurunEpgReconcile = require('./lib/mirakurun-epg-reconcile');
const operatorSchedulerRequest = require('./lib/operator-scheduler-request');
const operatorSchedulerPreflight = require('./lib/operator-scheduler-preflight');
const schedulerState = require('./lib/scheduler-state');
const reservationStore = require('./lib/reservation-store');
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
const prepTime = getHandoffPrepMillis();// 録画開始前の準備猶予
const endLackMaxSeconds = getEndLackMaxSeconds();// LACKで削ってよい最大秒数
const recordingExpireGraceTime = 1000 * 60 * 5;// 終了後5分で録画中固着を掃除
const recordingPriority = config.recordingPriority || 2;
const conflictedPriority = config.conflictedPriority || 1;
const storageThresholds = storageLow.resolveStorageThresholds(config);
const storageLowSpaceThresholdMB = storageThresholds.cleanupThresholdMB;
const storageLowSpaceWarningThresholdMB = storageThresholds.warningThresholdMB;
const storageLowSpaceWarningEnabled = storageThresholds.warningEnabled;
const storageLowSpaceWarningIntervalMinutes = storageLow.resolvePositiveNumber(
	config.storageLowSpaceWarningIntervalMinutes,
	180
);
const storageLowSpaceWarningIntervalTime = storageLowSpaceWarningIntervalMinutes * 60 * 1000;
const storageLowSpaceCriticalNotifyIntervalMinutes = storageLow.resolvePositiveNumber(
	config.storageLowSpaceCriticalNotifyIntervalMinutes,
	180
);
const storageLowSpaceCriticalNotifyIntervalTime = storageLowSpaceCriticalNotifyIntervalMinutes * 60 * 1000;
const storageLowSpaceConfiguredAction = config.storageLowSpaceAction;
const storageLowSpaceAction = storageLow.normalizeAction(storageLowSpaceConfiguredAction);
const notificationSettings = notification.resolveNotificationCommand(config);
const sendNotification = notification.createNotificationQueue(
	notification.createNotificationSender(notificationSettings.command, { log: operatorLog })
);
const recordedStorageWakeupBeforeSec = getRecordedStorageWakeupBeforeSec();// 録画開始前HDD起動秒数。0/null/未指定は無効
const recordedStorageWakeupBeforeTime = recordedStorageWakeupBeforeSec * 1000;
const mirakurunDropCheckIntervalTime = getMirakurunDropCheckIntervalTime();// 録画中drop監視間隔。0以下で無効
const reserveCheckIntervalTime = getReserveCheckIntervalTime();// 通常時の予約チェック間隔
const prepReserveCheckIntervalTime = getPrepReserveCheckIntervalTime();// 準備期間内の予約チェック間隔。通常間隔以上なら高速化なし
const recordedDurationProbeTimeoutMs = getRecordedDurationProbeTimeoutMs();// 録画済みTSのffprobe timeout


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


// 録画中drop監視間隔を取得する
// 未指定時は6秒、0以下は無効として扱う。
function getMirakurunDropCheckIntervalTime() {
	if (config.mirakurunDropCheckIntervalSec === null || typeof config.mirakurunDropCheckIntervalSec === 'undefined') {
		return 1000 * 6;
	}

	const seconds = Number(config.mirakurunDropCheckIntervalSec);

	if (!Number.isFinite(seconds) || seconds <= 0) {
		return 0;
	}

	return Math.max(1, Math.floor(seconds)) * 1000;
}

// 通常時の予約チェック間隔を取得する
// 未指定時は従来互換の3秒、1秒未満は1秒に丸める。
function getReserveCheckIntervalTime() {
	if (config.operatorReserveCheckIntervalSec === null || typeof config.operatorReserveCheckIntervalSec === 'undefined') {
		return 1000 * 3;
	}

	const seconds = Number(config.operatorReserveCheckIntervalSec);

	if (!Number.isFinite(seconds) || seconds <= 0) {
		return 1000 * 3;
	}

	return Math.max(1, Math.floor(seconds)) * 1000;
}

// 準備期間内の予約チェック間隔を取得する
// 未指定時は1秒。0以下は高速化無効として通常間隔を使う。
function getPrepReserveCheckIntervalTime() {
	if (config.operatorPrepReserveCheckIntervalSec === null || typeof config.operatorPrepReserveCheckIntervalSec === 'undefined') {
		return 1000;
	}

	const seconds = Number(config.operatorPrepReserveCheckIntervalSec);

	if (!Number.isFinite(seconds) || seconds <= 0) {
		return reserveCheckIntervalTime;
	}

	return Math.max(1, Math.floor(seconds)) * 1000;
}

// ffprobeは録画完了・shutdownの必須経路に含めない。
// timeoutは通常時の補助情報取得を長時間残さないための上限で、未指定時は8秒。
function getRecordedDurationProbeTimeoutMs() {
	const timeoutMs = Number(config.recordedDurationProbeTimeoutMs);

	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return 8000;
	}

	return Math.min(Math.floor(timeoutMs), 0x7fffffff);
}

// root管理方式ではsupplementary groupsを初期化してから権限を降格する。
try {
	runtimePrivileges.dropPrivileges(process, config);
} catch (error) {
	console.error('[fatal] failed to drop privileges: ' + error.message);
	process.exit(1);
}

// Mirakurun Client
const mirakurunPath = mirakurunConnection.configureClient(mirakurun, config);

mirakurun.userAgent = `Chinachu/${pkg.version} (operator)`;
mirakurun.priority = recordingPriority;

console.info(mirakurun);

notificationSettings.warnings.forEach(message => operatorLog('WARNING: ' + message));
if (typeof config.storageLowSpaceThresholdMB !== 'undefined' && config.storageLowSpaceThresholdMB !== storageLowSpaceThresholdMB) {
	operatorLog('WARNING: storageLowSpaceThresholdMB is invalid; using ' + storageLowSpaceThresholdMB + ' MB.');
}
if (typeof config.storageLowSpaceWarningThresholdMB !== 'undefined' && storageLowSpaceWarningThresholdMB === null) {
	operatorLog('WARNING: storageLowSpaceWarningThresholdMB is not a positive number; capacity warning is disabled.');
} else if (storageThresholds.legacyWarningDisabled) {
	operatorLog('WARNING: capacity warning is disabled by legacy storageLowSpaceWarningEnabled=false.');
} else if (storageLowSpaceWarningThresholdMB !== null && !storageLowSpaceWarningEnabled) {
	operatorLog('WARNING: storageLowSpaceWarningThresholdMB is not greater than storageLowSpaceThresholdMB; capacity warning is disabled.');
}
if (typeof config.storageLowSpaceWarningIntervalMinutes !== 'undefined' && config.storageLowSpaceWarningIntervalMinutes !== storageLowSpaceWarningIntervalMinutes) {
	operatorLog('WARNING: storageLowSpaceWarningIntervalMinutes is invalid; using ' + storageLowSpaceWarningIntervalMinutes + ' minutes.');
}
if (typeof config.storageLowSpaceCriticalNotifyIntervalMinutes !== 'undefined' && config.storageLowSpaceCriticalNotifyIntervalMinutes !== storageLowSpaceCriticalNotifyIntervalMinutes) {
	operatorLog('WARNING: storageLowSpaceCriticalNotifyIntervalMinutes is invalid; using ' + storageLowSpaceCriticalNotifyIntervalMinutes + ' minutes.');
}
if (typeof storageLowSpaceConfiguredAction === 'undefined') {
	operatorLog('WARNING: storageLowSpaceAction is not configured; using stop.');
} else if (storageLowSpaceConfiguredAction === 'none') {
	operatorLog('WARNING: storageLowSpaceAction none is deprecated; using stop without rewriting config.json.');
} else if (storageLowSpaceConfiguredAction !== 'remove' && storageLowSpaceConfiguredAction !== 'stop') {
	operatorLog('WARNING: Unknown storageLowSpaceAction `' + storageLowSpaceConfiguredAction + '`; using stop.');
}

// 初回起動や clean 環境向けに、不足している台帳JSONだけを作成する
reservationStore.ensureArrayFile(RESERVES_DATA_FILE);
ensureJsonArrayFile(RESERVES2_DATA_FILE);
ensureJsonArrayFile(RECORDING_DATA_FILE);
ensureJsonArrayFile(RECORDED_DATA_FILE);
ensureJsonArrayFile(MATCH_DATA_FILE);

// 録画中リストをクリア
fs.writeFileSync(RECORDING_DATA_FILE, '[]');

// 保存先ディレクトリが存在しない場合には作成
if (!fs.existsSync(config.recordedDir)) {
	const defaultDestination = storageHealth.findDestination(config, null);
	const defaultHealth = defaultDestination && storageHealth.inspectDestination(defaultDestination, {
		warningEnabled: storageLowSpaceWarningEnabled,
		warningThresholdMB: storageLowSpaceWarningThresholdMB,
		cleanupThresholdMB: storageLowSpaceThresholdMB,
		checkCapacity: false
	});
	if (!defaultDestination || !defaultDestination.protected || (defaultHealth && defaultHealth.canCreate)) {
		operatorLog('MKDIR: ' + config.recordedDir);
		fs.mkdirSync(config.recordedDir, { recursive: true });
	} else {
		operatorLog('WARNING: MKDIR blocked by Storage Health: ' + config.recordedDir + ' (' + defaultHealth.status + ')');
	}
}

// Tweeter (Experimental)
// mtwitter は旧Twitter API時代の依存であり、Node.js 24運用では本体起動から切り離す。
// operTweeter 設定が残っていても録画処理本体は継続し、通知のみ無効扱いにする。
if (config.operTweeter) {
	operatorLog('WARNING: operTweeter is disabled. mtwitter support has been detached from operator runtime.');
}

let clock = Date.now();
let scheduler = null;
let schedulerStartedAt = 0;
let scheduled = 0;
const storageMonitor = new StorageMonitor({
	inspect: storageHealth.inspectDestination,
	checkIntervalMs: 20000,
	inspectOptions: {
		warningEnabled: storageLowSpaceWarningEnabled,
		warningThresholdMB: storageLowSpaceWarningThresholdMB,
		cleanupThresholdMB: storageLowSpaceThresholdMB
	}
});
let storageCleanupState = {};
let storageLastPersistedRevision = -1;
let storageDisplaySnapshots = loadStorageDisplaySnapshots();
const runManualStorageRefresh = storageManualRefresh.createSingleFlight(handleManualStorageRefresh);
let storageRefreshServer = null;
let recordingChecked = 0;
let recordedStorageWakeupHistory = {};
let mirakurunDropChecked = 0;
let mirakurunDropChecking = false;
let mirakurunDropSnapshots = {};
let reserveCheckTimer = null;
let operatorInterval = null;
let periodicPreflightPending = false;
let shutdownStarted = false;
const activeRecordingOutputs = new Set();
const activeDurationProbes = new Set();

// EPG由来のscheduler要求だけをsingle pendingへ集約する。
// periodic schedulerはpreflightがdirtyの場合のみstartScheduler()を要求する。
const schedulerStateStore = new schedulerState.SchedulerStateStore(SCHEDULER_STATE_FILE, {
	legacyFilePath: LEGACY_SCHEDULER_STATE_FILE
});
const schedulerRequest = operatorSchedulerRequest.createSchedulerRequest({
	isSchedulerRunning: () => scheduler !== null,
	getSchedulerStartedAt: () => schedulerStartedAt,
	startScheduler: startScheduler,
	isShuttingDown: () => shutdownStarted,
	log: operatorLog,
	stateStore: schedulerStateStore
});

async function fetchMirakurunJobs() {
	const response = await mirakurun.call('getJobs');
	return response && Object.prototype.hasOwnProperty.call(response, 'body') ? response.body : response;
}

const schedulerPreflight = new operatorSchedulerPreflight.OperatorSchedulerPreflight({
	stateStore: schedulerStateStore,
	fetchJobs: fetchMirakurunJobs,
	fetchServices: () => mirakurun.getServices(),
	fetchTuners: () => mirakurun.getTuners(),
	paths: {
		state: SCHEDULER_STATE_FILE,
		rules: RULES_FILE,
		config: CONFIG_FILE,
		schedule: SCHEDULE_DATA_FILE,
		reserves: RESERVES_DATA_FILE,
		reserves2: RESERVES2_DATA_FILE,
		recorded: RECORDED_DATA_FILE
	}
});
const shadowPeriodicScheduler = new operatorSchedulerPreflight.ShadowPeriodicScheduler({
	preflight: schedulerPreflight,
	startScheduler: startScheduler,
	isShuttingDown: () => shutdownStarted,
	log: operatorLog
});

const epgJobWatcher = mirakurunEpgJobWatch.createWatcher({
	client: mirakurun,
	fetchJobs: fetchMirakurunJobs,
	log: operatorLog,
	onCycleSettled: (parentId, summary) => schedulerRequest.requestEpgCycle(parentId, summary)
});
epgJobWatcher.start();

const epgJobReconciler = mirakurunEpgReconcile.createReconciler({
	fetchJobs: fetchMirakurunJobs,
	requestCycle: (parentId, summary, metadata) => schedulerRequest.requestEpgCycle(parentId, summary, metadata),
	log: operatorLog
});
epgJobReconciler.start();


// メインループ
// 通常時は3秒程度でざっくり確認し、録画準備期間に入っている予約がある間だけ1秒程度で確認する。
// prepRecord() の判定は従来どおり reservesChecker() 側で行う。
function reserveCheckLoop() {
	if (shutdownStarted) {
		return;
	}

	clock = Date.now();

	wakeReservedRecordedStorage();

	for (let i = 0, l = reserves.length; i < l; i++) {
		reservesChecker(reserves[i]);
	}

	scheduleReserveCheckLoop();
}

function scheduleReserveCheckLoop() {
	const interval = getCurrentReserveCheckIntervalTime();

	reserveCheckTimer = setTimeout(reserveCheckLoop, interval);
}

function getCurrentReserveCheckIntervalTime() {
	if (prepReserveCheckIntervalTime < reserveCheckIntervalTime && hasPrepReserveCheckTarget()) {
		return prepReserveCheckIntervalTime;
	}

	return reserveCheckIntervalTime;
}

function hasPrepReserveCheckTarget() {
	for (let i = 0, l = reserves.length; i < l; i++) {
		const program = reserves[i];

		if (!program) {
			continue;
		}

		if (program.isSkip) {
			continue;
		}

		if (clock > program.end) {
			continue;
		}

		if (isRecordedForReserve(program)) {
			continue;
		}

		if (program.start - clock < prepTime) {
			// 番組開始前の準備期間中は、prepRecord() 済みかどうかに関係なく高速側を維持する。
			if (clock <= program.start) {
				return true;
			}

			// 番組開始後にまだ録画中扱いでない場合は、失敗後の再準備を拾いやすくする。
			if (isRecording(program) === false) {
				return true;
			}
		}
	}

	return false;
}

reserveCheckLoop();

// 裏ループ
operatorInterval = setInterval(() => {

	if ((scheduler === null) && (clock - scheduled > schedulerIntervalTime)) {
		if (scheduled === 0) {
			if (startScheduler()) {
				scheduled = clock;
			}
		} else {
			startPeriodicSchedulerWithPreflight();
		}
	}

	checkActiveRecordingStorage();

	if (clock - recordingChecked > 1000 * 30) {
		recordingStaleChecker();
		recordingChecked = clock;
	}

	if (mirakurunDropCheckIntervalTime > 0 && clock - mirakurunDropChecked > mirakurunDropCheckIntervalTime) {
		mirakurunDropChecker();
		mirakurunDropChecked = clock;
	}
}, 1000 * 6);

function startPeriodicSchedulerWithPreflight() {
	if (periodicPreflightPending || shutdownStarted) {
		return;
	}
	periodicPreflightPending = true;
	shadowPeriodicScheduler.request().then(outcome => {
		if (outcome && (outcome.started || (outcome.result && outcome.result.dirty === false))) {
			scheduled = clock;
		}
	}).finally(() => {
		periodicPreflightPending = false;
	});
}

// 予約時間チェック
function reservesChecker(program) {

	// スキップする
	if (program.isSkip || program._operatorNg || program._operatorAbort) {
		return;
	}

	// 予約時間超過
	if (clock > program.end) {
		return;
	}

	// すでに録画済みとして確定した番組は、同一放送時間内で再準備しない。
	// 手動中止や LACK は短縮録画済みとして recorded.json に残すため、
	// ここで再 PREPARE / 再 RECORD を防ぐ。
	if (isRecordedForReserve(program)) {
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

// graceful shutdown で中断した録画開始済みのルール予約だけを再開対象にする。
// isRecorded() の通常の終端判定は変更せず、その前段で限定的に使用する。
function getResumableInterruptedRecording(program) {
	if (!program || program.isManualReserved || clock > program.end) {
		return null;
	}

	for (let i = 0, l = recorded.length; i < l; i++) {
		const interrupted = recorded[i];

		if (!interrupted ||
			interrupted.id !== program.id ||
			interrupted.isManualReserved ||
			interrupted.operatorResumePending !== true ||
			interrupted.operatorAbort === true ||
			interrupted.operatorEndLack === true ||
			typeof interrupted.recorded !== 'string' ||
			interrupted.recorded.trim() === '') {
			continue;
		}

		return interrupted;
	}

	return null;
}

function isRecordedForReserve(program) {
	return isRecorded(program) && getResumableInterruptedRecording(program) === null;
}

function inheritInterruptedRecording(program, interrupted) {
	if (!program || !interrupted) {
		return;
	}

	program.operatorResumePending = true;
	program.operatorInterruptedAt = interrupted.operatorInterruptedAt;
	program.operatorInterruptionCount = Number(interrupted.operatorInterruptionCount) || 1;

	if (interrupted.operatorResumedAt) {
		program.operatorResumedAt = interrupted.operatorResumedAt;
	}

	Object.defineProperty(program, '_operatorResumeRecordedPath', {
		enumerable: false,
		configurable: true,
		value: interrupted.recorded
	});
}

function markRecordingInterruptedForResume(program) {
	if (!program ||
		program.isManualReserved ||
		program._operatorNg ||
		program._operatorAbort ||
		program._operatorEndLack ||
		program.operatorAbort === true ||
		program.operatorEndLack === true) {
		return false;
	}

	program.operatorResumePending = true;
	program.operatorInterruptedAt = Date.now();
	program.operatorInterruptionCount = (Number(program.operatorInterruptionCount) || 0) + 1;
	return true;
}

// 同一番組を異なる保存先へ録画した場合の旧録画IDを一意にする。
// 最初の衝突では従来互換の <program id>-<start base36> を維持し、
// そのIDも使用済みの場合だけ -2, -3, ... を付ける。
function getUniqueRecordedCollisionId(program, recordedPrograms) {
	const baseId = program.id + '-' + program.start.toString(36);
	let candidate = baseId;
	let sequence = 2;

	while (recordedPrograms.some(recordedProgram => recordedProgram.id === candidate)) {
		candidate = baseId + '-' + sequence;
		sequence++;
	}

	return candidate;
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
	if (scheduler === null) { return; }

	const signal = 'SIGINT';
	try {
		if (process.platform !== 'win32') {
			process.kill(-scheduler.pid, signal);
		} else {
			scheduler.kill(signal);
		}
		operatorLog('KILL: ' + signal + ' -> Scheduler group (pid=' + scheduler.pid + ')');
	} catch (error) {
		if (error.code !== 'ESRCH') {
			operatorLog('WARNING: Scheduler stop failed: ' + error.message);
		}
	}
}

// スケジューラーを開始
function startScheduler() {
	if (scheduler !== null) { return false; }

	var finalize;

	scheduler = child_process.spawn('./chinachu', [ 'update' ], {
		detached: process.platform !== 'win32'
	});
	schedulerStartedAt = Date.now();
	const startedScheduler = scheduler;
	operatorLog('SPAWN: ./chinachu update (pid=' + scheduler.pid + ')');

	// ./chinachu update 側の tee が scheduler log を保存する。
	// 転送された stdout は再追記せず、pipe が詰まらないよう明示的に drain する。
	scheduler.stdout.resume();

	finalize = function (code, signal) {

		operatorLog('EXIT: node app-scheduler.js (pid=' + startedScheduler.pid + ')');

		scheduler = null;
		schedulerStartedAt = 0;
		schedulerRequest.onSchedulerExit({
			successful: code === 0 && signal === null,
			finishedAt: Date.now()
		});
		completeOperatorShutdown();
	};

	scheduler.once('exit', finalize);
	return true;

}

function completeOperatorShutdown() {
	if (!shutdownStarted || scheduler !== null || activeRecordingOutputs.size !== 0) {
		return;
	}

	operatorLog('SHUTDOWN: complete');
	process.exit(0);
}

function shutdownOperator(signal) {
	if (shutdownStarted) {
		return;
	}
	shutdownStarted = true;
	operatorLog('SHUTDOWN: ' + signal);

	if (reserveCheckTimer !== null) {
		clearTimeout(reserveCheckTimer);
		reserveCheckTimer = null;
	}
	if (operatorInterval !== null) {
		clearInterval(operatorInterval);
		operatorInterval = null;
	}
	if (storageRefreshServer) {
		storageRefreshServer.close();
		storageRefreshServer = null;
	}

	epgJobReconciler.stop();
	epgJobWatcher.stop();
	shadowPeriodicScheduler.stop();
	schedulerPreflight.stop();
	stopScheduler();
	stopActiveDurationProbes();
	recording.slice().forEach(program => {
		if (typeof program._operatorFinalize === 'function') {
			markRecordingInterruptedForResume(program);
			program._operatorFinalize();
		}
	});

	setTimeout(() => {
		operatorLog('FATAL: graceful shutdown timed out.');
		if (scheduler !== null && process.platform !== 'win32') {
			try {
				process.kill(-scheduler.pid, 'SIGKILL');
			} catch (error) {
				if (error.code !== 'ESRCH') {
					operatorLog('WARNING: Scheduler force stop failed: ' + error.message);
				}
			}
		}
		process.exit(1);
	}, 10000);
	completeOperatorShutdown();
}

[ 'SIGINT', 'SIGTERM', 'SIGQUIT' ].forEach(signal => {
	process.on(signal, () => shutdownOperator(signal));
});

// 番組ログ用
function printProgram(program) {
	return `#${program.id} ${dateFormat(new Date(program.start), "isoDateTime")} [${program.channel.name}] ${program.title}`
}

// 録画中リストを書き込む
function writeRecordingData() {
	fs.writeFileSync(RECORDING_DATA_FILE, JSON.stringify(recording));
	operatorLog('WRITE: ' + RECORDING_DATA_FILE);
}

// 録画済みTSの実ファイル長をffprobeで取得する。
// probeは録画完了後のbest-effort処理であり、失敗しても完了状態を変更しない。
function probeRecordedDuration(filePath, callback) {
	if (shutdownStarted) {
		return null;
	}

	const configuredCommand = typeof config.ffprobeCommand === 'string' ? config.ffprobeCommand.trim() : '';
	const command = configuredCommand || 'ffprobe';
	let probe = null;
	let completed = false;

	function complete(duration) {
		if (completed) {
			return;
		}
		completed = true;
		if (probe) {
			activeDurationProbes.delete(probe);
		}
		callback(duration);
	}

	try {
		probe = child_process.execFile(
			command,
			[
				'-v', 'fatal',
				'-show_entries', 'format=duration',
				'-of', 'default=noprint_wrappers=1:nokey=1',
				filePath
			],
			{
				timeout: recordedDurationProbeTimeoutMs,
				maxBuffer: 64 * 1024,
				encoding: 'utf8'
			},
			(error, stdout) => {
				if (error) {
					operatorLog('WARNING: ffprobe duration failed: ' + filePath + ' (' + error.message + ')');
					complete(null);
					return;
				}

				const duration = Number(String(stdout || '').trim());

				if (!Number.isFinite(duration) || duration <= 0) {
					operatorLog('WARNING: ffprobe duration invalid: ' + filePath + ' (' + String(stdout || '').trim() + ')');
					complete(null);
					return;
				}

				complete(Math.round(duration * 1000000) / 1000000);
			}
		);
		activeDurationProbes.add(probe);
	} catch (error) {
		operatorLog('WARNING: ffprobe duration failed: ' + filePath + ' (' + error.message + ')');
		complete(null);
	}

	return probe;
}

// probe開始後にもrecorded.jsonはcleanup等で変化し得るため、disk上の現行entryを再確認して追記する。
function persistRecordedDuration(programId, recordedPath, duration) {
	let currentRecorded;
	let currentEntry;

	try {
		currentRecorded = JSON.parse(fs.readFileSync(RECORDED_DATA_FILE, { encoding: 'utf8' }));
		if (!Array.isArray(currentRecorded)) {
			throw new Error('recorded data is not an array');
		}

		currentEntry = currentRecorded.find(entry => entry && entry.id === programId && entry.recorded === recordedPath);
		if (!currentEntry || currentEntry.operatorResumePending === true) {
			operatorLog('WARNING: ffprobe duration target changed, skip update: ' + recordedPath);
			return false;
		}

		currentEntry.recordedDurationSeconds = duration;
		fs.writeFileSync(RECORDED_DATA_FILE, JSON.stringify(currentRecorded));
		operatorLog('WRITE: ' + RECORDED_DATA_FILE);

		const memoryEntry = recorded.find(entry => entry && entry.id === programId && entry.recorded === recordedPath);
		if (memoryEntry && memoryEntry.operatorResumePending !== true) {
			memoryEntry.recordedDurationSeconds = duration;
		}

		operatorLog('DURATION: ' + duration.toFixed(6) + ' sec ' + recordedPath);
		scheduleMatchLedgerUpdate('recorded duration');
		return true;
	} catch (error) {
		operatorLog('WARNING: ffprobe duration update failed: ' + recordedPath + ' (' + error.message + ')');
		return false;
	}
}

function stopActiveDurationProbes() {
	activeDurationProbes.forEach(probe => {
		try {
			probe.kill('SIGTERM');
		} catch (error) {
			operatorLog('WARNING: ffprobe stop failed: ' + error.message);
		}
	});
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
	const compacted = matchOutput.compactKeepRecordedStatus(stdout);
	const lines = compacted.lines;
	const summary = {};
	const keepRecordedOverMissed = compacted.keepRecordedOverMissed;
	let cleanup = null;
	let oldNgRemoved = null;
	let inSummary = false;
	let messages = [];

	lines.forEach(line => {
		let m;

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

// expectedMountのmount guardと、Low対象filesystemの録画開始guardを適用する。
// 未設定の従来録画先にはmount必須条件を適用しない。
function ensureRecordingDestinationHealthy(program, allowCreate) {
	if (program && typeof program.recordedDirId === 'string' && program.recordedDirId.trim() !== '' &&
		(typeof program.recordedDir !== 'string' || program.recordedDir.trim() === '')) {
		const now = Date.now();
		if (!program._storageHealthRetryAt || now >= program._storageHealthRetryAt) {
			operatorLog('WARNING: Recording destination blocked by Storage Health: unresolved recordedDirId `' +
				program.recordedDirId + '`; default fallback is disabled.');
			Object.defineProperty(program, '_storageHealthRetryAt', {
				enumerable: false,
				configurable: true,
				writable: true,
				value: now + 5000
			});
		}
		return false;
	}

	const destination = storageHealth.findDestination(config, program);
	if (!destination) {
		return false;
	}

	let health = storageMonitor.check(destination, { now: Date.now() });

	if (allowCreate && health.status === 'missing' && health.canCreate) {
		try {
			operatorLog('MKDIR: ' + destination.path);
			fs.mkdirSync(destination.path, { recursive: true });
			health = storageMonitor.check(destination, { now: Date.now(), force: true });
		} catch (error) {
			health.status = error.code === 'EROFS' ? 'read-only' : 'unknown';
			health.detail = error.message;
		}
	}

	if (health.filesystemKey) {
		Object.defineProperty(program, '_storageFilesystemKey', {
			enumerable: false,
			configurable: true,
			writable: true,
			value: health.filesystemKey
		});
	}

	if (health.filesystemKey && health.capacityCheckedAt) {
		handleStorageGroup(health, destination);
	} else {
		persistStorageRuntimeState();
	}

	if (health.stopNewRecordings === true) {
		const now = Date.now();
		if (!program || !program._storageHealthRetryAt || now >= program._storageHealthRetryAt) {
			operatorLog('WARNING: Recording destination blocked by Storage: ' + destination.path +
				' (' + (health.phase || health.status || 'unknown') + ', action=' + storageLowSpaceAction + ')');
			if (program) {
				Object.defineProperty(program, '_storageHealthRetryAt', {
					enumerable: false,
					configurable: true,
					writable: true,
					value: now + 5000
				});
			}
		}
		return false;
	}

	if (health.status === 'ok' || health.status === 'low-space') {
		return true;
	}

	const now = Date.now();
	if (!program || !program._storageHealthRetryAt || now >= program._storageHealthRetryAt) {
		operatorLog('WARNING: Recording destination blocked by Storage Health: ' + destination.path +
			' (' + health.status + (health.detail ? ': ' + health.detail : '') + ')');
		if (program) {
			Object.defineProperty(program, '_storageHealthRetryAt', {
				enumerable: false,
				configurable: true,
				writable: true,
				value: now + 5000
			});
		}
	}
	return false;
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
		if (!ensureRecordingDestinationHealthy(program, true)) {
			return false;
		}
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

// 手動予約はskipではなく予約解除として扱う。
// 録画開始後のfinalizeと、ユーザーによるstream取得前の停止で同じ削除処理を使う。
function removeManualReserve(program) {
	if (!program || !program.isManualReserved) {
		return false;
	}

	try {
		return reservationStore.withLock(RESERVES_DATA_FILE, () => {
			const latestReserves = reservationStore.readArray(RESERVES_DATA_FILE);

			for (let i = 0, l = latestReserves.length; i < l; i++) {
				if (latestReserves[i].id !== program.id) {
					continue;
				}

				latestReserves.splice(i, 1);
				reserves = latestReserves;
				reservationStore.writeArrayAtomic(RESERVES_DATA_FILE, reserves);
				operatorLog('WRITE: ' + RESERVES_DATA_FILE);
				return true;
			}

			return false;
		});
	} catch (error) {
		operatorLog('WARNING: manual reserve removal failed: ' + error.message);
		return false;
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


// Mirakurun APIからJSONを1回取得する
function getMirakurunJson(endpoint, timeoutMs) {
	return new Promise((resolve) => {
		timeoutMs = Number(timeoutMs) || 1000;

		let finished = false;
		let req = null;
		let chunks = [];
		const requestPath = mirakurunDropWatch.getApiRequestPath(mirakurun, endpoint);

		function done(err, data) {
			if (finished) {
				return;
			}

			finished = true;
			clearTimeout(timer);

			try {
				if (req) {
					req.destroy();
				}
			} catch (_) {}

			if (err) {
				resolve({
					ok: false,
					error: err.message,
					path: requestPath
				});
				return;
			}

			resolve({
				ok: true,
				data: data,
				path: requestPath
			});
		}

		const timer = setTimeout(() => {
			done(new Error('timeout'));
		}, timeoutMs);

		try {
			if (mirakurunDropWatch.usesUnixSocket(mirakurun)) {
				req = http.request({
					socketPath: mirakurun.socketPath,
					path: requestPath,
					method: 'GET',
					headers: {
						'User-Agent': mirakurun.userAgent || 'Chinachu operator'
					}
				}, handleResponse);
			} else {
				const baseUrl = new URL(mirakurunPath);
				const client = baseUrl.protocol === 'https:' ? https : http;

				baseUrl.pathname = requestPath;
				baseUrl.search = '';

				req = client.request(baseUrl, {
					method: 'GET',
					headers: {
						'User-Agent': mirakurun.userAgent || 'Chinachu operator'
					}
				}, handleResponse);
			}

			req.on('error', err => done(err));
			req.end();
		} catch (e) {
			done(e);
		}

		function handleResponse(res) {
			res.on('data', chunk => chunks.push(chunk));
			res.on('end', () => {
				try {
					if (res.statusCode < 200 || res.statusCode >= 300) {
						done(new Error('HTTP ' + res.statusCode));
						return;
					}

					done(null, JSON.parse(Buffer.concat(chunks).toString('utf8')));
				} catch (e) {
					done(e);
				}
			});
		}
	});
}

function summarizeMirakurunStreamInfo(streamInfo) {
	const summary = {
		packetTotal: 0,
		dropTotal: 0,
		dropPids: {}
	};

	Object.keys(streamInfo || {}).forEach(pid => {
		const info = streamInfo[pid] || {};
		const packet = Number(info.packet || 0);
		const drop = Number(info.drop || 0);

		summary.packetTotal += packet;
		summary.dropTotal += drop;

		if (drop > 0) {
			summary.dropPids[pid] = drop;
		}
	});

	return summary;
}

function buildMirakurunUserMap(tuners) {
	const map = {};

	(tuners || []).forEach(tuner => {
		if (!tuner || !Array.isArray(tuner.users)) {
			return;
		}

		tuner.users.forEach(user => {
			if (!user || !user.url) {
				return;
			}

			map[user.url] = {
				tuner: tuner,
				user: user
			};
		});
	});

	return map;
}

function buildMirakurunDropSnapshot(program, matched) {
	const summary = summarizeMirakurunStreamInfo(matched.user.streamInfo);

	return {
		checkedAt: new Date().toISOString(),
		programId: program.id,
		mirakurunProgramId: program.mirakurunProgramId,
		tunerIndex: matched.tuner.index,
		tunerName: matched.tuner.name,
		userId: matched.user.id,
		agent: matched.user.agent,
		url: matched.user.url,
		packetTotal: summary.packetTotal,
		dropTotal: summary.dropTotal,
		dropPids: summary.dropPids
	};
}

function cleanupMirakurunDropSnapshots() {
	const activeProgramIds = {};

	for (let i = 0, l = recording.length; i < l; i++) {
		if (recording[i] && recording[i].id) {
			activeProgramIds[recording[i].id] = true;
		}
	}

	Object.keys(mirakurunDropSnapshots).forEach(id => {
		if (!activeProgramIds[id]) {
			delete mirakurunDropSnapshots[id];
		}
	});
}

// 録画中のMirakurun drop情報を取得し、program.id別の最新スナップショットとして保持する
async function mirakurunDropChecker() {
	if (mirakurunDropChecking) {
		return;
	}

	if (recording.length === 0) {
		cleanupMirakurunDropSnapshots();
		return;
	}

	mirakurunDropChecking = true;

	try {
		const result = await getMirakurunJson('/tuners', 1000);

		if (!result.ok) {
			operatorLog('DROP WATCH: failed: ' + result.error + ' path=' + result.path);
			return;
		}

		const userMap = buildMirakurunUserMap(result.data);

		for (let i = 0, l = recording.length; i < l; i++) {
			const program = recording[i];

			if (!program || !program.id || !program.mirakurunStreamPath) {
				continue;
			}

			const matched = userMap[program.mirakurunStreamPath];

			if (!matched) {
				if (config.mirakurunDropVerbose === true) {
					operatorLog('DROP WATCH: user not found url=' + program.mirakurunStreamPath + ': ' + printProgram(program));
				}
				continue;
			}

			const prev = mirakurunDropSnapshots[program.id];
			const snapshot = buildMirakurunDropSnapshot(program, matched);

			mirakurunDropSnapshots[program.id] = snapshot;

			if (!prev) {
				operatorLog('DROP WATCH: start tuner=' + snapshot.tunerName + ' packet=' + snapshot.packetTotal + ' drop=' + snapshot.dropTotal + ' url=' + snapshot.url + ': ' + printProgram(program));
			} else if (snapshot.dropTotal !== prev.dropTotal) {
				operatorLog('DROP WATCH: drop changed ' + prev.dropTotal + ' -> ' + snapshot.dropTotal + ' tuner=' + snapshot.tunerName + ' url=' + snapshot.url + ': ' + printProgram(program));
			} else if (config.mirakurunDropVerbose === true) {
				operatorLog('DROP WATCH: update tuner=' + snapshot.tunerName + ' packet=' + snapshot.packetTotal + ' drop=' + snapshot.dropTotal + ' url=' + snapshot.url + ': ' + printProgram(program));
			}
		}

		cleanupMirakurunDropSnapshots();
	} catch (e) {
		operatorLog('DROP WATCH: failed: ' + (e && e.message ? e.message : e));
	} finally {
		mirakurunDropChecking = false;
	}
}

function applyMirakurunDropSnapshot(program) {
	if (!program || !program.id) {
		return;
	}

	const snapshot = mirakurunDropSnapshots[program.id];

	if (!snapshot) {
		if (config.mirakurunDropVerbose === true) {
			operatorLog('DROP WATCH: no snapshot: ' + printProgram(program));
		}
		return;
	}

	program.mirakurunDrop = snapshot;
	operatorLog('DROP WATCH: final tuner=' + snapshot.tunerName + ' packet=' + snapshot.packetTotal + ' drop=' + snapshot.dropTotal + ': ' + printProgram(program));
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

	if (program._operatorNg || program._operatorAbort || clock > program.end) {
		return;
	}
	if (!ensureRecordingDestinationHealthy(program, true)) {
		return;
	}

	const interrupted = getResumableInterruptedRecording(program);
	if (interrupted) {
		inheritInterruptedRecording(program, interrupted);
	}

	const attempt = recordingAttempt.start(program);

	function isCurrentAttempt() {
		return recordingAttempt.isCurrent(program, attempt) &&
			!program._operatorNg &&
			!program._operatorAbort &&
			isRecording(program) &&
			clock <= program.end;
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
			if (!isCurrentAttempt()) {
				operatorLog('DROP STREAM: ' + printProgram(program));
				safeAbortStream(stream, 'drop stream');
				recordingAttempt.clear(program, attempt);
				return;
			}

			recordingAttempt.clear(program, attempt);
			doRecord(program, stream);
		})
		.catch(err => {

			if (!isCurrentAttempt()) {
				operatorLog('DROP STREAM ERROR: ' + printProgram(program));
				recordingAttempt.clear(program, attempt);
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
							if (!recordingAttempt.isCurrent(program, attempt)) {
								return;
							}

							if (program._operatorNg ||
								program._operatorAbort ||
								clock > program.end ||
								isRecording(program) ||
								isRecordedForReserve(program)) {
								recordingAttempt.clear(program, attempt);
								return;
							}

							recordingAttempt.clear(program, attempt);
							prepRecord(program);
						}, 500);
						return;
					}
				} else {
					logHandoffEndLackSkip(handoffInfo, program);
				}
			}

			// リトライ
			setTimeout(() => {
				if (!recordingAttempt.isCurrent(program, attempt)) {
					return;
				}

				if (program._operatorNg || program._operatorAbort) {
					recordingAttempt.clear(program, attempt);
					return;
				}

				if (recordingAttempt.remove(recording, program, attempt)) {
					writeRecordingData();
				}
			}, 5000);
		});

	recording.push(program);
	writeRecordingData();
}

// 録画実行
function doRecord(program, stream) {

	if (shutdownStarted || program._operatorNg || !isRecording(program) || clock > program.end) {
		operatorLog('DROP RECORD: ' + printProgram(program));
		safeAbortStream(stream, 'drop record');
		return;
	}
	if (!ensureRecordingDestinationHealthy(program, false)) {
		operatorLog('DROP RECORD: unsafe recording destination: ' + printProgram(program));
		safeAbortStream(stream, 'unsafe recording destination');
		removeRecording(program.id, 'STORAGE HEALTH BLOCK');
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
	program.mirakurunProgramId = parseInt(program.id, 36);
	program.mirakurunStreamPath = stream.req.path;
	program.command = `mirakurun type=${program.channel.type} url=${stream.req.path} priority=${program.priority}`;// dummy
	program.pid = -1;// dummy

	// 保存先パス。shutdown後の再開時だけ、暫定recordedに保存した同一pathを使う。
	const isResumedRecording = typeof program._operatorResumeRecordedPath === 'string';
	const recPath = isResumedRecording ? program._operatorResumeRecordedPath : getRecordedPath(program);
	if (isResumedRecording && !fs.existsSync(recPath)) {
		operatorLog('WARNING: RESUME RECORDING FILE NOT FOUND, recreate at same path: ' + recPath);
	}
	program.recorded = recPath;
	if (isResumedRecording) {
		program.operatorResumePending = false;
		program.operatorResumedAt = Date.now();
		delete program._operatorResumeRecordedPath;
		operatorLog('RESUME RECORD: ' + printProgram(program));
	}

	// 保存先ディレクトリ
	const recDirPath = path.dirname(recPath);
	if (!fs.existsSync(recDirPath)) {
		operatorLog('MKDIR: ' + recDirPath);
		fs.mkdirSync(recDirPath, { recursive: true });
	}

	// 保存ストリーム
	const recFile = fs.createWriteStream(recPath, { flags: 'a' });
	activeRecordingOutputs.add(recFile);
	operatorLog('STREAM: ' + recPath);

	let finalized = false;
	let inputEnded = false;
	let probeDurationAfterClose = false;

	function finalizeNg(reason, error) {
		if (finalized) {
			return;
		}

		const errorDetail = error && (error.code || error.message);
		markRecordingNg(program, reason + (errorDetail ? ' (' + errorDetail + ')' : ''));
		finalize();
	}

	function onInputEnd() {
		inputEnded = true;
		finalize();
	}

	function onInputAborted() {
		finalizeNg('NG RECORDING: INPUT STREAM ABORTED');
	}

	function onInputError(error) {
		finalizeNg('NG RECORDING: INPUT STREAM ERROR', error);
	}

	function onInputClose() {
		stream.removeListener('error', onInputError);
		if (!inputEnded) {
			finalizeNg('NG RECORDING: INPUT STREAM CLOSED PREMATURELY');
		}
	}

	function onOutputError(error) {
		finalizeNg('NG RECORDING: OUTPUT STREAM ERROR', error);
	}

	// 録画プロセス終了時処理
	stream.once('end', onInputEnd);
	stream.once('aborted', onInputAborted);
	// aborted後にもerrorが続くため、closeまではerror listenerを維持する
	stream.on('error', onInputError);
	stream.once('close', onInputClose);
	recFile.once('error', onOutputError);
	recFile.once('close', () => {
		recFile.removeListener('error', onOutputError);
		activeRecordingOutputs.delete(recFile);
		if (!shutdownStarted) {
			checkStorageAfterRecordingClose(program);
		}
		if (probeDurationAfterClose && !shutdownStarted) {
			probeRecordedDuration(recPath, duration => {
				if (duration !== null) {
					persistRecordedDuration(program.id, recPath, duration);
				}
			});
		}
		completeOperatorShutdown();
	});

	// 内部用
	Object.defineProperty(program, "_stream", {
		enumerable: false,
		configurable: true,
		value: stream
	});
	Object.defineProperty(program, "_operatorFinalize", {
		enumerable: false,
		configurable: true,
		value: finalize
	});

	stream.pipe(recFile);

	// 状態更新
	writeRecordingData();

	// お片付け
	function finalize() {

		if (finalized) {
			return;
		}
		finalized = true;

		stream.removeListener('end', onInputEnd);
		stream.removeListener('aborted', onInputAborted);

		applyMirakurunDropSnapshot(program);

		safeAbortStream(stream, 'recording finalize');

		delete program._stream;
		delete program._operatorFinalize;

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
		const isResumePending = !isNgRecording &&
			program.operatorResumePending === true &&
			!program.isManualReserved &&
			program.operatorAbort !== true &&
			program.operatorEndLack !== true;
		probeDurationAfterClose = !isNgRecording && !isResumePending;

		if (!isNgRecording) {
			for (let i = 0, l = recorded.length; i < l; i++) {
				if (recorded[i].id === program.id) {
					if (recorded[i].recorded === program.recorded) {
						recorded.splice(i, 1);
					} else {
						recorded[i].id = getUniqueRecordedCollisionId(recorded[i], recorded);
					}
					break;
				}
			}
			recorded.push(program);
			fs.writeFileSync(RECORDED_DATA_FILE, JSON.stringify(recorded));
			operatorLog('WRITE: ' + RECORDED_DATA_FILE);
			if (!isResumePending) {
				scheduleMatchLedgerUpdate('recorded finalize');
			}
		} else {
			operatorLog(program._operatorNg + ': ' + printProgram(program));
		}

		const recordingIndex = recording.indexOf(program);
		if (recordingIndex !== -1) {
			recording.splice(recordingIndex, 1);
		}
		writeRecordingData();
		delete mirakurunDropSnapshots[program.id];
		removeManualReserve(program);

		// ポストプロセス
		if (!isNgRecording && !isResumePending && config.recordedCommand) {
			const postProcess = child_process.spawn(config.recordedCommand, [recPath, JSON.stringify(program)]);
			operatorLog('SPAWN: ' + config.recordedCommand + ' (pid=' + postProcess.pid + ')');
		}

		if (isResumePending) {
			operatorLog('FIN INTERRUPTED: resume pending: ' + printProgram(program));
		} else if (program._operatorEndLack) {
			operatorLog('FIN END LACK: ' + printProgram(program));
		} else if (program._operatorAbort) {
			operatorLog('FIN ABORT SHORT: ' + printProgram(program));
		} else {
			operatorLog('FIN: ' + printProgram(program));
		}
	}

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
	if (abortReason === 'ABORT RECORDING') {
		removeManualReserve(program);
	}
}


// 容量不足時の削除対象拡張子か確認する
function isStorageCleanupTargetFile(filePath) {
	const ext = path.extname(filePath).toLowerCase();
	return ext === '.ts' || ext === '.m2ts';
}

// 現在録画中の保存先パス一覧を取得する
function getRecordingPathSet() {
	const paths = new Set();
	const now = Date.now();

	for (let i = 0, l = recording.length; i < l; i++) {
		if (!recording[i] || !recording[i].recorded) {
			continue;
		}

		paths.add(path.resolve(recording[i].recorded));
	}

	// 番組終了前のshutdown中断ファイルは、再開待ちの間も自動削除から保護する。
	for (let i = 0, l = recorded.length; i < l; i++) {
		if (!recorded[i] ||
			recorded[i].operatorResumePending !== true ||
			now > recorded[i].end ||
			typeof recorded[i].recorded !== 'string' ||
			recorded[i].recorded.trim() === '') {
			continue;
		}

		paths.add(path.resolve(recorded[i].recorded));
	}

	return paths;
}

// config.recordedDir 直下の古い録画ファイルを探す。
// サブディレクトリ、シンボリックリンク、リンク先、別マウント配下は追わない。
function findRecordedCleanupCandidates(limit) {
	const baseDir = config.recordedDir;
	let entries;
	const candidates = [];
	const recordingPaths = getRecordingPathSet();

	try {
		entries = fs.readdirSync(baseDir);
	} catch (e) {
		operatorLog('WARNING: Storage cleanup scan failed: ' + e.message);
		return [];
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

		candidates.push({
			path: filePath,
			name: path.basename(filePath),
			mtimeMs: stats.mtimeMs,
			size: stats.size
		});
	}

	candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
	return candidates.slice(0, typeof limit === 'number' && limit > 0 ? limit : candidates.length);
}

function findOldestRecordedFileInRecordedDir() {
	return findRecordedCleanupCandidates(1)[0] || null;
}

// 実ファイル削除後、recorded.json 側に同一パスの記録が残っていれば整合更新する
// 削除対象の選定には recorded 台帳を使わない
function markMatchRecordingDeleted(recordedEntries, filePath, deletedAt) {
	let items;

	try {
		items = JSON.parse(fs.readFileSync(MATCH_DATA_FILE, { encoding: 'utf8' }));
		if (!Array.isArray(items)) {
			throw new Error('match data is not an array');
		}

		if (!storageLow.markMatchRecordingDeleted(items, recordedEntries, filePath, deletedAt, 'storage-low')) {
			return false;
		}

		fs.writeFileSync(MATCH_DATA_FILE, JSON.stringify(items));
		operatorLog('WRITE: ' + MATCH_DATA_FILE);
		return true;
	} catch (error) {
		operatorLog('WARNING: Storage cleanup match history update failed: ' + filePath + ' (' + error.message + ')');
		return false;
	}
}

function removeRecordedLedgerEntriesByPath(filePath, deletedAt) {
	const resolvedFilePath = path.resolve(filePath);
	const removed = [];
	let changed = false;

	for (let i = recorded.length - 1; i >= 0; i--) {
		if (!recorded[i] || !recorded[i].recorded) {
			continue;
		}

		if (path.resolve(recorded[i].recorded) !== resolvedFilePath) {
			continue;
		}

		removed.push(recorded[i]);
		recorded.splice(i, 1);
		changed = true;
	}

	if (changed) {
		fs.writeFileSync(RECORDED_DATA_FILE, JSON.stringify(recorded));
		operatorLog('WRITE: ' + RECORDED_DATA_FILE);
		markMatchRecordingDeleted(removed, filePath, deletedAt);
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
		removeRecordedLedgerEntriesByPath(target.path, Date.now());
		return true;
	} catch (e) {
		operatorLog('WARNING: Storage cleanup remove failed: ' + target.path + ' (' + e.message + ')');
		return false;
	}
}

function getProgramStorageFilesystemId(program) {
	return program && program._storageFilesystemKey || null;
}

function stopRecordingsOnFilesystem(filesystemKey) {
	storageLow.stopCurrentRecordings(
		recording,
		stopRecording,
		program => {
			const programFilesystemKey = getProgramStorageFilesystemId(program);
			if (!programFilesystemKey) {
				return null;
			}
			return programFilesystemKey === filesystemKey;
		},
		program => operatorLog('WARNING: Low Storage stop skipped because recording destination is unknown: ' + printProgram(program))
	);
}

const storageNotificationPending = {};

function isDefaultStorageGroup(group) {
	return group && group.destinations.some(destination => path.resolve(destination) === path.resolve(config.recordedDir));
}

function getStorageSnapshotCompatibility() {
	return {
		action: storageLowSpaceAction,
		warningEnabled: storageLowSpaceWarningEnabled,
		warningMB: storageLowSpaceWarningThresholdMB,
		cleanupMB: storageLowSpaceThresholdMB
	};
}

function createUnobservedStorageState(destination) {
	return {
		id: destination.id || null,
		name: destination.name,
		path: destination.path,
		configuredPath: destination.configuredPath,
		expectedMount: destination.expectedMount,
		status: 'unobserved',
		detail: 'Capacity has not been checked by an Operator storage event.',
		filesystemKey: null,
		capacityReliable: false,
		capacityCheckedAt: null,
		total: null,
		used: null,
		available: null,
		lowSpacePhase: null,
		stopNewRecordings: false
	};
}

function loadStorageDisplaySnapshots() {
	const configured = storageHealth.getDestinations(config);
	const state = storageRuntimeState.readCompatibleSnapshot(
		fs,
		STORAGE_STATE_FILE,
		getStorageSnapshotCompatibility()
	);
	const snapshots = new Map();
	if (!state) return snapshots;
	configured.forEach(destination => {
		const saved = state.storages.find(storage => storageRuntimeState.matchesDestination(storage, destination));
		if (saved) snapshots.set(storageRuntimeState.destinationToken(destination), Object.assign({}, saved));
	});
	return snapshots;
}

function chooseStorageDisplayState(destination, observed) {
	const token = storageRuntimeState.destinationToken(destination);
	const cached = storageDisplaySnapshots.get(token);
	if (!observed) return cached || createUnobservedStorageState(destination);
	if (!cached || !storageRuntimeState.matchesDestination(cached, destination)) return observed;
	if (Number(cached.capacityCheckedAt) > Number(observed.capacityCheckedAt)) return cached;
	if (!observed.filesystemKey || !cached.filesystemKey ||
		observed.filesystemKey !== cached.filesystemKey ||
		observed.mountFingerprint !== cached.mountFingerprint) return observed;
	return observed;
}

function persistStorageRuntimeState(force) {
	const revision = storageMonitor.getRevision();
	if (force !== true && revision === storageLastPersistedRevision) return;
	const configured = storageHealth.getDestinations(config);
	const observed = storageMonitor.getDestinationStates();
	const observedByToken = new Map();
	observed.forEach(storage => {
		observedByToken.set(storage.id ? 'id:' + storage.id : 'path:' + path.resolve(storage.path), storage);
	});
	const storages = configured.map(destination => {
		const token = destination.id ? 'id:' + destination.id : 'path:' + path.resolve(destination.path);
		const selected = chooseStorageDisplayState(destination, observedByToken.get(token));
		const result = Object.assign({}, selected, {
			id: destination.id || null,
			name: destination.name,
			path: destination.path,
			configuredPath: destination.configuredPath,
			expectedMount: destination.expectedMount
		});
		storageDisplaySnapshots.set(storageRuntimeState.destinationToken(destination), result);
		return result;
	});
	const state = {
		schemaVersion: 3,
		updatedAt: Date.now(),
		action: storageLowSpaceAction,
		thresholds: {
			warningEnabled: storageLowSpaceWarningEnabled,
			warningMB: storageLowSpaceWarningThresholdMB,
			cleanupMB: storageLowSpaceThresholdMB
		},
		filesystems: storageMonitor.toJSON(),
		storages: storages
	};
	Object.keys(storageCleanupState).forEach(filesystemKey => {
		const cleanup = storageCleanupState[filesystemKey];
		const group = state.filesystems.find(item => item.filesystemKey === filesystemKey);
		if (group && cleanup && cleanup.mountFingerprint === group.mountFingerprint) Object.assign(group, cleanup);
		state.storages.forEach(storage => {
			if (storage.filesystemKey === filesystemKey && cleanup && cleanup.mountFingerprint === storage.mountFingerprint) Object.assign(storage, cleanup);
		});
	});

	try {
		storageRuntimeState.atomicWriteJson(fs, STORAGE_STATE_FILE, state);
		storageLastPersistedRevision = revision;
	} catch (error) {
		operatorLog('WARNING: Storage runtime state write failed: ' + error.message);
	}
}

function notifyStorageGroup(group) {
	if (!group || !group.phase || !notificationSettings.command || storageNotificationPending[group.filesystemKey]) return;
	const phase = group.phase;
	const intervalTime = phase === 'cleanup' ? storageLowSpaceCriticalNotifyIntervalTime : storageLowSpaceWarningIntervalTime;
	const notified = {
		warning: group.warningNotifiedAt || 0,
		cleanup: group.cleanupNotifiedAt || 0
	};
	if (!notification.shouldSendStorageLowPhaseNotification(notificationSettings.source, phase, clock, notified, intervalTime)) return;

	const thresholdMB = phase === 'cleanup' ? storageLowSpaceThresholdMB : storageLowSpaceWarningThresholdMB;
	const payload = notification.createStorageLowNotification({
		availableBytes: group.availableBytes,
		availableMB: group.availableBytes / 1024 / 1024,
		thresholdMB: thresholdMB,
		recordedDir: group.destinations[0] || config.recordedDir,
		action: storageLowSpaceAction,
		severity: phase === 'cleanup' ? 'critical' : 'warning',
		phase: phase,
		filesystemKey: group.filesystemKey,
		recordedDirIds: group.recordedDirIds,
		destinations: group.destinations
	});
	storageNotificationPending[group.filesystemKey] = true;
	sendNotification(payload).then(result => {
		if (result && result.ok === true) {
			storageMonitor.setNotificationTime(group.filesystemKey, phase, Date.now());
			persistStorageRuntimeState(true);
		}
	}).finally(() => {
		delete storageNotificationPending[group.filesystemKey];
	});
}

function handleStorageGroup(group) {
	if (!group || !group.filesystemKey) return;
	if (group._handledCapacityCheckedAt === group.capacityCheckedAt) {
		persistStorageRuntimeState();
		return;
	}
	Object.defineProperty(group, '_handledCapacityCheckedAt', {
		enumerable: false,
		configurable: true,
		writable: true,
		value: group.capacityCheckedAt
	});
	const freeMB = group.availableBytes / 1024 / 1024;
	if (group.phase === 'cleanup') {
		operatorLog(`ALERT: Storage Low Space! (${freeMB} MB < ${storageLowSpaceThresholdMB} MB) filesystem=${group.filesystemKey}`);
	} else if (group.phase === 'warning') {
		operatorLog(`WARNING: Storage Low Space! (${freeMB} MB < ${storageLowSpaceWarningThresholdMB} MB) filesystem=${group.filesystemKey}`);
	}
	notifyStorageGroup(group);
	if (group.phase !== 'cleanup') {
		persistStorageRuntimeState();
		return;
	}

	let shouldStopRecordings = storageLowSpaceAction === 'stop';
	if (storageLowSpaceAction === 'remove' && isDefaultStorageGroup(group)) {
		const previous = storageCleanupState[group.filesystemKey];
		if (!previous || previous.handledCapacityCheckedAt !== group.capacityCheckedAt) {
			const candidates = findRecordedCleanupCandidates(5);
			storageCleanupState[group.filesystemKey] = {
				mountFingerprint: group.mountFingerprint,
				cleanupCandidateSource: true,
				cleanupCandidates: candidates.map(candidate => ({ name: candidate.name, size: candidate.size, mtimeMs: candidate.mtimeMs })),
				cleanupCandidatesCheckedAt: Date.now(),
				handledCapacityCheckedAt: group.capacityCheckedAt
			};
			if (candidates.length > 0 && removeOldestRecordedFileInRecordedDir()) {
				storageCleanupState[group.filesystemKey].cleanupCandidates = findRecordedCleanupCandidates(5).map(candidate => ({
					name: candidate.name, size: candidate.size, mtimeMs: candidate.mtimeMs
				}));
			} else {
				operatorLog('WARNING: Storage cleanup cannot safely free space; stopping recordings on the low filesystem.');
				shouldStopRecordings = true;
			}
		}
	} else if (storageLowSpaceAction === 'remove') {
		operatorLog('WARNING: Storage cleanup is limited to the default filesystem; stopping recordings on the low filesystem.');
		shouldStopRecordings = true;
	}

	group.stopNewRecordings = true;
	if (shouldStopRecordings) stopRecordingsOnFilesystem(group.filesystemKey);
	persistStorageRuntimeState();
}

function checkActiveRecordingStorage() {
	const checked = new Set();
	recording.slice().forEach(program => {
		const filesystemKey = getProgramStorageFilesystemId(program);
		if (!filesystemKey || checked.has(filesystemKey)) return;
		checked.add(filesystemKey);
		const destination = storageHealth.findDestination(config, program);
		if (!destination) return;
		const group = storageMonitor.check(destination, { now: Date.now() });
		if (group && group.capacityCheckedAt) handleStorageGroup(group, destination);
		else persistStorageRuntimeState();
	});
}

function checkStorageAfterRecordingClose(program) {
	if (!program || !program._storageFilesystemKey) return;
	const destination = storageHealth.findDestination(config, program);
	if (!destination) return;
	const group = storageMonitor.check(destination, { now: Date.now(), refreshAfterMs: 1000 });
	if (group && group.capacityCheckedAt) handleStorageGroup(group, destination);
	else persistStorageRuntimeState();
}

function storageStateFromGroup(group, destination) {
	return Object.assign({}, group, {
		id: destination.id || null,
		name: destination.name,
		path: destination.path,
		configuredPath: destination.configuredPath || destination.path,
		expectedMount: destination.expectedMount || null,
		capacityReliable: Number(group.capacityCheckedAt) > 0,
		total: typeof group.totalBytes === 'number' ? group.totalBytes : group.total,
		used: typeof group.usedBytes === 'number' ? group.usedBytes : group.used,
		available: typeof group.availableBytes === 'number' ? group.availableBytes : group.available,
		lowSpacePhase: group.phase || null,
		// Manual observations are display-only. Never persist an operational stop decision from them.
		stopNewRecordings: false
	});
}

function sharesKnownFilesystem(destination, source) {
	function sameKnownIdentity(candidate) {
		if (!candidate || candidate.filesystemKey !== source.filesystemKey) return false;
		const sourceFingerprints = source.mountFingerprints || (source.mountFingerprint ? [ source.mountFingerprint ] : []);
		const candidateFingerprints = candidate.mountFingerprints || (candidate.mountFingerprint ? [ candidate.mountFingerprint ] : []);
		return sourceFingerprints.length > 0 && sourceFingerprints.some(value => candidateFingerprints.includes(value));
	}
	const operational = storageMonitor.getByDestination(destination);
	if (sameKnownIdentity(operational)) return true;
	const cached = storageDisplaySnapshots.get(storageRuntimeState.destinationToken(destination));
	return sameKnownIdentity(cached);
}

function applyManualStorageSnapshots(states, selected, allRequested) {
	const configured = storageHealth.getDestinations(config);
	const selectedTokens = new Set(selected.map(storageRuntimeState.destinationToken));
	states.forEach(state => {
		storageDisplaySnapshots.set(storageRuntimeState.destinationToken(state), Object.assign({}, state));
	});
	if (allRequested || states.length !== 1) return;
	const source = states[0];
	configured.forEach(destination => {
		const token = storageRuntimeState.destinationToken(destination);
		if (selectedTokens.has(token) || !sharesKnownFilesystem(destination, source)) return;
		storageDisplaySnapshots.set(token, storageStateFromGroup(source, destination));
	});
}

function manualStorageRefreshError(code, statusCode, publicMessage) {
	const error = new Error(publicMessage);
	error.code = code;
	error.statusCode = statusCode;
	error.publicMessage = publicMessage;
	return error;
}

async function handleManualStorageRefresh(request) {
	if (!request || (request.all !== true && !Object.prototype.hasOwnProperty.call(request, 'storageId'))) {
		throw manualStorageRefreshError('invalid_request', 400, '更新対象が不正です。');
	}
	const configured = storageHealth.getDestinations(config);
	let selected;
	if (request.all === true) {
		selected = configured.slice();
	} else {
		const requestedId = request.storageId === null ? null : String(request.storageId);
		selected = configured.filter(destination => (destination.id || null) === requestedId);
		if (selected.length !== 1) {
			throw manualStorageRefreshError('storage_not_found', 404, '指定された録画先は設定されていません。');
		}
	}
	if (selected.length === 0) {
		throw manualStorageRefreshError('storage_not_found', 404, '更新対象の録画先がありません。');
	}

	const refresh = storageManualRefresh.collect(selected, {
		inspect: storageHealth.inspectDestination,
		checkIntervalMs: 20000,
		inspectOptions: {
			warningEnabled: storageLowSpaceWarningEnabled,
			warningThresholdMB: storageLowSpaceWarningThresholdMB,
			cleanupThresholdMB: storageLowSpaceThresholdMB
		},
		now: Date.now
	});
	const failures = refresh.failures;
	const successfulStates = refresh.states;
	applyManualStorageSnapshots(successfulStates, selected, request.all === true);
	if (successfulStates.length > 0) persistStorageRuntimeState(true);

	return {
		total: selected.length,
		updated: selected.length - failures.length,
		failed: failures.length,
		failures: failures
	};
}

function startStorageRefreshServer() {
	storageRefreshServer = storageRefreshIpc.createServer({
		socketPath: STORAGE_REFRESH_SOCKET,
		handler: runManualStorageRefresh,
		log: operatorLog
	});
	storageRefreshServer.listen().then(() => {
		operatorLog('Storage refresh IPC listening.');
	}).catch(error => {
		operatorLog('WARNING: Storage refresh IPC startup failed: ' + error.message);
		storageRefreshServer = null;
	});
}

startStorageRefreshServer();

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
