'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');
const { createFiles, sameFile, fail } = require('./recorded-maintenance-files');

// Single-record requests are drained only by Operator's existing post-processing arbiter.
// This module does not start an independent execution queue or execute recording hooks.
function createMaintenance(options) {
  const files = createFiles(options.root, options.config);
  const jobs = new Map();
  const queue = [];
  let active = null;
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
    const rows = [...t.linked.flatMap(row => [row, row.recordingResult, row.program, row.recorded]), t.program].filter(Boolean);
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
        stages: job.stages, tasks: job.tasks, message: job.message || '', search: job.search, candidate: job.candidate } : null };
  }
  function state(id) { const t = files.target(id); return snapshot(t, jobs.get(id)); }
  function isBusy() { return active !== null; }
  function currentThumbnail(job) {
    return active?.id === job.id && active.stage === 'thumbnail' &&
      [active.source?.real, active.target.program.recorded].includes(job.inputPath);
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
    const t = files.target(String(input.id || ''));
    if (input.action === 'state') return state(t.id);
    if (!['run', 'verify', 'search', 'apply'].includes(input.action)) fail('操作が不正です。', 'invalid_request');
    if (input.action === 'run' && t.pathConflict) fail('matchと録画管理台帳の登録パスが一致しないため、処理を実行できません。');
    if (input.action === 'run' && t.fileMissing) fail('行方不明の録画です。明示的に捜索・復帰してから実行してください。');
    if (stopped) fail('Operator停止中です。');
    expire();
    const previous = jobs.get(t.id);
    if (previous && ['queued', 'running'].includes(previous.status)) return snapshot(t, previous);
    if (queue.length >= 16) fail('個別確認が混雑しています。後ほど再試行してください。');
    const tasks = {};
    for (const name of ['ffprobe', 'thumbnail', 'ts']) tasks[name] = { selected: input.tasks?.[name] === true, redo: input.redo?.[name] === true };
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
      tasks, createdAt: Date.now(), status: 'queued', stage: 'waiting', stages: {},
      file: previous?.target.identity === t.identity ? previous.file : { state: 'unchecked' },
      source: previous?.target.identity === t.identity ? previous.source : null };
    jobs.set(t.id, job);
    queue.push(job);
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
        durationSeconds: saved(job.target).duration || Number(job.target.program.operatorActualSeconds) || null,
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
        path.join(options.root, 'tools/ts-analyzer.js'), '--json', job.source.real], { stdio: ['ignore', 'pipe', 'pipe'] });
      job.child = child;
      let stdout = '', stderr = '', error = null;
      try { if (child.pid) os.setPriority(child.pid, 19); } catch (cause) { error = cause; child.kill('SIGKILL'); }
      const deadline = setTimeout(() => { job.cancelled = true; job.message = 'TS解析の実行上限60分に達しました。'; child.kill('SIGKILL'); }, 60 * 60 * 1000);
      const guard = setInterval(() => {
        if (stopped || options.delay(true) > 0) {
          job.cancelled = true; job.message = '録画開始・切替を優先してTS解析を中断しました。';
          child.kill('SIGKILL');
        }
      }, 250);
      child.stdout.on('data', data => {
        stdout += data;
        if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) { error = new Error('解析結果が出力上限を超えました。'); child.kill('SIGKILL'); }
      });
      child.stderr.on('data', data => { stderr = (stderr + data).slice(-2048); });
      child.once('error', cause => { error = cause; });
      child.once('close', code => {
        clearTimeout(deadline); clearInterval(guard); job.child = null;
        if (job.cancelled || stopped) return resolve({ status: 'INCOMPLETE', completed: false, stopReason: job.message || '録画優先による中断' });
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
    if (stopped || active || !queue.length || !options.canStart()) return;
    const job = queue[0];
    const needsTs = job.action === 'run' && (job.tasks.ts.selected || job.tasks.ts.redo);
    const delay = options.delay(needsTs);
    if (delay > 0) { scheduleWake(Math.min(delay, job.createdAt + WAIT_MS - Date.now())); return; }
    queue.shift(); active = job;
    Promise.resolve().then(() => execute(job)).then(() => {
      job.status = Object.values(job.stages).some(stage => ['failed', 'interrupted'].includes(stage.state)) ? 'failed' : 'complete';
    }).catch(error => { job.status = 'failed'; job.message = errorText(error); }).finally(() => {
      job.stage = null; active = null; options.wake();
    });
  }
  function stop() {
    stopped = true;
    if (wakeTimer) clearTimeout(wakeTimer);
    for (const job of queue.splice(0)) { job.status = 'failed'; job.message = 'Operator停止のため未実行です。'; }
    if (active) { active.cancelled = true; if (!active.committing) active.child?.kill('SIGKILL'); }
  }
  return { request, state, runNext, stop, isBusy, nextRequestedAt, currentThumbnail, thumbnailStatus };
}
module.exports = { createMaintenance };
