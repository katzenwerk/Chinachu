'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const repositoryRoot = path.resolve(__dirname, '..');
const schedulerState = require('../lib/scheduler-state');
const reservationStore = require('../lib/reservation-store');

function commonState(overrides) {
	return Object.assign({
		version: 3,
		lastSchedulerStartedAt: 0,
		lastSchedulerSuccessAt: 0,
		lastAppliedParentId: null,
		lastAppliedAt: 0,
		baselines: schedulerState.emptyBaselines()
	}, overrides || {});
}

function writeFixture(mode, options = {}) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-scheduler-receipt-'));
	const binDirectory = path.join(directory, 'bin');
	const nodeModules = path.join(directory, 'node_modules');
	const mirakurunModule = path.join(nodeModules, 'mirakurun');

	fs.mkdirSync(path.join(directory, 'data'));
	fs.mkdirSync(path.join(directory, 'log'));
	fs.mkdirSync(binDirectory);
	fs.mkdirSync(nodeModules);
	fs.mkdirSync(mirakurunModule);
	fs.symlinkSync(path.join(repositoryRoot, 'lib'), path.join(directory, 'lib'), 'dir');
	[ 'opts', 'dateformat', 'chinachu-common', 'easy-table' ].forEach(name => {
		fs.symlinkSync(path.join(repositoryRoot, 'node_modules', name), path.join(nodeModules, name), 'dir');
	});

	const schedulerSource = fs.readFileSync(path.join(repositoryRoot, 'app-scheduler.js'), 'utf8').replace(
		"child_process.execSync('renice -n 19 -p ' + process.pid);",
		'void process.pid; // fixture: avoid changing process priority'
	);
	fs.writeFileSync(path.join(directory, 'app-scheduler.js'), schedulerSource);
	fs.copyFileSync(path.join(repositoryRoot, 'app-cli.js'), path.join(directory, 'app-cli.js'));
	fs.copyFileSync(path.join(repositoryRoot, 'app-matching.js'), path.join(directory, 'app-matching.js'));
	fs.copyFileSync(path.join(repositoryRoot, 'chinachu'), path.join(directory, 'chinachu'));
	fs.chmodSync(path.join(directory, 'chinachu'), 0o755);
	fs.writeFileSync(path.join(binDirectory, 'renice'), '#!/bin/sh\nexit 0\n');
	fs.chmodSync(path.join(binDirectory, 'renice'), 0o755);
	fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: 'test' }));
	fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({
		mirakurunPath: 'http://127.0.0.1:40772/',
		recordedDir: path.join(directory, 'recorded'),
		recordedFormat: '<id>.m2ts',
		mirakurunDropCheckIntervalSec: 0,
		storageLowSpaceAction: 'none',
		recordedDirs: [
			{ id: 'recorded-a', path: path.join(directory, 'recorded-a') },
			{ id: 'recorded-b', path: path.join(directory, 'recorded-b') }
		]
	}));
	fs.writeFileSync(path.join(directory, 'rules.json'), JSON.stringify(options.rules || []));
	[ 'schedule', 'reserves', 'reserves2', 'recording', 'recorded', 'match' ].forEach(name => {
		fs.writeFileSync(path.join(directory, 'data', name + '.json'), JSON.stringify(name === 'reserves' ? (options.reserves || []) : []));
	});

	fs.writeFileSync(path.join(mirakurunModule, 'package.json'), JSON.stringify({ main: 'index.js' }));
	fs.writeFileSync(path.join(mirakurunModule, 'index.js'), [
		"'use strict';",
		'class FakeMirakurun {',
		"  constructor() { this.basePath = '/api'; }",
		mode === 'failure'
			? "  getServices() { return Promise.reject(new Error('test Mirakurun failure')); }"
			: '  getServices() { return Promise.resolve(' + JSON.stringify(options.services || []) + '); }',
		'  getPrograms() { return Promise.resolve(' + JSON.stringify(options.programs || []) + '); }',
		'  getTuners() { return Promise.resolve(' + JSON.stringify(options.tuners || []) + '); }',
		"  getEventsStream() { const stream = new (require('events').EventEmitter)(); stream.destroy = function () {}; return stream; }",
		'}',
		'module.exports = { default: FakeMirakurun };'
	].join('\n'));

	return directory;
}

