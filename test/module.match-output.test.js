'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const matchOutput = require('../lib/match-output');

describe('Matching log compaction', function() {
	it('replaces repeated RECORDED-over-MISSED lines with one count for consumers', function() {
		const compacted = matchOutput.compactKeepRecordedStatus([
			'KEEP_RECORDED_STATUS: RECORDED over MISSED',
			'total: 3',
			'KEEP_RECORDED_STATUS: RECORDED over MISSED',
			'KEEP_RECORDED_STATUS: RECORDED over MISSED'
		].join('\n'));

		assert.strictEqual(compacted.keepRecordedOverMissed, 3);
		assert.deepStrictEqual(compacted.lines, [ 'total: 3' ]);
	});
});
