'use strict';

const SCHEMA_VERSION = 2;
const PAGE_FILTER_VERSION = 2;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const PAGE_STATUS_FILTERS = new Set([
	'RECORDED',
	'RECORDED_UNTRACKED',
	'MISSED',
	'SKIPPED_ONLY',
	'RESERVED'
]);
const PAGE_RESULT_FILTERS = new Set([
	'recorded',
	'deleted',
	'missed',
	'skipped'
]);

function cloneJson(value) {
	if (value === null || typeof value !== 'object') {
		return value;
	}

	return JSON.parse(JSON.stringify(value));
}

function positiveNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : 0;
}

function stringValue(value) {
	return typeof value === 'undefined' || value === null ? '' : String(value);
}

function addUnique(array, value) {
	value = stringValue(value);
	if (value && !array.includes(value)) {
		array.push(value);
	}
}

function parseCanonicalKey(value) {
	if (typeof value !== 'string' || value === '') {
		return null;
	}

	const secondsSeparator = value.lastIndexOf('|');
	const startSeparator = secondsSeparator > 0 ? value.lastIndexOf('|', secondsSeparator - 1) : -1;
	if (startSeparator <= 0 || secondsSeparator <= startSeparator + 1) {
		return null;
	}

	const channelId = value.slice(0, startSeparator);
	const startText = value.slice(startSeparator + 1, secondsSeparator);
	const secondsText = value.slice(secondsSeparator + 1);
	if (!/^\d+$/.test(startText) || !/^\d+$/.test(secondsText)) {
		return null;
	}

	const start = positiveNumber(startText);
	const seconds = positiveNumber(secondsText);
	if (!channelId || !start || !seconds) {
		return null;
	}

	return {
		key: value,
		channelId,
		start,
		seconds,
		end: start + seconds * 1000
	};
}

function makeCanonicalKey(program) {
	const channel = program && program.channel || {};
	const channelId = stringValue(channel.id || program && program.channelId);
	const start = positiveNumber(program && program.start);
	const seconds = positiveNumber(program && program.seconds);

	return channelId && start && seconds ? [channelId, start, seconds].join('|') : '';
}

function getLegacyProgram(entry) {
	return entry && (entry.program || entry.recorded || entry.reserve) || {};
}

function getLegacyRecordingResult(entry) {
	return entry && (entry.recordingResult || entry.recorded) || {};
}

function getLegacySnapshot(entry) {
	const result = getLegacyRecordingResult(entry);
	return result && result.snapshot && typeof result.snapshot === 'object' ? result.snapshot : {};
}

function getLegacyIds(entry) {
	const ids = [];
	const program = getLegacyProgram(entry);
	const result = getLegacyRecordingResult(entry);
	const snapshot = getLegacySnapshot(entry);
	const recording = entry && entry.recording || {};

	addUnique(ids, recording.recordedId);
	[program, result, snapshot].forEach(value => {
		addUnique(ids, value && value.id);
		addUnique(ids, value && value.recordedId);
		addUnique(ids, value && value.origId);
		addUnique(ids, value && value.programId);
	});

	return ids;
}

function getDeletion(entry) {
	if (entry && entry.deletion && typeof entry.deletion === 'object') {
		return {
			deletedAt: positiveNumber(entry.deletion.deletedAt) || null,
			reason: stringValue(entry.deletion.reason) || null
		};
	}

	const result = getLegacyRecordingResult(entry);
	const snapshot = getLegacySnapshot(entry);
	const program = getLegacyProgram(entry);
	const deletedSource = [result, snapshot, program].find(value => value &&
		(value.cleanupState === 'deleted' || value.deleted === true));

	if (!deletedSource) {
		return null;
	}

	return {
		deletedAt: positiveNumber(deletedSource.deletedAt) || null,
		reason: stringValue(deletedSource.cleanupReason) || null
	};
}

