'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { createSeriesService } = require('./series-service');
const { captureInputs, assertCaptureCurrent, projectionIdentity, stableJson } = require('./series-input-context');
const { createSeriesManualStore } = require('./series-manual-store');
const { buildEvents } = require('./series-projector');
const { createMatchCache } = require('./series-match-cache');

const started = performance.now();
let service;
let snapshot;
let overview;
let backfill;
const seriesById = new Map();
const attentionById = new Map();
const eventLocations = new Map();
const attentionLocations = new Map();
const listRows = new Map();

function summary(item) {
	const { episodes, description, ...rest } = item;
	return rest;
}
function pageView(input, base) {
	const filter = input.mode === 'attention' ? 'attention' : input.filter || 'all';
	if (!['all', 'recordings', 'reservations', 'attention'].includes(filter)) throw Object.assign(new Error('一覧フィルターが不正です'), { statusCode: 400 });
	const size = input.view === 'card' && filter !== 'attention' ? 25 : 50;
	const page = input.page === undefined ? 1 : Number(input.page);
	if (!Number.isSafeInteger(page) || page < 1) throw Object.assign(new Error('ページ指定が不正です'), { statusCode: 400 });
	const query = String(input.q || '').normalize('NFKC').toLowerCase();
	if (query.length > 512) throw Object.assign(new Error('検索文字列が長すぎます'), { statusCode: 400 });
	const rows = listRows.get(filter).filter(item => !query || String(item.title || '').normalize('NFKC').toLowerCase().includes(query));
	const total = rows.length;
	const selected = rows.slice((page - 1) * size, page * size);
	return { ...base, series: filter === 'attention' ? [] : selected, attention: filter === 'attention' ? selected : [],
		pagination: { filter, page, pageSize: size, total, totalPages: Math.ceil(total / size), hasMore: page * size < total } };
}
function view(input, generation) {
	const base = { manualGeneration: snapshot.manualGeneration, schemaVersion: 1, generatedAt: snapshot.generatedAt, availability: snapshot.availability,
		summary: snapshot.summary, hiddenSeries: snapshot.hiddenSeries, generation };
	if (input.mode === 'series') {
		if (seriesById.has(input.id)) return { ...base, series: [seriesById.get(input.id)], attention: [] };
		if (input.event) return view({ mode: 'event', event: input.event }, generation);
		return { ...base, series: [], attention: [] };
	}
	if (input.mode === 'attention' && !input.id) return pageView(input, base);
	if (input.mode === 'attention') return { ...base, series: [], attention: attentionById.has(input.id) ? [attentionById.get(input.id)] : [] };
	if (input.mode === 'event' || input.mode === 'events') {
		const keys = input.mode === 'event' ? [input.event] : input.eventKeys;
		if (!Array.isArray(keys) || keys.length > 10000 || keys.some(key => typeof key !== 'string' || key.length > 512)) {
			throw Object.assign(new Error('イベント指定が不正です'), { statusCode: 400 });
		}
		if (input.mode === 'event') {
			const location = eventLocations.get(keys[0]);
			if (location) return { ...base, series: [location[0].series], attention: [] };
			const group = attentionLocations.get(keys[0]);
			return group ? { ...base, series: [], attention: [group] } : { ...base, series: [], attention: [] };
		}
		const selected = new Map();
		const groups = new Map();
		for (const key of new Set(keys)) {
			for (const location of eventLocations.get(key) || []) {
				const { series, episode, event } = location;
				if (!selected.has(series.id)) selected.set(series.id, { ...summary(series), episodes: new Map() });
				const target = selected.get(series.id);
				if (!target.episodes.has(episode.key)) target.episodes.set(episode.key, { ...episode, events: [], recordings: [], reservations: [] });
				target.episodes.get(episode.key).events.push(event);
			}
			const group = attentionLocations.get(key);
			if (group) {
				if (!groups.has(group.id)) groups.set(group.id, { ...group, events: [] });
				groups.get(group.id).events.push(group.eventsByKey.get(key));
			}
		}
		return { ...base, series: Array.from(selected.values(), item => ({ ...item, episodes: Array.from(item.episodes.values()) })),
			attention: Array.from(groups.values(), ({ eventsByKey, ...group }) => group) };
	}
	if (input.mode === 'full') return { ...snapshot, generation };
	return pageView(input, base);
}

