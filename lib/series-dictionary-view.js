'use strict';

const { statSync } = require('node:fs');
const { openStore } = require('./drama-store');
const { createDictionaryStore, createSeriesResolver } = require('./series-resolver');

const PAGE_SIZE = 50;
const error = (message, statusCode) => Object.assign(new Error(message), { statusCode });

function readSyobocalDictionary(resolver, input, dictionaryGeneration) {
	if (input.dictionaryGeneration && input.dictionaryGeneration !== dictionaryGeneration) {
		throw error('作品辞書が更新されました。一覧を読み直してください。', 409);
	}
	if (input.tid !== undefined) {
		const tid = Number(input.tid);
		if (!Number.isSafeInteger(tid) || tid <= 0) throw error('TIDが不正です', 400);
		const title = resolver.getDictionaryTitle(tid);
		if (!title) throw error('作品辞書に存在しません', 404);
		const episodes = resolver.getDictionaryEpisodes(tid);
		return { tid, title: title.title, episodeCount: episodes.length, episodes, dictionaryGeneration };
	}
	const query = String(input.q || '');
	if (query.length > 512) throw error('検索文字列が長すぎます', 400);
	return { ...resolver.searchDictionaryTitles(query, PAGE_SIZE, input.page === undefined ? 1 : input.page), dictionaryGeneration };
}

function readPublishedSyobocal(path, input) {
	const info = statSync(path);
	const store = createDictionaryStore({ path });
	try {
		const resolver = createSeriesResolver({ dictionary: store });
		return readSyobocalDictionary(resolver, input, [info.ino, info.size, info.mtimeMs].join(':'));
	} finally {
		store.close();
	}
}

function readDrama(path, sources, op) {
	if (!path || (sources?.bangumi === false && sources?.wikipedia === false)) return null;
	let store;
	try {
		store = openStore(path, true, sources);
		return store.browse(() => op(store));
	} catch {
		return null;
	} finally {
		if (store) store.close();
	}
}

function browseDictionary(options, input, readSyobocal) {
	const { id, tid, source = 'all' } = input;
	const syobocal = options.enabled === false || options.useSyobocal === false ? null :
		readSyobocal || (options.dictionaryPath ? args => readPublishedSyobocal(options.dictionaryPath, args) : null);
	if (tid !== undefined || (typeof id === 'string' && id.startsWith('syobocal:'))) {
		if (!syobocal) throw error('しょぼいカレンダー辞書を利用できません', 404);
		const result = syobocal({ tid: tid ?? id.slice('syobocal:'.length) });
		return { ...result, id: 'syobocal:' + result.tid, source: 'syobocal' };
	}
	if (id !== undefined) {
		const match = typeof id === 'string' && id.length <= 160 && /^(bangumi|wikipedia):(.+)$/u.exec(id);
		if (!match || (match[1] === 'bangumi' && (!/^\d+$/u.test(match[2]) ||
			!Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= 0))) throw error('作品IDが不正です', 400);
		const result = readDrama(options.dramaPath, options.dramaSources, store => ({
			work: store.getWork(match[1] === 'bangumi' ? Number(match[2]) : 'wiki:' + match[2])
		}));
		if (!result?.work) throw error('作品辞書に存在しません', 404);
		return { id, work: result.work, source: result.work.bangumi ?
			(result.work.wikipedia ? 'bangumi-wikipedia' : 'bangumi') : 'wikipedia' };
	}
	const q = String(input.q || '');
	const page = input.page === undefined ? 1 : Number(input.page);
	const offset = (page - 1) * PAGE_SIZE;
	if (q.length > 512) throw error('検索文字列が長すぎます', 400);
	if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(offset + PAGE_SIZE)) {
		throw error('ページ指定が不正です', 400);
	}
	if (!['all', 'syobocal', 'drama'].includes(source)) throw error('辞書の指定が不正です', 400);
	let official;
	if (source !== 'drama' && syobocal) {
		try { official = syobocal({ q, page }); } catch { /* The live-action dictionary can be browsed independently. */ }
	}
	const officialTotal = official?.pagination.total || 0;
	const officialRows = official?.results || [];
	const drama = source === 'syobocal' ? null : readDrama(options.dramaPath, options.dramaSources, store => (
		store.searchWorks(q, PAGE_SIZE - officialRows.length, Math.max(0, offset - officialTotal))
	));
	const dictionaryGeneration = JSON.stringify([official?.dictionaryGeneration ?? null, drama?.version ?? null]);
	if (input.dictionaryGeneration && input.dictionaryGeneration !== dictionaryGeneration) {
		throw error('作品辞書が更新されました。一覧を読み直してください。', 409);
	}
	const total = officialTotal + (drama?.total || 0);
	return {
		results: [...officialRows.map(item => ({ ...item, id: 'syobocal:' + item.tid, source: 'syobocal' })), ...(drama?.results || [])],
		dramaManualSelection: options.enabled !== false &&
			(options.dramaSources?.bangumi !== false || options.dramaSources?.wikipedia !== false),
		dictionaryGeneration,
		pagination: { page, pageSize: PAGE_SIZE, total, totalPages: Math.ceil(total / PAGE_SIZE), hasMore: offset + PAGE_SIZE < total }
	};
}

module.exports = { browseDictionary, readSyobocalDictionary };
