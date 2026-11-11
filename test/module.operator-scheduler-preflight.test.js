'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
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

	const preflight = new preflightModule.OperatorSchedulerPreflight({
		worker: true,
		stateStore: store,
		fetchJobs: options.fetchJobs || (() => Promise.resolve(values.jobs)),
		fetchServices: options.fetchServices || (() => Promise.resolve(values.services)),
		fetchTuners: options.fetchTuners || (() => Promise.resolve(values.tuners)),
		paths: paths,
		now: () => 5000
	});

	return {
		directory: directory,
		paths: paths,
		values: values,
		baselines: baselines,
		store: store,
		preflight: preflight,
		async cleanup() {
			const worker = preflight.worker;
			preflight.stop();
			if (worker) await worker.terminate();
			fs.rmSync(directory, { recursive: true, force: true });
		}
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

function createOperatorLaunchFixture(store) {
	// Evaluate the actual launch/finalize/shutdown-completion functions without
	// starting Operator, opening sockets or reading its production ledgers.
	const source = fs.readFileSync(path.join(__dirname, '..', 'app-operator.js'), 'utf8');
	const start = source.indexOf('function startScheduler() {');
	const end = source.indexOf('function shutdownOperator(signal) {', start);
	assert.ok(start >= 0 && end > start);
	const children = [];
	const exits = [];
	const logs = [];
	const runtime = {
		scheduler: null, schedulerStartedAt: 0, shutdownStarted: false,
		matchLedgerProcess: null, pendingRecordedLedgerWrites: 0,
		maintenanceBusy: false, recordedMaintenance: { isBusy: () => runtime.maintenanceBusy },
		activeRecordingOutputs: new Set(), activeDurationProbes: new Set(), failedRecordingSaves: new Set(),
		process: { platform: process.platform, exit: code => exits.push(code) },
		operatorLog: message => logs.push(message),
		scheduleMatchLedgerUpdate: () => assert.fail('No overlapping match was started by this fixture'),
		wakePostProcessing: () => {},
		externalNotifier: { refreshOutcomes() {} },
		child_process: {
			spawn() {
				if (runtime.throwNext) { runtime.throwNext = false; throw new Error('spawn failed synchronously'); }
				const child = new EventEmitter();
				child.pid = runtime.failNext ? undefined : 100 + children.length;
				child.stdout = runtime.failNext ? null : { resume() {} };
				runtime.failNext = false;
				children.push(child);
				return child;
			}
		}
	};
	vm.runInNewContext(source.slice(start, end), runtime, { filename: 'app-operator-scheduler-fixture.js' });
	const coordinator = operatorSchedulerRequest.createSchedulerRequest({
		isSchedulerRunning: () => runtime.scheduler !== null,
		getSchedulerStartedAt: () => runtime.schedulerStartedAt,
		isShuttingDown: () => runtime.shutdownStarted,
		startScheduler: runtime.startScheduler,
		stateStore: store
	});
	runtime.schedulerRequest = coordinator;
	return { runtime, children, exits, logs, coordinator };
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
			let entered;
			let release;
			const fetching = new Promise(resolve => { entered = resolve; });
			const remoteReady = new Promise(resolve => { release = resolve; });
			const fetchJobs = local.preflight.fetchJobs;
			local.preflight.fetchJobs = () => { entered(); return remoteReady.then(fetchJobs); };
			const checking = local.preflight.check();
			assert.strictEqual(local.preflight.check(), checking);
			await fetching;
			assert.ok(local.preflight.worker, 'The actual check must execute in a Worker');
			writeJson(local.paths.rules, [ { types: [ 'BS' ] } ]);
			release();
			const changedWhileChecking = await checking;
			assert.strictEqual(changedWhileChecking.dirty, true);
			assert.ok(changedWhileChecking.reasons.includes('preflight-input-changed'));
			assert.strictEqual(local.preflight.worker, null);
			assert.strictEqual(local.preflight.getState().checkPending, false);
			local.preflight.fetchJobs = fetchJobs;
			assert.ok((await local.preflight.check()).reasons.includes('rules'));
			writeJson(local.paths.rules, local.values.rules);
			writeJson(local.paths.recorded, [{ id: 'new-recording' }]);
			const recordedOnly = await local.preflight.check();
			assert.strictEqual(recordedOnly.dirty, false);
			assert.ok(recordedOnly.advisory.includes('recorded'));
		} finally {
			await local.cleanup();
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
			await remote.cleanup();
		}
	});

	it('skips clean periodic checks, starts dirty updates, and falls back after worker failure', async function() {
		for (const testCase of [
			{
				workerFailure: false,
				expectedStarted: false,
				expectedStarts: 0
			},
			{
				workerFailure: false,
				changedRules: true,
				expectedStarted: true,
				expectedStarts: 1
			},
			{
				workerFailure: true,
				expectedStarted: true,
				expectedStarts: 1
			}
		]) {
			let starts = 0;
			const logs = [];
			const fixture = createFixture();
			if (testCase.changedRules) writeJson(fixture.paths.rules, [{ types: ['BS'] }]);
			if (testCase.workerFailure) {
				fixture.preflight.fetchJobs = async () => {
					await fixture.preflight.worker.terminate();
					return jobsFixture();
				};
			}
			const runner = new preflightModule.ShadowPeriodicScheduler({
				preflight: fixture.preflight,
				startScheduler: () => { starts++; return true; },
				log: message => logs.push(message)
			});
			try {
				const first = runner.request();
				const second = runner.request();
				assert.strictEqual(first, second);
				assert.strictEqual((await first).started, testCase.expectedStarted);
				assert.strictEqual(starts, testCase.expectedStarts);
				assert.strictEqual(logs.length, 1);
				assert.strictEqual(fixture.preflight.worker, null);
				assert.strictEqual(fixture.preflight.getState().checkPending, false);
				if (testCase.workerFailure) assert.match(logs[0], /preflight-error/);
			} finally {
				runner.stop();
				await fixture.cleanup();
			}
		}
	});

});

