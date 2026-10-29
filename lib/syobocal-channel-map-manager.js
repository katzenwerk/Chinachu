'use strict';

const fs = require('fs');
const channelCatalog = require('./syobocal-channel-catalog');
const channelMap = require('./syobocal-channel-map');
const progLookup = require('./proglookup-updater');
const seriesResolver = require('./series-resolver');

const CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function serviceKey(value) {
	const nid = Number(value && value.nid);
	const sid = Number(value && value.sid);
	return Number.isInteger(nid) && Number.isInteger(sid) ? nid + ':' + sid : null;
}

function atomicWriteMap(filename, value) {
	channelCatalog.atomicWriteJson(fs, filename, value);
}

function loadDictionaryTitles(filename) {
	if (!filename || !fs.existsSync(filename)) return new Map();
	const dictionary = seriesResolver.createDictionaryStore({ path: filename });
	try {
		return new Map(Array.from(dictionary.titles, ([tid, value]) => [tid, value.title]));
	} finally {
		dictionary.close();
	}
}

function preserveVerifiedBindings(current, generated, availableChannels) {
	if (!current) return { map: generated, preserved: [], conflicts: [] };
	const available = new Set((Array.isArray(availableChannels) ? availableChannels : [])
		.map(serviceKey).filter(Boolean));
	const nextByService = new Map(generated.channels.map(entry => [serviceKey(entry), entry]));
	const unresolvedByService = new Map(generated.unresolved.map(entry => [serviceKey(entry), entry]));
	const preserved = [];
	const conflicts = [];
	for (const existing of current.channels) {
		const key = serviceKey(existing);
		if (!key || !available.has(key)) continue;
		const next = nextByService.get(key);
		if (next && Number(next.chId) !== Number(existing.chId)) {
			conflicts.push({
				service: key,
				nid: Number(existing.nid),
				sid: Number(existing.sid),
				previousChId: Number(existing.chId),
				nextChId: Number(next.chId),
				previousEvidence: existing.evidence || null,
				nextEvidence: next.evidence || null
			});
			nextByService.set(key, existing);
			unresolvedByService.delete(key);
			preserved.push({ service: key, chId: Number(existing.chId), reason: 'verified-binding-conflict' });
			continue;
		}
		if (!next) {
			nextByService.set(key, existing);
			unresolvedByService.delete(key);
			preserved.push({ service: key, chId: Number(existing.chId), reason: 'previous-verified-binding' });
		}
	}
	const result = Object.assign({}, generated, {
		provenance: Object.assign({}, generated.provenance, {
			preservedVerified: preserved,
			verifiedBindingConflicts: conflicts
		}),
		channels: Array.from(nextByService.values()).sort((left, right) => left.nid - right.nid || left.sid - right.sid),
		unresolved: Array.from(unresolvedByService.values()).sort((left, right) => left.nid - right.nid || left.sid - right.sid)
	});
	return { map: result, preserved, conflicts };
}

