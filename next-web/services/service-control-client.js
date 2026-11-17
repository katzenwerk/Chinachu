import { serviceGeneration } from './service-restart-model.js';
import { completePendingRestart, getPendingRestart, setPendingRestart } from './service-restart-store.js';
import { getWuiConnectionState } from './wui-connection-monitor.js';

const SERVICE_CONTROL_PATH = '/api/service-control.json';

async function parseResponse(response) {
  let result = null;
  try { result = await response.json(); } catch (_) {}
  if (!response.ok) throw new Error(result?.message || `サービス制御APIがHTTP ${response.status}を返しました`);
  return result;
}

export async function loadServiceControl(signal) {
  const response = await fetch(SERVICE_CONTROL_PATH, {
    method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store', signal
  });
  const result = await parseResponse(response);
  if (!result || result.schemaVersion !== 1 || !result.targets) throw new Error('サービス制御APIの応答が不正です');
  return result;
}

export async function requestServiceRestart(target) {
  if (target !== 'operator' && target !== 'wui') throw new Error('再起動対象が不正です');
  const response = await fetch(`/api/service-control/${target}.json`, {
    method: 'POST', headers: { Accept: 'application/json' }, cache: 'no-store'
  });
  const result = await parseResponse(response);
  if (!result?.accepted || !result.operation) throw new Error('再起動要求を受け付けられません');
  return result.operation;
}

// Shared by the log and settings screens; app.js owns recovery monitoring.
export async function beginServiceRestart(target, report) {
  if (getPendingRestart() || !['operator', 'wui'].includes(target)) return;
  const current = report?.targets?.[target];
  if (current?.restartable !== true) return;
  const requestedAt = Date.now();
  const pending = {
    target, id: null, state: 'requesting', message: '再起動要求を送信しています…',
    before: serviceGeneration(current), beforeInstanceId: getWuiConnectionState().instanceId,
    requestedAt, deadline: requestedAt + 120000
  };
  setPendingRestart(pending);
  try {
    const operation = await requestServiceRestart(target);
    if (getPendingRestart()?.requestedAt !== requestedAt || getPendingRestart()?.target !== target) return;
    setPendingRestart({ ...pending, id: operation.id || null, state: 'reconnecting',
      message: '接続回復を確認しています…', before: operation.before || pending.before });
  } catch (error) {
    if (getPendingRestart()?.requestedAt !== requestedAt || getPendingRestart()?.target !== target) return;
    if (target === 'wui' && error?.name === 'TypeError') {
      setPendingRestart({ ...pending, state: 'reconnecting', message: '接続回復を確認しています…' });
      return;
    }
    const message = error.message || '再起動要求を受け付けられません';
    completePendingRestart(false, message, { notify: !/PM2|管理先|操作できません/.test(message) });
  }
}
