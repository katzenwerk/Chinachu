'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const history = require('../lib/recording-history-csv');

function jstTimestamp(year, month, day, hour, minute) {
	return Date.UTC(year, month - 1, day, hour - 9, minute || 0);
}

function program(id, start, overrides) {
	return Object.assign({
		id,
		start,
		end: start + 30 * 60 * 1000,
		seconds: 30 * 60,
		channel: { id: 'channel-' + id, name: 'チャンネル,' + id },
		title: '番組"' + id + '\n後半'
	}, overrides || {});
}

function match(programValue, status, recording, deletion) {
	return {
		schemaVersion: 2,
		key: [programValue.channel.id, programValue.start, programValue.seconds].join('|'),
		status,
		start: programValue.start,
		end: programValue.end,
		fullTitle: programValue.title,
		recording: recording || null,
		deletion: deletion || null
	};
}

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-recording-history-'));
	return {
		root,
		outputDir: path.join(root, 'data', 'csv'),
		stateFile: path.join(root, 'data', 'recording-history-csv-state.json'),
		close() { fs.rmSync(root, { recursive: true, force: true }); }
	};
}

test('monthly CSV is activation-bounded, classified, escaped, immutable, and idempotent', function () {
	const subject = fixture();
	try {
		const enabledAt = jstTimestamp(2026, 1, 1, 0, 0);
		const initialized = history.exportHistory({
			enabled: true,
			outputDir: subject.outputDir,
			stateFile: subject.stateFile,
			nowMs: enabledAt,
			recordedList: [], recordingList: [], reserves2List: [], matchList: []
		});
		assert.strictEqual(initialized.initialized, true);
		assert.strictEqual(fs.existsSync(subject.outputDir), false);

		const start = jstTimestamp(2026, 1, 2, 10, 0);
		const ok = program('ok', start, { recorded: '/recorded/preferred-ok.m2ts' });
		const failed = program('failed', start + 60 * 60 * 1000, {
			recorded: '/recorded/failed.m2ts', operatorAbort: true, operatorAbortReason: 'LOW STORAGE'
		});
		const missed = program('missed', start + 2 * 60 * 60 * 1000);
		const skipped = program('skipped', start + 3 * 60 * 60 * 1000, { isSkip: true });
		const active = program('active', start + 4 * 60 * 60 * 1000, { recorded: '/recorded/active.m2ts' });
		const canceled = program('canceled', start + 5 * 60 * 60 * 1000);
		const old = program('old', enabledAt - 60 * 60 * 1000, { recorded: '/recorded/old.m2ts' });
		const reserves2 = [ok, failed, missed, skipped, active];
		const recorded = [ok, failed, active, old];
		const matches = [
			match(ok, 'RECORDED', { recordedId: ok.id, path: '/match/fallback-ok.m2ts' }),
			match(failed, 'RECORDED', { recordedId: failed.id, path: failed.recorded }),
			match(missed, 'MISSED'),
			match(skipped, 'SKIPPED_ONLY'),
			match(active, 'RECORDED', { recordedId: active.id, path: active.recorded }),
			match(canceled, 'MISSED'),
			match(old, 'RECORDED', { recordedId: old.id, path: old.recorded })
		];
		const options = {
			enabled: true,
			outputDir: subject.outputDir,
			stateFile: subject.stateFile,
			nowMs: active.end + history.FINALIZE_GRACE_MS,
			recordedList: recorded,
			recordingList: [active],
			reserves2List: reserves2,
			matchList: matches
		};
		const waiting = history.exportHistory(options);
		assert.strictEqual(waiting.appended, 0);
		options.recordingList = [];
		options.recordedList = recorded.filter(item => item !== active);
		const first = history.exportHistory(options);
		assert.strictEqual(first.appended, 5);
		const csvFile = path.join(subject.outputDir, 'recording-history_2026-01.csv');
		const original = fs.readFileSync(csvFile, 'utf8');
		const rows = history.parseCsvRows(original);
		assert.deepStrictEqual(rows[0], history.HEADER.split(','));
		assert.deepStrictEqual(rows.slice(1).map(row => row[4]), ['録画完了', '録画失敗', '録画漏れ', 'スキップ', '録画完了']);
		assert.strictEqual(rows[1][3], ok.title);
		assert.strictEqual(rows[1][6], '/recorded/preferred-ok.m2ts');
		assert.strictEqual(rows[2][5], '容量不足');
		assert.ok(!original.includes('canceled'));
		assert.ok(!original.includes('/recorded/old.m2ts'));
		assert.strictEqual(rows[5][6], ''); // No recorded.json row; match-only path is not a fallback.

		options.recordedList = [active];
		const recovery = history.exportHistory(options);
		assert.strictEqual(recovery.appended, 0);
		const afterRecovery = fs.readFileSync(csvFile, 'utf8');
		assert.strictEqual(history.exportHistory(options).appended, 0);
		assert.strictEqual(fs.readFileSync(csvFile, 'utf8'), afterRecovery);

		options.recordedList = [];
		options.matchList = matches.map(item => item.key === match(ok, 'RECORDED').key ?
			Object.assign({}, item, { deletion: { deletedAt: options.nowMs, reason: 'manual' } }) : item);
		assert.strictEqual(history.exportHistory(options).appended, 0);
		assert.strictEqual(fs.readFileSync(csvFile, 'utf8'), afterRecovery);
	} finally {
		subject.close();
	}
});

test('cross-midnight rows wait for the actual end and use the broadcast-start month', function () {
	const subject = fixture();
	try {
		const enabledAt = jstTimestamp(2026, 1, 1, 0, 0);
		history.exportHistory({ enabled: true, outputDir: subject.outputDir, stateFile: subject.stateFile,
			nowMs: enabledAt, recordedList: [], recordingList: [], reserves2List: [], matchList: [] });
		const start = jstTimestamp(2026, 1, 31, 23, 50);
		const long = program('long', start, { seconds: 40 * 60, end: start + 40 * 60 * 1000, recorded: '/recorded/long.m2ts' });
		const options = {
			enabled: true, outputDir: subject.outputDir, stateFile: subject.stateFile,
			nowMs: long.end + history.FINALIZE_GRACE_MS - 1,
			recordedList: [long], recordingList: [], reserves2List: [long],
			matchList: [match(long, 'RECORDED', { recordedId: long.id, path: long.recorded })]
		};
		assert.strictEqual(history.exportHistory(options).appended, 0);
		options.nowMs++;
		assert.strictEqual(history.exportHistory(options).appended, 1);
		assert.strictEqual(fs.existsSync(path.join(subject.outputDir, 'recording-history_2026-01.csv')), true);
		assert.strictEqual(fs.existsSync(path.join(subject.outputDir, 'recording-history_2026-02.csv')), false);
	} finally {
		subject.close();
	}
});

test('disabled mode does not create activation state or output', function () {
	const subject = fixture();
	try {
		const result = history.exportHistory({ enabled: false, outputDir: subject.outputDir, stateFile: subject.stateFile });
		assert.deepStrictEqual(result, { enabled: false, initialized: false, appended: 0, files: [] });
		assert.strictEqual(fs.existsSync(subject.stateFile), false);
	} finally {
		subject.close();
	}
});
