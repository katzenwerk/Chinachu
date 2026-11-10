'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const matching = require('../app-matching');
const matchV2 = require('../lib/match-v2');
const reservationStore = require('../lib/reservation-store');

const nowMs = Date.UTC(2026, 9, 12, 12);
const start = nowMs - 3600000;
const base = {
	id: 'recorded-a',
	start,
	end: start + 1800000,
	seconds: 1800,
	title: 'Fixture title',
	fullTitle: 'Fixture full title',
	ruleUid: 'rule-a',
	channel: { id: 'channel-a', name: 'Channel A', type: 'GR' }
};
const key = matching.makeCanonicalKey(base);

function v2(overrides = {}) {
	return {
		schemaVersion: 2,
		key,
		status: 'RECORDED',
		start,
		end: start + 1800000,
		fullTitle: 'Fixture full title',
		ruleUid: null,
		recording: { recordedId: 'recorded-a', path: '/fixture/a.m2ts' },
		deletion: null,
		...overrides
	};
}

function writeJson(file, value) {
	fs.writeFileSync(file, JSON.stringify(value));
}

function withFixture(callback) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-match-v2-'));
	try {
		return callback(directory);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
}

describe('Match v2 writer and migration', function () {
	it('writes only the minimal v2 schema for every current status', function () {
		const future = { ...base, id: 'future', start: nowMs + 3600000, end: nowMs + 5400000 };
		const missed = { ...base, id: 'missed', channel: { ...base.channel, id: 'channel-missed' } };
		const skipped = { ...base, id: 'skipped', channel: { ...base.channel, id: 'channel-skip' }, isSkip: true };
		const recorded = { ...base, recorded: '/fixture/a.m2ts', recordedDurationSeconds: 1700, savedTsAnalysis: { schemaVersion: 1, status: 'complete', registeredPath: '/fixture/a.m2ts', file: { path: '/fixture/a.m2ts' } } };
		const untracked = {
			...base,
			id: 'recorded-b',
			ruleUid: 'rule-b',
			channel: { ...base.channel, id: 'channel-b' },
			recorded: '/fixture/b.m2ts'
		};
		const results = matching.buildMatchLedger({
			nowMs,
			keepDays: 0,
			schemaVersion: 2,
			recordedReadOk: true,
			recordedList: [recorded, untracked],
			reserves2List: [base, future, missed, skipped]
		}).results;
		const statuses = results.map(entry => entry.status).sort();

		assert.deepStrictEqual(statuses, ['MISSED', 'RECORDED', 'RECORDED_UNTRACKED', 'RESERVED', 'SKIPPED_ONLY']);
		// The contract is the persisted JSON. Optional undefined metadata is omitted.
		const persisted = JSON.parse(JSON.stringify(results));
		persisted.forEach(entry => {
			const fields = ['deletion', 'end', 'fullTitle', 'key', 'recording', 'ruleUid', 'schemaVersion', 'start', 'status'];
			if (entry.recording?.recordedId === 'recorded-a') fields.push('recordedDurationSeconds', 'savedTsAnalysis');
			assert.deepStrictEqual(Object.keys(entry).sort(), fields.sort());
			assert.equal(entry.schemaVersion, 2);
			assert.equal(entry.program, undefined);
			assert.equal(entry.recordingResult, undefined);
			assert.equal(entry.reservationMeta, undefined);
			assert.equal(entry.matchMeta, undefined);
			assert.equal(entry.recording?.path, undefined);
		});
		const saved = persisted.find(entry => entry.recording?.recordedId === 'recorded-a');
		assert.equal(saved.recordedDurationSeconds, recorded.recordedDurationSeconds);
		assert.deepStrictEqual(saved.savedTsAnalysis, { schemaVersion: 1, status: 'complete', file: { path: '/fixture/a.m2ts' } });
		assert.equal(saved.ruleUid, 'rule-a');
		assert.equal(results.find(entry => entry.recording?.recordedId === 'recorded-b').ruleUid, 'rule-b');
	});

	it('recovers only the same recorded-missing entry while preserving explicit or ambiguous deletion', function () {
		const old = v2({ deletion: { deletedAt: nowMs - 1000, reason: 'manual' } });
		const missing = v2({ deletion: { deletedAt: null, reason: 'recorded-missing' } });
		const same = v2({ deletion: null });
		const sameWithoutReservation = v2({ status: 'RECORDED_UNTRACKED', deletion: null });
		const replaced = v2({
			recording: { recordedId: 'recorded-new', path: '/fixture/new.m2ts' },
			deletion: null
		});

		assert.deepStrictEqual(matching.mergeOldNew(old, same, null, null, { recordedReadOk: true }).deletion, old.deletion);
		assert.equal(matching.mergeOldNew(missing, same, null, null, { recordedReadOk: true }).deletion, null);
		assert.deepStrictEqual(matching.mergeOldNew(missing, same).deletion, missing.deletion);
		assert.equal(matching.mergeOldNew(missing, replaced, null, null, { recordedReadOk: true }).recording.recordedId,
			'recorded-a');
		assert.equal(matching.mergeOldNew(old, sameWithoutReservation).status, 'RECORDED');
		assert.equal(matching.mergeOldNew(old, replaced).deletion, null);
		assert.equal(matching.mergeOldNew(v2({ ruleUid: 'rule-old' }), v2({ ruleUid: null })).ruleUid, 'rule-old');
		const fact = { recordedId: same.recording.recordedId, checkedAt: nowMs };
		const lost = v2({ fileMissing: fact, deletion: { deletedAt: null, reason: 'recorded-missing' } });
		const retained = matching.mergeOldNew(lost, same, null, null, { recordedReadOk: true });
		assert.deepStrictEqual(retained.fileMissing, fact); // Restored recorded.json is not a file discovery.
		assert.equal(retained.deletion, null);
		assert.deepStrictEqual(matchV2.toV2Entry(lost).fileMissing, fact);
		assert.deepStrictEqual(matchV2.toV2Entry(v2({ recording: { recordedId: 'recorded-a', path: '/legacy/old.m2ts' } })).recording,
			{ recordedId: 'recorded-a' });
		assert.deepStrictEqual(matchV2.toV2Entry(v2({ recording: null, fileMissing: fact })).fileMissing, fact);
		assert.equal(matching.mergeOldNew(lost, replaced, null, null, { recordedReadOk: true }).fileMissing, undefined);
		for (const reason of ['manual', 'storage-low']) {
			const terminal = v2({ deletion: { reason, deletedAt: nowMs }, fileMissing: fact });
			const merged = matching.mergeOldNew(terminal, same, null, null, { recordedReadOk: true });
			assert.equal(merged.deletion.reason, reason);
			assert.equal(merged.fileMissing, undefined);
			assert.equal(matching.mergeOldNew(terminal, replaced).deletion, null);
		}

	});

	it('reads the latest match under the common lock and preserves concurrent deletion history', function () {
		const latest = [v2({ deletion: { deletedAt: nowMs - 1000, reason: 'manual' } })];
		const calls = [];
		let locked = false;
		let saved = null;
		const store = {
			withLock(file, callback) {
				calls.push('lock:' + file);
				locked = true;
				try { return callback(); } finally { locked = false; calls.push('unlock:' + file); }
			},
			readArray(file) {
				assert.equal(locked, true);
				calls.push('read:' + file);
				return JSON.parse(JSON.stringify(latest));
			},
			writeArrayAtomic(file, value) {
				assert.equal(locked, true);
				calls.push('write:' + file);
				saved = JSON.parse(JSON.stringify(value));
			}
		};

		matching.writeMatchLedgerLocked({
			output: '/fixture/match.json',
			recordedList: [{ ...base, recorded: '/fixture/a.m2ts' }],
			recordingList: [],
			reserves2List: [base],
			nowMs,
			keepDays: 0,
			keepMonths: 3,
			readDays: 14,
			keepRecordedSnapshot: false,
			config: {},
			schemaVersion: 2,
			initialBuild: false,
			reservationStore: store
		});

		assert.deepStrictEqual(calls, [
			'lock:/fixture/match.json', 'read:/fixture/match.json',
			'write:/fixture/match.json', 'unlock:/fixture/match.json'
		]);
		assert.deepStrictEqual(saved[0].deletion, latest[0].deletion);
		assert.throws(() => matching.writeMatchLedgerLocked({
			output: '/fixture/match.json',
			schemaVersion: 2,
			reservationStore: { withLock() { throw new Error('fixture lock failed'); } }
		}), /fixture lock failed/);
	});

	it('adds recorded-missing only after canonical, active-recording and grace guards', function () {
		const deleted = v2({ deletion: { deletedAt: 1, reason: 'storage-low' } });
		const wrongCanonical = { ...base, start: start + 60000, end: start + 1860000, recorded: '/fixture/a.m2ts' };
		const withinGrace = v2({ key: 'channel-c|' + (nowMs - 1000) + '|1', start: nowMs - 1000, end: nowMs });
		const results = matchV2.markRecordedMissing([v2(), deleted, withinGrace], [wrongCanonical], {
			recordedReadOk: true,
			recordingList: [],
			nowMs
		});

		assert.deepStrictEqual(results[0].deletion, { deletedAt: null, reason: 'recorded-missing' });
		assert.deepStrictEqual(results[1].deletion, deleted.deletion);
		assert.equal(results[2].deletion, null);
		assert.equal(matchV2.markRecordedMissing([v2()], [], { recordedReadOk: false, nowMs })[0].deletion, null);
		assert.equal(matchV2.markRecordedMissing([v2()], [], {
			recordedReadOk: true,
			recordingList: [{ ...base }],
			nowMs
		})[0].deletion, null);
	});

	it('converts mixed legacy data once, preserves explicit deletion and keeps the original backup', function () {
		withFixture(directory => {
			const matchFile = path.join(directory, 'match.json');
			const backupFile = path.join(directory, 'match.before-v2.json');
			const legacy = matching.buildMatchItem(
				'RECORDED', key, { ...base, recorded: '/fixture/a.m2ts' }, base, base.channel,
				true, true, false, true, false, nowMs, true, {}
			);
			legacy.recordingResult.cleanupState = 'deleted';
			legacy.recordingResult.deletedAt = nowMs - 1000;
			legacy.recordingResult.cleanupReason = 'manual';
			const original = [legacy, v2({
				key: 'channel-b|' + start + '|1800',
				recording: { recordedId: 'recorded-b', path: '/fixture/b.m2ts' }
			})];
			writeJson(matchFile, original);

			const result = matchV2.runV2Fix({
				matchFile, backupFile, nowMs,
				reservationStore
			});
			const converted = JSON.parse(fs.readFileSync(matchFile, 'utf8'));

			assert.equal(result.changed, true);
			assert.equal(result.converted, 1);
			assert.deepStrictEqual(JSON.parse(fs.readFileSync(backupFile, 'utf8')), original);
			assert.deepStrictEqual(converted[0].deletion, { deletedAt: nowMs - 1000, reason: 'manual' });
			assert.equal(converted[1].deletion, null);
			assert.equal(matchV2.runV2Fix({ matchFile, nowMs, reservationStore }).skipped, true);
		});
	});

	it('leaves match unchanged when conversion or atomic saving fails', function () {
		withFixture(directory => {
			const matchFile = path.join(directory, 'match.json');
			writeJson(matchFile, [{ status: 'RECORDED' }]);
			const before = fs.readFileSync(matchFile, 'utf8');
			assert.throws(() => matchV2.runV2Fix({ matchFile, nowMs, reservationStore }), /invalid canonical match key/);
			assert.equal(fs.readFileSync(matchFile, 'utf8'), before);

			const legacy = matching.buildMatchItem(
				'RECORDED', key, { ...base, recorded: '/fixture/a.m2ts' }, base, base.channel,
				true, true, false, true, false, nowMs, true, {}
			);
			writeJson(matchFile, [legacy]);
			const validBefore = fs.readFileSync(matchFile, 'utf8');
			const failingStore = {
				withLock: reservationStore.withLock,
				readArray: reservationStore.readArray,
				writeArrayAtomic() { throw new Error('fixture save failed'); }
			};
			assert.throws(() => matchV2.runV2Fix({
				matchFile,
				backupFile: path.join(directory, 'save-failure-backup.json'),
				nowMs,
				reservationStore: failingStore
			}), /fixture save failed/);
			assert.equal(fs.readFileSync(matchFile, 'utf8'), validBefore);
		});
	});

	it('keeps the legacy writer by default and fails closed before v2fix', function () {
		const legacy = matching.buildMatchLedger({
			nowMs,
			keepDays: 0,
			recordedList: [{ ...base, recorded: '/fixture/a.m2ts' }],
			reserves2List: [base]
		}).results;

		assert.equal(matching.getMatchSchemaVersion({}), 1);
		assert.equal(matching.getMatchSchemaVersion({ matchSchemaVersion: 2 }), 2);
		assert.equal(legacy[0].schemaVersion, undefined);
		assert.throws(() => matchV2.assertWriterReady(legacy, 2), /completed v2fix/);
		assert.equal(matchV2.assertWriterReady([v2()], 2), true);
	});

});
