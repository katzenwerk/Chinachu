import {
  formatRecordingSeconds,
  isRecordedResultPlayable,
  recordedResultWarnings,
  recordedFileState,
  recordingDurationInfo,
  tsDropPidSummary
} from './recorded-result-warnings.js';

export const CONFLICT_DESCRIPTION = 'チューナー不足が予測されています。録画を試みますが、録画できない可能性があります。';

export function reservationActionLabel(action) {
  return { reserve: '録画予約', 'reserve-now': '今から録画', unreserve: '予約取消',
    skip: 'この予約をスキップ', unskip: 'スキップを取消' }[action] || '';
}

export function seriesCorrectionActions(context) {
  if (!context?.event?.key) return [];
  return [
    { action: 'series-change', label: context.tidConfirmed ? 'シリーズを変更' : 'シリーズに紐づけ' },
    { action: 'series-episode', label: '話数を修正' },
    ...(context.manual === true ? [{ action: 'series-remove', label: '手動指定を解除' }] : [])
  ];
}

export function programSeriesContext(model, program, context) {
  if (context || !model.eventKey) return context;
  return {
    eventKey: model.eventKey,
    event: { ...program, key: model.eventKey, resolution: null },
    seriesId: null,
    tidConfirmed: false,
    manual: false,
    candidates: []
  };
}

function validText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function parsedProgramValue(program, key) {
  return Object.prototype.hasOwnProperty.call(program, key) ? program[key] : undefined;
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function programState(detail) {
  const status = detail.match?.status || '';
  const deletionReason = validText(detail.match?.deletion?.reason);
  if (recordedFileState(detail.match) === 'missing') return { key: 'file-missing', label: '行方不明' };
  if (deletionReason !== null && deletionReason !== 'recorded-missing') {
    return {
      key: 'deleted',
      label: '削除済み',
      reason: deletionReason === 'storage-low' ? { key: 'storage-low', label: '容量不足' }
        : deletionReason === 'manual' ? { key: 'manual-delete', label: '手動削除' } : null
    };
  }
  if (detail.currentSource === 'recording') return { key: 'recording', label: '録画中' };
  if (status === 'RECORDED' || status === 'RECORDED_UNTRACKED' || detail.currentSource === 'recorded') {
    if (detail.program?.operatorAbort === true || detail.program?.operatorEndLack === true) {
      const abortReason = validText(detail.program?.operatorAbortReason);
      const reason = abortReason === 'LOW STORAGE' ? { key: 'storage-low', label: '容量不足' }
        : abortReason === 'ABORT RECORDING' ? { key: 'manual-abort', label: '手動中止' }
          : detail.program?.operatorEndLack === true ? { key: 'end-lack', label: '録画終了前に終了' } : null;
      return { key: 'aborted', label: '録画中止', reason };
    }
    return { key: 'recorded', label: '録画済み' };
  }
  if (detail.program?.isSkip === true) return { key: 'skipped', label: 'スキップ' };
  if (detail.currentSource === 'reserves' || status === 'RESERVED') return { key: 'reserved', label: '予約済み' };
  if (status === 'SKIPPED_ONLY') return { key: 'missed', label: '未録画', reason: { key: 'skipped', label: 'スキップ' } };
  if (status === 'MISSED') return { key: 'missed', label: '未録画' };
  return { key: 'program', label: '通常番組' };
}

function fileState(detail, state) {
  const deletion = detail.match?.deletion;
  if (recordedFileState(detail.match) === 'missing') return { key: 'file-missing', label: '行方不明', description: '捜索完了後に不在が確認された録画です。' };
  if (deletion) {
    return deletion.reason === 'recorded-missing'
      ? { key: 'recorded-unknown', label: null, description: null }
      : { key: 'deleted', label: '削除済み', description: '録画ファイルは削除済みとして記録されています。' };
  }
  if (['recorded', 'recording', 'aborted'].includes(state.key)) {
    return {
      key: 'unknown',
      label: null,
      description: null
    };
  }
  return { key: 'not-applicable', label: null, description: null };
}

function deletionInfo(deletion) {
  if (!deletion || typeof deletion !== 'object') return null;
  const unknown = deletion.reason === 'recorded-missing';
  const reasons = {
    manual: '手動削除',
    'storage-low': '容量不足による自動削除',
    'recorded-missing': '録画管理情報に対応する項目がありません'
  };
  const deletedAt = finitePositive(deletion.deletedAt);
  return {
    kind: unknown ? 'unknown' : 'deleted',
    reason: reasons[deletion.reason] || validText(deletion.reason) || '理由不明',
    deletedAt: deletedAt === null ? null : new Intl.DateTimeFormat('ja-JP', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).format(new Date(deletedAt))
  };
}

function formatDateTime(start, end) {
  if (start === null) return '放送日時未取得';
  const date = new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
  }).format(new Date(start));
  const time = new Intl.DateTimeFormat('ja-JP', {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  return end === null ? `${date} ${time.format(new Date(start))}` : `${date} ${time.format(new Date(start))}–${time.format(new Date(end))}`;
}

function formatDuration(seconds) {
  if (seconds === null) return '放送時間未取得';
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}時間` : `${hours}時間${rest}分`;
}

function ruleLabel(program, rules) {
  const uid = validText(program.ruleUid);
  const list = Array.isArray(rules) ? rules : [];
  const index = uid === null ? -1 : list.findIndex(rule => validText(rule?.ruleUid) === uid);
  if (index >= 0) return `ルール #${index + 1}`;
  if (uid !== null) return '関連ルール（現在のルール一覧にありません）';
  if (program.ruleId !== undefined && program.ruleId !== null && program.ruleId !== '') {
    return `ルール #${Number(program.ruleId) + 1}`;
  }
  return null;
}

