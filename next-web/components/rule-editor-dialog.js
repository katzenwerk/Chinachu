import { createChannelLogo } from './channel-logo.js';
import { openChannelSelector } from './channel-selector-dialog.js';
import { RULE_CATEGORIES, RULE_FLAGS, RULE_TYPES, buildRuleChannelMap, categoryLabel, ruleTitleMode } from '../services/rule-model.js';
import { createRule, deleteRule, loadRuleEditorData, runScheduler, updateRule } from '../services/rules-client.js';
import { previewRuleMatches, schedulePrograms } from '../services/rule-match-preview.js';
import { programState, programTitlePresentation } from '../services/timetable-model.js';

const TEXT_ARRAY_FIELDS = ['reserve_titles', 'ignore_titles', 'reserve_descriptions', 'ignore_descriptions'];
const KNOWN_KEYS = new Set([
  'ruleUid', 'name', 'isDisabled', 'sid', 'category', 'types', 'categories', 'channels', 'ignore_channels',
  'reserve_flags', 'ignore_flags', 'hour', 'duration', 'reserve_titles', 'reserve_titles_mode',
  'ignore_titles', 'reserve_descriptions', 'ignore_descriptions', 'recordedDirId',
  'recorded_format', 'allowEndLack', 'recordingBoundaryPolicy'
]);
const FLAG_TITLES = Object.freeze({
  '新': '新番組', '終': '最終回', '再': '再放送', '字': '字幕放送', 'デ': 'データ放送',
  '解': '解説放送', '無': '無料放送', '二': '二か国語放送', 'Ｓ': 'ステレオ放送'
});

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function list(value) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function logoUrl(channel) {
  return text(channel?.id) ? `/api/channel/${encodeURIComponent(channel.id)}/logo.png` : null;
}

function setListValue(payload, key, values) {
  const cleaned = values.map(text).filter(Boolean);
  if (cleaned.length) payload[key] = cleaned;
  else delete payload[key];
}

function createCheckboxes(name, items, selected, labeler = value => value, titleer = null) {
  const field = document.createElement('div');
  field.className = 'rule-check-grid';
  const values = new Set(list(selected));
  [...items, ...Array.from(values).filter(value => !items.includes(value))].forEach(value => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = name;
    input.value = value;
    input.checked = values.has(value);
    const span = document.createElement('span');
    span.textContent = labeler(value);
    if (titleer) label.title = titleer(value);
    label.append(input, span);
    field.append(label);
  });
  return field;
}

function createStringEditor(name, values) {
  const editor = document.createElement('div');
  editor.className = 'rule-string-editor';
  const rows = document.createElement('div');
  rows.className = 'rule-string-rows';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'button rule-string-add';
  add.textContent = '条件を追加';
  function appendRow(value = '') {
    const row = document.createElement('div');
    row.className = 'rule-string-row';
    const input = document.createElement('input');
    input.type = 'text'; input.name = name; input.value = value; input.autocomplete = 'off';
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'button is-quiet'; remove.textContent = '削除';
    remove.addEventListener('click', () => row.remove());
    row.append(input, remove);
    rows.append(row);
  }
  const initial = list(values);
  (initial.length ? initial : ['']).forEach(appendRow);
  add.addEventListener('click', () => { appendRow(); rows.lastElementChild?.querySelector('input')?.focus(); });
  editor.append(rows, add);
  return editor;
}

function selectedValues(form, name) {
  return Array.from(form.querySelectorAll(`[name="${name}"]:checked`)).map(input => input.value);
}

function inputValues(form, name) {
  return Array.from(form.querySelectorAll(`[name="${name}"]`)).map(input => input.value);
}

function formNumber(form, name) {
  const value = form.elements[name]?.value;
  return value === '' || value === undefined ? undefined : Number(value);
}

