'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const schedulerState = require('../lib/scheduler-state');

function state(overrides) {
	return Object.assign({
		version: 3,
		lastSchedulerStartedAt: 0,
		lastSchedulerSuccessAt: 0,
		lastAppliedParentId: null,
		lastAppliedAt: 0,
		baselines: schedulerState.emptyBaselines()
	}, overrides || {});
}

describe('Common scheduler persistent state', function() {
	it('atomically round-trips version 3 state with private permissions', function() {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-scheduler-state-'));
		const file = path.join(directory, 'state.json');
		try {
			const store = new schedulerState.SchedulerStateStore(file);
			assert.deepStrictEqual(store.load(), state());
			store.save(state({
				lastSchedulerStartedAt: 3000,
				lastSchedulerSuccessAt: 4000,
				lastAppliedParentId: 'parent-1',
				lastAppliedAt: 4000
			}));

			assert.deepStrictEqual(store.load(), state({
				lastSchedulerStartedAt: 3000,
				lastSchedulerSuccessAt: 4000,
				lastAppliedParentId: 'parent-1',
				lastAppliedAt: 4000
			}));
			assert.deepStrictEqual(fs.readdirSync(directory), [ 'state.json' ]);
			assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('records generic success without clearing EPG applied state', function() {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-scheduler-state-'));
		const file = path.join(directory, 'state.json');
		try {
			const store = new schedulerState.SchedulerStateStore(file);
			store.save(state({ lastAppliedParentId: 'parent-1', lastAppliedAt: 2000 }));
			store.recordSchedulerSuccess(3000, 4000);
			assert.deepStrictEqual(store.load(), state({
				lastSchedulerStartedAt: 3000,
				lastSchedulerSuccessAt: 4000,
				lastAppliedParentId: 'parent-1',
				lastAppliedAt: 2000
			}));
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('rejects corrupted or unsupported current state instead of trusting legacy data', function() {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-scheduler-state-'));
		const file = path.join(directory, 'scheduler-state.json');
		const legacy = path.join(directory, 'epg-scheduler-state.json');
		try {
			fs.writeFileSync(file, '{broken');
			fs.writeFileSync(legacy, JSON.stringify({ version: 1 }));
			const store = new schedulerState.SchedulerStateStore(file, { legacyFilePath: legacy });
			assert.throws(() => store.load(), /Unexpected token|Expected property name/);
			assert.strictEqual(fs.readFileSync(file, 'utf8'), '{broken');
			assert.throws(() => schedulerState.normalizeState({ version: 1 }), /unsupported state version/);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});
