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
const BITRATE_STATS_FILE = __dirname + '/data/bitrate-stats.json';
const STORAGE_STATE_FILE  = __dirname + '/data/storage-state.json';
const RECORDED_THUMBNAIL_DIR = __dirname + '/data/thumbnails';
const SCHEDULER_STATE_FILE = __dirname + '/data/scheduler-state.json';
const LEGACY_SCHEDULER_STATE_FILE = __dirname + '/data/epg-scheduler-state.json';
const BROADCAST_CLOCK_STATE_FILE = __dirname + '/data/broadcast-clock-state.json';
const BROADCAST_CLOCK_TOOL = __dirname + '/tools/mirakurun-broadcast-clock.js';

// 標準モジュールのロード
const path = require('path');
const fs = require('fs');
const util = require('util');
const http = require('http');
const https = require('https');
const os = require('os');

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
if (!fs.existsSync('./data/') || !fs.existsSync('./log/')) {
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
const recordedThumbnail = require('./lib/recorded-thumbnail');
const recordedMaintenanceModule = require('./lib/recorded-maintenance');
const recordedAutoAnalysis = require('./lib/recorded-auto-analysis');
const matchOutput = require('./lib/match-output');
const runtimePrivileges = require('./lib/runtime-privileges');
const runtimePathsModule = require('./lib/runtime-paths');
const mirakurunConnection = require('./lib/mirakurun-connection');
const mirakurunDropWatch = require('./lib/mirakurun-drop-watch');
const mirakurunEpgJobWatch = require('./lib/mirakurun-epg-job-watch');
const mirakurunEpgReconcile = require('./lib/mirakurun-epg-reconcile');
const operatorSchedulerRequest = require('./lib/operator-scheduler-request');
const operatorSchedulerPreflight = require('./lib/operator-scheduler-preflight');
const schedulerState = require('./lib/scheduler-state');
const reservationStore = require('./lib/reservation-store');
const matchV2 = require('./lib/match-v2');
const bitrateStats = require('./lib/bitrate-stats');
const { TsDropAnalyzer } = require('./lib/ts-drop-analyzer');
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
const dropDetectionMode = getDropDetectionMode();// 未指定時は既存Mirakurun方式
const mirakurunDropDetectionEnabled = ['mirakurun', 'both', 'mirakurun-file'].includes(dropDetectionMode);
const tsDropDetectionEnabled = dropDetectionMode === 'ts' || dropDetectionMode === 'both';
const autoTsAnalysisEnabled = dropDetectionMode === 'file' || dropDetectionMode === 'mirakurun-file';
const autoTsMaxRecordings = Number.isInteger(config.autoTsMaxRecordings) && config.autoTsMaxRecordings >= 0
	? config.autoTsMaxRecordings : 0;
const mirakurunDropCheckIntervalTime = getMirakurunDropCheckIntervalTime();// 録画中drop監視間隔。0以下で無効
const reserveCheckIntervalTime = getReserveCheckIntervalTime();// 通常時の予約チェック間隔
const prepReserveCheckIntervalTime = getPrepReserveCheckIntervalTime();// 準備期間内の予約チェック間隔。通常間隔以上なら高速化なし
const recordedDurationProbeTimeoutMs = getRecordedDurationProbeTimeoutMs();// 録画済みTSのffprobe timeout
const TS_DROP_LOG_INTERVAL_MS = 30 * 1000;
const TS_DROP_OVERLOAD_RATIO = 0.25;
const BROADCAST_CLOCK_RESERVE_GUARD_MS = 10 * 60 * 1000;
const BROADCAST_CLOCK_TIMEOUT_MS = 60 * 1000;
const BROADCAST_CLOCK_WARNING_MS = 3000;
const BROADCAST_CLOCK_SAMPLES = 5;
const BROADCAST_CLOCK_PRIORITY = 0;
const BROADCAST_CLOCK_JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const BROADCAST_CLOCK_ENABLED = config.broadcastClockEnabled === true;
const BROADCAST_CLOCK_INTERVAL_HOURS = [ 3, 6, 12, 24 ].includes(Number(config.broadcastClockIntervalHours))
	? Number(config.broadcastClockIntervalHours)
	: 3;
const BROADCAST_CLOCK_GR_CHANNEL = typeof config.broadcastClockGrChannel === 'string' && config.broadcastClockGrChannel.trim() !== ''
	? config.broadcastClockGrChannel.trim()
	: null;
const BROADCAST_CLOCK_SLOT_HOURS = (() => {
	const hours = [];
	for (let hour = 2; hour < 24; hour += BROADCAST_CLOCK_INTERVAL_HOURS) hours.push(hour);
	return hours;
})();
const BROADCAST_CLOCK_SLOT_MINUTES = [ 40, 42, 44, 46, 48 ];


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

function getDropDetectionMode() {
	if (config.dropDetectionMode === null || typeof config.dropDetectionMode === 'undefined') {
		return 'mirakurun';
	}

	const mode = typeof config.dropDetectionMode === 'string' ? config.dropDetectionMode.trim().toLowerCase() : '';
	if (['mirakurun', 'ts', 'both', 'off', 'file', 'mirakurun-file'].includes(mode)) return mode;

	operatorLog('WARNING: invalid dropDetectionMode=' + JSON.stringify(config.dropDetectionMode) +
		'; fallback to mirakurun');
	return 'mirakurun';
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

let runtimePaths;
try {
	runtimePaths = runtimePathsModule.resolveRuntimePaths(__dirname);
} catch (error) {
	console.error('[fatal] failed to prepare runtime directory: ' + error.message);
	process.exit(1);
}
const STORAGE_REFRESH_SOCKET = runtimePaths.storageRefreshSocket;
const RECORDED_THUMBNAIL_SOCKET = runtimePaths.recordedThumbnailSocket;

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
} else if (!['stop-new', 'stop', 'remove'].includes(storageLowSpaceConfiguredAction)) {
	operatorLog('WARNING: Unknown storageLowSpaceAction `' + storageLowSpaceConfiguredAction + '`; using stop.');
}

// 初回起動や clean 環境向けに、不足している台帳JSONだけを作成する
reservationStore.ensureArrayFile(RESERVES_DATA_FILE);
ensureJsonArrayFile(RESERVES2_DATA_FILE);
ensureJsonArrayFile(RECORDING_DATA_FILE);
ensureJsonArrayFile(RECORDED_DATA_FILE);
ensureJsonArrayFile(MATCH_DATA_FILE);

try {
	const matchV2Startup = matchV2.runV2Fix({
		matchFile: MATCH_DATA_FILE,
		backupFile: MATCH_DATA_FILE + '.v1-backup',
		reservationStore,
		legacyOnly: true,
		reuseMatchingBackup: true
	});
	operatorLog('MATCH V2FIX: ' + (matchV2Startup.changed ?
		'converted=' + matchV2Startup.converted + ' total=' + matchV2Startup.total + ' backup=' + matchV2Startup.backupFile :
		'skipped; all entries are already v2'));
} catch (error) {
	console.error('[fatal] match v2 startup conversion failed: ' + error.message);
	process.exit(1);
}

// Keep started recordings until their history transaction has committed. A
// previous process may have exited while waiting for the recorded ledger lock.
try {
	recording = reservationStore.readArray(RECORDING_DATA_FILE);
} catch (error) {
	console.error('[fatal] recording recovery data cannot be read: ' + error.message);
	process.exit(1);
}

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
let recordedThumbnailServer = null;
let recordingChecked = 0;
const handoffEndLackUsed = new Set();
let recordedStorageWakeupHistory = {};
let mirakurunDropChecked = 0;
let mirakurunDropChecking = false;
let mirakurunDropSnapshots = {};
let reserveCheckTimer = null;
let operatorInterval = null;
let periodicPreflightPending = false;
let shutdownStarted = false;
let broadcastClockTimer = null;
let broadcastClockProcess = null;
let broadcastClockChecking = false;
let broadcastClockState = null;
let broadcastClockStateWritable = true;
const activeRecordingOutputs = new Set();
const activeDurationProbes = new Set();
const activeDurationProbeJobs = new Map();
const durationProbeQueue = [];
let recordedLedgerWrites = Promise.resolve();
let pendingRecordedLedgerWrites = 0;
const failedRecordingSaves = new Set();
let lastRecordingTransitionAt = 0;
let recordedMaintenance = null;
let autoTsReviewTimer = null;
// Dashboard-only, bounded in-memory history; never writes to recording ledgers.
const recentPostProcessing = [];
const thumbnailProcessingStarts = new Map();
function rememberPostProcessing(type, title, status, startedAt, id = null, detail = '') {
	const finishedAt = Date.now();
	recentPostProcessing.unshift({ type, title: String(title || ''), status,
		startedAt: Number(startedAt) || finishedAt, finishedAt,
		durationMs: Math.max(0, finishedAt - (Number(startedAt) || finishedAt)),
		id: id === null ? null : String(id), detail: String(detail || '') });
	recentPostProcessing.length = Math.min(recentPostProcessing.length, 20);
}
function recordedTitleForId(id) {
	const row = recorded.find(item => item && String(item.id) === String(id));
	return row && (row.title || row.fullTitle) || String(id);
}
function recordedForPath(filePath) {
	return recorded.find(item => item && item.recorded === filePath) || null;
}
const recordedThumbnailGenerator = recordedThumbnail.createGenerator({
	outputDir: RECORDED_THUMBNAIL_DIR,
	log: operatorLog,
	timeoutMs: 30000,
	maxPending: 64,
	maxQueueAgeMs: 10 * 60 * 1000,
	getRunDelay: job => {
		if (recordedMaintenance && recordedMaintenance.isBusy() && !recordedMaintenance.currentThumbnail(job)) return Infinity;
		if (shutdownStarted || matchLedgerProcess || activeDurationProbes.size !== 0 ||
			pendingRecordedLedgerWrites !== 0) return Infinity;
		if (recordedMaintenance && recordedMaintenance.currentThumbnail(job)) return postProcessingDelay();
		const nextProbeAt = durationProbeQueue.length ? durationProbeQueue[0].queuedAt : Infinity;
		const nextMatchAt = matchLedgerUpdateReason && scheduler === null ? matchLedgerPendingAt : Infinity;
		if (job.requestedAt >= Math.min(nextProbeAt, nextMatchAt)) return Infinity;
		return postProcessingDelay();
	},
	onIdle: () => wakePostProcessing(),
	onStatus: (id, state) => {
		if (recordedMaintenance) recordedMaintenance.thumbnailStatus(id, state);
		const key = String(id);
		if (state.status === 'processing') thumbnailProcessingStarts.set(key, Date.now());
		else if (thumbnailProcessingStarts.has(key) && ['complete', 'failed'].includes(state.status)) {
			rememberPostProcessing('thumbnail', recordedTitleForId(id), state.status === 'complete' ? 'complete' : 'failed',
				thumbnailProcessingStarts.get(key), key, state.reason || '');
			thumbnailProcessingStarts.delete(key);
		} else if (state.status === 'source-missing') thumbnailProcessingStarts.delete(key);
	}
});
recordedMaintenance = recordedMaintenanceModule.createMaintenance({
	root: __dirname, config, thumbnail: recordedThumbnailGenerator,
	autoEnabled: autoTsAnalysisEnabled,
	getAutoSummary: () => recordedAutoAnalysis.summarize(recorded),
	autoAllowed: () => autoTsAnalysisEnabled && postProcessingDelay() === 0 &&
		Math.max(activeRecordingOutputs.size,
			recordedAutoAnalysis.peakRecordings(recording, reserves, isRecordedForReserve)) <= autoTsMaxRecordings,
	autoWaitReason: () => {
		if (postProcessingDelay() > 0) return 'recording-transition';
		if (recordedAutoAnalysis.peakRecordings(recording, reserves, isRecordedForReserve) > autoTsMaxRecordings) return 'recording-limit';
		return recordedAutoAnalysis.summarize(recorded).counts.remaining > 0 ? 'idle' : 'complete';
	},
	log: operatorLog,
	onCompleted: event => rememberPostProcessing('ts', event.title || recordedTitleForId(event.id),
		event.status, event.startedAt, event.id, event.mode === 'manual' ? '手動解析' : '自動解析'),
	canStart: () => !shutdownStarted && !matchLedgerProcess && activeDurationProbes.size === 0 &&
		pendingRecordedLedgerWrites === 0 && !recordedThumbnailGenerator.getState().active,
	wake: () => { wakePostProcessing(); completeOperatorShutdown(); },
	delay: ts => {
		if (shutdownStarted) return Infinity;
		return ts ? 0 : postProcessingDelay();
	},
	waitReason(ts) {
		if (shutdownStarted) return null;
		if (this.delay(ts) > 0) return 'recording-transition';
		if (recordedMaintenance.isBusy() || matchLedgerProcess || activeDurationProbes.size ||
			pendingRecordedLedgerWrites || recordedThumbnailGenerator.getState().active) return 'post-processing';
		return null;
	},
	probe: filePath => new Promise(resolve => startDurationProbe({ filePath, queuedAt: Date.now(), maintenance: true,
		callback: duration => resolve(duration) })),
	onChanged: () => { if (pendingRecordedLedgerWrites !== 0) return; try {
		recorded = reservationStore.readArray(RECORDED_DATA_FILE);
	} catch (error) {
		operatorLog('WARNING: maintenance ledger reload failed: ' + error.message);
	} }
});

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
	worker: true,
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
	abortBroadcastClockObservationIfNeeded();

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

// Start checking reservations after recovering the previous recording state.

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
	stopAutoIfRecordingLimitExceeded();

	if (clock - recordingChecked > 1000 * 30) {
		recordingStaleChecker();
		recordingChecked = clock;
	}

	if (mirakurunDropDetectionEnabled && mirakurunDropCheckIntervalTime > 0 &&
		clock - mirakurunDropChecked > mirakurunDropCheckIntervalTime) {
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

// graceful shutdown で中断し、有効な予約が残る録画開始済み番組を再開対象にする。
// isRecorded() の通常の終端判定は変更せず、その前段で限定的に使用する。
function getResumableInterruptedRecording(program) {
	if (!program || clock > program.end) {
		return null;
	}

	for (let i = 0, l = recorded.length; i < l; i++) {
		const interrupted = recorded[i];

		if (!interrupted ||
			interrupted.id !== program.id ||
			(interrupted.isManualReserved === true) !== (program.isManualReserved === true) ||
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
	if (interrupted._operatorFilenamePrefixApplied === true) {
		program._operatorFilenamePrefixApplied = true;
	}

	Object.defineProperty(program, '_operatorResumeRecordedPath', {
		enumerable: false,
		configurable: true,
		value: interrupted.recorded
	});
}

function markRecordingInterruptedForResume(program) {
	const interruptedAt = Date.now();

	if (!program ||
		program._operatorNg ||
		program._operatorAbort ||
		program._operatorEndLack ||
		program.operatorAbort === true ||
		program.operatorEndLack === true ||
		interruptedAt >= program.end ||
		(program.isManualReserved === true && !reserves.some(reserve =>
			reserve && reserve.id === program.id && reserve.isManualReserved === true && interruptedAt < reserve.end))) {
		return false;
	}

	program.operatorResumePending = true;
	program.operatorInterruptedAt = interruptedAt;
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
		'recordingBoundaryPolicy',
		'priority'
	];

	for (let i = 0, l = recording.length; i < l; i++) {
		if (recording[i].id === program.id) {
			if (recording[i]._operatorHistoryPending || recording[i]._operatorManualRemovalPending) return;
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

	let finalized = false;
	const overlappedMatch = matchLedgerProcess !== null;

	try {
		scheduler = child_process.spawn('./chinachu', [ 'update' ], {
			detached: process.platform !== 'win32'
		});
	} catch (error) {
		operatorLog('ERROR: Scheduler start failed: ' + error.message);
		return false;
	}
	schedulerStartedAt = Date.now();
	const startedScheduler = scheduler;

	const finalize = function (code, signal) {
		if (finalized) return;
		finalized = true;

		operatorLog('EXIT: node app-scheduler.js (pid=' + startedScheduler.pid + ')');

		scheduler = null;
		schedulerStartedAt = 0;
		// Its synchronous match worker may have timed out on our match lock,
		// while our earlier snapshot missed the Scheduler's new reservations.
		if (overlappedMatch) scheduleMatchLedgerUpdate('scheduler overlap');
		wakePostProcessing();
		schedulerRequest.onSchedulerExit({
			successful: code === 0 && signal === null,
			finishedAt: Date.now()
		});
		completeOperatorShutdown();
	};

	startedScheduler.on('error', error => {
		operatorLog('ERROR: Scheduler process failed: ' + error.message);
		// A failed spawn has no PID and may emit close without exit. Errors
		// from signalling a running child must not release its execution slot.
		if (!startedScheduler.pid) finalize(null, null);
	});
	startedScheduler.once('exit', finalize);
	startedScheduler.once('close', finalize);
	operatorLog('SPAWN: ./chinachu update (pid=' + startedScheduler.pid + ')');

	// ./chinachu update 側の tee が scheduler log を保存する。
	// 転送された stdout は再追記せず、pipe が詰まらないよう明示的に drain する。
	if (startedScheduler.stdout) startedScheduler.stdout.resume();
	return true;

}

function completeOperatorShutdown() {
	if (!shutdownStarted || scheduler !== null || activeRecordingOutputs.size !== 0 ||
		matchLedgerProcess !== null || activeDurationProbes.size !== 0 || pendingRecordedLedgerWrites !== 0 || recordedMaintenance.isBusy()) {
		return;
	}

	operatorLog('SHUTDOWN: ' + (failedRecordingSaves.size ? 'incomplete; recovery data retained in recording.json' : 'complete'));
	process.exit(failedRecordingSaves.size ? 1 : 0);
}

function shutdownOperator(signal) {
	if (shutdownStarted) {
		return;
	}
	shutdownStarted = true;
	operatorLog('SHUTDOWN: ' + signal);
	if (matchLedgerUpdateTimer !== null) {
		clearTimeout(matchLedgerUpdateTimer);
		matchLedgerUpdateTimer = null;
	}
	matchLedgerUpdateReason = '';
	if (matchLedgerProcess) {
		try { matchLedgerProcess.kill('SIGTERM'); } catch (error) {
			operatorLog('WARNING: match stop failed: ' + error.message);
		}
	}

	if (reserveCheckTimer !== null) {
		clearTimeout(reserveCheckTimer);
		reserveCheckTimer = null;
	}
	if (operatorInterval !== null) {
		clearInterval(operatorInterval);
		operatorInterval = null;
	}
	if (autoTsReviewTimer !== null) {
		clearTimeout(autoTsReviewTimer);
		autoTsReviewTimer = null;
	}
	stopBroadcastClockMonitor();
	if (storageRefreshServer) {
		storageRefreshServer.close();
		storageRefreshServer = null;
	}
	if (recordedThumbnailServer) {
		recordedThumbnailServer.close();
		recordedThumbnailServer = null;
	}

	epgJobReconciler.stop();
	epgJobWatcher.stop();
	shadowPeriodicScheduler.stop();
	schedulerPreflight.stop();
	stopScheduler();
	recordedMaintenance.stop();
	recordedThumbnailGenerator.stop();
	stopActiveDurationProbes();
	recording.slice().forEach(program => {
		if (typeof program._operatorFinalize === 'function') {
			markRecordingInterruptedForResume(program);
			program._operatorFinalize();
		}
	});

	setTimeout(() => {
		operatorLog('FATAL: graceful shutdown timed out.');
		if (matchLedgerProcess) {
			try { matchLedgerProcess.kill('SIGKILL'); } catch (_) {}
		}
		activeDurationProbes.forEach(probe => { try { probe.kill('SIGKILL'); } catch (_) {} });
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
	reservationStore.writeArrayAtomic(RECORDING_DATA_FILE, recording);
	operatorLog('WRITE: ' + RECORDING_DATA_FILE);
}

// 録画済みTSの実ファイル長をffprobeで取得する。
// probeは録画完了後のbest-effort処理であり、失敗しても完了状態を変更しない。
function probeRecordedDuration(filePath, callback) {
	if (shutdownStarted) return null;
	if (durationProbeQueue.length >= 128) {
		operatorLog('WARNING: ffprobe queue full: ' + filePath);
		callback(null, Date.now());
		return null;
	}
	durationProbeQueue.push({ filePath, callback, queuedAt: Date.now() });
	wakePostProcessing();
	return null;
}

function lowerPostProcessingPriority(child, label) {
	if (!child || !child.pid) return;
	try { os.setPriority(child.pid, 19); } catch (error) {
		operatorLog('WARNING: ' + label + ' priority adjustment failed: ' + error.message);
	}
}

function startDurationProbe(job) {
	const startedAt = Date.now();
	const configuredCommand = typeof config.ffprobeCommand === 'string' ? config.ffprobeCommand.trim() : '';
	let probe = null;
	let completed = false;
	function complete(duration) {
		if (completed) return;
		completed = true;
		if (probe) { activeDurationProbes.delete(probe); activeDurationProbeJobs.delete(probe); }
		const recordedRow = recordedForPath(job.filePath);
		if (!shutdownStarted) rememberPostProcessing('ffprobe', recordedRow?.title || path.basename(job.filePath),
			duration === null ? 'failed' : 'complete', startedAt, recordedRow?.id ?? null);
		try {
			if (!shutdownStarted || job.maintenance === true) job.callback(duration, job.queuedAt);
		} finally {
			wakePostProcessing();
			recordedThumbnailGenerator.resume();
			completeOperatorShutdown();
		}
	}
	try {
		probe = child_process.execFile(configuredCommand || 'ffprobe', [
			'-v', 'fatal', '-threads', '1', '-show_entries', 'format=duration',
			'-of', 'default=noprint_wrappers=1:nokey=1', job.filePath
		], {
			timeout: recordedDurationProbeTimeoutMs,
			maxBuffer: 64 * 1024,
			encoding: 'utf8',
			killSignal: 'SIGKILL'
		}, (error, stdout) => {
			const duration = Number(String(stdout || '').trim());
			if (error || !Number.isFinite(duration) || duration <= 0) {
				operatorLog('WARNING: ffprobe duration failed: ' + job.filePath +
					' (' + (error ? error.message : 'invalid duration: ' + String(stdout || '').trim()) + ')');
				complete(null);
				return;
			}
			complete(Math.round(duration * 1000000) / 1000000);
		});
		activeDurationProbes.add(probe);
		activeDurationProbeJobs.set(probe, { filePath: job.filePath, startedAt });
		lowerPostProcessingPriority(probe, 'ffprobe');
	} catch (error) {
		operatorLog('WARNING: ffprobe start failed: ' + job.filePath + ' (' + error.message + ')');
		complete(null);
	}
}

// Serialize short recorded transactions, not recording streams. Other writers use
// the same existing recorded lock; no stale in-memory array is written back.
function queueRecordedLedgerUpdate(reason, update, afterSave, retryLock) {
	pendingRecordedLedgerWrites++;
	const transaction = recordedLedgerWrites.then(async () => {
		// Three bounded attempts span the existing 30s incomplete-lock grace
		// period. Only contention is retried; parse/write/I/O failures are not.
		const retryDelays = retryLock ? [1000, 5000] : [];
		for (let attempt = 0; ; attempt++) {
			try {
				return await reservationStore.withLockAsync(RECORDED_DATA_FILE, () => {
					const current = reservationStore.readArray(RECORDED_DATA_FILE);
					const next = update(current);
					if (next === null) return false;
					reservationStore.writeArrayAtomic(RECORDED_DATA_FILE, next);
					operatorLog('WRITE: ' + RECORDED_DATA_FILE);
					return true;
				}, { timeoutMs: 10000 });
			} catch (error) {
				if (error.code !== 'RESERVATION_LOCK_TIMEOUT' || attempt >= retryDelays.length || shutdownStarted) throw error;
				operatorLog('WARNING: recorded lock busy (' + reason + '); retry ' + (attempt + 1));
				await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
			}
		}
	});
	// A later match-history reconciliation must not delay new recorded saves.
	recordedLedgerWrites = transaction.catch(() => {});
	const result = transaction.then(async saved => {
		if (saved && afterSave) await afterSave();
		return saved;
	});
	result.catch(error => {
		operatorLog('ERROR: recorded ledger update failed (' + reason + '): ' + error.message);
	}).finally(() => {
		pendingRecordedLedgerWrites--;
		if (pendingRecordedLedgerWrites === 0) {
			try { recorded = reservationStore.readArray(RECORDED_DATA_FILE); } catch (error) {
				operatorLog('WARNING: recorded ledger reload failed: ' + error.message);
			}
		}
		wakePostProcessing();
		completeOperatorShutdown();
	});
	return result;
}

function finishPendingRecording(program) {
	const remaining = recording.filter(entry => entry !== program);
	// Remove the durable recovery row before dropping its in-memory reference.
	reservationStore.writeArrayAtomic(RECORDING_DATA_FILE, remaining);
	recording = remaining;
	operatorLog('WRITE: ' + RECORDING_DATA_FILE);
	delete mirakurunDropSnapshots[program.id];
	failedRecordingSaves.delete(program);
}

function reportRecordingSaveFailure(program, error) {
	failedRecordingSaves.add(program);
	operatorLog('ERROR: recording finalization incomplete #' + program.id + ': ' + error.message +
		'; recording.json retained. Resolve the storage/lock error and restart Operator to recover.');
}

function saveCompletedRecording(program, recovering, originalRecordedPath = program.recorded) {
	const replayingPendingSave = recovering && program._operatorHistoryPending === true;
	program._operatorHistoryPending = true;
	try {
		writeRecordingData();
	} catch (error) {
		// The previous started-recording row is still the recovery source if
		// this snapshot cannot be written. Do not discard it on a save failure.
		operatorLog('ERROR: recording recovery snapshot failed #' + program.id + ': ' + error.message);
	}
	let completedProgram = JSON.parse(JSON.stringify(program));
	delete completedProgram._operatorHistoryPending;
	delete completedProgram._operatorFilenameFinalTarget;
	if (completedProgram.operatorResumePending !== true) delete completedProgram._operatorFilenamePrefixApplied;
	operatorLog('FIN SAVE PENDING: ' + printProgram(program));
	return queueRecordedLedgerUpdate('recorded finalize', current => {
		// A crash can occur after recorded was saved but before recording was
		// cleared. Keep later duration/metadata updates when replaying that row.
		const saved = current.find(entry => entry.id === completedProgram.id &&
			entry.recorded === completedProgram.recorded &&
			entry.operatorRecordingStart === completedProgram.operatorRecordingStart);
		if (recovering && saved &&
			((replayingPendingSave && saved.operatorRecordingEnd === completedProgram.operatorRecordingEnd) ||
			(!completedProgram.operatorRecordingEnd && saved.operatorRecordingEnd))) {
			// Also covers a failed recording.json snapshot followed by a
			// successful history save: an older running row must not undo it.
			completedProgram = Object.assign({}, saved);
			return current;
		}
		const previous = current.find(entry => entry.id === completedProgram.id);
		if (previous && previous.recorded !== completedProgram.recorded && previous.recorded !== originalRecordedPath) {
			previous.id = getUniqueRecordedCollisionId(previous, current);
		}
		return current.filter(entry => entry.id !== completedProgram.id).concat(completedProgram);
	}, async () => {
		const isResumePending = completedProgram.operatorResumePending === true &&
			completedProgram.operatorAbort !== true && completedProgram.operatorEndLack !== true;
		if (!isResumePending) {
			await removeManualReserve(program);
		}
		// Keep recovery data until both history and manual-reservation removal
		// have succeeded. A hook never runs against an uncommitted history.
		finishPendingRecording(program);
		if (!isResumePending) {
			scheduleMatchLedgerUpdate('recorded finalize', completedProgram.operatorRecordingEnd);
			if (config.recordedCommand) {
				try {
					const postProcess = child_process.spawn(config.recordedCommand, [program.recorded, JSON.stringify(completedProgram)]);
					operatorLog('SPAWN: ' + config.recordedCommand + ' (pid=' + postProcess.pid + ')');
				} catch (error) {
					operatorLog('ERROR: recorded hook could not start: ' + error.message);
				}
			}
		}
		if (recovering) operatorLog('RECOVERED HISTORY: ' + printProgram(program));
		else if (isResumePending) operatorLog('FIN INTERRUPTED: resume pending: ' + printProgram(program));
		else if (program._operatorEndLack) operatorLog('FIN END LACK: ' + printProgram(program));
		else if (program._operatorAbort) operatorLog('FIN ABORT SHORT: ' + printProgram(program));
		else operatorLog('FIN: ' + printProgram(program));
	}, true).catch(error => {
		reportRecordingSaveFailure(program, error);
		return false;
	});
}

function discardRecordingAfterManualRemoval(program) {
	// Retain a pre-stream abort/NG until asynchronous reservation removal
	// completes; reserveCheckLoop must not prepare the same manual job again.
	program._operatorManualRemovalPending = true;
	try { writeRecordingData(); } catch (error) {
		operatorLog('ERROR: manual removal recovery snapshot failed: ' + error.message);
	}
	pendingRecordedLedgerWrites++;
	removeManualReserve(program).then(() => finishPendingRecording(program)).catch(error => {
		reportRecordingSaveFailure(program, error);
	}).finally(() => {
		pendingRecordedLedgerWrites--;
		wakePostProcessing();
		completeOperatorShutdown();
	});
}

function recoverRecordingHistory() {
	// These are ledger reads only; no recording-file existence checks or probes.
	try {
		reserves = reservationStore.readArray(RESERVES_DATA_FILE);
		recorded = reservationStore.readArray(RECORDED_DATA_FILE);
		const previous = recording;
		for (const program of previous) {
			if (!program || typeof program !== 'object' ||
				(program._operatorHistoryPending && (typeof program.recorded !== 'string' || !program.recorded.trim()))) {
				throw new Error('invalid recording recovery row');
			}
		}
		recording = previous.filter(program => program &&
			(program._operatorManualRemovalPending || (typeof program.recorded === 'string' && program.recorded.trim() !== '')));
		for (const program of recording) {
			if (!program.id || !Number.isFinite(program.start) || !Number.isFinite(program.end) || !program.channel) {
				throw new Error('invalid started-recording recovery row');
			}
		}
		writeRecordingData();
	} catch (error) {
		console.error('[fatal] recording recovery cannot start: ' + error.message);
		process.exit(1);
	}
	for (const program of recording.slice()) {
		delete program.pid;
		if (program._operatorManualRemovalPending) {
			discardRecordingAfterManualRemoval(program);
			continue;
		}
		const originalRecordedPath = program.recorded;
		// Only pending prefix renames need file access during recovery.
		if (program._operatorFilenameFinalTarget && !finalizeRecordingFilename(program, true)) continue;
		if (!program._operatorHistoryPending && !program.operatorRecordingEnd) {
			// Actual crash/end time is unknown: do not invent a measured duration.
			markRecordingInterruptedForResume(program);
		}
		saveCompletedRecording(program, true, originalRecordedPath);
	}
}

function persistRecordedDuration(programId, recordedPath, duration, requestedAt) {
	return queueRecordedLedgerUpdate('recorded duration', current => {
		const entry = current.find(value => value && value.id === programId && value.recorded === recordedPath);
		if (!entry || entry.operatorResumePending === true) {
			operatorLog('WARNING: ffprobe duration target changed, skip update: ' + recordedPath);
			return null;
		}
		entry.recordedDurationSeconds = duration;
		return current;
	}, () => {
		operatorLog('DURATION: ' + duration.toFixed(6) + ' sec ' + recordedPath);
		scheduleMatchLedgerUpdate('recorded duration', requestedAt);
	}).catch(() => false);
}

// close済み録画ファイル1件だけを実測し、正常録画のビットレート統計をbest-effortで更新する。
// recordedDurationSecondsは実ファイル内のmedia時間なので、予定時間や壁時計時間より容量との対応がよい。
function updateBitrateStatsAfterClose(program, recordedPath, recordedDurationSeconds) {
	try {
		if (!bitrateStats.isEligibleRecording(program, recordedDurationSeconds)) {
			return false;
		}

		const fileStat = fs.statSync(recordedPath);
		if ((typeof fileStat.isFile === 'function' && !fileStat.isFile()) ||
			!Number.isSafeInteger(fileStat.size) || fileStat.size <= 0) {
			return false;
		}

		const measurement = bitrateStats.createRecordingMeasurement(
			program,
			fileStat.size,
			recordedDurationSeconds
		);
		if (!measurement) {
			return false;
		}

		const result = bitrateStats.tryUpdateFile(BITRATE_STATS_FILE, measurement);
		if (result.error) {
			throw result.error;
		}
		if (result.updated) {
			operatorLog('BITRATE STATS: channel=' + measurement.channelKey +
				' program=' + measurement.recording.programId +
				' mbps=' + measurement.recording.mbps.toFixed(6));
		}
		return result.updated;
	} catch (error) {
		operatorLog('WARNING: bitrate stats update failed: ' + recordedPath + ' (' + error.message + ')');
		return false;
	}
}

function stopActiveDurationProbes() {
	durationProbeQueue.length = 0;
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
let matchLedgerProcess = null;
let matchLedgerReadyAt = 0;
let matchLedgerPendingAt = 0;
let matchLedgerProbesRemaining = null;
let matchLedgerWakeAt = 0;

// Merge overlapping start/end windows and wake at the next actual opening.
// Queue expiry handles overload; waiting must never bypass a handoff window.
function postProcessingDelay() {
	const now = Date.now();
	const windows = [[lastRecordingTransitionAt, lastRecordingTransitionAt + 15000]];
	const addWindows = program => {
		if (!program) return;
		[program.start, program.end].forEach(value => {
			const time = Number(value);
			if (Number.isFinite(time) && time > 0 && time + 15000 > now) {
				windows.push([time - 15000, time + 15000]);
			}
		});
	};
	reserves.forEach(program => {
		if (program && !program.isSkip && !program.isConflict && !isRecordedForReserve(program)) addWindows(program);
	});
	recording.forEach(addWindows);
	windows.sort((left, right) => left[0] - right[0]);
	let readyAt = now;
	for (const [start, end] of windows) {
		if (start > readyAt) break;
		if (end > readyAt) readyAt = end;
	}
	return readyAt - now;
}

// The automatic queue is a view of recorded.json, not a separately persisted list.
// Only the candidate currently being written is excluded; other recordings can
// still be analyzed up to the configured concurrent-recording limit.
function nextAutoTsCandidate() {
	const openFiles = new Set(Array.from(activeRecordingOutputs, output => String(output.path || '')));
	return recordedAutoAnalysis.summarize(recorded, Date.now(), entry => openFiles.has(path.resolve(__dirname, entry.recorded))).candidate;
}

function stopAutoIfRecordingLimitExceeded() {
	if (!autoTsAnalysisEnabled) return;
	const actual = recording.filter(program => program && !program.operatorRecordingEnd &&
		!program.operatorResumePending && !program._operatorManualRemovalPending).length;
	if (Math.max(actual, activeRecordingOutputs.size) > autoTsMaxRecordings) {
		recordedMaintenance.interruptAuto('録画本数が許可上限を超えたため自動TS解析を中断しました。');
	}
}

function scheduleAutoTsReview() {
	if (!autoTsAnalysisEnabled || shutdownStarted) return;
	autoTsReviewTimer = setTimeout(() => {
		autoTsReviewTimer = null;
		wakePostProcessing();
		scheduleAutoTsReview();
	}, recordedAutoAnalysis.nextReviewDelay());
}

function wakePostProcessing(delay = 0) {
	if (shutdownStarted) return;
	delay = Math.max(0, Math.min(delay, 0x7fffffff));
	const wakeAt = Date.now() + delay;
	if (matchLedgerUpdateTimer !== null) {
		if (matchLedgerWakeAt <= wakeAt) return;
		clearTimeout(matchLedgerUpdateTimer);
	}
	matchLedgerWakeAt = wakeAt;
	matchLedgerUpdateTimer = setTimeout(() => {
		matchLedgerUpdateTimer = null;
		runPostProcessing();
	}, delay);
}

function runPostProcessing() {
	if (recordedMaintenance.isBusy()) return;
	if (shutdownStarted || matchLedgerProcess || activeDurationProbes.size !== 0 ||
		recordedThumbnailGenerator.getState().active) return;
	if (pendingRecordedLedgerWrites !== 0) return;
	const now = Date.now();
	while (durationProbeQueue.length && now - durationProbeQueue[0].queuedAt >= 10 * 60 * 1000) {
		const expired = durationProbeQueue.shift();
		if (matchLedgerProbesRemaining > 0) matchLedgerProbesRemaining--;
		operatorLog('WARNING: ffprobe job expired in queue: ' + expired.filePath);
		expired.callback(null, expired.queuedAt);
	}
	// A failed/expired probe's fallback callback can start a thumbnail directly.
	if (recordedThumbnailGenerator.getState().active) return;
	const delay = postProcessingDelay();
	if ((matchLedgerUpdateReason || durationProbeQueue.length) && delay > 0) {
		const expiryDelay = durationProbeQueue.length ? durationProbeQueue[0].queuedAt + 10 * 60 * 1000 - now : Infinity;
		wakePostProcessing(Math.min(delay, expiryDelay));
		return;
	}
	const thumbnail = recordedThumbnailGenerator.getState();
	const nextProbeAt = durationProbeQueue.length ? durationProbeQueue[0].queuedAt : Infinity;
	const nextMatchAt = matchLedgerUpdateReason && scheduler === null ? matchLedgerPendingAt : Infinity;
	const nextManualAt = recordedMaintenance.nextRequestedAt();
	// An older recording's thumbnail must not fall behind every later batch.
	if (thumbnail.pending && thumbnail.pendingSince < Math.min(nextProbeAt, nextMatchAt, nextManualAt)) {
		recordedThumbnailGenerator.resume();
		return;
	}
	if (Number.isFinite(nextManualAt) && nextManualAt < Math.min(nextProbeAt, nextMatchAt)) {
		recordedMaintenance.runNext();
		// A TS request may be deferred by recording. Existing automatic work can still proceed.
		if (recordedMaintenance.isBusy()) return;
	}
	const matchDue = matchLedgerUpdateReason && scheduler === null && now >= matchLedgerReadyAt;
	// Drain up to the eight recordings in one handoff before rebuilding match.
	// Later arrivals cannot extend the batch or crowd out older thumbnails.
	if (matchLedgerUpdateReason && matchLedgerProbesRemaining === null) {
		matchLedgerProbesRemaining = Math.min(8, durationProbeQueue.length);
	}
	if (durationProbeQueue.length && (!matchDue || matchLedgerProbesRemaining > 0)) {
		if (matchLedgerProbesRemaining > 0) matchLedgerProbesRemaining--;
		startDurationProbe(durationProbeQueue.shift());
		return;
	}
	if (matchDue) {
		const reason = matchLedgerUpdateReason;
		matchLedgerUpdateReason = '';
		updateMatchLedger(reason);
		return;
	}
	if (matchLedgerUpdateReason && scheduler === null) wakePostProcessing(Math.max(0, matchLedgerReadyAt - now));
	else {
		recordedThumbnailGenerator.resume();
		recordedMaintenance.runNext();
		// Optional full-file reads run only after existing post-processing work.
		if (autoTsAnalysisEnabled && !recordedMaintenance.isBusy() &&
			!recordedThumbnailGenerator.getState().pending && !recordedThumbnailGenerator.getState().active &&
			!durationProbeQueue.length && !matchLedgerUpdateReason && scheduler === null &&
			!Number.isFinite(recordedMaintenance.nextRequestedAt())) {
			const candidate = nextAutoTsCandidate();
			if (candidate) recordedMaintenance.startAuto(candidate);
		}
	}
}

function scheduleMatchLedgerUpdate(reason, sourceAt) {
	if (shutdownStarted) return;
	if (!matchLedgerUpdateReason) {
		const requestedAt = Date.now();
		// A recording's close callback can queue its probe before its ledger save
		// requests match. Keep that batch ahead of its own thumbnails either way.
		matchLedgerPendingAt = Number.isFinite(sourceAt) && sourceAt > 0 ? Math.min(requestedAt, sourceAt) : requestedAt;
		matchLedgerProbesRemaining = null;
		matchLedgerReadyAt = requestedAt +
			(Number(config.matchUpdateDelayMs) >= 0 ? Number(config.matchUpdateDelayMs) : 3000);
	}
	matchLedgerUpdateReason = reason || matchLedgerUpdateReason || 'scheduled';
	wakePostProcessing();
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
	const startedAt = Date.now();
	let child = null;
	let settled = false;
	let spawnError = null;
	let stdout = '';
	let stderr = '';
	function complete(code, signal) {
		if (settled) return;
		settled = true;
		matchLedgerProcess = null;
		if (!shutdownStarted) rememberPostProcessing('match', reason || 'match更新',
			spawnError || code !== 0 || signal ? 'failed' : 'complete', startedAt);
		emitMatchProcessOutput({ stdout, stderr });
		operatorLog('MATCH EXIT: pid=' + (child && child.pid || '-') +
			' elapsed_ms=' + (Date.now() - startedAt) + ' code=' + code + ' signal=' + (signal || '-'));
		if (spawnError || code !== 0 || signal) {
			operatorLog('WARNING: match.json update failed: ' +
				(spawnError ? spawnError.message : 'code=' + code + ' signal=' + signal));
		}
		wakePostProcessing();
		recordedThumbnailGenerator.resume();
		completeOperatorShutdown();
	}
	try {
		if (!fs.existsSync(appMatchingFile)) throw new Error('app-matching.js is missing');
		operatorLog('RUN: ' + appMatchingFile + (reason ? ' (' + reason + ')' : ''));
		child = child_process.spawn(process.execPath, [
			appMatchingFile,
			'--recorded', RECORDED_DATA_FILE,
			'--recording', RECORDING_DATA_FILE,
			'--reserves2', RESERVES2_DATA_FILE,
			'--old-match', MATCH_DATA_FILE,
			'--output', MATCH_DATA_FILE,
			'--config', CONFIG_FILE
		], {
			cwd: __dirname, stdio: [ 'ignore', 'pipe', 'pipe' ],
			// A stuck optional worker must not hold the other post-processing jobs
			// indefinitely. Five minutes allows ample headroom over observed ~35s.
			timeout: 5 * 60 * 1000, killSignal: 'SIGKILL'
		});
		matchLedgerProcess = child;
		child.once('error', error => { spawnError = error; });
		child.once('close', complete);
		lowerPostProcessingPriority(child, 'match');
		// Drain both pipes even if verbose output exceeds the retained log tail.
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-1024 * 1024); });
		child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-64 * 1024); });
	} catch (error) {
		spawnError = error;
		if (child) {
			try { child.kill('SIGTERM'); } catch (_) {}
		} else complete(null, null);
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

const RECORDING_FILENAME_PREFIX = '【録画中】';

// 録画保存先パスを取得する
function getRecordedPath(program, useRecordingPrefix = true) {
	let recordedName = chinachu.formatRecordedName(program, program.recordedFormat || config.recordedFormat, {
		replaceEnclosingCharacters: config.recordedNameReplaceEnclosingCharacters === true ||
			config.needToReplaceEnclosingCharacters === true,
		enclosingCharacterMap: config.recordedNameEnclosingCharacterMap || null
	});

	if (useRecordingPrefix && config.recordingFilenamePrefixEnabled === true) {
		const name = path.basename(recordedName);
		if (!name.startsWith(RECORDING_FILENAME_PREFIX)) {
			recordedName = recordedName.slice(0, -name.length) + RECORDING_FILENAME_PREFIX + name;
		}
	}
	return joinRecordedPath(getRecordedDir(program), recordedName);
}

// ファイル名確定は、その予定をrecording.jsonに記録してから行う。
// 再起動時は旧名・新名のどちらが残ったかを確認して確定できる。
function finalizeRecordingFilename(program, recovering = false) {
	const source = program.recorded;
	const target = program._operatorFilenameFinalTarget;
	if (!target) return true;
	if (fs.existsSync(source)) {
		if (fs.existsSync(target)) {
			operatorLog('WARNING: recording rename target exists: ' + target);
		} else {
			try {
				fs.renameSync(source, target);
				operatorLog('RENAME: ' + source + ' -> ' + target);
				program.recorded = target;
			} catch (error) {
				operatorLog('WARNING: recording rename failed: ' + source + ' (' + error.message + ')');
			}
		}
	} else if (recovering && fs.existsSync(target)) {
		program.recorded = target;
	} else if (recovering) {
		operatorLog('ERROR: pending recording rename paths missing: ' + source + ' / ' + target);
		return false;
	}
	delete program._operatorFilenameFinalTarget;
	return true;
}

function recordingFinalName(recordedPath) {
	const name = path.basename(recordedPath);
	if (!name.startsWith(RECORDING_FILENAME_PREFIX) || name === RECORDING_FILENAME_PREFIX) return null;
	return recordedPath.slice(0, -name.length) + name.slice(RECORDING_FILENAME_PREFIX.length);
}

// WUIのシリーズ管理Workerが公開した確定TID。新しい台帳は作らない。
const recordedFolderOrganizer = require('./lib/recorded-folder-organizer');
let recordedSeriesIndex = new Map();
let recordedSeriesGeneration = '';

function completedRecordedPath(program) {
	const source = program.recorded;
	const withoutPrefix = program._operatorFilenamePrefixApplied === true ? recordingFinalName(source) || source : source;
	if (config.recordedFolderOrganizeEnabled !== true) return withoutPrefix === source ? null : withoutPrefix;
	const root = path.resolve(getRecordedDir(program));
	if (path.dirname(path.resolve(source)) !== root) return withoutPrefix === source ? null : withoutPrefix;
	try {
		const selection = recordedFolderOrganizer.chooseRecordedFolder({
			program, sourcePath: withoutPrefix, root,
			folderNames: recordedFolderOrganizer.listExistingFolders(root),
			recorded, series: recordedSeriesIndex.get(String(program.id)) || null,
			seriesByRecordedId: recordedSeriesIndex,
			order: config.recordedFolderOrganizeOrder || 'filename'
		});
		if (selection) return path.join(selection.directoryPath, path.basename(withoutPrefix));
	} catch (error) {
		operatorLog('WARNING: recorded folder selection failed: ' + error.message);
	}
	return withoutPrefix === source ? null : withoutPrefix;
}

// 既存のOperator Unix socket経由で、小さな単位の確定TID索引を受け取る。
function updateRecordedSeriesIndex(message) {
	if (config.recordedFolderOrganizeEnabled !== true) return { accepted: false };
	if (typeof message.generation !== 'string' || !message.generation ||
		!Array.isArray(message.entries) || message.entries.length > 512) return { accepted: false };
	if (message.reset === true) {
		recordedSeriesIndex = new Map();
		recordedSeriesGeneration = message.generation;
	}
	if (recordedSeriesGeneration !== message.generation) return { accepted: false };
	for (const row of message.entries) {
		if (!Array.isArray(row) || row.length !== 3 || typeof row[0] !== 'string' ||
			!row[0] || !Number.isSafeInteger(row[1]) || row[1] <= 0 || typeof row[2] !== 'string') continue;
		recordedSeriesIndex.set(row[0], { tid: row[1], title: row[2] });
	}
	return { accepted: true };
}

// expectedMount / root filesystem guardと、Low対象filesystemの録画開始guardを適用する。
// 未設定の従来録画先にはmount必須条件やroot領域保護を適用しない。
function ensureRecordingDestinationHealthy(program, allowCreate, options) {
	options = options || {};
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

	const cachedGroup = storageMonitor.getByDestination(destination);
	const cleanupState = cachedGroup && storageCleanupState[cachedGroup.filesystemKey];
	let health = storageMonitor.check(destination, {
		now: Date.now(),
		force: options.force === true,
		refreshAfterMs: cleanupState && cleanupState.awaitingCapacityRefresh === true ? 1000 : undefined
	});

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
		handleStorageGroup(health, options.recordingEvent);
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
async function removeManualReserve(program) {
	if (!program || !program.isManualReserved) {
		return false;
	}

	try {
		return await reservationStore.withLockAsync(RESERVES_DATA_FILE, () => {
			const latestReserves = reservationStore.readArray(RESERVES_DATA_FILE);

			for (let i = 0, l = latestReserves.length; i < l; i++) {
				if (latestReserves[i].id !== program.id || !latestReserves[i].isManualReserved) {
					continue;
				}

				latestReserves.splice(i, 1);
				reservationStore.writeArrayAtomic(RESERVES_DATA_FILE, latestReserves);
				reserves = latestReserves;
				operatorLog('WRITE: ' + RESERVES_DATA_FILE);
				return true;
			}

			return false;
		});
	} catch (error) {
		operatorLog('WARNING: manual reserve removal failed: ' + error.message);
		throw error;
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

// 旧allowEndLackは「この録画が末尾を譲る許可」だけを表す。
// 新しいstart/endは、録画開始側と終了側の両方で評価する。
function boundaryOverride(program) {
	if (program?.recordingBoundaryPolicy === 'start' || program?.recordingBoundaryPolicy === 'end') {
		return program.recordingBoundaryPolicy;
	}
	return program?.allowEndLack === true ? 'legacy-start' : 'default';
}

function mayHandoffEndEarly(current, next) {
	const currentMode = boundaryOverride(current);
	const nextMode = boundaryOverride(next);
	// 明示的な終了優先は末尾短縮を拒否する。開始優先は共通設定を上書きできる。
	if (currentMode === 'end' || nextMode === 'end') return false;
	return currentMode === 'start' || currentMode === 'legacy-start' ||
		nextMode === 'start' || config.recordingBoundaryPolicy === 'start';
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
// stream取得失敗後だけ呼び出し、終了直前で録画境界の優先方針が末尾短縮を許す録画だけを対象にする。
function findHandoffEndLackCandidate(nextProgram) {
	return getHandoffEndLackCandidateInfo(nextProgram).candidate;
}

function canHandoffAcrossTypes(currentType, nextType, tuners) {
	if (!Array.isArray(tuners) || !tuners.every(tuner => tuner &&
		Array.isArray(tuner.types) && tuner.types.length > 0 &&
		tuner.types.every(type => typeof type === 'string' && type.length > 0))) {
		return false;
	}
	const currentTuners = tuners.filter(tuner => tuner.types.includes(currentType));
	return currentTuners.length > 0 && currentTuners.every(tuner => tuner.types.includes(nextType));
}

function getHandoffEndLackCandidateInfo(nextProgram, tuners = null) {
	let candidate = null;
	let candidateRemainSeconds = Infinity;
	let skipped = null;
	let skippedRemainSeconds = Infinity;
	let needsTunerInfo = false;
	const nextType = nextProgram && nextProgram.channel && nextProgram.channel.type;

	for (let i = 0, l = recording.length; i < l; i++) {
		const current = recording[i];
		const remainSeconds = getEarlyFinishSeconds(current, clock);

		if (!current || current.id === (nextProgram && nextProgram.id)) {
			continue;
		}

		if (!current._stream || current._operatorNg || current._operatorAbort || current._operatorEndLack) {
			continue;
		}

		if (!mayHandoffEndEarly(current, nextProgram)) {
			continue;
		}

		if (isSameChannelProgram(current, nextProgram)) {
			continue;
		}

		// 既に終了時刻を過ぎている番組はLACKではなく通常終了/固着掃除側に任せる。
		if (!current.end || Number(current.end) <= clock) {
			continue;
		}

		const currentType = current.channel && current.channel.type;
		if (typeof currentType !== 'string' || !currentType || typeof nextType !== 'string' || !nextType) {
			continue;
		}
		if (currentType !== nextType) {
			if (tuners === null) {
				if (remainSeconds <= endLackMaxSeconds) needsTunerInfo = true;
				continue;
			}
			if (!canHandoffAcrossTypes(currentType, nextType, tuners)) {
				continue;
			}
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
		skippedRemainSeconds: skippedRemainSeconds,
		needsTunerInfo: needsTunerInfo
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
	const statusCode = Number(err && (err.statusCode || err.status) || 0);
	const reason = err && (err.statusMessage || err.statusText || (err.body && err.body.reason));
	// Mirakurunは資源不足だけをこのreasonの503で返す。
	// 現行clientのstream取得ではHTTPエラーがmessageだけのErrorに変換される。
	return (statusCode === 503 && reason === 'Tuner Resource Unavailable') ||
		/^Bad status respond \(503 Tuner Resource Unavailable\)\.$/.test(String(err && err.message || ''));
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

function readBroadcastClockState() {
	try {
		const state = JSON.parse(fs.readFileSync(BROADCAST_CLOCK_STATE_FILE, 'utf8'));
		if (!state || state.schemaVersion !== 1 || !Number.isFinite(state.nextAttemptAt) || typeof state.warningActive !== 'boolean') {
			throw new Error('invalid state');
		}
		const lastSuccess = getBroadcastClockLastSuccess(state);
		if (lastSuccess) state.lastSuccess = lastSuccess;
		state.warningActive = lastSuccess ? isBroadcastClockWarning(lastSuccess) : false;
		return state;
	} catch (error) {
		if (error.code === 'ENOENT') {
			return null;
		}
		broadcastClockStateWritable = false;
		operatorLog('[BroadcastClock] ERROR: state read failed; existing file will not be overwritten: ' + error.message);
		return null;
	}
}

function getBroadcastClockDiffMs(result) {
	if (result && Number.isFinite(result.diffMs)) return Number(result.diffMs);
	if (result && Number.isFinite(result.diffSeconds)) return Number(result.diffSeconds) * 1000;
	return null;
}

function isBroadcastClockSuccess(result) {
	return !!result && Number.isFinite(getBroadcastClockDiffMs(result)) &&
		Number.isFinite(Date.parse(result.observedAt)) &&
		['TDT', 'TOT'].includes(result.source) && Number(result.sampleCount) >= BROADCAST_CLOCK_SAMPLES;
}

function getBroadcastClockLastSuccess(state) {
	if (isBroadcastClockSuccess(state && state.lastSuccess)) return state.lastSuccess;
	if (isBroadcastClockSuccess(state && state.lastResult)) return state.lastResult;
	return null;
}

function isBroadcastClockWarning(result) {
	const diffMs = getBroadcastClockDiffMs(result);
	return diffMs !== null && (diffMs <= -BROADCAST_CLOCK_WARNING_MS || diffMs >= BROADCAST_CLOCK_WARNING_MS);
}

function getBroadcastClockJstParts(at) {
	const date = new Date(Number(at) + BROADCAST_CLOCK_JST_OFFSET_MS);
	return {
		year: date.getUTCFullYear(),
		month: date.getUTCMonth(),
		date: date.getUTCDate(),
		hour: date.getUTCHours(),
		minute: date.getUTCMinutes()
	};
}

function getBroadcastClockSlotKey(at) {
	const parts = getBroadcastClockJstParts(at);
	if (!BROADCAST_CLOCK_SLOT_HOURS.includes(parts.hour) || parts.minute < 40 || parts.minute > 49) return null;
	return [
		parts.year,
		String(parts.month + 1).padStart(2, '0'),
		String(parts.date).padStart(2, '0'),
		String(parts.hour).padStart(2, '0')
	].join('-');
}

function getNextBroadcastClockAttempt(now, state) {
	const parts = getBroadcastClockJstParts(now);
	const lastSuccess = getBroadcastClockLastSuccess(state);
	const completedSlot = lastSuccess ? getBroadcastClockSlotKey(Date.parse(lastSuccess.observedAt)) : null;
	for (let dayOffset = 0; dayOffset < 3; dayOffset++) {
		for (let h = 0; h < BROADCAST_CLOCK_SLOT_HOURS.length; h++) {
			for (let m = 0; m < BROADCAST_CLOCK_SLOT_MINUTES.length; m++) {
				const candidate = Date.UTC(
					parts.year,
					parts.month,
					parts.date + dayOffset,
					BROADCAST_CLOCK_SLOT_HOURS[h] - 9,
					BROADCAST_CLOCK_SLOT_MINUTES[m]
				);
				if (candidate <= now) continue;
				if (completedSlot && getBroadcastClockSlotKey(candidate) === completedSlot) continue;
				return candidate;
			}
		}
	}
	throw new Error('failed to calculate next broadcast clock slot');
}

function formatBroadcastClockJst(at) {
	const date = new Date(Number(at) + BROADCAST_CLOCK_JST_OFFSET_MS);
	const pad = value => String(value).padStart(2, '0');
	return date.getUTCFullYear() + '/' + pad(date.getUTCMonth() + 1) + '/' + pad(date.getUTCDate()) + ' ' +
		pad(date.getUTCHours()) + ':' + pad(date.getUTCMinutes()) + ':' + pad(date.getUTCSeconds()) + ' JST';
}

function persistBroadcastClockState() {
	if (!broadcastClockStateWritable || !broadcastClockState) {
		return;
	}
	try {
		storageRuntimeState.atomicWriteJson(fs, BROADCAST_CLOCK_STATE_FILE, broadcastClockState);
	} catch (error) {
		operatorLog('[BroadcastClock] ERROR: state write failed: ' + error.message);
	}
}

function scheduleBroadcastClockObservation(at) {
	if (shutdownStarted) {
		return;
	}
	if (broadcastClockTimer !== null) {
		clearTimeout(broadcastClockTimer);
	}
	const delay = Math.max(1000, Number(at) - Date.now());
	broadcastClockTimer = setTimeout(() => {
		broadcastClockTimer = null;
		runBroadcastClockObservation();
	}, delay);
	broadcastClockTimer.unref?.();
}

function updateBroadcastClockState(status, result, successful) {
	const now = Date.now();
	broadcastClockState = Object.assign({
		schemaVersion: 1,
		warningActive: false
	}, broadcastClockState || {}, {
		status: status,
		updatedAt: new Date(now).toISOString()
	});
	if (result !== undefined) {
		broadcastClockState.lastResult = result;
	}
	if (successful === true) {
		broadcastClockState.lastSuccess = result;
	}
	broadcastClockState.nextAttemptAt = getNextBroadcastClockAttempt(now, broadcastClockState);
	persistBroadcastClockState();
	scheduleBroadcastClockObservation(broadcastClockState.nextAttemptAt);
	return broadcastClockState.nextAttemptAt;
}

function getBroadcastClockLocalDeferralReason(now, requiredRunMs) {
	if (recording.length > 0) {
		return 'recording-active';
	}
	const guardMs = BROADCAST_CLOCK_RESERVE_GUARD_MS + Math.max(0, Number(requiredRunMs) || 0);
	for (let i = 0; i < reserves.length; i++) {
		const program = reserves[i];
		if (!program || program.isSkip === true || !Number.isFinite(Number(program.start)) || !Number.isFinite(Number(program.end))) {
			continue;
		}
		if (Number(program.end) <= now) {
			continue;
		}
		if (Number(program.start) - now < guardMs) {
			return requiredRunMs ? 'insufficient-time-before-next-recording' : 'recording-reserved-within-10-minutes';
		}
	}
	return null;
}

function selectBroadcastClockChannel(tuners, channels) {
	if (!Array.isArray(tuners) || !Array.isArray(channels)) {
		return null;
	}
	const freeTuners = tuners.filter(tuner => tuner && tuner.isAvailable === true && tuner.isFree === true &&
		Array.isArray(tuner.users) && tuner.users.length === 0 && Array.isArray(tuner.types) && tuner.types.length > 0);
	if (freeTuners.length === 0) {
		return null;
	}
	return channels.find(channel => channel && channel.type === 'GR' &&
		(typeof channel.channel === 'string' || typeof channel.channel === 'number') &&
		(BROADCAST_CLOCK_GR_CHANNEL === null || String(channel.channel) === BROADCAST_CLOCK_GR_CHANNEL) &&
		freeTuners.some(tuner => tuner.types.indexOf(channel.type) !== -1)) || null;
}

function buildBroadcastClockToolArgs(channel) {
	const requestPath = mirakurunDropWatch.getApiRequestPath(
		mirakurun,
		'channels/' + encodeURIComponent(channel.type) + '/' + encodeURIComponent(String(channel.channel)) + '/stream'
	) + '?decode=0';
	const args = [
		BROADCAST_CLOCK_TOOL,
		'--samples', String(BROADCAST_CLOCK_SAMPLES),
		'--timeout', String(BROADCAST_CLOCK_TIMEOUT_MS),
		'--priority', String(BROADCAST_CLOCK_PRIORITY)
	];
	if (mirakurunDropWatch.usesUnixSocket(mirakurun)) {
		args.push('--socket-path', mirakurun.socketPath, '--request-path', requestPath);
	} else {
		const streamUrl = new URL(mirakurunPath);
		streamUrl.pathname = requestPath.split('?')[0];
		streamUrl.search = requestPath.indexOf('?') === -1 ? '' : requestPath.slice(requestPath.indexOf('?'));
		args.push('--url', streamUrl.toString());
	}
	return args;
}

function deferBroadcastClockObservation(reason) {
	const nextAt = updateBroadcastClockState('deferred', {
		checkedAt: new Date().toISOString(),
		reason: reason
	});
	operatorLog('[BroadcastClock] DEFER: ' + reason + '; NEXT: ' + formatBroadcastClockJst(nextAt));
}

function failBroadcastClockObservation(error) {
	const nextAt = updateBroadcastClockState('failed', {
		checkedAt: new Date().toISOString(),
		error: error.message
	});
	operatorLog('[BroadcastClock] ERROR: observation failed: ' + error.message + '; NEXT: ' + formatBroadcastClockJst(nextAt));
}

function handleBroadcastClockResult(result, channel) {
	if (!result || result.ok !== true || !Number.isFinite(result.diffMs) ||
		!['TDT', 'TOT'].includes(result.source) || result.sampleCount < BROADCAST_CLOCK_SAMPLES ||
		!Number.isFinite(Date.parse(result.broadcastTimeUtc)) || !Number.isFinite(Date.parse(result.systemTime))) {
		failBroadcastClockObservation(new Error('invalid or incomplete probe result'));
		return;
	}
	const diffMs = result.diffMs;
	const diffSeconds = diffMs / 1000;
	const warning = diffMs <= -BROADCAST_CLOCK_WARNING_MS || diffMs >= BROADCAST_CLOCK_WARNING_MS;
	const wasWarning = broadcastClockState && broadcastClockState.warningActive === true;
	if (warning && !wasWarning) {
		operatorLog('[BroadcastClock] WARN: server clock ' + (diffSeconds >= 0 ? 'ahead of' : 'behind') +
			' broadcast by ' + Math.abs(diffSeconds).toFixed(3) + ' seconds');
	} else if (!warning && wasWarning) {
		operatorLog('[BroadcastClock] RECOVERED: server clock is within +/-3 seconds; difference is ' +
			diffSeconds.toFixed(3) + ' seconds');
	} else if (!warning) {
		operatorLog('[BroadcastClock] OK: server clock is within +/-3 seconds; difference is ' +
			diffSeconds.toFixed(3) + ' seconds');
	}
	broadcastClockState = Object.assign({ schemaVersion: 1 }, broadcastClockState || {}, { warningActive: warning });
	const nextAt = updateBroadcastClockState(warning ? 'warning' : 'normal', {
		observedAt: new Date().toISOString(),
		channel: { type: channel.type, channel: String(channel.channel), name: channel.name || null },
		source: result.source,
		broadcastTimeUtc: result.broadcastTimeUtc,
		systemTimeUtc: result.systemTime,
		diffMs: diffMs,
		diffSeconds: diffSeconds,
		sampleCount: result.sampleCount
	}, true);
	operatorLog('[BroadcastClock] NEXT: ' + formatBroadcastClockJst(nextAt));
}

function startBroadcastClockProbe(channel) {
	const args = buildBroadcastClockToolArgs(channel);
	let stdout = '';
	let stderr = '';
	const child = child_process.spawn(process.execPath, args, {
		stdio: [ 'ignore', 'pipe', 'pipe' ]
	});
	broadcastClockProcess = child;
	operatorLog('[BroadcastClock] START: channel=' + channel.type + '/' + channel.channel +
		' samples=' + BROADCAST_CLOCK_SAMPLES + ' timeout=' + BROADCAST_CLOCK_TIMEOUT_MS + 'ms priority=' + BROADCAST_CLOCK_PRIORITY);
	const timeout = setTimeout(() => {
		child._broadcastClockFailure = new Error('probe timed out after ' + BROADCAST_CLOCK_TIMEOUT_MS + ' ms');
		try { child.kill('SIGTERM'); } catch (_) {}
	}, BROADCAST_CLOCK_TIMEOUT_MS);
	timeout.unref?.();
	child.stdout.on('data', chunk => {
		stdout += chunk.toString('utf8');
		if (stdout.length > 256 * 1024) {
			child._broadcastClockFailure = new Error('probe output exceeded limit');
			try { child.kill('SIGTERM'); } catch (_) {}
		}
	});
	child.stderr.on('data', chunk => {
		stderr += chunk.toString('utf8');
		if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
	});
	child.once('error', error => {
		clearTimeout(timeout);
		if (broadcastClockProcess === child) broadcastClockProcess = null;
		broadcastClockChecking = false;
		if (!shutdownStarted) failBroadcastClockObservation(error);
	});
	child.once('close', (code, signal) => {
		clearTimeout(timeout);
		if (broadcastClockProcess !== child) return;
		broadcastClockProcess = null;
		broadcastClockChecking = false;
		if (shutdownStarted) return;
		if (child._broadcastClockFailure) {
			failBroadcastClockObservation(child._broadcastClockFailure);
			return;
		}
		if (child._broadcastClockAbortReason) {
			deferBroadcastClockObservation(child._broadcastClockAbortReason);
			return;
		}
		if (code !== 0 || signal) {
			let detail = stderr.trim();
			try {
				const failure = JSON.parse(detail);
				detail = failure.error || detail;
			} catch (_) {}
			failBroadcastClockObservation(new Error(detail || ('probe exit=' + code + (signal ? ' signal=' + signal : ''))));
			return;
		}
		try {
			handleBroadcastClockResult(JSON.parse(stdout), channel);
		} catch (error) {
			failBroadcastClockObservation(new Error('probe output parse failed: ' + error.message));
		}
	});
}

async function runBroadcastClockObservation() {
	if (shutdownStarted || broadcastClockChecking || broadcastClockProcess) {
		return;
	}
	broadcastClockChecking = true;
	const now = Date.now();
	const nextAttemptAt = getNextBroadcastClockAttempt(now, broadcastClockState);
	broadcastClockState = Object.assign({ schemaVersion: 1, warningActive: false }, broadcastClockState || {}, {
		lastAttemptAt: now,
		nextAttemptAt: nextAttemptAt,
		status: 'checking',
		updatedAt: new Date(now).toISOString()
	});
	persistBroadcastClockState();
	try {
		const localReason = getBroadcastClockLocalDeferralReason(now, BROADCAST_CLOCK_TIMEOUT_MS);
		if (localReason) {
			broadcastClockChecking = false;
			deferBroadcastClockObservation(localReason);
			return;
		}
		const tunersResult = await getMirakurunJson('/tuners', 3000);
		if (!tunersResult.ok) throw new Error('tuner state unavailable: ' + tunersResult.error);
		const channelsResult = await getMirakurunJson('/channels', 3000);
		if (!channelsResult.ok) throw new Error('channel state unavailable: ' + channelsResult.error);
		if (shutdownStarted) {
			broadcastClockChecking = false;
			return;
		}
		const channel = selectBroadcastClockChannel(tunersResult.data, channelsResult.data);
		if (!channel) {
			broadcastClockChecking = false;
			deferBroadcastClockObservation(BROADCAST_CLOCK_GR_CHANNEL === null
				? 'no confirmed free tuner and GR channel'
				: 'configured channel GR/' + BROADCAST_CLOCK_GR_CHANNEL + ' is unavailable or has no confirmed free tuner');
			return;
		}
		const changedReason = getBroadcastClockLocalDeferralReason(Date.now(), BROADCAST_CLOCK_TIMEOUT_MS);
		if (changedReason) {
			broadcastClockChecking = false;
			deferBroadcastClockObservation(changedReason);
			return;
		}
		startBroadcastClockProbe(channel);
	} catch (error) {
		broadcastClockChecking = false;
		failBroadcastClockObservation(error);
	}
}

function abortBroadcastClockObservationIfNeeded() {
	if (!broadcastClockProcess) {
		return;
	}
	const reason = getBroadcastClockLocalDeferralReason(Date.now());
	if (!reason) {
		return;
	}
	broadcastClockProcess._broadcastClockAbortReason = reason;
	try { broadcastClockProcess.kill('SIGTERM'); } catch (error) {
		operatorLog('[BroadcastClock] ERROR: probe stop failed: ' + error.message);
	}
}

function startBroadcastClockMonitor() {
	broadcastClockState = readBroadcastClockState();
	if (!broadcastClockState) {
		broadcastClockState = {
			schemaVersion: 1,
			warningActive: false,
			status: 'scheduled',
			nextAttemptAt: 0,
			updatedAt: new Date().toISOString()
		};
	}
	if (!BROADCAST_CLOCK_ENABLED) {
		broadcastClockState.warningActive = false;
		broadcastClockState.status = 'disabled';
		broadcastClockState.nextAttemptAt = 0;
		broadcastClockState.updatedAt = new Date().toISOString();
		persistBroadcastClockState();
		operatorLog('[BroadcastClock] DISABLED: periodic TDT/TOT observation is off');
		return;
	}
	if (broadcastClockState.status === 'disabled') {
		broadcastClockState.status = broadcastClockState.warningActive ? 'warning' : 'scheduled';
	}
	broadcastClockState.nextAttemptAt = getNextBroadcastClockAttempt(Date.now(), broadcastClockState);
	broadcastClockState.updatedAt = new Date().toISOString();
	persistBroadcastClockState();
	scheduleBroadcastClockObservation(broadcastClockState.nextAttemptAt);
	operatorLog('[BroadcastClock] CONFIG: interval=' + BROADCAST_CLOCK_INTERVAL_HOURS + 'h channel=' +
		(BROADCAST_CLOCK_GR_CHANNEL === null ? 'auto (GR)' : 'GR/' + BROADCAST_CLOCK_GR_CHANNEL));
	operatorLog('[BroadcastClock] NEXT: ' + formatBroadcastClockJst(broadcastClockState.nextAttemptAt));
}

function stopBroadcastClockMonitor() {
	if (broadcastClockTimer !== null) {
		clearTimeout(broadcastClockTimer);
		broadcastClockTimer = null;
	}
	if (broadcastClockProcess) {
		broadcastClockProcess._broadcastClockAbortReason = 'operator-shutdown';
		try { broadcastClockProcess.kill('SIGTERM'); } catch (_) {}
		broadcastClockProcess = null;
	}
	broadcastClockChecking = false;
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

		if (!program || !program.end || program._operatorHistoryPending || program._operatorManualRemovalPending) {
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
			!shutdownStarted &&
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
		.catch(async err => {

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

			clock = Date.now();
			if (!isCurrentAttempt() || isRecordedForReserve(program)) {
				recordingAttempt.clear(program, attempt);
				return;
			}
			// 再試行や予約の再読込をまたいでも、同じ次番組のために複数録画を短縮しない。
			// 終了・取消済みの印はHANDOFF検討時だけ整理する。
			for (const id of handoffEndLackUsed) {
				if (!reserves.some(item => item.id === id && item.end >= clock) &&
					!recording.some(item => item.id === id && item.end >= clock)) {
					handoffEndLackUsed.delete(id);
				}
			}
			if (isTunerShortageError(err) && !handoffEndLackUsed.has(program.id)) {
				let handoffInfo = getHandoffEndLackCandidateInfo(program);
				if (!handoffInfo.candidate && handoffInfo.needsTunerInfo) {
					const result = await getMirakurunJson('/tuners', 1000);
					clock = Date.now();
					if (!isCurrentAttempt() || isRecordedForReserve(program)) {
						recordingAttempt.clear(program, attempt);
						return;
					}
					if (!result.ok) {
						operatorLog('HANDOFF END LACK SKIP: tuner compatibility unknown: ' + result.error);
					}
					// 待機中に録画状態や残り秒数が変わるため、候補も選び直す。
					handoffInfo = getHandoffEndLackCandidateInfo(program, result.ok ? result.data : null);
				}
				if (handoffInfo.candidate) {
					if (finishRecordingForEndLack(handoffInfo.candidate, program)) {
						handoffEndLackUsed.add(program.id);
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
	stopAutoIfRecordingLimitExceeded();
	writeRecordingData();
}

// 録画実行
function doRecord(program, stream) {

	if (shutdownStarted || program._operatorNg || !isRecording(program) || clock > program.end) {
		operatorLog('DROP RECORD: ' + printProgram(program));
		safeAbortStream(stream, 'drop record');
		return;
	}
	// 保存先パスの算出自体はfilesystemへ触れない。shutdown後の再開時だけ、
	// 暫定recordedに保存した同一pathを使う。
	const isResumedRecording = typeof program._operatorResumeRecordedPath === 'string';
	const recPath = isResumedRecording ? program._operatorResumeRecordedPath : getRecordedPath(program);
	// stream取得後、録画ファイルを作成する直前にfilesystem identityを必ず再確認する。
	// 直前のprepareやStorage snapshotを録画許可の根拠にはしない。
	if (!ensureRecordingDestinationHealthy(program, false, { force: true, recordingEvent: 'recording-start' })) {
		operatorLog('DROP RECORD: unsafe recording destination: ' + printProgram(program));
		safeAbortStream(stream, 'unsafe recording destination');
		removeRecording(program.id, 'STORAGE HEALTH BLOCK');
		return;
	}

	lastRecordingTransitionAt = Date.now();
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

	if (isResumedRecording && !fs.existsSync(recPath)) {
		operatorLog('WARNING: RESUME RECORDING FILE NOT FOUND, recreate at same path: ' + recPath);
	}
	program.recorded = recPath;
	if (!isResumedRecording && config.recordingFilenamePrefixEnabled === true &&
		recPath !== getRecordedPath(program, false)) {
		program._operatorFilenamePrefixApplied = true;
	}
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
	let generateThumbnailAfterClose = false;
	let finalizeFilenameAfterClose = false;
	let historySave = Promise.resolve(false);
	const tsDropAnalyzer = tsDropDetectionEnabled ? new TsDropAnalyzer() : null;
	let tsDropLogTimer = null;
	let tsDropLoggedSampleCount = 0;
	let tsDropPreviousCcErrorsByPid = {};

	function getTsDropLogDetails(summary) {
		const ccErrorsByPid = summary.ccErrorsByPid || {};
		const ccErrorsByPidInterval = {};
		Object.keys(ccErrorsByPid).forEach(pid => {
			const count = Number(ccErrorsByPid[pid]) || 0;
			const previous = Number(tsDropPreviousCcErrorsByPid[pid]) || 0;
			if (count > previous) ccErrorsByPidInterval[pid] = count - previous;
		});
		tsDropPreviousCcErrorsByPid = { ...ccErrorsByPid };

		const samples = Array.isArray(summary.ccErrorSamples) ?
			summary.ccErrorSamples.slice(tsDropLoggedSampleCount) : [];
		tsDropLoggedSampleCount += samples.length;
		return { ccErrorsByPidInterval, samples };
	}

	function tsDropLogText(label, summary, details) {
		details = details || { ccErrorsByPidInterval: {}, samples: [] };
		return 'TS DROP: ' + label +
			' complete=' + (summary.completed === true) +
			' packet=' + summary.packetTotal +
			' cc-events=' + summary.ccErrorEvents +
			' cc-pids=' + JSON.stringify(summary.ccErrorsByPid) +
			' cc-pids-interval=' + JSON.stringify(details.ccErrorsByPidInterval) +
			(details.samples.length > 0 ? ' cc-samples=' + JSON.stringify(details.samples) : '') +
			' tei=' + summary.teiPackets +
			' scrambled=' + summary.scrambledPackets +
			' sync-events=' + summary.syncErrorEvents +
			' cpu-ms=' + summary.processingTimeMs.toFixed(1) +
			' cpu-ratio=' + (summary.processingRatio * 100).toFixed(2) + '%' +
			(summary.stopReason ? ' reason=' + summary.stopReason : '') +
			': ' + printProgram(program);
	}

	function stopTsDropObservation(reason) {
		if (!tsDropAnalyzer || tsDropAnalyzer.stopped) return;
		tsDropAnalyzer.stop(reason);
		stream.removeListener('data', onTsDropData);
		if (tsDropLogTimer !== null) {
			clearInterval(tsDropLogTimer);
			tsDropLogTimer = null;
		}
		const summary = tsDropAnalyzer.snapshot();
		operatorLog(tsDropLogText('stopped', summary, getTsDropLogDetails(summary)));
	}

	function onTsDropData(chunk) {
		try {
			tsDropAnalyzer.push(chunk);
		} catch (error) {
			stopTsDropObservation('parser-error: ' + (error && error.message || error));
		}
	}

	function logTsDropProgress() {
		if (!tsDropAnalyzer || tsDropAnalyzer.stopped) return;
		const summary = tsDropAnalyzer.snapshot();
		operatorLog(tsDropLogText('progress', summary, getTsDropLogDetails(summary)));
		// 単一chunkの所要時間はchunk sizeやGCに左右されるため停止根拠にしない。
		// 30秒以上の累積で解析が1 CPUの25%以上を占有した場合だけ観測を停止する。
		if (summary.wallTimeMs >= TS_DROP_LOG_INTERVAL_MS && summary.processingRatio > TS_DROP_OVERLOAD_RATIO) {
			stopTsDropObservation('processing-load-ratio-exceeded');
		}
	}

	function finalizeTsDropObservation() {
		if (!tsDropAnalyzer) return;
		stream.removeListener('data', onTsDropData);
		if (tsDropLogTimer !== null) {
			clearInterval(tsDropLogTimer);
			tsDropLogTimer = null;
		}
		const reason = program._operatorNg ? 'recording-ng' :
			program.operatorResumePending === true ? 'recording-interrupted-for-resume' :
			program._operatorEndLack ? 'recording-ended-early' :
			program._operatorAbort ? 'recording-aborted' : 'input-stream-not-ended';
		const summary = tsDropAnalyzer.finish({ complete: inputEnded, reason });
		summary.coverage = isResumedRecording ? 'resumed-segment' : inputEnded ? 'recording' : 'partial-recording';
		program.tsDrop = summary;
		operatorLog(tsDropLogText('final', summary, getTsDropLogDetails(summary)));
		if (dropDetectionMode === 'both' && program.mirakurunDrop) {
			operatorLog('DROP COMPARE: mirakurun=' + Number(program.mirakurunDrop.dropTotal || 0) +
				' ts-cc-events=' + summary.ccErrorEvents + ' (different metrics): ' + printProgram(program));
		}
	}

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
		if (finalizeFilenameAfterClose) {
			finalizeRecordingFilename(program);
			for (let i = 0, l = recorded.length; i < l; i++) {
				if (recorded[i].id === program.id) {
					if (recorded[i].recorded === program.recorded || recorded[i].recorded === recPath) {
						recorded.splice(i, 1);
					} else {
						recorded[i].id = getUniqueRecordedCollisionId(recorded[i], recorded);
					}
					break;
				}
			}
			recorded.push(program);
			historySave = saveCompletedRecording(program, false, recPath);
		}
		const finalPath = program.recorded;
		historySave.then(saved => {
			if (saved && probeDurationAfterClose && !shutdownStarted) {
				probeRecordedDuration(finalPath, (duration, requestedAt) => {
					if (duration !== null) {
						persistRecordedDuration(program.id, finalPath, duration, requestedAt);
						updateBitrateStatsAfterClose(program, finalPath, duration);
					}
					if (generateThumbnailAfterClose && !shutdownStarted) {
						recordedThumbnailGenerator.enqueue({
							id: program.id,
							inputPath: finalPath,
							requestedAt: requestedAt,
							durationSeconds: duration !== null ? duration : program.operatorActualSeconds
						});
					}
				});
			}
		});
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
	if (tsDropAnalyzer) {
		// 録画pipeを先に接続し、同じchunkを読み取り専用で観測する。
		// Transformを録画経路へ挟まないため、recFile側のbackpressure経路は維持される。
		stream.on('data', onTsDropData);
		tsDropLogTimer = setInterval(logTsDropProgress, TS_DROP_LOG_INTERVAL_MS);
		if (typeof tsDropLogTimer.unref === 'function') tsDropLogTimer.unref();
	}

	// 状態更新
	writeRecordingData();

	// お片付け
	function finalize() {

		if (finalized) {
			return;
		}
		finalized = true;
		lastRecordingTransitionAt = Date.now();

		stream.removeListener('end', onInputEnd);
		stream.removeListener('aborted', onInputAborted);

		applyMirakurunDropSnapshot(program);
		finalizeTsDropObservation();

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
			program.operatorAbort !== true &&
			program.operatorEndLack !== true;
		const finalName = !isNgRecording && !isResumePending ? completedRecordedPath(program) : null;
		if (finalName && !fs.existsSync(finalName)) {
			program._operatorHistoryPending = true;
			program._operatorFilenameFinalTarget = finalName;
			try {
				writeRecordingData();
				finalizeFilenameAfterClose = true;
			} catch (error) {
				delete program._operatorFilenameFinalTarget;
				operatorLog('WARNING: recording rename deferred (snapshot failed): ' + error.message);
			}
		} else if (finalName) {
			operatorLog('WARNING: recording rename target exists: ' + finalName);
		}
		probeDurationAfterClose = !isNgRecording && !isResumePending;
		// 録画開始後に確定した短縮録画も recorded.json の録画結果として扱う。
		// ファイルが残る限り、通常終了と同じ保存済みサムネイル生成経路を利用する。
		generateThumbnailAfterClose = probeDurationAfterClose;
		if (!finalizeFilenameAfterClose) {
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
				historySave = saveCompletedRecording(program, false);
			} else {
				operatorLog(program._operatorNg + ': ' + printProgram(program));
				if (!isResumedRecording && program.isManualReserved) discardRecordingAfterManualRemoval(program);
				else finishPendingRecording(program);
			}
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
	if (program._operatorHistoryPending || program._operatorManualRemovalPending) {
		operatorLog('WARNING: finalization already pending: #' + program.id);
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
	if (abortReason === 'ABORT RECORDING' && program.isManualReserved) discardRecordingAfterManualRemoval(program);
	else removeRecording(program.id, abortReason);
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

function getCleanupRoots(group) {
	const roots = new Set(group && group.destinations || []);
	if (!group || !group.filesystemId || process.platform !== 'linux') return Array.from(roots);
	const mountInfo = storageHealth.readMountInfo(fs);
	if (!mountInfo.available) return Array.from(roots);
	storageHealth.getDestinations(config).forEach(destination => {
		const mount = storageHealth.findMount(mountInfo.mounts, destination.path);
		if (mount && mount.filesystemId === group.filesystemId) {
			roots.add(destination.configuredPath || destination.path);
		}
	});
	return Array.from(roots);
}

function cleanupScanOptions(group, limit) {
	return {
		fs: fs,
		// /proc/self/mountinfo identifies every configured root on this filesystem
		// without stat'ing unrelated recording HDDs. Unknown roots are not probed.
		roots: getCleanupRoots(group),
		filesystemKey: group && group.filesystemKey,
		protectedPaths: getRecordingPathSet(),
		limit: limit,
		onError: function (operation, targetPath, error) {
			operatorLog('WARNING: Storage cleanup ' + operation + ' failed: ' + targetPath + ' (' + error.message + ')');
		}
	};
}

function findRecordedCleanupCandidates(group, limit) {
	return storageLow.findCleanupCandidates(cleanupScanOptions(group, limit));
}

// 実ファイル削除後、recorded.json 側に同一パスの記録が残っていれば整合更新する
// 削除対象の選定には recorded 台帳を使わない
async function markMatchRecordingDeleted(recordedEntries, filePath, deletedAt) {
	const changed = await reservationStore.withLockAsync(MATCH_DATA_FILE, () => {
		const items = reservationStore.readArray(MATCH_DATA_FILE);
		if (!storageLow.markMatchRecordingDeleted(items, recordedEntries, filePath, deletedAt, 'storage-low')) return false;
		reservationStore.writeArrayAtomic(MATCH_DATA_FILE, items);
		return true;
	}, { timeoutMs: 5 * 60 * 1000 + 2000 });
	if (changed) operatorLog('WRITE: ' + MATCH_DATA_FILE);
	return changed;
}

function removeRecordedLedgerEntriesByPath(filePath, deletedAt) {
	const resolvedFilePath = path.resolve(filePath);
	let removed = [];
	return queueRecordedLedgerUpdate('recorded cleanup', current => {
		removed = current.filter(entry => entry && entry.recorded && path.resolve(entry.recorded) === resolvedFilePath);
		if (!removed.length) return null;
		return current.filter(entry => !removed.includes(entry));
	}, async () => {
		const matchUpdated = await markMatchRecordingDeleted(removed, filePath, deletedAt);
		if (!matchUpdated) {
			operatorLog('ERROR: Storage cleanup partial completion: fileDeleted=true recordedUpdated=true matchUpdated=false path=' + filePath + ' (do not retry file deletion)');
		} else {
			removed.forEach(entry => {
				const id = entry && (entry.id || entry.recordedId || entry.origId || entry.programId);
				if (!id) return;
				try { recordedThumbnailGenerator.discard(String(id)); } catch (error) {
					operatorLog('WARNING: Storage cleanup thumbnail removal failed: ' + id + ' (' + error.message + ')');
				}
			});
		}
		scheduleMatchLedgerUpdate('recorded cleanup', deletedAt);
	});
}

// Low対象filesystemに属する録画先配下から、検証済みの最古候補を1件削除する。
function removeOldestRecordedFileOnFilesystem(group, candidate) {
	const target = storageLow.validateCleanupCandidate(candidate, cleanupScanOptions(group));
	let fileDeleted = false;

	if (!target) {
		operatorLog('WARNING: Storage cleanup target failed the final safety check.');
		return false;
	}

	try {
		fs.unlinkSync(target.path);
		fileDeleted = true;
		operatorLog('REMOVE: Storage cleanup -> ' + target.path + ' (' + target.size + ' bytes)');
		removeRecordedLedgerEntriesByPath(target.path, Date.now()).catch(error => {
			operatorLog('ERROR: Storage cleanup ledger reconciliation failed after file deletion: ' + target.path +
				' (' + error.message + '; do not retry file deletion)');
		});
		return true;
	} catch (e) {
		if (fileDeleted) {
			operatorLog('ERROR: Storage cleanup partial completion: fileDeleted=true recordedUpdated=false matchUpdated=false path=' + target.path + ' (' + e.message + '; do not retry file deletion)');
		} else {
			operatorLog('WARNING: Storage cleanup remove failed: ' + target.path + ' (' + e.message + ')');
		}
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
const storageLoggedPhases = new Map();

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
		rootProtectionEnabled: destination.rootProtectionEnabled === true,
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
	if (observed.safetyBlocked === true) return observed;
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
			expectedMount: destination.expectedMount,
			rootProtectionEnabled: destination.rootProtectionEnabled === true
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

function logStorageGroup(group, recordingEvent) {
	const previous = storageLoggedPhases.get(group.filesystemKey);
	const phase = group.phase || null;
	storageLoggedPhases.set(group.filesystemKey, phase);
	if (previous === phase && !recordingEvent) return;
	const freeMB = group.availableBytes / 1024 / 1024;
	const context = ' filesystem=' + group.filesystemKey + (recordingEvent ? ' event=' + recordingEvent : '');
	if (phase === 'cleanup') {
		operatorLog(`ALERT: Storage Low Space! (${freeMB} MB < ${storageLowSpaceThresholdMB} MB)` + context);
	} else if (phase === 'warning') {
		operatorLog(`WARNING: Storage Low Space! (${freeMB} MB < ${storageLowSpaceWarningThresholdMB} MB)` + context);
	} else if (previous) {
		operatorLog(`INFO: Storage Capacity Recovered! (${freeMB} MB)` + context);
	}
}

function handleStorageGroup(group, recordingEvent) {
	if (!group || !group.filesystemKey) return;
	logStorageGroup(group, recordingEvent);
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
	notifyStorageGroup(group);
	if (group.phase !== 'cleanup') {
		const previous = storageCleanupState[group.filesystemKey];
		if (previous && previous.mountFingerprint === group.mountFingerprint) {
			delete storageCleanupState[group.filesystemKey];
		}
		persistStorageRuntimeState();
		return;
	}

	let cleanupFailed = false;
	if (storageLowSpaceAction === 'remove') {
		const previous = storageCleanupState[group.filesystemKey];
		if (!previous || previous.handledCapacityCheckedAt !== group.capacityCheckedAt) {
			const candidates = findRecordedCleanupCandidates(group, 5);
			storageCleanupState[group.filesystemKey] = {
				mountFingerprint: group.mountFingerprint,
				cleanupCandidateSource: true,
				cleanupCandidates: candidates.map(candidate => ({ name: candidate.name, size: candidate.size, mtimeMs: candidate.mtimeMs })),
				cleanupCandidatesCheckedAt: Date.now(),
				handledCapacityCheckedAt: group.capacityCheckedAt,
				awaitingCapacityRefresh: false,
				cleanupFallbackStopAll: false
			};
			if (candidates.length > 0 && removeOldestRecordedFileOnFilesystem(group, candidates[0])) {
				storageCleanupState[group.filesystemKey].awaitingCapacityRefresh = true;
				storageCleanupState[group.filesystemKey].cleanupCandidates = findRecordedCleanupCandidates(group, 5).map(candidate => ({
					name: candidate.name, size: candidate.size, mtimeMs: candidate.mtimeMs
				}));
			} else {
				operatorLog('WARNING: Storage cleanup cannot safely free space; stopping recordings on the low filesystem.');
				storageCleanupState[group.filesystemKey].cleanupFallbackStopAll = true;
				cleanupFailed = true;
			}
		}
	}

	group.stopNewRecordings = true;
	if (storageLow.shouldStopCurrentRecordings(storageLowSpaceAction, cleanupFailed)) {
		stopRecordingsOnFilesystem(group.filesystemKey);
	}
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
		const cleanupState = storageCleanupState[filesystemKey];
		const group = storageMonitor.check(destination, {
			now: Date.now(),
			refreshAfterMs: cleanupState && cleanupState.awaitingCapacityRefresh === true ? 1000 : undefined
		});
		if (group && group.capacityCheckedAt) handleStorageGroup(group);
		else persistStorageRuntimeState();
	});
}

function checkStorageAfterRecordingClose(program) {
	if (!program || !program._storageFilesystemKey) return;
	const destination = storageHealth.findDestination(config, program);
	if (!destination) return;
	const group = storageMonitor.check(destination, { now: Date.now(), refreshAfterMs: 1000 });
	if (group && group.capacityCheckedAt) handleStorageGroup(group, 'recording-end');
	else persistStorageRuntimeState();
}

function storageStateFromGroup(group, destination) {
	return Object.assign({}, group, {
		id: destination.id || null,
		name: destination.name,
		path: destination.path,
		configuredPath: destination.configuredPath || destination.path,
		expectedMount: destination.expectedMount || null,
		rootProtectionEnabled: destination.rootProtectionEnabled === true,
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

function recordedThumbnailRequestError(code, statusCode, publicMessage) {
	const error = new Error(publicMessage);
	error.code = code;
	error.statusCode = statusCode;
	error.publicMessage = publicMessage;
	return error;
}

function getRecordedThumbnailDuration(entry) {
	const measured = Number(entry && entry.recordedDurationSeconds);
	if (Number.isFinite(measured) && measured > 0) return measured;
	const actual = Number(entry && entry.operatorActualSeconds);
	if (Number.isFinite(actual) && actual > 0) return actual;
	return null;
}

// Read-only snapshot. All queue data are already in Operator memory; do not stat TS files.
function postProcessingMonitorStatus() {
	const auto = recordedMaintenance.request({ action: 'auto-status' });
	const manual = recordedMaintenance.monitorState();
	const thumbnail = recordedThumbnailGenerator.getState();
	const thumbnailPending = recordedThumbnailGenerator.getPendingJobs();
	const matchPending = Boolean(matchLedgerUpdateReason);
	const queued = [];
	if (matchPending) queued.push({ type: 'match', title: matchLedgerUpdateReason,
		queuedAt: matchLedgerPendingAt });
	for (const job of durationProbeQueue) {
		const row = recordedForPath(job.filePath);
		queued.push({ type: 'ffprobe', title: row?.title || path.basename(job.filePath),
			id: row?.id ?? null, queuedAt: job.queuedAt });
	}
	for (const job of thumbnailPending) queued.push({ type: 'thumbnail',
		title: recordedTitleForId(job.id), id: job.id, queuedAt: job.requestedAt || job.queuedAt });
	for (const job of manual.pendingJobs) queued.push({ ...job, title: recordedTitleForId(job.id) });
	queued.sort((a, b) => (Number(a.queuedAt) || 0) - (Number(b.queuedAt) || 0));
	const counts = { match: matchPending ? 1 : 0,
		ffprobe: durationProbeQueue.length + manual.pendingCounts.ffprobe,
		thumbnail: thumbnail.pending + manual.pendingCounts.thumbnail,
		ts: manual.pendingCounts.ts };
	const running = [];
	if (matchLedgerProcess) running.push({ type: 'match', title: 'match更新' });
	for (const job of activeDurationProbeJobs.values()) {
		const row = recordedForPath(job.filePath);
		running.push({ type: 'ffprobe', title: row?.title || path.basename(job.filePath),
			id: row?.id ?? null, startedAt: job.startedAt });
	}
	if (thumbnail.active) running.push({ type: 'thumbnail', id: thumbnail.active,
		title: recordedTitleForId(thumbnail.active) });
	if (manual.active?.type === 'ts') running.push({ type: 'ts', id: manual.active.id,
		title: recordedTitleForId(manual.active.id), startedAt: manual.active.startedAt });
	if (auto.current) running.push({ type: 'ts', id: auto.current.id,
		title: auto.current.title || recordedTitleForId(auto.current.id) });
	const recentTs = [];
	for (const entry of recorded) {
		const analysis = entry?.savedTsAnalysis;
		const result = analysis?.result;
		const checkedAt = Number(analysis?.checkedAt);
		if (!result || !['NO_FINDINGS', 'SUSPECT', 'ERROR'].includes(result.status) ||
			!Number.isFinite(checkedAt) || checkedAt <= 0) continue;
		recentTs.push({ id: String(entry.id), title: entry.title || entry.fullTitle || String(entry.id),
			checkedAt, status: result.status, ccErrorEvents: Number(result.ccErrorEvents) || 0,
			pcrGapEvents: Number(result.pcrGapEvents) || 0, error: String(result.error || '') });
		recentTs.sort((a, b) => b.checkedAt - a.checkedAt);
		if (recentTs.length > 5) recentTs.pop();
	}
	const currentTs = auto.current ? { ...auto.current, mode: 'auto' } :
		manual.active?.type === 'ts' ? { ...manual.active, title: recordedTitleForId(manual.active.id), mode: 'manual' } : null;
	if (currentTs) {
		const row = recorded.find(entry => entry && String(entry.id) === String(currentTs.id));
		currentTs.recordedPath = row?.recorded || '';
	}
	// Use the already loaded ledger for HOVER; do not access TS files.
	const ids = new Set([...queued.slice(0, 5), ...running, ...recentPostProcessing, ...recentTs, currentTs]
		.filter(item => item?.id !== null && item?.id !== undefined)
		.map(item => String(item.id)));
	const programs = {};
	for (const entry of recorded) {
		if (!entry || !ids.has(String(entry.id))) continue;
		const channel = entry.channel || {};
		programs[String(entry.id)] = {
			title: entry.title, fullTitle: entry.fullTitle, start: entry.start, end: entry.end,
			description: entry.description, detail: entry.detail, category: entry.category,
			channel: { id: channel.id, name: channel.name, type: channel.type, hasLogoData: channel.hasLogoData }
		};
	}
	return {
		monitorVersion: 1, updatedAt: Date.now(),
		queues: [
			{ type: 'match', active: Boolean(matchLedgerProcess), pending: counts.match },
			{ type: 'ffprobe', active: activeDurationProbes.size > 0 || manual.active?.type === 'ffprobe', pending: counts.ffprobe },
			{ type: 'thumbnail', active: Boolean(thumbnail.active) || manual.active?.type === 'thumbnail', pending: counts.thumbnail },
			{ type: 'ts', active: Boolean(auto.current) || manual.active?.type === 'ts', pending: counts.ts,
				remaining: auto.counts?.remaining || 0 }
		],
		running,
		queuedTotal: counts.match + counts.ffprobe + counts.thumbnail + counts.ts,
		waiting: queued.slice(0, 5),
		completed: recentPostProcessing.slice(),
		recentTs,
		programs,
		auto,
		currentTs
	};
}

function handleRecordedThumbnailRequest(request) {
	if (request && request.organizerIndex === true) return updateRecordedSeriesIndex(request);
	if (request && request.maintenance === true && request.maintenanceAction === 'monitor-status') return postProcessingMonitorStatus();
	if (request && request.maintenance === true) return recordedMaintenance.request(Object.assign({}, request, { action: request.maintenanceAction }));
	const id = request && String(request.id || '');
	const outputPath = recordedThumbnail.resolveOutputPath(RECORDED_THUMBNAIL_DIR, id);
	if (!outputPath) {
		throw recordedThumbnailRequestError('invalid_recorded_id', 400, '録画IDが不正です。');
	}
	if (request && request.action === 'status') {
		return recordedThumbnailGenerator.getStatus(id);
	}
	if (request && request.action === 'delete') {
		return recordedThumbnailGenerator.discard(id);
	}
	if (request && request.action === 'cancel') {
		return recordedThumbnailGenerator.cancel(id);
	}
	const fileResolver = require('./lib/match-detail-resolver');
	const matchItems = reservationStore.readArray(MATCH_DATA_FILE);
	const match = matchItems.filter(item => (fileResolver.normalizeMatchEntry(item).recording || fileResolver.normalizeMatchEntry(item).fileMissing || {}).recordedId === id);
	if (match.some(fileResolver.isExplicitDeletion)) throw recordedThumbnailRequestError('recorded_deleted', 410, '削除済みの録画は生成できません。');
	if (match.some(item => fileResolver.normalizeMatchEntry(item).fileMissing)) throw recordedThumbnailRequestError('recorded_file_missing', 410, '行方不明の録画です。状態確認から明示的に捜索してください。');
	if (fs.existsSync(outputPath)) {
		return recordedThumbnailGenerator.getStatus(id);
	}

	let entries;
	try {
		entries = reservationStore.readArray(RECORDED_DATA_FILE);
	} catch (error) {
		throw recordedThumbnailRequestError('recorded_data_unavailable', 503, '録画管理データを読み取れません。');
	}
	const entry = entries.find(item => item && String(item.id) === id);
	if (!entry) {
		throw recordedThumbnailRequestError('recorded_not_found', 404, '録画管理データが見つかりません。');
	}
	if (entry.operatorResumePending === true) {
		throw recordedThumbnailRequestError('recording_incomplete', 409, '再開待ちの録画からはサムネイルを生成できません。');
	}
	if (typeof entry.recorded !== 'string' || entry.recorded.trim() === '' || !fs.existsSync(entry.recorded)) {
		recordedThumbnailGenerator.markSourceMissing(id);
		throw recordedThumbnailRequestError('recorded_file_missing', 410, '録画ファイルが見つかりません。');
	}

	const result = recordedThumbnailGenerator.enqueue({
		id: id,
		inputPath: entry.recorded,
		durationSeconds: getRecordedThumbnailDuration(entry)
	});
	if (result.reason === 'queue-full') {
		throw recordedThumbnailRequestError('thumbnail_queue_full', 429, 'サムネイル生成が混雑しています。時間をおいて再試行してください。');
	}
	if (result.reason === 'stopped') {
		throw recordedThumbnailRequestError('operator_stopping', 503, 'Operator停止中のため生成を開始できません。');
	}
	if (result.reason === 'invalid') {
		throw recordedThumbnailRequestError('invalid_recorded_data', 500, '録画管理データの保存先が不正です。');
	}

	return recordedThumbnailGenerator.getStatus(id);
}

function startRecordedThumbnailServer() {
	recordedThumbnailServer = storageRefreshIpc.createServer({
		socketPath: RECORDED_THUMBNAIL_SOCKET,
		handler: handleRecordedThumbnailRequest,
		log: operatorLog,
		label: 'Recorded thumbnail IPC'
	});
	recordedThumbnailServer.listen().then(() => {
		operatorLog('Recorded thumbnail IPC listening.');
	}).catch(error => {
		operatorLog('WARNING: Recorded thumbnail IPC startup failed: ' + error.message);
		recordedThumbnailServer = null;
	});
}

startRecordedThumbnailServer();

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
		wakePostProcessing();
		recordedThumbnailGenerator.resume();

		if (recording.length > 0) {
			reserves.forEach(recordingUpdater);

			writeRecordingData();
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

		if (pendingRecordedLedgerWrites === 0) recorded = data;
		operatorLog(mes);
		if (autoTsAnalysisEnabled) wakePostProcessing();
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

recoverRecordingHistory();
reserveCheckLoop();
startBroadcastClockMonitor();
scheduleAutoTsReview();
if (autoTsAnalysisEnabled) wakePostProcessing();
