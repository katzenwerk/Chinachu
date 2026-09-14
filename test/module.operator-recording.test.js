'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const repositoryRoot = path.resolve(__dirname, '..');

function waitForCondition(predicate, message, timeoutMs) {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const interval = setInterval(() => {
			try {
				if (predicate()) {
					clearInterval(interval);
					resolve();
					return;
				}
			} catch (error) {
				clearInterval(interval);
				reject(error);
				return;
			}

			if (Date.now() - startedAt >= timeoutMs) {
				clearInterval(interval);
				reject(new Error(message));
			}
		}, 20);
	});
}

function waitForExit(child, timeoutMs) {
	return new Promise((resolve, reject) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolve({ code: child.exitCode, signal: child.signalCode });
			return;
		}

		const timeout = setTimeout(() => {
			child.removeListener('exit', onExit);
			reject(new Error('Operator did not exit within the timeout'));
		}, timeoutMs);

		function onExit(code, signal) {
			clearTimeout(timeout);
			resolve({ code: code, signal: signal });
		}

		child.once('exit', onExit);
	});
}

function processHasOpenPath(pid, targetPath) {
	const fdDir = '/proc/' + pid + '/fd';
	let entries;

	try {
		entries = fs.readdirSync(fdDir);
	} catch (error) {
		if (error.code === 'ENOENT') {
			return false;
		}
		throw error;
	}

	return entries.some(entry => {
		try {
			return fs.readlinkSync(path.join(fdDir, entry)).replace(/ \(deleted\)$/, '') === targetPath;
		} catch (error) {
			return false;
		}
	});
}

function createMirakurunStub(streamHandler) {
	const sockets = new Set();
	const docs = {
		swagger: '2.0',
		basePath: '/api',
		paths: {
			'/programs/{id}/stream': {
				parameters: [
					{ name: 'id', in: 'path', required: true, type: 'integer' }
				],
				get: {
					tags: [ 'stream' ],
					operationId: 'getProgramStream',
					parameters: [
						{ name: 'decode', in: 'query', required: false, type: 'integer' }
					]
				}
			}
		}
	};
	const server = http.createServer((req, res) => {
		if (req.url === '/api/docs') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(docs));
			return;
		}

		if (/^\/api\/programs\/1\/stream\?/.test(req.url)) {
			if (streamHandler) {
				streamHandler(req, res);
				return;
			}

			res.writeHead(200, { 'Content-Type': 'video/MP2T' });
			res.write(Buffer.alloc(188, 0x47));
			setTimeout(() => res.socket.destroy(), 50);
			return;
		}

		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end('{}');
	});

	server.on('connection', socket => {
		sockets.add(socket);
		socket.once('close', () => sockets.delete(socket));
	});

	return { server, sockets };
}

