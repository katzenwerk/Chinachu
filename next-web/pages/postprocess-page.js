const REFRESH_MS = 5000;
const TYPES = [
  ['match', 'match更新'],
  ['ffprobe', 'ffprobe'],
  ['thumbnail', 'サムネイル'],
  ['ts', 'TS解析']
];

// Rearrange the six sections here; each section renders independently.
const SECTIONS = [
  ['tasks', 'タスク状態', renderTasks],
  ['queue', 'キュー', renderQueue],
  ['waiting', '待機中のタスク', renderWaiting],
  ['completed', '直近の完了タスク', renderCompleted],
  ['current', '現在のTS解析処理', renderCurrentTs],
  ['results', '最近のTS解析結果', renderTsResults]
];

function node(tag, className = '', value = null) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== null) element.textContent = String(value);
  return element;
}
function typeName(type) { return TYPES.find(([key]) => key === type)?.[1] || type; }
function number(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function clock(value) {
  const time = Number(value);
  return Number.isFinite(time) && time > 0 ? new Date(time).toLocaleTimeString('ja-JP', {
    hour: '2-digit', minute: '2-digit', hour12: false
  }) : '--:--';
}
function elapsed(value) {
  const seconds = Math.max(0, Math.round(number(value) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${seconds}秒`;
}
function detailLink(id, title) {
  const link = node('a', 'postprocess-detail-link', title);
  link.href = `#program?id=${encodeURIComponent(id)}`;
  return link;
}
function status(value, label) {
  const span = node('span', `postprocess-state is-${value}`, label);
  return span;
}
function dataTable(headers, rows) {
  const wrap = node('div', 'postprocess-table-scroll');
  const table = node('table', 'postprocess-table');
  const head = node('thead');
  const heading = node('tr');
  for (const name of headers) heading.append(node('th', '', name));
  head.append(heading);
  const body = node('tbody');
  for (const cells of rows) {
    const row = node('tr');
    for (const value of cells) {
      const cell = node('td');
      if (value instanceof Node) cell.append(value);
      else cell.textContent = String(value ?? '');
      row.append(cell);
    }
    body.append(row);
  }
  table.append(head, body);
  wrap.append(table);
  return wrap;
}
function empty(message) { return node('p', 'postprocess-empty', message); }

function renderTasks(data) {
  const rows = (data.queues || []).map(item => {
    const current = item.active ? status('running', '実行中') : item.pending ? status('waiting', '待機中') : status('idle', '空き');
    return [typeName(item.type), current, item.pending ? `${item.pending}件` : '0件'];
  });
  return rows.length ? dataTable(['処理種別', '状態', '待機件数'], rows) : empty('状態を取得中です');
}
function renderQueue(data) {
  const rows = (data.queues || []).map(item => [typeName(item.type), `${item.pending}件`,
    item.type === 'ts' ? `未解析残 ${number(item.remaining)}件（キュー未投入）` :
      item.type === 'match' ? '更新要求を集約' : '実行順はOperatorが調整']);
  return rows.length ? dataTable(['処理種別', '待機', '備考'], rows) : empty('キューを取得中です');
}
function renderCurrentTs(data) {
  const auto = data.auto || {};
  const active = data.currentTs;
  if (!active) {
    const explanations = {
      disabled: '自動解析は無効です。手動解析は録画詳細から実行できます。',
      paused: '自動解析は一時停止中です。',
      complete: '対象の未解析録画はありません。',
      'recording-limit': '録画本数の条件が整うまで待機しています。',
      'recording-transition': '録画切替が近いため待機しています。',
      'manual-running': '手動のメンテナンス処理を優先しています。',
      idle: '自動解析の実行条件を確認しています。'
    };
    return empty(explanations[auto.state] || 'TS解析は現在実行していません。');
  }
  const box = node('div', 'postprocess-current');
  const line = node('div', 'postprocess-current-heading');
  line.append(status('running', active.mode === 'manual' ? '手動解析中' : '自動解析中'));
  line.append(node('strong', 'postprocess-clip', active.title || active.id || '対象ファイル確認中'));
  const percentage = active.mode === 'auto' && number(active.size) > 0
    ? Math.min(100, Math.floor(100 * number(active.bytesRead) / number(active.size))) : null;
  if (percentage !== null) line.append(node('strong', 'postprocess-percent', `${percentage}%`));
  box.append(line);
  if (percentage !== null) {
    const progress = node('progress', 'postprocess-progress');
    progress.max = 100;
    progress.value = percentage;
    box.append(progress);
    box.append(node('p', 'postprocess-muted', `${(number(active.bytesRead) / 1048576).toFixed(0)} / ${(number(active.size) / 1048576).toFixed(0)} MiB`));
  } else {
    box.append(node('p', 'postprocess-muted', active.mode === 'manual' ? '手動解析の進捗率は取得していません。' : '録画ファイルを確認しています。'));
  }
  return box;
}
function renderWaiting(data) {
  const rows = (data.waiting || []).map(item => [
    typeName(item.type),
    item.id ? detailLink(item.id, item.title || item.id) : (item.title || '-'),
    clock(item.queuedAt)
  ]);
  if (!rows.length) return empty('待機しているタスクはありません。');
  const box = node('div');
  box.append(dataTable(['処理', '対象・内容', '受付'], rows));
  box.append(node('p', 'postprocess-muted', number(data.queuedTotal) > rows.length
    ? `ほか${data.queuedTotal - rows.length}件。受付時刻順の参考表示で、実行順ではありません。`
    : '受付時刻順の参考表示で、実行順ではありません。'));
  return box;
}
function completedStatus(value) {
  return value === 'suspect' ? status('warning', '異常') :
    value === 'interrupted' ? status('idle', '中断') :
    value === 'failed' ? status('failed', '失敗') : status('complete', '完了');
}
function renderCompleted(data) {
  const rows = (data.completed || []).map(item => [
    clock(item.finishedAt),
    typeName(item.type),
    item.id ? detailLink(item.id, item.title || item.id) : (item.title || '-'),
    elapsed(item.durationMs),
    completedStatus(item.status)
  ]);
  return rows.length ? dataTable(['終了', '処理', '対象・内容', '所要', '結果'], rows) :
    empty('Operator起動後の完了履歴はまだありません。');
}
function tsStatus(value) {
  return value === 'SUSPECT' ? status('warning', '異常') :
    value === 'ERROR' ? status('failed', '失敗') : status('complete', 'OK');
}
function renderTsResults(data) {
  const rows = (data.recentTs || []).map(item => [
    clock(item.checkedAt),
    tsStatus(item.status),
    detailLink(item.id, item.title),
    item.status === 'ERROR' ? (item.error || '解析に失敗しました') :
      item.status === 'SUSPECT' ? `CC ${item.ccErrorEvents}件 / 時間飛び ${item.pcrGapEvents}件` : '異常未検出'
  ]);
  return rows.length ? dataTable(['解析', '結果', '録画番組', '内容'], rows) :
    empty('解析結果はまだ記録されていません。');
}

export function renderPostprocessPage(container) {
  const root = node('div', 'postprocess-page');
  const heading = node('div', 'postprocess-heading');
  heading.append(node('h2', '', '後処理モニター'));
  const updated = node('span', 'postprocess-muted', '状態取得中…');
  heading.append(updated);
  root.append(heading);
  const error = node('p', 'postprocess-error');
  error.hidden = true;
  root.append(error);
  const grid = node('div', 'postprocess-grid');
  const sections = new Map();
  for (const [id, title, render] of SECTIONS) {
    const section = node('section', 'panel postprocess-section');
    section.dataset.section = id;
    section.append(node('h3', 'postprocess-section-heading', title));
    const content = node('div', 'postprocess-section-body');
    content.append(empty('取得中…'));
    section.append(content);
    grid.append(section);
    sections.set(id, { content, render });
  }
  root.append(grid);
  root.append(node('p', 'postprocess-muted postprocess-note',
    '完了タスクはOperator起動後の最新5件です。TS解析結果は録画管理台帳に保存された最新5件を表示します。'));
  container.replaceChildren(root);

  let disposed = false;
  let fetching = false;
  const controller = new AbortController();
  async function refresh() {
    if (disposed || fetching || document.hidden) return;
    fetching = true;
    try {
      const response = await fetch('/api/recorded/auto-analysis.json?monitor=1', {
        headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal
      });
      if (!response.ok) throw new Error(`モニターAPIの取得に失敗しました（HTTP ${response.status}）。`);
      const data = await response.json();
      if (data?.monitorVersion !== 1) throw new Error(data?.message || 'Operatorがモニターに対応していません。');
      if (disposed) return;
      for (const { content, render } of sections.values()) content.replaceChildren(render(data));
      error.hidden = true;
      updated.textContent = `${clock(data.updatedAt)} 更新 · 5秒間隔`;
    } catch (cause) {
      if (disposed || cause?.name === 'AbortError') return;
      error.textContent = cause.message || String(cause);
      error.hidden = false;
    } finally { fetching = false; }
  }
  const timer = window.setInterval(refresh, REFRESH_MS);
  document.addEventListener('visibilitychange', refresh);
  void refresh();
  return () => {
    disposed = true;
    controller.abort();
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', refresh);
  };
}
