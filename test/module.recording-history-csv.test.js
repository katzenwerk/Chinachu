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

test('monthly CSV is activation-bounded, classified, escaped, supplemented without changing outcomes, and idempotent', async function () {
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
		const resume = program('resume', start + 5 * 60 * 60 * 1000, { recorded: '/recorded/resume.m2ts', operatorResumePending: true });
		const futureSkip = program('future-skip', start + 7 * 60 * 60 * 1000, { isSkip: true });
		const unclassified = program('unclassified', start + 20 * 60 * 1000);
		const old = program('old', enabledAt - 60 * 60 * 1000, { recorded: '/recorded/old.m2ts' });
		const reserves2 = [ok, failed, missed, skipped, active, resume, futureSkip, unclassified];
		const recorded = [ok, failed, active, old, resume];
		const matches = [
			match(ok, 'RECORDED', { recordedId: ok.id, path: '/match/fallback-ok.m2ts' }),
			match(failed, 'RECORDED', { recordedId: failed.id, path: failed.recorded }),
			match(missed, 'MISSED'),
			match(skipped, 'SKIPPED_ONLY'),
			match(active, 'RECORDED', { recordedId: active.id, path: active.recorded }),
			match(resume, 'RECORDED', { recordedId: resume.id, path: resume.recorded }),
			match(futureSkip, 'SKIPPED_ONLY'),
			match(unclassified, 'RESERVED'),
			match(canceled, 'MISSED'),
			match(old, 'RECORDED', { recordedId: old.id, path: old.recorded })
		];
		const options = {
			enabled: true,
			outputDir: subject.outputDir,
			stateFile: subject.stateFile,
			root: subject.root,
			nowMs: resume.end + 1,
			recordedList: recorded,
			recordingList: [{ ...active, _operatorHistoryPending: true }],
			reserves2List: reserves2,
			matchList: matches
		};
		const waiting = history.exportHistory(options);
		assert.strictEqual(waiting.appended, 4);
		options.recordingList = [];
		const first = history.exportHistory(options);
		assert.strictEqual(first.appended, 1);
		const csvFile = path.join(subject.outputDir, 'recording-history_2026-01.csv');
		const original = fs.readFileSync(csvFile, 'utf8');
		const rows = history.parseCsvRows(original);
		assert.deepStrictEqual(rows[0], history.HEADER.split(','));
		assert.deepStrictEqual(rows.slice(1).map(row => row[4]), ['録画完了', '録画失敗', '録画漏れ', 'スキップ', '録画完了']);
		assert.strictEqual(rows[1][3], ok.title);
		assert.strictEqual(rows[1][6], '/recorded/preferred-ok.m2ts');
		assert.strictEqual(rows[2][5], '容量不足');
		assert.ok(!original.includes('canceled'));
		assert.ok(!original.includes('unclassified'));
		assert.ok(!original.includes('resume'));
		assert.ok(!original.includes('future-skip'));
		assert.ok(!original.includes('/recorded/old.m2ts'));
		assert.strictEqual(rows[5][6], active.recorded);

		// Legacy reason files keep all historical fields while migrating to remarks.
		fs.writeFileSync(csvFile, original.replace(',remarks,', ',reason,'));
		ok.mirakurunDrop = { dropTotal: 12 };
		assert.strictEqual(history.exportHistory(options).updated, 1);
		assert.strictEqual(history.readFile(subject.outputDir, path.basename(csvFile)).rows[0][5], 'DROPあり（12）');
		ok.savedTsAnalysis = { checkedAt: options.nowMs, result: { completed: true, status: 'SUSPECT', ccErrorEvents: 3 } };
		assert.strictEqual(history.exportHistory(options).updated, 1);
		let supplemented = history.readFile(subject.outputDir, path.basename(csvFile));
		assert.strictEqual(supplemented.legacy, false);
		assert.strictEqual(supplemented.rows[0][5], 'DROPあり（3）'); // TS wins; never add 12 + 3.
		assert.deepStrictEqual(supplemented.rows[0].slice(0, 5), rows[1].slice(0, 5));
		assert.strictEqual(supplemented.rows[0][6], rows[1][6]);
		assert.deepStrictEqual(history.listFiles(subject.outputDir), [path.basename(csvFile)]);
		assert.throws(() => history.readFile(subject.outputDir, '../outside.csv'), /invalid CSV filename/);

		// A completed zero replaces Mirakurun findings; an incomplete retry does not.
		ok.savedTsAnalysis.result = { completed: true, status: 'NO_FINDINGS', ccErrorEvents: 0 };
		history.exportHistory(options);
		assert.strictEqual(history.readFile(subject.outputDir, path.basename(csvFile)).rows[0][5], '');
		ok.savedTsAnalysis.result = { completed: false, status: 'ERROR' };
		history.exportHistory(options);
		assert.strictEqual(history.readFile(subject.outputDir, path.basename(csvFile)).rows[0][5], '');

		// Missing and deleted recordings freeze the saved row, even with newer findings.
		ok.savedTsAnalysis.result = { completed: true, status: 'SUSPECT', ccErrorEvents: 99 };
		const okMatch = matches.find(row => row.key === match(ok, 'RECORDED').key);
		okMatch.fileMissing = { recordedId: ok.id, checkedAt: options.nowMs };
		const frozen = fs.readFileSync(csvFile, 'utf8');
		history.exportHistory(options);
		assert.strictEqual(fs.readFileSync(csvFile, 'utf8'), frozen);
		delete okMatch.fileMissing;
		okMatch.deletion = { deletedAt: options.nowMs, reason: 'manual' };
		history.exportHistory(options);
		assert.strictEqual(fs.readFileSync(csvFile, 'utf8'), frozen);

		// The post-analysis hook reads current ledgers and targets the program's month.
		delete okMatch.deletion;
		for (const [filename, value] of [['recorded', options.recordedList], ['match', matches], ['recording', []]]) {
			fs.writeFileSync(path.join(subject.root, 'data', filename + '.json'), JSON.stringify(value));
		}
		await history.refreshAnalysis(subject.root, { recordingResultCsvEnabled: true }, ok);
		supplemented = history.readFile(subject.outputDir, path.basename(csvFile));
		assert.strictEqual(supplemented.rows[0][5], 'DROPあり（99）');
		assert.strictEqual(supplemented.rows.length, 5);
		assert.deepStrictEqual(supplemented.rows.map(row => row[4]), rows.slice(1).map(row => row[4]));

		// An unrelated replacement path cannot contribute findings. A verified
		// move preserves the original registration path and fingerprint evidence.
		ok.recorded = '/recorded/series/preferred-ok.m2ts';
		ok.savedTsAnalysis.result.ccErrorEvents = 7;
		assert.strictEqual(history.exportHistory(options).updated, 0);
		ok.savedTsAnalysis.registeredPath = rows[1][6];
		ok.savedTsAnalysis.file = { path: ok.recorded, dev: 1, ino: 2, size: 3, mtimeMs: 4 };
		assert.strictEqual(history.exportHistory(options).updated, 1);
		assert.strictEqual(history.readFile(subject.outputDir, path.basename(csvFile)).rows[0][5], 'DROPあり（7）');
		assert.strictEqual(history.readFile(subject.outputDir, path.basename(csvFile)).rows[0][6], rows[1][6]);

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

test('recording finalization saves the broadcast-start month before analysis and retries failed saves', async function () {
	const subject = fixture();
	try {
		const enabledAt = jstTimestamp(2026, 1, 1, 0, 0);
		history.exportHistory({ enabled: true, outputDir: subject.outputDir, stateFile: subject.stateFile,
			nowMs: enabledAt, recordedList: [], recordingList: [], reserves2List: [], matchList: [] });
		const start = jstTimestamp(2026, 1, 31, 23, 50);
		const long = program('long', start, { seconds: 40 * 60, end: start + 40 * 60 * 1000,
			recorded: '/recorded/long.m2ts', mirakurunDrop: { dropTotal: 5 } });
		const options = {
			enabled: true, outputDir: subject.outputDir, stateFile: subject.stateFile,
			nowMs: long.end - 1,
			recordedList: [long], recordingList: [], reserves2List: [long],
			matchList: [match(long, 'MISSED')]
		};
		assert.strictEqual(history.exportHistory(options).appended, 0);
		options.nowMs++;
		long.operatorRecordingEnd = options.nowMs;
		options.recordingList = [{ ...long, _operatorHistoryPending: true }];
		assert.strictEqual(history.exportHistory(options).appended, 0);

		const source = fs.readFileSync(path.join(__dirname, '../app-operator.js'), 'utf8');
		const vm = require('node:vm');
		const calls = [];
		const context = vm.createContext({ config: {}, operatorLog() {}, printProgram: () => '', writeRecordingData() {},
			queueRecordedLedgerUpdate: async (_reason, write, afterSave) => {
				assert.strictEqual(write([])[0].recorded, long.recorded);
				calls.push('commit');
				await afterSave();
				return true;
			}, removeManualReserve: async () => {}, finishPendingRecording: () => calls.push('clear'),
			scheduleMatchLedgerUpdate: () => calls.push('match'), externalNotifier: { recordingResult() {}, notify() {} },
			requestCompletedRecordingCsv: () => { calls.push('csv'); return new Promise(() => {}); },
			reportRecordingSaveFailure: (_program, error) => assert.fail(error.message)
		});
		vm.runInContext(source.slice(source.indexOf('function saveCompletedRecording('), source.indexOf('function discardRecordingAfterManualRemoval(')), context);
		let closeOutput;
		const outputClosed = new Promise(resolve => { closeOutput = resolve; });
		const finalizing = context.saveCompletedRecording({ ...long }, false, long.recorded, outputClosed);
		assert.deepStrictEqual(calls, ['commit']);
		closeOutput(true);
		assert.strictEqual(await finalizing, true);
		assert.deepStrictEqual(calls, ['commit', 'clear', 'match', 'csv']);

		const jan = 'recording-history_2026-01.csv';
		const feb = 'recording-history_2026-02.csv';
		const entry = history.completedRecordingEntry(long, options.nowMs);
		assert.strictEqual(entry.month, '2026-01');
		assert.strictEqual(history.completedRecordingEntry({ ...long, operatorResumePending: true }, options.nowMs), null);
		fs.mkdirSync(subject.outputDir, { recursive: true });
		fs.writeFileSync(path.join(subject.outputDir, feb), 'invalid unrelated month');
		const writer = require('child_process').spawnSync(process.execPath,
			[require.resolve('../lib/recording-history-csv'), subject.root, JSON.stringify(entry)], { encoding: 'utf8' });
		assert.strictEqual(writer.status, 0, writer.stderr);
		assert.strictEqual(history.readFile(subject.outputDir, jan).rows[0][5], 'DROPあり（5）');
		assert.strictEqual(history.exportRecording(options, entry).appended, 0);

		// An analysis completed in a later month updates only the start month.
		long.savedTsAnalysis = { checkedAt: jstTimestamp(2026, 3, 1, 1, 0),
			result: { completed: true, status: 'SUSPECT', ccErrorEvents: 2 } };
		options.matchList = [match(long, 'RECORDED', { recordedId: long.id })];
		for (const [name, rows] of [['recorded', [long]], ['match', options.matchList], ['recording', []]]) {
			fs.writeFileSync(path.join(subject.root, 'data', name + '.json'), JSON.stringify(rows));
		}
		await history.refreshAnalysis(subject.root, { recordingResultCsvEnabled: true }, long);
		assert.strictEqual(history.readFile(subject.outputDir, jan).rows[0][5], 'DROPあり（2）');
		assert.strictEqual(fs.readFileSync(path.join(subject.outputDir, feb), 'utf8'), 'invalid unrelated month');

		const later = program('later', long.end + 60000, { recorded: '/recorded/later.m2ts' });
		const retryOptions = { ...options, nowMs: later.end, recordingList: [], recordedList: [long, later] };
		const failed = history.exportRecording(retryOptions, history.completedRecordingEntry(later, later.end));
		assert.deepStrictEqual(failed.failedFiles, [feb]);
		const dataDir = path.join(subject.root, 'data');
		const configFile = path.join(subject.root, 'config.json');
		const recordedFile = path.join(dataDir, 'recorded.json');
		const recordingFile = path.join(dataDir, 'recording.json');
		fs.writeFileSync(configFile, JSON.stringify({ recordingResultCsvEnabled: true }));
		fs.writeFileSync(recordedFile, JSON.stringify([long, later]));
		fs.writeFileSync(path.join(dataDir, 'reserves2.json'), '[]');
		const runMatching = () => {
			const result = require('child_process').spawnSync(process.execPath, [require.resolve('../app-matching'),
				'--config', configFile, '--recorded', recordedFile, '--recording', recordingFile,
				'--reserves2', path.join(dataDir, 'reserves2.json'), '--output', path.join(dataDir, 'match.json'),
				'--now', String(jstTimestamp(2026, 3, 2, 0, 0)), '--recorded-history-days', '1'], { encoding: 'utf8' });
			assert.strictEqual(result.status, 0, result.stderr);
			return JSON.parse(fs.readFileSync(recordedFile, 'utf8')).map(row => row.id);
		};
		assert.deepStrictEqual(runMatching(), [later.id]); // Corrupt CSV protects the matching month's history.
		fs.unlinkSync(path.join(subject.outputDir, feb));
		fs.writeFileSync(recordingFile, JSON.stringify([{ ...later, _operatorHistoryPending: true }]));
		assert.deepStrictEqual(runMatching(), [later.id]); // A handoff still in progress is also protected.
		assert.strictEqual(fs.existsSync(path.join(subject.outputDir, feb)), false);
		fs.writeFileSync(recordingFile, '[]');
		assert.deepStrictEqual(runMatching(), []);
		assert.strictEqual(history.readFile(subject.outputDir, feb).rows[0][4], '録画完了');

		// If analysis wins the lock first, the later initial-save request is idempotent.
		const analysisFirst = program('analysis-first', later.end + 60000, {
			recorded: '/recorded/analysis-first.m2ts', savedTsAnalysis: long.savedTsAnalysis
		});
		fs.writeFileSync(path.join(subject.root, 'data/recorded.json'), JSON.stringify([long, later, analysisFirst]));
		await history.refreshAnalysis(subject.root, { recordingResultCsvEnabled: true }, analysisFirst);
		assert.strictEqual(history.exportRecording(options, history.completedRecordingEntry(analysisFirst)).appended, 0);
		assert.strictEqual(history.readFile(subject.outputDir, feb).rows[1][5], 'DROPあり（2）');
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