function buildPayload(form, original) {
  const payload = structuredClone(original || {});
  payload.isDisabled = form.elements.isEnabled.checked !== true;
  ['types', 'categories', 'channels', 'ignore_channels', 'reserve_flags', 'ignore_flags']
    .forEach(key => setListValue(payload, key, selectedValues(form, key)));
  TEXT_ARRAY_FIELDS.forEach(key => setListValue(payload, key, inputValues(form, key)));
  const titleMode = form.elements.reserve_titles_mode.value === 'and' ? 'and' : 'or';
  if (titleMode === 'and' || Object.prototype.hasOwnProperty.call(original || {}, 'reserve_titles_mode')) payload.reserve_titles_mode = titleMode;
  else delete payload.reserve_titles_mode;
  const hourStart = formNumber(form, 'hour_start');
  const hourEnd = formNumber(form, 'hour_end');
  if (hourStart === undefined && hourEnd === undefined) delete payload.hour;
  else payload.hour = { start: hourStart ?? 0, end: hourEnd ?? 24 };
  const durationMin = formNumber(form, 'duration_min');
  const durationMax = formNumber(form, 'duration_max');
  if (durationMin === undefined && durationMax === undefined) delete payload.duration;
  else payload.duration = { ...(durationMin === undefined ? {} : { min: durationMin }), ...(durationMax === undefined ? {} : { max: durationMax }) };
  const recordedDirId = text(form.elements.recordedDirId.value);
  if (recordedDirId) payload.recordedDirId = recordedDirId; else delete payload.recordedDirId;
  const recordedFormat = text(form.elements.recorded_format.value);
  if (recordedFormat) payload.recorded_format = recordedFormat; else delete payload.recorded_format;
  payload.recordingBoundaryPolicy = form.elements.recordingBoundaryPolicy.value;
  delete payload.allowEndLack;
  return payload;
}

function pairedFields(left, right, variant = 'equal') {
  const grid = document.createElement('div');
  grid.className = `rule-editor-grid is-${variant}`;
  grid.append(left, right);
  return grid;
}

function formatProgramTime(program) {
  const start = new Date(Number(program?.start));
  const end = new Date(Number(program?.end) || Number(program?.start) + Number(program?.seconds || 0) * 1000);
  if (!Number.isFinite(start.getTime())) return '日時不明';
  const date = new Intl.DateTimeFormat('ja-JP', { month: '2-digit', day: '2-digit', weekday: 'short' }).format(start);
  const time = value => new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false }).format(value);
  return `${date} ${time(start)}〜${Number.isFinite(end.getTime()) ? time(end) : '—'}`;
}

function fieldset(title, description = '') {
  const field = document.createElement('fieldset');
  const legend = document.createElement('legend');
  legend.textContent = title;
  field.append(legend);
  if (description) {
    const note = document.createElement('p');
    note.className = 'rule-field-note';
    note.textContent = description;
    field.append(note);
  }
  return field;
}

export function programRuleSeed(seed = {}) {
  const rule = {};
  const title = text(seed.title);
  const type = text(seed.type);
  const channel = text(seed.channel);
  const category = text(seed.category);
  if (title) rule.reserve_titles = [title];
  if (RULE_TYPES.includes(type)) rule.types = [type];
  if (channel) rule.channels = [channel];
  if (RULE_CATEGORIES.includes(category)) rule.categories = [category];
  return rule;
}

