'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const repositoryRoot = path.resolve(__dirname, '..');

function reservePort(host) {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, host, () => {
			const port = server.address().port;
			server.close(error => error ? reject(error) : resolve(port));
		});
	});
}

function request(port, requestPath, headers) {
	return new Promise((resolve, reject) => {
		const req = http.request({
			host: '127.0.0.1',
			port: port,
			path: requestPath,
			headers: headers || {}
		}, response => {
			const chunks = [];
			response.on('data', chunk => chunks.push(chunk));
			response.once('end', () => resolve({
				statusCode: response.statusCode,
				body: Buffer.concat(chunks)
			}));
		});
		req.once('error', reject);
		req.end();
	});
}

function waitForOutput(child, output, pattern) {
	return new Promise((resolve, reject) => {
		if (pattern.test(output.value)) {
			resolve();
			return;
		}

		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error('Timed out waiting for WUI startup. Output:\n' + output.value));
		}, 8000);

		function onData() {
			if (pattern.test(output.value)) {
				cleanup();
				resolve();
			}
		}

		function onExit(code, signal) {
			cleanup();
			reject(new Error('WUI exited before startup: code=' + code + ' signal=' + signal + '\n' + output.value));
		}

		function cleanup() {
			clearTimeout(timeout);
			child.stdout.removeListener('data', onData);
			child.stderr.removeListener('data', onData);
			child.removeListener('exit', onExit);
		}

		child.stdout.on('data', onData);
		child.stderr.on('data', onData);
		child.once('exit', onExit);
	});
}

function waitForExit(child) {
	return new Promise(resolve => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolve();
			return;
		}
		child.once('exit', resolve);
		child.kill('SIGTERM');
	});
}

function waitForSignalExit(child, signal, timeoutMs) {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const timeout = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error('WUI did not exit after ' + signal));
		}, timeoutMs);

		child.once('exit', (code, exitSignal) => {
			clearTimeout(timeout);
			resolve({
				code: code,
				signal: exitSignal,
				elapsedMs: Date.now() - startedAt
			});
		});
		child.kill(signal);
	});
}

function waitForNaturalExit(child, timeoutMs) {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const timeout = setTimeout(() => {
			child.removeListener('close', onExit);
			reject(new Error('WUI did not exit after startup failure'));
		}, timeoutMs);

		function onExit(code, signal) {
			clearTimeout(timeout);
			resolve({
				code: code,
				signal: signal,
				elapsedMs: Date.now() - startedAt
			});
		}

		child.once('close', onExit);
	});
}

async function startWuiProcess(temporaryDir) {
	const output = { value: '' };
	const child = childProcess.spawn(process.execPath, [ 'app-wui.js' ], {
		cwd: temporaryDir,
		stdio: [ 'ignore', 'pipe', 'pipe' ]
	});
	child.stdout.on('data', chunk => { output.value += chunk.toString(); });
	child.stderr.on('data', chunk => { output.value += chunk.toString(); });
	await waitForOutput(child, output, /HTTP Open Server Listening/);
	return { child, output };
}

function waitForSocketEvent(socket, eventName, timeoutMs) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error('Timed out waiting for Socket.IO event: ' + eventName));
		}, timeoutMs || 5000);

		function onEvent() {
			const args = Array.from(arguments);
			cleanup();
			resolve(args);
		}

		function cleanup() {
			clearTimeout(timeout);
			socket.removeListener(eventName, onEvent);
		}

		socket.once(eventName, onEvent);
	});
}

function waitForCondition(predicate, message, timeoutMs) {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const interval = setInterval(() => {
			if (predicate()) {
				clearInterval(interval);
				resolve();
				return;
			}
			if (Date.now() - startedAt >= (timeoutMs || 5000)) {
				clearInterval(interval);
				reject(new Error(message));
			}
		}, 20);
	});
}

