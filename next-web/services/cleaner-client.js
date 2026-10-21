const CLEANER_PATH = '/api/cleaner.json';
const CLEANER_SCAN_PATH = '/api/cleaner/scan.json';
const CLEANER_APPLY_PATH = '/api/cleaner/apply.json';

async function readJson(response) {
  if (!response.ok) throw new Error(`台帳整理APIが HTTP ${response.status} を返しました`);
  return response.json();
}

export function loadCleanerState() {
  return fetch(CLEANER_PATH, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store'
  }).then(readJson);
}

export function startCleanerScan(options) {
  return fetch(CLEANER_SCAN_PATH, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(options)
  }).then(readJson);
}

export function applyCleanerPlan(previewId) {
  return fetch(CLEANER_APPLY_PATH, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ previewId, confirm: true })
  }).then(readJson);
}
