export const DROP_DETECTION_MODES = [
  { value: 'mirakurun', label: 'Mirakurun監視（標準）', description: 'MirakurunからDROP情報を取得する。' },
  { value: 'file', label: 'TSファイル解析', description: '録画完了後に保存TSを低優先度で自動解析する。' },
  { value: 'mirakurun-file', label: '両方', description: 'Mirakurun監視と録画後の保存TS解析を併用する。' },
  { value: 'off', label: '無効', description: 'DROP検出を行わない。' }
];

const KNOWN_KEYS = new Set([
  'externalNotifications', 'uid', 'gid', 'mirakurunPath', 'recordedDir', 'recordedStorage', 'recordedDirs',
  'recordedFormat', 'recordedCommand', 'recordedCommandSerial', 'ffprobeCommand', 'recordedDurationProbeTimeoutMs',
  'recordedThumbnailAutoEnabled', 'recordingFilenamePrefixEnabled', 'recordedFolderOrganizeEnabled', 'recordedFolderOrganizeOrder',
  'recordedNameReplaceEnclosingCharacters', 'recordedNameEnclosingCharacterMap', 'normalizationForm',
  'vaapiEnabled', 'vaapiDevice', 'recordingBoundaryPolicy', 'recordingPriority', 'conflictedPriority', 'handoffPrepSeconds', 'dropDetectionMode', 'autoTsMaxRecordings',
  'recordedStorageWakeupBeforeSec', 'storageLowSpaceWarningThresholdMB',
  'storageLowSpaceWarningIntervalMinutes', 'storageLowSpaceThresholdMB', 'storageLowSpaceAction',
  'storageLowSpaceCriticalNotifyIntervalMinutes', 'notificationCommand', 'matchRetentionDays',
  'reserves2RetentionDays', 'recordedHistoryRetentionDays', 'recordingResultCsvEnabled',
  'excludeServices', 'serviceOrder',
  'wuiOpenServer', 'wuiOpenHost', 'wuiOpenPort', 'wuiBlockGlobalAccess',
  'broadcastClockEnabled', 'broadcastClockIntervalHours', 'broadcastClockGrChannel',
  'seriesUseSyobocal'
]);

export function cloneConfig(value) {
  return JSON.parse(JSON.stringify(value));
}

const HISTORY_RETENTION_KEYS = ['matchRetentionDays', 'reserves2RetentionDays', 'recordedHistoryRetentionDays'];

// Match the existing backend effective values without materializing defaults.
export function historyRetentionValues(config) {
  return HISTORY_RETENTION_KEYS.map(key => {
    const value = Math.floor(Number(config[key]));
    return { key, days: Number.isFinite(value) && value >= 0 ? value : 365 };
  });
}

export function setHistoryRetentionDays(config, days) {
  if (!Number.isInteger(days) || days < 0) throw new Error('履歴の保持期間は0以上の整数で指定してください。');
  HISTORY_RETENTION_KEYS.forEach(key => { config[key] = days; });
}

