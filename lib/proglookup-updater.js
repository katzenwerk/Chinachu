'use strict';

const fs = require('fs');
const https = require('https');
const syobocalChannelMap = require('./syobocal-channel-map');

const ENDPOINT = 'https://cal.syoboi.jp/db.php';
const FIELDS = [
	'PID', 'TID', 'ChID', 'StTime', 'EdTime', 'Count', 'SubTitle', 'STSubTitle',
	'ProgComment', 'Flag', 'Deleted', 'Warn', 'Revision', 'LastUpdate'
];
const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MAX_ITEMS = 5000;
const MIN_REQUEST_INTERVAL_MS = 2000;
const DAILY_REQUEST_LIMIT = 12;
const DAILY_BACKFILL_LIMIT = 2;

function xmlText(value) {
	return String(value || '')
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, '$1')
		.replace(/&#(\d+);/gu, (_, number) => String.fromCodePoint(Number(number)))
		.replace(/&#x([0-9a-f]+);/giu, (_, number) => String.fromCodePoint(parseInt(number, 16)))
		.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"')
		.replace(/&apos;/gu, "'").replace(/&amp;/gu, '&').trim();
}

function tagText(xml, name) {
	const match = String(xml).match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + name + '>', 'iu'));
	return match ? xmlText(match[1]) : '';
}

function parseProgLookupXml(xml) {
	const source = String(xml || '').replace(/^\uFEFF/u, '');
	if (!/<ProgLookupResponse(?:\s|>)/iu.test(source) || !/<\/ProgLookupResponse>\s*$/iu.test(source)) {
		throw Object.assign(new Error('ProgLookup XML root was not found'), { code: 'invalid-xml' });
	}
	const result = source.match(/<Result(?:\s[^>]*)?>([\s\S]*?)<\/Result>/iu);
	const code = result ? tagText(result[1], 'Code') : '';
	const message = tagText(source, 'Message');
	if (code !== '200' && code !== '404') {
		throw Object.assign(new Error(message || 'ProgLookup returned Result/Code=' + (code || 'unknown')), {
			code: 'api-result-error', resultCode: code || null
		});
	}
	if (code === '404') return { resultCode: code, message, items: [], complete: true };
	const items = [];
	const itemPattern = /<ProgItem(?:\s[^>]*)?>([\s\S]*?)<\/ProgItem>/giu;
	let match;
	while ((match = itemPattern.exec(source)) !== null) {
		const item = {};
		for (const field of FIELDS) item[field] = tagText(match[1], field);
		items.push(item);
	}
	return { resultCode: code, message, items, complete: items.length < MAX_ITEMS };
}

function jstParts(milliseconds) {
	const date = new Date(milliseconds + JST_OFFSET_MS);
	return {
		year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
		hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds()
	};
}

function formatApiTime(milliseconds) {
	const part = jstParts(milliseconds);
	return String(part.year).padStart(4, '0') + String(part.month).padStart(2, '0') +
		String(part.day).padStart(2, '0') + '_' + String(part.hour).padStart(2, '0') +
		String(part.minute).padStart(2, '0') + String(part.second).padStart(2, '0');
}

function jstDayStart(milliseconds) {
	const part = jstParts(milliseconds);
	return Date.UTC(part.year, part.month - 1, part.day) - JST_OFFSET_MS;
}

function updateWindow(kind, now) {
	const today = jstDayStart(now);
	return {
		startMs: today - DAY_MS,
		endMs: today + (kind === 'delta' ? 3 : 9) * DAY_MS
	};
}

function buildRequestUrl(request) {
	const value = new URL(ENDPOINT);
	value.searchParams.set('Command', 'ProgLookup');
	value.searchParams.set('Range', formatApiTime(request.startMs) + '-' + formatApiTime(request.endMs));
	value.searchParams.set('ChID', request.chIds.join(','));
	value.searchParams.set('Fields', FIELDS.join(','));
	value.searchParams.set('JOIN', 'SubTitles');
	if (request.lastUpdateMs) value.searchParams.set('LastUpdate', formatApiTime(request.lastUpdateMs) + '-');
	return value.toString();
}

