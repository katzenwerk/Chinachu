'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const storageLow = require('../lib/storage-low');
const storageHealth = require('../lib/storage-health');
const { StorageMonitor } = require('../lib/storage-monitor');
const storageManualRefresh = require('../lib/storage-manual-refresh');
const storageRefreshIpc = require('../lib/storage-refresh-ipc');
const storageRuntimeState = require('../lib/storage-runtime-state');

function linuxDev(major, minor) {
	major = BigInt(major);
	minor = BigInt(minor);
	return ((major & 0xfffn) << 8n) |
		((major & ~0xfffn) << 32n) |
		(minor & 0xffn) |
		((minor & ~0xffn) << 12n);
}

function createStorageFs(dev, resolvedPath, calls) {
	return {
		statSync: function () {
			calls.stat += 1;
			return { dev: dev, ino: 10n, isDirectory: function () { return true; } };
		},
		realpathSync: function () { return resolvedPath; },
		accessSync: function () { calls.access += 1; },
		statfsSync: function () {
			calls.statfs += 1;
			return { bsize: 4096, blocks: 1000, bfree: 500, bavail: 400 };
		}
	};
}

function createMountFixtureFs(entries, realpaths) {
	entries = entries || {};
	realpaths = realpaths || {};
	function missing(targetPath) {
		const error = new Error('ENOENT: ' + targetPath);
		error.code = 'ENOENT';
		throw error;
	}
	return {
		statSync: function (targetPath) {
			const entry = entries[path.resolve(targetPath)];
			if (!entry) return missing(targetPath);
			return {
				dev: entry.dev,
				ino: entry.ino || 10n,
				isDirectory: function () { return entry.directory !== false; }
			};
		},
		lstatSync: function (targetPath) {
			const normalized = path.resolve(targetPath);
			const entry = entries[normalized];
			if (!entry) return missing(targetPath);
			return { isSymbolicLink: function () { return entry.symlink === true; } };
		},
		realpathSync: function (targetPath) {
			const normalized = path.resolve(targetPath);
			if (!entries[normalized] && !realpaths[normalized]) return missing(targetPath);
			return realpaths[normalized] || normalized;
		},
		accessSync: function () {},
		statfsSync: function () {
			return { bsize: 4096, blocks: 1000, bfree: 500, bavail: 400 };
		}
	};
}

