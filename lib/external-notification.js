'use strict';

const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('./wui-config');
const reservationStore = require('./reservation-store');

const EVENTS = Object.freeze({ conflict: '予約競合の可能性', failure: '録画失敗', abort: '録画中止',
  storage: 'ストレージ容量不足', analysis: 'TS解析異常・DROP疑い', start: '録画開始', complete: '録画完了' });
const DEFAULT_EVENTS = Object.fromEntries(Object.keys(EVENTS).map(key => [key, !['start', 'complete'].includes(key)]));
const FIELDS = { slack: ['webhook'], pushover: ['token', 'user'], mail: ['host', 'port', 'encryption', 'username', 'password', 'from', 'to'] };
const SECRETS = { slack: ['webhook'], pushover: ['token', 'user'], mail: ['password'] };
const TIMEOUT = 10000;

function invalid() { const error = new Error('通知設定の入力を確認してください。'); error.statusCode = 400; throw error; }
function fileFor(root) { return path.join(root, 'data', 'external-notification.json'); }
function read(root) {
  try {
    const file = fileFor(root);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('Notification settings must be private');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        !value.routes || typeof value.routes !== 'object' || Array.isArray(value.routes) ||
        !value.events || typeof value.events !== 'object' || Array.isArray(value.events)) throw new Error('Invalid notification settings');
    for (const [name, route] of Object.entries(value.routes)) {
      if (!Object.hasOwn(FIELDS, name) || !route || typeof route.enabled !== 'boolean') throw new Error('Invalid notification route');
      validate(name, route);
    }
    for (const [name, enabled] of Object.entries(value.events)) {
      if (!Object.hasOwn(DEFAULT_EVENTS, name) || typeof enabled !== 'boolean') throw new Error('Invalid notification event');
    }
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return { routes: {}, events: { ...DEFAULT_EVENTS } };
    throw error;
  }
}
function publicSettings(value) {
  const routes = {};
  for (const name of Object.keys(FIELDS)) {
    const route = value.routes[name];
    routes[name] = { configured: !!route, enabled: !!route?.enabled };
    if (route) for (const key of FIELDS[name]) if (!SECRETS[name].includes(key)) routes[name][key] = route[key];
  }
  return { routes, events: { ...DEFAULT_EVENTS, ...value.events } };
}
function validate(name, route) {
  for (const key of FIELDS[name]) if (typeof route[key] !== 'string' || !route[key].trim() || route[key].length > 2048 || /[\r\n\0]/.test(route[key])) invalid();
  if (name === 'slack') {
    let url;
    try { url = new URL(route.webhook); } catch (_) { invalid(); }
    if (url.protocol !== 'https:' || !['hooks.slack.com', 'hooks.slack-gov.com'].includes(url.hostname) ||
        !url.pathname.startsWith('/services/') || url.username || url.password || url.port || url.search || url.hash) invalid();
  }
  if (name === 'mail') {
    const port = Number(route.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !['starttls', 'tls'].includes(route.encryption) ||
        port === 587 && route.encryption !== 'starttls' || port === 465 && route.encryption !== 'tls') invalid();
    if (!/^[^\s<>@]+@[^\s<>@]+$/.test(route.from) || !/^[^\s<>@]+@[^\s<>@]+$/.test(route.to) || /[\s/:]/.test(route.host)) invalid();
  }
}
function applyPatch(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) invalid();
  if (patch.events !== undefined) {
    if (!patch.events || typeof patch.events !== 'object' || Array.isArray(patch.events)) invalid();
    for (const [key, value] of Object.entries(patch.events)) {
      if (!Object.hasOwn(DEFAULT_EVENTS, key) || typeof value !== 'boolean') invalid();
      current.events[key] = value;
    }
  }
  if (patch.route !== undefined) {
    const name = patch.route;
    if (!Object.hasOwn(FIELDS, name)) invalid();
    if (patch.remove === true) delete current.routes[name];
    else {
      const previous = current.routes[name];
      const route = { ...(previous || {}), enabled: previous?.enabled === true };
      if (patch.values !== undefined) {
        if (!patch.values || typeof patch.values !== 'object' || Array.isArray(patch.values)) invalid();
        for (const key of FIELDS[name]) {
          if (patch.values[key] === undefined || SECRETS[name].includes(key) && patch.values[key] === '') continue;
          route[key] = patch.values[key];
        }
      }
      if (patch.enabled !== undefined) {
        if (!previous || typeof patch.enabled !== 'boolean') invalid();
        route.enabled = patch.enabled;
      }
      validate(name, route);
      current.routes[name] = route;
    }
  }
}
function update(root, patch, commit) {
  const file = fileFor(root);
  const lock = reservationStore.acquire(file);
  try {
    const current = read(root);
    const previous = JSON.parse(JSON.stringify(current));
    const existed = fs.existsSync(file);
    if (patch?.settings !== undefined) {
      const settings = patch.settings;
      if (!settings || !settings.routes || !settings.events) invalid();
      applyPatch(current, { events: settings.events });
      for (const name of Object.keys(FIELDS)) {
        const route = settings.routes[name];
        if (!route || typeof route.configured !== 'boolean' || typeof route.enabled !== 'boolean') invalid();
        if (!route.configured) applyPatch(current, { route: name, remove: true });
        else {
          applyPatch(current, { route: name, values: route });
          applyPatch(current, { route: name, enabled: route.enabled });
        }
      }
    } else applyPatch(current, patch);
    writeAtomic(file, current);
    try { if (commit) commit(); }
    catch (error) {
      if (existed) writeAtomic(file, previous); else fs.unlinkSync(file);
      throw error;
    }
    return publicSettings(current);
  } finally { lock.release(); }
}
function saveSettings(root, settings, commit) { return update(root, { settings }, commit); }
function message(event, program, detail, timestamp = Date.now()) {
  const title = 'Chinachu thorn — ' + (EVENTS[event] || 'テスト通知');
  const time = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(timestamp) + ' JST';
  return { title, text: [title, time, (program?.title || program?.fullTitle) && '番組: ' + (program.title || program.fullTitle),
    program?.channel?.name && 'チャンネル: ' + program.channel.name, detail].filter(Boolean).join('\n') };
}
async function deliver(name, route, payload, dependencies = {}) {
  const fetcher = dependencies.fetch || globalThis.fetch;
  const post = async (url, body, type) => {
    const response = await fetcher(url, { method: 'POST', headers: { 'Content-Type': type }, body,
      redirect: 'error', signal: AbortSignal.timeout(TIMEOUT) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Delivery failed'); }
    if (name === 'pushover') {
      const result = await response.json();
      if (result.status !== 1) throw new Error('Delivery failed');
    } else await response.body?.cancel();
  };
  if (name === 'slack') {
    const text = Array.from(payload.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')).slice(0, 39000).join('');
    await post(route.webhook, JSON.stringify({ text, mrkdwn: false }), 'application/json');
  } else if (name === 'pushover') {
    await post('https://api.pushover.net/1/messages.json', new URLSearchParams({ token: route.token, user: route.user,
      priority: '0', title: Array.from(payload.title).slice(0, 250).join(''), message: Array.from(payload.text).slice(0, 1024).join('') }), 'application/x-www-form-urlencoded');
  } else {
    const mailer = dependencies.mailer || require('nodemailer');
    const transport = mailer.createTransport({ host: route.host, port: Number(route.port), secure: route.encryption === 'tls',
      requireTLS: route.encryption === 'starttls', auth: { user: route.username, pass: route.password },
      tls: { rejectUnauthorized: true }, connectionTimeout: TIMEOUT, greetingTimeout: TIMEOUT, socketTimeout: TIMEOUT,
      logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true });
    try { await transport.sendMail({ from: route.from, to: route.to, subject: payload.title, text: payload.text, signal: AbortSignal.timeout(TIMEOUT) }); }
    finally { transport.close(); }
  }
}
async function send(root, event, program, detail, options = {}) {
  const settings = read(root);
  if (options.testRoute && options.testValues !== undefined) {
    applyPatch(settings, { route: options.testRoute, values: options.testValues });
  }
  if (!options.testRoute && !settings.events[event]) return [];
  const payload = message(event, program, detail);
  const names = options.testRoute ? [options.testRoute] : Object.keys(FIELDS).filter(name => settings.routes[name]?.enabled);
  return Promise.all(names.map(async name => {
    try {
      if (!settings.routes[name]) throw new Error('Not configured');
      await deliver(name, settings.routes[name], payload, options);
      return { route: name, ok: true };
    } catch (_) {
      options.log?.('WARNING: External notification failed (' + name + ').');
      return { route: name, ok: false };
    }
  }));
}
function testConnection(root, route, values, options = {}) {
  if (!Object.hasOwn(FIELDS, route)) return Promise.reject(Object.assign(new Error('Invalid route'), { statusCode: 400 }));
  return send(root, 'test', null, '外部通知のテスト送信です。', { ...options, testRoute: route, testValues: values });
}
function createNotifier(root, log, dependencies = {}) {
  const stateFile = path.join(root, 'data', 'external-notification-state.json');
  const notify = (event, program, detail) => {
    // Defer settings I/O and delivery beyond the recording callback; never propagate failure.
    setImmediate(() => { send(root, event, program, detail, { ...dependencies, log }).catch(() => log('WARNING: External notification settings unavailable.')); });
  };
  function transition(change) {
    setImmediate(() => {
      try {
        let state;
        try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; state = { conflicts: [], storage: {} }; }
        const before = JSON.stringify(state);
        const events = change(state);
        if (JSON.stringify(state) !== before) writeAtomic(stateFile, state);
        for (const args of events) notify(...args);
      } catch (_) { log('WARNING: External notification state unavailable; transition skipped.'); }
    });
  }
  const notifier = { notify,
    refreshOutcomes() {
      setImmediate(() => {
        try { notifier.outcomes(reservationStore.readArray(path.join(root, 'data', 'match.json'))); }
        catch (_) { log('WARNING: External notification match read failed.'); }
      });
    },
    finish(event, program, detail) {
      const key = require('./match-detail-resolver').makeCanonicalKey(program);
      if (!key) return notify(event, program, detail);
      transition(state => {
        state.outcomes ||= {};
        if (state.outcomes[key]) return [];
        state.outcomes[key] = event;
        return [[event, program, detail]];
      });
    },
    outcomes(rows) {
      const resolver = require('./match-detail-resolver');
      const current = rows.map(row => ({ ...resolver.normalizeMatchEntry(row), channel: row.channel || row.program?.channel }));
      transition(state => {
        const initial = !state.outcomes;
        const previous = state.outcomes || {};
        state.outcomes = {};
        const events = [];
        for (const row of current) {
          if (previous[row.key]) state.outcomes[row.key] = previous[row.key];
          if (row.status !== 'MISSED') continue;
          state.outcomes[row.key] ||= 'failure';
          if (!initial && !previous[row.key]) events.push(['failure', { title: row.fullTitle, channel: row.channel }, '録画結果: MISSED（未録画）']);
        }
        return events;
      });
    },
    recordingResult(program) {
      // Reuse the display's pure result interpretation, without probing files.
      import('../next-web/services/recorded-result-warnings.js').then(model => {
        const warnings = model.recordedResultWarnings({ ...program, status: 'RECORDED' }).filter(item =>
          ['drop', 'head-shortage', 'tail-shortage', 'duration-shortage'].includes(item.key) || item.key.startsWith('ts-'));
        if (warnings.length) notify('analysis', program, '異常・DROPの疑い\n' + warnings.map(item => item.label + ': ' + item.description).join('\n'));
      }).catch(() => log('WARNING: External notification result interpretation failed.'));
    },
    conflicts(rows) {
      const current = rows.filter(row => row.isConflict && !row.isSkip && !row.isDuplicate);
      transition(state => {
        const keys = current.map(row => row.id + ':' + row.start);
        const events = current.filter((row, i) => !state.conflicts.includes(keys[i])).map(row =>
          ['conflict', row, '既存の予約評価で競合と判定されました。チューナー競合の可能性があります。']);
        state.conflicts = keys;
        return events;
      });
    },
    storage(group) {
      group = { ...group, destinations: [...(group.destinations || [])] };
      transition(state => {
        const key = group.filesystemKey;
        const previous = state.storage[key];
        if (group.phase === 'cleanup') state.storage[key] = true;
        else delete state.storage[key];
        return !previous && group.phase === 'cleanup' ? [['storage', null,
          `空き容量: ${Math.floor(group.availableBytes / 1024 / 1024)} MB\n録画先: ${(group.destinations || []).join(', ')}`]] : [];
      });
    }
  };
  return notifier;
}
function analysisSignature(result) {
  if (!result) return '';
  return JSON.stringify([result.status, result.completed, result.error || result.stopReason,
    ...['ccErrorEvents', 'teiPackets', 'syncErrorEvents', 'invalidHeaderPackets', 'pcrGapEvents', 'pcrBackwards', 'scrambledPackets'].map(key => result[key]),
    Object.entries(result.ccErrorsByPid || {}).sort(([a], [b]) => a.localeCompare(b))]);
}
function notifyAnalysis(root, program, result, previous, dependencies = {}) {
  const log = dependencies.log || (line => console.warn(line));
  return new Promise(resolve => setImmediate(resolve)).then(async () => {
    const model = await import('../next-web/services/recorded-result-warnings.js');
    const info = model.savedTsResultInfo({ result });
    if (!info.findings && result?.status !== 'ERROR' && result?.completed !== false) return [];
    if (analysisSignature(result) === analysisSignature(previous)) return [];
    return send(root, 'analysis', program, '解析結果: ' + info.label + (info.findings ? '（異常・DROPの疑い）' : '') +
      (info.description ? '\n' + info.description : ''), { ...dependencies, log });
  }).catch(() => { log('WARNING: External analysis notification failed.'); return []; });
}
module.exports = { EVENTS, DEFAULT_EVENTS, read, publicSettings, update, saveSettings, message, deliver, send, testConnection, createNotifier, notifyAnalysis };