function reservationInfo(program, state, rules) {
  if (!['reserved', 'recording', 'skipped'].includes(state.key)) return null;
  const manual = program.isManualReserved === true;
  const destination = validText(program.recordedDirId) || validText(program.recordedDir);
  const warnings = [];
  if (program.isConflict === true) warnings.push('予約競合');
  if (program.isSkip === true) warnings.push('スキップ');
  return {
    type: manual ? '手動予約' : 'ルール予約',
    rule: manual ? null : ruleLabel(program, rules),
    destination: destination || '保存先情報未取得',
    warnings
  };
}

export function ruleAction(program, rules, preferredRuleUid = null) {
  const programUid = validText(program.ruleUid);
  const uid = programUid || validText(preferredRuleUid);
  const list = Array.isArray(rules) ? rules : [];
  if (uid === null) {
    if (program.ruleId !== undefined && program.ruleId !== null && program.ruleId !== '') {
      return { mode: 'unavailable', ruleUid: null, index: null, label: '関連ルールの安定識別子がありません' };
    }
    return { mode: 'create', ruleUid: null, index: null, label: null };
  }
  const indexes = list.map((rule, index) => validText(rule?.ruleUid) === uid ? index : -1).filter(index => index >= 0);
  if (indexes.length === 1) return {
    mode: 'edit', ruleUid: uid, index: indexes[0], rule: list[indexes[0]], pending: programUid === null,
    label: `ルール #${indexes[0] + 1}${programUid === null ? '（予約反映待ち）' : ''}`
  };
  return { mode: 'unavailable', ruleUid: uid, index: null, label: indexes.length > 1 ? '関連ルールが複数あります' : '関連ルールは現在の一覧にありません' };
}

export function programEndTime(program) {
  const start = finitePositive(program?.start);
  const seconds = finitePositive(program?.seconds);
  return finitePositive(program?.end) || (start !== null && seconds !== null ? start + seconds * 1000 : null);
}

export function programRecordingAction(program, now = Date.now()) {
  const start = finitePositive(program?.start);
  if (start === null) return null;
  if (now < start) return 'reserve';
  const end = programEndTime(program);
  return end !== null && now < end ? 'reserve-now' : null;
}

function channelLogoUrl(channel) {
  const id = validText(channel?.id);
  return id !== null && channel?.hasLogoData === true ? `/api/channel/${encodeURIComponent(id)}/logo.png` : null;
}

function recordingPathInfo(detail, state, file) {
  const historyStatus = validText(detail.match?.status);
  const visible = state.key === 'recording' || ['recorded', 'aborted', 'deleted', 'unknown', 'file-missing'].includes(state.key) ||
    ['MISSED', 'SKIPPED_ONLY'].includes(historyStatus);
  if (!visible) return null;
  // Historical match/reserves/schedule metadata cannot establish a recording location.
  const path = detail.currentSource === 'recorded' || detail.resolution?.source === 'recorded'
    ? validText(detail.program?.recorded)
    : state.key === 'recording' && detail.currentSource === 'recording'
      ? validText(detail.program?.recorded) : null;
  const unavailable = file.key === 'deleted' ? '削除済み' : null;
  return {
    label: 'ファイルパス',
    value: unavailable || path || 'パス不明',
    copyValue: unavailable === null ? path : null
  };
}

