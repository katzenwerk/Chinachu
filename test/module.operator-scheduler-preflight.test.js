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

	it('uses the successful scheduler start as the EPG completion boundary', async function() {
		for (const scenario of [
			{ finishedAt: 4000, dirty: true },
			{ finishedAt: 2500, dirty: false }
		]) {
			const fixture = createFixture();
			try {
				fixture.values.jobs = jobsFixture({ finishedAt: scenario.finishedAt });
				const result = await fixture.preflight.check();
				assert.strictEqual(result.reasons.includes('epg'), scenario.dirty);
			} finally {
				fixture.cleanup();
			}
		}
	});

	it('treats failed and abnormal aborted terminal EPG cycles as periodic fallback reasons', async function() {
		for (const child of [ { hasFailed: true }, { hasAborted: true } ]) {
			const fixture = createFixture();
			try {
				fixture.values.jobs = jobsFixture(Object.assign({ finishedAt: 4000 }, child));
				assert.ok((await fixture.preflight.check()).reasons.includes('epg'));
			} finally {
				fixture.cleanup();
			}
		}
	});

	it('does not use an EPG cycle with a running child as a dirty reason', async function() {
		const fixture = createFixture();
		try {
			fixture.values.jobs = jobsFixture({ status: 'running', finishedAt: undefined });
			assert.strictEqual((await fixture.preflight.check()).reasons.includes('epg'), false);
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

	it('detects config content changes', async function() {
		const fixture = createFixture();
		try {
			writeJson(fixture.paths.config, { normalizationForm: 'NFC', recordedDir: '/recorded' });
			assert.ok((await fixture.preflight.check()).reasons.includes('config'));
		} finally {
			fixture.cleanup();
		}
	});

	it('detects manual reserve and skip changes', async function() {
		for (const reserve of [
			{ id: 'manual-1', start: 1000, end: 2000, isManualReserved: true, '1seg': true },
			{ id: 'auto-1', start: 1000, end: 2000, isSkip: true }
		]) {
			const fixture = createFixture();
			try {
				writeJson(fixture.paths.reserves, [ reserve ]);
				assert.ok((await fixture.preflight.check()).reasons.includes('reserves'));
			} finally {
				fixture.cleanup();
			}
		}
	});

	it('ignores scheduler-generated reserve fields and detects later external semantics', async function() {
		const fixture = createFixture();
		try {
			writeJson(fixture.paths.reserves, [ {
				id: 'different-auto-output',
				start: 5000,
				end: 6000,
				isConflict: true,
				ruleId: 10
			} ]);
			assert.strictEqual((await fixture.preflight.check()).reasons.includes('reserves'), false);

			writeJson(fixture.paths.reserves, [ {
				id: 'manual-during-scheduler',
				start: 5000,
				end: 6000,
				isManualReserved: true
			} ]);
			assert.ok((await fixture.preflight.check()).reasons.includes('reserves'));
		} finally {
			fixture.cleanup();
		}
	});

	it('detects service scheduling changes and ignores volatile service fields', async function() {
		const changed = createFixture();
		try {
			changed.values.services = servicesFixture({ name: 'Renamed Service' });
			assert.ok((await changed.preflight.check()).reasons.includes('services'));
		} finally {
			changed.cleanup();
		}

		const volatile = createFixture();
		try {
			volatile.values.services = servicesFixture({ remoteControlKeyId: 99, currentUsers: [ 'recording' ] });
			assert.strictEqual((await volatile.preflight.check()).reasons.includes('services'), false);
		} finally {
			volatile.cleanup();
		}
	});

	it('detects tuner capacity changes and ignores volatile tuner use', async function() {
		for (const tuners of [
			tunersFixture({ types: [ 'GR', 'BS' ] }),
			tunersFixture().concat(tunersFixture({ name: 'Tuner 2' }))
		]) {
			const changed = createFixture();
			try {
				changed.values.tuners = tuners;
				assert.ok((await changed.preflight.check()).reasons.includes('tuners'));
			} finally {
				changed.cleanup();
			}
		}

		const volatile = createFixture();
		try {
			volatile.values.tuners = tunersFixture({ isAvailable: false, users: [ { id: 'recording' } ] });
			assert.strictEqual((await volatile.preflight.check()).reasons.includes('tuners'), false);
		} finally {
			volatile.cleanup();
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

	it('treats missing or corrupt state and required outputs as dirty', async function() {
		const cases = [
			{ target: 'state', action: fs.unlinkSync, reason: 'state' },
			{ target: 'state', action: file => fs.writeFileSync(file, '{broken'), reason: 'state' },
			{ target: 'schedule', action: fs.unlinkSync, reason: 'schedule' },
			{ target: 'reserves', action: file => fs.writeFileSync(file, '{broken'), reason: 'reserves' },
			{ target: 'reserves2', action: fs.unlinkSync, reason: 'reserves2' }
		];
		for (const item of cases) {
			const fixture = createFixture();
			try {
				item.action(fixture.paths[item.target]);
				assert.ok((await fixture.preflight.check()).reasons.includes(item.reason));
			} finally {
				fixture.cleanup();
			}
		}
	});

	it('reports recorded changes as advisory without making the result dirty', async function() {
		const fixture = createFixture();
		try {
			writeJson(fixture.paths.recorded, [ { id: 'recorded-1' } ]);
			const result = await fixture.preflight.check();
			assert.strictEqual(result.dirty, false);
			assert.deepStrictEqual(result.advisory, [ 'recorded' ]);
		} finally {
			fixture.cleanup();
		}
	});

	it('coalesces concurrent checks into one set of Mirakurun requests', async function() {
		let resolveJobs;
		const jobs = new Promise(resolve => { resolveJobs = resolve; });
		const fixture = createFixture({ fetchJobs: () => { fixture.calls.jobs++; return jobs; } });
		try {
			const first = fixture.preflight.check();
			const second = fixture.preflight.check();
			assert.strictEqual(first, second);
			resolveJobs(fixture.values.jobs);
			await first;
			assert.deepStrictEqual(fixture.calls, { jobs: 1, services: 1, tuners: 1 });
		} finally {
			fixture.cleanup();
		}
	});

	it('suppresses an in-flight result after shutdown', async function() {
		let resolveJobs;
		const jobs = new Promise(resolve => { resolveJobs = resolve; });
		const fixture = createFixture({ fetchJobs: () => jobs });
		try {
			const check = fixture.preflight.check();
			fixture.preflight.stop();
			resolveJobs(fixture.values.jobs);
			assert.strictEqual(await check, null);
		} finally {
			fixture.cleanup();
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

	it('does not start a periodic scheduler after shadow runner shutdown', async function() {
		let resolveCheck;
		let starts = 0;
		const runner = new preflightModule.ShadowPeriodicScheduler({
			preflight: { check: () => new Promise(resolve => { resolveCheck = resolve; }) },
			startScheduler: () => { starts++; }
		});
		const request = runner.request();
		await Promise.resolve();
		runner.stop();
		resolveCheck({ dirty: false, reasons: [], advisory: [] });
		assert.strictEqual(await request, null);
		assert.strictEqual(starts, 0);
	});
});
