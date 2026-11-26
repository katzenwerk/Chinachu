'use strict';

const matchDetailResolver = require('./match-detail-resolver');
const seriesResolver = require('./series-resolver');

function stringValue(value) {
	return typeof value === 'undefined' || value === null ? '' : String(value);
}

function addUnique(values, value) {
	value = stringValue(value);
	if (value && !values.includes(value)) values.push(value);
}

function programIds(program) {
	const ids = [];
	['id', 'recordedId', 'origId', 'programId'].forEach(field => addUnique(ids, program && program[field]));
	return ids;
}

function eventKey(program, explicitKey) {
	return stringValue(explicitKey) || matchDetailResolver.makeCanonicalKey(program) ||
		(programIds(program)[0] ? 'id:' + programIds(program)[0] : '');
}

function richness(program) {
	if (!program || typeof program !== 'object') return 0;
	return ['title', 'fullTitle', 'detail', 'description', 'subTitle', 'episode', 'category']
		.reduce((score, field) => score + (typeof program[field] !== 'undefined' && program[field] !== '' ? 1 : 0), 0) +
		(program.channel && program.channel.name ? 2 : 0);
}

function sourceReference(source, program, match) {
	const ids = programIds(program);
	const normalized = match ? matchDetailResolver.normalizeMatchEntry(match) : null;
	return {
		source,
		ids,
		status: normalized && normalized.status || null,
		skipped: Boolean(program && program.isSkip === true) ||
			Boolean(normalized && normalized.status === 'SKIPPED_ONLY'),
		recordedId: normalized && (normalized.recording || normalized.fileMissing || {}).recordedId ||
			program && (program.recordedId || source === 'recorded' && program.id) || null,
		deleted: Boolean(normalized && matchDetailResolver.isExplicitDeletion(match)),
		fileMissing: normalized && normalized.fileMissing || (source === 'recorded' && program.fileMissing ? { ...program.fileMissing, recordedId: String(program.id) } : null),
		deletion: normalized && normalized.deletion || null
	};
}

function hasRecordingHistory(event) {
	return event.recordingIds.length > 0 || event.deleted || event.sources.some(reference =>
		reference.source === 'recorded' || reference.status === 'RECORDED' ||
		reference.status === 'RECORDED_UNTRACKED');
}

function hasActiveReservation(event) {
	return event.sources.some(reference => reference.source === 'reserves' && reference.skipped !== true);
}

function isSkippedOnlyEvent(event) {
	return event.sources.some(reference => reference.skipped === true) &&
		!hasActiveReservation(event) && !hasRecordingHistory(event);
}

function createEvent(key, program) {
	return {
		key,
		program,
		sources: [],
		ids: [],
		recordingIds: [],
		statuses: [],
		fileMissing: null,
		deleted: false,
		deletions: []
	};
}

function mergeEvent(events, key, program, source, match) {
	if (!key) return false;
	let event = events.get(key);
	if (!event) {
		event = createEvent(key, program);
		events.set(key, event);
	} else if ((source === 'recorded' && !event.sources.some(reference => reference.source === 'recorded')) ||
		richness(program) > richness(event.program)) {
		event.program = program;
	}
	const reference = sourceReference(source, program, match);
	event.sources.push(reference);
	reference.ids.forEach(id => addUnique(event.ids, id));
	addUnique(event.recordingIds, reference.recordedId);
	addUnique(event.statuses, reference.status);
	if (reference.fileMissing) event.fileMissing = reference.fileMissing;
	if (reference.deletion && reference.deletion.reason === 'recorded-missing') event.ledgerMissing = true;
	if (reference.deleted) {
		event.deleted = true;
		event.deletions.push(reference.deletion);
	}
	return true;
}

