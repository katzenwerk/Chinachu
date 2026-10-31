/*!
 *  Chinachu WebUI Server Service (chinachu-wui)
 *
 *  Copyright (c) 2016 Yuki KAN and Chinachu Project Contributors
 *  https://chinachu.moe/
**/
'use strict';

process.env.PATH = `${__dirname}/usr/bin:${process.env.PATH}`;

const CONFIG_FILE = __dirname + '/config.json';
const RULES_FILE = __dirname + '/rules.json';
const RESERVES_DATA_FILE = __dirname + '/data/reserves.json';
const RESERVES2_DATA_FILE = __dirname + '/data/reserves2.json';
const SCHEDULE_DATA_FILE = __dirname + '/data/schedule.json';
const RECORDING_DATA_FILE = __dirname + '/data/recording.json';
const RECORDED_DATA_FILE = __dirname + '/data/recorded.json';
const MATCH_DATA_FILE = __dirname + '/data/match.json';
const SERIES_DICTIONARY_FILE = __dirname + '/data/dictionary.sqlite3';
const SERIES_CHANNEL_CATALOG_FILE = __dirname + '/data/syobocal-channel-catalog.json';
const SERIES_CHANNEL_MAP_FILE = __dirname + '/data/syobocal-channel-map-independent.json';
const SERIES_PROGLOOKUP_CACHE_FILE = __dirname + '/data/proglookup-cache-independent.json';
const SERIES_MANUAL_OVERRIDE_FILE = __dirname + '/data/series-overrides.json';
const WUI_CONFIG_FILE = __dirname + '/data/wui-config.json';
const STORAGE_STATE_FILE = __dirname + '/data/storage-state.json';
const BROADCAST_CLOCK_STATE_FILE = __dirname + '/data/broadcast-clock-state.json';
const RECORDED_THUMBNAIL_DIR = __dirname + '/data/thumbnails';
const SCHEDULER_STATE_FILE = __dirname + '/data/scheduler-state.json';
const SCHEDULER_LOG_FILE = __dirname + '/log/scheduler';

// Load Config
const pkg = require("./package.json");
const config = require(CONFIG_FILE);

// Modules
const path = require('path');
const fs = require('fs');
const util = require('util');

const NEXT_WEB_ROOT = path.resolve(__dirname, 'next-web');

function resolveStaticFilename(root, requestPath) {
	const relative = requestPath.replace(/^\/+/, '');
	const filename = path.resolve(root, relative);

	if (filename !== root && !filename.startsWith(root + path.sep)) {
		return null;
	}

	return filename;
}

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

// Node.js 24 では util.log が存在しないため、旧Chinachu互換のログ関数を補う
if (typeof util.log !== 'function') {
	util.log = function () {
		console.log(formatJstLogTime() + ' - ' + Array.prototype.join.call(arguments, ' '));
	};
}
const child_process = require('child_process');
const url = require('url');
const querystring = require('querystring');
const vm = require('vm');
const os = require('os');
const zlib = require('zlib');
const events = require('events');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const chinachu = require('chinachu-common');
const mirakurun = new (require("mirakurun").default)();
const openHost = require('./lib/wui-open-host');
const runtimePrivileges = require('./lib/runtime-privileges');
const runtimePathsModule = require('./lib/runtime-paths');
const mirakurunConnection = require('./lib/mirakurun-connection');
const ruleUid = require('./lib/rule-uid');
const ruleStore = require('./lib/rule-store');
const healthDiagnosticsModule = require('./lib/health-diagnostics');
const serviceControlModule = require('./lib/service-control');
const mediaDeliveryModule = require('./lib/media-delivery');
const storageHealth = require('./lib/storage-health');
const storageLow = require('./lib/storage-low');
const storageRuntimeState = require('./lib/storage-runtime-state');
const storageRefreshIpc = require('./lib/storage-refresh-ipc');
const recordedThumbnail = require('./lib/recorded-thumbnail');
const matchDetailResolver = require('./lib/match-detail-resolver');
const seriesServiceModule = require('./lib/series-background-service');
const dictionaryManagerModule = require('./lib/syobocal-dictionary-manager');
const syobocalChannelCatalogModule = require('./lib/syobocal-channel-catalog');
const syobocalChannelMapManagerModule = require('./lib/syobocal-channel-map-manager');
const progLookupStoreModule = require('./lib/proglookup-store');
const progLookupUpdaterModule = require('./lib/proglookup-updater');
const matchDeletionHistory = require('./lib/match-deletion-history');
const reservationStore = require('./lib/reservation-store');
const logHistory = require('./lib/log-history');
const ledgerCleaner = require('./lib/ledger-cleaner');
const ledgerCleanerJobsModule = require('./lib/ledger-cleaner-jobs');
const wuiConfigStore = require('./lib/wui-config');
const wuiAuthModule = require('./lib/wui-auth');
const wuiRuntime = Object.freeze({
	instanceId: Date.now().toString(36) + '-' + process.pid.toString(36) + '-' + Math.random().toString(36).slice(2, 10),
	startedAt: Date.now()
});

// Directory Checking
if (!fs.existsSync('./data/') ||
	!fs.existsSync('./log/') ||
	!fs.existsSync(path.join(NEXT_WEB_ROOT, 'index.html')) ||
	!fs.existsSync(path.join(NEXT_WEB_ROOT, 'app.js'))) {
	console.error('FATAL: Current working directory is invalid.');
	process.exit(1);
}

const apps = require("./processes.json").apps;

