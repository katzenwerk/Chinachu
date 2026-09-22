'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const operatorSchedulerRequest = require('../lib/operator-scheduler-request');

function cleanSummary(overrides) {
	return Object.assign({
		total: 10,
		completed: 10,
		skipped: 0,
		failed: 0,
		aborted: 0
	}, overrides || {});
}

function commonState(overrides) {
	return Object.assign({
		version: 3,
		lastSchedulerStartedAt: 0,
		lastSchedulerSuccessAt: 0,
		lastAppliedParentId: null,
		lastAppliedAt: 0,
		baselines: {}
	}, overrides || {});
}

function memoryState(initial) {
	let value = commonState(initial);
	return {
		load: () => Object.assign({}, value),
		save: state => { value = Object.assign({}, state); },
		recordSchedulerSuccess: (startedAt, successAt) => {
			value.lastSchedulerStartedAt = startedAt;
			value.lastSchedulerSuccessAt = successAt;
			return Object.assign({}, value);
		},
		recordAppliedParent: (parentId, appliedAt) => {
			value.lastAppliedParentId = parentId;
			value.lastAppliedAt = appliedAt;
			return Object.assign({}, value);
		},
		read: () => Object.assign({}, value)
	};
}

function createFixture(options) {
	options = options || {};
	const state = {
		running: options.running === true,
		shuttingDown: false,
		starts: 0,
		logs: []
	};
	const coordinator = operatorSchedulerRequest.createSchedulerRequest({
		isSchedulerRunning: () => state.running,
		isShuttingDown: () => state.shuttingDown,
		startScheduler: () => {
			state.starts++;
			state.running = true;
		},
		log: message => state.logs.push(message),
		stateStore: options.stateStore || null
	});

	return { state: state, coordinator: coordinator };
}

