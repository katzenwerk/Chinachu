'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const epgReconcile = require('../lib/mirakurun-epg-reconcile');
const schedulerRequest = require('../lib/operator-scheduler-request');

const GRACE = 1000 * 60 * 10;

function jobsFixture(childOverrides) {
	const children = (childOverrides || [ {}, {} ]).map((overrides, index) => Object.assign({
		id: 'child-' + index,
		key: 'EPG.Gather.NID.' + (index + 1),
		status: 'finished',
		createdAt: 1100 + index,
		finishedAt: 2000 + index
	}, overrides));

	return [ {
		id: 'parent-latest',
		key: 'EPG.Gatherer',
		status: 'finished',
		startedAt: 1000,
		finishedAt: 1200
	} ].concat(children);
}

function manualTimers() {
	const timers = [];
	return {
		timers: timers,
		setTimeout: (callback, delay) => {
			const timer = { callback: callback, delay: delay, cleared: false };
			timers.push(timer);
			return timer;
		},
		clearTimeout: timer => { timer.cleared = true; }
	};
}

function memoryState(initial) {
	let state = Object.assign({
		version: 2,
		lastSchedulerStartedAt: 0,
		lastSchedulerSuccessAt: 0,
		lastAppliedParentId: null,
		lastAppliedAt: 0
	}, initial || {});
	return {
		load: () => Object.assign({}, state),
		save: value => { state = Object.assign({}, value); },
		recordSchedulerSuccess: (startedAt, successAt) => {
			state.lastSchedulerStartedAt = startedAt;
			state.lastSchedulerSuccessAt = successAt;
			return Object.assign({}, state);
		},
		recordAppliedParent: (parentId, appliedAt) => {
			state.lastAppliedParentId = parentId;
			state.lastAppliedAt = appliedAt;
			return Object.assign({}, state);
		},
		read: () => Object.assign({}, state)
	};
}

function completeScheduler(fixture, startedAt, successAt, finishedAt) {
	fixture.store.recordSchedulerSuccess(startedAt, successAt);
	fixture.runtime.running = false;
	fixture.coordinator.onSchedulerExit({ successful: true, finishedAt: finishedAt || successAt });
}

function integrationFixture(options) {
	options = options || {};
	const runtime = {
		running: options.running === true,
		startedAt: options.schedulerStartedAt || 0,
		starts: 0,
		logs: []
	};
	const store = options.store || memoryState(options.initialState);
	const coordinator = schedulerRequest.createSchedulerRequest({
		isSchedulerRunning: () => runtime.running,
		getSchedulerStartedAt: () => runtime.startedAt,
		startScheduler: () => {
			runtime.starts++;
			runtime.running = true;
			runtime.startedAt = options.now || GRACE + 5000;
			return true;
		},
		stateStore: store,
		log: message => runtime.logs.push(message)
	});
	const timers = manualTimers();
	const reconciler = epgReconcile.createReconciler({
		fetchJobs: options.fetchJobs || (async () => jobsFixture(options.children)),
		requestCycle: (parentId, summary, metadata) => coordinator.requestEpgCycle(parentId, summary, metadata),
		now: () => options.now || GRACE + 5000,
		setTimeout: timers.setTimeout,
		clearTimeout: timers.clearTimeout,
		log: message => runtime.logs.push(message)
	});
	reconciler.start();
	return { runtime: runtime, store: store, coordinator: coordinator, reconciler: reconciler, timers: timers };
}

