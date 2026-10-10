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

	it('queues notifications and advances phase suppression only after successful delivery', async function() {
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
	});

});
