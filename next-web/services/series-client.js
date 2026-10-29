export async function loadSeriesProjection({ signal } = {}) {
  const response = await fetch('/api/series.json', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    credentials: 'same-origin',
    signal
  });
  if (!response.ok) throw new Error(`シリーズAPIを取得できませんでした (HTTP ${response.status})`);
  const result = await response.json();
  if (!result || result.schemaVersion !== 1 || !Array.isArray(result.series) || !Array.isArray(result.attention)) {
    throw new Error('シリーズAPIの応答形式が不正です');
  }
  return result;
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
    const error = new Error(`シリーズAPIの操作に失敗しました (HTTP ${response.status})`);
    error.status = response.status;
    throw error;
  }
  if (!body.trim()) {
    const error = new Error(`シリーズAPIの応答本文が空です (HTTP ${response.status})`);
    error.status = response.status;
    error.resultUnknown = true;
    throw error;
  }
  try {
    return JSON.parse(body);
  } catch (_error) {
    const error = new Error(`シリーズAPIの応答形式が不正です (HTTP ${response.status})`);
    error.status = response.status;
    error.resultUnknown = true;
    throw error;
  }
}

export async function searchSeriesTitles(query, { signal } = {}) {
  const result = await requestJson(`/api/series/search.json?q=${encodeURIComponent(query)}`, { method: 'GET', signal });
  if (!result || result.schemaVersion !== 1 || !Array.isArray(result.results)) {
    throw new Error('作品辞書検索APIの応答形式が不正です');
  }
  return result.results;
}

export async function previewSeriesSelection({ eventKey, tid, episode = null }, { signal } = {}) {
  const result = await requestJson('/api/series/preview.json', {
    method: 'POST', signal, body: JSON.stringify({ eventKey, tid, episode })
  });
  if (!result || result.schemaVersion !== 1 || !result.result) {
    throw new Error('シリーズ補正プレビューAPIの応答形式が不正です');
  }
  return result.result;
}

export async function saveSeriesOverride({ eventKey, tid, episode }, { signal } = {}) {
  return requestJson('/api/series/override.json', {
    method: 'POST', signal, body: JSON.stringify({ eventKey, tid, episode })
  });
}

export async function saveSeriesOverridesBulk({ groupId, eventKeys, tid }, { signal } = {}) {
  return requestJson('/api/series/override-bulk.json', {
    method: 'POST', signal, body: JSON.stringify({ groupId, eventKeys, tid })
  });
}

export async function removeSeriesOverride(eventKey, { signal } = {}) {
  return requestJson('/api/series/override.json', {
    method: 'DELETE', signal, body: JSON.stringify({ eventKey })
  });
}

export async function removeSeriesWorkRule(id, { signal } = {}) {
  return requestJson('/api/series/work-rule.json', {
    method: 'DELETE', signal, body: JSON.stringify({ id })
  });
}

export async function setSeriesHidden(tid, hidden, { signal } = {}) {
  const response = await requestJson('/api/series/hidden.json', {
    method: 'POST', signal, body: JSON.stringify({ tid, hidden })
  });
  if (!response || response.schemaVersion !== 1 || !response.result ||
      Number(response.result.tid) !== Number(tid) || response.result.hidden !== hidden) {
    throw new Error('シリーズ表示設定APIの応答形式が不正です');
  }
  return response.result;
}
