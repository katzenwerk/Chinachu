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

// Historical input, deliberately independent of the current writer.
function legacyEntry() {
	return {
		key, status: 'RECORDED', program: { ...base, recorded: '/fixture/a.m2ts' },
		reservationMeta: { ruleUid: base.ruleUid },
		recordingResult: { id: base.id, start, seconds: base.seconds, snapshot: { ...base } }
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
		const finalizing = { ...base, id: 'finalizing', channel: { ...base.channel, id: 'channel-finalizing' } };
		const recorded = { ...base, recorded: '/fixture/a.m2ts', recordedDurationSeconds: 1700, savedTsAnalysis: { schemaVersion: 1, status: 'complete', registeredPath: '/fixture/a.m2ts', file: { path: '/fixture/a.m2ts' } } };
		const untracked = {
			...base,
			id: 'recorded-b',
			ruleUid: 'rule-b',
			channel: { ...base.channel, id: 'channel-b' },
			recorded: '/fixture/b.m2ts'
		};
		const options = {
			nowMs,
			keepDays: 0,
			recordedReadOk: true,
			recordedList: [recorded, untracked],
			reserves2List: [base, future, missed, skipped, finalizing]
		};
		const finalizingKey = matching.makeCanonicalKey(finalizing);
		const results = matching.buildMatchLedger({
			...options,
			recordingList: [base, skipped, { ...finalizing, id: 'different-id', operatorRecordingEnd: nowMs - 1000, _operatorHistoryPending: true }]
		}).results;
		const statuses = results.map(entry => entry.status).sort();

		assert.deepStrictEqual(statuses, ['MISSED', 'RECORDED', 'RECORDED_UNTRACKED', 'RESERVED', 'RESERVED', 'SKIPPED_ONLY']);
		assert.equal(results.find(entry => entry.key === finalizingKey).status, 'RESERVED');
		const rebuilt = matching.buildMatchLedger({ ...options, oldResults: results, recordingList: [] }).results;
		assert.equal(rebuilt.find(entry => entry.key === finalizingKey).status, 'MISSED');
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
		const missing = v2({
			recording: { recordedId: 'recorded-a' },
			deletion: { deletedAt: null, reason: 'recorded-missing' }
		});
		const same = v2({ deletion: null });
		const sameWithoutReservation = v2({ status: 'RECORDED_UNTRACKED', deletion: null });
		const replaced = v2({
			recording: { recordedId: 'recorded-new', path: '/fixture/new.m2ts' },
			deletion: null
		});

		assert.deepStrictEqual(matching.mergeOldNew(old, same, null, null, { recordedReadOk: true }).deletion, old.deletion);
		assert.equal(matching.mergeOldNew(missing, same, null, null, { recordedReadOk: true }).deletion, null);
		assert.deepStrictEqual(matching.mergeOldNew(missing, same).deletion, missing.deletion);
		const rejectedReplacement = matching.mergeOldNew(missing, replaced, null, null, { recordedReadOk: true });
		assert.equal(rejectedReplacement.recording.recordedId, 'recorded-a');
		assert.deepStrictEqual(rejectedReplacement.deletion, missing.deletion);
		assert.equal(rejectedReplacement.recording.path, undefined);
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

	it('reads the ledgers in handoff order under the common lock and preserves concurrent deletion history', function () {
		const latest = [v2({ deletion: { deletedAt: nowMs - 1000, reason: 'manual' } })];
		const handoff = { ...base, id: 'handoff', channel: { id: 'channel-handoff' }, recorded: '/fixture/handoff.m2ts' };
		let recording = [handoff];
		let recorded = [{ ...base, recorded: '/fixture/a.m2ts' }];
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
				if (file === '/fixture/recorded.json') return recorded;
				if (file === '/fixture/recording.json') {
					// Commit history and clear the active row between the two snapshots.
					const snapshot = recording;
					recorded = recorded.concat(handoff);
					recording = [];
					return snapshot;
				}
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
			recordingPath: '/fixture/recording.json',
			recordedPath: '/fixture/recorded.json',
			reserves2List: [base, handoff],
			nowMs,
			keepDays: 0,
			keepMonths: 3,
			readDays: 14,
			config: {},
			initialBuild: false,
			reservationStore: store
		});

		assert.deepStrictEqual(calls, [
			'lock:/fixture/match.json', 'read:/fixture/recording.json', 'read:/fixture/recorded.json', 'read:/fixture/match.json',
			'write:/fixture/match.json', 'unlock:/fixture/match.json'
		]);
		assert.deepStrictEqual(saved.find(entry => entry.key === key).deletion, latest[0].deletion);
		assert.equal(saved.find(entry => entry.key === matching.makeCanonicalKey(handoff)).status, 'RECORDED');
		assert.throws(() => matching.writeMatchLedgerLocked({
			output: '/fixture/match.json',
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
			const legacy = legacyEntry();
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

			const update = { output: matchFile, recordedList: [base], reserves2List: [base], nowMs, keepDays: 0 };
			assert.throws(() => matching.writeMatchLedgerLocked(update), /invalid canonical match key/);
			assert.equal(fs.readFileSync(matchFile, 'utf8'), before);
			fs.writeFileSync(matchFile, '{invalid');
			assert.throws(() => matching.writeMatchLedgerLocked(update), SyntaxError);
			assert.equal(fs.readFileSync(matchFile, 'utf8'), '{invalid');

			const legacy = legacyEntry();
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
			assert.throws(() => matching.writeMatchLedgerLocked({ ...update, reservationStore: failingStore }), /fixture save failed/);
			assert.equal(fs.readFileSync(matchFile, 'utf8'), validBefore);
			assert.equal(fs.readFileSync(matchFile + '.v1-backup', 'utf8'), validBefore);
			writeJson(matchFile, [legacy, v2()]);
			const changedBefore = fs.readFileSync(matchFile, 'utf8');
			assert.throws(() => matching.writeMatchLedgerLocked(update), /backup differs/);
			assert.equal(fs.readFileSync(matchFile, 'utf8'), changedBefore);
			assert.equal(fs.readFileSync(matchFile + '.v1-backup', 'utf8'), validBefore);

		});
	});

	it('migrates at the common writer and CLI without changing a separate merge source', function () {
		withFixture(directory => {
			const matchFile = path.join(directory, 'match.json');
			const sourceFile = path.join(directory, 'source.json');
			const recordedFile = path.join(directory, 'recorded.json');
			const reserveFile = path.join(directory, 'reserves2.json');
			const activeFile = path.join(directory, 'recording.json');
			const configFile = path.join(directory, 'config.json');
			const legacy = legacyEntry();
			legacy.recordingResult.cleanupState = 'deleted';
			legacy.recordingResult.cleanupReason = 'manual';
			legacy.recordingResult.deletedAt = nowMs - 1000;
			legacy.fileMissing = { recordedId: base.id, checkedAt: nowMs };
			writeJson(matchFile, [legacy]);
			const original = fs.readFileSync(matchFile, 'utf8');
			const options = {
				output: matchFile, recordedList: [base], reserves2List: [base], recordingList: [], nowMs, keepDays: 0,
				config: { matchSchemaVersion: 1, matchKeepRecordedSnapshot: true }
			};
			const result = matching.writeMatchLedgerLocked(options);
			assert.equal(fs.readFileSync(matchFile + '.v1-backup', 'utf8'), original);
			assert.equal(result.results[0].schemaVersion, 2);
			assert.equal(result.results[0].ruleUid, base.ruleUid);
			assert.equal(result.results[0].recording.recordedId, base.id);
			assert.equal(result.results[0].deletion.reason, 'manual');
			assert.equal(result.results[0].program, undefined);
			assert.throws(() => matching.writeMatchLedgerLocked({ ...options, initialBuild: true }), /cannot replace existing history/);
			assert.equal(matching.writeMatchLedgerLocked(options).results[0].schemaVersion, 2);
			// Separate CLI output must leave the legacy source bytes intact.
			const finalizing = { ...base, id: 'cli-active', channel: { id: 'channel-cli-active' } };
			writeJson(sourceFile, [legacy]);
			writeJson(recordedFile, [base]);
			writeJson(reserveFile, [base, finalizing]);
			writeJson(activeFile, [{ ...finalizing, operatorRecordingEnd: nowMs, _operatorHistoryPending: true }]);
			writeJson(configFile, { matchSchemaVersion: 1, recordedHistoryRetentionDays: 0 });
			const sourceBefore = fs.readFileSync(sourceFile, 'utf8');
			const cli = require('child_process').spawnSync(process.execPath, [
				path.join(__dirname, '../app-matching.js'), '--old-match', sourceFile, '--output', matchFile,
				'--recorded', recordedFile, '--reserves2', reserveFile, '--recording', activeFile,
				'--config', configFile, '--now', String(nowMs), '--keep-days', '0'
			], { encoding: 'utf8' });
			assert.equal(cli.status, 0, cli.stdout + cli.stderr);
			assert.equal(fs.readFileSync(sourceFile, 'utf8'), sourceBefore);
			assert.equal(fs.readFileSync(sourceFile + '.v1-backup', 'utf8'), sourceBefore);
			const cliRows = JSON.parse(fs.readFileSync(matchFile, 'utf8'));
			assert.equal(cliRows.find(entry => entry.key === key).schemaVersion, 2);
			assert.equal(cliRows.find(entry => entry.key === matching.makeCanonicalKey(finalizing)).status, 'RESERVED');
		});
	});

});
