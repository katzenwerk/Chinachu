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

describe('notification behavior contracts', function() {
	let temporaryDir;

	beforeEach(function() {
		temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-notification-'));
	});

	afterEach(function() {
		fs.rmSync(temporaryDir, { recursive: true, force: true });
	});

	it('resolves disabled, current, and legacy settings and invokes only the selected command', async function() {
		const cases = [
			{ config: {}, command: null, source: null, warnings: 0 },
			{ config: { storageLowSpaceNotifyTo: 'operator@example.invalid' }, command: null, source: null, warnings: 1 },
			{
				config: { storageLowSpaceCommand: '/legacy/notifier' },
				command: '/legacy/notifier', source: 'storageLowSpaceCommand', warnings: 1
			},
			{
				config: {
					notificationCommand: '/current/notifier',
					storageLowSpaceCommand: '/legacy/notifier',
					storageLowSpaceNotifyTo: 'operator@example.invalid'
				},
				command: '/current/notifier', source: 'notificationCommand', warnings: 2
			}
		];
		for (const entry of cases) {
			const resolved = notification.resolveNotificationCommand(entry.config);
			assert.strictEqual(resolved.command, entry.command);
			assert.strictEqual(resolved.source, entry.source);
			assert.strictEqual(resolved.warnings.length, entry.warnings);
		}

		const currentOutput = path.join(temporaryDir, 'current.jsonl');
		const legacyOutput = path.join(temporaryDir, 'legacy.jsonl');
		const selected = notification.resolveNotificationCommand({
			notificationCommand: ['tee', currentOutput],
			storageLowSpaceCommand: ['tee', legacyOutput]
		});
		const sent = await notification.createNotificationSender(selected.command)({ event: 'storage-low' });
		assert.strictEqual(sent.ok, true);
		assert.strictEqual(fs.existsSync(currentOutput), true);
		assert.strictEqual(fs.existsSync(legacyOutput), false);
		const skipped = await notification.createNotificationSender(null)({ event: 'storage-low' });
		assert.strictEqual(skipped.skipped, true);
		assert.strictEqual(notification.shouldSendStorageLowNotification('storageLowSpaceCommand', 1001, 1000, 10800000), true);
	});

	it('preserves notification payload data and sends user text as structured stdin, not shell syntax', async function() {
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
		assert.strictEqual(payload.title, '[Chinachu] ALERT: Storage Low Space!');
		assert.strictEqual(payload.message, 'Current Free Space is 1 MB.\nThreshold is 3000 MB.\nユーザー値: 日本語 ${touch ' + injectedMarker + '}');
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
	});

	it('suppresses concurrent sends and releases sender state after success and command failures', async function() {
		const successMarker = path.join(temporaryDir, 'success.log');
		const sender = createWorkerSender(successMarker, 'normal', { timeoutMs: 500, killGraceMs: 30 });
		const first = sender({ event: 'storage-low' });
		const duplicate = await sender({ event: 'storage-low' });
		assert.strictEqual(duplicate.skipped, true);
		assert.strictEqual(duplicate.reason, 'in-flight');
		assert.strictEqual((await first).ok, true);
		assert.strictEqual((await sender({ event: 'storage-low' })).ok, true);
		assert.strictEqual(countStarts(successMarker), 2);

		const failures = [
			{
				command: '/path/that/does/not/exist',
				check(result) { assert.strictEqual(result.ok, false); }
			},
			{
				command: [process.execPath, '-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(7));'],
				check(result) { assert.strictEqual(result.code, 7); }
			}
		];
		for (const entry of failures) {
			const failedSender = notification.createNotificationSender(entry.command);
			entry.check(await failedSender({ event: 'storage-low' }));
			entry.check(await failedSender({ event: 'storage-low' }));
		}
	});

	it('terminates a stuck child after timeout and permits a later send', async function() {
		const markerPath = path.join(temporaryDir, 'timeout.log');
		const sender = createWorkerSender(markerPath, 'ignore-term', {
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
	});

	it('keeps notification intervals independent by phase and retries skipped attempts', async function() {
		const interval = 3 * 60 * 60 * 1000;
		const now = interval + 1001;
		const notifiedAt = { warning: now - 1, cleanup: 0 };
		assert.strictEqual(
			notification.shouldSendStorageLowNotification('notificationCommand', 1000 + interval, 1000, interval),
			false
		);
		assert.strictEqual(
			notification.shouldSendStorageLowNotification('notificationCommand', now, now - interval - 1, interval),
			true
		);
		assert.strictEqual(
			notification.shouldSendStorageLowPhaseNotification('notificationCommand', 'warning', now, notifiedAt, interval),
			false
		);
		assert.strictEqual(
			notification.shouldSendStorageLowPhaseNotification('notificationCommand', 'cleanup', now, notifiedAt, interval),
			true
		);
		const result = await notification.sendStorageLowPhaseNotification(
			() => Promise.resolve({ ok: false, skipped: true, reason: 'in-flight' }),
			{ event: 'storage-low' },
			'cleanup',
			now,
			notifiedAt
		);
		assert.strictEqual(result.skipped, true);
		assert.strictEqual(notifiedAt.warning, now - 1);
		assert.strictEqual(notifiedAt.cleanup, 0);
	});
});
