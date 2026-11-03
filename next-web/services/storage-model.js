const UNAVAILABLE_LABELS = {
  'not-mounted': '未マウント',
  'wrong-storage': 'ストレージ不一致',
  'broken-link': 'リンク切れ',
  missing: 'パスなし',
  'read-only': '読み取り専用'
};

function isSafetyBlocked(storage) {
  return storage?.safetyBlocked === true || storage?.status === 'system-filesystem';
}

function storageCheckedAt(storage) {
  return isSafetyBlocked(storage) ? storage?.identityCheckedAt : storage?.capacityCheckedAt;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizePath(value) {
  const path = String(value || '').trim();
  if (!path) return '';
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

function formatCapacity(value, total) {
  if (!finite(value) || value < 0 || !finite(total) || total <= 0) return '未取得';
  const divisor = total >= 1e12 ? 1e12 : 1e9;
  return `${(value / divisor).toFixed(2)} ${divisor === 1e12 ? 'TB' : 'GB'}`;
}

function formatCapacityPair(used, total) {
  if (!finite(used) || !finite(total) || total <= 0) return '未取得';
  const divisor = total >= 1e12 ? 1e12 : 1e9;
  return `${(used / divisor).toFixed(2)} / ${(total / divisor).toFixed(2)} ${divisor === 1e12 ? 'TB' : 'GB'}`;
}

function formatThreshold(value) {
  if (!finite(value) || value <= 0) return '未設定';
  if (value >= 1024) return `${Math.round(value / 1024 * 10) / 10} GB`;
  return `${value} MB`;
}

function thresholdPosition(thresholdMB, total) {
  if (!finite(thresholdMB) || thresholdMB <= 0 || !finite(total) || total <= 0) return null;
  const thresholdBytes = thresholdMB * 1024 * 1024;
  if (!finite(thresholdBytes)) return null;
  return Math.max(0, Math.min(100, (1 - thresholdBytes / total) * 100));
}

function formatCheckedAt(value, options) {
  if (!value) return '未取得';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未取得' : date.toLocaleString('ja-JP', options);
}

function formatCheckedAgo(value, now = Date.now()) {
  const checkedAt = Number(value);
  if (!finite(checkedAt) || checkedAt <= 0 || !finite(now)) return '未取得';
  const elapsed = Math.max(0, now - checkedAt);
  if (elapsed < 60000) return '1分未満前';
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  return `${Math.floor(hours / 24)}日前`;
}

function validWarningThreshold(thresholds) {
  return thresholds?.warningEnabled === true &&
    finite(thresholds.warningMB) && finite(thresholds.cleanupMB) &&
    thresholds.warningMB > thresholds.cleanupMB;
}

export function classifyStorageState(storage, thresholds = {}) {
  if (isSafetyBlocked(storage)) {
    return {
      key: 'safety-error',
      label: '録画禁止',
      safetyCode: storage?.status === 'system-filesystem' ? 'system-filesystem' : 'storage-safety-unknown'
    };
  }
  const stale = storage?.status === 'stale' || storage?.capacityStale === true;
  const observedStatus = stale ? storage?.observedStatus : storage?.status;
  const observedPhase = stale ? storage?.observedLowSpacePhase : storage?.lowSpacePhase;
  if (observedStatus === 'low-space') {
    const warning = observedPhase === 'warning' && (stale || validWarningThreshold(thresholds));
    return {
      key: warning ? 'warning' : 'low',
      label: stale ? (warning ? 'Warning（参考値）' : 'Low（参考値）') : (warning ? 'Warning' : 'Low'),
      stale,
      observedPhase: warning ? 'warning' : 'low'
    };
  }
  if (storage.status === 'ok') return { key: 'normal', label: 'Normal' };
  if (stale) return { key: 'stale', label: '参考値', stale: true, observedPhase: 'normal' };
  if (storage.status === 'unobserved') return { key: 'unobserved', label: '未取得' };
  if (UNAVAILABLE_LABELS[storage.status]) return { key: 'unavailable', label: UNAVAILABLE_LABELS[storage.status] };
  return { key: 'error', label: '取得不可' };
}

function referenceCheckedText(storage, state, now) {
  const suffix = state.observedPhase === 'warning' ? '警告域' : state.observedPhase === 'low' ? 'Low域' : '参考値';
  return `最終確認：${formatCheckedAgo(storage.capacityCheckedAt, now)}（${suffix}）`;
}

function noteFor(storage, state, thresholds, now) {
  if (state.key === 'normal') return [];
  if (state.key === 'safety-error' && state.safetyCode === 'system-filesystem') {
    return [
      'システム領域への誤録画を検出しました。録画先がrootファイルシステムと同じため、録画を禁止しています。',
      'HDDのマウント状態を確認してください。',
      '録画禁止中'
    ];
  }
  if (state.key === 'safety-error') {
    return ['録画先のファイルシステムを安全に確認できないため、録画を禁止しています。', '録画禁止中'];
  }
  if (state.stale && state.key === 'warning') {
    return ['空き容量に注意してください。', referenceCheckedText(storage, state, now)];
  }
  if (state.stale && state.key === 'low') {
    return ['空き容量に注意してください。', referenceCheckedText(storage, state, now)];
  }
  if (state.key === 'warning') return ['空き容量に注意してください。'];
  if (state.key === 'low') {
    const notes = ['空き容量に注意してください。'];
    notes.push(thresholds.action === 'remove'
      ? storage.cleanupFallbackStopAll === true
        ? '削除できる録画ファイルがないため、対象filesystemの録画中番組も停止しています。'
        : '容量不足時は古い録画ファイルを削除する設定です。削除できない場合は録画中も停止します。'
      : thresholds.action === 'stop-new'
        ? '新規録画の開始を停止中です。録画中の番組は継続します。'
        : '対象filesystemの新規録画と録画中番組を停止する設定です。');
    if (storage.lowSpaceCurrent === true && storage.stopNewRecordings === true) {
      notes.push('容量不足により新規録画の開始を停止中');
    }
    return notes;
  }
  if (state.key === 'stale') return [];
  if (state.key === 'unobserved') return ['容量情報はまだ取得されていません。'];
  if (state.key === 'unavailable') return [`録画先を利用できません（${state.label}）。`];
  return ['Storage情報を取得できません。'];
}

function storageIds(storage) {
  return [storage.id].concat(storage.aliasIds || [], storage.recordedDirIds || [])
    .filter(value => value !== null && value !== undefined && String(value).trim() !== '')
    .map(value => String(value).trim());
}

function isDefaultStorage(storage) {
  return storage.id === null || storage.id === undefined || storage.isDefault === true;
}

function storageIdentity(storage) {
  if (isSafetyBlocked(storage)) {
    return String(storage?.id || storage?.configuredPath || storage?.path || storage?.name || 'unknown');
  }
  return String(storage?.filesystemId || storage?.expectedMount || storage?.resolvedPath ||
    storage?.configuredPath || storage?.path || storage?.id || storage?.name || 'unknown');
}

function issueForStorage(storage, thresholds, now = Date.now()) {
  const state = classifyStorageState(storage, thresholds);
  const name = String(storage?.name || storage?.id || 'Default');
  const base = {
    id: storageIdentity(storage),
    name,
    path: String(storage?.configuredPath || storage?.path || ''),
    state,
    href: '#storage',
    checkedAt: formatCheckedAt(storageCheckedAt(storage)),
    checkedAgo: formatCheckedAgo(storageCheckedAt(storage), now)
  };
  if (state.key === 'normal' || state.key === 'stale') return null;
  if (state.key === 'safety-error') {
    const systemFilesystem = state.safetyCode === 'system-filesystem';
    return {
      ...base,
      code: state.safetyCode,
      level: 'error',
      priority: 5,
      message: systemFilesystem
        ? '録画先エラー：録画を禁止しています'
        : '録画先の安全性を確認できないため、録画を禁止しています。',
      detail: systemFilesystem
        ? `${name} の録画先がシステム領域と同じファイルシステムになっています。HDDのマウント状態を確認してください。`
        : `${name} の録画先ファイルシステムを確認してください。`
    };
  }
  if (state.key === 'warning') {
    return {
      ...base,
      level: 'warning',
      priority: 2,
      message: state.stale
        ? '空き容量が警告閾値を下回っている可能性があります。'
        : '空き容量が少なくなっています。',
      detail: state.stale ? referenceCheckedText(storage, state, now) : `最終確認：${base.checkedAgo}`
    };
  }
  if (state.key === 'low') {
    return {
      ...base,
      level: 'low',
      priority: 3,
      message: state.stale
        ? '空き容量がLow閾値を下回っている可能性があります。'
        : '空き容量が不足しています。',
      detail: state.stale ? referenceCheckedText(storage, state, now) : `最終確認：${base.checkedAgo}`
    };
  }
  if (state.key === 'unavailable') {
    return { ...base, level: 'error', priority: 4, message: `録画先を利用できません（${state.label}）。`, detail: '' };
  }
  if (state.key === 'unobserved') {
    return { ...base, level: 'error', priority: 1, message: '容量情報はまだ取得されていません。', detail: '' };
  }
  return { ...base, level: 'error', priority: 1, message: 'ストレージ情報を取得できません。', detail: '' };
}

export function buildStorageWarnings(storageData, now = Date.now()) {
  if (!storageData || !Array.isArray(storageData.storages)) return [];
  const thresholds = storageData.thresholds || {};
  const byIdentity = new Map();
  storageData.storages.forEach(storage => {
    const issue = issueForStorage(storage, thresholds, now);
    if (issue === null) return;
    const current = byIdentity.get(issue.id);
    if (!current || issue.priority > current.priority) byIdentity.set(issue.id, issue);
  });
  return [...byIdentity.values()].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name, 'ja'));
}

