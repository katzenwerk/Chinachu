import { invalidateResources, loadResource } from './api-client.js';
import { subscribeRecordedNotifications } from './realtime-client.js';
import { subscribeRecordingData } from './recording-store.js';
import { buildStorageWarnings } from './storage-model.js';
import { subscribeStorageData } from './storage-store.js';
import { subscribeBroadcastClock } from './broadcast-clock-store.js';
import { loadRecordedThumbnailStatus, recordedThumbnailImageUrl } from './recorded-thumbnail-client.js';
import { programDetailUrl } from './program-detail-client.js';

const listeners = new Set();
const pendingCompletions = new Map();
let state = { issues: [], activities: [], pulseToken: 0, toast: null };
let knownIssuePriorities = null;
let previousRecordings = null;
let recordedPrograms = null;
let activitySequence = 0;
let unsubscribeStorage = null;
let unsubscribeRecording = null;
let unsubscribeRecorded = null;
let unsubscribeBroadcastClockState = null;
let recordedRefresh = null;
let storageIssues = [];
let broadcastClockIssues = [];
const completionWaits = new Map();
const THUMBNAIL_STATUS_INTERVAL_MS = 1000;
const THUMBNAIL_STATUS_MAX_CHECKS = 95;
const THUMBNAIL_TERMINAL_FAILURES = new Set(['failed', 'source-missing']);

function emit() {
  listeners.forEach(listener => listener(state));
}

function replaceIssues(issues, { track = true } = {}) {
  const nextPriorities = new Map(issues.map(issue => [issue.id, issue.priority]));
  const worsened = track && knownIssuePriorities !== null && issues.some(issue => {
    const previous = knownIssuePriorities.get(issue.id);
    return previous === undefined || issue.priority > previous;
  });
  if (track) knownIssuePriorities = nextPriorities;
  state = { ...state, issues, pulseToken: worsened ? state.pulseToken + 1 : state.pulseToken };
  emit();
}

function publishIssues(options) {
  replaceIssues(
    [...storageIssues, ...broadcastClockIssues]
      .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name, 'ja')),
    options
  );
}

function handleStorageState(storageState) {
  if (storageState.data === null && storageState.status !== 'error') return;
  const issues = storageState.data === null ? [] : buildStorageWarnings(storageState.data, Date.now());
  if (storageState.status === 'error') {
    issues.push({
      id: 'storage-api',
      name: 'Storage API',
      level: 'error',
      priority: 1,
      message: 'ストレージ情報を更新できません。最後に取得した警告を表示しています。',
      detail: '',
      href: '#storage'
    });
  }
  storageIssues = issues;
  publishIssues({ track: storageState.data !== null });
}

function formatBroadcastObservedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '不明';
  return date.toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
}

function handleBroadcastClockState(clockState) {
  const clock = clockState.data?.broadcastClock;
  const success = clock?.lastSuccess;
  const diffMs = Number(success?.diffMs);
  if (!clock || clock.warningActive !== true || !Number.isFinite(diffMs)) {
    broadcastClockIssues = [];
    publishIssues({ track: clockState.status === 'ready' });
    return;
  }
  const direction = diffMs < 0 ? '遅れています' : '進んでいます';
  const seconds = Math.max(3, Math.round(Math.abs(diffMs) / 1000));
  const failed = clock.status === 'failed';
  broadcastClockIssues = [{
    id: 'broadcast-clock-drift',
    name: 'サーバー時計',
    level: 'warning',
    priority: 2,
    message: '時刻ずれを検出しました',
    detail: `サーバー時計が放送波より約${seconds}秒${direction}。録画開始時刻に影響する可能性があります。` +
      ` 最終成功観測：${formatBroadcastObservedAt(success.observedAt)}${failed ? '（直近の観測は失敗）' : ''}`,
    href: '#log'
  }];
  publishIssues({ track: clockState.status === 'ready' });
}

function programId(program) {
  return typeof program?.id === 'string' && program.id !== '' ? program.id : null;
}

function programTitle(program) {
  return String(program?.fullTitle || program?.title || 'タイトル未取得');
}

function pushActivity(kind, title, href, toastText, details = {}) {
  const activity = { id: `${Date.now()}-${++activitySequence}`, kind, title, href, at: Date.now(), ...details };
  state = {
    ...state,
    activities: [activity, ...state.activities].slice(0, 5),
    toast: { id: activity.id, kind, text: toastText, level: 'activity', href, title, ...details }
  };
  emit();
}

