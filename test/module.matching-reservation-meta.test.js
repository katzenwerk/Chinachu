'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const matching = require('../app-matching');

const nowMs = Date.UTC(2026, 9, 1, 12);
const program = {
	id: 'snapshot-program', start: nowMs - 3600000, end: nowMs - 1800000, seconds: 1800,
	title: 'Fixture anime', channel: { id: 'fixture-channel', name: 'Fixture channel', type: 'GR' }
};
const reservation = {
	...program, ruleId: 0, ruleIdSource: 'index', ruleUid: 'uid-recorded-a', recordedDirId: 'recorded-a', recordedDir: '/fixture/recorded-a/',
	snapshotAt: nowMs - 7200000, updatedAt: nowMs - 7200000, source: 'scheduler'
};
const recorded = { ...program, recorded: '/fixture/recorded-a/program.m2ts' };
const snapshotFields = ['ruleId', 'ruleIdSource', 'ruleUid', 'recordedDirId', 'recordedDir', 'reserveSnapshotAt', 'reserveUpdatedAt'];

function ledger(options = {}) {
	return matching.buildMatchLedger({ nowMs, keepDays: 0, ...options }).results;
}

function snapshot(meta) {
	return Object.fromEntries(snapshotFields.map(key => [key, meta[key]]));
}

describe('Matching reservation snapshots', function() {
	it('uses null for absent fields in legacy reserves and recorded-only entries', function() {
		[matching.buildReservationMeta({}, true), matching.buildReservationMeta(null, false)].forEach(meta => {
			assert.deepStrictEqual(snapshot(meta), Object.fromEntries(snapshotFields.map(key => [key, null])));
		});
		const legacy = matching.buildReservationMeta({ ruleId: 0 }, true);
		assert.strictEqual(legacy.ruleId, 0);
		assert.strictEqual(legacy.ruleIdSource, null);
	});

	it('retains snapshots across repeated recorded-only rebuilds without changing current-input flags', function() {
		const original = ledger({ recordedList: [recorded], reserves2List: [reservation] });
		const before = JSON.stringify(original);
		const expected = snapshot(original[0].reservationMeta);
		let previous = original;
		for (let i = 0; i < 2; i++) {
			previous = ledger({
				oldResults: previous, recordedList: [recorded],
				config: { recordedDirs: [{ id: 'recorded-a', path: '/fixture/changed/' }], recordedDir: '/fixture/default/' }
			});
			assert.deepStrictEqual(snapshot(previous[0].reservationMeta), expected);
			assert.strictEqual(previous[0].reservationMeta.hasReserve, false);
			assert.strictEqual(previous[0].reservationMeta.source, null);
			assert.strictEqual(previous[0].sources.reservationMeta, null);
			assert.strictEqual(previous[0].recd_flg.hasReserve, false);
			assert.strictEqual(previous[0].matchMeta.matchedBy, 'recorded-only');
			assert.strictEqual(previous[0].status, 'RECORDED_UNTRACKED');
		}
		assert.strictEqual(JSON.stringify(original), before);
	});

	it('preserves legacy ruleId without inferring its source or directory', function() {
		const old = ledger({ reserves2List: [{ ...program, ruleId: '' }] });
		delete old[0].reservationMeta.ruleIdSource;
		delete old[0].reservationMeta.recordedDirId;
		delete old[0].reservationMeta.recordedDir;
		const result = ledger({ oldResults: old, recordedList: [recorded] })[0];
		assert.strictEqual(result.reservationMeta.ruleId, '');
		['ruleIdSource', 'ruleUid', 'recordedDirId', 'recordedDir'].forEach(key => assert.strictEqual(result.reservationMeta[key], null));
	});

	it('uses a new reservation as a whole, including missing values, after rule changes', function() {
		const old = ledger({ recordedList: [recorded], reserves2List: [reservation] });
		[
			{ ...program, ruleId: 'new-rule', ruleIdSource: 'id', recordedDirId: 'recorded-b', recordedDir: '/fixture/recorded-b/' },
			{ ...program, ruleId: 1, ruleIdSource: 'index' },
			{ ...program }
		].forEach(reserve => {
			const result = ledger({ oldResults: old, recordedList: [recorded], reserves2List: [reserve] })[0];
			assert.deepStrictEqual(result.reservationMeta, matching.buildReservationMeta(reserve, true));
			assert.strictEqual(result.sources.reservationMeta, 'reserves2');
		});
	});

	it('does not borrow a snapshot from a different program key or create one for old entries without metadata', function() {
		const old = ledger({ reserves2List: [reservation] });
		const other = { ...recorded, start: program.start + 60000, end: program.end + 60000 };
		const result = ledger({ oldResults: old, recordedList: [other] }).find(row => row.status === 'RECORDED_UNTRACKED');
		assert.strictEqual(result.reservationMeta.ruleId, null);
		delete old[0].reservationMeta;
		assert.strictEqual(ledger({ oldResults: old, recordedList: [recorded] })[0].reservationMeta.ruleId, null);
	});

	it('keeps the existing recorded-status and final-path protection branches', function() {
		const old = ledger({ recordedList: [recorded], reserves2List: [reservation] })[0];
		const missed = ledger({ reserves2List: [reservation] })[0];
		assert.strictEqual(matching.mergeOldNew(old, missed), old);
		const temporary = ledger({
			recordedList: [{ ...recorded, recorded: '/fixture/temp/program.m2ts' }], reserves2List: [reservation]
		})[0];
		assert.strictEqual(matching.mergeOldNew(old, temporary, null, { temporaryDir: '/fixture/temp/' }), old);
	});
});
