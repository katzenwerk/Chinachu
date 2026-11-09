'use strict';

const { DatabaseSync } = require('node:sqlite');

const SUSPICIOUS_SUBTITLES = new Set([
	'スタッフ', 'イマニメーション', 'ヌマニメーション', 'アニメーション',
	'end', '終了', '新番組', '最終回'
].map(compact));

function compact(value) {
	return String(value ?? '').normalize('NFKC').toLowerCase()
		.replace(/[\u0300-\u036f]/gu, '')
		.match(/[\p{L}\p{N}]/gu)?.join('') ?? '';
}

function normalizedText(value) {
	return String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, '');
}

function titleVariants(program) {
	const raw = String(program && program.title || '').normalize('NFKC').trim();
	const variants = [['raw', compact(raw)]];
	let stripped = raw
		.replace(/^[\[【]?[新終再無字解初][\]】]?/u, '')
		.replace(/^アニメA[・･]?#?/iu, '')
		.replace(/^アニメ[・･\s]+/u, '')
		.replace(/^日\d+「(.+)」$/u, '$1')
		.replace(/^『(.+)』(?=(?:Season|第?\d+期|$))/iu, '$1');
	if (compact(stripped) !== compact(raw)) {
		variants.push(['broadcast-frame-removed', compact(stripped)]);
	}
	stripped = stripped
		.replace(/(?:デジタルリマスター(?:HD)?版|デジタルリマスター版|HDリマスター版)/giu, '')
		.replace(/\s+request\s*\d+\.?$/iu, '');
	if (!variants.some(value => value[1] === compact(stripped))) {
		variants.push(['presentation-removed', compact(stripped)]);
	}
	return variants.filter(value => value[1]);
}

// Keep legacy workIdentity intact; only the title matching paths use both fields.
function titleCandidates(program) {
	const candidates = [];
	const seen = new Set();
	for (const value of [program && program.title, program && program.fullTitle]) {
		for (const variant of titleVariants({ title: value })) {
			if (seen.has(variant[1])) continue;
			seen.add(variant[1]);
			candidates.push(variant);
		}
	}
	return candidates;
}

function undecoratedBroadcastTitle(value) {
	return String(value || '').normalize('NFKC').trim()
		.replace(/^(?:(?:[＜<]アニメギルド[＞>]|【アニメギルド】)\s*)+/u, '')
		.replace(/^(?:(?:【[新終再]】|\[[新終再]\])\s*)+/u, '')
		.replace(/\s*(?:#\s*\d{1,3}(?:\s*[-~～]\s*#?\d{1,3})?|第\s*\d{1,3}\s*話)(?:\s*(?:[新終再]|🈟|🈡|🈞|【[新終再]】|\[[新終再]\]))*\s*$/u, '')
		.trim();
}

function embeddedFormalTitles(program, dictionary) {
	const found = new Map();
	const seen = new Set();
	for (const raw of [program && program.title, program && program.fullTitle]) {
		const content = compact(raw);
		if (!content || seen.has(content)) continue;
		seen.add(content);
		const bounded = compact(undecoratedBroadcastTitle(raw));
		for (let index = 0; index <= content.length - 6; index++) {
			for (const entry of dictionary.embeddedTitleIndex.get(content.slice(index, index + 6)) || []) {
				if (!content.startsWith(entry.key, index)) continue;
				const previous = found.get(entry.tid);
				found.set(entry.tid, { tid: entry.tid, bounded: Boolean(previous && previous.bounded) || bounded === entry.key });
			}
		}
	}
	return found;
}

function seriesKey(value) {
	return compact(value)
		.replace(/(?:第)?\d+期/gu, '')
		.replace(/season\d+|\d+(?:st|nd|rd|th)season/giu, '')
		.replace(/シーズン\d+/gu, '')
		.replace(/\d{4}$/u, '')
		.replace(/secondseason|2ndseason/giu, '');
}

function workIdentity(program) {
	const variants = titleVariants(program);
	return variants.length ? variants[variants.length - 1][1] : '';
}

function installmentIdentity(value) {
	const normalized = String(value ?? '').normalize('NFKC').toLowerCase();
	const values = [];
	for (const match of normalized.matchAll(/(?:第\s*(\d+)\s*期|season\s*(\d+)|(\d+)(?:st|nd|rd|th)\s*season|第\s*(\d+)\s*クール)/giu)) {
		if (match[1]) values.push('season:' + Number(match[1]));
		else if (match[2]) values.push('season:' + Number(match[2]));
		else if (match[3]) values.push('season:' + Number(match[3]));
		else if (match[4]) values.push('cour:' + Number(match[4]));
	}
	return Array.from(new Set(values)).sort().join(',');
}

function broadcastServiceIdentity(program) {
	const channel = program && program.channel || {};
	const nid = Number(channel.nid);
	const sid = Number(channel.sid);
	if (!Number.isInteger(nid) || nid < 0 || !Number.isInteger(sid) || sid < 0 ||
		typeof channel.type !== 'string' || !channel.type.trim()) return null;
	const tsid = Number(channel.tsid);
	return {
		type: channel.type.trim(),
		nid,
		sid,
		tsid: Number.isInteger(tsid) && tsid >= 0 ? tsid : null,
		channelId: typeof channel.id === 'string' && channel.id.trim() ? channel.id.trim() : null,
		name: typeof channel.name === 'string' && channel.name.trim() ? channel.name.trim() : null
	};
}

function hasExplicitInstallment(program) {
	const value = ['title', 'fullTitle'].map(field => String(program && program[field] || ''))
		.join(' ').normalize('NFKC');
	return /(?:season\s*\d+|第\s*\d+\s*期|第\s*\d+\s*クール|\d+(?:st|nd|rd|th)\s*season)/iu.test(value);
}

function parseEpisodeNumbers(value) {
	if (Number.isInteger(value)) return [value];
	const text = String(value ?? '').normalize('NFKC');
	const numbers = [];
	for (const match of text.matchAll(/(\d+)\s*[-~～]\s*#?(\d+)/gu)) {
		const left = Number(match[1]);
		const right = Number(match[2]);
		if (right - left >= 0 && right - left <= 100) {
			for (let number = left; number <= right; number++) numbers.push(number);
		}
	}
	const withoutRanges = text.replace(/\d+\s*[-~～]\s*#?\d+/gu, '');
	for (const match of withoutRanges.matchAll(/\d+/gu)) numbers.push(Number(match[0]));
	return Array.from(new Set(numbers));
}

function suspiciousSubtitle(program) {
	const subtitle = normalizedText(program && program.subTitle);
	if (!subtitle) return false;
	const key = compact(subtitle);
	return SUSPICIOUS_SUBTITLES.has(key) ||
		['イマニメーション', 'ヌマニメーション'].some(value => key.startsWith(compact(value))) ||
		key === compact(program && program.title);
}

function presentationSubtitle(program) {
	const subtitle = normalizedText(program && program.subTitle);
	if (!subtitle) return false;
	const source = [program && program.title, program && program.fullTitle]
		.filter(Boolean).join(' ').normalize('NFKC');
	for (const match of source.matchAll(/[【\[]([^】\]]+)[】\]]/gu)) {
		const annotation = normalizedText(match[1]);
		if (annotation === subtitle && /(?:版|ver(?:sion)?\.?)$/iu.test(annotation)) return true;
	}
	return false;
}

function addSet(map, key, value) {
	if (!map.has(key)) map.set(key, new Set());
	map.get(key).add(value);
}

function createDictionaryStore(options) {
	options = options || {};
	if (!options.path) throw new TypeError('dictionary path is required');
	const db = options.db || new DatabaseSync(options.path, { readOnly: true });
	db.exec('PRAGMA query_only=ON');
	const titles = new Map();
	const lookupIndex = new Map();
	const titleIndex = new Map();
	const aliasIndex = new Map();
	const titleKeysByTid = new Map();
	const seriesIndex = new Map();
	const embeddedTitleIndex = new Map();
	const episodeCache = new Map();
	const episodeLookupCache = new Map();
	const episodesStatement = db.prepare(
		'SELECT episode, subtitle, lookup_key FROM episodes WHERE tid = ?'
	);
	const subtitleStatement = db.prepare(
		'SELECT tid, episode, subtitle FROM episodes WHERE lookup_key = ? ORDER BY tid, episode'
	);

	for (const row of db.prepare(
		'SELECT tid, title, lookup_key, short_title, first_year, first_month FROM titles'
	).all()) {
		const tid = Number(row.tid);
		titles.set(tid, {
			tid,
			title: row.title,
			lookupKey: row.lookup_key,
			shortTitle: row.short_title || '',
			firstYear: row.first_year || '',
			firstMonth: row.first_month || ''
		});
		addSet(lookupIndex, row.lookup_key, tid);
		const officialKey = compact(row.title);
		if (officialKey.length >= 6) {
			const prefix = officialKey.slice(0, 6);
			if (!embeddedTitleIndex.has(prefix)) embeddedTitleIndex.set(prefix, []);
			embeddedTitleIndex.get(prefix).push({ tid, key: officialKey });
		}
		addSet(titleIndex, row.lookup_key, tid);
		addSet(titleKeysByTid, tid, row.lookup_key);
		for (const value of [row.title, row.short_title || '']) {
			const key = seriesKey(value);
			if (key.length >= 4) addSet(seriesIndex, key, tid);
		}
	}
	for (const row of db.prepare('SELECT tid, lookup_key FROM aliases').all()) {
		const tid = Number(row.tid);
		addSet(lookupIndex, row.lookup_key, tid);
		addSet(aliasIndex, row.lookup_key, tid);
		addSet(titleKeysByTid, tid, row.lookup_key);
		const key = seriesKey(row.lookup_key);
		if (key.length >= 4) addSet(seriesIndex, key, tid);
	}

	function loadEpisodes(tid) {
		if (episodeCache.has(tid)) return;
		const episodes = new Map();
		const lookup = new Map();
		for (const row of episodesStatement.all(tid)) {
			const episode = Number(row.episode);
			episodes.set(episode, row.subtitle);
			if (row.lookup_key) {
				if (!lookup.has(row.lookup_key)) lookup.set(row.lookup_key, []);
				lookup.get(row.lookup_key).push(episode);
			}
		}
		episodeCache.set(tid, episodes);
		episodeLookupCache.set(tid, lookup);
	}

	return {
		titles,
		lookupIndex,
		titleIndex,
		aliasIndex,
		titleKeysByTid,
		seriesIndex,
		embeddedTitleIndex,
		findEpisodesBySubtitle(lookupKey) {
			if (!lookupKey) return [];
			return subtitleStatement.all(lookupKey).map(row => ({
				tid: Number(row.tid),
				episode: Number(row.episode),
				subtitle: row.subtitle
			}));
		},
		getEpisodes(tid) {
			loadEpisodes(tid);
			return episodeCache.get(tid);
		},
		getEpisodeLookup(tid) {
			loadEpisodes(tid);
			return episodeLookupCache.get(tid);
		},
		counts() {
			return Object.fromEntries(['titles', 'aliases', 'episodes'].map(table => [
				table,
				Number(db.prepare('SELECT COUNT(*) AS count FROM ' + table).get().count)
			]));
		},
		close() {
			db.close();
		}
	};
}

function normalizeChannelMap(value) {
	if (value instanceof Map) return new Map(Array.from(value, entry => [entry[0], normalizeChannelEntry(entry[1])]));
	const channels = Array.isArray(value) ? value : value && Array.isArray(value.channels) ? value.channels : [];
	return new Map(channels.map(item => [Number(item.nid) + ':' + Number(item.sid), normalizeChannelEntry(item)]));
}

function channelIds(value) {
	if (!value || typeof value !== 'object') return [];
	return Array.from(new Set([value.chId]
		.concat(Array.isArray(value.chIds) ? value.chIds : [])
		.concat(Array.isArray(value.candidateChIds) ? value.candidateChIds : [])
		.map(Number).filter(number => Number.isInteger(number) && number > 0))).sort((left, right) => left - right);
}

function normalizeChannelEntry(value) {
	const result = Object.assign({}, value);
	result.chIds = channelIds(value);
	result.chId = result.chIds[0] || null;
	return result;
}

function normalizeProgLookupItems(items) {
	return (Array.isArray(items) ? items : []).map(item => Object.assign({}, item, {
		tid: Number(typeof item.tid === 'undefined' ? item.TID : item.tid),
		chid: Number(typeof item.chid === 'undefined' ? item.ChID : item.chid)
	}));
}

function buildProgLookupIndex(items) {
	const byStart = new Map();
	for (const item of normalizeProgLookupItems(items)) {
		const start = String(item.StTime || item.start || '');
		if (!start) continue;
		if (!byStart.has(start)) byStart.set(start, []);
		byStart.get(start).push(item);
	}
	return byStart;
}

function reserveStart(program) {
	const date = new Date(Number(program.start) + 9 * 60 * 60 * 1000);
	const pad = value => String(value).padStart(2, '0');
	return date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate()) +
		' ' + pad(date.getUTCHours()) + ':' + pad(date.getUTCMinutes()) + ':' + pad(date.getUTCSeconds());
}

function programYears(program) {
	const text = ['title', 'fullTitle', 'detail', 'description']
		.map(field => String(program && program[field] || '')).join(' ').normalize('NFKC');
	return new Set(Array.from(text.matchAll(/(?<!\d)(?:19|20)\d{2}(?!\d)/gu), match => match[0]));
}

function scoreTitleCandidates(program, dictionary) {
	const scores = new Map();
	function add(tid, points, evidence) {
		if (!scores.has(tid)) scores.set(tid, { score: 0, evidence: [] });
		const entry = scores.get(tid);
		entry.score += points;
		if (!entry.evidence.includes(evidence)) entry.evidence.push(evidence);
	}
	const variants = titleCandidates(program);
	variants.forEach((value, index) => {
		for (const tid of dictionary.lookupIndex.get(value[1]) || []) {
			add(tid, index === 0 ? 70 : 62, 'title:' + value[0]);
		}
	});
	for (const value of variants) {
		const simplified = seriesKey(value[1]);
		if (simplified.length < 4) continue;
		for (const tid of dictionary.seriesIndex.get(simplified) || []) {
			add(tid, 24, 'series-key:' + value[0]);
		}
	}
	return scores;
}

function uniqueFormalTitleMatch(program, dictionary) {
	let matched = null;
	for (const value of titleCandidates(program)) {
		const tids = Array.from(dictionary.titleIndex.get(value[1]) || []);
		if (tids.length > 1 || tids.length === 1 && matched && matched.tid !== tids[0]) return null;
		if (tids.length === 1 && !matched) matched = { tid: tids[0], variant: value[0], key: value[1] };
	}
	return matched;
}

function installmentMarkers(value) {
	const key = compact(value);
	const markers = new Set();
	for (const match of key.matchAll(/season(\d+)|(\d+)(?:st|nd|rd|th)season/giu)) {
		markers.add('season:' + Number(match[1] || match[2]));
	}
	for (const match of key.matchAll(/第(\d+)期/gu)) markers.add('season:' + Number(match[1]));
	for (const match of key.matchAll(/第(\d+)クール/gu)) markers.add('cour:' + Number(match[1]));
	return markers;
}

function titleCompatibility(program, tid, dictionary) {
	const variants = [program && program.title, program && program.fullTitle].filter(Boolean)
		.flatMap(value => titleVariants({ title: value }).map(item => item[1]));
	const keys = Array.from(dictionary.titleKeysByTid.get(tid) || []);
	const exact = variants.some(value => keys.includes(value));
	const partial = exact || variants.some(value => keys.some(key =>
		Math.min(value.length, key.length) >= 4 && (value.includes(key) || key.includes(value))));
	if (!partial) return null;
	const programMarkers = installmentMarkers([program.title, program.fullTitle].filter(Boolean).join(' '));
	const titleMarkers = installmentMarkers(dictionary.titles.get(tid)?.title || '');
	if (!exact && programMarkers.size &&
		(!titleMarkers.size || Array.from(programMarkers).some(marker => !titleMarkers.has(marker)))) return null;
	if (programMarkers.size && titleMarkers.size &&
		Array.from(programMarkers).some(marker => !titleMarkers.has(marker))) return null;
	return exact ? 'exact' : 'partial';
}

function subtitleReverseCandidates(program, dictionary) {
	const subtitleKey = compact(program && program.subTitle);
	if (!subtitleKey || suspiciousSubtitle(program)) {
		return { status: 'not-applicable', tids: [], uniqueTid: null, uniqueEpisode: null, rows: [] };
	}
	const sourceRows = dictionary.findEpisodesBySubtitle(subtitleKey);
	if (!sourceRows.length) {
		return { status: 'no-match', tids: [], uniqueTid: null, uniqueEpisode: null, rows: [] };
	}
	const epgNumbers = parseEpisodeNumbers(program.episode);
	const episodeRows = epgNumbers.length === 1 && sourceRows.some(row => row.episode === epgNumbers[0]) ?
		sourceRows.filter(row => row.episode === epgNumbers[0]) : sourceRows;
	const rows = episodeRows.map(row => Object.assign({}, row, {
		titleCompatibility: titleCompatibility(program, row.tid, dictionary)
	})).filter(row => row.titleCompatibility !== null);
	const tids = Array.from(new Set(rows.map(row => row.tid))).sort((left, right) => left - right);
	const uniqueTid = tids.length === 1 ? tids[0] : null;
	const episodes = uniqueTid === null ? [] : Array.from(new Set(rows.filter(row => row.tid === uniqueTid)
		.map(row => row.episode))).sort((left, right) => left - right);
	return {
		status: !rows.length ? 'title-or-installment-conflict' : tids.length === 1 ? 'unique-tid' : 'ambiguous-tid',
		tids,
		uniqueTid,
		uniqueEpisode: episodes.length === 1 ? episodes[0] : null,
		rows
	};
}

function subtitleEvidence(program, tid, dictionary) {
	const epgNumbers = parseEpisodeNumbers(program.episode);
	const subtitle = normalizedText(program.subTitle);
	const subtitleKey = compact(subtitle);
	const dictionaryEpisodes = dictionary.getEpisodes(tid);
	const exactSubtitleEpisodes = subtitleKey ? dictionary.getEpisodeLookup(tid).get(subtitleKey) || [] : [];
	const dictionaryEpisodeNumbers = Array.from(dictionaryEpisodes.keys());
	const result = {
		epgNumbers,
		dictionaryEpisode: null,
		dictionarySubtitle: null,
		subtitleStatus: 'unregistered',
		points: 0,
		evidence: [],
		schemeDifference: false,
		exactSubtitleEpisodes,
		rangeComplete: false,
		rangeEndpointsMatch: false,
		registeredEpgNumbers: epgNumbers.filter(number => dictionaryEpisodes.has(number)),
		dictionaryEpisodeFloor: dictionaryEpisodeNumbers.length ? Math.min(...dictionaryEpisodeNumbers) : null
	};
	const subtitleIsSuspicious = suspiciousSubtitle(program);
	if (exactSubtitleEpisodes.length && !subtitleIsSuspicious) {
		const matchingEpg = exactSubtitleEpisodes.filter(number => epgNumbers.includes(number));
		if (exactSubtitleEpisodes.length > 1 && matchingEpg.length !== 1) {
			result.subtitleStatus = 'exact-ambiguous';
			result.points = 15;
			result.evidence.push('subtitle-exact-ambiguous');
			return result;
		}
		const chosen = matchingEpg.length === 1 ? matchingEpg[0] : exactSubtitleEpisodes[0];
		result.dictionaryEpisode = chosen;
		result.dictionarySubtitle = dictionaryEpisodes.get(chosen) || null;
		result.subtitleStatus = normalizedText(dictionaryEpisodes.get(chosen)) === subtitle ?
			'exact' : 'notation-difference';
		result.points = 65;
		result.evidence.push('subtitle-exact');
		if (epgNumbers.length && !epgNumbers.includes(chosen)) {
			result.schemeDifference = true;
			result.evidence.push('season-vs-series-episode');
		}
		return result;
	}
	if (subtitleKey && !subtitleIsSuspicious) {
		const partial = Array.from(dictionaryEpisodes).filter(value => {
			const key = compact(value[1]);
			return Math.min(subtitleKey.length, key.length) >= 4 &&
				(subtitleKey.includes(key) || key.includes(subtitleKey));
		});
		if (partial.length === 1 && (!epgNumbers.length || epgNumbers.includes(partial[0][0]))) {
			result.dictionaryEpisode = partial[0][0];
			result.dictionarySubtitle = partial[0][1];
			result.subtitleStatus = 'partial';
			result.points = 10;
			result.evidence.push('subtitle-partial');
			return result;
		}
	}
	if (epgNumbers.length === 1 && dictionaryEpisodes.has(epgNumbers[0])) {
		const number = epgNumbers[0];
		result.dictionaryEpisode = number;
		result.dictionarySubtitle = dictionaryEpisodes.get(number);
		result.points = 20;
		result.evidence.push('episode-number-present');
		result.subtitleStatus = !subtitle ? 'missing' : subtitleIsSuspicious ?
			'suspicious-non-subtitle' : 'mismatch';
	} else if (epgNumbers.length && epgNumbers.every(number => dictionaryEpisodes.has(number))) {
		result.subtitleStatus = 'range-present';
		result.points = 12;
		result.evidence.push('episode-range-present');
		result.rangeComplete = true;
		result.rangeEndpointsMatch = dictionaryEpisodes.has(epgNumbers[0]) &&
			dictionaryEpisodes.has(epgNumbers[epgNumbers.length - 1]);
	} else if (subtitle) {
		result.subtitleStatus = subtitleIsSuspicious ? 'suspicious-non-subtitle' : 'mismatch';
	} else {
		result.subtitleStatus = 'missing';
	}
	return result;
}

function describeEpisodeIdentity(result) {
	const selected = result.selectedTid === null ? null :
		result.candidates.find(candidate => candidate.tid === result.selectedTid) || null;
	const epg = selected ? selected.subtitle.epgNumbers : parseEpisodeNumbers(result.program.episode);
	const dictionary = selected ? selected.subtitle.dictionaryEpisode : null;
	const refs = epg.map(number => 'epg:' + number);
	if (dictionary !== null) refs.push('dict:' + dictionary);
	if (result.proglookupEpisodeConfirmed && epg.length === 1) refs.push('prog:' + epg[0]);
	if (result.multipleEpisodeConfirmed && epg.length > 1) {
		const registered = new Set(selected && selected.subtitle.registeredEpgNumbers || []);
		return {
			status: 'multi-episode-confirmed',
			canonicalHint: null,
			episodeNumbers: epg.slice(),
			episodeIdentities: epg.map(number => (registered.has(number) ? 'dict:' : 'epg:') + number),
			refs: Array.from(new Set(refs.concat(
				selected && selected.subtitle.rangeComplete ? epg.map(number => 'dict:' + number) : []
			))),
			mergeAllowed: false
		};
	}
	if (result.tidConfirmed && result.episodeConfirmed && !result.scheduleConflict &&
		(epg.length === 1 || dictionary !== null)) {
		return {
			status: 'same-episode-corroborated',
			canonicalHint: dictionary !== null ? 'dict:' + dictionary :
				result.proglookupEpisodeConfirmed ? 'prog:' + epg[0] : 'epg:' + epg[0],
			refs: Array.from(new Set(refs)),
			mergeAllowed: true
		};
	}
	if (result.episodeRelation === 'possible-fixed-offset-unverified') {
		return { status: 'offset-unverified', canonicalHint: null, refs: Array.from(new Set(refs)), mergeAllowed: false };
	}
	if (epg.length > 1) {
		return { status: 'multi-episode-container', canonicalHint: null, refs: Array.from(new Set(refs)), mergeAllowed: false };
	}
	if (result.episodeRelation === 'same-number') {
		return { status: 'same-number-series-unconfirmed', canonicalHint: null, refs: Array.from(new Set(refs)), mergeAllowed: false };
	}
	return { status: 'unresolved', canonicalHint: null, refs: Array.from(new Set(refs)), mergeAllowed: false };
}

function previewSelection(program, tid, context) {
	tid = Number(tid);
	const title = context.dictionary.titles.get(tid) || null;
	if (!title) return null;
	const resolution = evaluateProgram(program || {}, context);
	const candidate = resolution.candidates.find(value => value.tid === tid) || null;
	const selectionTitleCompatibility = titleCompatibility(program || {}, tid, context.dictionary);
	const subtitle = candidate && candidate.subtitle ||
		(selectionTitleCompatibility ? subtitleEvidence(program || {}, tid, context.dictionary) : null);
	const epgNumbers = subtitle ? subtitle.epgNumbers : parseEpisodeNumbers(program && program.episode);
	const multipleEpisode = epgNumbers.length > 1;
	const contradiction = resolution.scheduleConflict ||
		resolution.proglookupStatus === 'same-channel-time-title-conflict' ||
		resolution.proglookupTidConfirmed && resolution.selectedTid !== tid;
	const subtitleAllowsSameNumber = subtitle && (
		['exact', 'notation-difference', 'missing', 'suspicious-non-subtitle'].includes(subtitle.subtitleStatus) ||
		presentationSubtitle(program)
	);
	const selectedProgCount = candidate && Number.isInteger(candidate.prog && candidate.prog.count) ?
		candidate.prog.count : null;
	const validEpisodeNumbers = epgNumbers.length > 0 && epgNumbers.every(number =>
		Number.isInteger(number) && number > 0);
	const subtitleEpisodeConflict = subtitle && subtitle.dictionaryEpisode !== null &&
		!epgNumbers.includes(subtitle.dictionaryEpisode);
	const installmentOffsetConflict = hasExplicitInstallment(program || {}) && subtitle &&
		subtitle.dictionaryEpisodeFloor !== null && subtitle.dictionaryEpisodeFloor > 1 &&
		epgNumbers.length > 0 && epgNumbers.every(number => number < subtitle.dictionaryEpisodeFloor) &&
		subtitle.dictionaryEpisode === null;
	const progEpisodeConflict = resolution.proglookupTidConfirmed && selectedProgCount !== null &&
		!epgNumbers.includes(selectedProgCount) && !(
			subtitleEpisodeConflict && ['exact', 'notation-difference'].includes(subtitle.subtitleStatus) &&
			selectedProgCount === subtitle.dictionaryEpisode
		);
	let episode = null;
	let episodeSource = null;
	if (!multipleEpisode && resolution.selectedTid === tid && resolution.episodeConfirmed) {
		const identity = resolution.episodeIdentity && resolution.episodeIdentity.canonicalHint || '';
		const match = String(identity).match(/^(?:dict|prog|epg):(\d+)$/u);
		episode = match ? Number(match[1]) : subtitle && subtitle.dictionaryEpisode || epgNumbers[0] || null;
		episodeSource = episode === null ? null : String(identity).startsWith('prog:') ? 'proglookup' :
			String(identity).startsWith('epg:') ? 'epg' : 'dictionary';
	} else if (!multipleEpisode && candidate && !contradiction) {
		if (subtitle.dictionaryEpisode !== null &&
			['exact', 'notation-difference'].includes(subtitle.subtitleStatus)) {
			episode = subtitle.dictionaryEpisode;
			episodeSource = 'dictionary';
		} else if (epgNumbers.length === 1 && subtitle.dictionaryEpisode === epgNumbers[0] &&
			subtitleAllowsSameNumber) {
			episode = epgNumbers[0];
			episodeSource = 'dictionary';
		}
	}
	if (episode === null && !multipleEpisode && selectionTitleCompatibility && !contradiction &&
		validEpisodeNumbers && !subtitleEpisodeConflict && !installmentOffsetConflict && !progEpisodeConflict &&
		(!subtitle || subtitle.dictionaryEpisode === null || subtitleAllowsSameNumber)) {
		episode = epgNumbers[0];
		episodeSource = subtitle && subtitle.dictionaryEpisode === epgNumbers[0] ? 'dictionary' : 'epg';
	}
	const dictionaryEpisode = episode === null ? null : context.dictionary.getEpisodes(tid).get(episode);
	const multipleEpisodes = multipleEpisode && selectionTitleCompatibility && !contradiction &&
		validEpisodeNumbers && !subtitleEpisodeConflict && !installmentOffsetConflict && !progEpisodeConflict ? epgNumbers.slice() : [];
	const multipleEpisodeIdentities = multipleEpisodes.map(number =>
		context.dictionary.getEpisodes(tid).has(number) ? 'dict:' + number : 'epg:' + number);
	return {
		tid,
		title: title.title,
		episode,
		episodeConfirmed: episode !== null,
		episodeSource,
		episodeHint: !multipleEpisode && epgNumbers.length === 1 ? epgNumbers[0] : null,
		multipleEpisode,
		multipleEpisodeConfirmed: multipleEpisodes.length > 1,
		multipleEpisodes,
		episodeIdentity: episode === null ? null : dictionaryEpisode !== undefined ?
			'dict:' + episode : resolution.proglookupEpisodeConfirmed ? 'prog:' + episode : 'epg:' + episode,
		multipleEpisodeIdentities,
		multipleEpisodeSource: multipleEpisodeIdentities.length > 1 &&
			multipleEpisodeIdentities.every(identity => identity.startsWith('dict:')) ? 'dictionary' :
			multipleEpisodeIdentities.length > 1 ? 'epg' : null,
		dictionarySubtitle: typeof dictionaryEpisode === 'string' && dictionaryEpisode !== '' ? dictionaryEpisode : null,
		subtitleStatus: subtitle && subtitle.subtitleStatus || null,
		subtitlePresentation: presentationSubtitle(program),
		titleCompatible: candidate !== null || selectionTitleCompatibility !== null,
		contradiction
	};
}

function evaluateProgram(program, context, index) {
	const dictionary = context.dictionary;
	const scores = scoreTitleCandidates(program, dictionary);
	const embeddedTitles = embeddedFormalTitles(program, dictionary);
	for (const match of embeddedTitles.values()) {
		if (!scores.has(match.tid)) scores.set(match.tid, { score: 0, evidence: [] });
		const entry = scores.get(match.tid);
		if (!entry.evidence.some(value => value.startsWith('title:'))) {
			entry.score += match.bounded ? 62 : 30;
			entry.evidence.push(match.bounded ? 'title-contained-bounded' : 'title-contained');
		}
	}
	const formalTitleMatch = uniqueFormalTitleMatch(program, dictionary);
	const subtitleReverse = subtitleReverseCandidates(program, dictionary);
	for (const tid of subtitleReverse.tids) {
		if (!scores.has(tid)) scores.set(tid, { score: 0, evidence: [] });
		const entry = scores.get(tid);
		const rows = subtitleReverse.rows.filter(row => row.tid === tid);
		const exactTitle = rows.some(row => row.titleCompatibility === 'exact');
		entry.score += exactTitle ? 82 : 68;
		entry.evidence.push(exactTitle ? 'subtitle-reverse-title-exact' : 'subtitle-reverse-title-partial');
	}
	const baselineTids = new Set(dictionary.lookupIndex.get(compact(program.title)) || []);
	const years = programYears(program);
	for (const [tid, entry] of scores) {
		const firstYear = dictionary.titles.get(tid)?.firstYear;
		if (firstYear && years.has(String(firstYear))) {
			entry.score += 10;
			entry.evidence.push('production-year');
		}
	}
	const start = reserveStart(program);
	const scheduleItems = context.progByStart.get(start) || [];
	const channel = program.channel || {};
	const mapping = context.channelMap.get(Number(channel.nid ?? -1) + ':' + Number(channel.sid ?? -1)) || null;
	const mappingChIds = channelIds(mapping);
	const directItems = scheduleItems.filter(item => mappingChIds.includes(item.chid));
	const proglookupAvailability = typeof context.getProgLookupCoverage === 'function' ?
		context.getProgLookupCoverage(program, mapping) : 'unknown';
	let scheduleConflict = false;
	for (const item of directItems) {
		const tid = item.tid;
		const titleKey = compact(dictionary.titles.get(tid)?.title);
		const plausible = scores.has(tid) || titleKey && titleVariants(program).some(value =>
			Math.min(value[1].length, titleKey.length) >= 4 &&
			(value[1].includes(titleKey) || titleKey.includes(value[1])));
		if (plausible) {
			if (!scores.has(tid)) scores.set(tid, { score: 0, evidence: [] });
			const entry = scores.get(tid);
			entry.score += mapping.status === 'verified' ? 100 : 88;
			entry.evidence.push('proglookup-channel-' + mapping.status);
			if (!entry.evidence.some(value => value.startsWith('title:'))) {
				entry.evidence.push('proglookup-title-compatible');
			}
			entry.prog = item;
		} else {
			scheduleConflict = true;
		}
	}
	if (!directItems.length) {
		const intersection = scheduleItems.filter(item => scores.has(item.tid));
		if (new Set(intersection.map(item => item.tid)).size === 1) {
			const item = intersection[0];
			const entry = scores.get(item.tid);
			entry.score += 52;
			entry.evidence.push('proglookup-time-title');
			entry.prog = item;
		}
	}
	for (const [tid, entry] of scores) {
		const subtitle = subtitleEvidence(program, tid, dictionary);
		entry.subtitle = subtitle;
		entry.score += subtitle.points;
		for (const evidence of subtitle.evidence) {
			if (!entry.evidence.includes(evidence)) entry.evidence.push(evidence);
		}
		const episodes = dictionary.getEpisodes(tid);
		if (subtitle.epgNumbers.length && episodes.size &&
			!subtitle.epgNumbers.some(number => episodes.has(number))) {
			entry.score -= 20;
			entry.evidence.push('episode-number-absent');
		}
	}
	const programSeriesKey = seriesKey(program.title);
	const sameSeries = Array.from(scores.keys()).filter(tid => programSeriesKey &&
		seriesKey(dictionary.titles.get(tid)?.title) === programSeriesKey);
	const scheduleResolved = sameSeries.filter(tid => scores.get(tid).evidence.some(value =>
		value.startsWith('proglookup-channel-')));
	const subtitleResolved = sameSeries.filter(tid =>
		['exact', 'notation-difference'].includes(scores.get(tid).subtitle.subtitleStatus));
	if (sameSeries.length > 1 && scheduleResolved.length === 1) {
		scores.get(scheduleResolved[0]).score += 45;
		scores.get(scheduleResolved[0]).evidence.push('series-disambiguated-by-proglookup');
	} else if (sameSeries.length > 1 && subtitleResolved.length === 1) {
		scores.get(subtitleResolved[0]).score += 45;
		scores.get(subtitleResolved[0]).evidence.push('series-disambiguated-by-subtitle');
	}
	const ordered = Array.from(scores).sort((a, b) => b[1].score - a[1].score || a[0] - b[0]);
	let competitive = ordered.length ? ordered.filter(value => value[1].score >= ordered[0][1].score - 18) : [];
	if (sameSeries.length > 1 && !scheduleResolved.length && !subtitleResolved.length) {
		const ids = new Set(competitive.map(value => value[0]));
		for (const tid of sameSeries) {
			if (!ids.has(tid)) competitive.push([tid, scores.get(tid)]);
		}
		competitive.sort((a, b) => b[1].score - a[1].score || a[0] - b[0]);
	}
	const plausibleDirectTids = new Set(Array.from(scores).filter(value =>
		directItems.includes(value[1].prog)).map(value => value[0]));
	const hasDirectTidConflict = new Set(directItems.map(item => item.tid)).size > 1;
	const uniqueDirectTid = plausibleDirectTids.size === 1 ? Array.from(plausibleDirectTids)[0] : null;
	const directChIds = new Set(directItems.map(item => item.chid));
	const allCandidateChannelsObserved = mappingChIds.length <= 1 || proglookupAvailability === 'covered-complete' ||
		mappingChIds.every(chId => directChIds.has(chId));
	let proglookupStatus;
	let proglookupTidConfirmed = false;
	if (directItems.length && uniqueDirectTid !== null && allCandidateChannelsObserved) {
		proglookupStatus = 'same-channel-time-same-tid';
		proglookupTidConfirmed = true;
	} else if (directItems.length) {
		proglookupStatus = plausibleDirectTids.size ?
			'same-channel-time-ambiguous-tid' : 'same-channel-time-title-conflict';
	} else if (scheduleItems.length && scheduleItems.some(item => scores.has(item.tid))) {
		proglookupStatus = 'time-title-only-channel-mismatch-or-unmapped';
	} else if (scheduleItems.length) {
		proglookupStatus = 'time-only-title-mismatch';
	} else {
		proglookupStatus = 'no-proglookup-at-time';
	}
	let classification;
	let selectedTid = null;
	let tidConfirmed = false;
	let tidConfirmationSource = null;
	const directEntry = uniqueDirectTid === null ? null : scores.get(uniqueDirectTid);
	const directTitleCompatible = directEntry && directEntry.evidence.some(value =>
		value.startsWith('title:') || value === 'proglookup-title-compatible');
	const directEpisodeNumbers = parseEpisodeNumbers(program.episode);
	const directCounts = directItems.filter(item => item.tid === uniqueDirectTid)
		.map(item => String(item.Count ?? '')).filter(value => /^\d+$/u.test(value)).map(Number);
	const directEpisodeContradiction = directEntry && directEntry.evidence.includes('episode-number-absent') &&
		directEpisodeNumbers.length === 1 && directCounts.length &&
		!directCounts.includes(directEpisodeNumbers[0]) && !directEntry.evidence.includes('subtitle-exact');
	const candidateMetadataContradiction = mapping && mapping.status !== 'verified' && directEntry &&
		['mismatch', 'partial', 'exact-ambiguous'].includes(directEntry.subtitle.subtitleStatus);
	const canConfirmDirect = proglookupTidConfirmed && directTitleCompatible && !scheduleConflict &&
		!directEpisodeContradiction && !candidateMetadataContradiction;
	const exactTid = formalTitleMatch && formalTitleMatch.tid;
	const exactConflictsWithSchedule = exactTid !== null && directItems.some(item => item.tid !== exactTid);
	const exactIsCompetitive = exactTid !== null && scores.has(exactTid) && competitive.some(value => value[0] === exactTid);
	const canConfirmFormalTitle = exactIsCompetitive && !scheduleConflict && !exactConflictsWithSchedule &&
		(competitive.length === 1 || hasExplicitInstallment(program));
	const reverseTid = subtitleReverse.uniqueTid;
	const reverseConflictsWithSchedule = reverseTid !== null && directItems.some(item => item.tid !== reverseTid);
	const canConfirmSubtitleReverse = reverseTid !== null && !scheduleConflict && !reverseConflictsWithSchedule;
	const embedded = embeddedTitles.size === 1 ? embeddedTitles.values().next().value : null;
	const containedTid = embedded?.bounded ? embedded.tid : null;
	const canConfirmContained = containedTid !== null && !scheduleConflict &&
		!directItems.some(item => item.tid !== containedTid) &&
		competitive.length === 1 && competitive[0][0] === containedTid &&
		titleCompatibility(program, containedTid, dictionary) !== null;
	if (canConfirmDirect) {
		selectedTid = uniqueDirectTid;
		competitive = competitive.filter(value => value[0] === selectedTid);
		classification = 'confirmed';
		tidConfirmed = true;
		tidConfirmationSource = 'proglookup';
	} else if (canConfirmSubtitleReverse) {
		selectedTid = reverseTid;
		competitive = competitive.filter(value => value[0] === selectedTid);
		classification = 'confirmed';
		tidConfirmed = true;
		tidConfirmationSource = 'dictionary-subtitle-reverse';
	} else if (canConfirmFormalTitle) {
		selectedTid = exactTid;
		competitive = competitive.filter(value => value[0] === selectedTid);
		classification = 'confirmed';
		tidConfirmed = true;
		tidConfirmationSource = 'dictionary-title';
	} else if (canConfirmContained) {
		selectedTid = containedTid;
		classification = 'confirmed';
		tidConfirmed = true;
		tidConfirmationSource = 'dictionary-contained-title';
	} else if (!ordered.length) {
		classification = 'no-candidate';
	} else if (competitive.length > 1) {
		classification = 'multiple';
	} else {
		selectedTid = ordered[0][0];
		const evidence = ordered[0][1].evidence;
		const hasSchedule = evidence.some(value => value.startsWith('proglookup-channel-'));
		const hasStrongTitle = evidence.some(value => value.startsWith('title:'));
		const hasSubtitle = evidence.includes('subtitle-exact');
		const hasContradictingDirect = directItems.some(item => item.tid !== selectedTid);
		const scheduleConfirmation = hasSchedule && proglookupTidConfirmed && hasStrongTitle;
		const dictionaryConfirmation = hasStrongTitle && hasSubtitle;
		classification = !hasDirectTidConflict && !hasContradictingDirect &&
			(scheduleConfirmation || dictionaryConfirmation) ? 'confirmed' : 'likely';
		if (classification === 'confirmed') {
			tidConfirmed = true;
			tidConfirmationSource = scheduleConfirmation ? 'proglookup-title' : 'dictionary-subtitle';
		}
	}
	proglookupTidConfirmed = proglookupTidConfirmed && selectedTid === uniqueDirectTid;
	let episodeRelation = 'unresolved';
	let proglookupEpisodeConfirmed = false;
	let episodeConfirmationSource = null;
	let subtitleDecision = 'indeterminate';
	let subtitleComplement = false;
	let metaTitle = null;
	if (selectedTid !== null) {
		const top = scores.get(selectedTid);
		const subtitle = top.subtitle;
		const epgNumbers = subtitle.epgNumbers;
		const rawCount = String(top.prog?.Count ?? '');
		const progCount = /^\d+$/u.test(rawCount) ? Number(rawCount) : null;
		const dictionaryEpisode = subtitle.dictionaryEpisode;
		const installmentOffsetConflict = hasExplicitInstallment(program) &&
			subtitle.dictionaryEpisodeFloor !== null && subtitle.dictionaryEpisodeFloor > 1 &&
			epgNumbers.length > 0 && epgNumbers.every(number => number < subtitle.dictionaryEpisodeFloor) &&
			dictionaryEpisode === null;
		if (epgNumbers.length === 1 && dictionaryEpisode === epgNumbers[0]) {
			episodeRelation = 'same-number';
		} else if (epgNumbers.length <= 1 && tidConfirmationSource === 'dictionary-subtitle-reverse' &&
			subtitleReverse.uniqueEpisode !== null) {
			episodeRelation = 'subtitle-reverse-exact';
		} else if (epgNumbers.length === 1 && dictionaryEpisode !== null && proglookupTidConfirmed &&
			[epgNumbers[0], dictionaryEpisode].includes(progCount) &&
			['exact', 'notation-difference'].includes(subtitle.subtitleStatus)) {
			episodeRelation = 'season-to-series-verified';
		} else if (epgNumbers.length === 1 && dictionaryEpisode !== null) {
			episodeRelation = 'possible-fixed-offset-unverified';
		} else if (epgNumbers.length === 1 && installmentOffsetConflict) {
			episodeRelation = 'possible-fixed-offset-unverified';
		} else if (epgNumbers.length === 1 && proglookupTidConfirmed && progCount !== null &&
			progCount !== epgNumbers[0]) {
			episodeRelation = 'proglookup-count-conflict';
		} else if (epgNumbers.length === 1 && epgNumbers[0] > 0) {
			episodeRelation = 'epg-number-uncontradicted';
		} else if (epgNumbers.length > 1) {
			const rangeConflict = installmentOffsetConflict ||
				dictionaryEpisode !== null && !epgNumbers.includes(dictionaryEpisode) ||
				proglookupTidConfirmed && progCount !== null && !epgNumbers.includes(progCount);
			episodeRelation = rangeConflict ? 'range-conflict' :
				subtitle.rangeComplete ? 'range-complete' : 'range-epg-uncontradicted';
		}
		proglookupEpisodeConfirmed = proglookupTidConfirmed && epgNumbers.length === 1 &&
			[epgNumbers[0], dictionaryEpisode].includes(progCount);
		if (classification === 'confirmed' && epgNumbers.length === 1) {
			const epgSubtitle = normalizedText(program.subTitle);
			const status = subtitle.subtitleStatus;
			let chosen = null;
			if (['exact', 'notation-difference'].includes(status)) {
				chosen = subtitle.dictionarySubtitle || epgSubtitle;
				subtitleDecision = 'epg-dictionary-agree';
			} else if (['missing', 'suspicious-non-subtitle'].includes(status) &&
				subtitle.dictionarySubtitle &&
				['same-number', 'season-to-series-verified'].includes(episodeRelation)) {
				chosen = subtitle.dictionarySubtitle;
				subtitleComplement = true;
				subtitleDecision = 'dictionary-complement';
			} else if (epgSubtitle && !suspiciousSubtitle(program)) {
				chosen = epgSubtitle;
				subtitleDecision = status === 'mismatch' ?
					'epg-kept-dictionary-mismatch' : 'epg-kept-no-exact-match';
			} else {
				subtitleDecision = status === 'mismatch' ?
					'dictionary-mismatch-no-complement' : 'indeterminate';
			}
			if (chosen) {
				metaTitle = dictionary.titles.get(selectedTid).title + ' #' + epgNumbers[0] + '「' + chosen + '」';
			}
		}
		if (subtitleDecision === 'indeterminate' && subtitle.subtitleStatus === 'mismatch') {
			subtitleDecision = 'dictionary-mismatch-no-complement';
		}
	}
	const selectedSubtitleStatus = selectedTid === null ? null : scores.get(selectedTid).subtitle.subtitleStatus;
	const resultEpisodeNumbers = parseEpisodeNumbers(program.episode);
	const episodeConfirmed = tidConfirmed && selectedTid !== null && !scheduleConflict && resultEpisodeNumbers.length <= 1 &&
		(resultEpisodeNumbers.length === 1 || subtitleReverse.uniqueEpisode !== null) &&
		(proglookupEpisodeConfirmed || ['same-number', 'season-to-series-verified', 'subtitle-reverse-exact',
			'epg-number-uncontradicted'].includes(episodeRelation));
	const selectedSubtitle = selectedTid === null ? null : scores.get(selectedTid).subtitle;
	const multipleEpisodeConfirmed = Boolean(tidConfirmed && selectedTid !== null && !scheduleConflict &&
		resultEpisodeNumbers.length > 1 && ['range-complete', 'range-epg-uncontradicted'].includes(episodeRelation) &&
		resultEpisodeNumbers.every(number => Number.isInteger(number) && number > 0));
	if (episodeConfirmed) {
		episodeConfirmationSource = ['same-number', 'season-to-series-verified', 'subtitle-reverse-exact'].includes(episodeRelation) ?
			'dictionary' : proglookupEpisodeConfirmed ? 'proglookup' : 'epg';
	} else if (multipleEpisodeConfirmed) {
		episodeConfirmationSource = episodeRelation === 'range-complete' ? 'dictionary' : 'epg';
	}
	const reason = classification === 'no-candidate' ? 'title-not-in-dictionary' :
		classification === 'multiple' ? 'candidate-score-tie' :
		classification === 'likely' ? 'single-title-candidate-without-independent-corroboration' :
		scheduleConflict ? 'channel-time-candidate-conflicts-with-title' : null;
	const result = {
		index,
		id: program.id || program.programId || null,
		program,
		classification,
		selectedTid,
		tidConfirmed,
		tidConfirmationSource,
		episodeConfirmed,
		multipleEpisodeConfirmed,
		episodeConfirmationSource,
		candidateTids: ordered.map(value => value[0]),
		competitiveTids: competitive.map(value => value[0]),
		candidates: ordered.map(value => {
			const tid = value[0];
			const entry = value[1];
			return {
				tid,
				score: entry.score,
				evidence: entry.evidence,
				subtitle: entry.subtitle,
				prog: entry.prog ? {
					pid: entry.prog.PID,
					tid: entry.prog.tid,
					chid: entry.prog.chid,
					count: /^\d+$/u.test(String(entry.prog.Count ?? '')) ? Number(entry.prog.Count) : null
				} : null
			};
		}),
		baselineSingle: baselineTids.size === 1,
		baselineCount: baselineTids.size,
		formalTitleMatch,
		subtitleReverse: {
			status: subtitleReverse.status,
			tids: subtitleReverse.tids,
			uniqueTid: subtitleReverse.uniqueTid,
			uniqueEpisode: subtitleReverse.uniqueEpisode
		},
		workIdentity: workIdentity(program),
		mapping,
		directPids: directItems.map(item => item.PID),
		scheduleConflict,
		metaTitle,
		subtitleComplement,
		reason,
		proglookupStatus,
		proglookupAvailability,
		proglookupTidConfirmed,
		proglookupEpisodeConfirmed,
		episodeRelation,
		subtitleDecision,
		multipleEpisodePreserved: parseEpisodeNumbers(program.episode).length > 1,
		heldForSafety: ['likely', 'multiple'].includes(classification) ||
			['mismatch', 'partial', 'exact-ambiguous'].includes(selectedSubtitleStatus) ||
			['possible-fixed-offset-unverified', 'proglookup-count-conflict', 'range-conflict'].includes(episodeRelation)
	};
	result.episodeIdentity = describeEpisodeIdentity(result);
	return result;
}

function resolveExploration(program, explorer, resolution, context) {
	// Preserve every existing confirmation, including a TID with no known EP.
	if (resolution.tidConfirmed || resolution.scheduleConflict) return resolution;
	const episodes = parseEpisodeNumbers(program.episode);
	if (episodes.length !== 1 || !Number.isSafeInteger(episodes[0]) || episodes[0] <= 0) return resolution;
	// The comparison number comes only from the EPG, never from ProgLookup.
	const exploration = explorer.find(Object.assign({}, program, { episode: episodes[0] }));
	if (exploration.status !== 'single-observed-tid' || exploration.acquisitionComplete !== true ||
		exploration.candidateTids.length !== 1) return resolution;
	const tid = exploration.candidateTids[0];
	const matches = exploration.matches.filter(match => match.tid === tid && match.episodeMatch === 'exact');
	if (!matches.length || resolution.proglookupTidConfirmed && resolution.selectedTid !== tid) return resolution;
	const title = context.dictionary.titles.get(tid);
	if (!title) return resolution;
	const localMarkers = installmentMarkers([program.title, program.fullTitle].filter(Boolean).join(' '));
	const officialMarkers = installmentMarkers(title.title);
	if (Array.from(localMarkers).some(marker => !officialMarkers.has(marker))) return resolution;
	// Reuse the selection/EP rules to reject dictionary offsets and stronger
	// subtitle or schedule contradictions instead of inventing a new EP scheme.
	const preview = previewSelection(program, tid, context);
	if (!preview || preview.contradiction || !preview.titleCompatible ||
		!preview.episodeConfirmed || preview.episode !== episodes[0] ||
		['partial', 'exact-ambiguous'].includes(preview.subtitleStatus) ||
		preview.subtitleStatus === 'mismatch' && !preview.subtitlePresentation) return resolution;
	const subtitle = subtitleEvidence(program, tid, context.dictionary);
	const candidate = Object.assign({}, resolution.candidates.find(item => item.tid === tid) || {
		tid, score: 0, evidence: []
	}, {
		subtitle,
		evidence: (resolution.candidates.find(item => item.tid === tid)?.evidence || [])
			.concat('proglookup-unresolved-channel-time-title-episode'),
		prog: { pid: matches[0].pid, tid, chid: matches[0].chId, count: episodes[0] }
	});
	const result = Object.assign({}, resolution, {
		classification: 'confirmed', selectedTid: tid, tidConfirmed: true,
		tidConfirmationSource: 'proglookup-exploration',
		episodeConfirmed: true, multipleEpisodeConfirmed: false, episodeConfirmationSource: 'proglookup',
		candidateTids: Array.from(new Set(resolution.candidateTids.concat(tid))), competitiveTids: [tid],
		candidates: resolution.candidates.filter(item => item.tid !== tid).concat(candidate),
		proglookupStatus: 'unresolved-channel-time-title-episode', proglookupAvailability: 'covered-complete',
		proglookupTidConfirmed: true, proglookupEpisodeConfirmed: true,
		directPids: Array.from(new Set(matches.map(match => match.pid))),
		episodeRelation: subtitle.dictionaryEpisode === episodes[0] ? 'same-number' : 'epg-number-uncontradicted',
		reason: null, heldForSafety: false, metaTitle: null, subtitleComplement: false
	});
	result.episodeIdentity = describeEpisodeIdentity(result);
	return result;
}

function createSeriesResolver(options) {
	options = options || {};
	const ownsDictionary = !options.dictionary;
	const dictionary = options.dictionary || createDictionaryStore({ path: options.dictionaryPath });
	const context = {
		dictionary,
		channelMap: normalizeChannelMap(options.channelMap),
		progByStart: buildProgLookupIndex(options.progLookupItems),
		getProgLookupCoverage: options.getProgLookupCoverage
	};
	let titleSearchRows = null; // Immutable dictionary snapshot; discarded with this resolver on reload.
	return {
		resolve(program, index) {
			return evaluateProgram(program || {}, context, index);
		},
		resolveExploration(program, explorer, resolution) {
			return resolveExploration(program, explorer, resolution, context);
		},
		resolveAll(programs) {
			return (Array.isArray(programs) ? programs : []).map((program, index) =>
				evaluateProgram(program, context, index));
		},
		getDictionaryTitle(tid) {
			return dictionary.titles.get(Number(tid)) || null;
		},
		getDictionaryEpisode(tid, episode) {
			const number = Number(episode);
			if (!Number.isInteger(number) || number <= 0) return null;
			const episodes = dictionary.getEpisodes(Number(tid));
			return episodes.has(number) ? {
				episode: number,
				subtitle: episodes.get(number) || null
			} : null;
		},
		getDictionaryEpisodeNumbers(tid) {
			return Array.from(dictionary.getEpisodes(Number(tid)).keys()).sort((left, right) => left - right);
		},
		getDictionaryEpisodes(tid) {
			return Array.from(dictionary.getEpisodes(Number(tid)), ([episode, subtitle]) => ({
				episode,
				subtitle: subtitle || null
			})).sort((left, right) => left.episode - right.episode);
		},
		previewSelection(program, tid) {
			return previewSelection(program, tid, context);
		},
		searchDictionaryTitles(query, limit) {
			const normalized = normalizedText(query).toLowerCase();
			const compacted = compact(query);
			const spaced = String(query ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
			if (!normalized || !compacted) return [];
			const maximum = Math.min(Math.max(Number(limit) || 20, 1), 50);
			const results = new Map();
			function add(tid, rank, match) {
				const item = dictionary.titles.get(Number(tid));
				const previous = results.get(Number(tid));
				if (!item || previous && previous.rank <= rank) return;
				results.set(item.tid, { item, rank, match });
			}
			const numericTid = /^\d+$/u.test(normalized) ? Number(normalized) : null;
			if (Number.isInteger(numericTid) && dictionary.titles.has(numericTid)) add(numericTid, 0, 'tid');
			if (!titleSearchRows) titleSearchRows = Array.from(dictionary.titles.values(), item => ({
				item, normalizedTitle: normalizedText(item.title).toLowerCase(), compactTitle: compact(item.title),
				spacedTitle: String(item.title).normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
			}));
			for (const { item, normalizedTitle, compactTitle, spacedTitle } of titleSearchRows) {
				if (compactTitle === compacted) add(item.tid, 0, 'exact');
				else if (normalizedTitle.length >= 4 && spaced.startsWith(spacedTitle)) {
					const suffix = spaced.slice(spacedTitle.length);
					if (/^(?:\s+|[【\[（(<＜「『])/u.test(suffix)) add(item.tid, 1, 'decorated-prefix');
				} else if (normalizedTitle.startsWith(normalized) || compactTitle.startsWith(compacted)) {
					add(item.tid, 4, 'prefix');
				} else if (normalizedTitle.includes(normalized) || compactTitle.includes(compacted)) {
					add(item.tid, 5, 'partial');
				}
			}
			for (const [alias, tids] of dictionary.aliasIndex) {
				const aliasKey = compact(alias);
				let rank = null;
				if (aliasKey === compacted) rank = 2;
				else if (aliasKey.startsWith(compacted)) rank = 3;
				else if (aliasKey.includes(compacted)) rank = 6;
				if (rank !== null) for (const tid of tids) add(tid, rank, rank === 2 ? 'alias-exact' : 'alias');
			}
			return Array.from(results.values())
				.sort((left, right) => left.rank - right.rank || left.item.title.localeCompare(right.item.title, 'ja') || left.item.tid - right.item.tid)
				.slice(0, maximum).map(value => ({
					tid: value.item.tid,
					title: value.item.title,
					firstYear: value.item.firstYear || null,
					match: value.match
				}));
		},
		getDictionaryCounts() {
			return dictionary.counts();
		},
		close() {
			if (ownsDictionary) dictionary.close();
		}
	};
}

module.exports = {
	compact,
	broadcastServiceIdentity,
	createDictionaryStore,
	createSeriesResolver,
	describeEpisodeIdentity,
	hasExplicitInstallment,
	installmentIdentity,
	normalizedText,
	parseEpisodeNumbers,
	presentationSubtitle,
	reserveStart,
	seriesKey,
	suspiciousSubtitle,
	titleVariants,
	workIdentity
};
