const STATUS_PATH = '/api/auth/status.json';
let csrfToken = null;
let authEnabled = false;
let fetchInstalled = false;

async function parseResponse(response) {
  let value = null;
  try { value = await response.json(); } catch (_) {}
  if (!response.ok) throw new Error(value?.error || `認証APIがHTTP ${response.status}を返しました`);
  return value || {};
}

async function authRequest(path, options = {}) {
  const response = await window.fetch(path, {
    ...options,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(options.headers || {}) },
    cache: 'no-store'
  });
  return parseResponse(response);
}

function applyAuthState(result) {
  if (typeof result?.enabled === 'boolean') authEnabled = result.enabled;
  if (Object.prototype.hasOwnProperty.call(result || {}, 'csrfToken')) {
    csrfToken = typeof result.csrfToken === 'string' ? result.csrfToken : null;
  }
  window.dispatchEvent(new CustomEvent('chinachu-auth-state', {
    detail: { enabled: authEnabled, authenticated: result?.authenticated === true }
  }));
  return result;
}

function installFetchProtection() {
  if (fetchInstalled) return;
  fetchInstalled = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : null;
    const target = new URL(request ? request.url : String(input), window.location.href);
    const method = String(init.method || request?.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers || request?.headers || {});
    if (target.origin === window.location.origin && csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      headers.set('X-Chinachu-CSRF', csrfToken);
    }
    const response = await nativeFetch(input, { ...init, headers });
    if (authEnabled && target.origin === window.location.origin && response.status === 401 && !target.pathname.startsWith('/api/auth/')) {
      window.location.reload();
    }
    return response;
  };
}

function renderLogin(root, status) {
  root.innerHTML = `<main class="auth-page">
    <section class="auth-panel panel" aria-labelledby="auth-title">
      <div class="auth-brand">Chinachu <span aria-hidden="true">Þ</span></div>
      <h1 id="auth-title">管理者ログイン</h1>
      <p class="auth-description">ユーザー名 <strong>admin</strong> と管理者パスワードを入力してください。</p>
      <form class="auth-form" novalidate>
        <label>ユーザー名<input name="username" value="admin" autocomplete="username" readonly></label>
        <label>パスワード<input name="password" type="password" autocomplete="current-password" required autofocus></label>
        <label class="auth-totp" hidden><span>2段階認証（2FA）コード</span><input name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="6桁のコード"><small>Google Authenticatorなどの認証アプリに表示される6桁の数字を入力してください。</small></label>
        <p class="auth-status" role="status"></p>
        <p class="auth-message" role="alert" hidden></p>
        <button class="button primary" type="submit">ログイン</button>
      </form>
      <p class="auth-network-note">この機能は追加的な保護です。WUIをインターネットへ直接公開せず、LANまたはVPN経由で利用してください。</p>
    </section>
  </main>`;
  const form = root.querySelector('.auth-form');
  const message = root.querySelector('.auth-message');
  const statusMessage = root.querySelector('.auth-status');
  const button = form.querySelector('button');
  const password = form.elements.password;
  const totpWrap = form.querySelector('.auth-totp');
  const totp = form.elements.totp;
  let challengeId = null;
  const clearError = () => {
    message.textContent = '';
    message.hidden = true;
  };
  const showError = text => {
    message.textContent = text;
    message.hidden = false;
  };
  password.addEventListener('input', clearError);
  totp.addEventListener('input', clearError);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    clearError();
    if (!challengeId && !password.value) {
      showError('管理者パスワードを入力してください。');
      password.focus();
      return;
    }
    if (challengeId && !totp.value.trim()) {
      showError('6桁の認証コードを入力してください。');
      totp.focus();
      return;
    }
    if (challengeId && !/^\d{6}$/.test(totp.value.trim())) {
      showError('認証コードを確認してください。');
      totp.focus();
      return;
    }
    button.disabled = true;
    statusMessage.textContent = challengeId ? '認証コードを確認しています…' : 'パスワードを確認しています…';
    try {
      const result = challengeId
        ? await authRequest('/api/auth/totp.json', { method: 'POST', body: JSON.stringify({ challengeId, code: totp.value }) })
        : await authRequest('/api/auth/login.json', { method: 'POST', body: JSON.stringify({ username: 'admin', password: password.value }) });
      if (result.totpRequired) {
        challengeId = result.challengeId;
        password.disabled = true;
        totpWrap.hidden = false;
        totp.required = true;
        totp.focus();
        statusMessage.textContent = '';
        button.disabled = false;
        return;
      }
      window.location.reload();
    } catch (error) {
      statusMessage.textContent = '';
      showError(error.message);
      button.disabled = false;
      if (challengeId) { totp.value = ''; totp.focus(); } else { password.select(); }
    }
  });
}

export async function initializeAuthentication(root) {
  installFetchProtection();
  let status;
  try {
    status = await authRequest(STATUS_PATH, { method: 'GET' });
  } catch (error) {
    root.innerHTML = `<main class="auth-page"><section class="auth-panel panel"><h1>認証状態を確認できません</h1><p class="auth-message"></p><button class="button" type="button">再読み込み</button></section></main>`;
    root.querySelector('.auth-message').textContent = error.message;
    root.querySelector('button').addEventListener('click', () => window.location.reload());
    return new Promise(() => {});
  }
  authEnabled = status.enabled === true;
  csrfToken = typeof status.csrfToken === 'string' ? status.csrfToken : null;
  if (status.locked) {
    root.innerHTML = '<main class="auth-page"><section class="auth-panel panel"><h1>ログイン認証はロックされています</h1><p>認証情報が欠落または破損しています。Linux実機で <code>./chinachu auth setup</code> を実行して復旧してください。</p></section></main>';
    return new Promise(() => {});
  }
  if (status.enabled && !status.authenticated) {
    renderLogin(root, status);
    return new Promise(() => {});
  }
  return status;
}

export async function logout() {
  await authRequest('/api/auth/logout.json', { method: 'POST', body: '{}' });
  window.location.reload();
}

export async function loadAuthSettings(signal) {
  return authRequest('/api/auth/settings.json', { method: 'GET', signal });
}

export async function updateAuthEnabled(enabled, password, totp, signal) {
  return applyAuthState(await authRequest('/api/auth/enabled.json', { method: 'POST', signal, body: JSON.stringify({ enabled, password, totp }) }));
}

export async function changeAdminPassword(password, newPassword, totp, signal) {
  return authRequest('/api/auth/password.json', { method: 'POST', signal, body: JSON.stringify({ password, newPassword, totp }) });
}

export async function beginTotpSetup(password, totp, signal) {
  return authRequest('/api/auth/totp/setup.json', { method: 'POST', signal, body: JSON.stringify({ password, totp }) });
}

export async function confirmTotpSetup(setupId, code, signal) {
  return applyAuthState(await authRequest('/api/auth/totp/confirm.json', { method: 'POST', signal, body: JSON.stringify({ setupId, code }) }));
}

export async function disableTotp(password, totp, signal) {
  return authRequest('/api/auth/totp/disable.json', { method: 'POST', signal, body: JSON.stringify({ password, totp }) });
}