function createSyobocalChannelMapManager(options) {
	options = options || {};
	if (!options.catalogPath) throw new TypeError('Syobocal channel catalog path is required');
	if (!options.channelMapPath) throw new TypeError('Syobocal ChID map path is required');
	if (!options.progLookupStore) throw new TypeError('ProgLookup store is required');
	const now = options.now || Date.now;
	const log = options.log || function () {};
	const getAvailableChannels = options.getAvailableChannels || (() => []);
	let running = null;
	let queued = null;
	let queuedRefresh = false;
	let stopped = false;

	function readCurrentMap() {
		if (!fs.existsSync(options.channelMapPath)) return null;
		const current = channelMap.readIndependentChannelMap(options.channelMapPath);
		if (!current) throw Object.assign(new Error('existing Syobocal ChID map is invalid'), {
			code: 'channel-map-invalid'
		});
		return current;
	}

	function readCatalog() {
		return channelCatalog.readChannelCatalog(options.catalogPath);
	}

	function catalogIsStale(catalog) {
		const fetchedAt = Date.parse(catalog && catalog.fetchedAt);
		return !Number.isFinite(fetchedAt) || now() - fetchedAt >= (Number(options.catalogMaxAgeMs) || CATALOG_MAX_AGE_MS);
	}

	async function ensureCatalog(allowRefresh) {
		const current = readCatalog();
		if (current && (!allowRefresh || !catalogIsStale(current))) return current;
		try {
			const fetched = await channelCatalog.fetchChannelCatalog({
				userAgent: options.userAgent,
				client: options.client,
				request: options.request,
				sleep: options.sleep,
				now
			});
			if (stopped) return current;
			channelCatalog.writeChannelCatalog(options.catalogPath, fetched);
			log('Syobocal channel catalog updated: ' + fetched.officialChannels.length + ' channels, ' +
				fetched.channelGroups.length + ' groups');
			return fetched;
		} catch (error) {
			if (current) {
				log('Syobocal channel catalog update failed; using the previous catalog: ' + error.message);
				return current;
			}
			throw error;
		}
	}

	function generate(catalog) {
		const availableChannels = getAvailableChannels();
		if (!Array.isArray(availableChannels) || !availableChannels.length) {
			throw Object.assign(new Error('Mirakurun schedule has no channel services yet'), { code: 'schedule-unavailable' });
		}
		const snapshot = options.progLookupStore.getSnapshot();
		const titles = loadDictionaryTitles(options.dictionaryPath);
		const generated = channelMap.buildIndependentChannelMap({
			mirakurunChannels: availableChannels,
			officialChannels: catalog.officialChannels,
			channelGroups: catalog.channelGroups,
			progLookupItems: snapshot.programs,
			progLookupCoverage: snapshot.coverage,
			titles,
			provenance: {
				generatedAt: new Date(now()).toISOString(),
				catalogFetchedAt: catalog.fetchedAt,
				catalogSources: catalog.sources,
				progLookupGeneration: snapshot.generation
			}
		});
		const current = readCurrentMap();
		const guarded = preserveVerifiedBindings(current, generated, availableChannels);
		const targetChIds = progLookup.targetChIdsFromMap(guarded.map, availableChannels);
		return { map: guarded.map, targetChIds, preserved: guarded.preserved, conflicts: guarded.conflicts,
			created: current === null };
	}

	async function rebuild(optionsForRun) {
		if (stopped) return null;
		optionsForRun = optionsForRun || {};
		if (running) {
			queuedRefresh = queuedRefresh || optionsForRun.refreshCatalog === true;
			if (!queued) {
				queued = running.then(() => {
					const refreshCatalog = queuedRefresh;
					queued = null;
					queuedRefresh = false;
					return rebuild({ refreshCatalog });
				});
			}
			return queued;
		}
		running = (async () => {
			const availableChannels = getAvailableChannels();
			if (!Array.isArray(availableChannels) || !availableChannels.length) {
				throw Object.assign(new Error('Mirakurun schedule has no channel services yet'), {
					code: 'schedule-unavailable'
				});
			}
			const catalog = await ensureCatalog(optionsForRun.refreshCatalog === true);
			if (stopped) return null;
			const result = generate(catalog);
			atomicWriteMap(options.channelMapPath, result.map);
			for (const conflict of result.conflicts) {
				log('Syobocal ChID conflict for NID/SID ' + conflict.nid + '/' + conflict.sid +
					': kept ChID ' + conflict.previousChId + ', rejected ChID ' + conflict.nextChId +
					' (previous=' + String(conflict.previousEvidence && conflict.previousEvidence.type || 'unknown') +
					', proposed=' + String(conflict.nextEvidence && conflict.nextEvidence.type || 'unknown') + ')');
			}
			log('Syobocal ChID map updated: ' + result.map.channels.length + ' verified, ' +
				result.map.unresolved.length + ' unresolved, ' + result.targetChIds.length + ' acquisition ChIDs' +
				(result.preserved.length ? ', ' + result.preserved.length + ' previous bindings preserved' : '') +
				(result.conflicts.length ? ', ' + result.conflicts.length + ' binding conflicts' : ''));
			return result;
		})().catch(error => {
			log('Syobocal ChID map update skipped: ' + error.message);
			return { error };
		}).finally(() => { running = null; });
		return running;
	}

	function stop() {
		stopped = true;
	}

	return { rebuild, stop };
}

module.exports = {
	CATALOG_MAX_AGE_MS,
	createSyobocalChannelMapManager,
	loadDictionaryTitles,
	preserveVerifiedBindings
};