function normalizeMatchEntry(entry) {
	entry = entry && typeof entry === 'object' ? entry : {};
	const program = getLegacyProgram(entry);
	const result = getLegacyRecordingResult(entry);
	const snapshot = getLegacySnapshot(entry);
	const inputRecording = entry.recording && typeof entry.recording === 'object' ? entry.recording : {};
	const hasExplicitRecording = entry.recording && typeof entry.recording === 'object';
	const hasLegacyRecordingContainer = Boolean(
		entry.recordingResult && typeof entry.recordingResult === 'object' ||
		entry.recorded && typeof entry.recorded === 'object'
	);
	let key = stringValue(entry.key);
	let parsedKey = parseCanonicalKey(key);

	if (!parsedKey) {
		key = makeCanonicalKey(program) || makeCanonicalKey(result) || makeCanonicalKey(snapshot);
		parsedKey = parseCanonicalKey(key);
	}

	const start = positiveNumber(entry.start) || positiveNumber(program.start) ||
		positiveNumber(result.start) || parsedKey && parsedKey.start || 0;
	const seconds = parsedKey && parsedKey.seconds || positiveNumber(program.seconds) || positiveNumber(result.seconds);
	const end = positiveNumber(entry.end) || positiveNumber(program.end) || positiveNumber(result.end) ||
		(start && seconds ? start + seconds * 1000 : 0);
	const recordedId = stringValue(inputRecording.recordedId || result.recordedId || result.id ||
		result.programId || result.origId || snapshot.recordedId || snapshot.id || snapshot.programId ||
		program.id || program.programId || program.origId) || null;
	const recordingPath = stringValue(inputRecording.path || result.path || result.recorded ||
		snapshot.path || snapshot.recorded || program.path || program.recorded) || null;
	const hasRecordedStatus = entry.status === 'RECORDED' || entry.status === 'RECORDED_UNTRACKED';
	const hasRecording = entry.recording !== null &&
			(hasExplicitRecording || hasLegacyRecordingContainer || hasRecordedStatus && recordingPath !== null) &&
			(recordedId !== null || recordingPath !== null);
	const reservationMeta = entry.reservationMeta && typeof entry.reservationMeta === 'object' ? entry.reservationMeta : {};
	const ruleUid = stringValue(entry.ruleUid || reservationMeta.ruleUid || program.ruleUid ||
		result.ruleUid || snapshot.ruleUid).trim() || null;

	return {
		schemaVersion: SCHEMA_VERSION,
		key,
		status: stringValue(entry.status),
		start,
		end,
		fullTitle: stringValue(entry.fullTitle || program.fullTitle || program.title ||
			result.fullTitle || result.title || snapshot.fullTitle || snapshot.title),
		ruleUid,
		recording: hasRecording ? {
			recordedId,
			path: recordingPath
		} : null,
		deletion: getDeletion(entry)
	};
}

function getMatchIdentity(entry, normalized) {
	const parsed = parseCanonicalKey(normalized.key);
	const program = getLegacyProgram(entry);
	const explicitChannelId = stringValue(program && program.channel && program.channel.id || program.channelId);
	let valid = parsed !== null;

	if (parsed && normalized.start && normalized.start !== parsed.start) {
		valid = false;
	}
	if (parsed && normalized.end && normalized.end !== parsed.end) {
		valid = false;
	}
	if (parsed && explicitChannelId && explicitChannelId !== parsed.channelId) {
		valid = false;
	}

	return {
		valid,
		key: valid ? parsed.key : '',
		channelId: parsed ? parsed.channelId : '',
		start: parsed ? parsed.start : normalized.start,
		seconds: parsed ? parsed.seconds : normalized.start && normalized.end > normalized.start ?
			Math.floor((normalized.end - normalized.start) / 1000) : 0
	};
}

function getProgramIds(program) {
	const ids = [];
	addUnique(ids, program && program.id);
	addUnique(ids, program && program.recordedId);
	addUnique(ids, program && program.origId);
	addUnique(ids, program && program.programId);
	return ids;
}

function flattenSchedule(schedule) {
	const programs = [];
	(Array.isArray(schedule) ? schedule : []).forEach(channel => {
		if (channel && Array.isArray(channel.programs)) {
			channel.programs.forEach(program => {
				if (!program || typeof program !== 'object') return;
				const output = cloneJson(program);
				if (!output.channel || typeof output.channel !== 'object') {
					output.channel = {
						id: channel.id || '',
						name: channel.name || '',
						type: channel.type || '',
						sid: typeof channel.sid === 'undefined' ? null : channel.sid,
						nid: typeof channel.nid === 'undefined' ? null : channel.nid
					};
				}
				programs.push(output);
			});
		} else if (channel && typeof channel === 'object') {
			programs.push(channel);
		}
	});
	return programs;
}

function createProgramIndex(entries) {
	const byId = new Map();
	const byKey = new Map();

	(Array.isArray(entries) ? entries : []).forEach(program => {
		if (!program || typeof program !== 'object') return;
		getProgramIds(program).forEach(id => {
			if (!byId.has(id)) byId.set(id, []);
			byId.get(id).push(program);
		});
		const key = makeCanonicalKey(program);
		if (key) {
			if (!byKey.has(key)) byKey.set(key, []);
			byKey.get(key).push(program);
		}
	});

	return { byId, byKey };
}

function uniquePrograms(programs) {
	const seen = new Set();
	return programs.filter(program => {
		if (seen.has(program)) return false;
		seen.add(program);
		return true;
	});
}

function selectLatest(candidates) {
	if (candidates.length <= 1) return candidates[0] || null;
	const sorted = candidates.slice().sort((a, b) => {
		const aTime = positiveNumber(a.updatedAt) || positiveNumber(a.snapshotAt);
		const bTime = positiveNumber(b.updatedAt) || positiveNumber(b.snapshotAt);
		return bTime - aTime;
	});
	const firstTime = positiveNumber(sorted[0].updatedAt) || positiveNumber(sorted[0].snapshotAt);
	const secondTime = positiveNumber(sorted[1].updatedAt) || positiveNumber(sorted[1].snapshotAt);
	return firstTime > secondTime ? sorted[0] : null;
}

