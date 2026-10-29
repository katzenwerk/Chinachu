export const DROP_DETECTION_MODES = [
  { value: 'mirakurun', label: 'Mirakurun監視（標準）', description: 'MirakurunからDROP情報を取得する。' },
  { value: 'ts', label: 'TS解析（BETA）', description: '録画ストリームを解析し、CC不連続などを検出する。' },
  { value: 'both', label: '両方（BETA）', description: 'Mirakurun監視とTS解析を併用する。' },
  { value: 'off', label: '無効', description: 'DROP検出を行わない。' }
];

const KNOWN_KEYS = new Set([
  'uid', 'gid', 'mirakurunPath', 'recordedDir', 'recordedStorage', 'recordedDirs',
  'recordedFormat', 'recordedCommand', 'ffprobeCommand', 'recordedDurationProbeTimeoutMs',
  'recordedNameReplaceEnclosingCharacters', 'recordedNameEnclosingCharacterMap', 'normalizationForm',
  'vaapiEnabled', 'vaapiDevice', 'recordingPriority', 'conflictedPriority', 'handoffPrepSeconds', 'dropDetectionMode',
  'recordedStorageWakeupBeforeSec', 'storageLowSpaceWarningThresholdMB',
  'storageLowSpaceWarningIntervalMinutes', 'storageLowSpaceThresholdMB', 'storageLowSpaceAction',
  'storageLowSpaceCriticalNotifyIntervalMinutes', 'notificationCommand', 'matchRetentionDays',
  'reserves2RetentionDays', 'recordedHistoryRetentionDays', 'recordingResultCsvEnabled',
  'excludeServices', 'serviceOrder',
  'wuiOpenServer', 'wuiOpenHost', 'wuiOpenPort', 'wuiBlockGlobalAccess',
  'seriesUseSyobocal'
]);

export function cloneConfig(value) {
  return JSON.parse(JSON.stringify(value));
}

export function configForSave(config) {
  const result = cloneConfig(config);
  if (!Object.prototype.hasOwnProperty.call(result, 'wuiBlockGlobalAccess')) result.wuiBlockGlobalAccess = true;
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
  if (config.dropDetectionMode !== undefined && config.dropDetectionMode !== null &&
      !DROP_DETECTION_MODES.some(option => option.value === config.dropDetectionMode)) {
    errors.push('DROP検出方式をmirakurun、ts、both、offのいずれかから選び直してください。');
  }
  if (config.normalizationForm !== undefined && !['NFC', 'NFD', 'NFKC', 'NFKD'].includes(config.normalizationForm)) {
    errors.push('予約ルールの文字正規化が不正です。');
  }
  if (config.storageLowSpaceAction !== undefined && !['stop-new', 'stop', 'remove'].includes(config.storageLowSpaceAction)) {
    errors.push('容量不足時の処置が不正です。');
  }
  if (config.seriesUseSyobocal !== undefined && typeof config.seriesUseSyobocal !== 'boolean') {
    errors.push('seriesUseSyobocalは真偽値で指定してください。');
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
  if (key === 'dropDetectionMode') {
    if (value === null) return '（未指定・Mirakurun監視（標準））';
    const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
    const option = DROP_DETECTION_MODES.find(item => item.value === mode);
    return option ? option.label : `${JSON.stringify(value)}（不正値・Mirakurun監視（標準）で動作）`;
  }
  if (typeof value === 'string') return value === '' ? '（空文字）' : value;
  return JSON.stringify(value);
}
