import { loadConfig, loadMirakurunServices, loadRuntimeMode, saveConfig } from '../services/config-client.js';
import {
  DROP_DETECTION_MODES,
  cloneConfig,
  configChanges,
  formatChangeValue,
  normalizeRecordedDirs,
  parseFieldValue,
  setConfigValue,
  unknownConfigKeys,
  updateRecordedStorageRootProtection,
  validateConfig
} from '../services/config-model.js';

const TABS = [
  ['basic', '基本設定'], ['recording', '録画設定'], ['storage', 'Storage'],
  ['history', '履歴管理'], ['services', 'サービス'], ['advanced', '詳細設定']
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
  wuiOpenHost: { label: '待受アドレス', type: 'text', empty: 'null' },
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
  let activeTab = 'basic';
  let services = null;
  const fieldErrors = new Map();
  const dependentUpdates = [];

  container.innerHTML = '<section class="panel settings-loading">設定を読み込んでいます…</section>';

  Promise.all([loadConfig(controller.signal), loadRuntimeMode(controller.signal)]).then(([config, mode]) => {
    if (disposed) return;
    original = cloneConfig(config);
    draft = cloneConfig(config);
    runtimeMode = mode;
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
    const wui = card('WUI公開サーバー', 'ほかの端末からChinachuのWeb画面へアクセスするためのHTTPサーバーです。家庭内LANなど、信頼できるネットワークで使用してください。');
    const open = bindBoolean('wuiOpenServer', 'WUI公開サーバー', 'ほかの端末からWeb画面へアクセスできるようにします。OFFにしてWUIを再起動すると、ブラウザから接続できなくなる場合があります。');
    const host = bindValueField('wuiOpenHost', 'Web画面への接続を受け付けるネットワークアドレスです。未指定時は利用可能なプライベートIPv4アドレスを自動選択します。', { wide: true });
    const port = bindValueField('wuiOpenPort', 'Web画面への接続に使用するポート番号です。変更するとブラウザでアクセスするURLも変わります。', { compact: true, placeholder: '例: 20772' });
    dependentUpdates.push(() => {
      [host, port].forEach(field => { field.input.disabled = draft.wuiOpenServer !== true; field.wrap.classList.toggle('is-disabled', field.input.disabled); });
    });
    const wuiGrid = document.createElement('div');
    wuiGrid.className = 'settings-fields';
    wuiGrid.append(host.wrap, port.wrap);
    wui.body.append(open.wrap, wuiGrid);

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
    const errors = [...fieldErrors.values(), ...validateConfig(draft)];
    if (errors.length) {
      window.alert(`入力内容を確認してください。\n\n${[...new Set(errors)].join('\n')}`);
      return;
    }
    const changes = configChanges(original, draft);
    if (!changes.length) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'settings-save-dialog';
    const warning = draft.wuiOpenServer === false && original.wuiOpenServer !== false
      ? '<p class="settings-danger-note">WUI公開サーバーをOFFにすると、再起動後に接続不能になる可能性があります。</p>' : '';
    dialog.innerHTML = `<form method="dialog"><header><h2>設定変更の確認</h2><button value="cancel" aria-label="閉じる">×</button></header>${warning}<p>次の設定変更を保存します。サービスは再起動しません。</p><div class="settings-change-list"></div><footer><button class="button" value="cancel">キャンセル</button><button class="button primary" value="default" type="button" data-save>保存</button></footer><p role="status"></p></form>`;
    const list = dialog.querySelector('.settings-change-list');
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
        const saved = await saveConfig(draft, controller.signal);
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
    content.append(createBasicTab(), createRecordingTab(), createStorageTab(), createHistoryTab(), createServicesTab(), createAdvancedTab());
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
