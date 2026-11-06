'use strict';

const { completed } = require('./saved-ts-analysis');

// This reads the recorded ledger only. No filesystem checks, sorting or persistent queue.
function summarize(recorded, now = Date.now(), ignoreCandidate = () => false) {
  const counts = { completed: 0, remaining: 0, failed: 0, suspect: 0 };
  let candidate = null;
  let newest = -Infinity;
  for (const entry of recorded || []) {
    if (!entry || entry.id === undefined || entry.id === null || typeof entry.recorded !== 'string' || !entry.recorded.trim() ||
        entry.operatorResumePending === true || entry.pid) continue;
    const ended = Number(entry.operatorRecordingEnd) || Number(entry.end);
    if (!Number.isFinite(ended) || ended <= 0 || ended > now) continue;
    const result = entry.savedTsAnalysis?.result;
    if (completed(result)) {
      counts.completed++;
      if (result.status === 'SUSPECT') counts.suspect++;
    } else if (result?.status === 'ERROR') {
      counts.failed++;
    } else {
      counts.remaining++;
      if (ended > newest && !ignoreCandidate(entry)) { newest = ended; candidate = entry; }
    }
  }
  return { counts, candidate };
}

// Maximum number of recordings overlapping any point in [now, now + horizonMs].
// End events precede start events when timestamps match.
function peakRecordings(recording, reserves, isRecordedForReserve, now = Date.now(), horizonMs = 5 * 60 * 1000) {
  const until = now + horizonMs;
  const events = [];
  const activeIds = new Set();
  let active = 0;
  for (const program of recording || []) {
    if (!program || program.operatorRecordingEnd || program.operatorResumePending || program._operatorManualRemovalPending) continue;
    active++;
    activeIds.add(String(program.id));
    const end = Number(program.end);
    if (end > now && end <= until) events.push({ time: end, change: -1 });
  }
  const scheduledIds = new Set();
  for (const program of reserves || []) {
    if (!program || program.isSkip || program.isConflict || program._operatorNg || program._operatorAbort ||
        activeIds.has(String(program.id)) || scheduledIds.has(String(program.id))) continue;
    const start = Number(program.start);
    const end = Number(program.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= now || start > until ||
        isRecordedForReserve(program)) continue;
    scheduledIds.add(String(program.id));
    if (start <= now) active++;
    else events.push({ time: start, change: 1 });
    if (end <= until) events.push({ time: end, change: -1 });
  }
  let peak = active;
  events.sort((a, b) => a.time - b.time || a.change - b.change);
  for (const event of events) {
    active += event.change;
    if (active > peak) peak = active;
  }
  return peak;
}

function nextReviewDelay(now = Date.now()) {
  const next = new Date(now);
  const minute = next.getMinutes();
  next.setSeconds(0, 0);
  if (minute < 10) next.setMinutes(10);
  else if (minute < 40) next.setMinutes(40);
  else { next.setHours(next.getHours() + 1); next.setMinutes(10); }
  return Math.max(1, next.getTime() - now);
}

module.exports = { summarize, peakRecordings, nextReviewDelay };
