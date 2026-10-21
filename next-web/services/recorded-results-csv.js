const dateFormatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});
const timeFormatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

const HEADERS = [
  '放送日', '開始時刻', '終了時刻', '放送局', '番組タイトル', 'ジャンル', '録画結果',
  '予約方法', '実録画時間', '中止', 'DROP数', '削除状態', '削除理由', '録画ファイルパス'
];

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function dateValue(value, formatter) {
  return finite(value) && value > 0 ? formatter.format(new Date(value)) : '';
}

function resultLabel(status) {
  if (status === 'RECORDED' || status === 'RECORDED_UNTRACKED') return '録画済';
  if (status === 'MISSED') return '未録画';
  if (status === 'SKIPPED_ONLY') return 'スキップ';
  return '';
}

function reservationLabel(type) {
  if (type === 'rule') return 'ルール予約';
  if (type === 'manual') return '手動予約';
  return '';
}

function neutralizeFormula(value) {
  const text = String(value ?? '');
  return /^[\t\r\n ]*[=+\-@]/.test(text) ? `'${text}` : text;
}

function csvCell(value) {
  const text = neutralizeFormula(value).replace(/\r\n?|\n/g, '\r\n');
  return `"${text.replace(/"/g, '""')}"`;
}

function rowFor(item) {
  const drop = item?.mirakurunDrop?.dropTotal;
  const deletion = item?.deletion && typeof item.deletion === 'object' ? item.deletion : null;
  return [
    dateValue(item?.start, dateFormatter),
    dateValue(item?.start, timeFormatter),
    dateValue(item?.end, timeFormatter),
    item?.channel?.name || '',
    item?.fullTitle || item?.title || '',
    item?.category || '',
    resultLabel(item?.status),
    reservationLabel(item?.reservationType),
    finite(item?.operatorActualSeconds) ? item.operatorActualSeconds : '',
    item?.operatorAbort === true ? 'あり' : item?.operatorAbort === false ? 'なし' : '',
    finite(drop) ? drop : '',
    item?.deletionKind === 'explicit' ? '削除済' : item?.deletionKind === 'missing' ? 'ファイル不明' : '',
    deletion?.reason || '',
    item?.recordingPath || ''
  ];
}

export function buildRecordedResultsCsv(items) {
  const rows = [HEADERS, ...(Array.isArray(items) ? items.map(rowFor) : [])];
  return `\uFEFF${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function recordedResultsCsvFilename(now = new Date()) {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const value = type => parts.find(part => part.type === type)?.value || '';
  return `chinachu-recorded-${value('year')}${value('month')}${value('day')}.csv`;
}