async function start() {
	const options = workerData.options;
	const captured = captureInputs(options, workerData.progLookupPath);
	captured.builtEvents = buildEvents(captured.inputs);
	const identity = projectionIdentity(captured);
	parentPort.postMessage({ captured: true, signature: captured.signature });
	const matchCache = options.matchCachePath ? createMatchCache(options, captured) : null;
	service = createSeriesService({ ...options, matchCache, inputContext: captured, progLookupStore: captured.progLookupStore,
		manualStore: createSeriesManualStore({ path: options.manualPath, initialState: captured.manualState, readOnly: true }), throwOnFailure: true });
	snapshot = service.getSnapshot();
	if (snapshot.availability.status === 'unavailable' && !service.getMetrics()) throw new Error(snapshot.availability.message);
	snapshot.manualGeneration = captured.manualState.generation;

	const projectedAt = performance.now();
	// 公開済みの配置（手動補正を含む）からだけ生成する。
	const recordingIdentities = new Map();
	for (const series of snapshot.series) {
		seriesById.set(series.id, series);
		const tid = Number(series.tid);
		for (const episode of series.episodes) for (const event of episode.events) {
			if (!eventLocations.has(event.key)) eventLocations.set(event.key, []);
			eventLocations.get(event.key).push({ series, episode, event });
			if (options.recordedFolderOrganizeEnabled !== true || !Number.isSafeInteger(tid) || tid <= 0) continue;
			for (const value of [...(captured.builtEvents.events.get(event.key)?.ids || []),
				...(captured.builtEvents.events.get(event.key)?.recordingIds || [])]) {
				const id = String(value || '');
				if (!id) continue;
				const previous = recordingIdentities.get(id);
				if (previous && previous[1] !== tid) recordingIdentities.set(id, null);
				else if (!recordingIdentities.has(id)) recordingIdentities.set(id, [id, tid, series.title || '']);
			}
		}
	}
	for (const group of snapshot.attention) {
		attentionById.set(group.id, group);
		// A private index; never serialized into a public response.
		Object.defineProperty(group, 'eventsByKey', { value: new Map(group.events.map(event => [event.key, event])) });
		for (const event of group.events) attentionLocations.set(event.key, group);
	}
	overview = { series: snapshot.series.map(summary), attention: snapshot.attention.map(group => ({
		id: group.id, kind: group.kind, label: group.label, title: group.title,
		candidateTids: group.candidateTids, candidateSeriesIds: group.candidateSeriesIds,
		progLookupLabel: group.progLookupLabel, eventCount: group.events.length,
		selectionEvents: group.events.map(event => ({
			key: event.key, title: event.title, fullTitle: event.fullTitle, start: event.start,
			channelName: event.channel?.name || ''
		})),
		firstEventKey: group.events[0]?.key || null
	})) };
	const tie = (a, b) => a.title.localeCompare(b.title, 'ja') || a.id.localeCompare(b.id);
	const visible = overview.series.filter(item => item.hidden !== true);
	const recordingOrder = (a, b) => Number(b.latestRecordingAt || 0) - Number(a.latestRecordingAt || 0) || tie(a, b);
	listRows.set('all', visible.filter(item => item.counts.recordings > 0 || item.counts.reservations > 0).sort(recordingOrder));
	listRows.set('recordings', visible.filter(item => item.counts.currentRecordings > 0).sort(recordingOrder));
	listRows.set('reservations', visible.filter(item => item.counts.reservations > 0).sort((a, b) =>
		Number(a.nextReservationAt || Number.MAX_SAFE_INTEGER) - Number(b.nextReservationAt || Number.MAX_SAFE_INTEGER) || tie(a, b)));
	listRows.set('attention', overview.attention.slice().sort(tie));
	const apiIndexMs = performance.now() - projectedAt;
	backfill = service.getBackfillRequests({ background: true });
	const cacheMetrics = matchCache ? matchCache.save() : {};
	const workerTotalMs = performance.now() - started;
	parentPort.postMessage({ ready: true, identities: Array.from(recordingIdentities.values()).filter(Boolean),
		metadata: { schemaVersion: 1, generatedAt: snapshot.generatedAt,
		availability: snapshot.availability, summary: snapshot.summary, hiddenSeries: snapshot.hiddenSeries, manualGeneration: snapshot.manualGeneration },
		backfill, metrics: { ...service.getMetrics(), ...cacheMetrics, apiIndexMs, generationMs: workerTotalMs - (cacheMetrics.cleanupMs || 0), workerTotalMs }, completedAt: Date.now() });
	const writes = new Set(['setManualOverride', 'setManualOverrides', 'removeManualOverride', 'removeWorkRule', 'setSeriesHidden']);
	let validation = null;
	let validationService = null;
	const tokens = new Map();
	function decorate(result) {
		const attach = event => {
			if (!tokens.has(event.key)) tokens.set(event.key, service.getCorrectionRevision({ eventKey: event.key }));
			event.correctionToken = tokens.get(event.key);
			const id = event.resolution?.workRule?.id;
			if (id && captured.manualState.workRules[id]) event.ruleToken = require('node:crypto').createHash('sha256').update(stableJson(captured.manualState.workRules[id])).digest('hex');
		};
		for (const item of result.series || []) for (const episode of item.episodes || []) for (const event of episode.events || []) attach(event);
		for (const group of result.attention || []) {
			group.dictionaryGeneration = captured.publication.generation;
			for (const event of group.events || []) attach(event);
		}
		return result;
	}
	function conflict(message, contextToken, currentContext) {
		return Object.assign(new Error(message), { code: 'correction-changed', statusCode: 409, contextToken, currentContext });
	}
	function getValidation() {
		if (validation) {
			try { assertCaptureCurrent(validation, options); return validationService; } catch (_) { /* recapture below */ }
		}
		const next = captureInputs(options, workerData.progLookupPath);
		next.builtEvents = buildEvents(next.inputs);
		if (validationService) validationService.close();
		validation = next;
		const writer = createSeriesManualStore({ path: options.manualPath, initialState: next.manualState,
			beforeWrite(state, name, args) {
				assertCaptureCurrent(next, options, true);
				if (name === 'setMany') {
					if (args[0].some(key => state.overrides[key])) throw Object.assign(new Error('対象に個別の手動補正が追加されました'), { code: 'manual-overrides-conflict', statusCode: 409 });
					if (stableJson([state.overrides, state.workRules]) !== stableJson([next.manualState.overrides, next.manualState.workRules])) {
						throw Object.assign(new Error('最新の要確認一覧を確認中です'), { code: 'projection-pending', statusCode: 503 });
					}
				} else if (pendingCheck) pendingCheck(state);
			} });
		validationService = createSeriesService({ ...options, inputContext: next, progLookupStore: next.progLookupStore,
			manualStore: writer, validationOnly: true, completedSnapshot: snapshot, throwOnFailure: true });
		return validationService;
	}
	let pendingCheck = null;
	function operate(command, input) {
		if (command === 'setSeriesHidden') {
			const writer = createSeriesManualStore({ path: options.manualPath });
			const result = writer.setHiddenTid(input.tid, input.hidden);
			return { ...result, manualGeneration: writer.getGeneration() };
		}
		const current = getValidation();
		if (command === 'setManualOverrides') {
			if (Array.isArray(input.eventKeys) && input.eventKeys.some(key => validation.manualState.overrides[key])) throw Object.assign(new Error('対象に個別の手動補正が追加されました'), { code: 'manual-overrides-conflict', statusCode: 409 });
			if (projectionIdentity(validation) !== identity) throw Object.assign(new Error('最新の要確認一覧を生成中です。生成完了後に再操作してください。'), { code: 'projection-pending', statusCode: 503 });
			if (input.dictionaryGeneration !== validation.publication.generation) throw conflict('作品辞書が更新されました。対象を再確認してください。');
			pendingCheck = null;
			const result = current.setManualOverrides(input);
			return { ...result, manualGeneration: current.getManualGeneration() };
		}
		if (command === 'searchTitles') return current.searchTitles(input.q, 20);
		let contextToken;
		try { contextToken = current.getCorrectionRevision({ eventKey: input.eventKey }); }
		catch (error) { if (error.statusCode === 404) throw conflict('対象イベントが変更・消滅しました'); throw error; }
		const selection = { eventKey: input.eventKey, tid: input.tid, episode: input.episode ?? null };
		const check = state => {
			const base = current.getCorrectionRevision({ eventKey: input.eventKey }, state);
			if (command === 'removeWorkRule') {
				const context = current.getCorrectionContext(input.eventKey, state);
				const rule = context.rules.find(rule => rule.id === input.id);
				if (!rule || rule.token !== input.ruleToken) throw conflict('解除対象の作品ルールが変わりました。最新情報を確認してください。', base, context);
			}
			if (command === 'setManualOverride') {
				if (!input.validationToken || input.validationToken !== current.getCorrectionRevision(selection, state)) throw conflict('補正条件が変わりました。最新情報を再確認してください。', base, current.getCorrectionContext(input.eventKey, state));
			} else if (!input.contextToken || input.contextToken !== base) throw conflict('対象情報が変わりました。最新情報を再確認してください。', base, current.getCorrectionContext(input.eventKey, state));
		};
		check(validation.manualState);
		if (command === 'previewManualSelection') {
			const result = current.previewManualSelection(input);
			return { ...result, contextToken, validationToken: current.getCorrectionRevision(selection) };
		}
		pendingCheck = check;
		try {
			const result = command === 'removeManualOverride' ? current.removeManualOverride(input.eventKey) : current[command](input);
			return { ...result, manualGeneration: current.getManualGeneration() };
		} finally { pendingCheck = null; }
	}

	// Keep commands serialized even across the asynchronous freshness check.
	let commands = Promise.resolve();
	parentPort.on('message', message => {
		commands = commands.then(async () => {
			try {
				const { id, command, input, generation } = message;
				let result;
				if (command === 'view') result = decorate(view(input, generation));
				else if (command === 'searchTitles') result = { schemaVersion: 1, results: operate(command, input) };
				else if (writes.has(command) || command === 'previewManualSelection') result = { schemaVersion: 1, result: operate(command, input) };
				else throw Object.assign(new Error('Unknown series command'), { statusCode: 400 });
				// JSON construction stays off the WUI thread. Transfer bytes without a
				// structured clone of the full projection or another JSON parse.
				const bytes = new TextEncoder().encode(JSON.stringify(result));
				parentPort.postMessage({ id, body: bytes.buffer, manualGeneration: result.result?.manualGeneration }, [bytes.buffer]);
			} catch (error) {
				parentPort.postMessage({ id: message.id, error: { message: error.message, code: error.code, contextToken: error.contextToken, currentContext: error.currentContext, statusCode: error.statusCode || 500 } });
			}
		});
	});
}
start().catch(error => parentPort.postMessage({ failure: { code: error.code, message: error.message } }));