function defaultRequest(url, options) {
	return new Promise((resolve, reject) => {
		const request = https.get(url, {
			headers: { 'User-Agent': options.userAgent, Accept: 'application/xml,text/xml' },
			timeout: options.timeoutMs
		}, response => {
			const chunks = [];
			let size = 0;
			response.on('data', chunk => {
				size += chunk.length;
				if (size > options.maxResponseBytes) {
					request.destroy(Object.assign(new Error('ProgLookup response was too large'), { code: 'response-too-large' }));
					return;
				}
				chunks.push(chunk);
			});
			response.on('end', () => resolve({
				statusCode: response.statusCode,
				headers: response.headers,
				body: Buffer.concat(chunks).toString('utf8')
			}));
		});
		request.on('timeout', () => request.destroy(Object.assign(new Error('ProgLookup request timed out'), { code: 'request-timeout' })));
		request.on('error', reject);
		if (options.signal) {
			if (options.signal.aborted) request.destroy(Object.assign(new Error('ProgLookup request aborted'), { code: 'request-aborted' }));
			else options.signal.addEventListener('abort', () => request.destroy(Object.assign(new Error('ProgLookup request aborted'), { code: 'request-aborted' })), { once: true });
		}
	});
}

function targetChIdsFromMap(source, availableChannels) {
	if (!source) return [];
	const available = new Set((Array.isArray(availableChannels) ? availableChannels : [])
		.map(channel => Number(channel.nid) + ':' + Number(channel.sid)));
	const verified = (Array.isArray(source.channels) ? source.channels : [])
		.filter(entry => entry.status === 'verified' &&
			available.has(Number(entry.nid) + ':' + Number(entry.sid)))
		.map(entry => Number(entry.chId));
	const candidates = (Array.isArray(source.unresolved) ? source.unresolved : [])
		.filter(entry => available.has(Number(entry.nid) + ':' + Number(entry.sid)))
		.flatMap(entry => Array.isArray(entry.acquisitionCandidateChIds) ? entry.acquisitionCandidateChIds.map(Number) : []);
	return Array.from(new Set(verified.concat(candidates).filter(value => Number.isInteger(value) && value > 0)))
		.sort((left, right) => left - right);
}

function verifiedChIds(channelMapPath, availableChannels) {
	const source = syobocalChannelMap.readIndependentChannelMap(channelMapPath);
	if (!source) return [];
	const available = new Set((Array.isArray(availableChannels) ? availableChannels : [])
		.map(channel => Number(channel.nid) + ':' + Number(channel.sid)));
	return Array.from(new Set((Array.isArray(source.channels) ? source.channels : [])
		.filter(entry => entry.status === 'verified' && available.has(Number(entry.nid) + ':' + Number(entry.sid)))
		.map(entry => Number(entry.chId)))).sort((left, right) => left - right);
}

function targetChIds(channelMapPath, availableChannels) {
	return targetChIdsFromMap(syobocalChannelMap.readIndependentChannelMap(channelMapPath), availableChannels);
}

function retryAfterMilliseconds(value, now) {
	if (!value) return null;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const time = Date.parse(value);
	return Number.isFinite(time) ? Math.max(0, time - now) : null;
}

