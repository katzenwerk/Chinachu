'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const preflightModule = require('../lib/operator-scheduler-preflight');
const operatorSchedulerRequest = require('../lib/operator-scheduler-request');
const schedulerState = require('../lib/scheduler-state');

function writeJson(filePath, value) {
	fs.writeFileSync(filePath, JSON.stringify(value));
}

function jobsFixture(overrides) {
	overrides = overrides || {};
	return [ {
		id: 'parent-latest',
		key: 'EPG.Gatherer',
		status: 'finished',
		startedAt: 1000,
		finishedAt: 1200
	}, Object.assign({
		id: 'child-1',
		key: 'EPG.Gather.NID.1',
		status: 'finished',
		createdAt: 1100,
		finishedAt: 2000
	}, overrides) ];
}

function servicesFixture(overrides) {
	return [ Object.assign({
		id: 1,
		serviceId: 101,
		networkId: 10,
		name: 'Service 1',
		hasLogoData: true,
		channel: { type: 'GR', channel: '27' },
		remoteControlKeyId: 1
	}, overrides || {}) ];
}

function tunersFixture(overrides) {
	return [ Object.assign({
		name: 'Tuner 1',
		types: [ 'GR' ],
		isAvailable: true,
		users: []
	}, overrides || {}) ];
}

function createFixture(options) {
	options = options || {};
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-preflight-'));
	const paths = {
		state: path.join(directory, 'scheduler-state.json'),
		rules: path.join(directory, 'rules.json'),
		config: path.join(directory, 'config.json'),
		schedule: path.join(directory, 'schedule.json'),
		reserves: path.join(directory, 'reserves.json'),
		reserves2: path.join(directory, 'reserves2.json'),
		recorded: path.join(directory, 'recorded.json')
	};
	const values = {
		rules: [ { types: [ 'GR' ] } ],
		config: { normalizationForm: 'NFKC', recordedDir: '/recorded' },
		schedule: [],
		reserves: [ { id: 'auto-1', start: 1000, end: 2000, isConflict: false } ],
		reserves2: [],
		recorded: [],
		jobs: jobsFixture(),
		services: servicesFixture(),
		tuners: tunersFixture()
	};

	[ 'rules', 'config', 'schedule', 'reserves', 'reserves2', 'recorded' ].forEach(name => {
		writeJson(paths[name], values[name]);
	});

	const baselines = {
		rules: preflightModule.createFileBaseline(paths.rules, values.rules),
		config: preflightModule.createFileBaseline(paths.config, values.config),
		reserves: preflightModule.createFileBaseline(paths.reserves, preflightModule.projectReserves(values.reserves)),
		services: preflightModule.createValueBaseline(preflightModule.projectServices(values.services)),
		tuners: preflightModule.createValueBaseline(preflightModule.projectTuners(values.tuners)),
		recorded: preflightModule.createFileBaseline(paths.recorded, values.recorded)
	};
	const store = new schedulerState.SchedulerStateStore(paths.state);
	store.save({
		version: 3,
		lastSchedulerStartedAt: options.lastSchedulerStartedAt || 3000,
		lastSchedulerSuccessAt: options.lastSchedulerSuccessAt || 3500,
		lastAppliedParentId: null,
		lastAppliedAt: 0,
		baselines: baselines
	});

	const calls = { jobs: 0, services: 0, tuners: 0 };
	const preflight = new preflightModule.OperatorSchedulerPreflight({
		stateStore: store,
		fetchJobs: options.fetchJobs || (() => { calls.jobs++; return Promise.resolve(values.jobs); }),
		fetchServices: options.fetchServices || (() => { calls.services++; return Promise.resolve(values.services); }),
		fetchTuners: options.fetchTuners || (() => { calls.tuners++; return Promise.resolve(values.tuners); }),
		paths: paths,
		now: () => 5000
	});

	return {
		directory: directory,
		paths: paths,
		values: values,
		baselines: baselines,
		store: store,
		calls: calls,
		preflight: preflight,
		cleanup: () => fs.rmSync(directory, { recursive: true, force: true })
	};
}

function cleanSummary(overrides) {
	return Object.assign({
		total: 10,
		completed: 10,
		skipped: 0,
		failed: 0,
		aborted: 0
	}, overrides || {});
}

function createRequestFixture(options) {
	options = options || {};
	const state = {
		running: options.running === true,
		shuttingDown: false,
		starts: 0
	};
	const coordinator = operatorSchedulerRequest.createSchedulerRequest({
		isSchedulerRunning: () => state.running,
		isShuttingDown: () => state.shuttingDown,
		startScheduler: () => {
			state.starts++;
			state.running = true;
		},
		stateStore: options.stateStore || null
	});
	return { state, coordinator };
}

