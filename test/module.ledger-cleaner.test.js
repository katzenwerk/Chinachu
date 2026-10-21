'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const cleaner = require('../lib/ledger-cleaner');
const cleanerJobs = require('../lib/ledger-cleaner-jobs');
const reservationStore = require('../lib/reservation-store');
const matching = require('../app-matching');

function program(id, recordedPath, overrides) {
	const start = Date.now() - 2 * 60 * 60 * 1000;
	return Object.assign({
		id,
		start,
		end: start + 30 * 60 * 1000,
		seconds: 1800,
		channel: { id: 'channel-' + id, name: 'Channel ' + id },
		title: 'Program ' + id,
		recorded: recordedPath
	}, overrides || {});
}

function match(programValue) {
	return {
		schemaVersion: 2,
		key: cleaner.canonicalKey(programValue),
		status: 'RECORDED',
		start: programValue.start,
		end: programValue.end,
		fullTitle: programValue.title,
		recording: { recordedId: programValue.id, path: programValue.recorded },
		deletion: null
	};
}

function writeJson(file, value) {
	fs.writeFileSync(file, JSON.stringify(value));
}

function createFixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-ledger-cleaner-'));
	const data = path.join(root, 'data');
	const recordings = path.join(root, 'recordings');
	fs.mkdirSync(data);
	fs.mkdirSync(recordings);
	const paths = {
		normal: path.join(recordings, 'normal.m2ts'),
		relocatedOld: path.join(recordings, 'old', 'relocated.m2ts'),
		relocatedNew: path.join(recordings, 'moved', 'relocated.m2ts'),
		ambiguousOld: path.join(recordings, 'old', 'ambiguous.m2ts'),
		ambiguousA: path.join(recordings, 'a', 'ambiguous.m2ts'),
		ambiguousB: path.join(recordings, 'b', 'ambiguous.m2ts'),
		missing: path.join(recordings, 'missing.m2ts'),
		active: path.join(recordings, 'active.m2ts')
	};
	[paths.normal, paths.relocatedNew, paths.ambiguousA, paths.ambiguousB].forEach(file => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, 'fixture');
	});
	const programs = [
		program('normal', paths.normal),
		program('relocated', paths.relocatedOld, { recordedDir: path.dirname(paths.relocatedOld), recordedDirId: 'old' }),
		program('ambiguous', paths.ambiguousOld),
		program('missing', paths.missing),
		program('active', paths.active)
	];
	const files = Object.fromEntries(['recorded', 'recording', 'reserves', 'reserves2', 'match'].map(name => [name, path.join(data, name + '.json')]));
	writeJson(files.recorded, programs);
	writeJson(files.recording, [programs[4]]);
	writeJson(files.reserves, []);
	writeJson(files.reserves2, programs);
	writeJson(files.match, programs.map(match));
	writeJson(path.join(root, 'config.json'), { recordedDir: recordings, recordedFormat: '<title>.m2ts' });
	fs.mkdirSync(path.join(data, 'csv'));
	fs.writeFileSync(path.join(data, 'csv', 'recording-history_2026-10.csv'), 'sentinel');
	return {
		root, data, recordings, paths, programs, files,
		close() { fs.rmSync(root, { recursive: true, force: true }); }
	};
}

function createPlan(fixture) {
	return cleaner.buildPlan(Object.assign({}, cleaner.loadLedgers(fixture.root), {
		normalizeLocations: true,
		missingPolicy: 'remove-history',
		selectedIds: null
	}));
}

function waitForJob(jobs, timeoutMs) {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;
		const timer = setInterval(() => {
			const state = jobs.get();
			if (state && state.status !== 'running') {
				clearInterval(timer);
				resolve(state);
			} else if (Date.now() >= deadline) {
				clearInterval(timer);
				reject(new Error('cleaner job timed out'));
			}
		}, 10);
	});
}

