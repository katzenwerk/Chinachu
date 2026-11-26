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
	// An EPG title may append #80 or 第80話 to an otherwise exact official title.
	const episodeFree = compact(undecoratedBroadcastTitle(raw));
	if (episodeFree && episodeFree !== variants[0][1]) {
		variants.push(['episode-removed', episodeFree]);
	}
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

// Preserve workIdentity's legacy keys for persisted rules. Only automatic matching uses these variants.
function broadcastTitlePart(value) {
	return String(value || '').split(/#\s*\d|(?:^|\s)第\s*\d+(?:\.\d+)?\s*話/u, 1)[0].trim();
}

function matchingTitleForms(program) {
	const text = [];
	for (const value of [program.title, program.fullTitle]) {
		const raw = broadcastTitlePart(String(value || '').replace(/[🈟🈡🈞🈑🈖🈚🈕]/gu, '').normalize('NFKC'));
		if (!raw) continue;
		let clean = raw.replace(/^(?:(?:[<【\[]アニメギルド[>】\]]|[【\[](?:[新終再無字解初]|再放送|(?:ドラマ|アニメ)(?:再放送|セレクション|劇場)?)[】\]])\s*)+/u, '');
		clean = undecoratedBroadcastTitle(clean);
		clean = clean.replace(/^アニメA[・･]?#?|^アニメ[・･\s]+/iu, '')
			.replace(/^日\d+「(.+)」$/u, '$1')
			.replace(/^『([^』]+)』(?=\s*(?:season|第?\d+期|$))/iu, '$1');
		clean = clean.replace(/^(.{2,32}?)セレクション\s+(.+)$/u, (whole, name, inner) =>
			compact(inner).startsWith(compact(name)) ? inner : whole);
		clean = clean.replace(/(?:デジタルリマスター(?:HD)?版|HDリマスター版)\s*$/iu, '')
			.replace(/\s*[<(【\[]\s*(?:HDリマスター(?:版)?|リマスター版|デジタルリマスター(?:HD)?版)\s*[>)】\]]\s*$/iu, '');
		clean = clean.replace(/\s*(?:全話(?:イッキ見|一挙(?:放送)?)|一挙放送|まとめて放送)[!\s]*[【\[][^】\]]*?(season\s*\d+|第\s*\d+\s*期)\s*[】\]]$/iu, ' $1');
		clean = clean.replace(/\s*(?:一挙放送|全話イッキ見|まとめて放送)[!\s]*$/u, '');
		text.push(compact(raw), compact(clean), compact(clean.replace(/\s+request\s*\d+\.?$/iu, '')));
		const episodeTypeFree = clean.replace(/\s+(?:特別編|スペシャル|SP)\s*$/iu, '');
		const withoutYear = episodeTypeFree.replace(/\s*(?:[【(\[]\s*(?:19|20)\d{2}(?:年(?:版)?)?\s*[】)\]]|(?:19|20)\d{2}年版)\s*$/u, '');
		text.push(compact(episodeTypeFree), compact(withoutYear));
	}
	return [...new Set(text.filter(Boolean))];
}

function createTitleMatcher(names) {
	const exact = new Map();
	const prefixes = new Map();
	for (const { id, name } of names) {
		const key = compact(name);
		if (!key) continue;
		addSet(exact, key, id);
		if (key.length >= 6) addSet(prefixes, key.slice(0, 6), key);
	}
	return program => {
		const found = new Map();
		const record = (key, type) => {
			for (const id of exact.get(key) || []) {
				const previous = found.get(id);
				const length = [...key].length;
				if (!previous || length > previous.length || length === previous.length && type === 'exact') {
					found.set(id, { key, length, type });
				}
			}
		};
		for (const key of matchingTitleForms(program)) if (exact.has(key)) record(key, 'exact');
		for (const value of new Set([program.title, program.fullTitle])) {
			// Keep word edges from the EPG before folding punctuation and spaces.
			let key = '';
			const edges = new Set([0]);
			const subtitleEdges = new Set();
			const title = broadcastTitlePart(String(value || '').replace(/[🈟🈡🈞🈑🈖🈚🈕]/gu, ' ').normalize('NFKC')).toLowerCase();
			for (const char of title) {
				if (/[\p{L}\p{N}]/u.test(char)) key += char;
				else if (!/[\u0300-\u036f]/u.test(char)) {
					edges.add(key.length);
					if (char === ':' || char === '：') subtitleEdges.add(key.length);
				}
			}
			edges.add(key.length);
			for (const start of edges) for (const candidate of prefixes.get(key.slice(start, start + 6)) || []) {
				const end = start + candidate.length;
				if (edges.has(end) && !subtitleEdges.has(end) && key.startsWith(candidate, start)) record(candidate, 'contained');
			}
		}
		return found;
	};
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
	const text = String(value ?? '').normalize('NFKC');
	const numbers = new Set();
	for (const match of text.matchAll(/(\d+(?:\.\d+)?)(?:\s*[-~〜]\s*#?(\d+(?:\.\d+)?))?/gu)) {
		const first = Number(match[1]), last = Number(match[2]);
		if (!Number.isFinite(first) || first <= 0) continue;
		if (!match[2]) numbers.add(first);
		else if (Number.isInteger(first) && Number.isInteger(last) && last >= first && last - first <= 100) {
			for (let number = first; number <= last; number++) numbers.add(number);
		}
	}
	return [...numbers];
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
	if (!options.disabled && !options.path) throw new TypeError('dictionary path is required');
	const db = options.disabled ? null : options.db || new DatabaseSync(options.path, { readOnly: true });
	db?.exec('PRAGMA query_only=ON');
	const titles = new Map();
	const lookupIndex = new Map();
	const aliasIndex = new Map();
	const titleKeysByTid = new Map();
	const seriesIndex = new Map();
	const episodeCache = new Map();
	const episodeLookupCache = new Map();
	const episodesStatement = db?.prepare(
		'SELECT episode, subtitle, lookup_key FROM episodes WHERE tid = ?'
	);
	const subtitleStatement = db?.prepare(
		'SELECT tid, episode, subtitle FROM episodes WHERE lookup_key = ? ORDER BY tid, episode'
	);

	for (const row of db?.prepare(
		'SELECT tid, title, lookup_key, short_title, first_year, first_month FROM titles'
	).all() || []) {
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
		addSet(titleKeysByTid, tid, row.lookup_key);
		for (const value of [row.title, row.short_title || '']) {
			const key = seriesKey(value);
			if (key.length >= 4) addSet(seriesIndex, key, tid);
		}
	}
	for (const row of db?.prepare('SELECT tid, lookup_key FROM aliases').all() || []) {
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
		for (const row of episodesStatement?.all(tid) || []) {
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
		aliasIndex,
		titleKeysByTid,
		seriesIndex,
		findEpisodesBySubtitle(lookupKey) {
			if (!lookupKey || !subtitleStatement) return [];
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
				db ? Number(db.prepare('SELECT COUNT(*) AS count FROM ' + table).get().count) : 0
			]));
		},
		close() {
			db?.close();
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
	const title = [program.title, program.fullTitle].map(value => broadcastTitlePart(String(value || '').normalize('NFKC'))).join(' ');
	const years = Array.from(title.matchAll(/(?<!\d)((?:19|20)\d{2})年(?:版|制作|製作|放送)|[【(\[]\s*((?:19|20)\d{2})(?:年(?:版)?)?\s*[】)\]]/gu),
		match => Number(match[1] || match[2]));
	if (years.length) return new Set(years);
	const detail = [program.detail, program.description].filter(Boolean).join('\n').normalize('NFKC');
	return new Set(Array.from(detail.matchAll(/^\s*(?:制作年|製作年)\s*[:：]?\s*((?:19|20)\d{2})年?\b/gmu),
		match => Number(match[1])));
}

function explicitEdition(program, work, matchedName, corroborated = false) {
	const year = programYears(program);
	if (year.size === 1 && work.firstYear && !year.has(Number(work.firstYear))) return false;
	const local = installmentMarkers([program.title, program.fullTitle].filter(Boolean).join(' '));
	const official = installmentMarkers(work.title);
	for (const marker of installmentMarkers(matchedName)) official.add(marker);
	if (work.season) official.add('season:' + work.season);
	for (const marker of local) {
		const sameKind = [...official].filter(value => value.split(':')[0] === marker.split(':')[0]);
		if (sameKind.length && !sameKind.includes(marker)) return false;
		if (!sameKind.length && marker.startsWith('season:') && !corroborated && !matchedName.endsWith(marker.split(':')[1])) return false;
	}
	const edition = value => String(value || '').normalize('NFKC').match(/実写(?:ドラマ)?版|アニメ版|劇場版/u)?.[0]?.replace('実写ドラマ版','実写版');
	const localEdition = edition([program.title, program.fullTitle].join(' '));
	const officialEdition = edition(work.title) || edition(matchedName);
	if (!localEdition) return true;
	if (officialEdition) return localEdition === officialEdition;
	return corroborated || localEdition === '実写版' && Boolean(work.source && work.source !== 'syobocal');
}

function installmentMarkers(value) {
	const key = String(value || '').normalize('NFKC');
	const markers = new Set();
	for (const match of key.matchAll(/season\s*(\d+)|(\d+)(?:st|nd|rd|th)\s*season/giu)) {
		markers.add('season:' + Number(match[1] || match[2]));
	}
	for (const match of key.matchAll(/(?:第\s*)?(\d+)\s*期|第\s*(\d+)\s*(?:シーズン|シリーズ)|シーズン\s*(\d+)/gu)) {
		markers.add('season:' + Number(match[1] || match[2] || match[3]));
	}
	for (const match of key.matchAll(/第\s*(\d+)\s*クール/gu)) markers.add('cour:' + Number(match[1]));
	return markers;
}

function corroboratedTitle(program, keys) {
	let best = null;
	for (const epg of matchingTitleForms(program)) for (const key of keys || []) {
		const shared = epg.includes(key) ? key : key.includes(epg) ? epg : '';
		const length = [...shared].length;
		if (length >= 4 && (!best || length > best.length)) {
			best = { key: shared, length, type: 'corroborated' };
		}
	}
	return best;
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

			result.evidence.push('subtitle-exact-ambiguous');
			return result;
		}
		const chosen = matchingEpg.length === 1 ? matchingEpg[0] : exactSubtitleEpisodes[0];
		result.dictionaryEpisode = chosen;
		result.dictionarySubtitle = dictionaryEpisodes.get(chosen) || null;
		result.subtitleStatus = normalizedText(dictionaryEpisodes.get(chosen)) === subtitle ?
			'exact' : 'notation-difference';

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

			result.evidence.push('subtitle-partial');
			return result;
		}
	}
	if (epgNumbers.length === 1 && dictionaryEpisodes.has(epgNumbers[0])) {
		const number = epgNumbers[0];
		result.dictionaryEpisode = number;
		result.dictionarySubtitle = dictionaryEpisodes.get(number);

		result.evidence.push('episode-number-present');
		result.subtitleStatus = !subtitle ? 'missing' : subtitleIsSuspicious ?
			'suspicious-non-subtitle' : 'mismatch';
	} else if (epgNumbers.length && epgNumbers.every(number => dictionaryEpisodes.has(number))) {
		result.subtitleStatus = 'range-present';

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
		Number.isFinite(number) && number > 0);
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
		const match = String(identity).match(/^(?:dict|prog|epg):(\d+(?:\.\d+)?)$/u);
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

function dramaEpisodeEvidence(program, work) {
	const numbers = parseEpisodeNumbers(program.episode);
	const entries = [...(work?.episodes.values() || [])];
	const epgSubtitle = compact(program.subTitle);
	const usableSubtitle = epgSubtitle && !suspiciousSubtitle(program) && !presentationSubtitle(program);
	const special = /(?:^|[\s【[(])(?:特別編|スペシャル|SP)(?:$|[\s】)\]#第]|\d)/iu.test(
		[program.title, program.fullTitle].join(' ').normalize('NFKC'));
	const kindEntries = entries.filter(entry => (entry.number === null) === special);
	const same = item => usableSubtitle && compact(item?.value) === epgSubtitle;
	const formal = kindEntries.filter(entry => same(entry.episode.subtitle));
	const alternatives = kindEntries.filter(entry => [entry.episode.subtitleCandidate, entry.episode.originalSubtitleCandidate,
		entry.episode.epgSubtitle, ...entry.episode.streamingSubtitles].some(same));
	const exact = formal.length ? formal : alternatives;
	const links = rows => rows.map(({ key, label }) => ({ key: 'ep:' + key, kind: 'episode', identity: key, label,
		refs: [key], status: 'same-episode-corroborated' }));
	const result = (rows, source, status) => ({ links: links(rows), source, status, formal: formal.length === 1 });
	const held = status => result([], null, status);
	if (special) {
		const label = compact([program.title, program.fullTitle].join(' '));
		const named = kindEntries.filter(entry => {
			const heading = compact(entry.episode.wikipedia?.label || '');
			return heading.length >= 4 && label.includes(heading);
		});
		const found = exact.length ? exact : named;
		const numbered = kindEntries.filter(entry => numbers.length === 1 && entry.episode.number === numbers[0]);
		const allowed = numbers.length ? (found.length ? found.filter(entry => numbered.includes(entry)) : numbered) : found;
		return allowed.length === 1 ? result(allowed, 'dictionary', 'special') : held('unresolved');
	}
	if (!numbers.length) return formal.length === 1 ? result(formal, 'dictionary', 'subtitle-exact') : held('unresolved');
	if (exact.length && !exact.some(entry => numbers.includes(entry.number))) return held('possible-fixed-offset-unverified');
	const floor = Math.min(...kindEntries.map(entry => entry.number));
	if (Number.isFinite(floor) && floor > 1 && hasExplicitInstallment(program) && numbers.every(number => number < floor)) {
		return held('possible-fixed-offset-unverified');
	}
	const resolved = numbers.map(number => kindEntries.find(entry => entry.number === number) ||
		(Number.isInteger(number) && number <= 100000 ? { key: 'normal:' + number, label: '第' + number + '話' } : null));
	if (resolved.some(entry => !entry)) return held(numbers.length > 1 ? 'range-conflict' : 'unresolved');
	return result(resolved, resolved.every(entry => entry.episode) ? 'dictionary' : 'epg',
		numbers.length > 1 ? 'multi-episode-confirmed' : 'same-number');
}

function evaluateProgram(program, context, index, historyId) {
	const dictionary = context.dictionary;
	const matches = context.matchTitles(program);
	const entries = new Map();
	function add(id, match, corroborated = false) {
		const tid = typeof id === 'number' ? id : null;
		const work = tid === null ? context.drama?.titles.get(id) : dictionary.titles.get(tid);
		if (!work || !explicitEdition(program, work, match?.key || '', corroborated)) return null;
		if (!entries.has(id)) entries.set(id, { id: tid === null ? id : 'syobocal:' + tid, tid, work, match,
			evidence: match ? ['title-' + match.type] : [], subtitle: null });
		return entries.get(id);
	}
	const promo = /(?:^|[\s「」【】\[\]])PR(?=$|[\s（(【】\[\]])/iu.test(String(program.title || '').normalize('NFKC'));
	for (const [id, match] of matches) {
		if (promo && match.type !== 'exact') continue;
		if (typeof id !== 'number' && program.category && !['drama', 'cinema', 'theater'].includes(program.category)) continue;
		add(id, match);
	}
	const subtitleReverse = subtitleReverseCandidates(program, dictionary);
	for (const tid of promo ? [] : subtitleReverse.tids) {
		if (!entries.has(tid)) {
			const match = corroboratedTitle(program, dictionary.titleKeysByTid.get(tid));
			if (match) add(tid, match);
		}
	}
	const baselineTids = new Set(dictionary.lookupIndex.get(compact(program.title)) || []);
	const scheduleItems = context.progByStart.get(reserveStart(program)) || [];
	const channel = program.channel || {};
	const mapping = context.channelMap.get(Number(channel.nid ?? -1) + ':' + Number(channel.sid ?? -1)) || null;
	const mappingChIds = channelIds(mapping);
	const directItems = scheduleItems.filter(item => mappingChIds.includes(item.chid));
	const proglookupAvailability = typeof context.getProgLookupCoverage === 'function' ?
		context.getProgLookupCoverage(program, mapping) : 'unknown';
	let scheduleConflict = false;
	const families = new Set(matchingTitleForms(program).map(seriesKey).filter(key => key.length >= 4));
	for (const item of directItems) {
		const compatible = entries.has(item.tid) || titleCompatibility(program, item.tid, dictionary) !== null ||
			families.has(seriesKey(dictionary.titles.get(item.tid)?.title));
		const entry = compatible ? add(item.tid, matches.get(item.tid), true) : null;
		if (!entry) { scheduleConflict = true; continue; }
		entry.prog = item;
		entry.evidence.push('proglookup-channel-' + mapping.status);
	}
	const directTids = new Set(directItems.map(item => item.tid));
	const uniqueDirectTid = directTids.size === 1 ? directTids.values().next().value : null;
	const directEntry = entries.get(uniqueDirectTid);
	const allChannels = mappingChIds.length <= 1 || proglookupAvailability === 'covered-complete' ||
		mappingChIds.every(chId => directItems.some(item => item.chid === chId));
	let proglookupTidConfirmed = Boolean(directEntry && allChannels && !scheduleConflict);
	const nums = parseEpisodeNumbers(program.episode);
	const directCounts = directItems.map(item => String(item.Count ?? '')).filter(value => /^\d+(?:\.\d+)?$/u.test(value)).map(Number);
	for (const [id, entry] of entries) {
		if (entry.tid === null) continue;
		const subtitle = subtitleEvidence(program, id, dictionary);
		entry.subtitle = subtitle;
		entry.evidence.push(...subtitle.evidence);
		if (subtitleReverse.tids.includes(id)) entry.evidence.push('subtitle-reverse');
		if (nums.length && dictionary.getEpisodes(id).size && !subtitle.registeredEpgNumbers.length) {
			entry.evidence.push('episode-number-absent');
		}
	}
	const episodeContradiction = directEntry?.evidence.includes('episode-number-absent') &&
		nums.length === 1 && directCounts.length && !directCounts.includes(nums[0]) && !directEntry.evidence.includes('subtitle-exact');
	const candidateContradiction = directEntry && mapping?.status !== 'verified' &&
		['mismatch', 'partial', 'exact-ambiguous'].includes(directEntry.subtitle.subtitleStatus);
	const canConfirmDirect = proglookupTidConfirmed && !episodeContradiction && !candidateContradiction;
	const ordered = [...entries.values()].filter(entry => entry.match || entry === directEntry && canConfirmDirect)
		.sort((a, b) => (b.match?.length || 0) - (a.match?.length || 0) || a.id.localeCompare(b.id, 'en'));
	let competitive = ordered.filter(entry => entry.match?.length === ordered[0]?.match?.length);
	const workEvidence = entry => {
		if (entry.tid !== null) return ['exact', 'notation-difference'].includes(entry.subtitle.subtitleStatus);
		entry.dramaEpisode = dramaEpisodeEvidence(program, context.drama.getWork(entry.id));
		return entry.dramaEpisode.formal && !entry.dramaEpisode.status.includes('unverified');
	};
	function narrow(predicate) {
		if (competitive.length < 2) return;
		const supported = competitive.filter(predicate);
		if (supported.length) competitive = supported;
	}
	let selected = null;
	let tidConfirmationSource = null;
	if (canConfirmDirect) {
		selected = directEntry;
		tidConfirmationSource = 'proglookup';
	} else if (!scheduleConflict && directTids.size <= 1 && !episodeContradiction && !candidateContradiction) {
		const years = programYears(program);
		if (years.size === 1) narrow(entry => years.has(Number(entry.work.firstYear)));
		const markers = installmentMarkers([program.title, program.fullTitle].join(' '));
		if (markers.size) narrow(entry => {
			const remote = installmentMarkers(entry.work.title);
			if (entry.work.season) remote.add('season:' + entry.work.season);
			return [...markers].every(marker => remote.has(marker));
		});
		narrow(workEvidence);
		// When the same known edition is indexed in both dictionaries, keep the existing TID.
		const official = competitive.filter(entry => entry.tid !== null);
		if (official.length === 1 && competitive.length > 1 && Number(official[0].work.firstYear) &&
			competitive.every(entry => entry.match?.key === official[0].match?.key &&
				Number(entry.work.firstYear) === Number(official[0].work.firstYear))) competitive = official;
		if (historyId && competitive.length > 1) narrow(entry => entry.id === historyId);
		if (competitive.length === 1 && (!directTids.size || directTids.has(competitive[0].tid))) {
			selected = competitive[0];
			tidConfirmationSource = historyId === selected.id ? 'confirmed-event-propagation' : ordered.length === 1 ? 'dictionary-single-title' :
				ordered[1]?.match?.length < selected.match?.length ? 'dictionary-longest-title' : 'dictionary-title-evidence';
		}
	}
	if (selected) competitive = [selected];
	const proglookupStatus = canConfirmDirect ? 'same-channel-time-same-tid' : directItems.length ?
		(scheduleConflict ? 'same-channel-time-title-conflict' : 'same-channel-time-ambiguous-tid') :
		scheduleItems.length ? (scheduleItems.some(item => entries.has(item.tid)) ?
			'time-title-only-channel-mismatch-or-unmapped' : 'time-only-title-mismatch') : 'no-proglookup-at-time';
	const classification = selected ? 'confirmed' : competitive.length > 1 ? 'multiple' : ordered.length ? 'likely' : 'no-candidate';
	const selectedTid = selected?.tid ?? null;
	const tidConfirmed = selectedTid !== null;
	proglookupTidConfirmed = proglookupTidConfirmed && selectedTid === uniqueDirectTid;
	const dramaEpisode = selected && selected.tid === null ?
		(selected.dramaEpisode || dramaEpisodeEvidence(program, context.drama.getWork(selected.id))) : null;
	let episodeRelation = 'unresolved';
	let proglookupEpisodeConfirmed = false;
	let episodeConfirmationSource = null;
	let subtitleDecision = 'indeterminate';
	let subtitleComplement = false;
	let metaTitle = null;
	if (selectedTid !== null) {
		const top = selected;
		const subtitle = top.subtitle;
		const epgNumbers = subtitle.epgNumbers;
		const rawCount = String(top.prog?.Count ?? '');
		const progCount = /^\d+(?:\.\d+)?$/u.test(rawCount) ? Number(rawCount) : null;
		const dictionaryEpisode = subtitle.dictionaryEpisode;
		const installmentOffsetConflict = hasExplicitInstallment(program) &&
			subtitle.dictionaryEpisodeFloor !== null && subtitle.dictionaryEpisodeFloor > 1 &&
			epgNumbers.length > 0 && epgNumbers.every(number => number < subtitle.dictionaryEpisodeFloor) &&
			dictionaryEpisode === null;
		if (epgNumbers.length === 1 && dictionaryEpisode === epgNumbers[0]) {
			episodeRelation = 'same-number';
		} else if (epgNumbers.length <= 1 && subtitleReverse.uniqueTid === selectedTid &&
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
	const selectedSubtitleStatus = selected?.subtitle?.subtitleStatus;
	const resultEpisodeNumbers = parseEpisodeNumbers(program.episode);
	const episodeConfirmed = tidConfirmed && selectedTid !== null && !scheduleConflict && resultEpisodeNumbers.length <= 1 &&
		(resultEpisodeNumbers.length === 1 || subtitleReverse.uniqueEpisode !== null) &&
		(proglookupEpisodeConfirmed || ['same-number', 'season-to-series-verified', 'subtitle-reverse-exact',
			'epg-number-uncontradicted'].includes(episodeRelation));
	const selectedSubtitle = selected?.subtitle;
	const multipleEpisodeConfirmed = Boolean(tidConfirmed && selectedTid !== null && !scheduleConflict &&
		resultEpisodeNumbers.length > 1 && ['range-complete', 'range-epg-uncontradicted'].includes(episodeRelation) &&
		resultEpisodeNumbers.every(number => Number.isFinite(number) && number > 0));
	if (episodeConfirmed) {
		episodeConfirmationSource = ['same-number', 'season-to-series-verified', 'subtitle-reverse-exact'].includes(episodeRelation) ?
			'dictionary' : proglookupEpisodeConfirmed ? 'proglookup' : 'epg';
	} else if (multipleEpisodeConfirmed) {
		episodeConfirmationSource = episodeRelation === 'range-complete' ? 'dictionary' : 'epg';
	}
	const reason = classification === 'no-candidate' ? 'title-not-in-dictionary' :
		classification === 'multiple' ? 'equal-longest-match' :
		classification === 'likely' ? 'conflicting-broadcast-evidence' :
		scheduleConflict ? 'channel-time-candidate-conflicts-with-title' : null;
	const result = {
		index,
		id: program.id || program.programId || null,
		program,
		classification,
		selectedTid,
		tidConfirmed,
		tidConfirmationSource,
		episodeConfirmed: dramaEpisode ? dramaEpisode.links.length === 1 : episodeConfirmed,
		multipleEpisodeConfirmed: dramaEpisode ? dramaEpisode.links.length > 1 : multipleEpisodeConfirmed,
		episodeConfirmationSource: dramaEpisode ? dramaEpisode.source : episodeConfirmationSource,
		selectedSeriesId: selected?.id || null,
		workConfirmed: Boolean(selected),
		candidateSeriesIds: ordered.map(entry => entry.id),
		competitiveSeriesIds: competitive.map(entry => entry.id),
		dramaEpisode,
		candidateTids: ordered.filter(entry => entry.tid !== null).map(entry => entry.tid),
		relatedTids: [...new Set(matchingTitleForms(program).flatMap(key => [...(dictionary.seriesIndex.get(seriesKey(key)) || [])]))]
			.filter(tid => explicitEdition(program, dictionary.titles.get(tid), '')),
		competitiveTids: competitive.filter(entry => entry.tid !== null).map(entry => entry.tid),
		candidates: ordered.map(entry => ({
			id: entry.id, tid: entry.tid, title: entry.work.title, firstYear: entry.work.firstYear || null,
			season: entry.work.season || null, source: entry.work.source || 'syobocal',
			match: entry.match || null, evidence: entry.evidence, subtitle: entry.subtitle,
			prog: entry.prog ? { pid: entry.prog.PID, tid: entry.prog.tid, chid: entry.prog.chid,
				count: /^\d+(?:\.\d+)?$/u.test(entry.prog.Count ?? '') ? Number(entry.prog.Count) : null } : null
		})),
		baselineSingle: baselineTids.size === 1,
		baselineCount: baselineTids.size,
		subtitleReverse: {
			status: subtitleReverse.status,
			tids: subtitleReverse.tids,
			uniqueTid: subtitleReverse.uniqueTid,
			uniqueEpisode: subtitleReverse.uniqueEpisode
		},
		workIdentity: workIdentity(program),
		mapping,
		directPids: directItems.map(item => item.PID),
		scheduleConflict: scheduleConflict || directTids.size > 1 || Boolean(episodeContradiction || candidateContradiction),
		metaTitle,
		subtitleComplement,
		reason,
		proglookupStatus,
		proglookupAvailability,
		proglookupTidConfirmed,
		proglookupEpisodeConfirmed,
		episodeRelation: dramaEpisode?.status || episodeRelation,
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
		tid, id: 'syobocal:' + tid, evidence: []
	}, {
		subtitle,
		evidence: (resolution.candidates.find(item => item.tid === tid)?.evidence || [])
			.concat('proglookup-unresolved-channel-time-title-episode'),
		prog: { pid: matches[0].pid, tid, chid: matches[0].chId, count: episodes[0] }
	});
	const result = Object.assign({}, resolution, {
		classification: 'confirmed', selectedTid: tid, tidConfirmed: true, selectedSeriesId: 'syobocal:' + tid, workConfirmed: true,
		dramaEpisode: null,
		tidConfirmationSource: 'proglookup-exploration',
		episodeConfirmed: true, multipleEpisodeConfirmed: false, episodeConfirmationSource: 'proglookup',
		candidateTids: Array.from(new Set(resolution.candidateTids.concat(tid))), competitiveTids: [tid],
		candidateSeriesIds: [...new Set([...(resolution.candidateSeriesIds || []), 'syobocal:' + tid])],
		competitiveSeriesIds: ['syobocal:' + tid],
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
	const drama = options.drama || null;
	const names = Array.from(dictionary.titleKeysByTid, ([id, keys]) => [...keys].map(name => ({ id, name }))).flat();
	const context = {
		dictionary, drama, matchTitles: createTitleMatcher(drama ? names.concat(drama.names) : names),
		channelMap: normalizeChannelMap(options.channelMap),
		progByStart: buildProgLookupIndex(options.progLookupItems),
		getProgLookupCoverage: options.getProgLookupCoverage
	};
	let titleSearchRows = null; // Immutable dictionary snapshot; discarded with this resolver on reload.
	return {
		compatibleWork(program, work) { return explicitEdition(program, work, compact(work.title)); },
		resolveWithHistory(program, id) { return evaluateProgram(program, context, undefined, id); },
		resolveDramaEpisodes(program, id) { return dramaEpisodeEvidence(program, drama?.getWork(id)); },
		getDramaWork(id) { return drama?.getWork(id) || null; },
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
		searchDictionaryTitles(query, limit, page) {
			const normalized = normalizedText(query).toLowerCase();
			const compacted = compact(query);
			const spaced = String(query ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
			if ((!normalized || !compacted) && page === undefined) return [];
			const pageNumber = page === undefined ? 1 : Number(page);
			if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) throw Object.assign(new Error('ページ指定が不正です'), { statusCode: 400 });
			const maximum = Math.min(Math.max(Number(limit) || 20, 1), 50);
			const results = new Map();
			function add(tid, rank, match) {
				const item = dictionary.titles.get(Number(tid));
				const previous = results.get(Number(tid));
				if (!item || previous && previous.rank <= rank) return;
				results.set(item.tid, { item, rank, match });
			}
			if (!normalized || !compacted) {
				for (const item of dictionary.titles.values()) add(item.tid, 0, 'browse');
			} else {
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
			}
			const sorted = Array.from(results.values())
				.sort((left, right) => left.rank - right.rank || left.item.title.localeCompare(right.item.title, 'ja') || left.item.tid - right.item.tid);
			const rows = sorted.slice((pageNumber - 1) * maximum, pageNumber * maximum).map(value => ({
					tid: value.item.tid,
					title: value.item.title,
					firstYear: value.item.firstYear || null,
					match: value.match
				}));
			return page === undefined ? rows : { results: rows, pagination: { page: pageNumber, pageSize: maximum,
				total: sorted.length, totalPages: Math.ceil(sorted.length / maximum), hasMore: pageNumber * maximum < sorted.length } };
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
