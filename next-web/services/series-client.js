const pendingReads = new Map();
const projections = new Map();
// Update only presentation data already cached by this browser, without rebuilding series membership.
export function applySeriesThumbnail(recordedId, thumbnailUrl) {
  const affectedSeries = new Set();
  const updateRecordings = recordings => {
    let changed = false;
    for (const recording of recordings || []) {
      if (String(recording.recordedId) !== String(recordedId) || recording.deleted) continue;
      recording.thumbnailUrl = thumbnailUrl;
      changed = true;
    }
    return changed;
  };
  for (const data of projections.values()) {
    for (const series of data.series) {
      for (const episode of series.episodes || []) {
        const changed = updateRecordings(episode.recordings);
        for (const event of episode.events || []) updateRecordings(event.recordings);
        if (!changed) continue;
        if (!episode.thumbnailUrl) episode.thumbnailUrl = thumbnailUrl;
        affectedSeries.add(series.id);
      }
    }
    for (const group of data.attention) {
      for (const event of group.events || []) updateRecordings(event.recordings);
    }
  }
  for (const data of projections.values()) {
    for (const series of data.series) {
      if (affectedSeries.has(series.id) && !series.representativeThumbnailUrl) series.representativeThumbnailUrl = thumbnailUrl;
    }
  }
}
let pendingManualGeneration = 0;