describe('Operator EPG scheduler requests', function() {
	it('records successful parents and releases failed Scheduler launches exactly once', function() {
		const fixture = createStateFixture();
		try {
			const request = createOperatorLaunchFixture(fixture.store);
			assert.strictEqual(request.coordinator.requestEpgCycle('parent-1', cleanSummary()), true);
			assert.strictEqual(request.coordinator.requestEpgCycle('parent-1', cleanSummary()), false);
			assert.strictEqual(request.children.length, 1);
			assert.strictEqual(fixture.store.load().lastAppliedParentId, null);

			fixture.store.recordSchedulerSuccess(4500, 5000);
			request.children[0].emit('exit', 0, null);
			request.children[0].emit('close', 0, null);
			const saved = fixture.store.load();
			assert.strictEqual(saved.lastSchedulerStartedAt, 4500);
			assert.strictEqual(saved.lastSchedulerSuccessAt, 5000);
			assert.strictEqual(saved.lastAppliedParentId, 'parent-1');
			assert.strictEqual(request.runtime.scheduler, null);
			assert.strictEqual(request.runtime.schedulerStartedAt, 0);

			request.runtime.failNext = true;
			assert.strictEqual(request.coordinator.requestEpgCycle('parent-2', cleanSummary()), true);
			assert.strictEqual(request.coordinator.requestEpgCycle('parent-3', cleanSummary()), true);
			const failedChild = request.children[1];
			failedChild.emit('error', new Error('spawn ./chinachu ENOENT'));
			assert.strictEqual(request.children.length, 3, 'Pending work must start after launch failure');
			assert.strictEqual(request.runtime.scheduler, request.children[2]);
			failedChild.emit('exit', 0, null);
			failedChild.emit('close', 0, null);
			assert.strictEqual(request.runtime.scheduler, request.children[2], 'Late events must not clear the next child');
			assert.strictEqual(fixture.store.load().lastAppliedParentId, 'parent-1');
			assert.strictEqual(request.coordinator.activeParentIds.has('parent-2'), false);
			request.children[2].emit('error', new Error('kill EPERM'));
			request.children[2].emit('error', new Error('kill EPERM'));
			assert.strictEqual(request.runtime.scheduler, request.children[2], 'A signalling error must not release a running child');
			request.children[2].emit('exit', 1, null);
			request.children[2].emit('close', 1, null);
			assert.strictEqual(request.runtime.scheduler, null);
			assert.strictEqual(request.runtime.schedulerStartedAt, 0);

			request.runtime.throwNext = true;
			assert.strictEqual(request.coordinator.requestEpgCycle('parent-2', cleanSummary()), false);
			assert.strictEqual(request.coordinator.activeParentIds.size, 0);
			request.runtime.failNext = true;
			assert.strictEqual(request.coordinator.requestEpgCycle('parent-2', cleanSummary()), true);
			request.runtime.shutdownStarted = true;
			request.runtime.maintenanceBusy = true;
			request.children[3].emit('error', new Error('spawn ./chinachu EACCES'));
			request.children[3].emit('close', -1, null);
			assert.strictEqual(request.runtime.scheduler, null);
			assert.strictEqual(request.runtime.schedulerStartedAt, 0);
			assert.deepStrictEqual(request.exits, [], 'Shutdown waits for recorded maintenance');
			request.runtime.maintenanceBusy = false;
			request.runtime.completeOperatorShutdown();
			assert.deepStrictEqual(request.exits, [0], 'Shutdown completion must run only once');
			assert.strictEqual(fixture.store.load().lastAppliedParentId, 'parent-1');
			assert.ok(request.logs.some(message => /Scheduler process failed.*ENOENT/.test(message)));
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