describe('Operator low-storage handling', function() {
	it('blocks root filesystem fallbacks and permits a verified separate filesystem', function() {
		const rootDev = linuxDev(8, 1);
		const archiveDev = linuxDev(8, 2);
		const mountInfo = {
			available: true,
			mounts: storageHealth.parseMountInfo([
				'1 0 8:1 / / rw - ext4 /dev/root rw',
				'2 1 8:2 / /mnt/archive rw - ext4 /dev/archive rw'
			].join('\n'))
		};
		const configured = storageHealth.getDestinations({
			recordedDir: '/recorded',
			recordedStorage: { protectRootFilesystem: true },
			recordedDirs: [{ id: 'archive', name: 'Archive', path: '/mnt/archive/recorded', storage: {} }]
		});
		assert.strictEqual(configured[0].rootProtectionEnabled, true);
		assert.strictEqual(configured[0].protected, true);
		assert.strictEqual(configured[1].rootProtectionEnabled, false);
		function inspect(destinationPath, entries, realpaths, enabled) {
			return storageHealth.inspectDestination({
				id: 'target', name: 'Target', path: destinationPath, configuredPath: destinationPath,
				expectedMount: null, rootProtectionEnabled: enabled !== false, aliasIds: []
			}, {
				fs: createMountFixtureFs(entries, realpaths), mountInfo: mountInfo,
				platform: 'linux', checkCapacity: false
			});
		}

		const separate = inspect('/mnt/archive/recorded', {
			'/': { dev: rootDev }, '/mnt': { dev: rootDev }, '/mnt/archive': { dev: archiveDev },
			'/mnt/archive/recorded': { dev: archiveDev }
		});
		assert.strictEqual(separate.status, 'ok');
		assert.strictEqual(separate.rootFilesystemSame, false);
		assert.strictEqual(separate.canWrite, true);

		const rootFallback = inspect('/recorded/missing', {
			'/': { dev: rootDev }, '/recorded': { dev: rootDev }
		});
		assert.strictEqual(rootFallback.status, 'system-filesystem');
		assert.strictEqual(rootFallback.rootFilesystemSame, true);
		assert.strictEqual(rootFallback.canCreate, false);

		const separateMissing = inspect('/mnt/archive/missing', {
			'/': { dev: rootDev }, '/mnt': { dev: rootDev }, '/mnt/archive': { dev: archiveDev }
		});
		assert.strictEqual(separateMissing.status, 'missing');
		assert.strictEqual(separateMissing.rootFilesystemSame, false);
		assert.strictEqual(separateMissing.canCreate, true);

		const symlinkToRoot = inspect('/recorded-link', {
			'/': { dev: rootDev }, '/recorded-link': { dev: rootDev, symlink: true },
			'/var': { dev: rootDev }, '/var/recordings': { dev: rootDev }
		}, { '/recorded-link': '/var/recordings' });
		assert.strictEqual(symlinkToRoot.status, 'system-filesystem');

		const compatibilityOff = inspect('/recorded', {
			'/': { dev: rootDev }, '/recorded': { dev: rootDev }
		}, {}, false);
		assert.strictEqual(compatibilityOff.status, 'ok');
		assert.strictEqual(compatibilityOff.canWrite, true);
	});

	it('fails closed when root filesystem identity cannot be verified', function() {
		const destination = {
			id: 'archive', name: 'Archive', path: '/mnt/archive/recorded', configuredPath: '/mnt/archive/recorded',
			expectedMount: null, rootProtectionEnabled: true, aliasIds: []
		};
		const calls = { stat: 0, access: 0, statfs: 0 };
		const health = storageHealth.inspectDestination(destination, {
			fs: createStorageFs(linuxDev(8, 2), destination.path, calls),
			mountInfo: { available: false, mounts: [], error: new Error('unavailable') },
			platform: 'linux', checkCapacity: false
		});
		assert.strictEqual(health.status, 'unknown');
		assert.strictEqual(health.canWrite, false);
		assert.match(health.detail, /root filesystem protection/);
	});

	it('forces a fresh safety check before recording output creation', function() {
		const source = fs.readFileSync(path.join(__dirname, '..', 'app-operator.js'), 'utf8');
		const doRecord = source.slice(source.indexOf('function doRecord(program, stream)'));
		const forcedCheck = doRecord.indexOf('ensureRecordingDestinationHealthy(program, false, { force: true })');
		const outputCreation = doRecord.indexOf("fs.createWriteStream(recPath, { flags: 'a' })");
		assert.ok(forcedCheck !== -1);
		assert.ok(outputCreation !== -1);
		assert.ok(forcedCheck < outputCreation);
	});

	it('keeps expectedMount active independently of root protection', function() {
		const rootDev = linuxDev(8, 1);
		const destination = {
			id: 'archive', name: 'Archive', path: '/mnt/archive/recorded', configuredPath: '/mnt/archive/recorded',
			expectedMount: '/mnt/archive', rootProtectionEnabled: false, aliasIds: []
		};
		const health = storageHealth.inspectDestination(destination, {
			fs: createMountFixtureFs({ '/': { dev: rootDev }, '/mnt': { dev: rootDev }, '/mnt/archive/recorded': { dev: rootDev } }),
			mountInfo: { available: true, mounts: storageHealth.parseMountInfo('1 0 8:1 / / rw - ext4 /dev/root rw') },
			platform: 'linux', checkCapacity: false
		});
		assert.strictEqual(health.status, 'not-mounted');
		assert.strictEqual(health.canWrite, false);
	});
	it('requires stat.dev to match the longest mountinfo entry', function() {
		const calls = { stat: 0, access: 0, statfs: 0 };
		const destination = {
			id: 'archive',
			name: 'Archive',
			path: '/mnt/archive/recorded',
			configuredPath: '/mnt/archive/recorded',
			expectedMount: null,
			aliasIds: []
		};
		const mountInfo = {
			available: true,
			mounts: storageHealth.parseMountInfo([
				'20 1 8:1 / /mnt rw - ext4 /dev/root rw',
				'21 20 8:2 / /mnt/archive rw - ext4 /dev/archive rw'
			].join('\n'))
		};
		const health = storageHealth.inspectDestination(destination, {
			fs: createStorageFs(linuxDev(8, 1), destination.path, calls),
			mountInfo: mountInfo,
			platform: 'linux'
		});

		assert.strictEqual(health.status, 'unknown');
		assert.match(health.detail, /stat\.dev/);
		assert.strictEqual(health.filesystemKey, null);
		assert.strictEqual(health.canWrite, false);
		assert.strictEqual(calls.statfs, 0);
	});

	it('groups aliases on one stat.dev runtime filesystem without treating it as a persistent disk ID', function() {
		const mountInfo = {
			available: true,
			mounts: storageHealth.parseMountInfo([
				'21 1 8:2 / /mnt/archive rw - ext4 /dev/archive rw',
				'22 1 8:2 /recorded /srv/recorded rw - ext4 /dev/archive rw'
			].join('\n'))
		};
		function inspect(id, configuredPath, resolvedPath) {
			const calls = { stat: 0, access: 0, statfs: 0 };
			return storageHealth.inspectDestination({
				id: id,
				name: id,
				path: configuredPath,
				configuredPath: configuredPath,
				expectedMount: null,
				aliasIds: []
			}, {
				fs: createStorageFs(linuxDev(8, 2), resolvedPath, calls),
				mountInfo: mountInfo,
				platform: 'linux',
				checkCapacity: false
			});
		}

		const groups = storageHealth.groupInspections([
			inspect('primary', '/mnt/archive/recorded', '/mnt/archive/recorded'),
			inspect('bind', '/srv/recorded', '/srv/recorded')
		]);

		assert.strictEqual(groups.length, 1);
		assert.strictEqual(groups[0].filesystemKey, 'linux-dev:8:2');
		assert.deepStrictEqual(groups[0].recordedDirIds, [ 'primary', 'bind' ]);
		assert.strictEqual(groups[0].mountFingerprints.length, 2);
	});

	it('uses stat.dev only as a runtime fallback when mountinfo is unavailable and no expectedMount is configured', function() {
		const calls = { stat: 0, access: 0, statfs: 0 };
		const base = {
			id: 'legacy',
			name: 'Legacy',
			path: '/recorded',
			configuredPath: '/recorded',
			expectedMount: null,
			aliasIds: []
		};
		const unavailable = { available: false, mounts: [], error: new Error('unavailable') };
		const runtimeFallback = storageHealth.inspectDestination(base, {
			fs: createStorageFs(linuxDev(253, 7), base.path, calls),
			mountInfo: unavailable,
			platform: 'linux',
			checkCapacity: false
		});
		const protectedResult = storageHealth.inspectDestination(Object.assign({}, base, {
			expectedMount: '/recorded'
		}), {
			fs: createStorageFs(linuxDev(253, 7), base.path, calls),
			mountInfo: unavailable,
			platform: 'linux',
			checkCapacity: false
		});

		assert.strictEqual(runtimeFallback.status, 'ok');
		assert.strictEqual(runtimeFallback.filesystemKey, 'linux-dev:253:7');
		assert.strictEqual(runtimeFallback.identitySource, 'stat.dev');
		assert.strictEqual(protectedResult.status, 'unknown');
		assert.strictEqual(protectedResult.canWrite, false);
	});

	it('deduplicates capacity checks per filesystem and discards state after identity change', function() {
		let now = 1000;
		let device = 'linux-dev:8:2';
		let fingerprint = 'mount-a';
		let capacityChecks = 0;
		const monitor = new StorageMonitor({
			now: function () { return now; },
			checkIntervalMs: 20000,
			inspect: function (destination, options) {
				const base = {
					id: destination.id,
					configuredPath: destination.path,
					resolvedPath: destination.path,
					status: 'ok',
					canWrite: true,
					capacityReliable: options.checkCapacity !== false,
					filesystemKey: device,
					filesystemId: device.replace('linux-dev:', ''),
					mountFingerprint: fingerprint,
					available: 400,
					total: 1000,
					used: 600,
					lowSpacePhase: null,
					capacityCheckedAt: options.now || null
				};
				if (options.checkCapacity !== false) capacityChecks += 1;
				return base;
			}
		});
		const primary = { id: 'primary', path: '/mnt/a', aliasIds: [] };
		const alias = { id: 'alias', path: '/mnt/b', aliasIds: [] };

		const first = monitor.check(primary);
		const shared = monitor.check(alias);
		assert.strictEqual(first, shared);
		assert.strictEqual(capacityChecks, 1);
		assert.deepStrictEqual(shared.recordedDirIds, [ 'primary', 'alias' ]);

		now += 20000;
		device = 'linux-dev:8:3';
		fingerprint = 'mount-b';
		const replaced = monitor.check(primary);
		assert.strictEqual(capacityChecks, 2);
		assert.strictEqual(replaced.filesystemKey, 'linux-dev:8:3');
		assert.strictEqual(monitor.get('linux-dev:8:2'), null);
	});

	it('keeps a safety error unresolved until a forced check verifies recovery', function() {
		let recovered = false;
		const destination = {
			id: 'archive', name: 'Archive', path: '/mnt/archive', configuredPath: '/mnt/archive',
			expectedMount: null, rootProtectionEnabled: true, aliasIds: []
		};
		const monitor = new StorageMonitor({
			now: function () { return 1000; },
			inspect: function (item, options) {
				if (!recovered) return {
					status: 'system-filesystem', detail: 'root', canWrite: false,
					filesystemKey: null, rootFilesystemSame: true
				};
				return {
					status: 'ok', detail: null, canWrite: true, capacityReliable: options.checkCapacity !== false,
					filesystemKey: 'linux-dev:8:2', filesystemId: '8:2', mountFingerprint: 'archive',
					resolvedPath: item.path, available: 400, total: 1000, used: 600,
					lowSpacePhase: null, capacityCheckedAt: options.now || null
				};
			}
		});
		const blocked = monitor.check(destination);
		assert.strictEqual(blocked.status, 'system-filesystem');
		assert.strictEqual(blocked.safetyBlocked, true);
		recovered = true;
		assert.strictEqual(monitor.check(destination), blocked);
		const healthy = monitor.check(destination, { force: true });
		assert.strictEqual(healthy.status, 'ok');
		assert.strictEqual(monitor.getDestinationStates()[0].safetyBlocked, false);
	});

	it('serves Storage API snapshots without filesystem or recorded-file probes', function() {
		const script = fs.readFileSync(path.join(__dirname, '..', 'api', 'script-storage.vm.js'), 'utf8');
		const checkedAt = Date.now() - 5000;
		const state = {
			schemaVersion: 3,
			action: 'stop',
			thresholds: { warningEnabled: true, warningMB: 10000, cleanupMB: 3000 },
			storages: [ {
				id: null,
				name: 'Default',
				path: '/recorded',
				configuredPath: '/recorded',
				status: 'ok',
				capacityReliable: true,
				capacityCheckedAt: checkedAt,
				total: 1000,
				used: 600,
				available: 400,
				lowSpacePhase: null
			} ]
		};
		let body = '';
		let reads = 0;
		let serializedState = JSON.stringify(state);
		const context = {
			request: { method: 'GET' },
			response: {
				head: function (status) { assert.strictEqual(status, 200); },
				end: function (value) { body = value; }
			},
			config: {
				recordedDir: '/recorded',
				storageLowSpaceAction: 'stop',
				storageLowSpaceThresholdMB: 3000,
				storageLowSpaceWarningThresholdMB: 10000
			},
			storageHealth: storageHealth,
			storageLow: storageLow,
			storageRuntimeState: storageRuntimeState,
			path: path,
			define: { STORAGE_STATE_FILE: '/runtime/storage-state.json' },
			fs: {
				readFileSync: function (file) {
					reads += 1;
					assert.strictEqual(file, '/runtime/storage-state.json');
					return serializedState;
				}
			}
		};

		vm.runInNewContext(script, context);
		const first = JSON.parse(body);
		vm.runInNewContext(script, context);
		const second = JSON.parse(body);
		assert.strictEqual(reads, 2);
		assert.strictEqual(first.storages[0].capacityCheckedAt, checkedAt);
		assert.strictEqual(second.storages[0].capacityCheckedAt, checkedAt);
		assert.strictEqual(first.recorded, null);

		state.storages[0].capacityCheckedAt = 1;
		serializedState = JSON.stringify(state);
		vm.runInNewContext(script, context);
		assert.strictEqual(JSON.parse(body).storages[0].status, 'stale');

		state.storages[0].configuredPath = '/different-recorded';
		state.storages[0].path = '/different-recorded';
		serializedState = JSON.stringify(state);
		vm.runInNewContext(script, context);
		assert.strictEqual(JSON.parse(body).storages[0].status, 'unobserved');

		state.storages[0] = {
			id: null, name: 'Default', path: '/recorded', configuredPath: '/recorded',
			rootProtectionEnabled: true, status: 'system-filesystem', safetyBlocked: true,
			identityCheckedAt: 1, capacityCheckedAt: null, stopNewRecordings: true
		};
		context.config.recordedStorage = { protectRootFilesystem: true };
		serializedState = JSON.stringify(state);
		vm.runInNewContext(script, context);
		const safety = JSON.parse(body).storages[0];
		assert.strictEqual(safety.status, 'system-filesystem');
		assert.strictEqual(safety.capacityStale, false);
		assert.strictEqual(safety.stopNewRecordings, true);

		serializedState = '{broken';
		vm.runInNewContext(script, context);
		assert.strictEqual(JSON.parse(body).storages[0].status, 'unobserved');
		assert.strictEqual(reads, 6);
	});

	it('atomically replaces Storage snapshots and preserves the old file on failure', function() {
		const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-storage-state-'));
		const target = path.join(temporaryDir, 'storage-state.json');
		try {
			fs.writeFileSync(target, JSON.stringify({ value: 'old' }));
			const failingFs = Object.create(fs);
			failingFs.renameSync = function () { throw new Error('rename failed'); };
			assert.throws(() => storageRuntimeState.atomicWriteJson(failingFs, target, { value: 'new' }), /rename failed/);
			assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { value: 'old' });
			assert.deepStrictEqual(fs.readdirSync(temporaryDir), [ 'storage-state.json' ]);

			storageRuntimeState.atomicWriteJson(fs, target, { value: 'new' });
			assert.deepStrictEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { value: 'new' });
		} finally {
			fs.rmSync(temporaryDir, { recursive: true, force: true });
		}
	});

	it('deduplicates manual capacity checks, continues after failure, and stays display-only', function() {
		const capacityOrder = [];
		const destinations = [
			{ id: 'a', name: 'A', path: '/a', aliasIds: [] },
			{ id: 'b', name: 'B', path: '/b', aliasIds: [] },
			{ id: 'c', name: 'C', path: '/c', aliasIds: [] },
			{ id: 'd', name: 'D', path: '/d', aliasIds: [] }
		];
		const result = storageManualRefresh.collect(destinations, {
			now: function () { return 1000; },
			inspect: function (destination, options) {
				if (destination.id === 'd') return {
					status: 'not-mounted', canWrite: false, filesystemKey: null, detail: 'not mounted'
				};
				const filesystemKey = destination.id === 'c' ? 'linux-dev:8:3' : 'linux-dev:8:2';
				if (options.checkCapacity !== false) capacityOrder.push(destination.id);
				return {
					status: 'ok', canWrite: true, capacityReliable: options.checkCapacity !== false,
					filesystemKey: filesystemKey, filesystemId: filesystemKey.slice(10),
					mountFingerprint: filesystemKey + ':mount', resolvedPath: destination.path,
					available: destination.id === 'c' ? 100 : 400, total: 1000, used: destination.id === 'c' ? 900 : 600,
					lowSpacePhase: destination.id === 'c' ? 'cleanup' : null,
					capacityCheckedAt: options.checkCapacity === false ? null : options.now
				};
			}
		});

		assert.deepStrictEqual(capacityOrder, [ 'a', 'c' ]);
		assert.deepStrictEqual(result.states.map(state => state.id), [ 'a', 'b', 'c' ]);
		assert.deepStrictEqual(result.failures.map(item => item.id), [ 'd' ]);
		assert.strictEqual(result.states.every(state => state.stopNewRecordings === false), true);
	});

	it('suppresses concurrent manual refresh operations', async function() {
		let release;
		let calls = 0;
		const run = storageManualRefresh.createSingleFlight(function () {
			calls += 1;
			return new Promise(resolve => { release = resolve; });
		});
		const first = run({ all: true });
		await new Promise(resolve => setImmediate(resolve));
		await assert.rejects(run({ all: true }), error => {
			assert.strictEqual(error.code, 'refresh_busy');
			assert.strictEqual(error.statusCode, 409);
			return true;
		});
		assert.strictEqual(calls, 1);
		release({ ok: true });
		await first;
	});

	it('returns an explicit unavailable error when manual refresh cannot reach Operator', async function() {
		const socketPath = path.join(os.tmpdir(), 'chinachu-missing-storage-' + process.pid + '.sock');
		await assert.rejects(storageRefreshIpc.request({ socketPath: socketPath, timeoutMs: 100 }, { all: true }), error => {
			assert.strictEqual(error.code, 'operator_unavailable');
			assert.strictEqual(error.statusCode, 503);
			return true;
		});
	});

	it('maps an unavailable Operator to a Storage refresh API error without probing storage', async function() {
		const script = fs.readFileSync(path.join(__dirname, '..', 'api', 'script-storage.vm.js'), 'utf8');
		let status = null;
		let body = null;
		const unavailable = new Error('unavailable');
		unavailable.code = 'operator_unavailable';
		unavailable.statusCode = 503;
		unavailable.publicMessage = 'Operatorが停止しているため更新できません。';
		vm.runInNewContext(script, {
			request: { method: 'POST', query: { all: true } },
			response: {
				head: function (value) { status = value; },
				end: function (value) { body = value; }
			},
			storageRefreshIpc: {
				request: function () { return Promise.reject(unavailable); }
			},
			define: { STORAGE_REFRESH_SOCKET: '/runtime/storage-refresh.sock' }
		});
		await new Promise(resolve => setImmediate(resolve));
		assert.strictEqual(status, 503);
		assert.strictEqual(JSON.parse(body).error, 'operator_unavailable');
	});

	it('enables Warning only above the effective Low threshold while preserving Low handling', function() {
		[
			{ config: {}, enabled: false, warning: null },
			{ config: { storageLowSpaceWarningThresholdMB: 0 }, enabled: false, warning: null },
			{ config: { storageLowSpaceThresholdMB: 3000, storageLowSpaceWarningThresholdMB: 3000 }, enabled: false, warning: 3000 },
			{ config: { storageLowSpaceThresholdMB: 4000, storageLowSpaceWarningThresholdMB: 3000 }, enabled: false, warning: 3000 },
			{ config: { storageLowSpaceThresholdMB: 3000, storageLowSpaceWarningThresholdMB: 50000 }, enabled: true, warning: 50000 },
			{ config: { storageLowSpaceThresholdMB: 3000, storageLowSpaceWarningThresholdMB: 50000, storageLowSpaceWarningEnabled: false }, enabled: false, warning: 50000 }
		].forEach(function (fixture) {
			const thresholds = storageLow.resolveStorageThresholds(fixture.config);
			assert.strictEqual(thresholds.warningEnabled, fixture.enabled);
			assert.strictEqual(thresholds.warningThresholdMB, fixture.warning);
			assert.strictEqual(storageLow.getPhase(2000, thresholds.cleanupThresholdMB, thresholds.warningThresholdMB, thresholds.warningEnabled), 'cleanup');
		});

		const enabled = storageLow.resolveStorageThresholds({
			storageLowSpaceThresholdMB: 3000,
			storageLowSpaceWarningThresholdMB: 50000
		});
		assert.strictEqual(storageLow.getPhase(4000, enabled.cleanupThresholdMB, enabled.warningThresholdMB, enabled.warningEnabled), 'warning');
		assert.strictEqual(storageLow.getPhase(60000, enabled.cleanupThresholdMB, enabled.warningThresholdMB, enabled.warningEnabled), null);
	});

	it('stops every initial recording on the low filesystem without touching other or unknown destinations', function() {
		const recording = [
			{ id: 'low-a', filesystemKey: 'fs-low' },
			{ id: 'low-b', filesystemKey: 'fs-low' },
			{ id: 'healthy', filesystemKey: 'fs-healthy' },
			{ id: 'unknown', filesystemKey: null }
		];
		const stopped = [];
		const unknown = [];
		storageLow.stopCurrentRecordings(recording, function (id, reason) {
			stopped.push({ id, reason });
			const index = recording.findIndex(program => program.id === id);
			if (index !== -1) recording.splice(index, 1);
		}, function (program) {
			return program.filesystemKey ? program.filesystemKey === 'fs-low' : null;
		}, function (program) {
			unknown.push(program.id);
		});

		assert.deepStrictEqual(stopped, [
			{ id: 'low-a', reason: 'LOW STORAGE' },
			{ id: 'low-b', reason: 'LOW STORAGE' }
		]);
		assert.deepStrictEqual(unknown, [ 'unknown' ]);
		assert.deepStrictEqual(recording.map(program => program.id), [ 'healthy', 'unknown' ]);
	});

	it('normalizes the three Low Storage modes and stops active recordings only for STOP-ALL or failed REMOVE', function() {
		assert.strictEqual(storageLow.normalizeAction('stop-new'), 'stop-new');
		assert.strictEqual(storageLow.normalizeAction('stop'), 'stop');
		assert.strictEqual(storageLow.normalizeAction('remove'), 'remove');
		assert.strictEqual(storageLow.normalizeAction('none'), 'stop');
		assert.strictEqual(storageLow.normalizeAction('invalid'), 'stop');
		assert.strictEqual(storageLow.shouldStopCurrentRecordings('stop-new', false), false);
		assert.strictEqual(storageLow.shouldStopCurrentRecordings('stop', false), true);
		assert.strictEqual(storageLow.shouldStopCurrentRecordings('remove', false), false);
		assert.strictEqual(storageLow.shouldStopCurrentRecordings('remove', true), true);

	});

	it('finds recursive cleanup candidates without crossing symlinks, mounts, active files, or duplicate roots', function() {
		const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-storage-cleanup-'));
		const root = path.join(temporaryDir, 'recorded');
		const nested = path.join(root, 'series');
		const otherMount = path.join(root, 'other-mount');
		const outside = path.join(temporaryDir, 'outside');
		const rootLink = path.join(temporaryDir, 'recorded-link');
		const active = path.join(nested, 'active.m2ts');
		const oldest = path.join(nested, 'oldest.m2ts');
		const newer = path.join(root, 'newer.ts');
		try {
			fs.mkdirSync(nested, { recursive: true });
			fs.mkdirSync(otherMount);
			fs.mkdirSync(outside);
			fs.writeFileSync(active, 'ACTIVE');
			fs.writeFileSync(oldest, 'OLDEST');
			fs.writeFileSync(newer, 'NEWER');
			fs.writeFileSync(path.join(nested, 'ignore.mp4'), 'IGNORE');
			fs.writeFileSync(path.join(otherMount, 'mounted.m2ts'), 'MOUNTED');
			fs.writeFileSync(path.join(outside, 'linked.m2ts'), 'LINKED');
			fs.symlinkSync(path.join(outside, 'linked.m2ts'), path.join(root, 'file-link.m2ts'));
			fs.symlinkSync(outside, path.join(root, 'dir-link'));
			fs.symlinkSync(root, rootLink, 'dir');
			fs.utimesSync(active, new Date(1000), new Date(1000));
			fs.utimesSync(oldest, new Date(2000), new Date(2000));
			fs.utimesSync(newer, new Date(3000), new Date(3000));

			const rootStats = fs.lstatSync(root, { bigint: true });
			const filesystemKey = 'linux-dev:' + storageHealth.linuxDeviceId(rootStats.dev);
			const fixtureFs = Object.create(fs);
			fixtureFs.lstatSync = function(targetPath, options) {
				const stats = fs.lstatSync(targetPath, options);
				if (path.resolve(targetPath) === otherMount || path.resolve(targetPath).startsWith(otherMount + path.sep)) {
					return new Proxy(stats, {
						get(value, key) {
							return key === 'dev' ? value.dev + 1n : Reflect.get(value, key, value);
						}
					});
				}
				return stats;
			};

			const candidates = storageLow.findCleanupCandidates({
				fs: fixtureFs,
				roots: [ root, nested ],
				filesystemKey: filesystemKey,
				protectedPaths: new Set([ active ])
			});
			assert.deepStrictEqual(candidates.map(item => item.path), [ oldest, newer ]);
			assert.deepStrictEqual(storageLow.findCleanupCandidates({
				fs: fixtureFs,
				roots: [ rootLink ],
				filesystemKey: filesystemKey
			}), []);
			assert.ok(storageLow.validateCleanupCandidate(candidates[0], {
				fs: fixtureFs,
				roots: [ root ],
				filesystemKey: filesystemKey,
				protectedPaths: new Set([ active ])
			}));

			fs.unlinkSync(oldest);
			fs.symlinkSync(path.join(outside, 'linked.m2ts'), oldest);
			assert.strictEqual(storageLow.validateCleanupCandidate(candidates[0], {
				fs: fixtureFs,
				roots: [ root ],
				filesystemKey: filesystemKey,
				protectedPaths: new Set([ active ])
			}), null);
		} finally {
			fs.rmSync(temporaryDir, { recursive: true, force: true });
		}
	});

	it('does not infer a match deletion without a recorded ledger entry', function() {
		const item = {
			status: 'RECORDED',
			program: { id: 'program-id', recorded: '/recorded/orphan.m2ts' },
			recordingResult: { id: 'recorded-id', recorded: '/recorded/orphan.m2ts' }
		};

		assert.strictEqual(
			storageLow.markMatchRecordingDeleted([ item ], [], '/recorded/orphan.m2ts', 1, 'storage-low'),
			false
		);
		assert.strictEqual(item.recordingResult.cleanupState, undefined);
	});

	it('records low-storage deletion only in the matching v2 deletion field', function() {
		const deletedAt = 1760281200000;
		const target = {
			schemaVersion: 2,
			key: 'channel-a|1760194800000|1800',
			status: 'RECORDED',
			start: 1760194800000,
			end: 1760196600000,
			fullTitle: 'Target',
			recording: { recordedId: 'recorded-a', path: '/recorded/target.m2ts' },
			deletion: null
		};
		const other = {
			schemaVersion: 2,
			key: 'channel-b|1760194800000|1800',
			status: 'RECORDED',
			start: 1760194800000,
			end: 1760196600000,
			fullTitle: 'Other',
			recording: { recordedId: 'recorded-a', path: '/recorded/other.m2ts' },
			deletion: null
		};

		assert.strictEqual(storageLow.markMatchRecordingDeleted(
			[target, other],
			[{ id: 'recorded-a', recorded: '/recorded/target.m2ts' }],
			'/recorded/target.m2ts',
			deletedAt,
			'storage-low'
		), true);
		assert.strictEqual(target.status, 'RECORDED');
		assert.deepStrictEqual(target.recording, {
			recordedId: 'recorded-a',
			path: '/recorded/target.m2ts'
		});
		assert.deepStrictEqual(target.deletion, { deletedAt, reason: 'storage-low' });
		assert.strictEqual(target.program, undefined);
		assert.strictEqual(target.recordingResult, undefined);
		assert.strictEqual(other.deletion, null);
	});

	it('does not update ambiguous deletion history targets', function() {
		const entries = [0, 1].map(index => ({
			schemaVersion: 2,
			key: `channel-${index}|1760194800000|1800`,
			status: 'RECORDED',
			start: 1760194800000,
			end: 1760196600000,
			fullTitle: `Duplicate ${index}`,
			recording: { recordedId: 'recorded-a', path: '/recorded/target.m2ts' },
			deletion: null
		}));

		assert.strictEqual(storageLow.markMatchRecordingDeleted(
			entries,
			[{ id: 'recorded-a', recorded: '/recorded/target.m2ts' }],
			'/recorded/target.m2ts',
			1760281200000,
			'storage-low'
		), false);
		assert.deepStrictEqual(entries.map(entry => entry.deletion), [null, null]);
	});
});
