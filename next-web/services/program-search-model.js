// Search only the already fetched EPG metadata. Never inspect recording files.
function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('ja-JP');
}

export function searchSchedule(schedule, { query = '', types = null, type = '', channelId = '', category = '', period = '', now = Date.now() } = {}) {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  const lowerBound = Number(now);
  const periodHours = period === '24h' ? 24 : period === '7d' ? 7 * 24 : 0;
  const upperBound = lowerBound + periodHours * 3600000;
  const results = [];
  for (const channel of Array.isArray(schedule) ? schedule : []) {
    if (types != null && !types.includes(String(channel?.type || ''))) continue;
    if (type && String(channel?.type || '') !== type) continue;
    if (channelId && String(channel?.id ?? '') !== channelId) continue;
    for (const program of Array.isArray(channel?.programs) ? channel.programs : []) {
      const start = Number(program?.start);
      if (!Number.isFinite(start)) continue;
      if (periodHours && (start < lowerBound || start >= upperBound)) continue;
      if (category && String(program?.category || '') !== category) continue;
      const haystack = normalize([
        program?.title, program?.fullTitle, program?.subTitle, program?.description, program?.detail,
        channel?.name
      ].filter(Boolean).join(' '));
      if (!terms.every(term => haystack.includes(term))) continue;
      results.push({ program, channel, start });
    }
  }
  results.sort((a, b) => a.start - b.start || String(a.channel?.id || '').localeCompare(String(b.channel?.id || '')));
  return results;
}
