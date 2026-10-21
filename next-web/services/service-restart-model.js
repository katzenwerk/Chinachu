export function serviceGeneration(target) {
  return {
    pid: target?.pid ?? null,
    restartCount: target?.restartCount,
    startedAt: target?.startedAt
  };
}

export function serviceGenerationChanged(before, after) {
  if (!before || !after) return false;
  return (before.pid !== null && after.pid !== null && before.pid !== after.pid) ||
    (Number.isFinite(before.restartCount) && Number.isFinite(after.restartCount) && after.restartCount > before.restartCount) ||
    (Number.isFinite(before.startedAt) && Number.isFinite(after.startedAt) && after.startedAt > before.startedAt);
}

export function restartButtonModel(source, report, pending) {
  if (source !== 'operator' && source !== 'wui') return { visible: false, enabled: false, reason: '' };
  const target = report?.targets?.[source];
  const operation = pending?.target === source ? pending : report?.operations?.[source];
  const busy = operation && ['requesting', 'accepted', 'running', 'reconnecting'].includes(operation.state);
  const enabled = Boolean(target?.restartable === true && !busy);
  let reason = target?.restartSummary || target?.summary || '再起動可否を確認できません';
  let reasonKind = enabled ? '' : 'unavailable';
  if (busy) {
    reason = operation.message || '再起動中です';
    reasonKind = 'restarting';
  } else if (source === 'operator' && target?.activity === 'busy') {
    reason = target.activityPhase === 'preparing'
      ? '録画開始準備中は再起動不可'
      : (target.activityPhase === 'finalizing'
        ? '録画終了処理中は再起動不可'
        : (target.activityPhase === 'recording' ? '録画中は再起動不可' : '録画処理中は再起動不可'));
    reasonKind = 'recording';
  } else if (source === 'operator' && target?.activity !== 'idle') {
    reason = '録画状態を確認できないため再起動不可';
    reasonKind = 'unknown';
  } else if (!enabled && (target?.manager === 'unavailable' || target?.manager === 'unknown')) {
    reason = 'サービス状態を確認中';
    reasonKind = 'unknown';
  }
  return {
    visible: true,
    enabled,
    reason,
    reasonKind
  };
}

export function serviceIndicatorModel(source, report, pending, fetchFailed = false) {
  if (source !== 'operator' && source !== 'wui') return { visible: false, state: 'none', label: '' };
  const label = source === 'operator' ? 'Operator' : 'WUI';
  const target = report?.targets?.[source];
  const operation = pending?.target === source ? pending : report?.operations?.[source];
  if (operation && ['requesting', 'accepted', 'running', 'reconnecting'].includes(operation.state)) {
    return { visible: true, state: 'checking', label: `${label}：再起動中` };
  }
  if (fetchFailed || !target || typeof target.status !== 'string') {
    return { visible: true, state: 'unknown', label: `${label}：状態不明` };
  }
  if (target.status === 'online') {
    return { visible: true, state: 'online', label: `${label}：稼働中` };
  }
  if (target.status === 'stopped' || target.status === 'stopping' || target.status === 'errored') {
    return { visible: true, state: 'stopped', label: `${label}：停止` };
  }
  return { visible: true, state: 'unknown', label: `${label}：状態不明` };
}

export function mirakurunIndicatorModel(report, fetchState = 'checking') {
  if (fetchState === 'checking' && !report) {
    return { visible: true, state: 'checking', label: 'Mirakurun：接続確認中' };
  }
  if (fetchState === 'failed' || !report?.mirakurun) {
    return { visible: true, state: 'unknown', label: 'Mirakurun：状態不明' };
  }
  const diagnostic = report.mirakurun;
  if (diagnostic.status === 'normal' && diagnostic.code === 'ok') {
    return { visible: true, state: 'online', label: 'Mirakurun：接続中' };
  }
  if (diagnostic.status === 'error' && (diagnostic.code === 'timeout' || diagnostic.code === 'unavailable')) {
    return { visible: true, state: 'unavailable', label: `Mirakurun：${diagnostic.summary || '接続不可'}` };
  }
  return { visible: true, state: 'unknown', label: `Mirakurun：${diagnostic.summary || '状態不明'}` };
}

export function serviceStatusModel(source, report, fetchFailed = false, fetchError = '') {
  if (source === 'scheduler') return { visible: false, text: '', detail: '' };
  const label = source === 'operator' ? 'Operator' : 'WUI';
  const target = report?.targets?.[source];
  if (fetchFailed || !target) {
    return { visible: true, text: `${label}：状態確認中`, detail: fetchError || 'サービス制御APIの応答を確認できません' };
  }
  const detail = target.restartSummary || target.summary || '';
  if (target.operable !== true) {
    const temporary = target.manager === 'unavailable' || target.manager === 'unknown';
    return { visible: true, text: temporary ? `${label}：状態確認中` : 'PM2操作不可', detail };
  }
  if (source === 'operator' && target.activity === 'busy') {
    return {
      visible: true,
      text: Number.isInteger(target.recordingCount) ? `Operator：録画中 ${target.recordingCount}件` : 'Operator：録画処理中',
      detail
    };
  }
  if (source === 'operator' && target.activity !== 'idle') {
    return { visible: true, text: 'Operator：状態確認中', detail };
  }
  return { visible: true, text: source === 'operator' ? 'Operator：稼働中 · 録画 0件' : 'WUI：稼働中', detail };
}
