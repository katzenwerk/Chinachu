function text(value, fallback = null) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function seriesEventHref(context, fallbackTab = 'recordings') {
  if (!context?.seriesId) return null;
  const params = new URLSearchParams({ tab: fallbackTab, id: context.seriesId });
  if (context.eventKey) params.set('event', context.eventKey);
  return `#series?${params.toString()}`;
}

export function buildSeriesEventIndex(snapshot) {
  const index = new Map();
  for (const series of Array.isArray(snapshot?.series) ? snapshot.series : []) {
    const tid = positiveInteger(series.tid);
    for (const episode of Array.isArray(series.episodes) ? series.episodes : []) {
      for (const event of Array.isArray(episode.events) ? episode.events : []) {
        const eventKey = text(event.key);
        if (eventKey === null) continue;
        const manualEpisode = positiveInteger(event.resolution?.manual?.episode);
        const episodeSource = event.resolution?.manual?.episodeSource ||
          event.resolution?.workRule?.episodeSource || event.resolution?.episodeConfirmationSource || null;
        let context = index.get(eventKey);
        if (!context) {
          context = {
            eventKey,
            event,
            seriesId: text(series.id),
            seriesTitle: text(series.title, '作品名未取得'),
            tid,
            tidConfirmed: tid !== null,
            episodeConfirmed: false,
            multipleEpisodeConfirmed: false,
            episode: null,
            episodes: [],
            episodeHint: positiveInteger(event.episode),
            episodeLabel: 'EP未確定',
            manualEpisode,
            episodeSource,
            manual: event.resolution?.manual?.active === true,
            workRule: event.resolution?.workRule?.active === true ? event.resolution.workRule : null,
            candidates: tid === null ? [] : [{ tid, title: text(series.title, `TID ${tid}`) }],
            _episodeNumbers: new Set()
          };
          index.set(eventKey, context);
        }
        const number = episode.confirmed === true ? positiveInteger(episode.number) : null;
        if (number !== null) context._episodeNumbers.add(number);
      }
    }
  }
  for (const context of index.values()) {
    context.episodes = Array.from(context._episodeNumbers).sort((left, right) => left - right);
    context.episodeConfirmed = context.episodes.length > 0;
    context.multipleEpisodeConfirmed = context.episodes.length > 1;
    context.episode = context.episodes.length === 1 ? context.episodes[0] : null;
    context.episodeLabel = context.episodes.length === 0 ? 'EP未確定' :
      context.episodes.length === 1 ? `第${context.episodes[0]}話` : `第${context.episodes.join('・')}話`;
    delete context._episodeNumbers;
  }
  for (const group of Array.isArray(snapshot?.attention) ? snapshot.attention : []) {
    for (const event of Array.isArray(group.events) ? group.events : []) {
      const eventKey = text(event.key);
      if (eventKey === null || index.has(eventKey)) continue;
      index.set(eventKey, {
        eventKey,
        event,
        seriesId: null,
        seriesTitle: null,
        tid: null,
        tidConfirmed: false,
        episodeConfirmed: false,
        multipleEpisodeConfirmed: false,
        episode: null,
        episodes: [],
        episodeHint: positiveInteger(event.episode),
        episodeLabel: 'EP未確定',
        manualEpisode: positiveInteger(event.resolution?.manual?.episode),
        episodeSource: event.resolution?.manual?.episodeSource ||
          event.resolution?.workRule?.episodeSource || event.resolution?.episodeConfirmationSource || null,
        manual: event.resolution?.manual?.active === true,
        workRule: event.resolution?.workRule?.active === true ? event.resolution.workRule : null,
        candidates: Array.isArray(group.candidates) ? group.candidates : []
      });
    }
  }
  return index;
}