describe('Mirakurun EPG reconciliation', function() {
	it('recovers a completed clean cycle without observing its active parent event', async function() {
		const fixture = integrationFixture({
			children: [ {}, { hasSkipped: true, hasAborted: true } ]
		});
		const cycle = await fixture.reconciler.check();

		assert.strictEqual(cycle.parentId, 'parent-latest');
		assert.deepStrictEqual(cycle.summary, { total: 2, completed: 1, skipped: 1, failed: 0, aborted: 0 });
		assert.strictEqual(fixture.runtime.starts, 1);
		assert.match(fixture.runtime.logs.join('\n'), /EPG: reconciliation recovered: parent=parent-latest/);
	});

	it('does nothing while any child is running or standby', async function() {
		for (const status of [ 'running', 'standby' ]) {
			const fixture = integrationFixture({ children: [ { status: status, finishedAt: undefined }, {} ] });
			assert.strictEqual(await fixture.reconciler.check(), null);
			assert.strictEqual(fixture.runtime.starts, 0);
		}
	});

	it('does nothing when the latest parent has no children', async function() {
		const fixture = integrationFixture({ children: [] });
		assert.strictEqual(await fixture.reconciler.check(), null);
		assert.strictEqual(fixture.runtime.starts, 0);
	});

	it('does not start recovery for failed or abnormal aborted cycles', async function() {
		for (const child of [ { hasFailed: true }, { hasAborted: true } ]) {
			const fixture = integrationFixture({ children: [ child ] });
			await fixture.reconciler.check();
			assert.strictEqual(fixture.runtime.starts, 0);
			assert.match(fixture.runtime.logs.join('\n'), /EPG: reconciliation skipped: parent=parent-latest/);
		}
	});

	it('does not duplicate a parent already requested by the live watcher', async function() {
		const fixture = integrationFixture();
		fixture.coordinator.requestEpgCycle('parent-latest', {
			total: 2, completed: 2, skipped: 0, failed: 0, aborted: 0
		});
		await fixture.reconciler.check();
		assert.strictEqual(fixture.runtime.starts, 1);
	});

	it('does not recover a cycle followed by an already successful scheduler', async function() {
		const fixture = integrationFixture({
			initialState: { lastSchedulerStartedAt: 3000, lastSchedulerSuccessAt: 3500 }
		});
		await fixture.reconciler.check();
		assert.strictEqual(fixture.runtime.starts, 0);
	});

	it('does not treat a scheduler started before EPG completion as already applied', async function() {
		const store = memoryState();
		store.recordSchedulerSuccess(1500, 3000);

		const restarted = integrationFixture({ store: store });
		await restarted.reconciler.check();
		assert.strictEqual(restarted.runtime.starts, 1);
	});

	it('associates recovery with a running scheduler that started after EPG completion', async function() {
		const store = memoryState();
		const fixture = integrationFixture({ running: true, schedulerStartedAt: 3000, store: store });
		await fixture.reconciler.check();

		assert.strictEqual(fixture.runtime.starts, 0);
		assert.strictEqual(fixture.coordinator.getState().pending, false);
		assert.deepStrictEqual(fixture.coordinator.getState().activeParentIds, [ 'parent-latest' ]);

		completeScheduler(fixture, 3000, 3900, 4000);
		const restarted = integrationFixture({ store: store });
		await restarted.reconciler.check();
		assert.strictEqual(restarted.runtime.starts, 0);
	});

	it('does not mark a request applied before scheduler success and recovers it after restart', async function() {
		const store = memoryState();
		const first = integrationFixture({ store: store });
		await first.reconciler.check();
		assert.strictEqual(store.read().lastSchedulerSuccessAt, 0);

		const restarted = integrationFixture({ store: store });
		await restarted.reconciler.check();
		assert.strictEqual(restarted.runtime.starts, 1);
	});

	it('persists recovery success and skips the same parent after restart', async function() {
		const store = memoryState();
		const first = integrationFixture({ store: store });
		await first.reconciler.check();
		completeScheduler(first, 3000, 3900, 4000);

		const restarted = integrationFixture({ store: store });
		await restarted.reconciler.check();
		assert.strictEqual(restarted.runtime.starts, 0);
		assert.strictEqual(store.read().lastAppliedParentId, 'parent-latest');
	});

	it('shares one in-flight snapshot check and one scheduler request', async function() {
		let resolveJobs;
		let fetches = 0;
		const jobsPromise = new Promise(resolve => { resolveJobs = resolve; });
		const fixture = integrationFixture({
			fetchJobs: () => { fetches++; return jobsPromise; }
		});
		const first = fixture.reconciler.check();
		const second = fixture.reconciler.check();
		assert.strictEqual(first, second);
		resolveJobs(jobsFixture());
		await first;
		assert.strictEqual(fetches, 1);
		assert.strictEqual(fixture.runtime.starts, 1);
	});

	it('clears its timer and suppresses a pending snapshot result after shutdown', async function() {
		let resolveJobs;
		const jobsPromise = new Promise(resolve => { resolveJobs = resolve; });
		const fixture = integrationFixture({ fetchJobs: () => jobsPromise });
		const check = fixture.reconciler.check();
		fixture.reconciler.stop();

		assert.strictEqual(fixture.timers.timers[0].cleared, true);
		resolveJobs(jobsFixture());
		assert.strictEqual(await check, null);
		assert.strictEqual(fixture.runtime.starts, 0);
		assert.strictEqual(fixture.timers.timers.length, 1);
	});

	it('isolates jobs API failures and keeps scheduling later checks', async function() {
		const fixture = integrationFixture({
			fetchJobs: async () => { throw new Error('jobs unavailable'); }
		});
		assert.strictEqual(await fixture.reconciler.check(), null);
		assert.strictEqual(fixture.runtime.starts, 0);
		assert.match(fixture.runtime.logs.join('\n'), /EPG: reconciliation failed: jobs unavailable/);
		assert.strictEqual(fixture.reconciler.getState().timerPending, true);
	});

	it('waits for the parent grace period before considering recovery', async function() {
		const fixture = integrationFixture({ now: 1000 + GRACE - 1 });
		assert.strictEqual(await fixture.reconciler.check(), null);
		assert.strictEqual(fixture.runtime.starts, 0);
	});

	it('does not fall back to an older finished parent while the latest parent is active', async function() {
		const jobs = jobsFixture().concat([ {
			id: 'parent-active',
			key: 'EPG.Gatherer',
			status: 'running',
			startedAt: 5000
		} ]);
		assert.strictEqual(epgReconcile.findLatestSettledCycle(jobs, GRACE + 6000, GRACE), null);
	});
});
