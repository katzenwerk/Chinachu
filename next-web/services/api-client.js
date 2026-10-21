const RESOURCE_PATHS = Object.freeze({
  rules: '/api/rules.json',
  reserves: '/api/reserves.json',
  schedule: '/api/schedule.json',
  recording: '/api/recording.json',
  recorded: '/api/recorded.json',
  storage: '/api/storage.json'
});

const values = new Map();
const pending = new Map();
const revisions = new Map();

function resourceRevision(name) {
  return revisions.get(name) || 0;
}

function invalidateResource(name) {
  resourcePath(name);
  revisions.set(name, resourceRevision(name) + 1);
  values.delete(name);
}

function resourcePath(name) {
  const path = RESOURCE_PATHS[name];
  if (!path) throw new Error(`Unknown WUI resource: ${name}`);
  return path;
}

async function requestJson(name) {
  const path = resourcePath(name);
  const response = await fetch(path, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store'
  });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}

export function loadResource(name, options = {}) {
  resourcePath(name);
  if (options.force === true) values.delete(name);
  if (values.has(name)) return Promise.resolve(values.get(name));
  const revision = resourceRevision(name);
  const current = pending.get(name);
  if (current?.revision === revision) return current.request;

  const request = requestJson(name)
    .then(value => {
      if (resourceRevision(name) === revision) values.set(name, value);
      return value;
    })
    .finally(() => {
      if (pending.get(name)?.request === request) pending.delete(name);
    });
  pending.set(name, { revision, request });
  return request;
}

export async function loadResources(names, options = {}) {
  const entries = await Promise.all(names.map(async name => [name, await loadResource(name, options)]));
  return Object.fromEntries(entries);
}

export function invalidateResources(names = Object.keys(RESOURCE_PATHS)) {
  names.forEach(invalidateResource);
}

export async function loadStorageResources(options = {}) {
  const { storage, rules, reserves } = await loadResources(['storage', 'rules', 'reserves'], options);
  if (!storage || !Array.isArray(storage.storages)) throw new Error('Storage API response is invalid');
  return {
    storage,
    rules: Array.isArray(rules) ? rules : [],
    reserves: Array.isArray(reserves) ? reserves : []
  };
}
