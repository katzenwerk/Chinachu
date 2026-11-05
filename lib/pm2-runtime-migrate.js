'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const {connectExisting, runtimeConfig} = require('./pm2-runtime-client');
const NAMES = new Set(['chinachu-operator', 'chinachu-wui']);
const TARGET_VERSION = '26.13.0';

function node24References(root, value, field = '') {
  const prefix = path.join(root, '.nave/installed/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (typeof value === 'string') return Array.from(value.matchAll(new RegExp(prefix + '24\\.\\d+\\.\\d+(?=/|:|$)', 'g')),
    match => ({field, path: match[0]}));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => node24References(root, item, field ? field + '.' + key : key));
}

function replaceNode24(root, value) {
  if (typeof value === 'string') {
    for (const reference of node24References(root, value)) value = value.split(reference.path).join(path.join(root, '.nave/installed', TARGET_VERSION));
    return value;
  }
  if (Array.isArray(value)) return value.map(item => replaceNode24(root, item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceNode24(root, item)]));
  return value;
}

function patchProcesses(root, list) {
  if (!Array.isArray(list)) throw new Error('PM2 process list must be an array');
  return list.map(item => {
    let copy = structuredClone(item), env = copy.pm2_env || copy;
    const name = copy.name || env.name;
    const references = node24References(root, env);
    if (!NAMES.has(name) && !env.pmx_module && references.length) {
      throw new Error('Node 24 reference outside Chinachu/PM2 migration: ' + name + ': ' +
        references.map(reference => reference.field + '=' + reference.path).join(', '));
    }
    if (NAMES.has(name)) {
      if (path.resolve(env.pm_cwd || root, env.pm_exec_path || env.script || '') !==
          path.join(root, name.replace('chinachu-', 'app-') + '.js')) throw new Error('Foreign Chinachu registration: ' + name);
    }
    if (NAMES.has(name) || env.pmx_module && references.length) {
      copy = replaceNode24(root, copy); env = copy.pm2_env || copy;
      if (NAMES.has(name)) {
        Object.assign(env, runtimeConfig(root, env));
        env.env = {...env.env, PATH: env.PATH};
      }
    }
    return copy;
  });
}
function startupUnit(root, binary, user, home) {
  const q = value => JSON.stringify(value.replace(/%/g, '%%'));
  const node = path.join(root, '.nave/node');
  return `[Unit]\nDescription=PM2 process manager\nAfter=network.target\n\n[Service]\nType=forking\nUser=${user}\nLimitNOFILE=infinity\nLimitNPROC=infinity\nLimitCORE=infinity\nEnvironment=${q('PATH=' + path.join(root, '.nave') + ':/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')}\nEnvironment=${q('PM2_HOME=' + path.join(home, '.pm2'))}\nPIDFile=${path.join(home, '.pm2/pm2.pid').replace(/%/g, '%%').replace(/\s/g, value => '\\x' + value.charCodeAt(0).toString(16).padStart(2, '0'))}\nRestart=on-failure\nExecStart=${q(node)} ${q(binary)} resurrect\nExecReload=${q(node)} ${q(binary)} reload all\nExecStop=${q(node)} ${q(binary)} kill\n\n[Install]\nWantedBy=multi-user.target\n`;
}
function command(binary, args, options = {}) {
  const result = cp.spawnSync(binary, args, {encoding: 'utf8', ...options});
  if (result.error || result.status !== 0) throw new Error(binary + ': ' + (result.error?.message || result.stderr || result.stdout));
  return result.stdout.trim();
}
function readArray(file) {
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); if (!Array.isArray(value)) throw new Error('not an array'); return value; }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function atomic(file, data, uid, gid, mode = 0o600) {
  const tmp = file + '.node26.' + process.pid;
  fs.writeFileSync(tmp, data, {mode, flag: 'wx'});
  fs.chownSync(tmp, uid, gid);
  fs.renameSync(tmp, file);
}
async function inspect(root, binary, user, home, uid) {
  const connection = fs.existsSync(path.join(home, '.pm2/rpc.sock'))
    ? await connectExisting(binary, path.join(home, '.pm2'), uid) : null;
  try {
    const active = connection ? await connection.call('getMonitorData', {}) : [];
    const target = fs.realpathSync(path.join(root, '.nave/node'));
    const daemonPid = connection ? Number(fs.readFileSync(path.join(home, '.pm2/pm2.pid'), 'utf8').trim()) : 0;
    const daemonOK = daemonPid > 0 && fs.readlinkSync('/proc/' + daemonPid + '/exe') === target;
    const patched = patchProcesses(root, active);
    const appsOK = active.filter(item => NAMES.has(item.name) || item.pm2_env.pmx_module).every(item =>
      item.pm2_env.status !== 'online' || fs.readlinkSync('/proc/' + item.pid + '/exe') === target);
    const dump = path.join(home, '.pm2/dump.pm2');
    const saved = readArray(dump), backup = readArray(dump + '.bak');
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const unitFile = '/etc/systemd/system/pm2-' + user + '.service';
    let unit = ''; try {unit = fs.readFileSync(unitFile, 'utf8');} catch (error) {if (error.code !== 'ENOENT') throw error;}
    const desiredUnit = startupUnit(root, binary, user, home);
    const enabled = cp.spawnSync('systemctl', ['is-enabled', 'pm2-' + user + '.service'], {encoding: 'utf8'}).stdout?.trim() === 'enabled';
    return {active, saved, backup, dump, unitFile, desiredUnit,
      needed: !daemonOK || !appsOK || !same(active, patched) || !same(saved, patchProcesses(root, saved)) ||
        !same(backup, patchProcesses(root, backup)) || unit !== desiredUnit || !enabled};
  } finally {connection?.close();}
}
async function repair(root, binary, user, previousActive) {
  root = fs.realpathSync(root); binary = fs.realpathSync(binary);
  if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(user)) throw new Error('Invalid PM2 user');
  const fields = command('getent', ['passwd', user]).split(':');
  const uid = Number(fields[2]), gid = Number(fields[3]), home = fields[5];
  const target = path.join(root, '.nave/node');
  if (command(target, ['-p', 'process.versions.node']) !== '26.13.0') throw new Error('Node 26.13.0 must be activated first');
  if (JSON.parse(fs.readFileSync(path.resolve(binary, '../../package.json'), 'utf8')).name !== 'pm2') throw new Error('Not a PM2 CLI');
  const state = await inspect(root, binary, user, home, uid);
  if (previousActive) {
    const previous = previousActive;
    for (const item of state.active.filter(row => NAMES.has(row.name))) {
      const old = previous.find(row => row.name === item.name && row.pm_id === item.pm_id);
      if (!old) throw new Error('PM2 registration changed during runtime activation');
      item.pm2_env.status = old.pm2_env.status;
    }
    state.needed = true;
  }
  if (!state.needed) {prune24(root); console.log('PM2 daemon/apps/saved/startup already use Node 26.13.0.'); return state.dump;}
  if (process.getuid() !== 0) throw new Error('PM2 runtime/startup repair requires root. Run sudo ./chinachu service runtime-repair ' + (user === 'root' ? 'root' : 'local'));
  // Fail before stopping anything if the system service cannot be controlled.
  const loadState = command('systemctl', ['show', 'pm2-' + user + '.service', '--property=LoadState', '--value']);
  const recording = JSON.parse(fs.readFileSync(path.join(root, 'data/recording.json'), 'utf8'));
  if (!Array.isArray(recording) || recording.length) throw new Error('Recording/preparation is active');
  const now = Date.now();
  for (const name of ['recorded', 'reserves', 'reserves2']) {
    const rows = JSON.parse(fs.readFileSync(path.join(root, 'data/' + name + '.json'), 'utf8'));
    if (!Array.isArray(rows)) throw new Error('Invalid ' + name + ' ledger');
    if (rows.some(item => item.operatorResumePending === true && (!Number.isFinite(Number(item.end)) || Number(item.end) > now))) throw new Error('Recording resume is pending');
    if (name === 'reserves' && rows.some(item => !item.isSkip && Number(item.end) > now && Number(item.start) < now + 300000)) throw new Error('Reservation starts within five minutes');
  }
  const restore = state.active.length ? state.active : state.saved.filter(item => NAMES.has(item.name)).map(env => ({name: env.name, pm2_env: env}));
  const patched = patchProcesses(root, restore);
  const envs = patched.filter(item => !item.pm2_env.pmx_module).map(item => {
    const env = item.pm2_env; delete env.pm_id; delete env.instances; return env;
  });
  const saved = patchProcesses(root, state.saved);
  for (const item of envs.filter(item => NAMES.has(item.name))) if (!saved.some(row => row.name === item.name)) saved.push(item);
  const stablePath = path.join(root, '.nave') + ':/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  const pm2 = args => command('runuser', ['-u', user, '--', 'env', 'PATH=' + stablePath, 'PM2_HOME=' + path.join(home, '.pm2'), target, binary, ...args]);
  // Only this selected manager is rebuilt. Saved-only entries are restored to the dump,
  // not started during repair; installed modules are relaunched by PM2 itself.
  try {
    if (loadState !== 'not-found') command('systemctl', ['stop', 'pm2-' + user + '.service']);
    if (fs.existsSync(path.join(home, '.pm2/pm2.pid'))) {
      const pid = Number(fs.readFileSync(path.join(home, '.pm2/pm2.pid'), 'utf8'));
      if (pid > 0 && fs.existsSync('/proc/' + pid)) pm2(['kill']);
    }
    atomic(state.unitFile, state.desiredUnit, 0, 0, 0o644);
    atomic(state.dump, JSON.stringify(envs, null, 2) + '\n', uid, gid);
    // Do not let a failed parse resurrect the old backup.
    if (fs.existsSync(state.dump + '.bak')) atomic(state.dump + '.bak', JSON.stringify(patchProcesses(root, state.backup), null, 2) + '\n', uid, gid);
    command('systemctl', ['daemon-reload']);
    command('systemctl', ['enable', 'pm2-' + user + '.service']);
    // Configuration is on Node 26 before removal; service success is not a prerequisite.
    prune24(root);
    command('systemctl', ['start', 'pm2-' + user + '.service']);
    atomic(state.dump, JSON.stringify(saved, null, 2) + '\n', uid, gid);
    if (fs.existsSync(state.dump + '.bak')) atomic(state.dump + '.bak', JSON.stringify(patchProcesses(root, state.backup), null, 2) + '\n', uid, gid);
    const deadline = Date.now() + 30000;
    for (;;) {
      const after = await inspect(root, binary, user, home, uid);
      const applications = patched.filter(item => !item.pm2_env.pmx_module);
      if (!after.needed && applications.every(item => after.active.some(row => row.name === item.name && row.pm2_env.status === item.pm2_env.status))) break;
      if (Date.now() >= deadline) throw new Error('PM2 runtime restoration verification failed');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    console.log('PM2 daemon, CLI, startup, Operator/WUI and saved state unified on Node 26.13.0.');
    return state.dump;
  } catch (error) {
    try {
      atomic(state.dump, JSON.stringify(saved, null, 2) + '\n', uid, gid);
      if (fs.existsSync(state.dump + '.bak')) atomic(state.dump + '.bak', JSON.stringify(patchProcesses(root, state.backup), null, 2) + '\n', uid, gid);
    } catch (saveError) {console.error('Saved state recovery: ' + saveError.message);}
    throw error;
  }
}
function prune24(root) {
  const installed = path.join(root, '.nave/installed');
  for (const name of fs.readdirSync(installed).filter(value => /^24\.\d+\.\d+$/.test(value))) {
    fs.rmSync(path.join(installed, name), {recursive: true});
    console.log('Removed Chinachu Node ' + name);
  }
}
module.exports = {patchProcesses, startupUnit, inspect, repair, prune24};
if (require.main === module) {
  const [root, binary, user, action = 'repair'] = process.argv.slice(2);
  (async () => {
    if (action === 'prune') {
      prune24(root);
    } else if (action === 'references') {
      const fields = command('getent', ['passwd', user]).split(':');
      const home = path.join(fields[5], '.pm2');
      const connection = fs.existsSync(path.join(home, 'rpc.sock')) ? await connectExisting(binary, home, Number(fields[2])) : null;
      try {
        const active = connection ? await connection.call('getMonitorData', {}) : [];
        for (const [label, list] of [['active', active], ['saved', readArray(path.join(home, 'dump.pm2'))],
          ['saved fallback', readArray(path.join(home, 'dump.pm2.bak'))]]) {
          for (const item of list) for (const reference of node24References(root, item.pm2_env || item)) {
            console.error('Node 24 reference: ' + label + ' ' + item.name + '.' + reference.field + '=' + reference.path);
          }
          patchProcesses(root, list);
        }
      } finally {connection?.close();}
    } else if (action === 'check') {
      const fields = command('getent', ['passwd', user]).split(':');
      const state = await inspect(root, fs.realpathSync(binary), user, fields[5], Number(fields[2]));
      process.exitCode = state.needed ? 2 : 0;
    } else {
      const input = process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8');
      await repair(root, binary, user, input.trim() ? JSON.parse(input) : null);
    }
  })().catch(error => {console.error(error.message); process.exitCode = 1;});
}