const WUI_LOG_FILE = !!process.env.pm_id ? apps[0].out_file : (__dirname + '/log/wui');
const OPERATOR_LOG_FILE = !!process.env.pm_id ? apps[1].out_file : (__dirname + '/log/operator');
const WUI_ERROR_LOG_FILE = path.resolve(__dirname, apps[0].error_file);
const OPERATOR_ERROR_LOG_FILE = path.resolve(__dirname, apps[1].error_file);
const OPERATOR_PID_FILE = (() => {
	if (process.env.pm_id) {
		try {
			const jlist = JSON.parse(child_process.execSync("pm2 jlist"));
			const proc = jlist.find(_proc => _proc.name === "chinachu-operator");

			if (proc && proc.pm2_env && proc.pm2_env.pm_pid_path) {
				return proc.pm2_env.pm_pid_path;
			}

			util.log("WARNING: PM2 process `chinachu-operator` was not found. operator status will be shown as stopped.");
		} catch (e) {
			util.log("WARNING: failed to inspect PM2 process list: " + e.message);
		}
	}

	return "/var/run/chinachu-operator.pid";
})();

// Uncaught Exception
process.on('uncaughtException', err => {

	if (err.toString() === 'Error: read ECONNRESET') {
		util.log('ECONNRESET');
		return;
	}

	console.error('uncaughtException: ' + err);
});

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
const wuiAuth = wuiAuthModule.createAuthManager({ rootDir: __dirname, log: util.log });
const seriesUseSyobocal = config.seriesUseSyobocal !== false;
const seriesBackgroundStop = new AbortController();
let seriesTimingReady = 0;
function seriesBackgroundDelay() {
	// Initial jsonWatcher reads are asynchronous; do not interpret their
	// not-yet-loaded arrays as proof that no handoff is approaching.
	if (seriesTimingReady !== 3) return 30000;
	const now = Date.now();
	let until = now;
	const upcoming = (reserves || []).filter(program => program && !program.isSkip && !program.isConflict);
	for (const program of upcoming.concat(recording || [])) {
		if (!program) continue;
		for (const time of [Number(program.start), Number(program.end)]) {
			if (Number.isFinite(time) && time - 15000 <= now && time + 15000 > until) until = time + 15000;
		}
	}
	return until - now;
}
async function waitForSeriesBackground(signal) {
	const combined = signal ? AbortSignal.any([signal, seriesBackgroundStop.signal]) : seriesBackgroundStop.signal;
	// At most one complete 30s handoff window per work unit. Back-to-back
	// transitions must not indefinitely starve dictionary/cache progress.
	const deadline = Date.now() + 30000;
	for (;;) {
		combined.throwIfAborted();
		const delay = Math.min(seriesBackgroundDelay(), deadline - Date.now());
		if (delay <= 0) return;
		await require('node:timers/promises').setTimeout(delay, undefined, { signal: combined });
	}
}
const officialRequests = seriesUseSyobocal ? syobocalChannelCatalogModule.createOfficialRequestQueue({
	statePath: __dirname + '/data/syobocal-request-cooldown.json'
}) : null;
let dictionaryManager;
const progLookupStore = progLookupStoreModule.createProgLookupStore({ path: SERIES_PROGLOOKUP_CACHE_FILE });
const seriesService = seriesServiceModule.createSeriesService({
	enabled: seriesUseSyobocal,
	dictionaryPath: SERIES_DICTIONARY_FILE,
	getDictionaryStatus: () => dictionaryManager && dictionaryManager.getStatus(),
	channelMapPath: SERIES_CHANNEL_MAP_FILE,
	progLookupPath: SERIES_PROGLOOKUP_CACHE_FILE,
	onPublished: generation => ios.emit('notify-series', { generation }),
	onStatus: () => ios.emit('notify-series-status'),
	log: util.log,
	progLookupStore,
	manualPath: SERIES_MANUAL_OVERRIDE_FILE,
	thumbnailDir: RECORDED_THUMBNAIL_DIR,
	ledgerPaths: {
		reserves: RESERVES_DATA_FILE,
		reserves2: RESERVES2_DATA_FILE,
		recorded: RECORDED_DATA_FILE,
		match: MATCH_DATA_FILE
	}
});
const syobocalChannelMapManager = syobocalChannelMapManagerModule.createSyobocalChannelMapManager({
	request: officialRequests && officialRequests.request,
	catalogPath: SERIES_CHANNEL_CATALOG_FILE,
	channelMapPath: SERIES_CHANNEL_MAP_FILE,
	dictionaryPath: SERIES_DICTIONARY_FILE,
	progLookupPath: SERIES_PROGLOOKUP_CACHE_FILE,
	schedulePath: SCHEDULE_DATA_FILE,
	waitForBackground: waitForSeriesBackground,
	progLookupStore,
	getAvailableChannels: () => schedule,
	userAgent: `Chinachu-thorn/${pkg.version} (Syobocal channel catalog; WUI)`,
	log: util.log
});
const progLookupUpdater = progLookupUpdaterModule.createProgLookupUpdater({
	worker: true,
	cachePath: SERIES_PROGLOOKUP_CACHE_FILE,
	waitForBackground: waitForSeriesBackground,
	request: officialRequests && officialRequests.request,
	store: progLookupStore,
	channelMapPath: SERIES_CHANNEL_MAP_FILE,
	getAvailableChannels: () => schedule,
	getBackfillRequests: () => seriesService.getBackfillRequests({ background: true }),
	onUpdateApplied: async update => {
		await syobocalChannelMapManager.rebuild({ refreshCatalog: update.kind === 'full' });
		seriesService.invalidate({ retain: true });
		ios.emit('notify-series-status');
	},
	userAgent: `Chinachu-thorn/${pkg.version} (ProgLookup; WUI)`,
	log: util.log
});
dictionaryManager = dictionaryManagerModule.createDictionaryManager({
	getBackgroundDelay: seriesBackgroundDelay,
	path: SERIES_DICTIONARY_FILE,
	enabled: seriesUseSyobocal,
	request: officialRequests && officialRequests.request,
	userAgent: `Chinachu-thorn/${pkg.version} (TitleLookup dictionary; WUI)`,
	getNextRequestAt: () => officialRequests ? officialRequests.getNextAt() : 0,
	log: util.log,
	onStatus: () => ios.emit('notify-series-status'),
	onPublished: () => dictionaryManagerModule.applyDictionaryToSeries({
		background: true, waitForBackground: waitForSeriesBackground,
		seriesService, channelMapManager: syobocalChannelMapManager, progLookupUpdater,
		notify: () => ios.emit('notify-series-status')
	})
});
const initialAuthStatus = wuiAuth.statusFor(null);
util.log('WUI Authentication: ' + (initialAuthStatus.locked ? 'locked' : (initialAuthStatus.enabled ? 'enabled' : 'disabled')));