export function pushSystemActivity(kind, title, href = '#home', toastText = title) {
  pushActivity(kind, title, href, toastText);
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForRecordedThumbnail(id, signal) {
  for (let check = 0; check < THUMBNAIL_STATUS_MAX_CHECKS; check += 1) {
    let thumbnail;
    try {
      thumbnail = await loadRecordedThumbnailStatus(id, { signal });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return null;
    }
    if (thumbnail?.status === 'complete' && thumbnail.available === true) {
      return recordedThumbnailImageUrl(id, thumbnail.updatedAt);
    }
    if (THUMBNAIL_TERMINAL_FAILURES.has(thumbnail?.status)) return null;
    await wait(THUMBNAIL_STATUS_INTERVAL_MS, signal);
  }
  return null;
}

function completeRecording(id, program, thumbnailUrl) {
  const title = programTitle(program);
  const channel = typeof program?.channel?.name === 'string' && program.channel.name.trim() !== ''
    ? program.channel.name.trim()
    : '放送局未取得';
  const href = programDetailUrl({ id }) || '#recorded';
  pushActivity('recording-complete', title, href, `録画が正常に終了しました：${title}`, {
    subtitle: channel,
    thumbnailUrl
  });
}

function beginRecordingCompletion(id, program) {
  if (completionWaits.has(id)) return;
  pendingCompletions.delete(id);
  const controller = new AbortController();
  const pending = waitForRecordedThumbnail(id, controller.signal)
    .then(thumbnailUrl => {
      if (!controller.signal.aborted) completeRecording(id, program, thumbnailUrl);
    })
    .catch(error => {
      if (error?.name !== 'AbortError' && !controller.signal.aborted) completeRecording(id, program, null);
    })
    .finally(() => {
      if (completionWaits.get(id)?.pending === pending) completionWaits.delete(id);
    });
  completionWaits.set(id, { controller, pending });
}

function reconcileCompletions() {
  if (recordedPrograms === null) return;
  pendingCompletions.forEach((program, id) => {
    if (recordedPrograms.has(id)) beginRecordingCompletion(id, recordedPrograms.get(id) || program);
  });
}

function handleRecordingState(recordingState) {
  if (recordingState.status !== 'ready') return;
  const current = new Map();
  recordingState.programs.forEach(program => {
    const id = programId(program);
    if (id !== null) current.set(id, program);
  });
  if (previousRecordings === null) {
    previousRecordings = current;
    return;
  }
  current.forEach((program, id) => {
    if (!previousRecordings.has(id)) {
      const title = programTitle(program);
      pushActivity('recording-start', title, '#recording', `録画を開始しました：${title}`);
    }
  });
  previousRecordings.forEach((program, id) => {
    if (current.has(id)) return;
    pendingCompletions.set(id, program);
  });
  previousRecordings = current;
  if (pendingCompletions.size > 0) refreshRecorded();
}

function refreshRecorded() {
  if (recordedRefresh !== null) return recordedRefresh;
  invalidateResources(['recorded']);
  recordedRefresh = loadResource('recorded').then(programs => {
    if (!Array.isArray(programs)) throw new Error('Recorded API response is invalid');
    recordedPrograms = new Map(programs.map(program => [programId(program), program]).filter(([id]) => id !== null));
    reconcileCompletions();
  }).catch(() => {}).finally(() => {
    recordedRefresh = null;
  });
  return recordedRefresh;
}

function start() {
  if (unsubscribeStorage !== null) return;
  unsubscribeStorage = subscribeStorageData(handleStorageState);
  unsubscribeRecording = subscribeRecordingData(handleRecordingState);
  unsubscribeRecorded = subscribeRecordedNotifications(refreshRecorded);
  unsubscribeBroadcastClockState = subscribeBroadcastClock(handleBroadcastClockState);
  refreshRecorded();
}

function stopIfUnused() {
  if (listeners.size !== 0 || unsubscribeStorage === null) return;
  unsubscribeStorage();
  unsubscribeRecording();
  unsubscribeRecorded();
  unsubscribeBroadcastClockState();
  unsubscribeStorage = null;
  unsubscribeRecording = null;
  unsubscribeRecorded = null;
  unsubscribeBroadcastClockState = null;
  completionWaits.forEach(({ controller }) => controller.abort());
  completionWaits.clear();
}

export function subscribeNotificationCenter(listener) {
  listeners.add(listener);
  start();
  listener(state);
  return () => {
    listeners.delete(listener);
    stopIfUnused();
  };
}