test('dry-run indexes once and classifies normal, unique, ambiguous, missing, and active entries without writes', function () {
	const fixture = createFixture();
	try {
		const before = Object.fromEntries(Object.entries(fixture.files).map(([name, file]) => [name, fs.readFileSync(file, 'utf8')]));
		const plan = createPlan(fixture);
		assert.strictEqual(plan.index.complete, true);
		assert.strictEqual(plan.summary.ok, 1);
		assert.strictEqual(plan.summary.relocated, 1);
		assert.strictEqual(plan.summary.ambiguous, 1);
		assert.strictEqual(plan.summary.missing, 1);
		assert.strictEqual(plan.summary.recording, 1);
		assert.strictEqual(plan.results.find(item => item.id === 'relocated').newPath, fixture.paths.relocatedNew);
		assert.strictEqual(plan.results.find(item => item.id === 'ambiguous').automatic, false);
		Object.entries(fixture.files).forEach(([name, file]) => assert.strictEqual(fs.readFileSync(file, 'utf8'), before[name]));
	} finally {
		fixture.close();
	}
});

test('apply revalidates and updates only recorded, reserves2, and match while preserving files and CSV', function () {
	const fixture = createFixture();
	try {
		const found = program('recorded-missing-found', path.join(fixture.recordings, 'recorded-missing-found.m2ts'));
		const absent = program('recorded-missing-absent', path.join(fixture.recordings, 'recorded-missing-absent.m2ts'));
		fs.writeFileSync(found.recorded, 'fixture');
		writeJson(fixture.files.reserves2, fixture.programs.concat([found, absent]));
		writeJson(fixture.files.match, fixture.programs.map(match).concat([found, absent].map(value =>
			Object.assign(match(value), { deletion: { deletedAt: null, reason: 'recorded-missing' } }))));
		const plan = createPlan(fixture);
		assert.strictEqual(plan.summary.recordedMissingFound, 1);
		assert.strictEqual(plan.summary.recordedMissingHistory, 1);
		const outcome = cleaner.applyPlan(fixture.root, plan);
			assert.deepStrictEqual(outcome.counts, {
				pathRepaired: 1, recordedRemoved: 1, matchRemoved: 2, reserves2Removed: 2,
				programsRemoved: 2, recordedHistoryRemoved: 1, deletedMatchHistoryRemoved: 0,
				recordedMissingHistoryRemoved: 1,
				skippedHistoryRemoved: 0, missedHistoryRemoved: 0,
				thumbnailDeleted: 0, thumbnailRetained: 0, thumbnailFailed: 0, held: 1
			});
		assert.deepStrictEqual(outcome.changedLedgers.sort(), ['match', 'recorded', 'reserves2']);
		const recorded = JSON.parse(fs.readFileSync(fixture.files.recorded, 'utf8'));
		const reserves2 = JSON.parse(fs.readFileSync(fixture.files.reserves2, 'utf8'));
		const matches = JSON.parse(fs.readFileSync(fixture.files.match, 'utf8'));
		assert.strictEqual(recorded.find(item => item.id === 'relocated').recorded, fixture.paths.relocatedNew);
		assert.strictEqual(recorded.find(item => item.id === 'relocated').recordedDir, fixture.recordings);
		assert.strictEqual(recorded.some(item => item.id === 'missing'), false);
		assert.strictEqual(reserves2.some(item => item.id === 'missing'), false);
		assert.strictEqual(matches.some(item => item.recording.recordedId === 'missing'), false);
		assert.strictEqual(matches.some(item => item.recording.recordedId === 'recorded-missing-found'), true);
		assert.strictEqual(matches.some(item => item.recording.recordedId === 'recorded-missing-absent'), false);
		assert.strictEqual(matches.find(item => item.recording.recordedId === 'relocated').recording.path, fixture.paths.relocatedNew);
		assert.strictEqual(JSON.parse(fs.readFileSync(fixture.files.reserves, 'utf8')).length, 0);
		assert.strictEqual(fs.readFileSync(path.join(fixture.data, 'csv', 'recording-history_2026-10.csv'), 'utf8'), 'sentinel');
		[fixture.paths.normal, fixture.paths.relocatedNew, fixture.paths.ambiguousA, fixture.paths.ambiguousB]
			.forEach(file => assert.strictEqual(fs.existsSync(file), true));
			assert.strictEqual(fs.existsSync(path.join(outcome.backupDirectory, 'manifest.json')), true);
				assert.strictEqual(JSON.parse(fs.readFileSync(path.join(outcome.backupDirectory, 'manifest.json'), 'utf8')).status, 'complete');
				assert.strictEqual(fs.existsSync(path.join(outcome.backupDirectory, 'match.json')), false);
	} finally {
		fixture.close();
	}
});