export function configForSave(config) {
  const result = cloneConfig(config);
  if (!Object.prototype.hasOwnProperty.call(result, 'wuiBlockGlobalAccess')) result.wuiBlockGlobalAccess = true;
  if (!Object.prototype.hasOwnProperty.call(result, 'recordedCommandSerial')) result.recordedCommandSerial = true;
  if (!Object.prototype.hasOwnProperty.call(result, 'recordedThumbnailAutoEnabled')) result.recordedThumbnailAutoEnabled = true;
  if (!Object.prototype.hasOwnProperty.call(result, 'seriesUseSyobocal')) result.seriesUseSyobocal = true;
  return result;
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function configChanges(original, draft) {
  const keys = new Set([...Object.keys(original || {}), ...Object.keys(draft || {})]);
  return [...keys].filter(key => !sameValue(original?.[key], draft?.[key])).sort().map(key => ({
    key,
    before: original?.[key],
    after: draft?.[key],
    removed: !Object.prototype.hasOwnProperty.call(draft || {}, key)
  }));
}

const enabled = value => value === true;
const defaultOn = value => value !== false;
const positive = fallback => value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
const storageSettings = value => ({ ...(value || {}), protectRootFilesystem: value?.protectRootFilesystem === true });
const application = (targets, effective = value => value) => ({ targets, effective });
// Operator/WUI hold config.json at startup (including the WUI API sandbox).
// Scheduler, reservation-store and app-matching read it for each execution;
// external-notification reads its separate settings for each notification.
const CONFIG_APPLICATION = {
  uid: application(['operator', 'wui']), gid: application(['operator', 'wui']),
  mirakurunPath: application(['operator', 'wui', 'scheduler', 'history'], (value, config) => value || config.schedulerMirakurunPath || 'http+unix://%2Fvar%2Frun%2Fmirakurun.sock/'),
  recordedDir: application(['operator', 'wui', 'history']),
  recordedStorage: application(['operator', 'wui', 'history'], storageSettings),
  recordedDirs: application(['operator', 'wui', 'scheduler', 'history'], value => (value || []).map(item => ({ ...item, storage: storageSettings(item.storage) }))),
  recordedFormat: application(['operator', 'history']),
  recordedCommand: application(['operator'], value => value || ''),
  recordedCommandSerial: application(['operator'], defaultOn),
  ffprobeCommand: application(['operator'], value => typeof value === 'string' && value.trim() || 'ffprobe'),
  recordedDurationProbeTimeoutMs: application(['operator'], value => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.min(Math.floor(Number(value)), 0x7fffffff) : 8000),
  recordedThumbnailAutoEnabled: application(['operator'], defaultOn),
  recordingFilenamePrefixEnabled: application(['operator'], enabled),
  recordedFolderOrganizeEnabled: application(['operator', 'wui'], enabled),
  recordedFolderOrganizeOrder: application(['operator'], value => value || 'filename'),
  recordedNameReplaceEnclosingCharacters: application(['operator'], (value, config) => value === true || config.needToReplaceEnclosingCharacters === true),
  recordedNameEnclosingCharacterMap: application(['operator'], value => value || null),
  normalizationForm: application(['wui', 'scheduler', 'history'], value => value || null),
  vaapiEnabled: application(['wui'], enabled),
  vaapiDevice: application(['wui'], (value, config) => config.vaapiEnabled === true ? value || '/dev/dri/renderD128' : null),
  recordingBoundaryPolicy: application(['operator'], value => value === 'start' ? 'start' : 'end'),
  recordingPriority: application(['operator'], value => value || 2),
  conflictedPriority: application(['operator'], value => value || 1),
  handoffPrepSeconds: application(['operator'], value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.min(Number(value), 60) : 20),
  dropDetectionMode: application(['operator'], value => {
    const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return ['mirakurun', 'ts', 'both', 'file', 'mirakurun-file', 'off'].includes(mode) ? mode : 'mirakurun';
  }),
  autoTsMaxRecordings: application(['operator'], value => Number.isInteger(value) && value >= 0 ? value : 0),
  recordedStorageWakeupBeforeSec: application(['operator'], value => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.floor(Number(value)) : 0),
  storageLowSpaceThresholdMB: application(['operator', 'wui'], positive(3000)),
  storageLowSpaceWarningThresholdMB: application(['operator', 'wui'], positive(null)),
  storageLowSpaceWarningIntervalMinutes: application(['operator', 'wui'], positive(180)),
  storageLowSpaceCriticalNotifyIntervalMinutes: application(['operator', 'wui'], positive(180)),
  storageLowSpaceAction: application(['operator', 'wui'], value => ['remove', 'stop-new'].includes(value) ? value : 'stop'),
  notificationCommand: application(['operator'], value => value || null),
  ...Object.fromEntries(HISTORY_RETENTION_KEYS.map(key => [key, application(['history'], value => {
    const days = Math.floor(Number(value));
    return Number.isFinite(days) && days >= 0 ? days : 365;
  })])),
  recordingResultCsvEnabled: application(['history'], enabled),
  excludeServices: application(['scheduler'], value => value || []),
  serviceOrder: application(['scheduler'], value => value || []),
  wuiOpenServer: application(['wui'], enabled),
  wuiOpenHost: application(['wui'], value => value || null),
  wuiOpenPort: application(['wui'], value => value || 20772),
  wuiBlockGlobalAccess: application(['wui'], defaultOn),
  broadcastClockEnabled: application(['operator'], enabled),
  broadcastClockIntervalHours: application(['operator'], value => [3, 6, 12, 24].includes(Number(value)) ? Number(value) : 3),
  broadcastClockGrChannel: application(['operator'], value => typeof value === 'string' && value.trim() || null),
  seriesUseSyobocal: application(['wui'], defaultOn),
  externalNotifications: application(['immediate'])
};

export function configApplicationEffects(before, after) {
  const effects = { operator: false, wui: false, scheduler: false, history: false, immediate: false, connectionChanged: false, unknown: [] };
  for (const change of configChanges(before, after)) {
    const entry = CONFIG_APPLICATION[change.key];
    if (!entry) { effects.unknown.push(change.key); continue; }
    if (sameValue(entry.effective(change.before, before), entry.effective(change.after, after))) continue;
    entry.targets.forEach(target => { effects[target] = true; });
    if (['wuiOpenServer', 'wuiOpenHost', 'wuiOpenPort', 'wuiBlockGlobalAccess'].includes(change.key)) effects.connectionChanged = true;
  }
  return effects;
}

export function configApplicationMessages(effects) {
  const messages = [];
  if (effects.operator && effects.wui) messages.push('Operator・WUIの再起動が必要です。WUIだけを再起動しても、Operator側の変更は反映されません。');
  else if (effects.operator) messages.push('Operatorの再起動が必要です。');
  else if (effects.wui) messages.push('WUIの再起動が必要です。');
  const prefix = effects.operator || effects.wui ? '' : '再起動不要：';
  if (effects.scheduler) messages.push(`${prefix}次回Scheduler実行時に反映されます。`);
  if (effects.history) messages.push(`${prefix}次回履歴・照合処理時に反映されます。`);
  if (effects.connectionChanged) messages.push('待受IP・ポート・アクセス制限の変更により、WUI再起動後は現在のURLで接続できなくなる可能性があります。');
  if (effects.unknown.length) messages.push(`反映条件を確認できない設定：${effects.unknown.join(', ')}`);
  return messages;
}

export function unknownConfigKeys(config) {
  return Object.keys(config || {}).filter(key => !KNOWN_KEYS.has(key)).sort();
}

export function setConfigValue(config, key, value, options = {}) {
  if (options.remove === true) delete config[key]; else config[key] = value;
  return config;
}

export function parseFieldValue(raw, definition) {
  const value = String(raw ?? '');
  if (value === '') {
    if (definition.required) return { error: `${definition.label}は必須です。` };
    if (definition.empty === 'null') return { value: null };
    if (definition.empty === 'string') return { value: '' };
    return { remove: true };
  }
  if (definition.type === 'number') {
    const number = Number(value);
    if (!Number.isFinite(number)) return { error: `${definition.label}は数値で指定してください。` };
    if (definition.integer && !Number.isInteger(number)) return { error: `${definition.label}は整数で指定してください。` };
    if (definition.min !== undefined && number < definition.min) return { error: `${definition.label}は${definition.min}以上で指定してください。` };
    if (definition.exclusiveMin !== undefined && number <= definition.exclusiveMin) return { error: `${definition.label}は${definition.exclusiveMin}より大きい値で指定してください。` };
    return { value: number };
  }
  if (definition.type === 'json') {
    try {
      const parsed = JSON.parse(value);
      if (definition.jsonType === 'object' && (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')) {
        return { error: `${definition.label}はJSONオブジェクトで指定してください。` };
      }
      return { value: parsed };
    } catch (_) {
      return { error: `${definition.label}は正しいJSONで指定してください。` };
    }
  }
  if (definition.type === 'command' && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(item => typeof item !== 'string')) {
        return { error: `${definition.label}のJSON配列は1個以上の文字列で指定してください。` };
      }
      return { value: parsed };
    } catch (_) {
      return { error: `${definition.label}は実行ファイルのパスまたは正しいJSON配列で指定してください。` };
    }
  }
  return { value };
}

