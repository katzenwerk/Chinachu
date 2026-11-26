'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { acquire } = require('./reservation-store');
const { openStore } = require('./drama-store');
const { updateBangumi, scratchDirectory } = require('./drama-bangumi');

const DAY = 86400_000;
const HOUR = 3600_000;
const JST = 9 * HOUR;
const DEFAULT_PATH = path.resolve(__dirname, '../data/drama.sqlite');
const DEFAULT_START_YEAR = 2000;
const jstDate = value => new Date(value + JST).toISOString().slice(0, 10);

function settings(config = {}) {
	return {
		bangumiEnabled: config.bangumiEnabled === true,
		wikipediaEnabled: config.wikipediaEnabled === true,
		wikipediaStartYear: Number.isInteger(config.wikipediaStartYear) && config.wikipediaStartYear >= 1 &&
			config.wikipediaStartYear <= 9999 ? config.wikipediaStartYear : DEFAULT_START_YEAR
	};
}

function validateSettings(config) {
	for (const key of ['bangumiEnabled', 'wikipediaEnabled']) {
		if (Object.hasOwn(config, key) && typeof config[key] !== 'boolean') return false;
	}
	return !Object.hasOwn(config, 'wikipediaStartYear') ||
		Number.isInteger(config.wikipediaStartYear) && config.wikipediaStartYear >= 1 && config.wikipediaStartYear <= 9999;
}

function bangumiDue(now, source) {
	if (source.retryAt > now) return false;
	if (!source.revision) return true;
	const local = new Date(now + JST);
	const weekday = local.getUTCDay();
	const today = Date.parse(jstDate(now)) - JST;
	let wednesday = today - (weekday + 4) % 7 * DAY;
	if (now < wednesday + 9 * HOUR) wednesday -= 7 * DAY;
	const checked = source.checkedAt || 0;
	if (checked < wednesday + 9 * HOUR) return true;
	if (!source.release?.publishedAt || jstDate(Date.parse(source.release.publishedAt)) >= jstDate(wednesday)) return false;
	return now >= today + 9 * HOUR && checked < today;
}

function wikipediaPlan(now, startYear, progress) {
	const day = jstDate(now);
	const current = Number(day.slice(0, 4));
	const rows = new Map(progress.map(row => [row.year, row]));
	const unfinished = row => row?.hasPending ?? row?.completed < row?.total;
	const catalog = [];
	const incomplete = [];
	for (const year of [current, current + 1]) {
		if (rows.get(year)?.discoveredDay !== day) catalog.push(year);
		if (!rows.get(year)?.completedAt || unfinished(rows.get(year))) incomplete.push(year);
	}
	const past = progress.filter(row => row.year >= startYear && row.year < current);
	const dailyBackfill = progress.some(row => row.year < current &&
		(!row.completedAt && row.discoveredDay === day || row.completedAt && jstDate(row.completedAt) === day));
	let backfill = null;
	const currentRow = rows.get(current);
	if (currentRow?.completedAt && !unfinished(currentRow) && jstDate(currentRow.completedAt) !== day) {
		for (let year = current - 1; year >= startYear; year--) {
			const row = rows.get(year);
			if (row?.completedAt) continue;
			if (!dailyBackfill || row?.discoveredDay === day) backfill = year;
			break;
		}
	}
	const completedPast = past.filter(row => row.completedAt);
	const pending = completedPast.filter(unfinished)
		.sort((a, b) => (a.discoveredDay || '').localeCompare(b.discoveredDay || '') || b.year - a.year);
	const alreadyReviewed = progress.some(row => row.year < current && row.completedAt &&
		jstDate(row.completedAt) < day && row.discoveredDay === day);
	const review = !alreadyReviewed ? completedPast.filter(row => !unfinished(row) &&
		Date.parse(day) - Date.parse(row.discoveredDay || jstDate(row.completedAt)) >= 30 * DAY)
		.sort((a, b) => (a.discoveredDay || jstDate(a.completedAt)).localeCompare(b.discoveredDay || jstDate(b.completedAt)) ||
			b.year - a.year)[0]?.year ?? null : null;
	return { day, current, catalog, incomplete, backfill, review, reviewPending: pending[0]?.year ?? null };
}

async function runPython(instruction, signal, onEvent) {
	const child = spawn('python3', ['-B', path.join(__dirname, 'drama-wikipedia.py')], {
		signal, stdio: ['pipe', 'pipe', 'pipe']
	});
	let diagnostics = '';
	const exited = new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('close', code => code === 0 ? resolve() : reject(new Error(diagnostics.trim() ||
			'Wikipedia helper exited (' + code + ')')));
	});
	exited.catch(() => {});
	child.stdin.on('error', () => {});
	child.stderr.on('data', chunk => { if (diagnostics.length < 4096) diagnostics += chunk.toString(); });
	child.stdin.end(JSON.stringify(instruction));
	try {
		const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
		for await (const line of lines) {
			signal.throwIfAborted();
			onEvent(JSON.parse(line));
		}
		await exited;
	} finally {
		if (child.exitCode === null) child.kill();
		await exited.catch(() => {});
	}
}

