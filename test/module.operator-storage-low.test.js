'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const storageLow = require('../lib/storage-low');

describe('Operator low-storage handling', function() {
	it('stops every recording present at the start of one low-storage pass', function() {
		function runPass(ids) {
			const recording = ids.map(id => ({ id: id }));
			const stopped = [];

			storageLow.stopCurrentRecordings(recording, function(id, reason) {
				stopped.push({ id: id, reason: reason });
				const index = recording.findIndex(program => program.id === id);
				if (index !== -1) {
					recording.splice(index, 1);
				}
			});

			return { recording: recording, stopped: stopped };
		}

		const multiple = runPass([ 'A', 'B', 'C' ]);
		assert.deepStrictEqual(multiple.stopped, [
			{ id: 'A', reason: 'LOW STORAGE' },
			{ id: 'B', reason: 'LOW STORAGE' },
			{ id: 'C', reason: 'LOW STORAGE' }
		]);
		assert.deepStrictEqual(multiple.recording, []);

		const single = runPass([ 'A' ]);
		assert.deepStrictEqual(single.stopped, [ { id: 'A', reason: 'LOW STORAGE' } ]);
		assert.deepStrictEqual(single.recording, []);
	});

	it('does not infer a match deletion without a recorded ledger entry', function() {
		const item = {
			status: 'RECORDED',
			program: { id: 'program-id', recorded: '/recorded/orphan.m2ts' },
			recordingResult: { id: 'recorded-id', recorded: '/recorded/orphan.m2ts' }
		};

		assert.strictEqual(
			storageLow.markMatchRecordingDeleted([ item ], [], '/recorded/orphan.m2ts', 1, 'storage-low'),
			false
		);
		assert.strictEqual(item.recordingResult.cleanupState, undefined);
	});
});
