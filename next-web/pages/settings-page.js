import { loadConfig, loadMirakurunServices, loadRuntimeMode, saveConfig } from '../services/config-client.js';
import {
  beginTotpSetup,
  changeAdminPassword,
  confirmTotpSetup,
  disableTotp,
  loadAuthSettings,
  updateAuthEnabled
} from '../services/auth-client.js';
import {
  DROP_DETECTION_MODES,
  cloneConfig,
  configForSave,
  configChanges,
  formatChangeValue,
  normalizeRecordedDirs,
  parseFieldValue,
  setConfigValue,
  unknownConfigKeys,
  updateRecordedStorageRootProtection,
  validateConfig
} from '../services/config-model.js';
import QrCreator from '../vendor/qr-creator.es6.min.js';

const TABS = [
  ['basic', '基本設定'], ['recording', '録画設定'], ['storage', 'Storage'],
  ['history', '履歴管理'], ['services', 'サービス'], ['series', 'シリーズ'], ['auth', 'ログイン認証'], ['advanced', '詳細設定']
];

const FIELD = {
  mirakurunPath: { label: 'Mirakurun接続先', type: 'text', required: true },
  vaapiDevice: { label: 'VA-APIデバイス', type: 'text', empty: 'string' },
  recordedDir: { label: 'デフォルト録画先', type: 'text', required: true },
  recordedFormat: { label: '録画ファイル名フォーマット', type: 'text', required: true },
  recordedNameEnclosingCharacterMap: { label: '囲み文字の置換ルール', type: 'json', jsonType: 'object' },
  recordedCommand: { label: '録画後コマンド', type: 'text', empty: 'string' },
  ffprobeCommand: { label: 'ffprobeコマンド', type: 'text', empty: 'string' },
  recordedDurationProbeTimeoutMs: { label: 'ffprobeタイムアウト', type: 'number', min: 1 },
  normalizationForm: { label: '予約ルールの文字正規化', type: 'text' },
  recordingPriority: { label: '通常録画の優先度', type: 'number', integer: true },
  conflictedPriority: { label: '競合録画の優先度', type: 'number', integer: true },
  handoffPrepSeconds: { label: 'チューナー引継ぎ準備時間', type: 'number', min: 0 },
  dropDetectionMode: { label: 'DROP検出方式', type: 'text', select: DROP_DETECTION_MODES },
  recordedStorageWakeupBeforeSec: { label: '録画先HDDの事前起動', type: 'number', integer: true, min: 0 },
  storageLowSpaceWarningThresholdMB: { label: '容量警告の空き容量', type: 'number', min: 0 },
  storageLowSpaceWarningIntervalMinutes: { label: '容量警告の通知間隔', type: 'number', exclusiveMin: 0 },
  storageLowSpaceThresholdMB: { label: '容量不足の空き容量', type: 'number', exclusiveMin: 0 },
  storageLowSpaceCriticalNotifyIntervalMinutes: { label: '容量不足の通知間隔', type: 'number', exclusiveMin: 0 },
  notificationCommand: { label: '通知コマンド', type: 'command', empty: 'null' },
  matchRetentionDays: { label: '予約・録画照合履歴の保持期間', type: 'number', integer: true, min: 0 },
  reserves2RetentionDays: { label: '予約履歴の保持期間', type: 'number', integer: true, min: 0 },
  recordedHistoryRetentionDays: { label: '録画済み履歴の保持期間', type: 'number', integer: true, min: 0 },
  wuiOpenHost: { label: '接続を受け付けるIPアドレス', type: 'text', empty: 'null' },
  wuiOpenPort: { label: 'ポート番号', type: 'number', integer: true, min: 1 }
};

function valueText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function card(title, description) {
  const section = document.createElement('section');
  section.className = 'settings-card panel';
  const header = document.createElement('header');
  const heading = document.createElement('h2');
  const note = document.createElement('p');
  heading.textContent = title;
  note.textContent = description;
  header.append(heading, note);
  const body = document.createElement('div');
  body.className = 'settings-card-body';
  section.append(header, body);
  return { section, body };
}

function globalAccessWarning() {
  const warning = document.createElement('aside');
  warning.className = 'settings-access-warning';
  warning.innerHTML = '<strong><span aria-hidden="true">⚠</span> 外部アクセスに関する注意</strong><p>この設定をOFFにすると、Chinachu WUIはグローバルIPからの接続を拒否しなくなります。</p><p>インターネットへ直接公開する構成では必要になる場合がありますが、不正アクセスなどのセキュリティリスクがあるため、WUIの直接公開は推奨しません。</p><p>外部から利用する場合は、VPN（Tailscale、WireGuardなど）や、remote.itなどのリモートアクセスサービスの利用を検討してください。</p>';
  return warning;
}

function fieldShell(label, key, description, options = {}) {
  const wrap = document.createElement('div');
  wrap.className = `settings-field${options.wide ? ' is-wide' : ''}${options.compact ? ' is-compact' : ''}`;
  const title = document.createElement('span');
  title.className = 'settings-field-title';
  title.textContent = label;
  if (key) {
    const code = document.createElement('code');
    code.textContent = key;
    title.append(code);
  }
  const help = document.createElement('span');
  help.className = 'settings-field-help';
  help.textContent = description;
  const control = document.createElement('span');
  control.className = 'settings-field-control';
  const error = document.createElement('span');
  error.className = 'settings-field-error';
  error.hidden = true;
  wrap.append(title, help, control, error);
  return { wrap, control, error };
}

function switchControl(label, checked) {
  const wrap = document.createElement('label');
  wrap.className = 'settings-switch';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  const track = document.createElement('span');
  track.className = 'settings-switch-track';
  track.setAttribute('aria-hidden', 'true');
  const state = document.createElement('span');
  state.className = 'settings-switch-state';
  const update = () => { state.textContent = input.checked ? 'ON' : 'OFF'; };
  input.addEventListener('change', update);
  update();
  wrap.append(input, track, state);
  wrap.setAttribute('aria-label', label);
  return { wrap, input };
}

function summarizeService(service) {
  const channel = service?.channel || {};
  return `${channel.type || '-'} / ${channel.channel || '-'} / SID ${service?.serviceId ?? '-'}`;
}