export function buildProgramDetailModel(detail, now = Date.now()) {
  const match = detail.match || {};
  const program = { ...(detail.program || {}) };
  for (const field of ['savedTsAnalysis', 'recordedDurationSeconds']) {
    if (Object.prototype.hasOwnProperty.call(match, field)) program[field] = match[field];
  }
  const parsedProgramAvailable = detail.currentSource != null || detail.resolution?.matchedBy !== 'minimal-match';
  const reservationMeta = match.reservationMeta || {};
  const reservationProgram = {
    ...program,
    ruleUid: validText(program.ruleUid) || validText(reservationMeta.ruleUid),
    ruleId: program.ruleId ?? reservationMeta.ruleId,
    isManualReserved: program.isManualReserved === true || reservationMeta.isManualReserved === true,
    recordedDirId: validText(program.recordedDirId) || validText(reservationMeta.recordedDirId),
    recordedDir: validText(program.recordedDir) || validText(reservationMeta.recordedDir)
  };
  const state = programState(detail);
  const recording = match.recording || match.fileMissing || {};
  const recordedId = validText(recording.recordedId) || validText(program.recordedId) ||
    (detail.currentSource === 'recorded' ? validText(program.id) : null);
  const programId = validText(program.id);
  const start = finitePositive(program.start) || finitePositive(match.start);
  const seconds = finitePositive(program.seconds) || (start !== null && finitePositive(match.end) !== null
    ? Math.max(1, Math.round((Number(match.end) - start) / 1000))
    : null);
  const end = finitePositive(program.end) || finitePositive(match.end) || (start !== null && seconds !== null ? start + seconds * 1000 : null);
  const channel = program.channel && typeof program.channel === 'object' ? program.channel : {};
  const channelId = validText(channel.id);
  const file = fileState(detail, state);
  const recordedState = ['recorded', 'aborted', 'deleted', 'unknown', 'file-missing'].includes(state.key);
  const recordedResourceAvailable = detail.currentSource === 'recorded' || detail.resolution?.source === 'recorded';
  const recordingPath = recordingPathInfo(detail, state, file);
  const relatedRule = ruleLabel(reservationProgram, detail.rules);
  const recordingItem = {
    ...program,
    fileMissing: match.fileMissing || null,
    deletion: match.deletion || null,
    status: validText(match.status) || (['recorded', 'aborted', 'deleted'].includes(state.key) ? 'RECORDED' : null),
    start,
    end,
    seconds,
    recordingPath: recordingPath?.copyValue,
    recordingPathMissing: recordingPath?.copyValue === null,
    deletionKind: file.key === 'file-missing' ? 'file-missing' : file.key === 'deleted' ? 'explicit' : file.key === 'recorded-unknown' ? 'missing' : 'none'
  };
  const actualDuration = recordingDurationInfo(recordingItem);
  const recordingInfo = recordedState ? {
    plannedDuration: seconds === null ? '予定時間不明' : formatRecordingSeconds(seconds),
    actualDuration: actualDuration?.label || '録画時間不明',
    path: recordingPath?.value || 'パス不明'
  } : null;
  const recordingWarnings = recordingInfo === null ? [] : recordedResultWarnings(recordingItem);
  const tsDropInfo = recordingInfo === null ? null : tsDropPidSummary(recordingItem);
  const playable = isRecordedResultPlayable({
    status: recordingItem.status,
    deletionKind: recordingItem.deletionKind,
    recordingPathMissing: recordingItem.recordingPathMissing,
    recordedId,
    recordingPath: recordingPath?.copyValue,
    detailSource: recordedResourceAvailable ? 'recorded' : null
  });
  const attributes = [
    validText(program.category),
    ...(Array.isArray(program.flags) ? program.flags.map(validText).filter(Boolean) : [])
  ];
  const warnings = [];
  if (detail.historyAmbiguous) warnings.push('同じ番組IDの履歴が複数あるため、履歴情報は表示していません。');
  const reserves = Array.isArray(detail.reserves) ? detail.reserves : [];
  const conflicted = program.isConflict === true || reserves.some(item => item.id === programId && item.isConflict === true);
  if (conflicted) warnings.push(CONFLICT_DESCRIPTION);
  const overlappingReservations = conflicted ? reserves
    .filter(item => item.id !== programId && item.isSkip !== true &&
      start !== null && end !== null && finitePositive(item.start) !== null &&
      programEndTime(item) !== null && Number(item.start) < end && programEndTime(item) > start)
    .sort((a, b) => Number(a.start) - Number(b.start))
    .map(item => ({
      id: item.id,
      title: validText(item.fullTitle) || validText(item.title) || 'タイトル未取得',
      channel: validText(item.channel?.name) || '放送局未取得',
      dateTime: formatDateTime(Number(item.start), programEndTime(item))
    })) : null;
  const liveAvailable = channelId !== null && start !== null && end !== null && start <= now && now < end;
  const livePreviewAvailable = liveAvailable && state.key !== 'recording' && !recordedState && programId !== null;
  const manualReservation = reservationProgram.isManualReserved === true;
  const reservationAction = state.key === 'reserved'
    ? (manualReservation ? 'unreserve' : 'skip')
    : state.key === 'skipped'
      ? 'unskip'
      : state.key === 'program' ? programRecordingAction({ start, end, seconds }, now) : null;

  return {
    eventKey: validText(match.key) || (channelId !== null && start !== null && seconds !== null
      ? `${channelId}|${start}|${seconds}` : null),
    title: validText(program.fullTitle) || validText(program.title) || validText(match.fullTitle) || 'タイトル未取得',
    shortTitle: validText(program.title),
    parsedProgram: {
      title: parsedProgramAvailable ? parsedProgramValue(program, 'title') : undefined,
      subTitle: parsedProgramAvailable ? parsedProgramValue(program, 'subTitle') : undefined,
      episode: parsedProgramAvailable ? parsedProgramValue(program, 'episode') : undefined
    },
    summary: validText(program.description),
    detail: validText(program.detail) || validText(program.description),
    state,
    phase: state,
    matchStatus: validText(match.status),
    fileState: file,
    channel: {
      name: validText(channel.name) || '放送局未取得',
      meta: [validText(channel.type), validText(channel.id)].filter(Boolean).join(' / '),
      logoUrl: channelLogoUrl(channel)
    },
    dateTime: formatDateTime(start, end),
    duration: formatDuration(seconds),
    attributes,
    reservation: reservationInfo(reservationProgram, state, detail.rules),
    relatedRule,
    recordingInfo,
    savedTsAnalysis: program.savedTsAnalysis || null,
    mirakurunDrop: program.mirakurunDrop || null,
    recordingWarnings,
    tsDropInfo,
    recordingPath,
    deletion: deletionInfo(match.deletion),
    actions: {
      recordedMaintenance: recordedState && file.key !== 'deleted' && recordedId !== null &&
        (finitePositive(program.operatorRecordingEnd) || end) !== null &&
        (finitePositive(program.operatorRecordingEnd) || end) <= now &&
        (recordedResourceAvailable || ['RECORDED', 'RECORDED_UNTRACKED'].includes(match.status)) &&
        program.operatorResumePending !== true && detail.resolution?.idConflict !== true
        ? { recordedId } : null,
      reservation: reservationAction,
      stopRecording: state.key === 'recording' && programId !== null ? { requested: program.abort === true } : null,
      rule: ruleAction(reservationProgram, detail.rules, detail.preferredRuleUid),
      deleteRecording: playable && recordingPath?.copyValue ? {
        recordedId,
        path: recordingPath.copyValue
      } : null
    },
    programId,
    broadcast: { start, end },
    ruleSeed: {
      title: validText(program.title) || validText(program.fullTitle),
      type: validText(channel.type),
      channel: channelId,
      category: validText(program.category)
    },
    warnings,
    overlappingReservations,
    media: {
      visible: liveAvailable || state.key === 'recording' || recordedState,
      kind: state.key === 'recording' ? 'recording' : 'recorded',
      livePreviewUrl: livePreviewAvailable
        ? `/api/channel/${encodeURIComponent(channelId)}/preview.jpg?id=${encodeURIComponent(programId)}&start=${start}&end=${end}`
        : null,
      recordedId,
      playable,
      canCreateThumbnail: recordedResourceAvailable && ['recorded', 'aborted'].includes(state.key) &&
        recordedId !== null && file.key !== 'deleted' && file.key !== 'file-missing' &&
        program.fileExists !== false && program.cleanupState !== 'deleted' && program.operatorResumePending !== true &&
        validText(program.recorded) !== null,
      thumbnailUrl: recordedState && recordedId !== null
        ? `/api/recorded/${encodeURIComponent(recordedId)}/thumbnail.jpg`
        : null,
      previewUrl: state.key === 'recording' && programId !== null && Boolean(program.pid) &&
        validText(program.recorded) !== null && program.tuner?.isScrambling !== true
        ? `/api/recording/${encodeURIComponent(programId)}/preview.jpg?width=480&height=270&_n=${Date.now()}`
        : null,
      liveModel: liveAvailable ? {
        title: validText(program.fullTitle) || validText(program.title) || 'タイトル未取得',
        liveChannel: { id: channelId, name: validText(channel.name) || '放送局未取得' },
        liveProgram: {
          id: programId,
          title: validText(program.title),
          fullTitle: validText(program.fullTitle),
          detail: validText(program.detail),
          start,
          end
        }
      } : null,
      downloadUrl: playable
        ? `/api/recorded/${encodeURIComponent(recordedId)}/file.m2ts`
        : null
    },
    source: detail.resolution?.source || detail.currentSource || null,
    matchedBy: detail.resolution?.matchedBy || null
  };
}