function findIndexedCandidate(index, identity, ids, preferredRecordedId) {
	const idMatches = uniquePrograms(ids.reduce((programs, id) =>
		programs.concat(index.byId.get(id) || []), []));
	let idConflict = false;
	let candidate;

	if (idMatches.length > 0) {
		const safeIdMatches = identity.valid ? idMatches.filter(program => makeCanonicalKey(program) === identity.key) : idMatches;
		candidate = identity.valid ? selectLatest(safeIdMatches) : safeIdMatches.length === 1 ? safeIdMatches[0] : null;
		if (candidate) {
			return {
				program: cloneJson(candidate),
				matchedBy: preferredRecordedId && getProgramIds(candidate).includes(preferredRecordedId) ? 'recordedId' : 'id-alias',
				idConflict: idMatches.length !== safeIdMatches.length
			};
		}
		idConflict = identity.valid && safeIdMatches.length !== idMatches.length;
	}

	if (identity.valid) {
		const keyMatches = index.byKey.get(identity.key) || [];
		candidate = selectLatest(keyMatches);
		if (candidate) {
			return {
				program: cloneJson(candidate),
				matchedBy: 'canonical-key',
				idConflict
			};
		}
	}

	return { program: null, matchedBy: null, idConflict };
}

function createDetailResolver(sources) {
	sources = sources || {};
	const indexes = {};

	function getIndex(sourceName) {
		if (!indexes[sourceName]) {
			const source = typeof sources[sourceName] === 'function' ? sources[sourceName]() : sources[sourceName];
			const entries = sourceName === 'schedule' ? flattenSchedule(source) : source;
			indexes[sourceName] = createProgramIndex(entries);
		}
		return indexes[sourceName];
	}

	return {
		resolve(entry) {
			return resolveMatchDetailWithIndexes(entry, getIndex);
		},
		resolveRuleUid(entry) {
			const normalized = normalizeMatchEntry(entry);
			if (normalized.ruleUid) return normalized.ruleUid;
			const identity = getMatchIdentity(entry, normalized);
			const ids = getLegacyIds(entry);
			const preferredRecordedId = normalized.recording && normalized.recording.recordedId || '';

			for (const sourceName of sourcePriority(normalized)) {
				if (sourceName === 'match') {
					const legacyDetail = getLegacyMatchDetail(entry);
					return stringValue(legacyDetail && legacyDetail.ruleUid).trim();
				}

				const candidate = findIndexedCandidate(getIndex(sourceName), identity, ids, preferredRecordedId);
				if (candidate.program) return stringValue(candidate.program.ruleUid).trim();
			}

			return '';
		}
	};
}

function hasRichMatchDetail(program) {
	if (!program || typeof program !== 'object') return false;
	return Boolean(program.detail || program.description || program.category || program.extra ||
		Array.isArray(program.flags) && program.flags.length > 0 ||
		program.channel && (program.channel.name || program.channel.type));
}

function getLegacyMatchDetail(entry) {
	if (!entry || Number(entry.schemaVersion) === SCHEMA_VERSION && !entry.program && !entry.recordingResult) {
		return null;
	}

	const program = getLegacyProgram(entry);
	const result = getLegacyRecordingResult(entry);
	const snapshot = getLegacySnapshot(entry);
	const candidates = entry.status === 'RECORDED' || entry.status === 'RECORDED_UNTRACKED' ?
		[snapshot, result, program] : [program, entry.reserve, result, snapshot];
	const candidate = candidates.find(hasRichMatchDetail);
	return candidate ? cloneJson(candidate) : null;
}

function buildMinimalProgram(normalized, identity) {
	const recordedId = normalized.recording && normalized.recording.recordedId;
	return {
		id: recordedId || null,
		recordedId: recordedId || null,
		title: normalized.fullTitle,
		fullTitle: normalized.fullTitle,
		start: normalized.start,
		end: normalized.end,
		seconds: identity.seconds || 0,
		channel: { id: identity.channelId || '' },
		recorded: normalized.recording && normalized.recording.path || null,
		path: normalized.recording && normalized.recording.path || null
	};
}

function sourcePriority(normalized) {
	if (normalized.deletion !== null) return ['reserves2', 'match', 'schedule'];
	switch (normalized.status) {
	case 'RECORDED': return ['recorded', 'reserves2', 'match', 'schedule'];
	case 'RECORDED_UNTRACKED': return ['recorded', 'match'];
	case 'MISSED': return ['reserves2', 'reserves', 'match', 'schedule'];
	case 'SKIPPED_ONLY': return ['reserves2', 'match', 'schedule'];
	case 'RESERVED': return ['reserves', 'reserves2', 'schedule', 'match'];
	default: return ['recorded', 'reserves2', 'reserves', 'match', 'schedule'];
	}
}

