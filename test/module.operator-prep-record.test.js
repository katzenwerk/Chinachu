'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const matching = require('../app-matching');
const recordingAttempt = require('../lib/recording-attempt');
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
				if (!(error instanceof SyntaxError)) {
					clearInterval(interval);
					reject(error);
					return;
				}
			}

			if (Date.now() - startedAt >= timeoutMs) {
				clearInterval(interval);
				reject(new Error(message));
			}
		}, 20);
	});
}

function createProgram(id, options) {
	options = options || {};
	const now = Date.now();

	return {
		id: id,
		start: now - 1000,
		end: now + (options.endAfterMs || 60000),
		seconds: 61,
		title: 'Prep attempt ' + id,
		fullTitle: 'Prep attempt ' + id,
		channel: {
			id: 'channel-' + id,
			type: 'GR',
			channel: id,
			sid: Number(id),
			name: 'Channel ' + id
		},
		allowEndLack: options.allowEndLack === true,
		isManualReserved: options.isManualReserved === true
	};
}

async function createOperatorFixture(programs, onStream, options) {
	options = options || {};
	const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-operator-prep-'));
	const dataDir = path.join(temporaryDir, 'data');
	const recordedDir = path.join(temporaryDir, 'recorded');
	const recordedCommandLog = path.join(temporaryDir, 'recorded-command.log');
	const matchingLog = path.join(temporaryDir, 'matching.log');
	const notificationLog = path.join(temporaryDir, 'notification.log');
	const ffprobeLog = path.join(temporaryDir, 'ffprobe.log');
	const sockets = new Set();
	const requests = [];
	const docs = {
		swagger: '2.0',
		basePath: '/api',
		paths: {
			'/programs/{id}/stream': {
				parameters: [ { name: 'id', in: 'path', required: true, type: 'integer' } ],
				get: {
					tags: [ 'stream' ],
					operationId: 'getProgramStream',
					parameters: [ { name: 'decode', in: 'query', type: 'integer' } ]
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

		const match = req.url.match(/^\/api\/programs\/(\d+)\/stream\?/);
		if (!match) {
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end('{}');
			return;
		}

		const id = match[1];
		const request = {
			id: id,
			index: requests.filter(item => item.id === id).length + 1,
			req: req,
			res: res
		};
		requests.push(request);
		onStream(request);
	});

	server.on('connection', socket => {
		sockets.add(socket);
		socket.once('close', () => sockets.delete(socket));
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});

	fs.mkdirSync(dataDir);
	fs.mkdirSync(path.join(temporaryDir, 'log'));
	fs.symlinkSync(path.join(repositoryRoot, 'lib'), path.join(temporaryDir, 'lib'), 'dir');
	fs.symlinkSync(path.join(repositoryRoot, 'node_modules'), path.join(temporaryDir, 'node_modules'), 'dir');
	fs.symlinkSync(path.join(repositoryRoot, 'web'), path.join(temporaryDir, 'web'), 'dir');
	fs.copyFileSync(path.join(repositoryRoot, 'app-operator.js'), path.join(temporaryDir, 'app-operator.js'));
	fs.copyFileSync(path.join(repositoryRoot, 'package.json'), path.join(temporaryDir, 'package.json'));
	fs.writeFileSync(path.join(temporaryDir, 'chinachu'), '#!/usr/bin/env node\nprocess.exit(0);\n');
	fs.chmodSync(path.join(temporaryDir, 'chinachu'), 0o755);
	if (options.trackRecordedCommand) {
		const recordedCommand = path.join(temporaryDir, 'recorded-command.js');
		fs.writeFileSync(recordedCommand, '#!/usr/bin/env node\nrequire("fs").appendFileSync(process.env.CHINACHU_TEST_RECORDED_COMMAND_LOG, process.argv[2] + "\\n");\n');
		fs.chmodSync(recordedCommand, 0o755);
		options.config = Object.assign({}, options.config, { recordedCommand: recordedCommand });
	}
	if (options.trackNotification) {
		const notificationCommand = path.join(temporaryDir, 'notification-test.js');
		fs.writeFileSync(notificationCommand, [
			'#!/usr/bin/env node',
			"let input = '';",
			"process.stdin.setEncoding('utf8');",
			"process.stdin.on('data', chunk => { input += chunk; });",
			"process.stdin.on('end', () => require('fs').appendFileSync(process.env.CHINACHU_TEST_NOTIFICATION_LOG, input));"
		].join('\n') + '\n');
		fs.chmodSync(notificationCommand, 0o755);
		options.config = Object.assign({}, options.config, {
			notificationCommand: [ process.execPath, notificationCommand ]
		});
	}
	if (options.trackMatching) {
		fs.writeFileSync(path.join(temporaryDir, 'app-matching.js'), 'require("fs").appendFileSync(process.env.CHINACHU_TEST_MATCHING_LOG, "matching\\n");\n');
	} else if (options.copyMatching) {
		fs.copyFileSync(path.join(repositoryRoot, 'app-matching.js'), path.join(temporaryDir, 'app-matching.js'));
	}
	if (options.ffprobeScript) {
		const ffprobeCommand = path.join(temporaryDir, 'ffprobe-test.js');
		fs.writeFileSync(ffprobeCommand, '#!/usr/bin/env node\n' + options.ffprobeScript + '\n');
		fs.chmodSync(ffprobeCommand, 0o755);
		options.config = Object.assign({}, options.config, { ffprobeCommand: ffprobeCommand });
	}
	fs.writeFileSync(path.join(temporaryDir, 'config.json'), JSON.stringify(Object.assign({
		mirakurunPath: 'http://127.0.0.1:' + server.address().port + '/',
		recordedDir: recordedDir,
		recordedFormat: '<id>.m2ts',
		handoffPrepSeconds: 20,
		operatorReserveCheckIntervalSec: 1,
		operatorPrepReserveCheckIntervalSec: 1,
		mirakurunDropCheckIntervalSec: 0,
		storageLowSpaceAction: 'none'
	}, options.config || {})));
	fs.writeFileSync(path.join(dataDir, 'reserves.json'), JSON.stringify(programs));
	const initialRecorded = typeof options.initialRecorded === 'function' ?
		options.initialRecorded(recordedDir) : options.initialRecorded || [];
	const initialReserves2 = typeof options.initialReserves2 === 'function' ?
		options.initialReserves2(recordedDir) : options.initialReserves2 || [];
	const initialMatch = typeof options.initialMatch === 'function' ?
		options.initialMatch(recordedDir) : options.initialMatch || [];
	for (const name of [ 'reserves2', 'recording', 'recorded', 'match' ]) {
		const initial = name === 'recorded' ? initialRecorded :
			name === 'reserves2' ? initialReserves2 :
			name === 'match' ? initialMatch : [];
		fs.writeFileSync(path.join(dataDir, name + '.json'), JSON.stringify(initial));
	}
	fs.mkdirSync(recordedDir, { recursive: true });
	Object.keys(options.initialFiles || {}).forEach(fileName => {
		fs.writeFileSync(path.join(recordedDir, fileName), options.initialFiles[fileName]);
	});

	let output = '';
	let child = null;

	function startOperator() {
		child = childProcess.spawn(process.execPath, [ 'app-operator.js' ], {
			cwd: temporaryDir,
			stdio: [ 'ignore', 'pipe', 'pipe' ],
			env: Object.assign({}, process.env, {
				CHINACHU_TEST_RECORDED_COMMAND_LOG: recordedCommandLog,
				CHINACHU_TEST_MATCHING_LOG: matchingLog,
				CHINACHU_TEST_NOTIFICATION_LOG: notificationLog,
				CHINACHU_TEST_FFPROBE_LOG: ffprobeLog
			})
		});
		child.stdout.on('data', chunk => { output += chunk.toString(); });
		child.stderr.on('data', chunk => { output += chunk.toString(); });
		return child;
	}

	async function stopOperator() {
		if (!child || child.exitCode !== null || child.signalCode !== null) {
			return;
		}

		const exited = new Promise(resolve => child.once('exit', resolve));
		child.kill('SIGKILL');
		await exited;
	}

	async function signalOperator(signal) {
		if (!child || child.exitCode !== null || child.signalCode !== null) {
			return;
		}

		const exited = new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('operator did not exit after ' + signal)), 3000);
			child.once('exit', (code, exitSignal) => {
				clearTimeout(timer);
				resolve({ code: code, signal: exitSignal });
			});
		});
		child.kill(signal);
		return exited;
	}

	startOperator();

	return {
		temporaryDir,
		dataDir,
		server,
		sockets,
		requests,
		recordedDir,
		recordedCommandLog,
		matchingLog,
		notificationLog,
		ffprobeLog,
		get child() {
			return child;
		},
		output: () => output,
		read(name) {
			return JSON.parse(fs.readFileSync(path.join(dataDir, name + '.json'), 'utf8'));
		},
		abort(id) {
			const recording = this.read('recording');
			recording.find(item => item.id === id).abort = true;
			fs.writeFileSync(path.join(dataDir, 'recording.json'), JSON.stringify(recording));
		},
		writeReserves(programs) {
			fs.writeFileSync(path.join(dataDir, 'reserves.json'), JSON.stringify(programs));
		},
		start: startOperator,
		gracefulStop(signal) {
			return signalOperator(signal || 'SIGINT');
		},
		async restart() {
			await stopOperator();
			output = '';
			return startOperator();
		},
		async close() {
			await stopOperator();
			for (const socket of sockets) {
				socket.destroy();
			}
			if (server.listening) {
				await new Promise(resolve => server.close(resolve));
			}
			fs.rmSync(temporaryDir, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 50
			});
		}
	};
}

