'use strict';

// Chinachu's TitleLookup builder: official fields + existing reader contract.
// Acquisition and SQLite work stay off the WUI event loop. The root dictionary
// is never opened. All resumable state belongs to the new working database.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { isMainThread, parentPort, workerData } = require('node:worker_threads');
const { XMLParser, XMLValidator } = require('fast-xml-parser');
const { compact, createDictionaryStore } = require('./series-resolver');
const { formatApiTime } = require('./proglookup-updater');

const APPLICATION_ID = 0x43484431; // CHD1: this product's dictionary format.
const VERSION = 1;
const LIST_FIELDS = 'TID,Title,LastUpdate';
const DETAIL_FIELDS = 'TID,Title,ShortTitle,FirstYear,FirstMonth,SubTitles,LastUpdate';
const parser = new XMLParser({ ignoreAttributes: false, trimValues: false,
	parseTagValue: false, isArray: name => name === 'TitleItem' });

function parseTitles(xml, fields, allowEmpty) {
	if (/<!DOCTYPE/iu.test(xml) || XMLValidator.validate(xml) !== true ||
		!/<\/TitleLookupResponse>\s*$/u.test(xml)) throw new Error('incomplete TitleLookup XML');
	const root = parser.parse(xml).TitleLookupResponse;
	const code = root && String(root.Result && root.Result.Code);
	if (allowEmpty && code === '404') return [];
	if (code !== '200') throw new Error('TitleLookup Result/Code=' + code);
	const rows = root.TitleItems && root.TitleItems.TitleItem || [];
	if (!Array.isArray(rows) || (!allowEmpty && !rows.length)) throw new Error('empty TitleLookup response');
	const seen = new Set();
	for (const row of rows) {
		if (fields.split(',').some(field => typeof row[field] !== 'string')) throw new Error('missing TitleLookup field');
		const tid = Number(row.TID);
		if (!/^[1-9]\d*$/u.test(row.TID) || !Number.isSafeInteger(tid) || seen.has(tid) || !compact(row.Title)) {
			throw new Error('invalid/duplicate TitleLookup TID');
		}
		seen.add(tid);
		row.tid = tid;
	}
	return rows;
}

function parseSubtitles(source) {
	const seen = new Map();
	const blocked = new Set();
	let rejected = 0;
	for (const line of source.split(/\r\n|\n|\r/u)) {
		if (!line.trim()) continue;
		const match = /^\*([0-9]+)\*(.*)$/u.exec(line);
		const number = match ? Number(match[1]) : NaN;
		if (!Number.isSafeInteger(number) || number <= 0) { rejected++; continue; }
		const subtitle = match[2];
		if (seen.has(number)) {
			if (seen.get(number) !== subtitle) { blocked.add(number); rejected++; }
		} else seen.set(number, subtitle);
	}
	const episodes = [];
	for (const [episode, subtitle] of seen) {
		if (blocked.has(episode)) continue;
		const key = compact(subtitle);
		if (!subtitle.trim()) { rejected++; continue; }
		episodes.push({ episode, subtitle, key });
	}
	return { episodes, rejected };
}

function getMeta(db, key) {
	const row = db.prepare('SELECT value FROM dictionary_meta WHERE key=?').get(key);
	return row ? JSON.parse(row.value) : null;
}
function setMeta(db, key, value) {
	db.prepare('INSERT OR REPLACE INTO dictionary_meta(key,value) VALUES (?,?)').run(key, JSON.stringify(value));
}
function assertFormat(db) {
	if (db.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID ||
		db.prepare('PRAGMA user_version').get().user_version !== VERSION) throw new Error('unsupported dictionary format');
	if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('dictionary integrity check failed');
	if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') throw new Error('dictionary must use DELETE journal mode');
}
function inspectPublished(filename) {
	if (!fs.existsSync(filename)) return null;
	const db = new DatabaseSync(filename, { readOnly: true });
	try {
		assertFormat(db);
		const metadata = getMeta(db, 'published');
		if (!metadata || metadata.source !== 'syobocal-official-titlelookup' || !metadata.generation ||
			!Number.isFinite(metadata.boundary) || !Number.isFinite(metadata.lastSuccessAt)) throw new Error('invalid published metadata');
		const reader = createDictionaryStore({ path: filename });
		try {
			const counts = reader.counts();
			if (!counts.titles) throw new Error('dictionary has no titles');
			return Object.assign({}, metadata, { counts });
		} finally { reader.close(); }
	} finally { db.close(); }
}

