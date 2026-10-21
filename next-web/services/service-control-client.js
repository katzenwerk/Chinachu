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
