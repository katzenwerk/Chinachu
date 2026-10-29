import { programDetailUrl } from './program-detail-client.js';
import { recordedResultWarnings } from './recorded-result-warnings.js';
import { buildProgramDisplayTitle } from './program-title.js';

const dateFormatter = new Intl.DateTimeFormat('ja-JP', {
  month: '2-digit',
  day: '2-digit',
  weekday: 'short'
});
const timeFormatter = new Intl.DateTimeFormat('ja-JP', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function normalizeDisplayText(value, preserveLineBreaks = false) {
  const text = validText(value);
  if (text === null) return null;
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
    .map(line => line.replace(/[\t\f\v ]+/g, ' ').trim())
    .filter(Boolean);
  return lines.join(preserveLineBreaks ? '\n' : ' ');
}

function formatDate(value) {
  return finite(value) && value > 0
    ? dateFormatter.format(new Date(value)).replace(/\s/g, '')
    : '日付未取得';
}

function formatTime(value) {
  return finite(value) && value > 0 ? timeFormatter.format(new Date(value)) : '未取得';
}

function formatDuration(seconds) {
  if (!finite(seconds) || seconds <= 0) return null;
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `実録画 ${minutes}分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `実録画 ${hours}時間` : `実録画 ${hours}時間${rest}分`;
}

function primaryStatus(item) {
  if (item?.deletionKind === 'explicit') return { key: 'deleted', label: '削除済み' };
  if (item?.deletionKind === 'missing') return { key: 'unknown', label: '不明' };
  if (item?.status === 'RECORDED' || item?.status === 'RECORDED_UNTRACKED') {
    return { key: 'recorded', label: '録画済' };
  }
  if (item?.status === 'MISSED') return { key: 'missed', label: '未録画' };
  if (item?.status === 'SKIPPED_ONLY') return { key: 'skipped', label: 'スキップ' };
  return { key: 'unknown', label: '状態不明' };
}

function reservationTag(type) {
  if (type === 'manual') return { key: 'manual', label: '手動予約' };
  if (type === 'rule') return { key: 'rule', label: 'ルール予約' };
  return { key: 'unknown', label: '予約種別不明' };
}

function resultTags(item) {
  return [reservationTag(item.reservationType)];
}

function channelLogoUrl(channel) {
  const id = validText(channel?.id);
  return id === null || channel?.hasLogoData !== true
    ? null
    : `/api/channel/${encodeURIComponent(id)}/logo.png`;
}

function channelTooltip(channel) {
  const values = [validText(channel?.name), validText(channel?.type), validText(channel?.id)].filter(Boolean);
  return values.join(' / ') || 'チャンネル情報未取得';
}

export function buildRecordedResultModels(items, options = {}) {
  if (!Array.isArray(items)) throw new Error('Match page items are invalid');
  return items.map((item, index) => {
    const channel = item?.channel && typeof item.channel === 'object' ? item.channel : {};
    const channelName = validText(channel.name);
    const channelId = validText(channel.id);
    const displayTitle = buildProgramDisplayTitle(item, options.seriesTitleIndex);
    const submeta = [
      channelName,
      validText(item?.category),
      formatDuration(item?.operatorActualSeconds)
    ].filter(Boolean);
    return {
      key: validText(item?.key) || `recorded-result-${index}`,
      detailUrl: programDetailUrl({ key: validText(item?.key), id: validText(item?.recordedId) }),
      displayTitle: displayTitle.text,
      displayTitleSource: displayTitle.source,
      displayEpisodeSource: displayTitle.episodeSource || null,
      detail: normalizeDisplayText(item?.detail, true),
      category: submeta.join(' · ') || '補足情報未取得',
      dateText: formatDate(item?.start),
      timeText: `${formatTime(item?.start)}–${formatTime(item?.end)}`,
      channelLogoUrl: channelLogoUrl(channel),
      channelFallbackText: channelName || channelId || '不明',
      channelTooltip: channelTooltip(channel),
      primaryStatus: primaryStatus(item),
      recordingWarnings: recordedResultWarnings(item),
      tags: resultTags(item || {}),
      storageTag: null,
      storageNotice: null
    };
  });
}