export function updateRecordedStorage(config, expectedMount) {
  const storage = config.recordedStorage && typeof config.recordedStorage === 'object' && !Array.isArray(config.recordedStorage)
    ? cloneConfig(config.recordedStorage) : {};
  if (expectedMount === '') delete storage.expectedMount; else storage.expectedMount = expectedMount;
  if (Object.keys(storage).length === 0) delete config.recordedStorage; else config.recordedStorage = storage;
}

export function updateRecordedStorageRootProtection(config, enabled) {
  const storage = config.recordedStorage && typeof config.recordedStorage === 'object' && !Array.isArray(config.recordedStorage)
    ? cloneConfig(config.recordedStorage) : {};
  storage.protectRootFilesystem = enabled === true;
  config.recordedStorage = storage;
}

export function normalizeRecordedDirs(rows) {
  const ids = new Set();
  const errors = [];
  const result = [];
  rows.forEach((row, index) => {
    const no = index + 1;
    const item = cloneConfig(row.original || {});
    const id = String(row.id || '').trim();
    const name = String(row.name || '').trim();
    const path = String(row.path || '').trim();
    const protectRootFilesystem = row.protectRootFilesystem === true;
    if (!id && !name && !path && !protectRootFilesystem) return;
    if (!id || !name || !path) errors.push(`追加録画先 ${no} はID・表示名・パスをすべて入力してください。`);
    if (id && !/^[A-Za-z0-9_-]+$/.test(id)) errors.push(`追加録画先 ${no} のIDは英数字・ハイフン・アンダースコアで指定してください。`);
    if (ids.has(id)) errors.push(`追加録画先のIDが重複しています: ${id}`); else if (id) ids.add(id);
    item.id = id;
    item.name = name;
    item.path = path;
    const storage = item.storage && typeof item.storage === 'object' && !Array.isArray(item.storage) ? cloneConfig(item.storage) : {};
    if (protectRootFilesystem) storage.protectRootFilesystem = true;
    else if (Object.prototype.hasOwnProperty.call(storage, 'protectRootFilesystem')) storage.protectRootFilesystem = false;
    if (Object.keys(storage).length) item.storage = storage; else delete item.storage;
    result.push(item);
  });
  return { value: result, errors };
}