function createEmpty(filename) {
	const fd = fs.openSync(filename, 'wx', 0o600);
	fs.closeSync(fd);
	const db = new DatabaseSync(filename);
	db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
		PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${VERSION};
		CREATE TABLE titles(tid INTEGER PRIMARY KEY,title TEXT NOT NULL,lookup_key TEXT NOT NULL,
			short_title TEXT,first_year TEXT,first_month TEXT,last_update TEXT);
		CREATE TABLE aliases(tid INTEGER NOT NULL,lookup_key TEXT NOT NULL,PRIMARY KEY(tid,lookup_key));
		CREATE TABLE episodes(tid INTEGER NOT NULL,episode INTEGER NOT NULL,subtitle TEXT NOT NULL,
			lookup_key TEXT NOT NULL,PRIMARY KEY(tid,episode));
		CREATE INDEX idx_titles_key ON titles(lookup_key);
		CREATE INDEX idx_aliases_key ON aliases(lookup_key);
		CREATE INDEX idx_episodes_key ON episodes(lookup_key);
		CREATE TABLE dictionary_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
	return db;
}

async function build(options, fetchXml, report, cancelled) {
	const filename = options.path;
	const stage = filename + '.building';
	fs.mkdirSync(path.dirname(filename), { recursive: true });
	let db;
	let published = null;
	try {
		try { published = inspectPublished(filename); }
		catch (error) { report({ usable: false, validationError: error.message }); }
		report({ usable: !!published, published, phase: published ? 'ready' : 'preparing' });
		if (cancelled()) throw new Error('dictionary build cancelled');
		if (published && options.now < published.boundary + options.updateIntervalMs && !fs.existsSync(stage)) return;
		let progress = null;
		if (fs.existsSync(stage)) {
			try {
				db = new DatabaseSync(stage);
				assertFormat(db);
				progress = getMeta(db, 'build');
				if (!progress || progress.base !== (published && published.generation) || !Array.isArray(progress.ids) ||
					!Number.isInteger(progress.next) || progress.next < 0 || progress.next > progress.ids.length ||
					!Number.isFinite(progress.boundary)) throw new Error('invalid dictionary checkpoint');
			} catch (_) {
				if (db) db.close();
				db = null;
				// Only this builder's unfinished database is disposable.
				for (const suffix of ['', '-journal', '-wal', '-shm']) fs.rmSync(stage + suffix, { force: true });
			}
		}
		if (!db) {
			if (published) {
				fs.copyFileSync(filename, stage, fs.constants.COPYFILE_EXCL);
				db = new DatabaseSync(stage);
			} else db = createEmpty(stage);
			progress = { base: published && published.generation, mode: published ? 'delta' : 'full',
				boundary: Math.floor(options.now / 1000) * 1000, ids: [], next: 0, listed: false, rejected: 0 };
			setMeta(db, 'build', progress);
		}
		db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL');
		if (!progress.listed) {
			const parameters = { Command: 'TitleLookup', TID: '*', Fields: LIST_FIELDS };
			if (progress.mode === 'delta') {
				// Inclusive lower/exclusive upper bounds; overlap one minute so a
				// boundary-second update is not lost. Success advances only at publish.
				parameters.LastUpdate = formatApiTime(published.boundary - 60000) + '-' + formatApiTime(progress.boundary);
			}
			const rows = parseTitles(await fetchXml(parameters), LIST_FIELDS, progress.mode === 'delta');
			progress.ids = rows.map(row => row.tid).sort((a, b) => a - b);
			progress.next = 0;
			progress.listed = true;
			setMeta(db, 'build', progress);
		}
		const count = Math.min(100, Math.max(1, options.batchSize || 100));
		report({ phase: published ? 'updating' : 'preparing', completed: progress.next, total: progress.ids.length });
		while (progress.next < progress.ids.length) {
			if (cancelled()) throw new Error('dictionary build cancelled');
			const ids = progress.ids.slice(progress.next, progress.next + count);
			const xml = await fetchXml({ Command: 'TitleLookup', TID: ids.join(','), Fields: DETAIL_FIELDS });
			const rows = parseTitles(xml, DETAIL_FIELDS, true);
			if (rows.length !== ids.length || rows.some(row => !ids.includes(row.tid))) {
				// Re-enumerate this same range on retry if an item disappeared; never
				// invent a missing record. Previously published data stays untouched.
				progress.listed = false;
				setMeta(db, 'build', progress);
				throw new Error('incomplete detailed TID set');
			}
			db.exec('BEGIN');
			try {
				for (const row of rows) {
					db.prepare('INSERT OR REPLACE INTO titles VALUES (?,?,?,?,?,?,?)').run(row.tid, row.Title,
						compact(row.Title), row.ShortTitle, row.FirstYear, row.FirstMonth, row.LastUpdate);
					db.prepare('DELETE FROM episodes WHERE tid=?').run(row.tid);
					const parsed = parseSubtitles(row.SubTitles);
					progress.rejected += parsed.rejected;
					const insert = db.prepare('INSERT INTO episodes VALUES (?,?,?,?)');
					for (const episode of parsed.episodes) insert.run(row.tid, episode.episode, episode.subtitle, episode.key);
				}
				progress.next += ids.length;
				setMeta(db, 'build', progress);
				db.exec('COMMIT');
			} catch (error) { db.exec('ROLLBACK'); throw error; }
			report({ completed: progress.next, total: progress.ids.length, rejectedSubtitles: progress.rejected });
		}
		if (cancelled()) throw new Error('dictionary build cancelled');
		db.exec('BEGIN; DELETE FROM aliases;');
		try {
			if (progress.mode === 'full') {
				const keep = new Set(progress.ids);
				for (const row of db.prepare('SELECT tid FROM titles').all()) if (!keep.has(row.tid)) {
					for (const table of ['titles', 'aliases', 'episodes']) db.prepare('DELETE FROM ' + table + ' WHERE tid=?').run(row.tid);
				}
				if (db.prepare('SELECT COUNT(*) AS n FROM titles').get().n !== progress.ids.length) throw new Error('full dictionary TID count mismatch');
			}
			// ShortTitle alone is adopted. Rebuild the keys after each delta so a
			// collision introduced/removed by another title is handled consistently.
			const insert = db.prepare('INSERT OR IGNORE INTO aliases VALUES (?,?)');
			for (const row of db.prepare('SELECT tid,title,short_title FROM titles').all()) {
				const key = compact(row.short_title);
				if (key && key !== compact(row.title)) insert.run(row.tid, key);
			}
			db.exec(`DELETE FROM aliases WHERE lookup_key IN (
				SELECT lookup_key FROM aliases GROUP BY lookup_key HAVING COUNT(*)>1
			) OR EXISTS (SELECT 1 FROM titles WHERE titles.lookup_key=aliases.lookup_key AND titles.tid<>aliases.tid);`);
			const metadata = { source: 'syobocal-official-titlelookup', generation: randomUUID(),
				boundary: progress.boundary, lastSuccessAt: Date.now(), rejectedSubtitles: progress.rejected };
			setMeta(db, 'published', metadata);
			// Keep the completed checkpoint: if WUI exits between COMMIT and
			// rename, the next run can validate/publish without downloading again.
			// The next incremental working copy replaces it with its own checkpoint.
			db.exec('COMMIT');
		} catch (error) { db.exec('ROLLBACK'); throw error; }
		if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('built dictionary integrity failed');
		if (db.prepare("SELECT COUNT(*) AS n FROM episodes WHERE typeof(episode)<>'integer' OR episode<=0").get().n) throw new Error('invalid episode in dictionary');
		db.close(); db = null;
		const ready = inspectPublished(stage);
		if (['-journal', '-wal', '-shm'].some(suffix => fs.existsSync(filename + suffix))) {
			throw new Error('published dictionary has unexpected SQLite sidecars; publication cancelled');
		}
		// All handles on the working file are closed, journal_mode=DELETE. POSIX
		// rename replaces only the pathname; existing read-only readers stay valid.
		const fd = fs.openSync(stage, 'r');
		try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
		fs.renameSync(stage, filename);
		const directory = fs.openSync(path.dirname(filename), 'r');
		try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
		report({ usable: true, published: ready, phase: 'ready', completed: progress.ids.length,
			total: progress.ids.length, rejectedSubtitles: progress.rejected, justPublished: true });
	} finally {
		if (db) db.close();
	}
}

if (!isMainThread) {
	let cancelled = false;
	let sequence = 0;
	const requests = new Map();
	parentPort.on('message', message => {
		if (message.type === 'cancel') { cancelled = true; return; }
		const pending = requests.get(message.id);
		if (!pending) return;
		requests.delete(message.id);
		if (message.error) pending.reject(Object.assign(new Error(message.error.message), message.error));
		else pending.resolve(message.body);
	});
	const fetchXml = parameters => new Promise((resolve, reject) => {
		const id = ++sequence;
		requests.set(id, { resolve, reject });
		parentPort.postMessage({ type: 'request', id, parameters });
	});
	build(workerData, fetchXml, value => parentPort.postMessage({ type: 'status', value }), () => cancelled)
		.then(() => parentPort.postMessage({ type: 'done' }))
		.catch(error => parentPort.postMessage({ type: 'failed', error: { message: error.message, code: error.code } }))
		.finally(() => parentPort.close());
}

module.exports = { DETAIL_FIELDS, LIST_FIELDS, parseTitles, parseSubtitles, inspectPublished };
