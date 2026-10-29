'use strict';

const fs = require('fs');

const SOURCE_KIND = 'syobocal-official-independent';

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

function resultCode(source, rootName) {
	if (!new RegExp('<' + rootName + '(?:\\s|>)', 'iu').test(source) ||
		!new RegExp('<\\/' + rootName + '>\\s*$', 'iu').test(source)) {
		throw Object.assign(new Error(rootName + ' XML root was not found'), { code: 'invalid-xml' });
	}
	const result = source.match(/<Result(?:\s[^>]*)?>([\s\S]*?)<\/Result>/iu);
	const code = result ? tagText(result[1], 'Code') : '';
	if (code !== '200' && code !== '404') {
		throw Object.assign(new Error(tagText(source, 'Message') || rootName + ' returned Result/Code=' + (code || 'unknown')), {
			code: 'api-result-error', resultCode: code || null
		});
	}
	return code;
}

function parseItems(xml, rootName, itemName, fields) {
	const source = String(xml || '').replace(/^\uFEFF/u, '');
	if (resultCode(source, rootName) === '404') return [];
	const items = [];
	const pattern = new RegExp('<' + itemName + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + itemName + '>', 'giu');
	let match;
	while ((match = pattern.exec(source)) !== null) {
		const item = {};
		for (const field of fields) item[field] = tagText(match[1], field);
		items.push(item);
	}
	return items;
}

function parseChLookupXml(xml) {
	return parseItems(xml, 'ChLookupResponse', 'ChItem', ['ChID', 'ChName', 'ChiEPGName', 'ChGID', 'LastUpdate'])
		.map(item => ({
			chId: Number(item.ChID),
			chName: item.ChName,
			chiEpgName: item.ChiEPGName,
			chGroupId: Number(item.ChGID) || null,
			lastUpdate: item.LastUpdate
		})).filter(item => Number.isInteger(item.chId) && item.chId > 0);
}

function parseChGroupLookupXml(xml) {
	return parseItems(xml, 'ChGroupLookupResponse', 'ChGroupItem',
		['ChGID', 'ChGroupName', 'ChGroupComment', 'ChGroupOrder', 'LastUpdate'])
		.map(item => ({
			chGroupId: Number(item.ChGID),
			name: item.ChGroupName,
			comment: item.ChGroupComment,
			order: Number(item.ChGroupOrder),
			lastUpdate: item.LastUpdate
		})).filter(item => Number.isInteger(item.chGroupId) && item.chGroupId > 0);
}

function parseTitleLookupXml(xml) {
	return parseItems(xml, 'TitleLookupResponse', 'TitleItem', ['TID', 'Title'])
		.map(item => [Number(item.TID), item.Title])
		.filter(item => Number.isInteger(item[0]) && item[0] > 0 && item[1]);
}

