import { loadRecordedMaintenance, requestRecordedMaintenance } from '../services/recorded-maintenance-client.js';
import { invalidateResources } from '../services/api-client.js';
import { notifyRecordedThumbnailReady } from '../services/recorded-thumbnail-client.js';
import { formatRecordingSeconds, savedTsResultInfo } from '../services/recorded-result-warnings.js';

const STEP_LABELS = { checking: '対象確認中', running: '実行中', failed: '失敗', interrupted: '中断' };
export function savedTsLabel(value) {
  const info = savedTsResultInfo(value);
  return info.findings ? '要確認' : info.label;
}
function fact(host, name, value) {
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');
  dt.textContent = name; dd.textContent = String(value);
  host.append(dt, dd);
}
export function createSavedTsSummary(value) {
  if (!value) return null;
  const section = document.createElement('section');
  section.className = 'program-saved-ts-summary';
  const heading = document.createElement('h4'); heading.textContent = 'TS解析';
  const list = document.createElement('dl'); list.className = 'program-saved-ts-facts';
  const result = value.result || {};
  const present = value => value !== undefined && value !== null && value !== '' && value !== '-';
  const count = value => Number.isFinite(value) && value >= 0 ? `${value}件` : '不明';
  const pid = value => Number.isInteger(value) ? `0x${value.toString(16).toUpperCase().padStart(4, '0')}` : value;
  const offset = value => Number.isFinite(value) && value >= 0 ? `${value.toLocaleString('ja-JP')} bytes（0x${value.toString(16).toUpperCase()}）` : '不明';
  function summaryFact(name, value, className = '') {
    const pair = document.createElement('div'); pair.className = className;
    fact(pair, name, value); list.append(pair);
  }
  function note(host, text) {
    const paragraph = document.createElement('p'); paragraph.textContent = text; host.append(paragraph);
  }
  function table(host, label, rows, fields) {
    const wrap = document.createElement('div'); wrap.className = 'program-saved-ts-table-scroll';
    wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', label);
    const table = document.createElement('table');
    const caption = document.createElement('caption'); caption.textContent = label;
    const head = document.createElement('thead'); const headers = document.createElement('tr');
    for (const [name] of fields) { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = name; headers.append(cell); }
    head.append(headers);
    const body = document.createElement('tbody');
    for (const row of rows) {
      const line = document.createElement('tr');
      for (const [, key, format] of fields) {
        const cell = document.createElement('td');
        cell.textContent = present(row[key]) ? (format ? format(row[key]) : row[key]) : '不明';
        line.append(cell);
      }
      body.append(line);
    }
    table.append(caption, head, body); wrap.append(table); host.append(wrap);
  }
  function sampleLabel(name, rows, total, truncated) {
    if (Number.isFinite(total) && total > rows.length) return `${name}（全${total}件中、詳細${rows.length}件）`;
    if (!Number.isFinite(total) || truncated) return `${name}（詳細${rows.length}件・${truncated ? '保存上限あり' : '全件数不明'}）`;
    return name;
  }
  summaryFact('結果', savedTsLabel(value), 'is-wide is-result');
  summaryFact('CC異常', count(result.ccErrorEvents));
  summaryFact('GAP候補', count(result.pcrGapEvents));
  summaryFact('その他の異常', `TEI ${count(result.teiPackets)} / 同期 ${count(result.syncErrorEvents)} / ヘッダー ${count(result.invalidHeaderPackets)}`, 'is-wide');
  if (!result.completed) summaryFact('未完了・失敗理由', result.stopReason || result.error || '不明', 'is-wide');
  if (result.completed && result.pcrSamples === 0) summaryFact('PCR評価', 'PCR未検出のため時間飛びは評価できません。', 'is-wide');
  if (value.lastAttempt) summaryFact('直近の再解析', `${value.lastAttempt.status}: ${value.lastAttempt.reason || ''}（前回の完了結果を保持）`, 'is-wide');
  section.append(heading, list);
  const gaps = Array.isArray(result.pcrGapSamples) ? result.pcrGapSamples : [];
  const cc = Array.isArray(result.ccSamples) ? result.ccSamples : [];
  function ccContent(sample) {
    const change = `${sample.previousCc}→${sample.actualCc}`;
    if (sample.kind === 'repeat-changed') return `${change}（内容変化）`;
    if (sample.kind === 'repeat-excess') return `${change}（繰り返し過多）`;
    if (!Number.isInteger(sample.expectedCc) || !Number.isInteger(sample.actualCc)) return change;
    const difference = (sample.actualCc - sample.expectedCc + 16) % 16;
    return `${change}（期待${sample.expectedCc}・差${difference}）`;
  }
  const events = [
    ...gaps.map(sample => ({ type: 'gap', sample, byteOffset: sample.fromOffset })),
    ...cc.map(sample => ({ type: 'cc', sample, byteOffset: sample.byteOffset }))
  ].sort((a, b) => (Number.isFinite(a.byteOffset) ? a.byteOffset : Number.MAX_SAFE_INTEGER) -
    (Number.isFinite(b.byteOffset) ? b.byteOffset : Number.MAX_SAFE_INTEGER));
  if (events.length) {
    const rows = events.map(({ type, sample }) => ({
      start: type === 'gap' ? sample.fromPcr : sample.pcr,
      tot: sample.tot,
      type: type === 'gap' ? 'GAP' : `PID ${pid(sample.pid)}`,
      content: type === 'gap'
        ? `${Number.isFinite(sample.deltaMs) ? (sample.deltaMs / 1000).toFixed(2) + '秒' : '不明'}${sample.lowData === true ? '（低データ量疑い）' : ''}`
        : ccContent(sample)
    }));
    table(section, sampleLabel('異常発生一覧', rows,
      (result.ccErrorEvents || 0) + (result.pcrGapEvents || 0), result.ccSamplesTruncated || result.pcrGapSamplesTruncated), rows, [
      ['開始時間', 'start'], ['放送時刻（TOT）', 'tot'],
      ['種別', 'type'], ['欠落候補・内容', 'content']
    ]);
    note(section, 'PCR観測時刻は厳密な再生位置ではありません。GAPは時間飛び候補で、欠落の確定ではありません。CC差は実際の欠落パケット数を示すものではありません。');
  } else if ((result.ccErrorEvents || 0) + (result.pcrGapEvents || 0) > 0) {
    note(section, '異常の発生位置は保存されていません。');
  }
  const details = document.createElement('details');
  const summary = document.createElement('summary'); summary.textContent = '異常詳細'; details.append(summary);
  const pids = Object.entries(result.ccErrorsByPid || {}).filter(([, count]) => Number.isFinite(count) && count > 0)
    .map(([key, count]) => ({ pid: /^\d+$/.test(key) ? Number(key) : key, count }));
  if (pids.length) table(details, 'CC異常・PID別件数', pids, [['PID', 'pid', pid], ['件数', 'count', count]]);
  if (result.pidResultsTruncated) note(details, 'PID別内訳は保存上限までの表示です。');
  if (result.pcrLowDataGapEvents > 0) note(details, `GAP補足：低データ量の疑い ${count(result.pcrLowDataGapEvents)}`);
  if (gaps.length) table(details, 'GAP補足', gaps, [
    ['開始時間', 'fromPcr'],
    ['時間差', 'deltaMs', value => Number.isFinite(value) ? `${(value / 1000).toFixed(2)}秒` : '不明'],
    ['通常区間比', 'rateRatio', value => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '不明'],
    ['データ量低下', 'lowData', value => value === true ? '疑いあり' : value === false ? '記録なし' : '不明']
  ]);
  const technical = document.createElement('details');
  const technicalSummary = document.createElement('summary'); technicalSummary.textContent = '技術詳細'; technical.append(technicalSummary);
  const stats = document.createElement('dl');
  if (Number.isFinite(value.file?.size)) fact(stats, '対象ファイルサイズ', `${value.file.size} bytes`);
  for (const [key, label] of [['pcrPid', 'PCR PID'], ['pcrSamples', 'PCRサンプル数'], ['totValidSections', '有効TOT数'],
    ['pcrBackwards', 'PCR逆行候補'], ['pcrResets', 'PCR時計切替']]) {
    if (present(result[key])) fact(stats, label, key === 'pcrPid' ? pid(result[key]) : result[key]);
  }
  technical.append(stats);
  if (cc.length) table(technical, sampleLabel('CC異常の発生箇所', cc, result.ccErrorEvents, result.ccSamplesTruncated), cc, [
    ['PID', 'pid', pid], ['種別', 'kind', value => ({ 'counter-jump': 'CC不連続', 'repeat-changed': '同一CCで内容変更', 'repeat-excess': '同一CCの繰り返し過多' })[value] || value],
    ['バイト位置', 'byteOffset', offset], ['PID内の検出順', 'occurrence'], ['直前CC', 'previousCc'],
    ['期待CC', 'expectedCc'], ['実測CC', 'actualCc'], ['PCR観測値', 'pcr'], ['直近TOT', 'tot']
  ]);
  else if (result.ccErrorEvents > 0) note(technical, `CC異常の発生位置は未保存です（全${result.ccErrorEvents}件中、詳細0件）。`);
  if (gaps.length) table(technical, 'GAP候補・技術情報', gaps, [
    ['PCR PID', 'pid', pid], ['PCR区間', 'segment'], ['開始バイト位置', 'fromOffset', offset], ['終了バイト位置', 'toOffset', offset],
    ['終了PCR観測値', 'toPcr'], ['区間データ量', 'bytesBetween', value => Number.isFinite(value) ? `${value.toLocaleString('ja-JP')} bytes` : '不明'], ['直近TOT', 'tot']
  ]);
  if ([result.teiPackets, result.syncErrorEvents, result.invalidHeaderPackets].some(value => value > 0)) {
    note(technical, 'TEI・同期異常・ヘッダー異常は件数のみが保存されており、個別の発生位置は保存されていません。');
  }
  const shown = new Set(['file', 'ccErrorEvents', 'pcrGapEvents', 'teiPackets', 'syncErrorEvents', 'invalidHeaderPackets',
    'pcrBackwards', 'pcrResets', 'pcrPid', 'pcrSamples', 'totValidSections', 'ccErrorsByPid']);
  if (result.pcrLowDataGapEvents > 0) shown.add('pcrLowDataGapEvents');
  const extra = Object.fromEntries(Object.entries(result).filter(([key]) => !shown.has(key)));
  if (Object.keys(extra).length) {
    const raw = document.createElement('details'); const title = document.createElement('summary'); title.textContent = 'その他の解析統計（JSON）';
    const pre = document.createElement('pre'); pre.textContent = JSON.stringify(extra, null, 2);
    raw.append(title, pre); technical.append(raw);
  }
  details.append(technical);
  section.append(details);
  return section;
}
export function openRecordedMaintenanceDialog({ id, title, onUpdated, getRecordingWarnings = () => null }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'recorded-maintenance-dialog';
  const controller = new AbortController();
  let disposed = false, pending = false, pendingInput = null, state = null, timer = null, error = '', refreshError = '', manualPath = '', announced = '';
  let selectedRoots = null, confirmed = false, confirmedToken = null;
  let analysisOpen = null, searchOpen = false, manualOpen = false, recoveryRequested = false;
  const failures = {};
  const busy = () => pending || ['queued', 'running'].includes(state?.job?.status);
  function button(label, fn, disabled = false) {
    const element = document.createElement('button');
    element.className = 'button'; element.type = 'button'; element.textContent = label;
    element.disabled = disabled;
    element.addEventListener('click', fn);
    return element;
  }
  function disclosure(label, open, changed) {
    const element = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = label;
    element.append(summary); element.open = open;
    element.addEventListener('toggle', () => changed(element.open));
    return element;
  }
  function checkbox(host, label, checked, change, disabled = false) {
    const row = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox'; input.checked = checked; input.disabled = disabled;
    input.addEventListener('change', () => { change(input.checked); render(); });
    row.append(input, document.createTextNode(label)); host.append(row);
  }
  function accept(next) {
    state = next;
    if (analysisOpen === null && next.analysis) analysisOpen = true;
    if (next.job?.action === 'apply' && next.job.status === 'complete' && next.file?.state === 'present') {
      recoveryRequested = false; searchOpen = false; manualOpen = false;
    }
    for (const [name, stage] of Object.entries(next.job?.stages || {})) {
      if (['failed', 'interrupted'].includes(stage.state)) failures[name] = stage.message || STEP_LABELS[stage.state];
      if (stage.state === 'complete') delete failures[name];
    }
  }
  async function updated() {
    const key = `${state?.job?.createdAt}:${state?.job?.status}`;
    if (!state?.job || busy() || announced === key) return;
    announced = key;
    try {
      // match has no api-client cache. The existing callback reloads one match item
      // through program-detail-client with cache: no-store.
      invalidateResources(['recorded']);
      if (state.job.stages?.thumbnail?.state === 'complete') notifyRecordedThumbnailReady(id, state.thumbnail.updatedAt || Date.now());
      const refreshed = await onUpdated?.();
      if (refreshed === false) throw new Error('番組詳細を更新できませんでした。');
      refreshError = '';
    } catch (cause) {
      refreshError = `処理結果は取得しましたが、表示の更新に失敗しました: ${cause.message}`;
    }
  }
  function planPoll() {
    window.clearTimeout(timer);
    if (!disposed && (error || ['queued', 'running'].includes(state?.job?.status))) timer = window.setTimeout(poll, 1500);
  }
  async function poll() {
    try {
      const next = await loadRecordedMaintenance(id, controller.signal);
      if (disposed) return;
      accept(next); error = '';
      await updated();
      if (!disposed) render();
    } catch (cause) { if (!disposed) { error = cause.message; render(); } }
    finally { planPoll(); }
  }
  async function perform(input) {
    if (busy() || disposed) return;
    pending = true; pendingInput = input; error = ''; render();
    try {
      const next = await requestRecordedMaintenance(id, input, controller.signal);
      if (disposed) return;
      accept(next); pending = false; pendingInput = null;
      await updated();
      if (!disposed) { render(); planPoll(); }
    } catch (cause) {
      if (!disposed) {
        pending = false; pendingInput = null;
        const task = Object.keys(input.tasks || input.redo || {})[0];
        if (input.action === 'run' && task) failures[task] = cause.message;
        else error = cause.message;
        render();
      }
    }
  }
  function runTask(task, acquired) {
    return perform({ action: 'run', [acquired ? 'redo' : 'tasks']: { [task]: true } });
  }
  function render() {
    const previous = dialog.querySelector('.recorded-maintenance-content');
    const scrollTop = previous?.scrollTop || 0;
    const savedDetails = Array.from(previous?.querySelectorAll('.program-saved-ts-summary details') || [])
      .map(element => ({ open: element.open, scrollTop: element.querySelector('pre')?.scrollTop || 0 }));
    const focused = dialog.contains(document.activeElement) ? document.activeElement?.dataset.maintenanceControl : null;
    const shell = document.createElement('div'); shell.className = 'recorded-maintenance-body';
    const header = document.createElement('header');
    const body = document.createElement('div'); body.className = 'recorded-maintenance-content';
    const heading = document.createElement('h2'); heading.textContent = '録画メンテナンス';
    heading.id = 'recorded-maintenance-heading'; dialog.setAttribute('aria-labelledby', heading.id);
    const name = document.createElement('p'); name.textContent = title;
    header.append(heading, name);
    const stages = state?.job?.stages || {};
    const runFileMissing = state?.job?.action === 'run' &&
      ['complete', 'failed'].includes(state.job.status) && state.file?.state === 'missing' && state.file.checkedAt >= state.job.createdAt;
    const canProcess = !!state && !state.fileMissing && !runFileMissing && !busy() && !error;
    const probeDone = state?.ffprobe?.state === 'complete';
    const thumbnailDone = state?.thumbnail?.available === true;
    const analysis = state?.analysis;
    function progress(task) {
      const input = pendingInput;
      if (input?.action === 'run' && (input.tasks?.[task] || input.redo?.[task])) return '要求送信中…';
      const selected = state?.job?.action === 'run' && (state.job.tasks?.[task]?.selected || state.job.tasks?.[task]?.redo);
      if (selected && state.job.status === 'queued') {
        const reason = { recording: '録画中', 'recording-transition': '録画開始・終了付近の保護',
          'post-processing': '先行する後処理の完了待ち' }[state.job.waitReason];
        return reason ? `実行待ち（${reason}）` : '実行待ち';
      }
      const stage = stages[task];
      if (['checking', 'running'].includes(stage?.state)) return STEP_LABELS[stage.state];
      if (selected && state.job.status === 'running' && !stage) return '対象確認・実行待ち';
      return '';
    }
    function row(key, label, text, action, { expanded, toggle, warning = false } = {}) {
      const line = document.createElement('div'); line.className = 'recorded-maintenance-row';
      const caption = document.createElement('span'); caption.className = 'recorded-maintenance-label'; caption.textContent = label;
      const status = toggle ? button(`${text} ${expanded ? '▲' : '▼'}`, toggle) : document.createElement('span');
      status.className = `recorded-maintenance-value${toggle ? ' is-toggle' : ''}${warning ? ' is-warning' : ''}`;
      if (!toggle) { status.textContent = text; status.setAttribute('role', 'status'); }
      else {
        status.setAttribute('aria-expanded', String(expanded)); status.setAttribute('aria-controls', `recorded-maintenance-${key}-details`);
        status.dataset.maintenanceControl = `${key}-toggle`;
      }
      const actions = document.createElement('div'); actions.className = 'recorded-maintenance-actions';
      action.dataset.maintenanceControl = `${key}-action`; actions.append(action);
      line.append(caption, status, actions); body.append(line);
    }
    const metadata = document.createElement('dl');
    fact(metadata, '登録パス', state ? state.path || '登録なし' : '取得中…');
    if (state?.fileMissing) fact(metadata, '録画結果', '行方不明');
    body.append(metadata);
    const canSearch = !!state?.fileMissing || runFileMissing || recoveryRequested;
    if (canSearch && !searchOpen && !error) {
      const prompt = document.createElement('p');
      prompt.textContent = state.fileMissing ? '行方不明の録画です。再捜索できます。' : 'ファイルが見つかりません。捜索しますか？';
      body.append(prompt, button(state.fileMissing ? '再捜索' : '捜索する', () => { recoveryRequested = true; searchOpen = true; render(); }, busy()));
    }
    if (canSearch && searchOpen && !error) {
      const search = disclosure('ファイルを探す', searchOpen, value => { searchOpen = value; });
      const notice = document.createElement('p'); notice.textContent = '捜索は設定済みの録画先だけを対象にします。HDDを起動する可能性があります。'; search.append(notice);
      if (selectedRoots === null) selectedRoots = new Set(state.roots.map(root => root.id));
      for (const root of state.roots) checkbox(search, `${root.name}: ${root.path}`, selectedRoots.has(root.id), value => {
        if (value) selectedRoots.add(root.id); else selectedRoots.delete(root.id);
      }, busy());
      search.append(button('選択した録画先を捜索', () => perform({ action: 'search', selectedIds: [...selectedRoots] }), busy() || selectedRoots.size === 0));
      const manual = disclosure('パスを手動指定', manualOpen, value => { manualOpen = value; });
      const input = document.createElement('input'); input.type = 'text'; input.value = manualPath;
      input.setAttribute('aria-label', 'サーバー上の録画ファイルの絶対パス'); input.placeholder = '/mnt/recorded/example.ts'; input.disabled = busy();
      input.addEventListener('input', () => { manualPath = input.value; });
      manual.append(input, button('ファイルを確認', () => perform({ action: 'verify', path: manualPath }), busy()));
      body.append(search, manual);
      const candidates = [...(state?.job?.search?.candidates || []), ...(state?.job?.candidate ? [state.job.candidate] : [])];
      for (const candidate of candidates) {
        const section = document.createElement('section');
        const text = document.createElement('p');
        text.textContent = `登録パス: ${candidate.oldPath || state.path}\n候補: ${candidate.path}\nサイズ: ${candidate.size ?? '情報なし'} bytes\n${candidate.evidence || candidate.message || ''}`;
        section.append(text);
        if (candidate.token) {
          if (confirmedToken !== candidate.token && candidates.length === 1) { confirmedToken = candidate.token; confirmed = false; }
          checkbox(section, 'このファイルが対象の録画であることと、新旧パスを確認しました', confirmed && confirmedToken === candidate.token, value => {
            confirmedToken = candidate.token; confirmed = value;
          }, busy());
          section.append(button('このファイルを録画履歴に反映', () => perform({ action: 'apply', token: candidate.token, confirm: true }), busy() || !confirmed || confirmedToken !== candidate.token));
        }
        body.append(section);
      }
      if (state.job?.search) {
        const report = document.createElement('p');
        report.textContent = state.job.search.complete ? `捜索完了: ${candidates.length}候補${state.job.search.persisted ? '（行方不明を台帳に保存しました）' : !state.job.search.fullScope ? '（探索範囲が限定されているため不在は確定しません）' : ''}` : `捜索未完了: ${state.job.search.failures.join(' / ')}`;
        body.append(report);
      }
    }

    const duration = probeDone ? formatRecordingSeconds(state.ffprobe.seconds, true) : null;
    row('ffprobe', '録画時間', progress('ffprobe') || duration || (failures.ffprobe ? '取得失敗' : '未取得'),
      button(probeDone ? '再取得' : '取得する', () => runTask('ffprobe', probeDone), !canProcess), { warning: !!failures.ffprobe });
    if (failures.ffprobe) {
      const reason = document.createElement('p'); reason.className = 'recorded-maintenance-row-note'; reason.textContent = failures.ffprobe; body.append(reason);
    }
    const thumbnailStatus = { queued: '作成待ち', processing: '生成中', failed: '生成失敗' }[state?.thumbnail?.status];
    row('thumbnail', 'サムネイル', progress('thumbnail') || (thumbnailDone ? '作成済み' : thumbnailStatus || (failures.thumbnail ? '生成失敗' : '未作成')),
      button(thumbnailDone ? '再生成' : '生成する', () => runTask('thumbnail', thumbnailDone), !canProcess), { warning: !!failures.thumbnail || state?.thumbnail?.status === 'failed' });
    if (failures.thumbnail) {
      const reason = document.createElement('p'); reason.className = 'recorded-maintenance-row-note'; reason.textContent = failures.thumbnail; body.append(reason);
    }
    const analysisInfo = savedTsResultInfo(analysis);
    const incompleteTs = stages.ts?.state === 'interrupted' || analysis?.lastAttempt?.status === 'INCOMPLETE' || analysis?.result?.status === 'INCOMPLETE';
    const analysisText = progress('ts') || (analysis ? savedTsLabel(analysis) : failures.ts ? (incompleteTs ? '解析未完了' : '解析失敗') : '未解析');
    const hasAnalysisDetails = !!analysis || !!failures.ts;
    const tsAction = button(analysis || failures.ts ? '再解析' : '解析する', () => runTask('ts', !!analysis), !canProcess);
    tsAction.title = '保存TS全量を読み込みます。録画優先で待機・中断し、待機期限は10分です。';
    row('ts', 'TS解析', analysisText, tsAction, { warning: analysisInfo.findings || !!failures.ts,
      expanded: analysisOpen, toggle: hasAnalysisDetails ? () => { analysisOpen = !analysisOpen; render(); } : null });
    if (hasAnalysisDetails) {
      const details = document.createElement('section'); details.id = 'recorded-maintenance-ts-details'; details.className = 'recorded-maintenance-inline-details recorded-maintenance-analysis-details'; details.hidden = !analysisOpen;
      if (failures.ts) {
        const reason = document.createElement('p'); reason.textContent = `直近の処理: ${failures.ts}`; details.append(reason);
      }
      const summary = createSavedTsSummary(analysis); if (summary) details.append(summary);
      body.append(details);
    }
    const recordingWarnings = (getRecordingWarnings() || []).filter(value => value.key !== 'saved-ts');
    if (recordingWarnings.length) {
      const warnings = document.createElement('ul'); warnings.className = 'recorded-maintenance-warnings';
      for (const warning of recordingWarnings) {
        const item = document.createElement('li'); item.textContent = warning.description || warning.label; warnings.append(item);
      }
      body.append(warnings);
    }
    if (error || state?.job?.status === 'failed' && state.job.message) {
      const message = document.createElement('p'); message.setAttribute('role', 'alert'); message.textContent = error || state.job.message; body.append(message);
      if (error) body.append(button('表示を更新', poll, pending));
    }
    if (refreshError) {
      const feedback = document.createElement('p'); feedback.setAttribute('role', 'alert'); feedback.textContent = refreshError;
      body.append(feedback, button('表示を更新', async () => { announced = ''; await updated(); if (!disposed) render(); }, busy()));
    }
    const footer = document.createElement('footer'); footer.append(button('閉じる', () => dialog.close()));
    shell.append(header, body, footer); dialog.replaceChildren(shell);
    body.querySelectorAll('.program-saved-ts-summary details').forEach((element, index) => {
      if (!savedDetails[index]) return;
      element.open = savedDetails[index].open;
      const pre = element.querySelector('pre'); if (pre) pre.scrollTop = savedDetails[index].scrollTop;
    });
    if (focused) {
      const control = Array.from(dialog.querySelectorAll('[data-maintenance-control]')).find(element => element.dataset.maintenanceControl === focused);
      control?.focus({ preventScroll: true });
    }
    body.scrollTop = scrollTop;
  }
  dialog.addEventListener('close', () => {
    disposed = true; window.clearTimeout(timer); controller.abort(); dialog.remove();
  }, { once: true });
  document.body.append(dialog); render(); dialog.showModal();
  loadRecordedMaintenance(id, controller.signal).then(next => {
    if (disposed) return;
    accept(next); render();
    if (['queued', 'running'].includes(next.job?.status)) {
      planPoll();
    }

  }).catch(cause => { if (!disposed) { error = cause.message; render(); planPoll(); } });
  return dialog;
}
