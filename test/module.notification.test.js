'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const notification = require('../lib/notification');
const external = require('../lib/external-notification');
const vm = require('vm');

function prepareSettings(root) {
	fs.mkdirSync(path.join(root, 'data'));
	const routes = { slack: { webhook: 'https://hooks.slack.com/services/fixture/only/secret' },
		pushover: { token: 'fixture-token', user: 'fixture-user' },
		mail: { host: 'smtp.example.invalid', port: '587', encryption: 'starttls', username: 'fixture',
			password: 'fixture-password', from: 'from@example.invalid', to: 'to@example.invalid' } };
	for (const [route, values] of Object.entries(routes)) external.update(root, { route, values });
	return routes;
}
async function drain() { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); }

const workerPath = path.join(__dirname, 'fixtures', 'notification-worker.js');

function countStarts(markerPath) {
	if (!fs.existsSync(markerPath)) {
		return 0;
	}

	return fs.readFileSync(markerPath, 'utf8').trim().split('\n').filter(Boolean).length;
}

function createWorkerSender(markerPath, options) {
	return notification.createNotificationSender([
		process.execPath,
		workerPath,
		markerPath
	], options);
}

describe('notification behavior contracts', function() {
	let temporaryDir;

	beforeEach(function() {
		temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-notification-'));
	});

	afterEach(function() {
		fs.rmSync(temporaryDir, { recursive: true, force: true });
	});

	it('preserves structured command payloads and private external route settings', async function() {
		const outputPath = path.join(temporaryDir, 'notification.jsonl');
		const injectedMarker = path.join(temporaryDir, 'shell-command-ran');
		const payload = notification.createStorageLowNotification({
			availableBytes: 1048576,
			availableMB: 1,
			thresholdMB: 3000,
			recordedDir: '/録画 data/$HOME `command` "quoted" $(touch ' + injectedMarker + ')',
			action: 'none'
		});
		payload.message += '\nユーザー値: 日本語 ${touch ' + injectedMarker + '}';
		const result = await notification.createNotificationSender(['tee', outputPath])(payload);

		assert.strictEqual(result.ok, true);
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), payload);
		assert.strictEqual(payload.event, 'storage-low');
		assert.strictEqual(payload.severity, 'critical');
		assert.strictEqual(payload.metadata.recordedDir, '/録画 data/$HOME `command` "quoted" $(touch ' + injectedMarker + ')');
		assert.deepStrictEqual(payload.metadata, {
			availableBytes: 1048576,
			availableMB: 1,
			thresholdMB: 3000,
			recordedDir: '/録画 data/$HOME `command` "quoted" $(touch ' + injectedMarker + ')',
			action: 'none'
		});
		assert.strictEqual(typeof payload.timestamp, 'string');
		assert.strictEqual(fs.existsSync(injectedMarker), false);

		const warning = notification.createStorageLowNotification({
			availableBytes: 5242880,
			availableMB: 5,
			thresholdMB: 10000,
			recordedDir: '/recorded',
			action: 'remove',
			severity: 'warning',
			phase: 'warning'
		});
		assert.strictEqual(warning.event, 'storage-low');
		assert.strictEqual(warning.severity, 'warning');
		assert.strictEqual(warning.metadata.phase, 'warning');
		assert.strictEqual(warning.metadata.action, 'remove');

		const routes = prepareSettings(temporaryDir);
		let view = external.publicSettings(external.read(temporaryDir));
		assert.deepStrictEqual(view.events, { conflict: true, failure: true, abort: true, storage: true, analysis: true, start: false, complete: false });
		assert.ok(Object.values(view.routes).every(route => route.configured && !route.enabled));
		assert.strictEqual(fs.statSync(path.join(temporaryDir, 'data/external-notification.json')).mode & 0o777, 0o600);
		for (const [route, values] of Object.entries(routes)) {
			external.update(temporaryDir, { route, enabled: true });
			external.update(temporaryDir, { route, values: Object.fromEntries(Object.keys(values).filter(key => ['webhook', 'token', 'user', 'password'].includes(key)).map(key => [key, ''])) });
			assert.deepStrictEqual(external.read(temporaryDir).routes[route], { ...values, enabled: true });
			external.update(temporaryDir, { route, enabled: false });
			assert.strictEqual(external.read(temporaryDir).routes[route].enabled, false);
		}
		external.update(temporaryDir, { events: { start: true, failure: false } });
		assert.strictEqual(external.read(temporaryDir).events.conflict, true);
		assert.strictEqual(external.read(temporaryDir).events.failure, false);
		assert.throws(() => external.update(temporaryDir, { route: 'mail', values: { encryption: 'tls' } }));
		assert.throws(() => external.update(temporaryDir, { route: 'slack', values: { webhook: 'http://localhost/secret' } }));
		const replies = [];
		vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api/script-notification.vm.js'), 'utf8'), {
			data: { status: { feature: { configurator: true } } }, define: { REPOSITORY_ROOT: temporaryDir },
			request: { method: 'GET' }, externalNotification: external,
			response: { head: code => assert.strictEqual(code, 200), end: text => replies.push(text), error: () => assert.fail('GET failed') }
		});
		for (const value of ['fixture-token', 'fixture-user', 'fixture-password', routes.slack.webhook]) assert.ok(!replies[0].includes(value));
		const staged = external.publicSettings(external.read(temporaryDir));
		staged.routes.slack.enabled = true;
		staged.routes.mail.host = 'new.example.invalid';
		staged.routes.mail.password = '';
		assert.throws(() => external.update(temporaryDir, { settings: staged }, () => { throw new Error('config write failed'); }));
		assert.strictEqual(external.read(temporaryDir).routes.mail.host, routes.mail.host);
		const batch = external.update(temporaryDir, { settings: staged });
		assert.strictEqual(batch.routes.slack.enabled, true);
		assert.strictEqual(external.read(temporaryDir).routes.mail.password, routes.mail.password);
		assert.ok(!JSON.stringify(batch).includes(routes.mail.password));
		for (const route of Object.keys(routes)) {
			external.update(temporaryDir, { route, remove: true });
			assert.strictEqual(external.publicSettings(external.read(temporaryDir)).routes[route].configured, false);
		}
		const settingsFile = path.join(temporaryDir, 'data/external-notification.json');
		fs.writeFileSync(settingsFile, '{invalid');
		assert.throws(() => external.update(temporaryDir, { events: { start: false } }));
		assert.strictEqual(fs.readFileSync(settingsFile, 'utf8'), '{invalid');
	});

	it('bounds command execution and isolates independent external transports', async function() {
		const markerPath = path.join(temporaryDir, 'timeout.log');
		const sender = createWorkerSender(markerPath, {
			timeoutMs: 100,
			killGraceMs: 30
		});
		const first = await sender({ event: 'storage-low' });
		const second = await sender({ event: 'storage-low' });

		assert.strictEqual(first.timedOut, true);
		assert.strictEqual(first.signal, 'SIGKILL');
		assert.strictEqual(second.timedOut, true);
		assert.strictEqual(second.signal, 'SIGKILL');
		assert.strictEqual(countStarts(markerPath), 2);

		prepareSettings(temporaryDir);
		const calls = [], logs = [], mailOptions = [];
		const options = { log: line => logs.push(line), fetch: async (url, init) => {
			calls.push(url);
			assert.strictEqual(init.redirect, 'error');
			assert.ok(init.signal instanceof AbortSignal);
			if (url.includes('slack')) throw new Error('fixture-password must never be logged');
			return { ok: true, json: async () => ({ status: 1 }) };
		}, mailer: { createTransport: config => {
			mailOptions.push(config);
			return { sendMail: async message => { assert.ok(message.signal instanceof AbortSignal); assert.match(message.text, /JST/); }, close() {} };
		} } };
		assert.deepStrictEqual(await external.send(temporaryDir, 'failure', { title: 'Fixture' }, '失敗', options), []);
		const testResult = await external.send(temporaryDir, 'test', null, '', { ...options, testRoute: 'pushover' });
		assert.strictEqual(testResult[0].ok, true); // Disabled route can be tested.
		calls.length = 0;
		for (const route of ['slack', 'pushover', 'mail']) external.update(temporaryDir, { route, enabled: true });
		const result = await external.send(temporaryDir, 'failure', { title: 'Fixture', channel: { name: 'Channel' } }, '録画失敗', options);
		assert.deepStrictEqual(result.map(item => item.ok), [false, true, true]);
		assert.strictEqual(mailOptions[0].requireTLS, true);
		assert.strictEqual(mailOptions[0].secure, false);
		assert.strictEqual(mailOptions[0].tls.rejectUnauthorized, true);
		assert.ok(!logs.join(' ').includes('fixture-password'));
		external.update(temporaryDir, { route: 'mail', values: { port: '465', encryption: 'tls' } });
		await external.send(temporaryDir, 'test', null, '', { ...options, testRoute: 'mail' });
		assert.strictEqual(mailOptions[1].secure, true);
		external.update(temporaryDir, { events: { failure: false } });
		assert.deepStrictEqual(await external.send(temporaryDir, 'failure', null, '', options), []);

		// Initial setup can be tested before any settings file exists; delivery stays mocked.
		const draftRoot = path.join(temporaryDir, 'draft-only');
		fs.mkdirSync(path.join(draftRoot, 'data'), { recursive: true });
		const drafts = { slack: { webhook: 'https://hooks.slack.com/services/fixture/draft/secret' },
			pushover: { token: 'draft-token', user: 'draft-user' },
			mail: { host: 'draft.example.invalid', port: '587', encryption: 'starttls', username: 'draft',
				password: 'draft-password', from: 'from@example.invalid', to: 'to@example.invalid' } };
		const transports = [];
		const mocks = { fetch: async (url, init) => {
			transports.push({ url, body: init.body }); return { ok: true, json: async () => ({ status: 1 }) };
		}, mailer: { createTransport: config => {
			transports.push(config); return { sendMail: async () => {}, close() {} };
		} } };
		for (const [name, values] of Object.entries(drafts)) {
			const result = await external.testConnection(draftRoot, name, values, mocks);
			assert.deepStrictEqual(result, [{ route: name, ok: true }]);
		}
		assert.strictEqual(transports[0].url, drafts.slack.webhook);
		assert.strictEqual(transports[1].body.get('token'), drafts.pushover.token);
		assert.strictEqual(transports[2].auth.pass, drafts.mail.password);
		assert.strictEqual(fs.existsSync(path.join(draftRoot, 'data/external-notification.json')), false);
		const settingsPath = path.join(temporaryDir, 'data/external-notification.json');
		const before = fs.readFileSync(settingsPath, 'utf8');
		await external.testConnection(temporaryDir, 'mail', { host: 'unsaved.example.invalid', password: '' }, mocks);
		assert.strictEqual(transports.at(-1).host, 'unsaved.example.invalid');
		assert.strictEqual(transports.at(-1).auth.pass, 'fixture-password');
		assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), before);
		await assert.rejects(external.testConnection(draftRoot, 'mail', { host: 'incomplete' }, mocks), error => error.statusCode === 400);
		await new Promise((resolve, reject) => {
			vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../api/script-notification.vm.js'), 'utf8'), {
				data: { status: { feature: { configurator: true } } }, define: { REPOSITORY_ROOT: draftRoot },
				request: { method: 'POST', query: { route: 'slack', values: drafts.slack } },
				externalNotification: { testConnection: (root, name, values) => {
					assert.strictEqual(root, draftRoot); assert.strictEqual(name, 'slack');
					assert.deepStrictEqual(values, drafts.slack); return external.testConnection(root, name, values, mocks);
				} }, response: { head: code => assert.strictEqual(code, 200),
					end: text => { try { assert.strictEqual(JSON.parse(text).ok, true); resolve(); } catch (error) { reject(error); } },
					error: code => reject(new Error('Unexpected HTTP ' + code)) }
			});
		});
		assert.strictEqual(fs.existsSync(path.join(draftRoot, 'data/external-notification.json')), false);
	});

	it('serializes commands and suppresses repeated external event results', async function() {
		const order = [];
		const queued = notification.createNotificationQueue(function (payload) {
			order.push('start-' + payload.id);
			return new Promise(resolve => setTimeout(function () {
				order.push('end-' + payload.id);
				resolve({ ok: true });
			}, 10));
		});
		await Promise.all([ queued({ id: 'a' }), queued({ id: 'b' }) ]);
		assert.deepStrictEqual(order, [ 'start-a', 'end-a', 'start-b', 'end-b' ]);

		const notified = { warning: 0, cleanup: 0 };
		await notification.sendStorageLowPhaseNotification(
			function () { return Promise.resolve({ ok: false }); },
			{}, 'warning', 100, notified
		);
		assert.strictEqual(notified.warning, 0);
		await notification.sendStorageLowPhaseNotification(
			function () { return Promise.resolve({ ok: true }); },
			{}, 'warning', 200, notified
		);
		assert.strictEqual(notified.warning, 200);

		prepareSettings(temporaryDir);
		external.update(temporaryDir, { route: 'pushover', enabled: true });
		const delivered = [];
		const dependencies = { fetch: async (url, init) => {
			delivered.push(init.body.get('message'));
			return { ok: true, json: async () => ({ status: 1 }) };
		} };
		const log = line => assert.fail(line);
		let notifier = external.createNotifier(temporaryDir, log, dependencies);
		const program = { id: 'fixture', start: 1000, seconds: 60, channel: { id: 'fixture-channel', type: 'GR', channel: '1', sid: 1, name: 'Fixture' }, title: 'Fixture', isConflict: true };
		notifier.conflicts([program]); notifier.conflicts([program]); await drain();
		assert.strictEqual(delivered.length, 1);
		notifier = external.createNotifier(temporaryDir, log, dependencies); // Persist across Operator restart.
		notifier.conflicts([program]); await drain();
		assert.strictEqual(delivered.length, 1);
		notifier.conflicts([]); notifier.conflicts([program]); await drain();
		assert.strictEqual(delivered.length, 2);
		const low = { filesystemKey: 'fixture-disk', phase: 'cleanup', availableBytes: 1024, destinations: ['/fixture'] };
		notifier.storage(low); notifier.storage(low); await drain();
		assert.strictEqual(delivered.length, 3);
		notifier.storage({ ...low, phase: null }); notifier.storage(low); await drain();
		assert.strictEqual(delivered.length, 4);
		const resolver = require('../lib/match-detail-resolver');
		const key = resolver.makeCanonicalKey(program);
		notifier.outcomes([{ schemaVersion: 2, key, status: 'RESERVED', start: 1000 }]); await drain();
		notifier.finish('failure', program, 'NG RECORDING');
		notifier.finish('failure', program, 'NG RECORDING'); await drain();
		notifier.outcomes([{ schemaVersion: 2, key, status: 'MISSED', start: 1000 }]); await drain();
		assert.strictEqual(delivered.length, 5);
		const analysis = { status: 'SUSPECT', completed: true, ccErrorEvents: 2, ccErrorsByPid: { 100: 2 }, elapsedMs: 100 };
		await external.notifyAnalysis(temporaryDir, program, analysis, null, { ...dependencies, log });
		assert.strictEqual(delivered.length, 6);
		assert.match(delivered.at(-1), /疑い/);
		await external.notifyAnalysis(temporaryDir, program, { ...analysis, elapsedMs: 200 }, analysis, { ...dependencies, log });
		assert.strictEqual(delivered.length, 6);
		await external.notifyAnalysis(temporaryDir, program, { status: 'NO_FINDINGS', completed: true }, analysis, { ...dependencies, log });
		assert.strictEqual(delivered.length, 6);
		await external.notifyAnalysis(temporaryDir, program, { status: 'ERROR', completed: false, error: 'fixture error' }, analysis, { ...dependencies, log });
		assert.strictEqual(delivered.length, 7);
		fs.writeFileSync(path.join(temporaryDir, 'data/external-notification-state.json'), '{invalid');
		const stateLogs = [];
		external.createNotifier(temporaryDir, line => stateLogs.push(line), dependencies).conflicts([program]); await drain();
		assert.strictEqual(delivered.length, 7);
		assert.strictEqual(stateLogs.length, 1);
		assert.strictEqual(fs.readFileSync(path.join(temporaryDir, 'data/external-notification-state.json'), 'utf8'), '{invalid');
	});

});