function resolveReservationStorage(storageData, reservation) {
  const storages = Array.isArray(storageData?.storages) ? storageData.storages : [];
  const recordedDirId = typeof reservation?.recordedDirId === 'string'
    ? reservation.recordedDirId.trim()
    : '';
  const recordedDir = typeof reservation?.recordedDir === 'string'
    ? normalizePath(reservation.recordedDir)
    : '';

  if (recordedDirId) {
    const storage = storages.find(item => storageIds(item).includes(recordedDirId));
    if (storage) return { storage, unresolved: false };
    if (recordedDir) {
      const byPath = storages.find(item => normalizePath(item.configuredPath || item.path) === recordedDir);
      if (byPath) return { storage: byPath, unresolved: false };
    }
    return { storage: null, unresolved: true };
  }
  if (recordedDir) {
    const storage = storages.find(item => normalizePath(item.configuredPath || item.path) === recordedDir);
    return storage ? { storage, unresolved: false } : { storage: null, unresolved: true };
  }
  const storage = storages.find(isDefaultStorage) || null;
  return { storage, unresolved: storage === null };
}

function reservationStorageNotice(storage, thresholds, unresolved) {
  if (unresolved || storage === null) {
    return {
      strong: true,
      label: '録画先：確認不可',
      message: '録画先の状態を取得できません。',
      tooltip: '状態：確認不可\n録画先の状態を取得できません。'
    };
  }
  const issue = issueForStorage(storage, thresholds);
  if (issue === null) return null;
  let label = '録画先：確認不可';
  let message = issue.message;
  if (issue.state.key === 'safety-error') {
    label = '録画先：録画禁止';
  } else if (issue.state.key === 'warning') {
    label = '録画先：警告';
    message = issue.state.stale
      ? '空き容量が警告閾値を下回っている可能性があります。'
      : '録画先の空き容量が少なくなっています。';
  } else if (issue.state.key === 'low') {
    label = '録画先：容量不足';
    message = issue.state.stale
      ? '空き容量がLow閾値を下回っている可能性があります。'
      : (thresholds?.action === 'remove' && storage.cleanupFallbackStopAll !== true
        ? '録画先が容量不足です。自動削除を実行中です。'
        : thresholds?.action === 'stop-new'
          ? '録画先が容量不足のため、新規録画の開始を停止中です。'
          : '録画先が容量不足のため、録画停止・開始抑止の対象です。');
  }
  const tooltip = issue.state.key === 'warning' ? [
    '録画先の空き容量警告',
    `録画先：${issue.name}`,
    `空き容量：${formatCapacity(storage.available, storage.total)} / 警告閾値：${formatThreshold(thresholds.warningMB)}`,
    `確認日時：${formatCheckedAt(storage.capacityCheckedAt, {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    })}`
  ] : [
    `状態：${issue.state.label}`,
    `最終確認：${issue.checkedAgo}`,
    message
  ];
  if (issue.state.stale) {
    tooltip.push('※ 空き容量は前回の録画時、または手動更新時の参考値です。');
  }
  return {
    strong: issue.priority >= 3,
    label,
    message,
    tooltip: tooltip.join('\n')
  };
}

