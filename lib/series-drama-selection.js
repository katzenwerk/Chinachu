'use strict';

const { createHash } = require('node:crypto');
const { browseDictionary } = require('./series-dictionary-view');
const { openStore } = require('./drama-store');

const isDramaId = value => typeof value === 'string' && value.length <= 160 &&
	/^(?:bangumi:[1-9]\d{0,14}|wikipedia:[1-9]\d*:[1-9]\d{0,3}:\d{1,3}:[^:\s]*)$/u.test(value);
const isEpisodeKey = value => typeof value === 'string' &&
	/^(?:normal:[1-9]\d{0,5}(?:\.\d{1,8})?|special:(?:b[1-9]\d{0,15}|[0-9a-f]{24}))$/u.test(value);
const isNumberedEpisode = key => key.startsWith('normal:');
const numberOf = key => isNumberedEpisode(key) ? Number(key.slice(7)) : null;

function episodeKey(episode, preferWiki) {
	const { wikipedia, bangumi, number } = episode;
	if (wikipedia?.kind === 'range') return null;
	if (wikipedia?.kind === 'normal' || bangumi?.type === 0) {
		const key = 'normal:' + number;
		return isEpisodeKey(key) && number <= 100000 ? key : null;
	}
	if (wikipedia?.kind !== 'special' && bangumi?.type !== 1) return null;
	if (bangumi?.type === 1 && (!preferWiki || wikipedia?.kind !== 'special')) return 'special:b' + bangumi.id;
	const label = wikipedia?.label?.normalize('NFKC').trim();
	if (!label) return null;
	const source = wikipedia?.source?.page_id;
	return 'special:' + createHash('sha256').update(JSON.stringify([source, label, wikipedia.number])).digest('hex').slice(0, 24);
}

function loadDramaSelection(dramaPath, seriesId, dramaSources) {
	try {
		const result = browseDictionary({ dramaPath, dramaSources }, { id: seriesId });
		const { work } = result;
		const preferWiki = seriesId.startsWith('wikipedia:');
		const bg = work.bangumi;
		const wiki = work.wikipedia;
		const primary = preferWiki ? wiki : bg;
		if (!primary) return null;
		const episodes = new Map();
		const ambiguous = new Set();
		for (const episode of work.episodes) {
			// A saved Wikipedia edition stays anchored to rows in that edition even after linking.
			if (preferWiki && !episode.wikipedia) continue;
			const key = episodeKey(episode, preferWiki);
			if (!key || ambiguous.has(key)) continue;
			if (episodes.has(key)) {
				episodes.delete(key);
				ambiguous.add(key);
				continue;
			}
			const specialLabel = episode.wikipedia?.label || (episode.number != null ? String(episode.number) : '');
			const label = isNumberedEpisode(key) ? '第' + numberOf(key) + '話' :
				/^(?:特別編|スペシャル)/u.test(specialLabel) ? specialLabel : ['特別編', specialLabel].filter(Boolean).join(' · ');
			episodes.set(key, { key, label, number: numberOf(key), episode });
		}
		return {
			title: primary.title || primary.name,
			firstYear: preferWiki ? wiki.year : (/^[1-9]\d{3}-/u.test(bg.date) ? Number(bg.date.slice(0, 4)) : null),
			season: preferWiki ? (wiki.season || null) : work.season,
			source: result.source, episodes
		};
	} catch (error) {
		if (error.statusCode === 404) return null;
		throw error;
	}
}

function resolveDramaEpisodes(keys, selected, saved) {
	if (!Array.isArray(keys) || keys.length > 100 || new Set(keys).size !== keys.length ||
		keys.some(key => !isEpisodeKey(key) || (isNumberedEpisode(key) && numberOf(key) > 100000))) {
		throw Object.assign(new Error('話数指定が不正です'), { statusCode: 400 });
	}
	const previous = new Map((saved?.episodes || []).map(episode => [episode.key, episode]));
	return keys.map(key => {
		const episode = selected?.episodes.get(key) || previous.get(key);
		if (episode) return { key, label: episode.label };
		if (isNumberedEpisode(key) && Number.isInteger(numberOf(key))) return { key, label: '第' + numberOf(key) + '話' };
		throw Object.assign(new Error('指定した各話は作品辞書に存在しません'), { statusCode: 400 });
	});
}

function createDramaMatcher(filename, sources) {
	if (!filename || (sources?.bangumi === false && sources?.wikipedia === false)) return null;
	let store;
	try {
		store = openStore(filename, true, sources);
		const data = store.browse(() => store.matchingTitles());
		const works = new Map();
		return { ...data, getWork(id) {
			if (!works.has(id)) works.set(id, loadDramaSelection(filename, id, sources));
			return works.get(id);
		} };
	} catch {
		return null;
	} finally {
		if (store) store.close();
	}
}

module.exports = { isDramaId, isEpisodeKey, isNumberedEpisode, numberOf, loadDramaSelection, resolveDramaEpisodes, createDramaMatcher };
