const CONFIG_PATH = '/api/config.json';

async function parseJsonResponse(response) {
  let value = null;
  try { value = await response.json(); } catch (_) {}
  if (!response.ok) throw new Error(`設定APIがHTTP ${response.status}を返しました`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('設定APIの応答形式が不正です');
  return value;
}

export async function loadConfig(signal) {
  const response = await fetch(CONFIG_PATH, { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store', signal });
  return parseJsonResponse(response);
}

export async function loadClockRuntime(signal) {
  const response = await fetch('/api/clock.json', { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store', signal });
  const value = await parseJsonResponse(response);
  return value.runtime && typeof value.runtime === 'object' ? value.runtime : {};
}

export async function saveConfig(config, signal) {
  const json = JSON.stringify(config, null, '\t');
  const body = new URLSearchParams({ json });
  const response = await fetch(CONFIG_PATH, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body,
    signal
  });
  return parseJsonResponse(response);
}

export async function loadRuntimeMode(signal) {
  try {
    const response = await fetch('/api/service-control.json', { headers: { Accept: 'application/json' }, cache: 'no-store', signal });
    const report = await response.json();
    const targets = report?.targets;
    if (response.ok && targets?.wui?.manager === 'pm2-user' && targets?.operator?.manager === 'pm2-user') {
      return {
        mode: 'user',
        label: 'Chinachuの実行ユーザー',
        detail: 'WUIとOperatorは同じLinuxユーザーのPM2で実行されています。現在の起動方法では、uid/gidによる権限の切り替えは行われません。'
      };
    }
    return { mode: 'unknown', label: 'Chinachuの実行ユーザーを確認できません', detail: 'WUIとOperatorの起動方法を確認できないため、uid/gidの編集を無効にしています。' };
  } catch (_) {
    return { mode: 'unknown', label: 'Chinachuの実行ユーザーを確認できません', detail: 'サービス管理情報を取得できないため、uid/gidの編集を無効にしています。' };
  }
}

export function mirakurunBrowserBase(path, locationObject = window.location) {
  const value = String(path || '');
  if (/^http\+unix:\/\//.test(value) || /^http:\/\/(?:127\.0\.0\.1|localhost)(?::40772)?\//.test(value)) {
    return `${locationObject.protocol}//${locationObject.hostname}:40772`;
  }
  return value.replace(/\/$/, '');
}

export async function loadMirakurunServices(path, signal) {
  const base = mirakurunBrowserBase(path);
  if (!base || /^http\+unix:/.test(base)) throw new Error('ブラウザから利用できるMirakurun接続先を特定できません');
  const response = await fetch(`${base}/api/services`, { headers: { Accept: 'application/json' }, cache: 'no-store', signal });
  if (!response.ok) throw new Error(`Mirakurun servicesがHTTP ${response.status}を返しました`);
  const services = await response.json();
  if (!Array.isArray(services)) throw new Error('Mirakurun servicesの応答形式が不正です');
  return services;
}