describe('WUI access model', function() {
	it('keeps only the Open Server configuration and dependencies', function() {
		const config = require('../config.sample.json');
		const pkg = require('../package.json');
		const source = fs.readFileSync(path.join(repositoryRoot, 'app-wui.js'), 'utf8');
		const browserSource = fs.readFileSync(path.join(repositoryRoot, 'web/chinachu.js'), 'utf8');
		const removedKeys = [
			'wuiPort',
			'wuiHost',
			'wuiUsers',
			'wuiTlsKeyPath',
			'wuiTlsCertPath',
			'wuiTlsPassphrase',
			'wuiTlsRequestCert',
			'wuiTlsRejectUnauthorized',
			'wuiTlsCaPath',
			'wuiAllowCountries',
			'wuiXFF',
			'wuiMdnsAdvertisement'
		];

		assert.strictEqual(config.wuiOpenServer, true);
		assert.ok(Object.hasOwn(config, 'wuiOpenHost'));
		assert.strictEqual(config.wuiOpenPort, 20772);
		removedKeys.forEach(key => assert.ok(!Object.hasOwn(config, key)));
		assert.strictEqual(pkg.dependencies['http-auth'], undefined);
		assert.strictEqual(pkg.dependencies['geoip-lite'], undefined);
		assert.strictEqual(pkg.dependencies['mdns-js'], undefined);
		assert.strictEqual(pkg.dependencies['socket.io'], '^4.8.3');
		assert.strictEqual(pkg.devDependencies['socket.io-client'], '^4.8.3');
		assert.strictEqual(require('engine.io').protocol, 4);
		assert.strictEqual(require('engine.io-client').protocol, 4);
		removedKeys.forEach(key => assert.doesNotMatch(source, new RegExp('config\\.' + key + '\\b')));
		assert.doesNotMatch(source, /require\(['"]http-auth['"]\)/);
		assert.doesNotMatch(source, /require\(['"]geoip-lite['"]\)/);
		assert.doesNotMatch(source, /require\(['"]mdns-js['"]\)/);
		assert.doesNotMatch(source, /createAdvertisement/);
		assert.doesNotMatch(source, /openServerMdns/);
		assert.strictEqual(source.match(/http\.createServer\(httpServer\)/g).length, 1);
		assert.match(source, /new SocketIOServer\(server/);
		assert.doesNotMatch(source, /allowEIO3\s*:\s*true/);
		assert.doesNotMatch(browserSource, /connectTimeout/);
		assert.match(browserSource, /transports:\s*\[\s*'polling',\s*'websocket'\s*\]/);
	});

	it('waits for network availability before starting an auto-detected Open Server', { timeout: 10000 }, async function() {
		const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-wui-network-wait-'));
		const dataDir = path.join(temporaryDir, 'data');
		const logDir = path.join(temporaryDir, 'log');
		const libDir = path.join(temporaryDir, 'lib');
		const openPort = await reservePort('127.0.0.1');
		const output = { value: '' };
		let child = null;

		try {
			fs.mkdirSync(dataDir);
			fs.mkdirSync(logDir);
			fs.mkdirSync(libDir);

			fs.symlinkSync(path.join(repositoryRoot, 'api'), path.join(temporaryDir, 'api'), 'dir');
			fs.symlinkSync(path.join(repositoryRoot, 'node_modules'), path.join(temporaryDir, 'node_modules'), 'dir');
			fs.symlinkSync(path.join(repositoryRoot, 'web'), path.join(temporaryDir, 'web'), 'dir');

			fs.symlinkSync(
				path.join(repositoryRoot, 'lib/runtime-privileges.js'),
				path.join(libDir, 'runtime-privileges.js')
			);
			fs.symlinkSync(
				path.join(repositoryRoot, 'lib/mirakurun-connection.js'),
				path.join(libDir, 'mirakurun-connection.js')
			);

			fs.writeFileSync(
				path.join(libDir, 'wui-open-host.js'),
				[
					"'use strict';",
					'let attempts = 0;',
					'module.exports.resolveOpenServerHost = function() {',
					'\tattempts += 1;',
					'\tif (attempts === 1) {',
					'\t\tthrow new Error("No private IPv4 address was detected. Configure `wuiOpenHost` explicitly; the WUI Open Server was not started.");',
					'\t}',
					"\treturn { host: '127.0.0.1', autoDetected: false, addresses: [] };",
					'};'
				].join('\n') + '\n'
			);

			fs.copyFileSync(path.join(repositoryRoot, 'app-wui.js'), path.join(temporaryDir, 'app-wui.js'));
			fs.copyFileSync(path.join(repositoryRoot, 'package.json'), path.join(temporaryDir, 'package.json'));
			fs.copyFileSync(path.join(repositoryRoot, 'processes.json'), path.join(temporaryDir, 'processes.json'));

			fs.writeFileSync(path.join(temporaryDir, 'rules.json'), '[]');
			[ 'rules', 'reserves', 'schedule', 'recording', 'recorded', 'match' ].forEach(name => {
				fs.writeFileSync(path.join(dataDir, name + '.json'), '[]');
			});

			fs.writeFileSync(path.join(temporaryDir, 'config.json'), JSON.stringify({
				mirakurunPath: 'http://127.0.0.1:9/',
				wuiOpenServer: true,
				wuiOpenHost: null,
				wuiOpenPort: openPort
			}));

			child = childProcess.spawn(process.execPath, [ 'app-wui.js' ], {
				cwd: temporaryDir,
				stdio: [ 'ignore', 'pipe', 'pipe' ]
			});

			child.stdout.on('data', chunk => { output.value += chunk.toString(); });
			child.stderr.on('data', chunk => { output.value += chunk.toString(); });

			await waitForOutput(child, output, /HTTP Open Server Listening/);

			assert.match(
				output.value,
				/WARNING: No private IPv4 address was detected/
			);
			assert.match(
				output.value,
				/Private IPv4 address became available\. Starting the WUI Open Server\./
			);
			assert.match(
				output.value,
				/HTTP Open Server Listening/
			);
		} finally {
			if (child && child.exitCode === null && child.signalCode === null) {
				await waitForExit(child);
			}
			fs.rmSync(temporaryDir, { recursive: true, force: true });
		}
	});

	it('exits non-zero when the Open Server port is already in use', { timeout: 10000 }, async function() {
		const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-wui-eaddrinuse-'));
		const dataDir = path.join(temporaryDir, 'data');
		const logDir = path.join(temporaryDir, 'log');
		const occupiedServer = net.createServer();
		let child = null;
		let output = '';

		try {
			await new Promise((resolve, reject) => {
				occupiedServer.once('error', reject);
				occupiedServer.listen(0, '127.0.0.1', resolve);
			});
			const occupiedPort = occupiedServer.address().port;

			fs.mkdirSync(dataDir);
			fs.mkdirSync(logDir);
			fs.symlinkSync(path.join(repositoryRoot, 'api'), path.join(temporaryDir, 'api'), 'dir');
			fs.symlinkSync(path.join(repositoryRoot, 'lib'), path.join(temporaryDir, 'lib'), 'dir');
			fs.symlinkSync(path.join(repositoryRoot, 'node_modules'), path.join(temporaryDir, 'node_modules'), 'dir');
			fs.symlinkSync(path.join(repositoryRoot, 'web'), path.join(temporaryDir, 'web'), 'dir');
			fs.copyFileSync(path.join(repositoryRoot, 'app-wui.js'), path.join(temporaryDir, 'app-wui.js'));
			fs.copyFileSync(path.join(repositoryRoot, 'package.json'), path.join(temporaryDir, 'package.json'));
			fs.copyFileSync(path.join(repositoryRoot, 'processes.json'), path.join(temporaryDir, 'processes.json'));
			fs.writeFileSync(path.join(temporaryDir, 'rules.json'), '[]');
			[ 'rules', 'reserves', 'schedule', 'recording', 'recorded', 'match' ].forEach(name => {
				fs.writeFileSync(path.join(dataDir, name + '.json'), '[]');
			});
			fs.writeFileSync(path.join(temporaryDir, 'config.json'), JSON.stringify({
				mirakurunPath: 'http://127.0.0.1:9/',
				wuiOpenServer: true,
				wuiOpenHost: '127.0.0.1',
				wuiOpenPort: occupiedPort
			}));

			child = childProcess.spawn(process.execPath, [ 'app-wui.js' ], {
				cwd: temporaryDir,
				stdio: [ 'ignore', 'pipe', 'pipe' ]
			});
			child.stdout.on('data', chunk => { output += chunk.toString(); });
			child.stderr.on('data', chunk => { output += chunk.toString(); });

			const exit = await waitForNaturalExit(child, 5000);
			assert.notStrictEqual(exit.code, null);
			assert.notStrictEqual(exit.code, 0);
			assert.strictEqual(exit.signal, null);
			assert.ok(exit.elapsedMs < 5000);
			assert.match(output, /EADDRINUSE/);
			assert.match(output, /FATAL: HTTP Open Server failed to listen/);
			assert.doesNotMatch(output, /uncaughtException/);
			assert.doesNotMatch(output, /HTTP Open Server Listening/);
		} finally {
			if (child && child.exitCode === null && child.signalCode === null) {
				await waitForExit(child);
			}
			if (occupiedServer.listening) {
				await new Promise(resolve => occupiedServer.close(resolve));
			}
			fs.rmSync(temporaryDir, { recursive: true, force: true });
		}
	});

	it('serves WUI, API, stream, and Socket.IO 4 with polling, upgrade, and reconnect', { timeout: 40000 }, async function() {
		const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-wui-smoke-'));
		const dataDir = path.join(temporaryDir, 'data');
		const logDir = path.join(temporaryDir, 'log');
		const recordedPath = path.join(temporaryDir, 'smoke.m2ts');
		const openPort = await reservePort('127.0.0.1');
		const legacyPort = await reservePort('127.0.0.1');
		let child = null;
		let socket = null;
		let pollingSocket = null;
		let output = null;

		try {
			fs.mkdirSync(dataDir);
			fs.mkdirSync(logDir);
			fs.symlinkSync(path.join(repositoryRoot, 'api'), path.join(temporaryDir, 'api'), 'dir');
			fs.symlinkSync(path.join(repositoryRoot, 'lib'), path.join(temporaryDir, 'lib'), 'dir');
			fs.symlinkSync(path.join(repositoryRoot, 'node_modules'), path.join(temporaryDir, 'node_modules'), 'dir');
			fs.symlinkSync(path.join(repositoryRoot, 'web'), path.join(temporaryDir, 'web'), 'dir');
			fs.copyFileSync(path.join(repositoryRoot, 'app-wui.js'), path.join(temporaryDir, 'app-wui.js'));
			fs.copyFileSync(path.join(repositoryRoot, 'package.json'), path.join(temporaryDir, 'package.json'));
			fs.copyFileSync(path.join(repositoryRoot, 'processes.json'), path.join(temporaryDir, 'processes.json'));
			fs.writeFileSync(recordedPath, Buffer.from('chinachu-stream-smoke'));
			fs.writeFileSync(path.join(temporaryDir, 'rules.json'), '[]');
			fs.writeFileSync(path.join(dataDir, 'rules.json'), '[]');
			fs.writeFileSync(path.join(dataDir, 'reserves.json'), '[]');
			fs.writeFileSync(path.join(dataDir, 'schedule.json'), '[]');
			fs.writeFileSync(path.join(dataDir, 'recording.json'), '[]');
			fs.writeFileSync(path.join(dataDir, 'recorded.json'), JSON.stringify([
				{ id: 'smoke', recorded: recordedPath, title: 'Smoke', channel: {} }
			]));
			fs.writeFileSync(path.join(dataDir, 'match.json'), '[]');
			fs.writeFileSync(path.join(temporaryDir, 'config.json'), JSON.stringify({
				mirakurunPath: 'http://127.0.0.1:9/',
				wuiOpenServer: true,
				wuiOpenHost: '127.0.0.1',
				wuiOpenPort: openPort,
				wuiMdnsAdvertisement: true,
				wuiPort: legacyPort,
				wuiHost: '127.0.0.1',
				wuiUsers: [ 'legacy:password' ],
				wuiTlsKeyPath: '/does/not/exist/legacy.key',
				wuiTlsCertPath: '/does/not/exist/legacy.crt',
				wuiAllowCountries: [ 'ZZ' ],
				wuiXFF: true
			}));

			({ child, output } = await startWuiProcess(temporaryDir));

			const wui = await request(openPort, '/', { 'X-Forwarded-For': '203.0.113.99' });
			assert.strictEqual(wui.statusCode, 200);
			assert.ok(wui.body.length > 0);

			const api = await request(openPort, '/api/status.json');
			assert.strictEqual(api.statusCode, 200);
			assert.ok(Object.hasOwn(JSON.parse(api.body.toString()), 'wui'));

			const stream = await request(openPort, '/api/recorded/smoke/file.m2ts');
			assert.strictEqual(stream.statusCode, 200);
			assert.strictEqual(stream.body.toString(), 'chinachu-stream-smoke');

			const clientBundle = await request(openPort, '/socket.io/socket.io.js');
			assert.strictEqual(clientBundle.statusCode, 200);
			assert.match(clientBundle.body.toString(), /Socket\.IO v4\.8\.3/);

			const engine4 = await request(openPort, '/socket.io/?EIO=4&transport=polling');
			assert.strictEqual(engine4.statusCode, 200);
			assert.match(engine4.body.toString(), /^0\{/);
			assert.match(engine4.body.toString(), /"upgrades":\["websocket"\]/);

			const engine3 = await request(openPort, '/socket.io/?EIO=3&transport=polling');
			assert.strictEqual(engine3.statusCode, 400);

			const { io } = require('socket.io-client');
			pollingSocket = io('http://127.0.0.1:' + openPort, {
				autoConnect: false,
				forceNew: true,
				reconnection: false,
				transports: [ 'polling' ]
			});
			const pollingConnected = waitForSocketEvent(pollingSocket, 'connect');
			pollingSocket.connect();
			await pollingConnected;
			assert.strictEqual(pollingSocket.io.engine.transport.name, 'polling');
			pollingSocket.close();
			pollingSocket = null;

			const notifyEvents = [
				'notify-rules',
				'notify-reserves',
				'notify-recording',
				'notify-recorded',
				'notify-schedule'
			];
			const notifyCounts = {};
			const notifyArgumentCounts = {};
			notifyEvents.forEach(eventName => {
				notifyCounts[eventName] = 0;
				notifyArgumentCounts[eventName] = [];
			});
			let latestStatus = null;
			let initialTransport = null;

			socket = io('http://127.0.0.1:' + openPort, {
				autoConnect: false,
				forceNew: true,
				reconnection: true,
				reconnectionDelay: 100,
				reconnectionDelayMax: 200,
				timeout: 1000,
				transports: [ 'polling', 'websocket' ]
			});
			notifyEvents.forEach(eventName => {
				socket.on(eventName, function () {
					notifyCounts[eventName]++;
					notifyArgumentCounts[eventName].push(arguments.length);
				});
			});
			socket.on('status', status => { latestStatus = status; });

			const upgraded = new Promise((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error('Socket.IO did not upgrade to WebSocket')), 5000);
				socket.io.once('open', () => {
					initialTransport = socket.io.engine.transport.name;
					socket.io.engine.once('upgrade', transport => {
						clearTimeout(timeout);
						resolve(transport.name);
					});
				});
			});
			const connected = waitForSocketEvent(socket, 'connect');
			socket.connect();
			await connected;
			assert.strictEqual(initialTransport, 'polling');
			assert.strictEqual(await upgraded, 'websocket');
			await waitForCondition(
				() => latestStatus && notifyEvents.every(eventName => notifyCounts[eventName] >= 1),
				'Initial status or notify events were not received'
			);
			assert.ok(Object.hasOwn(latestStatus, 'connectedCount'));
			assert.ok(latestStatus.connectedCount >= 1);
			notifyEvents.forEach(eventName => assert.strictEqual(notifyArgumentCounts[eventName][0], 0));

			const rulesBeforeUpdate = notifyCounts['notify-rules'];
			fs.writeFileSync(path.join(temporaryDir, 'rules.json'), '[{"name":"updated"}]');
			await waitForCondition(
				() => notifyCounts['notify-rules'] > rulesBeforeUpdate,
				'notify-rules was not emitted after rules.json changed'
			);

			await new Promise(resolve => setTimeout(resolve, 50));
			assert.match(output.value, /127\.0\.0\.1/);
			assert.doesNotMatch(output.value, /203\.0\.113\.99/);
			assert.doesNotMatch(output.value, /mDNS advertising started/);

			await (async function() {
				try {
					await request(legacyPort, '/');
					throw new Error('legacy wuiPort unexpectedly accepted a connection');
				} catch (error) {
					if (error.message === 'legacy wuiPort unexpectedly accepted a connection') {
						throw error;
					}
				}
			}());

			const countsBeforeReconnect = {};
			notifyEvents.forEach(eventName => {
				countsBeforeReconnect[eventName] = notifyCounts[eventName];
			});
			const disconnected = waitForSocketEvent(socket, 'disconnect');
			const reconnected = waitForSocketEvent(socket, 'connect', 10000);
			const sigquitExit = await waitForSignalExit(child, 'SIGQUIT', 1500);
			child = null;
			assert.strictEqual(sigquitExit.code, 0);
			assert.strictEqual(sigquitExit.signal, null);
			assert.ok(sigquitExit.elapsedMs < 900);
			await disconnected;
			({ child } = await startWuiProcess(temporaryDir));
			await reconnected;
			await waitForCondition(
				() => notifyEvents.every(eventName => notifyCounts[eventName] > countsBeforeReconnect[eventName]),
				'Initial notify events were not re-sent after reconnect',
				10000
			);
		} finally {
			if (pollingSocket) {
				pollingSocket.close();
			}
			if (socket) {
				socket.close();
			}
			if (child) {
				await waitForExit(child);
			}
			fs.rmSync(temporaryDir, { recursive: true, force: true });
		}
	});
});
