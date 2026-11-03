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
		fileMissing: normalized && normalized.fileMissing || null,
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
	if (!resolution || resolution.tidConfirmed !== true || resolution.selectedTid === null) {
		return { seriesId: null, reason: resolution && resolution.classification || 'unresolved', episodeLinks: [] };
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

function applyOneStepPropagation(items) {
	const anchors = new Map();
	for (const item of items) {
		const resolution = item.resolution;
		if (!resolution || !resolution.tidConfirmed || resolution.tidConfirmationSource === 'confirmed-event-propagation' ||
			!resolution.workIdentity) continue;
		if (!anchors.has(resolution.workIdentity)) anchors.set(resolution.workIdentity, new Set());
		anchors.get(resolution.workIdentity).add(resolution.selectedTid);
	}
	let propagated = 0;
	for (const item of items) {
		const resolution = item.resolution;
		if (!resolution || resolution.tidConfirmed || !resolution.workIdentity || resolution.scheduleConflict) continue;
		const tids = anchors.get(resolution.workIdentity);
		if (!tids || tids.size !== 1) continue;
		const tid = Array.from(tids)[0];
		if (!resolution.candidateTids.includes(tid) ||
			resolution.proglookupStatus === 'same-channel-time-title-conflict') continue;
		const selected = resolution.candidates.find(candidate => candidate.tid === tid);
		if (!selected) continue;
		resolution.selectedTid = tid;
		resolution.classification = 'confirmed';
		resolution.tidConfirmed = true;
		resolution.tidConfirmationSource = 'confirmed-event-propagation';
		resolution.competitiveTids = [tid];
		resolution.reason = null;
		const epgNumbers = selected ? selected.subtitle.epgNumbers : [];
		const dictionaryEpisode = selected.subtitle.dictionaryEpisode;
		const progCount = Number.isInteger(selected.prog && selected.prog.count) ? selected.prog.count : null;
		const installmentOffsetConflict = seriesResolver.hasExplicitInstallment(item.event.program) &&
			selected.subtitle.dictionaryEpisodeFloor !== null && selected.subtitle.dictionaryEpisodeFloor > 1 &&
			epgNumbers.length > 0 &&
			epgNumbers.every(number => number < selected.subtitle.dictionaryEpisodeFloor) &&
			dictionaryEpisode === null;
		if (epgNumbers.length === 1 && dictionaryEpisode === epgNumbers[0]) {
			resolution.episodeRelation = 'same-number';
		} else if (epgNumbers.length === 1 && dictionaryEpisode !== null) {
			resolution.episodeRelation = 'possible-fixed-offset-unverified';
		} else if (epgNumbers.length === 1 && installmentOffsetConflict) {
			resolution.episodeRelation = 'possible-fixed-offset-unverified';
		} else if (epgNumbers.length === 1 && resolution.proglookupTidConfirmed && progCount !== null &&
			progCount !== epgNumbers[0]) {
			resolution.episodeRelation = 'proglookup-count-conflict';
		} else if (epgNumbers.length === 1 && epgNumbers[0] > 0) {
			resolution.episodeRelation = 'epg-number-uncontradicted';
		} else if (epgNumbers.length > 1) {
			const rangeConflict = installmentOffsetConflict ||
				dictionaryEpisode !== null && !epgNumbers.includes(dictionaryEpisode) ||
				resolution.proglookupTidConfirmed && progCount !== null && !epgNumbers.includes(progCount);
			resolution.episodeRelation = rangeConflict ? 'range-conflict' :
				selected.subtitle.rangeComplete ? 'range-complete' : 'range-epg-uncontradicted';
		} else {
			resolution.episodeRelation = 'unresolved';
		}
		resolution.episodeConfirmed = epgNumbers.length === 1 &&
			(resolution.proglookupEpisodeConfirmed ||
				['same-number', 'season-to-series-verified', 'subtitle-reverse-exact',
					'epg-number-uncontradicted'].includes(resolution.episodeRelation));
		resolution.multipleEpisodeConfirmed = epgNumbers.length > 1 &&
			['range-complete', 'range-epg-uncontradicted'].includes(resolution.episodeRelation) &&
			epgNumbers.every(number => Number.isInteger(number) && number > 0);
		resolution.episodeConfirmationSource = resolution.episodeConfirmed ?
			resolution.proglookupEpisodeConfirmed ? 'proglookup' :
				resolution.episodeRelation === 'epg-number-uncontradicted' ? 'epg' : 'dictionary' :
			resolution.multipleEpisodeConfirmed ?
				resolution.episodeRelation === 'range-complete' ? 'dictionary' : 'epg' : null;
		resolution.episodeIdentity = seriesResolver.describeEpisodeIdentity(resolution);
		propagated++;
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
		tid: typeof value.tid === 'undefined' ? null : Number(value.tid),
		reason: 'manual-override',
		episodeSource: stringValue(value.episodeSource),
		manualEpisode: Number.isInteger(Number(value.manualEpisode)) && Number(value.manualEpisode) > 0 ?
			Number(value.manualEpisode) : null,
		episodeLinks: Array.isArray(value.episodeLinks) ? value.episodeLinks.map((link, index) => ({
			key: stringValue(link.key) || 'manual:' + index,
			kind: stringValue(link.kind) || 'manual',
			identity: link.identity === null ? null : stringValue(link.identity),
			refs: Array.isArray(link.refs) ? link.refs.map(stringValue).filter(Boolean) : [],
			status: 'manual'
		})) : []
	};
}

function normalizeWorkRulePlacement(value, automatic) {
	if (!value || value.mode !== 'work-rule' || !stringValue(value.seriesId)) return automatic;
	return {
		seriesId: stringValue(value.seriesId),
		tid: Number(value.tid),
		reason: 'work-rule',
		episodeSource: stringValue(value.episodeSource),
		workRule: value.workRule || null,
		episodeLinks: Array.isArray(value.episodeLinks) ? value.episodeLinks.map((link, index) => ({
			key: stringValue(link.key) || 'work-rule:' + index,
			kind: stringValue(link.kind) || 'episode-unresolved',
			identity: link.identity === null ? null : stringValue(link.identity),
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
	const propagated = applyOneStepPropagation(resolvedEvents);

	for (const item of resolvedEvents) {
		const event = item.event;
		let resolution = item.resolution;
		let automatic = automaticPlacement(event, resolution);
		const workRule = typeof options.workRuleOverlay === 'function' ?
			options.workRuleOverlay(eventView(event), resolution, automatic) : null;
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
				candidateTids: resolution.competitiveTids,
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
				title: title && title.title || event.program.title || null,
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
						tid: placement.tid ?? null,
						episode: placement.manualEpisode,
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
