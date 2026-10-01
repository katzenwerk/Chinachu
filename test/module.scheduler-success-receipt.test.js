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
	[ 'opts', 'dateformat', 'chinachu-common' ].forEach(name => {
		fs.symlinkSync(path.join(repositoryRoot, 'node_modules', name), path.join(nodeModules, name), 'dir');
	});

	const schedulerSource = fs.readFileSync(path.join(repositoryRoot, 'app-scheduler.js'), 'utf8').replace(
		"child_process.execSync('renice -n 19 -p ' + process.pid);",
		'void process.pid; // fixture: avoid changing process priority'
	);
	fs.writeFileSync(path.join(directory, 'app-scheduler.js'), schedulerSource);
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
			{ id: 'anime3', path: path.join(directory, 'anime3') },
			{ id: 'anime4', path: path.join(directory, 'anime4') }
		]
	}));
	fs.writeFileSync(path.join(directory, 'rules.json'), JSON.stringify(options.rules || []));
	[ 'schedule', 'reserves', 'reserves2', 'recording', 'recorded', 'match' ].forEach(name => {
		fs.writeFileSync(path.join(directory, 'data', name + '.json'), '[]');
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
			rules: [{ isDisabled: true }, { ruleUid: 'uid-anime3', recordedDirId: 'anime3' }],
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
			assert.strictEqual(oldMeta.ruleUid, 'uid-anime3');
			const reserve = read('reserves2')[0];
			fs.writeFileSync(path.join(directory, 'data', 'recorded.json'), JSON.stringify([
				{ ...reserve, recorded: path.join(directory, 'anime3', 'fixture.m2ts') }
			]));
			// Delete/reorder the old rules, reuse their index, and remap the same HDD ID.
			fs.writeFileSync(path.join(directory, 'rules.json'), JSON.stringify([
				{ recordedDirId: 'anime4' }, { recordedDirId: 'anime4' }
			]));
			const configPath = path.join(directory, 'config.json');
			const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
			config.recordedDirs[0].path = path.join(directory, 'remapped-anime3');
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
			name: 'last matching rule selects anime4 over anime3',
			rules: [{ recordedDirId: 'anime3' }, { recordedDirId: ' anime4 ' }],
			ruleId: 1, ruleIdSource: 'index', recordedDirId: 'anime4', directory: 'anime4'
		},
		{
			name: 'explicit string ID selects anime3',
			rules: [{ id: 'rule-anime', ruleUid: 'uid-anime3', recordedDirId: 'anime3', recorded_format: '<title>/<id>.m2ts' }],
			ruleId: 'rule-anime', ruleIdSource: 'id', recordedDirId: 'anime3', directory: 'anime3',
			ruleUid: 'uid-anime3',
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
				['anime3', 'anime4', 'recorded'].forEach(name => assert.strictEqual(fs.existsSync(path.join(directory, name)), false));
			} finally {
				fs.rmSync(directory, { recursive: true, force: true });
			}
		});
	});
});
