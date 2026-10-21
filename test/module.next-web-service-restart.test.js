'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');

async function loadModel() {
	const source = fs.readFileSync(path.resolve(__dirname, '../next-web/services/service-restart-model.js'), 'utf8');
	return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

describe('next WUI service restart model', function() {
	it('uses server safety state for Operator and never offers Scheduler restart', async function() {
		const { restartButtonModel } = await loadModel();
		const report = { targets: {
			operator: { restartable: true, restartSummary: '録画していません' },
			wui: { restartable: true }
		}, operations: {} };
		assert.deepStrictEqual(restartButtonModel('scheduler', report, null), { visible: false, enabled: false, reason: '' });
		assert.deepStrictEqual(restartButtonModel('mirakurun', report, null), { visible: false, enabled: false, reason: '' });
		assert.strictEqual(restartButtonModel('operator', report, null).enabled, true);
		report.targets.operator.restartable = false;
		report.targets.operator.activity = 'busy';
		report.targets.operator.activityPhase = 'recording';
		report.targets.operator.restartSummary = '録画中です';
		const blocked = restartButtonModel('operator', report, null);
		assert.strictEqual(blocked.visible, true);
		assert.strictEqual(blocked.enabled, false);
		assert.strictEqual(blocked.reasonKind, 'recording');
		assert.strictEqual(restartButtonModel('wui', report, null).visible, true);
		const unavailable = restartButtonModel('wui', {
			targets: { wui: { restartable: false, manager: 'unavailable' } }
		}, null);
		assert.strictEqual(unavailable.enabled, false);
		assert.strictEqual(unavailable.reasonKind, 'unknown');
	});

	it('locks an accepted operation and recognizes a verified process generation change', async function() {
		const { restartButtonModel, serviceGenerationChanged } = await loadModel();
		const report = { targets: { wui: { restartable: true } }, operations: {} };
		const pending = { target: 'wui', state: 'reconnecting', message: '確認中' };
		const model = restartButtonModel('wui', report, pending);
		assert.strictEqual(model.visible, true);
		assert.strictEqual(model.enabled, false);
		assert.strictEqual(serviceGenerationChanged(
			{ pid: 10, restartCount: 1, startedAt: 100 },
			{ pid: 11, restartCount: 2, startedAt: 200 }
		), true);
		assert.strictEqual(serviceGenerationChanged(
			{ pid: 10, restartCount: 1, startedAt: 100 },
			{ pid: 10, restartCount: 1, startedAt: 100 }
		), false);
	});

});
