'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { withLock } = require('./reservation-store');
const { stableJson, assertCaptureCurrent } = require('./series-input-context');
const { eventKey } = require('./series-projector');
const { normalizeMatchEntry } = require('./match-detail-resolver');

const clone = value => JSON.parse(JSON.stringify(value));
const digest = value => createHash('sha256').update(value).digest('hex');
const hash = value => digest(stableJson(value));
// Dependencies of placement, propagation, exploration and attention grouping.
// Do not persist program snapshots, dictionary metadata or final overlays.
const RESULT_FIELDS = ['classification', 'selectedTid', 'tidConfirmed', 'tidConfirmationSource',
	'episodeConfirmed', 'multipleEpisodeConfirmed', 'episodeConfirmationSource', 'candidateTids',
	'competitiveTids', 'candidates', 'workIdentity', 'directPids', 'scheduleConflict', 'reason',
	'proglookupStatus', 'proglookupAvailability', 'proglookupTidConfirmed', 'proglookupEpisodeConfirmed',
	'episodeRelation', 'episodeIdentity'];
function savedResult(resolution) {
	const result = clone(Object.fromEntries(RESULT_FIELDS.map(key => [key, resolution[key]])));
	// Subtitle text is display data. Propagation needs only numeric identities,
	// status and evidence; current subtitles come from the dictionary.
	result.candidates = result.candidates.map(candidate => {
		const { dictionarySubtitle, ...subtitle } = candidate.subtitle;
		return { ...candidate, subtitle };
	});
	return result;
}
function read(filename) {
	try { return fs.readFileSync(filename, 'utf8'); }
	catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function parse(text) {
	if (text === null) return { version: 1, lastCleanupAt: 0, entries: {} };
	const state = JSON.parse(text);
	if (state.version !== 1 || !state.entries || Array.isArray(state.entries) || typeof state.entries !== 'object' ||
		!Number.isFinite(state.lastCleanupAt) || state.lastCleanupAt < 0) throw new Error('invalid series match cache');
	return state;
}

// Cache only pre-propagation automatic decisions. Return a fresh copy because
// projectSeries mutates resolutions during its existing one-step propagation.
function createMatchCache(options, context) {
	const started = performance.now();
	const filename = options.matchCachePath;
	const original = read(filename);
	const state = parse(original);
	const prog = context.progLookupStore.getSnapshot();
	const logic = ['series-resolver.js', 'series-projector.js', 'series-service.js', 'syobocal-channel-map.js', 'proglookup-store.js', 'series-match-cache.js']
		.map(name => digest(fs.readFileSync(path.join(__dirname, name))));
	const logicIdentity = hash(logic);
	const mappings = rows => (rows || []).map(row => [row.nid, row.sid, row.status, row.chId,
		row.chIds || [], row.candidateChIds || [], row.acquisitionCandidateChIds || []]);
	const coverage = [...new Set(prog.coverage.map(row => stableJson([row.kind, row.startMs, row.endMs,
		[...new Set(row.chIds)].sort((a, b) => a - b)])))].sort();
	const environment = hash({ logic: logicIdentity, dictionary: context.publication.generation,
		channels: mappings(context.independentMap?.channels), unresolved: mappings(context.independentMap?.unresolved),
		programs: prog.programs, coverage });
	const metrics = { cacheReadMs: performance.now() - started, cacheReused: 0, cacheResolved: 0, resolutionMs: 0,
		cacheSaveMs: 0, cleanupMs: 0, cleanupScanned: 0, cleanupDeleted: 0 };
	let changed = false;
	function resolve(event, resolver) {
		const t = performance.now();
		const p = event.program;
		const previous = Object.hasOwn(state.entries, event.key) ? state.entries[event.key] : null;
		const fingerprint = hash({ environment, title: p.title, fullTitle: p.fullTitle, subTitle: p.subTitle,
			episode: p.episode, detail: p.detail, description: p.description, start: p.start, end: p.end,
			seconds: p.seconds, channel: { nid: p.channel?.nid, sid: p.channel?.sid } });
		let resolution;
		if (previous?.fingerprint === fingerprint && previous.result && previous.checksum === hash(previous.result) &&
			Array.isArray(previous.result.candidates) && previous.result.tidConfirmationSource !== 'confirmed-event-propagation') {
			resolution = clone(previous.result);
			resolution.program = p;
			resolution.id = p.id || p.programId || null;
			metrics.cacheReused++;
		} else {
			resolution = resolver.resolve(p);
			const saved = savedResult(resolution);
			Object.defineProperty(state.entries, event.key, { enumerable: true, configurable: true, writable: true,
				value: { fingerprint, result: saved, checksum: hash(saved) } });
			changed = true;
			metrics.cacheResolved++;
		}
		metrics.resolutionMs += performance.now() - t;
		return resolution;
	}
	function save() {
		const began = performance.now();
		const now = Date.now();
		const lastCleanupAt = Math.max(state.lastCleanupAt, options.matchCleanupAt || 0);
		const days = Number.isInteger(options.seriesMatchCleanupIntervalDays) && options.seriesMatchCleanupIntervalDays >= 0 ?
			options.seriesMatchCleanupIntervalDays : 30;
		let cleanupAt = lastCleanupAt;
		const removed = new Map();
		if (days > 0 && now - lastCleanupAt >= days * 86400000) {
			const cleanupStarted = performance.now();
			// A changed/read-failed ledger must never be interpreted as absence.
			try {
				assertCaptureCurrent(context, options);
				const keys = new Set();
				for (const p of [...context.inputs.reserves, ...context.inputs.recorded]) keys.add(eventKey(p));
				for (const match of context.inputs.match) keys.add(normalizeMatchEntry(match).key);
				metrics.cleanupScanned = Object.keys(state.entries).length;
				for (const key of Object.keys(state.entries)) if (!keys.has(key)) {
					removed.set(key, state.entries[key]);
					delete state.entries[key]; metrics.cleanupDeleted++; changed = true;
				}
				cleanupAt = now;
			} catch (error) { metrics.cleanupDeferred = error.message; }
			metrics.cleanupMs = performance.now() - cleanupStarted;
		}
		state.lastCleanupAt = cleanupAt;
		// Carry successful no-op cleanup times through the existing coordinator;
		// persist them with the next content change, without rewriting all entries.
		metrics.matchCleanupAt = cleanupAt;
		if (changed) {
			fs.mkdirSync(path.dirname(filename), { recursive: true });
			withLock(filename, () => {
				if (read(filename) !== original) {
					metrics.cacheSaveSuperseded = true; metrics.matchCleanupAt = lastCleanupAt;
					metrics.cleanupDeleted = 0; metrics.cleanupDeferred = 'cache-superseded'; return;
				}
				if (cleanupAt !== lastCleanupAt) {
					try { assertCaptureCurrent(context, options); }
					catch (error) {
						for (const [key, entry] of removed) Object.defineProperty(state.entries, key, { value: entry, enumerable: true, writable: true, configurable: true });
						state.lastCleanupAt = lastCleanupAt; metrics.matchCleanupAt = lastCleanupAt;
						metrics.cleanupDeleted = 0; metrics.cleanupDeferred = error.message;
						if (!metrics.cacheResolved) return;
					}
				}
				const temporary = filename + '.tmp-' + randomUUID();
				let fd;
				try {
					fd = fs.openSync(temporary, 'wx', 0o600);
					fs.writeFileSync(fd, JSON.stringify(state) + '\n');
					fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
					if (metrics.cleanupDeleted) {
						try { assertCaptureCurrent(context, options); }
						catch (error) {
							metrics.cleanupDeleted = 0; metrics.matchCleanupAt = lastCleanupAt;
							metrics.cleanupDeferred = error.message; metrics.cacheSaveDeferred = true;
							return;
						}
					}
					fs.renameSync(temporary, filename);
				} finally {
					if (fd !== undefined) fs.closeSync(fd);
					try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
				}
			});
		}
		metrics.cacheSaveMs = performance.now() - began - metrics.cleanupMs;
		return metrics;
	}
	return { resolve, save, metrics };
}
module.exports = { createMatchCache };