function runUpdate(directory) {
	return childProcess.spawnSync('bash', [ './chinachu', 'update' ], {
		cwd: directory,
		env: Object.assign({}, process.env, {
			PATH: path.join(directory, 'bin') + ':' + process.env.PATH,
			CHINACHU_RUNTIME_DIR: path.join(directory, 'runtime')
		}),
		encoding: 'utf8'
	});
}

function runCli(directory, mode, id) {
	return childProcess.spawnSync(process.execPath, [ 'app-cli.js', '-mode', mode, '-id', id ], {
		cwd: directory,
		encoding: 'utf8'
	});
}

function readData(directory, name) {
	return JSON.parse(fs.readFileSync(path.join(directory, 'data', name + '.json'), 'utf8'));
}

function duplicateFixtureOptions(reverseServices) {
	const startAt = Date.now() + 3600000;
	const low = { id: 1001, serviceId: 1, networkId: 1, name: 'Low SID', channel: { type: 'GR', channel: '27' } };
	const high = { id: 1002, serviceId: 2, networkId: 1, name: 'High SID', channel: { type: 'GR', channel: '27' } };
	return {
		startAt,
		lowId: (1001001).toString(36),
		highId: (1002001).toString(36),
		services: reverseServices ? [ high, low ] : [ low, high ],
		programs: [
			{ id: 1001001, serviceId: 1, networkId: 1, name: 'Same show', description: '', startAt, duration: 1800000 },
			{ id: 1002001, serviceId: 2, networkId: 1, name: 'Same show', description: '', startAt, duration: 1800000 }
		]
	};
}

function multiProgramFixtureOptions(rules) {
	const startAt = Date.now() + 3600000;
	const services = [1, 2].map(sid => ({
		id: 1000 + sid,
		serviceId: sid,
		networkId: 1,
		name: 'Service ' + sid,
		channel: { type: 'GR', channel: String(26 + sid) }
	}));
	return {
		rules,
		tuners: [{ types: ['GR'] }],
		services,
		programs: services.map((service, index) => ({
			id: (1000 + service.serviceId) * 1000 + 1,
			serviceId: service.serviceId,
			networkId: 1,
			name: 'Fixture ' + service.serviceId,
			description: '',
			startAt: startAt + index * 1000,
			duration: 1800000
		}))
	};
}

