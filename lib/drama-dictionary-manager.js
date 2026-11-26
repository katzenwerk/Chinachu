'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { DEFAULT_PATH, settings, bangumiDue } = require('./drama-dictionary');
const { acquire } = require('./reservation-store');

function createDramaDictionaryManager({ config, database = DEFAULT_PATH, log = () => {} }) {
	let effective = settings(config);
	let snapshot = { sources: { bangumi: {}, wikipedia: {} }, counts: {}, years: [] };
	const workers = new Map();
	const lastTick = new Map();
	const progress = {};
	let timer;
	let running = false;

	function enabled(name) { return effective[name + 'Enabled']; }
	function startWorker(source) {
		if (workers.has(source)) return;
		let lease;
		let worker;
		try {
			if (source) {
				fs.mkdirSync(path.dirname(database), { recursive: true });
				lease = acquire(database + '.' + source, { timeoutMs: 0 });
			}
			worker = new Worker(path.join(__dirname, 'drama-dictionary-worker.js'), { workerData: {
				source, options: { database, startYear: effective.wikipediaStartYear, bangumiEnabled: effective.bangumiEnabled, leaseHeld: Boolean(lease) }
			} });
			workers.set(source, worker);
		} catch (error) {
			if (lease) lease.release();
			log('実写辞書: ' + error.message);
			return;
		}
		const failed = error => {
			log('実写辞書: ' + error);
			if (source && enabled(source)) progress[source] = { phase: 'failed', error };
		};
		worker.on('message', message => {
			if (message.snapshot) {
				snapshot = message.snapshot;
				delete progress[source];
			} else if (message.progress && source && enabled(source)) {
				if (message.progress.diagnostics) log('実写辞書 Wikipedia 抽出: ' + JSON.stringify(message.progress.diagnostics));
				else if (message.progress.phase !== 'idle') progress[source] = { ...progress[source], ...message.progress };
			} else if (message.error) failed(message.error);
		});
		worker.once('error', error => failed(error.message));
		worker.once('exit', code => {
			if (code !== 0) failed('worker exit ' + code);
			workers.delete(source);
			if (lease) {
				try { lease.release(); } catch (error) { log('実写辞書: ' + error.message); }
			}
		});
	}
	function tick() {
		const now = Date.now();
		for (const name of ['bangumi', 'wikipedia']) {
			if (!enabled(name) || workers.has(name)) continue;
			// The database is the authority. This guard avoids opening a worker each minute during cooldown.
			if (now - (lastTick.get(name) || 0) < 60_000) continue;
			const previous = snapshot.sources[name];
			if (previous.retryAt > now) continue;
			if (name === 'bangumi' && !bangumiDue(now, previous)) continue;
			if (name === 'wikipedia' && now - (previous.checkedAt || 0) < 10 * 60_000) continue;
			lastTick.set(name, now);
			startWorker(name);
		}
	}
	function configure(configValue) {
		const previous = effective;
		effective = settings(configValue);
		for (const name of ['bangumi', 'wikipedia']) {
			if (previous[name + 'Enabled'] !== enabled(name)) lastTick.delete(name);
			const restartWiki = name === 'wikipedia' && previous.wikipediaStartYear !== effective.wikipediaStartYear;
			if (!enabled(name) || restartWiki) {
				workers.get(name)?.postMessage('cancel');
				delete progress[name];
			}
			if (restartWiki) lastTick.delete(name);
		}
		if (running) tick();
	}
	function start() {
		if (running) return;
		running = true;
		if (fs.existsSync(database)) startWorker(null);
		tick();
		timer = setInterval(tick, 60_000);
		timer.unref();
	}
	function stop() {
		running = false;
		clearInterval(timer);
		return Promise.all([...workers.values()].map(worker => new Promise(resolve => {
			worker.once('exit', resolve);
			worker.postMessage('cancel');
		})));
	}
	function getStatus() {
		const sources = {};
		for (const name of ['bangumi', 'wikipedia']) {
			const saved = snapshot.sources[name];
			sources[name] = {
				enabled: enabled(name), phase: enabled(name) ? progress[name]?.phase || saved.phase || 'waiting' : 'disabled',
				error: progress[name]?.error || saved.error || null, publishedAt: saved.publishedAt || null,
				checkedAt: saved.checkedAt || null, works: snapshot.counts[name + 'Works'] || 0,
				episodes: snapshot.counts[name + 'Episodes'] || 0
			};
		}
		return { sources, startYear: effective.wikipediaStartYear, years: progress.wikipedia?.years || snapshot.years };
	}
	return { start, stop, configure, getStatus };
}

module.exports = { createDramaDictionaryManager };
