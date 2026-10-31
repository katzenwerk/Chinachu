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

function createFfmpegFixture(temporaryDir) {
	const fixturePath = path.join(temporaryDir, 'ffmpeg');
	fs.writeFileSync(fixturePath, [
		'#!/usr/bin/env node',
		"const fs = require('fs');",
		"fs.appendFileSync(process.env.CHINACHU_TEST_FFMPEG_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');",
		"fs.writeFileSync(process.argv[process.argv.length - 1], Buffer.from([0xff, 0xd8, 0xff, 0xd9]));"
	].join('\n') + '\n');
	fs.chmodSync(fixturePath, 0o755);
}

function createMirakurunStub(streamHandler) {
	const sockets = new Set();
	const recordingConnections = [];
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
			// Register before the handler can end or destroy the stream. Keep
			// the close result even when the test starts waiting afterwards.
			const connection = { socket: req.socket, closed: false };
			recordingConnections.push(connection);
			connection.socket.once('close', () => { connection.closed = true; });
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

	return { server, sockets, recordingConnections };
}

describe('Operator recording stream termination', function() {
	it('recovers a silent stream and keeps Operator responsive while serialized post-processing runs', { timeout: 40000 }, async function() {
		const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-operator-silent-stream-'));
		const dataDir = path.join(temporaryDir, 'data');
		const logDir = path.join(temporaryDir, 'log');
		const recordedDir = path.join(temporaryDir, 'recorded');
		const recordedPath = path.join(recordedDir, '1.m2ts');
		const ffprobePath = path.join(temporaryDir, 'ffprobe-fixture.js');
		const ffmpegLog = path.join(temporaryDir, 'ffmpeg.log');
		const thumbnailPath = path.join(dataDir, 'thumbnails', '1.jpg');
		const matchingStarted = path.join(temporaryDir, 'matching.started');
		const matchingRelease = path.join(temporaryDir, 'matching.release');
		const matchingFinished = path.join(temporaryDir, 'matching.finished');
		let streamResponse = null;
		const { server, sockets, recordingConnections } = createMirakurunStub((req, res) => {
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
					nid: 10,
					sid: 1,
					name: 'Test Channel'
				},
				isManualReserved: true
			};

			fs.mkdirSync(dataDir);
			fs.mkdirSync(logDir);
			fs.symlinkSync(path.join(repositoryRoot, 'lib'), path.join(temporaryDir, 'lib'), 'dir');
			fs.symlinkSync(path.join(repositoryRoot, 'node_modules'), path.join(temporaryDir, 'node_modules'), 'dir');
			fs.copyFileSync(path.join(repositoryRoot, 'app-operator.js'), path.join(temporaryDir, 'app-operator.js'));
			fs.copyFileSync(path.join(repositoryRoot, 'package.json'), path.join(temporaryDir, 'package.json'));
			// These are required runtime entry points, not the Scheduler/matcher
			// being tested here. Keep their effects local and controllable.
			fs.writeFileSync(path.join(temporaryDir, 'chinachu'), '#!/usr/bin/env node\nprocess.exit(0);\n');
			fs.chmodSync(path.join(temporaryDir, 'chinachu'), 0o755);
			fs.writeFileSync(path.join(temporaryDir, 'app-matching.js'), [
				'const fs = require("fs");',
				'const path = require("path");',
				'const release = path.join(__dirname, "matching.release");',
				'let finished = false;',
				'function finish(reason) {',
				'  if (finished) return;',
				'  finished = true; clearTimeout(deadline); watcher.close();',
				'  fs.writeFileSync(path.join(__dirname, "matching.finished"), reason);',
				'}',
				'const watcher = fs.watch(__dirname, () => { if (fs.existsSync(release)) finish("released"); });',
				'const deadline = setTimeout(() => finish("timeout"), 10000);',
				'process.once("SIGTERM", () => finish("signal"));',
				'fs.writeFileSync(path.join(__dirname, "matching.started"), "started");',
				'if (fs.existsSync(release)) finish("released");'
			].join('\n') + '\n');
			fs.writeFileSync(ffprobePath, '#!/usr/bin/env node\nprocess.stdout.write("120\\n");\n');
			fs.chmodSync(ffprobePath, 0o755);
			createFfmpegFixture(temporaryDir);
			fs.writeFileSync(path.join(temporaryDir, 'config.json'), JSON.stringify({
				mirakurunPath: 'http://127.0.0.1:' + server.address().port + '/',
				recordedDir: recordedDir,
				recordedFormat: '<id>.m2ts',
				handoffPrepSeconds: 20,
				operatorReserveCheckIntervalSec: 1,
				operatorPrepReserveCheckIntervalSec: 1,
				mirakurunDropCheckIntervalSec: 0,
				ffprobeCommand: ffprobePath,
				storageLowSpaceAction: 'none'
			}));
			fs.writeFileSync(path.join(dataDir, 'reserves.json'), JSON.stringify([ program ]));
			[ 'reserves2', 'recording', 'recorded', 'match' ].forEach(name => {
				fs.writeFileSync(path.join(dataDir, name + '.json'), '[]');
			});

			child = childProcess.spawn(process.execPath, [ 'app-operator.js' ], {
				cwd: temporaryDir,
				stdio: [ 'ignore', 'pipe', 'pipe' ],
					env: Object.assign({}, process.env, {
						PATH: temporaryDir + path.delimiter + process.env.PATH,
						CHINACHU_TEST_FFMPEG_LOG: ffmpegLog,
						CHINACHU_RUNTIME_DIR: path.join(temporaryDir, 'runtime')
					})
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
			assert.strictEqual(fs.existsSync(thumbnailPath), false);
			assert.strictEqual(fs.existsSync(ffmpegLog), false);
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
				() => !processHasOpenPath(child.pid, recordedPath) &&
					recordingConnections.length > 0 && recordingConnections.every(connection => connection.closed),
				'Recovered recording resources remained open',
				3000
			);
			await waitForCondition(() => fs.existsSync(matchingStarted),
				'Match did not resume after the recording handoff window. Output:\n' + output, 22000);
			assert.strictEqual(fs.existsSync(matchingFinished), false);
			assert.strictEqual(fs.existsSync(ffmpegLog), false, 'Thumbnail overlapped a running match worker');
			const readsBefore = (output.match(/READ: .*reserves\.json.*updated/g) || []).length;
			const futureReserve = Object.assign({}, program, {
				start: Date.now() + 3600000, end: Date.now() + 3660000
			});
			fs.writeFileSync(path.join(dataDir, 'reserves.json'), JSON.stringify([futureReserve]));
			await waitForCondition(
				() => (output.match(/READ: .*reserves\.json.*updated/g) || []).length > readsBefore,
				'Operator event loop stopped while match was running. Output:\n' + output, 3000);
			assert.strictEqual(fs.existsSync(matchingFinished), false);
			assert.strictEqual(fs.existsSync(ffmpegLog), false);
			fs.writeFileSync(matchingRelease, 'release');
			await waitForCondition(
				() => fs.existsSync(path.join(dataDir, 'bitrate-stats.json')) &&
					fs.existsSync(thumbnailPath) &&
					JSON.parse(fs.readFileSync(path.join(dataDir, 'recorded.json'), 'utf8'))[0].recordedDurationSeconds === 120,
				'Normal recording did not update duration and bitrate statistics. Output:\n' + output,
				25000 // The held match has been released; the queued thumbnail must finish.
			);

			const recorded = JSON.parse(fs.readFileSync(path.join(dataDir, 'recorded.json'), 'utf8'));
			assert.strictEqual(recorded.length, 1);
			assert.strictEqual(recorded[0].recorded, recordedPath);
			assert.strictEqual(recorded[0].recordedDurationSeconds, 120);
			assert.strictEqual(fs.readFileSync(matchingFinished, 'utf8'), 'released');
			assert.strictEqual(fs.readFileSync(recordedPath, 'utf8'), 'PART1PART2');
			assert.deepStrictEqual(fs.readFileSync(thumbnailPath), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
			assert.strictEqual(fs.readFileSync(ffmpegLog, 'utf8').trim().split('\n').length, 1);
			const thumbnailArgs = JSON.parse(fs.readFileSync(ffmpegLog, 'utf8').trim());
			assert.strictEqual(thumbnailArgs[thumbnailArgs.indexOf('-threads') + 1], '1');
			assert.strictEqual(thumbnailArgs[thumbnailArgs.lastIndexOf('-threads') + 1], '1');
			assert.strictEqual(thumbnailArgs[thumbnailArgs.indexOf('-filter_threads') + 1], '1');
			assert.doesNotMatch(output, /NG RECORDING/);
			assert.doesNotMatch(output, /uncaughtException/);

			const exitPromise = waitForExit(child, 2000);
			child.kill('SIGTERM');
			const exit = await exitPromise;
			assert.strictEqual(exit.signal, null);
			assert.strictEqual(exit.code, 0);
		} finally {
			// Release the owned matcher before removing its watched directory,
			// including assertion failures while it is held.
			if (fs.existsSync(matchingStarted) && !fs.existsSync(matchingFinished)) {
				fs.writeFileSync(matchingRelease, 'release');
				await waitForCondition(() => fs.existsSync(matchingFinished), 'Match fixture did not exit', 2000).catch(() => {});
			}
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
		const ffmpegLog = path.join(temporaryDir, 'ffmpeg.log');
		const thumbnailPath = path.join(dataDir, 'thumbnails', '1.jpg');
		const { server, sockets, recordingConnections } = createMirakurunStub();
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
			fs.copyFileSync(path.join(repositoryRoot, 'app-operator.js'), path.join(temporaryDir, 'app-operator.js'));
			fs.copyFileSync(path.join(repositoryRoot, 'package.json'), path.join(temporaryDir, 'package.json'));
			createFfmpegFixture(temporaryDir);
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
				stdio: [ 'ignore', 'pipe', 'pipe' ],
					env: Object.assign({}, process.env, {
						PATH: temporaryDir + path.delimiter + process.env.PATH,
						CHINACHU_TEST_FFMPEG_LOG: ffmpegLog,
						CHINACHU_RUNTIME_DIR: path.join(temporaryDir, 'runtime')
					})
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
				() => {
					try {
						return JSON.parse(fs.readFileSync(path.join(dataDir, 'recording.json'), 'utf8')).length === 0;
					} catch (error) {
						if (error instanceof SyntaxError) {
							return false;
						}
						throw error;
					}
				},
				'Interrupted recording remained in recording.json',
				3000
			);
			await waitForCondition(
				() => fs.existsSync(recordedPath) && !processHasOpenPath(child.pid, recordedPath),
				'Recording output WriteStream remained open',
				3000
			);
			await waitForCondition(
				() => recordingConnections.length > 0 && recordingConnections.every(connection => connection.closed),
				'Mirakurun input stream socket remained open',
				3000
			);

			assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'recording.json'), 'utf8')), []);
			assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'recorded.json'), 'utf8')), []);
			assert.strictEqual(fs.existsSync(path.join(dataDir, 'bitrate-stats.json')), false);
			assert.strictEqual(fs.existsSync(thumbnailPath), false);
			assert.strictEqual(fs.existsSync(ffmpegLog), false);
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
