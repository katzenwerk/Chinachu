import { invalidateResources, loadResources } from './api-client.js';
import { loadConfig } from './config-client.js';

async function jsonResponse(response, label) {
  let value = null;
  try { value = await response.json(); } catch (_) {}
  if (!response.ok) throw new Error(`${label}に失敗しました (HTTP ${response.status})`);
  return value;
}

async function mutate(url, method, label, body, extraHeaders = {}) {
  const response = await fetch(url, {
    method,
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await jsonResponse(response, label);
  invalidateResources(['rules', 'reserves']);
  return result;
}

export async function loadRulesPageData(options = {}) {
  if (options.force !== true) {
    const resources = await loadResources(['rules', 'reserves']);
    return {
      rules: Array.isArray(resources.rules) ? resources.rules : [],
      reserves: Array.isArray(resources.reserves) ? resources.reserves : []
    };
  }
  // 操作直後は、別の画面から進行中のresource取得やcacheを再利用せず、
  // rules.jsonの最新状態をno-storeで読み直す。
  invalidateResources(['rules', 'reserves']);
  const [rules, resources] = await Promise.all([
    loadCurrentRules(), loadResources(['reserves'])
  ]);
  return {
    rules,
    reserves: Array.isArray(resources.reserves) ? resources.reserves : []
  };
}

export async function loadRuleEditorData(options = {}) {
  const [resources, config] = await Promise.all([
    loadResources(['schedule', 'reserves', 'recording']),
    loadConfig(options.signal)
  ]);
  return {
    schedule: Array.isArray(resources.schedule) ? resources.schedule : [],
    reserves: Array.isArray(resources.reserves) ? resources.reserves : [],
    recording: Array.isArray(resources.recording) ? resources.recording : [],
    config
  };
}

export async function loadRuleRecordingCounts(options = {}) {
  const response = await fetch('/api/match.json?mode=rule-recording-counts', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: options.signal
  });
  const result = await jsonResponse(response, '録画実績の取得');
  if (!result || !result.counts || typeof result.counts !== 'object' || Array.isArray(result.counts)) {
    throw new Error('録画実績APIの応答が不正です');
  }
  return result;
}

export const createRule = rule => mutate('/api/rules.json', 'POST', 'ルールの作成', rule);
export const updateRule = (index, rule, expectedRuleUid = null) => mutate(
  `/api/rules/${index}.json`,
  'PUT',
  'ルールの保存',
  rule,
  expectedRuleUid ? { 'X-Chinachu-Rule-Uid': expectedRuleUid } : {}
);
export const deleteRule = (index, expectedRuleUid = null) => mutate(
  `/api/rules/${index}.json`,
  'DELETE',
  'ルールの削除',
  undefined,
  expectedRuleUid ? { 'X-Chinachu-Rule-Uid': expectedRuleUid } : {}
);
export const setRuleEnabled = (index, enabled, expectedRuleUid = null) => mutate(
  `/api/rules/${index}/${enabled ? 'enable' : 'disable'}.json`,
  'PUT',
  enabled ? 'ルールの有効化' : 'ルールの無効化',
  undefined,
  expectedRuleUid ? { 'X-Chinachu-Rule-Uid': expectedRuleUid } : {}
);

async function loadCurrentRules() {
  const response = await fetch('/api/rules.json', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store'
  });
  const result = await jsonResponse(response, 'ルール一覧の再確認');
  if (!Array.isArray(result)) throw new Error('ルール一覧APIの応答が不正です');
  return result;
}

// 位置番号を保存せず、操作直前のrules.jsonから対象を確定する。
// APIにもruleUidを渡し、ロック内の最新rules.jsonで対象を再解決する。
export async function setRuleEnabledByUid(ruleUid, expectedEnabled) {
  if (!ruleUid) throw new Error('ルールの識別子がありません');
  const current = await loadCurrentRules();
  const matching = current.map((rule, index) => ({ rule, index }))
    .filter(entry => entry.rule?.ruleUid === ruleUid);
  if (matching.length !== 1) throw new Error('操作対象のルールを一意に特定できません。一覧を更新してください');
  const { rule, index } = matching[0];
  if ((rule.isDisabled !== true) !== expectedEnabled) {
    throw new Error('ルールの有効状態が変更されています。一覧を更新してください');
  }
  const result = await setRuleEnabled(index, !expectedEnabled, ruleUid);
  // APIの受付直後にファイルへの変更がまだ反映されていない場合がある。
  // 切替後の状態をruleUidで確認するまで、古い一覧を表示し直さない。
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const latest = await loadCurrentRules();
    const target = latest.filter(entry => entry?.ruleUid === ruleUid);
    if (target.length !== 1) throw new Error('操作後に対象ルールを一意に確認できません。一覧を再確認してください');
    if ((target[0].isDisabled !== true) === !expectedEnabled) return result;
    if (attempt < 9) await wait(150);
  }
  throw new Error('有効状態の反映を確認できませんでした。一覧を再確認してください');
}

const wait = duration => new Promise(resolve => setTimeout(resolve, duration));

async function waitForRuleRemoval(ruleUid) {
  let currentRules = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    currentRules = await loadCurrentRules();
    if (!currentRules.some(rule => rule?.ruleUid === ruleUid)) return currentRules;
    if (attempt < 9) await wait(150);
  }
  throw new Error('削除後のルール一覧更新を確認できません');
}

export async function deleteRulesByUid(ruleUids, options = {}) {
  const targets = [...new Set((Array.isArray(ruleUids) ? ruleUids : []).filter(value => typeof value === 'string' && value !== ''))];
  const deletedRuleUids = [];
  let latestRules = null;
  for (const ruleUid of targets) {
    let currentRules;
    try {
      currentRules = latestRules || await loadCurrentRules();
      const index = currentRules.findIndex(rule => rule?.ruleUid === ruleUid);
      if (index === -1) throw new Error(`対象ルール (${ruleUid}) が見つかりません`);
      const result = await deleteRule(index, ruleUid);
      deletedRuleUids.push(ruleUid);
      options.onProgress?.({ deleted: deletedRuleUids.length, total: targets.length, ruleUid });
      try {
        latestRules = Array.isArray(result?.rules) ? result.rules : await waitForRuleRemoval(ruleUid);
      } catch (cause) {
        const error = new Error(`${deletedRuleUids.length}件削除しましたが、${cause.message}`);
        error.cause = cause;
        error.deletedRuleUids = deletedRuleUids.slice();
        error.failedRuleUid = null;
        error.refreshFailed = true;
        throw error;
      }
    } catch (cause) {
      if (cause?.refreshFailed === true) throw cause;
      const error = new Error(`${deletedRuleUids.length}件削除後、${cause.message}`);
      error.cause = cause;
      error.deletedRuleUids = deletedRuleUids.slice();
      error.failedRuleUid = ruleUid;
      throw error;
    }
  }
  return { deletedRuleUids, rules: latestRules || [] };
}

export async function runScheduler() {
  const response = await fetch('/api/scheduler.json', {
    method: 'PUT',
    headers: { Accept: 'application/json' }
  });
  if (response.status === 409) {
    const error = new Error('スケジューラーは現在実行中です');
    error.status = response.status;
    throw error;
  }
  const result = await jsonResponse(response, 'スケジューラーの実行');
  invalidateResources(['reserves']);
  return result || { conflicts: [], reserves: [] };
}