function normalizeName(value) {
	return String(value || '').normalize('NFKC').toLocaleLowerCase('ja-JP')
		.replace(/[\s\u3000・･:：;；,，.．\-‐‑‒–—―_／/\\()[\]{}【】「」『』<>＜＞'"“”‘’!！?？]+/gu, '');
}

function normalizeTitle(value) {
	return String(value || '').normalize('NFKC')
		.replace(/[\u{1F100}-\u{1F1FF}]/gu, ' ')
		.replace(/(?:\s*(?:第\s*\d+\s*話|[#＃]\s*\d+(?:\s*[,、・／~-]\s*\d+)*))\s*$/u, '')
		.toLocaleLowerCase('ja-JP').replace(/[\s\u3000・･:：;；,，.．\-‐‑‒–—―_／/\\()[\]{}【】「」『』<>＜＞'"“”‘’!！?？]+/gu, '');
}

// ChID and service IDs are input data, never an answer table.
const ALGORITHM_VERSION = 7;
const TIME_TOLERANCE_MS = 5 * 60 * 1000;
const MIN_CONTENT_MATCHES = 2;

function integer(value, minimum) {
	if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/u.test(value))) return null;
	const number = Number(value);
	return Number.isSafeInteger(number) && number >= minimum ? number : null;
}

function serviceIdentity(channel) {
	const nid = integer(channel && channel.nid, 0);
	const sid = integer(channel && channel.sid, 1);
	return nid !== null && sid !== null ? nid + ':' + sid : null;
}

function channelNames(channel) {
	return [channel && channel.chName, channel && channel.chiEpgName]
		.map(normalizeName).filter(Boolean);
}

function channelGroupType(group) {
	const name = String(group && group.name || '').normalize('NFKC').trim();
	if (/4K|8K/iu.test(name)) return '4K8K';
	if (name === '\u0042\u0053\u30c7\u30b8\u30bf\u30eb' || name === 'BS\u30a2\u30ca\u30ed\u30b0/\u30c7\u30b8\u30bf\u30eb') return 'BS';
	if (name === '\u30b9\u30ab\u30d1\u30fc') return 'CS';
	if (/^\u30c6\u30ec\u30d3 (?:\u95a2\u6771|\u8fd1\u757f|\u6771\u6d77|\u4e2d\u56fd|\u5317\u6d77\u9053|\u4e5d\u5dde|\u6771\u5317|\u7532\u4fe1\u8d8a|\u56db\u56fd|\u5317\u9678|\u6c96\u7e04)$/u.test(name)) return 'GR';
	// A national grouping is not itself a transmission standard.
	return null;
}

function serviceBranch(value) {
	const match = String(value || '').normalize('NFKC').trim().match(/^(.*?)[\u30fb\uff65]\s*(\d{2,3})$/u);
	return match && normalizeName(match[1]) ? { base: normalizeName(match[1]), branch: Number(match[2]) } : null;
}

function primaryServiceName(value) {
	const normalized = normalizeName(value);
	const match = normalized.match(/^(.*?)([1-9])$/u);
	if (!match || !match[1] || !(/[\u3040-\u30ff\u3400-\u9fff]/u.test(match[1]) || /^[a-z]{3,}$/u.test(match[1]))) return null;
	return { base: match[1], number: Number(match[2]) };
}

function englishAbbreviation(value, local) {
	const name = normalizeName(value);
	const match = name.match(local ? /^([a-z]{3,})(?:1)?$/u : /^([a-z]{3,})/u);
	return match ? match[1] : null;
}

function japaneseStationName(value, local) {
	let name = normalizeName(value);
	if (local) {
		if (!/^[\u3040-\u30ff\u3400-\u9fff]/u.test(name)) return null;
		const suffix = primaryServiceName(value);
		if (suffix && suffix.number === 1) name = suffix.base;
	} else {
		const match = name.match(/^[a-z]{3,}([\u3040-\u30ff\u3400-\u9fff].*)$/u);
		if (!match) return null;
		name = match[1];
	}
	return name || null;
}

function comparableChannelName(value) {
	let name = String(value || '').normalize('NFKC');
	// Expand a channel abbreviation, not arbitrary letters inside an English word.
	name = name.replace(/(^|[^a-zA-Z])(?:ch|CH)(?=[A-Z]{2,}(?:$|[^a-zA-Z]))/gu, '$1\u30c1\u30e3\u30f3\u30cd\u30eb');
	name = name.replace(/([\u3040-\u30ff\u3400-\u9fff])ch$/iu, '$1\u30c1\u30e3\u30f3\u30cd\u30eb');
	return normalizeName(name);
}

function numberedBrand(value) {
	const match = normalizeName(value).match(/^([a-z]+\d+)(.*)$/u);
	return match ? { base: match[1], rest: match[2] } : null;
}

function nameRelation(channel, official, group) {
	const localName = String(channel && channel.name || '');
	const local = normalizeName(localName);
	if (!local) return null;
	const names = [official.chName, official.chiEpgName].filter(Boolean);
	const localBranch = serviceBranch(localName);
	const officialBranch = serviceBranch(official.chName);
	const sid = integer(channel.sid, 1);
	// An explicit service number in the current official name overrides an old alias.
	if ((localBranch && sid !== null && localBranch.branch !== sid) ||
		(officialBranch && sid !== null && officialBranch.branch !== sid) ||
		(localBranch && officialBranch && localBranch.branch !== officialBranch.branch)) return null;
	const localSuffix = primaryServiceName(localName);
	const officialSuffix = primaryServiceName(official.chName);
	if (localSuffix && officialSuffix && localSuffix.base === officialSuffix.base &&
		localSuffix.number !== officialSuffix.number) return null;
	const relation = (nameMatch, nameStrength) => ({ nameMatch, nameStrength });
	if (channelNames(official).includes(local)) return relation('exact', 'identity');
	const comparableLocal = comparableChannelName(localName);
	if (names.some(name => comparableChannelName(name) === comparableLocal)) return relation('channel-token', 'identity');
	if (localBranch && sid !== null && localBranch.branch === sid) {
		for (const name of names) {
			const branch = serviceBranch(name);
			if (branch && branch.base === localBranch.base && branch.branch === sid) return relation('service-branch', 'identity');
			if (normalizeName(name) === localBranch.base) return relation('service-base', 'identity');
		}
	}
	if (localSuffix && localSuffix.number === 1 && channelNames(official).includes(localSuffix.base)) {
		return relation('service-suffix', ['GR', 'BS'].includes(String(channel.type || '').toUpperCase()) ? 'identity' : 'evidence');
	}
	const abbreviation = englishAbbreviation(localName, true);
	if (abbreviation && names.some(name => englishAbbreviation(name, false) === abbreviation)) {
		return relation('abbreviation', 'identity');
	}
	const japaneseName = japaneseStationName(localName, true);
	if (japaneseName && names.some(name => japaneseStationName(name, false) === japaneseName)) {
		return relation('japanese', 'identity');
	}
	// The official catalog, rather than a list of NHK names, supplies the base name.
	if (normalizeName(group && group.name) === '\u30c6\u30ec\u30d3\u5168\u56fd' && String(channel.type || '').toUpperCase() === 'GR') {
		for (const name of channelNames(official)) {
			if (name.length < 4 || !local.startsWith(name)) continue;
			const tail = local.slice(name.length);
			if (/^(?:1)?[\u3040-\u30ff\u3400-\u9fff]{2,}$/u.test(tail)) return relation('national-regional-service', 'evidence');
		}
	}
	const brand = numberedBrand(localName);
	if (brand && brand.rest && names.some(name => {
		const other = numberedBrand(name);
		return other && other.base === brand.base;
	})) return relation('numbered-brand', 'evidence');
	for (const name of names) {
		const comparableOfficial = comparableChannelName(name);
		if (Math.min(comparableLocal.length, comparableOfficial.length) >= 6 &&
			(comparableLocal.includes(comparableOfficial) || comparableOfficial.includes(comparableLocal))) {
			return relation('name-containment', 'evidence');
		}
	}
	return null;
}

function selectCandidates(channel, officialChannels, channelGroups, includeDifferentGroup) {
	const groups = new Map((Array.isArray(channelGroups) ? channelGroups : []).map(group => [Number(group.chGroupId), group]));
	const candidates = new Map();
	const localType = String(channel && channel.type || '').toUpperCase();
	for (const official of Array.isArray(officialChannels) ? officialChannels : []) {
		const chId = integer(official && official.chId, 1);
		if (chId === null) continue;
		const group = groups.get(Number(official.chGroupId));
		const groupType = channelGroupType(group);
		// 4K/8K is outside this PoC. Other group/type differences are only a
		// constraint of the legacy path, not a veto on an independent name hit.
		if (groupType === '4K8K' || /(?:4k|8k)/iu.test(String(official.chName || ''))) continue;
		const groupTypeMismatch = !!(groupType && ['GR', 'BS', 'CS'].includes(localType) && groupType !== localType);
		if (groupTypeMismatch && !includeDifferentGroup) continue;
		const relation = nameRelation(channel, official, group);
		if (!relation) continue;
		candidates.set(chId, Object.assign({
			chId, chName: String(official.chName || ''), chiEpgName: String(official.chiEpgName || ''),
			chGroupId: integer(official.chGroupId, 1), chGroupName: group ? group.name : null, groupType
		}, groupTypeMismatch ? { groupTypeMismatch: true } : {}, relation));
	}
	const result = Array.from(candidates.values()).sort((a, b) => a.chId - b.chId);
	// Exact names/aliases outrank weak substring and brand-family searches. Tied
	// exact aliases remain tied: a smaller ChID or a primary spelling is no vote.
	const exact = result.filter(item => ['exact', 'channel-token', 'service-branch'].includes(item.nameMatch));
	if (exact.length) return exact;
	const identity = result.filter(item => item.nameStrength === 'identity');
	return identity.length ? identity : result;
}

function candidateChannels(name, officialChannels) {
	const candidates = selectCandidates({ name }, officialChannels, []);
	const types = new Set(candidates.map(item => item.nameMatch));
	return { type: types.size === 1 ? candidates[0].nameMatch : 'structured', candidates };
}

function mergeCandidates(primary, supplementary) {
	const byId = new Map(primary.map(item => [item.chId, item]));
	for (const item of supplementary) {
		if (!byId.has(item.chId)) byId.set(item.chId, item);
	}
	return Array.from(byId.values()).sort((a, b) => a.chId - b.chId);
}

function acquisitionCandidates(channel, _matched, officialChannels, channelGroups) {
	// Keep the previously eligible candidates, and also expose candidates whose
	// official ChGID differs from Mirakurun's type. The latter can be explored
	// without weakening the established verification path.
	const established = selectCandidates(channel, officialChannels, channelGroups);
	const supplementary = selectCandidates(channel, officialChannels, channelGroups, true);
	return mergeCandidates(established, supplementary);
}

function syobocalTime(value) {
	const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/u);
	if (!match) return null;
	const parts = match.slice(1).map(Number);
	const utc = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
	const date = new Date(utc);
	if (date.getUTCFullYear() !== parts[0] || date.getUTCMonth() !== parts[1] - 1 || date.getUTCDate() !== parts[2] ||
		date.getUTCHours() !== parts[3] || date.getUTCMinutes() !== parts[4] || date.getUTCSeconds() !== parts[5]) return null;
	return utc - 9 * 60 * 60 * 1000;
}

function mergeIntervals(intervals) {
	const result = [];
	for (const interval of intervals.slice().sort((a, b) => a.start - b.start || a.end - b.end)) {
		const last = result[result.length - 1];
		if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
		else result.push({ start: interval.start, end: interval.end });
	}
	return result;
}

function covers(intervals, start, end) {
	return intervals.some(interval => interval.start <= start && interval.end >= end);
}

function completeCoverage(coverage, chId) {
	return mergeIntervals((Array.isArray(coverage) ? coverage : []).filter(entry =>
		entry && ['full', 'backfill'].includes(entry.kind) && Array.isArray(entry.chIds) && entry.chIds.map(Number).includes(chId) &&
		Number.isFinite(entry.startMs) && Number.isFinite(entry.endMs) && entry.endMs > entry.startMs)
		.map(entry => ({ start: entry.startMs, end: entry.endMs })));
}

function subtitleKey(value) {
	return normalizeName(String(value || '').replace(/[\u{1F100}-\u{1F1FF}]/gu, ' '));
}

function informativeSubtitle(value) {
	const normalized = String(value || '').normalize('NFKC').trim();
	const key = subtitleKey(normalized);
	if (key.length < 4 || /^(?:[#\d\s,\u3001\u30fb/\u301c~\-]+|\u7b2c?\d+\u8a71|\u672a\u5b9a|\u30b5\u30d6\u30bf\u30a4\u30c8\u30eb\u672a\u5b9a|\u653e\u9001\u4f11\u6b62|\u7dcf\u96c6\u7de8)$/u.test(normalized)) return null;
	return key;
}

function workTitleParts(value, episode) {
	let source = String(value || '').normalize('NFKC')
		.replace(/[\u{1F100}-\u{1F1FF}]/gu, ' ').trim();
	// Broadcast-slot labels are not part of the work title. Require a
	// separator so names starting with the same characters stay intact.
	source = source.replace(/^(?:\u30df\u30cb\u30a2\u30cb\u30e1|\u30a2\u30cb\u30e1)\s+/u, '').trim();
	// Quoted text at the end of an EPG title is episode information. Do not
	// remove an internal quotation or a title consisting only of a quote.
	if (/\S\s*[\u300c\u300e]/u.test(source)) {
		source = source.replace(/(?:\s*[\u300c\u300e][^\u300d\u300f]+[\u300d\u300f])+\s*$/u, '').trim();
	}
	const number = integer(episode, 1);
	if (number !== null) {
		const trailing = source.match(/\(\s*(\d+)\s*\)\s*$/u);
		if (trailing && Number(trailing[1]) === number) source = source.slice(0, trailing.index).trim();
	}
	// A season is a separate attribute. Removing it must not remove brand
	// numbers (e.g. BS10) or a number occurring within a work title.
	const season = /(?:\(\s*(?:\u7b2c\s*(\d+)\s*(?:\u671f|\u30b7\u30ea\u30fc\u30ba|\u30b7\u30fc\u30ba\u30f3)|(?:season|\u30b7\u30fc\u30ba\u30f3)\s*(\d+))\s*\)|\s+(?:\u7b2c\s*(\d+)\s*(?:\u671f|\u30b7\u30ea\u30fc\u30ba|\u30b7\u30fc\u30ba\u30f3)|(?:season|\u30b7\u30fc\u30ba\u30f3)\s*(\d+)))\s*$/iu.exec(source);
	let installment = null;
	if (season) {
		installment = Number(season.slice(1).find(Boolean));
		source = source.slice(0, season.index).trim();
	}
	return { base: normalizeTitle(source), installment };
}

function titleComparison(local, officialTitle) {
	const official = workTitleParts(officialTitle);
	const locals = [local.title, local.fullTitle].map(value => workTitleParts(value, local.episode))
		.filter(value => value.base);
	if (!official.base || !locals.length) return 'missing';
	const sameBase = locals.filter(value => value.base === official.base);
	if (sameBase.length) {
		const seasons = new Set(sameBase.map(value => value.installment).filter(value => value !== null));
		if (seasons.size > 1 || (official.installment !== null && seasons.size && !seasons.has(official.installment))) {
			return 'different';
		}
		// If only one side has a season label, it is a possible match, not
		// proof of the same installment and not a title contradiction.
		return (official.installment === null && !seasons.size) ||
			(official.installment !== null && seasons.has(official.installment)) ? 'exact' : 'compatible';
	}
	// Program-slot descriptions sometimes extend a work title. This is
	// weaker than title identity and requires subtitle/episode confirmation.
	const related = locals.some(value => official.base.length >= 6 && value.base.startsWith(official.base) &&
		(official.installment === null || value.installment === null || value.installment === official.installment));
	return related ? 'contained' : 'different';
}

function compareContent(local, official, titles) {
	const officialTitle = titles.get(Number(official.TID));
	const titleMatch = titleComparison(local, typeof officialTitle === 'string' ? officialTitle : '');
	const episode = integer(local.episode, 1);
	const count = integer(official.Count, 1);
	const episodeMatch = episode === null || count === null ? 'missing' : episode === count ? 'exact' : 'different';
	const sub = informativeSubtitle(official.SubTitle || official.STSubTitle);
	const full = subtitleKey(local.fullTitle);
	const parsedSub = informativeSubtitle(local.subTitle);
	const parsedTitle = subtitleKey(local.title);
	const quoted = [];
	const quotePattern = /[\u300c\u300e]([^\u300d\u300f]+)[\u300d\u300f]/gu;
	let quote;
	while ((quote = quotePattern.exec(String(local.fullTitle || ''))) !== null) {
		const key = informativeSubtitle(quote[1]);
		if (key && key !== parsedTitle) quoted.push(key);
	}
	// A subtitle guessed from a synopsis is not reliable negative evidence.
	const reliableSub = parsedSub && full.includes(parsedSub) && parsedSub !== parsedTitle ? parsedSub : null;
	const subtitleMatch = !sub ? 'missing' : full.includes(sub) || reliableSub === sub || quoted.includes(sub) ? 'exact' :
		(reliableSub || quoted.length) ? 'different' : 'missing';
	const conflicts = [];
	if (titleMatch === 'different') conflicts.push('title');
	if (episodeMatch === 'different') conflicts.push('episode');
	if (subtitleMatch === 'different') conflicts.push('subtitle');
	// Neither a matching episode number nor a shared work-family title with
	// an unknown season establishes work identity on its own. A genuine
	// title/season mismatch is never overridden by a subtitle match.
	const supported = !conflicts.length && (titleMatch === 'exact' ||
		(['compatible', 'contained'].includes(titleMatch) &&
			(subtitleMatch === 'exact' || episodeMatch === 'exact')) ||
		(titleMatch === 'missing' && subtitleMatch === 'exact'));
	return { titleMatch, episodeMatch, subtitleMatch, conflicts, supported,
		contentKey: [official.TID, count === null ? '' : count, sub || ''].join(':') };
}

function uniqueProgramItems(items) {
	const rows = new Map();
	for (const item of Array.isArray(items) ? items : []) {
		if (!item || integer(item.ChID, 1) === null || integer(item.TID, 1) === null) continue;
		const key = String(item.PID || [item.ChID, item.TID, item.StTime, item.EdTime, item.Count].join('|'));
		const previous = rows.get(key);
		if (!previous || Number(item.Revision || 0) > Number(previous.Revision || 0) ||
			(Number(item.Revision || 0) === Number(previous.Revision || 0) && String(item.LastUpdate || '') >= String(previous.LastUpdate || ''))) rows.set(key, item);
	}
	return Array.from(rows.values()).filter(item => !Number(item.Deleted || 0));
}

function programEvidence(channel, chId, items, titles, coverage) {
	const localPrograms = (Array.isArray(channel.programs) ? channel.programs : [])
		.filter(item => item && Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start);
	const intervals = mergeIntervals(localPrograms.map(item => ({ start: item.start, end: item.end })));
	const covered = completeCoverage(coverage, chId);
	const rows = items.filter(item => Number(item.ChID) === chId);
	const result = {
		availability: rows.length ? 'has-records' : intervals.length && intervals.every(interval => covers(covered, interval.start, interval.end)) ? 'covered-empty' : 'not-covered',
		availablePrograms: rows.length, timeCompared: 0, timeMatches: 0, nearTimeMatches: 0,
		outsideSchedule: 0, scheduleGaps: 0, invalidTimes: 0, ambiguousTimes: 0,
		exact: 0, partial: 0, episodeCompared: 0, episodeMatches: 0,
		subtitleCompared: 0, subtitleMatches: 0, contentMatches: 0, distinctContentMatches: 0,
		contradictions: 0, missingTitles: 0, matchedTids: [], matches: []
	};
	const tids = new Set();
	const contentKeys = new Set();
	const supportedLocalSlots = new Set();
	for (const item of rows) {
		const start = syobocalTime(item.StTime);
		const end = syobocalTime(item.EdTime);
		if (start === null || end === null || end <= start) { result.invalidTimes++; continue; }
		if (!covers(intervals, start, end)) {
			if (!intervals.length || start < intervals[0].start || end > intervals[intervals.length - 1].end) result.outsideSchedule++;
			else result.scheduleGaps++;
			continue;
		}
		result.timeCompared++;
		const exact = localPrograms.filter(local => local.start === start && local.end === end);
		const near = exact.length ? exact : localPrograms.filter(local =>
			Math.abs(local.start - start) <= TIME_TOLERANCE_MS && Math.abs(local.end - end) <= TIME_TOLERANCE_MS);
		// Do not count duplicate EPG rows at one airing as extra evidence.
		const unique = new Map(near.map(local => [JSON.stringify([local.start, local.end, local.title, local.fullTitle, local.episode, local.subTitle]), local]));
		if (unique.size > 1) { result.ambiguousTimes++; continue; }
		if (!unique.size) continue;
		const local = unique.values().next().value;
		const exactTime = local.start === start && local.end === end;
		if (exactTime) result.timeMatches++;
		else result.nearTimeMatches++;
		const content = compareContent(local, item, titles);
		if (content.titleMatch === 'missing') result.missingTitles++;
		if (content.episodeMatch !== 'missing') result.episodeCompared++;
		if (content.episodeMatch === 'exact') result.episodeMatches++;
		if (content.subtitleMatch !== 'missing') result.subtitleCompared++;
		if (content.subtitleMatch === 'exact') result.subtitleMatches++;
		if (content.conflicts.length) result.contradictions++;
		const slot = local.start + ':' + local.end;
		const supported = exactTime && content.supported;
		if (supported && !supportedLocalSlots.has(slot)) {
			supportedLocalSlots.add(slot);
			result.contentMatches++;
			if (content.titleMatch === 'exact') result.exact++;
			if (content.titleMatch === 'contained') result.partial++;
			tids.add(Number(item.TID));
			contentKeys.add(content.contentKey);
		}
		result.matches.push({ pid: String(item.PID || ''), tid: Number(item.TID), localProgramId: String(local.id || ''),
			startMs: local.start, endMs: local.end, startDifferenceMs: local.start - start, endDifferenceMs: local.end - end,
			exactTime, titleMatch: content.titleMatch, episodeMatch: content.episodeMatch, subtitleMatch: content.subtitleMatch,
			supported, conflicts: content.conflicts });
	}
	result.distinctContentMatches = contentKeys.size;
	result.matchedTids = Array.from(tids).sort((a, b) => a - b);
	return result;
}

function programChoice(candidates, evidence) {
	const qualified = evidence.filter(item => item.programs.contentMatches >= MIN_CONTENT_MATCHES &&
		item.programs.distinctContentMatches >= MIN_CONTENT_MATCHES && item.programs.contradictions === 0 && item.programs.ambiguousTimes === 0);
	if (qualified.length !== 1) return null;
	const winner = qualified[0];
	if (candidates.length === 1) return winner;
	// Missing/empty data for a rival is NOT proof against that rival. Require
	// actual contradictory content at separate supporting airings of the winner.
	const supporting = winner.programs.matches.filter(match => match.supported);
	return evidence.filter(item => item.chId !== winner.chId).every(rival => {
		const discriminating = new Set(supporting.filter(match => rival.programs.matches.some(other =>
			other.exactTime && other.startMs === match.startMs && other.endMs === match.endMs && other.conflicts.length))
			.map(match => match.startMs + ':' + match.endMs));
		return discriminating.size >= MIN_CONTENT_MATCHES;
	}) ? winner : null;
}

function buildIndependentChannelMap(options) {
	options = options || {};
	const officialChannels = Array.isArray(options.officialChannels) ? options.officialChannels : [];
	const channelGroups = Array.isArray(options.channelGroups) ? options.channelGroups : [];
	const titles = options.titles instanceof Map ? options.titles : new Map();
	const items = uniqueProgramItems(options.progLookupItems);
	const confirmed = [];
	const unresolved = [];
	const seen = new Set();
	for (const channel of Array.isArray(options.mirakurunChannels) ? options.mirakurunChannels : []) {
		const identity = serviceIdentity(channel);
		if (!identity || seen.has(identity)) continue;
		seen.add(identity);
		// First, preserve the entire v6 decision path. A newly considered
		// ChGID-mismatched candidate must never invalidate a result from it.
		const established = selectCandidates(channel, officialChannels, channelGroups);
		const candidates = acquisitionCandidates(channel, null, officialChannels, channelGroups);
		const evidence = candidates.map(candidate => Object.assign({}, candidate, {
			programs: programEvidence(channel, candidate.chId, items, titles, options.progLookupCoverage)
		}));
		const byId = new Map(evidence.map(item => [item.chId, item]));
		const establishedEvidence = established.map(item => byId.get(item.chId));
		const establishedByName = established.length === 1 && established[0].nameStrength === 'identity';
		let chosen = establishedByName ? establishedEvidence[0] : programChoice(established, establishedEvidence);
		let byName = establishedByName;
		let selectionPath = 'established';
		if (!chosen) {
			// A strong, unique official-name match is sufficient even when
			// the catalog's group type differs (e.g. a service migration).
			// Weak name containment or ChGID alone is never sufficient.
			const identities = candidates.filter(item => item.nameStrength === 'identity');
			if (identities.length === 1) {
				chosen = byId.get(identities[0].chId);
				byName = true;
			} else {
				chosen = programChoice(candidates, evidence);
			}
			if (chosen) selectionPath = 'supplementary';
		}
		if (chosen) {
			const selectedEvidence = {
				type: byName ? 'official-name-' + chosen.nameMatch : 'official-proglookup',
				nameMatch: chosen.nameMatch, chName: chosen.chName, chiEpgName: chosen.chiEpgName,
				chGroupId: chosen.chGroupId, chGroupName: chosen.chGroupName, groupType: chosen.groupType,
				exactProgramMatches: chosen.programs.exact, partialProgramMatches: chosen.programs.partial,
				matchedTids: chosen.programs.matchedTids, verification: chosen.programs
			};
			if (selectionPath === 'supplementary') {
				selectedEvidence.selectionPath = selectionPath;
				selectedEvidence.groupTypeMismatch = !!chosen.groupTypeMismatch;
			}
			// Do not revoke an established hit merely because another method
			// found a different ChID. Keep the original, but disclose a strong
			// supplementary identity disagreement for review.
			const competing = candidates.filter(item => item.chId !== chosen.chId &&
				item.groupTypeMismatch && item.nameStrength === 'identity').map(item => item.chId);
			if (competing.length) selectedEvidence.competingIdentityChIds = competing;
			confirmed.push({
				nid: Number(channel.nid), sid: Number(channel.sid), chId: chosen.chId,
				status: 'verified', label: String(channel.name || ''), evidence: selectedEvidence
			});
			continue;
		}
		const reason = !candidates.length ? 'no-name-candidate' :
			evidence.every(item => item.programs.availability === 'covered-empty') ? 'program-evidence-empty' :
			evidence.every(item => item.programs.availability === 'not-covered') ? 'program-evidence-not-fetched' :
			candidates.length > 1 ? 'program-evidence-not-unique' : 'program-evidence-insufficient';
		unresolved.push({
			nid: Number(channel.nid), sid: Number(channel.sid), label: String(channel.name || ''), reason,
			candidateChIds: candidates.map(item => item.chId),
			acquisitionCandidateChIds: candidates.map(item => item.chId), acquisitionCandidates: candidates, evidence
		});
	}
	confirmed.sort((a, b) => a.nid - b.nid || a.sid - b.sid);
	unresolved.sort((a, b) => a.nid - b.nid || a.sid - b.sid);
	return {
		version: 2,
		provenance: Object.assign({}, options.provenance || {}, { kind: SOURCE_KIND, algorithmVersion: ALGORITHM_VERSION }),
		channels: confirmed, unresolved
	};
}

// Optional, read-only discovery of TIDs via unresolved ChID candidates.
// This does not change verified service bindings. Assignment requires independent
// episode agreement and complete acquisition, checked by the series resolver.
function createProgramExplorer(options) {
	options = options || {};
	const source = options.channelMap || {};
	const getTitle = options.getTitle;
	if (typeof getTitle !== 'function') throw new TypeError('getTitle is required');
	const verifiedServices = new Set((Array.isArray(source.channels) ? source.channels : [])
		.filter(item => item && item.status === 'verified').map(serviceIdentity).filter(Boolean));
	const candidateServices = new Map();
	for (const entry of Array.isArray(source.unresolved) ? source.unresolved : []) {
		const id = serviceIdentity(entry);
		if (!id || verifiedServices.has(id)) continue;
		const chIds = Array.from(new Set((Array.isArray(entry.acquisitionCandidateChIds) ?
			entry.acquisitionCandidateChIds : []).map(value => integer(value, 1)).filter(value => value !== null)));
		if (chIds.length) candidateServices.set(id, chIds);
	}
	const titleCache = new Map();
	const programsByStart = new Map();
	const eligibleChIds = new Set(Array.from(candidateServices.values()).flat());
	for (const item of uniqueProgramItems(options.progLookupItems)) {
		const chId = integer(item.ChID, 1);
		const tid = integer(item.TID, 1);
		if (!eligibleChIds.has(chId) || tid === null) continue;
		const start = syobocalTime(item.StTime);
		const end = syobocalTime(item.EdTime);
		if (start === null || end === null || end <= start) continue;
		const key = chId + ':' + start;
		if (!programsByStart.has(key)) programsByStart.set(key, []);
		programsByStart.get(key).push({ item, start, end, tid, chId });
	}

	function getWorkTitle(tid) {
		if (!titleCache.has(tid)) {
			const record = getTitle(tid);
			titleCache.set(tid, typeof record === 'string' ? record : String(record && record.title || ''));
		}
		return titleCache.get(tid);
	}

	function titleContainedInEpg(program, officialTitle) {
		const official = workTitleParts(officialTitle);
		// Avoid incidental matches on very short strings.
		if (official.base.length < 4) return false;
		const variants = Array.from(new Set([official.base,
			String(officialTitle || '').normalize('NFKC').toLocaleLowerCase('ja-JP')].filter(Boolean)));
		// A shorter title must not hide a conflicting season in fullTitle.
		if (official.installment !== null && [program.title, program.fullTitle].some(value => {
			const local = workTitleParts(value, program.episode);
			return local.installment !== null && local.installment !== official.installment;
		})) return false;
		const edge = /[^\p{L}\p{N}]/u;
		for (const value of [program.title, program.fullTitle]) {
			const local = workTitleParts(value, program.episode);
			if (!local.base) continue;
			const raw = String(value || '').normalize('NFKC').toLocaleLowerCase('ja-JP')
				.replace(/[\u{1F100}-\u{1F1FF}]/gu, ' ');
			for (const name of variants) {
				let position = -1;
				while ((position = raw.indexOf(name, position + 1)) !== -1) {
					const before = position ? raw[position - 1] : '';
					const after = raw[position + name.length] || '';
					if ((!before || edge.test(before)) && (!after || edge.test(after))) return true;
				}
			}
		}
		return false;
	}

	function find(program) {
		const id = serviceIdentity(program && program.channel);
		const chIds = id && candidateServices.get(id);
		if (!chIds) return { status: 'not-applicable', candidateTids: [], matches: [] };
		const start = Number(program.start);
		const end = Number(program.end);
		if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
			return { status: 'no-time', candidateTids: [], matches: [] };
		}
		const episode = integer(program.episode, 1);
		const localTitle = subtitleKey(program.fullTitle || program.title);
		const localSubtitle = informativeSubtitle(program.subTitle);
		const hits = [];
		for (const chId of chIds) {
			// A true time match is required; do not infer a missing candidate's TID.
			for (const entry of programsByStart.get(chId + ':' + start) || []) {
				if (entry.end !== end) continue;
				const title = getWorkTitle(entry.tid);
				if (!title || !titleContainedInEpg(program, title)) continue;
				const count = integer(entry.item.Count, 1);
				if (episode !== null && count !== null && episode !== count) continue;
				const officialSubtitle = informativeSubtitle(entry.item.SubTitle || entry.item.STSubTitle);
				const subtitleMatches = !!officialSubtitle &&
					(localTitle.includes(officialSubtitle) || localSubtitle === officialSubtitle);
				hits.push({ tid: entry.tid, chId, pid: String(entry.item.PID || ''),
					title, episodeMatch: episode !== null && count !== null ? 'exact' : 'not-compared',
					subtitleMatch: subtitleMatches ? 'exact' : 'not-confirmed' });
			}
		}
		const tids = Array.from(new Set(hits.map(item => item.tid))).sort((a, b) => a - b);
		return { status: tids.length === 1 ? 'single-observed-tid' : tids.length ? 'ambiguous-tid' : 'no-match',
			candidateTids: tids, matches: hits,
			acquisitionComplete: typeof options.isRangeCovered === 'function' &&
				options.isRangeCovered(start, end, chIds) === true };
	}
	return { find };
}

function readIndependentChannelMap(filename) {
	if (!filename || !fs.existsSync(filename)) return null;
	const source = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/u, ''));
	if (!source || source.version !== 2 || !source.provenance || source.provenance.kind !== SOURCE_KIND ||
		!Array.isArray(source.channels)) return null;
	return Object.assign({}, source, {
		channels: source.channels.filter(entry => entry && entry.status === 'verified' &&
			serviceIdentity(entry) !== null && integer(entry.chId, 1) !== null).map(entry => ({
			nid: Number(entry.nid), sid: Number(entry.sid), chId: Number(entry.chId),
			status: 'verified', label: String(entry.label || ''), evidence: entry.evidence || null
		})),
		unresolved: (Array.isArray(source.unresolved) ? source.unresolved : []).map(entry => Object.assign({}, entry, {
			acquisitionCandidateChIds: Array.from(new Set((Array.isArray(entry.acquisitionCandidateChIds) ?
				entry.acquisitionCandidateChIds : []).map(Number).filter(value => Number.isInteger(value) && value > 0)))
				.sort((left, right) => left - right)
		}))
	});
}

module.exports = {
	SOURCE_KIND,
	ALGORITHM_VERSION,
	acquisitionCandidates,
	createProgramExplorer,
	buildIndependentChannelMap,
	candidateChannels,
	channelGroupType,
	normalizeName,
	normalizeTitle,
	parseChLookupXml,
	parseChGroupLookupXml,
	parseTitleLookupXml,
	readIndependentChannelMap,
	syobocalTime
};
