function validText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function normalizeDisplayText(value) {
  const text = validText(value);
  if (text === null) return null;
  return text.replace(/\r\n?/g, '\n').split('\n')
    .map(line => line.replace(/[\t\f\v ]+/g, ' ').trim())
    .filter(Boolean).join(' ');
}

function compactHeading(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('ja-JP')
    .replace(/[＜＞<>【】\[\]「」『』（）()\s:：・]/gu, '');
}

function normalizedEpisode(value) {
  if (Number.isInteger(value) && value >= 0) return String(value);
  const text = validText(value);
  if (text === null || text.length > 40) return null;
  return /^[#\d\s.,，/／&＆\-~～＋+前後上下話回]+$/u.test(text) ? text.replace(/^#/u, '').trim() : null;
}

function isDescriptionHeadingSubtitle(program, subtitle) {
  const key = compactHeading(subtitle);
  if (!['スタッフ', 'キャスト'].includes(key)) return false;
  const detail = normalizeDisplayText(program?.detail || program?.description);
  if (detail === null) return false;
  return compactHeading(detail).startsWith(key);
}

function usableParsedSubtitle(program) {
  const subtitle = normalizeDisplayText(program?.subTitle);
  if (subtitle === null) return null;
  const title = normalizeDisplayText(program?.title);
  if (title !== null && title.includes(subtitle)) return null;
  if (isDescriptionHeadingSubtitle(program, subtitle)) return null;
  return subtitle;
}

export function canonicalProgramKey(program) {
  const explicit = validText(program?.key);
  if (explicit !== null) return explicit;
  const channelId = validText(program?.channel?.id);
  const start = Number(program?.start);
  const seconds = Number(program?.seconds);
  return channelId !== null && Number.isFinite(start) && start > 0 &&
    Number.isFinite(seconds) && seconds > 0 ? `${channelId}|${start}|${seconds}` : null;
}

export function buildSeriesTitleIndex(snapshot) {
  const index = new Map();
  for (const series of Array.isArray(snapshot?.series) ? snapshot.series : []) {
    for (const episode of Array.isArray(series?.episodes) ? series.episodes : []) {
      for (const event of Array.isArray(episode?.events) ? episode.events : []) {
        const key = validText(event?.key);
        if (key === null) continue;
        const resolution = event.resolution || {};
        const manualEpisode = Number(resolution.manual?.episode);
        const manualEpisodeConfirmed = resolution.manual?.active === true && Number.isInteger(manualEpisode) && manualEpisode > 0;
        const seriesEpisodeConfirmed = episode.confirmed === true && resolution.episodeConfirmed === true;
        const rawEpisode = normalizedEpisode(event.episode);
        const episodeNumber = manualEpisodeConfirmed ? String(manualEpisode) :
          seriesEpisodeConfirmed ? rawEpisode || (Number.isInteger(episode.number) ? String(episode.number) : null) : null;
        const tid = Number(series.tid);
        const tidConfirmed = series.tid !== null && series.tid !== undefined && Number.isInteger(tid) && tid > 0;
        index.set(key, {
          tid: tidConfirmed ? tid : null,
          tidConfirmed,
          seriesTitle: normalizeDisplayText(series.title),
          episodeConfirmed: manualEpisodeConfirmed || seriesEpisodeConfirmed,
          episode: episodeNumber,
          dictionaryEpisode: seriesEpisodeConfirmed || manualEpisodeConfirmed ? episode.number : null,
          dictionarySubtitle: seriesEpisodeConfirmed || manualEpisodeConfirmed ? normalizeDisplayText(episode.dictionarySubtitle) : null,
          multipleEpisode: episode.kind === 'multiple-unconfirmed',
          manual: resolution.manual?.active === true
        });
      }
    }
  }
  return index;
}

export function buildProgramDisplayTitle(program, seriesTitleIndex = null) {
  const key = canonicalProgramKey(program);
  const series = key !== null && seriesTitleIndex instanceof Map ? seriesTitleIndex.get(key) || null : null;
  const parsedTitle = normalizeDisplayText(program?.title);
  const fallback = normalizeDisplayText(program?.fullTitle) || 'タイトル未取得';
  const title = series?.tidConfirmed && series.seriesTitle || parsedTitle;
  if (title === null) {
    return { text: fallback, title: fallback, subtitle: null, episode: null, source: 'full-title' };
  }

  const dictionarySubtitle = series?.episodeConfirmed ? series.dictionarySubtitle : null;
  const subtitle = dictionarySubtitle || usableParsedSubtitle(program);
  const seriesEpisode = series?.episodeConfirmed && !series.multipleEpisode ? normalizedEpisode(series.episode) : null;
  const parsedEpisode = normalizedEpisode(program?.episode);
  const episode = seriesEpisode || parsedEpisode;
  const parts = [title];
  if (subtitle !== null && !title.includes(subtitle)) parts.push(subtitle);
  if (episode !== null) parts.push(`#${episode}`);
  return {
    text: parts.join(' '),
    title,
    subtitle,
    episode,
    source: series?.tidConfirmed ? 'series' : 'parsed',
    episodeSource: seriesEpisode !== null ? 'series-confirmed' : parsedEpisode !== null ? 'epg-parsed' : null
  };
}
