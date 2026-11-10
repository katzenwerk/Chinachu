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
	isManualReserved: true, allowEndLack: true,
	snapshotAt: nowMs - 7200000, updatedAt: nowMs - 7200000, source: 'scheduler'
};
const recorded = { ...program, recorded: '/fixture/recorded-a/program.m2ts' };
const snapshotFields = ['ruleId', 'ruleIdSource', 'ruleUid', 'recordedDirId', 'recordedDir', 'isManualReserved', 'allowEndLack', 'reserveSnapshotAt', 'reserveUpdatedAt'];

function ledger(options = {}) {
	return matching.buildMatchLedger({ nowMs, keepDays: 0, ...options }).results;
}

function snapshot(meta) {
	return Object.fromEntries(snapshotFields.map(key => [key, meta[key]]));
}

describe('Matching reservation snapshots', function() {
	it('normalizes absent metadata and retains a removed reservation snapshot across rebuilds', function() {
		[matching.buildReservationMeta({}, true), matching.buildReservationMeta(null, false)].forEach(meta => {
			assert.deepStrictEqual(snapshot(meta), {
				ruleId: null, ruleIdSource: null, ruleUid: null, recordedDirId: null, recordedDir: null,
				isManualReserved: false, allowEndLack: false, reserveSnapshotAt: null, reserveUpdatedAt: null
			});
		});
		const legacy = matching.buildReservationMeta({ ruleId: 0 }, true);
		assert.strictEqual(legacy.ruleId, 0);
		assert.strictEqual(legacy.ruleIdSource, null);

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

	it('uses only matching current metadata and preserves recorded status without retaining match paths', function() {
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

		const other = { ...recorded, start: program.start + 60000, end: program.end + 60000 };
		const metadataOnly = ledger({ reserves2List: [reservation] });
		const result = ledger({ oldResults: metadataOnly, recordedList: [other] })
			.find(row => row.status === 'RECORDED_UNTRACKED');
		assert.strictEqual(result.reservationMeta.ruleId, null);

		const previous = old[0];
		const missed = ledger({ reserves2List: [reservation] })[0];
		assert.strictEqual(matching.mergeOldNew(previous, missed), previous);
		const temporary = ledger({
			recordedList: [{ ...recorded, recorded: '/fixture/temp/program.m2ts' }], reserves2List: [reservation]
		})[0];
		const merged = matching.mergeOldNew(previous, temporary, null, { temporaryDir: '/fixture/temp/' });
		assert.deepStrictEqual(merged, temporary);
		assert.strictEqual(merged.status, 'RECORDED');
		assert.strictEqual(merged.recordingResult.id, recorded.id);
		assert.strictEqual(merged.recordingResult.path, undefined);
		assert.strictEqual(merged.program.recorded, undefined);
		assert.strictEqual(merged.recordingResult.snapshot.recorded, undefined);
	});
});
