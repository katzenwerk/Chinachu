'use strict';

const path = require('node:path');
const chinachu = require('chinachu-common');
const { displayableEventSubtitle } = require('./series-resolver');

const DEFAULT_FORMAT = '<fulltitle3> <channel-code>[<date:yyyy-mm-dd HHMM>]';
const captureConfig = config => ({
  format: config.seriesRenameFormat?.trim() || DEFAULT_FORMAT,
  replaceEnclosingCharacters: config.recordedNameReplaceEnclosingCharacters === true || config.needToReplaceEnclosingCharacters === true,
  enclosingCharacterMap: config.recordedNameEnclosingCharacterMap || null
});

function validFormat(value) {
  return value === undefined || typeof value === 'string' && value.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function candidates(series) {
  const entries = new Map();
  for (const episode of series.episodes) {
    if (episode.virtual) continue;
    for (const event of episode.events) for (const recording of event.recordings) {
      if (!recording.recordedId || !recording.current || recording.deleted || recording.fileMissing) continue;
      const id = String(recording.recordedId);
      if (!entries.has(id)) entries.set(id, { id, key: event.key, title: series.title,
        epgSubtitle: displayableEventSubtitle(event), episodes: new Map(), unresolved: false });
      const item = entries.get(id);
      if (item.key !== event.key || !episode.confirmed) item.unresolved = true;
      else item.episodes.set(episode.key, { number: episode.number, label: episode.label, subtitle: episode.dictionarySubtitle,
        first: episode.number != null && series.episodeBoundaries?.first === episode.number,
        last: episode.number != null && series.episodeBoundaries?.last === episode.number });
    }
  }
  return [...entries.values()].filter(item => !item.unresolved && item.episodes.size).map(({ unresolved, episodes, ...item }) => ({
    ...item, episodes: [...episodes.values()].sort((a, b) => a.number != null && b.number != null ? a.number - b.number :
      a.number != null ? -1 : b.number != null ? 1 : String(a.label).localeCompare(String(b.label), 'ja', { numeric: true }))
  }));
}

function nameFor(program, series, filename, config) {
  if (!series.episodes.length) return null;
  const originalExtension = path.extname(filename);
  if (!originalExtension) return null;
  const { format, ...options } = captureConfig(config);
  const name = chinachu.formatRecordedName(program, format, { ...options, series, originalExtension });
  if (!name || name === originalExtension || name === '.' || name === '..' || path.basename(name) !== name) return null;
  return name;
}

module.exports = { candidates, captureConfig, validFormat, nameFor };
