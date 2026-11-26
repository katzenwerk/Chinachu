'use strict';

// Classification and infobox field names are shared with the Archive investigation.
const clean = (value) => typeof value === 'string' ? value.trim() : '';
const normalize = (value) => clean(value).normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const useful = (value) => value && !/^(?:\*+|[-—?？]+|未知|不明|n\/a|tbd)$/i.test(value);
const asSet = (value) => new Set(value.split('|').map(normalize));
const keys = {
  country: asSet('国家/地区|国家 / 地区|國家/地區|国家地区|國家地區|国家・地区|製作国|制作国|制片国家/地区|製片國家/地區|制作国家/地区|製作國家/地區|制片国家|製片國家|制作国家|製作國家|制片地区|製片地區|国家|國家|地区/国家|地區/國家|地区|地區|地域|制作地区|生产国'),
  premiere: asSet('首播国家|首播國家|首播地区|首播地區'),
  language: asSet('语言|語言|言語|对白语言|對白語言|原始语言|原始語言|音声言語'),
  broadcaster: asSet('电视台|電視台|播放电视台|播放電視台|其他电视台|其他電視台|首播电视台|首播電視台|放送局|放送網|电视网|電視網|频道|頻道'),
  streaming: asSet('在线播放平台|在線播放平台|网络播放平台|網絡播放平台|配信プラットフォーム'),
  aliases: asSet('别名|別名|又名|英文名|英語名|英语名|英語タイトル|台湾名称|台灣名稱|港澳名称|马新名称|馬新名稱'),
  season: asSet('季数|季數|シーズン|季度|季'),
  total: asSet('话数|話数|話數|集数|集數|总话数|總話數|总集数|總集數|総話数|全話数'),
  start: asSet('放送开始|放送開始|放送開始日|初回放送日|首播|首播日|首播日期|放送日'),
};
const fieldByKey = new Map(Object.entries(keys).flatMap(([field, variants]) =>
  [...variants].map((key) => [key, field])));

// Read the scalar and bracketed-list forms used by the wiki templates.
function extractInfobox(text) {
  const fields = Object.fromEntries(Object.keys(keys).map((key) => [key, []]));
  const listed = new Set();
  let current;
  for (const raw of text.split(/\r?\n|\r/)) {
    const line = raw.trim();
    const entry = /^\|\s*([^=]+)=(.*)$/.exec(line);
    if (entry) {
      current = fieldByKey.get(normalize(entry[1]).replace(/:$/, ''));
      if (!current) continue;
      listed.add(current);
      const value = entry[2].trim();
      if (!value.startsWith('{') && useful(value)) fields[current].push(value);
      if (!value.startsWith('{')) current = undefined;
    }
    if (!current) continue;
    for (const item of line.matchAll(/\[([^\[\]]+)\]/g)) {
      const value = item[1].replace(/^[^=\]]+=\s*/, '').trim();
      if (useful(value)) fields[current].push(value);
    }
    if (line.includes('}')) current = undefined;
  }
  for (const key of Object.keys(fields)) fields[key] = [...new Set(fields[key])];
  return { fields, listed };
}

