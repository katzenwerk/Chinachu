function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function recordedStatus(item) {
  return item?.status === 'RECORDED' || item?.status === 'RECORDED_UNTRACKED';
}

export function isRecordedResultPlayable(item) {
  return recordedStatus(item) && item?.deletionKind !== 'explicit' && item?.deletionKind !== 'missing' &&
    item?.recordingPathMissing !== true && text(item?.recordedId) !== null && item?.detailSource === 'recorded';
}

export function formatRecordingSeconds(value, precise = false) {
  const seconds = finitePositive(value);
  if (seconds === null) return null;
  const normalized = precise ? Math.round(seconds * 10) / 10 : Math.floor(seconds);
  const hours = Math.floor(normalized / 3600);
  const minutes = Math.floor((normalized - hours * 3600) / 60);
  const rest = normalized - hours * 3600 - minutes * 60;
  const restText = precise && !Number.isInteger(rest) ? rest.toFixed(1) : String(Math.floor(rest));
  return `${hours > 0 ? `${hours}時間` : ''}${minutes > 0 || hours > 0 ? `${minutes}分` : ''}${restText}秒`;
}

export function recordingDurationInfo(item) {
  const fileSeconds = finitePositive(item?.recordedDurationSeconds);
  if (fileSeconds !== null) {
    return {
      seconds: fileSeconds,
      source: 'file',
      sourceLabel: '実ファイル長',
      label: `${formatRecordingSeconds(fileSeconds, true)}（実ファイル長）`
    };
  }
  let operatorSeconds = finitePositive(item?.operatorActualSeconds);
  const recordingStart = finitePositive(item?.operatorRecordingStart);
  const recordingEnd = finitePositive(item?.operatorRecordingEnd);
  if (operatorSeconds === null && recordingStart !== null && recordingEnd !== null && recordingEnd > recordingStart) {
    operatorSeconds = Math.floor((recordingEnd - recordingStart) / 1000);
  }
  return operatorSeconds === null ? null : {
    seconds: operatorSeconds,
    source: 'operator',
    sourceLabel: 'Operator録画実績',
    label: `${formatRecordingSeconds(operatorSeconds)}（Operator録画実績）`
  };
}

export function tsDropPidSummary(item) {
  const tsDrop = item?.tsDrop && typeof item.tsDrop === 'object' ? item.tsDrop : null;
  if (tsDrop === null) return null;

  const ccErrorTotalValue = Number(tsDrop.ccErrorEvents);
  const ccErrorTotal = Number.isInteger(ccErrorTotalValue) && ccErrorTotalValue >= 0
    ? ccErrorTotalValue : null;
  const ccErrorsByPid = tsDrop.ccErrorsByPid && typeof tsDrop.ccErrorsByPid === 'object'
    ? tsDrop.ccErrorsByPid : {};
  const pids = Object.entries(ccErrorsByPid).map(([key, value]) => {
    const pid = Number(key);
    const count = Number(value);
    if (!Number.isInteger(pid) || pid < 0 || pid > 0x1fff || !Number.isInteger(count) || count <= 0) return null;
    return {
      pid,
      label: `0x${pid.toString(16).toUpperCase().padStart(4, '0')}`,
      count
    };
  }).filter(Boolean).sort((left, right) => left.pid - right.pid);
  const pidTotal = pids.reduce((total, entry) => total + entry.count, 0);

  return {
    ccErrorTotal,
    pidTotal,
    totalsMatch: ccErrorTotal === null ? null : ccErrorTotal === pidTotal,
    pids
  };
}

function warning(key, label, description, kind = 'confirmed', tone = 'warning') {
  return { key, label, description: description || label, kind, tone };
}

