'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

async function configModel() {
	const source = fs.readFileSync(path.join(__dirname, '../next-web/services/config-model.js'), 'utf8');
	return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

async function storageModel() {
	const source = fs.readFileSync(path.join(__dirname, '../next-web/services/storage-model.js'), 'utf8');
	return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

test('settings model preserves unknown and untouched values while validating explicit edits', async function () {
	const model = await configModel();
	const original = {
		recordedDir: '/recorded',
		recordedDurationProbeTimeoutMs: '8000',
		customFutureSetting: { enabled: true },
		recordedStorage: { expectedMount: '/recorded', custom: 'keep-default' },
		recordedDirs: [{ id: 'one', name: 'One', path: '/one', storage: { expectedMount: '/mnt/one', custom: 'keep' }, custom: 1 }]
	};
	const draft = model.cloneConfig(original);
	const parsed = model.parseFieldValue('9000', { label: 'timeout', type: 'number', min: 1 });
	model.setConfigValue(draft, 'recordedDurationProbeTimeoutMs', parsed.value);
	assert.strictEqual(draft.recordedDurationProbeTimeoutMs, 9000);
	assert.deepStrictEqual(draft.customFutureSetting, { enabled: true });
	assert.deepStrictEqual(model.unknownConfigKeys(draft), ['customFutureSetting']);

	const dirs = model.normalizeRecordedDirs([{
		original: original.recordedDirs[0], id: 'one', name: 'One renamed', path: '/one', protectRootFilesystem: true
	}]);
	assert.deepStrictEqual(dirs.errors, []);
	assert.strictEqual(dirs.value[0].custom, 1);
	assert.strictEqual(dirs.value[0].storage.custom, 'keep');
	assert.strictEqual(dirs.value[0].storage.expectedMount, '/mnt/one');
	assert.strictEqual(dirs.value[0].storage.protectRootFilesystem, true);
	model.updateRecordedStorageRootProtection(draft, false);
	assert.strictEqual(draft.recordedStorage.expectedMount, '/recorded');
	assert.strictEqual(draft.recordedStorage.custom, 'keep-default');
	assert.strictEqual(draft.recordedStorage.protectRootFilesystem, false);

	const invalid = model.normalizeRecordedDirs([
		{ original: {}, id: 'same', name: 'A', path: '/a', protectRootFilesystem: false },
		{ original: {}, id: 'same', name: 'B', path: '/b', protectRootFilesystem: false }
	]);
	assert.ok(invalid.errors.some(message => message.includes('重複')));
	assert.deepStrictEqual(model.validateConfig({ recordedDir: '/recorded', storageLowSpaceAction: 'stop', recordedDirs: dirs.value }), []);
	assert.deepStrictEqual(model.validateConfig({ recordedDir: '/recorded', storageLowSpaceAction: 'stop-new', recordedDirs: dirs.value }), []);
	assert.ok(model.configChanges(original, draft).some(change => change.key === 'recordedDurationProbeTimeoutMs'));

	const storage = await storageModel();
	const blocked = {
		thresholds: {},
		storages: [{
			id: 'hdd2', name: 'HDD 2', configuredPath: '/mnt/hdd2/recorded',
			status: 'system-filesystem', safetyBlocked: true, rootProtectionEnabled: true,
			identityCheckedAt: Date.now()
		}]
	};
	const issues = storage.buildStorageWarnings(blocked);
	assert.strictEqual(issues.length, 1);
	assert.strictEqual(issues[0].code, 'system-filesystem');
	assert.strictEqual(issues[0].path, '/mnt/hdd2/recorded');
	assert.match(issues[0].message, /録画を禁止/);
	const view = storage.buildStorageViewModels({ storage: blocked, rules: [], reserves: [] })[0];
	assert.strictEqual(view.state.key, 'safety-error');
	assert.strictEqual(view.state.label, '録画禁止');
	assert.ok(view.notes.some(note => note.includes('rootファイルシステム')));
	assert.notStrictEqual(view.checkedAt, '未取得');
	assert.deepStrictEqual(storage.buildStorageWarnings({ thresholds: {}, storages: [{ status: 'ok' }] }), []);

});