function instrumentScheduler(directory, target, marker) {
	const file = path.join(directory, 'app-scheduler.js');
	const source = fs.readFileSync(file, 'utf8');
	const markerFile = path.join(directory, 'data', marker + '.ready');
	const usedFile = path.join(directory, 'data', marker + '.used');
	const releaseFile = path.join(directory, 'data', marker + '.release');
	const fifo = childProcess.spawnSync('mkfifo', [ releaseFile ], { encoding: 'utf8' });
	assert.strictEqual(fifo.status, 0, fifo.stderr);
	assert.match(source, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
	fs.writeFileSync(file, source.replace(
		target,
		target + '\n\t\tfs.writeFileSync(' + JSON.stringify(markerFile) + ", 'ready');" +
			" console.log('" + marker + "');" +
			' if (!fs.existsSync(' + JSON.stringify(usedFile) + ')) {' +
			' fs.writeFileSync(' + JSON.stringify(usedFile) + ", 'used');" +
			' fs.readFileSync(' + JSON.stringify(releaseFile) + ');' +
			' fs.unlinkSync(' + JSON.stringify(releaseFile) + '); }'
	));
	return releaseFile;
}

function runUpdateWithCliAtMarker(directory, marker, mode, id, options) {
	options = options || {};
	const markerFile = path.join(directory, 'data', marker + '.ready');
	const releaseFile = path.join(directory, 'data', marker + '.release');
	if (options.releaseWhenCliAttemptsLock) {
		const cliFile = path.join(directory, 'app-cli.js');
		const cliSource = fs.readFileSync(cliFile, 'utf8');
		const lockCall = 'return reservationStore.withLock(RESERVES_DATA_FILE, function () {';
		assert.match(cliSource, new RegExp(lockCall.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
		fs.writeFileSync(cliFile, cliSource.replace(
			lockCall,
			'fs.writeFileSync(' + JSON.stringify(releaseFile) + ", 'attempt');\n\t\t" + lockCall
		));
	}
	return new Promise((resolve, reject) => {
		let watcher;
		const child = childProcess.spawn('bash', [ './chinachu', 'update' ], {
			cwd: directory,
			env: Object.assign({}, process.env, {
				PATH: path.join(directory, 'bin') + ':' + process.env.PATH,
				CHINACHU_RUNTIME_DIR: path.join(directory, 'runtime')
			}),
			stdio: [ 'ignore', 'pipe', 'pipe' ]
		});
		let output = '';
		let cli = null;
		let cliOutput = '';
		let startedCli = false;
		const startCli = () => {
			if (startedCli || !fs.existsSync(markerFile)) return;
			startedCli = true;
			if (watcher) watcher.close();
			cli = childProcess.spawn(process.execPath, [ 'app-cli.js', '-mode', mode, '-id', id ], {
				cwd: directory,
				stdio: [ 'ignore', 'pipe', 'pipe' ]
			});
			cli.stdout.on('data', cliChunk => { cliOutput += cliChunk.toString(); });
			cli.stderr.on('data', cliChunk => { cliOutput += cliChunk.toString(); });
			if (!options.releaseWhenCliAttemptsLock) {
				cli.once('close', () => fs.writeFileSync(releaseFile, 'continue'));
			}
		};
		watcher = fs.watch(path.join(directory, 'data'), startCli);
		child.stdout.on('data', chunk => {
			output += chunk.toString();
			startCli();
		});
		child.stderr.on('data', chunk => { output += chunk.toString(); });
		child.once('error', reject);
		child.once('close', async status => {
			if (watcher) watcher.close();
			if (!startedCli || !cli) {
				reject(new Error('scheduler marker was not observed: ' + output));
				return;
			}
			const cliStatus = cli.exitCode === null ? await new Promise(done => cli.once('close', done)) : cli.exitCode;
			resolve({ status, output, cliStatus, cliOutput });
		});
	});
}

describe('Common scheduler persistent state', function() {
	it('preserves the version 3 state contract and rejects unsafe current state', function() {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-scheduler-state-'));
		const file = path.join(directory, 'scheduler-state.json');
		const legacy = path.join(directory, 'epg-scheduler-state.json');
		try {
			const store = new schedulerState.SchedulerStateStore(file, { legacyFilePath: legacy });
			assert.deepStrictEqual(store.load(), commonState());

			store.save(commonState({
				lastSchedulerStartedAt: 3000,
				lastSchedulerSuccessAt: 4000,
				lastAppliedParentId: 'parent-1',
				lastAppliedAt: 2000
			}));
			assert.deepStrictEqual(fs.readdirSync(directory), [ 'scheduler-state.json' ]);
			assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);

			store.recordSchedulerSuccess(5000, 6000);
			assert.deepStrictEqual(store.load(), commonState({
				lastSchedulerStartedAt: 5000,
				lastSchedulerSuccessAt: 6000,
				lastAppliedParentId: 'parent-1',
				lastAppliedAt: 2000
			}));

			fs.writeFileSync(file, '{broken');
			fs.writeFileSync(legacy, JSON.stringify({ version: 1 }));
			assert.throws(() => store.load(), /Unexpected token|Expected property name/);
			assert.strictEqual(fs.readFileSync(file, 'utf8'), '{broken');
			assert.throws(() => schedulerState.normalizeState({ version: 1 }), /unsupported state version/);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe('Common scheduler success receipt', function() {
	it('records a direct ./chinachu update success in the common state', function() {
		const directory = writeFixture('success');
		const stateFile = path.join(directory, 'data', 'scheduler-state.json');
		try {
			const store = new schedulerState.SchedulerStateStore(stateFile);
			const before = Date.now();
			const result = runUpdate(directory);
			const after = Date.now();

			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			const saved = store.load();
			assert.ok(saved.lastSchedulerStartedAt >= before);
			assert.ok(saved.lastSchedulerStartedAt <= saved.lastSchedulerSuccessAt);
			assert.ok(saved.lastSchedulerSuccessAt <= after);
			[ 'rules', 'config', 'reserves', 'services', 'tuners', 'recorded' ].forEach(name => {
				assert.ok(saved.baselines[name] && typeof saved.baselines[name].hash === 'string');
			});
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('does not advance a successful baseline when scheduler processing fails', function() {
		const directory = writeFixture('failure');
		const stateFile = path.join(directory, 'data', 'scheduler-state.json');
		try {
			const store = new schedulerState.SchedulerStateStore(stateFile);
			store.recordSchedulerSuccess(1000, 2000);
			const result = runUpdate(directory);

			assert.notStrictEqual(result.status, 0);
			assert.match(result.stdout + result.stderr, /test Mirakurun failure/);
			assert.strictEqual(store.load().lastSchedulerStartedAt, 1000);
			assert.strictEqual(store.load().lastSchedulerSuccessAt, 2000);
			assert.deepStrictEqual(store.load().baselines, schedulerState.emptyBaselines());
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('keeps a corrupted current state untouched and still completes scheduler work', function() {
		const directory = writeFixture('success');
		const stateFile = path.join(directory, 'data', 'scheduler-state.json');
		try {
			fs.writeFileSync(stateFile, '{broken');
			const result = runUpdate(directory);

			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			assert.match(result.stdout + result.stderr, /WARNING: scheduler state save failed:/);
			assert.strictEqual(fs.readFileSync(stateFile, 'utf8'), '{broken');
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe('Scheduler reservation snapshot propagation', function() {
	it('reservation store waits asynchronously and rereads after a Cleaner-style deletion', async function() {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-reservation-store-race-'));
		const historyFile = path.join(directory, 'reserves2.json');
		const oldHistory = { id: 'old-history', start: 1, end: 2, seconds: 1, channel: { id: 'old' } };
		const currentReserve = { id: 'current', start: 3, end: 4, seconds: 1, channel: { id: 'current' } };
		const asyncReserve = { id: 'async-current', start: 5, end: 6, seconds: 1, channel: { id: 'async' } };
		fs.writeFileSync(historyFile, JSON.stringify([oldHistory]));
		const cleanerLock = reservationStore.acquire(historyFile);
		let released = false;
		let asyncSaved = null;
		try {
			assert.throws(() => reservationStore.updateArrayAtomic(historyFile, current => current, {
				lock: { timeoutMs: 0 }
			}), error => error.code === 'RESERVATION_LOCK_TIMEOUT');
			assert.deepStrictEqual(JSON.parse(fs.readFileSync(historyFile, 'utf8')), [oldHistory]);
			// Wait in this process while a synchronous Scheduler-style writer
			// starts in another. The IPC release below cannot run if this wait
			// blocks the event loop. Both writers must reread after the deletion.
			asyncSaved = reservationStore.withLockAsync(historyFile, () => {
				const latest = reservationStore.readArray(historyFile);
				reservationStore.writeArrayAtomic(historyFile, latest.concat([asyncReserve]));
			});
			asyncSaved.catch(() => {}); // The result is awaited below, including failures.
			const script = [
				"const store = require(process.argv[1]);",
				"const file = process.argv[2];",
				"const item = JSON.parse(process.argv[3]);",
				"if (process.send) process.send('READY');",
				"store.updateArrayAtomic(file, current => current.concat([item]));"
			].join('\n');
			const child = childProcess.spawn(process.execPath, [
				'-e', script, path.join(repositoryRoot, 'lib/reservation-store.js'), historyFile, JSON.stringify(currentReserve)
			], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
			let stderr = '';
			const completed = new Promise((resolve, reject) => {
				child.on('message', message => {
					if (!released && message === 'READY') {
						reservationStore.writeArrayAtomic(historyFile, []);
						cleanerLock.release();
						released = true;
					}
				});
				child.stderr.on('data', chunk => { stderr += chunk.toString(); });
				child.once('error', reject);
				child.once('close', status => resolve({ status, stderr }));
			});
			const result = await completed;
			assert.strictEqual(result.status, 0, result.stderr);
			await asyncSaved;
			const saved = JSON.parse(fs.readFileSync(historyFile, 'utf8')).sort((left, right) => left.id.localeCompare(right.id));
			assert.deepStrictEqual(saved, [asyncReserve, currentReserve]);
		} finally {
			if (!released) cleanerLock.release();
			if (asyncSaved) await asyncSaved.catch(() => {});
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	function assertSnapshots(directory, expectedById) {
		['reserves', 'reserves2'].forEach(name => {
			const rows = readData(directory, name);
			assert.strictEqual(rows.length, Object.keys(expectedById).length, name);
			rows.forEach(row => {
				const expected = expectedById[row.id];
				assert.ok(expected, name + ': unexpected program ' + row.id);
				Object.keys(expected).forEach(key => {
					assert.deepStrictEqual(row[key], expected[key], name + '.' + row.id + '.' + key);
				});
			});
		});
	}

	it('preserves legacy index and unresolved destination snapshots', function() {
		const rules = [ { sid: 1 }, { sid: 2, recordedDirId: 'missing' } ];
		const directory = writeFixture('success', multiProgramFixtureOptions(rules));
		try {
			const result = runUpdate(directory);
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			assertSnapshots(directory, {
				[(1001001).toString(36)]: { ruleId: 0, ruleIdSource: 'index', ruleUid: undefined, recordedDirId: undefined, recordedDir: undefined },
				[(1002001).toString(36)]: { ruleId: 1, ruleIdSource: 'index', ruleUid: undefined, recordedDirId: 'missing', recordedDir: undefined }
			});
			assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(directory, 'rules.json'), 'utf8')), rules);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('preserves numeric ID zero and the last matching rule metadata', function() {
		const rules = [
			{ id: 0, sid: 1 },
			{ sid: 2, recordedDirId: 'recorded-a' },
			{ id: 'rule-recorded', ruleUid: 'uid-recorded-b', sid: 2, recordedDirId: ' recorded-b ', recorded_format: '<title>/<id>.m2ts' }
		];
		const directory = writeFixture('success', multiProgramFixtureOptions(rules));
		try {
			const result = runUpdate(directory);
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			assertSnapshots(directory, {
				[(1001001).toString(36)]: { ruleId: 0, ruleIdSource: 'id', ruleUid: undefined, recordedDirId: undefined, recordedDir: undefined },
				[(1002001).toString(36)]: {
					ruleId: 'rule-recorded', ruleIdSource: 'id', ruleUid: 'uid-recorded-b',
					recordedDirId: 'recorded-b', recordedDir: path.join(directory, 'recorded-b') + '/',
					recordedFormat: '<title>/<id>.m2ts'
				}
			});
			assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(directory, 'rules.json'), 'utf8')), rules);
			['recorded-a', 'recorded-b', 'recorded'].forEach(name => assert.strictEqual(fs.existsSync(path.join(directory, name)), false));
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe('Scheduler Skip and duplicate reservation boundaries', function() {
	it('keeps a skipped duplicate stable and returns to the low SID after Unskip regardless of service order', function() {
		const runInitialSelection = reverseServices => {
			const fixture = duplicateFixtureOptions(reverseServices);
			const directory = writeFixture('success', {
				rules: [{ ruleUid: 'stable-rule', recordedDirId: 'recorded-a', recorded_format: '<title>/<id>.m2ts' }],
				tuners: [{ types: ['GR'] }],
				services: fixture.services,
				programs: fixture.programs
			});

			try {
				const result = runUpdate(directory);
				assert.strictEqual(result.status, 0, result.stdout + result.stderr);
				assert.deepStrictEqual(readData(directory, 'reserves').map(program => program.id), [ fixture.lowId ]);
				return { fixture, directory };
			} catch (error) {
				fs.rmSync(directory, { recursive: true, force: true });
				throw error;
			}
		};

		const representative = runInitialSelection(true);
		try {
			let result = runCli(representative.directory, 'skip', representative.fixture.lowId);
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			for (let i = 0; i < 2; i++) {
				result = runUpdate(representative.directory);
				assert.strictEqual(result.status, 0, result.stdout + result.stderr);
				const skipped = readData(representative.directory, 'reserves');
				assert.strictEqual(skipped.length, 1);
				assert.strictEqual(skipped[0].id, representative.fixture.lowId);
				assert.strictEqual(skipped[0].isSkip, true);
				assert.strictEqual(skipped[0].ruleUid, 'stable-rule');
				assert.strictEqual(skipped[0].recordedDirId, 'recorded-a');
				assert.strictEqual(skipped[0].recordedDir, path.join(representative.directory, 'recorded-a') + '/');
				assert.strictEqual(skipped[0].recordedFormat, '<title>/<id>.m2ts');
			}

			result = runCli(representative.directory, 'unskip', representative.fixture.lowId);
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			for (let i = 0; i < 2; i++) {
				result = runUpdate(representative.directory);
				assert.strictEqual(result.status, 0, result.stdout + result.stderr);
				const active = readData(representative.directory, 'reserves');
				assert.strictEqual(active.length, 1);
				assert.strictEqual(active[0].id, representative.fixture.lowId);
				assert.strictEqual(active[0].isSkip, undefined);
			}
			const opposite = runInitialSelection(false);
			fs.rmSync(opposite.directory, { recursive: true, force: true });
		} finally {
			fs.rmSync(representative.directory, { recursive: true, force: true });
		}
	});

	it('persists one manual duplicate without duplication and removes it without discarding Skip history', function() {
		const fixture = duplicateFixtureOptions(true);
		const directory = writeFixture('success', {
			rules: [{ sid: 1, ruleUid: 'low-only-rule' }],
			tuners: [{ types: ['GR'] }],
			services: fixture.services,
			programs: fixture.programs
		});

		try {
			let result = runUpdate(directory);
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			result = runCli(directory, 'skip', fixture.lowId);
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			result = runCli(directory, 'reserve', fixture.highId);
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			let history = readData(directory, 'reserves2');
			assert.strictEqual(history.length, 2);
			assert.strictEqual(history.find(program => program.id === fixture.highId).isManualReserved, true);
			assert.strictEqual(history.find(program => program.id === fixture.highId).source, 'manual');
			result = runCli(directory, 'reserve', fixture.highId);
			assert.notStrictEqual(result.status, 0);
			assert.strictEqual(readData(directory, 'reserves2').length, 2);

			result = runUpdate(directory);
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			let current = readData(directory, 'reserves');
			assert.deepStrictEqual(current.map(program => program.id).sort(), [ fixture.lowId, fixture.highId ].sort());
			assert.strictEqual(current.find(program => program.id === fixture.lowId).isSkip, true);
			assert.strictEqual(current.find(program => program.id === fixture.highId).isManualReserved, true);

			result = runCli(directory, 'unreserve', fixture.highId);
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			history = readData(directory, 'reserves2');
			assert.deepStrictEqual(history.map(program => program.id), [ fixture.lowId ]);
			result = runUpdate(directory);
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			current = readData(directory, 'reserves');
			assert.strictEqual(current.length, 1);
			assert.strictEqual(current[0].id, fixture.lowId);
			assert.strictEqual(current[0].isSkip, true);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('retries once and preserves a CLI Skip made before the scheduler output lock', { timeout: 10000 }, async function() {
		const fixture = duplicateFixtureOptions(false);
		const directory = writeFixture('success', {
			rules: [{ ruleUid: 'race-rule', recordedDirId: 'recorded-a', recorded_format: '<title>/<id>.m2ts' }],
			tuners: [{ types: ['GR'] }],
			services: fixture.services,
			programs: fixture.programs
		});
		try {
			let result = runUpdate(directory);
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			instrumentScheduler(directory, 'function outputReserves() {', 'BEFORE_RESERVATION_LOCK');
			const raced = await runUpdateWithCliAtMarker(directory, 'BEFORE_RESERVATION_LOCK', 'skip', fixture.lowId);
			assert.strictEqual(raced.status, 0, raced.output);
			assert.strictEqual(raced.cliStatus, 0, raced.cliOutput);
			assert.match(raced.output, /reserves\.json changed while scheduler was running/);
			assert.match(raced.output, /retrying once with the latest reserves\.json/);
			assert.strictEqual(raced.output.split('BEFORE_RESERVATION_LOCK').length - 1, 2);
			const low = readData(directory, 'reserves').find(program => program.id === fixture.lowId);
			assert.strictEqual(low.isSkip, true);
			assert.strictEqual(low.ruleUid, 'race-rule');
			assert.strictEqual(low.recordedDirId, 'recorded-a');
			assert.strictEqual(low.recordedDir, path.join(directory, 'recorded-a') + '/');
			assert.strictEqual(low.recordedFormat, '<title>/<id>.m2ts');
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('serializes a CLI Skip started after the scheduler acquires its output lock', { timeout: 10000 }, async function() {
		const fixture = duplicateFixtureOptions(false);
		const directory = writeFixture('success', {
			rules: [{}],
			tuners: [{ types: ['GR'] }],
			services: fixture.services,
			programs: fixture.programs
		});

		try {
			let result = runUpdate(directory);
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			instrumentScheduler(directory, '// reservation output lock acquired', 'AFTER_RESERVATION_LOCK');
			const raced = await runUpdateWithCliAtMarker(directory, 'AFTER_RESERVATION_LOCK', 'skip', fixture.lowId, {
				releaseWhenCliAttemptsLock: true
			});
			assert.strictEqual(raced.status, 0, raced.output);
			assert.strictEqual(raced.cliStatus, 0, raced.cliOutput);
			assert.strictEqual(readData(directory, 'reserves').find(program => program.id === fixture.lowId).isSkip, true);
			assert.strictEqual(fs.existsSync(path.join(directory, 'data', 'reserves.json.lock')), false);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});
