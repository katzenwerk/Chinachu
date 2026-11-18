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
	const effects = (before, after) => model.configApplicationEffects(before, after);
	const explicitDefaults = {
		wuiBlockGlobalAccess: true, recordedCommandSerial: true, recordedThumbnailAutoEnabled: true, seriesUseSyobocal: true,
		vaapiEnabled: false, vaapiDevice: '/dev/dri/renderD128', wuiOpenPort: 20772,
		recordedFolderOrganizeEnabled: false, recordedFolderOrganizeOrder: 'filename',
		storageLowSpaceThresholdMB: 3000, storageLowSpaceAction: 'stop',
		storageLowSpaceWarningThresholdMB: 0, storageLowSpaceWarningIntervalMinutes: 180,
		storageLowSpaceCriticalNotifyIntervalMinutes: 180, handoffPrepSeconds: 20,
		matchRetentionDays: 365, reserves2RetentionDays: 365, recordedHistoryRetentionDays: 365,
		recordedStorage: { protectRootFilesystem: false }, broadcastClockIntervalHours: 3,
		recordingBoundaryPolicy: 'end', recordingPriority: 2, conflictedPriority: 1,
		dropDetectionMode: 'mirakurun', autoTsMaxRecordings: 0, recordedStorageWakeupBeforeSec: 0
	};
	assert.deepStrictEqual(model.configApplicationMessages(effects({}, explicitDefaults)), []);
	for (const [key, value, targets] of [
		['mirakurunPath', 'http://192.0.2.1:40772/', ['operator', 'wui', 'scheduler', 'history']],
		['recordedDir', '/new', ['operator', 'wui', 'history']],
		['recordedDirs', [{ id: 'one', name: 'One', path: '/one' }], ['operator', 'wui', 'scheduler', 'history']],
		['storageLowSpaceThresholdMB', 5000, ['operator', 'wui']],
		['recordedFolderOrganizeEnabled', true, ['operator', 'wui']],
		['recordedFolderOrganizeOrder', 'title', ['operator']],
		['recordedCommandSerial', false, ['operator']],
		['vaapiEnabled', true, ['wui']], ['normalizationForm', 'NFKC', ['wui', 'scheduler', 'history']],
		['excludeServices', [211], ['scheduler']], ['serviceOrder', [211], ['scheduler']],
		['matchRetentionDays', 30, ['history']], ['reserves2RetentionDays', 0, ['history']],
		['recordedHistoryRetentionDays', 90, ['history']], ['recordingResultCsvEnabled', true, ['history']],
		['externalNotifications', { routes: {}, events: {} }, ['immediate']]
	]) {
		const result = effects({}, { [key]: value });
		assert.deepStrictEqual(['operator', 'wui', 'scheduler', 'history', 'immediate'].filter(target => result[target]), targets, key);
		assert.deepStrictEqual(result.unknown, []);
	}
	assert.deepStrictEqual(model.configApplicationMessages(effects({ vaapiEnabled: false }, { vaapiEnabled: false, vaapiDevice: '/dev/dri/other' })), []);
	assert.strictEqual(effects({ vaapiEnabled: true }, { vaapiEnabled: true, vaapiDevice: '/dev/dri/renderD128' }).wui, false);
	assert.ok(model.configApplicationMessages(effects({}, { wuiOpenPort: 20773 })).some(text => text.includes('現在のURL')));
	assert.ok(model.configApplicationMessages(effects({}, { recordedFolderOrganizeEnabled: true })).some(text => text.includes('WUIだけを再起動しても')));
	assert.ok(model.configApplicationMessages(effects({}, { serviceOrder: [211] }))[0].startsWith('再起動不要'));
	assert.deepStrictEqual(model.configApplicationMessages(effects({}, { externalNotifications: {} })), []);
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

	assert.strictEqual(model.configForSave(original).recordedCommandSerial, true);
	for (const serial of [true, false]) {
		const config = { ...original, recordedCommandSerial: serial };
		assert.strictEqual(model.configForSave(config).recordedCommandSerial, serial);
		assert.ok(!model.unknownConfigKeys(config).includes('recordedCommandSerial'));
		assert.deepStrictEqual(model.validateConfig(config), []);
	}
	assert.ok(model.validateConfig({ ...original, recordedCommandSerial: 'false' }).some(message => message.includes('直列実行')));
	assert.strictEqual(model.configForSave(original).recordedThumbnailAutoEnabled, true);
	for (const enabled of [true, false]) {
		const config = { ...original, recordedThumbnailAutoEnabled: enabled };
		assert.strictEqual(model.configForSave(config).recordedThumbnailAutoEnabled, enabled);
		assert.ok(!model.unknownConfigKeys(config).includes('recordedThumbnailAutoEnabled'));
		assert.deepStrictEqual(model.validateConfig(config), []);
	}
	assert.ok(model.validateConfig({ ...original, recordedThumbnailAutoEnabled: 'false' }).some(message => message.includes('サムネイル自動作成')));

	// Hidden controls and an untouched mixed retention policy survive other edits.
	const individual = {
		...original, ffprobeCommand: '/custom/ffprobe', recordedDurationProbeTimeoutMs: 12345,
		recordedNameEnclosingCharacterMap: { '🈟': '新番組' },
		vaapiEnabled: true, vaapiDevice: '/dev/dri/renderD129',
		recordedFolderOrganizeEnabled: true, recordedFolderOrganizeOrder: 'history',
		matchRetentionDays: 120, reserves2RetentionDays: 0
	};
	const mixedBefore = JSON.stringify(individual);
	assert.deepStrictEqual(model.historyRetentionValues(individual).map(item => item.days), [120, 0, 365]);
	assert.strictEqual(JSON.stringify(individual), mixedBefore);
	const untouched = model.cloneConfig(individual);
	model.setConfigValue(untouched, 'vaapiEnabled', false);
	model.setConfigValue(untouched, 'recordedFolderOrganizeEnabled', false);
	const savedUntouched = model.configForSave(untouched);
	assert.strictEqual(savedUntouched.vaapiDevice, individual.vaapiDevice);
	assert.strictEqual(savedUntouched.recordedFolderOrganizeOrder, 'history');
	assert.strictEqual(savedUntouched.ffprobeCommand, individual.ffprobeCommand);
	assert.strictEqual(savedUntouched.recordedDurationProbeTimeoutMs, 12345);
	assert.deepStrictEqual(savedUntouched.recordedNameEnclosingCharacterMap, individual.recordedNameEnclosingCharacterMap);
	assert.strictEqual(savedUntouched.matchRetentionDays, 120);
	assert.strictEqual(savedUntouched.reserves2RetentionDays, 0);
	assert.ok(!Object.hasOwn(savedUntouched, 'recordedHistoryRetentionDays'));
	assert.ok(!model.configChanges(individual, savedUntouched).some(change => /RetentionDays$/.test(change.key)));
	assert.deepStrictEqual(model.historyRetentionValues({}).map(item => item.days), [365, 365, 365]);
	assert.deepStrictEqual(model.historyRetentionValues({ matchRetentionDays: 365 }).map(item => item.days), [365, 365, 365]);
	model.setHistoryRetentionDays(untouched, 30);
	assert.deepStrictEqual(model.historyRetentionValues(model.configForSave(untouched)).map(item => item.days), [30, 30, 30]);
	assert.strictEqual(model.configChanges(individual, untouched).filter(change => /RetentionDays$/.test(change.key)).length, 3);
	model.setHistoryRetentionDays(untouched, 0);
	assert.deepStrictEqual(model.historyRetentionValues(untouched).map(item => item.days), [0, 0, 0]);
	const beforeInvalid = JSON.stringify(untouched);
	assert.throws(() => model.setHistoryRetentionDays(untouched, -1));
	assert.throws(() => model.setHistoryRetentionDays(untouched, 1.5));
	assert.strictEqual(JSON.stringify(untouched), beforeInvalid);
	assert.strictEqual(JSON.stringify(individual), mixedBefore);
	assert.ok(!Object.hasOwn(untouched, 'historyRetentionDays'));

	const commandDraft = model.cloneConfig(individual);
	commandDraft.externalNotifications = { routes: { command: { configured: true, enabled: false, command: ['/fixture/notifier', 'arg'] } },
		events: { failure: true }, commandManaged: true };
	assert.deepStrictEqual(model.configForSave(commandDraft).notificationCommand, individual.notificationCommand);
	assert.strictEqual(model.configForSave(commandDraft).externalNotifications.routes.command.enabled, false);

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

	// Display and persistence use one stable ordering, including duplicate ranks.
	const settingsSource = fs.readFileSync(path.join(__dirname, '../next-web/pages/settings-page.js'), 'utf8');
	const sortingSource = settingsSource.slice(settingsSource.indexOf('export function sortSettingsServices'), settingsSource.indexOf('export function renderSettingsPage'));
	const sorting = await import('data:text/javascript;base64,' + Buffer.from(sortingSource).toString('base64'));
	const services = [
		{ id: 11, stableIndex: 0, order: '', excluded: false },
		{ id: 22, stableIndex: 1, order: '2', excluded: true },
		{ id: 33, stableIndex: 2, order: '1', excluded: false },
		{ id: 44, stableIndex: 3, order: '2', excluded: false },
		{ id: 55, stableIndex: 4, order: '', excluded: false }
	];
	assert.deepStrictEqual(sorting.sortSettingsServices(services).map(item => item.id), [33, 22, 44, 11, 55]);
	assert.deepStrictEqual(services.map(item => item.id), [11, 22, 33, 44, 55]);
	const serviceContext = { services, draft: { serviceOrder: [999, 33], excludeServices: [22] },
		sortSettingsServices: sorting.sortSettingsServices, markChanged() {} };
	const commitSource = settingsSource.slice(settingsSource.indexOf('  function commitServices('), settingsSource.indexOf('  function createServicesTab('));
	vm.runInNewContext(commitSource, serviceContext);
	serviceContext.commitServices('excluded');
	assert.deepStrictEqual(serviceContext.draft.serviceOrder, [999, 33]);
	serviceContext.commitServices('order');
	assert.deepStrictEqual(serviceContext.draft.serviceOrder, [33, 22, 44]);
	assert.deepStrictEqual(serviceContext.draft.excludeServices, [22]);
	services[0].order = '1';
	serviceContext.commitServices('order');
	assert.deepStrictEqual(serviceContext.draft.serviceOrder, [11, 33, 22, 44]);
	services[2].order = '';
	serviceContext.commitServices('order');
	assert.deepStrictEqual(serviceContext.draft.serviceOrder, [11, 22, 44]);
	// Typing alone leaves the draft and DOM order intact; Enter/blur commit.
	const orderHandlers = {};
	const orderInput = { value: '2', validity: { badInput: false }, addEventListener(name, callback) { orderHandlers[name] = callback; } };
	let orderCommits = 0, rowMoves = 0, orderError;
	const orderContext = { order: orderInput, item: { id: 22, order: '1' }, error: {},
		setError(key, element, message) { orderError = message; }, markChanged() {}, updateServiceStatus() {},
		commitServices(kind) { assert.strictEqual(kind, 'order'); orderCommits++; }, reorder() { rowMoves++; } };
	const bindingStart = settingsSource.indexOf('        const commitOrder = () => {');
	vm.runInNewContext(settingsSource.slice(bindingStart, settingsSource.indexOf('        orderLabel.append(order);', bindingStart)), orderContext);
	assert.strictEqual(orderHandlers.input, undefined);
	assert.strictEqual(orderContext.item.order, '1');
	assert.strictEqual(rowMoves, 0);
	orderHandlers.keydown({ key: 'Enter', preventDefault() {} });
	assert.strictEqual(orderContext.item.order, '2');
	assert.strictEqual(orderCommits, 1); assert.strictEqual(rowMoves, 1);
	orderInput.value = '';
	orderHandlers.blur();
	assert.strictEqual(orderContext.item.order, '');
	assert.strictEqual(orderCommits, 2); assert.strictEqual(rowMoves, 2);
	orderInput.value = '1.5';
	orderHandlers.blur();
	assert.ok(orderError); assert.strictEqual(orderCommits, 2);
	assert.strictEqual(orderContext.item.order, '');

	// Card clicks reuse the checkbox, while its label and the whole order control are excluded.
	let cardClick, checkboxClicks = 0, excluded = false;
	const cardClickContext = {
		row: { addEventListener(name, callback) { assert.strictEqual(name, 'click'); cardClick = callback; } },
		excludeLabel: { contains(target) { return ['checkbox', 'exclude-label'].includes(target); } },
		orderLabel: { contains(target) { return ['order-input', 'order-label'].includes(target); } },
		check: { click() { checkboxClicks++; excluded = !excluded; cardClick({ target: 'checkbox' }); } }
	};
	const cardClickStart = settingsSource.indexOf("        row.addEventListener('click', event => {");
	assert.ok(cardClickStart >= 0);
	vm.runInNewContext(settingsSource.slice(cardClickStart, settingsSource.indexOf('        rows.set(item, row);', cardClickStart)), cardClickContext);
	for (const target of ['card', 'logo', 'service-name', 'service-details']) cardClick({ target });
	assert.strictEqual(checkboxClicks, 4);
	assert.strictEqual(excluded, false);
	for (const target of ['checkbox', 'exclude-label', 'order-input', 'order-label']) cardClick({ target });
	assert.strictEqual(checkboxClicks, 4);
	cardClick({ target: 'card' });
	assert.strictEqual(excluded, true);

	// Render the success notice without saving production settings or starting services.
	const notice = { children: [], hidden: true, append(...nodes) { this.children.push(...nodes); }, replaceChildren() { this.children = []; } };
	const restartSource = fs.readFileSync(path.join(__dirname, '../next-web/services/service-restart-model.js'), 'utf8');
	const restartModel = await import('data:text/javascript;base64,' + Buffer.from(restartSource).toString('base64'));
	const noticeContext = {
		savedEffects: null, disposed: false, restartOutcome: '', restartChecking: false, restartError: '', restartDialog: null,
		restartReport: { targets: { wui: { restartable: true } } },
		container: { querySelector() { return notice; } },
		document: { createElement(tag) { return { tag, addEventListener() {} }; } },
		getPendingRestart: () => null, configApplicationMessages: model.configApplicationMessages,
		restartButtonModel: restartModel.restartButtonModel, refreshRestartReport() {}
	};
	const renderNoticeStart = settingsSource.indexOf('  function renderSavedApplication()');
	vm.runInNewContext(settingsSource.slice(renderNoticeStart, settingsSource.indexOf('  const unsubscribeRestart', renderNoticeStart)), noticeContext);
	noticeContext.renderSavedApplication();
	assert.strictEqual(notice.hidden, true);
	for (const config of [{ recordingPriority: 3 }, { vaapiEnabled: true }, { recordedFolderOrganizeEnabled: true }, { externalNotifications: {} }]) {
		noticeContext.savedEffects = effects({}, config);
		noticeContext.renderSavedApplication();
		const restartButtons = notice.children.filter(node => node.tag === 'button');
		assert.strictEqual(restartButtons.length, noticeContext.savedEffects.wui ? 1 : 0);
		assert.ok(notice.children[0].textContent.startsWith('設定を保存しました。'));
	}
	noticeContext.savedEffects = effects({}, { vaapiEnabled: true });
	noticeContext.restartReport = { targets: { wui: { restartable: false, restartSummary: 'PM2管理先を特定できません' } } };
	noticeContext.renderSavedApplication();
	assert.strictEqual(notice.children.find(node => node.textContent === 'WUIを再起動').disabled, true);
	assert.ok(notice.children.some(node => node.textContent === 'PM2管理先を特定できません'));
	noticeContext.restartReport.targets.wui.restartable = true;
	noticeContext.getPendingRestart = () => ({ target: 'wui', state: 'reconnecting', message: '確認中' });
	noticeContext.renderSavedApplication();
	assert.strictEqual(notice.children.find(node => node.textContent === 'WUIを再起動').disabled, true);
	assert.ok(notice.children.some(node => node.textContent === '確認中'));

	// The real save callback must not expose the notice on a rejected save.
	let dialog, saveFails = true, savedNotices = 0;
	function element() {
		return { children: [], handlers: {}, selectors: new Map(), classList: { add() {} },
			append(...nodes) { this.children.push(...nodes); }, before() {}, close() {}, showModal() {}, remove() {},
			addEventListener(name, fn) { this.handlers[name] = fn; },
			querySelector(selector) { if (!this.selectors.has(selector)) this.selectors.set(selector, element()); return this.selectors.get(selector); },
			querySelectorAll() { return [element(), element(), element()]; } };
	}
	const saveContext = {
		original: { recordedDir: '/recorded' }, draft: { recordedDir: '/recorded', vaapiEnabled: true },
		applicationBaseline: { recordedDir: '/recorded' }, wuiApplicationBaseline: { recordedDir: '/recorded' }, savedEffects: null,
		configChanges: model.configChanges, configForSave: model.configForSave, validateConfig: model.validateConfig,
		configApplicationEffects: model.configApplicationEffects, configApplicationMessages: model.configApplicationMessages,
		formatChangeValue: model.formatChangeValue, cloneConfig: model.cloneConfig,
		fieldErrors: new Map(), controller: { signal: {} }, notificationView: { refresh() {} }, markChanged() {},
		document: { createElement(tag) { const node = element(); if (tag === 'dialog') dialog = node; return node; }, body: element() },
		async saveConfig(value) { if (saveFails) throw new Error('save failed'); return value; },
		renderSavedApplication() { savedNotices++; }, refreshRestartReport() {}
	};
	const saveStart = settingsSource.indexOf('  function openSaveDialog()');
	vm.runInNewContext(settingsSource.slice(saveStart, settingsSource.indexOf('  async function refreshRestartReport()', saveStart)), saveContext);
	saveContext.openSaveDialog();
	await dialog.querySelector('[data-save]').handlers.click();
	assert.strictEqual(savedNotices, 0);
	assert.strictEqual(saveContext.savedEffects, null);
	assert.strictEqual(saveContext.original.vaapiEnabled, undefined);
	saveFails = false;
	await dialog.querySelector('[data-save]').handlers.click();
	assert.strictEqual(savedNotices, 1);
	assert.strictEqual(saveContext.original.vaapiEnabled, true);
	assert.strictEqual(saveContext.savedEffects.wui, true);
	saveContext.original.recordingPriority = 3;
	saveContext.updateSavedEffects();
	assert.strictEqual(saveContext.savedEffects.operator, true);
	assert.strictEqual(saveContext.savedEffects.wui, true);
	saveContext.wuiApplicationBaseline = model.cloneConfig(saveContext.original);
	saveContext.updateSavedEffects();
	assert.strictEqual(saveContext.savedEffects.operator, true);
	assert.strictEqual(saveContext.savedEffects.wui, false);

	const serverDisabled = model.configForSave({ recordedDir: '/recorded', wuiOpenServer: false });
	assert.strictEqual(serverDisabled.wuiOpenServer, false);
	assert.ok(!Object.hasOwn(model.configForSave({ recordedDir: '/recorded' }), 'wuiOpenServer'));

	// An excluded service has no schedule row but still resolves through Mirakurun.
	const logoSource = fs.readFileSync(path.join(__dirname, '../api/script-channel-logo.vm.js'), 'utf8');
	const logoResult = await new Promise(resolve => vm.runInNewContext(logoSource, {
		request: { param: { chid: (12345).toString(36) }, type: 'png' }, data: { schedule: [] },
		mirakurun: { getLogoImage(id) { assert.strictEqual(id, 12345); return Promise.resolve(Buffer.from('logo')); } },
		response: { head(status) { assert.strictEqual(status, 200); }, end(body) { resolve(body.toString()); }, error(status) { resolve(status); } }
	}));
	assert.strictEqual(logoResult, 'logo');
	const unavailableLogo = await new Promise(resolve => vm.runInNewContext(logoSource, {
		request: { param: { chid: (12345).toString(36) }, type: 'png' },
		mirakurun: { getLogoImage() { return Promise.reject({ req: {}, statusCode: 404 }); } },
		response: { error(status) { resolve(status); } }
	}));
	assert.strictEqual(unavailableLogo, 404);
	let invalidLogo;
	vm.runInNewContext(logoSource, {
		request: { param: { chid: '../bad' }, type: 'png' },
		mirakurun: { getLogoImage() { assert.fail('Invalid service ID reached Mirakurun'); } },
		response: { error(status) { invalidLogo = status; } }
	});
	assert.strictEqual(invalidLogo, 404);


});