describe('Operator recording stream termination', function() {
	it('continues the same recording after a temporary silent input stream recovers', { timeout: 15000 }, async function() {
		const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-operator-silent-stream-'));
		const dataDir = path.join(temporaryDir, 'data');
		const logDir = path.join(temporaryDir, 'log');
		const recordedDir = path.join(temporaryDir, 'recorded');
		const recordedPath = path.join(recordedDir, '1.m2ts');
		let streamResponse = null;
		const { server, sockets } = createMirakurunStub((req, res) => {
			streamResponse = res;
			res.writeHead(200, {
				'Content-Type': 'video/MP2T',
				'Connection': 'close'
			});
			res.write(Buffer.from('PART1'));
		});
		let child = null;
		let output = '';

		try {
			await new Promise((resolve, reject) => {
				server.once('error', reject);
				server.listen(0, '127.0.0.1', resolve);
			});

			const now = Date.now();
			const program = {
				id: '1',
				start: now - 1000,
				end: now + 60000,
				seconds: 61,
				title: 'Temporary silent stream test',
				fullTitle: 'Temporary silent stream test',
				channel: {
					id: 'test-channel',
					type: 'GR',
					channel: 'test',
					sid: 1,
					name: 'Test Channel'
				},
				isManualReserved: true
			};

			fs.mkdirSync(dataDir);
			fs.mkdirSync(logDir);
			fs.symlinkSync(path.join(repositoryRoot, 'lib'), path.join(temporaryDir, 'lib'), 'dir');
			fs.symlinkSync(path.join(repositoryRoot, 'node_modules'), path.join(temporaryDir, 'node_modules'), 'dir');
			fs.symlinkSync(path.join(repositoryRoot, 'web'), path.join(temporaryDir, 'web'), 'dir');
			fs.copyFileSync(path.join(repositoryRoot, 'app-operator.js'), path.join(temporaryDir, 'app-operator.js'));
			fs.copyFileSync(path.join(repositoryRoot, 'package.json'), path.join(temporaryDir, 'package.json'));
			fs.writeFileSync(path.join(temporaryDir, 'config.json'), JSON.stringify({
				mirakurunPath: 'http://127.0.0.1:' + server.address().port + '/',
				recordedDir: recordedDir,
				recordedFormat: '<id>.m2ts',
				handoffPrepSeconds: 20,
				operatorReserveCheckIntervalSec: 1,
				operatorPrepReserveCheckIntervalSec: 1,
				mirakurunDropCheckIntervalSec: 0,
				storageLowSpaceAction: 'none'
			}));
			fs.writeFileSync(path.join(dataDir, 'reserves.json'), JSON.stringify([ program ]));
			[ 'reserves2', 'recording', 'recorded', 'match' ].forEach(name => {
				fs.writeFileSync(path.join(dataDir, name + '.json'), '[]');
			});

			child = childProcess.spawn(process.execPath, [ 'app-operator.js' ], {
				cwd: temporaryDir,
				stdio: [ 'ignore', 'pipe', 'pipe' ]
			});
			child.stdout.on('data', chunk => { output += chunk.toString(); });
			child.stderr.on('data', chunk => { output += chunk.toString(); });

			await waitForCondition(
				() => /RECORD: #1\b/.test(output) &&
					fs.existsSync(recordedPath) &&
					fs.readFileSync(recordedPath, 'utf8') === 'PART1',
				'Operator did not enter the temporary silent period. Output:\n' + output,
				8000
			);

			const stalledRecording = JSON.parse(fs.readFileSync(path.join(dataDir, 'recording.json'), 'utf8'));
			assert.strictEqual(stalledRecording.length, 1);
			assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'recorded.json'), 'utf8')), []);
			assert.strictEqual(fs.readFileSync(recordedPath, 'utf8'), 'PART1');
			assert.strictEqual(processHasOpenPath(child.pid, recordedPath), true);
			assert.doesNotMatch(output, /NG RECORDING/);

			assert.ok(streamResponse);
			assert.strictEqual(streamResponse.writableEnded, false);
			streamResponse.end(Buffer.from('PART2'));

			await waitForCondition(
				() => JSON.parse(fs.readFileSync(path.join(dataDir, 'recording.json'), 'utf8')).length === 0 &&
					JSON.parse(fs.readFileSync(path.join(dataDir, 'recorded.json'), 'utf8')).length === 1 &&
					fs.readFileSync(recordedPath, 'utf8') === 'PART1PART2',
				'Operator did not finalize the recovered stream normally. Output:\n' + output,
				3000
			);
			await waitForCondition(
				() => !processHasOpenPath(child.pid, recordedPath) && sockets.size === 0,
				'Recovered recording resources remained open',
				3000
			);

			const recorded = JSON.parse(fs.readFileSync(path.join(dataDir, 'recorded.json'), 'utf8'));
			assert.strictEqual(recorded.length, 1);
			assert.strictEqual(recorded[0].recorded, recordedPath);
			assert.strictEqual(fs.readFileSync(recordedPath, 'utf8'), 'PART1PART2');
			assert.doesNotMatch(output, /NG RECORDING/);
			assert.doesNotMatch(output, /uncaughtException/);

			const exitPromise = waitForExit(child, 2000);
			child.kill('SIGTERM');
			const exit = await exitPromise;
			assert.strictEqual(exit.signal, null);
			assert.strictEqual(exit.code, 0);
		} finally {
			if (child && child.exitCode === null && child.signalCode === null) {
				child.kill('SIGKILL');
				await waitForExit(child, 2000).catch(() => {});
			}
			for (const socket of sockets) {
				socket.destroy();
			}
			if (server.listening) {
				await new Promise(resolve => server.close(resolve));
			}
			fs.rmSync(temporaryDir, { recursive: true, force: true });
		}
	});

	it('finalizes an interrupted Mirakurun stream once as NG and releases recording resources', { timeout: 15000 }, async function() {
		const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-operator-stream-'));
		const dataDir = path.join(temporaryDir, 'data');
		const logDir = path.join(temporaryDir, 'log');
		const recordedDir = path.join(temporaryDir, 'recorded');
		const recordedPath = path.join(recordedDir, '1.m2ts');
		const { server, sockets } = createMirakurunStub();
		let child = null;
		let output = '';

		try {
			await new Promise((resolve, reject) => {
				server.once('error', reject);
				server.listen(0, '127.0.0.1', resolve);
			});

			const now = Date.now();
			const program = {
				id: '1',
				start: now - 1000,
				end: now + 60000,
				seconds: 61,
				title: 'Interrupted stream test',
				fullTitle: 'Interrupted stream test',
				channel: {
					id: 'test-channel',
					type: 'GR',
					channel: 'test',
					sid: 1,
					name: 'Test Channel'
				},
				isManualReserved: true
			};

			fs.mkdirSync(dataDir);
			fs.mkdirSync(logDir);
			fs.symlinkSync(path.join(repositoryRoot, 'lib'), path.join(temporaryDir, 'lib'), 'dir');
			fs.symlinkSync(path.join(repositoryRoot, 'node_modules'), path.join(temporaryDir, 'node_modules'), 'dir');
			fs.symlinkSync(path.join(repositoryRoot, 'web'), path.join(temporaryDir, 'web'), 'dir');
			fs.copyFileSync(path.join(repositoryRoot, 'app-operator.js'), path.join(temporaryDir, 'app-operator.js'));
			fs.copyFileSync(path.join(repositoryRoot, 'package.json'), path.join(temporaryDir, 'package.json'));
			fs.writeFileSync(path.join(temporaryDir, 'config.json'), JSON.stringify({
				mirakurunPath: 'http://127.0.0.1:' + server.address().port + '/',
				recordedDir: recordedDir,
				recordedFormat: '<id>.m2ts',
				handoffPrepSeconds: 20,
				operatorReserveCheckIntervalSec: 1,
				operatorPrepReserveCheckIntervalSec: 1,
				mirakurunDropCheckIntervalSec: 0,
				storageLowSpaceAction: 'none'
			}));
			fs.writeFileSync(path.join(dataDir, 'reserves.json'), JSON.stringify([ program ]));
			[ 'reserves2', 'recording', 'recorded', 'match' ].forEach(name => {
				fs.writeFileSync(path.join(dataDir, name + '.json'), '[]');
			});

			child = childProcess.spawn(process.execPath, [ 'app-operator.js' ], {
				cwd: temporaryDir,
				stdio: [ 'ignore', 'pipe', 'pipe' ]
			});
			child.stdout.on('data', chunk => { output += chunk.toString(); });
			child.stderr.on('data', chunk => { output += chunk.toString(); });

			await waitForCondition(
				() => /RECORD: #1\b/.test(output),
				'Operator did not start the isolated recording. Output:\n' + output,
				8000
			);
			await waitForCondition(
				() => /NG RECORDING: INPUT STREAM (?:ABORTED|ERROR|CLOSED PREMATURELY)/.test(output),
				'Operator did not finalize the interrupted stream as NG. Output:\n' + output,
				3000
			);
			await waitForCondition(
				() => JSON.parse(fs.readFileSync(path.join(dataDir, 'recording.json'), 'utf8')).length === 0,
				'Interrupted recording remained in recording.json',
				3000
			);
			await waitForCondition(
				() => fs.existsSync(recordedPath) && !processHasOpenPath(child.pid, recordedPath),
				'Recording output WriteStream remained open',
				3000
			);
			await waitForCondition(
				() => sockets.size === 0,
				'Mirakurun input stream socket remained open',
				3000
			);

			assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'recording.json'), 'utf8')), []);
			assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'recorded.json'), 'utf8')), []);
			assert.strictEqual((output.match(/NG RECORDING: INPUT STREAM (?:ABORTED|ERROR|CLOSED PREMATURELY)/g) || []).length, 1);
			assert.doesNotMatch(output, /WRITE: .*recorded\.json/);
			assert.doesNotMatch(output, /uncaughtException/);

			const exitPromise = waitForExit(child, 2000);
			child.kill('SIGTERM');
			const exit = await exitPromise;
			assert.strictEqual(exit.signal, null);
			assert.strictEqual(exit.code, 0);
		} finally {
			if (child && child.exitCode === null && child.signalCode === null) {
				child.kill('SIGKILL');
				await waitForExit(child, 2000).catch(() => {});
			}
			for (const socket of sockets) {
				socket.destroy();
			}
			if (server.listening) {
				await new Promise(resolve => server.close(resolve));
			}
			fs.rmSync(temporaryDir, { recursive: true, force: true });
		}
	});
});
