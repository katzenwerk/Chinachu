'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const matching = require('../app-matching');

function createRecorded(duration) {
	return {
		id: 'recorded-duration-test',
		start: 1000,
		end: 61000,
		seconds: 60,
		title: 'Recorded duration test',
		channel: { id: 'channel', name: 'Channel', type: 'GR' },
		recorded: '/recorded/test.m2ts',
		recordedDurationSeconds: duration,
		operatorInterruptionCount: 2
	};
}

describe('Matching recorded duration metadata', function() {
	it('keeps ffprobe duration as a decimal in merged program and recording result', function() {
		const recorded = createRecorded(59.123456);
		const program = matching.mergeProgram(recorded, null, true, recorded.channel);
		const result = matching.buildRecordingResult(recorded, 123456789, false);

		assert.strictEqual(matching.safeNumber('59.123456', 0), 59.123456);
		assert.strictEqual(program.recordedDurationSeconds, 59.123456);
		assert.strictEqual(program.operatorInterruptionCount, 2);
		assert.strictEqual(result.recordedDurationSeconds, 59.123456);
		assert.strictEqual(result.operatorInterruptionCount, 2);
		assert.strictEqual(result.snapshot, undefined);
	});

	it('omits invalid or non-positive duration values', function() {
		[ '', 'not-a-number', NaN, Infinity, 0, -1 ].forEach(value => {
			const recorded = createRecorded(value);
			const result = matching.buildRecordingResult(recorded, 123456789, false);

			assert.strictEqual(result.recordedDurationSeconds, undefined);
		});
	});
});
