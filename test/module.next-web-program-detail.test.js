'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

async function programDetailModel() {
	const dependencySource = fs.readFileSync(path.join(__dirname, '../next-web/services/recorded-result-warnings.js'), 'utf8');
	const dependencyUrl = 'data:text/javascript;base64,' + Buffer.from(dependencySource).toString('base64');
	const source = fs.readFileSync(path.join(__dirname, '../next-web/services/program-detail-model.js'), 'utf8')
		.replace("'./recorded-result-warnings.js'", JSON.stringify(dependencyUrl));
	return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

function detail(overrides = {}) {
	const start = Date.now() + 3600000;
	return {
		program: {
			id: 'program-a', title: '番組A', start, end: start + 1800000, seconds: 1800,
			channel: { id: 'GR_1', name: '放送局', type: 'GR' },
			...overrides.program
		},
		match: overrides.match || null,
		resolution: overrides.resolution || null,
		currentSource: overrides.currentSource || 'schedule',
		rules: overrides.rules || [],
		historyAmbiguous: false
	};
}

test('common programme detail maps reservation, rule and recorded actions without merging phase/file/history state', async function () {
	const { buildProgramDetailModel } = await programDetailModel();
	const future = buildProgramDetailModel(detail());
	assert.strictEqual(future.phase.key, 'program');
	assert.strictEqual(future.actions.reservation, 'reserve');
	assert.strictEqual(future.actions.rule.mode, 'create');

	const manual = buildProgramDetailModel(detail({
		currentSource: 'reserves',
		program: { isManualReserved: true }
	}));
	assert.strictEqual(manual.actions.reservation, 'unreserve');

	const ruled = buildProgramDetailModel(detail({
		currentSource: 'reserves',
		program: { ruleUid: 'stable-rule' },
		rules: [{ ruleUid: 'stable-rule' }]
	}));
	assert.strictEqual(ruled.actions.reservation, 'skip');
	assert.strictEqual(ruled.actions.rule.mode, 'edit');
	assert.strictEqual(ruled.actions.rule.ruleUid, 'stable-rule');
	assert.strictEqual(ruled.actions.rule.index, 0);
	assert.strictEqual(ruled.actions.rule.rule.ruleUid, 'stable-rule');
	assert.strictEqual(ruled.actions.rule.pending, false);
	const legacyRuled = buildProgramDetailModel(detail({ currentSource: 'reserves', program: { ruleId: 0 } }));
	assert.strictEqual(legacyRuled.actions.rule.mode, 'unavailable');

	const skipped = buildProgramDetailModel(detail({
		currentSource: 'reserves',
		program: { isSkip: true, ruleUid: 'stable-rule' },
		rules: [{ ruleUid: 'stable-rule' }]
	}));
	assert.strictEqual(skipped.phase.key, 'skipped');
	assert.strictEqual(skipped.actions.reservation, 'unskip');

	const skippedHistory = buildProgramDetailModel(detail({
		currentSource: null,
		program: { isSkip: false },
		match: { status: 'SKIPPED_ONLY' }
	}));
	assert.strictEqual(skippedHistory.phase.key, 'missed');
	assert.strictEqual(skippedHistory.phase.reason.key, 'skipped');

	const recorded = buildProgramDetailModel(detail({
		currentSource: 'recorded',
		program: { id: 'recorded-a', recorded: '/recordings/a.m2ts' },
		match: { status: 'RECORDED', recording: { recordedId: 'recorded-a', path: '/recordings/a.m2ts' } },
		resolution: { source: 'recorded' }
	}));
	assert.strictEqual(recorded.phase.key, 'recorded');
	assert.strictEqual(recorded.fileState.key, 'unknown');
	assert.strictEqual(recorded.matchStatus, 'RECORDED');
	assert.strictEqual(recorded.media.playable, true);
	assert.strictEqual(recorded.actions.deleteRecording.recordedId, 'recorded-a');

	const lowStorageAbort = buildProgramDetailModel(detail({
		currentSource: 'recorded',
		program: {
			id: 'recorded-a', recorded: '/recordings/a.m2ts',
			operatorAbort: true, operatorAbortReason: 'LOW STORAGE'
		},
		match: { status: 'RECORDED', recording: { recordedId: 'recorded-a', path: '/recordings/a.m2ts' } },
		resolution: { source: 'recorded' }
	}));
	assert.strictEqual(lowStorageAbort.phase.key, 'aborted');
	assert.strictEqual(lowStorageAbort.phase.reason.key, 'storage-low');
	assert.strictEqual(lowStorageAbort.media.playable, true);
	assert.strictEqual(lowStorageAbort.actions.deleteRecording.recordedId, 'recorded-a');

	const deleted = buildProgramDetailModel(detail({
		currentSource: null,
		program: { id: 'recorded-a', recorded: '/recordings/a.m2ts' },
		match: { status: 'RECORDED', recording: { recordedId: 'recorded-a', path: '/recordings/a.m2ts' }, deletion: { reason: 'manual' } },
		resolution: { source: 'reserves2' }
	}));
	assert.strictEqual(deleted.phase.key, 'deleted');
	assert.strictEqual(deleted.phase.reason.key, 'manual-delete');
	assert.strictEqual(deleted.fileState.key, 'deleted');
	assert.strictEqual(deleted.matchStatus, 'RECORDED');
	assert.strictEqual(deleted.media.playable, false);
	assert.strictEqual(deleted.media.thumbnailUrl, '/api/recorded/recorded-a/thumbnail.jpg');
	assert.strictEqual(deleted.actions.deleteRecording, null);

	const start = Date.now() + 60000;
	const liveDetail = detail({ program: { start, end: start + 60000 } });
	assert.strictEqual(buildProgramDetailModel(liveDetail, start - 1).media.liveModel, null);
	assert.strictEqual(buildProgramDetailModel(liveDetail, start).media.liveModel.liveChannel.id, 'GR_1');
	assert.strictEqual(buildProgramDetailModel(liveDetail, start + 30000).media.liveModel.liveChannel.id, 'GR_1');
	assert.strictEqual(buildProgramDetailModel(liveDetail, start + 60000).media.liveModel, null);
	const liveReserved = buildProgramDetailModel(detail({
		currentSource: 'reserves',
		program: { start, end: start + 60000, isManualReserved: true }
	}), start + 1);
	assert.strictEqual(liveReserved.media.liveModel.liveChannel.id, 'GR_1');
	const liveRecording = buildProgramDetailModel(detail({
		currentSource: 'recording',
		program: { start, end: start + 60000, recorded: '/recordings/live.m2ts', pid: 1 }
	}), start + 1);
	assert.strictEqual(liveRecording.media.liveModel.liveChannel.id, 'GR_1');

	const pendingRule = buildProgramDetailModel({ ...detail(), preferredRuleUid: 'created-rule', rules: [{ ruleUid: 'created-rule' }] });
	assert.strictEqual(pendingRule.phase.key, 'program');
	assert.strictEqual(pendingRule.actions.rule.mode, 'edit');
	assert.strictEqual(pendingRule.actions.rule.pending, true);
});
