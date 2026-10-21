import { listLogFiles, loadLogChunk, loadRecentLog, openLogStream } from '../services/log-client.js';
import { classifyLogLine } from '../services/log-level.js';
import { loadServiceControl, requestServiceRestart } from '../services/service-control-client.js';
import { mirakurunIndicatorModel, restartButtonModel, serviceGeneration, serviceGenerationChanged, serviceIndicatorModel } from '../services/service-restart-model.js';
import { checkWuiConnectionNow, getWuiConnectionState, subscribeWuiConnection } from '../services/wui-connection-monitor.js';
import { completePendingRestart, getPendingRestart, setPendingRestart, subscribePendingRestart } from '../services/service-restart-store.js';

const MAX_BROWSER_LINES = 5000;
const SOURCE_LABELS = { operator: 'Operator', scheduler: 'Scheduler', wui: 'WUI', mirakurun: 'Mirakurun' };
const LEVEL_LABELS = { all: '全件', error: 'ERROR', warning: 'WARNING', info: 'INFO' };
const SERVICE_REFRESH_MS = 5000;
const MIRAKURUN_HEALTH_REFRESH_MS = 5000;
const SERVICE_RESTART_TIMEOUT_MS = 120000;

async function loadHealthDiagnostics(signal) {
  const response = await fetch('/api/diagnostics.json', {
    method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store', signal
  });
  if (!response.ok) throw new Error(`Diagnostics API returned HTTP ${response.status}`);
  const report = await response.json();
  if (!report || report.schemaVersion !== 1 || !report.mirakurun) throw new Error('Diagnostics API response is invalid');
  return report;
}

