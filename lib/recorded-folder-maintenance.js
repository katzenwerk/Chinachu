'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const store = require('./reservation-store');
const resolver = require('./match-detail-resolver');
const health = require('./storage-health');
const { createFiles } = require('./recorded-maintenance-files');
const organizer = require('./recorded-folder-organizer');
const { writeAtomic } = require('./wui-config');

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = message => Object.assign(new Error(message), { statusCode: 409, publicMessage: message });
function locations(root) {
  return { preview: path.join(root, 'data/recorded-folder-preview.json'),
    result: path.join(root, 'data/recorded-folder-result.json'),
    pending: path.join(root, 'data/recorded-folder-pending.json'),
    lock: path.join(root, 'data/recorded-file-maintenance') };
}
function readOptional(filename) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function pendingId(root) {
  const pending = readOptional(locations(root).pending);
  if (!pending) return null;
  if (pending.version !== 1 || typeof pending.id !== 'string' || !pending.id) throw new Error('未完了の振り分け記録が不正です。記録を確認・修復してから再実行してください。');
  return pending.id;
}
function snapshot(root) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  const recorded = store.readArray(path.join(root, 'data/recorded.json'));
  const match = store.readArray(path.join(root, 'data/match.json'));
  const recording = store.readArray(path.join(root, 'data/recording.json'));
  return { config, recorded, match, recording };
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function persist(filename, value) { writeAtomic(filename, value); syncDirectory(path.dirname(filename)); }
function removePending(filename) { fs.unlinkSync(filename); syncDirectory(path.dirname(filename)); }
function present(filename) {
  try { return fs.lstatSync(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function sameObject(stat, fingerprint) {
  return stat && stat.isFile() && !stat.isSymbolicLink() &&
    stat.dev === fingerprint.dev && stat.ino === fingerprint.ino && stat.size === fingerprint.size && stat.mtimeMs === fingerprint.mtimeMs;
}
function rootState(destination) {
  const result = health.inspectDestination(destination, { checkCapacity: false });
  if (result.status !== 'ok') throw new Error('録画先を確認できません: ' + result.status + ' / ' + (result.detail || ''));
  return { rootIdentity: result.rootIdentity, mountFingerprint: result.mountFingerprint };
}
function checkDirectory(destination, directory) {
  const base = fs.realpathSync(destination.path);
  const parts = path.relative(destination.path, directory).split(path.sep).filter(Boolean);
  if (parts.some(part => part === '..')) throw new Error('録画先の範囲外です。');
  let current = destination.path;
  const device = fs.statSync(base).dev;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== device) throw new Error('移動先・捜索先のディレクトリを安全に確認できません。');
  }
}
function indexNames(destination, progress) {
  const names = new Map(), queue = [destination.path];
  let visited = 0;
  while (queue.length) {
    const directory = queue.pop();
    checkDirectory(destination, directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (++visited > 100000) throw new Error('捜索上限を超えました。台帳整理で対象を絞って確認してください。');
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) queue.push(filename);
      else if (entry.isFile()) {
        if (!names.has(entry.name)) names.set(entry.name, []);
        names.get(entry.name).push(filename);
      }
    }
    progress({ phase: '所在確認', visited });
  }
  return names;
}
async function evaluate(root, options, series, progress = () => {}) {
  const data = snapshot(root), files = createFiles(root, data.config);
  const destinations = files.roots();
  const byId = new Map((series.entries || []).map(([id, tid, title]) => [id, { tid, title }]));
  const results = [], roots = new Map();
  const pending = readOptional(locations(root).pending);
  const originalSignature = digest(data);
  for (const program of data.recorded) {
    if (!program || typeof program.recorded !== 'string') continue;
    const oldPath = path.resolve(root, program.recorded);
    const destination = destinations.find(item => item.path === path.dirname(oldPath));
    if (!destination) continue;
    const row = { id: String(program.id), title: program.fullTitle || program.title || '', oldPath,
      currentPath: oldPath, newPath: null, action: 'none', reason: '', status: 'excluded' };
    results.push(row);
    try {
      if (pending && pending.id === row.id) throw new Error('未完了の移動があります。「未完了を復旧」を実行してください。');
      const target = files.target(row.id);
      if (!target.key || target.linked.length > 1 || data.recorded.filter(item => String(item.id) === row.id).length !== 1 ||
          data.recorded.some(item => item !== program && item.recorded && path.resolve(root, item.recorded) === oldPath)) throw new Error('録画と台帳の対応が一意ではありません。');
      if (target.fileMissing || program.fileMissing || program.deleted || program.cleanupState === 'deleted') throw new Error('行方不明・削除済みの録画です。');
      row.status = 'checking';
      if (!roots.has(destination.path)) {
        const state = rootState(destination);
        const folders = organizer.listExistingFolders(destination.path);
        const entry = { destination, state, folders, names: null, error: null };
        roots.set(destination.path, entry);
        if (options.repairPaths) {
          try { entry.names = indexNames(destination, progress); }
          catch (error) { entry.error = error.message; }
        }
        if (digest(rootState(destination)) !== digest(state)) throw new Error('確認中にマウントが変わりました。');
      }
      const state = roots.get(destination.path);
      if (state.error) throw new Error(state.error);
      let currentPath = oldPath;
      if (!present(currentPath)) {
        if (!options.repairPaths) throw new Error('登録パスにファイルがありません。保存パスの確認はOFFです。');
        const candidates = state.names.get(path.basename(oldPath)) || [];
        if (candidates.length !== 1) throw new Error(candidates.length ? '同名ファイルが複数あります。' : '同じ録画先内にファイルが見つかりません。');
        currentPath = candidates[0];
      }
      if (data.recorded.some(item => item !== program && item.recorded && path.resolve(root, item.recorded) === currentPath)) throw new Error('確認したパスは別録画が使用しています。');
      const source = await files.file(currentPath);
      if (source.destination.path !== destination.path) throw new Error('確認先が別の登録録画先に属しています。');
      row.currentPath = currentPath;
      row.fingerprint = source.fingerprint;
      row.identity = target.identity;
      row.rootPath = destination.path;
      row.rootState = state.state;
      row.destination = { id: destination.id, configuredPath: destination.configuredPath };
      row.status = 'evaluated';
      if (currentPath !== oldPath) {
        row.action = 'repair'; row.newPath = currentPath; row.reason = '同じ録画先内の同名ファイルを一意に確認';
      }
    } catch (error) { row.status = row.status === 'checking' ? 'failed' : 'excluded'; row.reason = error.publicMessage || error.message; }
    progress({ phase: '評価', evaluated: results.length });
  }
  // Repairs are projected once; planned moves never become history for later rows.
  const projected = data.recorded.map(item => {
    const repair = results.find(row => row.status === 'evaluated' && row.action === 'repair' && row.id === String(item.id));
    return repair ? { ...item, recorded: repair.currentPath } : item.recorded ? { ...item, recorded: path.resolve(root, item.recorded) } : item;
  });
  for (const row of results.filter(item => item.status === 'evaluated')) {
    if (path.dirname(row.currentPath) !== row.rootPath) continue;
    const state = roots.get(row.rootPath);
    const selection = organizer.chooseRecordedFolder({ program: projected.find(item => String(item.id) === row.id),
      sourcePath: row.currentPath, root: row.rootPath, folderNames: state.folders,
      recorded: projected, series: byId.get(row.id), seriesByRecordedId: byId, order: data.config.recordedFolderOrganizeOrder });
    if (!selection) { if (row.action === 'none') row.reason = '一致候補なし、または最長候補が同率で決定できません。'; continue; }
    try {
      checkDirectory(state.destination, selection.directoryPath);
      const newPath = path.join(selection.directoryPath, path.basename(row.currentPath));
      if (present(newPath)) throw new Error('移動先に同名ファイルがあります。');
      if (data.recorded.some(item => String(item.id) !== row.id && item.recorded && path.resolve(root, item.recorded) === newPath)) throw new Error('移動先パスが別録画に登録されています。');
      row.action = 'move'; row.newPath = newPath; row.reason = selection.reason; row.method = selection.method;
    } catch (error) { row.status = 'excluded'; row.action = 'none'; row.reason = error.message; }
  }
  const claims = new Map();
  for (const row of results.filter(item => item.action !== 'none')) {
    if (!claims.has(row.newPath)) claims.set(row.newPath, []);
    claims.get(row.newPath).push(row);
  }
  for (const rows of claims.values()) if (rows.length > 1) for (const row of rows) {
    row.action = 'none'; row.status = 'excluded'; row.reason = '複数の録画が同じ適用先を要求しています。';
  }
  for (const state of roots.values()) {
    try {
      if (digest(rootState(state.destination)) !== digest(state.state)) throw new Error('評価中に録画先が変わりました。再評価してください。');
    } catch (error) {
      for (const row of results.filter(item => item.rootPath === state.destination.path)) {
        row.action = 'none'; row.status = 'excluded'; row.reason = error.message;
      }
    }
  }
  if (digest(snapshot(root)) !== originalSignature) throw conflict('評価中に設定・台帳が変わりました。再評価してください。');
  return { id: randomUUID(), options, series, sourceSignature: originalSignature, configSignature: digest(data.config), order: data.config.recordedFolderOrganizeOrder || 'filename', results,
    token: digest(results), createdAt: Date.now() };
}
function updateAnalysis(value, source, target, verified, fingerprint) {
  const result = structuredClone(value);
  if (result?.savedTsAnalysis?.file) {
    if (verified && [source, fingerprint.path].includes(result.savedTsAnalysis.file.path) &&
        ['dev', 'ino', 'size', 'mtimeMs'].every(key => result.savedTsAnalysis.file[key] === fingerprint[key])) result.savedTsAnalysis.file.path = path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
    else result.savedTsAnalysis = null;
  }
  if (!verified && source !== target) {
    if (Object.hasOwn(result, 'savedTsAnalysis')) result.savedTsAnalysis = null;
    if (Object.hasOwn(result, 'recordedDurationSeconds')) result.recordedDurationSeconds = null;
  }
  for (const key of ['recordingResult', 'recorded', 'program']) {
    if (result[key] && typeof result[key] === 'object') result[key] = updateAnalysis(result[key], source, target, verified, fingerprint);
  }
  return result;
}
async function finishPending(root, pending) {
  const data = snapshot(root), files = createFiles(root, data.config);
  const destination = files.roots().find(item => item.path === pending.rootPath);
  if (!destination || digest(rootState(destination)) !== digest(pending.rootState)) throw new Error('録画先・マウントが変わったため復旧できません。');
  checkDirectory(destination, path.dirname(pending.source));
  checkDirectory(destination, path.dirname(pending.target));
  const sourceStat = present(pending.source), targetStat = present(pending.target);
  if (sourceStat && !sameObject(sourceStat, pending.fingerprint) || targetStat && !sameObject(targetStat, pending.fingerprint)) throw new Error('元または先のファイル実体が変わっています。');
  if (!sourceStat && !targetStat) throw new Error('元と先のファイルを確認できません。');
  // Acquire both ledger locks before linking or updating. Never restore whole snapshots.
  return store.withLockAsync(path.join(root, 'data/recorded.json'), () => store.withLockAsync(path.join(root, 'data/match.json'), () => {
    const current = snapshot(root);
    if (digest(rootState(destination)) !== digest(pending.rootState)) throw new Error('適用直前にマウントが変わりました。');
    checkDirectory(destination, path.dirname(pending.source));
    checkDirectory(destination, path.dirname(pending.target));
    const sourceStat = present(pending.source), targetStat = present(pending.target);
    if (sourceStat && !sameObject(sourceStat, pending.fingerprint) || targetStat && !sameObject(targetStat, pending.fingerprint) || !sourceStat && !targetStat) throw new Error('適用直前にファイルが変わりました。');
    const target = files.target(pending.id);
    const index = current.recorded.findIndex(item => String(item.id) === pending.id);
    if (index < 0 || ![digest(pending.before), digest(pending.after)].includes(digest(current.recorded[index])) || target.key !== pending.key) throw new Error('対象台帳が変更されているため復旧できません。');
    if (current.recorded.some((item, at) => at !== index && item.recorded && [pending.source, pending.target].includes(path.resolve(root, item.recorded)))) throw new Error('別録画と保存パスが競合しています。');
    const matches = pending.matches.map(item => {
      const index = current.match.findIndex(row => [digest(item.before), digest(item.after)].includes(digest(row)));
      if (index < 0) throw new Error('対応するmatchが変更されています。');
      return { index, after: item.after };
    });
    if (target.fileMissing || target.linked.length !== pending.matches.length) throw new Error('行方不明記録またはmatch対応の変化により復旧できません。');
    if (!targetStat) {
      fs.linkSync(pending.source, pending.target); // EEXIST must never overwrite another file.
      syncDirectory(path.dirname(pending.target));
    }
    checkDirectory(destination, path.dirname(pending.target));
    if (!sameObject(present(pending.target), pending.fingerprint)) throw new Error('移動先の実体が変わりました。');
    current.recorded[index] = pending.after;
    for (const item of matches) current.match[item.index] = item.after;
    store.writeArrayAtomic(path.join(root, 'data/recorded.json'), current.recorded);
    if (matches.length) store.writeArrayAtomic(path.join(root, 'data/match.json'), current.match);
    if (pending.source !== pending.target && present(pending.source)) {
      checkDirectory(destination, path.dirname(pending.source));
      checkDirectory(destination, path.dirname(pending.target));
      if (!sameObject(present(pending.source), pending.fingerprint) || !sameObject(present(pending.target), pending.fingerprint)) throw new Error('元リンクを安全に解除できません。');
      fs.unlinkSync(pending.source);
      syncDirectory(path.dirname(pending.source));
    }
    syncDirectory(path.join(root, 'data'));
    removePending(locations(root).pending);
    return { id: pending.id, title: pending.before.fullTitle || pending.before.title, oldPath: pending.before.recorded,
      currentPath: pending.source, newPath: pending.target, action: pending.action, status: 'complete', reason: pending.action === 'repair' ? '台帳パス修復完了' : '移動・台帳更新完了' };
  }, { timeoutMs: 2000 }), { timeoutMs: 2000 });
}
async function apply(root, preview, progress = () => {}) {
  const lock = store.acquire(locations(root).lock);
  try {
    if (readOptional(locations(root).pending)) throw conflict('未完了の操作を先に復旧してください。');
    if (digest(preview.results) !== preview.token) throw conflict('評価結果が不正です。再評価してください。');
    if (digest(snapshot(root)) !== preview.sourceSignature) throw conflict('設定・台帳が変わりました。再評価してください。');
    const fresh = await evaluate(root, preview.options, preview.series, progress);
    if (fresh.token !== preview.token) throw conflict('ファイルまたは判定が変わりました。再評価してください。');
    const results = preview.results.map(row => ({ ...row, status: row.action === 'none' ? row.status : 'unapplied' }));
    for (const row of results.filter(item => item.action !== 'none')) {
      try {
        const data = snapshot(root), files = createFiles(root, data.config), target = files.target(row.id);
        if (digest(data.config) !== preview.configSignature) throw new Error('適用中に設定が変更されました。再評価してください。');
        if (target.identity !== row.identity) throw new Error('評価後に対象台帳が変更されました。');
        const verified = await files.file(row.currentPath);
        if (digest(verified.fingerprint) !== digest(row.fingerprint)) throw new Error('評価後にファイルが変更されました。');
        const before = target.recorded.find(item => String(item.id) === row.id);
        const after = updateAnalysis(before, before.recorded, row.newPath, row.action === 'move', row.fingerprint);
        after.recorded = row.newPath;
        if (Object.hasOwn(after, 'path')) after.path = row.newPath;
        after.recordedDir = row.destination.configuredPath;
        after.recordedDirId = row.destination.id;
        const matches = target.linked.map(before => ({ before, after: resolver.withoutRecordingPaths(updateAnalysis(before, row.oldPath, row.newPath, row.action === 'move', row.fingerprint)) }));
        const pending = { version: 1, id: row.id, key: target.key, source: row.currentPath, target: row.newPath,
          rootPath: row.rootPath, rootState: row.rootState, fingerprint: row.fingerprint,
          action: row.action, before, after, matches };
        await store.withLockAsync(path.join(root, 'data/recorded.json'), () => store.withLockAsync(path.join(root, 'data/match.json'), () => {
          if (files.target(row.id).identity !== row.identity) throw new Error('作業記録の保存前に対象台帳が変わりました。');
          if (!sameObject(present(row.currentPath), row.fingerprint)) throw new Error('作業記録の保存前にファイルが変わりました。');
          persist(locations(root).pending, pending);
        }, { timeoutMs: 2000 }), { timeoutMs: 2000 });
        Object.assign(row, await finishPending(root, pending));
      } catch (error) {
        row.reason = error.publicMessage || error.message;
        const pending = readOptional(locations(root).pending);
        if (pending) {
          // A failed no-overwrite link (including unsupported hard links) changed no ledger.
          const current = snapshot(root);
          const original = current.recorded.find(item => String(item.id) === pending.id);
          const beforeMatches = pending.matches.every(item => current.match.some(row => digest(row) === digest(item.before)));
          const untouched = pending.action === 'move' && digest(original) === digest(pending.before) && beforeMatches &&
            sameObject(present(pending.source), pending.fingerprint) && !sameObject(present(pending.target), pending.fingerprint);
          if (untouched) removePending(locations(root).pending);
          else { row.status = 'recovery'; break; }
        }
      }
      progress({ phase: '適用', completed: results.filter(item => item.status === 'complete').length });
    }
    return { results, completedAt: Date.now() };
  } finally { lock.release(); }
}
async function recover(root) {
  const lock = store.acquire(locations(root).lock);
  try {
    const pending = readOptional(locations(root).pending);
    if (!pending) return { results: [], completedAt: Date.now() };
    return { results: [await finishPending(root, pending)], completedAt: Date.now() };
  } finally { lock.release(); }
}
module.exports = { evaluate, apply, recover, locations, readOptional, persist, conflict, pendingId };
