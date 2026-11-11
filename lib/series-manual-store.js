'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { withLock } = require('./reservation-store');

function emptyState() {
	return { version: 4, generation: 0, updatedAt: null, overrides: {}, workRules: {}, hiddenTids: [], localSeries: {} };
}

function normalizeHiddenTids(value) {
	if (typeof value === 'undefined') return [];
	if (!Array.isArray(value)) {
		throw new TypeError('series hidden tids are invalid');
	}
	const tids = value.slice();
	if (tids.some(tid => !Number.isInteger(tid) || tid <= 0)) {
		throw new TypeError('series hidden tids are invalid');
	}
	return Array.from(new Set(tids)).sort((left, right) => left - right);
}

function validateEventKey(value) {
	if (typeof value !== 'string' || value.trim() === '' || value.length > 512) {
		throw Object.assign(new TypeError('eventKey is invalid'), { statusCode: 400 });
	}
	if (['__proto__', 'prototype', 'constructor'].includes(value)) {
		throw Object.assign(new TypeError('eventKey is invalid'), { statusCode: 400 });
	}
	return value;
}

function isLocalId(value) { return typeof value === 'string' && /^local:[a-f0-9]{24}$/u.test(value); }
function nameKey(value) { return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase(); }
function normalizeOverride(value) {
	if (value && value.seriesId !== undefined) {
		if (!isLocalId(value.seriesId) || value.tid != null || value.episode != null) throw Object.assign(new TypeError('local series selection is invalid'), { statusCode: 400 });
		return { seriesId: value.seriesId, episode: null };
	}
	const tid = Number(value && value.tid);
	const episodeValue = value && value.episode;
	const episode = episodeValue === null || typeof episodeValue === 'undefined' || episodeValue === '' ?
		null : Number(episodeValue);
	if (!Number.isInteger(tid) || tid <= 0) {
		throw Object.assign(new TypeError('tid is invalid'), { statusCode: 400 });
	}
	if (episode !== null && (!Number.isInteger(episode) || episode <= 0 || episode > 100000)) {
		throw Object.assign(new TypeError('episode is invalid'), { statusCode: 400 });
	}
	return { tid, episode };
}

function nullableInteger(value, name) {
	if (value === null || typeof value === 'undefined' || value === '') return null;
	const number = Number(value);
	if (!Number.isInteger(number) || number < 0) {
		throw Object.assign(new TypeError(name + ' is invalid'), { statusCode: 400 });
	}
	return number;
}

function requiredText(value, name, maximum) {
	if (typeof value !== 'string' || value.trim() === '' || value.length > maximum) {
		throw Object.assign(new TypeError(name + ' is invalid'), { statusCode: 400 });
	}
	return value.trim();
}

function normalizeWorkRule(value) {
	const tid = Number(value && value.tid);
	if (!Number.isInteger(tid) || tid <= 0) {
		throw Object.assign(new TypeError('work rule tid is invalid'), { statusCode: 400 });
	}
	const service = value && value.service || {};
	const work = value && value.work || {};
	const normalized = {
		service: {
			type: requiredText(service.type, 'work rule service type', 16),
			nid: nullableInteger(service.nid, 'work rule service nid'),
			sid: nullableInteger(service.sid, 'work rule service sid'),
			tsid: nullableInteger(service.tsid, 'work rule service tsid'),
			channelId: typeof service.channelId === 'string' && service.channelId.trim() ? service.channelId.trim() : null,
			name: typeof service.name === 'string' && service.name.trim() ? service.name.trim() : null
		},
		work: {
			identity: requiredText(work.identity, 'work rule identity', 512),
			seriesKey: requiredText(work.seriesKey, 'work rule series key', 512),
			installment: typeof work.installment === 'string' ? work.installment : '',
			scopeStart: nullableInteger(work.scopeStart, 'work rule scope start'),
			scopeEnd: nullableInteger(work.scopeEnd, 'work rule scope end'),
			episodeFloor: nullableInteger(work.episodeFloor, 'work rule episode floor')
		},
		tid,
		sourceEventKey: validateEventKey(value.sourceEventKey),
		createdAt: Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : null,
		updatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : null
	};
	if (normalized.service.nid === null || normalized.service.sid === null) {
		throw Object.assign(new TypeError('work rule service identity is incomplete'), { statusCode: 400 });
	}
	if (normalized.work.scopeStart !== null && normalized.work.scopeEnd !== null &&
		normalized.work.scopeStart >= normalized.work.scopeEnd) {
		throw Object.assign(new TypeError('work rule scope is invalid'), { statusCode: 400 });
	}
	return normalized;
}

