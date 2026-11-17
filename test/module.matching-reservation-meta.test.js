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
function ledger(options = {}) {
	return matching.buildMatchLedger({ nowMs, keepDays: 0, ...options }).results;
}


describe('Matching v2 reservation identity', function() {
	it('retains ruleUid after reservation removal without retaining v1 metadata', function() {
		const original = ledger({ recordedList: [recorded], reserves2List: [reservation] });
		const before = JSON.stringify(original);
		assert.strictEqual(original[0].ruleUid, reservation.ruleUid);
		const rebuilt = ledger({ oldResults: original, recordedList: [recorded] });
		assert.strictEqual(rebuilt[0].ruleUid, reservation.ruleUid);
		assert.strictEqual(rebuilt[0].status, 'RECORDED');
		assert.strictEqual(rebuilt[0].recording.recordedId, recorded.id);
		assert.strictEqual(rebuilt[0].reservationMeta, undefined);
		assert.strictEqual(rebuilt[0].sources, undefined);
		assert.strictEqual(rebuilt[0].recd_flg, undefined);
		assert.strictEqual(JSON.stringify(original), before);
	});

	it('uses matching current rule identity and preserves recorded history without match paths', function() {
		const old = ledger({ recordedList: [recorded], reserves2List: [reservation] });
		const current = { ...program, ruleUid: 'current-rule', recordedDir: '/fixture/other/' };
		const updated = ledger({ oldResults: old, recordedList: [recorded], reserves2List: [current] })[0];
		assert.strictEqual(updated.ruleUid, 'current-rule');
		assert.strictEqual(updated.reservationMeta, undefined);
		const other = { ...recorded, id: 'another-recording', start: program.start + 60000, end: program.end + 60000 };
		const metadataOnly = ledger({ reserves2List: [reservation] });
		const unrelated = ledger({ oldResults: metadataOnly, recordedList: [other] }).find(row => row.status === 'RECORDED_UNTRACKED');
		assert.strictEqual(unrelated.ruleUid, null);
		assert.strictEqual(unrelated.recording.recordedId, other.id);
		const missed = ledger({ reserves2List: [reservation] })[0];
		assert.strictEqual(matching.mergeOldNew(old[0], missed), old[0]);
		const rebuilt = ledger({ oldResults: old, recordedList: [{ ...recorded, recorded: '/fixture/temp/program.m2ts' }], reserves2List: [reservation] })[0];
		assert.strictEqual(rebuilt.status, 'RECORDED');
		assert.deepStrictEqual(rebuilt.recording, { recordedId: recorded.id });
		assert.strictEqual(rebuilt.program, undefined);
		assert.strictEqual(rebuilt.recordingResult, undefined);
	});
});
