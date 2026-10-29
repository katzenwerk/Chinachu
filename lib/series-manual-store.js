'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function emptyState() {
	return { version: 3, generation: 0, updatedAt: null, overrides: {}, workRules: {}, hiddenTids: [] };
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

function normalizeOverride(value) {
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
	if (!value || ![1, 2, 3].includes(value.version) || !value.overrides || Array.isArray(value.overrides) ||
		typeof value.overrides !== 'object') {
		throw new TypeError('series manual override file is invalid');
	}
	const state = emptyState();
	state.generation = Number.isInteger(value.generation) && value.generation >= 0 ? value.generation : 0;
	state.updatedAt = Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : null;
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
	if (value.version >= 3) state.hiddenTids = normalizeHiddenTids(value.hiddenTids);
	return state;
}

function createSeriesManualStore(options) {
	options = options || {};
	if (!options.path) throw new TypeError('series manual override path is required');
	const filePath = options.path;
	let state = emptyState();
	let loadError = null;
	if (fs.existsSync(filePath)) {
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
			version: 3,
			generation: state.generation + 1,
			updatedAt: Date.now(),
			overrides,
			workRules,
			hiddenTids: normalizeHiddenTids(typeof hiddenTids === 'undefined' ? state.hiddenTids : hiddenTids)
		};
	}

	return {
		get(eventKey) {
			assertLoaded();
			return state.overrides[eventKey] || null;
		},
		set(eventKey, value) {
			assertLoaded();
			eventKey = validateEventKey(eventKey);
			const override = normalizeOverride(value);
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
			const override = normalizeOverride(value);
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
			const override = normalizeOverride(value);
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
}

module.exports = { createSeriesManualStore, parseState, workRuleId, normalizeHiddenTids };
