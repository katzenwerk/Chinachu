'use strict';

const { formatRecordedName } = require('chinachu-common');
const { isDeleted } = require('./proglookup-store');
const { parseEpisodeNumbers } = require('./series-resolver');

const regularNumber = number => Number.isSafeInteger(number) && number > 0;

function indexProgBoundaries(programs = []) {
	const byTid = new Map();
	for (const row of programs) {
		if (isDeleted(row) || !/^[1-9]\d*$/u.test(row.TID) || !/^[1-9]\d*$/u.test(row.Count)) continue;
		const tid = Number(row.TID), number = Number(row.Count);
		if (!regularNumber(tid) || !regularNumber(number)) continue;
		if (!byTid.has(tid)) byTid.set(tid, { numbers: new Set(), first: new Set(), last: new Set() });
		const entry = byTid.get(tid);
		entry.numbers.add(number);
		// Syobocal Flag is a bitmask: 2 = new, 4 = final, 8 = rerun.
		const flags = /^\d+$/u.test(row.Flag) ? Number(row.Flag) : 0;
		if (flags & 2) entry.first.add(number);
		if (flags & 4) entry.last.add(number);
	}
	return byTid;
}

function dateValue(value) {
	if (!/^[1-9]\d{3}-\d{2}-\d{2}$/u.test(value)) return null;
	const time = Date.parse(value);
	return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? value : null;
}

function dramaBoundaries(work, preferWiki, now = Date.now()) {
	const primary = preferWiki ? work.wikipedia : work.bangumi;
	if (!primary) return {};
	const airing = ['ongoing', 'upcoming'].includes(work.wikipedia?.broadcast_status);
	const result = airing ? { airing } : {};
	const today = new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
	const start = dateValue(preferWiki ? primary.first_air_date : primary.firstBroadcast?.date || primary.date);
	if (!start || start > today) return result;
	const episodes = work.episodes.flatMap(entry => {
		const row = preferWiki ? entry.wikipedia : entry.bangumi;
		if (!row || (preferWiki ? row.kind !== 'normal' : row.type !== 0)) return [];
		return [{ number: preferWiki ? row.number : row.sort, date: dateValue(row.airdate) }];
	}).sort((a, b) => a.number - b.number);
	const first = episodes[0];
	if (!first || !regularNumber(first.number) || first.date !== start ||
		episodes.filter(episode => episode.date === start).length !== 1 ||
		episodes.filter(episode => episode.number === first.number).length !== 1) return result;
	const count = preferWiki ? primary.declared_episode_count : primary.total;
	const last = episodes.at(-1);
	const end = preferWiki ? dateValue(primary.last_air_date) : last.date;
	const complete = !airing && regularNumber(count) && episodes.length === count && end && end < today &&
		last.date === end && episodes.every(({ number, date }, index) =>
			number === first.number + index && date && start <= date && date <= end &&
			(index === 0 || date >= episodes[index - 1].date));
	return { ...result, first: first.number, ...(complete ? { last: last.number } : {}) };
}

function explicitEndNumber(event) {
	// An isolated broadcast suffix after an explicit episode marker, never an
	// occurrence inside the work name or a quoted subtitle.
	const title = String(event.fullTitle || '').normalize('NFKC').trim();
	const end = /(?:#\s*(\d+)|第\s*(\d+)\s*話)\s*(?:「[^」]*」\s*)?\s+END$/iu.exec(title);
	if (!end || event.title?.normalize('NFKC').includes(end[0])) return null;
	const number = Number(end[1] || end[2]);
	const numbers = parseEpisodeNumbers(event.episode);
	return numbers.length === 1 && numbers[0] === number ? number : null;
}

function episodeBoundaries(seriesId, episodes, prog, drama) {
	const numbers = new Set(prog?.numbers);
	const first = new Set(prog?.first);
	const last = new Set(prog?.last);
	if (drama?.first) first.add(drama.first);
	if (drama?.last) last.add(drama.last);
	for (const episode of episodes) {
		if (!episode.confirmed || !regularNumber(episode.number)) continue;
		const number = episode.number;
		numbers.add(number);
		for (const event of episode.events) {
			// An EPG marker has meaning for the confirmed work/episode only.
			const automatic = event.resolution?.automatic;
			if (automatic?.seriesId !== seriesId || automatic.episodeLinks?.length !== 1 ||
				automatic.episodeLinks[0].kind !== 'episode' ||
				event.resolution.manual?.active && event.resolution.manual.episode !== number) continue;
			const epg = parseEpisodeNumbers(event.episode);
			if (epg.length !== 1 || epg[0] !== number) continue;
			const flags = formatRecordedName(event, '<flags2>');
			if (flags.includes('[新]')) first.add(number);
			if (flags.includes('[終]') || explicitEndNumber(event) === number) last.add(number);
		}
	}
	// Known earlier/later episodes can disprove a boundary, never establish it.
	const result = {};
	const firstEpisode = first.values().next().value;
	const lastEpisode = last.values().next().value;
	if (first.size === 1 && ![...numbers].some(number => number < firstEpisode)) result.first = firstEpisode;
	if (!drama?.airing && last.size === 1 && ![...numbers].some(number => number > lastEpisode)) result.last = lastEpisode;
	return result;
}

module.exports = { indexProgBoundaries, dramaBoundaries, episodeBoundaries };
