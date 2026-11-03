const PAGE_SIZE = 50;

async function loadRecordedResultsPageRaw(options = {}) {
  const params = new URLSearchParams({
    mode: 'page',
    page: String(options.page || 1),
    limit: String(options.limit || PAGE_SIZE)
  });
  if (options.search) params.set('search', options.search);
	if (options.status) params.set('status', options.status);
	if (Array.isArray(options.results)) params.set('results', options.results.join(','));
	if (options.ruleUid) params.set('ruleUid', options.ruleUid);

  const response = await fetch(`/api/match.json?${params}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: options.signal
  });
  if (!response.ok) throw new Error(`/api/match.json returned HTTP ${response.status}`);
  const result = await response.json();
  if (!result || !Array.isArray(result.items) || !Number.isInteger(result.total) ||
      !Number.isInteger(result.page) || !Number.isInteger(result.pageSize) ||
      !Number.isInteger(result.totalPages)) {
    throw new Error('Match page API response is invalid');
  }
  return result;
}

function resultKind(item) {
  if (item?.status === 'MISSED') return 'missed';
  if (item?.status === 'SKIPPED_ONLY') return 'skipped';
  if (item?.status === 'RECORDED' || item?.status === 'RECORDED_UNTRACKED') {
    return item?.deletionKind === 'explicit' ? 'deleted' : item?.fileMissing ? 'missing' : 'recorded';
  }
  return null;
}

export async function loadRecordedResultsPage(options = {}) {
  if (!options.ruleUid) return loadRecordedResultsPageRaw(options);
  const filtered = await loadRecordedResultsPageRaw(options);
  if (Number(filtered.filterVersion) >= 2 && filtered.appliedRuleUid === options.ruleUid) return filtered;

  // Older running WUI processes ignore ruleUid. Keep the previous client-side
  // fallback until the server module has been reloaded instead of showing zero.
  const page = Number.isInteger(Number(options.page)) && Number(options.page) > 0 ? Number(options.page) : 1;
  const pageSize = Number.isInteger(Number(options.limit)) && Number(options.limit) > 0 ? Number(options.limit) : PAGE_SIZE;
  const items = (await loadAllRecordedResults({ ...options, ruleUid: null }))
    .filter(item => typeof item?.ruleUid === 'string' && item.ruleUid === options.ruleUid);
  const counts = { recorded: 0, deleted: 0, missing: 0, missed: 0, skipped: 0 };
  items.forEach(item => {
    const kind = resultKind(item);
    if (kind) counts[kind] += 1;
  });
  const offset = (page - 1) * pageSize;
  return {
    items: items.slice(offset, offset + pageSize),
    total: items.length,
    counts,
    page,
    pageSize,
    totalPages: items.length === 0 ? 0 : Math.ceil(items.length / pageSize)
  };
}

export async function loadRecordedResultsCounts(options = {}) {
  let counts = null;
  try {
    const response = await fetch('/api/match.json?mode=result-counts', {
      method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store', signal: options.signal
    });
    if (response.ok) counts = (await response.json())?.counts;
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
  }
  if (!counts || !Number.isInteger(counts.recorded) || !Number.isInteger(counts.deleted) ||
      !Number.isInteger(counts.missed)) {
    const result = await loadRecordedResultsPage({
      ...options,
      page: 1,
      limit: 1,
      results: Array.isArray(options.results) ? options.results : ['recorded', 'deleted', 'missing', 'missed']
    });
    counts = result.counts;
  }
  if (!counts || !Number.isInteger(counts.recorded) || !Number.isInteger(counts.deleted) ||
      !Number.isInteger(counts.missed)) throw new Error('Match count API response is invalid');
  return {
    recorded: counts.recorded + counts.deleted + (counts.missing || 0),
    missed: counts.missed
  };
}

export async function loadAllRecordedResults(options = {}) {
  const items = [];
  const keys = new Set();
  let page = 1;
  let totalPages = 1;
  do {
    const result = await loadRecordedResultsPage({ ...options, page });
    result.items.forEach((item, index) => {
      const key = typeof item?.key === 'string' && item.key !== '' ? item.key : `page-${page}-${index}`;
      if (keys.has(key)) return;
      keys.add(key);
      items.push(item);
    });
    totalPages = result.totalPages;
    page += 1;
  } while (page <= totalPages);
  return items;
}

function recordedPath(item) {
  const candidates = [
    item?.recording?.path,
    item?.recordingResult?.path,
    item?.recordingResult?.recorded,
    item?.recorded?.path,
    item?.recorded?.recorded,
    item?.program?.path,
    item?.program?.recorded
  ];
  return candidates.find(value => typeof value === 'string' && value !== '') || null;
}

export async function loadMatchRecordingPaths(options = {}) {
  const response = await fetch('/api/match.json', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: options.signal
  });
  if (!response.ok) throw new Error(`/api/match.json returned HTTP ${response.status}`);
  const items = await response.json();
  if (!Array.isArray(items)) throw new Error('Match ledger API response is invalid');
  const paths = new Map();
  items.forEach(item => {
    const key = typeof item?.key === 'string' && item.key !== '' ? item.key : null;
    const path = recordedPath(item);
    if (key !== null && path !== null) paths.set(key, path);
  });
  return paths;
}

export { PAGE_SIZE as RECORDED_RESULTS_PAGE_SIZE };
