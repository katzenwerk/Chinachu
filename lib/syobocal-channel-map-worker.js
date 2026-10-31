'use strict';

const { parentPort, workerData } = require('worker_threads');
try {
	const availableChannels = workerData.schedulePath ?
		require('./reservation-store').readArray(workerData.schedulePath) : workerData.availableChannels;
	if (!Array.isArray(availableChannels) || !availableChannels.length) throw new Error('Mirakurun schedule has no channel services');
	const snapshot = require('./proglookup-store').createProgLookupStore({ path: workerData.progLookupPath }).getSnapshot();
	if (snapshot.loadError) throw new Error('ProgLookup cache cannot be read: ' + snapshot.loadError);
	const titles = require('./syobocal-channel-map-manager').loadDictionaryTitles(workerData.dictionaryPath);
	const map = require('./syobocal-channel-map').buildIndependentChannelMap({
		mirakurunChannels: availableChannels,
		officialChannels: workerData.catalog.officialChannels,
		channelGroups: workerData.catalog.channelGroups,
		progLookupItems: snapshot.programs, progLookupCoverage: snapshot.coverage, titles,
		provenance: {
			generatedAt: workerData.generatedAt, catalogFetchedAt: workerData.catalog.fetchedAt,
			catalogSources: workerData.catalog.sources, progLookupGeneration: snapshot.generation
		}
	});
	parentPort.postMessage({ map, services: availableChannels.filter(Boolean).map(channel => ({ nid: channel.nid, sid: channel.sid })) });
} catch (error) {
	parentPort.postMessage({ error: error.message });
}
parentPort.close();
