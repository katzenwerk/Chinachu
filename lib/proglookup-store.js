'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const RETAIN_PAST_MS = 35 * 24 * 60 * 60 * 1000;
const RETAIN_FUTURE_MS = 10 * 24 * 60 * 60 * 1000;

function emptyDocument() {
	return {
		schemaVersion: SCHEMA_VERSION,
		generation: 0,
		programs: {},
		coverage: [],
		state: {
			lastFullSuccessAt: null,
			lastDeltaSuccessAt: null,
			lastBackfillSuccessAt: null,
			nextFullAt: null,
			nextDeltaAt: null,
			nextAttemptAt: null,
			lastSuccessAt: null,
			lastError: null,
			lastUpdateCount: 0,
			targetChIds: [],
			requestLog: []
		}
	};
}

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function finiteTime(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeProgram(value) {
	if (!value || typeof value !== 'object') return null;
	const pid = Number(value.PID);
	const tid = Number(value.TID);
	const chId = Number(value.ChID);
	const deleted = isDeleted(value);
	if (!Number.isInteger(pid) || pid <= 0 || (!deleted && (!Number.isInteger(chId) || chId <= 0 ||
		!String(value.StTime || '') || !String(value.EdTime || '')))) return null;
	return {
		PID: String(pid),
		TID: Number.isInteger(tid) && tid > 0 ? String(tid) : '',
		ChID: Number.isInteger(chId) && chId > 0 ? String(chId) : '',
		StTime: String(value.StTime),
		EdTime: String(value.EdTime),
		Count: String(value.Count ?? ''),
		SubTitle: String(value.SubTitle ?? ''),
		STSubTitle: String(value.STSubTitle ?? ''),
		ProgComment: String(value.ProgComment ?? ''),
		Flag: String(value.Flag ?? ''),
		Deleted: String(value.Deleted ?? ''),
		Warn: String(value.Warn ?? ''),
		Revision: String(value.Revision ?? ''),
		LastUpdate: String(value.LastUpdate ?? '')
	};
}

function normalizeCoverage(value) {
	if (!value || typeof value !== 'object') return null;
	const startMs = finiteTime(value.startMs);
	const endMs = finiteTime(value.endMs);
	const chIds = Array.from(new Set((Array.isArray(value.chIds) ? value.chIds : [])
		.map(Number).filter(number => Number.isInteger(number) && number > 0))).sort((a, b) => a - b);
	if (startMs === null || endMs === null || endMs <= startMs || !chIds.length) return null;
	return {
		kind: ['full', 'delta', 'backfill'].includes(value.kind) ? value.kind : 'full',
		startMs,
		endMs,
		chIds,
		completedAt: finiteTime(value.completedAt) || Date.now(),
		itemCount: Math.max(0, Number(value.itemCount) || 0)
	};
}

function normalizeDocument(value) {
	if (!value || typeof value !== 'object' || Number(value.schemaVersion) !== SCHEMA_VERSION) {
		throw new Error('unsupported ProgLookup cache schema');
	}
	const result = emptyDocument();
	result.generation = Math.max(0, Number(value.generation) || 0);
	for (const item of Object.values(value.programs || {})) {
		const normalized = normalizeProgram(item);
		if (normalized) result.programs[normalized.PID] = normalized;
	}
	result.coverage = (Array.isArray(value.coverage) ? value.coverage : []).map(normalizeCoverage).filter(Boolean);
	const state = value.state && typeof value.state === 'object' ? value.state : {};
	for (const key of [
		'lastFullSuccessAt', 'lastDeltaSuccessAt', 'lastBackfillSuccessAt', 'nextFullAt',
		'nextDeltaAt', 'nextAttemptAt', 'lastSuccessAt'
	]) result.state[key] = finiteTime(state[key]);
	result.state.lastError = state.lastError && typeof state.lastError === 'object' ? clone(state.lastError) : null;
	result.state.lastUpdateCount = Math.max(0, Number(state.lastUpdateCount) || 0);
	result.state.targetChIds = Array.from(new Set((Array.isArray(state.targetChIds) ? state.targetChIds : [])
		.map(Number).filter(number => Number.isInteger(number) && number > 0))).sort((a, b) => a - b);
	result.state.requestLog = (Array.isArray(state.requestLog) ? state.requestLog : []).map(entry => ({
		at: finiteTime(entry && entry.at),
		kind: String(entry && entry.kind || '')
	})).filter(entry => entry.at !== null);
	return result;
}

function atomicWriteJson(fsImpl, filename, value) {
	const directory = path.dirname(filename);
	const temporary = filename + '.tmp-' + process.pid + '-' + Date.now();
	let descriptor = null;
	fsImpl.mkdirSync(directory, { recursive: true });
	try {
		descriptor = fsImpl.openSync(temporary, 'wx', 0o600);
		fsImpl.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n', 'utf8');
		if (typeof fsImpl.fsyncSync === 'function') fsImpl.fsyncSync(descriptor);
		fsImpl.closeSync(descriptor);
		descriptor = null;
		fsImpl.renameSync(temporary, filename);
	} catch (error) {
		if (descriptor !== null) {
			try { fsImpl.closeSync(descriptor); } catch (_) {}
		}
		try { fsImpl.unlinkSync(temporary); } catch (_) {}
		throw error;
	}
}

function parseJstTime(value) {
	const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u);
	if (!match) return null;
	const milliseconds = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]),
		Number(match[4]) - 9, Number(match[5]), Number(match[6]));
	return Number.isFinite(milliseconds) ? milliseconds : null;
}