test('deleted and recorded-missing history is removed without a location scan and cleans only unshared thumbnails', function () {
	const fixture = createFixture();
	try {
		const thumbnailDir = path.join(fixture.data, 'thumbnails');
		fs.mkdirSync(thumbnailDir);
		const deleted = program('deleted-only', path.join(fixture.recordings, 'deleted-only.m2ts'), {
			channel: { id: 'deleted-channel', name: 'Deleted' }
		});
		const sharedDeleted = program('shared', path.join(fixture.recordings, 'shared-old.m2ts'), {
			channel: { id: 'shared-old-channel', name: 'Shared old' }
		});
		const sharedValid = program('shared-valid-source', path.join(fixture.recordings, 'shared-valid.m2ts'), {
			channel: { id: 'shared-valid-channel', name: 'Shared valid' }
		});
		const thumbnailFailure = program('thumbnail-failure', path.join(fixture.recordings, 'thumbnail-failure.m2ts'), {
			channel: { id: 'thumbnail-failure-channel', name: 'Thumbnail failure' }
		});
		const recordedMissing = program('recorded-missing-unchecked', path.join(fixture.recordings, 'recorded-missing-unchecked.m2ts'), {
			channel: { id: 'recorded-missing-unchecked-channel', name: 'Recorded missing unchecked' }
		});
		const deletedMatch = Object.assign(match(deleted), { deletion: { deletedAt: Date.now() - 1000, reason: 'manual' } });
		const sharedDeletedMatch = Object.assign(match(sharedDeleted), { deletion: { deletedAt: Date.now() - 1000, reason: 'manual' } });
		const thumbnailFailureMatch = Object.assign(match(thumbnailFailure), { deletion: { deletedAt: Date.now() - 1000, reason: 'manual' } });
		const recordedMissingMatch = Object.assign(match(recordedMissing), {
			deletion: { deletedAt: null, reason: 'recorded-missing' }
		});
		const sharedValidMatch = match(sharedValid);
		sharedValidMatch.recording.recordedId = 'shared';
		writeJson(fixture.files.match, [deletedMatch, sharedDeletedMatch, thumbnailFailureMatch, recordedMissingMatch, sharedValidMatch]);
		writeJson(fixture.files.reserves2, [deleted, sharedDeleted, thumbnailFailure, recordedMissing]);
		fs.writeFileSync(path.join(thumbnailDir, 'deleted-only.jpg'), 'thumbnail');
		fs.writeFileSync(path.join(thumbnailDir, 'shared.jpg'), 'thumbnail');
		fs.mkdirSync(path.join(thumbnailDir, 'thumbnail-failure.jpg'));
		writeJson(path.join(fixture.root, 'config.json'), { recordedDir: path.join(fixture.root, 'offline-root') });

		const beforeMatch = fs.readFileSync(fixture.files.match, 'utf8');
		const plan = cleaner.buildPlan(Object.assign({}, cleaner.loadLedgers(fixture.root), {
			checkLocations: false,
			normalizeLocations: true,
			missingPolicy: 'remove-history',
			selectedIds: null
		}));
		assert.strictEqual(plan.index.files, 0);
		assert.strictEqual(plan.summary.deletedMatch, 3);
		assert.strictEqual(plan.summary.recordedMissingHistory, 1);
		assert.match(plan.results.find(item => item.id === 'recorded-missing-unchecked').reason, /not selected/);
		assert.strictEqual(fs.readFileSync(fixture.files.match, 'utf8'), beforeMatch);

		const outcome = cleaner.applyPlan(fixture.root, plan);
		assert.strictEqual(outcome.counts.matchRemoved, 4);
		assert.strictEqual(outcome.counts.reserves2Removed, 4);
		assert.strictEqual(outcome.counts.recordedMissingHistoryRemoved, 1);
		assert.strictEqual(outcome.counts.thumbnailDeleted, 1);
		assert.strictEqual(outcome.counts.thumbnailRetained, 1);
		assert.strictEqual(outcome.counts.thumbnailFailed, 1);
		assert.strictEqual(outcome.errors, 1);
		assert.strictEqual(outcome.thumbnailErrors[0].id, 'thumbnail-failure');
		assert.strictEqual(fs.existsSync(path.join(thumbnailDir, 'deleted-only.jpg')), false);
		assert.strictEqual(fs.existsSync(path.join(thumbnailDir, 'shared.jpg')), true);
		assert.strictEqual(fs.existsSync(path.join(outcome.backupDirectory, 'match.json')), false);

		const matchItems = JSON.parse(fs.readFileSync(fixture.files.match, 'utf8'));
		const reserves2Items = JSON.parse(fs.readFileSync(fixture.files.reserves2, 'utf8'));
		assert.deepStrictEqual(matchItems, [sharedValidMatch]);
		assert.deepStrictEqual(reserves2Items, []);
		const rebuilt = matching.writeMatchLedgerLocked({
			oldMatchPath: fixture.files.match,
			output: fixture.files.match,
			recordedPath: fixture.files.recorded,
			recordedList: [deleted],
			recordingList: [],
			reserves2Path: fixture.files.reserves2,
			reserves2List: [deleted, sharedDeleted, thumbnailFailure],
			nowMs: Date.now(),
			keepDays: 0,
			readDays: 0,
			schemaVersion: 2,
			config: {}
		});
		assert.strictEqual(rebuilt.results.some(item => [deletedMatch.key, sharedDeletedMatch.key, thumbnailFailureMatch.key,
			recordedMissingMatch.key].includes(item.key)), false);
	} finally {
		fixture.close();
	}
});

