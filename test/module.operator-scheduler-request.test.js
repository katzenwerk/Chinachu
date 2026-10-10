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

	it('does not trigger for failed or abnormal aborted cycles', function() {
		const fixture = createFixture();

		assert.strictEqual(fixture.coordinator.requestEpgCycle('parent-failed', cleanSummary({ failed: 1 })), false);
		assert.strictEqual(fixture.coordinator.requestEpgCycle('parent-aborted', cleanSummary({ aborted: 1 })), false);
		assert.strictEqual(fixture.state.starts, 0);
		assert.match(fixture.state.logs[0], /scheduler skipped: parent=parent-failed failed=1 aborted=0/);
		assert.match(fixture.state.logs[1], /scheduler skipped: parent=parent-aborted failed=0 aborted=1/);
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

});