export function openRuleEditorDialog({ row = null, initialRule = null, title = null, onSaved = null, onDeleted = null, onClose = null } = {}) {
  const original = structuredClone(row?.rule || initialRule || {});
  if (!row) delete original.ruleUid;
  const controller = new AbortController();
  const logoHandles = [];
  const channelObservers = [];
  const dialog = document.createElement('dialog');
  dialog.className = 'rule-dialog';
  const article = document.createElement('article');
  const header = document.createElement('header');
  const heading = document.createElement('h2');
  heading.textContent = title || (row ? `ルール #${row.index + 1} を編集` : 'ルールを追加');
  const headerActions = document.createElement('div');
  headerActions.className = 'rule-dialog-header-actions';
  const closeButton = document.createElement('button');
  closeButton.type = 'button'; closeButton.className = 'rule-dialog-close'; closeButton.setAttribute('aria-label', '閉じる'); closeButton.textContent = '×';
  const body = document.createElement('div');
  body.className = 'rule-dialog-body is-editor';
  body.innerHTML = '<p class="rules-message">番組情報を取得しています</p>';
  header.append(heading, headerActions, closeButton);
  article.append(header, body);
  dialog.append(article);
  document.body.append(dialog);
  let dirtyCheck = () => false;
  let previewTimer = null;
  let mutating = false;
  let backdropPointerDown = false;

  const requestClose = () => {
    if (mutating) return;
    const cancel = new Event('cancel', { cancelable: true });
    if (dialog.dispatchEvent(cancel)) dialog.close();
  };
  closeButton.addEventListener('click', requestClose);
  // Dragging selected text from inside the editor onto the backdrop must not close it.
  dialog.addEventListener('pointerdown', event => {
    backdropPointerDown = event.button === 0 && event.target === dialog;
  });
  dialog.addEventListener('pointerup', event => {
    backdropPointerDown = backdropPointerDown && event.target === dialog;
  });
  dialog.addEventListener('click', event => {
    if (backdropPointerDown && event.target === dialog) requestClose();
    backdropPointerDown = false;
  });
  dialog.addEventListener('cancel', event => {
    if (mutating || (dirtyCheck() && !window.confirm('保存していない変更を破棄しますか？'))) event.preventDefault();
  });
  dialog.addEventListener('close', () => {
    controller.abort();
    clearTimeout(previewTimer);
    channelObservers.forEach(observer => observer.disconnect());
    logoHandles.forEach(handle => handle.dispose());
    dialog.remove();
    onClose?.();
  }, { once: true });
  dialog.showModal();

  (async () => {
    let editorData;
    try { editorData = await loadRuleEditorData({ signal: controller.signal }); }
    catch (error) {
      if (error?.name === 'AbortError' || !dialog.open) return;
      body.innerHTML = '<div class="rules-error"><p>編集に必要な番組情報を取得できませんでした</p><small></small></div>';
      body.querySelector('small').textContent = error.message;
      return;
    }
    if (!dialog.open) return;
    body.replaceChildren();
    const form = document.createElement('form');
    const formId = `rule-editor-${Date.now()}`;
    form.id = formId;
    form.className = 'rule-form rule-editor-form';
    const enabledLabel = document.createElement('span');
    enabledLabel.className = 'rule-enabled-label';
    enabledLabel.textContent = 'ルールを有効にする';
    const enabledSwitch = document.createElement('label');
    enabledSwitch.className = 'settings-switch rule-enabled-switch';
    enabledSwitch.setAttribute('aria-label', 'ルールを有効にする');
    const enabledInput = document.createElement('input');
    enabledInput.type = 'checkbox'; enabledInput.name = 'isEnabled'; enabledInput.setAttribute('form', formId); enabledInput.checked = original.isDisabled !== true;
    const enabledTrack = document.createElement('span'); enabledTrack.className = 'settings-switch-track'; enabledTrack.setAttribute('aria-hidden', 'true');
    const enabledState = document.createElement('span'); enabledState.className = 'settings-switch-state';
    const updateEnabledState = () => { enabledState.textContent = enabledInput.checked ? '有効' : '無効'; };
    enabledInput.addEventListener('change', () => { updateEnabledState(); form.dispatchEvent(new Event('change')); }); updateEnabledState();
    enabledSwitch.append(enabledInput, enabledTrack, enabledState);
    headerActions.replaceChildren(enabledLabel, enabledSwitch);

    const tabs = document.createElement('div');
    tabs.className = 'rule-editor-tabs';
    tabs.innerHTML = '<button type="button" class="is-active" data-tab="basic">基本条件</button><button type="button" data-tab="advanced">詳細オプション</button><button type="button" data-tab="matches">一致番組（計算中）</button>';
    const scroll = document.createElement('div');
    scroll.className = 'rule-editor-scroll';
    const basic = document.createElement('section'); basic.className = 'rule-editor-panel is-active'; basic.dataset.panel = 'basic';
    const advanced = document.createElement('section'); advanced.className = 'rule-editor-panel'; advanced.dataset.panel = 'advanced';
    const matches = document.createElement('section'); matches.className = 'rule-editor-panel rule-match-panel'; matches.dataset.panel = 'matches';

    function stringField(name, labelText, description, withMode = false) {
      const field = fieldset(labelText, `${description} 空欄は保存時に除外されます。`);
      if (withMode) {
        const mode = document.createElement('div');
        mode.className = 'rule-title-mode';
        mode.innerHTML = `<span>複数条件：</span><label><input type="radio" name="reserve_titles_mode" value="or"${ruleTitleMode(original) === 'or' ? ' checked' : ''}>いずれかに一致（OR）</label><label><input type="radio" name="reserve_titles_mode" value="and"${ruleTitleMode(original) === 'and' ? ' checked' : ''}>すべてに一致（AND）</label>`;
        field.append(mode);
      }
      field.append(createStringEditor(name, original[name]));
      return field;
    }

    basic.append(pairedFields(
      stringField('reserve_titles', '対象タイトル', '正規表現を1条件ずつ入力します。', true),
      stringField('ignore_titles', '除外タイトル', 'いずれかに一致する番組を除外します。')
    ));
    const types = fieldset('放送波', '未選択の場合はすべての放送波を対象にします。');
    types.append(createCheckboxes('types', RULE_TYPES, original.types));
    const categories = fieldset('ジャンル', '未選択の場合はジャンルで絞り込みません。');
    categories.append(createCheckboxes('categories', RULE_CATEGORIES, original.categories, categoryLabel));
    basic.append(pairedFields(types, categories, 'broadcast'));

    const channelMap = buildRuleChannelMap(editorData.schedule);
    function channelField(name, labelText) {
      const field = fieldset(labelText);
      const picker = document.createElement('section'); picker.className = 'rule-channel-picker';
      const selectedHost = document.createElement('div'); selectedHost.className = 'rule-channel-selected';
      const chips = document.createElement('span'); chips.className = 'rule-channel-chips';
      const count = document.createElement('span'); count.className = 'rule-channel-count'; count.hidden = true;
      const inputs = document.createElement('div'); inputs.hidden = true;
      const choose = document.createElement('button'); choose.type = 'button'; choose.className = 'button'; choose.textContent = '放送局を選択';
      let values = list(original[name]);
      function updateSelectedDisplay() {
        if (!values.length) {
          chips.hidden = true;
          count.hidden = false;
          count.textContent = '指定なし';
          return;
        }
        chips.hidden = false;
        count.hidden = true;
        requestAnimationFrame(() => {
          if (!dialog.open) return;
          const overflow = chips.scrollWidth > selectedHost.clientWidth;
          chips.hidden = overflow;
          count.hidden = !overflow;
        });
      }
      function renderSelected() {
        chips.replaceChildren(); inputs.replaceChildren();
        const names = [];
        values.forEach(id => {
          const input = document.createElement('input'); input.type = 'checkbox'; input.name = name; input.value = id; input.checked = true; inputs.append(input);
          const channel = channelMap.get(id);
          const channelName = channel?.name || id;
          names.push(channelName);
          const chip = document.createElement('span'); chip.className = 'rule-channel-chip';
          const handle = createChannelLogo({ name: channelName, fallbackText: channelName, tooltip: channelName, url: logoUrl(channel) }, { variant: 'list', focusable: false });
          logoHandles.push(handle);
          const label = document.createElement('small'); label.textContent = channelName;
          chip.append(handle.element, label); chips.append(chip);
        });
        selectedHost.title = names.join('、');
        count.textContent = `${name === 'channels' ? '対象' : '除外'}${values.length}局`;
        updateSelectedDisplay();
      }
      choose.addEventListener('click', async () => {
        const result = await openChannelSelector({ title: `${labelText}を選択`, channels: editorData.schedule, selectedIds: values });
        if (result === null) return;
        values = result; renderSelected(); form.dispatchEvent(new Event('change', { bubbles: true }));
      });
      selectedHost.append(chips, count);
      picker.append(selectedHost, inputs, choose); field.append(picker);
      const observer = new ResizeObserver(updateSelectedDisplay); observer.observe(selectedHost); channelObservers.push(observer);
      renderSelected();
      return field;
    }
    basic.append(pairedFields(
      channelField('channels', '対象局'),
      channelField('ignore_channels', '除外局')
    ));

    const storageField = fieldset('録画保存先', '保存先を指定しない場合は、デフォルト録画先を使用します。');
    const storage = document.createElement('select'); storage.name = 'recordedDirId'; storage.innerHTML = '<option value="">デフォルト録画先</option>';
    (Array.isArray(editorData.config?.recordedDirs) ? editorData.config.recordedDirs : []).forEach(item => {
      const option = document.createElement('option'); option.value = text(item?.id); option.textContent = text(item?.name) || text(item?.id) || text(item?.path); option.selected = option.value !== '' && option.value === original.recordedDirId; storage.append(option);
    });
    if (text(original.recordedDirId) && !Array.from(storage.options).some(option => option.value === original.recordedDirId)) {
      const option = document.createElement('option'); option.value = original.recordedDirId; option.textContent = `${original.recordedDirId}（現在の設定にない保存先）`; option.selected = true; storage.append(option);
    }
    storageField.append(storage); basic.append(storageField);
    const includeFlags = fieldset('対象属性', '選択した属性のうち、少なくとも1つに一致する番組を対象にします。');
    includeFlags.append(createCheckboxes('reserve_flags', RULE_FLAGS, original.reserve_flags, value => value, value => FLAG_TITLES[value] || value));
    const excludeFlags = fieldset('除外属性', '選択した属性が1つでも含まれる番組を除外します。');
    excludeFlags.append(createCheckboxes('ignore_flags', RULE_FLAGS, original.ignore_flags, value => value, value => FLAG_TITLES[value] || value));
    advanced.append(
      pairedFields(includeFlags, excludeFlags),
      pairedFields(
        stringField('reserve_descriptions', '対象説明文', 'いずれかに一致する番組を対象にします。'),
        stringField('ignore_descriptions', '除外説明文', 'いずれかに一致する番組を除外します。')
      )
    );

    const hours = fieldset('時間帯', '0〜24時の既存判定を使用します。');
    hours.innerHTML += '<div class="rule-compact-range"><span>開始</span><label><input type="number" name="hour_start" min="0" max="24" step="1"><span>時</span></label><span>〜 終了</span><label><input type="number" name="hour_end" min="0" max="24" step="1"><span>時</span></label></div>';
    const duration = fieldset('番組の長さ', '空欄の扱いと単位は既存仕様を維持します。');
    duration.innerHTML += '<div class="rule-compact-range"><span>最短</span><label><input type="number" name="duration_min" min="0" step="1"><span>秒</span></label><span>〜 最長</span><label><input type="number" name="duration_max" min="0" step="1"><span>秒</span></label></div>';
    hours.querySelector('[name="hour_start"]').value = original.hour?.start ?? 0;
    hours.querySelector('[name="hour_end"]').value = original.hour?.end ?? 24;
    duration.querySelector('[name="duration_min"]').value = original.duration?.min ?? '';
    duration.querySelector('[name="duration_max"]').value = original.duration?.max ?? '';
    advanced.append(pairedFields(hours, duration));

    const output = fieldset('録画オプション');
    const outputGrid = document.createElement('div'); outputGrid.className = 'rule-form-columns';
    const format = document.createElement('label'); format.textContent = 'ファイル名書式';
    const formatInput = document.createElement('input'); formatInput.type = 'text'; formatInput.name = 'recorded_format'; formatInput.value = text(original.recorded_format); formatInput.placeholder = 'デフォルトの書式を使用'; format.append(formatInput);
    const boundary = document.createElement('label'); boundary.textContent = '録画の優先方針';
    const boundarySelect = document.createElement('select'); boundarySelect.name = 'recordingBoundaryPolicy';
    [['default', '共通設定に従う'], ['start', '開始優先（末尾切れを許可）'], ['end', '終了優先（開始遅れを許可）']]
      .forEach(([value, label]) => {
        const option = document.createElement('option'); option.value = value; option.textContent = label;
        boundarySelect.append(option);
      });
    boundarySelect.value = ['default', 'start', 'end'].includes(original.recordingBoundaryPolicy)
      ? original.recordingBoundaryPolicy : original.allowEndLack === true ? 'start' : 'default';
    boundary.append(boundarySelect);
    const boundaryNote = document.createElement('p'); boundaryNote.className = 'rule-field-note';
    boundaryNote.textContent = '共通設定に従う場合は録画設定の方針を使用します。個別指定は共通設定を変更しても維持されます。';
    outputGrid.append(format, boundary); output.append(outputGrid, boundaryNote); advanced.append(output);

    const compatibility = Object.keys(original).filter(key => !KNOWN_KEYS.has(key));
    if (compatibility.length || original.sid !== undefined || original.category !== undefined) {
      const legacy = fieldset('互換条件', '現在のルールに保存されている互換条件です。今回の編集では値を維持します。');
      const details = [];
      if (original.sid !== undefined) details.push(`サービスID: ${original.sid}`);
      if (original.category !== undefined) details.push(`旧形式ジャンル: ${categoryLabel(original.category)}`);
      compatibility.forEach(key => details.push(`${key}: ${JSON.stringify(original[key])}`));
      const value = document.createElement('p'); value.className = 'rule-compatibility-values'; value.textContent = details.join(' / '); legacy.append(value); advanced.append(legacy);
    }

    const matchIntro = document.createElement('div');
    matchIntro.className = 'rule-match-intro';
    matchIntro.innerHTML = '<div><strong>編集中の条件による一致番組</strong><p>現在の番組表を保存せずに照合します。ルールへの一致と予約成立は別に表示します。</p></div><span>計算中</span>';
    const matchList = document.createElement('div'); matchList.className = 'rule-match-list'; matchList.setAttribute('aria-live', 'polite');
    matches.append(matchIntro, matchList);

    scroll.append(basic, advanced, matches); form.append(tabs, scroll);
    const feedback = document.createElement('p'); feedback.className = 'rule-form-feedback'; feedback.hidden = true;
    const actions = document.createElement('footer'); actions.innerHTML = `${row ? '<button class="button is-danger rule-delete" type="button">削除</button><span class="rule-action-spacer"></span>' : ''}<button class="button rule-cancel" type="button">キャンセル</button><button class="button rule-submit-only" type="submit"${row ? '' : ' hidden'}>${row ? '保存' : '作成'}</button><button class="button is-primary rule-submit-schedule" type="submit">${row ? '保存して予約更新' : '作成して予約更新'}</button>`;
    form.append(feedback, actions); body.append(form);

    const panelScroll = new Map();
    let activeTab = 'basic';
    let latestMatchResult = null;
    function setTab(name) {
      if (!['basic', 'advanced', 'matches'].includes(name)) return;
      panelScroll.set(activeTab, scroll.scrollTop);
      activeTab = name;
      tabs.querySelectorAll('button').forEach(item => item.classList.toggle('is-active', item.dataset.tab === name));
      form.querySelectorAll('.rule-editor-panel').forEach(panel => panel.classList.toggle('is-active', panel.dataset.panel === name));
      requestAnimationFrame(() => { scroll.scrollTop = panelScroll.get(name) || 0; });
      if (name === 'matches') {
        if (latestMatchResult) renderMatchList(latestMatchResult);
        updatePreview(true);
      }
    }
    tabs.addEventListener('click', event => {
      const button = event.target.closest('[data-tab]');
      if (button) setTab(button.dataset.tab);
    });
    const programs = schedulePrograms(editorData.schedule);
    let previewRevision = 0; let previewSignature = ''; let composing = false;
    function renderMatchList(result) {
      const count = Number(result?.count) || 0;
      const matchTab = tabs.querySelector('[data-tab="matches"]');
      matchTab.textContent = `一致番組（${count}件）`;
      matchIntro.querySelector('span').textContent = `${count}件`;
      matchList.replaceChildren();
      if (count === 0) {
        const empty = document.createElement('p'); empty.className = 'rule-match-empty'; empty.textContent = '現在の番組表に一致する番組はありません。'; matchList.append(empty); return;
      }
      const heading = document.createElement('div'); heading.className = 'rule-match-row is-heading';
      heading.innerHTML = '<span>放送日時</span><span>放送局</span><span>番組タイトル</span><span>予約状態</span>';
      matchList.append(heading);
      const sorted = [...result.programs].sort((a, b) => Number(a?.start || 0) - Number(b?.start || 0));
      let rendered = 0;
      const more = document.createElement('button'); more.type = 'button'; more.className = 'button rule-match-more';
      const appendChunk = () => {
        more.remove();
        const fragment = document.createDocumentFragment();
        sorted.slice(rendered, rendered + 100).forEach(program => {
          const state = programState(program, editorData.reserves, editorData.recording);
          const item = document.createElement('div'); item.className = 'rule-match-row';
          const date = document.createElement('time');
          const startDate = new Date(Number(program.start));
          if (Number.isFinite(startDate.getTime())) date.dateTime = startDate.toISOString();
          date.textContent = formatProgramTime(program);
          const channel = document.createElement('span'); channel.textContent = text(program.channel?.name) || text(program.channel?.id) || '放送局不明';
          const titleNode = document.createElement('strong'); titleNode.textContent = programTitlePresentation(text(program.fullTitle) || text(program.title) || 'タイトル不明');
          const stateNode = document.createElement('span'); stateNode.className = `rule-match-state is-${state.key}`; stateNode.textContent = state.label;
          item.append(date, channel, titleNode, stateNode); fragment.append(item);
        });
        rendered = Math.min(rendered + 100, sorted.length);
        matchList.append(fragment);
        if (rendered < sorted.length) {
          more.textContent = `さらに表示（${rendered} / ${sorted.length}件）`;
          matchList.append(more);
        }
      };
      more.addEventListener('click', appendChunk);
      appendChunk();
    }
    function renderPreviewError(error) {
      tabs.querySelector('[data-tab="matches"]').textContent = '一致番組（条件エラー）';
      matchIntro.querySelector('span').textContent = '条件エラー';
      const message = document.createElement('p');
      message.className = 'rule-match-empty is-error';
      message.title = text(error.message);
      message.textContent = '条件を確認してください。一致番組は表示できません。';
      matchList.replaceChildren(message);
    }
    function updatePreview(immediate = false) {
      if (composing) return; clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        let payload;
        try { payload = buildPayload(form, original); } catch (error) { renderPreviewError(error); return; }
        const signature = JSON.stringify(payload); if (signature === previewSignature) return; previewSignature = signature;
        const revision = ++previewRevision; tabs.querySelector('[data-tab="matches"]').textContent = '一致番組（計算中）'; matchIntro.querySelector('span').textContent = '計算中';
        Promise.resolve().then(() => previewRuleMatches(payload, programs, editorData.config?.normalizationForm)).then(result => {
          if (revision !== previewRevision) return;
          latestMatchResult = result;
          tabs.querySelector('[data-tab="matches"]').textContent = `一致番組（${result.count}件）`;
          matchIntro.querySelector('span').textContent = `${result.count}件`;
          if (activeTab === 'matches') renderMatchList(result);
        }).catch(error => { if (revision !== previewRevision) return; renderPreviewError(error); });
      }, immediate ? 0 : 300);
    }
    form.addEventListener('compositionstart', () => { composing = true; });
    form.addEventListener('compositionend', () => { composing = false; updatePreview(); });
    form.addEventListener('input', () => { updatePreview(); });
    form.addEventListener('change', () => { updatePreview(true); });
    form.addEventListener('click', event => { if (event.target.closest('.rule-string-add,.rule-string-row .is-quiet')) setTimeout(() => { updatePreview(true); }, 0); });
    updatePreview(true);

    const initial = new FormData(form);
    const footerButtons = Array.from(actions.querySelectorAll('button'));
    const saveOnlyButton = form.querySelector('.rule-submit-only');
    const scheduleButton = form.querySelector('.rule-submit-schedule');
    const cancelButton = form.querySelector('.rule-cancel');
    let savedResult = null;
    let savedMode = row ? 'edit' : 'create';
    let savedIndex = row?.index ?? null;
    let saveWasCommitted = false;
    dirtyCheck = () => !saveWasCommitted && JSON.stringify(Array.from(initial)) !== JSON.stringify(Array.from(new FormData(form)));

    function setBusy(button, message) {
      mutating = true;
      footerButtons.forEach(item => { item.disabled = true; });
      closeButton.disabled = true;
      form.setAttribute('aria-busy', 'true');
      scroll.inert = true;
      button?.classList.add('is-running');
      feedback.classList.add('is-progress');
      feedback.textContent = message;
      feedback.hidden = false;
    }
    function setProgress(message) {
      feedback.textContent = message;
    }
    function stopBusy(button) {
      mutating = false;
      footerButtons.forEach(item => { item.disabled = false; });
      closeButton.disabled = false;
      form.removeAttribute('aria-busy');
      if (!saveWasCommitted) scroll.inert = false;
      button?.classList.remove('is-running');
      feedback.classList.remove('is-progress');
    }
    function showError(message) {
      feedback.classList.remove('is-progress');
      feedback.textContent = message;
      feedback.hidden = false;
    }
    async function notifySaved(extra = {}) {
      await onSaved?.({ mode: savedMode, index: savedIndex, rule: savedResult, ...extra });
    }

    cancelButton.addEventListener('click', requestClose);
    form.querySelector('.rule-delete')?.addEventListener('click', async event => {
      if (mutating || !window.confirm(`ルール #${row.index + 1} を削除しますか？`)) return;
      const button = event.currentTarget;
      setBusy(button, 'ルールを削除しています…');
      try {
        await deleteRule(row.index, row.uid || null);
      } catch (error) {
        stopBusy(button);
        showError(error.message);
        return;
      }
      dirtyCheck = () => false;
      setProgress('ルール一覧を更新しています…');
      try {
        await onDeleted?.(row);
        dialog.close();
      } catch (error) {
        stopBusy(button);
        showError(`ルールは削除されましたが、画面更新に失敗しました: ${error.message}`);
        footerButtons.forEach(item => { item.disabled = item !== cancelButton; });
        cancelButton.textContent = '閉じる';
      }
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (mutating || (!saveWasCommitted && !form.reportValidity())) return;
      const button = event.submitter?.classList.contains('rule-submit-schedule') ? scheduleButton : saveOnlyButton;
      // After a successful save, a retry must never POST the same new rule again.
      if (saveWasCommitted && button !== scheduleButton) return;
      setBusy(button, saveWasCommitted ? '予約情報を更新しています…' : 'ルールを保存しています…');
      let schedulerResult = null;
      let savedThisTime = false;
      if (!saveWasCommitted) {
        try {
          const payload = buildPayload(form, original);
          const saved = row ? await updateRule(row.index, payload, row.uid) : await createRule(payload);
          savedResult = saved || payload;
          savedThisTime = true;
          saveWasCommitted = true;
          dirtyCheck = () => false;
        } catch (error) {
          stopBusy(button);
          showError(error.message);
          return;
        }
      }
      if (button === scheduleButton || !row) {
        setProgress(row ? 'スケジューラーを実行しています…' : '予約情報を更新しています…');
        try {
          if (!row && savedThisTime) {
            if (!savedResult.reservationUpdate?.success) {
              throw new Error(savedResult.reservationUpdate?.error || '予約更新の結果を確認できませんでした');
            }
            schedulerResult = { ...savedResult.reservationUpdate, quick: true };
          } else {
            schedulerResult = await runScheduler(row ? null : savedResult);
          }
        } catch (error) {
          setProgress('ルール一覧を更新しています…');
          let refreshError = null;
          try { await notifySaved({ schedulerRan: false, schedulerError: error }); }
          catch (cause) { refreshError = cause; }
          stopBusy(button);
          saveOnlyButton.hidden = true;
          scheduleButton.textContent = '予約更新を再試行';
          cancelButton.textContent = '閉じる';
          showError(`ルールは保存済みですが、予約更新に失敗しました: ${error.message}${refreshError ? `（画面更新も失敗: ${refreshError.message}）` : ''}`);
          return;
        }
      }
      setProgress('ルール・予約情報を更新しています…');
      try {
        await notifySaved({ schedulerRan: button === scheduleButton || !row, schedulerResult });
        dialog.close();
      } catch (error) {
        stopBusy(button);
        saveOnlyButton.hidden = true;
        scheduleButton.hidden = true;
        cancelButton.textContent = '閉じる';
        showError(`ルールは保存されましたが、画面更新に失敗しました: ${error.message}`);
      }
    });
  })();
  return dialog;
}
