'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const repositoryRoot = path.resolve(__dirname, '..');
const schedulerState = require('../lib/scheduler-state');

function writeFixture(mode, options = {}) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-scheduler-receipt-'));
	const binDirectory = path.join(directory, 'bin');
	const nodeModules = path.join(directory, 'node_modules');
	const mirakurunModule = path.join(nodeModules, 'mirakurun');

	fs.mkdirSync(path.join(directory, 'data'));
	fs.mkdirSync(path.join(directory, 'log'));
	fs.mkdirSync(path.join(directory, 'web'));
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
		env: Object.assign({}, process.env, { PATH: path.join(directory, 'bin') + ':' + process.env.PATH }),
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

function instrumentScheduler(directory, target, marker) {
	const file = path.join(directory, 'app-scheduler.js');
	const source = fs.readFileSync(file, 'utf8');
	assert.match(source, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
	fs.writeFileSync(file, source.replace(
		target,
		target + "\n\t\tconsole.log('" + marker + "'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);"
	));
}

function runUpdateWithCliAtMarker(directory, marker, mode, id) {
	return new Promise((resolve, reject) => {
		const child = childProcess.spawn('bash', [ './chinachu', 'update' ], {
			cwd: directory,
			env: Object.assign({}, process.env, { PATH: path.join(directory, 'bin') + ':' + process.env.PATH }),
			stdio: [ 'ignore', 'pipe', 'pipe' ]
		});
		let output = '';
		let cli = null;
		let cliOutput = '';
		let startedCli = false;
		child.stdout.on('data', chunk => {
			output += chunk.toString();
			if (!startedCli && output.indexOf(marker) !== -1) {
				startedCli = true;
				cli = childProcess.spawn(process.execPath, [ 'app-cli.js', '-mode', mode, '-id', id ], {
					cwd: directory,
					stdio: [ 'ignore', 'pipe', 'pipe' ]
				});
				cli.stdout.on('data', cliChunk => { cliOutput += cliChunk.toString(); });
				cli.stderr.on('data', cliChunk => { cliOutput += cliChunk.toString(); });
			}
		});
		child.stderr.on('data', chunk => { output += chunk.toString(); });
		child.once('error', reject);
		child.once('close', async status => {
			if (!startedCli || !cli) {
				reject(new Error('scheduler marker was not observed: ' + output));
				return;
			}
			const cliStatus = cli.exitCode === null ? await new Promise(done => cli.once('close', done)) : cli.exitCode;
			resolve({ status, output, cliStatus, cliOutput });
		});
	});
}

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
	it('keeps historical JSON snapshots after rules and directory mappings change', function() {
		const startAt = Date.now() + 3600000;
		const directory = writeFixture('success', {
			rules: [{ isDisabled: true }, { ruleUid: 'uid-recorded-a', recordedDirId: 'recorded-a' }],
			tuners: [{ types: ['GR'] }],
			services: [{ id: 1001, serviceId: 1, networkId: 1, name: 'Fixture channel', channel: { type: 'GR', channel: '27' } }],
			programs: [{ id: 1001001, serviceId: 1, networkId: 1, name: 'Fixture anime', description: '', startAt, duration: 1800000 }]
		});
		try {
			const scheduled = runUpdate(directory);
			assert.strictEqual(scheduled.status, 0, scheduled.stdout + scheduled.stderr);
			const read = name => JSON.parse(fs.readFileSync(path.join(directory, 'data', name + '.json'), 'utf8'));
			const oldMeta = read('match')[0].reservationMeta;
			assert.strictEqual(oldMeta.ruleId, 1);
			assert.strictEqual(oldMeta.ruleUid, 'uid-recorded-a');
			const reserve = read('reserves2')[0];
			fs.writeFileSync(path.join(directory, 'data', 'recorded.json'), JSON.stringify([
				{ ...reserve, recorded: path.join(directory, 'recorded-a', 'fixture.m2ts') }
			]));
			// Delete/reorder the old rules, reuse their index, and remap the same HDD ID.
			fs.writeFileSync(path.join(directory, 'rules.json'), JSON.stringify([
				{ recordedDirId: 'recorded-b' }, { recordedDirId: 'recorded-b' }
			]));
			const configPath = path.join(directory, 'config.json');
			const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
			config.recordedDirs[0].path = path.join(directory, 'remapped-recorded-a');
			fs.writeFileSync(configPath, JSON.stringify(config));
			[true, false].forEach(hasReserve => {
				if (!hasReserve) fs.writeFileSync(path.join(directory, 'data', 'reserves2.json'), '[]');
				const result = childProcess.spawnSync(process.execPath, [
					'app-matching.js', '--output', path.join(directory, 'data', 'match.json'),
					'--now', String(startAt + 3600000)
				], { cwd: directory, encoding: 'utf8' });
				assert.strictEqual(result.status, 0, result.stdout + result.stderr);
				const row = read('match')[0];
				['ruleId', 'ruleIdSource', 'ruleUid', 'recordedDirId', 'recordedDir', 'reserveSnapshotAt', 'reserveUpdatedAt'].forEach(key => {
					assert.deepStrictEqual(row.reservationMeta[key], oldMeta[key], key);
				});
				assert.strictEqual(row.reservationMeta.hasReserve, hasReserve);
				assert.strictEqual(row.sources.reservationMeta, hasReserve ? 'reserves2' : null);
			});
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	const cases = [
		{ name: 'single rule with index zero and no directory', rules: [{}], ruleId: 0, ruleIdSource: 'index' },
		{
			name: 'last matching rule selects recorded-b over recorded-a',
			rules: [{ recordedDirId: 'recorded-a' }, { recordedDirId: ' recorded-b ' }],
			ruleId: 1, ruleIdSource: 'index', recordedDirId: 'recorded-b', directory: 'recorded-b'
		},
		{
			name: 'explicit string ID selects recorded-a',
			rules: [{ id: 'rule-recorded', ruleUid: 'uid-recorded-a', recordedDirId: 'recorded-a', recorded_format: '<title>/<id>.m2ts' }],
			ruleId: 'rule-recorded', ruleIdSource: 'id', recordedDirId: 'recorded-a', directory: 'recorded-a',
			ruleUid: 'uid-recorded-a',
			recordedFormat: '<title>/<id>.m2ts'
		},
		{
			name: 'unresolved directory retains logical ID without inventing a path',
			rules: [{ recordedDirId: 'missing' }], ruleId: 0, ruleIdSource: 'index', recordedDirId: 'missing'
		},
		{ name: 'blank directory stays absent', rules: [{ recordedDirId: ' ' }], ruleId: 0, ruleIdSource: 'index' },
		...[0, '', null, false, { legacy: 1 }].map(id => ({
			name: 'explicit ID is preserved without normalization: ' + JSON.stringify(id),
			rules: [{ id }], ruleId: id, ruleIdSource: 'id'
		}))
	];

	cases.forEach(entry => {
		it(entry.name, function() {
			const directory = writeFixture('success', {
				rules: entry.rules,
				tuners: [{ types: ['GR'] }],
				services: [{ id: 1001, serviceId: 1, networkId: 1, name: 'Fixture channel', channel: { type: 'GR', channel: '27' } }],
				programs: [{ id: 1001001, serviceId: 1, networkId: 1, name: 'Fixture anime', description: '', startAt: Date.now() + 3600000, duration: 1800000 }]
			});
			try {
				const result = runUpdate(directory);
				assert.strictEqual(result.status, 0, result.stdout + result.stderr);
				const expected = {
					ruleId: entry.ruleId,
					ruleIdSource: entry.ruleIdSource,
					ruleUid: entry.ruleUid,
					recordedDirId: entry.recordedDirId,
					recordedDir: entry.directory ? path.join(directory, entry.directory) + '/' : undefined
				};
				['reserves', 'reserves2', 'match'].forEach(name => {
					const rows = JSON.parse(fs.readFileSync(path.join(directory, 'data', name + '.json'), 'utf8'));
					assert.strictEqual(rows.length, 1, name);
					const snapshot = name === 'match' ? rows[0].reservationMeta : rows[0];
					Object.keys(expected).forEach(key => {
						const value = name === 'match' && expected[key] === undefined ? null : expected[key];
						assert.deepStrictEqual(snapshot[key], value, name + '.' + key);
					});
					if (entry.recordedFormat) assert.strictEqual(snapshot.recordedFormat, entry.recordedFormat);
					if (name === 'match') {
						assert.strictEqual(snapshot.hasReserve, true);
						assert.strictEqual(rows[0].sources.reservationMeta, 'reserves2');
					}
				});
				assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(directory, 'rules.json'), 'utf8')), entry.rules);
				['recorded-a', 'recorded-b', 'recorded'].forEach(name => assert.strictEqual(fs.existsSync(path.join(directory, name)), false));
			} finally {
				fs.rmSync(directory, { recursive: true, force: true });
			}
		});
	});
});