function resolveMatchDetailWithIndexes(entry, getIndex) {
	const normalized = normalizeMatchEntry(entry);
	const identity = getMatchIdentity(entry, normalized);
	const ids = getLegacyIds(entry);
	const preferredRecordedId = normalized.recording && normalized.recording.recordedId || '';
	const attemptedSources = [];
	let idConflict = false;
	let resolved = null;

	for (const sourceName of sourcePriority(normalized)) {
		attemptedSources.push(sourceName);
		if (sourceName === 'match') {
			const legacyDetail = getLegacyMatchDetail(entry);
			if (legacyDetail) {
				resolved = { program: legacyDetail, source: 'match', matchedBy: 'legacy-match' };
				break;
			}
			continue;
		}

		const candidate = findIndexedCandidate(getIndex(sourceName), identity, ids, preferredRecordedId);
		idConflict = idConflict || candidate.idConflict;
		if (candidate.program) {
			resolved = { program: candidate.program, source: sourceName, matchedBy: candidate.matchedBy };
			break;
		}
	}

	if (!resolved) {
		resolved = {
			program: buildMinimalProgram(normalized, identity),
			source: 'match',
			matchedBy: 'minimal-match'
		};
	}

	return {
		match: normalized,
		program: resolved.program,
		resolution: {
			source: resolved.source,
			matchedBy: resolved.matchedBy,
			canonicalKeyValid: identity.valid,
			idConflict,
			attemptedSources
		}
	};
}

function resolveMatchDetail(entry, sources) {
	return createDetailResolver(sources).resolve(entry);
}

function finiteNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number : 0;
}

function isLegacyDeletedOrMissing(entry) {
	const program = getLegacyProgram(entry);
	const result = getLegacyRecordingResult(entry);
	return [result, program].some(value => value && (
		value.cleanupState === 'deleted' || value.cleanupState === 'missing' ||
		value.deleted === true || value.fileExists === false
	));
}

function getMatchKind(entry, normalized, now) {
	if (!normalized.end || now <= normalized.end) return null;
	if (normalized.status === 'RECORDED' || normalized.status === 'RECORDED_UNTRACKED') {
		return normalized.deletion !== null || isLegacyDeletedOrMissing(entry) ? 'DELETED' : 'RECORDED';
	}
	if (normalized.status === 'SKIPPED_ONLY' || entry && entry.recd_flg && entry.recd_flg.isSkip === true) {
		return 'SKIPPED';
	}
	if (normalized.status === 'MISSED') return 'NG';
	if (entry && entry.recd_flg && entry.recd_flg.hasReserve === true &&
		entry.recd_flg.hasRecorded === false && entry.recd_flg.isSkip === false) return 'NG';
	if (normalized.status && normalized.status !== 'RESERVED') return 'NG';
	return null;
}

function pickValue(primary, secondary, key, fallback) {
	for (const source of [primary, secondary, fallback]) {
		if (source && typeof source[key] !== 'undefined' && source[key] !== null && source[key] !== '') {
			return source[key];
		}
	}
	return 0;
}

function getMirakurunDropTotal(drop) {
	if (!drop || typeof drop !== 'object') return null;
	if (drop.dropTotal !== null && typeof drop.dropTotal !== 'undefined' && drop.dropTotal !== '') {
		const total = Number(drop.dropTotal);
		return Number.isFinite(total) ? total : null;
	}
	if (Array.isArray(drop.pids)) {
		return drop.pids.reduce((total, pid) => total + (Number(pid && pid.drop) || 0), 0);
	}
	const pidMap = drop.pidDrops || drop.dropsByPid || drop.dropPids;
	if (pidMap && typeof pidMap === 'object') {
		return Object.keys(pidMap).reduce((total, pid) => total + (Number(pidMap[pid]) || 0), 0);
	}
	return null;
}

function compactMirakurunDrop(primary, secondary, fallback) {
	const drop = [primary, secondary, fallback].find(value =>
		value && value.mirakurunDrop && typeof value.mirakurunDrop === 'object');
	if (!drop) return null;
	return {
		dropTotal: getMirakurunDropTotal(drop.mirakurunDrop),
		packetTotal: drop.mirakurunDrop.packetTotal,
		tunerName: drop.mirakurunDrop.tunerName,
		checkedAt: drop.mirakurunDrop.checkedAt
	};
}

