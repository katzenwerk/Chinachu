const MB_PER_GB = 1024;
const CLEANUP_KEY = 'storageLowSpaceThresholdGB';
const WARNING_KEY = 'storageLowSpaceWarningThresholdGB';

export const STORAGE_THRESHOLD_LEGACY_KEYS = Object.freeze({
  [CLEANUP_KEY]: 'storageLowSpaceThresholdMB',
  [WARNING_KEY]: 'storageLowSpaceWarningThresholdMB'
});

export function isStorageThresholdGB(key, value) {
  return Number.isFinite(value) && Number.isFinite(value * MB_PER_GB) && Number.isInteger(value * 10) &&
    (value > 0 || (key === WARNING_KEY && value === 0));
}

function resolveThreshold(config, key, fallback) {
  const inGB = Object.hasOwn(config, key);
  const source = inGB ? key : STORAGE_THRESHOLD_LEGACY_KEYS[key];
  if (!Object.hasOwn(config, source)) return { mb: fallback };
  const value = config[source];
  const valid = inGB ? isStorageThresholdGB(key, value) :
    Number.isFinite(value) && (value > 0 || (key === WARNING_KEY && value === 0));
  if (!valid) return { mb: fallback, invalidKey: source };
  return { mb: value === 0 ? fallback : inGB ? value * MB_PER_GB : value };
}

export function resolveStorageThresholds(config) {
  config ||= {};
  // Keep legacy values in MB at their original precision until settings are saved.
  const cleanup = resolveThreshold(config, CLEANUP_KEY, 3 * MB_PER_GB);
  const warning = resolveThreshold(config, WARNING_KEY, null);
  const legacyWarningDisabled = config.storageLowSpaceWarningEnabled === false;
  return {
    cleanupThresholdMB: cleanup.mb,
    warningThresholdMB: warning.mb,
    warningEnabled: !legacyWarningDisabled && warning.mb !== null && warning.mb > cleanup.mb,
    legacyWarningDisabled,
    invalidCleanupKey: cleanup.invalidKey,
    invalidWarningKey: warning.invalidKey
  };
}

export function migrateStorageThresholds(config) {
  const result = { ...config };
  for (const [key, legacyKey] of Object.entries(STORAGE_THRESHOLD_LEGACY_KEYS)) {
    if (!Object.hasOwn(config, legacyKey)) continue;
    delete result[legacyKey];
    if (Object.hasOwn(config, key)) continue;
    const { mb } = resolveThreshold(config, key, null);
    if (mb !== null) result[key] = Math.ceil(mb / MB_PER_GB * 10) / 10;
    else if (key === WARNING_KEY && config[legacyKey] === 0) result[key] = 0;
  }
  // Rounding can collapse two legacy thresholds that previously enabled warnings.
  if (!Object.hasOwn(config, WARNING_KEY) && !Object.hasOwn(config, CLEANUP_KEY) &&
      result[WARNING_KEY] !== undefined && result[WARNING_KEY] === result[CLEANUP_KEY] &&
      resolveStorageThresholds(config).warningEnabled) {
    result[WARNING_KEY] = (result[WARNING_KEY] * 10 + 1) / 10;
  }
  return result;
}

export function formatStorageGB(valueMB, fractionDigits) {
  const gb = valueMB / MB_PER_GB;
  return `${fractionDigits === undefined ? gb : gb.toFixed(fractionDigits)} GB`;
}