function seedKey(seed) {
	return JSON.stringify([seed.year, seed.title, seed.season, seed.name]);
}

async function updateWikipedia(store, options) {
	const { database, signal, scratch, seedCache, now, startYear, year: onlyYear, notify, bangumiEnabled = true } = options;
	const day = jstDate(now);
	const current = Number(day.slice(0, 4));
	const cache = options.cache || scratch;
	const base = { cache, seedCache, retainedCache: options.retainedCache };
	const due = onlyYear ? [] : store.dueArticles(now);
	const metrics = { deadline_queries: Number(!onlyYear), due_articles: due.length };
	const processedSeeds = new Set();
	const processedPages = new Set();
	const errors = [];
	let retryAt = null;
	let requestAfter = options.requestAfter || 0;
	let stopBatch = false;
	let changed = 0;
	let background = false;
	let priorityFailed = false;
	let backgroundFailed = false;
	function observe(event) {
		if (event.event === 'cooldown') {
			requestAfter = Math.max(requestAfter, event.requestAfter);
		} else if (event.event === 'metrics') {
			for (const [key, value] of Object.entries(event)) if (key !== 'event') metrics[key] = (metrics[key] || 0) + value;
		} else if (event.event === 'error' || event.event === 'failed') {
			errors.push(event.year ? event.year + '年: ' + event.message : event.message);
			if (background) backgroundFailed = true;
			else priorityFailed = true;
			stopBatch ||= Boolean(event.stopBatch);
			if (event.retryAfter) {
				retryAt = Math.max(retryAt || 0, event.retryAfter);
				store.setSource('wikipedia', { serverRetryAt: retryAt });
			}
			if (event.seeds) store.setSeeds(event.seeds, 'failed');
		}
	}
	const canRequest = () => !stopBatch && !(retryAt > Date.now());
	async function discover(years) {
		if (!years.length || !canRequest()) return;
		await runPython({ ...base, requestAfter, mode: 'discoverMany', catalogs: years.map(year => ({ year, bangumi: bangumiEnabled ? store.bangumiNames(year) : [] })) },
			signal, event => {
				if (event.event === 'discovered') store.discover(event.year, day, event.entries, event.sources, bangumiEnabled);
				observe(event);
			});
	}
	async function ingest(years, dueArticles) {
		if (!canRequest()) return;
		const pending = years.flatMap(year => store.pending(year, Boolean(onlyYear && options.checkAll), bangumiEnabled));
		const due = dueArticles.filter(article => !processedPages.has(article.id));
		const candidates = new Map([...due.flatMap(article => article.seeds), ...pending]
			.filter(seed => !processedSeeds.has(seedKey(seed))).map(seed => [seedKey(seed), seed]));
		const seeds = [...candidates.values()];
		if (!seeds.length) return;
		const articleIds = [...new Set([...store.articleIds(seeds), ...due.map(article => article.id)])];
		metrics.article_hints = (metrics.article_hints || 0) + articleIds.length;
		await runPython({ ...base, requestAfter, mode: 'process', seeds, database, articleIds, bangumiEnabled }, signal, event => {
			switch (event.event) {
				case 'page':
					store.savePage(event, now);
					processedPages.add(event.source.page_id);
					for (const seed of event.seeds) processedSeeds.add(seedKey(seed));
					changed++;
					if (changed % 5 === 0) notify({ years: store.years(), ...metrics });
					break;
				case 'unchanged':
					store.markChecked(event.pageId, event.seeds, now);
					processedPages.add(event.pageId);
					for (const { seed } of event.seeds) processedSeeds.add(seedKey(seed));
					break;
				case 'missing':
				case 'unresolved':
					store.setSeeds([event.seed], event.event);
					if (event.pageId && !processedPages.has(event.pageId)) {
						store.markChecked(event.pageId, [], now);
						processedPages.add(event.pageId);
					}
					processedSeeds.add(seedKey(event.seed));
					break;
				default:
					observe(event);
			}
		});
	}
	try {
		const priority = onlyYear || current;
		if (!store.planningYears(bangumiEnabled).some(row => row.year === priority && row.discoveredDay === day)) await discover([priority]);
		const [priorityDue, otherDue] = [[], []];
		for (const article of due) (article.seeds.some(seed => seed.year === current) ? priorityDue : otherDue).push(article);
		await ingest([priority], priorityDue);
		store.closeYears(now, bangumiEnabled);
		if (!onlyYear && canRequest() && !(options.backgroundRetryAt > now)) {
			background = true;
			const progress = store.planningYears(bangumiEnabled);
			const plan = wikipediaPlan(now, startYear, progress);
			const catalogs = plan.catalog.filter(year => year !== current);
			if (plan.backfill && !progress.some(row => row.year === plan.backfill && row.discoveredDay)) catalogs.push(plan.backfill);
			if (plan.review) catalogs.push(plan.review);
			await discover(catalogs);
			await ingest([current + 1, ...[plan.backfill, plan.review, plan.reviewPending].filter(Boolean)], otherDue);
			store.closeYears(now, bangumiEnabled);
		}
	} finally {
		metrics.link_rebuilds = Number(store.refreshPendingLinks());
	}
	const diagnostics = Object.fromEntries(Object.entries(metrics).filter(([key, count]) =>
		key.startsWith('extract_') && count > 0));
	if (Object.keys(diagnostics).length) notify({ diagnostics });

	return { changed, metrics, errors, retryAt, requestAfter, priorityFailed, backgroundFailed, background };
}

