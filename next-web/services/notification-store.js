import { invalidateResources, loadResource } from './api-client.js';
import { subscribeRecordedNotifications } from './realtime-client.js';
import { subscribeRecordingData } from './recording-store.js';
import { buildStorageWarnings } from './storage-model.js';
import { subscribeStorageData } from './storage-store.js';

const listeners = new Set();
const pendingCompletions = new Map();
let state = { issues: [], activities: [], pulseToken: 0, toast: null };
let knownIssuePriorities = null;
let previousRecordings = null;
let recordedIds = null;
let activitySequence = 0;
let unsubscribeStorage = null;
let unsubscribeRecording = null;
let unsubscribeRecorded = null;
let recordedRefresh = null;

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
  replaceIssues(
    issues.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name, 'ja')),
    { track: storageState.data !== null }
  );
}

function programId(program) {
  return typeof program?.id === 'string' && program.id !== '' ? program.id : null;
}

function programTitle(program) {
  return String(program?.fullTitle || program?.title || 'タイトル未取得');
}

function pushActivity(kind, title, href, toastText) {
  const activity = { id: `${Date.now()}-${++activitySequence}`, kind, title, href, at: Date.now() };
  state = { ...state, activities: [activity, ...state.activities].slice(0, 5), toast: { id: activity.id, kind, text: toastText, level: 'activity' } };
  emit();
}

export function pushSystemActivity(kind, title, href = '#home', toastText = title) {
  pushActivity(kind, title, href, toastText);
}

function completeRecording(id, title) {
  pendingCompletions.delete(id);
  pushActivity('recording-complete', title, '#recorded', `録画が正常に終了しました：${title}`);
}

function reconcileCompletions() {
  if (recordedIds === null) return;
  pendingCompletions.forEach((title, id) => {
    if (recordedIds.has(id)) completeRecording(id, title);
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
    const title = programTitle(program);
    if (recordedIds?.has(id)) completeRecording(id, title);
    else pendingCompletions.set(id, title);
  });
  previousRecordings = current;
}

function refreshRecorded() {
  if (recordedRefresh !== null) return recordedRefresh;
  invalidateResources(['recorded']);
  recordedRefresh = loadResource('recorded').then(programs => {
    if (!Array.isArray(programs)) throw new Error('Recorded API response is invalid');
    recordedIds = new Set(programs.map(programId).filter(Boolean));
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
  refreshRecorded();
}

function stopIfUnused() {
  if (listeners.size !== 0 || unsubscribeStorage === null) return;
  unsubscribeStorage();
  unsubscribeRecording();
  unsubscribeRecorded();
  unsubscribeStorage = null;
  unsubscribeRecording = null;
  unsubscribeRecorded = null;
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
