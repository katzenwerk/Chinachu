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

export function recordedFileState(item) {
  if (item?.deletionKind === 'explicit' || item?.deletion && item.deletion.reason !== 'recorded-missing') return 'deleted';
  if (item?.fileMissing || item?.deletionKind === 'file-missing') return 'missing';
  if (item?.deletionKind === 'missing' || item?.deletion?.reason === 'recorded-missing') return 'ledger';
  return 'normal';
}

export function isRecordedResultPlayable(item) {
  return recordedStatus(item) && !['deleted', 'missing'].includes(recordedFileState(item)) &&
    item?.recordingPathMissing !== true && text(item?.recordedId) !== null;
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

export function savedTsResultInfo(saved) {
  const result = saved?.result;
  if (!result) return { label: '未解析', findings: false, description: '' };
  const parts = [], notes = [];
  if (Number.isFinite(result.ccErrorEvents) && result.ccErrorEvents > 0) {
    parts.push(`CC ${result.ccErrorEvents.toLocaleString('ja-JP')}`);
    notes.push('保存TSのパケット連続性異常です。件数は欠落パケット数そのものではありません。');
  }
  if (Number.isFinite(result.pcrGapEvents) && result.pcrGapEvents > 0) {
    parts.push('GAPあり'); notes.push('保存TSで検出した時間飛び候補です。発生箇所は解析詳細で確認できます。');
  }
  for (const [key, name] of [['teiPackets', 'TEI'], ['syncErrorEvents', '同期'], ['invalidHeaderPackets', 'ヘッダー'], ['pcrBackwards', 'PCR逆行']]) {
    if (Number.isFinite(result[key]) && result[key] > 0) { parts.push(`${name} ${result[key].toLocaleString('ja-JP')}`); notes.push(`${name}を検出しました。`); }
  }
  if (parts.length) return { label: parts.join(' / '), findings: true, description: notes.join('\n') };
  if (result.status === 'SUSPECT') return { label: '異常検出', findings: true, description: '保存TS解析で異常を検出しました。解析詳細で内容を確認できます。' };
  if (result.status === 'ERROR') return { label: '解析失敗', findings: false, description: result.error || '' };
  if (result.completed !== true) return { label: '解析未完了', findings: false, description: result.stopReason || '' };
  return { label: result.status === 'NO_FINDINGS' ? '異常未検出' : '解析結果なし', findings: false, description: '' };
}

export function recordedResultWarnings(item) {
  const warnings = [];
  const analysis = savedTsResultInfo(item?.savedTsAnalysis);
  if (analysis.findings) warnings.push(warning('saved-ts', `Analyze: ${analysis.label}`, analysis.description));
  if (item?.status === 'MISSED') {
    warnings.push(warning('missed', '未録画', '録画されませんでした', 'confirmed', 'danger'));
  }
  if (recordedFileState(item) === 'deleted') {
    warnings.push(warning('deleted', '削除済み', '録画ファイルは削除済みとして記録されています', 'confirmed', 'muted'));
  } else if (recordedFileState(item) === 'missing') {
    warnings.push(warning('file-missing', '行方不明', '正常に捜索を完了しましたが、録画ファイルが見つかりませんでした。明示的に再捜索できます。', 'confirmed', 'muted'));
  }
  if (item?.deletionKind === 'missing' || item?.deletion?.reason === 'recorded-missing') {
    warnings.push(warning('recorded-unknown', '台帳不整合', item?.fileMissing ? '録画ファイルの行方不明に加え、録画管理情報にも対応する項目がありません。' : '録画管理台帳に対応する項目がありません。', 'confirmed', 'muted'));
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
    warnings.push(warning('drop', `Mirakurun: ${dropTotal.toLocaleString('ja-JP')}`,
      '録画中にMirakurunが観測したDROP数です。保存TSの詳細解析とは検出方法が異なります。', 'confirmed'));
  }
  const tsDrop = item?.tsDrop && typeof item.tsDrop === 'object' ? item.tsDrop : null;
  if (tsDrop) {
    const ccEvents = Number(tsDrop.ccErrorEvents);
    const teiPackets = Number(tsDrop.teiPackets);
    const scrambledPackets = Number(tsDrop.scrambledPackets);
    const syncEvents = Number(tsDrop.syncErrorEvents);
    if (tsDrop.completed !== true) {
      warnings.push(warning('ts-drop-incomplete', 'Operator: 監視未完了',
        `OperatorのTS解析は完了していません${tsDrop.stopReason ? `（${tsDrop.stopReason}）` : ''}`, 'confirmed'));
    }
    if (Number.isFinite(ccEvents) && ccEvents > 0) {
      warnings.push(warning('ts-cc', `Operator: CC ${ccEvents.toLocaleString('ja-JP')}`,
        `録画TSでCC不連続イベントを${ccEvents.toLocaleString('ja-JP')}件検出（欠落パケット数ではありません）`, 'confirmed'));
    }
    if (Number.isFinite(teiPackets) && teiPackets > 0) {
      warnings.push(warning('ts-tei', `Operator: TEI ${teiPackets.toLocaleString('ja-JP')}`,
        `録画TSでTransport Error Indicatorを${teiPackets.toLocaleString('ja-JP')}パケット検出`, 'confirmed'));
    }
    if (Number.isFinite(scrambledPackets) && scrambledPackets > 0) {
      warnings.push(warning('ts-scrambled', `Operator: 未復号 ${scrambledPackets.toLocaleString('ja-JP')}`,
        `録画TSでscrambling制御付きパケットを${scrambledPackets.toLocaleString('ja-JP')}件検出`, 'confirmed'));
    }
    if (Number.isFinite(syncEvents) && syncEvents > 0) {
      warnings.push(warning('ts-sync', `Operator: 同期 ${syncEvents.toLocaleString('ja-JP')}`,
        `録画TS解析で同期喪失イベントを${syncEvents.toLocaleString('ja-JP')}件検出`, 'confirmed'));
    }
  }
  return warnings;
}

export function hasRecordedResultWarnings(item) {
  return recordedResultWarnings(item).length > 0;
}