function buildEvents(options) {
	const sources = {
		recorded: Array.isArray(options.recorded) ? options.recorded : [],
		reserves: Array.isArray(options.reserves) ? options.reserves : []
	};
	const events = new Map();
	let sourceRecords = 0;
	let unidentifiedRecords = 0;

	for (const source of ['reserves', 'recorded']) {
		for (const program of sources[source]) {
			sourceRecords++;
			if (!mergeEvent(events, eventKey(program), program, source, null)) unidentifiedRecords++;
		}
	}

	const matches = Array.isArray(options.match) ? options.match : [];
	if (matches.length) {
		for (const match of matches) {
			// Explicit deletions remain in match for recorded results, not series cards.
			if (matchDetailResolver.isExplicitDeletion(match)) continue;
			const normalized = matchDetailResolver.normalizeMatchEntry(match);
			const current = events.get(normalized.key);
			// Match owns deletion/history state, never the current EPG payload.
			// A history-only event needs evidence of an actual recording.
			if (!current && !normalized.deletion && !normalized.recording &&
				!['RECORDED', 'RECORDED_UNTRACKED'].includes(normalized.status)) continue;
			if (!current && ['MISSED', 'SKIPPED_ONLY', 'RESERVED'].includes(normalized.status) && !normalized.deletion) continue;
			sourceRecords++;
			const program = current ? current.program : {
				title: normalized.fullTitle,
				fullTitle: normalized.fullTitle,
				start: normalized.start,
				end: normalized.end,
				seconds: normalized.end > normalized.start ? Math.floor((normalized.end - normalized.start) / 1000) : 0,
				channel: { id: matchDetailResolver.parseCanonicalKey(normalized.key)?.channelId || '' }
			};
			if (!mergeEvent(events, eventKey(program, normalized.key), program, 'match', match)) unidentifiedRecords++;
		}
	}

	for (const [key, event] of events) {
		if (isSkippedOnlyEvent(event) || (!hasActiveReservation(event) && !hasRecordingHistory(event))) events.delete(key);
	}

	return { events, sourceRecords, unidentifiedRecords };
}

function eventView(event) {
	const program = event.program || {};
	const channel = program.channel || {};
	return {
		key: event.key,
		ids: event.ids,
		recordingIds: event.recordingIds,
		currentRecordingIds: event.sources.filter(ref => ref.source === 'recorded').map(ref => String(ref.recordedId)),
		sources: event.sources.map(value => value.source),
		activeReservation: hasActiveReservation(event),
		statuses: event.statuses,
		deleted: event.deleted,
		fileMissing: event.deleted ? null : event.fileMissing,
		ledgerMissing: event.ledgerMissing === true,
		deletions: event.deletions,
		broadcast: {
			channel: {
				id: channel.id || null,
				name: channel.name || null,
				type: channel.type || null,
				nid: typeof channel.nid === 'undefined' ? null : channel.nid,
				sid: typeof channel.sid === 'undefined' ? null : channel.sid,
				hasLogoData: channel.hasLogoData === true
			},
			start: Number(program.start) || null,
			end: Number(program.end) || null,
			seconds: Number(program.seconds) || null,
			title: program.title || null,
			category: program.category || null,
			fullTitle: program.fullTitle || program.title || null,
			subTitle: typeof program.subTitle === 'undefined' ? null : program.subTitle,
			episode: typeof program.episode === 'undefined' ? null : program.episode,
			flags: Array.isArray(program.flags) ? program.flags.slice() : [],
			detail: program.detail || program.description || null
		},
		recordingResult: {
			fileMissing: event.deleted ? null : event.fileMissing,
			deletion: event.deleted ? event.deletions[0] || null : event.sources.find(value => value.deletion?.reason === 'recorded-missing')?.deletion || null,
			recordedDurationSeconds: program.recordedDurationSeconds ?? null,
			operatorRecordingStart: program.operatorRecordingStart ?? null,
			operatorRecordingEnd: program.operatorRecordingEnd ?? null,
			operatorActualSeconds: program.operatorActualSeconds ?? null,
			operatorInterruptionCount: program.operatorInterruptionCount ?? null,
			operatorAbort: program.operatorAbort === true,
			operatorAbortReason: program.operatorAbortReason || null,
			operatorEndLack: program.operatorEndLack === true,
			mirakurunDrop: program.mirakurunDrop || null,
			tsDrop: program.tsDrop || null,
			savedTsAnalysis: program.savedTsAnalysis || null,
			recordingPathMissing: program.recordingPathMissing === true,
			detailSource: event.sources.some(value => value.source === 'recorded') ? 'recorded' : null
		}
	};
}

