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
		version: 3,
		lastSchedulerStartedAt: 0,
		lastSchedulerSuccessAt: 0,
		lastAppliedParentId: null,
		lastAppliedAt: 0,
		baselines: {}
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

	it('does not start recovery for failed or abnormal aborted cycles', async function() {
		for (const child of [ { hasFailed: true }, { hasAborted: true } ]) {
			const fixture = integrationFixture({ children: [ child ] });
			await fixture.reconciler.check();
			assert.strictEqual(fixture.runtime.starts, 0);
			assert.match(fixture.runtime.logs.join('\n'), /EPG: reconciliation skipped: parent=parent-latest/);
		}
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

});