function createStateFixture() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-scheduler-request-'));
	const store = new schedulerState.SchedulerStateStore(path.join(directory, 'scheduler-state.json'));
	store.save({
		version: 3,
		lastSchedulerStartedAt: 3000,
		lastSchedulerSuccessAt: 3500,
		lastAppliedParentId: null,
		lastAppliedAt: 0,
		baselines: schedulerState.emptyBaselines()
	});
	return { store, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

describe('Operator scheduler preflight', function() {
	it('classifies clean, content, metadata-only, and unavailable inputs', async function() {
		const local = createFixture();
		try {
			assert.deepStrictEqual(await local.preflight.check(), {
				dirty: false,
				reasons: [],
				advisory: [],
				lastSchedulerStartedAt: 3000,
				lastSchedulerSuccessAt: 3500
			});
			const future = new Date(Date.now() + 5000);
			fs.utimesSync(local.paths.rules, future, future);
			assert.strictEqual((await local.preflight.check()).reasons.includes('rules'), false);
			writeJson(local.paths.rules, [ { types: [ 'BS' ] } ]);
			assert.ok((await local.preflight.check()).reasons.includes('rules'));
		} finally {
			local.cleanup();
		}

		const remote = createFixture();
		try {
			for (const name of [ 'jobs', 'services', 'tuners' ]) {
				const property = 'fetch' + name.charAt(0).toUpperCase() + name.slice(1);
				const original = remote.preflight[property];
				remote.preflight[property] = () => Promise.reject(new Error('unavailable'));
				const result = await remote.preflight.check();
				assert.ok(result.reasons.includes(name === 'jobs' ? 'epg-unavailable' : name + '-unavailable'));
				remote.preflight[property] = original;
			}
		} finally {
			remote.cleanup();
		}
	});

	it('skips clean periodic checks and starts one scheduler for dirty results', async function() {
		for (const testCase of [
			{
				result: { dirty: false, reasons: [], advisory: [] },
				expectedStarted: false,
				expectedStarts: 0
			},
			{
				result: { dirty: true, reasons: [ 'rules' ], advisory: [] },
				expectedStarted: true,
				expectedStarts: 1
			}
		]) {
			let starts = 0;
			const logs = [];
			const runner = new preflightModule.ShadowPeriodicScheduler({
				preflight: { check: () => Promise.resolve(testCase.result) },
				startScheduler: () => { starts++; return true; },
				log: message => logs.push(message)
			});
			const first = runner.request();
			const second = runner.request();
			assert.strictEqual(first, second);
			assert.strictEqual((await first).started, testCase.expectedStarted);
			assert.strictEqual(starts, testCase.expectedStarts);
			assert.strictEqual(logs.length, 1);
		}
	});

});

describe('Operator EPG scheduler requests', function() {
	it('starts once per clean parent and records it only after scheduler success', function() {
		const fixture = createStateFixture();
		try {
			const request = createRequestFixture({ stateStore: fixture.store });
			assert.strictEqual(request.coordinator.requestEpgCycle('parent-1', cleanSummary()), true);
			assert.strictEqual(request.coordinator.requestEpgCycle('parent-1', cleanSummary()), false);
			assert.strictEqual(request.state.starts, 1);
			assert.strictEqual(fixture.store.load().lastAppliedParentId, null);

			fixture.store.recordSchedulerSuccess(4500, 5000);
			request.state.running = false;
			request.coordinator.onSchedulerExit({ successful: true, finishedAt: 5100 });
			const saved = fixture.store.load();
			assert.strictEqual(saved.lastSchedulerStartedAt, 4500);
			assert.strictEqual(saved.lastSchedulerSuccessAt, 5000);
			assert.strictEqual(saved.lastAppliedParentId, 'parent-1');
		} finally {
			fixture.cleanup();
		}
	});

	it('does not start or apply failed and aborted EPG parents', function() {
		const fixture = createStateFixture();
		try {
			const request = createRequestFixture({ stateStore: fixture.store });
			assert.strictEqual(request.coordinator.requestEpgCycle('parent-failed', cleanSummary({ failed: 1 })), false);
			assert.strictEqual(request.coordinator.requestEpgCycle('parent-aborted', cleanSummary({ aborted: 1 })), false);
			assert.strictEqual(request.state.starts, 0);
			assert.strictEqual(fixture.store.load().lastAppliedParentId, null);
		} finally {
			fixture.cleanup();
		}
	});
});
