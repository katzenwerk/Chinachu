'use strict';

// Only called by explicit single-record maintenance or analysis registration.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./reservation-store');
const resolver = require('./match-detail-resolver');
const health = require('./storage-health');
const savedTs = require('./saved-ts-analysis');

function fail(message, code = 'maintenance_conflict') {
  const error = new Error(message);
  error.publicMessage = message;
  error.code = code;
  error.statusCode = code === 'invalid_request' ? 400 : 409;
  throw error;
}
const errorText = error => error.publicMessage || error.message;
function within(root, value) {
  const rel = path.relative(root, value);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
function fingerprint(stat, filename) {
  return { path: filename, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}
function sameFile(a, b) {
  return !!a && !!b && ['path', 'dev', 'ino', 'size', 'mtimeMs'].every(key => a[key] === b[key]);
}
function createFiles(root, config) {
  root = path.resolve(root);
  const recordedFile = path.join(root, 'data/recorded.json');
  const matchFile = path.join(root, 'data/match.json');
  const recordingFile = path.join(root, 'data/recording.json');
  // This resolver is private to server-loaded ledger/config values. User-entered
  // candidates still go straight to file(), which requires an absolute path.
  function ledgerPath(value) {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) fail('台帳の保存パスが不正です。');
    return path.resolve(root, value);
  }
  function target(id) {
    if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') fail('録画IDが不正です。', 'invalid_request');
    let recorded, matches, recording;
    try {
      recorded = store.readArray(recordedFile);
      matches = store.readArray(matchFile);
      recording = store.readArray(recordingFile);
    } catch (_) { fail('録画・台帳データを読み取れません。形式・読み取り権限を確認してください。', 'ledger_read_failed'); }
    const resolved = resolver.resolveRecordedProgram(id, matches, { recorded, recording });
    const identityKey = resolved.program && resolver.makeCanonicalKey(resolved.program);
    const terminal = matches.some(entry => resolver.isExplicitDeletion(entry) &&
      ((resolver.normalizeMatchEntry(entry).recording || {}).recordedId === id || identityKey && resolver.normalizeMatchEntry(entry).key === identityKey));
    if (terminal) fail('削除済みの録画は確認・捜索・復帰できません。', 'recorded_deleted');
    if (!resolved.program) fail('対象録画を一意に特定できません。');
    const program = resolved.program;
    if (String(program.id) !== id) fail('別名IDから対象録画を確定できません。録画IDを指定してください。');
    const key = resolver.makeCanonicalKey(program) || program._matchKey;
    const linked = matches.filter(entry => {
      const n = resolver.normalizeMatchEntry(entry);
      const reference = n.recording || n.fileMissing;
      return reference && reference.recordedId === id || key && n.key === key;
    });
    if (linked.some(entry => {
      const n = resolver.normalizeMatchEntry(entry);
      return n.recording?.recordedId && n.recording.recordedId !== id;
    })) fail('別の録画IDと台帳の対応が競合しています。');
    const finishedAt = Number(program.operatorRecordingEnd) || Number(program.end);
    if (program.operatorResumePending || program.pid || !program.recorded || !finishedAt || finishedAt > Date.now() ||
        recording.some(item => String(item.id) === id || typeof item.recorded === 'string' && item.recorded.trim() &&
          ledgerPath(item.recorded) === ledgerPath(program.recorded))) {
      fail('録画中・再開待ち、または終了済みと確認できない対象です。');
    }
    const fileMissing = linked.length === 1 ? resolver.normalizeMatchEntry(linked[0]).fileMissing : null;
    const registeredPath = linked.length === 1 ? (resolver.normalizeMatchEntry(linked[0]).recording || fileMissing)?.path || null : null;
    const pathConflict = registeredPath !== null && ledgerPath(registeredPath) !== ledgerPath(program.recorded);
    return { id, program, key, recorded, matches, linked, fileMissing, registeredPath, pathConflict, historical: resolved.source !== 'recorded',
      identity: JSON.stringify([id, key, program.recorded, program.start, program.end, linked.map(entry => JSON.stringify(entry))]) };
  }
  function roots() {
    const configured = [{ path: config.recordedDir }, ...(Array.isArray(config.recordedDirs) ? config.recordedDirs : [])]
      .filter(destination => destination && typeof destination.path === 'string' && destination.path.trim());
    const absolute = value => typeof value === 'string' && value.trim() ? ledgerPath(value) : value;
    const resolvedConfig = { ...config, recordedDir: absolute(config.recordedDir),
      recordedDirs: Array.isArray(config.recordedDirs) ? config.recordedDirs.map(destination =>
        destination && typeof destination === 'object' ? { ...destination, path: absolute(destination.path) } : destination) : config.recordedDirs };
    return health.getDestinations(resolvedConfig).map(destination => ({ ...destination,
      // Keep the existing configuredPath contract used when a repair is explicitly approved.
      configuredPath: configured.find(item => ledgerPath(item.path) === destination.path)?.path || destination.configuredPath }));
  }
  function checkedRoot(filename) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename.includes('\0')) fail('サーバー上の絶対パスを指定してください。', 'invalid_request');
    const absolute = path.resolve(filename);
    const destination = roots().filter(item => within(item.path, absolute)).sort((a, b) => b.path.length - a.path.length)[0];
    if (!destination) fail('登録済み録画先の配下ではありません。');
    const inspection = health.inspectDestination(destination, { checkCapacity: false });
    if (inspection.status !== 'ok') fail('録画先を安全に確認できません: ' + inspection.status + ' / ' + (inspection.detail || ''));
    return { destination, inspection, absolute };
  }
  async function file(filename) {
    const checked = checkedRoot(filename);
    const base = checked.destination.path;
    let current = base;
    // Root aliases are resolved by storage-health; links below that root are rejected.
    for (const segment of path.relative(base, checked.absolute).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const stat = await fs.promises.lstat(current);
      if (stat.isSymbolicLink()) fail('録画先内のシンボリックリンクは指定できません。');
    }
    const real = await fs.promises.realpath(checked.absolute);
    if (!within(checked.inspection.resolvedPath, real)) fail('実体が録画先の範囲外です。');
    const stat = await fs.promises.stat(real);
    if (!stat.isFile() || stat.size <= 0 || !/\.(ts|m2ts)$/i.test(real)) fail('空でない通常のTSファイルを指定してください。');
    if (checked.inspection.filesystemId && health.linuxDeviceId(stat.dev) !== checked.inspection.filesystemId) fail('ファイルが確認済み録画先と別のファイルシステムにあります。');
    await fs.promises.access(real, fs.constants.R_OK);
    return { ...checked, real, fingerprint: fingerprint(stat, real), size: stat.size, linkCount: stat.nlink };
  }
  async function inspect(t) {
    let before;
    try { before = checkedRoot(ledgerPath(t.program.recorded)); }
    catch (error) { return { state: 'failed', checkedAt: Date.now(), message: errorText(error) }; }
    try { return { state: 'present', checkedAt: Date.now(), ...(await file(ledgerPath(t.program.recorded))) }; }
    catch (error) {
      // ENOENT below a healthy, verified root is absence. Mount/I/O/permission failures are not.
      if (error.code === 'ENOENT') {
        try {
          const after = checkedRoot(ledgerPath(t.program.recorded));
          if (before.inspection.mountFingerprint !== after.inspection.mountFingerprint || before.inspection.rootIdentity !== after.inspection.rootIdentity) fail('確認中に録画先のマウントが変わりました。');
          return { state: 'missing', checkedAt: Date.now(), message: '登録パスにファイルがありません。' };
        } catch (cause) { return { state: 'failed', checkedAt: Date.now(), message: errorText(cause) }; }
      }
      return { state: 'failed', checkedAt: Date.now(), message: error.publicMessage || error.message };
    }
  }
  function assertTarget(t) {
    const latest = target(t.id);
    if (latest.identity !== t.identity) fail('録画ID・パス・台帳が変更されています。状態確認をやり直してください。');
    return latest;
  }
  async function assertFile(t, f) {
    assertTarget(t);
    const latest = await file(ledgerPath(t.program.recorded));
    if (!sameFile(f.fingerprint, latest.fingerprint)) fail('確認後に録画ファイルが変更されています。');
    return latest;
  }
  async function save(t, fields) {
    return store.withLockAsync(recordedFile, () => store.withLockAsync(matchFile, () => {
      const latest = assertTarget(t);
      const updates = typeof fields === 'function' ? fields(latest) : fields;
      if (updates === null) return latest;
      const originals = { recorded: JSON.parse(JSON.stringify(latest.recorded)), matches: JSON.parse(JSON.stringify(latest.matches)) };
      const entry = latest.recorded.find(item => String(item.id) === t.id);
      if (entry) Object.assign(entry, updates);
      for (const row of latest.linked) {
        // Preserve the existing v2/legacy paths, and place supplemental results alongside the result snapshot.
        if (row.schemaVersion === 2) {
          Object.assign(row, updates);
        } else {
          const container = row.recordingResult || row.recorded || row.program;
          if (!container || typeof container !== 'object') fail('履歴の保存形式を安全に更新できません。');
          Object.assign(container, updates);
        }
      }
      if (!entry && !latest.linked.length) fail('結果の保存先がありません。');
      try {
        if (entry) store.writeArrayAtomic(recordedFile, latest.recorded);
        if (latest.linked.length) store.writeArrayAtomic(matchFile, latest.matches);
      } catch (error) {
        // Same two-ledger rollback contract as Cleaner; never replace invalid JSON with defaults.
        try {
          if (entry) store.writeArrayAtomic(recordedFile, originals.recorded);
          if (latest.linked.length) store.writeArrayAtomic(matchFile, originals.matches);
        } catch (rollback) { error.message += '; ledger rollback failed: ' + rollback.message; }
        throw error;
      }
      return target(t.id);
    }, { timeoutMs: 2000 }), { timeoutMs: 2000 });
  }
  async function saveAnalysis(t, analysis, external = false, source = null) {
    const normalized = { ...analysis, result: savedTs.normalizeResult(analysis.result) };
    // Check the file before acquiring ledger locks. HDD/mount waits must not
    // hold the recording ledgers; save() rechecks ledger identity under locks.
    if (external) await assertFile(t, source);
    let status = 'registered';
    const latest = await save(t, current => {
      const rows = [...current.linked.flatMap(row => [row, row.recordingResult, row.program, row.recorded]), current.program].filter(Boolean);
      if (external) {
        registrationTarget(current);
        if (rows.some(row => savedTs.completed(row.savedTsAnalysis?.result))) {
          status = 'unchanged';
          return null; // Existing completed results always win, including retries.
        }
      }
      const previous = rows.find(row => Object.prototype.hasOwnProperty.call(row, 'savedTsAnalysis'))?.savedTsAnalysis;
      return { savedTsAnalysis: normalized.result.completed || !previous?.result?.completed ? normalized :
        { ...previous, lastAttempt: { checkedAt: normalized.checkedAt, status: normalized.result.status,
          reason: normalized.result.stopReason || normalized.result.error } } };
    });
    return { target: latest, status };
  }
  function registrationTarget(t) {
    if (t.fileMissing) fail('行方不明の録画には登録できません。');
    if (t.pathConflict || t.linked.length !== 1 || t.recorded.filter(item => String(item.id) === t.id).length > 1) fail('対象録画を一意に特定できません。');
    const row = t.linked[0], n = resolver.normalizeMatchEntry(row);
    if (row.schemaVersion !== 2 || !['RECORDED', 'RECORDED_UNTRACKED'].includes(n.status) ||
        n.recording?.recordedId !== t.id || !n.recording?.path || ledgerPath(n.recording.path) !== ledgerPath(t.program.recorded)) {
      fail('対応するmatch v2録画ID・登録パスを確定できません。');
    }
    const registered = ledgerPath(n.recording.path);
    if (t.recorded.some(item => String(item.id) !== t.id && item.recorded && ledgerPath(item.recorded) === registered) ||
        t.matches.some(other => {
          if (other === row) return false;
          const reference = resolver.normalizeMatchEntry(other).recording || resolver.normalizeMatchEntry(other).fileMissing;
          return reference?.path && ledgerPath(reference.path) === registered;
        })) fail('同じ登録パスに別の録画履歴が対応しています。');
  }
  async function registerAnalysis(id, input) {
    const analysis = savedTs.externalAnalysis(input);
    const t = target(id);
    registrationTarget(t);
    const registered = ledgerPath(t.registeredPath);
    if (analysis.file.path !== registered) fail('解析対象とmatchの登録パスが一致しません。');
    const source = await file(registered);
    for (const key of ['size', 'dev', 'ino', 'mtimeMs']) {
      if (analysis.file[key] !== undefined && analysis.file[key] !== source.fingerprint[key]) fail('解析時のファイル情報と現在の対象が一致しません。');
    }
    // Missing historical identity fields stay missing. Do not turn a current
    // stat into a claimed analysis-time fingerprint or invent an analysis date.
    analysis.registeredPath = t.registeredPath;
    const outcome = await saveAnalysis(t, analysis, true, source);
    return { status: outcome.status, id, reason: outcome.status === 'unchanged' ? 'completed-result-exists' : undefined };
  }
  function claimedByOther(t, candidate) {
    const aliases = value => {
      if (typeof value !== 'string' || !value.trim()) return '';
      const absolute = ledgerPath(value);
      const r = roots().find(item => within(item.path, absolute));
      return r && r.path === candidate.destination.path ? path.join(candidate.inspection.resolvedPath, path.relative(r.path, absolute)) : absolute;
    };
    const conflicting = value => aliases(value) === candidate.real || typeof value === 'string' && path.basename(value) === path.basename(candidate.real);
    return t.recorded.some(item => String(item.id) !== t.id && conflicting(item.recorded)) ||
      t.matches.some(entry => {
        const n = resolver.normalizeMatchEntry(entry);
        return n.recording && n.recording.recordedId !== t.id && conflicting(n.recording.path);
      });
  }
  function correspondence(t, candidate) {
    const name = path.basename(candidate.real);
    const original = path.basename(t.program.recorded);
    if (t.fileMissing && resolver.sameRecordingTarget(t.fileMissing, { recordedId: t.id, path: candidate.absolute })) return '不在を記録した録画ID・登録パスと一致';
    const previous = t.program.savedTsAnalysis?.file;
    if (previous && previous.size === candidate.size && name === original) return '元のファイル名と保存済み解析のサイズが一致';
    const date = new Date(Number(t.program.start));
    const pad = n => String(n).padStart(2, '0');
    const day = date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
    const time = pad(date.getHours()) + pad(date.getMinutes());
    const sid = String(t.program.channel?.sid || '');
    const idInName = name.split(/[^A-Za-z0-9._-]+/).includes(t.id);
    if (name === original && name.includes(day) && name.includes(time) && sid && name.includes(sid)) return '元のファイル名・放送開始日時・サービスIDが一致';
    if (idInName && name.includes(day) && name.includes(time)) return 'ファイル名内の録画ID・放送開始日時が一致';
    fail('対応関係を確定できません。同名だけでは反映しません。録画ID・日時・サービスIDまたは保存済みサイズとの照合が必要です。');
  }
  async function verify(t, filename) {
    assertTarget(t);
    const candidate = await file(filename);
    if (candidate.linkCount > 1) fail('ハードリンクがあるため、別履歴との重複参照を安全に除外できません。');
    if (claimedByOther(t, candidate)) fail('別履歴に同じパスまたはファイル名の参照があり、対応関係を確定できません。');
    const evidence = correspondence(t, candidate);
    const token = crypto.randomBytes(24).toString('hex');
    const ticket = { token, identity: t.identity, candidate, evidence, expiresAt: Date.now() + 5 * 60 * 1000 };
    return { token, path: candidate.absolute, oldPath: t.program.recorded, size: candidate.size, evidence, expiresAt: ticket.expiresAt, _ticket: ticket };
  }
  async function apply(t, ticket, beforeCommit) {
    if (!ticket || ticket.expiresAt < Date.now() || ticket.identity !== t.identity) fail('候補の確認期限が切れたか、録画履歴が変わりました。再確認してください。');
    const candidate = await file(ticket.candidate.absolute);
    if (!sameFile(candidate.fingerprint, ticket.candidate.fingerprint)) fail('確認後に候補ファイルが変更されています。');
    if (claimedByOther(assertTarget(t), candidate)) fail('候補が別の履歴に関連付けられています。');
    correspondence(t, candidate);
    const newPath = candidate.absolute;
    const samePath = ledgerPath(t.program.recorded) === newPath;
    const dir = candidate.destination;
    if (beforeCommit) await beforeCommit();
    // Path and supplemental-file results are saved in one locked transaction.
    const latest = await store.withLockAsync(recordedFile, () => store.withLockAsync(matchFile, () => {
      const current = assertTarget(t);
      // Disk verification above is outside ledger locks: a slow data disk must
      // not hold up recording finalization. Re-read ledger identity under both locks.
      if (candidate.linkCount > 1 || claimedByOther(current, candidate)) fail('反映直前に別の参照・候補の競合が検出されました。');
      const oldRecorded = JSON.parse(JSON.stringify(current.recorded));
      const oldMatches = JSON.parse(JSON.stringify(current.matches));
      let entry = current.recorded.find(item => String(item.id) === t.id);
      if (!entry) {
        // Reuse the existing historical resolver, retaining broadcast identity; do not invent an EPG snapshot.
        if (!current.key || !current.program.channel?.id || !Number(current.program.start)) fail('履歴に録画を復元する識別情報が不足しています。');
        entry = { ...current.program, id: t.id };
        for (const key of Object.keys(entry)) if (key.startsWith('_')) delete entry[key];
        current.recorded.push(entry);
      }
      const fields = { recorded: newPath, recordedDirId: dir.id, recordedDir: dir.configuredPath,
        ...(samePath ? {} : { savedTsAnalysis: null, recordedDurationSeconds: null }) };
      Object.assign(entry, fields); delete entry.fileMissing;
      if (Object.hasOwn(entry, 'path')) entry.path = newPath;
      for (const row of current.linked) {
        if (row.schemaVersion === 2) {
          row.recording = { recordedId: t.id, path: newPath }; delete row.fileMissing;
          if (!samePath) Object.assign(row, { savedTsAnalysis: null, recordedDurationSeconds: null });
        }
        for (const container of [row.program, row.recorded, row.recordingResult, row.recordingResult?.snapshot]) {
          if (!container || typeof container !== 'object') continue;
          if (Object.hasOwn(container, 'recorded')) container.recorded = newPath;
          if (Object.hasOwn(container, 'path')) container.path = newPath;
          Object.assign(container, { recordedDirId: fields.recordedDirId, recordedDir: fields.recordedDir,
            ...(samePath ? {} : { savedTsAnalysis: null, recordedDurationSeconds: null }) });
        }
      }
      try {
        store.writeArrayAtomic(recordedFile, current.recorded);
        if (current.linked.length) store.writeArrayAtomic(matchFile, current.matches);
      } catch (error) {
        try { store.writeArrayAtomic(recordedFile, oldRecorded); store.writeArrayAtomic(matchFile, oldMatches); }
        catch (rollback) { error.message += '; rollback failed: ' + rollback.message; }
        throw error;
      }
      return target(t.id);
    }, { timeoutMs: 2000 }), { timeoutMs: 2000 });
    return latest;
  }
  async function search(t, selectedIds, check, beforeCommit) {
    const selected = roots().filter(r => !selectedIds?.length || selectedIds.includes(r.id || 'default'));
    if (!selected.length) fail('捜索先を選択してください。');
    const candidates = [];
    const failures = [];
    const observedRoots = [];
    let visited = 0, excluded = false;
    const name = path.basename(t.program.recorded);
    for (const root of selected) {
      try {
        check();
        assertTarget(t);
        const inspection = health.inspectDestination(root, { checkCapacity: false });
        if (inspection.status !== 'ok') fail('録画先の確認失敗: ' + root.name + ' / ' + inspection.status);
        observedRoots.push({ root, inspection });
        const dirs = [root.path];
        while (dirs.length) {
          check();
          assertTarget(t);
          const dir = dirs.pop();
          const dirStat = await fs.promises.lstat(dir);
          if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) fail('捜索中にディレクトリの種類が変わりました。');
          const realDir = await fs.promises.realpath(dir);
          if (!within(inspection.resolvedPath, realDir) || inspection.filesystemId && health.linuxDeviceId(dirStat.dev) !== inspection.filesystemId) fail('捜索先に録画先範囲外のディレクトリがあります。');
          const entries = await fs.promises.readdir(dir, { withFileTypes: true });
          for (const item of entries) {
            check();
            if (++visited > 100000) fail('捜索上限に達しました。録画先を絞って再実行してください。');
            if (item.isSymbolicLink()) { excluded = true; continue; }
            const filename = path.join(dir, item.name);
            if (item.isDirectory()) dirs.push(filename);
            else if (item.isFile() && item.name === name) {
              try { candidates.push(await verify(t, filename)); }
              catch (error) { candidates.push({ path: filename, rejected: true, message: error.publicMessage || error.message }); }
              if (candidates.length >= 20) fail('候補が20件に達しました。捜索先を絞ってください。');
            }
          }
        }
      } catch (error) { failures.push(error.publicMessage || error.message); }
    }
    const complete = failures.length === 0;
    const allRoots = roots();
    const fullScope = selected.length === allRoots.length && allRoots.every(root => selected.some(item => item.path === root.path)) &&
      selected.some(root => within(root.path, ledgerPath(t.program.recorded))) && !excluded;
    let persisted = false;
    if (complete && fullScope && !candidates.length) {
      check();
      for (const observed of observedRoots) {
        check();
        const current = health.inspectDestination(observed.root, { checkCapacity: false });
        if (current.status !== 'ok' || current.mountFingerprint !== observed.inspection.mountFingerprint || current.rootIdentity !== observed.inspection.rootIdentity) fail('捜索中に録画先のマウント状態が変わりました。不在を保存しません。');
      }
      const currentFile = await inspect(t);
      if (currentFile.state !== 'missing') fail(currentFile.message || '登録パスの不在を確定できません。再捜索してください。');
      if (beforeCommit) await beforeCommit();
      await store.withLockAsync(recordedFile, () => store.withLockAsync(matchFile, () => {
        const latest = assertTarget(t);
        if (latest.linked.length !== 1 || latest.linked[0].schemaVersion !== 2 || !latest.key) fail('matchの対象を一意に特定できないため不在を保存しません。');
        if (latest.matches.some(row => { const n = resolver.normalizeMatchEntry(row), ref = n.recording || n.fileMissing; return ref && ref.recordedId !== t.id && ref.path && ledgerPath(ref.path) === ledgerPath(t.program.recorded); })) fail('他の履歴も同じ保存パスを参照しています。');
        const row = latest.linked[0], n = resolver.normalizeMatchEntry(row);
        const reference = n.recording || n.fileMissing || (n.key === latest.key ? { recordedId: t.id, path: t.program.recorded } : null);
        if (!resolver.sameRecordingTarget(reference, { recordedId: t.id, path: t.program.recorded })) fail('録画とパスの対応が一致しません。');
        row.fileMissing = { recordedId: t.id, path: ledgerPath(t.program.recorded), checkedAt: Date.now() };
        store.writeArrayAtomic(matchFile, latest.matches); persisted = true;
      }, { timeoutMs: 2000 }), { timeoutMs: 2000 });
    }
    return { candidates, failures, complete, fullScope, persisted, visited };

  }
  return { target, roots, file, inspect, assertTarget, assertFile, save, saveAnalysis, registerAnalysis, verify, apply, search };
}
module.exports = { createFiles, sameFile, fail };
