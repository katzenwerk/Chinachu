import { loadProgramDetail } from './program-detail-client.js';
import { buildProgramDetailModel, programSeriesContext } from './program-detail-model.js';
import { loadSeriesProjection } from './series-client.js';
import { buildSeriesEventIndex } from './series-event-model.js';

// Share only in-flight detail reads; never keep a stale action model after completion.
const pendingActionDetails = new Map();

export async function loadProgramActionContext(id, knownSeriesContext) {
  const key = String(id);
  if (!pendingActionDetails.has(key)) {
    const request = loadProgramDetail({ id }).finally(() => pendingActionDetails.delete(key));
    pendingActionDetails.set(key, request);
  }
  const detail = await pendingActionDetails.get(key);
  const model = buildProgramDetailModel(detail);
  let seriesContext = null;
  const knownKey = knownSeriesContext?.eventKey || knownSeriesContext?.event?.key;
  if (model.eventKey && knownKey === model.eventKey) seriesContext = knownSeriesContext;
  else if (model.eventKey) {
    try {
      const snapshot = await loadSeriesProjection({ eventKeys: [model.eventKey] });
      seriesContext = programSeriesContext(model, detail.program, buildSeriesEventIndex(snapshot).get(model.eventKey) || null);
    } catch (_) { /* 詳細モーダルと同様、シリーズ取得失敗でも番組操作は利用する。 */ }
  }
  return { detail, model, seriesContext };
}

function validTitle(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : 'タイトル未取得';
}

export function programActionTitle(program) {
  return validTitle(program?.fullTitle || program?.title);
}

export async function copyProgramTitle(title) {
  const value = typeof title === 'string' ? title : '';
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const input = document.createElement('textarea');
  input.value = value;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.append(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('copy failed');
}

export function programSearchUrl(provider, title) {
  const query = encodeURIComponent(validTitle(title));
  if (provider === 'google') return `https://www.google.com/search?q=${query}`;
  if (provider === 'wikipedia') return `https://ja.wikipedia.org/w/index.php?search=${query}`;
  throw new Error(`Unsupported program search provider: ${provider}`);
}
