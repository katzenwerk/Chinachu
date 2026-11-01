import { programEndTime } from './program-detail-model.js';

function interval(program) {
  const start = Number(program?.start);
  const end = programEndTime(program);
  if (!Number.isFinite(start) || start <= 0 || end === null || end <= start) {
    throw new Error('番組の放送時間を確認できません');
  }
  return { start, end };
}

function broadcastType(program) {
  const type = program?.channel?.type;
  if (typeof type !== 'string' || !type.trim()) throw new Error('番組の放送波を確認できません');
  return type.trim();
}

export function hasReservationCapacityConflict(program, reserves, tuners, now = Date.now()) {
  if (!Array.isArray(reserves) || !Array.isArray(tuners) || !Number.isFinite(now) ||
      !tuners.every(tuner => Array.isArray(tuner?.types) && tuner.types.length > 0 &&
        tuner.types.every(type => typeof type === 'string' && type.trim() !== ''))) {
    throw new Error('予約・チューナー情報を確認できません');
  }
  const target = interval(program);
  const start = Math.max(target.start, now);
  if (target.end <= start) throw new Error('番組の放送は終了しています');
  const targetId = String(program?.id || '').trim();
  if (!targetId) throw new Error('番組IDを確認できません');
  const events = [
    { at: start, type: broadcastType(program), delta: 1 },
    { at: target.end, type: broadcastType(program), delta: -1 }
  ];
  const seen = new Set([targetId]);
  for (const reserve of reserves) {
    // isConflict付きでもOperatorは録画を試みるため、集計から除外しない。
    if (reserve?.isSkip === true) continue;
    const id = String(reserve?.id || '').trim();
    if (seen.has(id)) continue;
    const time = interval(reserve);
    if (time.end <= start || time.start >= target.end) continue;
    if (!id) throw new Error('予約IDを確認できません');
    seen.add(id);
    const type = broadcastType(reserve);
    events.push({ at: Math.max(time.start, start), type, delta: 1 });
    events.push({ at: Math.min(time.end, target.end), type, delta: -1 });
  }

  // 放送波の各組合せについて、必要本数と、そのいずれかに対応する実チューナー数を比較する。
  // 実チューナーへの割当順序は再現せず、共用チューナーを組合せ内で二重計上しない。
  const groups = [[]];
  for (const type of new Set(events.map(event => event.type))) {
    const length = groups.length;
    for (let i = 0; i < length; i++) groups.push([...groups[i], type]);
  }
  const limits = groups.slice(1).map(types => ({
    types,
    capacity: tuners.filter(tuner => tuner.types.some(type => types.includes(type.trim()))).length
  }));
  events.sort((a, b) => a.at - b.at);
  const counts = new Map();
  let index = 0;
  while (index < events.length) {
    const at = events[index].at;
    // 同時刻の終了・開始をまとめて適用し、境界だけの重複を数えない。
    while (index < events.length && events[index].at === at) {
      const event = events[index++];
      counts.set(event.type, (counts.get(event.type) || 0) + event.delta);
    }
    if (index < events.length && limits.some(limit =>
      limit.types.reduce((sum, type) => sum + (counts.get(type) || 0), 0) > limit.capacity)) return true;
  }
  return false;
}