describe('Operator EPG scheduler requests', function() {
	it('starts one scheduler for a clean cycle and ignores the same parent twice', function() {
		const fixture = createFixture();

		assert.strictEqual(fixture.coordinator.requestEpgCycle('parent-1', cleanSummary()), true);
		assert.strictEqual(fixture.coordinator.requestEpgCycle('parent-1', cleanSummary()), false);
		assert.strictEqual(fixture.state.starts, 1);
	});

	it('treats skipped children as clean for scheduler triggering', function() {
		const fixture = createFixture();

		fixture.coordinator.requestEpgCycle('parent-skipped', cleanSummary({
			completed: 8,
			skipped: 2
		}));

		assert.strictEqual(fixture.state.starts, 1);
	});

	it('does not trigger for failed or abnormal aborted cycles', function() {
		const fixture = createFixture();

		assert.strictEqual(fixture.coordinator.requestEpgCycle('parent-failed', cleanSummary({ failed: 1 })), false);
		assert.strictEqual(fixture.coordinator.requestEpgCycle('parent-aborted', cleanSummary({ aborted: 1 })), false);
		assert.strictEqual(fixture.state.starts, 0);
		assert.match(fixture.state.logs[0], /scheduler skipped: parent=parent-failed failed=1 aborted=0/);
		assert.match(fixture.state.logs[1], /scheduler skipped: parent=parent-aborted failed=0 aborted=1/);
	});

	it('coalesces running-time requests into one scheduler start after exit', function() {
		const fixture = createFixture({ running: true });

		fixture.coordinator.requestEpgCycle('parent-a', cleanSummary());
		fixture.coordinator.requestEpgCycle('parent-b', cleanSummary());
		fixture.coordinator.requestEpgCycle('parent-b', cleanSummary());
		assert.deepStrictEqual(fixture.coordinator.getState(), {
			pending: true,
			pendingParentIds: [ 'parent-a', 'parent-b' ],
			activeParentIds: [],
			finalizedParentIds: [],
			lastSchedulerStartedAt: 0,
			lastSchedulerSuccessAt: 0,
			lastAppliedParentId: null
		});
		assert.strictEqual(fixture.state.starts, 0);

		fixture.state.running = false;
		assert.strictEqual(fixture.coordinator.onSchedulerExit(), true);
		assert.strictEqual(fixture.coordinator.onSchedulerExit(), false);
		assert.strictEqual(fixture.state.starts, 1);
		assert.strictEqual(fixture.coordinator.getState().pending, false);
	});

	it('isolates scheduler start failures from later requests', function() {
		const logs = [];
		const coordinator = operatorSchedulerRequest.createSchedulerRequest({
			isSchedulerRunning: () => false,
			startScheduler: () => { throw new Error('test start failure'); },
			log: message => logs.push(message)
		});

		assert.doesNotThrow(() => coordinator.requestEpgCycle('parent-error', cleanSummary()));
		assert.match(logs.join('\n'), /scheduler request failed: parent=parent-error error=test start failure/);
	});

	it('persists a parent only after its scheduler exits successfully', function() {
		const stateStore = memoryState();
		const fixture = createFixture({ stateStore: stateStore });

		fixture.coordinator.requestEpgCycle('parent-success', cleanSummary());
		assert.strictEqual(stateStore.read().lastAppliedParentId, null);

		// app-scheduler.js writes the generic success receipt before child exit.
		stateStore.recordSchedulerSuccess(4500, 5000);

		fixture.state.running = false;
		fixture.coordinator.onSchedulerExit({ successful: true, finishedAt: 5100 });
		assert.strictEqual(stateStore.read().lastSchedulerStartedAt, 4500);
		assert.strictEqual(stateStore.read().lastSchedulerSuccessAt, 5000);
		assert.strictEqual(stateStore.read().lastAppliedParentId, 'parent-success');
	});

	it('does not persist a requested parent after scheduler failure', function() {
		const stateStore = memoryState();
		const fixture = createFixture({ stateStore: stateStore });

		fixture.coordinator.requestEpgCycle('parent-failure', cleanSummary());
		fixture.state.running = false;
		fixture.coordinator.onSchedulerExit({ successful: false, finishedAt: 5000 });

		assert.strictEqual(stateStore.read().lastAppliedParentId, null);
		assert.strictEqual(fixture.coordinator.getState().finalizedParentIds.includes('parent-failure'), false);
	});

	it('isolates persistent state write failures', function() {
		const fixture = createFixture({
			stateStore: {
				load: () => commonState(),
				recordAppliedParent: () => { throw new Error('read-only test state'); }
			}
		});

		fixture.coordinator.requestEpgCycle('parent-state-error', cleanSummary());
		fixture.state.running = false;
		assert.doesNotThrow(() => fixture.coordinator.onSchedulerExit({ successful: true, finishedAt: 5000 }));
		assert.match(fixture.state.logs.join('\n'), /EPG: scheduler state save failed: read-only test state/);
	});

	it('falls back safely when persistent state cannot be loaded', function() {
		const logs = [];
		let starts = 0;
		const coordinator = operatorSchedulerRequest.createSchedulerRequest({
			isSchedulerRunning: () => false,
			startScheduler: () => { starts++; },
			stateStore: { load: () => { throw new Error('malformed test state'); } },
			log: message => logs.push(message)
		});

		assert.strictEqual(coordinator.requestEpgCycle('parent-load-error', cleanSummary()), true);
		assert.strictEqual(starts, 1);
		assert.match(logs.join('\n'), /EPG: scheduler state load failed: malformed test state/);
	});

	it('refreshes generic success written by a scheduler outside the operator coordinator', function() {
		const stateStore = memoryState();
		const fixture = createFixture({ stateStore: stateStore });
		stateStore.recordSchedulerSuccess(3000, 3500);

		assert.strictEqual(fixture.coordinator.requestEpgCycle('already-applied', cleanSummary(), {
			completedAt: 2500,
			source: 'reconciliation'
		}), false);
		assert.strictEqual(fixture.state.starts, 0);
		assert.strictEqual(fixture.coordinator.getState().lastSchedulerStartedAt, 3000);
	});
});
