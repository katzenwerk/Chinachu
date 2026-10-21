export const TIMETABLE_DEFAULTS = Object.freeze({ channelWidth: 150, hourHeight: 180 });
export const TIMETABLE_LIMITS = Object.freeze({ channelWidth: [100, 260, 10], hourHeight: [80, 300, 10] });

const PROGRAM_FLAG_LABELS = new Map([
  ['新', '🈟'], ['終', '🈡'], ['再', '🈞'], ['字', '🈑'],
  ['デ', '🈓'], ['解', '🈖'], ['無', '🈚'], ['二', '🈔'],
  ['S', '🅂'], ['SS', '🅍'], ['初', '🈠'], ['生', '🈢'],
  ['N', '🄽'], ['Ｎ', '🄽'], ['映', '🈙'], ['多', '🈕'], ['双', '🈒'],
  ['無料', '🈚'], ['映画', '🈙']
]);
const ENCLOSED_PROGRAM_FLAGS = new Set(PROGRAM_FLAG_LABELS.values());
const PROGRAM_FLAG_ALTERNATE_RE = /(?:\[(?:無料|映画|SS|新|終|再|字|デ|解|無|二|S|初|生|N|Ｎ|映|多|双)\]|［(?:無料|映画|SS|新|終|再|字|デ|解|無|二|S|初|生|N|Ｎ|映|多|双)］|【(?:無料|映画|SS|新|終|再|字|デ|解|無|二|S|初|生|N|Ｎ|映|多|双)】)/g;

export function broadcastDayStart(date = new Date()) {
  const value = new Date(date);
  if (value.getHours() < 4) value.setDate(value.getDate() - 1);
  value.setHours(4, 0, 0, 0);
  return value.getTime();
}

export function dateInputValue(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function dayStartFromInput(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 4, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

export function guideDisplayRange(dayStart, now = Date.now()) {
  const currentDayStart = broadcastDayStart(new Date(now));
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  const current = dayStart === currentDayStart;
  return {
    start: current ? Math.max(dayStart, Math.floor(now / 3600000) * 3600000) : dayStart,
    end: dayEnd,
    current,
    currentDayStart
  };
}

export function programPosition(program, rangeStart, hourHeight, rangeEnd = rangeStart + 24 * 60 * 60 * 1000) {
  const start = Number(program?.start);
  const end = Number(program?.end) || start + Number(program?.seconds || 0) * 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= rangeStart || start >= rangeEnd) return null;
  const visibleStart = Math.max(start, rangeStart);
  const visibleEnd = Math.min(end, rangeEnd);
  return {
    top: (visibleStart - rangeStart) / 3600000 * hourHeight,
    height: Math.max(2, (visibleEnd - visibleStart) / 3600000 * hourHeight),
    clippedStart: start < rangeStart,
    clippedEnd: end > rangeEnd
  };
}

export function programDisplayMode(renderedHeight) {
  if (!Number.isFinite(renderedHeight) || renderedHeight < 11) return 'tiny';
  return renderedHeight < 44 ? 'compact' : 'normal';
}

export function programContentLayout(renderedHeight, channelWidth = TIMETABLE_DEFAULTS.channelWidth) {
  const mode = programDisplayMode(renderedHeight);
  if (mode === 'tiny') return { mode, titleLines: 0, descriptionLines: 0, showFlags: false };
  if (mode === 'compact') return { mode, titleLines: 1, descriptionLines: 0, showFlags: false };
  const descriptionLines = channelWidth >= 130
    ? Math.max(0, Math.min(4, Math.floor((renderedHeight - 43) / 14)))
    : 0;
  return { mode, titleLines: 2, descriptionLines, showFlags: true };
}

export function programFlagPresentation(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (ENCLOSED_PROGRAM_FLAGS.has(raw)) {
    const core = raw.normalize('NFKC');
    const tone = core === '新' ? 'new' : core === '終' ? 'final' : core === '再' ? 'repeat' : 'plain';
    return { label: raw, tone };
  }
  const bracketed = [
    ['[', ']'], ['［', '］'], ['【', '】']
  ].some(([open, close]) => raw.startsWith(open) && raw.endsWith(close));
  const core = bracketed ? raw.slice(1, -1).trim() : raw;
  const tone = core === '新' ? 'new' : core === '終' ? 'final' : core === '再' ? 'repeat' : 'plain';
  return { label: PROGRAM_FLAG_LABELS.get(core) || (bracketed ? raw : `[${raw}]`), tone };
}

export function programTitlePresentation(value) {
  return String(value ?? '').replace(PROGRAM_FLAG_ALTERNATE_RE, token => PROGRAM_FLAG_LABELS.get(token.slice(1, -1)) || token);
}

export function isProgramLive(program, now = Date.now()) {
  const start = Number(program?.start);
  const end = Number(program?.end) || start + Number(program?.seconds || 0) * 1000;
  return Number.isFinite(start) && Number.isFinite(end) && start <= now && now < end;
}

export function programState(program, reserves, recording) {
  const reserve = (reserves || []).find(item => item?.id === program?.id) || null;
  const active = (recording || []).find(item => item?.id === program?.id) || null;
  if (active) return { key: 'recording', label: '録画中', reserve: active };
  if (!reserve) return { key: 'none', label: '未予約', reserve: null };
  if (reserve.isSkip) return { key: 'skip', label: 'スキップ', reserve };
  if (reserve.isConflict) return { key: 'conflict', label: '競合', reserve };
  return { key: reserve.isManualReserved ? 'manual' : 'rule', label: reserve.isManualReserved ? '手動予約' : 'ルール予約', reserve };
}

export function scotify(program) {
  const start = new Date(Number(program.start));
  const stamp = `${start.getFullYear()}/${String(start.getMonth() + 1).padStart(2, '0')}/${String(start.getDate()).padStart(2, '0')} ${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
  return `${program.channel?.name || ''}: ${program.title || ''} (${stamp}) [chinachu://${program.id || ''}]`;
}