export function recordedResultWarnings(item) {
  const warnings = [];
  if (item?.status === 'MISSED') {
    warnings.push(warning('missed', '未録画', '録画されませんでした', 'confirmed', 'danger'));
  }
  if (item?.deletionKind === 'explicit') {
    warnings.push(warning('deleted', '削除済み', '録画ファイルは削除済みとして記録されています', 'confirmed', 'muted'));
  } else if (item?.deletionKind === 'missing') {
    warnings.push(warning('recorded-unknown', '不明', '録画履歴と現在の録画管理情報が一致していません（ファイルは未確認です）', 'confirmed', 'muted'));
  } else if (recordedStatus(item) && item?.recordingPathMissing === true) {
    warnings.push(warning('path-unknown', 'パス不明', '録画ファイルの保存パスが台帳にありません', 'confirmed', 'muted'));
  }

  if (item?.operatorAbort === true) {
    const reason = text(item.operatorAbortReason);
    const description = reason === 'LOW STORAGE'
      ? 'Low Storageにより録画が中断されました'
      : reason === null || reason === 'ABORT RECORDING'
        ? '録画が番組終了前に中止されました'
        : `録画が中断されました（${reason}）`;
    warnings.push(warning('recording-abort', '録画中止', description, 'confirmed', 'danger'));
  }
  if (item?.operatorEndLack === true) {
    warnings.push(warning('end-lack-allowed', '尻切れ許可', '次の録画へ切り替えるため、録画末尾の不足を許可して終了しました', 'confirmed', 'muted'));
  }

  if (recordedStatus(item)) {
    const hasConfirmedEarlyEnd = item?.operatorAbort === true || item?.operatorEndLack === true;
    const programStart = finitePositive(item?.start);
    const programEnd = finitePositive(item?.end) || (programStart !== null && finitePositive(item?.seconds) !== null
      ? programStart + Number(item.seconds) * 1000 : null);
    const recordingStart = finitePositive(item?.operatorRecordingStart);
    const recordingEnd = finitePositive(item?.operatorRecordingEnd);
    const fileSeconds = finitePositive(item?.recordedDurationSeconds);
    const interruptionCount = finiteNonNegative(item?.operatorInterruptionCount) || 0;
    let headDelaySeconds = null;
    let tailShortageSeconds = null;

    if (programStart !== null) {
      if (fileSeconds !== null && recordingEnd !== null && interruptionCount === 0) {
        const estimatedFileStart = recordingEnd - fileSeconds * 1000;
        if (estimatedFileStart > programStart + 1000) headDelaySeconds = (estimatedFileStart - programStart) / 1000;
      } else if (fileSeconds === null && recordingStart !== null && recordingStart > programStart + 1000) {
        headDelaySeconds = Math.ceil((recordingStart - programStart) / 1000);
      }
    }
    if (!hasConfirmedEarlyEnd && programEnd !== null && recordingEnd !== null && recordingEnd < programEnd - 1000) {
      tailShortageSeconds = Math.ceil((programEnd - recordingEnd) / 1000);
    }
    if (headDelaySeconds !== null) {
      warnings.push(warning('head-shortage', '頭切れの可能性', `推定ファイル先頭が番組開始より${formatRecordingSeconds(headDelaySeconds, true)}遅れています`, 'estimated'));
    }
    if (tailShortageSeconds !== null) {
      warnings.push(warning('tail-shortage', '尻切れの可能性', `録画終了が番組終了より${formatRecordingSeconds(tailShortageSeconds)}早い記録です`, 'estimated'));
    }
    const expectedSeconds = finitePositive(item?.seconds) || (programStart !== null && programEnd !== null
      ? (programEnd - programStart) / 1000 : null);
    const measured = recordingDurationInfo(item);
    if (!hasConfirmedEarlyEnd && headDelaySeconds === null && tailShortageSeconds === null && expectedSeconds !== null && measured !== null &&
        measured.seconds < expectedSeconds - 1) {
      warnings.push(warning('duration-shortage', '録画時間不足',
        `予定${formatRecordingSeconds(expectedSeconds)}に対して${measured.sourceLabel}は${formatRecordingSeconds(measured.seconds, measured.source === 'file')}です`, 'estimated'));
    }
  }

  const dropTotal = Number(item?.mirakurunDrop?.dropTotal);
  if (Number.isFinite(dropTotal) && dropTotal > 0) {
    warnings.push(warning('drop', `DROP ${dropTotal.toLocaleString('ja-JP')}`,
      `MirakurunでDROPを${dropTotal.toLocaleString('ja-JP')}件記録（映像への影響は未確認）`, 'confirmed'));
  }
  const tsDrop = item?.tsDrop && typeof item.tsDrop === 'object' ? item.tsDrop : null;
  if (tsDrop) {
    const ccEvents = Number(tsDrop.ccErrorEvents);
    const teiPackets = Number(tsDrop.teiPackets);
    const scrambledPackets = Number(tsDrop.scrambledPackets);
    const syncEvents = Number(tsDrop.syncErrorEvents);
    if (tsDrop.completed !== true) {
      warnings.push(warning('ts-drop-incomplete', 'TS DROP解析未完了',
        `OperatorのTS解析は完了していません${tsDrop.stopReason ? `（${tsDrop.stopReason}）` : ''}`, 'confirmed'));
    }
    if (Number.isFinite(ccEvents) && ccEvents > 0) {
      warnings.push(warning('ts-cc', `CC不連続 ${ccEvents.toLocaleString('ja-JP')}`,
        `録画TSでCC不連続イベントを${ccEvents.toLocaleString('ja-JP')}件検出（欠落パケット数ではありません）`, 'confirmed'));
    }
    if (Number.isFinite(teiPackets) && teiPackets > 0) {
      warnings.push(warning('ts-tei', `TEI ${teiPackets.toLocaleString('ja-JP')}`,
        `録画TSでTransport Error Indicatorを${teiPackets.toLocaleString('ja-JP')}パケット検出`, 'confirmed'));
    }
    if (Number.isFinite(scrambledPackets) && scrambledPackets > 0) {
      warnings.push(warning('ts-scrambled', `未復号 ${scrambledPackets.toLocaleString('ja-JP')}`,
        `録画TSでscrambling制御付きパケットを${scrambledPackets.toLocaleString('ja-JP')}件検出`, 'confirmed'));
    }
    if (Number.isFinite(syncEvents) && syncEvents > 0) {
      warnings.push(warning('ts-sync', `同期異常 ${syncEvents.toLocaleString('ja-JP')}`,
        `録画TS解析で同期喪失イベントを${syncEvents.toLocaleString('ja-JP')}件検出`, 'confirmed'));
    }
  }
  return warnings;
}

export function hasRecordedResultWarnings(item) {
  return recordedResultWarnings(item).length > 0;
}
