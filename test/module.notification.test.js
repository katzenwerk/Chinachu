'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const notification = require('../lib/notification');

const workerPath = path.join(__dirname, 'fixtures', 'notification-worker.js');

function countStarts(markerPath) {
	if (!fs.existsSync(markerPath)) {
		return 0;
	}

	return fs.readFileSync(markerPath, 'utf8').trim().split('\n').filter(Boolean).length;
}

function createWorkerSender(markerPath, mode, options) {
	return notification.createNotificationSender([
		process.execPath,
		workerPath,
		markerPath,
		mode
	], options);
}

describe('notification command resolution', function() {
	it('does not configure a command when notification settings are absent', function() {
		const result = notification.resolveNotificationCommand({});

		assert.strictEqual(result.command, null);
		assert.strictEqual(result.source, null);
		assert.strictEqual(result.warnings.length, 0);
	});

	it('prefers notificationCommand and warns about deprecated settings', function() {
		const result = notification.resolveNotificationCommand({
			notificationCommand: '/usr/local/bin/notifier',
			storageLowSpaceCommand: '/usr/local/bin/legacy-notifier',
			storageLowSpaceNotifyTo: 'operator@example.invalid'
		});

		assert.strictEqual(result.command, '/usr/local/bin/notifier');
		assert.strictEqual(result.source, 'notificationCommand');
		assert.strictEqual(result.warnings.length, 2);
	});

	it('uses storageLowSpaceCommand only as a compatibility fallback', function() {
		const result = notification.resolveNotificationCommand({
			storageLowSpaceCommand: '/usr/local/bin/legacy-notifier'
		});

		assert.strictEqual(result.command, '/usr/local/bin/legacy-notifier');
		assert.strictEqual(result.source, 'storageLowSpaceCommand');
		assert.strictEqual(result.warnings.length, 1);
	});

	it('ignores storageLowSpaceNotifyTo without configuring a command', function() {
		const result = notification.resolveNotificationCommand({
			storageLowSpaceNotifyTo: 'operator@example.invalid'
		});

		assert.strictEqual(result.command, null);
		assert.strictEqual(result.source, null);
		assert.strictEqual(result.warnings.length, 1);
	});
});

