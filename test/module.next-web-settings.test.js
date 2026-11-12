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

	assert.strictEqual(model.configForSave(original).recordedThumbnailAutoEnabled, true);
	for (const enabled of [true, false]) {
		const config = { ...original, recordedThumbnailAutoEnabled: enabled };
		assert.strictEqual(model.configForSave(config).recordedThumbnailAutoEnabled, enabled);
		assert.ok(!model.unknownConfigKeys(config).includes('recordedThumbnailAutoEnabled'));
		assert.deepStrictEqual(model.validateConfig(config), []);
	}
	assert.ok(model.validateConfig({ ...original, recordedThumbnailAutoEnabled: 'false' }).some(message => message.includes('サムネイル自動作成')));

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

	const GiB = 1024 ** 3;
	const storageSample = { id: 'one', name: 'One', status: 'ok', available: 12 * GiB, total: 20 * GiB,
		used: 8 * GiB, capacityReliable: true, capacityCheckedAt: Date.now() };
	const capacityData = { thresholds: { warningEnabled: true, warningMB: 10000, cleanupMB: 3000, action: 'stop-new' }, storages: [storageSample] };
	assert.strictEqual(storage.buildHomeStorageWarning(capacityData), null);
	capacityData.storages = [{ ...storageSample, status: 'low-space', lowSpacePhase: 'warning', available: 8 * GiB }];
	const homeWarning = storage.buildHomeStorageWarning(capacityData);
	assert.strictEqual(homeWarning.level, 'warning');
	assert.strictEqual(homeWarning.title, 'ストレージ容量低下');
	assert.strictEqual(homeWarning.entries[0].free, '8.59 GB');
	assert.strictEqual(homeWarning.entries[0].usagePercent, '60.0');
	assert.strictEqual(homeWarning.entries[0].note, '');
	const low = { ...storageSample, id: 'two', name: 'Two', status: 'low-space', lowSpacePhase: 'cleanup', available: GiB };
	capacityData.storages.push(low, { ...low, id: 'three', name: 'Three' });
	const homeLow = storage.buildHomeStorageWarning(capacityData);
	assert.strictEqual(homeLow.level, 'low'); assert.strictEqual(homeLow.title, 'ストレージ容量不足');
	assert.strictEqual(homeLow.entries.length, 2); assert.strictEqual(homeLow.remaining, 1);
	assert.ok(homeLow.entries.every(row => row.level === 'low'));
	assert.ok(homeLow.entries.every(row => !row.note.includes('停止'))); // Low does not prove admission is blocked.
	capacityData.storages = [{ ...low, lowSpaceCurrent: true, stopNewRecordings: true }];
	assert.strictEqual(storage.buildHomeStorageWarning(capacityData).entries[0].note, '新規録画の開始を停止中');
	assert.ok(storage.buildHomeStorageWarning(capacityData, true).entries[0].note.startsWith('参考値'));
	capacityData.storages = [{ ...low, status: 'stale', observedStatus: 'low-space', observedLowSpacePhase: 'cleanup', capacityStale: true,
		lowSpaceCurrent: true, stopNewRecordings: true }];
	assert.ok(storage.buildHomeStorageWarning(capacityData).entries[0].note.startsWith('参考値'));
	const homeSource = fs.readFileSync(path.join(__dirname, '../next-web/pages/home-page.js'), 'utf8');
	const vm = require('vm');
	class Node {
		constructor() { this.children = []; this.parentElement = null; this.attributes = {}; }
		get firstChild() { return this.children[0] || null; }
		get nextSibling() { const parent = this.parentElement; return parent?.children[parent.children.indexOf(this) + 1] || null; }
		setAttribute(key, value) { this.attributes[key] = value; }
		append(...children) { for (const child of children) this.insertBefore(child, null); }
		insertBefore(child, before) { child.remove(); this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, child); child.parentElement = this; }
		replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.append(...children); }
		remove() { if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
	}
	const rendererSource = homeSource.slice(homeSource.indexOf('export function createHomeStorageWarningRenderer'), homeSource.indexOf('export function renderHomePage')).replace('export ', '');
	const sandbox = { document: { createElement: () => new Node() } };
	vm.runInNewContext(rendererSource, sandbox);
	const parent = new Node(), host = new Node(), nextReservation = new Node(); parent.append(host, nextReservation);
	const renderWarning = sandbox.createHomeStorageWarningRenderer(host);
	renderWarning(null); assert.strictEqual(host.children.length, 0);
	renderWarning(homeWarning); const warningCard = host.firstChild, firstRow = warningCard.children[1].firstChild;
	assert.strictEqual(warningCard.className, 'panel home-storage-capacity-card is-warning');
	renderWarning({ ...homeWarning, entries: [{ ...homeWarning.entries[0], free: '7.50 GB' }] });
	assert.strictEqual(host.firstChild, warningCard); assert.strictEqual(warningCard.children[1].firstChild, firstRow);
	renderWarning(homeLow); assert.strictEqual(host.children.length, 1);
	assert.strictEqual(host.firstChild.className, 'panel home-storage-capacity-card is-low');
	assert.strictEqual(homeLow.href, '#storage');
	assert.strictEqual(host.firstChild.firstChild.children[2].href, homeLow.href);
	assert.ok(host.firstChild.children[2].textContent.includes('ほか1件'));
	renderWarning(null); assert.strictEqual(host.children.length, 0); assert.strictEqual(parent.children[1], nextReservation);
	// Initial mounting always selects C and nests the warning above reservations, ignoring old A preferences.
	const mountSource = homeSource.slice(homeSource.indexOf('  const page = document.createElement', homeSource.indexOf('export function renderHomePage')), homeSource.indexOf('  const headerSettings =', homeSource.indexOf('export function renderHomePage')));
	const mounted = new Node();
	vm.runInNewContext(mountSource, { ...sandbox, container: mounted, createHomeStorageWarningRenderer: sandbox.createHomeStorageWarningRenderer });
	assert.strictEqual(mounted.firstChild.className, 'home-page is-layout-c');
	assert.strictEqual(mounted.firstChild.children[2].children[0].className, 'home-storage-capacity-host');
	assert.ok(!homeSource.includes('chinachu.home.layout.v1'));
	assert.ok(!homeSource.includes('data-home-layout'));


	// Notification drafts share the ordinary change/restore model; secrets never enter previews.
	const notification = require('../lib/external-notification');
	const os = require('os');
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-settings-'));
	try {
		fs.mkdirSync(path.join(root, 'data'));
		const configFile = path.join(root, 'config.json');
		fs.writeFileSync(configFile, JSON.stringify(original));
		notification.update(root, { route: 'slack', values: { webhook: 'https://hooks.slack.com/services/fixture/only/secret' } });
		const saved = { ...original, externalNotifications: notification.publicSettings(notification.read(root)) };
		const pending = model.cloneConfig(saved);
		pending.externalNotifications.routes.slack.enabled = true;
		pending.externalNotifications.events.start = true;
		assert.deepStrictEqual(model.configChanges(saved, pending).map(item => item.key), ['externalNotifications']);
		pending.externalNotifications.routes.slack.enabled = false;
		pending.externalNotifications.events.start = false;
		assert.deepStrictEqual(model.configChanges(saved, pending), []);
		pending.externalNotifications.routes.slack.webhook = 'https://hooks.slack.com/services/fixture/new/new-secret';
		assert.ok(!JSON.stringify(model.configPreview(pending)).includes('new-secret'));
		assert.ok(!model.formatChangeValue(pending.externalNotifications, false, 'externalNotifications').includes('new-secret'));
		const apiSource = fs.readFileSync(path.join(__dirname, '../api/script-config.vm.js'), 'utf8');
		function put(config, notifications) {
			let status, body;
			const query = { json: JSON.stringify(config) };
			if (notifications) query.notifications = JSON.stringify(notifications);
			vm.runInNewContext(apiSource, { fs, data: { status: { feature: { configurator: true } } },
				define: { CONFIG_FILE: configFile, REPOSITORY_ROOT: root }, request: { method: 'PUT', query },
				wuiConfigStore: require('../lib/wui-config'), externalNotification: notification,
				response: { head: code => { status = code; }, end: text => { body = JSON.parse(text); }, error: code => { status = code; } } });
			return { status, body };
		}
		const combined = put({ ...original, recordedFormat: 'new-format' }, pending.externalNotifications);
		assert.strictEqual(combined.status, 200);
		assert.strictEqual(combined.body.recordedFormat, 'new-format');
		assert.ok(!JSON.stringify(combined.body).includes('new-secret'));
		assert.ok(!fs.readFileSync(configFile, 'utf8').includes('externalNotifications'));
		assert.ok(notification.read(root).routes.slack.webhook.endsWith('new-secret'));
		put({ ...original, recordedFormat: 'other-tab' });
		assert.ok(notification.read(root).routes.slack.webhook.endsWith('new-secret'));
		const clientSource = fs.readFileSync(path.join(__dirname, '../next-web/services/config-client.js'), 'utf8');
		const client = await import('data:text/javascript;base64,' + Buffer.from(clientSource).toString('base64'));
		const realFetch = globalThis.fetch, calls = [];
		globalThis.fetch = async (url, init) => {
			calls.push({ url, init });
			let value;
			if (init.method === 'GET') value = url.includes('notification') ? notification.publicSettings(notification.read(root)) : JSON.parse(fs.readFileSync(configFile, 'utf8'));
			else {
				assert.strictEqual(url, '/api/config.json');
				assert.ok(!init.body.get('json').includes('externalNotifications'));
				const result = put(JSON.parse(init.body.get('json')), init.body.has('notifications') ? JSON.parse(init.body.get('notifications')) : null);
				return { ok: result.status === 200, status: result.status, json: async () => result.body };
			}
			return { ok: true, status: 200, json: async () => value };
		};
		try {
			const loaded = await client.loadConfig();
			assert.ok(loaded.externalNotifications.routes.slack.configured);
			const edited = model.cloneConfig(loaded);
			edited.recordedThumbnailAutoEnabled = false;
			edited.externalNotifications.events.start = !edited.externalNotifications.events.start;
			edited.externalNotifications.routes.slack.webhook = 'https://hooks.slack.com/services/fixture/edited/new-secret';
			const result = await client.saveConfig(edited, undefined, loaded);
			assert.strictEqual(result.externalNotifications.events.start, edited.externalNotifications.events.start);
			assert.strictEqual(result.externalNotifications.routes.slack.webhook, undefined);
			assert.deepStrictEqual(model.configChanges(result, model.cloneConfig(result)), []);
			assert.strictEqual((await client.loadConfig()).recordedThumbnailAutoEnabled, false);
			const onlyOtherTab = { ...result, recordedFormat: 'unchanged-notification', recordedThumbnailAutoEnabled: true };
			await client.saveConfig(onlyOtherTab, undefined, result);
			assert.strictEqual(calls.at(-1).init.body.has('notifications'), false);
			assert.strictEqual((await client.loadConfig()).recordedThumbnailAutoEnabled, true);
		} finally { globalThis.fetch = realFetch; }
		const deleted = model.cloneConfig(combined.body.externalNotifications);
		deleted.routes.slack = { configured: false, enabled: false };
		assert.ok(notification.read(root).routes.slack); // Staging deletion makes no server change.
		assert.strictEqual(put(original, deleted).status, 200);
		assert.strictEqual(notification.read(root).routes.slack, undefined);
		const invalid = model.cloneConfig(deleted);
		invalid.routes.mail = { configured: true, enabled: true }; // No SMTP connection information.
		assert.strictEqual(put({ recordedDir: '/should-not-save' }, invalid).status, 400);
		assert.strictEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')).recordedDir, original.recordedDir);
		fs.writeFileSync(configFile, '{invalid');
		assert.strictEqual(put(original, deleted).status, 400);
		assert.strictEqual(fs.readFileSync(configFile, 'utf8'), '{invalid');
	} finally { fs.rmSync(root, { recursive: true, force: true }); }


});
