import { createProgramHover, programHoverInfo, setProgramHover } from '../components/program-hover.js';

const REFRESH_MS = 5000;
const TYPES = [
  ['match', 'match更新'],
  ['ffprobe', 'ffprobe'],
  ['thumbnail', 'サムネイル'],
  ['ts', 'TS解析']
];

const SECTIONS = [
  ['tasks', 'タスク状態', renderTasks],
  ['waiting', '実行中・待機中のタスク', renderWaiting],
  ['completed', '直近の完了タスク', renderCompleted],
  ['current', '現在のTS解析状況', renderCurrentTs],
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
function detailLink(id, title, programs = {}) {
  const link = node('a', 'postprocess-detail-link', title);
  link.href = `#program?id=${encodeURIComponent(id)}`;
  const program = programs[String(id)];
  if (program) {
    const channel = program.channel || {};
    setProgramHover(link, () => programHoverInfo(program, {
      channelLogoUrl: channel.id && channel.hasLogoData === true
        ? `/api/channel/${encodeURIComponent(channel.id)}/logo.png` : null
    }));
  }
  return link;
}
function status(value, label) {
  const span = node('span', `postprocess-state is-${value}`, label);
  return span;
}
function dataTable(headers, rows, keys = []) {
  const wrap = node('div', 'postprocess-table-scroll');
  const table = node('table', 'postprocess-table');
  const head = node('thead');
  const heading = node('tr');
  for (const name of headers) heading.append(node('th', '', name));
  head.append(heading);
  const body = node('tbody');
  for (const [index, cells] of rows.entries()) {
    const row = node('tr');
    row.dataset.taskKey = keys[index] || String(index);
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
    const auto = data.auto || {};
    const waiting = item.pending > 0 || item.type === 'ts' && auto.enabled && !auto.paused && item.remaining > 0;
    const current = item.active ? status('running', '実行中') :
      waiting ? status('waiting', '待機中') :
      item.type === 'ts' && !auto.enabled ? status('idle', '無効') :
      item.type === 'ts' && auto.paused ? status('idle', '一時停止') : status('idle', '空き');
    const note = item.type === 'ts'
      ? `未解析残 ${number(item.remaining)}件（自動解析候補・キュー未投入）`
      : item.type === 'match' ? '更新要求を集約' : '';
    return [typeName(item.type), current, `${number(item.pending)}件`, note];
  });
  if (!rows.length) return empty('状態を取得中です');
  const box = node('div');
  box.append(dataTable(['処理種別', '状態', 'キュー待機', '備考'], rows, (data.queues || []).map(item => item.type)));
  const explanation = data.auto?.enabled === false ? '自動TS解析は無効です。' :
    data.auto?.paused ? '自動TS解析は一時停止中です。' :
    '録画や他の処理に支障がないときに、順次解析します。';
  box.append(node('p', 'postprocess-muted',
    `※ TS未解析残数は待機ジョブ数ではありません。${explanation}`));
  return box;
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
  const title = active.id ? detailLink(active.id, active.title || active.id, data.programs)
    : node('strong', '', active.title || '対象ファイル確認中');
  title.classList.add('postprocess-clip');
  line.append(title);
  const percentage = active.mode === 'auto' && number(active.size) > 0
    ? Math.min(100, Math.floor(100 * number(active.bytesRead) / number(active.size))) : null;
  if (percentage !== null) line.append(node('strong', 'postprocess-percent', `${percentage}%`));
  box.append(line);
  box.append(node('p', 'postprocess-path', active.recordedPath || '録画パス未取得'));
  if (percentage !== null) {
    const progress = node('progress', 'postprocess-progress');
    progress.max = 100;
    progress.value = percentage;
    box.append(progress);
    box.append(node('p', 'postprocess-muted postprocess-bytes', `${(number(active.bytesRead) / 1048576).toFixed(0)} / ${(number(active.size) / 1048576).toFixed(0)} MiB`));
  } else {
    box.append(node('p', 'postprocess-muted', active.mode === 'manual' ? '手動解析の進捗率は取得していません。' : '録画ファイルを確認しています。'));
  }
  return box;
}
function renderWaiting(data) {
  const running = (data.running || []).map(item => [
    status('running', '実行中'), typeName(item.type),
    item.id ? detailLink(item.id, item.title || item.id, data.programs) : (item.title || '-'),
    clock(item.startedAt)
  ]);
  const waiting = (data.waiting || []).map(item => [
    status('waiting', '待機中'), typeName(item.type),
    item.id ? detailLink(item.id, item.title || item.id, data.programs) : (item.title || '-'),
    clock(item.queuedAt)
  ]);
  const rows = running.concat(waiting);
  if (!rows.length) return empty('実行中・待機中のタスクはありません。');
  const box = node('div');
  box.append(dataTable(['状態', '処理', '対象・内容', '開始／受付'], rows,
    [...(data.running || []), ...(data.waiting || [])].map(item => `${item.type}:${item.id}:${item.startedAt || item.queuedAt}`)));
  if (number(data.queuedTotal) > waiting.length) {
    box.append(node('p', 'postprocess-muted',
      `待機中のほか${number(data.queuedTotal) - waiting.length}件は省略しています。表示順は実行順を保証しません。`));
  }
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
    item.id ? detailLink(item.id, item.title || item.id, data.programs) : (item.title || '-'),
    elapsed(item.durationMs),
    completedStatus(item.status)
  ]);
  return rows.length ? dataTable(['終了', '処理', '対象・内容', '所要', '結果'], rows,
    (data.completed || []).map(item => `${item.type}:${item.id}:${item.finishedAt}`)) :
    empty('Operator起動後の完了履歴はまだありません。');
}
function tsStatus(value) {
  return value === 'SUSPECT' ? status('warning', '異常') :
    value === 'ERROR' ? status('failed', '失敗') : status('complete', 'OK');
}
function renderTsResults(data) {
  const rows = (data.recentTs || []).map(item => {
    const result = node('div', 'postprocess-result-summary');
    result.append(tsStatus(item.status));
    result.append(node('span', 'postprocess-result-text',
      item.status === 'ERROR' ? (item.error || '解析に失敗しました') :
      item.status === 'SUSPECT' ? `CC ${item.ccErrorEvents}件 / 時間飛び ${item.pcrGapEvents}件` : '異常未検出'));
    return [clock(item.checkedAt), detailLink(item.id, item.title, data.programs), result];
  });
  return rows.length ? dataTable(['解析', '録画番組', '結果・内容'], rows, (data.recentTs || []).map(item => String(item.id))) :
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
    sections.set(id, { content, render, signature: '' });
  }
  root.append(grid);
  root.append(node('p', 'postprocess-muted postprocess-note',
    '完了タスクはOperator起動後の最新20件です。TS解析結果は録画管理台帳に保存された最新5件を表示します。'));
  container.replaceChildren(root);
  const hover = createProgramHover(root);

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
      for (const [id, section] of sections) {
        // Retain unchanged rows and HOVER targets across the 5-second refresh.
        const snapshot = id === 'tasks' ? [data.queues, data.auto?.enabled, data.auto?.paused] :
          id === 'waiting' ? [data.running, data.waiting, data.queuedTotal, data.programs] :
          id === 'completed' ? [data.completed, data.programs] :
          id === 'results' ? [data.recentTs, data.programs] : [data.currentTs, data.auto?.state];
        const signature = JSON.stringify(snapshot);
        if (section.signature === signature) continue;
        const ts = data.currentTs;
        const identity = ts ? `${ts.mode}:${ts.id}:${ts.title}:${ts.recordedPath}` : '';
        if (id === 'current' && ts && section.identity === identity) {
          const progress = section.content.querySelector('.postprocess-progress');
          const bytes = section.content.querySelector('.postprocess-bytes');
          const percentNode = section.content.querySelector('.postprocess-percent');
          if (progress && bytes && percentNode && number(ts.size) > 0) {
            const percent = Math.min(100, Math.floor(100 * number(ts.bytesRead) / number(ts.size)));
            progress.value = percent;
            percentNode.textContent = `${percent}%`;
            bytes.textContent = `${(number(ts.bytesRead) / 1048576).toFixed(0)} / ${(number(ts.size) / 1048576).toFixed(0)} MiB`;
            section.signature = signature;
            continue;
          }
        }
        const incoming = section.render(data);
        const body = section.content.querySelector('tbody');
        const nextBody = incoming.querySelector('tbody');
        if (body && nextBody && section.content.querySelector('thead').outerHTML === incoming.querySelector('thead').outerHTML) {
          const rows = new Map(Array.from(body.children).map(row => [row.dataset.taskKey, row]));
          const desired = Array.from(nextBody.children).map(row => {
            const retained = rows.get(row.dataset.taskKey);
            if (!retained) return row;
            Array.from(row.children).forEach((cell, index) => {
              const current = retained.children[index];
              const comparison = current.cloneNode(true);
              comparison.querySelectorAll('[aria-describedby="program-hover"]').forEach(target => target.removeAttribute('aria-describedby'));
              if (comparison.outerHTML !== cell.outerHTML) {
                if (current.querySelector('[aria-describedby="program-hover"]')) hover.close();
                current.replaceWith(cell);
              }
            });
            return retained;
          });
          const wanted = new Set(desired);
          for (const row of Array.from(body.children)) if (!wanted.has(row)) row.remove();
          let cursor = body.firstChild;
          for (const row of desired) {
            if (row === cursor) cursor = cursor.nextSibling;
            else body.insertBefore(row, cursor);
          }
          const note = section.content.querySelector('p.postprocess-muted');
          const nextNote = incoming.querySelector('p.postprocess-muted');
          if (note && nextNote) { if (note.textContent !== nextNote.textContent) note.textContent = nextNote.textContent; }
          else if (note) note.remove();
          else if (nextNote) section.content.firstElementChild.append(nextNote);
        } else if (section.content.firstElementChild?.outerHTML !== incoming.outerHTML) section.content.replaceChildren(incoming);
        section.signature = signature;
        section.identity = id === 'current' ? identity : '';
      }
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
    hover.dispose();
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', refresh);
  };
}