function createProgLookupUpdater(options) {
	options = options || {};
	if (!options.store) throw new TypeError('ProgLookup store is required');
	if (!options.channelMapPath) throw new TypeError('ChID map path is required');
	const store = options.store;
	const now = options.now || Date.now;
	const random = options.random || Math.random;
	const sleep = options.sleep || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
	const request = options.request || defaultRequest;
	const log = options.log || function () {};
	const getAvailableChannels = options.getAvailableChannels || (() => []);
	const getBackfillRequests = options.getBackfillRequests || (() => []);
	const onUpdateApplied = typeof options.onUpdateApplied === 'function' ? options.onUpdateApplied : null;
	const requestLimit = Number(options.dailyRequestLimit) || DAILY_REQUEST_LIMIT;
	const minRequestInterval = Number(options.minRequestIntervalMs) || MIN_REQUEST_INTERVAL_MS;
	let timer = null;
	let stopped = true;
	let running = null;
	let activeController = null;
	let lastRequestStartedAt = 0;
	let tickRequested = false;

	function jitter(maximum) {
		return Math.floor(Math.max(0, maximum) * random());
	}

	function requestBudget(kind) {
		const current = now();
		const dayStart = jstDayStart(current);
		if (store.requestCountSince(dayStart) >= requestLimit) return false;
		if (kind === 'backfill' && store.requestCountSince(dayStart, 'backfill') >= DAILY_BACKFILL_LIMIT) return false;
		return true;
	}

	async function fetchOnce(kind, descriptor) {
		if (!requestBudget(kind)) throw Object.assign(new Error('daily ProgLookup request budget exhausted'), { code: 'request-budget-exhausted' });
		const wait = Math.max(0, lastRequestStartedAt + minRequestInterval - now());
		if (wait) await sleep(wait);
		const startedAt = now();
		lastRequestStartedAt = startedAt;
		store.recordRequest(kind, startedAt);
		const url = buildRequestUrl(descriptor);
		const response = await request(url, {
			userAgent: options.userAgent || 'Chinachu-thorn/unknown (ProgLookup)',
			timeoutMs: Number(options.timeoutMs) || 30000,
			maxResponseBytes: Number(options.maxResponseBytes) || 32 * 1024 * 1024,
			signal: activeController && activeController.signal
		});
		const statusCode = Number(response && response.statusCode);
		if (statusCode === 429) {
			const error = Object.assign(new Error('ProgLookup rate limit exceeded'), {
				code: 'http-429', httpStatus: 429,
				retryAfterMs: retryAfterMilliseconds(response.headers && response.headers['retry-after'], now())
			});
			throw error;
		}
		if (!Number.isFinite(statusCode) || statusCode < 200 || statusCode >= 300) {
			throw Object.assign(new Error('ProgLookup HTTP status ' + statusCode), { code: 'http-error', httpStatus: statusCode });
		}
		return Object.assign(parseProgLookupXml(response.body), { url });
	}

	async function fetchComplete(kind, descriptor, depth) {
		const response = await fetchOnce(kind, descriptor);
		if (response.complete) return response.items;
		if (depth >= 8) throw Object.assign(new Error('ProgLookup result remained at 5000 items after bounded splitting'), { code: 'result-incomplete' });
		if (descriptor.chIds.length > 1) {
			const middle = Math.ceil(descriptor.chIds.length / 2);
			const first = Object.assign({}, descriptor, { chIds: descriptor.chIds.slice(0, middle) });
			const second = Object.assign({}, descriptor, { chIds: descriptor.chIds.slice(middle) });
			return (await fetchComplete(kind, first, depth + 1)).concat(await fetchComplete(kind, second, depth + 1));
		}
		const duration = descriptor.endMs - descriptor.startMs;
		if (duration <= 60 * 60 * 1000) {
			throw Object.assign(new Error('ProgLookup result reached 5000 items for the minimum range'), { code: 'result-incomplete' });
		}
		const middle = descriptor.startMs + Math.floor(duration / 2);
		const first = Object.assign({}, descriptor, { endMs: middle });
		const second = Object.assign({}, descriptor, { startMs: middle });
		return (await fetchComplete(kind, first, depth + 1)).concat(await fetchComplete(kind, second, depth + 1));
	}

	function uniquePrograms(items) {
		const result = new Map();
		for (const item of items) {
			const current = result.get(String(item.PID));
			const revision = Number(item.Revision);
			const currentRevision = Number(current && current.Revision);
			if (!current || (Number.isFinite(revision) && (!Number.isFinite(currentRevision) || revision >= currentRevision)) ||
				String(item.LastUpdate || '') >= String(current.LastUpdate || '')) result.set(String(item.PID), item);
		}
		return Array.from(result.values());
	}

	async function execute(kind, descriptor) {
		const current = now();
		store.setRuntimeState({ updating: true, updateKind: kind, startedAt: current });
		try {
			const items = uniquePrograms(await fetchComplete(kind, descriptor, 0));
			const nextDeltaAt = current + 12 * 60 * 60 * 1000 + jitter(30 * 60 * 1000);
			const nextFullAt = current + 24 * 60 * 60 * 1000 + jitter(60 * 60 * 1000);
			const result = store.applyUpdate({
				kind, items, chIds: descriptor.chIds, startMs: descriptor.startMs, endMs: descriptor.endMs,
				targetChIds: descriptor.targetChIds, completedAt: now(), nextDeltaAt, nextFullAt
			});
			log('ProgLookup ' + kind + ' update completed: ' + items.length + ' items, ' + result.changed + ' changed');
			if (onUpdateApplied) {
				try {
					await onUpdateApplied({ kind, descriptor, result });
				} catch (error) {
					// The ProgLookup cache is already valid. A map rebuild failure must
					// not turn that successful fetch into a failed update.
					log('ProgLookup cache was updated, but the ChID map was not rebuilt: ' + error.message);
				}
			}
			return result;
		} catch (error) {
			const retryDelay = error.retryAfterMs === null || typeof error.retryAfterMs === 'undefined' ?
				60 * 60 * 1000 : Math.max(error.retryAfterMs, 60 * 1000);
			try { store.recordFailure(error, now() + retryDelay + jitter(10 * 60 * 1000)); } catch (saveError) {
				log('ProgLookup failure state could not be saved: ' + saveError.message);
			}
			throw error;
		} finally {
			store.setRuntimeState({ updating: false, updateKind: null, startedAt: null });
		}
	}

	function descriptorFor(kind, override) {
		if (override) return Object.assign({}, override, { chIds: Array.from(new Set(override.chIds.map(Number))).sort((a, b) => a - b) });
		const current = now();
		const range = updateWindow(kind, current);
		const snapshot = store.getSnapshot();
		const chIds = targetChIds(options.channelMapPath, getAvailableChannels());
		const latest = snapshot.state.lastDeltaSuccessAt || snapshot.state.lastFullSuccessAt;
		return Object.assign(range, {
			chIds,
			lastUpdateMs: kind === 'delta' && latest ? Math.max(1, latest - 10 * 60 * 1000) : null
		});
	}

	function runUpdate(kind, override) {
		if (running) return running;
		running = (async () => {
			activeController = new AbortController();
			const descriptor = descriptorFor(kind, override);
			if (!descriptor.chIds.length) {
				const error = Object.assign(new Error('No independently matched receivable ChID is available'), { code: 'no-target-chid' });
				store.recordFailure(error, now() + 60 * 60 * 1000);
				throw error;
			}
			return execute(kind, descriptor);
		})().finally(() => { running = null; activeController = null; });
		return running;
	}

	function nextBackfillDescriptor() {
		const requests = getBackfillRequests();
		for (const requestItem of Array.isArray(requests) ? requests : []) {
			const descriptor = descriptorFor('backfill', requestItem);
			descriptor.chIds = descriptor.chIds.filter(chId => !store.isRangeCovered(descriptor.startMs, descriptor.endMs, [chId]));
			if (descriptor.chIds.length) return descriptor;
		}
		return null;
	}

	async function tick() {
		const current = now();
		const snapshot = store.getSnapshot();
		if (snapshot.state.nextAttemptAt && snapshot.state.nextAttemptAt > current) return;
		const desired = descriptorFor('full');
		if (!desired.chIds.length) return;
		const previousTargets = new Set(snapshot.state.targetChIds || []);
		const missingChIds = desired.chIds.filter(chId => !previousTargets.has(chId));
		if (missingChIds.length) {
			await runUpdate('full', Object.assign({}, desired, {
				chIds: missingChIds,
				targetChIds: desired.chIds
			}));
			return;
		}
		if (!snapshot.state.lastFullSuccessAt || !snapshot.state.nextFullAt || snapshot.state.nextFullAt <= current) {
			await runUpdate('full');
			return;
		}
		if (!snapshot.state.nextDeltaAt || snapshot.state.nextDeltaAt <= current) {
			await runUpdate('delta');
			return;
		}
		const backfill = nextBackfillDescriptor();
		if (backfill && requestBudget('backfill')) await runUpdate('backfill', backfill);
	}

	function schedule(delay) {
		if (stopped) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(async () => {
			tickRequested = false;
			try { await tick(); } catch (error) { log('ProgLookup update failed: ' + error.message); }
			finally {
				const delayUntilNextTick = tickRequested ? 0 : 15 * 60 * 1000 + jitter(5 * 60 * 1000);
				schedule(delayUntilNextTick);
			}
		}, delay);
		if (timer && typeof timer.unref === 'function') timer.unref();
	}

	function start() {
		if (!stopped) return;
		stopped = false;
		schedule(30 * 1000 + jitter(150 * 1000));
	}

	function stop() {
		stopped = true;
		if (timer) clearTimeout(timer);
		timer = null;
		tickRequested = false;
		if (activeController) activeController.abort();
	}

	function requestTick() {
		if (stopped || tickRequested) return false;
		tickRequested = true;
		if (!running) schedule(0);
		return true;
	}

	return { requestTick, runUpdate, start, stop, tick };
}

module.exports = {
	DAILY_REQUEST_LIMIT,
	ENDPOINT,
	FIELDS,
	MAX_ITEMS,
	buildRequestUrl,
	createProgLookupUpdater,
	formatApiTime,
	jstDayStart,
	parseProgLookupXml,
	updateWindow,
	targetChIds,
	targetChIdsFromMap,
	verifiedChIds
};