function workRuleId(value) {
	const rule = normalizeWorkRule(value);
	const identity = [rule.service.type, rule.service.nid, rule.service.sid, rule.service.tsid ?? '',
		rule.work.identity, rule.work.scopeStart ?? '', rule.work.installment].join('\u0000');
	return 'work:' + crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24);
}

function parseState(source) {
	const value = JSON.parse(source.replace(/^\uFEFF/u, ''));
	if (!value || ![1, 2, 3, 4].includes(value.version) || !value.overrides || Array.isArray(value.overrides) ||
		typeof value.overrides !== 'object') {
		throw new TypeError('series manual override file is invalid');
	}
	const state = emptyState();
	state.generation = Number.isInteger(value.generation) && value.generation >= 0 ? value.generation : 0;
	state.updatedAt = Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : null;
	if (value.version >= 4) {
		if (!value.localSeries || typeof value.localSeries !== 'object' || Array.isArray(value.localSeries)) throw new TypeError('local series definitions are invalid');
		for (const [id, item] of Object.entries(value.localSeries)) {
			if (!isLocalId(id)) throw new TypeError('local series id is invalid');
			state.localSeries[id] = { title: requiredText(item.title, 'series title', 256), createdAt: nullableInteger(item.createdAt, 'createdAt') };
		}
	}
	for (const [key, override] of Object.entries(value.overrides)) {
		state.overrides[validateEventKey(key)] = Object.assign(normalizeOverride(override), {
			updatedAt: Number.isFinite(Number(override.updatedAt)) ? Number(override.updatedAt) : null
		});
	}
	if (value.version >= 2) {
		if (!value.workRules || Array.isArray(value.workRules) || typeof value.workRules !== 'object') {
			throw new TypeError('series work rules are invalid');
		}
		for (const [id, rule] of Object.entries(value.workRules)) {
			const normalized = normalizeWorkRule(rule);
			if (id !== workRuleId(normalized)) throw new TypeError('series work rule id is invalid');
			state.workRules[id] = normalized;
		}
	}
	for (const override of Object.values(state.overrides)) if (override.seriesId && !state.localSeries[override.seriesId]) throw new TypeError('local series reference is invalid');
	if (value.version >= 3) state.hiddenTids = normalizeHiddenTids(value.hiddenTids);
	return state;
}

