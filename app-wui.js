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
const SCHEDULE_DATA_FILE = __dirname + '/data/schedule.json';
const RECORDING_DATA_FILE = __dirname + '/data/recording.json';
const RECORDED_DATA_FILE = __dirname + '/data/recorded.json';
const SCHEDULER_LOG_FILE = __dirname + '/log/scheduler';

// Load Config
const pkg = require("./package.json");
const config = require(CONFIG_FILE);

// Modules
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
const mirakurunConnection = require('./lib/mirakurun-connection');

// Directory Checking
if (!fs.existsSync('./data/') || !fs.existsSync('./log/') || !fs.existsSync('./web/')) {
	console.error('FATAL: Current working directory is invalid.');
	process.exit(1);
}

const apps = require("./processes.json").apps;

const WUI_LOG_FILE = !!process.env.pm_id ? apps[0].out_file : (__dirname + '/log/wui');
const OPERATOR_LOG_FILE = !!process.env.pm_id ? apps[1].out_file : (__dirname + '/log/operator');
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

// Mirakurun Client
const mirakurunPath = mirakurunConnection.configureClient(mirakurun, config);

mirakurun.userAgent = `Chinachu/${pkg.version} (wui)`;
mirakurun.priority = 0;

console.info(mirakurun);

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

var rules     = [];
var schedule  = [];
var reserves  = [];
var recording = [];
var recorded  = [];

// Init HTTP Server
let openServer;
let socketServer;
let shutdownStarted = false;

function shutdownWui(signal) {
	if (shutdownStarted) {
		return;
	}
	shutdownStarted = true;
	util.log('SHUTDOWN: ' + signal);

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

// Open Server for Access from LAN.
if (openServerEnabled) {
	let selection = null;
	try {
		selection = openHost.resolveOpenServerHost(config.wuiOpenHost);
	} catch (error) {
		console.error('ERROR: ' + error.message);
	}

	if (selection) {
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
	if (location.match(/\/$/) !== null) { location += 'index.html'; }

	// HTTPメソッド指定を上書き
	if (query.method) {
		req.method = query.method.toUpperCase();
		delete query.method;
	}

	if (query._method) {
		req.method = query._method.toUpperCase();
		delete query._method;
	}

	var filename = path.join('./web/', location);

	var ext = null;
	if (filename.match(/[^\/]+\..+$/) !== null) {
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

	var responseStatic = function () {

		if (fs.existsSync(filename) === false) { return resErr(404); }

		if (req.method !== 'HEAD' && req.method !== 'GET') {
			res.setHeader('Allow', 'HEAD, GET');
			return resErr(405);
		}

		if (['ico', 'png'].indexOf(ext) !== -1) {
			res.setHeader('Cache-Control', 'private, max-age=86400');
		}

		var fstat = fs.statSync(filename);

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
			fs.createReadStream(filename, range || {}).pipe(res);
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
				mirakurun    : mirakurun,
				config       : config,
				define: {
					CONFIG_FILE        : CONFIG_FILE,
					RULES_FILE         : RULES_FILE,
					RESERVES_DATA_FILE : RESERVES_DATA_FILE,
					SCHEDULE_DATA_FILE : SCHEDULE_DATA_FILE,
					RECORDING_DATA_FILE: RECORDING_DATA_FILE,
					RECORDED_DATA_FILE : RECORDED_DATA_FILE,
					OPERATOR_LOG_FILE  : OPERATOR_LOG_FILE,
					WUI_LOG_FILE       : WUI_LOG_FILE,
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
	if (req.url.match(/^\/api\/.*$/) === null) {
		if (/^web\//.test(filename) === false) { return resErr(400); }
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
		transports: [ 'polling', 'websocket' ]
	});

	io.on('connection', ioServer);

	// listen event
	iosAddEventListner(io, 'status');
	iosAddEventListner(io, 'notify-rules');
	iosAddEventListner(io, 'notify-reserves');
	iosAddEventListner(io, 'notify-recording');
	iosAddEventListner(io, 'notify-recorded');
	iosAddEventListner(io, 'notify-schedule');

	return io;
}

function ioServer(socket) {
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

		rules = data;
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

		reserves = data;
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

		recorded = data;
		ios.emit('notify-recorded');
		util.log(mes);
	},
	{ create: [], now: true }
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
processChecker();