function mergeMirakurunSnapshot(snapshot, buffered) {
  const maxOverlap = Math.min(snapshot.length, buffered.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const snapshotStart = snapshot.length - overlap;
    let matches = true;
    for (let index = 0; index < overlap; index += 1) {
      if (snapshot[snapshotStart + index] !== buffered[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return snapshot.concat(buffered.slice(overlap));
  }
  return snapshot.concat(buffered);
}

function formatModifiedTime(value) {
  if (!Number.isFinite(value)) return '保存日時不明';
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(new Date(value));
}

function fileLabel(file) {
  const stream = file.stream === 'log' ? 'ログ' : file.stream;
  return file.current
    ? `${stream}（現行）`
    : `${stream} · ${formatModifiedTime(file.mtimeMs)} · ${file.filename}`;
}

function fileOrder(file) {
  const streamOrder = { stdout: 0, stderr: 2, log: 4 }[file.stream] ?? 6;
  return streamOrder + (file.current ? 0 : 1);
}

async function copyText(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Copy command failed');
}

export function renderLogPage(container) {
  let active = true;
  let source = 'operator';
  let mode = 'realtime';
  let level = 'all';
  let search = '';
  let lines = [];
  let files = [];
  let selectedFileId = '';
  let historyCursor = null;
  let historyHasMore = false;
  let autoFollow = true;
  let stopStream = null;
  let requestController = null;
  let catalogController = null;
  let generation = 0;
  let renderFrame = null;
  let pendingHistoryPrependScroll = null;
  let scrollToEndOnRender = false;
  let serviceReport = null;
  let serviceRequestController = null;
  let serviceRefreshTimer = null;
  let diagnosticsReport = null;
  let diagnosticsRequestController = null;
  let diagnosticsRefreshTimer = null;
  let diagnosticsFetchState = 'checking';
  let pendingRestart = getPendingRestart();
  let serviceFetchFailed = false;
  let serviceFetchError = '';
  let confirmTarget = null;

  const page = document.createElement('div');
  page.className = 'log-page';
  page.innerHTML = `
    <section class="panel log-page-panel" aria-label="システムログ">
      <div class="log-service-row">
        <div class="log-source-tabs" role="tablist" aria-label="ログ種別">
          ${Object.entries(SOURCE_LABELS).map(([value, label]) => `<button type="button" role="tab" data-source="${value}" aria-selected="${value === source}">${value === 'operator' || value === 'wui' || value === 'mirakurun' ? '<span class="log-service-dot" aria-hidden="true"></span>' : ''}<span>${label}</span></button>`).join('')}
        </div>
        <div class="log-service-action" hidden>
          <span class="log-restart-reason" hidden><b aria-hidden="true">×</b><span></span></span>
          <button class="button log-restart-button" type="button">再起動</button>
        </div>
      </div>
      <div class="log-toolbar">
        <label class="log-selection"><span class="visually-hidden">ログ選択</span><select aria-label="ログ選択"><option value="realtime">リアルタイム</option></select></label>
        <label class="log-search"><span class="visually-hidden">検索</span><input type="search" placeholder="ログ検索" title="検索は現在読み込んでいる範囲に適用されます" autocomplete="off"></label>
        <label class="log-level"><span class="visually-hidden">レベル</span><select aria-label="ログレベル">${Object.entries(LEVEL_LABELS).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
        <button class="button log-copy" type="button">表示中をコピー</button>
        <button class="button log-load-older" type="button" hidden>さらに古い300行</button>
      </div>
      <div class="log-summary" hidden>
        <span class="log-connection-status" data-status="connecting">接続準備中</span>
        <button class="button log-retry" type="button" hidden>再試行</button>
      </div>
      <div class="log-console" tabindex="0" aria-label="ログ本文">
        <div class="log-lines" role="log" aria-live="off"></div>
      </div>
      <button class="button log-follow" type="button" hidden>最新ログへ戻る</button>
      <dialog class="log-restart-dialog">
        <form method="dialog">
          <h2></h2>
          <p></p>
          <div class="log-restart-dialog-actions">
            <button class="button" value="cancel">キャンセル</button>
            <button class="button log-restart-confirm" value="restart">再起動する</button>
          </div>
        </form>
      </dialog>
    </section>`;
  container.replaceChildren(page);

  const consoleElement = page.querySelector('.log-console');
  const linesElement = page.querySelector('.log-lines');
  const logSelection = page.querySelector('.log-selection select');
  const olderButton = page.querySelector('.log-load-older');
  const summaryElement = page.querySelector('.log-summary');
  const statusElement = page.querySelector('.log-connection-status');
  const retryButton = page.querySelector('.log-retry');
  const followButton = page.querySelector('.log-follow');
  const searchInput = page.querySelector('.log-search input');
  const levelSelect = page.querySelector('.log-level select');
  const copyButton = page.querySelector('.log-copy');
  const serviceAction = page.querySelector('.log-service-action');
  const restartReason = page.querySelector('.log-restart-reason');
  const restartButton = page.querySelector('.log-restart-button');
  const restartDialog = page.querySelector('.log-restart-dialog');
  const restartDialogTitle = restartDialog.querySelector('h2');
  const restartDialogText = restartDialog.querySelector('p');

  function renderServiceAction() {
    const model = restartButtonModel(source, serviceFetchFailed ? null : serviceReport, pendingRestart);
    serviceAction.hidden = !model.visible;
    if (model.visible) {
      restartButton.disabled = !model.enabled || serviceFetchFailed;
      restartButton.textContent = pendingRestart?.target === source ? '再起動中…' : '再起動';
      restartButton.title = serviceFetchFailed ? serviceFetchError || 'サービス状態を確認中です' : model.reason;
      const reason = serviceFetchFailed ? 'サービス状態を確認中' : model.reason;
      restartReason.hidden = model.enabled;
      restartReason.dataset.kind = serviceFetchFailed ? 'unknown' : model.reasonKind;
      restartReason.querySelector('span').textContent = reason;
      restartReason.querySelector('b').hidden = model.reasonKind !== 'recording';
    }
    renderServiceIndicators();
  }

  function renderServiceIndicators() {
    page.querySelectorAll('[data-source]').forEach(button => {
      const indicator = button.dataset.source === 'mirakurun'
        ? mirakurunIndicatorModel(diagnosticsReport, diagnosticsFetchState)
        : serviceIndicatorModel(button.dataset.source, serviceReport, pendingRestart, serviceFetchFailed);
      const dot = button.querySelector('.log-service-dot');
      if (!dot) return;
      dot.dataset.state = indicator.state;
      button.title = indicator.label;
      button.setAttribute('aria-label', indicator.label);
    });
  }

  function finishRestart(succeeded, message, options) {
    const target = pendingRestart?.target;
    completePendingRestart(succeeded, message, options);
    pendingRestart = null;
    renderServiceAction();
    if (succeeded && target === source) restart();
  }

  function evaluateRestartProgress() {
    if (!pendingRestart) return;
    if (pendingRestart.target === 'wui') {
      const connection = getWuiConnectionState();
      const startedAfterRequest = connection.transition?.kind === 'started'
        && connection.transition.at >= Number(pendingRestart.requestedAt || 0);
      if (startedAfterRequest || pendingRestart.beforeInstanceId && connection.instanceId && pendingRestart.beforeInstanceId !== connection.instanceId) {
        finishRestart(true, 'WUIの起動を確認しました');
        return;
      }
    }
    if (Date.now() > pendingRestart.deadline) {
      finishRestart(false, '復旧状態を確認できません');
      return;
    }
    if (!serviceReport) return;
    const target = serviceReport.targets?.[pendingRestart.target];
    const operation = serviceReport.operations?.[pendingRestart.target];
    if (operation && pendingRestart.id && operation.id === pendingRestart.id && operation.state === 'failed') {
      finishRestart(false, operation.message || '再起動に失敗しました');
      return;
    }
    if (target?.operable === true && target.status === 'online' &&
        serviceGenerationChanged(pendingRestart.before, serviceGeneration(target))) {
      finishRestart(true, '再起動後の稼働を確認しました');
      return;
    }
  }

  function scheduleServiceRefresh(delay) {
    clearTimeout(serviceRefreshTimer);
    serviceRefreshTimer = setTimeout(refreshServiceControl, delay);
  }

  async function refreshServiceControl() {
    if (!active || serviceRequestController) return;
    const controller = new AbortController();
    serviceRequestController = controller;
    try {
      serviceReport = await loadServiceControl(controller.signal);
      serviceFetchFailed = false;
      serviceFetchError = '';
      evaluateRestartProgress();
    } catch (error) {
      if (error?.name !== 'AbortError') {
        serviceFetchFailed = true;
        serviceFetchError = error.message || 'サービス制御状態を取得できません';
      }
    } finally {
      if (serviceRequestController === controller) serviceRequestController = null;
      renderServiceAction();
      if (active) scheduleServiceRefresh(SERVICE_REFRESH_MS);
    }
  }

  function scheduleDiagnosticsRefresh(delay) {
    clearTimeout(diagnosticsRefreshTimer);
    diagnosticsRefreshTimer = setTimeout(refreshMirakurunHealth, delay);
  }

  async function refreshMirakurunHealth() {
    if (!active || diagnosticsRequestController) return;
    const controller = new AbortController();
    diagnosticsRequestController = controller;
    if (!diagnosticsReport) diagnosticsFetchState = 'checking';
    renderServiceIndicators();
    try {
      diagnosticsReport = await loadHealthDiagnostics(controller.signal);
      diagnosticsFetchState = 'ready';
    } catch (error) {
      if (error?.name !== 'AbortError') {
        diagnosticsReport = null;
        diagnosticsFetchState = 'failed';
      }
    } finally {
      if (diagnosticsRequestController === controller) diagnosticsRequestController = null;
      renderServiceIndicators();
      if (active) scheduleDiagnosticsRefresh(MIRAKURUN_HEALTH_REFRESH_MS);
    }
  }

  async function beginRestart(target) {
    if (pendingRestart || (target !== 'operator' && target !== 'wui')) return;
    const current = serviceReport?.targets?.[target];
    if (!current || current.restartable !== true) return refreshServiceControl();
    pendingRestart = {
      target, id: null, state: 'requesting', message: '再起動要求を送信しています…',
      before: serviceGeneration(current), beforeInstanceId: getWuiConnectionState().instanceId,
      requestedAt: Date.now(),
      deadline: Date.now() + SERVICE_RESTART_TIMEOUT_MS
    };
    setPendingRestart(pendingRestart);
    renderServiceAction();
    try {
      const operation = await requestServiceRestart(target);
      if (!active || pendingRestart?.target !== target) return;
      pendingRestart = {
        ...pendingRestart, id: operation.id || null, state: 'reconnecting',
        message: '接続回復を確認しています…', before: operation.before || pendingRestart.before
      };
      setPendingRestart(pendingRestart);
      scheduleServiceRefresh(0);
    } catch (error) {
      if (!active || pendingRestart?.target !== target) return;
      if (target === 'wui' && error?.name === 'TypeError') {
        pendingRestart = {
          ...pendingRestart, state: 'reconnecting', message: '接続回復を確認しています…'
        };
        setPendingRestart(pendingRestart);
        renderServiceAction();
        scheduleServiceRefresh(SERVICE_REFRESH_MS);
        return;
      }
      const message = error.message || '再起動要求を受け付けられません';
      const controlUnavailable = /PM2|管理先|操作できません/.test(message);
      finishRestart(false, message, { notify: !controlUnavailable });
      scheduleServiceRefresh(0);
    }
  }

  const isActive = token => active && page.isConnected && token === generation;

  function setStatus(status, detail) {
    const labels = {
      connecting: '接続中…', connected: 'リアルタイム接続中', disconnected: 'ログ接続が切断されました',
      loading: '読み込み中…', ready: '履歴を表示中', empty: 'ログはありません', error: '取得失敗'
    };
    statusElement.dataset.status = status;
    statusElement.textContent = detail || labels[status] || status;
    retryButton.hidden = status !== 'error' && status !== 'disconnected';
    summaryElement.hidden = status === 'connected' || status === 'ready' || status === 'empty';
  }

  function filteredLines() {
    const needle = search.trim().toLocaleLowerCase('ja-JP');
    return lines.filter(line => {
      if (level !== 'all' && line.level !== level) return false;
      return needle === '' || line.text.toLocaleLowerCase('ja-JP').includes(needle);
    });
  }

  function renderLines() {
    renderFrame = null;
    if (!active) return;
    const visible = filteredLines();
    const previousScrollTop = consoleElement.scrollTop;
    const fragment = document.createDocumentFragment();
    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'log-empty';
      empty.textContent = lines.length === 0 ? 'ログはありません' : '条件に一致するログはありません';
      fragment.append(empty);
    } else {
      visible.forEach(line => {
        const row = document.createElement('div');
        row.className = `log-line is-${line.level}`;
        row.textContent = line.text;
        fragment.append(row);
      });
    }
    linesElement.replaceChildren(fragment);
    if (pendingHistoryPrependScroll !== null) {
      const { scrollHeight, scrollTop } = pendingHistoryPrependScroll;
      pendingHistoryPrependScroll = null;
      consoleElement.scrollTop = scrollTop + (consoleElement.scrollHeight - scrollHeight);
    } else if (scrollToEndOnRender || (mode === 'realtime' && autoFollow)) {
      scrollToEndOnRender = false;
      consoleElement.scrollTop = consoleElement.scrollHeight;
    } else {
      consoleElement.scrollTop = previousScrollTop;
    }
  }

  function scheduleRender() {
    if (renderFrame === null) renderFrame = window.requestAnimationFrame(renderLines);
  }

  function replaceLines(values) {
    lines = values.slice(-MAX_BROWSER_LINES).map(text => ({ text: String(text), level: classifyLogLine(text) }));
    scheduleRender();
  }

  function appendLines(values) {
    if (values.length === 0) return;
    lines.push(...values.map(text => ({ text: String(text), level: classifyLogLine(text) })));
    if (lines.length > MAX_BROWSER_LINES) lines.splice(0, lines.length - MAX_BROWSER_LINES);
    scheduleRender();
  }

  function stopCurrentActivity() {
    stopStream?.();
    stopStream = null;
    requestController?.abort();
    requestController = null;
  }

  function stopAllRequests() {
    stopCurrentActivity();
    catalogController?.abort();
    catalogController = null;
  }

  function updateControls() {
    page.querySelectorAll('[data-source]').forEach(button => {
      const selected = button.dataset.source === source;
      button.setAttribute('aria-selected', String(selected));
    });
    logSelection.value = mode === 'realtime' ? 'realtime' : selectedFileId;
    followButton.hidden = mode !== 'realtime' || autoFollow;
    olderButton.hidden = mode !== 'history' || !historyHasMore;
    renderServiceAction();
  }

  function startRealtime(token) {
    replaceLines([]);
    autoFollow = true;
    updateControls();
    let initialMirakurunLines = source === 'mirakurun' ? [] : null;
    let mirakurunSnapshotStarted = false;
    const loadMirakurunSnapshot = () => {
      if (mirakurunSnapshotStarted || source !== 'mirakurun') return;
      mirakurunSnapshotStarted = true;
      const controller = new AbortController();
      requestController = controller;
      loadRecentLog('mirakurun', controller.signal).then(history => {
        if (!isActive(token)) return;
        const buffered = initialMirakurunLines;
        initialMirakurunLines = null;
        replaceLines(mergeMirakurunSnapshot(history, buffered));
      }).catch(error => {
        if (error?.name !== 'AbortError' && isActive(token)) {
          const buffered = initialMirakurunLines;
          initialMirakurunLines = null;
          appendLines(buffered);
          setStatus('error', `直近ログ取得失敗（新規ログは受信中）：${error.message}`);
        }
      }).finally(() => {
        if (requestController === controller) requestController = null;
      });
    };
    stopStream = openLogStream(source, {
      onLines(values) {
        if (!isActive(token)) return;
        if (initialMirakurunLines !== null) initialMirakurunLines.push(...values);
        else appendLines(values);
      },
      onStatus(status) {
        if (!isActive(token)) return;
        setStatus(status);
        if (status === 'connected') loadMirakurunSnapshot();
        if (status === 'disconnected') checkWuiConnectionNow();
      },
      onError(error) {
        if (!isActive(token)) return;
        setStatus('error', `ログ接続失敗：${error.message}`);
        checkWuiConnectionNow();
      }
    });
  }

  async function loadSelectedHistory(token, before = null, prepend = false) {
    const file = files.find(item => item.id === selectedFileId);
    if (!file) {
      replaceLines([]);
      historyCursor = null;
      historyHasMore = false;
      olderButton.disabled = true;
      setStatus('empty');
      return;
    }
    olderButton.disabled = true;
    setStatus('loading', `${fileLabel(file)} を読み込み中…`);
    const controller = new AbortController();
    requestController = controller;
    try {
      const result = await loadLogChunk(file.id, { before, lines: 300, signal: controller.signal });
      if (!isActive(token)) return;
      const incoming = result.lines.map(text => ({ text: String(text), level: classifyLogLine(text) }));
      if (prepend) {
        pendingHistoryPrependScroll = {
          scrollHeight: consoleElement.scrollHeight,
          scrollTop: consoleElement.scrollTop
        };
        lines = incoming.concat(lines);
        if (lines.length > MAX_BROWSER_LINES) lines.length = MAX_BROWSER_LINES;
        scheduleRender();
      } else {
        lines = incoming;
        scrollToEndOnRender = true;
        scheduleRender();
      }
      historyCursor = Number.isFinite(result.cursor) ? result.cursor : null;
      historyHasMore = result.hasMore === true;
      olderButton.disabled = !historyHasMore;
      updateControls();
      const suffix = result.byteLimitReached ? '（1行が長いため読込上限位置で省略）' : '';
      setStatus(lines.length === 0 ? 'empty' : 'ready', `${fileLabel(result.file || file)}${suffix}`);
    } catch (error) {
      if (error?.name !== 'AbortError' && isActive(token)) setStatus('error', `履歴取得失敗：${error.message}`);
    } finally {
      if (requestController === controller) requestController = null;
    }
  }

  async function loadLogOptions(token) {
    if (source === 'mirakurun') {
      const realtimeOption = document.createElement('option');
      realtimeOption.value = 'realtime';
      realtimeOption.textContent = 'リアルタイム';
      logSelection.replaceChildren(realtimeOption);
      logSelection.disabled = true;
      updateControls();
      return;
    }
    logSelection.disabled = false;
    const controller = new AbortController();
    catalogController = controller;
    try {
      files = await listLogFiles(source, controller.signal);
      if (!isActive(token)) return;
      files.sort((a, b) => fileOrder(a) - fileOrder(b) || b.mtimeMs - a.mtimeMs);
      const realtimeOption = document.createElement('option');
      realtimeOption.value = 'realtime';
      realtimeOption.textContent = 'リアルタイム';
      logSelection.replaceChildren(realtimeOption, ...files.map(file => {
        const option = document.createElement('option');
        option.value = file.id;
        option.textContent = fileLabel(file);
        return option;
      }));
      updateControls();
    } catch (error) {
      if (error?.name !== 'AbortError' && isActive(token)) logSelection.title = `履歴一覧取得失敗：${error.message}`;
    } finally {
      if (catalogController === controller) catalogController = null;
    }
  }

  function restart(refreshCatalog = false) {
    stopCurrentActivity();
    if (refreshCatalog) {
      catalogController?.abort();
      catalogController = null;
    }
    generation += 1;
    const token = generation;
    updateControls();
    if (mode === 'realtime') startRealtime(token); else startHistory(token);
    if (refreshCatalog) loadLogOptions(token);
  }

  function startHistory(token) {
    replaceLines([]);
    historyCursor = null;
    historyHasMore = false;
    olderButton.hidden = true;
    loadSelectedHistory(token);
  }

  page.querySelector('.log-source-tabs').addEventListener('click', event => {
    const button = event.target.closest('[data-source]');
    if (!button || button.dataset.source === source) return;
    source = button.dataset.source;
    mode = 'realtime';
    files = [];
    selectedFileId = '';
    restart(true);
    scheduleServiceRefresh(0);
  });
  searchInput.addEventListener('input', () => { search = searchInput.value; scheduleRender(); });
  levelSelect.addEventListener('change', () => { level = levelSelect.value; scheduleRender(); });
  logSelection.addEventListener('change', () => {
    if (logSelection.value === 'realtime') {
      mode = 'realtime';
      selectedFileId = '';
    } else {
      mode = 'history';
      selectedFileId = logSelection.value;
    }
    restart();
  });
  olderButton.addEventListener('click', () => {
    if (!historyHasMore || !Number.isFinite(historyCursor)) return;
    loadSelectedHistory(generation, historyCursor, true);
  });
  retryButton.addEventListener('click', restart);
  followButton.addEventListener('click', () => {
    autoFollow = true;
    followButton.hidden = true;
    consoleElement.scrollTop = consoleElement.scrollHeight;
  });
  consoleElement.addEventListener('scroll', () => {
    if (mode !== 'realtime') return;
    const nearBottom = consoleElement.scrollHeight - consoleElement.scrollTop - consoleElement.clientHeight < 28;
    if (nearBottom !== autoFollow) {
      autoFollow = nearBottom;
      followButton.hidden = autoFollow;
    }
  }, { passive: true });
  copyButton.addEventListener('click', async () => {
    const text = filteredLines().map(line => line.text).join('\n');
    try {
      await copyText(text);
      const original = copyButton.textContent;
      copyButton.textContent = 'コピーしました';
      window.setTimeout(() => { if (active) copyButton.textContent = original; }, 1600);
    } catch (_) {
      setStatus('error', 'クリップボードへコピーできませんでした');
    }
  });
  restartButton.addEventListener('click', () => {
    const model = restartButtonModel(source, serviceReport, pendingRestart);
    if (!model.visible || !model.enabled) return;
    confirmTarget = source;
    const label = source === 'operator' ? 'Operator' : 'WUI';
    restartDialogTitle.textContent = `${label}の再起動`;
    restartDialogText.textContent = source === 'operator'
      ? 'Operatorを再起動します。録画中や録画開始・終了処理中は実行できません。'
      : 'WUIを再起動します。画面との接続が一時的に切断されますが、復旧後に自動接続します。';
    restartDialog.returnValue = '';
    restartDialog.showModal();
  });
  restartDialog.addEventListener('close', () => {
    const target = confirmTarget;
    confirmTarget = null;
    if (restartDialog.returnValue === 'restart') beginRestart(target);
  });

  const unsubscribeConnection = subscribeWuiConnection(connection => {
    if (!active || connection.status !== 'online') return;
    evaluateRestartProgress();
  });
  const unsubscribePending = subscribePendingRestart(restartState => {
    pendingRestart = restartState.pending;
    renderServiceAction();
    if (pendingRestart) scheduleServiceRefresh(0);
  });

  restart(true);
  refreshServiceControl();
  refreshMirakurunHealth();
  return () => {
    active = false;
    generation += 1;
    stopAllRequests();
    serviceRequestController?.abort();
    serviceRequestController = null;
    clearTimeout(serviceRefreshTimer);
    diagnosticsRequestController?.abort();
    diagnosticsRequestController = null;
    clearTimeout(diagnosticsRefreshTimer);
    unsubscribeConnection();
    unsubscribePending();
    if (restartDialog.open) restartDialog.close();
    if (renderFrame !== null) window.cancelAnimationFrame(renderFrame);
  };
}