export function renderSettingsPage(container) {
  let disposed = false;
  const controller = new AbortController();
  let original = null;
  let draft = null;
  let runtimeMode = null;
  let authSettings = null;
  let activeTab = 'basic';
  let services = null;
  const fieldErrors = new Map();
  const dependentUpdates = [];

  container.innerHTML = '<section class="panel settings-loading">設定を読み込んでいます…</section>';

  const authenticationRequest = loadAuthSettings(controller.signal).then(
    value => ({ value }),
    error => {
      if (error?.name === 'AbortError') throw error;
      return { error };
    }
  );
  Promise.all([loadConfig(controller.signal), loadRuntimeMode(controller.signal), authenticationRequest]).then(([config, mode, authentication]) => {
    if (disposed) return;
    original = cloneConfig(config);
    draft = cloneConfig(config);
    runtimeMode = mode;
    authSettings = authentication.value || { loadError: authentication.error?.message || '認証状態を取得できませんでした。' };
    render();
  }).catch(error => {
    if (disposed || error?.name === 'AbortError') return;
    container.innerHTML = `<section class="panel empty-page"><h2>設定を読み込めません</h2><p></p></section>`;
    container.querySelector('p').textContent = error.message;
  });

  function markChanged() {
    updateStatus();
    dependentUpdates.forEach(update => update());
  }

  function setError(key, element, message) {
    if (message) {
      fieldErrors.set(key, message);
      element.textContent = message;
      element.hidden = false;
    } else {
      fieldErrors.delete(key);
      element.textContent = '';
      element.hidden = true;
    }
  }

  function bindValueField(key, description, options = {}) {
    const definition = { ...FIELD[key], ...options };
    const shell = fieldShell(definition.label, key, description, options);
    const input = document.createElement(options.multiline ? 'textarea' : definition.select ? 'select' : 'input');
    input.className = 'settings-input';
    if (!options.multiline && !definition.select) input.type = definition.type === 'number' ? 'number' : 'text';
    if (definition.type === 'number') {
      if (definition.min !== undefined) input.min = String(definition.min);
      input.step = definition.integer ? '1' : 'any';
    }
    if (definition.select) {
      definition.select.forEach(option => {
        const item = document.createElement('option');
        item.value = option.value;
        item.textContent = option.label;
        input.append(item);
      });
    }
    input.value = valueText(draft[key]);
    if (options.placeholder) input.placeholder = options.placeholder;
    const update = () => {
      const parsed = parseFieldValue(input.value, definition);
      setError(key, shell.error, parsed.error);
      if (!parsed.error) setConfigValue(draft, key, parsed.value, { remove: parsed.remove });
      markChanged();
    };
    input.addEventListener(definition.select ? 'change' : 'input', update);
    shell.control.append(input);
    return { ...shell, input };
  }

  function bindBoolean(key, label, description, options = {}) {
    const shell = fieldShell(label, key, description, options);
    const toggle = switchControl(label, draft[key] === true || (options.defaultTrue && draft[key] !== false));
    toggle.input.addEventListener('change', () => {
      draft[key] = toggle.input.checked;
      markChanged();
    });
    shell.control.append(toggle.wrap);
    return { ...shell, input: toggle.input };
  }

  function sectionFor(tab) {
    const section = document.createElement('div');
    section.className = 'settings-tab-panel';
    section.dataset.tab = tab;
    section.hidden = tab !== activeTab;
    return section;
  }

  function createBasicTab() {
    const tab = sectionFor('basic');
    const connection = card('接続と実行環境', '番組情報の取得や録画に使用するMirakurunと、Chinachuの実行環境を設定します。');
    const path = bindValueField('mirakurunPath', '番組情報の取得やチューナーの制御に使用するMirakurunサーバーの接続先です。HTTP URLまたはUnix socketのURLを指定できます。', { wide: true, placeholder: '例: http://127.0.0.1:40772/ または http+unix://%2Fvar%2Frun%2Fmirakurun.sock/' });
    connection.body.append(path.wrap);
    const privilege = document.createElement('div');
    privilege.className = 'settings-runtime-status';
    privilege.innerHTML = '<strong></strong><p></p>';
    privilege.querySelector('strong').textContent = runtimeMode.label;
    privilege.querySelector('p').textContent = runtimeMode.detail;
    connection.body.append(privilege);
    const identityGrid = document.createElement('div');
    identityGrid.className = 'settings-fields';
    ['uid', 'gid'].forEach(key => {
      const shell = fieldShell(key === 'uid' ? '権限切替先ユーザー' : '権限切替先グループ', key,
        `root権限でChinachuを起動する場合に、実際の処理を実行する${key === 'uid' ? 'ユーザー' : 'グループ'}を指定します。現在の起動方法で切り替えを行わない場合は編集できません。`, { compact: true });
      const input = document.createElement('input');
      input.className = 'settings-input';
      input.value = valueText(draft[key]);
      input.disabled = true;
      shell.control.append(input);
      identityGrid.append(shell.wrap);
    });
    connection.body.append(identityGrid);

    const video = card('動画処理', '対応する視聴・動画変換処理でGPUを利用し、CPU負荷を軽減します。新しいHLS配信には適用されません。');
    const vaapi = bindBoolean('vaapiEnabled', 'VA-API', '対応する従来の視聴・動画変換処理でVA-APIを使用します。利用するには対応GPUとドライバーが必要です。');
    const device = bindValueField('vaapiDevice', '動画変換に使用するGPUデバイスを指定します。通常は変更する必要はありません。', { wide: true, placeholder: '例: /dev/dri/renderD128' });
    dependentUpdates.push(() => { device.input.disabled = draft.vaapiEnabled !== true; device.wrap.classList.toggle('is-disabled', device.input.disabled); });
    video.body.append(vaapi.wrap, device.wrap);
    tab.append(connection.section, video.section);
    return tab;
  }

  function createRecordedDirsEditor() {
    const wrap = document.createElement('div');
    wrap.className = 'settings-recorded-dirs';
    const list = document.createElement('div');
    list.className = 'settings-recorded-dir-list';
    const add = document.createElement('button');
    add.className = 'button';
    add.type = 'button';
    add.textContent = '追加録画先を追加';
    let rows = Array.isArray(draft.recordedDirs) ? draft.recordedDirs.map(item => ({
      original: cloneConfig(item || {}), id: item?.id || '', name: item?.name || '', path: item?.path || '',
      protectRootFilesystem: item?.storage?.protectRootFilesystem === true
    })) : [];
    const error = document.createElement('p');
    error.className = 'settings-field-error';
    error.hidden = true;

    const commit = () => {
      const normalized = normalizeRecordedDirs(rows);
      if (normalized.errors.length) {
        fieldErrors.set('recordedDirs', normalized.errors.join('\n'));
        error.textContent = normalized.errors.join(' ');
        error.hidden = false;
      } else {
        fieldErrors.delete('recordedDirs');
        error.hidden = true;
        draft.recordedDirs = normalized.value;
      }
      markChanged();
    };
    const draw = () => {
      list.replaceChildren();
      if (!rows.length) {
        const empty = document.createElement('p');
        empty.className = 'settings-muted';
        empty.textContent = '追加録画先は登録されていません。デフォルト録画先を重複して登録する必要はありません。';
        list.append(empty);
      }
      rows.forEach((row, index) => {
        const item = document.createElement('article');
        item.className = 'settings-recorded-dir';
        const head = document.createElement('header');
        head.innerHTML = `<strong>追加録画先 ${index + 1}</strong>`;
        const remove = document.createElement('button');
        remove.className = 'button is-danger';
        remove.type = 'button';
        remove.textContent = '削除';
        remove.addEventListener('click', () => { rows.splice(index, 1); draw(); commit(); });
        head.append(remove);
        const grid = document.createElement('div');
        grid.className = 'settings-recorded-dir-fields';
        [['id', 'ID（録画先の識別名）'], ['name', '表示名（画面上の名前）'], ['path', 'パス（保存フォルダ）']].forEach(([key, label]) => {
          const field = document.createElement('label');
          field.innerHTML = `<span>${label}</span>`;
          const input = document.createElement('input');
          input.className = 'settings-input';
          input.value = row[key];
          input.addEventListener('input', () => { row[key] = input.value; commit(); });
          field.append(input);
          grid.append(field);
        });
        const protection = document.createElement('div');
        protection.className = 'settings-recorded-dir-protection';
        const protectionLabel = document.createElement('span');
        protectionLabel.textContent = 'システム領域への誤録画を防止';
        const protectionSwitch = switchControl('システム領域への誤録画を防止', row.protectRootFilesystem);
        protectionSwitch.input.addEventListener('change', () => {
          row.protectRootFilesystem = protectionSwitch.input.checked;
          commit();
        });
        protection.append(protectionLabel, protectionSwitch.wrap);
        const protectionHelp = document.createElement('small');
        protectionHelp.textContent = 'ONにすると、OSと同じ保存領域では録画を開始しません。';
        protection.append(protectionHelp);
        if (typeof row.original?.storage?.expectedMount === 'string' && row.original.storage.expectedMount.trim() !== '') {
          const legacy = document.createElement('small');
          legacy.textContent = 'マウント先の確認による保護も設定されています。この保護はスイッチとは別に動作します。';
          protection.append(legacy);
        }
        grid.append(protection);
        item.append(head, grid);
        list.append(item);
      });
    };
    add.addEventListener('click', () => { rows.push({ original: {}, id: '', name: '', path: '', protectRootFilesystem: false }); draw(); });
    draw();
    wrap.append(list, add, error);
    return wrap;
  }

  function createRecordingTab() {
    const tab = sectionFor('recording');
    tab.classList.add('settings-recording');
    const destination = card('録画先', '録画ファイルを保存するフォルダと、保存先ごとの安全保護を設定します。');
    const defaultDir = bindValueField('recordedDir', '録画ルールで保存先を指定していない場合に使用する録画先です。');
    const rootProtection = fieldShell('システム領域への誤録画を防止', 'recordedStorage.protectRootFilesystem', '録画先がOSと同じ保存領域になった場合、録画を開始せず警告します。HDDのマウント外れによるシステムディスクへの誤録画を防ぎます。OSと同じ領域へ録画する構成ではOFFにしてください。');
    const rootProtectionSwitch = switchControl('デフォルト録画先のシステム領域への誤録画を防止', draft.recordedStorage?.protectRootFilesystem === true);
    rootProtectionSwitch.input.addEventListener('change', () => {
      updateRecordedStorageRootProtection(draft, rootProtectionSwitch.input.checked);
      markChanged();
    });
    rootProtection.control.append(rootProtectionSwitch.wrap);
    if (typeof draft.recordedStorage?.expectedMount === 'string' && draft.recordedStorage.expectedMount.trim() !== '') {
      const legacy = document.createElement('span');
      legacy.className = 'settings-legacy-protection';
      legacy.textContent = 'マウント先の確認による保護も設定されています。この保護はスイッチをOFFにしても引き続き動作します。';
      rootProtection.control.append(legacy);
    }
    destination.body.append(defaultDir.wrap, rootProtection.wrap);
    const dirsTitle = document.createElement('div');
    dirsTitle.className = 'settings-subsection-title';
    dirsTitle.innerHTML = '<strong>追加録画先</strong><p>録画ルールごとに選択できる保存先を追加します。保存先を指定しないルールでは、デフォルト録画先を使用します。</p>';
    destination.body.append(dirsTitle, createRecordedDirsEditor());

    const naming = card('録画ファイル名', '録画ファイルの名前と、放送属性を表す囲み文字の扱いを設定します。');
    const format = bindValueField('recordedFormat', '録画ファイルの名前を決める設定です。番組名、放送日時、チャンネル名などを組み合わせて指定できます。', { wide: true });
    const replace = bindBoolean('recordedNameReplaceEnclosingCharacters', '囲み文字の置換', '録画ファイル名に含まれる「🈟」「🈞」「🈑」などを「[新]」「[再]」「[字]」へ置き換えます。番組表の表示は変更されません。');
    const map = bindValueField('recordedNameEnclosingCharacterMap', '囲み文字をどの文字列へ置き換えるかをJSON形式で指定します。通常は標準の置換ルールを使用します。', { multiline: true, placeholder: '例: {"🈟":"[新]","🈞":"[再]"}' });
    dependentUpdates.push(() => { map.input.disabled = draft.recordedNameReplaceEnclosingCharacters !== true; map.wrap.classList.toggle('is-disabled', map.input.disabled); });
    naming.body.append(format.wrap, replace.wrap, map.wrap);

    const drop = card('録画中のDROP検出', '変更はOperatorの再起動後に反映されます。保存しても自動では再起動しません。');
    drop.section.classList.add('settings-drop');
    const dropMode = bindValueField('dropDetectionMode', '録画中のDROP検出方式を選択します。TS解析はBETA機能で、録画中のCPU負荷が増加する場合があります。', { wide: true });
    if (draft.dropDetectionMode === undefined || draft.dropDetectionMode === null) {
      dropMode.input.value = 'mirakurun';
    } else if (!DROP_DETECTION_MODES.some(option => option.value === draft.dropDetectionMode)) {
      const current = document.createElement('option');
      current.value = '';
      current.disabled = true;
      current.textContent = `現在の設定: ${formatChangeValue(draft.dropDetectionMode, false, 'dropDetectionMode')}（選び直してください）`;
      dropMode.input.prepend(current);
      dropMode.input.value = '';
    }
    const dropDescription = document.createElement('p');
    dropDescription.className = 'settings-muted';
    dependentUpdates.push(() => {
      dropDescription.textContent = DROP_DETECTION_MODES.find(option => option.value === dropMode.input.value)?.description ||
        '保存するにはDROP検出方式を選び直してください。現在の設定値は自動では変更しません。';
    });
    dropMode.wrap.append(dropDescription);
    drop.body.append(dropMode.wrap);

    const commands = card('録画後処理と予約照合', '録画終了後の処理と、予約ルールの照合方法を設定します。変更した内容はOperatorの再起動後に反映されます。');
    const fields = document.createElement('div');
    fields.className = 'settings-fields';
    const recordedCommand = bindValueField('recordedCommand', '録画が正常に終了した後に実行する外部コマンドです。空欄では何も実行しません。', { multiline: true, wide: true });
    const ffprobe = bindValueField('ffprobeCommand', '録画ファイルの再生時間を調べるために使用するコマンドです。通常は変更不要です。', { placeholder: '通常: ffprobe' });
    const timeout = bindValueField('recordedDurationProbeTimeoutMs', '再生時間の取得を待つ最大時間です。単位はミリ秒で、8000なら8秒です。', { compact: true });
    const normalization = bindValueField('normalizationForm', '番組名や番組説明と予約ルールを照合する際に、文字の表現の違いを調整します。変更すると、ルールに一致する番組が変わる場合があります。通常はNFKCを使用します。', {
      select: [{ value: '', label: '未指定（正規化なし）' }, { value: 'NFC', label: 'NFC' }, { value: 'NFD', label: 'NFD' }, { value: 'NFKC', label: 'NFKC' }, { value: 'NFKD', label: 'NFKD' }]
    });
    fields.append(ffprobe.wrap, timeout.wrap, normalization.wrap);
    ['recordingPriority', 'conflictedPriority', 'handoffPrepSeconds'].forEach(key => {
      const descriptions = {
        recordingPriority: 'Mirakurunに通常録画を要求する際の優先度です。値が大きい要求が優先され、0を指定すると既定値の2が使われます。',
        conflictedPriority: '予約競合がある番組を録画する際の優先度です。通常録画より低くすると通常録画を優先でき、0を指定すると既定値の1が使われます。',
        handoffPrepSeconds: '連続する番組の録画で、次の番組へチューナーを切り替える準備を始める時間です。0〜60秒として扱われ、大きくするとチューナー不足時に前の番組を早く終了する可能性があります。'
      };
      fields.append(bindValueField(key, descriptions[key], { compact: true }).wrap);
    });
    commands.body.append(fields, recordedCommand.wrap);
    tab.append(destination.section, naming.section, drop.section, commands.section);
    return tab;
  }

  function createStorageTab() {
    const tab = sectionFor('storage');
    const wake = card('録画先HDDの事前起動', '録画開始前に休止中の録画先HDDを起動し、起動待ちによる録画冒頭の欠けを防ぎます。0または未指定で無効です。');
    wake.body.append(bindValueField('recordedStorageWakeupBeforeSec', '録画開始の何秒前に起動するかを指定します。300なら5分前です。', { compact: true }).wrap);

    const warning = card('容量警告', '空き容量が警告閾値を下回ったときの表示・通知設定です。警告閾値が容量不足閾値以下なら警告は無効です。');
    const warningGrid = document.createElement('div');
    warningGrid.className = 'settings-fields';
    warningGrid.append(
      bindValueField('storageLowSpaceWarningThresholdMB', '空き容量がこの値を下回ると警告します。単位はMBで、60000なら約60GBです。0または空欄で無効です。', { compact: true }).wrap,
      bindValueField('storageLowSpaceWarningIntervalMinutes', '容量警告が解消しない場合の再通知間隔です。単位は分で、1440なら24時間です。', { compact: true }).wrap
    );
    warning.body.append(warningGrid);

    const low = card('容量不足時の処置', '録画先の空き容量が不足した際の動作を設定します。変更はOperatorの再起動後に反映されます。');
    const lowGrid = document.createElement('div');
    lowGrid.className = 'settings-fields';
    lowGrid.append(
      bindValueField('storageLowSpaceThresholdMB', '空き容量がこの値を下回ると、選択した容量不足対策を実行します。単位はMBです。', { compact: true }).wrap,
      bindValueField('storageLowSpaceCriticalNotifyIntervalMinutes', '容量不足が解消しない場合の再通知間隔です。単位は分です。', { compact: true }).wrap
    );
    const action = fieldShell('容量不足時の動作', 'storageLowSpaceAction', '「新規録画のみ停止」は録画中の番組を継続しますが、容量枯渇によって完走できない場合があります。「録画中を含めて停止」は対象filesystemの新規録画と録画中番組を停止します。「古い録画ファイルを削除」は対象filesystemの録画先サブフォルダも含めてTS/M2TSを古い順に削除し、削除不能時は録画中も停止します。symlinkや別mountは対象外です。');
    const radios = document.createElement('div');
    radios.className = 'settings-radio-row';
    [['stop-new', '新規録画のみ停止'], ['stop', '録画中を含めて停止'], ['remove', '古い録画ファイルを削除']].forEach(([value, label]) => {
      const item = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'storageLowSpaceAction';
      input.value = value;
      input.checked = (['stop-new', 'stop', 'remove'].includes(draft.storageLowSpaceAction) ? draft.storageLowSpaceAction : 'stop') === value;
      input.addEventListener('change', () => { if (input.checked) { draft.storageLowSpaceAction = value; markChanged(); } });
      item.append(input, document.createTextNode(label));
      radios.append(item);
    });
    action.control.append(radios);
    const notification = bindValueField('notificationCommand', '録画先の容量警告・容量不足を外部プログラムへ通知する場合に使用するコマンドです。空欄では外部通知を行いません。', { multiline: true, wide: true });
    low.body.append(lowGrid, action.wrap, notification.wrap);
    tab.append(wake.section, warning.section, low.section);
    return tab;
  }

  function createHistoryTab() {
    const tab = sectionFor('history');
    const retention = card('履歴保持期間', '履歴を自動整理するまでの日数を指定します。0で自動整理を無効にし、未指定時は365日です。録画ファイル自体は削除しません。');
    const grid = document.createElement('div');
    grid.className = 'settings-fields';
    grid.append(
      bindValueField('matchRetentionDays', '予約と録画結果を結び付ける履歴を保持する日数です。', { compact: true }).wrap,
      bindValueField('reserves2RetentionDays', '終了した予約の履歴を保持する日数です。', { compact: true }).wrap,
      bindValueField('recordedHistoryRetentionDays', '録画済み一覧に使用する履歴情報を保持する日数です。整理しても録画ファイルは削除しません。', { compact: true }).wrap
    );
    retention.body.append(grid);
    const behavior = card('録画結果の記録', '録画結果をCSVファイルにも保存するか設定します。');
    behavior.body.append(
      bindBoolean('recordingResultCsvEnabled', '録画結果CSVの自動保存', '録画結果を月ごとのCSVファイルへ自動で追記します。未指定時は無効です。').wrap
    );
    tab.append(retention.section, behavior.section);
    return tab;
  }

  function normalizeServices(raw) {
    const excluded = new Set((draft.excludeServices || []).map(String));
    const order = new Map((draft.serviceOrder || []).map((id, index) => [String(id), index + 1]));
    return raw.map(service => ({
      raw: service,
      id: Number(service.id),
      name: String(service.name || ''),
      excluded: excluded.has(String(service.id)),
      order: order.get(String(service.id)) || ''
    })).sort((a, b) => summarizeService(a.raw).localeCompare(summarizeService(b.raw), 'ja'));
  }

  function commitServices() {
    if (!services) return;
    draft.excludeServices = services.filter(item => item.excluded).map(item => item.id);
    draft.serviceOrder = services.filter(item => item.order !== '').sort((a, b) => Number(a.order) - Number(b.order)).map(item => item.id);
    markChanged();
  }

  function createServicesTab() {
    const tab = sectionFor('services');
    const wui = card('WUIサーバー・アクセス制限', 'ChinachuのWeb画面と、接続元IPアドレスによるアクセス制限を設定します。変更はWUIの再起動後に反映されます。');
    const open = bindBoolean('wuiOpenServer', 'WUIサーバーを有効にする', 'ChinachuのWeb画面を利用できるようにします。OFFにすると、WUI再起動後に接続できなくなる場合があります。');
    const blockGlobal = bindBoolean('wuiBlockGlobalAccess', 'グローバルIPからの接続を拒否', 'ONにすると、接続元IPアドレスがローカル・プライベートネットワークに属する接続だけを受け付けます。', { defaultTrue: true });
    const host = bindValueField('wuiOpenHost', 'WUIが接続を受け付ける、このサーバー側のIPアドレスです。未指定時は、内部インターフェース以外のプライベート・リンクローカルIPv4アドレスから最初の1つを自動選択します。該当するアドレスがなければ起動しません。', { placeholder: '自動選択（未指定）' });
    const port = bindValueField('wuiOpenPort', 'Web画面への接続に使用するポート番号です。変更するとブラウザでアクセスするURLも変わります。', { compact: true, placeholder: '例: 20772' });
    dependentUpdates.push(() => {
      [host, port].forEach(field => { field.input.disabled = draft.wuiOpenServer !== true; field.wrap.classList.toggle('is-disabled', field.input.disabled); });
    });
    const serverColumn = document.createElement('div');
    serverColumn.className = 'settings-wui-column';
    const serverHeading = document.createElement('h3');
    serverHeading.textContent = 'WUIサーバー';
    serverColumn.append(serverHeading, open.wrap, host.wrap, port.wrap);
    const accessColumn = document.createElement('div');
    accessColumn.className = 'settings-wui-column';
    const accessHeading = document.createElement('h3');
    accessHeading.textContent = 'アクセス制限';
    const accessWarning = globalAccessWarning();
    accessWarning.setAttribute('role', 'note');
    accessColumn.append(accessHeading, blockGlobal.wrap, accessWarning);
    dependentUpdates.push(() => { accessWarning.hidden = draft.wuiBlockGlobalAccess !== false; });
    wui.body.append(serverColumn, accessColumn);

    const serviceCard = card('放送サービス', '番組表や録画予約で使用しないサービスを選び、画面上の表示順を指定します。除外するサービスにチェックを入れてください。');
    const controls = document.createElement('div');
    controls.className = 'settings-service-controls';
    const load = document.createElement('button');
    load.className = 'button';
    load.type = 'button';
    load.textContent = 'サービス一覧を読み込む';
    const status = document.createElement('p');
    status.className = 'settings-muted';
    status.textContent = `現在の設定: 除外 ${(draft.excludeServices || []).length}件 / 順序 ${(draft.serviceOrder || []).length}件`;
    const list = document.createElement('div');
    list.className = 'settings-service-list';
    const draw = () => {
      list.replaceChildren();
      services.forEach(item => {
        const row = document.createElement('article');
        row.className = 'settings-service-row';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = item.excluded;
        check.setAttribute('aria-label', `${item.name}を除外`);
        check.addEventListener('change', () => { item.excluded = check.checked; commitServices(); row.classList.toggle('is-excluded', item.excluded); });
        const info = document.createElement('div');
        info.innerHTML = '<strong></strong><small></small>';
        info.querySelector('strong').textContent = item.name || `サービス ${item.id}`;
        info.querySelector('small').textContent = `${summarizeService(item.raw)} / ID ${item.id}`;
        const orderLabel = document.createElement('label');
        orderLabel.innerHTML = '<span>順序</span>';
        const order = document.createElement('input');
        order.type = 'number';
        order.min = '1';
        order.className = 'settings-input';
        order.value = item.order;
        order.addEventListener('input', () => { item.order = order.value; commitServices(); });
        orderLabel.append(order);
        row.classList.toggle('is-excluded', item.excluded);
        row.append(check, info, orderLabel);
        list.append(row);
      });
      status.textContent = `サービス ${services.length}件 / 除外 ${services.filter(item => item.excluded).length}件 / 順序指定 ${services.filter(item => item.order !== '').length}件`;
    };
    load.addEventListener('click', async () => {
      load.disabled = true;
      status.textContent = 'Mirakurunからサービス一覧を読み込んでいます…';
      try {
        services = normalizeServices(await loadMirakurunServices(draft.mirakurunPath, controller.signal));
        draw();
      } catch (error) {
        status.textContent = `${error.message}。現在のサービス選択と表示順は変更していません。`;
      } finally { load.disabled = false; }
    });
    controls.append(load, status);
    serviceCard.body.append(controls, list);
    tab.append(wui.section, serviceCard.section);
    return tab;
  }

  function createSeriesTab() {
    const tab = sectionFor('series');
    const information = card('しょぼいカレンダー連携（Beta）',
      'しょぼいカレンダーの作品・話数・副題情報を利用し、番組情報を補完します。利用しない場合はシリーズ一覧が表示されません。');
    const enabled = bindBoolean('seriesUseSyobocal', 'しょぼいカレンダーの情報を利用する',
      'ONでは外部取得と保存済み情報を利用します。インターネットに接続できない場合も、取得済みの情報があれば利用できます。OFFでは外部取得を行わず、保存済みの辞書・放送情報もシリーズ判定に利用しません。',
      { defaultTrue: true, wide: true });
    const status = document.createElement('div');
    status.className = 'settings-runtime-status';
    const heading = document.createElement('strong');
    const offline = document.createElement('p');
    const limitation = document.createElement('p');
    status.append(heading, offline, limitation);
    dependentUpdates.push(() => {
      const usesSyobocal = draft.seriesUseSyobocal !== false;
      heading.textContent = usesSyobocal ? 'しょぼいカレンダーの情報を利用します' : 'しょぼいカレンダーの情報を利用しません';
      offline.textContent = usesSyobocal ?
        'インターネットに接続できない場合でも、取得済みの情報があれば利用できます。' :
        'ProgLookupの外部取得は開始せず、取得済みの辞書・放送情報も参照しません。';
      limitation.textContent = usesSyobocal ? '' :
        'OFFではシリーズ一覧に作品が表示されません。録画・予約・ルール管理には影響しません。';
      limitation.hidden = usesSyobocal;
    });
    information.body.append(enabled.wrap, status);
    tab.append(information.section);
    return tab;
  }

  function createAdvancedTab() {
    const tab = sectionFor('advanced');
    const preview = card('保存内容の確認', '保存前の設定全体を確認できます。画面に入力欄がない設定は、ここで内容を確認できます。');
    const details = document.createElement('details');
    details.className = 'settings-json-preview';
    details.innerHTML = '<summary>JSONを表示</summary><pre></pre>';
    const unknown = document.createElement('p');
    unknown.className = 'settings-muted';
    const update = () => {
      details.querySelector('pre').textContent = JSON.stringify(draft, null, 2);
      const keys = unknownConfigKeys(draft);
      unknown.textContent = keys.length ? `この画面では編集しない設定: ${keys.join(', ')}` : '画面に入力欄がない設定はありません。';
    };
    dependentUpdates.push(update);
    preview.body.append(unknown, details);
    const notice = card('設定の反映', '設定を保存しても、WUIやOperatorは自動的に再起動しません。');
    notice.body.innerHTML = '<ul class="settings-notes"><li>待受アドレスやポートなどのWUI設定は、WUIの再起動後に反映されます。</li><li>録画先、容量判定、録画処理などの設定は、Operatorの再起動後に反映されます。</li><li>録画中のOperatorをこの画面から停止・再起動することはありません。</li></ul>';
    tab.append(preview.section, notice.section);
    return tab;
  }

  function openAuthDialog(options) {
    const dialog = document.createElement('dialog');
    dialog.className = 'settings-save-dialog settings-auth-dialog';
    dialog.innerHTML = '<form method="dialog"><header><h2></h2><button value="cancel" aria-label="閉じる">×</button></header><p class="settings-auth-description"></p><div class="settings-auth-fields"></div><footer><button class="button" value="cancel">キャンセル</button><button class="button primary" type="button" data-submit></button></footer><p role="status"></p></form>';
    dialog.querySelector('h2').textContent = options.title;
    dialog.querySelector('.settings-auth-description').textContent = options.description || '';
    const fields = dialog.querySelector('.settings-auth-fields');
    (options.fields || []).forEach(definition => {
      const label = document.createElement('label');
      label.textContent = definition.label;
      const input = document.createElement('input');
      input.name = definition.name;
      input.type = definition.type || 'text';
      input.required = definition.required !== false;
      if (definition.autocomplete) input.autocomplete = definition.autocomplete;
      if (definition.inputmode) input.inputMode = definition.inputmode;
      if (definition.minlength) input.minLength = definition.minlength;
      if (definition.maxlength) input.maxLength = definition.maxlength;
      label.append(input);
      fields.append(label);
    });
    const submit = dialog.querySelector('[data-submit]');
    submit.textContent = options.submitLabel || '実行';
    if (options.danger) submit.classList.add('is-danger');
    const status = dialog.querySelector('[role="status"]');
    submit.addEventListener('click', async () => {
      const form = dialog.querySelector('form');
      if (!form.reportValidity()) return;
      submit.disabled = true;
      status.textContent = '確認しています…';
      status.classList.remove('is-error');
      const values = Object.fromEntries(new FormData(form).entries());
      try {
        const outcome = await options.submit(values, dialog);
        if (outcome !== false && dialog.open) dialog.close();
      } catch (error) {
        status.textContent = error.message;
        status.classList.add('is-error');
        submit.disabled = false;
      }
    });
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector('input')?.focus();
  }

  function credentialFields(includeNewPassword = false) {
    const fields = [{ name: 'password', label: '現在の管理者パスワード', type: 'password', autocomplete: 'current-password' }];
    if (includeNewPassword) {
      fields.push(
        { name: 'newPassword', label: '新しいパスワード（6文字以上）', type: 'password', autocomplete: 'new-password', minlength: 6 },
        { name: 'newPasswordConfirm', label: '新しいパスワード（確認）', type: 'password', autocomplete: 'new-password' }
      );
    }
    if (authSettings.totpEnabled) fields.push({ name: 'totp', label: '現在の6桁確認コード', inputmode: 'numeric', maxlength: 6, autocomplete: 'one-time-code' });
    return fields;
  }

  function reloadAfterAuthChange() {
    window.location.reload();
    return false;
  }

  function showAuthChange(result, message) {
    authSettings = {
      ...authSettings,
      enabled: typeof result.enabled === 'boolean' ? result.enabled : authSettings.enabled,
      totpEnabled: typeof result.totpEnabled === 'boolean' ? result.totpEnabled : authSettings.totpEnabled
    };
    render();
    const notice = container.querySelector('.settings-page-message');
    notice.textContent = message;
    notice.hidden = false;
  }

  async function copyAuthText(value, button) {
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(value);
        copied = true;
      } catch (_) {}
    }
    if (!copied) {
      const field = document.createElement('textarea');
      field.value = value;
      field.setAttribute('readonly', '');
      field.className = 'settings-copy-fallback';
      document.body.append(field);
      field.select();
      copied = document.execCommand('copy');
      field.remove();
      if (!copied) throw new Error('コピーできませんでした。');
    }
    const original = button.textContent;
    button.textContent = 'コピーしました';
    window.setTimeout(() => { button.textContent = original; }, 1600);
  }

  function openTotpSetupDialog(setup) {
    const dialog = document.createElement('dialog');
    dialog.className = 'settings-save-dialog settings-auth-dialog settings-totp-dialog';
    dialog.innerHTML = '<form method="dialog"><header><h2>2FA（TOTP）を設定</h2><button value="cancel" aria-label="閉じる">×</button></header><div class="settings-totp-steps"><section><h3><span>1</span>認証アプリを開く</h3><p>スマートフォンでGoogle Authenticator（Google 認証システム）などの認証アプリを開いてください。</p><p>アプリの「＋」から「QRコードをスキャン」を選択します。</p></section><section><h3><span>2</span>QRコードを読み取る</h3><div class="settings-totp-qr" data-qr></div><p class="settings-totp-account"></p><details><summary>QRコードを読み取れない場合</summary><p>認証アプリへ次の秘密鍵を手動で登録してください。</p><div class="settings-auth-copy"><code></code><button class="button" type="button">秘密鍵をコピー</button></div></details></section><section><h3><span>3</span>6桁の認証コードを入力する</h3><p>認証アプリに表示された6桁のコードを入力してください。</p><p>コードは30秒ごとに更新されます。切り替わった場合は、新しく表示されたコードを入力してください。</p><label>6桁の認証コード<input name="code" required inputmode="numeric" maxlength="6" pattern="[0-9]{6}" autocomplete="one-time-code"></label></section></div><footer><button class="button" value="cancel">キャンセル</button><button class="button primary" type="button" data-submit>確認して有効化</button></footer><p role="status"></p></form>';
    dialog.querySelector('.settings-totp-account').textContent = `登録名: ${setup.issuer} / ${setup.account}`;
    dialog.querySelector('details code').textContent = setup.secret;
    dialog.querySelector('.settings-auth-copy button').addEventListener('click', event => {
      copyAuthText(setup.secret, event.currentTarget).catch(error => {
        const status = dialog.querySelector('[role="status"]');
        status.textContent = error.message;
        status.classList.add('is-error');
      });
    });
    const status = dialog.querySelector('[role="status"]');
    try {
      QrCreator.render({ text: setup.otpauth, radius: 0, ecLevel: 'M', fill: '#000', background: '#fff', size: 240, quiet: 4 }, dialog.querySelector('[data-qr]'));
    } catch (_) {
      dialog.querySelector('details').open = true;
      status.textContent = 'QRコードを表示できませんでした。秘密鍵を手動で登録してください。';
      status.classList.add('is-error');
    }
    const submit = dialog.querySelector('[data-submit]');
    submit.addEventListener('click', async () => {
      const form = dialog.querySelector('form');
      if (!form.reportValidity()) return;
      submit.disabled = true;
      status.textContent = '確認しています…';
      status.classList.remove('is-error');
      try {
        const values = Object.fromEntries(new FormData(form).entries());
        const result = await confirmTotpSetup(setup.setupId, values.code, controller.signal);
        dialog.close();
        showAuthChange(result, '2FA（TOTP）を有効にしました。');
      } catch (error) {
        status.textContent = error.message;
        status.classList.add('is-error');
        submit.disabled = false;
      }
    });
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector('input[name="code"]').focus();
  }

  function createAuthTab() {
    const tab = sectionFor('auth');
    const warning = document.createElement('div');
    warning.className = 'settings-auth-warning';
    warning.textContent = 'WUIのインターネット直接公開は推奨しません。LAN内またはVPN経由で利用し、wuiBlockGlobalAccessも補助的な制限として併用してください。';
    const compatibilityNotice = document.createElement('section');
    compatibilityNotice.className = 'settings-card panel';
    compatibilityNotice.innerHTML = '<header><h2>ログイン認証に関する注意</h2></header><div class="settings-card-body"><div class="settings-auth-onboarding"><p>ログイン認証を有効にすると、一部の端末や再生アプリでは動画を再生できなくなる場合があります。</p><p>2FA（TOTP）を有効にすると、ログイン時に認証アプリの6桁コードが必要になります。認証コードを入力できない端末では、ログインできない場合があります。</p></div></div>';

    if (authSettings.loadError) {
      const unavailable = card('認証状態を確認できません', authSettings.loadError);
      unavailable.body.append(warning);
      tab.append(unavailable.section, compatibilityNotice);
      return tab;
    }

    if (!authSettings.configured) {
      const onboarding = card('管理者パスワードが未設定です', 'ログイン認証を利用するには、Chinachuを実行しているLinux端末で、最初に管理者パスワードを登録してください。');
      const instructions = document.createElement('div');
      instructions.className = 'settings-auth-onboarding';
      instructions.innerHTML = '<p>Chinachuのインストールディレクトリへ移動し、WUI実行ユーザーと同じLinuxユーザーで実行してください。</p><div class="settings-auth-copy"><code>./chinachu auth setup</code><button class="button" type="button">コマンドをコピー</button></div><p>登録後、この画面を再読み込みしてください。CLIをブラウザから自動実行することはありません。</p>';
      instructions.querySelector('button').addEventListener('click', event => {
        copyAuthText('./chinachu auth setup', event.currentTarget).catch(error => window.alert(error.message));
      });
      onboarding.body.append(instructions, warning);
      tab.append(onboarding.section, compatibilityNotice);
      return tab;
    }

    const overview = card('ログイン認証', '単一の管理者 admin とサーバー側セッションでWUIとAPIを保護します。認証情報は通常設定とは別に保存されます。');
    const statuses = document.createElement('dl');
    statuses.className = 'settings-auth-status';
    statuses.innerHTML = `<div><dt>ログイン認証</dt><dd>${authSettings.enabled ? 'ON' : 'OFF'}</dd></div><div><dt>管理者パスワード</dt><dd>設定済み</dd></div><div><dt>2FA（TOTP）</dt><dd>${authSettings.totpEnabled ? 'ON' : 'OFF'}</dd></div>`;
    overview.body.append(warning, statuses);

    const actions = card('認証設定の変更', '重要な変更では現在の管理者パスワードと、有効な場合はTOTP確認コードを再入力します。認証有効化と2FA設定では操作中のブラウザだけ継続し、その他の既存セッションは失効します。');
    const buttons = document.createElement('div');
    buttons.className = 'settings-auth-actions';
    const enable = document.createElement('button');
    enable.type = 'button';
    enable.className = `button${authSettings.enabled ? ' is-danger' : ' primary'}`;
    enable.textContent = authSettings.enabled ? 'ログイン認証をOFFにする' : 'ログイン認証をONにする';
    enable.addEventListener('click', () => openAuthDialog({
      title: enable.textContent,
		description: authSettings.enabled ? '認証を無効にすると、WUIとAPIへログインせずアクセスできるようになります。' : '本人確認後、このブラウザを認証済みにして設定画面で操作を継続します。',
      fields: credentialFields(),
      submitLabel: authSettings.enabled ? '認証をOFFにする' : '認証をONにする',
      danger: authSettings.enabled,
      submit: async values => {
        const result = await updateAuthEnabled(!authSettings.enabled, values.password, values.totp, controller.signal);
        if (!result.enabled) return reloadAfterAuthChange();
        showAuthChange(result, 'ログイン認証を有効にしました。');
      }
    }));

    const password = document.createElement('button');
    password.type = 'button';
    password.className = 'button';
    password.textContent = '管理者パスワードを変更';
    password.addEventListener('click', () => openAuthDialog({
      title: '管理者パスワードを変更',
      description: '変更すると、現在を含むすべてのログインセッションが失効します。',
      fields: credentialFields(true),
      submitLabel: 'パスワードを変更',
      submit: async values => {
        if (values.newPassword !== values.newPasswordConfirm) throw new Error('新しいパスワードが一致しません。');
        await changeAdminPassword(values.password, values.newPassword, values.totp, controller.signal);
        return reloadAfterAuthChange();
      }
    }));

    const totp = document.createElement('button');
    totp.type = 'button';
    totp.className = 'button';
    totp.textContent = authSettings.totpEnabled ? '2FAを再設定' : '2FA（TOTP）を設定';
    totp.addEventListener('click', () => openAuthDialog({
      title: authSettings.totpEnabled ? '2FAを再設定' : '2FA（TOTP）を設定',
      description: '現在の認証情報を確認した後、認証アプリへ登録するQRコードを表示します。',
      fields: credentialFields(),
      submitLabel: 'QRコードを表示',
      submit: async (values, dialog) => {
        const setup = await beginTotpSetup(values.password, values.totp, controller.signal);
        dialog.close();
        openTotpSetupDialog(setup);
        return false;
      }
    }));

    const removeTotp = document.createElement('button');
    removeTotp.type = 'button';
    removeTotp.className = 'button is-danger';
    removeTotp.textContent = '2FAを解除';
    removeTotp.addEventListener('click', () => openAuthDialog({
      title: '2FAを解除',
      description: '解除後は管理者パスワードだけでログインできます。既存セッションは失効します。',
      fields: credentialFields(),
      submitLabel: '2FAを解除',
      danger: true,
      submit: async values => {
        await disableTotp(values.password, values.totp, controller.signal);
        return reloadAfterAuthChange();
      }
    }));
    buttons.append(enable, password);
    if (authSettings.enabled) {
      buttons.append(totp);
      if (authSettings.totpEnabled) buttons.append(removeTotp);
    }
    actions.body.append(buttons);
    tab.append(overview.section, actions.section, compatibilityNotice);
    return tab;
  }

  function updateStatus() {
    if (!draft) return;
    const changes = configChanges(original, draft);
    const count = container.querySelector('.settings-change-count');
    const save = container.querySelector('.settings-save');
    const discard = container.querySelector('.settings-discard');
    if (count) count.textContent = changes.length ? `${changes.length}項目を変更` : '未保存の変更はありません';
    if (save) save.disabled = changes.length === 0 || fieldErrors.size > 0;
    if (discard) discard.disabled = changes.length === 0;
  }

  function openSaveDialog() {
    if (!configChanges(original, draft).length) return;
    const saveDraft = configForSave(draft);
    const errors = [...fieldErrors.values(), ...validateConfig(saveDraft)];
    if (errors.length) {
      window.alert(`入力内容を確認してください。\n\n${[...new Set(errors)].join('\n')}`);
      return;
    }
    const changes = configChanges(original, saveDraft);
    const dialog = document.createElement('dialog');
    dialog.className = 'settings-save-dialog settings-config-dialog';
    const warning = draft.wuiOpenServer === false && original.wuiOpenServer !== false
      ? '<p class="settings-danger-note">WUIサーバーをOFFにすると、再起動後に接続不能になる可能性があります。</p>' : '';
    dialog.innerHTML = `<form method="dialog"><header><h2>設定変更の確認</h2><button value="cancel" aria-label="閉じる">×</button></header><p>次の設定変更を保存します。サービスは再起動しません。</p><div class="settings-change-list"></div><footer><button class="button" value="cancel">キャンセル</button><button class="button primary" value="default" type="button" data-save>保存</button></footer><p role="status"></p></form>`;
    const list = dialog.querySelector('.settings-change-list');
    list.innerHTML = warning;
    if (changes.some(change => change.key === 'wuiBlockGlobalAccess' && change.after === false)) {
      list.append(globalAccessWarning());
    }
    changes.forEach(change => {
      const row = document.createElement('div');
      row.innerHTML = '<strong></strong><span></span><span aria-hidden="true">→</span><span></span>';
      row.querySelector('strong').textContent = change.key === 'dropDetectionMode' ? FIELD.dropDetectionMode.label : change.key;
      const values = row.querySelectorAll('span');
      values[0].textContent = formatChangeValue(change.before, false, change.key);
      values[2].textContent = formatChangeValue(change.after, change.removed, change.key);
      list.append(row);
    });
    const button = dialog.querySelector('[data-save]');
    const status = dialog.querySelector('[role="status"]');
    button.addEventListener('click', async () => {
      button.disabled = true;
      status.textContent = '保存しています…';
      try {
        const saved = await saveConfig(saveDraft, controller.signal);
        original = cloneConfig(saved);
        draft = cloneConfig(saved);
        fieldErrors.clear();
        dialog.close();
        render();
        const message = container.querySelector('.settings-page-message');
        message.textContent = '設定を保存しました。必要なサービス再起動は自動では行いません。';
        message.hidden = false;
      } catch (error) {
        status.textContent = error.message;
        status.classList.add('is-error');
        button.disabled = false;
      }
    });
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    document.body.append(dialog);
    dialog.showModal();
  }

  function openDiscardDialog() {
    if (!configChanges(original, draft).length) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'settings-save-dialog settings-discard-dialog';
    dialog.innerHTML = '<form method="dialog"><header><h2>未保存の変更を破棄</h2><button value="cancel" aria-label="閉じる">×</button></header><p>最後に保存された設定値へ戻します。保存済みの設定は変更しません。</p><footer><button class="button" value="cancel">キャンセル</button><button class="button is-danger" value="default" type="button" data-discard>変更を破棄</button></footer></form>';
    dialog.querySelector('[data-discard]').addEventListener('click', () => {
      draft = cloneConfig(original);
      fieldErrors.clear();
      services = null;
      dialog.close();
      render();
    });
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    document.body.append(dialog);
    dialog.showModal();
  }

  function render() {
    dependentUpdates.length = 0;
    container.innerHTML = `<div class="settings-page"><div class="settings-intro"><div><h2>Chinachu設定</h2><p>Chinachuの接続先、録画、Storage、履歴、Web画面の動作を設定します。</p></div><span class="settings-change-count"></span></div><p class="settings-page-message" role="status" hidden></p><div class="settings-tabs" role="tablist" aria-label="設定カテゴリ"></div><div class="settings-content"></div><div class="settings-actions"><span>保存した設定は、必要なサービスを再起動した後に反映されます。</span><button class="button settings-discard" type="button">変更を破棄</button><button class="button primary settings-save" type="button">変更を確認して保存</button></div></div>`;
    const tabs = container.querySelector('.settings-tabs');
    const content = container.querySelector('.settings-content');
    TABS.forEach(([key, label]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.role = 'tab';
      button.textContent = label;
      button.dataset.tab = key;
      button.setAttribute('aria-selected', String(key === activeTab));
      button.addEventListener('click', () => {
        activeTab = key;
        tabs.querySelectorAll('[role="tab"]').forEach(item => item.setAttribute('aria-selected', String(item === button)));
        content.querySelectorAll('.settings-tab-panel').forEach(panel => { panel.hidden = panel.dataset.tab !== key; });
      });
      tabs.append(button);
    });
    content.append(createBasicTab(), createRecordingTab(), createStorageTab(), createHistoryTab(), createServicesTab(), createSeriesTab(), createAuthTab(), createAdvancedTab());
    container.querySelector('.settings-save').addEventListener('click', openSaveDialog);
    container.querySelector('.settings-discard').addEventListener('click', openDiscardDialog);
    dependentUpdates.forEach(update => update());
    updateStatus();
  }

  return () => {
    disposed = true;
    controller.abort();
    document.querySelectorAll('.settings-save-dialog').forEach(dialog => dialog.close());
  };
}
