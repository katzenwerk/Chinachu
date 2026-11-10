'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const reservationStore = require('../lib/reservation-store');

const repositoryRoot = path.resolve(__dirname, '..');

function waitForCondition(predicate, message, timeoutMs, fixture) {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		function failure(reason) {
			if (!fixture) return new Error(reason);
			const child = fixture.child;
			return new Error(reason + '\n' + JSON.stringify({
				elapsedMs: Date.now() - startedAt,
				pid: child.pid,
				exitCode: child.exitCode,
				signalCode: child.signalCode,
				spawnError: fixture.childError && fixture.childError.message,
				streamRequests: fixture.requests.map(item => ({ id: item.id, index: item.index }))
			}) + '\nOperator output:\n' + fixture.output());
		}
		const interval = setInterval(() => {
			try {
				if (fixture && (fixture.childError || fixture.child.exitCode !== null || fixture.child.signalCode !== null)) {
					clearInterval(interval);
					reject(failure(message + ': Operator failed before the condition was met'));
					return;
				}
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
				reject(failure(message));
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
	fs.copyFileSync(path.join(repositoryRoot, 'app-operator.js'), path.join(temporaryDir, 'app-operator.js'));
	fs.copyFileSync(path.join(repositoryRoot, 'package.json'), path.join(temporaryDir, 'package.json'));
	fs.writeFileSync(path.join(temporaryDir, 'chinachu'), '#!/usr/bin/env node\nprocess.exit(0);\n');
	fs.chmodSync(path.join(temporaryDir, 'chinachu'), 0o755);
	if (options.trackRecordedCommand) {
		const recordedCommand = path.join(temporaryDir, 'recorded-command.js');
		fs.writeFileSync(recordedCommand, [
			'#!/usr/bin/env node',
			'const fs = require("fs");',
			'const assert = require("node:assert/strict");',
			'const program = JSON.parse(process.argv[3]);',
			'const recorded = JSON.parse(fs.readFileSync("data/recorded.json", "utf8"));',
			'const reserves = JSON.parse(fs.readFileSync("data/reserves.json", "utf8"));',
			'assert.ok(recorded.some(item => item.id === program.id && item.recorded === process.argv[2]));',
			'if (program.isManualReserved) assert.ok(!reserves.some(item => item.id === program.id && item.isManualReserved));',
			'fs.appendFileSync(process.env.CHINACHU_TEST_RECORDED_COMMAND_LOG, process.argv[2] + "\\n");'
		].join('\n') + '\n');
		fs.chmodSync(recordedCommand, 0o755);
		options.config = Object.assign({}, options.config, { recordedCommand: recordedCommand });
	}
	if (options.trackMatching) {
		fs.writeFileSync(path.join(temporaryDir, 'app-matching.js'), 'require("fs").appendFileSync(process.env.CHINACHU_TEST_MATCHING_LOG, "matching\\n");\n');
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
	for (const name of [ 'reserves2', 'recording', 'recorded', 'match' ]) {
		const initial = name === 'recorded' ? initialRecorded : [];
		fs.writeFileSync(path.join(dataDir, name + '.json'), JSON.stringify(initial));
	}
	fs.mkdirSync(recordedDir, { recursive: true });
	Object.keys(options.initialFiles || {}).forEach(fileName => {
		fs.writeFileSync(path.join(recordedDir, fileName), options.initialFiles[fileName]);
	});

	let output = '';
	let child = null;
	let childError = null;
	let recordedLock = null;
	const lockEventsPath = path.join(temporaryDir, 'recorded-lock-events.jsonl');
	const operatorArgs = [ 'app-operator.js' ];
	if (Number.isFinite(options.recordedLockTimeoutMs)) {
		// Exercise the real lock and Operator retry/recovery code. Only shorten
		// this fixture's lock deadline; leave retry delays and all other locks intact.
		const preloadPath = path.join(temporaryDir, 'recorded-lock-fixture.js');
		fs.writeFileSync(preloadPath, [
			'const fs = require("fs");',
			'const path = require("path");',
			'const store = require("./lib/reservation-store");',
			'const original = store.withLockAsync;',
			'const target = path.resolve("data/recorded.json");',
			'const log = event => fs.appendFileSync(' + JSON.stringify(lockEventsPath) + ', JSON.stringify({event, at: Date.now()}) + "\\n");',
			'store.withLockAsync = async function(file, callback, options) {',
			'  if (path.resolve(file) !== target) return original(file, callback, options);',
			'  log("attempt");',
			'  try {',
			'    return await original(file, callback, Object.assign({}, options, {timeoutMs: ' + options.recordedLockTimeoutMs + '}));',
			'  } catch (error) { log(error.code); throw error; }',
			'};'
		].join('\n') + '\n');
		operatorArgs.unshift('--require', preloadPath);
		recordedLock = reservationStore.acquire(path.join(dataDir, 'recorded.json'), { timeoutMs: 0 });
	}

	function releaseRecordedLock() {
		if (!recordedLock) return;
		recordedLock.release();
		recordedLock = null;
	}

	function startOperator() {
		childError = null;
		child = childProcess.spawn(process.execPath, operatorArgs, {
			cwd: temporaryDir,
			stdio: [ 'ignore', 'pipe', 'pipe' ],
			env: Object.assign({}, process.env, {
					CHINACHU_TEST_RECORDED_COMMAND_LOG: recordedCommandLog,
					CHINACHU_TEST_MATCHING_LOG: matchingLog,
					CHINACHU_TEST_FFPROBE_LOG: ffprobeLog,
					CHINACHU_RUNTIME_DIR: path.join(temporaryDir, 'runtime')
			})
		});
		child.once('error', error => { childError = error; });
		child.stdout.on('data', chunk => { output += chunk.toString(); });
		child.stderr.on('data', chunk => { output += chunk.toString(); });
		return child;
	}

	async function stopOperator() {
		if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) {
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
		ffprobeLog,
		releaseRecordedLock,
		lockEvents() {
			return fs.existsSync(lockEventsPath) ? fs.readFileSync(lockEventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
		},
		get child() {
			return child;
		},
		get childError() {
			return childError;
		},
		output: () => output,
		read(name) {
			return JSON.parse(fs.readFileSync(path.join(dataDir, name + '.json'), 'utf8'));
		},
		start: startOperator,
		gracefulStop(signal) {
			return signalOperator(signal || 'SIGINT');
		},
		async close() {
			await stopOperator();
			releaseRecordedLock();
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
				10000, fixture
			);
			assert.ok(fixture.read('recording').some(item => item.id === '2'));
			assert.doesNotMatch(fixture.output(), /DROP STREAM ERROR: #2\b/);
		} finally {
			await fixture.close();
		}
	});

	it('resumes shutdown-interrupted rule and active manual recordings but not a released manual reserve', { timeout: 45000 }, async function() {
		for (const scenario of [
			{ name: 'rule', program: createProgram('2') },
			{ name: 'manual', program: createProgram('2', { isManualReserved: true }) }
		]) {
			const responses = [];
			const fixture = await createOperatorFixture([ scenario.program ], request => {
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
					'initial ' + scenario.name + ' recording did not start',
					7000, fixture
				);

				const exit = await fixture.gracefulStop('SIGINT');
				assert.deepStrictEqual(exit, { code: 0, signal: null });

				const interrupted = fixture.read('recorded');
				assert.strictEqual(interrupted.length, 1);
				assert.strictEqual(interrupted[0].operatorResumePending, true);
				assert.ok(interrupted[0].operatorInterruptedAt > 0);
				assert.strictEqual(interrupted[0].operatorInterruptionCount, 1);
				assert.strictEqual(interrupted[0].recorded, recordedPath);
				assert.strictEqual(interrupted[0].isManualReserved, scenario.program.isManualReserved);
				assert.deepStrictEqual(fixture.read('recording'), []);
				assert.strictEqual(fixture.read('reserves').length, 1);
				assert.strictEqual(fs.existsSync(fixture.recordedCommandLog), false);
				assert.strictEqual(fs.existsSync(fixture.matchingLog), false);
				assert.strictEqual(fs.existsSync(fixture.ffprobeLog), false);
				assert.match(fixture.output(), /FIN INTERRUPTED: resume pending: #2\b/);

				fixture.start();
				await waitForCondition(
					() => fixture.requests.length === 2 && fs.readFileSync(recordedPath, 'utf8') === 'PART1PART2',
					'interrupted ' + scenario.name + ' recording did not append at the same path',
					7000, fixture
				);
				responses[1].end();

				await waitForCondition(
					() => fixture.read('recording').length === 0 &&
						fixture.read('recorded').length === 1 &&
						fixture.read('recorded')[0].operatorResumePending === false &&
						fs.existsSync(fixture.recordedCommandLog) &&
						fs.existsSync(fixture.matchingLog),
					'final ' + scenario.name + ' recording completion work did not finish',
					20000 // Recording completion is immediate; optional match waits out the 15s handoff window.
				);
				await waitForCondition(
					() => fixture.read('recorded')[0].recordedDurationSeconds === 10.500001,
					'final resumed ' + scenario.name + ' recording was not probed',
					3000
				);

				const finalized = fixture.read('recorded')[0];
				assert.strictEqual(finalized.recorded, recordedPath);
				assert.strictEqual(finalized.operatorInterruptionCount, 1);
				assert.ok(finalized.operatorResumedAt >= finalized.operatorInterruptedAt);
				assert.strictEqual(fixture.read('reserves').length, scenario.program.isManualReserved ? 0 : 1);
				assert.strictEqual(fs.readFileSync(recordedPath, 'utf8'), 'PART1PART2');
				assert.strictEqual(fs.readFileSync(fixture.recordedCommandLog, 'utf8').trim().split('\n').length, 1);
				assert.ok(fs.readFileSync(fixture.matchingLog, 'utf8').trim().split('\n').length >= 1);
				assert.strictEqual(fs.readFileSync(fixture.ffprobeLog, 'utf8').trim().split('\n').length, 1);
				assert.match(fixture.output(), /RESUME RECORD: #2\b/);
			} finally {
				await fixture.close();
			}
		}

		const releasedProgram = createProgram('2', { isManualReserved: true });
		const releasedFixture = await createOperatorFixture([ releasedProgram ], request => {
			request.res.writeHead(200, { 'Content-Type': 'video/MP2T' });
			request.res.write('PART' + request.index);
		});
		const releasedPath = path.join(releasedFixture.recordedDir, '2.m2ts');

		try {
			await waitForCondition(
				() => fs.existsSync(releasedPath) && fs.readFileSync(releasedPath, 'utf8') === 'PART1',
				'initial released manual recording did not start',
				7000, releasedFixture
			);
			fs.writeFileSync(path.join(releasedFixture.dataDir, 'reserves.json'), '[]');
			await waitForCondition(
				() => (releasedFixture.output().match(/READ: .*reserves\.json.*updated/g) || []).length >= 2,
				'operator did not reload the released manual reserve',
				3000
			);

			const exit = await releasedFixture.gracefulStop('SIGINT');
			assert.deepStrictEqual(exit, { code: 0, signal: null });
			assert.strictEqual(releasedFixture.read('recorded')[0].operatorResumePending, undefined);
			assert.deepStrictEqual(releasedFixture.read('reserves'), []);

			const readCount = (releasedFixture.output().match(/READ: .*reserves\.json/g) || []).length;
			releasedFixture.start();
			await waitForCondition(
				() => (releasedFixture.output().match(/READ: .*reserves\.json/g) || []).length > readCount,
				'restarted operator did not reload released reserves',
				3000
			);
			await new Promise(resolve => setTimeout(resolve, 1200));
			assert.strictEqual(releasedFixture.requests.length, 1);
		} finally {
			await releasedFixture.close();
		}
	});

	it('retains eight concurrent completions through recorded lock timeout and rereads before retry', { timeout: 25000 }, async function() {
		const programs = Array.from({ length: 8 }, (_, index) => createProgram(String(index + 2), { isManualReserved: true }));
		const responses = [];
		const fixture = await createOperatorFixture(programs, request => {
			responses.push(request.res);
			request.res.writeHead(200, { 'Content-Type': 'video/MP2T' });
			request.res.write('PART1');
		}, {
			recordedLockTimeoutMs: 4000,
			trackRecordedCommand: true,
			initialRecorded: recordedDir => [ { id: 'old', recorded: path.join(recordedDir, 'old.m2ts'), recordedDurationSeconds: 10 } ]
		});
		try {
			await waitForCondition(() => responses.length === 8 && programs.every(program =>
				fs.existsSync(path.join(fixture.recordedDir, program.id + '.m2ts')) &&
				fs.readFileSync(path.join(fixture.recordedDir, program.id + '.m2ts'), 'utf8') === 'PART1'),
			'all eight fixture streams did not start', 7000, fixture);
			responses.forEach(response => response.end('PART2'));
			await waitForCondition(() => fixture.lockEvents().length > 0 &&
				fixture.read('recording').filter(program => program._operatorHistoryPending).length === 8,
			'concurrent completions were not retained while the first save waited', 2000);
			assert.strictEqual(fixture.read('recorded').length, 1);
			assert.strictEqual(fs.existsSync(fixture.recordedCommandLog), false);

			// The child must process a watcher event before the held lock times out.
			const reads = (fixture.output().match(/READ: .*reserves\.json.*updated/g) || []).length;
			const future = Object.assign(createProgram('91'), { start: Date.now() + 3600000, end: Date.now() + 3660000 });
			reservationStore.writeArrayAtomic(path.join(fixture.dataDir, 'reserves.json'), programs.concat(future));
			await waitForCondition(() => (fixture.output().match(/READ: .*reserves\.json.*updated/g) || []).length > reads,
			'Operator event loop blocked during recorded lock acquisition', 1500);
			assert.strictEqual(fixture.lockEvents().filter(event => event.event === 'RESERVATION_LOCK_TIMEOUT').length, 0);
			await waitForCondition(() => fixture.lockEvents().some(event => event.event === 'RESERVATION_LOCK_TIMEOUT'),
			'the held recorded lock did not time out', 5000);
			assert.strictEqual(fixture.read('recording').length, 8);

			// Another writer commits while owning the lock. Retry must use these
			// rows rather than the Operator's pre-timeout in-memory snapshot.
			const latest = fixture.read('recorded');
			latest[0].recordedDurationSeconds = 321;
			latest.push({ id: 'concurrent', recorded: path.join(fixture.recordedDir, 'concurrent.m2ts') });
			reservationStore.writeArrayAtomic(path.join(fixture.dataDir, 'recorded.json'), latest);
			fixture.releaseRecordedLock();
			await waitForCondition(() => fixture.read('recording').length === 0 &&
				fs.existsSync(fixture.recordedCommandLog) &&
				fs.readFileSync(fixture.recordedCommandLog, 'utf8').trim().split('\n').length === 8,
			'all eight saves and post-save hooks did not complete', 7000);
			const recorded = fixture.read('recorded');
			assert.strictEqual(recorded.length, 10);
			assert.strictEqual(new Set(recorded.map(program => program.id)).size, 10);
			assert.deepStrictEqual(recorded.filter(program => !programs.some(item => item.id === program.id)), latest);
			assert.deepStrictEqual(recorded.slice(2).map(program => program.id),
				(fixture.output().match(/FIN SAVE PENDING: #[2-9]\b/g) || []).map(line => line.slice(-1)));
			for (const program of programs) {
				assert.strictEqual(recorded.find(item => item.id === program.id).recorded, path.join(fixture.recordedDir, program.id + '.m2ts'));
				assert.strictEqual(fs.readFileSync(path.join(fixture.recordedDir, program.id + '.m2ts'), 'utf8'), 'PART1PART2');
			}
			assert.deepStrictEqual(fixture.read('reserves').map(program => program.id), ['91']);
			assert.strictEqual(new Set(fs.readFileSync(fixture.recordedCommandLog, 'utf8').trim().split('\n')).size, 8);
			assert.match(fixture.output(), /recorded lock busy \(recorded finalize\); retry 1/);
			assert.doesNotMatch(fixture.output(), /recording finalization incomplete/);
		} finally {
			await fixture.close();
		}
	});

	it('retains unsaved history after retry exhaustion and recovers it idempotently on restart', { timeout: 25000 }, async function() {
		const program = createProgram('2', { isManualReserved: true });
		let response;
		const fixture = await createOperatorFixture([program], request => {
			response = request.res;
			response.writeHead(200, { 'Content-Type': 'video/MP2T' });
			response.write('PART1');
		}, {
			recordedLockTimeoutMs: 0,
			trackRecordedCommand: true,
			initialRecorded: recordedDir => [ { id: 'old', recorded: path.join(recordedDir, 'old.m2ts'), recordedDurationSeconds: 321 } ]
		});
		try {
			await waitForCondition(() => response && fs.existsSync(path.join(fixture.recordedDir, '2.m2ts')) &&
				fs.readFileSync(path.join(fixture.recordedDir, '2.m2ts'), 'utf8') === 'PART1',
			'fixture recording did not start', 7000, fixture);
			response.end('PART2');
			await waitForCondition(() => /recording finalization incomplete #2:/.test(fixture.output()),
			'failed save was not reported after bounded retries', 10000);
			assert.strictEqual(fixture.lockEvents().filter(event => event.event === 'RESERVATION_LOCK_TIMEOUT').length, 3);
			assert.strictEqual(fixture.read('recorded').length, 1);
			const recovery = fixture.read('recording');
			assert.strictEqual(recovery.length, 1);
			assert.strictEqual(recovery[0]._operatorHistoryPending, true);
			assert.ok(recovery[0].operatorRecordingEnd);
			assert.strictEqual(fixture.read('reserves').length, 1);
			assert.strictEqual(fs.existsSync(fixture.recordedCommandLog), false);
			assert.doesNotMatch(fixture.output(), /FIN: #2\b/);
			assert.deepStrictEqual(await fixture.gracefulStop(), { code: 1, signal: null });
			assert.deepStrictEqual(fixture.read('recording'), recovery);

			const oldHistory = fixture.read('recorded')[0];
			fixture.releaseRecordedLock();
			fixture.start();
			await waitForCondition(() => fixture.read('recording').length === 0 &&
				fs.existsSync(fixture.recordedCommandLog) && /RECOVERED HISTORY: #2\b/.test(fixture.output()),
			'unsaved history did not recover after restarting Operator', 5000);
			const saved = fixture.read('recorded');
			assert.strictEqual(saved.length, 2);
			assert.deepStrictEqual(saved[0], oldHistory);
			assert.strictEqual(saved[1].id, '2');
			assert.strictEqual(saved[1].recorded, recovery[0].recorded);
			assert.strictEqual(saved[1].operatorRecordingStart, recovery[0].operatorRecordingStart);
			assert.strictEqual(saved[1].operatorRecordingEnd, recovery[0].operatorRecordingEnd);
			assert.strictEqual(saved[1]._operatorHistoryPending, undefined);
			assert.deepStrictEqual(fixture.read('reserves'), []);
			assert.strictEqual(fixture.requests.length, 1, 'recovery must not record the completed program again');
			assert.deepStrictEqual(await fixture.gracefulStop(), { code: 0, signal: null });

			// Replaying the durable snapshot after a crash must retain a later
			// ffprobe update, rather than overwrite it or register the ID twice.
			saved[1].recordedDurationSeconds = 123;
			reservationStore.writeArrayAtomic(path.join(fixture.dataDir, 'recorded.json'), saved);
			reservationStore.writeArrayAtomic(path.join(fixture.dataDir, 'recording.json'), recovery);
			const recoveredCount = (fixture.output().match(/RECOVERED HISTORY: #2\b/g) || []).length;
			fixture.start();
			await waitForCondition(() => fixture.read('recording').length === 0 &&
				(fixture.output().match(/RECOVERED HISTORY: #2\b/g) || []).length > recoveredCount &&
				fs.readFileSync(fixture.recordedCommandLog, 'utf8').trim().split('\n').length === 2,
			'recovery replay did not finish', 5000);
			assert.deepStrictEqual(fixture.read('recorded'), saved);
			assert.strictEqual(fixture.requests.length, 1);
			assert.deepStrictEqual(fixture.read('reserves'), []);
		} finally {
			await fixture.close();
		}
	});

	it('does not scan or clean an idle filesystem while preserving a future resume-pending path', { timeout: 12000 }, async function() {
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
			await new Promise(resolve => setTimeout(resolve, 1500));
			assert.strictEqual(fs.existsSync(pendingPath), true);
			assert.strictEqual(fs.existsSync(deletablePath), true);
			assert.strictEqual(fs.readFileSync(pendingPath, 'utf8'), 'PENDING');
			assert.doesNotMatch(fixture.output(), /Storage cleanup/);
		} finally {
			await fixture.close();
		}
	});

});