function compactTsDrop(primary, secondary, fallback) {
	const source = [primary, secondary, fallback].find(value =>
		value && value.tsDrop && typeof value.tsDrop === 'object');
	if (!source) return null;
	const drop = source.tsDrop;
	return {
		completed: drop.completed === true,
		stopReason: typeof drop.stopReason === 'string' ? drop.stopReason : null,
		coverage: typeof drop.coverage === 'string' ? drop.coverage : null,
		packetTotal: finiteNumber(drop.packetTotal),
		analyzedBytes: finiteNumber(drop.analyzedBytes),
		ccErrorEvents: finiteNumber(drop.ccErrorEvents),
		ccErrorsByPid: drop.ccErrorsByPid && typeof drop.ccErrorsByPid === 'object' ? cloneJson(drop.ccErrorsByPid) : {},
		teiPackets: finiteNumber(drop.teiPackets),
		scrambledPackets: finiteNumber(drop.scrambledPackets),
		syncErrorEvents: finiteNumber(drop.syncErrorEvents),
		processingTimeMs: finiteNumber(drop.processingTimeMs),
		maxChunkProcessingMs: finiteNumber(drop.maxChunkProcessingMs),
		processingRatio: finiteNumber(drop.processingRatio),
		checkedAt: drop.checkedAt || null
	};
}

function normalizeSearchText(value) {
	return stringValue(value).normalize('NFKC').toLocaleLowerCase('ja-JP');
}

function optionalValue(sources, key) {
	for (const source of sources) {
		if (source && Object.prototype.hasOwnProperty.call(source, key) &&
			typeof source[key] !== 'undefined' && source[key] !== null && source[key] !== '') {
			return source[key];
		}
	}
	return null;
}

function getReservationType(sources) {
	if (sources.some(source => source && source.isManualReserved === true)) return 'manual';
	if (sources.some(source => source && (
		stringValue(source.ruleUid) !== '' ||
		stringValue(source.ruleIdSource) !== '' ||
		(typeof source.ruleId !== 'undefined' && source.ruleId !== null && source.ruleId !== '')
	))) return 'rule';
	return 'unknown';
}

function getDeletionKind(entry, normalized) {
	if (normalized.deletion !== null) {
		return normalized.deletion.reason === 'recorded-missing' ? 'missing' : 'explicit';
	}

	const program = getLegacyProgram(entry);
	const result = getLegacyRecordingResult(entry);
	if ([result, program].some(value => value &&
		(value.cleanupState === 'missing' || value.fileExists === false))) return 'missing';
	if ([result, program].some(value => value &&
		(value.cleanupState === 'deleted' || value.deleted === true))) return 'explicit';
	return 'none';
}

function getPageStatusFilter(value) {
	const status = stringValue(value).trim().toUpperCase();
	if (!status) return '';
	if (!PAGE_STATUS_FILTERS.has(status)) throw new RangeError('invalid match page status');
	return status;
}

function getPageResultFilters(value) {
	if (typeof value === 'undefined' || value === null) return null;
	const filters = new Set();
	stringValue(value).split(',').map(item => item.trim().toLowerCase()).filter(Boolean).forEach(item => {
		if (!PAGE_RESULT_FILTERS.has(item)) throw new RangeError('invalid match page result filter');
		filters.add(item);
	});
	return filters;
}

function getPageResultKind(item) {
	if (item.status === 'RECORDED' || item.status === 'RECORDED_UNTRACKED') {
		return item.deletionKind === 'explicit' ? 'deleted' : 'recorded';
	}
	if (item.status === 'MISSED') return 'missed';
	if (item.status === 'SKIPPED_ONLY') return 'skipped';
	return null;
}

function positiveInteger(value, fallback, maximum) {
	const number = Number(value);
	if (!Number.isInteger(number) || number <= 0) return fallback;
	return Math.min(number, maximum);
}

function absoluteRecordingPath(value) {
	return typeof value === 'string' && value.startsWith('/') ? value : null;
}