describe('Scheduler Skip and duplicate reservation boundaries', function() {
	it('keeps a skipped duplicate stable and returns to the low SID after Unskip regardless of service order', function() {
		[ false, true ].forEach(reverseServices => {
			const fixture = duplicateFixtureOptions(reverseServices);
			const directory = writeFixture('success', {
				rules: [{ ruleUid: 'stable-rule', recordedDirId: 'recorded-a', recorded_format: '<title>/<id>.m2ts' }],
				tuners: [{ types: ['GR'] }],
				services: fixture.services,
				programs: fixture.programs
			});

			try {
				let result = runUpdate(directory);
				assert.strictEqual(result.status, 0, result.stdout + result.stderr);
				assert.deepStrictEqual(readData(directory, 'reserves').map(program => program.id), [ fixture.lowId ]);

				result = runCli(directory, 'skip', fixture.lowId);
				assert.strictEqual(result.status, 0, result.stdout + result.stderr);
				for (let i = 0; i < 2; i++) {
					result = runUpdate(directory);
					assert.strictEqual(result.status, 0, result.stdout + result.stderr);
					const skipped = readData(directory, 'reserves');
					assert.strictEqual(skipped.length, 1);
					assert.strictEqual(skipped[0].id, fixture.lowId);
					assert.strictEqual(skipped[0].isSkip, true);
					assert.strictEqual(skipped[0].ruleUid, 'stable-rule');
					assert.strictEqual(skipped[0].recordedDirId, 'recorded-a');
					assert.strictEqual(skipped[0].recordedDir, path.join(directory, 'recorded-a') + '/');
					assert.strictEqual(skipped[0].recordedFormat, '<title>/<id>.m2ts');
				}

				result = runCli(directory, 'unskip', fixture.lowId);
				assert.strictEqual(result.status, 0, result.stdout + result.stderr);
				for (let i = 0; i < 2; i++) {
					result = runUpdate(directory);
					assert.strictEqual(result.status, 0, result.stdout + result.stderr);
					const active = readData(directory, 'reserves');
					assert.strictEqual(active.length, 1);
					assert.strictEqual(active[0].id, fixture.lowId);
					assert.strictEqual(active[0].isSkip, undefined);
				}
			} finally {
				fs.rmSync(directory, { recursive: true, force: true });
			}
		});
	});

	it('keeps an explicit manual duplicate without discarding the existing Skip marker', function() {
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

			result = runUpdate(directory);
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			let current = readData(directory, 'reserves');
			assert.deepStrictEqual(current.map(program => program.id).sort(), [ fixture.lowId, fixture.highId ].sort());
			assert.strictEqual(current.find(program => program.id === fixture.lowId).isSkip, true);
			assert.strictEqual(current.find(program => program.id === fixture.highId).isManualReserved, true);

			result = runCli(directory, 'unreserve', fixture.highId);
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
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

	it('retries once and preserves CLI Skip, Unskip, and manual reserve changes made during a scheduler run', { timeout: 20000 }, async function() {
		for (const entry of [
			{ mode: 'skip', setup: false },
			{ mode: 'unskip', setup: true },
			{ mode: 'reserve', setup: false, manual: true }
		]) {
			const fixture = duplicateFixtureOptions(false);
			const raceRule = {
				ruleUid: 'race-rule',
				recordedDirId: 'recorded-a',
				recorded_format: '<title>/<id>.m2ts'
			};
			if (entry.manual) {
				raceRule.sid = 1;
			}
			const directory = writeFixture('success', {
				rules: [raceRule],
				tuners: [{ types: ['GR'] }],
				services: fixture.services,
				programs: fixture.programs
			});

			try {
				let result = runUpdate(directory);
				assert.strictEqual(result.status, 0, result.stdout + result.stderr);
				if (entry.setup) {
					result = runCli(directory, 'skip', fixture.lowId);
					assert.strictEqual(result.status, 0, result.stdout + result.stderr);
				}

				instrumentScheduler(directory, 'function outputReserves() {', 'BEFORE_RESERVATION_LOCK');
				const raced = await runUpdateWithCliAtMarker(
					directory,
					'BEFORE_RESERVATION_LOCK',
					entry.mode,
					entry.manual ? fixture.highId : fixture.lowId
				);
				assert.strictEqual(raced.status, 0, raced.output);
				assert.strictEqual(raced.cliStatus, 0, raced.cliOutput);
				assert.match(raced.output, /reserves\.json changed while scheduler was running/);
				assert.match(raced.output, /retrying once with the latest reserves\.json/);
				assert.strictEqual(raced.output.split('BEFORE_RESERVATION_LOCK').length - 1, 2);

				const current = readData(directory, 'reserves');
				const low = current.find(program => program.id === fixture.lowId);
				if (!entry.manual) {
					assert.strictEqual(low.ruleUid, 'race-rule');
					assert.strictEqual(low.recordedDirId, 'recorded-a');
					assert.strictEqual(low.recordedDir, path.join(directory, 'recorded-a') + '/');
					assert.strictEqual(low.recordedFormat, '<title>/<id>.m2ts');
				}
				if (entry.mode === 'skip') {
					assert.strictEqual(low.isSkip, true);
				} else if (entry.mode === 'unskip') {
					assert.strictEqual(low.isSkip, undefined);
				} else {
					assert.strictEqual(current.find(program => program.id === fixture.highId).isManualReserved, true);
				}
			} finally {
				fs.rmSync(directory, { recursive: true, force: true });
			}
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
			const raced = await runUpdateWithCliAtMarker(directory, 'AFTER_RESERVATION_LOCK', 'skip', fixture.lowId);
			assert.strictEqual(raced.status, 0, raced.output);
			assert.strictEqual(raced.cliStatus, 0, raced.cliOutput);
			assert.strictEqual(readData(directory, 'reserves').find(program => program.id === fixture.lowId).isSkip, true);
			assert.strictEqual(fs.existsSync(path.join(directory, 'data', 'reserves.json.lock')), false);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});
