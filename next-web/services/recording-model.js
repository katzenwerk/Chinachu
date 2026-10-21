import { buildRecordingStorageDisplay } from './storage-model.js';
import { programDetailUrl } from './program-detail-client.js';

const timeFormatter = new Intl.DateTimeFormat('ja-JP', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});
const dateFormatter = new Intl.DateTimeFormat('ja-JP', {
  month: '2-digit',
  day: '2-digit'
});

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function positiveTimestamp(value) {
  return finite(value) && value > 0 ? value : null;
}

function endTime(program, start) {
  const end = positiveTimestamp(program.end);
  if (end !== null) return end;
  return start !== null && finite(program.seconds) && program.seconds > 0
    ? start + program.seconds * 1000
    : null;
}

function formatTime(value) {
  return value === null ? '未取得' : timeFormatter.format(new Date(value));
}

function formatDateTime(start, end) {
  if (start === null || end === null) return '放送日時未取得';
  return `${dateFormatter.format(new Date(start))} ${formatTime(start)}–${formatTime(end)}`;
}

function formatDuration(minutes) {
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}時間` : `${hours}時間${rest}分`;
}

export function channelIdentifier(channel) {
  const type = typeof channel.type === 'string' ? channel.type.toUpperCase() : '';
  if (!['GR', 'BS', 'CS'].includes(type)) return null;
  const sid = typeof channel.sid === 'number'
    ? channel.sid
    : (typeof channel.sid === 'string' && /^\d+$/.test(channel.sid) ? Number(channel.sid) : NaN);
  return Number.isSafeInteger(sid) && sid >= 0 ? `${type}${sid}` : null;
}

export function channelLogoUrl(channel) {
  const channelId = typeof channel?.id === 'string' && channel.id !== '' ? channel.id : null;
  return channelId !== null && channel.hasLogoData === true
    ? `/api/channel/${encodeURIComponent(channelId)}/logo.png`
    : null;
}

export function channelDetailText(channel = {}) {
  const name = typeof channel?.name === 'string' && channel.name.trim() !== ''
    ? channel.name.trim()
    : null;
  const type = typeof channel?.type === 'string' && channel.type.trim() !== ''
    ? channel.type.trim().toUpperCase()
    : null;
  const id = typeof channel?.id === 'string' && channel.id.trim() !== ''
    ? channel.id.trim()
    : null;
  const sid = typeof channel?.sid === 'number' && Number.isSafeInteger(channel.sid)
    ? channel.sid
    : (typeof channel?.sid === 'string' && /^\d+$/.test(channel.sid.trim()) ? Number(channel.sid) : null);
  const parts = [
    name,
    type ? `放送波：${type}` : null,
    id ? `チャンネルID：${id}` : null,
    sid !== null ? `SID：${sid}` : null
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : 'チャンネル情報未取得';
}

function dynamicValues(start, end, now) {
  if (start === null || end === null || end <= start || !finite(now)) {
    return { progress: null, progressText: '未取得', elapsedText: '経過時間未取得', remainingText: '残り時間未取得' };
  }
  const progress = Math.max(0, Math.min(100, (now - start) / (end - start) * 100));
  const elapsedText = now < start
    ? '開始前'
    : `番組開始から${formatDuration(Math.max(0, Math.floor((now - start) / 60000)))}`;
  if (now >= end) {
    return { progress, progressText: `${Math.round(progress)}%`, elapsedText, remainingText: '終了処理中' };
  }
  if (now < start) {
    return { progress, progressText: `${Math.round(progress)}%`, elapsedText, remainingText: '開始前' };
  }
  const remainingMinutes = Math.max(1, Math.ceil((end - now) / 60000));
  return { progress, progressText: `${Math.round(progress)}%`, elapsedText, remainingText: `残り${formatDuration(remainingMinutes)}` };
}

export function buildRecordingViewModels(programs, now = Date.now(), options = {}) {
  if (!Array.isArray(programs)) throw new Error('Recording API response is invalid');
  return programs.slice().sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0)).map((program, index) => {
    const id = typeof program.id === 'string' && program.id !== '' ? program.id : null;
    const start = positiveTimestamp(program.start);
    const end = endTime(program, start);
    const recordingStart = positiveTimestamp(program.operatorRecordingStart);
    const status = recordingStart === null ? 'preparing' : 'recording';
    const channel = program.channel && typeof program.channel === 'object' ? program.channel : {};
    const channelId = typeof channel.id === 'string' && channel.id !== '' ? channel.id : null;
    const channelName = String(channel.name || 'チャンネル未取得');
    const identifier = channelIdentifier(channel);
    const previewEligible = id !== null && status === 'recording' && Boolean(program.pid) &&
      typeof program.recorded === 'string' && program.recorded !== '' &&
      !(program.tuner && program.tuner.isScrambling === true);
    const storageDisplay = buildRecordingStorageDisplay(options.storageData, program);
    return {
      key: id || `invalid-${index}`,
      id,
      title: String(program.title || program.fullTitle || 'タイトル未取得'),
      channelName,
      channelIdentifier: identifier,
      channelLogoUrl: channelLogoUrl(channel),
      channelTooltip: channelDetailText(channel),
      channelMetaText: [channelName, identifier, `${formatTime(start)}–${formatTime(end)}`].filter(Boolean).join(' · '),
      timeText: `${formatTime(start)}–${formatTime(end)}`,
      broadcastText: formatDateTime(start, end),
      detailUrl: programDetailUrl({ id }),
      status,
      statusText: status === 'preparing' ? '準備中' : '',
      liveChannel: channelId === null ? null : { id: channelId, name: channelName },
      liveProgram: { id, title: program.title, fullTitle: program.fullTitle, detail: program.detail, start, end },
      previewKey: previewEligible ? `${id}:${recordingStart}:${program.recorded}` : null,
      storageNotice: storageDisplay.notice,
      ...dynamicValues(start, end, now)
    };
  });
}
