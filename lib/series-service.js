'use strict';

const fs = require('fs');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const { stableJson } = require('./series-input-context');
const path = require('path');
const recordedThumbnail = require('./recorded-thumbnail');
const seriesResolver = require('./series-resolver');
const seriesProjector = require('./series-projector');
const seriesManualStore = require('./series-manual-store');
const syobocalChannelMap = require('./syobocal-channel-map');

const RESULT_STATUSES = new Set(['RECORDED', 'RECORDED_UNTRACKED', 'MISSED', 'SKIPPED_ONLY']);
const RECORDED_STATUSES = new Set(['RECORDED', 'RECORDED_UNTRACKED']);
const STRONG_TID_SOURCES = new Set([
	'proglookup', 'proglookup-title', 'dictionary-subtitle-reverse', 'dictionary-subtitle'
]);

function readArray(filePath) {
	const value = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, '') || '[]');
	if (!Array.isArray(value)) throw new TypeError(path.basename(filePath) + ' must contain an array');
	return value;
}

function sourceSignature(paths) {
	return paths.map(filePath => {
		const stat = fs.statSync(filePath);
		return filePath + ':' + stat.size + ':' + stat.mtimeMs;
	}).join('|');
}

function text(value) {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function unique(values) {
	return Array.from(new Set(values.filter(value => value !== null && typeof value !== 'undefined')));
}

function uniqueBy(values, identity) {
	const seen = new Set();
	return values.filter(value => {
		const key = identity(value);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function projectedProgram(event) {
	const broadcast = event && event.broadcast || {};
	return {
		title: broadcast.title,
		fullTitle: broadcast.fullTitle,
		subTitle: broadcast.subTitle,
		episode: broadcast.episode,
		start: broadcast.start,
		end: broadcast.end,
		seconds: broadcast.seconds,
		detail: broadcast.detail,
		flags: broadcast.flags,
		channel: broadcast.channel || {}
	};
}

function installmentTokens(value) {
	return new Set(String(value || '').split(',').filter(Boolean));
}

function workFamilyKey(value) {
	return seriesResolver.seriesKey(value).replace(/(?:第)?\d+クール/gu, '');
}

function installmentCompatible(eventInstallment, targetInstallment) {
	if (!eventInstallment) return true;
	const target = installmentTokens(targetInstallment);
	return Array.from(installmentTokens(eventInstallment)).every(value => target.has(value));
}

function sixMonthScope(firstYear, firstMonth) {
	const year = Number(firstYear);
	const month = Number(firstMonth);
	if (!Number.isInteger(year) || year < 1970 || !Number.isInteger(month) || month < 1 || month > 12) {
		return { start: null, end: null };
	}
	const start = Date.UTC(year, month - 1, 1) - 9 * 60 * 60 * 1000;
	return { start, end: Date.UTC(year, month - 1 + 6, 1) - 9 * 60 * 60 * 1000 };
}

function workRuleSummary(rule) {
	if (!rule) return null;
	return {
		id: rule.id || null,
		tid: rule.tid,
		serviceName: rule.service.name || rule.service.channelId ||
			[rule.service.type, rule.service.nid, rule.service.sid].join('/'),
		workIdentity: rule.work.identity,
		scopeStart: rule.work.scopeStart,
		scopeEnd: rule.work.scopeEnd,
		episodeFloor: rule.work.episodeFloor,
		sourceEventKey: rule.sourceEventKey
	};
}

function episodeNumber(episode) {
	const match = String(episode && episode.identity || '').match(/(?:^|:)(?:dict|epg|prog):(\d+)(?:$|:)/u);
	if (match) return Number(match[1]);
	const refs = Array.isArray(episode && episode.refs) ? episode.refs : [];
	for (const prefix of ['dict', 'epg', 'prog']) {
		for (const ref of refs) {
			const value = String(ref).match(new RegExp('^' + prefix + ':(\\d+)$', 'u'));
			if (value) return Number(value[1]);
		}
	}
	return null;
}

function eventStatus(event) {
	if (event.deleted) return { key: 'deleted', label: '削除済み' };
	if (event.fileMissing) return { key: 'file-missing', label: '行方不明' };
	const statuses = Array.isArray(event.statuses) ? event.statuses : [];
	if (statuses.includes('MISSED')) return { key: 'missed', label: '未録画' };
	if (statuses.some(status => status === 'RECORDED' || status === 'RECORDED_UNTRACKED') ||
		(Array.isArray(event.sources) && event.sources.includes('recorded'))) {
		return { key: 'recorded', label: '録画済み' };
	}
	if (statuses.includes('SKIPPED_ONLY')) return { key: 'skipped', label: 'スキップ' };
	return { key: 'unknown', label: '録画結果' };
}

function channelLogoUrl(channel) {
	const id = text(channel && channel.id);
	return id && channel.hasLogoData === true ? '/api/channel/' + encodeURIComponent(id) + '/logo.png' : null;
}

function programDetailUrl(event, recordedId) {
	const params = new URLSearchParams();
	if (text(event.key)) params.set('key', event.key);
	if (text(recordedId)) params.set('id', recordedId);
	if (params.size === 0 && Array.isArray(event.ids) && text(event.ids[0])) params.set('id', event.ids[0]);
	return params.size ? '#program?' + params.toString() : null;
}

function hasThumbnail(thumbnailDir, recordedId) {
	if (!thumbnailDir || !text(recordedId)) return false;
	const outputPath = recordedThumbnail.resolveOutputPath(thumbnailDir, recordedId);
	if (!outputPath) return false;
	try {
		const stat = fs.statSync(outputPath);
		return stat.isFile() && stat.size > 0;
	} catch (error) {
		if (error && error.code === 'ENOENT') return false;
		throw error;
	}
}

function eventView(event, thumbnailDir) {
	const broadcast = event.broadcast || {};
	const channel = broadcast.channel || {};
	const status = eventStatus(event);
	const resultStatus = (Array.isArray(event.statuses) ? event.statuses : []).find(value => RESULT_STATUSES.has(value)) ||
		(status.key === 'recorded' ? 'RECORDED' : status.key === 'missed' ? 'MISSED' :
			status.key === 'skipped' ? 'SKIPPED_ONLY' : '');
	const recordingIds = unique((Array.isArray(event.recordingIds) ? event.recordingIds : []).map(text));
	const hasResult = recordingIds.length > 0 || event.deleted ||
		(Array.isArray(event.sources) && event.sources.includes('recorded')) || statusesAreRecorded(event.statuses);
	const resultIds = recordingIds.length ? recordingIds : hasResult ? [null] : [];
	const recordings = resultIds.map(recordedId => Object.assign({
		key: event.key,
		recordedId,
		status: resultStatus,
		state: !event.deleted && event.fileMissing && event.fileMissing.recordedId !== recordedId ? 'recorded' : status.key,
		statusLabel: event.deleted ? '削除済み' : event.fileMissing?.recordedId === recordedId ? '行方不明' : status.key === 'file-missing' ? '録画済み' : status.label,
		deleted: event.deleted === true,
		channel: {
			id: channel.id || null,
			name: channel.name || null,
			type: channel.type || null,
			nid: Number.isFinite(Number(channel.nid)) ? Number(channel.nid) : null,
			sid: Number.isFinite(Number(channel.sid)) ? Number(channel.sid) : null,
			logoUrl: channelLogoUrl(channel)
		},
		start: broadcast.start || null,
		end: broadcast.end || null,
		detailUrl: programDetailUrl(event, recordedId),
		thumbnailUrl: recordedId && hasThumbnail(thumbnailDir, recordedId) ?
			'/api/recorded/' + encodeURIComponent(recordedId) + '/thumbnail.jpg' : null
	}, event.recordingResult || {}, {
		fileMissing: !event.deleted && event.fileMissing?.recordedId === recordedId ? event.fileMissing : null,
		deletionKind: event.deleted ? 'explicit' : event.fileMissing?.recordedId === recordedId ? 'file-missing' : event.ledgerMissing ? 'missing' : null,
		detailSource: event.recordingResult && event.recordingResult.detailSource || null
	}));
	const reservation = event.activeReservation === true && recordings.length === 0;
	return {
		key: event.key,
		title: broadcast.title || broadcast.fullTitle || 'タイトル未取得',
		fullTitle: broadcast.fullTitle || broadcast.title || 'タイトル未取得',
		subTitle: broadcast.subTitle || null,
		episode: typeof broadcast.episode === 'undefined' ? null : broadcast.episode,
		detail: broadcast.detail || null,
		start: broadcast.start || null,
		end: broadcast.end || null,
		channel: {
			id: channel.id || null,
			name: channel.name || null,
			type: channel.type || null,
			logoUrl: channelLogoUrl(channel)
		},
		reservation: reservation ? {
			status: 'reserved',
			detailUrl: programDetailUrl(event, null)
		} : null,
		recordings,
		resolution: event.resolution || null
	};
}

function statusesAreRecorded(statuses) {
	return (Array.isArray(statuses) ? statuses : []).some(status => RECORDED_STATUSES.has(status));
}

function newest(values, field) {
	return values.reduce((latest, value) => !latest || Number(value[field]) > Number(latest[field]) ? value : latest, null);
}

function displayableEventSubtitle(event) {
	const subtitle = text(event && event.subTitle);
	if (!subtitle || seriesResolver.suspiciousSubtitle({ subTitle: subtitle, title: event && event.title }) ||
		seriesResolver.presentationSubtitle(event)) return null;
	const heading = value => String(value || '').normalize('NFKC').toLowerCase()
		.replace(/[＜＞<>【】\[\]「」『』（）()\s:：・]/gu, '');
	const key = heading(subtitle);
	const detail = heading(event && event.detail);
	if (['スタッフ', 'キャスト'].includes(key) && detail.startsWith(key)) return null;
	return subtitle;
}

function shapeSeries(item, thumbnailDir, resolver) {
	const dictionaryEpisodes = resolver && item.tid !== null && typeof item.tid !== 'undefined' ?
		resolver.getDictionaryEpisodes(item.tid) : [];
	const dictionaryEpisodesByNumber = new Map(dictionaryEpisodes.map(episode => [episode.episode, episode]));
	let episodes = item.episodes.map(episode => {
		const events = episode.events.map(event => eventView(event, thumbnailDir));
		const recordings = events.flatMap(event => event.recordings);
		const reservations = events.filter(event => event.reservation !== null);
		const number = episodeNumber(episode);
		const dictionaryEpisode = number !== null ? dictionaryEpisodesByNumber.get(number) || null : null;
		const subtitleCandidates = Array.from(new Set(events.map(displayableEventSubtitle).filter(Boolean)));
		const subtitle = subtitleCandidates.length === 1 ? subtitleCandidates[0] : null;
		const thumbnail = newest(recordings.filter(recording => recording.thumbnailUrl), 'start');
		return {
			key: episode.key,
			kind: episode.kind,
			identity: episode.identity,
			refs: episode.refs,
			status: episode.status,
			confirmed: episode.kind === 'episode' && number !== null,
			number,
			label: episode.kind === 'episode' && number !== null ? '第' + number + '話' :
				episode.kind === 'multiple-unconfirmed' ? '複数話・範囲未確定' : 'EP未確定',
			subtitle,
			dictionarySubtitle: dictionaryEpisode && dictionaryEpisode.subtitle || null,
			displaySubtitle: episode.kind === 'episode' && number !== null && dictionaryEpisode && dictionaryEpisode.subtitle || subtitle,
			subtitleSource: episode.kind === 'episode' && number !== null && dictionaryEpisode && dictionaryEpisode.subtitle ?
				'dictionary' : subtitle ? 'epg' : null,
			thumbnailUrl: thumbnail && thumbnail.thumbnailUrl || null,
			reservations,
			recordings,
			events
		};
	});
	const groupedEpisodes = new Map();
	for (const episode of episodes) {
		const groupKey = episode.confirmed && episode.number !== null ? 'confirmed:' + episode.number :
			episode.kind === 'episode-unresolved' ? 'episode-unresolved' : episode.key;
		if (!groupedEpisodes.has(groupKey)) {
			groupedEpisodes.set(groupKey, Object.assign({}, episode, {
				key: groupKey,
				number: episode.confirmed ? episode.number : null,
				label: episode.confirmed ? episode.label :
					episode.kind === 'multiple-unconfirmed' ? episode.label : 'EP未確定',
				refs: Array.from(new Set(episode.refs || [])),
				reservations: episode.reservations.slice(),
				recordings: episode.recordings.slice(),
				events: episode.events.slice()
			}));
			continue;
		}
		const grouped = groupedEpisodes.get(groupKey);
		grouped.refs = Array.from(new Set(grouped.refs.concat(episode.refs || [])));
		grouped.events.push(...episode.events.filter(event => !grouped.events.some(current => current.key === event.key)));
		grouped.reservations.push(...episode.reservations.filter(event => !grouped.reservations.some(current => current.key === event.key)));
		grouped.recordings.push(...episode.recordings.filter(recording => !grouped.recordings.some(current =>
			current.key === recording.key && current.recordedId === recording.recordedId)));
		if (grouped.subtitle !== episode.subtitle) grouped.subtitle = null;
		if (grouped.displaySubtitle !== episode.displaySubtitle) {
			grouped.displaySubtitle = grouped.dictionarySubtitle || null;
			grouped.subtitleSource = grouped.displaySubtitle ? 'dictionary' : null;
		}
		const thumbnail = newest(grouped.recordings.filter(recording => recording.thumbnailUrl), 'start');
		grouped.thumbnailUrl = thumbnail && thumbnail.thumbnailUrl || null;
	}
	episodes = Array.from(groupedEpisodes.values());
	const confirmedNumbers = new Set(episodes.filter(episode => episode.confirmed).map(episode => episode.number));
	for (const dictionaryEpisode of dictionaryEpisodes) {
		if (confirmedNumbers.has(dictionaryEpisode.episode)) continue;
		episodes.push({
			key: 'virtual:dict:' + dictionaryEpisode.episode,
			kind: 'virtual-empty',
			identity: 'dict:' + dictionaryEpisode.episode,
			refs: ['dict:' + dictionaryEpisode.episode],
			status: 'no-record',
			confirmed: true,
			number: dictionaryEpisode.episode,
			label: '第' + dictionaryEpisode.episode + '話',
			subtitle: dictionaryEpisode.subtitle,
			dictionarySubtitle: dictionaryEpisode.subtitle,
			displaySubtitle: dictionaryEpisode.subtitle,
			subtitleSource: dictionaryEpisode.subtitle ? 'dictionary' : null,
			thumbnailUrl: null,
			reservations: [],
			recordings: [],
			events: [],
			virtual: true,
			empty: true
		});
	}
	episodes.sort((left, right) => {
		if (left.number !== null && right.number !== null) return left.number - right.number;
		if (left.number !== null) return -1;
		if (right.number !== null) return 1;
		return left.key.localeCompare(right.key, 'ja');
	});
	const events = uniqueBy(episodes.flatMap(episode => episode.events), event => event.key);
	const recordings = uniqueBy(episodes.flatMap(episode => episode.recordings), recording =>
		recording.key + '\u0000' + String(recording.recordedId || ''));
	const reservations = uniqueBy(episodes.flatMap(episode => episode.reservations), event => event.key);
	const currentRecordings = recordings.filter(recording => !recording.deleted && !recording.fileMissing);
	const knownEpisodeNumbers = new Set(episodes.filter(episode => episode.confirmed && episode.number !== null)
		.map(episode => episode.number));
	const availableEpisodeNumbers = episodes.filter(episode => episode.confirmed && episode.number !== null &&
		episode.recordings.some(recording => !recording.deleted && !recording.fileMissing)).map(episode => episode.number);
	const latestAvailableEpisode = availableEpisodeNumbers.length ? Math.max(...availableEpisodeNumbers) : null;
	const currentEpisodes = episodes.filter(episode => episode.confirmed && !episode.virtual &&
		episode.recordings.some(recording => !recording.deleted && !recording.fileMissing)).length;
	const representativeEpisode = episodes.filter(episode => episode.confirmed && episode.number !== null &&
		episode.recordings.some(recording => !recording.deleted && !recording.fileMissing && recording.thumbnailUrl))
		.sort((left, right) => right.number - left.number)[0] || null;
	const representative = representativeEpisode ? newest(representativeEpisode.recordings.filter(recording =>
		!recording.deleted && !recording.fileMissing && recording.thumbnailUrl), 'start') :
		newest(currentRecordings.filter(recording => recording.thumbnailUrl), 'start');
	const nextReservation = reservations.filter(event => Number(event.start) >= Date.now())
		.sort((left, right) => Number(left.start) - Number(right.start))[0] ||
		reservations.sort((left, right) => Number(left.start) - Number(right.start))[0] || null;
	const latestRecording = newest(recordings, 'start');
	return {
		id: item.id,
		tid: item.tid,
		title: item.title || events[0] && events[0].title || '作品名未取得',
		description: events.map(event => text(event.detail)).find(Boolean) || null,
		representativeThumbnailUrl: representative && representative.thumbnailUrl || null,
		counts: {
			episodes: episodes.filter(episode => episode.confirmed && !episode.virtual).length,
			knownEpisodes: knownEpisodeNumbers.size,
			dictionaryEpisodes: dictionaryEpisodes.length,
			episodeUnresolved: episodes.filter(episode => !episode.confirmed)
				.reduce((count, episode) => count + episode.events.length, 0),
			reservations: reservations.length,
			recordings: recordings.length,
			currentRecordings: currentRecordings.length,
			currentEpisodes,
			deletedRecordings: recordings.filter(recording => recording.deleted).length,
			...(recordings.some(recording => recording.fileMissing && !recording.deleted) ? { missingRecordings: recordings.filter(recording => recording.fileMissing && !recording.deleted).length } : {})
		},
		nextReservationAt: nextReservation && nextReservation.start || null,
		nextReservationChannel: nextReservation && nextReservation.channel.name || null,
		latestRecordingAt: latestRecording && latestRecording.start || null,
		latestAvailableEpisode,
		episodes
	};
}

function attentionProgLookupLabel(events) {
	const resolutions = events.map(event => event.resolution || {});
	if (resolutions.some(value => value.proglookupAvailability === 'outside-cache' || value.proglookupAvailability === 'covered-delta-only')) {
		return '放送データ未取得';
	}
	if (resolutions.some(value => value.proglookupStatus === 'unresolved-channel-time-title-episode')) return '放送データでTID・EP確認済み';
	if (resolutions.some(value => value.proglookupStatus === 'same-channel-time-same-tid')) return '放送データでTID確認済み';
	if (resolutions.some(value => ['same-channel-time-title-conflict', 'time-only-title-mismatch',
		'time-title-only-channel-mismatch-or-unmapped'].includes(value.proglookupStatus))) return '取得済み・放送情報不一致';
	if (resolutions.some(value => value.proglookupAvailability === 'covered-complete' && value.proglookupStatus === 'no-proglookup-at-time')) {
		return '取得済み・該当番組なし';
	}
	if (resolutions.some(value => value.proglookupStatus === 'same-channel-time-ambiguous-tid')) return '取得済み・TID候補未確定';
	return '放送データ判定不能';
}

function groupAttention(projected, seriesById, resolver, explorer) {
	const groups = new Map();
	for (const item of projected.unassigned) {
		const title = text(item.event && item.event.broadcast && (item.event.broadcast.title || item.event.broadcast.fullTitle)) || 'タイトル未取得';
		const key = item.classification + ':' + title.normalize('NFKC').trim();
		if (!groups.has(key)) {
			groups.set(key, {
				id: key,
				kind: item.classification,
				label: item.classification === 'likely' ? '有力候補あり' :
					item.classification === 'multiple' ? '複数候補' : '候補なし',
				title,
				candidateTids: [],
				candidateSeriesIds: [],
				events: []
			});
		}
		const group = groups.get(key);
		group.events.push(eventView(item.event, null));
		group.candidateTids = unique(group.candidateTids.concat(item.candidateTids || []));
		if (explorer) {
			const exploration = explorer.find(projectedProgram(item.event));
			if (exploration.status === 'single-observed-tid') {
				// Only add a candidate for user review: projection/TID/EP decisions remain unchanged.
				group.candidateTids = unique(group.candidateTids.concat(exploration.candidateTids));
				if (!group.explorationMatches) group.explorationMatches = [];
				group.explorationMatches.push({ eventKey: item.event.key, tid: exploration.candidateTids[0],
					method: 'time-and-official-title', matches: exploration.matches.map(match => ({
						chId: match.chId, pid: match.pid, episodeMatch: match.episodeMatch,
						subtitleMatch: match.subtitleMatch
					})) });
			}
		}
	}
	for (const group of groups.values()) {
		group.candidateSeriesIds = group.candidateTids.map(tid => 'syobocal:' + tid)
			.filter(id => seriesById.has(id));
		const automaticCandidates = group.candidateTids.map(tid => resolver.getDictionaryTitle(tid))
			.filter(Boolean).map(item => ({ tid: item.tid, title: item.title, firstYear: item.firstYear || null }));
		const searchCandidates = resolver.searchDictionaryTitles(group.title, 20)
			.filter(item => ['exact', 'decorated-prefix', 'alias-exact'].includes(item.match));
		group.candidates = uniqueBy(automaticCandidates.concat(searchCandidates), item => item.tid);
		if (group.explorationMatches && group.kind === 'none') group.label = '放送データにTID候補あり';
		group.progLookupLabel = attentionProgLookupLabel(group.events);
	}
	return Array.from(groups.values()).sort((left, right) => left.title.localeCompare(right.title, 'ja'));
}

function createSeriesService(options) {
	options = options || {};
	const enabled = options.enabled !== false;
	const fixed = options.inputContext || null;
	const ledgerPaths = options.ledgerPaths || {};
	const required = ['reserves', 'recorded', 'match'];
	const progLookupStore = options.progLookupStore || null;
	const manualStore = options.manualStore || (enabled ? seriesManualStore.createSeriesManualStore({ path: options.manualPath }) : null);
	let dictionary = null;
	let resolver = null;
	let resolverGeneration = null;
	let cache = null;
	let cacheSignature = null;
	let dictionaryStale = false;
	let eventIndex = null;
	let metrics = null;

	function dictionaryStatus() {
		return typeof options.getDictionaryStatus === 'function' ? options.getDictionaryStatus() : null;
	}
	function withDictionaryStatus(snapshot) {
		const state = dictionaryStatus();
		if (!state) return snapshot;
		const availability = Object.assign({}, snapshot.availability, { dictionaryStatus: state,
			dictionary: state.usable ? 'ready' : state.phase });
		if (!state.usable || state.phase === 'failed' || state.phase === 'updating') {
			availability.status = state.usable ? (state.phase === 'failed' ? 'stale' : 'updating') :
				state.phase === 'preparing' ? 'updating' : 'unavailable';
			availability.reason = 'dictionary-' + state.phase;
			availability.message = state.message;
		} else if (!availability.message) availability.message = state.message;
		return Object.assign({}, snapshot, { availability });
	}
	function invalidate(settings) {
		if (!settings || !settings.retain) cache = null;
		cacheSignature = null;
	}
	function reloadDictionary(settings) {
		if (!enabled) return false;
		if (settings && settings.lazy) {
			dictionaryStale = true;
			invalidate({ retain: true });
			return true;
		}
		// Open first. A failed reload must not discard a working reader.
		const next = seriesResolver.createDictionaryStore({ path: options.dictionaryPath });
		if (resolver) resolver.close();
		if (dictionary) dictionary.close();
		dictionary = next;
		dictionaryStale = false;
		resolver = null;
		resolverGeneration = null;
		invalidate();
		return true;
	}

	function channelMapState() {
		try {
			return (fixed ? fixed.independentMap : syobocalChannelMap.readIndependentChannelMap(options.channelMapPath)) ? 'ready' : 'missing';
		} catch (_) {
			return 'invalid';
		}
	}

	function channelMapSignature() {
		if (fixed) return fixed.signature;
		if (!options.channelMapPath || !fs.existsSync(options.channelMapPath)) return 'missing';
		const stat = fs.statSync(options.channelMapPath);
		return stat.size + ':' + stat.mtimeMs;
	}

	function disabledSnapshot() {
		return {
			schemaVersion: 1,
			generatedAt: Date.now(),
			availability: {
				status: 'disabled',
				reason: 'syobocal-disabled',
				message: 'しょぼいカレンダーの情報利用は設定でOFFになっています。',
				dictionary: 'disabled',
				channelMap: 'disabled',
				progLookup: 'disabled',
				technical: null
			},
			summary: null,
			series: [],
			attention: [],
			hiddenSeries: []
		};
	}

	function ensureEnabled() {
		if (!enabled) {
			throw Object.assign(new Error('しょぼいカレンダーの情報利用は設定でOFFになっています'), {
				code: 'syobocal-disabled', statusCode: 503
			});
		}
	}

	function progLookupAvailability(snapshot) {
		if (!progLookupStore || !snapshot) return {
			status: 'unavailable', reason: 'proglookup-unavailable',
			message: '放送情報を取得できていません。シリーズ判定の一部は未確定です。',
			progLookup: 'unavailable', technical: null
		};
		const hasData = snapshot.programs.length > 0;
		const hasCompleteCoverage = snapshot.coverage.some(entry => entry.kind === 'full' || entry.kind === 'backfill');
		const hasCache = hasData || hasCompleteCoverage;
		const updating = snapshot.runtime.updating === true;
		const error = snapshot.state.lastError;
		let status = 'ready';
		let reason = null;
		let message = null;
		if (updating && !hasCache) {
			status = 'updating';
			reason = 'proglookup-initial-update';
			message = '放送情報を取得しています。取得済みの情報から表示します。';
		} else if (error && hasCache) {
			status = 'stale';
			reason = 'proglookup-update-failed';
			message = '放送情報を更新できませんでした。前回取得した情報を使用しています。';
		} else if (!hasCache) {
			status = 'unavailable';
			reason = error ? 'proglookup-initial-failed' : 'proglookup-not-fetched';
			message = '放送情報を取得できていません。シリーズ判定の一部は未確定です。';
		}
		return {
			status, reason, message, progLookup: hasCache ? (error ? 'stale' : 'ready') : (updating ? 'updating' : 'unavailable'),
			technical: {
				lastSuccessAt: snapshot.state.lastSuccessAt,
				lastFullSuccessAt: snapshot.state.lastFullSuccessAt,
				lastDeltaSuccessAt: snapshot.state.lastDeltaSuccessAt,
				lastBackfillSuccessAt: snapshot.state.lastBackfillSuccessAt,
				nextFullAt: snapshot.state.nextFullAt,
				nextDeltaAt: snapshot.state.nextDeltaAt,
				nextAttemptAt: snapshot.state.nextAttemptAt,
				targetChIds: snapshot.state.targetChIds,
				programCount: snapshot.programs.length,
				coverage: snapshot.coverage,
				lastUpdateCount: snapshot.state.lastUpdateCount,
				lastError: error,
				updating,
				updateKind: snapshot.runtime.updateKind
			}
		};
	}

	function unavailable(reason, message) {
		let hiddenSeries = [];
		try {
			hiddenSeries = manualStore.getHiddenTids().map(tid => ({ tid, title: null }));
		} catch (_) {}
		return withDictionaryStatus({
			schemaVersion: 1,
			generatedAt: Date.now(),
			availability: {
				status: 'unavailable',
				reason,
				message,
				dictionary: options.dictionaryPath && fs.existsSync(options.dictionaryPath) ? 'ready' : 'missing',
				channelMap: channelMapState(),
				progLookup: 'unavailable'
			},
			summary: null,
			series: [],
			attention: [],
			hiddenSeries
		});
	}

	function initializeResolver(progSnapshot) {
		if (dictionaryStale) reloadDictionary();
		const state = dictionaryStatus();
		if (state && !state.usable) throw Object.assign(new Error(state.message), { code: 'dictionary-preparing', statusCode: 503 });
		if (!fixed && (!options.dictionaryPath || !fs.existsSync(options.dictionaryPath))) {
			throw Object.assign(new Error('SQLite作品辞書が準備されていません'), { code: 'dictionary-missing' });
		}
		const independentMap = (fixed ? fixed.independentMap : syobocalChannelMap.readIndependentChannelMap(options.channelMapPath)) || {
			version: 2,
			provenance: { kind: syobocalChannelMap.SOURCE_KIND, state: 'not-generated' },
			channels: []
		};
		const mapSignature = channelMapSignature();
		const generation = String(progSnapshot ? progSnapshot.generation : -1) + ':' + mapSignature;
		if (resolver && resolverGeneration === generation) return resolver;
		if (!dictionary) dictionary = seriesResolver.createDictionaryStore({ path: options.dictionaryPath, db: fixed && fixed.db });
		if (resolver) resolver.close();
		resolver = seriesResolver.createSeriesResolver({
			dictionary,
			channelMap: independentMap,
			progLookupItems: progSnapshot ? progSnapshot.programs : [],
			getProgLookupCoverage: progLookupStore ? progLookupStore.coverageFor : function () { return 'unavailable'; }
		});
		resolverGeneration = generation;
		return resolver;
	}

	function buildWorkRuleProposal(event, tid, currentResolver) {
		const program = event && event.program || projectedProgram(event);
		const service = seriesResolver.broadcastServiceIdentity(program);
		if (!service) return { eligible: false, reason: '放送サービスのONID/SIDを特定できないため、個別補正のみ保存します。' };
		const identity = seriesResolver.workIdentity(program);
		const sourceSeriesKey = workFamilyKey(identity);
		const target = currentResolver.getDictionaryTitle(tid);
		if (!identity || !sourceSeriesKey || !target || workFamilyKey(target.title) !== sourceSeriesKey) {
			return { eligible: false, reason: '選択した作品とEPG作品名の系統を安全に対応付けられないため、個別補正のみ保存します。' };
		}
		const eventInstallment = seriesResolver.installmentIdentity(
			String(program.title || '') + ' ' + String(program.fullTitle || '')
		);
		const targetInstallment = seriesResolver.installmentIdentity(target.title);
		if (!installmentCompatible(eventInstallment, targetInstallment)) {
			return { eligible: false, reason: '期・クール表記が選択した作品と一致しないため、個別補正のみ保存します。' };
		}
		const scope = sixMonthScope(target.firstYear, target.firstMonth);
		const episodeNumbers = currentResolver.getDictionaryEpisodeNumbers(tid);
		const episodeFloor = episodeNumbers.length ? episodeNumbers[0] : null;
		if (!eventInstallment && scope.start === null && (episodeFloor === null || episodeFloor <= 1)) {
			return { eligible: false, reason: '期・クールを限定する根拠が不足しているため、個別補正のみ保存します。' };
		}
		const start = Number(program.start);
		if (scope.start !== null && Number.isFinite(start) && (start < scope.start || start >= scope.end)) {
			return { eligible: false, reason: '放送時期が選択した作品の登録時期と整合しないため、個別補正のみ保存します。' };
		}
		const epgNumbers = seriesResolver.parseEpisodeNumbers(program.episode);
		if (episodeFloor !== null && episodeFloor > 1 && epgNumbers.length === 1 && epgNumbers[0] < episodeFloor) {
			return { eligible: false, reason: 'EPG話数が選択した期・クールの辞書範囲より前のため、個別補正のみ保存します。' };
		}
		const rule = {
			service,
			work: {
				identity,
				seriesKey: sourceSeriesKey,
				installment: targetInstallment,
				scopeStart: scope.start,
				scopeEnd: scope.end,
				episodeFloor
			},
			tid,
			sourceEventKey: event.key
		};
		return {
			eligible: true,
			reason: (service.name || service.channelId || '同一放送局') +
				'の同じ作品系統へTIDのみを自動適用します。EPは各番組で判定します。',
			rule
		};
	}

	function serviceMatches(rule, program) {
		const service = seriesResolver.broadcastServiceIdentity(program);
		return Boolean(service && service.type === rule.service.type && service.nid === rule.service.nid &&
			service.sid === rule.service.sid && (rule.service.tsid === null || service.tsid === rule.service.tsid));
	}

	function workRuleMatches(rule, event, program) {
		if (!serviceMatches(rule, program) || seriesResolver.workIdentity(program) !== rule.work.identity) return false;
		if (workFamilyKey(seriesResolver.workIdentity(program)) !== rule.work.seriesKey) return false;
		const installment = seriesResolver.installmentIdentity(
			String(program.title || '') + ' ' + String(program.fullTitle || '')
		);
		if (!installmentCompatible(installment, rule.work.installment)) return false;
		const start = Number(program.start);
		if (rule.work.scopeStart !== null && (!Number.isFinite(start) || start < rule.work.scopeStart || start >= rule.work.scopeEnd)) {
			return false;
		}
		const numbers = seriesResolver.parseEpisodeNumbers(program.episode);
		if (rule.work.episodeFloor !== null && rule.work.episodeFloor > 1 && numbers.length === 1 &&
			numbers[0] < rule.work.episodeFloor) return false;
		return true;
	}

	function workRuleEpisodeLinks(event, preview) {
		if (preview.episodeConfirmed) return [{
			key: 'ep:' + (preview.episodeIdentity || 'epg:' + preview.episode),
			kind: 'episode',
			identity: preview.episodeIdentity || 'epg:' + preview.episode,
			refs: ['work-rule:' + preview.episode, 'epg:' + preview.episode],
			status: 'work-rule-episode-confirmed'
		}];
		if (preview.multipleEpisodeConfirmed && Array.isArray(preview.multipleEpisodes)) {
			return preview.multipleEpisodes.map((number, index) => {
				const identity = preview.multipleEpisodeIdentities[index] || 'epg:' + number;
				return {
					key: 'ep:' + identity,
					kind: 'episode',
					identity,
					refs: ['epg:' + number].concat(identity.startsWith('dict:') ? ['dict:' + number] : []),
					status: 'work-rule-multi-episode-confirmed'
				};
			});
		}
		if (preview.multipleEpisode) {
			const numbers = seriesResolver.parseEpisodeNumbers(projectedProgram(event).episode);
			return [{
				key: 'multiple:' + event.key,
				kind: 'multiple-unconfirmed',
				identity: null,
				refs: numbers.map(number => 'epg:' + number),
				status: 'multi-episode-container'
			}];
		}
		return [];
	}

	function manualEpisodeLinks(event, preview) {
		if (!preview || preview.contradiction) return [];
		if (preview.episodeConfirmed) return [{
			key: 'ep:' + (preview.episodeIdentity || 'epg:' + preview.episode),
			kind: 'episode',
			identity: preview.episodeIdentity || 'epg:' + preview.episode,
			refs: ['manual-tid:' + preview.episode, 'epg:' + preview.episode],
			status: 'manual-tid-episode-confirmed'
		}];
		if (preview.multipleEpisodeConfirmed && Array.isArray(preview.multipleEpisodes)) {
			return preview.multipleEpisodes.map((number, index) => {
				const identity = preview.multipleEpisodeIdentities[index] || 'epg:' + number;
				return {
					key: 'ep:' + identity,
					kind: 'episode',
					identity,
					refs: ['epg:' + number].concat(identity.startsWith('dict:') ? ['dict:' + number] : []),
					status: 'manual-tid-multi-episode-confirmed'
				};
			});
		}
		if (preview.multipleEpisode) {
			const numbers = seriesResolver.parseEpisodeNumbers(projectedProgram(event).episode);
			return [{
				key: 'multiple:' + event.key,
				kind: 'multiple-unconfirmed',
				identity: null,
				refs: numbers.map(number => 'epg:' + number),
				status: 'multi-episode-container'
			}];
		}
		return [];
	}

	function resolveWorkRule(event, resolution, currentResolver) {
		const program = projectedProgram(event);
		const matching = manualStore.getWorkRules().filter(rule => workRuleMatches(rule, event, program));
		if (!matching.length) return null;
		const tids = new Set(matching.map(rule => rule.tid));
		if (tids.size !== 1) return null;
		const rule = matching.sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))[0];
		if (resolution.selectedTid !== null && resolution.selectedTid !== rule.tid &&
			(resolution.proglookupTidConfirmed || resolution.scheduleConflict || STRONG_TID_SOURCES.has(resolution.tidConfirmationSource))) {
			return null;
		}
		const preview = currentResolver.previewSelection(program, rule.tid);
		if (!preview || preview.contradiction) return null;
		if (event.key !== rule.sourceEventKey && !preview.subtitlePresentation &&
			['mismatch', 'partial', 'exact-ambiguous'].includes(preview.subtitleStatus)) {
			return null;
		}
		return {
			mode: 'work-rule',
			seriesId: 'syobocal:' + rule.tid,
			tid: rule.tid,
			episodeLinks: workRuleEpisodeLinks(event, preview),
			episodeSource: preview.episodeSource || preview.multipleEpisodeSource,
			workRule: workRuleSummary(rule)
		};
	}

	function getSnapshot() {
		if (!enabled) return disabledSnapshot();
		if (options.validationOnly) {
			if (options.completedSnapshot) return options.completedSnapshot;
			throw Object.assign(new Error('最新の要確認一覧を生成中です'), { statusCode: 503 });
		}
		const dictionaryState = dictionaryStatus();
		if (dictionaryState && !dictionaryState.usable) return unavailable('dictionary-preparing', dictionaryState.message);
		try {
			const started = performance.now();
			for (const name of fixed ? [] : required) {
				if (!ledgerPaths[name] || !fs.existsSync(ledgerPaths[name])) {
					return unavailable('ledger-missing', name + '台帳が準備されていません');
				}
			}
			const progState = progLookupStore ? (progLookupStore.getStateSnapshot ?
				progLookupStore.getStateSnapshot() : progLookupStore.getSnapshot()) : null;
			const progSignature = progState ? JSON.stringify({
				generation: progState.generation
			}) : 'none';
			const signature = (fixed ? fixed.signature : sourceSignature(required.map(name => ledgerPaths[name]))) + '|' + progSignature +
				'|manual:' + manualStore.getGeneration() + '|channel-map:' + channelMapSignature();
			if (cache && signature === cacheSignature) return withDictionaryStatus(cache);
			const inputs = readProjectionInputs();
			const inputsRead = performance.now();
			const builtEvents = fixed && fixed.builtEvents || seriesProjector.buildEvents(inputs);
			const progSnapshot = progLookupStore ? (progLookupStore.getStateSnapshot ? progLookupStore.getSnapshot() : progState) : null;
			const availability = progLookupAvailability(progSnapshot);
			const currentResolver = initializeResolver(progSnapshot);
			const independentMap = fixed ? fixed.independentMap : syobocalChannelMap.readIndependentChannelMap(options.channelMapPath);
			const explorer = independentMap && progSnapshot && Array.isArray(progSnapshot.programs) ?
				syobocalChannelMap.createProgramExplorer({
					channelMap: independentMap, progLookupItems: progSnapshot.programs,
					getTitle: tid => currentResolver.getDictionaryTitle(tid),
					isRangeCovered: (start, end, chIds) => !!progLookupStore &&
						progLookupStore.isRangeCovered(start, end, chIds)
				}) : null;
			const prepared = performance.now();
			const projected = seriesProjector.projectSeries({
				builtEvents,
				resolver: currentResolver,
				resolveEvent: options.matchCache && options.matchCache.resolve,
				programExplorer: explorer,
				reserves: inputs.reserves,
				recorded: inputs.recorded,
				match: inputs.match,
				workRuleOverlay(event, resolution) {
					return resolveWorkRule(event, resolution, currentResolver);
				},
				manualOverlay(event) {
					const override = manualStore.get(event.key);
					if (!override) return null;
					const preview = override.episode === null ?
						currentResolver.previewSelection(projectedProgram(event), override.tid) : null;
					return {
						mode: 'override',
						seriesId: 'syobocal:' + override.tid,
						tid: override.tid,
						manualEpisode: override.episode,
						episodeSource: override.episode === null ? preview &&
							(preview.episodeSource || preview.multipleEpisodeSource) : 'manual',
						episodeLinks: override.episode === null ? manualEpisodeLinks(event, preview) : [{
							key: 'ep:dict:' + override.episode,
							kind: 'episode',
							identity: 'dict:' + override.episode,
							refs: ['manual:' + override.episode]
						}]
					};
				}
			});
			const hiddenTids = new Set(manualStore.getHiddenTids());
			const series = projected.series.map(item => {
				const shaped = shapeSeries(item, options.thumbnailDir, currentResolver);
				shaped.hidden = hiddenTids.has(Number(shaped.tid));
				return shaped;
			});
			const seriesById = new Map(series.map(item => [item.id, item]));
			const seriesByTid = new Map(series.filter(item => Number.isInteger(Number(item.tid)))
				.map(item => [Number(item.tid), item]));
			const hiddenSeries = Array.from(hiddenTids).sort((left, right) => left - right).map(tid => {
				const current = seriesByTid.get(tid);
				const dictionaryTitle = current ? null : currentResolver.getDictionaryTitle(tid);
				return { tid, title: current && current.title || dictionaryTitle && dictionaryTitle.title || null };
			});
			cache = {
				schemaVersion: 1,
				generatedAt: Date.now(),
				availability: {
					status: availability.status,
					reason: availability.reason,
					message: availability.message,
					dictionary: 'ready',
					channelMap: channelMapState(),
					progLookup: availability.progLookup,
					technical: availability.technical
				},
				summary: projected.summary,
				series,
				attention: groupAttention(projected, seriesById, currentResolver, explorer),
				hiddenSeries
			};
			eventIndex = builtEvents.events;
			const completed = performance.now();
			metrics = { ledgerReadMs: inputsRead - started, dictionaryAndIndexMs: prepared - inputsRead,
				projectionMs: completed - prepared, totalMs: completed - started, events: eventIndex.size,
				series: cache.series.length, attentionGroups: cache.attention.length,
				attentionEvents: cache.attention.reduce((n, group) => n + group.events.length, 0) };
			cacheSignature = signature;
			return withDictionaryStatus(cache);
		} catch (error) {
			if (options.throwOnFailure) throw error;
			return unavailable(error.code || 'series-projection-failed', error.message || 'シリーズ情報を生成できませんでした');
		}
	}

	function readProjectionInputs() {
		if (fixed) return fixed.inputs;
		for (const name of required) {
			if (!ledgerPaths[name] || !fs.existsSync(ledgerPaths[name])) {
				throw Object.assign(new Error(name + '台帳が準備されていません'), { statusCode: 503 });
			}
		}
		return {
			reserves: readArray(ledgerPaths.reserves),
			recorded: readArray(ledgerPaths.recorded),
			match: readArray(ledgerPaths.match)
		};
	}

	function getEvent(eventKey) {
		if (fixed) eventIndex = fixed.builtEvents.events;
		else getSnapshot();
		if (!eventIndex || (!fixed && !cacheSignature)) throw Object.assign(new Error('シリーズ情報を準備中です'), { statusCode: 503 });
		const event = eventIndex.get(eventKey);
		if (!event) {
			throw Object.assign(new Error('対象イベントが現在の台帳に存在しません'), { statusCode: 404 });
		}
		return event;
	}

	function ensureEventExists(eventKey) {
		getEvent(eventKey);
	}

	function previewManualSelection(input) {
		ensureEnabled();
		const event = getEvent(input && input.eventKey);
		const currentResolver = initializeResolver(progLookupStore ? progLookupStore.getSnapshot() : null);
		const tid = Number(input && input.tid);
		const preview = currentResolver.previewSelection(event.program, tid);
		if (!preview) throw Object.assign(new Error('指定したTIDは作品辞書に存在しません'), { statusCode: 400 });
		const requested = Number(input && input.episode);
		const requestedEpisode = Number.isInteger(requested) && requested > 0 ?
			currentResolver.getDictionaryEpisode(tid, requested) : null;
		const workRuleProposal = buildWorkRuleProposal(event, tid, currentResolver);
		return Object.assign(preview, {
			requestedEpisode: requestedEpisode && requestedEpisode.episode || null,
			requestedSubtitle: requestedEpisode && requestedEpisode.subtitle || null,
			workRuleProposal: {
				eligible: workRuleProposal.eligible,
				reason: workRuleProposal.reason
			}
		});
	}

	function setManualOverride(input) {
		ensureEnabled();
		const eventKey = input && input.eventKey;
		const event = getEvent(eventKey);
		const currentResolver = initializeResolver(progLookupStore ? progLookupStore.getSnapshot() : null);
		const tid = Number(input && input.tid);
		if (!currentResolver.getDictionaryTitle(tid)) {
			throw Object.assign(new Error('指定したTIDは作品辞書に存在しません'), { statusCode: 400 });
		}
		const proposal = buildWorkRuleProposal(event, tid, currentResolver);
		const sourceRuleIds = manualStore.getWorkRules()
			.filter(rule => rule.sourceEventKey === eventKey).map(rule => rule.id);
		const saved = manualStore.setWithWorkRule(eventKey, { tid, episode: input && input.episode },
			proposal.eligible ? proposal.rule : null, sourceRuleIds);
		cache = null;
		cacheSignature = null;
		return {
			eventKey,
			override: saved.override,
			workRule: saved.workRuleId ? Object.assign(workRuleSummary(saved.workRule), { id: saved.workRuleId }) : null,
			workRuleStatus: proposal.reason
		};
	}

	function setManualOverrides(input) {
		ensureEnabled();
		const groupId = text(input && input.groupId);
		const eventKeys = input && input.eventKeys;
		if (!groupId || !Array.isArray(eventKeys) || eventKeys.length === 0 ||
			eventKeys.some(key => !text(key)) || new Set(eventKeys).size !== eventKeys.length) {
			throw Object.assign(new Error('一括補正の対象が不正です'), { statusCode: 400 });
		}
		const snapshot = getSnapshot();
		const group = snapshot && Array.isArray(snapshot.attention) ?
			snapshot.attention.find(item => item.id === groupId) : null;
		const submitted = eventKeys.slice().sort((left, right) => left.localeCompare(right, 'en'));
		const current = group ? group.events.map(event => event.key)
			.sort((left, right) => left.localeCompare(right, 'en')) : [];
		if (!group || submitted.length !== current.length || submitted.some((key, index) => key !== current[index])) {
			throw Object.assign(new Error('要確認グループの対象が変更されました'), {
				code: 'attention-group-changed', statusCode: 409
			});
		}
		const conflicts = submitted.filter(eventKey => manualStore.get(eventKey));
		if (conflicts.length) {
			throw Object.assign(new Error('個別の手動補正が追加されたため一括保存できません'), {
				code: 'manual-overrides-conflict', statusCode: 409, eventKeys: conflicts
			});
		}
		const currentResolver = initializeResolver(progLookupStore ? progLookupStore.getSnapshot() : null);
		const tid = Number(input && input.tid);
		if (!currentResolver.getDictionaryTitle(tid)) {
			throw Object.assign(new Error('指定したTIDは作品辞書に存在しません'), { statusCode: 400 });
		}
		const saved = manualStore.setMany(submitted, { tid, episode: null });
		cache = null;
		cacheSignature = null;
		return { groupId, tid, count: saved.length, eventKeys: submitted };
	}

	function removeManualOverride(eventKey) {
		ensureEnabled();
		ensureEventExists(eventKey);
		const removed = manualStore.remove(eventKey);
		cache = null;
		cacheSignature = null;
		return { eventKey, removed };
	}

	function removeWorkRule(input) {
		ensureEnabled();
		const id = input && input.id;
		const removed = manualStore.removeWorkRule(id);
		cache = null;
		cacheSignature = null;
		return { id, removed };
	}

	function setSeriesHidden(input) {
		ensureEnabled();
		const tid = input && input.tid;
		const hidden = input && input.hidden;
		if (!Number.isInteger(tid) || tid <= 0) {
			throw Object.assign(new Error('TIDが不正です'), { statusCode: 400 });
		}
		if (typeof hidden !== 'boolean') {
			throw Object.assign(new Error('非表示状態が不正です'), { statusCode: 400 });
		}
		const result = manualStore.setHiddenTid(tid, hidden);
		if (result.changed) {
			cache = null;
			cacheSignature = null;
		}
		return result;
	}

	function searchTitles(query, limit) {
		ensureEnabled();
		const currentResolver = initializeResolver(progLookupStore ? progLookupStore.getSnapshot() : null);
		return currentResolver.searchDictionaryTitles(query, limit);
	}

	function getBackfillRequests(settings) {
		if (!enabled || !progLookupStore) return [];
		// Automatic acquisition may use the last projection, but must not
		// synchronously rebuild the complete series view on a timer.
		const snapshot = settings && settings.background ? cache : getSnapshot();
		if (!snapshot || !Array.isArray(snapshot.attention)) return [];
		let map;
		try {
			const source = fixed ? fixed.independentMap : syobocalChannelMap.readIndependentChannelMap(options.channelMapPath);
			if (!source) return [];
			map = new Map((Array.isArray(source.channels) ? source.channels : [])
				.filter(entry => entry.status === 'verified')
				.map(entry => [Number(entry.nid) + ':' + Number(entry.sid), [Number(entry.chId)]]));
		} catch (_) {
			return [];
		}
		const current = Date.now();
		const minimum = current - 30 * 24 * 60 * 60 * 1000;
		let activeTitles = new Set();
		try {
			activeTitles = new Set((fixed ? fixed.inputs.reserves : readArray(ledgerPaths.reserves)).map(item => text(item.title || item.fullTitle))
				.filter(Boolean).map(value => value.normalize('NFKC').trim()));
		} catch (_) {}
		const groups = new Map();
		for (const group of snapshot.attention) {
			for (const event of Array.isArray(group.events) ? group.events : []) {
				const start = Number(event.start);
				if (!Number.isFinite(start) || start < minimum || start > current) continue;
				const chIds = map.get(Number(event.channel && event.channel.nid) + ':' + Number(event.channel && event.channel.sid));
				if (!chIds || !chIds.length) continue;
				const day = new Date(start + 9 * 60 * 60 * 1000);
				const dayStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) - 9 * 60 * 60 * 1000;
				const key = String(dayStart);
				const hasRecording = Array.isArray(event.recordings) && event.recordings.some(recording => !recording.deleted && !recording.fileMissing);
				const relatedToReservation = event.reservation || activeTitles.has(text(event.title || event.fullTitle, '').normalize('NFKC').trim());
				const priority = hasRecording ? 1 : relatedToReservation ? 2 : 3;
				if (!groups.has(key)) groups.set(key, { startMs: dayStart, endMs: dayStart + 24 * 60 * 60 * 1000, chIds: chIds.slice(), priority });
				else {
					const target = groups.get(key);
					target.priority = Math.min(target.priority, priority);
					for (const chId of chIds) if (!target.chIds.includes(chId)) target.chIds.push(chId);
				}
			}
		}
		return Array.from(groups.values()).map(group => Object.assign(group, { chIds: group.chIds.sort((a, b) => a - b) }))
			.sort((left, right) => left.priority - right.priority || right.startMs - left.startMs);
	}

	// Display generation is deliberately absent. Only this event's effective
	// correction inputs invalidate the optimistic check.
	function getCorrectionContext(eventKey, state) {
		const event = getEvent(eventKey);
		return { eventKey, title: event.program.title, fullTitle: event.program.fullTitle,
			episode: event.program.episode, manual: (state || manualStore.exportState()).overrides[eventKey] || null,
			rules: Object.entries((state || manualStore.exportState()).workRules).filter(([, rule]) =>
				rule.sourceEventKey === eventKey || workRuleMatches(rule, event, event.program)).map(([id, rule]) => ({
					id, tid: rule.tid, token: createHash('sha256').update(stableJson(rule)).digest('hex') })),
			dictionaryGeneration: fixed?.publication.generation };
	}

	function getCorrectionRevision(input, manualState) {
		const event = getEvent(input.eventKey);
		const program = event.program;
		const state = manualState || manualStore.exportState();
		const tid = Number(input.tid) || null;
		const currentResolver = initializeResolver(progLookupStore ? progLookupStore.getSnapshot() : null);
		const proposal = tid ? buildWorkRuleProposal(event, tid, currentResolver) : null;
		const proposedId = proposal?.eligible ? seriesManualStore.workRuleId(proposal.rule) : null;
		const rules = Object.entries(state.workRules).filter(([id, rule]) =>
			rule.sourceEventKey === event.key || id === proposedId || workRuleMatches(rule, event, program))
			.sort(([a], [b]) => a.localeCompare(b));
		const source = fixed ? fixed.independentMap : syobocalChannelMap.readIndependentChannelMap(options.channelMapPath);
		const mapping = (source?.channels || []).find(row => row.nid === Number(program.channel?.nid) && row.sid === Number(program.channel?.sid));
		const candidates = (source?.unresolved || []).find(row => row.nid === Number(program.channel?.nid) && row.sid === Number(program.channel?.sid));
		const chIds = [...new Set([mapping?.chId, ...(candidates?.acquisitionCandidateChIds || [])].filter(Boolean))].sort((a, b) => a - b);
		const start = Number(program.start);
		const end = Number(program.end) || start + Number(program.seconds) * 1000;
		// The resolver also consults same-time broadcasts on other channels.
		// Fingerprint its effective result rather than only the local ChID rows.
		const resolution = currentResolver.resolve(program);
		const selectedPreview = tid ? currentResolver.previewSelection(program, tid) : null;
		const revision = { event: { program, statuses: event.statuses, deleted: event.deleted, recordingIds: event.recordingIds, sources: event.sources, ids: event.ids, deletions: event.deletions, fileMissing: event.fileMissing, ledgerMissing: event.ledgerMissing },
			override: state.overrides[event.key] || null, rules, dictionary: fixed?.publication.generation,
			chIds, coverage: progLookupStore ? progLookupStore.coverageFor(program, mapping) : null,
			complete: progLookupStore ? progLookupStore.isRangeCovered(start, end, chIds) : false, resolution, selectedPreview,
			selection: tid ? [tid, input.episode ?? null] : null };
		return createHash('sha256').update(stableJson(revision)).digest('hex');
	}

	function close() {
		if (resolver) resolver.close();
		if (dictionary) dictionary.close();
		else if (fixed?.db) fixed.db.close();
		resolver = null;
		dictionary = null;
		resolverGeneration = null;
		cache = null;
		cacheSignature = null;
	}

	return {
		reloadDictionary, invalidate, getMetrics: () => metrics, getCorrectionContext, getCorrectionRevision, getManualGeneration: () => manualStore.getGeneration(),
		getSnapshot, getBackfillRequests, previewManualSelection,
		setManualOverride, setManualOverrides, removeManualOverride, removeWorkRule, setSeriesHidden, searchTitles, close
	};
}

module.exports = { createSeriesService };
