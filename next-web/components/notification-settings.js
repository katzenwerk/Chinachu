const LABELS = { mail: 'メール', slack: 'Slack', pushover: 'Pushover', command: 'コマンド' };
const EVENTS = { conflict: '予約競合', failure: '録画失敗', abort: '録画中止', storageWarning: 'ストレージ容量低下', storage: 'ストレージ容量不足',
  analysis: 'TS解析異常・DROP疑い', start: '録画開始', complete: '録画完了' };
const FIELDS = {
  command: [['command', '実行コマンド（実行ファイルまたはJSON配列）', 'command']],
  slack: [['webhook', 'Incoming Webhook URL', 'password']],
  pushover: [['token', 'Application API Token', 'password'], ['user', 'User Key', 'password']],
  mail: [['host', 'SMTPサーバー', 'text'], ['port', 'ポート', 'number'], ['encryption', '暗号化方式', 'select'],
    ['username', 'SMTPユーザー名', 'text'], ['password', 'SMTPパスワード', 'password'],
    ['from', '送信元メールアドレス', 'email'], ['to', '送信先メールアドレス', 'email']]
};
export function createNotificationSettings({ signal, getSettings, getSaved, getLegacyCommand = () => null, onChange }) {
  const panel = document.createElement('section');
  panel.className = 'settings-tab-panel settings-notifications';
  panel.dataset.tab = 'notification';
  panel.innerHTML = '<section class="settings-card panel"><header><h2>外部通知</h2><p>通知設定は下部の「変更を確認して保存」で確定し、保存後すぐに反映されます。</p></header><div class="settings-notification-routes" role="group" aria-label="通知経路" data-routes></div></section><section class="settings-card panel"><header><h2>通知イベント</h2></header><div class="settings-notification-events" data-events></div></section><p role="status" data-message></p>';
  const status = panel.querySelector('[data-message]');
  const legacy = document.createElement('p');
  legacy.className = 'settings-muted settings-notification-legacy';
  panel.querySelector('.settings-card').append(legacy);
  function report(error) { if (error.name !== 'AbortError') status.textContent = error.message; }
  function button(text, action) {
    const node = document.createElement('button');
    node.type = 'button'; node.className = 'button'; node.textContent = text;
    node.addEventListener('click', async () => {
      node.disabled = true;
      try { await action(); } catch (error) { report(error); }
      finally { node.disabled = false; }
    });
    return node;
  }
  function edit(name, redraw) {
    const current = getSettings().routes[name] || { configured: false, enabled: false };
    const saved = getSaved().routes[name] || { configured: false, enabled: false };
    const route = current.configured ? current : saved.configured ? saved : current;
    const dialog = document.createElement('dialog');
    dialog.className = 'settings-save-dialog settings-notification-dialog';
    const form = document.createElement('form');
    const header = document.createElement('header');
    const heading = document.createElement('h2'); heading.textContent = LABELS[name] + 'の設定';
    const hint = document.createElement('p');
    hint.textContent = name === 'command' ? '実行ファイルのパス、または実行ファイルと引数のJSON配列を指定します。シェルを介さず、通知内容のJSONを標準入力へ渡します。変更は下部の保存操作で確定します。' : route.configured ? '秘密情報の空欄は現在の値を保持します。変更は下部の保存操作で確定します。' : '設定画面へ一時反映すると、保存前にテスト送信できます。';
    const fields = document.createElement('div'); fields.className = 'settings-card-body';
    const inputs = {};
    let fieldRow;
    let fieldCount = 0;
    for (const [key, label, type] of FIELDS[name]) {
      if (fieldCount++ % 2 === 0) {
        fieldRow = document.createElement('div'); fieldRow.className = 'settings-field-row'; fields.append(fieldRow);
      }
      const wrap = document.createElement('label'); wrap.className = 'settings-field';
      if (FIELDS[name].length === 1) wrap.classList.add('is-wide');
      const title = document.createElement('span'); title.className = 'settings-field-title'; title.textContent = label;
      const input = document.createElement(type === 'select' ? 'select' : 'input');
      if (type === 'select') {
        for (const [value, text] of [['starttls', 'STARTTLS'], ['tls', 'SSL/TLS']]) {
          const option = document.createElement('option'); option.value = value; option.textContent = text; input.append(option);
        }
      } else { input.type = type === 'command' ? 'text' : type; input.autocomplete = 'off'; }
      input.className = 'settings-input';
      const initial = name === 'command' ? route[key] ?? getLegacyCommand() : route[key];
      input.value = (Array.isArray(initial) ? JSON.stringify(initial) : initial) ?? (key === 'port' ? '587' : key === 'encryption' ? 'starttls' : '');
      input.required = !(type === 'password' && route.configured);
      if (key === 'port') { input.min = '1'; input.max = '65535'; input.step = '1'; }
      inputs[key] = input;
      wrap.append(title, input); fieldRow.append(wrap);
    }
    if (inputs.port) inputs.port.addEventListener('change', () => {
      if (inputs.port.value === '465') inputs.encryption.value = 'tls';
      if (inputs.port.value === '587') inputs.encryption.value = 'starttls';
    });
    const error = document.createElement('p'); error.setAttribute('role', 'status');
    const footer = document.createElement('footer');
    const cancel = button('キャンセル', () => dialog.close());
    const save = document.createElement('button'); save.type = 'submit'; save.className = 'button primary'; save.textContent = '設定画面に反映';
    header.append(heading);
    if (current.configured) footer.append(button('設定削除', () => {
      getSettings().routes[name] = { configured: false, enabled: false };
      if (name === 'command') getSettings().commandManaged = true;
      onChange(); redraw(); dialog.close();
    }));
    footer.append(cancel, save); form.append(header, hint, fields, error, footer); dialog.append(form);
    form.addEventListener('submit', event => {
      event.preventDefault(); save.disabled = true;
      try {
        const values = Object.fromEntries(Object.entries(inputs).filter(([key, input]) =>
          !['webhook', 'token', 'user', 'password'].includes(key) || input.value !== '').map(([key, input]) => [key, input.value]));
        if (name === 'command') {
          const value = String(values.command || '').trim();
          values.command = value.startsWith('[') ? JSON.parse(value) : value;
          if (!(typeof values.command === 'string' && values.command || Array.isArray(values.command) && values.command.length &&
              values.command.every(item => typeof item === 'string') && values.command[0])) throw new Error('実行ファイルのパス、または実行ファイルと引数のJSON配列を指定してください。');
          getSettings().commandManaged = true;
        }
        getSettings().routes[name] = { ...route, configured: true, enabled: current.configured ? current.enabled : false, ...values };
        onChange();
        redraw(); dialog.close();
      } catch (failure) { if (failure.name !== 'AbortError') error.textContent = failure.message; }
      finally { save.disabled = false; }
    });
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    signal.addEventListener('abort', () => { dialog.close(); dialog.remove(); }, { once: true });
    document.body.append(dialog); dialog.showModal();
  }
  function routes() {
    legacy.hidden = !getLegacyCommand() && !getSettings().commandManaged;
    legacy.textContent = (getSaved().commandManaged ? '旧コマンド通知は停止済みです。' : '旧設定がある場合、現在は容量警告・容量不足のみで実行されます。') +
      ' 旧notificationCommandの値は保持します。コマンド通知を一度保存すると旧方式を停止し、新方式をOFF・削除しても旧方式は再開しません。実行はシェルを介さず、JSONを標準入力へ渡します。';
    const body = panel.querySelector('[data-routes]'); body.replaceChildren();
    for (const [name, label] of Object.entries(LABELS)) {
      const controls = document.createElement('section');
      controls.className = 'settings-notification-route';
      controls.setAttribute('role', 'group');
      controls.setAttribute('aria-label', label);
      function redraw() {
        controls.replaceChildren();
        const route = getSettings().routes[name] || { configured: false, enabled: false };
        const title = document.createElement('h3');
        title.className = 'settings-notification-route-title';
        title.textContent = label;
        if (!route.configured) {
          const state = document.createElement('span');
          state.textContent = '（設定なし）';
          title.append(state);
        }
        const wrap = document.createElement('label'); wrap.className = 'settings-switch';
        const input = document.createElement('input'); input.type = 'checkbox';
        input.disabled = !route.configured;
        input.checked = route.configured && route.enabled === true;
        input.setAttribute('aria-label', label + 'の通知');
        const track = document.createElement('span'); track.className = 'settings-switch-track'; track.setAttribute('aria-hidden', 'true');
        const state = document.createElement('span'); state.className = 'settings-switch-state'; state.textContent = input.checked ? 'ON' : 'OFF';
        input.addEventListener('change', () => {
          getSettings().routes[name].enabled = input.checked;
          state.textContent = input.checked ? 'ON' : 'OFF'; onChange();
        });
        wrap.append(input, track, state);
        controls.append(title, wrap, button('設定', () => edit(name, redraw)));
        const test = button('テスト送信', async () => {
          status.textContent = label + 'へテスト送信しています…（設定は保存しません）';
          const route = getSettings().routes[name] || { configured: false, enabled: false };
          const values = Object.fromEntries(FIELDS[name].filter(([key]) => route[key] !== undefined).map(([key]) => [key, route[key]]));
          const response = await fetch('/api/notification.json', { method: 'POST', cache: 'no-store', signal,
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ route: name, values }) });
          if (response.status === 503) throw new Error('テスト送信APIの更新が必要です。WUIの再起動後にやり直してください。');
          if (!response.ok) throw new Error(`テスト送信APIがHTTP ${response.status}を返しました。`);
          const result = await response.json();
          status.textContent = result.ok ? label + 'へテスト送信しました（設定は保存していません）。' : label + 'の送信に失敗しました。入力した接続情報を確認してください。';
        });
        test.disabled = !route.configured;
        test.title = '画面上の接続情報でテストします。設定は保存しません'; controls.append(test);
      }
      redraw(); body.append(controls);
    }
  }
  function events() {
    const body = panel.querySelector('[data-events]'); body.replaceChildren();
    let row;
    let count = 0;
    for (const [key, label] of Object.entries(EVENTS)) {
      if (count++ % 2 === 0) {
        row = document.createElement('div'); row.className = 'settings-field-row'; body.append(row);
      }
      const wrap = document.createElement('label'); wrap.className = 'settings-notification-event';
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = getSettings().events[key];
      input.addEventListener('change', () => {
        getSettings().events[key] = input.checked; onChange();
      });
      wrap.append(input, document.createTextNode(label)); row.append(wrap);
    }
  }
  panel.refresh = () => { routes(); events(); };
  panel.refresh();
  return panel;
}