function automaticPlacement(event, resolution) {
	if (!resolution || !(resolution.workConfirmed || resolution.tidConfirmed)) {
		return { seriesId: null, reason: resolution && resolution.classification || 'unresolved', episodeLinks: [] };
	}
	if (resolution.selectedSeriesId && resolution.selectedTid === null) {
		return { seriesId: resolution.selectedSeriesId, tid: null,
			title: resolution.candidates.find(candidate => candidate.id === resolution.selectedSeriesId)?.title,
			reason: 'automatic-confirmed', episodeLinks: resolution.dramaEpisode?.links || [] };
	}
	const identity = resolution.episodeIdentity;
	let episodeLinks;
	if (identity && identity.status === 'multi-episode-confirmed' &&
		Array.isArray(identity.episodeNumbers) && identity.episodeNumbers.length > 1) {
		episodeLinks = identity.episodeNumbers.map((number, index) => {
			const episodeIdentity = Array.isArray(identity.episodeIdentities) && identity.episodeIdentities[index] ||
				'epg:' + number;
			return {
				key: 'ep:' + episodeIdentity,
				kind: 'episode',
				identity: episodeIdentity,
				refs: identity.refs.filter(ref => ref === 'epg:' + number || ref === 'dict:' + number),
				status: identity.status
			};
		});
	} else if (identity && identity.mergeAllowed && identity.canonicalHint) {
		episodeLinks = [{
			key: 'ep:' + identity.canonicalHint,
			kind: 'episode',
			identity: identity.canonicalHint,
			refs: identity.refs,
			status: identity.status
		}];
	} else if (identity && identity.status === 'multi-episode-container') {
		episodeLinks = [{
			key: 'multiple:' + event.key,
			kind: 'multiple-unconfirmed',
			identity: null,
			refs: identity.refs,
			status: identity.status
		}];
	} else {
		episodeLinks = [{
			key: 'unresolved:' + event.key,
			kind: identity && identity.status === 'offset-unverified' ?
				'offset-unverified' : 'episode-unresolved',
			identity: null,
			refs: identity && identity.refs || [],
			status: identity && identity.status || 'unresolved'
		}];
	}
	return {
		seriesId: 'syobocal:' + resolution.selectedTid,
		tid: resolution.selectedTid,
		reason: 'automatic-confirmed',
		episodeLinks
	};
}

function applyOneStepPropagation(items, resolver) {
	const anchors = new Map();
	let propagated = 0;
	// Use only earlier confirmations from the same service, local start time and work name.
	// Newly propagated decisions never become anchors.
	for (const item of items.slice().sort((a, b) => Number(a.event.program.start) - Number(b.event.program.start))) {
		const { event, resolution } = item;
		const start = Number(event.program.start);
		const channel = event.program.channel || {};
		const service = channel.nid != null && channel.sid != null ? seriesResolver.broadcastServiceIdentity(event.program) : null;
		const channelKey = service ? [service.type, service.nid, service.sid, service.tsid].join(':') : channel.id;
		if (!channelKey || !Number.isFinite(start) || !resolution?.workIdentity) continue;
		const key = JSON.stringify([channelKey, Math.floor(((start + 9 * 3600_000) % 86400_000) / 60000), resolution.workIdentity]);
		const previous = anchors.get(key) || [];
		if (resolution.workConfirmed || resolution.tidConfirmed) {
			previous.push({ start, id: resolution.selectedSeriesId || 'syobocal:' + resolution.selectedTid });
			anchors.set(key, previous);
			continue;
		}
		if (resolution.scheduleConflict || resolution.classification !== 'multiple' || typeof resolver.resolveWithHistory !== 'function') continue;
		const ids = new Set(previous.filter(anchor => anchor.start < start && start - anchor.start <= 180 * 86400_000).map(anchor => anchor.id));
		if (ids.size !== 1) continue;
		const id = ids.values().next().value;
		if (!resolution.competitiveSeriesIds?.includes(id)) continue;
		const resolved = resolver.resolveWithHistory(event.program, id);
		if (resolved.workConfirmed && resolved.selectedSeriesId === id) {
			item.resolution = resolved;
			propagated++;
		}
	}
	return propagated;
}

