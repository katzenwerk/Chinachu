'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { describe, it } = require('node:test');

async function loadMonitor() {
	const source = fs.readFileSync(path.resolve(__dirname, '../next-web/services/wui-connection-monitor.js'), 'utf8');
	return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

function ok(instanceId, startedAt = 100) {
	return { ok: true, json: async () => ({ schemaVersion: 1, instanceId, startedAt }) };
}

describe('next WUI connection monitor', function() {
	it('requires two failures, recovers, and distinguishes a changed WUI instance', async function() {
		const { createWuiConnectionMonitor } = await loadMonitor();
		let clock = 1;
		const values = [
			ok('first'), new Error('temporary'), new Error('offline'), new Error('prolonged'),
			ok('first'), ok('second', 200)
		];
		const monitor = createWuiConnectionMonitor({
			fetch: async () => { const value = values.shift(); if (value instanceof Error) throw value; return value; },
			document: { hidden: false }, setTimeout: () => 1, clearTimeout: () => {},
			now: () => clock, longOutageMs: 60000
		});
		await monitor.probe();
		assert.strictEqual(monitor.getState().status, 'online');
		assert.strictEqual(monitor.getState().transition, null);
		await monitor.probe();
		assert.strictEqual(monitor.getState().status, 'online');
		await monitor.probe();
		assert.strictEqual(monitor.getState().status, 'offline');
		assert.strictEqual(monitor.getState().prolonged, false);
		clock = 60001;
		await monitor.probe();
		assert.strictEqual(monitor.getState().prolonged, true);
		await monitor.probe();
		assert.strictEqual(monitor.getState().transition.kind, 'reconnected');
		await monitor.probe();
		assert.strictEqual(monitor.getState().transition.kind, 'started');
	});

	it('uses the shared Socket.IO connection for immediate outage and API-verified recovery', async function() {
		const { createWuiConnectionMonitor } = await loadMonitor();
		let socketListener;
		let instance = 'first';
		const monitor = createWuiConnectionMonitor({
			fetch: async () => ok(instance),
			document: { hidden: false, addEventListener() {}, removeEventListener() {} },
			setTimeout: () => 1,
			clearTimeout: () => {},
			now: (() => { let value = 0; return () => value += 100; })(),
			subscribeSocket(listener) {
				socketListener = listener;
				listener({ status: 'connecting' });
				return () => {};
			}
		});
		const unsubscribe = monitor.subscribe(() => {});
		await monitor.probe();
		assert.strictEqual(monitor.getState().status, 'online');

		monitor.suspend();
		socketListener({ status: 'disconnected', reason: 'transport close' });
		assert.strictEqual(monitor.getState().status, 'online');
		monitor.resume();
		assert.strictEqual(monitor.getState().status, 'checking');
		socketListener({ status: 'connected' });
		await new Promise(resolve => setImmediate(resolve));
		assert.strictEqual(monitor.getState().status, 'online');
		assert.strictEqual(monitor.getState().transition, null);

		socketListener({ status: 'disconnected', reason: 'transport close' });
		assert.strictEqual(monitor.getState().status, 'offline');
		assert.strictEqual(monitor.getState().transition.kind, 'disconnected');

		socketListener({ status: 'connected' });
		await new Promise(resolve => setImmediate(resolve));
		assert.strictEqual(monitor.getState().status, 'online');
		assert.strictEqual(monitor.getState().transition.kind, 'reconnected');

		socketListener({ status: 'disconnected', reason: 'transport close' });
		instance = 'second';
		socketListener({ status: 'connected' });
		await new Promise(resolve => setImmediate(resolve));
		assert.strictEqual(monitor.getState().transition.kind, 'started');
		unsubscribe();
	});

	it('shares one realtime socket between data notifications and connection monitoring', async function() {
		const source = fs.readFileSync(path.resolve(__dirname, '../next-web/services/realtime-client.js'), 'utf8');
		const handlers = new Map();
		let ioCalls = 0;
		let disconnectCalls = 0;
		const previousWindow = global.window;
		global.window = {
			location: { origin: 'http://fixture.invalid' },
			io() {
				ioCalls += 1;
				return {
					on(name, listener) { handlers.set(name, listener); },
					off(name) { handlers.delete(name); },
					disconnect() { disconnectCalls += 1; }
				};
			}
		};
		try {
			const client = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#' + Date.now());
			const connectionStates = [];
			const unsubscribeConnection = client.subscribeRealtimeConnection(state => connectionStates.push(state.status));
			const unsubscribeRecording = client.subscribeRecordingNotifications(() => {});
			assert.strictEqual(ioCalls, 1);
			handlers.get('connect')();
			handlers.get('disconnect')('transport close');
			assert.deepStrictEqual(connectionStates.slice(-2), ['connected', 'disconnected']);
			unsubscribeRecording();
			assert.strictEqual(disconnectCalls, 0);
			unsubscribeConnection();
			assert.strictEqual(disconnectCalls, 1);
		} finally {
			global.window = previousWindow;
		}
	});

	it('does not let a stale liveness response clear a Socket.IO outage', async function() {
		const { createWuiConnectionMonitor } = await loadMonitor();
		let socketListener;
		let resolveFirst;
		let fetchCount = 0;
		const monitor = createWuiConnectionMonitor({
			fetch: async () => {
				fetchCount += 1;
				if (fetchCount === 1) return new Promise(resolve => { resolveFirst = resolve; });
				return ok('fresh');
			},
			document: { hidden: false, addEventListener() {}, removeEventListener() {} },
			setTimeout: () => 1,
			clearTimeout: () => {},
			now: () => 1000,
			subscribeSocket(listener) {
				socketListener = listener;
				return () => {};
			}
		});
		const unsubscribe = monitor.subscribe(() => {});
		socketListener({ status: 'disconnected', reason: 'transport close' });
		resolveFirst(ok('stale'));
		await new Promise(resolve => setImmediate(resolve));
		assert.strictEqual(monitor.getState().status, 'offline');
		assert.strictEqual(monitor.getState().instanceId, null);

		socketListener({ status: 'connected' });
		await new Promise(resolve => setImmediate(resolve));
		assert.strictEqual(monitor.getState().status, 'online');
		assert.strictEqual(monitor.getState().instanceId, 'fresh');
		unsubscribe();
	});

	it('returns a lightweight process identity response without probing other services', function() {
		const source = fs.readFileSync(path.resolve(__dirname, '../api/script-wui-alive.vm.js'), 'utf8');
		let body = '';
		let status = null;
		vm.runInNewContext(source, {
			wuiRuntime: { instanceId: 'fixture-instance', startedAt: 123 },
			data: { status: {} },
			response: { head(value) { status = value; }, end(value) { body = value; } },
			Date: { now: () => 456 }, Math, Object, JSON
		});
		assert.strictEqual(status, 200);
		assert.deepStrictEqual(JSON.parse(body), {
			schemaVersion: 1, instanceId: 'fixture-instance', startedAt: 123, checkedAt: 456
		});

		const fallbackContext = {
			data: { status: {} }, response: { head() {}, end(value) { body = value; } },
			Date: { now: () => 789 }, Math, Object, JSON
		};
		vm.runInNewContext(source, fallbackContext);
		const firstFallback = JSON.parse(body);
		vm.runInNewContext(source, fallbackContext);
		assert.strictEqual(JSON.parse(body).instanceId, firstFallback.instanceId);
	});

});
