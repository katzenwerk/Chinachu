'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const preflightModule = require('../lib/operator-scheduler-preflight');
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

describe('Operator scheduler preflight', function() {
	it('is clean when all successful scheduler baselines still match', async function() {
		const fixture = createFixture();
		try {
			assert.deepStrictEqual(await fixture.preflight.check(), {
				dirty: false,
				reasons: [],
				advisory: [],
				lastSchedulerStartedAt: 3000,
				lastSchedulerSuccessAt: 3500
			});
		} finally {
			fixture.cleanup();
		}
	});

	it('detects rules content changes but ignores mtime-only changes', async function() {
		const changed = createFixture();
		try {
			writeJson(changed.paths.rules, [ { types: [ 'BS' ] } ]);
			assert.ok((await changed.preflight.check()).reasons.includes('rules'));
		} finally {
			changed.cleanup();
		}

		const touched = createFixture();
		try {
			const future = new Date(Date.now() + 5000);
			fs.utimesSync(touched.paths.rules, future, future);
			assert.strictEqual((await touched.preflight.check()).reasons.includes('rules'), false);
		} finally {
			touched.cleanup();
		}
	});

	it('isolates jobs, services, and tuners API failures as safe dirty reasons', async function() {
		for (const name of [ 'jobs', 'services', 'tuners' ]) {
			const options = {};
			options['fetch' + name.charAt(0).toUpperCase() + name.slice(1)] = () => Promise.reject(new Error('unavailable'));
			const fixture = createFixture(options);
			try {
				const expected = name === 'jobs' ? 'epg-unavailable' : name + '-unavailable';
				assert.ok((await fixture.preflight.check()).reasons.includes(expected));
			} finally {
				fixture.cleanup();
			}
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
			assert.match(logs[0], testCase.result.dirty ? /preflight dirty reasons=rules/ : /preflight clean/);
		}
	});

});
