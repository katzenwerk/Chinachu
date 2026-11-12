export const RULE_TYPES = ['GR', 'BS', 'CS', 'SKY'];
export const RULE_CATEGORIES = [
  'anime', 'information', 'news', 'sports', 'variety', 'documentary',
  'drama', 'music', 'cinema', 'theater', 'hobby', 'welfare', 'etc'
];
export const RULE_FLAGS = ['新', '終', '再', '字', 'デ', '解', '無', '二', 'Ｓ'];

const CATEGORY_LABELS = Object.freeze({
  anime: 'アニメ', information: '情報', news: 'ニュース', sports: 'スポーツ',
  variety: 'バラエティ', documentary: 'ドキュメンタリー', drama: 'ドラマ', music: '音楽',
  cinema: '映画', theater: '演劇', hobby: '趣味', welfare: '福祉', etc: 'その他'
});

export function categoryLabel(value) {
  return CATEGORY_LABELS[value] || value;
}

export function ruleTitleMode(rule) {
  return rule?.reserve_titles_mode === 'and' ? 'and' : 'or';
}

export function ruleHandoffProtected(rule) {
  return rule?.recordingHandoffProtected === true;
}

export function buildRuleChannelMap(schedule) {
  const channels = new Map();
  (Array.isArray(schedule) ? schedule : []).forEach(channel => {
    if (!channel || typeof channel.id !== 'string' || channels.has(channel.id)) return;
    channels.set(channel.id, channel);
  });
  return channels;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function list(value) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

export function ruleSummary(rule) {
  const name = text(rule?.name);
  const titles = list(rule?.reserve_titles);
  if (titles.length > 0) {
    const connector = ruleTitleMode(rule) === 'and' ? ' AND ' : ' OR ';
    const titleSummary = titles.slice(0, 2).join(connector) + (titles.length > 2 ? ` ほか${titles.length - 2}件` : '');
    return name ? `${name} — ${titleSummary}` : titleSummary;
  }
  const parts = [];
  const categories = list(rule?.categories);
  if (text(rule?.category) && !categories.includes(text(rule.category))) categories.push(text(rule.category));
  const types = list(rule?.types);
  const channels = list(rule?.channels);
  if (categories.length) parts.push(categories.map(categoryLabel).join('・'));
  if (types.length) parts.push(types.join('・'));
  if (channels.length) parts.push(`${channels.length}局`);
  return name || parts.join(' / ') || 'すべての番組';
}

export function buildRuleRows(rules, reserves, achievementCounts, channelMap) {
  const reservationCounts = new Map();
  (Array.isArray(reserves) ? reserves : []).forEach(reserve => {
    const uid = text(reserve?.ruleUid);
    if (!uid || reserve?.isSkip === true) return;
    reservationCounts.set(uid, (reservationCounts.get(uid) || 0) + 1);
  });

  return (Array.isArray(rules) ? rules : []).map((rule, index) => {
    const uid = text(rule?.ruleUid);
    const channelIds = list(rule?.channels);
    const channelNames = channelIds.map(id => channelMap.get(id)?.name || id);
    const summary = ruleSummary(rule);
    const searchText = [
      index + 1, uid, summary, ...channelNames, ...list(rule?.ignore_channels),
      ...list(rule?.reserve_titles), ...list(rule?.ignore_titles),
      ...list(rule?.reserve_descriptions), ...list(rule?.ignore_descriptions),
      ...list(rule?.types), ...list(rule?.categories).map(categoryLabel),
      ...list(rule?.reserve_flags), ...list(rule?.ignore_flags), JSON.stringify(rule || {})
    ].join(' ').toLocaleLowerCase('ja');
    return {
      index,
      rule,
      uid,
      enabled: rule?.isDisabled !== true,
      summary,
      channelIds,
      reservationCount: uid ? reservationCounts.get(uid) || 0 : 0,
      achievementCount: achievementCounts === null ? null : uid ? Number(achievementCounts?.[uid]) || 0 : 0,
      searchText
    };
  });
}

export function filterRuleRows(rows, options = {}) {
  const search = text(options.search).toLocaleLowerCase('ja');
  const status = ['enabled', 'disabled'].includes(options.status) ? options.status : 'all';
  return rows.filter(row => {
    if (status === 'enabled' && !row.enabled) return false;
    if (status === 'disabled' && row.enabled) return false;
    return search === '' || row.searchText.includes(search);
  });
}