function normalizeManualPlacement(value, automatic) {
	if (!value || value.mode === 'auto') return automatic;
	if (value.mode === 'unlinked') {
		return { seriesId: null, reason: 'manual-unlinked', episodeLinks: [] };
	}
	if (value.mode !== 'override' || !stringValue(value.seriesId)) return automatic;
	return {
		seriesId: stringValue(value.seriesId),
		title: value.title || null,
		tid: value.tid == null ? null : Number(value.tid),
		reason: 'manual-override',
		manualDramaEpisodes: value.manualDramaEpisodes,
		episodeSource: stringValue(value.episodeSource),
		manualEpisode: Number.isInteger(Number(value.manualEpisode)) && Number(value.manualEpisode) > 0 ?
			Number(value.manualEpisode) : null,
		episodeLinks: Array.isArray(value.episodeLinks) ? value.episodeLinks.map((link, index) => ({
			key: stringValue(link.key) || 'manual:' + index,
			kind: stringValue(link.kind) || 'manual',
			identity: link.identity === null ? null : stringValue(link.identity),
			...(link.label ? { label: link.label } : {}),
			refs: Array.isArray(link.refs) ? link.refs.map(stringValue).filter(Boolean) : [],
			status: 'manual'
		})) : []
	};
}

function normalizeWorkRulePlacement(value, automatic) {
	if (!value || value.mode !== 'work-rule' || !stringValue(value.seriesId)) return automatic;
	return {
		seriesId: stringValue(value.seriesId),
		title: value.title || null,
		tid: value.tid == null ? null : Number(value.tid),
		reason: 'work-rule',
		episodeSource: stringValue(value.episodeSource),
		workRule: value.workRule || null,
		episodeLinks: Array.isArray(value.episodeLinks) ? value.episodeLinks.map((link, index) => ({
			key: stringValue(link.key) || 'work-rule:' + index,
			kind: stringValue(link.kind) || 'episode-unresolved',
			identity: link.identity === null ? null : stringValue(link.identity),
			...(link.label ? { label: link.label } : {}),
			refs: Array.isArray(link.refs) ? link.refs.map(stringValue).filter(Boolean) : [],
			status: stringValue(link.status) || 'work-rule'
		})) : []
	};
}