export function validateConfig(config) {
  const errors = [];
  if (typeof config.recordedDir !== 'string' || config.recordedDir.trim() === '') errors.push('デフォルト録画先は必須です。');
  if (config.recordingBoundaryPolicy !== undefined && !['start', 'end'].includes(config.recordingBoundaryPolicy)) {
    errors.push('録画境界の優先方針が不正です。');
  }
  if (config.dropDetectionMode !== undefined && config.dropDetectionMode !== null &&
      !DROP_DETECTION_MODES.some(option => option.value === config.dropDetectionMode) &&
      !['ts', 'both'].includes(config.dropDetectionMode)) {
    errors.push('DROP検出方式の設定値が不正です。');
  }
  if (config.autoTsMaxRecordings !== undefined && (!Number.isInteger(config.autoTsMaxRecordings) || config.autoTsMaxRecordings < 0)) {
    errors.push('自動TS解析の許可録画本数は0以上の整数で指定してください。');
  }
  if (config.normalizationForm !== undefined && !['NFC', 'NFD', 'NFKC', 'NFKD'].includes(config.normalizationForm)) {
    errors.push('予約ルールの文字正規化が不正です。');
  }
  if (config.storageLowSpaceAction !== undefined && !['stop-new', 'stop', 'remove'].includes(config.storageLowSpaceAction)) {
    errors.push('容量不足時の処置が不正です。');
  }
  if (config.broadcastClockEnabled !== undefined && typeof config.broadcastClockEnabled !== 'boolean') {
    errors.push('broadcastClockEnabledは真偽値で指定してください。');
  }
  if (config.seriesUseSyobocal !== undefined && typeof config.seriesUseSyobocal !== 'boolean') {
    errors.push('seriesUseSyobocalは真偽値で指定してください。');
  }
  if (config.recordedCommandSerial !== undefined && typeof config.recordedCommandSerial !== 'boolean') {
    errors.push('録画後コマンドの直列実行は真偽値で指定してください。');
  }
  if (config.recordedThumbnailAutoEnabled !== undefined && typeof config.recordedThumbnailAutoEnabled !== 'boolean') {
    errors.push('サムネイル自動作成は真偽値で指定してください。');
  }
  if (config.recordedFolderOrganizeEnabled !== undefined && typeof config.recordedFolderOrganizeEnabled !== 'boolean') {
    errors.push('recordedFolderOrganizeEnabledは真偽値で指定してください。');
  }
  if (config.recordedFolderOrganizeOrder !== undefined && !['filename', 'title', 'history'].includes(config.recordedFolderOrganizeOrder)) {
    errors.push('録画フォルダ振り分けの優先順位が不正です。');
  }
  if (config.broadcastClockIntervalHours !== undefined && ![3, 6, 12, 24].includes(config.broadcastClockIntervalHours)) {
    errors.push('broadcastClockIntervalHoursは3、6、12、24のいずれかで指定してください。');
  }
  if (config.broadcastClockGrChannel !== undefined && config.broadcastClockGrChannel !== null &&
      (typeof config.broadcastClockGrChannel !== 'string' || config.broadcastClockGrChannel.trim() === '')) {
    errors.push('broadcastClockGrChannelはnullまたは空でない文字列で指定してください。');
  }
  const nonNegativeIntegers = ['recordedStorageWakeupBeforeSec', 'matchRetentionDays', 'reserves2RetentionDays', 'recordedHistoryRetentionDays'];
  nonNegativeIntegers.forEach(key => {
    if (config[key] !== undefined && (!Number.isInteger(config[key]) || config[key] < 0)) errors.push(`${key}は0以上の整数で指定してください。`);
  });
  ['storageLowSpaceThresholdMB', 'storageLowSpaceWarningIntervalMinutes', 'storageLowSpaceCriticalNotifyIntervalMinutes'].forEach(key => {
    if (config[key] !== undefined && (!Number.isFinite(config[key]) || config[key] <= 0)) errors.push(`${key}は0より大きい数値で指定してください。`);
  });
  if (config.storageLowSpaceWarningThresholdMB !== undefined &&
      (!Number.isFinite(config.storageLowSpaceWarningThresholdMB) || config.storageLowSpaceWarningThresholdMB < 0)) {
    errors.push('storageLowSpaceWarningThresholdMBは0以上の数値で指定してください。');
  }
  if (Array.isArray(config.recordedDirs)) {
    const normalized = normalizeRecordedDirs(config.recordedDirs.map(item => ({
      original: item, id: item?.id, name: item?.name, path: item?.path,
      protectRootFilesystem: item?.storage?.protectRootFilesystem === true
    })));
    errors.push(...normalized.errors);
  } else if (config.recordedDirs !== undefined) {
    errors.push('recordedDirsは配列である必要があります。');
  }
  ['excludeServices', 'serviceOrder'].forEach(key => {
    if (config[key] !== undefined && (!Array.isArray(config[key]) || config[key].some(id => !Number.isFinite(Number(id))))) {
      errors.push(`${key}はサービスIDの配列で指定してください。`);
    }
  });
  return errors;
}

export function formatChangeValue(value, removed = false, key) {
  if (removed) return '（未指定へ変更）';
  if (value === undefined) return '（未指定）';
  if (key === 'externalNotifications') {
    const publicValue = configPreview({ externalNotifications: value }).externalNotifications;
    const hasSecrets = Object.values(value.routes).some(route => ['webhook', 'token', 'user', 'password'].some(key => route[key]));
    return JSON.stringify(publicValue) + (hasSecrets ? '（接続情報の変更あり）' : '');
  }
  if (key === 'dropDetectionMode') {
    if (value === null) return '（未指定・Mirakurun監視（標準））';
    const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
    const option = DROP_DETECTION_MODES.find(item => item.value === mode);
    return option ? option.label : `${JSON.stringify(value)}（不正値・Mirakurun監視（標準）で動作）`;
  }
  if (typeof value === 'string') return value === '' ? '（空文字）' : value;
  return JSON.stringify(value);
}

export function configPreview(config) {
  const result = cloneConfig(config);
  if (result.externalNotifications) {
    for (const route of Object.values(result.externalNotifications.routes)) {
      for (const key of ['webhook', 'token', 'user', 'password']) delete route[key];
    }
  }
  return result;
}