function buildPageItem(entry, resolved) {
	const normalized = resolved.match;
	const identity = getMatchIdentity(entry, normalized);
	const isLegacy = Number(entry && entry.schemaVersion) !== SCHEMA_VERSION;
	const program = resolved.program || {};
	const legacyProgram = isLegacy ? getLegacyProgram(entry) : null;
	const legacyResult = isLegacy ? getLegacyRecordingResult(entry) : null;
	const sources = [program, legacyResult, legacyProgram].filter(Boolean);
	const channel = program.channel || legacyResult && legacyResult.channel || legacyProgram && legacyProgram.channel || {};
	const recordedSourceKnown = resolved.resolution.source === 'recorded' ||
		sources.some(source => Object.prototype.hasOwnProperty.call(source, 'operatorAbort') ||
			Object.prototype.hasOwnProperty.call(source, 'mirakurunDrop') ||
			Object.prototype.hasOwnProperty.call(source, 'tsDrop') ||
			Object.prototype.hasOwnProperty.call(source, 'operatorActualSeconds'));
	const operatorAbortValue = optionalValue(sources, 'operatorAbort');
	const drop = compactMirakurunDrop(program, legacyResult, legacyProgram);
	const tsDrop = compactTsDrop(program, legacyResult, legacyProgram);
	const ruleId = optionalValue(sources, 'ruleId');
	const title = program.title || program.fullTitle || normalized.fullTitle || null;
	const fullTitle = program.fullTitle || program.title || normalized.fullTitle || null;
	const recordedStatus = normalized.status === 'RECORDED' || normalized.status === 'RECORDED_UNTRACKED';
	const currentRecordingPathValue = resolved.resolution.source === 'recorded' ?
		stringValue(program.recorded || program.path) || null : null;
	const historicalRecordingPathValue = stringValue(normalized.recording && normalized.recording.path) || null;
	const currentRecordingPath = absoluteRecordingPath(currentRecordingPathValue);
	const historicalRecordingPath = absoluteRecordingPath(historicalRecordingPathValue);
	const recordingPath = recordedStatus ? currentRecordingPath || historicalRecordingPath : null;

	return {
		key: normalized.key || '',
		status: normalized.status || '',
		start: normalized.start || 0,
		end: normalized.end || 0,
		seconds: finiteNumber(program.seconds) || identity.seconds ||
			(normalized.start && normalized.end ? Math.floor((normalized.end - normalized.start) / 1000) : 0),
		title,
		fullTitle,
		detail: program.detail || program.description || null,
		category: program.category || null,
		flags: Array.isArray(program.flags) ? program.flags : [],
		subTitle: typeof program.subTitle === 'undefined' ? null : program.subTitle,
		episode: typeof program.episode === 'undefined' ? null : program.episode,
		channel: {
			id: channel.id || identity.channelId || null,
			name: channel.name || null,
			type: channel.type || null,
			hasLogoData: channel.hasLogoData === true
		},
		recordedId: normalized.recording && normalized.recording.recordedId || null,
		recordingPath,
		recordingPathMissing: recordedStatus && currentRecordingPathValue === null && historicalRecordingPathValue === null,
		operatorRecordingStart: recordedSourceKnown ? optionalValue(sources, 'operatorRecordingStart') : null,
		operatorRecordingEnd: recordedSourceKnown ? optionalValue(sources, 'operatorRecordingEnd') : null,
		operatorActualSeconds: recordedSourceKnown ? optionalValue(sources, 'operatorActualSeconds') : null,
		recordedDurationSeconds: recordedSourceKnown ? optionalValue(sources, 'recordedDurationSeconds') : null,
		operatorInterruptionCount: recordedSourceKnown ? optionalValue(sources, 'operatorInterruptionCount') : null,
		operatorAbort: recordedSourceKnown ? operatorAbortValue === true : null,
		operatorAbortAt: recordedSourceKnown ? optionalValue(sources, 'operatorAbortAt') : null,
		operatorAbortReason: recordedSourceKnown ? optionalValue(sources, 'operatorAbortReason') : null,
		operatorEndLack: recordedSourceKnown ? optionalValue(sources, 'operatorEndLack') === true : null,
		operatorEndLackReason: recordedSourceKnown ? optionalValue(sources, 'operatorEndLackReason') : null,
		mirakurunDrop: recordedSourceKnown ? drop : null,
		tsDrop: recordedSourceKnown ? tsDrop : null,
		reservationType: getReservationType(sources),
		ruleUid: optionalValue(sources, 'ruleUid') || normalized.ruleUid,
		ruleId,
		ruleIdSource: optionalValue(sources, 'ruleIdSource'),
		deletionKind: getDeletionKind(entry, normalized),
		deletion: normalized.deletion === null ? null : cloneJson(normalized.deletion),
		detailSource: resolved.resolution.source
	};
}

