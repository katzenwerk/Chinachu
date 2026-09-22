'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const repositoryRoot = path.resolve(__dirname, '..');
const schedulerState = require('../lib/scheduler-state');

function writeFixture(mode) {
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
		storageLowSpaceAction: 'none'
	}));
	fs.writeFileSync(path.join(directory, 'rules.json'), '[]');
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
			: '  getServices() { return Promise.resolve([]); }',
		'  getPrograms() { return Promise.resolve([]); }',
		'  getTuners() { return Promise.resolve([]); }',
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

	it('routes operator, normal API, and force API starts through the same app-scheduler receipt', function() {
		const operatorSource = fs.readFileSync(path.join(repositoryRoot, 'app-operator.js'), 'utf8');
		const normalApiSource = fs.readFileSync(path.join(repositoryRoot, 'api', 'script-scheduler.vm.js'), 'utf8');
		const forceApiSource = fs.readFileSync(path.join(repositoryRoot, 'api', 'script-scheduler-force.vm.js'), 'utf8');
		const launcherSource = fs.readFileSync(path.join(repositoryRoot, 'chinachu'), 'utf8');
		const schedulerSource = fs.readFileSync(path.join(repositoryRoot, 'app-scheduler.js'), 'utf8');

		assert.match(operatorSource, /child_process\.spawn\('\.\/chinachu', \[ 'update' \]/);
		assert.match(normalApiSource, /child_process\.exec\('\.\/chinachu update'/);
		assert.match(forceApiSource, /child_process\.exec\('\.\/chinachu update --force'/);
		assert.match(launcherSource, /chinachu_update[\s\S]*node app-scheduler\.js/);
		assert.match(schedulerSource, /recordSchedulerSuccess\(\);[\s\S]*process\.exit\(0\)/);
	});
});