export function buildReservationStorageDisplay(storageData, reservation) {
  if (!storageData || !Array.isArray(storageData.storages)) {
    return { tag: null, notice: null };
  }
  const resolved = resolveReservationStorage(storageData, reservation);
  return {
    tag: storageData.storages.length > 1 && resolved.storage !== null
      ? { key: 'storage', label: String(resolved.storage.name || resolved.storage.id || 'Default') }
      : null,
    notice: reservationStorageNotice(resolved.storage, storageData.thresholds || {}, resolved.unresolved)
  };
}

export function buildRecordingStorageDisplay(storageData, recording) {
  if (!storageData || !Array.isArray(storageData.storages)) return { notice: null };
  const recordedPath = typeof recording?.recorded === 'string' ? normalizePath(recording.recorded) : '';
  if (!recordedPath) return { notice: null };
  const storage = storageData.storages
    .map(item => ({ item, path: normalizePath(item.configuredPath || item.path) }))
    .filter(candidate => candidate.path &&
      (recordedPath === candidate.path ||
        (candidate.path === '/' ? recordedPath.startsWith('/') : recordedPath.startsWith(`${candidate.path}/`))))
    .sort((a, b) => b.path.length - a.path.length)[0]?.item || null;
  if (storage === null) return { notice: null };
  return { notice: reservationStorageNotice(storage, storageData.thresholds || {}, false) };
}

