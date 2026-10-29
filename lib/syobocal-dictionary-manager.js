'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { Worker } = require('node:worker_threads');
const { acquire } = require('./reservation-store');
const { createOfficialXmlClient } = require('./syobocal-channel-catalog');

const UPDATE_INTERVAL_MS = 12 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 15 * 60 * 1000;

// Called by WUI and the offline PoC alike; reuses the existing projection and
// ChID paths, including their manual overrides and verified-binding guards.
async function applyDictionaryToSeries(options) {
	options.seriesService.reloadDictionary();
	const mapping = await options.channelMapManager.rebuild({ refreshCatalog: false });
	if (mapping && mapping.created && options.progLookupUpdater) options.progLookupUpdater.requestTick();
	options.seriesService.invalidate();
	const projection = options.seriesService.getSnapshot();
	if (options.notify) options.notify();
	return projection;
}

function createDictionaryManager(options) {
	if (!options || !options.path) throw new TypeError('dictionary path is required');
	const enabled = options.enabled !== false;
	const now = options.now || Date.now;
	const client = options.client || createOfficialXmlClient({ request: options.request, userAgent: options.userAgent,
		minRequestIntervalMs: options.minRequestIntervalMs });
	const interval = options.updateIntervalMs || UPDATE_INTERVAL_MS;
	let state = { enabled, usable: false, phase: enabled ? 'preparing' : 'disabled',
		published: null, completed: 0, total: null, lastError: null, nextAttemptAt: null };
	let running = null;
	let worker = null;
	let timer = null;
	let controller = null;
	let stopped = true;
	let closing = false;
	let appliedGeneration = null;
	let scheduledGeneration = null;
	let reflection = Promise.resolve();
	function notify() { if (options.onStatus) options.onStatus(getStatus()); }
	function getStatus() {
		const messages = {
			disabled: 'しょぼいカレンダー連携は無効です。',
			preparing: '作品辞書を初回準備中です。録画・予約は引き続き利用できます。',
			ready: '作品辞書は利用可能です。', updating: '作品辞書を更新中です。既存辞書を使用しています。',
			failed: state.usable ? '作品辞書の更新に失敗しました。既存辞書を使用し、後で再試行します。' :
				'作品辞書を準備できませんでした。後で自動的に再試行します。'
		};
		return Object.assign({}, state, { message: messages[state.phase] || messages.preparing });
	}
	function schedule() {
		if (stopped || !enabled) return;
		clearTimeout(timer);
		timer = setTimeout(() => { runOnce().finally(schedule); }, Math.max(0, (state.nextAttemptAt || now()) - now()));
		timer.unref();
	}
	function runOnce() {
		if (!enabled) return Promise.resolve(getStatus());
		if (running) return running;
		state = Object.assign({}, state, { phase: state.usable ? 'updating' : 'preparing', completed: 0, total: null, nextAttemptAt: null });
		notify();
		controller = new AbortController();
		let lease;
		try {
			fs.mkdirSync(path.dirname(options.path), { recursive: true });
			lease = acquire(options.path, { timeoutMs: 0 });
			worker = new Worker(path.join(__dirname, 'syobocal-dictionary-worker.js'), { workerData: {
				path: options.path, now: now(), updateIntervalMs: interval, batchSize: options.batchSize
			} });
		} catch (error) {
			if (lease) lease.release();
			if (options.log) options.log('Syobocal dictionary: ' + error.message);
			state = Object.assign({}, state, { phase: 'failed', lastError: { at: now(), message: error.message }, nextAttemptAt: now() + RETRY_INTERVAL_MS });
			notify();
			return Promise.resolve(getStatus());
		}
		// The WUI owns the lease, so even a worker crash releases it. A process
		// crash is recovered by reservation-store's existing stale-owner checks.
		let releaseError = null;
		const exited = new Promise(resolve => worker.once('exit', () => {
			try { lease.release(); } catch (error) { releaseError = error; } finally { resolve(); }
		}));
		running = new Promise(resolve => {
			let settled = false;
			const fail = error => {
				state = Object.assign({}, state, { phase: 'failed', lastError: { at: now(), code: error.code || null, message: error.message },
					nextAttemptAt: Math.max(now() + RETRY_INTERVAL_MS,
						typeof options.getNextRequestAt === 'function' ? options.getNextRequestAt() : 0) });
				if (options.log) options.log('Syobocal dictionary: ' + error.message);
			};
			const finish = async error => {
				if (settled) return;
				settled = true;
				if (error) fail(error);
				try { await reflection; } catch (reflectionError) { fail(reflectionError); }
				await exited;
				if (releaseError) fail(releaseError);
				if (state.phase !== 'failed') {
					state.phase = 'ready';
					state.lastError = null;
					state.nextAttemptAt = Math.max(now() + 1000, state.published.boundary + interval);
				}
				notify();
				resolve(getStatus());
			};
			worker.on('message', async message => {
				if (message.type === 'request') {
					const target = worker;
					try {
						if (controller.signal.aborted) throw new Error('dictionary request cancelled');
						const response = await client.fetchXml(message.parameters, controller.signal);
						if (target.threadId !== -1) target.postMessage({ id: message.id, body: response.body });
					} catch (error) {
						if (target.threadId !== -1) target.postMessage({ id: message.id, error: { message: error.message, code: error.code } });
					}
				} else if (message.type === 'status') {
					state = Object.assign({}, state, message.value);
					if (message.value.justPublished && options.log) options.log('Syobocal dictionary published: ' +
						state.published.counts.titles + ' titles, ' + state.published.counts.episodes + ' episodes');
					const generation = state.usable && state.published && state.published.generation;
					if (!closing && generation && generation !== appliedGeneration && generation !== scheduledGeneration) {
						scheduledGeneration = generation;
						reflection = reflection.catch(() => {}).then(async () => {
							if (!closing && options.onPublished) await options.onPublished(getStatus());
							appliedGeneration = generation;
						});
						// Keep an observer attached while acquisition continues.
						reflection.catch(() => { scheduledGeneration = null; });
					}
					notify();
				} else if (message.type === 'failed') finish(message.error);
				else if (message.type === 'done') finish();
			});
			worker.once('error', finish);
			worker.once('exit', code => { if (!settled) finish(new Error('dictionary worker exited: ' + code)); });
		}).finally(() => { running = null; worker = null; controller = null; });
		return running;
	}
	function start() { if (stopped && enabled) { stopped = false; closing = false; schedule(); } }
	function stop() {
		stopped = true;
		closing = true;
		clearTimeout(timer);
		if (controller) controller.abort();
		if (worker) worker.postMessage({ type: 'cancel' });
		return running || Promise.resolve();
	}
	return { start, stop, runOnce, getStatus };
}

module.exports = { createDictionaryManager, applyDictionaryToSeries };