describe('Operator recording preparation attempts', function() {
	it('removes a stopped pre-stream manual reserve until the user reserves it again', { timeout: 15000 }, async function() {
		const manualProgram = createProgram('2', { isManualReserved: true });
		const fixture = await createOperatorFixture([ manualProgram ], () => {});

		try {
			await waitForCondition(
				() => fixture.requests.length === 1 && fixture.read('recording').some(item => item.id === '2'),
				'manual reserve did not enter stream preparation',
				7000
			);

			fixture.abort('2');
			await waitForCondition(
				() => fixture.read('recording').length === 0 && fixture.read('reserves').length === 0,
				'pre-stream manual stop did not remove recording and reserve state',
				3000
			);

			assert.strictEqual(fixture.read('reserves').some(item => item.isSkip), false);

			fixture.writeReserves([]);
			await waitForCondition(
				() => (fixture.output().match(/READ: .*reserves\.json.*updated/g) || []).length >= 2,
				'operator did not reload the empty reserves file',
				3000
			);
			assert.strictEqual(fixture.requests.length, 1);

			await fixture.restart();
			await waitForCondition(
				() => /READ: .*reserves\.json.*updated/.test(fixture.output()),
				'restarted operator did not load reserves',
				3000
			);
			assert.strictEqual(fixture.requests.length, 1);

			fixture.writeReserves([ createProgram('2', { isManualReserved: true }) ]);
			await waitForCondition(
				() => fixture.requests.length === 2 && fixture.read('recording').some(item => item.id === '2'),
				'new explicit manual reserve did not start a new preparation',
				5000
			);
			assert.strictEqual(fixture.read('reserves')[0].isManualReserved, true);
			assert.strictEqual(fixture.read('reserves')[0].isSkip, undefined);
		} finally {
			await fixture.close();
		}
	});

	it('keeps a started manual stop as a shortened recording and removes its reserve', { timeout: 10000 }, async function() {
		const fixture = await createOperatorFixture([
			createProgram('2', { isManualReserved: true })
		], request => {
			request.res.writeHead(200, { 'Content-Type': 'video/MP2T' });
			request.res.write(Buffer.alloc(188, 0x47));
		});

		try {
			await waitForCondition(
				() => /RECORD: #2\b[\s\S]*WRITE: .*recording\.json/.test(fixture.output()),
				'manual recording did not start',
				7000
			);
			fixture.abort('2');
			await waitForCondition(
				() => fixture.read('recording').length === 0 &&
					fixture.read('reserves').length === 0 &&
					fixture.read('recorded').some(item => item.id === '2') &&
					/FIN ABORT SHORT: #2\b/.test(fixture.output()),
				'started manual stop did not finalize as a shortened recording',
				3000
			);

			const recorded = fixture.read('recorded')[0];
			assert.strictEqual(recorded.operatorAbort, true);
			assert.strictEqual(recorded.operatorAbortReason, 'ABORT RECORDING');
			assert.match(fixture.output(), /FIN ABORT SHORT: #2\b/);
		} finally {
			await fixture.close();
		}
	});

	it('ignores an aborted target late 503 without ending another recording or retrying the target', { timeout: 12000 }, async function() {
		let pendingTarget = null;
		const fixture = await createOperatorFixture([
			createProgram('1', { allowEndLack: true, endAfterMs: 25000 }),
			createProgram('2')
		], request => {
			if (request.id === '1') {
				request.res.writeHead(200, { 'Content-Type': 'video/MP2T' });
				request.res.write(Buffer.alloc(188, 0x47));
				return;
			}
			pendingTarget = request;
		});

		try {
			await waitForCondition(
				() => {
					const state = fixture.read('recording');
					const candidate = state.find(item => item.id === '1');

					return !!pendingTarget &&
						!!candidate &&
						Number(candidate.operatorRecordingStart) > 0 &&
						state.some(item => item.id === '2');
				},
				'candidate recording and target request did not start',
				7000
			);
			fixture.abort('2');
			await waitForCondition(
				() => fixture.read('recording').every(item => item.id !== '2'),
				'abort did not remove the pending target',
				3000
			);

			pendingTarget.res.writeHead(503, { 'Content-Type': 'application/json' });
			pendingTarget.res.end('{}');
			await waitForCondition(
				() => /DROP STREAM ERROR: #2\b/.test(fixture.output()),
				'late reject was not discarded',
				3000
			);
			await new Promise(resolve => setTimeout(resolve, 700));

			assert.strictEqual(fixture.requests.filter(item => item.id === '2').length, 1);
			assert.ok(fixture.read('recording').some(item => item.id === '1'));
			assert.ok(fixture.read('recording').every(item => item.id !== '2'));
			assert.ok(fixture.read('recorded').every(item => item.id !== '1'));
			assert.doesNotMatch(fixture.output(), /HANDOFF END LACK/);
			assert.doesNotMatch(fixture.output(), /FIN END LACK/);
		} finally {
			await fixture.close();
		}
	});

	it('drops an aborted target late resolve without starting recording or preparing it again', { timeout: 10000 }, async function() {
		let pendingTarget = null;
		const fixture = await createOperatorFixture([ createProgram('2') ], request => {
			pendingTarget = request;
		});

		try {
			await waitForCondition(() => !!pendingTarget, 'target request did not start', 7000);
			fixture.abort('2');
			await waitForCondition(
				() => fixture.read('recording').length === 0,
				'abort did not remove the pending target',
				3000
			);

			pendingTarget.res.writeHead(200, { 'Content-Type': 'video/MP2T' });
			pendingTarget.res.write(Buffer.alloc(188, 0x47));
			await waitForCondition(
				() => /DROP STREAM: #2\b/.test(fixture.output()),
				'late resolve was not discarded',
				3000
			);
			await new Promise(resolve => setTimeout(resolve, 1200));

			assert.strictEqual(fixture.requests.filter(item => item.id === '2').length, 1);
			assert.deepStrictEqual(fixture.read('recording'), []);
			assert.deepStrictEqual(fixture.read('recorded'), []);
			assert.doesNotMatch(fixture.output(), /RECORD: #2\b/);
		} finally {
			await fixture.close();
		}
	});

	it('does not let an older cleanup remove a newer attempt for the same program', function() {
		const program = createProgram('2');
		const recording = [ program ];
		const firstAttempt = recordingAttempt.start(program);
		const secondAttempt = recordingAttempt.start(program);

		assert.strictEqual(recordingAttempt.remove(recording, program, firstAttempt), false);
		assert.deepStrictEqual(recording, [ program ]);
		assert.strictEqual(recordingAttempt.isCurrent(program, secondAttempt), true);
		assert.strictEqual(recordingAttempt.remove(recording, program, secondAttempt), true);
		assert.deepStrictEqual(recording, []);
	});

	it('keeps normal error retry behavior for an active scheduled reserve', { timeout: 12000 }, async function() {
		const fixture = await createOperatorFixture([ createProgram('2') ], request => {
			if (request.index === 1) {
				request.res.writeHead(500, { 'Content-Type': 'application/json' });
				request.res.end('{}');
			}
		});

		try {
			await waitForCondition(
				() => fixture.requests.filter(item => item.id === '2').length >= 2,
				'active reserve was not retried after the normal cleanup interval',
				10000
			);
			assert.ok(fixture.read('recording').some(item => item.id === '2'));
			assert.doesNotMatch(fixture.output(), /DROP STREAM ERROR: #2\b/);
		} finally {
			await fixture.close();
		}
	});

	it('persists decimal ffprobe duration after completion without delaying recordedCommand', { timeout: 15000 }, async function() {
		let response = null;
		const fixture = await createOperatorFixture([ createProgram('2') ], request => {
			response = request.res;
			request.res.writeHead(200, { 'Content-Type': 'video/MP2T' });
			request.res.write('RECORDED');
		}, {
			trackRecordedCommand: true,
			ffprobeScript: [
				'const fs = require("fs");',
				'fs.appendFileSync(process.env.CHINACHU_TEST_FFPROBE_LOG, process.argv[process.argv.length - 1] + "\\n");',
				'const releaseFile = process.env.CHINACHU_TEST_FFPROBE_LOG + ".release";',
				'const timer = setInterval(() => {',
				'  if (!fs.existsSync(releaseFile)) return;',
				'  clearInterval(timer);',
				'  process.stdout.write("12.3456789\\n");',
				'}, 20);'
			].join('\n')
		});

		try {
			await waitForCondition(() => !!response && /RECORD: #2\b/.test(fixture.output()), 'recording did not start', 7000);
			response.end();
			await waitForCondition(
				() => fixture.read('recording').length === 0 &&
					fixture.read('recorded').length === 1 &&
					fs.existsSync(fixture.recordedCommandLog) &&
					fs.existsSync(fixture.ffprobeLog),
				'recording completion or recordedCommand was delayed by ffprobe',
				3000
			);
			assert.strictEqual(fixture.read('recorded')[0].recordedDurationSeconds, undefined);

			fs.writeFileSync(fixture.ffprobeLog + '.release', 'release\n');

			await waitForCondition(
				() => fixture.read('recorded')[0].recordedDurationSeconds === 12.345679 &&
					/DURATION: 12\.345679 sec/.test(fixture.output()),
				'ffprobe duration was not persisted',
				3000
			);
			assert.strictEqual(fs.readFileSync(fixture.recordedCommandLog, 'utf8').trim().split('\n').length, 1);
			assert.strictEqual(fs.readFileSync(fixture.ffprobeLog, 'utf8').trim(), path.join(fixture.recordedDir, '2.m2ts'));
			assert.match(fixture.output(), /DURATION: 12\.345679 sec/);
		} finally {
			await fixture.close();
		}
	});

	it('keeps recordings finalized when ffprobe fails, returns invalid output, or times out', { timeout: 30000 }, async function() {
		const cases = [
			{
				name: 'failure',
				script: 'process.exit(2);',
				config: {},
				warning: /WARNING: ffprobe duration failed:/
			},
			{
				name: 'invalid',
				script: 'process.stdout.write("not-a-duration\\n");',
				config: {},
				warning: /WARNING: ffprobe duration invalid:/
			},
			{
				name: 'timeout',
				script: 'setTimeout(() => process.stdout.write("60\\n"), 2000);',
				config: { recordedDurationProbeTimeoutMs: 100 },
				warning: /WARNING: ffprobe duration failed:/
			}
		];

		for (const item of cases) {
			let response = null;
			const fixture = await createOperatorFixture([ createProgram('2') ], request => {
				response = request.res;
				request.res.writeHead(200, { 'Content-Type': 'video/MP2T' });
				request.res.write(item.name);
			}, {
				ffprobeScript: item.script,
				config: item.config
			});

			try {
				await waitForCondition(() => !!response && /RECORD: #2\b/.test(fixture.output()), item.name + ' recording did not start', 7000);
				response.end();
				await waitForCondition(() => item.warning.test(fixture.output()), item.name + ' warning was not logged', 4000);
				assert.strictEqual(fixture.read('recording').length, 0);
				assert.strictEqual(fixture.read('recorded').length, 1);
				assert.strictEqual(fixture.read('recorded')[0].recordedDurationSeconds, undefined);
				assert.match(fixture.output(), /FIN: #2\b/);
				assert.doesNotMatch(fixture.output(), /uncaughtException/);
			} finally {
				await fixture.close();
			}
		}
	});

	it('does not wait for an active duration probe during graceful shutdown', { timeout: 15000 }, async function() {
		let response = null;
		const fixture = await createOperatorFixture([ createProgram('2') ], request => {
			response = request.res;
			request.res.writeHead(200, { 'Content-Type': 'video/MP2T' });
			request.res.write('RECORDED');
		}, {
			trackRecordedCommand: true,
			config: { recordedDurationProbeTimeoutMs: 8000 },
			ffprobeScript: [
				'const fs = require("fs");',
				'fs.appendFileSync(process.env.CHINACHU_TEST_FFPROBE_LOG, "started\\n");',
				'setTimeout(() => process.stdout.write("60\\n"), 5000);'
			].join('\n')
		});

		try {
			await waitForCondition(() => !!response && /RECORD: #2\b/.test(fixture.output()), 'recording did not start', 7000);
			response.end();
			await waitForCondition(
				() => fixture.read('recording').length === 0 && fixture.read('recorded').length === 1 &&
					fs.existsSync(fixture.ffprobeLog) && fs.existsSync(fixture.recordedCommandLog),
				'finalization did not complete before the slow probe',
				3000
			);

			const startedAt = Date.now();
			const exit = await fixture.gracefulStop('SIGTERM');
			assert.deepStrictEqual(exit, { code: 0, signal: null });
			assert.ok(Date.now() - startedAt < 3000);
			assert.strictEqual(fixture.read('recorded')[0].recordedDurationSeconds, undefined);
			assert.strictEqual(fs.readFileSync(fixture.recordedCommandLog, 'utf8').trim().split('\n').length, 1);
		} finally {
			await fixture.close();
		}
	});

	it('does not resurrect a recorded entry removed while duration probing is in flight', { timeout: 15000 }, async function() {
		let response = null;
		const fixture = await createOperatorFixture([ createProgram('2') ], request => {
			response = request.res;
			request.res.writeHead(200, { 'Content-Type': 'video/MP2T' });
			request.res.write('RECORDED');
		}, {
			ffprobeScript: [
				'const fs = require("fs");',
				'fs.appendFileSync(process.env.CHINACHU_TEST_FFPROBE_LOG, "started\\n");',
				'setTimeout(() => process.stdout.write("60.25\\n"), 500);'
			].join('\n')
		});

		try {
			await waitForCondition(() => !!response && /RECORD: #2\b/.test(fixture.output()), 'recording did not start', 7000);
			response.end();
			await waitForCondition(
				() => fixture.read('recorded').length === 1 && fs.existsSync(fixture.ffprobeLog),
				'probe did not start after recording completion',
				3000
			);
			fs.writeFileSync(path.join(fixture.dataDir, 'recorded.json'), '[]');
			await waitForCondition(
				() => /ffprobe duration target changed, skip update/.test(fixture.output()),
				'changed duration target was not detected',
				3000
			);
			assert.deepStrictEqual(fixture.read('recorded'), []);
		} finally {
			await fixture.close();
		}
	});

	it('resumes a shutdown-interrupted rule recording at the same path and runs completion work only after natural end', { timeout: 20000 }, async function() {
		const responses = [];
		const fixture = await createOperatorFixture([ createProgram('2') ], request => {
			responses.push(request.res);
			request.res.writeHead(200, { 'Content-Type': 'video/MP2T' });
			request.res.write('PART' + request.index);
		}, {
			trackRecordedCommand: true,
			trackMatching: true,
			config: { matchUpdateDelayMs: 0 },
			ffprobeScript: [
				'const fs = require("fs");',
				'fs.appendFileSync(process.env.CHINACHU_TEST_FFPROBE_LOG, "probe\\n");',
				'process.stdout.write("10.500001\\n");'
			].join('\n')
		});
		const recordedPath = path.join(fixture.recordedDir, '2.m2ts');

		try {
			await waitForCondition(
				() => fs.existsSync(recordedPath) && fs.readFileSync(recordedPath, 'utf8') === 'PART1',
				'initial rule recording did not start',
				7000
			);

			const exit = await fixture.gracefulStop('SIGINT');
			assert.deepStrictEqual(exit, { code: 0, signal: null });

			const interrupted = fixture.read('recorded');
			assert.strictEqual(interrupted.length, 1);
			assert.strictEqual(interrupted[0].operatorResumePending, true);
			assert.ok(interrupted[0].operatorInterruptedAt > 0);
			assert.strictEqual(interrupted[0].operatorInterruptionCount, 1);
			assert.strictEqual(interrupted[0].recorded, recordedPath);
			assert.deepStrictEqual(fixture.read('recording'), []);
			assert.strictEqual(fixture.read('reserves').length, 1);
			assert.strictEqual(fs.existsSync(fixture.recordedCommandLog), false);
			assert.strictEqual(fs.existsSync(fixture.matchingLog), false);
			assert.strictEqual(fs.existsSync(fixture.ffprobeLog), false);
			assert.match(fixture.output(), /FIN INTERRUPTED: resume pending: #2\b/);

			fixture.start();
			await waitForCondition(
				() => fixture.requests.length === 2 && fs.readFileSync(recordedPath, 'utf8') === 'PART1PART2',
				'interrupted rule recording did not append at the same path',
				7000
			);
			responses[1].end();

			await waitForCondition(
				() => fixture.read('recording').length === 0 &&
					fixture.read('recorded').length === 1 &&
					fixture.read('recorded')[0].operatorResumePending === false &&
					fs.existsSync(fixture.recordedCommandLog) &&
					fs.existsSync(fixture.matchingLog),
				'final recording completion work did not finish',
				5000
			);
			await waitForCondition(
				() => fixture.read('recorded')[0].recordedDurationSeconds === 10.500001,
				'final resumed recording was not probed',
				3000
			);

			const finalized = fixture.read('recorded')[0];
			assert.strictEqual(finalized.recorded, recordedPath);
			assert.strictEqual(finalized.operatorInterruptionCount, 1);
			assert.ok(finalized.operatorResumedAt >= finalized.operatorInterruptedAt);
			assert.strictEqual(fs.readFileSync(recordedPath, 'utf8'), 'PART1PART2');
			assert.strictEqual(fs.readFileSync(fixture.recordedCommandLog, 'utf8').trim().split('\n').length, 1);
			assert.ok(fs.readFileSync(fixture.matchingLog, 'utf8').trim().split('\n').length >= 1);
			assert.strictEqual(fs.readFileSync(fixture.ffprobeLog, 'utf8').trim().split('\n').length, 1);
			assert.match(fixture.output(), /RESUME RECORD: #2\b/);
		} finally {
			await fixture.close();
		}
	});

	it('keeps one path and increments interruption count across repeated graceful restarts', { timeout: 25000 }, async function() {
		const responses = [];
		const fixture = await createOperatorFixture([ createProgram('2') ], request => {
			responses.push(request.res);
			request.res.writeHead(200, { 'Content-Type': 'video/MP2T' });
			request.res.write('PART' + request.index);
		});
		const recordedPath = path.join(fixture.recordedDir, '2.m2ts');

		try {
			for (let index = 1; index <= 2; index++) {
				await waitForCondition(
					() => fixture.requests.length === index && fs.existsSync(recordedPath) && fs.readFileSync(recordedPath, 'utf8') ===
						Array.from({ length: index }, (_, part) => 'PART' + (part + 1)).join(''),
					'recording part ' + index + ' did not start',
					7000
				);
				await fixture.gracefulStop(index === 1 ? 'SIGTERM' : 'SIGQUIT');
				const interrupted = fixture.read('recorded');
				assert.strictEqual(interrupted.length, 1);
				assert.strictEqual(interrupted[0].recorded, recordedPath);
				assert.strictEqual(interrupted[0].operatorResumePending, true);
				assert.strictEqual(interrupted[0].operatorInterruptionCount, index);
				fixture.start();
			}

			await waitForCondition(
				() => fixture.requests.length === 3 && fs.readFileSync(recordedPath, 'utf8') === 'PART1PART2PART3',
				'third recording part did not append',
				7000
			);
			responses[2].end();
			await waitForCondition(
				() => fixture.read('recording').length === 0 && fixture.read('recorded')[0].operatorResumePending === false,
				'repeatedly resumed recording did not finalize',
				3000
			);
			assert.strictEqual(fixture.read('recorded').length, 1);
			assert.strictEqual(fixture.read('recorded')[0].operatorInterruptionCount, 2);
			assert.strictEqual(fixture.read('recorded')[0].recorded, recordedPath);
		} finally {
			await fixture.close();
		}
	});

	it('does not resume manual, aborted, end-lack, or ended recorded states', { timeout: 15000 }, async function() {
		const cases = [
			{ name: 'manual', program: createProgram('2', { isManualReserved: true }), recorded: { isManualReserved: true } },
			{ name: 'manual stop', program: createProgram('2'), recorded: { operatorAbort: true } },
			{ name: 'end lack', program: createProgram('2'), recorded: { operatorEndLack: true } },
			{ name: 'ended', program: Object.assign(createProgram('2'), { end: Date.now() - 100 }), recorded: { end: Date.now() - 100 } }
		];

		for (const item of cases) {
			const fixture = await createOperatorFixture([ item.program ], () => {}, {
				initialRecorded(recordedDir) {
					return [ Object.assign({}, item.program, {
						recorded: path.join(recordedDir, '2.m2ts'),
						operatorResumePending: true,
						operatorInterruptedAt: Date.now() - 1000,
						operatorInterruptionCount: 1
					}, item.recorded) ];
				},
				initialFiles: { '2.m2ts': item.name }
			});

			try {
				await new Promise(resolve => setTimeout(resolve, 1400));
				assert.strictEqual(fixture.requests.length, 0, item.name + ' unexpectedly resumed');
			} finally {
				await fixture.close();
			}
		}
	});

	it('keeps retrying a resumed rule recording after an abnormal stream close', { timeout: 15000 }, async function() {
		let finalResponse = null;
		const program = createProgram('2');
		const fixture = await createOperatorFixture([ program ], request => {
			request.res.writeHead(200, { 'Content-Type': 'video/MP2T' });
			request.res.write(request.index === 1 ? 'BROKEN' : 'RECOVERED');
			if (request.index === 1) {
				setTimeout(() => request.res.socket.destroy(), 50);
			} else {
				finalResponse = request.res;
			}
		}, {
			initialRecorded(recordedDir) {
				return [ Object.assign({}, program, {
					recorded: path.join(recordedDir, '2.m2ts'),
					operatorResumePending: true,
					operatorInterruptedAt: Date.now() - 1000,
					operatorInterruptionCount: 1
				}) ];
			},
			initialFiles: { '2.m2ts': 'BASE' }
		});

		try {
			await waitForCondition(
				() => /NG RECORDING: INPUT STREAM/.test(fixture.output()),
				'resumed rule recording did not enter the existing NG path',
				4000
			);
			fixture.writeReserves([ program ]);
			await waitForCondition(
				() => fixture.requests.length >= 2 && !!finalResponse,
				'resumed rule recording was not retried after reserve reload',
				5000
			);
			finalResponse.end();
			await waitForCondition(
				() => fixture.read('recording').length === 0 && fixture.read('recorded')[0].operatorResumePending === false,
				'retried resumed recording did not finalize',
				3000
			);
			assert.strictEqual(fs.readFileSync(path.join(fixture.recordedDir, '2.m2ts'), 'utf8'), 'BASEBROKENRECOVERED');
		} finally {
			await fixture.close();
		}
	});

	it('recreates a missing interrupted file at the recorded path without searching for another file', { timeout: 10000 }, async function() {
		const program = createProgram('2');
		let response = null;
		const fixture = await createOperatorFixture([ program ], request => {
			response = request.res;
			request.res.writeHead(200, { 'Content-Type': 'video/MP2T' });
			request.res.write('RECREATED');
		}, {
			initialRecorded(recordedDir) {
				return [ Object.assign({}, program, {
					recorded: path.join(recordedDir, 'expected.m2ts'),
					operatorResumePending: true,
					operatorInterruptedAt: Date.now() - 1000,
					operatorInterruptionCount: 1
				}) ];
			}
		});
		const expectedPath = path.join(fixture.recordedDir, 'expected.m2ts');

		try {
			await waitForCondition(
				() => !!response && fs.existsSync(expectedPath) && fs.readFileSync(expectedPath, 'utf8') === 'RECREATED',
				'missing interrupted file was not recreated at its recorded path',
				7000
			);
			assert.match(fixture.output(), /WARNING: RESUME RECORDING FILE NOT FOUND, recreate at same path:/);
			assert.strictEqual(fs.existsSync(path.join(fixture.recordedDir, '2.m2ts')), false);
			response.end();
			await waitForCondition(
				() => fixture.read('recording').length === 0 && fixture.read('recorded')[0].operatorResumePending === false,
				'recreated recording did not finalize',
				3000
			);
			assert.strictEqual(fixture.read('recorded')[0].recorded, expectedPath);
		} finally {
			await fixture.close();
		}
	});

	it('protects a future resume-pending path from low-storage cleanup', { timeout: 12000 }, async function() {
		const now = Date.now();
		const pendingProgram = Object.assign(createProgram('2'), { end: now + 60000 });
		const fixture = await createOperatorFixture([], () => {}, {
			initialRecorded(recordedDir) {
				return [ Object.assign({}, pendingProgram, {
					recorded: path.join(recordedDir, 'pending.m2ts'),
					operatorResumePending: true,
					operatorInterruptedAt: now - 1000,
					operatorInterruptionCount: 1
				}) ];
			},
			initialFiles: {
				'pending.m2ts': 'PENDING',
				'deletable.m2ts': 'DELETE'
			},
			config: {
				storageLowSpaceThresholdMB: 1000000000000,
				storageLowSpaceAction: 'remove'
			}
		});
		const pendingPath = path.join(fixture.recordedDir, 'pending.m2ts');
		const deletablePath = path.join(fixture.recordedDir, 'deletable.m2ts');

		try {
			fs.utimesSync(pendingPath, new Date(now - 20000), new Date(now - 20000));
			fs.utimesSync(deletablePath, new Date(now - 10000), new Date(now - 10000));
			await waitForCondition(
				() => !fs.existsSync(deletablePath),
				'low-storage cleanup did not remove the unprotected file',
				8000
			);
			assert.strictEqual(fs.existsSync(pendingPath), true);
			assert.strictEqual(fs.readFileSync(pendingPath, 'utf8'), 'PENDING');
		} finally {
			await fixture.close();
		}
	});

	it('does not run the cleanup action in the low-storage warning band', { timeout: 12000 }, async function() {
		const fixture = await createOperatorFixture([], () => {}, {
			trackNotification: true,
			initialFiles: {
				'warning-only.m2ts': 'KEEP'
			},
			config: {
				storageLowSpaceWarningThresholdMB: 1000000000000,
				storageLowSpaceThresholdMB: 1,
				storageLowSpaceAction: 'remove'
			}
		});
		const warningPath = path.join(fixture.recordedDir, 'warning-only.m2ts');

		try {
			await waitForCondition(
				() => /WARNING: Storage Low Space!/.test(fixture.output()) && fs.existsSync(fixture.notificationLog),
				'low-storage warning notification was not sent',
				8000
			);
			assert.strictEqual(fs.existsSync(warningPath), true);
			assert.doesNotMatch(fixture.output(), /REMOVE: Storage cleanup ->/);
			assert.doesNotMatch(fixture.output(), /STORAGE LOW SPACE ACTION: warning only/);
			const payloads = fs.readFileSync(fixture.notificationLog, 'utf8').trim().split('\n').map(JSON.parse);
			assert.strictEqual(payloads.length, 1);
			assert.strictEqual(payloads[0].event, 'storage-low');
			assert.strictEqual(payloads[0].metadata.phase, 'warning');
		} finally {
			await fixture.close();
		}
	});

	it('records a low-storage cleanup in match history and preserves it through matching', { timeout: 15000 }, async function() {
		const now = Date.now();
		const baseProgram = Object.assign(createProgram('2'), {
			start: now - 120000,
			end: now - 60000,
			seconds: 60
		});
		function recordedProgram(recordedDir) {
			return Object.assign({}, baseProgram, {
				recorded: path.join(recordedDir, 'cleanup.m2ts')
			});
		}
		const fixture = await createOperatorFixture([], () => {}, {
			copyMatching: true,
			initialRecorded(recordedDir) {
				return [ recordedProgram(recordedDir) ];
			},
			initialReserves2() {
				return [ Object.assign({}, baseProgram) ];
			},
			initialMatch(recordedDir) {
				const recorded = recordedProgram(recordedDir);
				const key = matching.makeKeyFromRecorded(recorded);

				return [ matching.buildMatchItem(
					'RECORDED', key, recorded, baseProgram, baseProgram.channel,
					true, true, false, true, false, now, true, {}
				) ];
			},
			initialFiles: {
				'cleanup.m2ts': 'DELETE'
			},
			config: {
				storageLowSpaceThresholdMB: 1000000000000,
				storageLowSpaceAction: 'remove',
				matchUpdateDelayMs: 0
			}
		});
		const cleanupPath = path.join(fixture.recordedDir, 'cleanup.m2ts');

		try {
			await waitForCondition(() => {
				const items = fixture.read('match');
				const result = items[0] && items[0].recordingResult;

				return !fs.existsSync(cleanupPath) &&
					fixture.read('recorded').length === 0 &&
					items[0] && items[0].status === 'RECORDED' &&
					result && result.cleanupState === 'deleted' &&
					result.cleanupReason === 'storage-low' &&
					Number(result.deletedAt) > 0 &&
					/MATCH: updated .*keep_recorded_over_missed=1/.test(fixture.output());
			}, 'low-storage cleanup history was not preserved through matching', 10000);

			const item = fixture.read('match')[0];
			assert.strictEqual(item.status, 'RECORDED');
			[ item.recordingResult, item.recordingResult.snapshot, item.program ].forEach(value => {
				assert.strictEqual(value.fileExists, false);
				assert.strictEqual(value.cleanupState, 'deleted');
				assert.strictEqual(value.cleanupReason, 'storage-low');
				assert.ok(Number(value.deletedAt) > 0);
			});
			assert.match(fixture.output(), /REMOVE: Storage cleanup -> .*cleanup\.m2ts \(6 bytes\)/);
		} finally {
			await fixture.close();
		}
	});
});