test('history cleanup removes ended skips by default and missed entries only when explicitly requested', function () {
	const fixture = createFixture();
	try {
		const now = Date.now();
		const pastSkip = program('past-skip', '', { start: now - 7200000, end: now - 5400000, isSkip: true });
		const futureSkip = program('future-skip', '', { start: now + 3600000, end: now + 5400000, isSkip: true });
		const missed = program('missed', '', { start: now - 7200000, end: now - 5400000 });
		const activeSkip = program('active-skip', '', { start: now - 7200000, end: now - 5400000, isSkip: true });
		const recordedSkip = program('recorded-skip', fixture.paths.normal, {
			start: now - 7200000, end: now - 5400000, isSkip: true
		});
		function history(value, status) {
			return {
				schemaVersion: 2,
				key: cleaner.canonicalKey(value),
				status,
				start: value.start,
				end: value.end,
				fullTitle: value.title,
				recording: null,
				deletion: null
			};
		}
		writeJson(fixture.files.recorded, [recordedSkip]);
		writeJson(fixture.files.recording, [activeSkip]);
		writeJson(fixture.files.reserves, [futureSkip]);
		writeJson(fixture.files.reserves2, [pastSkip, futureSkip, missed, activeSkip, recordedSkip]);
		writeJson(fixture.files.match, [
			history(pastSkip, 'SKIPPED_ONLY'),
			history(futureSkip, 'SKIPPED_ONLY'),
			history(missed, 'MISSED'),
			history(activeSkip, 'SKIPPED_ONLY'),
			history(recordedSkip, 'SKIPPED_ONLY')
		]);

		const before = Object.fromEntries(['recorded', 'reserves2', 'match']
			.map(name => [name, fs.readFileSync(fixture.files[name], 'utf8')]));
		const defaultPlan = cleaner.buildPlan(Object.assign({}, cleaner.loadLedgers(fixture.root), {
			checkLocations: false,
			missingPolicy: 'remove-history'
		}));
		assert.strictEqual(defaultPlan.options.cleanupMissed, false);
		assert.strictEqual(defaultPlan.summary.skippedHistory, 1);
		assert.strictEqual(defaultPlan.summary.skippedHistoryHeld, 0);
		assert.strictEqual(defaultPlan.summary.missedHistory, 0);
		assert.strictEqual(defaultPlan.results.filter(item => item.automatic).length, 1);
		assert.strictEqual(defaultPlan.results.find(item => item.key === cleaner.canonicalKey(futureSkip)).classification,
			'skipped-history-pending');
		assert.strictEqual(defaultPlan.results.find(item => item.key === cleaner.canonicalKey(activeSkip)).classification,
			'skipped-history-pending');
		assert.strictEqual(defaultPlan.results.find(item => item.ledger === 'match.json' &&
			item.key === cleaner.canonicalKey(recordedSkip)).classification,
			'skipped-history-retained');
		assert.strictEqual(defaultPlan.results.filter(item => item.classification.endsWith('-held')).length, 0);
		Object.entries(before).forEach(([name, text]) => assert.strictEqual(fs.readFileSync(fixture.files[name], 'utf8'), text));

		let outcome = cleaner.applyPlan(fixture.root, defaultPlan);
		assert.strictEqual(outcome.counts.skippedHistoryRemoved, 1);
		assert.strictEqual(outcome.counts.missedHistoryRemoved, 0);
		assert.strictEqual(outcome.counts.programsRemoved, 1);
		assert.strictEqual(outcome.counts.held, 0);
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(fixture.files.reserves2, 'utf8')).map(item => item.id).sort(),
			['active-skip', 'future-skip', 'missed', 'recorded-skip']);
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(fixture.files.match, 'utf8')).map(item => item.status).sort(),
			['MISSED', 'SKIPPED_ONLY', 'SKIPPED_ONLY', 'SKIPPED_ONLY']);

		const missedPlan = cleaner.buildPlan(Object.assign({}, cleaner.loadLedgers(fixture.root), {
			checkLocations: false,
			missingPolicy: 'remove-history',
			cleanupMissed: true
		}));
		assert.strictEqual(missedPlan.summary.missedHistory, 1);
		outcome = cleaner.applyPlan(fixture.root, missedPlan);
		assert.strictEqual(outcome.counts.missedHistoryRemoved, 1);
		assert.strictEqual(JSON.parse(fs.readFileSync(fixture.files.reserves2, 'utf8')).some(item => item.id === 'missed'), false);
		assert.strictEqual(JSON.parse(fs.readFileSync(fixture.files.match, 'utf8')).some(item => item.status === 'MISSED'), false);

		matching.writeMatchLedgerLocked({
			oldMatchPath: fixture.files.match,
			output: fixture.files.match,
			recordedPath: fixture.files.recorded,
			recordedList: [],
			recordingList: [],
			reserves2Path: fixture.files.reserves2,
			reserves2List: [pastSkip, missed],
			nowMs: now,
			keepDays: 0,
			readDays: 0,
			schemaVersion: 2,
			config: {}
		});
		const rebuiltKeys = JSON.parse(fs.readFileSync(fixture.files.match, 'utf8')).map(item => item.key);
		assert.strictEqual(rebuiltKeys.includes(cleaner.canonicalKey(pastSkip)), false);
		assert.strictEqual(rebuiltKeys.includes(cleaner.canonicalKey(missed)), false);
	} finally {
		fixture.close();
	}
});