function snapshot(store) {
	return { sources: { bangumi: store.source('bangumi'), wikipedia: store.source('wikipedia') },
		counts: { ...store.counts() }, years: store.years().map(row => ({ ...row })) };
}

async function runSource(name, options) {
	const { database = DEFAULT_PATH, signal = new AbortController().signal, notify = () => {}, now = Date.now() } = options;
	await fsp.mkdir(path.dirname(database), { recursive: true });
	const lease = options.leaseHeld ? null : acquire(database + '.' + name, { timeoutMs: 0 });
	let scratch;
	let store;
	let active = false;
	try {
		store = openStore(database);
		const recoveredLinks = name === 'wikipedia' && store.refreshPendingLinks();
		const previous = store.source(name);
		if (name === 'bangumi' && !options.force && !bangumiDue(now, previous)) return snapshot(store);
		if (name === 'wikipedia' && (previous.serverRetryAt || 0) > now) return snapshot(store);
		if (name === 'wikipedia' && !options.force && previous.retryAt > now) return snapshot(store);
		if (name === 'wikipedia' && !options.force && now - (previous.checkedAt || 0) < 10 * 60_000) return snapshot(store);
		active = true;
		scratch = await scratchDirectory(database);
		notify({ phase: 'updating' });
		try {
			if (name === 'bangumi') {
				const result = await updateBangumi(store, { scratch, localArchive: options.localArchive, signal, notify });
				store.setSource(name, { phase: 'ready', checkedAt: now, retryAt: null, error: null,
					result: result.changed ? 'updated' : 'unchanged' });
			} else {
				const retainedCache = options.cache ? undefined : database + '.wikipedia-cache';
				const result = await updateWikipedia(store, { ...options, database: path.resolve(database), scratch,
					retainedCache, now, signal, notify, requestAfter: previous.requestAfter, backgroundRetryAt: previous.backgroundRetryAt });
				if (recoveredLinks) result.metrics.link_rebuilds++;
				store.setSource(name, { phase: result.errors.length ? 'failed' : 'ready', checkedAt: now,
					retryAt: result.priorityFailed || result.retryAt ? Math.max(Date.now() + HOUR, result.retryAt || 0) : null,
					backgroundRetryAt: result.backgroundFailed ? Math.max(Date.now() + HOUR, result.retryAt || 0) :
						result.background ? null : previous.backgroundRetryAt ?? null,
					serverRetryAt: result.errors.length ? result.retryAt : null,
					requestAfter: result.requestAfter > Date.now() ? result.requestAfter : null,
					error: result.errors[0] || null, result: result.changed ? 'updated' : 'unchanged', metrics: result.metrics,
					publishedAt: result.changed ? Date.now() : previous.publishedAt ?? null });
			}
		} catch (error) {
			const cancelled = signal.aborted;
			store.setSource(name, { phase: cancelled ? 'paused' : 'failed', retryAt: cancelled ? null : Date.now() + HOUR,
				error: cancelled ? null : error.message });
		}
		return snapshot(store);
	} finally {
		try {
			if (store) store.close();
			if (scratch) await fsp.rm(scratch, { recursive: true, force: true });
		} finally {
			if (lease) lease.release();
			if (active) notify({ phase: 'idle' });
		}
	}
}

module.exports = { DEFAULT_PATH, settings, validateSettings, bangumiDue, wikipediaPlan, runSource, snapshot, jstDate };