// Mirakurun Client
const mirakurunPath = mirakurunConnection.configureClient(mirakurun, config);

mirakurun.userAgent = `Chinachu/${pkg.version} (wui)`;
mirakurun.priority = 0;

console.info(mirakurun);

const healthDiagnostics = healthDiagnosticsModule.createHealthDiagnostics({
	rootDir: __dirname,
	packageVersion: pkg.version,
	nodeVersion: process.version,
	paths: {
		config: CONFIG_FILE,
		rules: RULES_FILE,
		schedulerState: SCHEDULER_STATE_FILE,
		recording: RECORDING_DATA_FILE
	},
	validateRules: ruleUid.validateRuleUids,
	// Direct status request avoids loading the dynamic API document for every unavailable endpoint.
	fetchMirakurunStatus: signal => mirakurun.request('GET', '/status', { signal: signal }).then(result => result.body)
});
const serviceControl = serviceControlModule.createServiceControl({
	rootDir: __dirname,
	recordingPath: RECORDING_DATA_FILE,
	isShuttingDown: () => shutdownStarted,
	log: util.log
});
const ledgerCleanerJobs = ledgerCleanerJobsModule.createLedgerCleanerJobs({ rootDir: __dirname });
const mediaDelivery = mediaDeliveryModule.createMediaDelivery({
	mirakurun: mirakurun,
	log: util.log
});

// etc.
const timer = {};
const emptyFunction = function () {};
const status = {
	connectedCount: 0,
	feature: {
		previewer: true,
		streamer: true,
		filer: true,
		configurator: true,
		normalizationForm: config.normalizationForm
	},
	system: {
		core: os.cpus().length
	},
	operator: {
		alive: false,
		pid: null
	},
	wui: {
		alive: false,
		pid: null
	}
};

// Open Server
const openServerEnabled = config.wuiOpenServer === true;
const globalAccessBlockEnabled = openHost.isGlobalAccessBlockEnabled(config.wuiBlockGlobalAccess);
const OPEN_SERVER_HOST_RETRY_INTERVAL_MS = 1000;
const OPEN_SERVER_HOST_RETRY_TIMEOUT_MS = 60000;
util.log('WUI Global Access Block: ' + (globalAccessBlockEnabled ? 'enabled' : 'disabled'));

var rules     = [];
var schedule  = [];
var reserves  = [];
var recording = [];
var recorded  = [];

if (fs.existsSync(RULES_FILE)) {
	try {
		const result = ruleStore.ensureRuleFile(RULES_FILE);
		rules = result.rules;
		if (result.assigned > 0) {
			util.log('RULE UID BACKFILL: assigned=' + result.assigned + ' existing=' + result.existing);
		}
	} catch (error) {
		console.error('ERROR: rules.json could not be loaded or has invalid ruleUid values: ' + error.message);
	}
}

// MATCH CACHE BEGIN
// match.json は正本のまま維持し、parse 済み配列だけを WUI プロセスの RAM に保持する。
// API 要求時に stat を比較し、ファイルが変化した場合だけ再 read/parse する。
// 録画実ファイル(recordedDir配下)には一切触れない。
function createMatchCache(file) {
	var state = {
		hasValue: false,
		signature: null,
		items: []
	};

	function getSignature() {
		var stat;

		try {
			stat = fs.statSync(file);
		} catch (e) {
			if (e && e.code === 'ENOENT') {
				return null;
			}
			throw e;
		}

		return {
			dev: stat.dev,
			ino: stat.ino,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			ctimeMs: stat.ctimeMs
		};
	}

	function isSameSignature(a, b) {
		if (a === null || b === null) {
			return a === b;
		}

		return a.dev === b.dev &&
			a.ino === b.ino &&
			a.size === b.size &&
			a.mtimeMs === b.mtimeMs &&
			a.ctimeMs === b.ctimeMs;
	}

	function readStableItems(initialSignature) {
		var before = initialSignature;
		var after;
		var text;
		var items;
		var attempt;

		// direct write と atomic rename のどちらでも、読み取り中に更新された場合は1回だけ取り直す。
		for (attempt = 0; attempt < 2; attempt++) {
			text = fs.readFileSync(file, { encoding: 'utf8' }).replace(/^\uFEFF/, '');
			items = JSON.parse(text || '[]');

			if (!Array.isArray(items)) {
				throw new Error('match.json is not an array');
			}

			after = getSignature();
			if (after !== null && isSameSignature(before, after)) {
				return {
					signature: after,
					items: items
				};
			}

			if (after === null) {
				throw new Error('match.json disappeared while reading');
			}

			before = after;
		}

		throw new Error('match.json changed repeatedly while reading');
	}

	function getItems() {
		var signature;
		var loaded;
		var rssMB;

		try {
			signature = getSignature();
		} catch (e) {
			if (state.hasValue) {
				util.log('WARNING: MATCH CACHE stat failed; keeping previous cache: ' + e.message);
				return state.items;
			}
			throw e;
		}

		if (signature === null) {
			state.hasValue = true;
			state.signature = null;
			state.items = [];
			return state.items;
		}

		if (state.hasValue && isSameSignature(signature, state.signature)) {
			return state.items;
		}

		try {
			loaded = readStableItems(signature);
		} catch (e) {
			if (state.hasValue) {
				// 書き込み途中などで一時的に壊れて見えた場合は、直前の正常キャッシュを維持する。
				// signature は更新しないため、次回API要求で再度読み込みを試す。
				util.log('WARNING: MATCH CACHE reload failed; keeping previous cache: ' + e.message);
				return state.items;
			}
			throw e;
		}

		state.hasValue = true;
		state.signature = loaded.signature;
		state.items = loaded.items;
		rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
		util.log('MATCH CACHE: loaded items=' + state.items.length + ' size=' + state.signature.size + ' rss=' + rssMB + 'MB');

		return state.items;
	}

	return {
		getItems: getItems
	};
}

