'use strict';

const { DatabaseSync } = require('node:sqlite');
const { compact: searchKey } = require('./series-resolver');

const parse = value => JSON.parse(value);
const json = JSON.stringify;
const compact = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const dateYear = value => /^\d{4}(?:-|$)/.test(value || '') ? Number(value.slice(0, 4)) || null : null;
const seasonPattern = /(?:seasons?\s*|シーズン\s*|シリーズ\s*)(\d+)|第\s*(\d+)\s*(?:シリーズ|シーズン|期|部)|(\d+)(?:st|nd|rd|th)\s+season/iu;
const seasonOf = title => Number(seasonPattern.exec(String(title || '').normalize('NFKC'))?.slice(1).find(Boolean)) || null;
const archiveSeason = work => {
	const explicit = seasonOf(work.name) || work.season;
	const aliases = new Set((work.aliases || []).map(seasonOf).filter(Boolean));
	return explicit || (aliases.size === 1 ? aliases.values().next().value : null);
};
const normalizeTitle = title => compact(String(title || '').normalize('NFKC').replace(/(秋冬|春夏)編/gu, '$1'));
const baseTitle = title => normalizeTitle(String(title || '').normalize('NFKC').replace(seasonPattern, ''));
const PART = /秋冬|春夏|春編|夏編|秋編|冬編|前期|後期|ファイナル/u;

const SCHEMA = [
	'CREATE TABLE IF NOT EXISTS drama_updates (source TEXT PRIMARY KEY, value TEXT NOT NULL)',
	'CREATE TABLE IF NOT EXISTS bangumi_works (id INTEGER PRIMARY KEY, title TEXT NOT NULL, year INTEGER, season INTEGER, data TEXT NOT NULL)',
	'CREATE INDEX IF NOT EXISTS bangumi_year ON bangumi_works(year)',
	'CREATE TABLE IF NOT EXISTS bangumi_aliases (work_id INTEGER REFERENCES bangumi_works ON DELETE CASCADE, alias TEXT NOT NULL, PRIMARY KEY(work_id, alias))',
	'CREATE TABLE IF NOT EXISTS bangumi_episodes (id INTEGER PRIMARY KEY, work_id INTEGER NOT NULL REFERENCES bangumi_works ON DELETE CASCADE, number REAL NOT NULL, kind INTEGER NOT NULL, data TEXT NOT NULL)',
	'CREATE INDEX IF NOT EXISTS bangumi_work_episode ON bangumi_episodes(work_id, kind, number)',
	'CREATE TABLE IF NOT EXISTS wikipedia_articles (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, checked_at INTEGER NOT NULL, source TEXT NOT NULL, seeds TEXT NOT NULL, related TEXT NOT NULL)',
	'CREATE TABLE IF NOT EXISTS wikipedia_editions (id TEXT PRIMARY KEY, article_id INTEGER NOT NULL REFERENCES wikipedia_articles, year INTEGER NOT NULL, season INTEGER, title TEXT NOT NULL, data TEXT NOT NULL)',
	'CREATE INDEX IF NOT EXISTS wikipedia_article_edition ON wikipedia_editions(article_id)',
	'CREATE INDEX IF NOT EXISTS wikipedia_year_edition ON wikipedia_editions(year)',
	'CREATE TABLE IF NOT EXISTS wikipedia_episodes (id INTEGER PRIMARY KEY, edition_id TEXT NOT NULL REFERENCES wikipedia_editions ON DELETE CASCADE, number INTEGER, kind TEXT NOT NULL, data TEXT NOT NULL)',
	'CREATE INDEX IF NOT EXISTS wikipedia_edition_episode ON wikipedia_episodes(edition_id, kind, number)',
	'CREATE TABLE IF NOT EXISTS wikipedia_years (year INTEGER PRIMARY KEY, discovered_day TEXT, completed_at INTEGER, sources TEXT NOT NULL DEFAULT \'[]\')',
	'CREATE TABLE IF NOT EXISTS wikipedia_queue (year INTEGER NOT NULL REFERENCES wikipedia_years, key TEXT NOT NULL, seed TEXT NOT NULL, state TEXT NOT NULL, page_id INTEGER, PRIMARY KEY(year, key))',
	'CREATE INDEX IF NOT EXISTS wikipedia_queue_page ON wikipedia_queue(page_id)',
	"CREATE INDEX IF NOT EXISTS wikipedia_queue_pending ON wikipedia_queue(year) WHERE state IN ('pending','failed')",
	'CREATE TABLE IF NOT EXISTS drama_work_links (bangumi_id INTEGER PRIMARY KEY REFERENCES bangumi_works ON DELETE CASCADE, wikipedia_id TEXT NOT NULL UNIQUE REFERENCES wikipedia_editions ON DELETE CASCADE, evidence TEXT NOT NULL)',
	'CREATE TABLE IF NOT EXISTS drama_episode_links (bangumi_id INTEGER PRIMARY KEY REFERENCES bangumi_episodes ON DELETE CASCADE, wikipedia_id INTEGER NOT NULL UNIQUE REFERENCES wikipedia_episodes ON DELETE CASCADE)'
].join(';\n');

