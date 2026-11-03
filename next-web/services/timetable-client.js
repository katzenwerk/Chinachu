import { invalidateResources, loadResources } from './api-client.js';
import { hasReservationCapacityConflict } from './reservation-capacity-model.js';
import { programRecordingAction, reservationActionLabel } from './program-detail-model.js';
import { confirmReservationWarning } from '../components/reservation-confirm-dialog.js';
import { TIMETABLE_DEFAULTS } from './timetable-model.js';

async function json(response, label) {
  if (!response.ok) throw new Error(`${label}に失敗しました (HTTP ${response.status})`);
  return response.json();
}

export async function loadTimetableData(options = {}) {
  const resources = await loadResources(['schedule', 'reserves', 'recording', 'rules'], options);
  return {
    schedule: Array.isArray(resources.schedule) ? resources.schedule : [],
    reserves: Array.isArray(resources.reserves) ? resources.reserves : [],
    recording: Array.isArray(resources.recording) ? resources.recording : [],
    rules: Array.isArray(resources.rules) ? resources.rules : []
  };
}

export function refreshTimetableData(names) {
  invalidateResources(names);
  return loadTimetableData();
}

export function loadWuiConfig() {
  return fetch('/api/wui-config.json', { headers: { Accept: 'application/json' }, cache: 'no-store' })
    .then(response => response.status === 404
      ? { version: 1, timetable: { ...TIMETABLE_DEFAULTS } }
      : json(response, 'WUI設定の取得'))
    .catch(error => ({
      version: 1,
      timetable: { ...TIMETABLE_DEFAULTS },
      loadWarning: error.message
    }));
}

export function saveTimetableConfig(timetable) {
  return fetch('/api/wui-config.json', {
    method: 'PUT', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ timetable })
  }).then(response => json(response, 'WUI設定の保存'));
}

async function mutate(url, method, label, body = null) {
  const response = await fetch(url, {
    method, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  await json(response, label);
  invalidateResources(['reserves', 'rules']);
}

const pendingReservations = new Set();

export async function reserveProgram(id, { confirmReservation = false } = {}) {
  if (pendingReservations.has(id)) return false;
  pendingReservations.add(id);
  try {
    let program = null;
    let conflict = null;
    try {
      // ブラウザー内のresourceキャッシュ・取得中リクエストを再利用しない。
      const [currentProgram, reserves, tuners] = await Promise.all([
        [`/api/program/${encodeURIComponent(id)}.json`, '番組情報の取得'],
        ['/api/reserves.json', '予約情報の取得'],
        ['/api/tuners.json', 'チューナー情報の取得']
      ].map(([url, label]) => fetch(url, {
        headers: { Accept: 'application/json' }, cache: 'no-store'
      }).then(response => json(response, label))));
      program = currentProgram;
      conflict = hasReservationCapacityConflict(program, reserves, tuners);
    } catch (_) {
      // 取得・判定の失敗を「競合なし」に置き換えない。
    }
    const programTitle = program?.fullTitle || program?.title || 'この番組';
    if (conflict !== false) {
      const accepted = await confirmReservationWarning({
        title: conflict === true ? 'チューナー競合の可能性があります' : '競合を確認できませんでした',
        programTitle,
        message: conflict === true
          ? '同時間帯の予約数が、対応チューナーの収容数を超える見込みです。共用チューナーの割当状況によっては、録画できない場合があります。'
          : '競合の可能性を判断できませんでした。このまま予約しますか？'
      });
      if (!accepted) return false;
    } else if (confirmReservation && !window.confirm(`${programTitle}\n\n「${reservationActionLabel(programRecordingAction(program))}」を実行しますか？`)) {
      return false;
    }
    await mutate(`/api/program/${encodeURIComponent(id)}.json`, 'PUT', '録画予約');
    return true;
  } finally {
    pendingReservations.delete(id);
  }
}
export const unreserveProgram = id => mutate(`/api/reserves/${encodeURIComponent(id)}.json`, 'DELETE', '予約取消');
export const setReserveSkip = (id, skip) => mutate(`/api/reserves/${encodeURIComponent(id)}/${skip ? 'skip' : 'unskip'}.json`, 'PUT', skip ? 'スキップ' : 'スキップ取消');
export const createRule = rule => mutate('/api/rules.json', 'POST', 'ルール作成', rule);