function isDeleted(item) {
	return !['', '0', 'false'].includes(String(item && item.Deleted || '').trim().toLowerCase());
}

function compareVersion(left, right) {
	const leftRevision = Number(left && left.Revision);
	const rightRevision = Number(right && right.Revision);
	const hasLeftRevision = String(left && left.Revision || '').trim() !== '';
	const hasRightRevision = String(right && right.Revision || '').trim() !== '';
	if (hasLeftRevision && hasRightRevision && Number.isFinite(leftRevision) && Number.isFinite(rightRevision) && leftRevision !== rightRevision) {
		return leftRevision - rightRevision;
	}
	return String(left && left.LastUpdate || '').localeCompare(String(right && right.LastUpdate || ''));
}

function createProgLookupStore(options) {
	options = options || {};
	const fsImpl = options.fs || fs;
	const filename = options.path;
	if (!filename) throw new TypeError('ProgLookup cache path is required');
	let document = null;
	let loadError = null;
	let runtime = { updating: false, updateKind: null, startedAt: null };

	function load() {
		if (document) return document;
		try {
			if (!fsImpl.existsSync(filename)) {
				document = emptyDocument();
				return document;
			}
			document = normalizeDocument(JSON.parse(fsImpl.readFileSync(filename, 'utf8').replace(/^\uFEFF/u, '')));
		} catch (error) {
			loadError = error;
			document = emptyDocument();
			document.state.lastError = { at: Date.now(), code: 'cache-read-failed', message: error.message };
		}
		return document;
	}

	function persist(nextDocument) {
		const normalized = normalizeDocument(nextDocument);
		atomicWriteJson(fsImpl, filename, normalized);
		document = normalized;
		loadError = null;
		return document;
	}

	function getSnapshot() {
		const current = load();
		return {
			generation: current.generation,
			programs: Object.values(current.programs).map(clone),
			coverage: current.coverage.map(clone),
			state: clone(current.state),
			runtime: clone(runtime),
			loadError: loadError ? loadError.message : null
		};
	}

	function setRuntimeState(value) {
		runtime = Object.assign({}, runtime, value || {});
	}

	function requestCountSince(startMs, kind) {
		return load().state.requestLog.filter(entry => entry.at >= startMs && (!kind || entry.kind === kind)).length;
	}

	function recordRequest(kind, at) {
		const next = clone(load());
		next.state.requestLog.push({ at, kind });
		next.state.requestLog = next.state.requestLog.filter(entry => entry.at >= at - 48 * 60 * 60 * 1000);
		persist(next);
	}

	function recordFailure(error, nextAttemptAt) {
		const next = clone(load());
		next.state.lastError = {
			at: Date.now(),
			code: String(error && error.code || 'update-failed'),
			message: String(error && error.message || error || 'ProgLookup update failed'),
			httpStatus: Number(error && error.httpStatus) || null,
			resultCode: String(error && error.resultCode || '') || null
		};
		next.state.nextAttemptAt = finiteTime(nextAttemptAt);
		persist(next);
	}

	function prune(next, now) {
		const minimum = now - RETAIN_PAST_MS;
		const maximum = now + RETAIN_FUTURE_MS;
		for (const [pid, item] of Object.entries(next.programs)) {
			const start = parseJstTime(item.StTime);
			const end = parseJstTime(item.EdTime);
			if (start === null || end === null || end < minimum || start > maximum) delete next.programs[pid];
		}
		next.coverage = next.coverage.filter(entry => entry.endMs >= minimum && entry.startMs <= maximum)
			.sort((left, right) => left.completedAt - right.completedAt).slice(-256);
	}

	function applyUpdate(update) {
		const now = finiteTime(update.completedAt) || Date.now();
		const next = clone(load());
		const chIds = Array.from(new Set(update.chIds.map(Number))).sort((a, b) => a - b);
		const incoming = new Map();
		for (const value of update.items || []) {
			const item = normalizeProgram(value);
			if (item) incoming.set(item.PID, item);
		}
		let changed = 0;
		if (update.kind === 'full' || update.kind === 'backfill') {
			for (const [pid, item] of Object.entries(next.programs)) {
				const start = parseJstTime(item.StTime);
				const end = parseJstTime(item.EdTime);
				if (chIds.includes(Number(item.ChID)) && start !== null && end !== null &&
					update.startMs < end && start < update.endMs && !incoming.has(pid)) {
					delete next.programs[pid];
					changed++;
				}
			}
		}
		for (const [pid, item] of incoming) {
			const existing = next.programs[pid];
			if (existing && compareVersion(item, existing) < 0) continue;
			if (isDeleted(item)) {
				if (existing) {
					delete next.programs[pid];
					changed++;
				}
				continue;
			}
			if (!existing || JSON.stringify(existing) !== JSON.stringify(item)) changed++;
			next.programs[pid] = item;
		}
		next.coverage.push({
			kind: update.kind,
			startMs: update.startMs,
			endMs: update.endMs,
			chIds,
			completedAt: now,
			itemCount: incoming.size
		});
		next.generation++;
		next.state.lastSuccessAt = now;
		next.state.lastError = null;
		next.state.nextAttemptAt = null;
		next.state.lastUpdateCount = changed;
		if (update.kind !== 'backfill') {
			next.state.targetChIds = Array.from(new Set((Array.isArray(update.targetChIds) ? update.targetChIds : chIds)
				.map(Number).filter(number => Number.isInteger(number) && number > 0))).sort((a, b) => a - b);
		}
		if (update.kind === 'full') {
			next.state.lastFullSuccessAt = now;
			next.state.nextFullAt = finiteTime(update.nextFullAt);
			next.state.nextDeltaAt = finiteTime(update.nextDeltaAt);
		} else if (update.kind === 'delta') {
			next.state.lastDeltaSuccessAt = now;
			next.state.nextDeltaAt = finiteTime(update.nextDeltaAt);
		} else if (update.kind === 'backfill') {
			next.state.lastBackfillSuccessAt = now;
		}
		prune(next, now);
		persist(next);
		return { changed, generation: next.generation, programs: Object.keys(next.programs).length };
	}

	function coverageFor(program, mapping) {
		if (!mapping) return 'chid-unmapped';
		const start = Number(program && program.start);
		const end = Number(program && program.end) || start + Number(program && program.seconds || 0) * 1000;
		if (!Number.isFinite(start) || !Number.isFinite(end)) return 'time-unavailable';
		const chIds = Array.from(new Set([mapping.chId]
			.concat(Array.isArray(mapping.chIds) ? mapping.chIds : [])
			.concat(Array.isArray(mapping.candidateChIds) ? mapping.candidateChIds : [])
			.map(Number).filter(number => Number.isInteger(number) && number > 0)));
		if (!chIds.length) return 'chid-unmapped';
		const entries = load().coverage.filter(entry => entry.startMs < end && start < entry.endMs);
		if (chIds.every(chId => entries.some(entry => entry.chIds.includes(chId) &&
			(entry.kind === 'full' || entry.kind === 'backfill')))) return 'covered-complete';
		if (chIds.every(chId => entries.some(entry => entry.chIds.includes(chId) && entry.kind === 'delta'))) {
			return 'covered-delta-only';
		}
		return 'outside-cache';
	}

	function isRangeCovered(startMs, endMs, chIds) {
		return chIds.every(chId => load().coverage.some(entry =>
			(entry.kind === 'full' || entry.kind === 'backfill') && entry.startMs <= startMs &&
			entry.endMs >= endMs && entry.chIds.includes(Number(chId))));
	}

	return {
		applyUpdate,
		coverageFor,
		getSnapshot,
		isRangeCovered,
		recordFailure,
		recordRequest,
		requestCountSince,
		setRuntimeState
	};
}

module.exports = {
	SCHEMA_VERSION,
	atomicWriteJson,
	createProgLookupStore,
	isDeleted,
	normalizeProgram,
	parseJstTime
};
