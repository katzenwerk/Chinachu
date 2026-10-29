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
		fs.writeFileSync(recordedCommand, '#!/usr/bin/env node\nrequire("fs").appendFileSync(process.env.CHINACHU_TEST_RECORDED_COMMAND_LOG, process.argv[2] + "\\n");\n');
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

	function startOperator() {
		child = childProcess.spawn(process.execPath, [ 'app-operator.js' ], {
			cwd: temporaryDir,
			stdio: [ 'ignore', 'pipe', 'pipe' ],
			env: Object.assign({}, process.env, {
					CHINACHU_TEST_RECORDED_COMMAND_LOG: recordedCommandLog,
					CHINACHU_TEST_MATCHING_LOG: matchingLog,
					CHINACHU_TEST_FFPROBE_LOG: ffprobeLog,
					CHINACHU_RUNTIME_DIR: path.join(temporaryDir, 'runtime')
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
		ffprobeLog,
		get child() {
			return child;
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
				10000
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
					7000
				);
				responses[1].end();

				await waitForCondition(
					() => fixture.read('recording').length === 0 &&
						fixture.read('recorded').length === 1 &&
						fixture.read('recorded')[0].operatorResumePending === false &&
						fs.existsSync(fixture.recordedCommandLog) &&
						fs.existsSync(fixture.matchingLog),
					'final ' + scenario.name + ' recording completion work did not finish',
					5000
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
				7000
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