const matchCache = createMatchCache(MATCH_DATA_FILE);
// MATCH CACHE END

// Init HTTP Server
let openServer;
let socketServer;
let shutdownStarted = false;
let openServerStartRetryTimer = null;
let openServerHostRetryLogged = false;

function shutdownWui(signal) {
	if (shutdownStarted) {
		return;
	}
	shutdownStarted = true;
	seriesBackgroundStop.abort();
	util.log('SHUTDOWN: ' + signal);
	mediaDelivery.close();
	progLookupUpdater.stop();
	dictionaryManager.stop();
	syobocalChannelMapManager.stop();
	seriesService.close();

	if (openServerStartRetryTimer) {
		clearTimeout(openServerStartRetryTimer);
		openServerStartRetryTimer = null;
	}

	const timeout = setTimeout(() => {
		console.error('FATAL: WUI graceful shutdown timed out.');
		process.exit(1);
	}, 10000);

	const complete = () => {
		clearTimeout(timeout);
		process.exit(0);
	};

	if (socketServer) {
		socketServer.close(complete);
	} else if (openServer && openServer.listening) {
		openServer.close(complete);
	} else {
		complete();
	}
}

[ 'SIGINT', 'SIGTERM', 'SIGQUIT' ].forEach(signal => {
	process.on(signal, () => shutdownWui(signal));
});

function isOpenServerRequestAllowed(req) {
	return openHost.isRemoteAddressAllowed(
		req && req.socket ? req.socket.remoteAddress : null,
		config.wuiBlockGlobalAccess
	);
}

function rejectOpenServerHttpRequest(req, res) {
	res.writeHead(403, {
		'content-type': 'text/plain; charset=utf-8',
		'connection': 'close'
	});
	if (req.method !== 'HEAD') res.write('403 Forbidden\n');
	res.end();
}

function rejectOpenServerUpgrade(socket) {
	if (!socket || socket.destroyed) return;
	socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
}

// Socket.IOがHTTP/upgrade listenerを差し替えた後、その全受付経路の手前に共通判定を置く。
function guardOpenServerRequests(server) {
	const requestListeners = server.listeners('request').slice();
	const upgradeListeners = server.listeners('upgrade').slice();

	server.removeAllListeners('request');
	server.on('request', (req, res) => {
		if (!isOpenServerRequestAllowed(req)) {
			rejectOpenServerHttpRequest(req, res);
			return;
		}
		requestListeners.forEach(listener => listener.call(server, req, res));
	});

	server.removeAllListeners('upgrade');
	server.on('upgrade', (req, socket, head) => {
		if (!isOpenServerRequestAllowed(req)) {
			rejectOpenServerUpgrade(socket);
			return;
		}
		upgradeListeners.forEach(listener => listener.call(server, req, socket, head));
	});
}

// Open Server for Access from LAN.
function startOpenServer(startedAt) {
	let selection;

	try {
		selection = openHost.resolveOpenServerHost(config.wuiOpenHost);
	} catch (error) {
		const elapsedMs = Date.now() - startedAt;

		if (!config.wuiOpenHost && elapsedMs < OPEN_SERVER_HOST_RETRY_TIMEOUT_MS) {
			if (!openServerHostRetryLogged) {
				console.error(
					'WARNING: No private IPv4 address was detected. ' +
					'Waiting for network configuration before starting the WUI Open Server.'
				);
				openServerHostRetryLogged = true;
			}

			openServerStartRetryTimer = setTimeout(() => {
				openServerStartRetryTimer = null;
				startOpenServer(startedAt);
			}, OPEN_SERVER_HOST_RETRY_INTERVAL_MS);

			return;
		}

		console.error('FATAL: ' + error.message);
		process.exit(1);
		return;
	}

	if (openServerHostRetryLogged) {
		console.log('Private IPv4 address became available. Starting the WUI Open Server.');
	}

	if (selection.autoDetected) {
		console.log("============================================================");
		console.log("Detected Private IPv4:", selection.addresses);
		console.log("Selected Private IPv4 for Open Server:", selection.host);
		console.log("NOTE: set `wuiOpenHost` to fix address for listen.");
		console.log("============================================================");
	}

	openServer = http.createServer(httpServer);
	openServer.timeout = 0;

	const onOpenServerStartupError = error => {
		const code = error && error.code ? ' [' + error.code + ']' : '';
		console.error('FATAL: HTTP Open Server failed to listen' + code + ': ' + error.message);
		process.exit(1);
	};
	openServer.once('error', onOpenServerStartupError);

	openServer.listen(config.wuiOpenPort || 20772, selection.host, () => {
		openServer.removeListener('error', onOpenServerStartupError);
		socketServer = ioAddListener(openServer);
		util.log('HTTP Open Server Listening on ' + util.inspect(openServer.address()));
	});
}

if (openServerEnabled) {
	startOpenServer(Date.now());
}