function createSeriesManualStore(options) {
	options = options || {};
	if (!options.path) throw new TypeError('series manual override path is required');
	const filePath = options.path;
	let state = options.initialState ? parseState(JSON.stringify(options.initialState)) : emptyState();
	let loadError = null;
	if (!options.initialState && fs.existsSync(filePath)) {
		try {
			state = parseState(fs.readFileSync(filePath, 'utf8'));
		} catch (error) {
			loadError = error;
		}
	}

	function assertLoaded() {
		if (loadError) throw Object.assign(new Error('series manual override file could not be read: ' + loadError.message), {
			code: 'manual-overrides-invalid',
			statusCode: 500
		});
	}

	function save(next) {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		const temporaryPath = filePath + '.tmp-' + process.pid + '-' + Date.now();
		const content = JSON.stringify(next, null, 2) + '\n';
		let descriptor;
		try {
			descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
			fs.writeFileSync(descriptor, content, 'utf8');
			fs.fsyncSync(descriptor);
			fs.closeSync(descriptor);
			descriptor = null;
			fs.renameSync(temporaryPath, filePath);
		} catch (error) {
			if (descriptor !== null && typeof descriptor !== 'undefined') {
				try { fs.closeSync(descriptor); } catch (_) {}
			}
			try { fs.unlinkSync(temporaryPath); } catch (_) {}
			throw error;
		}
		state = next;
	}

	function nextState(overrides, workRules, hiddenTids) {
		return {
			version: 4,
			localSeries: state.localSeries,
			generation: state.generation + 1,
			updatedAt: Date.now(),
			overrides,
			workRules,
			hiddenTids: normalizeHiddenTids(typeof hiddenTids === 'undefined' ? state.hiddenTids : hiddenTids)
		};
	}

	function checkedOverride(value) {
		const override = normalizeOverride(value);
		if (override.seriesId && !state.localSeries[override.seriesId]) throw Object.assign(new Error('オリジナル登録が存在しません'), { statusCode: 409 });
		return override;
	}
	const api = {
		getLocalSeries(id) { assertLoaded(); return state.localSeries[id] ? { id, ...state.localSeries[id] } : null; },
		listLocalSeries(query = '', recorded = []) {
			assertLoaded();
			const eventKey = require('./series-projector').eventKey;
			const needle = nameKey(String(query));
			const associations = new Map(), recordings = new Map();
			for (const row of Object.values(state.overrides)) if (row.seriesId) associations.set(row.seriesId, (associations.get(row.seriesId) || 0) + 1);
			for (const row of recorded) {
				const id = state.overrides[eventKey(row)]?.seriesId;
				if (!id || row.fileMissing) continue;
				if (!recordings.has(id)) recordings.set(id, new Set());
				recordings.get(id).add(row.id);
			}
			return Object.entries(state.localSeries).filter(([, item]) => !needle || nameKey(item.title).includes(needle)).map(([id, item]) => ({
				id, ...item, kind: 'local', tid: null,
				associationCount: associations.get(id) || 0,
				recordingCount: recordings.get(id)?.size || 0
			})).sort((a, b) => a.title.localeCompare(b.title, 'ja') || a.id.localeCompare(b.id));
		},
		createLocalSeries(title) {
			assertLoaded(); title = requiredText(title, 'series title', 256);
			if (/[\u0000-\u001f\u007f]/u.test(title)) throw Object.assign(new Error('作品名に制御文字は使えません'), { statusCode: 400 });
			const duplicate = Object.entries(state.localSeries).find(([, item]) => nameKey(item.title) === nameKey(title));
			if (duplicate) return { id: duplicate[0], ...duplicate[1], existing: true };
			const id = 'local:' + crypto.randomBytes(12).toString('hex');
			const item = { title, createdAt: Date.now() };
			const next = nextState(state.overrides, state.workRules);
			next.localSeries = { ...state.localSeries, [id]: item }; save(next);
			return { id, ...item, existing: false };
		},
		removeLocalSeries(ids, generation) {
			assertLoaded();
			if (!Array.isArray(ids) || !ids.length || ids.some(id => !isLocalId(id))) throw Object.assign(new Error('削除対象が不正です'), { statusCode: 400 });
			if (generation !== state.generation) throw Object.assign(new Error('登録や関連付けが更新されました。一覧を読み直して確認してください。'), { statusCode: 409 });
			if (ids.some(id => !Object.hasOwn(state.localSeries, id))) throw Object.assign(new Error('削除対象の登録が更新されました。一覧を読み直してください。'), { statusCode: 409 });
			const removed = new Set(ids);
			const next = nextState(Object.fromEntries(Object.entries(state.overrides).filter(([, row]) => !removed.has(row.seriesId))), state.workRules);
			next.localSeries = Object.fromEntries(Object.entries(state.localSeries).filter(([id]) => !removed.has(id)));
			save(next); return { ids: [...removed], removed: removed.size };
		},
		pruneHiddenTids(activeTids) {
			assertLoaded(); const active = new Set(activeTids);
			const kept = state.hiddenTids.filter(tid => active.has(tid));
			if (kept.length === state.hiddenTids.length) return false;
			save(nextState(state.overrides, state.workRules, kept)); return true;
		},
		exportState() { assertLoaded(); return JSON.parse(JSON.stringify(state)); },
		get(eventKey) {
			assertLoaded();
			return state.overrides[eventKey] || null;
		},
		set(eventKey, value) {
			assertLoaded();
			eventKey = validateEventKey(eventKey);
			const override = checkedOverride(value);
			const now = Date.now();
			const next = nextState(Object.assign({}, state.overrides, {
				[eventKey]: Object.assign(override, { updatedAt: now })
			}), state.workRules);
			save(next);
			return next.overrides[eventKey];
		},
		setMany(eventKeys, value) {
			assertLoaded();
			if (!Array.isArray(eventKeys) || eventKeys.length === 0) {
				throw Object.assign(new TypeError('eventKeys are invalid'), { statusCode: 400 });
			}
			const keys = eventKeys.map(validateEventKey);
			if (new Set(keys).size !== keys.length) {
				throw Object.assign(new TypeError('eventKeys contain duplicates'), { statusCode: 400 });
			}
			const conflicts = keys.filter(eventKey => Object.prototype.hasOwnProperty.call(state.overrides, eventKey));
			if (conflicts.length) {
				throw Object.assign(new Error('manual overrides already exist'), {
					code: 'manual-overrides-conflict', statusCode: 409, eventKeys: conflicts
				});
			}
			const override = checkedOverride(value);
			const now = Date.now();
			const overrides = Object.assign({}, state.overrides);
			for (const eventKey of keys) overrides[eventKey] = Object.assign({}, override, { updatedAt: now });
			const next = nextState(overrides, state.workRules);
			save(next);
			return keys.map(eventKey => ({ eventKey, override: next.overrides[eventKey] }));
		},
		setWithWorkRule(eventKey, value, workRule, replaceWorkRuleIds) {
			assertLoaded();
			eventKey = validateEventKey(eventKey);
			const override = checkedOverride(value);
			const rule = workRule ? normalizeWorkRule(workRule) : null;
			const now = Date.now();
			const overrides = Object.assign({}, state.overrides, {
				[eventKey]: Object.assign(override, { updatedAt: now })
			});
			const workRules = Object.assign({}, state.workRules);
			for (const id of Array.isArray(replaceWorkRuleIds) ? replaceWorkRuleIds : []) delete workRules[id];
			let id = null;
			if (rule) {
				id = workRuleId(rule);
				const previous = state.workRules[id];
				workRules[id] = Object.assign({}, rule, {
					createdAt: previous && previous.createdAt || now,
					updatedAt: now
				});
			}
			const next = nextState(overrides, workRules);
			save(next);
			return { override: next.overrides[eventKey], workRuleId: id, workRule: id ? next.workRules[id] : null };
		},
		remove(eventKey) {
			assertLoaded();
			eventKey = validateEventKey(eventKey);
			if (!state.overrides[eventKey]) return false;
			const overrides = Object.assign({}, state.overrides);
			delete overrides[eventKey];
			save(nextState(overrides, state.workRules));
			return true;
		},
		getWorkRules() {
			assertLoaded();
			return Object.entries(state.workRules).map(([id, rule]) => Object.assign({ id }, rule));
		},
		removeWorkRule(id) {
			assertLoaded();
			if (typeof id !== 'string' || !/^work:[a-f0-9]{24}$/u.test(id) ||
				!Object.prototype.hasOwnProperty.call(state.workRules, id)) return false;
			const workRules = Object.assign({}, state.workRules);
			delete workRules[id];
			save(nextState(state.overrides, workRules));
			return true;
		},
		getHiddenTids() {
			assertLoaded();
			return state.hiddenTids.slice();
		},
		setHiddenTid(tid, hidden) {
			assertLoaded();
			tid = Number(tid);
			if (!Number.isInteger(tid) || tid <= 0) {
				throw Object.assign(new TypeError('tid is invalid'), { statusCode: 400 });
			}
			if (typeof hidden !== 'boolean') {
				throw Object.assign(new TypeError('hidden is invalid'), { statusCode: 400 });
			}
			const currentlyHidden = state.hiddenTids.includes(tid);
			if (currentlyHidden === hidden) return { tid, hidden, changed: false };
			const hiddenTids = hidden ? state.hiddenTids.concat(tid) : state.hiddenTids.filter(value => value !== tid);
			save(nextState(state.overrides, state.workRules, hiddenTids));
			return { tid, hidden, changed: true };
		},
		getGeneration() {
			assertLoaded();
			return state.generation;
		}
	};
	for (const name of ['set', 'setMany', 'setWithWorkRule', 'remove', 'removeWorkRule', 'setHiddenTid', 'createLocalSeries', 'removeLocalSeries', 'pruneHiddenTids']) {
		const write = api[name];
		api[name] = (...args) => {
			if (options.readOnly) throw new Error('frozen manual store cannot be written');
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			try {
				return withLock(filePath, () => {
					// Every writer reloads inside the same lease before merging.
					try { state = parseState(fs.readFileSync(filePath, 'utf8')); }
					catch (error) { if (error.code === 'ENOENT') state = emptyState(); else throw error; }
					loadError = null;
					if (options.beforeWrite) options.beforeWrite(state, name, args);
					return write(...args);
				}, { timeoutMs: 0 });
			} catch (error) {
				if (error.code === 'RESERVATION_LOCK_TIMEOUT') {
					error.statusCode = 503;
					error.message = '手動補正を保存中です。完了後に再操作してください。';
				}
				throw error;
			}
		};
	}
	return api;
}

module.exports = { createSeriesManualStore, parseState, workRuleId, normalizeHiddenTids, isLocalId };
