'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');
const { createFiles, sameFile, fail } = require('./recorded-maintenance-files');
const { extractionPercent } = require('./recorded-thumbnail');

// Single-record requests are drained only by Operator's existing post-processing arbiter.
// This module does not start an independent execution queue or execute recording hooks.
function createMaintenance(options) {
  const files = createFiles(options.root, options.config);
  const jobs = new Map();
  const queue = [];
  let active = null;
  let activeAuto = null;
  let activeAutoThumbnail = null;
  let thumbnailPaused = false;
  let thumbnailError = null;
  let autoPaused = false;
  let autoError = null;
  let stopped = false;
  let wakeTimer = null;
  let thumbnailWait = null;
  const tickets = new Map();
  const WAIT_MS = 10 * 60 * 1000;
  const errorText = error => error.publicMessage || error.message || String(error);
  const changed = () => options.onChanged();
  const thumb = () => options.thumbnail;
  function diskRequest(job, action, extra = {}) {
    return new Promise((resolve, reject) => {
      if (stopped || job.cancelled && action !== 'assertFile') return reject(new Error('Operator停止・録画優先による中断です。'));
      if (!fs.existsSync('/usr/bin/ionice')) return reject(new Error('低I/O優先度で実行するioniceがありません。'));
      const child = childProcess.fork(path.join(options.root, 'lib/recorded-maintenance-file-worker.js'), [], {
        execPath: '/usr/bin/ionice', execArgv: ['-c', '3', process.execPath], stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      });
      job.child = child;
      job.committing = false;
      let response = null, failure = null, stderr = '';
      const timer = setTimeout(() => {
        failure = new Error('ファイル確認・捜索の120秒期限に達しました。');
        child.kill('SIGKILL');
      }, 120000);
      try { if (child.pid) os.setPriority(child.pid, 19); } catch (error) { failure = error; child.kill('SIGKILL'); }
      child.stderr.on('data', data => { stderr = (stderr + data).slice(-1024); });
      child.once('error', error => { failure = error; });
      child.on('message', message => {
        if (message.phase === 'commit') {
          if (stopped || job.cancelled) { failure = new Error('台帳反映前に中断しました。'); child.kill('SIGKILL'); return; }
          job.committing = true;
          clearTimeout(timer);
          child.send({ commit: true });
          return;
        }
        response = message;
      });
      child.once('close', () => {
        clearTimeout(timer); job.child = null; job.committing = false;
        if (failure) return reject(failure);
        if (!response?.ok) return reject(new Error(response?.message || stderr || 'ファイル確認を完了できませんでした。'));
        resolve(response.result);
      });
      child.send({ root: options.root, config: options.config, id: job.id, identity: job.target.identity, action,
        deadline: Math.min(job.createdAt + WAIT_MS, Date.now() + 120000), ...extra }, error => {
        if (error) { failure = error; child.kill('SIGKILL'); }
      });
    });
  }
  async function assertSource(job) {
    files.assertTarget(job.target);
    const result = await diskRequest(job, 'assertFile', { fingerprint: job.source.fingerprint });
    files.assertTarget(job.target);
    return result;
  }
  function keepTicket(candidate) {
    if (candidate?._ticket) {
      tickets.set(candidate.token, candidate._ticket);
      delete candidate._ticket;
    }
    for (const [key, value] of tickets) if (value.expiresAt < Date.now()) tickets.delete(key);
    return candidate;
  }
  function saved(t) {
    const recordedRow = t.recorded.find(row => String(row.id) === t.id && row.recorded === t.program.recorded);
    const rows = [recordedRow, t.program, ...t.linked.flatMap(row => [row, row.recordingResult, row.program, row.recorded])].filter(Boolean);
    const durationRow = rows.find(row => Object.prototype.hasOwnProperty.call(row, 'recordedDurationSeconds'));
    const seconds = Number(durationRow?.recordedDurationSeconds);
    const analysisRow = rows.find(row => Object.prototype.hasOwnProperty.call(row, 'savedTsAnalysis'));
    return { duration: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
      analysis: analysisRow?.savedTsAnalysis || null };
  }
  function snapshot(t, job) {
    const data = saved(t);
    if (data.analysis && job?.target.identity === t.identity && job.source &&
        !sameFile(data.analysis.file, job.source.fingerprint)) data.analysis = { ...data.analysis, stale: true };
    const thumbnail = thumb().getStatus(t.id);
    return { maintenanceVersion: 1, id: t.id, path: t.registeredPath, historical: t.historical,
      roots: files.roots().map(root => ({ id: root.id || 'default', name: root.name, path: root.configuredPath })),
      fileMissing: t.fileMissing || null,
      file: t.fileMissing ? { state: 'missing', checkedAt: t.fileMissing.checkedAt } : job?.target.identity === t.identity ? job.file : { state: 'assumed' },
      ffprobe: { state: data.duration ? 'complete' : 'missing', seconds: data.duration },
      thumbnail, analysis: data.analysis,
      job: job ? { status: job.status, action: job.action, stage: job.stage, createdAt: job.createdAt,
        waitReason: job.status === 'queued' ? options.waitReason?.(job.action === 'run' &&
          (job.tasks.ts.selected || job.tasks.ts.redo)) || null : null,
        stages: job.stages, tasks: job.tasks, message: job.message || '', search: job.search, candidate: job.candidate } : null };
  }
  function state(id) { const t = files.target(id); return snapshot(t, jobs.get(id)); }
  function isBusy() { return active !== null || activeAuto !== null || activeAutoThumbnail !== null; }
  function thumbnailSummary() {
    try { return options.getThumbnailSummary(); }
    catch (error) {
      thumbnailPaused = true;
      thumbnailError = 'サムネイル候補を確認できません: ' + errorText(error);
      return { remaining: null, candidate: null };
    }
  }
  function autoThumbnailStatus() {
    const summary = thumbnailSummary();
    return { autoThumbnailVersion: 1, paused: thumbnailPaused, error: thumbnailError, remaining: summary.remaining,
      state: thumbnailPaused ? 'paused' : activeAutoThumbnail ? 'running' : summary.remaining === 0 ? 'complete' : 'waiting',
      current: activeAutoThumbnail ? { id: activeAutoThumbnail.id, title: activeAutoThumbnail.title } : null };
  }
  function interruptAutoThumbnail(reason) {
    if (!activeAutoThumbnail || activeAutoThumbnail.cancelled) return;
    activeAutoThumbnail.cancelled = true;
    activeAutoThumbnail.message = reason;
    activeAutoThumbnail.child?.kill('SIGKILL');
    thumb().cancel(activeAutoThumbnail.id, 'interrupted');
  }
  function startAutoThumbnail(record) {
    if (stopped || thumbnailPaused || isBusy() || queue.length || !options.canStart() || !options.thumbnailAllowed()) return false;
    let target;
    try {
      target = files.target(String(record.id));
      if (target.fileMissing || target.program.recorded !== record.recorded) throw new Error('録画台帳の対象が変更されています。');
    } catch (error) { thumb().markFailed(record.id, errorText(error)); options.wake(); return false; }
    const job = { id: String(record.id), title: record.title || record.fullTitle || '', target,
      stage: 'file', child: null, cancelled: false };
    activeAutoThumbnail = job;
    Promise.resolve().then(async () => {
      try {
        job.source = await inspectAutoFile(job, record.recorded);
        if (stopped || job.cancelled || thumbnailPaused || !options.thumbnailAllowed()) return;
        job.stage = 'thumbnail';
        await new Promise((resolve, reject) => {
          thumbnailWait = { id: job.id, resolve, reject };
          const result = thumb().enqueue({ id: job.id, inputPath: job.source.real,
            durationSeconds: saved(target).duration,
            percent: 35, replace: false,
            validate: async () => {
              if (stopped || job.cancelled) throw new Error('サムネイル自動補完を中断しました。');
              files.assertTarget(target);
              const current = await inspectAutoFile(job, record.recorded);
              if (!sameFile(job.source.fingerprint, current.fingerprint)) throw new Error('録画ファイルが変更されました。');
            }
          });
          if (result.reason === 'existing') resolve();
          else if (!result.accepted) reject(new Error(result.reason));
        }).finally(() => { thumbnailWait = null; });
      } catch (error) {
        if (!stopped && !job.cancelled) {
          thumb().markFailed(job.id, errorText(error));
          options.log?.('WARNING: AUTO THUMBNAIL: ' + errorText(error));
        }
      }
    }).finally(() => { activeAutoThumbnail = null; options.wake(); });
    return true;
  }
  function monitorState() {
    const names = job => job.action === 'run' ? ['ffprobe', 'thumbnail', 'ts'].filter(name =>
      job.tasks?.[name]?.selected || job.tasks?.[name]?.redo) : [];
    const pendingCounts = { ffprobe: 0, thumbnail: 0, ts: 0 };
    const pendingJobs = [];
    for (const job of queue) {
      for (const name of names(job)) {
        pendingCounts[name]++;
        if (pendingJobs.length < 5) pendingJobs.push({ id: job.id, type: name, queuedAt: job.createdAt });
      }
    }
    return { pendingCounts, pendingJobs, active: active ? { id: active.id,
      type: ['ffprobe', 'thumbnail', 'ts'].includes(active.stage) ? active.stage : names(active)[0] || 'maintenance',
      startedAt: active.startedAt || active.createdAt } : null };
  }
  function autoStatus() {
    const { counts } = options.getAutoSummary();
    const enabled = options.autoEnabled === true;
    return {
      autoAnalysisVersion: 1, enabled, paused: autoPaused,
      state: !enabled ? 'disabled' : activeAuto ? 'running' : autoPaused ? 'paused' : active ? 'manual-running' :
        options.autoWaitReason() || 'idle',
      counts, error: autoError,
      current: activeAuto ? { id: activeAuto.id, title: activeAuto.title,
        size: activeAuto.source?.size || null, bytesRead: activeAuto.bytesRead || 0, stage: activeAuto.stage } : null
    };
  }
  function interruptAuto(reason) {
    if (!activeAuto || activeAuto.cancelled) return;
    activeAuto.cancelled = true;
    activeAuto.message = reason;
    activeAuto.child?.kill('SIGKILL');
  }
  function inspectAutoFile(job, filename) {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync('/usr/bin/ionice')) return reject(new Error('低I/O優先度で実行するioniceがありません。'));
      const child = childProcess.fork(path.join(options.root, 'lib/recorded-auto-file-worker.js'), [], {
        execPath: '/usr/bin/ionice', execArgv: ['-c', '3', process.execPath], stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      });
      job.child = child;
      let response = null, failure = null, stderr = '';
      const timer = setTimeout(() => {
        failure = new Error('録画ファイル確認の120秒期限に達しました。');
        child.kill('SIGKILL');
      }, 120000);
      try { if (child.pid) os.setPriority(child.pid, 19); }
      catch (error) { failure = error; child.kill('SIGKILL'); }
      child.stderr.on('data', data => { stderr = (stderr + data).slice(-1024); });
      child.once('error', error => { failure = error; });
      child.on('message', message => { response = message; });
      child.once('close', () => {
        clearTimeout(timer);
        job.child = null;
        if (failure) return reject(failure);
        if (!response?.ok) return reject(new Error(response?.message || stderr || '録画ファイルを確認できませんでした。'));
        resolve(response.file);
      });
      child.send({ root: options.root, config: options.config, filename }, error => {
        if (error) { failure = error; child.kill('SIGKILL'); }
      });
    });
  }
  function startAuto(record) {
    if (!options.autoEnabled || stopped || autoPaused || isBusy() || queue.length ||
        !options.canStart() || !options.autoAllowed()) return false;
    const job = { id: String(record.id), title: record.title || record.fullTitle || '',
      stage: 'file', startedAt: Date.now(), source: null, child: null, cancelled: false, timedOut: false };
    activeAuto = job;
    Promise.resolve().then(async () => {
      let result;
      try {
        job.source = await inspectAutoFile(job, record.recorded);
        if (stopped || job.cancelled || autoPaused || !options.autoAllowed()) return;
        job.stage = 'running';
        try { result = await analyze(job); }
        catch (error) { result = { status: 'ERROR', completed: false, error: errorText(error) }; }
        if (stopped || job.cancelled && !job.timedOut) return;
        if (job.timedOut) {
          result = { status: 'ERROR', completed: false, error: job.message };
        } else {
          const current = await inspectAutoFile(job, job.source.absolute);
          if (!sameFile(job.source.fingerprint, current.fingerprint)) {
            throw new Error('TS解析中に録画ファイルが変更されました。');
          }
          if (!result.completed) result = { status: 'ERROR', completed: false,
            error: result.error || result.stopReason || 'TS解析を完了できませんでした。' };
        }
      } catch (error) {
        if (stopped || job.cancelled && !job.timedOut) return;
        result = { status: 'ERROR', completed: false, error: errorText(error) };
      }
      if (stopped || job.cancelled && !job.timedOut) return;
      try {
        const saved = await files.saveAutoAnalysis(record, {
          checkedAt: Date.now(), registeredPath: record.recorded,
          file: job.source?.fingerprint || { path: path.resolve(options.root, record.recorded) }, result
        });
        if (saved) options.onCompleted?.({ id: job.id, title: job.title, mode: 'auto',
          status: result.status === 'ERROR' ? 'failed' : result.status === 'SUSPECT' ? 'suspect' : 'complete',
          startedAt: job.startedAt });
        // Also refresh when another writer already completed or removed this entry.
        changed();
        options.log?.('AUTO TS: ' + result.status + ' #' + job.id);
      } catch (error) {
        // A ledger failure cannot be persisted as a per-file failure. Stop automatic
        // work rather than re-reading the same TS indefinitely.
        autoPaused = true;
        autoError = '解析結果を保存できませんでした: ' + errorText(error);
        options.log?.('ERROR: AUTO TS: ' + autoError);
      }
    }).finally(() => {
      activeAuto = null;
      options.wake();
    });
    return true;
  }
  function currentThumbnail(job) {
    const current = active || activeAutoThumbnail;
    return current?.id === job.id && current.stage === 'thumbnail' &&
      [current.source?.real, current.target.program.recorded].includes(job.inputPath);
  }
  function nextRequestedAt() { return queue.length ? queue[0].createdAt : Infinity; }
  function scheduleWake(delay) {
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => {
      wakeTimer = null; expire(); options.wake();
      if (!stopped && queue.length) scheduleWake(queue[0].createdAt + WAIT_MS - Date.now());
    }, Math.max(1, Math.min(delay, WAIT_MS)));
  }
  function expire() {
    for (let index = queue.length - 1; index >= 0; index--) {
      const job = queue[index];
      if (Date.now() - job.createdAt < WAIT_MS) continue;
      queue.splice(index, 1);
      job.stage = null;
      job.status = 'failed'; job.message = '実行待ちの10分期限が切れました。録画が落ち着いてから再実行してください。';
    }
  }
  function request(input) {
    if (input.action === 'thumbnail-auto-status') return autoThumbnailStatus();
    if (input.action === 'thumbnail-auto-pause') {
      thumbnailPaused = true; interruptAutoThumbnail('自動補完を一時停止しました。'); return autoThumbnailStatus();
    }
    if (input.action === 'thumbnail-auto-resume') {
      thumbnailPaused = false; thumbnailError = null; options.wake(); return autoThumbnailStatus();
    }
    if (input.action === 'auto-status') return autoStatus();
    if (input.action === 'auto-pause') { autoPaused = true; return autoStatus(); }
    if (input.action === 'auto-resume') { autoPaused = false; autoError = null; options.wake(); return autoStatus(); }
    let percent;
    try { percent = extractionPercent(input.percent); }
    catch (error) { fail(error.message, 'invalid_request'); }
    const t = files.target(String(input.id || ''));
    if (input.action === 'state') return state(t.id);
    if (!['run', 'verify', 'search', 'apply'].includes(input.action)) fail('操作が不正です。', 'invalid_request');
    if (input.action === 'run' && t.fileMissing) fail('行方不明の録画です。明示的に捜索・復帰してから実行してください。');
    if (stopped) fail('Operator停止中です。');
    expire();
    const previous = jobs.get(t.id);
    if (previous && ['queued', 'running'].includes(previous.status)) return snapshot(t, previous);
    if (queue.length >= 16) fail('個別確認が混雑しています。後ほど再試行してください。');
    const tasks = {};
    for (const name of ['ffprobe', 'thumbnail', 'ts']) tasks[name] = { selected: input.tasks?.[name] === true, redo: input.redo?.[name] === true };
    if (input.action === 'run' && (tasks.ts.selected || tasks.ts.redo) && activeAuto) {
      fail('自動TS解析中です。解析完了後に手動解析を実行してください。');
    }
    if (input.action === 'run') {
      const data = saved(t);
      const known = previous?.target.identity === t.identity && previous.file?.state === 'present';
      const complete = { ffprobe: !!data.duration, thumbnail: thumb().getStatus(t.id).available,
        ts: !!data.analysis?.result?.completed && known && sameFile(data.analysis.file, previous.source?.fingerprint) };
      const names = Object.keys(tasks);
      if (names.every(name => !tasks[name].redo && (!tasks[name].selected || known && complete[name]))) {
        const noop = { id: t.id, target: t, action: 'run', status: 'complete', stage: null,
          createdAt: Date.now(), tasks, stages: {}, file: known ? previous.file : { state: 'unchecked' },
          source: known ? previous.source : null, message: '補完が必要な項目はありません。' };
        jobs.set(t.id, noop);
        return snapshot(t, noop);
      }
    }
    if (input.action === 'apply' && input.confirm !== true) fail('新旧パスを確認し、反映を承認してください。', 'invalid_request');
    if (input.action === 'search' && (!Array.isArray(input.selectedIds) || !input.selectedIds.length)) fail('捜索先を選択してください。', 'invalid_request');
    const job = { id: t.id, target: t, action: input.action, path: input.path, token: input.token,
      selectedIds: Array.isArray(input.selectedIds) ? input.selectedIds.filter(id => typeof id === 'string').slice(0, 64) : [],
      tasks, percent, createdAt: Date.now(), status: 'queued', stage: 'waiting', stages: {},
      file: previous?.target.identity === t.identity ? previous.file : { state: 'unchecked' },
      source: previous?.target.identity === t.identity ? previous.source : null };
    jobs.set(t.id, job);
    queue.push(job);
    interruptAutoThumbnail('手動メンテナンスを優先するため自動補完を中断しました。');
    for (const [id, value] of jobs) if (jobs.size > 128 && !['queued', 'running'].includes(value.status)) jobs.delete(id);
    options.wake();
    scheduleWake(queue[0].createdAt + WAIT_MS - Date.now());
    return snapshot(t, job);
  }
  function check(job) {
    if (stopped || job.cancelled) fail('録画優先のため中断しました。再実行できます。');
    if (Date.now() - job.createdAt > WAIT_MS) fail('個別確認の待機・確認期限が切れました。再実行してください。');
  }
  async function delayUntilReady(job, ts = false) {
    check(job);
    const delay = options.delay(ts);
    if (delay > 0) fail('録画開始・切替が近いため処理を中断しました。再実行してください。');
  }
  async function stage(job, name, fn) {
    job.stage = name;
    job.stages[name] = { state: 'checking' };
    try {
      await delayUntilReady(job, name === 'ts');
      await assertSource(job);
      await delayUntilReady(job, name === 'ts');
      job.stages[name] = { state: 'running' };
      const result = await fn();
      job.stages[name] = { state: 'complete' };
      return result;
    } catch (error) {
      job.stages[name] = { state: job.cancelled ? 'interrupted' : 'failed', message: errorText(error) };
      job.message = errorText(error);
      return null;
    }
  }
  function thumbnailStatus(id, value) {
    if (!thumbnailWait || thumbnailWait.id !== id) return;
    if (value.status === 'complete') thumbnailWait.resolve(value);
    else if (!['queued', 'processing'].includes(value.status)) thumbnailWait.reject(new Error('サムネイル: ' + (value.reason || value.status)));
  }
  async function generateThumbnail(job) {
    if (['queued', 'processing'].includes(thumb().getStatus(job.id).status)) {
      await new Promise((resolve, reject) => {
        thumbnailWait = { id: job.id, resolve, reject };
        thumb().resume();
      }).finally(() => { thumbnailWait = null; });
      if (!job.tasks.thumbnail.redo) return;
      await assertSource(job);
    }
    return new Promise((resolve, reject) => {
      thumbnailWait = { id: job.id, resolve, reject };
      const result = thumb().enqueue({ id: job.id, inputPath: job.source.real,
        percent: job.percent,
        durationSeconds: saved(job.target).duration,
        replace: job.tasks.thumbnail.redo,
        validate: () => assertSource(job)
      });
      if (result.reason === 'existing') resolve(thumb().getStatus(job.id));
      else if (!result.accepted) reject(new Error('サムネイル要求を受け付けられません: ' + result.reason));
    }).finally(() => { thumbnailWait = null; });
  }
  function analyze(job) {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync('/usr/bin/ionice')) return reject(new Error('低I/O優先度で実行するioniceがありません。'));
      const child = childProcess.spawn('/usr/bin/ionice', ['-c', '3', process.execPath,
        path.join(options.root, 'tools/ts-analyzer.js'), '--json', ...(activeAuto === job ? ['--progress'] : []), job.source.real], { stdio: ['ignore', 'pipe', 'pipe'] });
      job.child = child;
      let stdout = '', stderr = '', error = null;
      try { if (child.pid) os.setPriority(child.pid, 19); } catch (cause) { error = cause; child.kill('SIGKILL'); }
      const deadline = setTimeout(() => { job.cancelled = true; job.timedOut = true; job.message = 'TS解析の実行上限60分に達しました。'; child.kill('SIGKILL'); }, 60 * 60 * 1000);
      child.stdout.on('data', data => {
        stdout += data;
        if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) { error = new Error('解析結果が出力上限を超えました。'); child.kill('SIGKILL'); }
      });
      let progressText = '';
      child.stderr.on('data', data => {
        const value = progressText + data.toString();
        const lines = value.split('\n');
        progressText = lines.pop().slice(-512);
        for (const line of lines) {
          if (activeAuto === job && /^TS_PROGRESS [0-9]+$/.test(line)) {
            job.bytesRead = Number(line.slice(12));
          } else {
            stderr = (stderr + line + '\n').slice(-2048);
          }
        }
      });
      child.once('error', cause => { error = cause; });
      child.once('close', code => {
        clearTimeout(deadline); job.child = null;
        if (job.cancelled || stopped) return resolve({ status: 'INCOMPLETE', completed: false, stopReason: job.message || 'Operator停止による中断' });
        try {
          if (error) throw error;
          const result = JSON.parse(stdout.trim());
          if (![0, 1, 2].includes(code) || !['NO_FINDINGS', 'SUSPECT', 'INCOMPLETE'].includes(result.status)) {
            throw new Error(result.error || stderr || 'TS解析に失敗しました。');
          }
          resolve(result);
        } catch (cause) { reject(cause); }
      });
    });
  }
  async function execute(job) {
    check(job);
    job.status = 'running';
    const t = files.assertTarget(job.target);
    job.target = t;
    if (job.action === 'verify') { job.candidate = keepTicket(await diskRequest(job, 'verify', { path: job.path })); return; }
    if (job.action === 'apply') {
      const ticket = tickets.get(job.token);
      if (!ticket || ticket.expiresAt < Date.now() || ticket.identity !== t.identity) fail('候補の確認期限が切れたか、録画履歴が変わりました。再確認してください。');
      await diskRequest(job, 'apply', { ticket });
      tickets.delete(job.token);
      job.target = files.target(job.id);
      if (job.target.program.recorded !== t.program.recorded) thumb().cancel(t.id);
      changed();
    }
    if (job.action === 'search') {
      job.search = await diskRequest(job, 'search', { selectedIds: job.selectedIds });
      job.search.candidates.forEach(keepTicket);
      if (job.search.persisted) { job.target = files.target(job.id); job.file = { state: 'missing' }; changed(); }
      return;
    }
    job.stage = 'file';
    job.file = await diskRequest(job, 'inspect');
    if (job.file.state !== 'present') { job.message = job.file.message; return; }
    job.source = job.file;
    // IPC only exposes the explicit check result, not the filesystem helper internals.
    job.file = { state: 'present', checkedAt: job.file.checkedAt, path: job.source.absolute, size: job.source.size };
    if (job.action !== 'run') return;
    let count = 0;
    for (const name of ['ffprobe', 'thumbnail', 'ts']) {
      const selected = job.tasks[name];
      if (!selected.selected && !selected.redo) continue;
      const before = saved(job.target);
      const exists = name === 'ffprobe' ? before.duration : name === 'thumbnail' ? thumb().getStatus(job.id).available :
        before.analysis?.result?.completed && sameFile(before.analysis.file, job.source.fingerprint);
      if (exists && !selected.redo) { job.stages[name] = { state: 'skipped' }; continue; }
      count++;
      if (name === 'ffprobe') await stage(job, name, async () => {
        const duration = await options.probe(job.source.real);
        if (!Number.isFinite(duration) || duration <= 0) throw new Error('ffprobeから正常な録画時間を取得できませんでした。');
        await assertSource(job);
        job.target = await files.save(job.target, { recordedDurationSeconds: duration }); changed();
      });
      if (name === 'thumbnail') await stage(job, name, async () => { await generateThumbnail(job); changed(); });
      if (name === 'ts') await stage(job, name, async () => {
        let result;
        try { result = await analyze(job); }
        catch (error) { result = { status: 'ERROR', completed: false, error: errorText(error) }; }
        if (result.completed || !stopped) await assertSource(job);
        else files.assertTarget(job.target); // Only an incomplete attempt is saved during shutdown; no more HDD requests.
        const analysis = { checkedAt: Date.now(), registeredPath: job.target.program.recorded, file: job.source.fingerprint, result };
        // A failed reanalysis must not discard the last completed result.
        job.target = (await files.saveAnalysis(job.target, analysis)).target; changed();
        if (!result.completed) throw new Error(result.stopReason || result.error || 'TS解析が未完了です。');
      });
      if (job.cancelled) break;
    }
    if (!count) job.message = '補完が必要な項目はありません。';
  }
  function runNext() {
    expire();
    if (stopped || isBusy() || !queue.length || !options.canStart()) return;
    const job = queue[0];
    const needsTs = job.action === 'run' && (job.tasks.ts.selected || job.tasks.ts.redo);
    const delay = options.delay(needsTs);
    if (delay > 0) { scheduleWake(Math.min(delay, job.createdAt + WAIT_MS - Date.now())); return; }
    queue.shift(); active = job; job.startedAt = Date.now();
    Promise.resolve().then(() => execute(job)).then(() => {
      job.status = Object.values(job.stages).some(stage => ['failed', 'interrupted'].includes(stage.state)) ? 'failed' : 'complete';
    }).catch(error => { job.status = 'failed'; job.message = errorText(error); }).finally(() => {
      if (job.action === 'run' && job.stages.ts) {
        options.onCompleted?.({ id: job.id, title: job.target?.program?.title || job.id,
          mode: 'manual', status: job.stages.ts.state === 'complete' ? 'complete' :
            job.stages.ts.state === 'interrupted' ? 'interrupted' : 'failed',
          startedAt: job.startedAt });
      }
      job.stage = null; active = null; options.wake();
    });
  }
  function stop() {
    stopped = true;
    if (wakeTimer) clearTimeout(wakeTimer);
    for (const job of queue.splice(0)) { job.status = 'failed'; job.message = 'Operator停止のため未実行です。'; }
    if (active) { active.cancelled = true; if (!active.committing) active.child?.kill('SIGKILL'); }
    interruptAuto('Operator停止による中断');
    interruptAutoThumbnail('Operator停止による中断');
  }
  return { request, state, runNext, startAuto, interruptAuto, autoStatus, stop, isBusy,
    nextRequestedAt, currentThumbnail, thumbnailStatus, monitorState,
    startAutoThumbnail, interruptAutoThumbnail, autoThumbnailStatus, thumbnailSummary };
}
module.exports = { createMaintenance };