function buildPage(items, detailResolver, options) {
	options = options || {};
	const now = finiteNumber(options.now) || Date.now();
	const page = positiveInteger(options.page, 1, Number.MAX_SAFE_INTEGER);
	const pageSize = positiveInteger(options.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
	const status = getPageStatusFilter(options.status);
	const resultFilters = getPageResultFilters(options.results);
	const search = normalizeSearchText(options.search).trim();
	const ruleUid = stringValue(options.ruleUid).trim();
	let candidates = [];
	const counts = { recorded: 0, deleted: 0, missed: 0, skipped: 0 };

	(Array.isArray(items) ? items : []).forEach((entry, index) => {
		const normalized = normalizeMatchEntry(entry);
		if (normalized.status === 'RESERVED' || !normalized.end || now <= normalized.end) return;
		if (status && normalized.status !== status) return;
		let entryRuleUid = normalized.ruleUid;
		if (ruleUid && !entryRuleUid) entryRuleUid = detailResolver.resolveRuleUid(entry || {});
		if (ruleUid && stringValue(entryRuleUid) !== ruleUid) return;
		const resultKind = getPageResultKind({
			status: normalized.status,
			deletionKind: getDeletionKind(entry || {}, normalized)
		});
		if (resultFilters !== null && !resultFilters.has(resultKind)) return;
		candidates.push({ entry: entry || {}, normalized, resultKind, index });
	});

	candidates.sort((a, b) => {
		if (a.normalized.start !== b.normalized.start) return b.normalized.start - a.normalized.start;
		if (a.normalized.key !== b.normalized.key) return a.normalized.key < b.normalized.key ? -1 : 1;
		return a.index - b.index;
	});

	if (search) {
		candidates = candidates.map(candidate => {
			const item = buildPageItem(candidate.entry, detailResolver.resolve(candidate.entry));
			return Object.assign(candidate, { item });
		}).filter(candidate => {
			const item = candidate.item;
			const haystack = normalizeSearchText([
				item.title,
				item.fullTitle,
				item.detail,
				item.category,
				item.channel.id,
				item.channel.name,
				item.channel.type
			].filter(Boolean).join('\n'));
			return haystack.includes(search);
		});
	}

	candidates.forEach(candidate => {
		if (Object.prototype.hasOwnProperty.call(counts, candidate.resultKind)) counts[candidate.resultKind]++;
	});

	const total = candidates.length;
	const offset = (page - 1) * pageSize;
	return {
		items: candidates.slice(offset, offset + pageSize).map(candidate =>
			candidate.item || buildPageItem(candidate.entry, detailResolver.resolve(candidate.entry))),
		total,
		counts,
		page,
		pageSize,
		totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
		filterVersion: PAGE_FILTER_VERSION,
		appliedRuleUid: ruleUid || null
	};
}

function buildResultCounts(items, options) {
	options = options || {};
	const now = finiteNumber(options.now) || Date.now();
	const counts = { recorded: 0, deleted: 0, missed: 0, skipped: 0 };

	(Array.isArray(items) ? items : []).forEach(entry => {
		const normalized = normalizeMatchEntry(entry);
		if (normalized.status === 'RESERVED' || !normalized.end || now <= normalized.end) return;
		const resultKind = getPageResultKind({
			status: normalized.status,
			deletionKind: getDeletionKind(entry || {}, normalized)
		});
		if (Object.prototype.hasOwnProperty.call(counts, resultKind)) counts[resultKind]++;
	});

	return counts;
}

function buildRuleRecordingCounts(items, detailResolver, options) {
	options = options || {};
	const now = finiteNumber(options.now) || Date.now();
	const counts = {};
	const seenKeys = new Set();
	let counted = 0;
	let withoutRuleUid = 0;

	(Array.isArray(items) ? items : []).forEach((entry, index) => {
		const normalized = normalizeMatchEntry(entry);
		if (normalized.status !== 'RECORDED' && normalized.status !== 'RECORDED_UNTRACKED') return;
		if (!normalized.end || now <= normalized.end) return;
		const key = normalized.key || `item-${index}`;
		if (seenKeys.has(key)) return;
		seenKeys.add(key);

		const ruleUid = normalized.ruleUid || detailResolver.resolveRuleUid(entry || {});
		if (!ruleUid) {
			withoutRuleUid++;
			return;
		}
		counts[ruleUid] = (counts[ruleUid] || 0) + 1;
		counted++;
	});

	return { counts, counted, withoutRuleUid, total: counted + withoutRuleUid };
}

function buildListItem(entry, resolved, now) {
	const normalized = resolved.match;
	const kind = getMatchKind(entry, normalized, now);
	if (kind === null) return null;

	const isLegacy = Number(entry && entry.schemaVersion) !== SCHEMA_VERSION;
	const primary = isLegacy ? getLegacyProgram(entry) : resolved.program || {};
	const secondary = isLegacy ? getLegacyRecordingResult(entry) : {};
	const fallback = isLegacy ? resolved.program || {} : {};
	const identity = getMatchIdentity(entry, normalized);
	const channel = primary.channel || secondary.channel || fallback.channel || {};
	const recordedId = normalized.recording && normalized.recording.recordedId;
	const displayId = primary.id || primary.origId || primary.programId || secondary.id ||
		secondary.recordedId || secondary.origId || recordedId || null;
	const seconds = finiteNumber(primary.seconds || secondary.seconds) || identity.seconds ||
		(normalized.start && normalized.end ? Math.floor((normalized.end - normalized.start) / 1000) : 0);

	return {
		_listSlim: true,
		_matchItem: { key: normalized.key || '' },
		_matchKind: kind,
		id: displayId,
		_recordedId: recordedId || secondary.id || secondary.recordedId || secondary.origId || null,
		start: normalized.start || finiteNumber(primary.start || secondary.start),
		seconds,
		operatorRecordingStart: pickValue(primary, secondary, 'operatorRecordingStart', fallback),
		operatorRecordingEnd: pickValue(primary, secondary, 'operatorRecordingEnd', fallback),
		operatorActualSeconds: pickValue(primary, secondary, 'operatorActualSeconds', fallback),
		recordedDurationSeconds: pickValue(primary, secondary, 'recordedDurationSeconds', fallback),
		operatorAbort: [primary, secondary, fallback].some(value => value && value.operatorAbort === true),
		operatorEndLack: [primary, secondary, fallback].some(value => value && value.operatorEndLack === true),
		mirakurunDrop: compactMirakurunDrop(primary, secondary, fallback),
		tsDrop: compactTsDrop(primary, secondary, fallback),
		title: primary.title || primary.fullTitle || normalized.fullTitle || '-',
		fullTitle: primary.fullTitle || primary.title || normalized.fullTitle || '-',
		detail: primary.detail || primary.description || '',
		flags: Array.isArray(primary.flags) ? primary.flags : [],
		subTitle: primary.subTitle,
		episode: primary.episode,
		channel: {
			id: channel.id || identity.channelId || '-',
			name: channel.name || '-',
			type: channel.type || '-'
		},
		isManualReserved: primary.isManualReserved === true
	};
}

function buildList(items, detailResolver, options) {
	const now = options && finiteNumber(options.now) || Date.now();
	return (Array.isArray(items) ? items : []).map(entry =>
		buildListItem(entry || {}, detailResolver.resolve(entry || {}), now)).filter(Boolean);
}

function buildSummary(items, detailResolver, options) {
	const now = options && finiteNumber(options.now) || Date.now();
	const limit = Math.max(0, Math.min(options && finiteNumber(options.limit) || 0, 16));
	const counts = { recorded: 0, ng: 0 };
	const history = [];

	(Array.isArray(items) ? items : []).forEach(entry => {
		const normalized = normalizeMatchEntry(entry);
		if (!normalized.end || now <= normalized.end) return;
		if (normalized.status === 'RECORDED') counts.recorded++;
		else if (normalized.status === 'MISSED') counts.ng++;
		else return;
		if (limit > 0) history.push({ entry, normalized });
	});

	const recent = history.sort((a, b) => b.normalized.start - a.normalized.start).slice(0, limit).map(value => {
		const resolved = detailResolver.resolve(value.entry);
		const program = resolved.program || {};
		const identity = getMatchIdentity(value.entry, value.normalized);
		const channel = program.channel || {};
		return {
			key: value.normalized.key,
			status: value.normalized.status,
			channel: { id: channel.id || identity.channelId || '-', name: channel.name || '-', type: channel.type || '-' },
			program: {
				start: value.normalized.start,
				end: value.normalized.end,
				seconds: finiteNumber(program.seconds) || identity.seconds,
				title: program.title || program.fullTitle || value.normalized.fullTitle || '-',
				fullTitle: program.fullTitle || program.title || value.normalized.fullTitle || '-',
				detail: program.detail || program.description || '',
				flags: Array.isArray(program.flags) ? program.flags : [],
				episode: program.episode,
				category: program.category || 'etc'
			}
		};
	});

	return { counts, items: recent, hasMore: counts.recorded + counts.ng > recent.length };
}

function getMatchLookupIds(entry) {
	const ids = getLegacyIds(entry);
	addUnique(ids, entry && entry.key);
	return ids;
}

function resolveRecordedProgram(id, matchItems, sources) {
	id = stringValue(id);
	const recorded = Array.isArray(sources && sources.recorded) ? sources.recorded : [];
	const exact = recorded.filter(program => stringValue(program && program.id) === id);
	const aliases = exact.length === 0 ? recorded.filter(program => getProgramIds(program).includes(id)) : [];
	const direct = exact.length === 1 ? exact[0] : aliases.length === 1 ? aliases[0] : null;
	if (direct) return { program: cloneJson(direct), source: 'recorded', matchItem: null, resolution: null };
	if (exact.length > 1 || aliases.length > 1) {
		return { program: null, source: null, matchItem: null, resolution: { error: 'ambiguous-recorded-id' } };
	}

	const entries = (Array.isArray(matchItems) ? matchItems : []).filter(item => getMatchLookupIds(item).includes(id));
	if (entries.length !== 1) {
		return {
			program: null,
			source: null,
			matchItem: null,
			resolution: entries.length > 1 ? { error: 'ambiguous-match-id' } : null
		};
	}
	const entry = entries[0];
	const resolved = createDetailResolver(sources).resolve(entry);
	const recording = resolved.match.recording;
	if (!recording || !recording.path) return { program: null, source: null, matchItem: entry, resolution: resolved.resolution };

	const program = cloneJson(resolved.program) || {};
	program.id = recording.recordedId || program.id || id;
	program.origId = program.origId || program.programId || program.id;
	program.programId = program.programId || program.origId || program.id;
	program.recordedId = recording.recordedId || program.recordedId || program.id;
	program.recorded = recording.path;
	program.path = recording.path;
	program._isMatchFallback = true;
	program._matchKey = resolved.match.key;
	return { program, source: 'match', matchItem: entry, resolution: resolved.resolution };
}

module.exports = {
	SCHEMA_VERSION,
	PAGE_FILTER_VERSION,
	buildList,
	buildPage,
	buildResultCounts,
	buildRuleRecordingCounts,
	buildSummary,
	createDetailResolver,
	makeCanonicalKey,
	normalizeMatchEntry,
	parseCanonicalKey,
	resolveRecordedProgram,
	resolveMatchDetail
};