test('apply rejects stale ledgers and an incomplete root without changing data', function () {
	const fixture = createFixture();
	try {
		const plan = createPlan(fixture);
		const originalRecorded = fs.readFileSync(fixture.files.recorded, 'utf8');
		writeJson(fixture.files.match, []);
		assert.throws(() => cleaner.applyPlan(fixture.root, plan), error => error.code === 'CLEANER_PLAN_STALE');
		assert.strictEqual(fs.readFileSync(fixture.files.recorded, 'utf8'), originalRecorded);

		writeJson(path.join(fixture.root, 'config.json'), {
			recordedDir: fixture.recordings,
			recordedDirs: [{ id: 'missing-root', path: path.join(fixture.root, 'not-mounted') }]
		});
		const uninspected = program('recorded-missing-uninspected', path.join(fixture.recordings, 'not-found.m2ts'));
		writeJson(fixture.files.match, [Object.assign(match(uninspected), {
			deletion: { deletedAt: null, reason: 'recorded-missing' }
		})]);
		const incomplete = createPlan(fixture);
		assert.strictEqual(incomplete.index.complete, false);
		assert.strictEqual(incomplete.summary.recordedMissingUninspected, 1);
		assert.strictEqual(incomplete.results.find(item => item.id === 'recorded-missing-uninspected').automatic, false);
		assert.throws(() => cleaner.applyPlan(fixture.root, incomplete), /Every registered recording root/);
	} finally {
		fixture.close();
	}
});