// HTTP Server
function httpServer(req, res) {

	var q = '';

	switch (req.method) {
	case 'GET':
	case 'HEAD':

		q = new URL(req.url, 'http://localhost').searchParams.toString() || '';

		if (q.match(/^\{.*\}$/) === null) {
			q = querystring.parse(q);
		} else {
			try {
				q = JSON.parse(q);
			} catch (e) {
				q = {};
			}
		}

		httpServerMain(req, res, q);
		q = void 0;

		break;

	case 'POST':
	case 'PUT':
	case 'DELETE':

		req.on('data', function (chunk) {
			q += chunk.toString();
		});

		req.once('end', function () {
			if (q.trim().match(/^\{(\n|.)*\}$/) === null) {
				q = querystring.parse(q);
			} else {
				try {
					q = JSON.parse(q.trim());
				} catch (e) {
					q = {};
				}
			}

			httpServerMain(req, res, q);
			q = void 0;
		});

		break;

	default:

		res.writeHead(400, {'content-type': 'text/plain'});
		res.end('400 Bad Request\n');
		util.log('400');
	}
}

function httpServerMain(req, res, query) {
	var remoteAddress = req.client.remoteAddress;
	var transportMethod = req.method;

	if (/^\:\:ffff\:[^\:]+/.test(remoteAddress) === true) {
		remoteAddress = remoteAddress.split(':')[3];
	}

	// http request logging
	var log = function (statusCode) {
		util.log([
			statusCode,
			req.method + ':' + req.url,
			remoteAddress,
			'"' + (req.headers['user-agent'] || '-') + '"'
		].join(' '));
	};

	// serve static file
	var location = req.url;
	if (location.match(/(\?.*)$/) !== null) { location = location.match(/^(.+)\?.*$/)[1]; }
	var isApiRequest = location.match(/^\/api\/.*$/) !== null;
	var staticRoot = NEXT_WEB_ROOT;
	var staticLocation = location;
	if (!isApiRequest) {
		try {
			staticLocation = decodeURIComponent(staticLocation);
		} catch (e) {
			staticLocation = null;
		}

		if (staticLocation === null || staticLocation.indexOf('\0') !== -1) {
			res.writeHead(400, {'content-type': 'text/plain'});
			res.end('400 Bad Request\n');
			log(400);
			return;
		}

		if (staticLocation.indexOf('/next/') === 0) {
			staticRoot = NEXT_WEB_ROOT;
			staticLocation = staticLocation.slice('/next'.length);
		}
		if (staticLocation.match(/\/$/) !== null) { staticLocation += 'index.html'; }
	}

	// HTTPメソッド指定を上書き
	if (['method', '_method'].some(function (key) {
		return Object.prototype.hasOwnProperty.call(query, key) && typeof query[key] !== 'string';
	})) {
		res.writeHead(400, {'content-type': 'text/plain'});
		if (req.method !== 'HEAD') res.write('400 Bad Request\n');
		res.end();
		log(400);
		return;
	}

	if (query.method) {
		req.method = query.method.toUpperCase();
		delete query.method;
	}

	if (query._method) {
		req.method = query._method.toUpperCase();
		delete query._method;
	}

	var filename = resolveStaticFilename(staticRoot, staticLocation);

	var ext = null;
	if (filename !== null && filename.match(/[^\/]+\..+$/) !== null) {
		ext = filename.split('.').pop();
	}

	// エラーレスポンス用
	var resErr = function (code) {

		if (res.headersSent === false) {
			res.writeHead(code, {'content-type': 'text/plain'});

			if (req.method !== 'HEAD') {
				switch (code) {
				case 400:
					res.write('400 Bad Request\n');
					break;
				case 402:
					res.write('402 Payment Required\n');
					break;
				case 401:
					res.write('401 Unauthorized\n');
					break;
				case 403:
					res.write('403 Forbidden\n');
					break;
				case 404:
					res.write('404 Not Found\n');
					break;
				case 405:
					res.write('405 Method Not Allowed\n');
					break;
				case 406:
					res.write('406 Not Acceptable\n');
					break;
				case 407:
					res.write('407 Proxy Authentication Required\n');
					break;
				case 408:
					res.write('408 Request Timeout\n');
					break;
				case 409:
					res.write('409 Conflict\n');
					break;
				case 410:
					res.write('410 Gone\n');
					break;
				case 411:
					res.write('411 Length Required\n');
					break;
				case 412:
					res.write('412 Precondition Failed\n');
					break;
				case 413:
					res.write('413 Request Entity Too Large\n');
					break;
				case 414:
					res.write('414 Request-URI Too Long\n');
					break;
				case 415:
					res.write('415 Unsupported Media Type\n');
					break;
				case 416:
					res.write('416 Requested Range Not Satisfiable\n');
					break;
				case 417:
					res.write('417 Expectation Failed\n');
					break;
				case 429:
					res.write('429 Too Many Requests\n');
					break;
				case 451:
					res.write('451 Unavailable For Legal Reasons\n');
					break;
				case 500:
					res.write('500 Internal Server Error\n');
					break;
				case 501:
					res.write('501 Not Implemented\n');
					break;
				case 502:
					res.write('502 Bad Gateway\n');
					break;
				case 503:
					res.write('503 Service Unavailable\n');
					break;
				}
			}
			log(code);
		} else {
			log(res.statusCode + '(!' + code + ')');
		}
		res.end();
	};

	var writeHead = function (code) {
		var type = 'text/plain';

		if (ext === 'html') { type = 'text/html'; }
		if (ext === 'js') { type = 'text/javascript'; }
		if (ext === 'css') { type = 'text/css'; }
		if (ext === 'ico') { type = 'image/vnd.microsoft.icon'; }
		if (ext === 'cur') { type = 'image/vnd.microsoft.icon'; }
		if (ext === 'png') { type = 'image/png'; }
		if (ext === 'gif') { type = 'image/gif'; }
		if (ext === 'jpg') { type = 'image/jpeg'; }
		if (ext === 'f4v') { type = 'video/mp4'; }
		if (ext === 'm4v') { type = 'video/mp4'; }
		if (ext === 'mp4') { type = 'video/mp4'; }
		if (ext === 'flv') { type = 'video/x-flv'; }
		if (ext === 'webm') { type = 'video/webm'; }
		if (ext === 'm2ts') { type = 'video/MP2T'; }
		if (ext === 'asf') { type = 'video/x-ms-asf'; }
		if (ext === 'json') { type = 'application/json; charset=utf-8'; }
		if (ext === 'xspf') { type = 'application/xspf+xml'; }
		if (ext === 'm3u8') { type = 'application/vnd.apple.mpegurl'; }
		if (ext === 'm4s') { type = 'video/iso.segment'; }
		if (ext === 'svg') { type = 'image/svg+xml'; }
		if (ext === 'woff2') { type = 'font/woff2'; }
		if (ext === 'ttf') { type = 'font/ttf'; }

		var head = {
			'Content-Type'             : type,
			'Server'                   : 'Chinachu (Node)',
			'Cache-Control'            : 'no-cache',
			'X-Content-Type-Options'   : 'nosniff',
			'X-Frame-Options'          : 'SAMEORIGIN',
			'X-UA-Compatible'          : 'IE=Edge,chrome=1',
			'X-XSS-Protection'         : '1; mode=block'
		};

		res.writeHead(code, head);
	};

	// ヘッダの確認
	if (!req.headers.host) { return resErr(400); }

	var responseAuthApi = function () {
		wuiAuth.handleHttp(req, location, query).then(function (result) {
			Object.keys(result.headers || {}).forEach(function (name) {
				res.setHeader(name, result.headers[name]);
			});
				writeHead(result.status);
				log(result.status);
				var afterSend = result.afterSend;
				var finishAuthResponse = function () {
					if (!afterSend) return;
					var callback = afterSend;
					afterSend = null;
					callback();
				};
				res.once('close', finishAuthResponse);
				if (req.method === 'HEAD') return res.end(finishAuthResponse);
				res.end(JSON.stringify(result.body), finishAuthResponse);
		}).catch(function (error) {
			console.error('AUTH API ERROR: ' + error.message);
			resErr(500);
		});
	};

	if (isApiRequest && wuiAuth.isAuthApiPath(location)) {
		if (transportMethod !== req.method) return resErr(405);
		return responseAuthApi();
	}

	if (isApiRequest) {
		var authResult = wuiAuth.authorizeApi(req);
		if (!authResult.ok) return resErr(authResult.status);
		wuiAuth.registerResponse(authResult.session, res);
	}

	var responseStatic = function () {

		if (fs.existsSync(filename) === false) { return resErr(404); }

		if (req.method !== 'HEAD' && req.method !== 'GET') {
			res.setHeader('Allow', 'HEAD, GET');
			return resErr(405);
		}

		if (['ico', 'png'].indexOf(ext) !== -1) {
			res.setHeader('Cache-Control', 'private, max-age=86400');
		}

		var fstat;
		try {
			fstat = fs.statSync(filename);
		} catch (error) {
			return resErr(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 500);
		}
		if (!fstat.isFile()) { return resErr(404); }

		res.setHeader('Accept-Ranges', 'bytes');
		res.setHeader('Last-Modified', new Date(fstat.mtime).toUTCString());

		if (req.headers['if-modified-since'] && req.headers['if-modified-since'] === new Date(fstat.mtime).toUTCString()) {
			writeHead(304);
			log(304);
			return res.end();
		}

		var range = {};
		if (req.headers.range) {
			var bytes = req.headers.range.replace(/bytes=/, '').split('-');
			range.start = parseInt(bytes[0], 10);
			range.end   = parseInt(bytes[1], 10) || fstat.size - 1;

			if (range.start > fstat.size || range.end > fstat.size) {
				return resErr(416);
			}

			res.setHeader('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + fstat.size);
			res.setHeader('Content-Length', range.end - range.start + 1);

			writeHead(206);
			log(206);
		} else {
			res.setHeader('Content-Length', fstat.size);

			writeHead(200);
			log(200);
		}

		if (req.method === 'GET') {
			var stream;
			var onReadError = function () {
				if (res.destroyed || res.writableEnded) { return; }
				if (res.headersSent) {
					res.destroy();
				} else {
					res.removeHeader('Content-Length');
					res.removeHeader('Content-Range');
					resErr(500);
				}
			};
			try {
				stream = fs.createReadStream(filename, range || {});
				stream.on('error', onReadError);
				stream.pipe(res);
			} catch (error) {
				if (stream) { stream.destroy(); }
				onReadError();
			}
		} else {
			res.end();
		}
	};

	var responseApi = function () {
		var dir  = location.replace('/api/', '').replace(/\.[a-z0-9]+$/, '');
		var dirs = dir.split('/');
		var addr = dir.replace(/^[^\/]+\/?/, '/');

		if (dirs[0] === 'index.html') { return resErr(400); }

		var resourceFile = './api/resource-' + dirs[0] + '.json';

		if (fs.existsSync(resourceFile) === false) { return resErr(404); }

		fs.readFile(resourceFile, function (err, json) {
			if (err) { return resErr(500); }

			var r;
			try {
				r = JSON.parse(json);
			} catch (e) {
				console.error(e);
				return resErr(500);
			}

			var pattern;
			var param;
			var target = null;

			var k, i, l;
			for (k in r) {
				if (r.hasOwnProperty(k)) {
					pattern = new RegExp(k.replace(/:[^\/]+/g, '([^/]+)'));

					if (addr.match(pattern) !== null) {
						target = r[k];
						param  = {};

						if (k.match(pattern).length > 1) {
							for (i = 1, l = k.match(pattern).length; i < l; i++) {
								param[k.match(pattern)[i].replace(':', '')] = addr.match(pattern)[i];
							}
						}
					}
				}
			}

			if (target === null) { return resErr(400); }
			if (target.methods.indexOf(req.method.toLowerCase()) === -1) {
				res.setHeader('Allow', target.methods.join(', ').toUpperCase());
				return resErr(405);
			}
			if (target.types.indexOf(ext) === -1) { return resErr(415); }

			var scriptFile = './api/script-' + target.script + '.vm.js';

			if (fs.existsSync(scriptFile) === false) { return resErr(501); }

			res._end = res.end;
			res.end  = function () {
				res.end = res._end;
				res.end.apply(res, arguments);
				res.emit('end');
			};

			var acceptEncoding = req.headers['accept-encoding'];
			if (!acceptEncoding) { acceptEncoding = ''; }
			var encoding = '';

			if (acceptEncoding.match(/deflate/)) {
				encoding = 'deflate';
			}

			if (req.headers['user-agent'] && req.headers['user-agent'].match(/Trident/)) {
				encoding = '';
			}

			var sandbox = {
				request      : req,
				response     : res,
				path         : path,
				fs           : fs,
				url          : url,
				util         : util,
				child_process: child_process,
				Buffer       : Buffer,
				zlib         : zlib,
				chinachu     : chinachu,
				ruleUid      : ruleUid,
				ruleStore    : ruleStore,
				mirakurun    : mirakurun,
				config       : config,
				matchCache   : matchCache,
				healthDiagnostics: healthDiagnostics,
				serviceControl: serviceControl,
				wuiRuntime   : wuiRuntime,
				mediaDelivery: mediaDelivery,
				storageHealth: storageHealth,
				storageLow   : storageLow,
				storageRuntimeState: storageRuntimeState,
				storageRefreshIpc: storageRefreshIpc,
				recordedThumbnail: recordedThumbnail,
					matchDetailResolver: matchDetailResolver,
					seriesService: seriesService,
					matchDeletionHistory: matchDeletionHistory,
					reservationStore: reservationStore,
				logHistory    : logHistory,
				ledgerCleaner : ledgerCleaner,
					ledgerCleanerJobs: ledgerCleanerJobs,
					wuiConfigStore: wuiConfigStore,
				define: {
					REPOSITORY_ROOT   : __dirname,
					NODE_EXECUTABLE    : process.execPath,
					LOG_DIR            : path.resolve(__dirname, 'log'),
					CONFIG_FILE        : CONFIG_FILE,
					RULES_FILE         : RULES_FILE,
					RESERVES_DATA_FILE : RESERVES_DATA_FILE,
					RESERVES2_DATA_FILE: RESERVES2_DATA_FILE,
					SCHEDULE_DATA_FILE : SCHEDULE_DATA_FILE,
					RECORDING_DATA_FILE: RECORDING_DATA_FILE,
					RECORDED_DATA_FILE : RECORDED_DATA_FILE,
						MATCH_DATA_FILE    : MATCH_DATA_FILE,
						WUI_CONFIG_FILE    : WUI_CONFIG_FILE,
						STORAGE_STATE_FILE : STORAGE_STATE_FILE,
						BROADCAST_CLOCK_STATE_FILE: BROADCAST_CLOCK_STATE_FILE,
					STORAGE_REFRESH_SOCKET: STORAGE_REFRESH_SOCKET,
					RECORDED_THUMBNAIL_DIR: RECORDED_THUMBNAIL_DIR,
					RECORDED_THUMBNAIL_SOCKET: RECORDED_THUMBNAIL_SOCKET,
					OPERATOR_LOG_FILE  : OPERATOR_LOG_FILE,
					OPERATOR_ERROR_LOG_FILE: OPERATOR_ERROR_LOG_FILE,
					WUI_LOG_FILE       : WUI_LOG_FILE,
					WUI_ERROR_LOG_FILE : WUI_ERROR_LOG_FILE,
					SCHEDULER_LOG_FILE : SCHEDULER_LOG_FILE,
					OPERATOR_PID_FILE  : OPERATOR_PID_FILE
				},
				data: {
					rules    : rules,
					schedule : schedule,
					reserves : reserves,
					recording: recording,
					recorded : recorded,
					status   : status
				},
				setInterval: setInterval,
				setTimeout : setTimeout,
				clearInterval: clearInterval,
				clearTimeout : clearTimeout,

				children: []
			};

			var isClosed = false;
			var cleanup;

			sandbox.request.query    = query;
			sandbox.request.param    = param;
			sandbox.request.type     = ext;
			sandbox.request.encoding = encoding;
			sandbox.response.head    = writeHead;
			sandbox.response.error   = function (code) {

				isClosed = true;

				resErr(code);

				cleanup();
			};

			// DEPRECATED
			sandbox.response.exit = function (data, encoding) {

				util.log('response.exit is DEPRECATED: ' + scriptFile);

				try {
					res.end(data, encoding);
				} catch (e) {
					util.log(e);
				}
			};

			var onResponseClose = function () {

				if (!isClosed) {
					isClosed = true;

					log(res.statusCode);
				}

				cleanup();
			};

			cleanup = function () {

				setTimeout(function () {

					sandbox.children.forEach(function (pid) {

						util.log('child process killing: PID=' + pid);

						try {
							process.kill(pid, 'SIGKILL');
						} catch (e) {
						}
					});

					sandbox = null;
				}, 1000);

				res.removeListener('close', onResponseClose);
				res.removeListener('finish', onResponseClose);

				cleanup = emptyFunction;
			};

			res.on('close', onResponseClose);
			res.on('finish', onResponseClose);

			try {
				vm.runInNewContext(fs.readFileSync(scriptFile), sandbox, scriptFile);
			} catch (ee) {
				if (!isClosed) {
					resErr(500);
					isClosed = true;
				}

				console.error(ee);
			}

			return;
		});

		return;
	};

	// 静的ファイルまたはAPIレスポンスの分岐
	if (!isApiRequest) {
		if (staticLocation === '/next') {
			res.setHeader('Location', '/next/');
			writeHead(302);
			log(302);
			return res.end();
		}
		if (filename === null) { return resErr(403); }
		if (fs.existsSync(filename) === false) { return resErr(404); }

		responseStatic();
	} else {
		responseApi();
	}
}

//
// socket.io server
//

var ios = new events.EventEmitter();
ios.setMaxListeners(0);

function iosAddEventListner(io, eventName) {
	return ios.on(eventName, function () {
		var i, l, args = [];
		for (i = 0, l = arguments.length; i < l; i++) {
			args.push(arguments[i]);
		}
		io.emit.apply(io, [eventName].concat(args));
	});
}

function ioAddListener(server) {
	// Preserve the pre-P1-E transport model: polling first, then WebSocket upgrade.
	// WebTransport and the legacy Engine.IO 3 compatibility mode are not enabled.
	var io = new SocketIOServer(server, {
		transports: [ 'polling', 'websocket' ],
		allowRequest: function (req, callback) {
			callback(null, isOpenServerRequestAllowed(req) && wuiAuth.authorizeSocket(req));
		}
	});
	guardOpenServerRequests(server);

	io.on('connection', ioServer);

	// listen event
	iosAddEventListner(io, 'status');
	iosAddEventListner(io, 'notify-rules');
	iosAddEventListner(io, 'notify-reserves');
	iosAddEventListner(io, 'notify-recording');
	iosAddEventListner(io, 'notify-recorded');
	iosAddEventListner(io, 'notify-match');
	iosAddEventListner(io, 'notify-schedule');
	iosAddEventListner(io, 'notify-series');
	iosAddEventListner(io, 'notify-series-status');

	return io;
}

function ioServer(socket) {
	wuiAuth.registerSocket(socket);
	ioServerMain(socket);
}

function ioServerMain(socket) {
	++status.connectedCount;

	socket.on('disconnect', ioServerSocketOnDisconnect);

	// broadcast
	ios.emit('status', status);

	socket.emit('notify-rules');
	socket.emit('notify-reserves');
	socket.emit('notify-recording');
	socket.emit('notify-recorded');
	socket.emit('notify-schedule');
}

function ioServerSocketOnDisconnect(socket) {
	--status.connectedCount;
	ios.emit('status', status);
}

// ファイル更新監視: ./data/rules.json
chinachu.jsonWatcher(
	RULES_FILE,
	function _onUpdated(err, data, mes) {
		if (err) {
			console.error(err);
			return;
		}

		try {
			const result = ruleStore.ensureRuleFile(RULES_FILE);
			if (result.assigned > 0) {
				util.log('RULE UID BACKFILL: assigned=' + result.assigned + ' existing=' + result.existing);
			}
			rules = result.rules;
		} catch (error) {
			console.error('ERROR: rules.json update rejected: ' + error.message);
			return;
		}
		ios.emit('notify-rules');
		util.log(mes);
	},
	{ create: [], now: true }
);

// ファイル更新監視: ./data/schedule.json
chinachu.jsonWatcher(
	SCHEDULE_DATA_FILE,
	function _onUpdated(err, data, mes) {
		if (err) {
			console.error(err);
			return;
		}

		schedule = data;
		if (seriesUseSyobocal) {
			syobocalChannelMapManager.rebuild({ refreshCatalog: true }).then(result => {
				if (result && result.created) progLookupUpdater.requestTick();
			});
		}
		ios.emit('notify-schedule');
		util.log(mes);
	},
	{ create: [], now: true }
);

// ファイル更新監視: ./data/reserves.json
chinachu.jsonWatcher(
	RESERVES_DATA_FILE,
	function _onUpdated(err, data, mes) {
		if (err) {
			console.error(err);
			return;
		}

		seriesService.invalidate({ retain: true });
		reserves = data;
		seriesTimingReady |= 1;
		ios.emit('notify-reserves');
		util.log(mes);
	},
	{ create: [], now: true }
);

// ファイル更新監視: ./data/recording.json
chinachu.jsonWatcher(
	RECORDING_DATA_FILE,
	function _onUpdated(err, data, mes) {
		if (err) {
			console.error(err);
			return;
		}

		recording = data;
		seriesTimingReady |= 2;
		ios.emit('notify-recording');
		util.log(mes);
	},
	{ create: [], now: true }
);

// ファイル更新監視: ./data/recorded.json
chinachu.jsonWatcher(
	RECORDED_DATA_FILE,
	function _onUpdated(err, data, mes) {
		if (err) {
			console.error(err);
			return;
		}

		seriesService.invalidate({ retain: true });
		recorded = data;
		ios.emit('notify-recorded');
		util.log(mes);
	},
	{ create: [], now: true }
);

// ファイル更新監視: ./data/match.json
// recorded.json の通知より後に確定する録画結果一覧を、書き込み完了後に更新する。
chinachu.jsonWatcher(
	MATCH_DATA_FILE,
	function _onUpdated(err, data, mes) {
		if (err) {
			console.error(err);
			return;
		}

		seriesService.invalidate({ retain: true });
		ios.emit('notify-match');
		util.log(mes);
	},
	{ create: [], now: false }
);

// プロセス監視
function processChecker() {

	ios.emit('status', status);

	var c = chinachu.createCountdown(1, chinachu.createTimeout(processChecker, 5000));

	if (fs.existsSync(OPERATOR_PID_FILE) === true) {
		fs.readFile(OPERATOR_PID_FILE, function (err, pid) {

			if (err) { return c.tick(); }

			pid = pid.toString().trim();

			child_process.exec('ps h -p ' + pid + ' -o %cpu,rss', function (err, stdout) {

				if (stdout === '') {
					status.operator.alive = false;
					status.operator.pid   = null;
				} else {
					status.operator.alive = true;
					status.operator.pid   = parseInt(pid, 10);
				}

				c.tick();
			});
		});
	} else {
		status.operator.alive = false;
		status.operator.pid   = null;

		c.tick();
	}
}
if (seriesUseSyobocal) {
	progLookupUpdater.start();
	dictionaryManager.start();
}
processChecker();