function projectSeries(options) {
	options = options || {};
	if (!options.resolver || typeof options.resolver.resolve !== 'function') {
		throw new TypeError('resolver is required');
	}
	const built = options.builtEvents || buildEvents(options);
	const series = new Map();
	const unassigned = [];
	let duplicateEventLinks = 0;
	let automaticConfirmed = 0;
	let manualPlacements = 0;
	let workRulePlacements = 0;

	const resolvedEvents = Array.from(built.events.values()).map(event => ({
		event,
		resolution: options.resolveEvent ? options.resolveEvent(event, options.resolver) : options.resolver.resolve(event.program)
	}));
	const propagated = applyOneStepPropagation(resolvedEvents, options.resolver);

	for (const item of resolvedEvents) {
		const event = item.event;
		let resolution = item.resolution;
		let automatic = automaticPlacement(event, resolution);
		let workRule = typeof options.workRuleOverlay === 'function' ?
			options.workRuleOverlay(eventView(event), resolution, automatic) : null;
		if ((automatic.seriesId && automatic.tid === null || workRule?.seriesId && workRule.tid === null) &&
			options.programExplorer && typeof options.resolver.resolveExploration === 'function') {
			const observed = options.resolver.resolveExploration(event.program, options.programExplorer, resolution);
			if (observed.tidConfirmed) {
				resolution = observed;
				automatic = automaticPlacement(event, resolution);
				workRule = typeof options.workRuleOverlay === 'function' ? options.workRuleOverlay(eventView(event), resolution, automatic) : null;
			}
		}
		const workRulePlacement = normalizeWorkRulePlacement(workRule, automatic);
		const manual = typeof options.manualOverlay === 'function' ?
			options.manualOverlay(eventView(event), resolution, workRulePlacement) : null;
		let placement = normalizeManualPlacement(manual, workRulePlacement);
		// Discovery is a last resort after existing decisions and overlays. Run it
		// after propagation too, so these new confirmations never become anchors.
		if (!placement.seriesId && placement.reason !== 'manual-unlinked' && options.programExplorer &&
			typeof options.resolver.resolveExploration === 'function') {
			resolution = options.resolver.resolveExploration(event.program, options.programExplorer, resolution);
			automatic = automaticPlacement(event, resolution);
			placement = automatic;
		}
		if (placement.reason === 'automatic-confirmed') automaticConfirmed++;
		if (placement.reason === 'work-rule') workRulePlacements++;
		if (placement.reason === 'manual-override' || placement.reason === 'manual-unlinked') manualPlacements++;
		if (!placement.seriesId) {
			unassigned.push({
				event: Object.assign(eventView(event), {
					resolution: {
						classification: resolution.classification,
						selectedTid: resolution.selectedTid,
						selectedSeriesId: resolution.selectedSeriesId || null,
						workConfirmed: resolution.workConfirmed || resolution.tidConfirmed,
						candidateSeriesIds: resolution.competitiveSeriesIds || [],
						candidateTids: resolution.competitiveTids,
						tidConfirmed: resolution.tidConfirmed,
						tidConfirmationSource: resolution.tidConfirmationSource,
						episodeConfirmed: resolution.episodeConfirmed,
						multipleEpisodeConfirmed: resolution.multipleEpisodeConfirmed === true,
						episodeConfirmationSource: resolution.episodeConfirmationSource || null,
						episodeRelation: resolution.episodeRelation,
						episodeIdentity: resolution.episodeIdentity,
						proglookupStatus: resolution.proglookupStatus,
						proglookupAvailability: resolution.proglookupAvailability,
						directPids: resolution.directPids,
						automatic: {
							seriesId: automatic.seriesId,
							tid: automatic.tid ?? null,
							episodeLinks: automatic.episodeLinks
						},
						workRule: workRulePlacement.reason === 'work-rule' ?
							Object.assign({
								active: true,
								shadowed: false,
								episodeSource: workRulePlacement.episodeSource,
								episodeConfirmed: workRulePlacement.episodeLinks.length === 1 &&
									workRulePlacement.episodeLinks[0].kind === 'episode'
							}, workRulePlacement.workRule || {}) : null,
						manual: null
					}
				}),
				classification: resolution.classification,
				candidateTids: resolution.competitiveTids?.length ? resolution.competitiveTids : resolution.relatedTids,
				candidateWorks: (resolution.candidates || []).filter(candidate => candidate.tid === null &&
					resolution.competitiveSeriesIds?.includes(candidate.id)).map(({ id, title, firstYear, season, source }) => ({ id, title, firstYear, season, source })),
				reason: placement.reason,
				episodeIdentity: resolution.episodeIdentity
			});
			continue;
		}
		if (!series.has(placement.seriesId)) {
			const title = placement.tid === null || typeof placement.tid === 'undefined' ? null :
				options.resolver.getDictionaryTitle(placement.tid);
			series.set(placement.seriesId, {
				id: placement.seriesId,
				tid: placement.tid ?? null,
				title: placement.title || title && title.title || event.program.title || null,
				episodes: new Map(),
				eventKeys: new Set()
			});
		}
		const seriesItem = series.get(placement.seriesId);
		seriesItem.eventKeys.add(event.key);
		const links = placement.episodeLinks.length ? placement.episodeLinks : [{
			key: 'unresolved:' + event.key,
			kind: 'episode-unresolved',
			identity: null,
			refs: [],
			status: 'unresolved'
		}];
		for (const link of links) {
			if (!seriesItem.episodes.has(link.key)) {
				seriesItem.episodes.set(link.key, Object.assign({}, link, { events: new Map() }));
			}
			const episode = seriesItem.episodes.get(link.key);
			if (episode.events.has(event.key)) {
				duplicateEventLinks++;
				continue;
			}
			episode.events.set(event.key, Object.assign(eventView(event), {
				placement: placement.reason,
				resolution: {
					classification: resolution.classification,
					selectedTid: resolution.selectedTid,
						selectedSeriesId: resolution.selectedSeriesId || null,
						workConfirmed: resolution.workConfirmed || resolution.tidConfirmed,
						candidateSeriesIds: resolution.competitiveSeriesIds || [],
					candidateTids: resolution.competitiveTids,
					tidConfirmed: resolution.tidConfirmed,
					tidConfirmationSource: resolution.tidConfirmationSource,
					episodeConfirmed: resolution.episodeConfirmed,
					multipleEpisodeConfirmed: resolution.multipleEpisodeConfirmed === true,
					episodeConfirmationSource: resolution.episodeConfirmationSource || null,
					episodeRelation: resolution.episodeRelation,
					episodeIdentity: resolution.episodeIdentity,
					proglookupStatus: resolution.proglookupStatus,
					proglookupAvailability: resolution.proglookupAvailability,
					directPids: resolution.directPids,
					automatic: {
						seriesId: automatic.seriesId,
						tid: automatic.tid ?? null,
						episodeLinks: automatic.episodeLinks
					},
					workRule: workRulePlacement.reason === 'work-rule' ? Object.assign({
						active: true,
						shadowed: placement.reason === 'manual-override',
						episodeSource: workRulePlacement.episodeSource,
						episodeConfirmed: workRulePlacement.episodeLinks.length === 1 &&
							workRulePlacement.episodeLinks[0].kind === 'episode'
					}, workRulePlacement.workRule || {}) : null,
					manual: placement.reason === 'manual-override' ? {
						active: true,
						seriesId: placement.seriesId,
						title: placement.title || null,
						tid: placement.tid ?? null,
						episode: placement.manualEpisode,
						...(placement.manualDramaEpisodes ? { episodes: placement.manualDramaEpisodes } : {}),
						episodeSource: placement.episodeSource,
						episodeConfirmed: placement.episodeLinks.length === 1 &&
							placement.episodeLinks[0].kind === 'episode',
						multipleEpisodeConfirmed: placement.episodeLinks.length > 1 &&
							placement.episodeLinks.every(link => link.kind === 'episode')
					} : null
				}
			}));
		}
	}

	const seriesOutput = Array.from(series.values()).map(item => ({
		id: item.id,
		tid: item.tid,
		title: item.title,
		eventCount: item.eventKeys.size,
		episodes: Array.from(item.episodes.values()).map(episode => ({
			key: episode.key,
			kind: episode.kind,
			identity: episode.identity,
			...(episode.label ? { label: episode.label } : {}),
			refs: episode.refs,
			status: episode.status,
			events: Array.from(episode.events.values())
		})).sort((a, b) => a.key.localeCompare(b.key, 'ja'))
	})).sort((a, b) => a.id.localeCompare(b.id, 'en'));

	const episodeBuckets = seriesOutput.reduce((count, item) => count + item.episodes.length, 0);
	const eventLinks = seriesOutput.reduce((count, item) => count +
		item.episodes.reduce((sum, episode) => sum + episode.events.length, 0), 0);
	return {
		series: seriesOutput,
		unassigned,
		summary: {
			sourceRecords: built.sourceRecords,
			unidentifiedRecords: built.unidentifiedRecords,
			uniqueEvents: built.events.size,
			collapsedSourceRecords: built.sourceRecords - built.events.size - built.unidentifiedRecords,
			series: seriesOutput.length,
			episodeBuckets,
			eventLinks,
			automaticConfirmed,
			workRulePlacements,
			propagated,
			unassigned: unassigned.length,
			manualPlacements,
			duplicateEventLinks
		}
	};
}

module.exports = {
	automaticPlacement,
	buildEvents,
	eventKey,
	projectSeries
};