test('apply restores every ledger and records rollback when an atomic write fails', function () {
	const fixture = createFixture();
	const originalWrite = reservationStore.writeArrayAtomic;
	try {
		const plan = createPlan(fixture);
		const before = Object.fromEntries(['recorded', 'reserves2', 'match']
			.map(name => [name, fs.readFileSync(fixture.files[name], 'utf8')]));
		let writes = 0;
		reservationStore.writeArrayAtomic = function (file, value) {
			writes++;
			if (writes === 2) throw new Error('fixture write failure');
			return originalWrite(file, value);
		};
		assert.throws(() => cleaner.applyPlan(fixture.root, plan), /fixture write failure/);
		Object.entries(before).forEach(([name, value]) => {
			assert.deepStrictEqual(JSON.parse(fs.readFileSync(fixture.files[name], 'utf8')), JSON.parse(value));
		});
		const backupRoot = path.join(fixture.data, 'ledger-cleaner-backups');
		const transaction = fs.readdirSync(backupRoot)[0];
		const manifest = JSON.parse(fs.readFileSync(path.join(backupRoot, transaction, 'manifest.json'), 'utf8'));
		assert.strictEqual(manifest.status, 'rolled-back');
	} finally {
		reservationStore.writeArrayAtomic = originalWrite;
		fixture.close();
	}
});

test('worker jobs keep scan and apply single-flight across a closed modal', async function () {
	const fixture = createFixture();
	try {
		const jobs = cleanerJobs.createLedgerCleanerJobs({ rootDir: fixture.root });
		const scan = jobs.start({ normalizeLocations: true, missingPolicy: 'remove-history', selectedIds: null });
		assert.strictEqual(scan.type, 'scan');
		assert.throws(() => jobs.start({}), error => error.statusCode === 409);
		const preview = await waitForJob(jobs, 5000);
		assert.strictEqual(preview.status, 'complete');
		const apply = jobs.apply(preview.id);
		assert.strictEqual(apply.type, 'apply');
		assert.strictEqual(apply.previewId, preview.id);
		assert.throws(() => jobs.apply(preview.id), error => error.statusCode === 409);
		const completed = await waitForJob(jobs, 5000);
		assert.strictEqual(completed.status, 'complete');
		assert.strictEqual(completed.result.counts.recordedRemoved, 1);
	} finally {
		fixture.close();
	}
});
