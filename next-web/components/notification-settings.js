const LABELS = { mail: 'メール', slack: 'Slack', pushover: 'Pushover' };
const EVENTS = { conflict: '予約競合', failure: '録画失敗', abort: '録画中止', storage: 'ストレージ容量不足',
  analysis: 'TS解析異常・DROP疑い', start: '録画開始', complete: '録画完了' };
const FIELDS = {
  slack: [['webhook', 'Incoming Webhook URL', 'password']],
  pushover: [['token', 'Application API Token', 'password'], ['user', 'User Key', 'password']],
  mail: [['host', 'SMTPサーバー', 'text'], ['port', 'ポート', 'number'], ['encryption', '暗号化方式', 'select'],
    ['username', 'SMTPユーザー名', 'text'], ['password', 'SMTPパスワード', 'password'],
    ['from', '送信元メールアドレス', 'email'], ['to', '送信先メールアドレス', 'email']]
};
export function createNotificationSettings({ signal, getSettings, getSaved, onChange }) {
  const panel = document.createElement('section');
  panel.className = 'settings-tab-panel settings-notifications';
  panel.dataset.tab = 'notification';
  panel.innerHTML = '<section class="settings-card panel"><header><h2>外部通知</h2><p>通知設定は下部の「変更を確認して保存」で確定し、保存後すぐに反映されます。</p></header><div class="settings-notification-table" role="group" aria-label="通知経路" data-routes></div></section><section class="settings-card panel"><header><h2>通知イベント</h2></header><div class="settings-notification-events" data-events></div></section><p role="status" data-message></p>';
  const status = panel.querySelector('[data-message]');
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
    const current = getSettings().routes[name];
    const saved = getSaved().routes[name];
    const route = current.configured ? current : saved.configured ? saved : current;
    const dialog = document.createElement('dialog');
    dialog.className = 'settings-save-dialog settings-notification-dialog';
    const form = document.createElement('form');
    const header = document.createElement('header');
    const heading = document.createElement('h2'); heading.textContent = LABELS[name] + 'の設定';
    const hint = document.createElement('p');
    hint.textContent = route.configured ? '秘密情報の空欄は現在の値を保持します。変更は下部の保存操作で確定します。' : '設定画面へ一時反映すると、保存前にテスト送信できます。';
    const fields = document.createElement('div'); fields.className = 'settings-card-body';
    const inputs = {};
    for (const [key, label, type] of FIELDS[name]) {
      const wrap = document.createElement('label'); wrap.className = 'settings-field';
      const title = document.createElement('span'); title.className = 'settings-field-title'; title.textContent = label;
      const input = document.createElement(type === 'select' ? 'select' : 'input');
      if (type === 'select') {
        for (const [value, text] of [['starttls', 'STARTTLS'], ['tls', 'SSL/TLS']]) {
          const option = document.createElement('option'); option.value = value; option.textContent = text; input.append(option);
        }
      } else { input.type = type; input.autocomplete = 'off'; }
      input.className = 'settings-input';
      input.value = route[key] ?? (key === 'port' ? '587' : key === 'encryption' ? 'starttls' : '');
      input.required = !(type === 'password' && route.configured);
      if (key === 'port') { input.min = '1'; input.max = '65535'; input.step = '1'; }
      inputs[key] = input;
      wrap.append(title, input); fields.append(wrap);
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
      onChange(); redraw(); dialog.close();
    }));
    footer.append(cancel, save); form.append(header, hint, fields, error, footer); dialog.append(form);
    form.addEventListener('submit', event => {
      event.preventDefault(); save.disabled = true;
      try {
        const values = Object.fromEntries(Object.entries(inputs).filter(([key, input]) =>
          !['webhook', 'token', 'user', 'password'].includes(key) || input.value !== '').map(([key, input]) => [key, input.value]));
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
    const body = panel.querySelector('[data-routes]'); body.replaceChildren();
    const header = document.createElement('div'); header.className = 'settings-notification-heading';
    for (const text of ['種別', ...Object.values(LABELS)]) {
      const cell = document.createElement('strong'); cell.textContent = text; header.append(cell);
    }
    body.append(header);
    const labels = document.createElement('div'); labels.className = 'settings-notification-row-labels';
    for (const label of ['有効', '設定', 'テスト送信']) { const cell = document.createElement('strong'); cell.textContent = label; labels.append(cell); }
    body.append(labels);
    for (const [name, label] of Object.entries(LABELS)) {
      const column = document.createElement('div'); column.className = 'settings-notification-column'; column.setAttribute('role', 'group');
      column.setAttribute('aria-label', label);
      const title = document.createElement('h3'); title.className = 'settings-notification-mobile-title'; title.textContent = label;
      column.append(title);
      const controls = document.createElement('div'); controls.className = 'settings-notification-controls';
      function cell(rowLabel, control) {
        const cell = document.createElement('div'); cell.className = 'settings-notification-cell'; cell.dataset.label = rowLabel;
        cell.append(control); controls.append(cell);
      }
      function redraw() {
        controls.replaceChildren();
        const route = getSettings().routes[name];
        if (!route.configured) {
          const none = document.createElement('span'); none.textContent = '設定なし'; cell('有効', none);
        } else {
          const wrap = document.createElement('label'); wrap.className = 'settings-switch';
          const input = document.createElement('input'); input.type = 'checkbox'; input.checked = route.enabled;
          input.setAttribute('aria-label', label + 'の通知');
          const track = document.createElement('span'); track.className = 'settings-switch-track'; track.setAttribute('aria-hidden', 'true');
          const state = document.createElement('span'); state.className = 'settings-switch-state'; state.textContent = input.checked ? 'ON' : 'OFF';
          input.addEventListener('change', () => {
            getSettings().routes[name].enabled = input.checked;
            state.textContent = input.checked ? 'ON' : 'OFF'; onChange();
          });
          wrap.append(input, track, state); cell('有効', wrap);
        }
        cell('設定', button('設定', () => edit(name, redraw)));
        const test = button('テスト送信', async () => {
          status.textContent = label + 'へテスト送信しています…（設定は保存しません）';
          const route = getSettings().routes[name];
          const values = Object.fromEntries(FIELDS[name].filter(([key]) => route[key] !== undefined).map(([key]) => [key, route[key]]));
          const response = await fetch('/api/notification.json', { method: 'POST', cache: 'no-store', signal,
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ route: name, values }) });
          if (response.status === 503) throw new Error('テスト送信APIの更新が必要です。WUIの再起動後にやり直してください。');
          if (!response.ok) throw new Error(`テスト送信APIがHTTP ${response.status}を返しました。`);
          const result = await response.json();
          status.textContent = result.ok ? label + 'へテスト送信しました（設定は保存していません）。' : label + 'の送信に失敗しました。入力した接続情報を確認してください。';
        });
        test.disabled = !route.configured;
        test.title = '画面上の接続情報でテストします。設定は保存しません'; cell('テスト送信', test);
      }
      redraw(); column.append(controls); body.append(column);
    }
  }
  function events() {
    const body = panel.querySelector('[data-events]'); body.replaceChildren();
    for (const [key, label] of Object.entries(EVENTS)) {
      const wrap = document.createElement('label'); wrap.className = 'settings-notification-event';
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = getSettings().events[key];
      input.addEventListener('change', () => {
        getSettings().events[key] = input.checked; onChange();
      });
      wrap.append(input, document.createTextNode(label)); body.append(wrap);
    }
  }
  panel.refresh = () => { routes(); events(); };
  panel.refresh();
  return panel;
}
