'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { randomUUID } = require('node:crypto');

const { sourceState } = require('./series-input-context');

function createSeriesService(options) {
	let active = null;
	let building = null;
	let checking = null;
	let checkAgain = false;
	let closed = false;
	let generation = 0;
	let matchCleanupAt = 0;
	let nextJob = 0;
	let publishedJob = 0;
	let latestManualGeneration = 0;
	let retryTimer = null;
	const instance = randomUUID();
	let lastError = null;
	let failedSignature = null;
	let retryAt = 0;
	let mutation = Promise.resolve();
	const workers = new Set();
	const log = options.log || (() => {});
	const dictionaryStatus = () => options.getDictionaryStatus && options.getDictionaryStatus();
	const progGeneration = () => options.progLookupStore.getStateSnapshot().generation;
	const signature = () => sourceState(options, progGeneration());
	const notify = () => { if (!closed && options.onStatus) options.onStatus(); };
	const conflict = () => Object.assign(new Error('シリーズ情報が更新されました。最新の表示から再操作してください'), { statusCode: 409 });

	function retire(record) {
		if (!record || record.retired) return;
		record.retired = true;
		if (!record.pending.size) record.worker.terminate();
	}
	function spawn(expected) {
		const startedAt = Date.now();
		const record = { job: ++nextJob, startedAt, worker: new Worker(path.join(__dirname, 'series-worker.js'), { workerData: {
			options: { enabled: options.enabled, recordedFolderOrganizeEnabled: options.recordedFolderOrganizeEnabled === true, dictionaryPath: options.dictionaryPath, channelMapPath: options.channelMapPath,
				manualPath: options.manualPath, matchCachePath: options.matchCachePath,
				seriesMatchCleanupIntervalDays: options.seriesMatchCleanupIntervalDays, matchCleanupAt, thumbnailDir: options.thumbnailDir, ledgerPaths: options.ledgerPaths },
			progLookupPath: options.progLookupPath, progGeneration: progGeneration(), signature: expected
		} }), signature: expected, pending: new Map(), sequence: 0, retired: false };
		workers.add(record);
		building = record;
		record.worker.on('message', async message => {
			if (closed) return;
			if (message.captured) {
				record.signature = message.signature;
			} else if (message.ready) {
				try {
					// A save must finish before swapping the worker that owns the manual store.
					const publish = mutation.then(async () => {
						if (closed || building !== record || record.job <= publishedJob) return;
						building = null;
						matchCleanupAt = Math.max(matchCleanupAt, message.metrics.matchCleanupAt || 0);
						const previous = active;
						record.generation = instance + ':' + (++generation);
						record.metadata = message.metadata;
						record.backfill = message.backfill;
						active = record;
						publishedJob = record.job;
						lastError = null;
						failedSignature = null;
						clearTimeout(retryTimer);
						retire(previous);
						log('SERIES projection ' + JSON.stringify({ ...message.metrics, generation: record.generation,
							coreTotalMs: message.metrics.totalMs, publishMs: Date.now() - message.completedAt, totalMs: Date.now() - record.startedAt }));
						if (options.onPublished) options.onPublished(record.generation, message.identities || []);
					});
					mutation = publish.catch(() => {});
					await publish;
				} catch (error) {
					if (building === record) building = null;
					retire(record);
					failedSignature = expected;
					fail(error);
				}
				notify();
				refresh(true);
			} else if (message.failure) {
				building = null;
				retire(record);
				failedSignature = expected; fail(new Error(message.failure.message));
			} else {
				const pending = record.pending.get(message.id);
				if (!pending) return;
				record.pending.delete(message.id);
				if (Number.isSafeInteger(message.manualGeneration)) latestManualGeneration = Math.max(latestManualGeneration, message.manualGeneration);
				if (message.error) pending.reject(Object.assign(new Error(message.error.message), message.error));
				else pending.resolve(Buffer.from(message.body));
				if (record.retired && !record.pending.size) record.worker.terminate();
			}
		});
		record.worker.on('error', error => {
			if (building === record) { building = null; failedSignature = expected; }
			fail(error);
		});
		record.worker.on('exit', code => {
			workers.delete(record);
			for (const pending of record.pending.values()) pending.reject(new Error('シリーズWorkerが終了しました'));
			record.pending.clear();
			if (closed || record.retired) return;
			if (building === record) { building = null; failedSignature = expected; }
			if (active === record) active = null;
			fail(new Error('シリーズWorkerが終了しました (code ' + code + ')'));
		});
		notify();
	}
	function fail(error) {
		lastError = error.message;
		retryAt = Date.now() + 30000;
		clearTimeout(retryTimer);
		if (!closed) { retryTimer = setTimeout(() => refresh(true), 30000); retryTimer.unref(); }
		log('SERIES projection failed: ' + error.message);
		notify();
	}
	function refresh(recheck = false) {
		if (closed || options.enabled === false) return Promise.resolve();
		if (checking) { checkAgain = checkAgain || recheck; return checking; }
		checking = (async () => {
			const state = dictionaryStatus();
			if (state && !state.usable) return;
			const current = await signature();
			if (!closed && !building && current !== active?.signature && (current !== failedSignature || Date.now() >= retryAt)) spawn(current);
		})().catch(fail).finally(() => {
			checking = null;
			if (checkAgain) { checkAgain = false; refresh(); }
		});
		return checking;
	}
	function status() {
		const dictionary = dictionaryStatus();
		const prog = options.progLookupStore.getStateSnapshot();
		const base = active ? active.metadata : { schemaVersion: 1, generatedAt: null, summary: null, hiddenSeries: [], availability: {} };
		const availability = { ...base.availability, dictionaryStatus: dictionary,
			technical: { ...base.availability.technical, ...prog.state, ...prog.runtime } };
		if (dictionary) {
			availability.dictionary = dictionary.usable ? 'ready' : dictionary.phase;
			if (!dictionary.usable || dictionary.phase === 'failed' || dictionary.phase === 'updating') {
				availability.status = dictionary.usable ? (dictionary.phase === 'failed' ? 'stale' : 'updating') :
					dictionary.phase === 'preparing' ? 'updating' : 'unavailable';
				availability.reason = 'dictionary-' + dictionary.phase;
				availability.message = dictionary.message;
			}
		}
		if (!active || building) {
			availability.status = 'updating';
			availability.reason = 'series-preparing';
			availability.message = active ? 'シリーズ情報を再生成しています。前回の結果を表示しています。' :
				dictionary?.message || 'シリーズ情報を準備しています。';
		}
		if (lastError) {
			availability.status = active ? 'stale' : 'unavailable';
			availability.reason = 'series-projection-failed';
			availability.message = lastError;
		}
		if (options.enabled === false) {
			availability.status = 'disabled';
			availability.reason = 'syobocal-disabled';
			availability.message = 'しょぼいカレンダーの情報利用は設定でOFFになっています。';
		}
		const manualPending = latestManualGeneration > (base.manualGeneration || 0);
		if (manualPending) availability.message = '補正を保存しました。シリーズ情報への反映を待っています。';
		return { ...base, generation: active?.generation || 0, building: !!building, manualPending, availability };
	}

	function rpc(record, command, input) {
		return new Promise((resolve, reject) => {
			const id = ++record.sequence;
			record.pending.set(id, { resolve, reject });
			record.worker.postMessage({ id, command, input, generation: record.generation });
		});
	}
	const writes = new Set(['setManualOverride', 'setManualOverrides', 'removeManualOverride', 'removeWorkRule', 'setSeriesHidden']);
	async function request(command, input = {}) {
		await refresh();
		if (command === 'status') return Buffer.from(JSON.stringify(status()));
		const record = active;
		if (!record) {
			if (command === 'view') return Buffer.from(JSON.stringify({ ...status(), series: [], attention: [] }));
			throw Object.assign(new Error('シリーズ情報を準備中です'), { statusCode: 503 });
		}
		if (writes.has(command) || command === 'previewManualSelection') {
			const operation = mutation.then(async () => {
				if (!active) throw Object.assign(new Error('シリーズ情報を準備中です'), { statusCode: 503 });
				const result = await rpc(active, command, input);
				if (writes.has(command)) { failedSignature = null; await refresh(true); notify(); }
				return result;
			});
			mutation = operation.catch(() => {});
			return operation;
		}
		if (command === 'view' && input.generation && input.generation !== record.generation) throw conflict();
		return rpc(record, command, input);
	}
	return {
		request,
		invalidate() { failedSignature = null; return refresh(true); },
		reloadDictionary() { failedSignature = null; return refresh(true); },
		getBackfillRequests() { return active?.backfill || []; },
		close() {
			closed = true;
			clearTimeout(retryTimer);
			for (const record of workers) record.worker.terminate();
		},
		getSnapshot() { return status(); }
	};
}

module.exports = { createSeriesService, sourceState };