describe('external notification boundary', function() {
	let temporaryDir;

	beforeEach(function() {
		temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-notification-'));
	});

	afterEach(function() {
		fs.rmSync(temporaryDir, { recursive: true, force: true });
	});

	it('skips cleanly when no command is configured', async function() {
		const send = notification.createNotificationSender(null);

		const result = await send({ event: 'storage-low' });

		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.skipped, true);
	});

	it('passes structured UTF-8 data over stdin without shell quoting', async function() {
		const outputPath = path.join(temporaryDir, 'notification.jsonl');
		const payload = {
			event: 'storage-low',
			severity: 'critical',
			title: '空き 容量 & <危険>',
			message: '1行目\n2行目: 日本語 $HOME `command` "quoted"',
			metadata: { recordedDir: '/録画 データ/[test]' }
		};
		const send = notification.createNotificationSender([
			'tee',
			outputPath
		]);

		const result = await send(payload);

		assert.strictEqual(result.ok, true);
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), payload);
	});

	it('does not reject when the command cannot be started', async function() {
		const logs = [];
		const send = notification.createNotificationSender('/path/that/does/not/exist', {
			log: message => logs.push(message)
		});

		const result = await send({ event: 'storage-low' });

		assert.strictEqual(result.ok, false);
		assert.strictEqual(logs.some(message => message.indexOf('failed to start') !== -1), true);
	});

	it('does not reject when the command exits unsuccessfully', async function() {
		const logs = [];
		const send = notification.createNotificationSender([
			process.execPath,
			'-e',
			'process.stdin.resume(); process.stdin.on("end", () => process.exit(7));'
		], {
			log: message => logs.push(message)
		});

		const result = await send({ event: 'storage-low' });

		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.code, 7);
		assert.strictEqual(logs.some(message => message.indexOf('exit=7') !== -1), true);
	});

	it('does not start a second child while the notifier is running', async function() {
		const markerPath = path.join(temporaryDir, 'single-flight.log');
		const send = createWorkerSender(markerPath, 'hang', {
			timeoutMs: 150,
			killGraceMs: 30
		});

		const first = send({ event: 'storage-low' });
		const duplicate = await send({ event: 'storage-low' });
		const firstResult = await first;

		assert.strictEqual(duplicate.skipped, true);
		assert.strictEqual(duplicate.reason, 'in-flight');
		assert.strictEqual(firstResult.timedOut, true);
		assert.strictEqual(countStarts(markerPath), 1);
	});

	it('can run again after the notifier exits normally', async function() {
		const markerPath = path.join(temporaryDir, 'normal-retry.log');
		const send = createWorkerSender(markerPath, 'normal', {
			timeoutMs: 500,
			killGraceMs: 30
		});

		const first = await send({ event: 'storage-low' });
		const second = await send({ event: 'storage-low' });

		assert.strictEqual(first.ok, true);
		assert.strictEqual(second.ok, true);
		assert.strictEqual(countStarts(markerPath), 2);
	});

	it('recovers the child and clears single-flight state after timeout', async function() {
		const markerPath = path.join(temporaryDir, 'timeout-retry.log');
		const logs = [];
		const send = createWorkerSender(markerPath, 'hang', {
			timeoutMs: 100,
			killGraceMs: 30,
			log: message => logs.push(message)
		});

		const first = await send({ event: 'storage-low' });
		const second = await send({ event: 'storage-low' });

		assert.strictEqual(first.timedOut, true);
		assert.strictEqual(second.timedOut, true);
		assert.strictEqual(countStarts(markerPath), 2);
		assert.strictEqual(logs.filter(message => message.indexOf('timed out') !== -1).length, 2);
	});

	it('uses SIGKILL after the timeout grace period and clears single-flight state', async function() {
		const markerPath = path.join(temporaryDir, 'force-kill.log');
		const send = createWorkerSender(markerPath, 'ignore-term', {
			timeoutMs: 100,
			killGraceMs: 30
		});

		const first = await send({ event: 'storage-low' });
		const second = await send({ event: 'storage-low' });

		assert.strictEqual(first.timedOut, true);
		assert.strictEqual(first.signal, 'SIGKILL');
		assert.strictEqual(second.timedOut, true);
		assert.strictEqual(countStarts(markerPath), 2);
	});

	it('clears single-flight state after repeated spawn failures', async function() {
		const logs = [];
		const send = notification.createNotificationSender('/path/that/does/not/exist', {
			log: message => logs.push(message)
		});

		const first = await send({ event: 'storage-low' });
		const second = await send({ event: 'storage-low' });

		assert.strictEqual(first.skipped, undefined);
		assert.strictEqual(second.skipped, undefined);
		assert.strictEqual(logs.filter(message => message.indexOf('failed to start') !== -1).length, 2);
	});

	it('clears single-flight state after repeated non-zero exits', async function() {
		const markerPath = path.join(temporaryDir, 'nonzero-retry.log');
		const send = createWorkerSender(markerPath, 'nonzero', {
			timeoutMs: 500,
			killGraceMs: 30
		});

		const first = await send({ event: 'storage-low' });
		const second = await send({ event: 'storage-low' });

		assert.strictEqual(first.code, 7);
		assert.strictEqual(second.code, 7);
		assert.strictEqual(countStarts(markerPath), 2);
	});

	it('protects the legacy command with the same single-flight and timeout behavior', async function() {
		const markerPath = path.join(temporaryDir, 'legacy-timeout.log');
		const settings = notification.resolveNotificationCommand({
			storageLowSpaceCommand: [ process.execPath, workerPath, markerPath, 'hang' ]
		});
		const send = notification.createNotificationSender(settings.command, {
			timeoutMs: 100,
			killGraceMs: 30
		});

		const first = send({ event: 'storage-low' });
		const duplicate = await send({ event: 'storage-low' });
		const firstResult = await first;
		const retry = await send({ event: 'storage-low' });

		assert.strictEqual(settings.source, 'storageLowSpaceCommand');
		assert.strictEqual(duplicate.reason, 'in-flight');
		assert.strictEqual(firstResult.timedOut, true);
		assert.strictEqual(retry.timedOut, true);
		assert.strictEqual(countStarts(markerPath), 2);
	});

	it('keeps the three-hour interval separate from single-flight', function() {
		const interval = 3 * 60 * 60 * 1000;
		const lastNotifiedAt = 1000;

		assert.strictEqual(notification.shouldSendStorageLowNotification('notificationCommand', lastNotifiedAt + interval, lastNotifiedAt, interval), false);
		assert.strictEqual(notification.shouldSendStorageLowNotification('notificationCommand', lastNotifiedAt + interval + 1, lastNotifiedAt, interval), true);
		assert.strictEqual(notification.shouldSendStorageLowNotification('storageLowSpaceCommand', lastNotifiedAt + 1, lastNotifiedAt, interval), true);
	});

	it('executes only notificationCommand when both new and legacy settings exist', async function() {
		const newOutputPath = path.join(temporaryDir, 'new.jsonl');
		const legacyOutputPath = path.join(temporaryDir, 'legacy.jsonl');
		const settings = notification.resolveNotificationCommand({
			notificationCommand: [ 'tee', newOutputPath ],
			storageLowSpaceCommand: [ 'tee', legacyOutputPath ]
		});
		const send = notification.createNotificationSender(settings.command);

		const result = await send({ event: 'storage-low' });

		assert.strictEqual(result.ok, true);
		assert.strictEqual(settings.source, 'notificationCommand');
		assert.strictEqual(fs.existsSync(newOutputPath), true);
		assert.strictEqual(fs.existsSync(legacyOutputPath), false);
	});

	it('creates the storage-low event payload used by the operator', function() {
		const payload = notification.createStorageLowNotification({
			availableBytes: 1048576,
			availableMB: 1,
			thresholdMB: 3000,
			recordedDir: '/録画 data',
			action: 'none'
		});

		assert.strictEqual(payload.event, 'storage-low');
		assert.strictEqual(payload.severity, 'critical');
		assert.strictEqual(typeof payload.title, 'string');
		assert.match(payload.message, /\n/);
		assert.strictEqual(typeof payload.timestamp, 'string');
		assert.deepStrictEqual(payload.metadata, {
			availableBytes: 1048576,
			availableMB: 1,
			thresholdMB: 3000,
			recordedDir: '/録画 data',
			action: 'none'
		});
	});
});