export function itemMatchesStorage(item, storage, allowRecordedPath) {
  if (!storage) return false;
  const ids = storageIds(storage);
  const itemId = typeof item.recordedDirId === 'string' ? item.recordedDirId.trim() : '';
  const itemPath = allowRecordedPath ? normalizePath(item.recordedDir) : '';
  const storagePath = normalizePath(storage.path || storage.configuredPath);

  if (itemPath) return itemPath === storagePath;
  if (itemId) return ids.includes(itemId);
  return isDefaultStorage(storage);
}

function filterToken(storage) {
  if (storage.id !== null && storage.id !== undefined && String(storage.id).trim()) {
    return `id:${String(storage.id).trim()}`;
  }
  return `path:${normalizePath(storage.path || storage.configuredPath)}`;
}

export function resolveStorageFilter(storageData, token) {
  return (storageData?.storages || []).find(storage => {
    if (token?.startsWith('id:')) return storageIds(storage).includes(token.slice(3));
    if (token?.startsWith('path:')) return normalizePath(storage.path || storage.configuredPath) === normalizePath(token.slice(5));
    return false;
  }) || null;
}

export function resolveRecordedStorage(storageData, item) {
  const storages = storageData?.storages || [];
  const normalize = value => {
    const path = normalizePath(value);
    if (!path) return '';
    const parts = [];
    path.split('/').forEach(part => {
      if (!part || part === '.') return;
      if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
      else if (part !== '..' || !path.startsWith('/')) parts.push(part);
    });
    return `${path.startsWith('/') ? '/' : ''}${parts.join('/')}` || '.';
  };
  let recordedPath = normalize(item?.storageRecordingPath || item?.recordingPath);
  // A historical result without a saved destination must not inherit today's default.
  if (!recordedPath) return null;
  const contains = (root, path) => root && (path === root ||
    (root === '.' ? !path.startsWith('/') && path !== '..' && !path.startsWith('../')
      : path.startsWith(root === '/' ? '/' : `${root}/`)));
  if (!recordedPath.startsWith('/')) {
    // Storage API supplies the absolute form of each configured relative root.
    const relativeRoot = storages.map(storage => ({ path: normalize(storage.configuredPath), absolute: normalize(storage.path) }))
      .filter(root => root.path && !root.path.startsWith('/') && root.absolute.startsWith('/') && contains(root.path, recordedPath))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (relativeRoot) recordedPath = normalize(`${relativeRoot.absolute}/${relativeRoot.path === '.' ? recordedPath : recordedPath.slice(relativeRoot.path.length)}`);
  }
  return storages.flatMap(storage => [...new Set([storage.path, storage.configuredPath].map(normalize))]
    .map(path => ({ storage, path })))
    .filter(candidate => contains(candidate.path, recordedPath))
    .sort((a, b) => b.path.length - a.path.length)[0]?.storage || null;
}