function transaction(db, run) {
	db.exec('BEGIN IMMEDIATE');
	try {
		const result = run();
		db.exec('COMMIT');
		return result;
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

function seedKey(seed) {
	return json([seed.title, seed.season, PART.exec(seed.name)?.[0] || '']);
}

function decorateSubtitle(raw) {
	const value = String(raw || '').trim();
	if (!value || /^(?:(?:第\s*)?\d{1,3}(?:話|回|集)?|最終[話回]|[-―ー]+)$/u.test(value)) return null;
	return value;
}

function subtitleLanguage(value) {
	if (!value) return 'unknown';
	if (/[ぁ-ゖァ-ヺ]/u.test(value)) return 'ja';
	return /[这们谁说话发爱东网长听开吗为电个过实贵编结门给还妈语儿剧亲欢让买怀务见觉]|為什麼|我們|這個|沒有/u.test(value) ? 'zh' : 'unknown';
}

function validAirdate(value) {
	const date = /^(\d{4})[-/.年]\s*(\d{1,2})[-/.月]\s*(\d{1,2})日?$/u.exec(String(value || '').trim());
	if (!date || date[1] === '0000') return null;
	const result = [date[1], date[2].padStart(2, '0'), date[3].padStart(2, '0')].join('-');
	const millis = Date.parse(result);
	return Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 10) === result ? result : null;
}

function episodeInfo(bangumi, wikipedia, sources) {
	const original = decorateSubtitle(bangumi?.name);
	const language = subtitleLanguage(original);
	const article = decorateSubtitle(wikipedia?.formal_subtitle) || decorateSubtitle(wikipedia?.listed_subtitle);
	const wikiTitle = subtitleLanguage(article) === 'zh' ? null : article;
	const wikiFormal = wikiTitle && wikiTitle === decorateSubtitle(wikipedia.formal_subtitle) && subtitleLanguage(wikiTitle) === 'ja';
	const canSupplement = !original || language === 'zh';
	const bgDate = validAirdate(bangumi?.airdate);
	const wikiDate = validAirdate(wikipedia?.airdate);
	const wikiSource = wikipedia?.source || sources.wikipedia;
	return {
		bangumi, wikipedia,
		number: bangumi?.sort ?? wikipedia?.number ?? null,
		subtitle: language === 'ja' ? { value: original, language, source: sources.bangumi } :
			canSupplement && wikiFormal ? { value: wikiTitle, language: 'ja', source: wikiSource } : null,
		originalSubtitleCandidate: original && language === 'unknown' ?
			{ value: original, language, source: sources.bangumi } : null,
		subtitleCandidate: wikiTitle && (!wikiFormal || !canSupplement) && compact(wikiTitle) !== compact(original) ?
			{ value: wikiTitle, language: subtitleLanguage(wikiTitle), formal: wikiFormal, source: wikiSource } : null,
		epgSubtitle: wikipedia?.epg_subtitle ? { value: wikipedia.epg_subtitle, source: wikiSource } : null,
		streamingSubtitles: Object.entries(wikipedia?.streaming_titles || {}).map(([label, value]) => ({ label, value, source: wikiSource })),
		airdate: bgDate && wikiDate && bgDate !== wikiDate ? null :
			bgDate ? { value: bgDate, source: sources.bangumi } : wikiDate ? { value: wikiDate, source: wikiSource } : null,
		airdateConflict: bgDate && wikiDate && bgDate !== wikiDate ?
			[{ value: bgDate, source: sources.bangumi }, { value: wikiDate, source: wikiSource }] : []
	};
}

const DAY = 86_400_000;
const JST = 9 * 3600_000;

function articleDeadline(checkedAt, edition, year, lastEpisode) {
	const dayAt = time => Math.floor((time + JST) / DAY);
	const dayFromDate = value => value ? Date.parse(value) / DAY : null;
	const start = dayFromDate(validAirdate(edition.first_air_date));
	const end = dayFromDate(validAirdate(edition.last_air_date));
	const latest = dayFromDate(validAirdate(lastEpisode));
	// Evaluate the interval at the candidate deadline, including transitions across the 92/120-day windows.
	const interval = time => {
		const day = dayAt(time);
		if (end !== null) return day < end ? 1 : day - end <= 92 ? 7 : 30;
		if (edition.broadcast_status === 'ongoing' || edition.broadcast_status === 'upcoming') return 1;
		if (latest !== null && day - latest <= 28) return 1;
		if (start !== null) return day - start <= 120 ? 1 : 30;
		const calendar = new Date(day * DAY);
		return year > calendar.getUTCFullYear() || year === calendar.getUTCFullYear() &&
			day - Date.UTC(year, 0, 1) / DAY <= 120 ? 1 : 30;
	};
	return [1, 7, 30].map(days => checkedAt + days * DAY)
		.find((date, index) => interval(date) <= [1, 7, 30][index]);
}

function scheduleArticle(db, id, checkedAt) {
	const editions = db.prepare('SELECT id,year,data FROM wikipedia_editions WHERE article_id=?');
	const latest = db.prepare("SELECT max(json_extract(data,'$.airdate')) AS airdate FROM wikipedia_episodes WHERE edition_id=? AND kind='normal'");
	const dates = editions.all(id).map(row => {
		const info = parse(row.data);
		return articleDeadline(checkedAt, info, row.year,
			info.last_air_date || info.broadcast_status ? null : latest.get(row.id).airdate);
	});
	db.prepare('UPDATE wikipedia_articles SET next_check_at=? WHERE id=?')
		.run(dates.length ? Math.min(...dates) : null, id);
}

function wikiWorkLinkFields(row, data) {
	const titles = [row.title, data.article_work_name, ...(data.aliases || [])].filter(Boolean);
	const nameKeys = values => [...new Set(values.filter(Boolean))].sort();
	return json([row.year, row.season, normalizeTitle(row.title), PART.exec(row.title)?.[0]?.replace(/編$/u, '') || null,
		nameKeys(titles.map(normalizeTitle)), row.season ? nameKeys(titles.map(baseTitle)) : [], validAirdate(data.first_air_date)]);
}

function wikiEpisodeLinkFields(row) {
	if (row.number === null || !['normal', 'special'].includes(row.kind)) return null;
	return json([row.number, row.kind, row.season || null,
		...(row.kind === 'special' ? [validAirdate(row.airdate), compact(row.formal_subtitle || row.listed_subtitle)] : [])]);
}

function compareWorks(db) {
	const aliases = new Map();
	for (const row of db.prepare('SELECT * FROM bangumi_aliases').iterate()) {
		if (!aliases.has(row.work_id)) aliases.set(row.work_id, []);
		aliases.get(row.work_id).push(row.alias);
	}
	const exact = new Map();
	const families = new Map();
	function index(map, identity, row) {
		if (!map.has(identity)) map.set(identity, new Map());
		map.get(identity).set(row.id, row);
	}
	for (const row of db.prepare('SELECT id, title, year, season, data FROM bangumi_works WHERE year IS NOT NULL').iterate()) {
		const work = parse(row.data);
		if ([6002, 6003, 6004].includes(work.platform)) continue;
		row.start = validAirdate(work.date) || work.firstBroadcast?.date || null;
		for (const title of [row.title, ...(aliases.get(row.id) || [])]) {
			if (normalizeTitle(title)) index(exact, row.year + ':' + normalizeTitle(title), row);
			if (row.season && baseTitle(title)) index(families, row.year + ':' + row.season + ':' + baseTitle(title), row);
		}
	}
	const candidates = new Map();
	for (const row of db.prepare('SELECT * FROM wikipedia_editions').iterate()) {
		const work = parse(row.data);
		const titles = [row.title, work.article_work_name, ...(work.aliases || [])].filter(Boolean);
		const found = new Map();
		const part = PART.exec(row.title)?.[0]?.replace(/編$/u, '');
		for (const title of titles) {
			for (const other of exact.get(row.year + ':' + normalizeTitle(title))?.values() || []) found.set(other.id, other);
			if (row.season) for (const other of families.get(row.year + ':' + row.season + ':' + baseTitle(title))?.values() || []) found.set(other.id, other);
		}
		let eligible = [...found.values()].filter(other => {
			if (row.season && other.season && row.season !== other.season) return false;
			const otherPart = PART.exec(other.title)?.[0]?.replace(/編$/u, '');
			return !part || !otherPart || part === otherPart;
		});
		const start = validAirdate(work.first_air_date);
		const exactDate = eligible.filter(other => start && other.start === start);
		if (eligible.length > 1 && exactDate.length) eligible = exactDate;
		if (eligible.length !== 1) continue;
		const other = eligible[0];
		if ((Boolean(row.season) !== Boolean(other.season)) && start !== other.start &&
			normalizeTitle(row.title) !== normalizeTitle(other.title)) continue;
		candidates.set(row.id, { other: other.id, evidence: { year: row.year, season: row.season || other.season,
			exactStart: Boolean(start && other.start === start) } });
	}
	const reverse = new Map();
	for (const { other } of candidates.values()) reverse.set(other, (reverse.get(other) || 0) + 1);
	return [...candidates].filter(([, candidate]) => reverse.get(candidate.other) === 1);
}

function refreshLinks(db) {
	db.exec('DELETE FROM drama_episode_links; DELETE FROM drama_work_links');
	const putWork = db.prepare('INSERT INTO drama_work_links VALUES (?, ?, ?)');
	const putEpisode = db.prepare('INSERT INTO drama_episode_links VALUES (?, ?)');
	const bangumi = db.prepare('SELECT id, number, kind, data FROM bangumi_episodes WHERE work_id = ? AND kind IN (0,1)');
	const wiki = db.prepare("SELECT id, number, kind, data FROM wikipedia_episodes WHERE edition_id = ? AND kind IN ('normal','special')");
	for (const [wikiId, candidate] of compareWorks(db)) {
		putWork.run(candidate.other, wikiId, json(candidate.evidence));
		const index = new Map();
		const wikiNumbers = new Map();
		for (const row of bangumi.iterate(candidate.other)) {
			const id = row.kind + ':' + row.number;
			if (index.has(id)) index.set(id, null);
			else index.set(id, row);
		}
		for (const row of wiki.iterate(wikiId)) {
			if (row.number === null) continue;
			const season = parse(row.data).season;
			if (season && candidate.evidence.season && season !== candidate.evidence.season) continue;
			const id = (row.kind === 'normal' ? 0 : 1) + ':' + row.number;
			if (wikiNumbers.has(id)) wikiNumbers.set(id, null);
			else wikiNumbers.set(id, row);
		}
		for (const [id, left] of index) {
			const right = wikiNumbers.get(id);
			if (!left || !right) continue;
			if (left.kind === 1) {
				const bg = parse(left.data);
				const wp = parse(right.data);
				const sameDate = validAirdate(bg.airdate) && validAirdate(bg.airdate) === validAirdate(wp.airdate);
				const title = compact(bg.name);
				if (!sameDate && (!title || title !== compact(wp.formal_subtitle || wp.listed_subtitle))) continue;
			}
			putEpisode.run(left.id, right.id);
		}
	}
}

function openStore(filename, readOnly = false, sources = {}) {
	const bangumiEnabled = sources.bangumi !== false;
	const wikipediaEnabled = sources.wikipedia !== false;
	const useLinks = bangumiEnabled && wikipediaEnabled;
	const bangumiLink = useLinks ? 'l.bangumi_id=b.id' : '0';
	const wikipediaLink = useLinks ? 'l.wikipedia_id=w.id' : '0';
	const db = new DatabaseSync(filename, { readOnly, enableForeignKeyConstraints: true });
	try {
		db.exec('PRAGMA busy_timeout = 5000');
		if (!readOnly) {
			db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA temp_store = FILE');
			db.exec(SCHEMA);
			if (!db.prepare("SELECT 1 FROM pragma_table_info('wikipedia_articles') WHERE name='next_check_at'").get()) {
				transaction(db, () => {
					if (db.prepare("SELECT 1 FROM pragma_table_info('wikipedia_articles') WHERE name='next_check_at'").get()) return;
					db.exec('ALTER TABLE wikipedia_articles ADD COLUMN next_check_at INTEGER');
					db.exec('CREATE INDEX wikipedia_article_due ON wikipedia_articles(next_check_at) WHERE next_check_at IS NOT NULL');
					for (const { id, checked_at } of db.prepare('SELECT id,checked_at FROM wikipedia_articles').all()) {
						scheduleArticle(db, id, checked_at);
					}
				});
			}
		}
	} catch (error) {
		db.close();
		throw error;
	}
	function source(name) {
		return parse(db.prepare('SELECT value FROM drama_updates WHERE source = ?').get(name)?.value || '{}');
	}
	function setSource(name, patch) {
		db.prepare('INSERT INTO drama_updates VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET value=excluded.value')
			.run(name, json({ ...source(name), ...patch }));
	}
	function counts() {
		return db.prepare("SELECT (SELECT count(*) FROM bangumi_works) AS bangumiWorks, (SELECT count(*) FROM bangumi_episodes) AS bangumiEpisodes, " +
			"(SELECT count(*) FROM wikipedia_editions) AS wikipediaWorks, (SELECT count(*) FROM wikipedia_episodes WHERE kind != 'range') AS wikipediaEpisodes, " +
			"(SELECT count(*) FROM wikipedia_episodes WHERE kind = 'range') AS wikipediaRanges, " +
			"(SELECT count(*) FROM drama_work_links) AS workLinks, (SELECT count(*) FROM drama_episode_links) AS episodeLinks").get();
	}
	function years() {
		return db.prepare("SELECT y.year, y.discovered_day AS discoveredDay, y.completed_at AS completedAt, " +
			"count(q.key) AS total, count(q.key) FILTER(WHERE q.state NOT IN ('pending','failed')) AS completed, " +
			"count(q.key) FILTER(WHERE q.state='failed') AS failed " +
			'FROM wikipedia_years y LEFT JOIN wikipedia_queue q ON y.year=q.year GROUP BY y.year ORDER BY y.year DESC').all();
	}
	// Older candidates without route metadata used listed=false for Bangumi-only seeds.
	function discoveryScope(bangumiEnabled) {
		return bangumiEnabled ? '' : ` AND (
			EXISTS (SELECT 1 FROM json_each(q.seed,'$.routes') WHERE value <> 'bangumi') OR
			(json_extract(q.seed,'$.routes') IS NULL AND coalesce(json_extract(q.seed,'$.listed'),1)=1))`;
	}
	function planningYears(bangumiEnabled = true) {
		return db.prepare("SELECT y.year, y.discovered_day AS discoveredDay, y.completed_at AS completedAt, " +
			"EXISTS (SELECT 1 FROM wikipedia_queue q WHERE q.year=y.year AND q.state IN ('pending','failed')" +
			discoveryScope(bangumiEnabled) + ") AS hasPending " +
			"FROM wikipedia_years y").all();
	}
	function discover(year, day, entries, sources, bangumiEnabled = true) {
		transaction(db, () => {
			db.prepare('INSERT INTO wikipedia_years(year, discovered_day, sources) VALUES (?, ?, ?) ' +
				'ON CONFLICT(year) DO UPDATE SET discovered_day=excluded.discovered_day, sources=excluded.sources')
				.run(year, day, json(sources));
			const put = db.prepare("INSERT INTO wikipedia_queue VALUES (?, ?, ?, 'pending', NULL) " +
				"ON CONFLICT(year,key) DO UPDATE SET seed=excluded.seed, state=CASE WHEN wikipedia_queue.state IN ('missing','unresolved','excluded') THEN 'pending' ELSE wikipedia_queue.state END");
			for (const seed of entries) put.run(year, seedKey(seed), json(seed));
			const current = new Set(entries.map(seedKey));
			const refreshedLists = new Set(sources.map(source => source.page_id));
			const obsolete = db.prepare('DELETE FROM wikipedia_queue WHERE year=? AND key=?');
			for (const row of db.prepare('SELECT key,seed FROM wikipedia_queue WHERE year=?').all(year)) {
				if (current.has(row.key)) continue;
				const seed = parse(row.seed);
				if (seed.listed && refreshedLists.has(seed.discovery?.page_id) &&
					!(seed.routes || []).some(route => route !== 'list')) obsolete.run(year, row.key);
			}
			db.prepare("UPDATE wikipedia_queue AS q SET state='pending' WHERE year=? AND state IN ('missing','unresolved')" + discoveryScope(bangumiEnabled)).run(year);
		});
	}
	function pending(year, all = false, bangumiEnabled = true) {
		const query = "SELECT seed FROM wikipedia_queue q WHERE year=?" + (all ? "" : " AND state IN ('pending','failed')") +
			discoveryScope(bangumiEnabled);
		return db.prepare(query).all(year).map(row => parse(row.seed));
	}
	function setSeeds(seeds, state, pageId) {
		const update = db.prepare('UPDATE wikipedia_queue SET state=?, page_id=coalesce(?,page_id) WHERE year=? AND key=?');
		for (const seed of seeds) update.run(state, pageId ?? null, seed.year, seedKey(seed));
	}
	function resolveCandidates(candidates, pageId) {
		const found = db.prepare('SELECT 1 FROM wikipedia_editions WHERE id=? AND article_id=?');
		const states = new Map();
		for (const { seed, editionKeys, state } of candidates) {
			const key = seed.year + ':' + seedKey(seed);
			const ready = editionKeys.some(edition => found.get(pageId + ':' + edition, pageId));
			const previous = states.get(key)?.state;
			states.set(key, { seed, state: ready || previous === 'ready' ? 'ready' :
				state === 'unresolved' || previous === 'unresolved' ? 'unresolved' : state });
		}
		for (const { seed, state } of states.values()) setSeeds([seed], state, pageId);
	}
	function completeLinkRefresh() {
		refreshLinks(db);
		db.prepare("UPDATE drama_updates SET value=json_remove(value, '$.linksDirty') WHERE source='wikipedia' AND json_extract(value, '$.linksDirty')=1").run();
	}
	function refreshPendingLinks() {
		if (!source('wikipedia').linksDirty) return false;
		return transaction(db, () => {
			if (!source('wikipedia').linksDirty) return false;
			completeLinkRefresh();
			return true;
		});
	}
	function closeYears(now, bangumiEnabled = true) {
		db.prepare("UPDATE wikipedia_years SET completed_at=? WHERE completed_at IS NULL AND discovered_day IS NOT NULL AND NOT EXISTS " +
			"(SELECT 1 FROM wikipedia_queue q WHERE q.year=wikipedia_years.year AND q.state IN ('pending','failed')" +
			discoveryScope(bangumiEnabled) + ")").run(now);
	}
	function articleIds(seeds) {
		const page = db.prepare('SELECT page_id FROM wikipedia_queue WHERE year=? AND key=?');
		return [...new Set(seeds.map(seed => page.get(seed.year, seedKey(seed))?.page_id).filter(Boolean))];
	}
	function dueArticles(now) {
		return db.prepare('SELECT id,seeds FROM wikipedia_articles WHERE next_check_at <= ? ORDER BY next_check_at,id')
			.all(now).map(row => ({ id: row.id, seeds: parse(row.seeds) }));
	}
	function savePage(event, now) {
		transaction(db, () => {
			const id = event.source.page_id;
			let linksChanged = false;
			db.prepare('INSERT INTO wikipedia_articles(id,revision,checked_at,source,seeds,related) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ' +
				'revision=excluded.revision, checked_at=excluded.checked_at, source=excluded.source, seeds=excluded.seeds, related=excluded.related')
				.run(id, event.source.revision_id, now, json(event.source), json(event.seeds), json(event.related));
			const putEdition = db.prepare('INSERT INTO wikipedia_editions VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ' +
				'title=excluded.title, season=excluded.season, data=excluded.data');
			const putEpisode = db.prepare('INSERT INTO wikipedia_episodes(edition_id,number,kind,data) VALUES (?, ?, ?, ?)');
			const listEpisodes = db.prepare('SELECT id,data FROM wikipedia_episodes WHERE edition_id=? ORDER BY id');
			const updateEpisode = db.prepare('UPDATE wikipedia_episodes SET data=? WHERE id=?');
			const deleteEpisode = db.prepare('DELETE FROM wikipedia_episodes WHERE id=?');
			const episodeKey = episode => json([episode.kind, episode.number ?? episode.label]);
			const remove = db.prepare('DELETE FROM wikipedia_editions WHERE article_id=? AND id=?');
			const kept = new Set(event.editions.map(edition => edition.key));
			for (const key of event.removeEditions) {
				if (kept.has(key)) throw new Error('Wikipedia: 放送版の保存と削除が重複 ' + id + ':' + key);
				if (remove.run(id, id + ':' + key).changes) linksChanged = true;
			}
			const current = db.prepare('SELECT title,year,season,data FROM wikipedia_editions WHERE id=? AND article_id=?');
			const { unconfirmed_candidates, ...source } = event.source;
			for (const edition of event.editions) {
				const editionId = id + ':' + edition.key;
				const existing = current.get(editionId, id);
				const previous = existing && parse(existing.data);
				if (previous?.broadcast_identity && json(previous.broadcast_identity) !== json(edition.metadata.broadcast_identity)) {
					throw new Error('Wikipedia: 放送版IDの再利用 ' + editionId);
				}
				const row = { title: edition.seed.name, year: edition.seed.year, season: edition.seed.season };
				if (!existing || wikiWorkLinkFields(existing, previous) !== wikiWorkLinkFields(row, edition.metadata)) linksChanged = true;
				putEdition.run(editionId, id, row.year, row.season, row.title, json({ ...edition.metadata,
					discovery: edition.seed.discovery || null, source }));
				if (existing && !edition.replaceEpisodes) continue;
				const episodes = new Map();
				for (const saved of listEpisodes.all(editionId)) {
					const data = parse(saved.data);
					const key = episodeKey(data);
					if (!episodes.has(key)) episodes.set(key, []);
					episodes.get(key).push({ ...saved, link: wikiEpisodeLinkFields(data) });
				}
				for (const episode of edition.episodes) {
					const previous = episodes.get(episodeKey(episode))?.shift();
					const link = wikiEpisodeLinkFields(episode);
					if ((previous?.link ?? null) !== link) linksChanged = true;
					const data = json(episode);
					if (!previous) putEpisode.run(editionId, episode.number, episode.kind, data);
					else if (previous.data !== data) updateEpisode.run(data, previous.id);
				}
				for (const remaining of episodes.values()) for (const episode of remaining) {
					deleteEpisode.run(episode.id);
					if (episode.link !== null) linksChanged = true;
				}
			}
			resolveCandidates(event.candidates, id);
			scheduleArticle(db, id, now);
			if (linksChanged) setSource('wikipedia', { linksDirty: true });
		});
	}
	function getWork(identifier) {
		const wiki = typeof identifier === 'string' && identifier.startsWith('wiki:');
		const id = wiki ? identifier.slice(5) : Number(identifier);
		if (wiki ? !wikipediaEnabled : !bangumiEnabled) return null;
		const link = useLinks ? db.prepare('SELECT * FROM drama_work_links WHERE ' + (wiki ? 'wikipedia_id' : 'bangumi_id') + '=?').get(id) : null;
		const bgId = wiki ? link?.bangumi_id : id;
		const wpId = wiki ? id : link?.wikipedia_id;
		const bg = bgId ? db.prepare('SELECT data FROM bangumi_works WHERE id=?').get(bgId) : null;
		const wp = wpId ? db.prepare('SELECT * FROM wikipedia_editions WHERE id=?').get(wpId) : null;
		if (!bg && !wp) return null;
		const bgWork = bg ? { ...parse(bg.data), aliases: db.prepare('SELECT alias FROM bangumi_aliases WHERE work_id=?')
			.all(bgId).map(row => row.alias) } : null;
		const wpWork = wp ? { id: wp.id, title: wp.title, year: wp.year, season: wp.season, ...parse(wp.data) } : null;
		const sources = { bangumi: bg && source('bangumi').release, wikipedia: wpWork?.source };
		const episodes = [];
		const linked = new Set();
		if (bg) {
			for (const row of db.prepare('SELECT b.data AS bg, w.id AS wpId, w.data AS wp FROM bangumi_episodes b ' +
				`LEFT JOIN drama_episode_links l ON ${bangumiLink} LEFT JOIN wikipedia_episodes w ON w.id=l.wikipedia_id ` +
				'WHERE b.work_id=? ORDER BY b.kind,b.number,b.id').iterate(bgId)) {
				if (row.wpId !== null) linked.add(row.wpId);
				episodes.push(episodeInfo(parse(row.bg), row.wp ? parse(row.wp) : null, sources));
			}
		}
		if (wp) for (const row of db.prepare('SELECT id,data FROM wikipedia_episodes WHERE edition_id=? ORDER BY kind,number,id').iterate(wpId)) {
			if (!linked.has(row.id)) episodes.push(episodeInfo(null, parse(row.data), sources));
		}
		return { bangumi: bgWork, wikipedia: wpWork, aliases: [...(bgWork?.aliases || []).map(value => ({ value, source: sources.bangumi })),
			...(wpWork?.aliases || []).map(value => ({ value, source: sources.wikipedia }))],
			season: bgWork && archiveSeason(bgWork) || wpWork?.season || null, sources, episodes };
	}
	function searchWorks(query, limit, offset) {
		const key = searchKey(query);
		const works = `
			SELECT 'bangumi:' || b.id AS id, b.title, b.year, coalesce(b.season,w.season) AS season,
				CASE WHEN w.id IS NULL THEN 'bangumi' ELSE 'bangumi-wikipedia' END AS source
			FROM bangumi_works b LEFT JOIN drama_work_links l ON ${bangumiLink} LEFT JOIN wikipedia_editions w ON w.id=l.wikipedia_id
			WHERE ${Number(bangumiEnabled)}
			UNION ALL
			SELECT 'wikipedia:' || w.id, w.title, w.year, w.season, 'wikipedia'
			FROM wikipedia_editions w LEFT JOIN drama_work_links l ON ${wikipediaLink} WHERE ${Number(wikipediaEnabled)} AND l.bangumi_id IS NULL`;
		const params = key ? { $key: key } : {};
		const matches = key ? `
			WITH names(id, name, alternative) AS (
				SELECT 'bangumi:' || id, title, 0 FROM bangumi_works WHERE ${Number(bangumiEnabled)}
				UNION ALL SELECT 'bangumi:' || id, json_extract(data,'$.name_cn'), 1 FROM bangumi_works WHERE ${Number(bangumiEnabled)}
				UNION ALL SELECT 'bangumi:' || work_id, alias, 1 FROM bangumi_aliases WHERE ${Number(bangumiEnabled)}
				UNION ALL SELECT coalesce('bangumi:' || l.bangumi_id, 'wikipedia:' || w.id), w.title, 0
					FROM wikipedia_editions w LEFT JOIN drama_work_links l ON ${wikipediaLink} WHERE ${Number(wikipediaEnabled)}
				UNION ALL SELECT coalesce('bangumi:' || l.bangumi_id, 'wikipedia:' || w.id),
					json_extract(w.data,'$.article_work_name'), 1
					FROM wikipedia_editions w LEFT JOIN drama_work_links l ON ${wikipediaLink} WHERE ${Number(wikipediaEnabled)}
				UNION ALL SELECT coalesce('bangumi:' || l.bangumi_id, 'wikipedia:' || w.id), a.value, 1
					FROM wikipedia_editions w LEFT JOIN drama_work_links l ON ${wikipediaLink}, json_each(w.data,'$.aliases') a WHERE ${Number(wikipediaEnabled)}
			), hits AS (
				SELECT id, min(drama_search_rank(name, $key, alternative)) AS rank FROM names GROUP BY id
				HAVING rank IS NOT NULL
			)
			SELECT works.*, hits.rank FROM (${works}) works JOIN hits USING(id)` : `SELECT works.*, 0 AS rank FROM (${works}) works`;
		if (key) db.function('drama_search_rank', { deterministic: true }, (name, needle, alternative) => {
			const title = searchKey(name);
			if (title === needle) return alternative ? 2 : 0;
			if (title.startsWith(needle)) return alternative ? 3 : 4;
			if (title.includes(needle)) return alternative ? 6 : 5;
			return null;
		});
		if (key) db.function('drama_search_family', { deterministic: true }, name => baseTitle(name) || searchKey(name));
		const total = db.prepare(`SELECT count(*) AS total FROM (${matches})`).get(params).total;
		const results = limit && offset < total ? db.prepare(`SELECT id,title,year AS firstYear,season,source FROM (${matches})
			ORDER BY rank,${key ? 'drama_search_family(title), firstYear IS NULL, firstYear, season, title' : 'title, firstYear, season'},id
			LIMIT $limit OFFSET $offset`).all({ ...params, $limit: limit, $offset: offset }) : [];
		return { results, total };
	}
	function matchingTitles() {
		const titles = new Map();
		const names = [];
		for (const row of db.prepare(`SELECT b.id,b.title,b.year,b.season,w.id AS wiki FROM bangumi_works b
			LEFT JOIN drama_work_links l ON ${bangumiLink} LEFT JOIN wikipedia_editions w ON w.id=l.wikipedia_id WHERE ${Number(bangumiEnabled)}`).iterate()) {
			const id = 'bangumi:' + row.id;
			titles.set(id, { title: row.title, firstYear: row.year, season: row.season, source: row.wiki ? 'bangumi-wikipedia' : 'bangumi' });
			names.push({ id, name: row.title });
			const numbered = /^(.*?)[ \u3000]+(?:Season|シーズン)\s*(\d+)$/iu.exec(row.title.normalize('NFKC'));
			if (numbered && row.season === Number(numbered[2])) names.push({ id, name: numbered[1] + numbered[2] });
		}
		for (const row of db.prepare('SELECT work_id,alias FROM bangumi_aliases WHERE ?').iterate(Number(bangumiEnabled))) {
			names.push({ id: 'bangumi:' + row.work_id, name: row.alias });
		}
		for (const row of db.prepare(`SELECT w.id,w.title,w.year,w.season,w.data,l.bangumi_id FROM wikipedia_editions w
			LEFT JOIN drama_work_links l ON ${wikipediaLink} WHERE ${Number(wikipediaEnabled)}`).iterate()) {
			const id = row.bangumi_id ? 'bangumi:' + row.bangumi_id : 'wikipedia:' + row.id;
			if (!row.bangumi_id) titles.set(id, { title: row.title, firstYear: row.year, season: row.season, source: 'wikipedia' });
			const work = parse(row.data);
			for (const name of [row.title, work.article_work_name, ...(work.aliases || [])].filter(Boolean)) names.push({ id, name });
		}
		return { titles, names };
	}
	function browse(query) {
		db.exec('BEGIN');
		try {
			return { ...query(), version: [bangumiEnabled ? source('bangumi').revision ?? null : false,
				wikipediaEnabled ? source('wikipedia').publishedAt ?? null : false] };
		} finally {
			db.exec('ROLLBACK');
		}
	}
	function stageBangumi() {
		db.exec('CREATE TEMP TABLE draft_works AS SELECT * FROM bangumi_works WHERE 0; ' +
			'CREATE TEMP TABLE draft_aliases AS SELECT * FROM bangumi_aliases WHERE 0; ' +
			'CREATE TEMP TABLE draft_episodes AS SELECT * FROM bangumi_episodes WHERE 0');
		const putWork = db.prepare('INSERT INTO draft_works VALUES (?, ?, ?, ?, ?)');
		const putAlias = db.prepare('INSERT INTO draft_aliases VALUES (?, ?)');
		const putEpisode = db.prepare('INSERT INTO draft_episodes VALUES (?, ?, ?, ?, ?)');
		return {
			work(work) {
				const { aliases, ...metadata } = work;
				putWork.run(work.id, work.name, dateYear(work.firstBroadcast?.date || work.date), archiveSeason(work), json(metadata));
				for (const alias of aliases) putAlias.run(work.id, alias);
			},
			episode(row) {
				const { id, subject_id, sort, type, name, name_cn, airdate, duration } = row;
				putEpisode.run(id, subject_id, sort, type, json({ id, subject_id, sort, type, name, name_cn, airdate, duration }));
			},
			publish(asset) {
				transaction(db, () => {
					db.exec('DELETE FROM bangumi_works; INSERT INTO bangumi_works SELECT * FROM draft_works; ' +
						'INSERT INTO bangumi_aliases SELECT * FROM draft_aliases; INSERT INTO bangumi_episodes SELECT * FROM draft_episodes');
					completeLinkRefresh();
					setSource('bangumi', { revision: asset.digest, release: { name: asset.name, digest: asset.digest,
						url: asset.browser_download_url, publishedAt: asset.created_at,
						licenseUrl: 'https://bangumi.tv/about/copyright' }, publishedAt: Date.now() });
				});
			}
		};
	}
	function audit() {
		const values = { subtitlesFromWiki: 0, titleCandidates: 0, datesFromWiki: 0, datesFromBangumi: 0, conflictingDates: 0 };
		for (const row of db.prepare('SELECT b.data AS bg, w.data AS wp FROM drama_episode_links l ' +
			'JOIN bangumi_episodes b ON b.id=l.bangumi_id JOIN wikipedia_episodes w ON w.id=l.wikipedia_id').iterate()) {
			const b = parse(row.bg);
			const w = parse(row.wp);
			const original = decorateSubtitle(b.name);
			if (!original || subtitleLanguage(original) === 'zh') {
				const supplement = episodeInfo(b, w, {});
				if (supplement.subtitle) values.subtitlesFromWiki++;
				if (supplement.subtitleCandidate) values.titleCandidates++;
			}
			const left = validAirdate(b.airdate);
			const right = validAirdate(w.airdate);
			if (!left && right) values.datesFromWiki++;
			if (left && !right) values.datesFromBangumi++;
			if (left && right && left !== right) values.conflictingDates++;
		}
		const only = db.prepare("SELECT (SELECT count(*) FROM wikipedia_editions w WHERE NOT EXISTS " +
			"(SELECT 1 FROM drama_work_links l WHERE l.wikipedia_id=w.id)) AS wikipediaUnlinkedWorks, " +
			"(SELECT count(*) FROM wikipedia_episodes w JOIN drama_work_links l ON l.wikipedia_id=w.edition_id " +
			"WHERE w.kind IN ('normal','special') AND NOT EXISTS(SELECT 1 FROM drama_episode_links e WHERE e.wikipedia_id=w.id)) " +
			"AS wikipediaUnlinkedEpisodesOnLinkedWorks").get();
		return { ...values, ...only };
	}
	return { source, setSource, counts, years, planningYears, discover, pending, setSeeds, closeYears, articleIds, dueArticles,
		savePage, getWork, searchWorks, matchingTitles, browse, audit, stageBangumi, refreshPendingLinks,
		markChecked: (id, candidates, now) => transaction(db, () => {
			db.prepare('UPDATE wikipedia_articles SET checked_at=? WHERE id=?').run(now, id);
			scheduleArticle(db, id, now);
			resolveCandidates(candidates, id);
		}),
		bangumiNames: year => {
			const aliases = db.prepare('SELECT alias FROM bangumi_aliases WHERE work_id=? ORDER BY alias');
			const tvStation = /テレビ|NHK|WOWOWプライム|BS[1-9T]|TBS|MBS|ABC|CBC|TOKYO MX|富士電視|日本電視|朝日電視|東京電視|電視台|电视台/iu;
			return db.prepare('SELECT id,title,season,data FROM bangumi_works WHERE year=?').all(year).flatMap(row => {
				const work = parse(row.data);
				const classified = [1,6001].includes(work.platform);
				const tv = (work.broadcasters || []).some(name => tvStation.test(name)) ||
					work.tvTemplate && !(work.streaming || []).length;
				if (classified ? work.total === 1 && !tv :
					work.platform !== 0 || !tv || work.origin !== 'japan' && work.evidence?.language !== 1) return [];
				return [{ id: row.id, title: row.title, season: row.season, platform: work.platform,
					single: work.total === 1, aliases: aliases.all(row.id).map(row => row.alias) }];
			});
		},

		close: () => db.close() };
}

module.exports = { openStore };