// Shared reads are independent of a page's lifetime. Aborting one consumer
// must not cancel a read still used by another page or dialog.
function consume(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function sharedRead(path, options = {}, signal) {
  const key = path + (options.body || '');
  if (!pendingReads.has(key)) {
    const promise = requestJson(path, options).finally(() => pendingReads.delete(key));
    pendingReads.set(key, promise);
  }
  return consume(pendingReads.get(key), signal);
}
export function loadSeriesStatus({ signal } = {}) {
  return sharedRead('/api/series/status.json', { method: 'GET' }, signal).then(state => {
    if ((state.manualGeneration || 0) < pendingManualGeneration) {
      return { ...state, manualPending: true, availability: { ...state.availability, message: '補正を保存しました。シリーズ情報への反映を待っています。' } };
    }
    return state;
  });
}
export async function loadSeriesProjection({ signal, id, groupId, event, eventKeys, filter = 'all', view = 'list', page = 1, q = '', generation, retry = true } = {}) {
  const state = await loadSeriesStatus({ signal });
  if (generation && state.generation !== generation) {
    const error = new Error('シリーズ情報が更新されました'); error.status = 409; throw error;
  }
  const query = id ? ['/api/series/detail.json?id=' + encodeURIComponent(id) + (event ? '&event=' + encodeURIComponent(event) : ''), {}] :
    groupId ? ['/api/series/attention.json?id=' + encodeURIComponent(groupId), {}] :
    event ? ['/api/series/event.json?event=' + encodeURIComponent(event), {}] :
    eventKeys ? ['/api/series/events.json', { method: 'POST', body: JSON.stringify({ eventKeys: [...new Set(eventKeys)].filter(Boolean).sort() }) }] :
    ['/api/series/overview.json?' + new URLSearchParams({ filter, view, page, q }), {}];
  if (query[1].body) {
    query[1].body = JSON.stringify({ ...JSON.parse(query[1].body), generation: state.generation });
  } else query[0] += (query[0].includes('?') ? '&' : '?') + 'generation=' + encodeURIComponent(state.generation);
  const key = state.generation + ':' + query[0] + (query[1].body || '');
  let data = projections.get(key);
  if (!data) {
    try {
      data = await sharedRead(query[0], query[1], signal);
    } catch (error) {
      if (retry && error.status === 409) return loadSeriesProjection({ signal, id, groupId, event, eventKeys, filter, view, page, q, generation, retry: false });
      throw error;
    }
    if (!data || data.schemaVersion !== 1 || !Array.isArray(data.series) || !Array.isArray(data.attention)) {
      throw new Error('シリーズAPIの応答形式が不正です');
    }
    for (const item of data.series) for (const episode of item.episodes || []) {
      for (const entry of episode.events || []) entry.generation = data.generation;
    }
    for (const group of data.attention) {
      group.generation = data.generation;
      for (const entry of group.events || []) entry.generation = data.generation;
    }
    // Bound navigation cache memory; never retain complete historical projections.
    if (projections.size >= 24) projections.delete(projections.keys().next().value);
    if (data.generation) projections.set(key, data);
  }
  return { ...data, availability: data.generation === state.generation ? state.availability : data.availability };
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    cache: 'no-store',
    credentials: 'same-origin',
    ...options,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.text();
  if (!response.ok) {
    let detail = null;
    try { detail = JSON.parse(body).error; } catch (_) {}
    const error = new Error(detail?.message || `シリーズAPIの操作に失敗しました (HTTP ${response.status})`);
    error.status = response.status;
    error.code = detail?.code;
    error.contextToken = detail?.contextToken;
    error.currentContext = detail?.currentContext;
    throw error;
  }
  if (!body.trim()) {
    const error = new Error(`シリーズAPIの応答本文が空です (HTTP ${response.status})`);
    error.status = response.status;
    error.resultUnknown = true;
    throw error;
  }
  try {
    const result = JSON.parse(body);
    if (Number.isSafeInteger(result.result?.manualGeneration)) pendingManualGeneration = Math.max(pendingManualGeneration, result.result.manualGeneration);
    return result;
  } catch (_error) {
    const error = new Error(`シリーズAPIの応答形式が不正です (HTTP ${response.status})`);
    error.status = response.status;
    error.resultUnknown = true;
    throw error;
  }
}

export async function searchSeriesTitles(query, { signal, kind } = {}) {
  const result = await requestJson(`/api/series/search.json?q=${encodeURIComponent(query)}${kind ? '&kind=' + encodeURIComponent(kind) : ''}`, { method: 'GET', signal });
  if (!result || result.schemaVersion !== 1 || !Array.isArray(result.results)) {
    throw new Error('作品辞書検索APIの応答形式が不正です');
  }
  return result.results;
}

export async function previewSeriesSelection({ eventKey, tid, seriesId, episode = null, generation, contextToken }, { signal } = {}) {
  const result = await requestJson('/api/series/preview.json', {
    method: 'POST', signal, body: JSON.stringify({ eventKey, tid, seriesId, episode, generation, contextToken })
  });
  if (!result || result.schemaVersion !== 1 || !result.result) {
    throw new Error('シリーズ補正プレビューAPIの応答形式が不正です');
  }
  return result.result;
}

export async function saveSeriesOverride({ eventKey, tid, seriesId, episode, generation, validationToken }, { signal } = {}) {
  return requestJson('/api/series/override.json', {
    method: 'POST', signal, body: JSON.stringify({ eventKey, tid, seriesId, episode, generation, validationToken })
  });
}

export async function saveSeriesOverridesBulk({ groupId, eventKeys, tid, seriesId, generation, dictionaryGeneration }, { signal } = {}) {
  return requestJson('/api/series/override-bulk.json', {
    method: 'POST', signal, body: JSON.stringify({ groupId, eventKeys, tid, seriesId, generation, dictionaryGeneration })
  });
}

export async function removeSeriesOverride(eventKey, { signal, generation, contextToken } = {}) {
  return requestJson('/api/series/override.json', {
    method: 'DELETE', signal, body: JSON.stringify({ eventKey, generation, contextToken })
  });
}

export async function removeSeriesWorkRule(id, { signal, generation, eventKey, contextToken, ruleToken } = {}) {
  return requestJson('/api/series/work-rule.json', {
    method: 'DELETE', signal, body: JSON.stringify({ id, generation, eventKey, contextToken, ruleToken })
  });
}

export async function setSeriesHidden(tid, hidden, { signal, generation } = {}) {
  const response = await requestJson('/api/series/hidden.json', {
    method: 'POST', signal, body: JSON.stringify({ tid, hidden, generation })
  });
  if (!response || response.schemaVersion !== 1 || !response.result ||
      Number(response.result.tid) !== Number(tid) || response.result.hidden !== hidden) {
    throw new Error('シリーズ表示設定APIの応答形式が不正です');
  }
  return response.result;
}

export function listLocalSeries(q = '', { signal } = {}) {
  return requestJson('/api/series/local.json?q=' + encodeURIComponent(q), { method: 'GET', signal });
}
export function createLocalSeries(title, { signal } = {}) {
  return requestJson('/api/series/local.json', { method: 'POST', body: JSON.stringify({ title }), signal });
}
export function deleteLocalSeries(ids, manualGeneration, { signal } = {}) {
  return requestJson('/api/series/local.json', { method: 'DELETE', body: JSON.stringify({ ids, manualGeneration }), signal });
}

export function loadSeriesDictionary({ q = '', page = 1, tid, dictionaryGeneration, signal } = {}) {
  const query = tid === undefined ? new URLSearchParams({ q, page }) : new URLSearchParams({ tid });
  if (dictionaryGeneration) query.set('dictionaryGeneration', dictionaryGeneration);
  return requestJson('/api/series/dictionary.json?' + query, { method: 'GET', signal });
}