export function buildStorageViewModels(resources, now = Date.now()) {
  const thresholds = resources.storage.thresholds || {};
  const recordedCounts = new Map();
  (resources.recordedResults || []).forEach(item => {
    const storage = resolveRecordedStorage(resources.storage, item);
    if (storage) recordedCounts.set(storage, (recordedCounts.get(storage) || 0) + 1);
  });
  return resources.storage.storages.map(storage => {
    const state = classifyStorageState(storage, thresholds);
    const reliable = storage.capacityReliable === true && finite(storage.total) && storage.total > 0;
    const used = reliable && finite(storage.used) ? storage.used : null;
    const available = reliable && finite(storage.available) ? storage.available : null;
    const percent = reliable && available !== null
      ? Math.max(0, Math.min(100, (storage.total - available) / storage.total * 100))
      : null;
    const rules = resources.rules.filter(rule => itemMatchesStorage(rule, storage, false));
    const reserves = resources.reserves.filter(reserve => itemMatchesStorage(reserve, storage, true));
    const token = filterToken(storage);
    const warningThresholdValid = thresholds.warningEnabled === true &&
      finite(thresholds.warningMB) && thresholds.warningMB > 0;
    const lowThresholdValid = storage.lowStorageManaged !== false &&
      finite(thresholds.cleanupMB) && thresholds.cleanupMB > 0;
    const warningMarker = reliable && warningThresholdValid
      ? thresholdPosition(thresholds.warningMB, storage.total)
      : null;
    const lowMarker = reliable && lowThresholdValid
      ? thresholdPosition(thresholds.cleanupMB, storage.total)
      : null;

    return {
      id: token,
      refreshStorageId: storage.id ?? null,
      name: String(storage.name || storage.id || 'Default'),
      path: String(storage.configuredPath || storage.path || ''),
      state,
      free: reliable ? formatCapacity(available, storage.total) : '未取得',
      usagePercent: percent === null ? null : percent.toFixed(1),
      usage: reliable ? formatCapacityPair(used, storage.total) : '未取得',
      warningThreshold: warningThresholdValid ? formatThreshold(thresholds.warningMB) : null,
      lowThreshold: storage.lowStorageManaged === false ? '対象外' : formatThreshold(thresholds.cleanupMB),
      warningMarker,
      lowMarker,
      thresholdMarkersClose: warningMarker !== null && lowMarker !== null && Math.abs(warningMarker - lowMarker) < 1.5,
      checkedAt: formatCheckedAt(storageCheckedAt(storage)),
      checkedAgo: formatCheckedAgo(storageCheckedAt(storage), now),
      notes: noteFor(storage, state, thresholds, now),
      ruleCount: rules.length,
      reserveCount: reserves.length,
      recordedCount: recordedCounts.get(storage) || 0,
      ruleHref: `#rules?storage=${encodeURIComponent(token)}`,
      reserveHref: `#reserves?storage=${encodeURIComponent(token)}`,
      recordedHref: `#recorded?storage=${encodeURIComponent(token)}&results=recorded`
    };
  });
}