const japanCountry = asSet('日本|日本国|日本國|japan|jp|jpn');
const otherCountry = asSet('欧美|歐美|欧洲|歐洲|中国|中國|中国大陆|中國大陸|大陆|大陸|中华人民共和国|中華人民共和國|china|prc|国产|國產|香港|中国香港|中國香港|hong kong|台湾|台灣|臺灣|中国台湾|中国台灣|中國台灣|中國臺灣|taiwan|中华民国|中華民國|澳门|澳門|中国澳门|中國澳門|macau|韩国|韓國|南韩|南韓|south korea|korea|kr|朝鲜|朝鮮|北韩|north korea|美国|美國|usa|us|united states|united states of america|u.s.|u.s.a.|英国|英國|uk|u.k.|united kingdom|great britain|加拿大|canada|法国|法國|france|德国|德國|germany|西德|东德|東德|澳大利亚|澳大利亞|澳洲|australia|新西兰|新西蘭|纽西兰|紐西蘭|new zealand|泰国|泰國|thailand|俄罗斯|俄羅斯|russia|苏联|蘇聯|ussr|苏俄|西班牙|spain|意大利|義大利|italy|葡萄牙|portugal|巴西|brazil|墨西哥|mexico|阿根廷|argentina|智利|chile|哥伦比亚|colombia|比利时|比利時|belgium|荷兰|荷蘭|netherlands|卢森堡|盧森堡|luxembourg|奥地利|奧地利|austria|瑞士|switzerland|爱尔兰|愛爾蘭|ireland|捷克|czechia|czech republic|捷克斯洛伐克|czechoslovakia|斯洛伐克|波兰|波蘭|poland|匈牙利|hungary|瑞典|sweden|丹麦|丹麥|denmark|挪威|norway|芬兰|芬蘭|finland|冰岛|冰島|希腊|希臘|罗马尼亚|保加利亚|南斯拉夫|克罗地亚|塞尔维亚|乌克兰|烏克蘭|ukraine|爱沙尼亚|拉脱维亚|立陶宛|以色列|israel|伊朗|iran|土耳其|turkey|南非|south africa|印度|india|新加坡|singapore|马来西亚|馬來西亞|malaysia|菲律宾|菲律賓|philippines|越南|vietnam|印度尼西亚|印尼|indonesia|蒙古|哈萨克斯坦|格鲁吉亚|阿联酋|埃及|沙特阿拉伯');
const japanTag = asSet('日本|日剧|日劇|日影|日本动画|日本動畫|日本动漫|日本動漫|日本电影|日本電影|日本アニメ|邦画');
const otherTag = new Set([...otherCountry, ...asSet('华语|華語|美剧|美劇|英剧|英劇|韩剧|韓劇|港剧|港劇|台剧|台劇|泰剧|泰劇|法剧|法劇|德剧|德劇|国剧|國劇|国产动画|國產動畫|欧美动画|歐美動畫|国漫|國漫')]);
const japanLanguage = asSet('日语|日語|日本语|日本語|日文|japanese|日本');
const otherLanguage = asSet('英语|英語|英文|english|汉语普通话|漢語普通話|普通话|普通話|中文|中文汉语广东话|汉语|漢語|国语|國語|简体中文|mandarin|chinese|粤语|粵語|广东话|cantonese|闽南语|閩南語|台语|台語|韩语|韓語|korean|法语|法語|french|俄语|俄語|russian|德语|德語|german|西班牙语|西班牙語|spanish|葡萄牙语|葡萄牙語|意大利语|意大利語|泰语|泰語|捷克语|荷兰语|挪威语|波斯语|波兰语|印地语|芬兰语|乌克兰语|土耳其语|阿拉伯语|越南语|菲律宾语|serbian');
function signs(values, japan, other, split = false) {
  let bits = 0;
  for (const value of values) {
    const parts = split ? value.normalize('NFKC').split(/[\/、,;，；・+&／|]|\s+(?:and|と|和)\s+/i) : [value];
    for (const part of parts) {
      const key = normalize(part.trim().replace(/\s*[（(][^()（）]*[）)]\s*$/, ''));
      if (japan.has(key)) bits |= 1;
      if (other.has(key)) bits |= 2;
    }
  }
  return bits;
}

function evidenceFor(subject, fields, tags, meta) {
  return {
    platform: subject.type === 6 ? ({ 1: 1, 2: 2, 3: 2 })[subject.platform] || 0 : 0,
    meta_tags: signs(meta, japanCountry, otherCountry),
    country: signs(fields.country, japanCountry, otherCountry, true),
    language: signs(fields.language, japanLanguage, otherLanguage, true),
    tags: signs(tags, japanTag, otherTag),
  };
}


function firstBroadcast(subjectDate, values) {
  const raw = clean(subjectDate);
  if (useful(raw) && !/^0{4}(?:-0{2}){0,2}$/.test(raw)) return null;
  const dates = new Set();
  for (const value of values) {
    const match = /^(\d{4})(?:[-/.]|年)(\d{1,2})(?:[-/.]|月)(\d{1,2})日?$/.exec(value.normalize('NFKC').trim());
    if (!match || match[1] === '0000') continue;
    const date = [match[1], match[2].padStart(2, '0'), match[3].padStart(2, '0')].join('-');
    const instant = new Date(date);
    if (Number.isFinite(instant.valueOf()) && instant.toISOString().slice(0, 10) === date) dates.add(date);
  }
  return dates.size === 1 ? { date: dates.values().next().value, source: 'infobox' } : null;
}

function classify(subject) {
  if (subject.type !== 6) return null;
  const infobox = subject.infobox || '';
  const { fields } = extractInfobox(infobox);
  const tags = (subject.tags || []).map(tag => tag.name);
  const meta = subject.meta_tags || [];
  const evidence = evidenceFor(subject, fields, tags, meta);
  const geography = evidence.platform | evidence.meta_tags | evidence.country;
  if (geography === 2) return null;
  const counts = [...new Set(fields.total.map(normalize).filter(value => /^\d+(?:話|话|集)?$/.test(value))
    .map(value => Number.parseInt(value, 10)).filter(value => value > 0))];
  const tvTemplate = /\{\{\s*Infobox\s+real\/Television\b/i.test(infobox);
  const tv = [1, 6001].includes(subject.platform) || subject.platform === 0 && tvTemplate;
  const firstBroadcastDate = tv ? firstBroadcast(subject.date, fields.start) : null;
  return {
    id: subject.id, name: subject.name, name_cn: subject.name_cn || '', date: subject.date || '',
    platform: subject.platform, origin: geography === 1 ? 'japan' : 'unknown', evidence,
    aliases: fields.aliases, broadcasters: fields.broadcaster, countries: fields.country,
    languages: fields.language, total: counts.length === 1 ? counts[0] : null,
    season: fields.season.length === 1 && /^\d{1,3}$/.test(normalize(fields.season[0])) ? Number(normalize(fields.season[0])) : null,
    streaming: fields.streaming, tags: meta, tvTemplate,
    ...(firstBroadcastDate ? { firstBroadcast: firstBroadcastDate } : {})
  };
}

module.exports = { classify };
