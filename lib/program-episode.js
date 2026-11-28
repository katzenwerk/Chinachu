'use strict';

const flagBracketsRE = /\[.{1,2}\]|【.】|\(.{1,2}\)/g;
const flagExtractRE = /(?:【|\[|\()(.{1,2})(?:】|\]|\))/;
const flagRE = /新|終|再|字|デ|解|無|二|S|SS|初|生|Ｎ|映|多|双/;
const flagUniRE = /🈟|🈡|🈞|🈑|🈓|🈖|🈚|🈔|🅂|🅍|🈠|🈢|🄽|🈙|🈕|🈒/g;

// episode parser
// 4桁まで対応: #1000 など
const jpEpisodeNumberRE = '[0-9０-９]{1,4}|[〇零一壱壹二弐貳三参參四五六七八九十拾百]{1,10}';
const jpEpisodeUnitRE = '[話回幕怪章番]';

const singleEpisodePatterns = [
	{
		kind: 'hash',
		re: /[#＃♯]\s*[0-9０-９]{1,4}(?:[.．][0-9０-９]+)?/i
	},
	{
		kind: 'dai-unit',
		re: new RegExp('第\\s*(?:' + jpEpisodeNumberRE + ')\\s*' + jpEpisodeUnitRE, 'i')
	},
	{
		kind: 'episode',
		re: /Episode\s*[.．]?\s*[0-9０-９]{1,4}/i
	},
	{
		kind: 'ep',
		re: /Ep\s*[.．]?\s*[0-9０-９]{1,4}/i
	},
	{
		kind: 'chapter',
		re: /Chapter\s*[.．]?\s*[0-9０-９]{1,4}/i
	},
	{
		kind: 'lesson',
		re: /Lesson\s*[.．]?\s*[0-9０-９]{1,4}/i
	},
	{
		kind: 'mission',
		re: /作戦\s*[0-9０-９]{1,4}/i
	}
];

function stripPrivateUseMarks(value) {
	return String(value || '').replace(/[\uE000-\uF8FF]/g, '').trim();
}

function toHalfWidthDigits(value) {
	return String(value || '').replace(/[０-９]/g, function (ch) {
		return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
	});
}

function parseKanjiEpisodeNumber(value) {
	const digitMap = {
		'〇': 0, '零': 0,
		'一': 1, '壱': 1, '壹': 1,
		'二': 2, '弐': 2, '貳': 2,
		'三': 3, '参': 3, '參': 3,
		'四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9
	};

	let total = 0;
	let current = 0;
	let seen = false;

	for (const ch of String(value || '')) {
		if (Object.prototype.hasOwnProperty.call(digitMap, ch)) {
			current = digitMap[ch];
			seen = true;
			continue;
		}

		if (ch === '十' || ch === '拾') {
			total += (current || 1) * 10;
			current = 0;
			seen = true;
			continue;
		}

		if (ch === '百') {
			total += (current || 1) * 100;
			current = 0;
			seen = true;
			continue;
		}

		return null;
	}

	return seen ? total + current : null;
}

function episodeNumberFromToken(token) {
	const ascii = toHalfWidthDigits(token).replace(/．/g, '.');
	const digitMatch = ascii.match(/[0-9]{1,4}(?:\.[0-9]+)?/);

	if (digitMatch) {
		return digitMatch[0].indexOf('.') !== -1
			? parseFloat(digitMatch[0])
			: parseInt(digitMatch[0], 10);
	}

	const kanjiMatch = String(token || '').match(/[〇零一壱壹二弐貳三参參四五六七八九十拾百]+/);
	if (kanjiMatch) {
		return parseKanjiEpisodeNumber(kanjiMatch[0]);
	}

	return null;
}

function normalizeEpisodeSpec(value) {
	return toHalfWidthDigits(value)
		.replace(/．/g, '.')
		.replace(/[#＃♯]/g, '')
		.replace(/[\s　]+/g, '')
		.replace(/[，、・&＆]/g, ',')
		.replace(/[－~〜～]/g, '-')
		.replace(/ova/ig, 'OVA');
}

function findMultiEpisodeMarker(text) {
	const source = String(text || '');
	let matched;

	// #3,4 / #25-#36 / #01-13,OVA / #62-65,65.5,66-70
	// 先頭の # 以降を「複数話指定式」としてまとめて保持する。
	const hashAtom = '(?:[0-9０-９]{1,4}(?:[.．][0-9０-９]+)?|OVA)';
	const hashMultiRE = new RegExp(
		'[#＃♯]\\s*(' + hashAtom + '(?:\\s*(?:[,，、・&＆]|[-－~〜～])\\s*(?:[#＃♯]\\s*)?' + hashAtom + ')+)',
		'i'
	);

	matched = source.match(hashMultiRE);
	if (matched && matched.index !== undefined) {
		return {
			kind: 'hash-multi-spec',
			index: matched.index,
			end: matched.index + matched[0].length,
			token: matched[0],
			episode: normalizeEpisodeSpec(matched[1]),
			isMulti: true
		};
	}

	// 第12～22話 / 第12-22話
	matched = source.match(
		/第\s*([0-9０-９]{1,4})\s*[-－~〜～]\s*([0-9０-９]{1,4})\s*話/
	);
	if (matched && matched.index !== undefined) {
		return {
			kind: 'dai-range',
			index: matched.index,
			end: matched.index + matched[0].length,
			token: matched[0],
			episode: normalizeEpisodeSpec(matched[1] + '-' + matched[2]),
			isMulti: true
		};
	}

	// 12～22話 / 12-22話
	matched = source.match(
		/(^|[\s　])([0-9０-９]{1,4})\s*[-－~〜～]\s*([0-9０-９]{1,4})\s*話/
	);
	if (matched && matched.index !== undefined) {
		const index = matched.index + matched[1].length;
		return {
			kind: 'bare-range-wa',
			index: index,
			end: matched.index + matched[0].length,
			token: source.slice(index, matched.index + matched[0].length),
			episode: normalizeEpisodeSpec(matched[2] + '-' + matched[3]),
			isMulti: true
		};
	}

	return null;
}

function findBareWaEpisodeMarker(text) {
	const source = String(text || '');
	const re = /([0-9０-９]{1,4})\s*話/g;
	let matched;

	while ((matched = re.exec(source)) !== null) {
		const before = source.slice(Math.max(0, matched.index - 10), matched.index);

		if (/全\s*$/.test(before)) {
			continue;
		}

		if (/[0-9０-９]\s*[-－~〜～]\s*$/.test(before)) {
			continue;
		}

		if (/第\s*[0-9０-９]{1,4}\s*[-－~〜～]\s*$/.test(before)) {
			continue;
		}

		return {
			kind: 'bare-wa',
			index: matched.index,
			end: matched.index + matched[0].length,
			token: matched[0],
			episode: episodeNumberFromToken(matched[0]),
			isMulti: false
		};
	}

	return null;
}

function findBareNumberEpisodeMarker(text) {
	const source = String(text || '');
	const re = /(^|[\s　])([0-9０-９]{1,4})(?=[\s　]+)([\s　]+)(.+)$/g;
	let matched;

	while ((matched = re.exec(source)) !== null) {
		const number = matched[2];
		const tail = String(matched[4] || '').trim();
		const numberIndex = matched.index + matched[1].length;
		const prefix = source.slice(0, numberIndex).trim();

		if (!prefix || !tail) {
			continue;
		}

		if (/[-－~〜～]\s*$/.test(prefix) || /^[\-－~〜～]/.test(tail)) {
			continue;
		}

		if (/^[%％]/.test(tail)) {
			continue;
		}

		// "...～2　13" のように作品名末尾が数字なら推測しない
		if (/[0-9０-９]$/.test(prefix)) {
			continue;
		}

		// Season 3 #12 の 3 など、シーズン/シリーズ番号は bare-number 扱いしない。
		if (/(?:\bseason|シーズン|シリーズ)\s*$/i.test(prefix) || /第\s*$/.test(prefix)) {
			continue;
		}

		return {
			kind: 'bare-number',
			index: numberIndex,
			end: numberIndex + number.length,
			token: number,
			episode: parseInt(toHalfWidthDigits(number), 10),
			isMulti: false
		};
	}

	return null;
}

function findColonEpisodeMarker(text) {
	const source = String(text || '');
	const re = /([0-9０-９]{1,4})\s*[:：](?=\s*\S)/g;
	let matched;

	while ((matched = re.exec(source)) !== null) {
		const prefix = source.slice(0, matched.index).trim();

		if (!prefix) {
			continue;
		}

		// Season 3: ... などのシーズン番号は episode とみなさない。
		if (/(?:\bseason|シーズン|シリーズ)\s*$/i.test(prefix) || /第\s*$/.test(prefix)) {
			continue;
		}

		return {
			kind: 'colon',
			index: matched.index,
			end: matched.index + matched[0].length,
			token: matched[0],
			episode: episodeNumberFromToken(matched[1]),
			isMulti: false
		};
	}

	return null;
}

function findParenthesizedEpisodeMarker(text) {
	const source = String(text || '');
	const matched = source.match(/[（(]\s*[0-9０-９]{1,4}\s*[）)]/i);

	if (!matched || matched.index === undefined) {
		return null;
	}

	return {
		kind: 'paren',
		index: matched.index,
		end: matched.index + matched[0].length,
		token: matched[0],
		episode: episodeNumberFromToken(matched[0]),
		isMulti: false
	};
}

function findSingleEpisodeMarker(text) {
	const source = String(text || '');
	let best = null;

	// #12 / 第12話 / Episode12 などの明示マーカーを最優先する。
	// 括弧数字 (12) / （12） はここには含めず、後段の fallback に回す。
	// これにより "ゲゲゲの鬼太郎（1971） #17" の （1971）を episode と誤認しない。
	for (const pattern of singleEpisodePatterns) {
		const matched = source.match(pattern.re);

		if (!matched || matched.index === undefined) {
			continue;
		}

		if (!best || matched.index < best.index) {
			best = {
				kind: pattern.kind,
				index: matched.index,
				end: matched.index + matched[0].length,
				token: matched[0],
				episode: episodeNumberFromToken(matched[0]),
				isMulti: false
			};
		}
	}

	// "12話" も明示的な話数表記として扱う。
	const bareWa = findBareWaEpisodeMarker(source);
	if (bareWa && (!best || bareWa.index < best.index)) {
		best = bareWa;
	}

	if (best) {
		return best;
	}

	// "44:CLOUDY BEACH" のような「話数:副題」形式。
	// bare-number より明示度が高いが、Season 3: ... は除外する。
	const colon = findColonEpisodeMarker(source);
	if (colon) {
		return colon;
	}

	// 括弧数字は NHK 等で使われる補助的な話数表記として fallback 扱い。
	// 他に明示的な話数が無い場合だけ採用する。
	const paren = findParenthesizedEpisodeMarker(source);
	if (paren) {
		return paren;
	}

	// bare-number は最後の fallback。
	// これにより "Season 3 #12" の 3 が #12 より優先されることを防ぐ。
	return findBareNumberEpisodeMarker(source);
}

function findEpisodeMarker(text) {
	const source = String(text || '');
	const multi = findMultiEpisodeMarker(source);
	const single = findSingleEpisodeMarker(source);

	// 複数話表記が先に現れるなら、単話より優先する
	if (multi && (!single || multi.index <= single.index)) {
		return multi;
	}

	return single;
}

function isBroadcastMetadata(value) {
	const text = stripPrivateUseMarks(value);

	if (text === '') {
		return true;
	}

	if (/^[◆◇]/.test(text)) {
		return true;
	}

	return false;
}

function subtitleFromTail(value) {
	let text = stripPrivateUseMarks(value)
		.replace(/^[\s　:：\-－―—・]+/, '')
		.trim();

	// episode 直後の短い括弧付き放送フラグは subtitle にしない。
	// 例: #94(二) / #94（二）
	const leadingFlag = text.match(/^[\[【(（]([^\]】)）]{1,2})[\]】)）]\s*/);
	if (leadingFlag && leadingFlag[1].split('').every(function (ch) { return flagRE.test(ch); })) {
		text = text.slice(leadingFlag[0].length).trim();
	}

	if (text === '' || isBroadcastMetadata(text)) {
		return '';
	}

	const quoted = text.match(/^[「『【]([^」』】]+)[」』】]/);
	if (quoted) {
		return quoted[1].trim();
	}

	if (text.length <= 60) {
		return text;
	}

	return '';
}

function episodeSpecContains(episode, candidate) {
	if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
		return false;
	}

	if (typeof episode === 'number') {
		return episode === candidate;
	}

	if (typeof episode !== 'string' || episode.trim() === '') {
		return false;
	}

	const spec = normalizeEpisodeSpec(episode);
	const parts = spec.split(',');

	for (const rawPart of parts) {
		const part = rawPart.trim();

		if (part === '' || /^OVA$/i.test(part)) {
			continue;
		}

		const range = part.match(/^([0-9]+(?:\.[0-9]+)?)-([0-9]+(?:\.[0-9]+)?)$/);
		if (range) {
			const start = parseFloat(range[1]);
			const end = parseFloat(range[2]);
			if (candidate >= Math.min(start, end) && candidate <= Math.max(start, end)) {
				return true;
			}
			continue;
		}

		const single = part.match(/^([0-9]+(?:\.[0-9]+)?)$/);
		if (single && parseFloat(single[1]) === candidate) {
			return true;
		}
	}

	return false;
}

function getDetailLeadLines(detail, limit) {
	return String(detail || '')
		.split(/\r?\n/)
		.map(function (line) { return stripPrivateUseMarks(line).trim(); })
		.filter(function (line) { return line !== ''; })
		.slice(0, limit || 5);
}

function episodeLeadLines(value) {
	const lines = getDetailLeadLines(value, 5);
	// Episode headings belong to the synopsis, before cast or promotional sections.
	const boundary = lines.findIndex(line => (/^[◆◇]/u.test(line) &&
		!/^[◆◇]\s*(?:[＜<【]\s*)?(?:番組内容|番組概要|あらすじ|ストーリー)\s*[＞>】]?$/u.test(line)) ||
		/^(?:[【［\[＜<]\s*)?(?:出演者?|主演|声の出演|キャスト|スタッフ|告知|お知らせ|番組予告|次回予告|次回放送|予告|関連番組)(?=$|[\s:：】］\]＞>])/u.test(line));
	return boundary === -1 ? lines : lines.slice(0, boundary);
}

function isExplicitLeadMarker(marker) {
	return marker?.index === 0 && !['bare-number', 'colon', 'paren'].includes(marker.kind);
}

function detailEpisodeMarkers(lines) {
	return lines.flatMap((line, index) => {
		const marker = findEpisodeMarker(line);
		if (!marker || marker.episode === null || /(?:次回|予告|告知|主演|出演)/u.test(line.slice(0, marker.index))) return [];
		if (index > 0 && !isExplicitLeadMarker(marker)) return [];
		if (marker.isMulti) return [marker];
		const tail = line.slice(marker.end).trim();
		const next = findEpisodeMarker(tail);
		if (isExplicitLeadMarker(next) && next.episode !== marker.episode) return [marker, next];
		const subtitle = subtitleFromTail(tail);
		// A line can name several separate episodes without declaring a range.
		return [{ ...marker, subtitle }, ...collectEpisodeSubtitles([line], null).filter(entry => entry.episode !== marker.episode)];
	});
}

function inferredDetailEpisode(markers) {
	const ranges = new Set(markers.filter(marker => marker.isMulti).map(marker => marker.episode));
	const numbers = new Set(markers.filter(marker => !marker.isMulti).map(marker => marker.episode));
	const [range] = ranges;
	if (ranges.size > 1 || (ranges.size ? [...numbers].some(number => !episodeSpecContains(range, number)) : numbers.size > 1)) {
		return { conflict: true, episode: null };
	}
	return { conflict: false, episode: range ?? [...numbers][0] ?? null };
}

function summarizeSubTitles(unique) {
	if (unique.length === 0) {
		return '';
	}

	if (unique.length === 1) {
		return unique[0];
	}

	if (unique.length === 2) {
		return unique[0] + '／' + unique[1];
	}

	return unique[0] + '／' + unique[1] + '／他';
}

function collectEpisodeSubtitles(lines, episode) {
	const found = [];

	function add(candidate, subtitle) {
		if (episode !== null && !episodeSpecContains(episode, candidate)) {
			return;
		}

		const text = stripPrivateUseMarks(subtitle).trim();
		if (text !== '') found.push({ episode: candidate, subtitle: text });
	}

	for (const line of lines) {
		let matched;
		let quotedFound = false;

		// #2「副題」 / #39「A」 #40「B」
		const hashQuotedRE = /[#＃♯]\s*([0-9０-９]{1,4}(?:[.．][0-9０-９]+)?)\s*[「『【]([^」』】]+)[」』】]/g;
		while ((matched = hashQuotedRE.exec(line)) !== null) {
			quotedFound = true;
			add(episodeNumberFromToken(matched[1]), matched[2]);
		}

		// 第2話「副題」 / 第2話【副題】
		const daiQuotedRE = /第\s*([0-9０-９]{1,4})\s*[話回幕怪章番]\s*[「『【]([^」』】]+)[」』】]/g;
		while ((matched = daiQuotedRE.exec(line)) !== null) {
			quotedFound = true;
			add(episodeNumberFromToken(matched[1]), matched[2]);
		}

		if (quotedFound) {
			continue;
		}

		// 複数話の説明が1行内に並ぶ形式。
		// 例: 『#1 偶然から生まれた大ヒット商品/#2 バービー vs G.I.ジョー』
		// episode が複数指定のときだけ使い、該当する話数の副題だけを拾う。
		if (episode === null || typeof episode === 'string' && /[,\-]/.test(episode)) {
			const inlineHashRE = /[#＃♯]\s*([0-9０-９]{1,4}(?:[.．][0-9０-９]+)?)\s+([^\r\n]+?)(?=\s*\/\s*[#＃♯]\s*[0-9０-９]|\s*[#＃♯]\s*[0-9０-９]|[」』】]|$)/g;
			let inlineMatched;
			const previous = found.length;
			while ((inlineMatched = inlineHashRE.exec(line)) !== null) {
				add(
					episodeNumberFromToken(inlineMatched[1]),
					inlineMatched[2].replace(/[\s　\/]+$/, '')
				);
			}

			if (found.length > previous) {
				continue;
			}
		}

		// #13 見上げて覗いて探して、次！
		matched = line.match(/^[#＃♯]\s*([0-9０-９]{1,4}(?:[.．][0-9０-９]+)?)\s+(.+)$/);
		if (matched) {
			add(episodeNumberFromToken(matched[1]), subtitleFromTail(matched[2]));
			continue;
		}

		// 第8話 泥の河は乾える ...
		matched = line.match(/^第\s*([0-9０-９]{1,4})\s*[話回幕怪章番]\s+(.+)$/);
		if (matched) {
			add(episodeNumberFromToken(matched[1]), subtitleFromTail(matched[2]));
		}
	}

	return found;
}

function angleBracketSubtitle(value) {
	const text = stripPrivateUseMarks(value);
	const matched = text.match(/^[<＜]([^>＞]{1,100})[>＞]/);

	if (!matched) {
		return '';
	}

	return matched[1].trim();
}

function quotedSubtitle(value) {
	const text = stripPrivateUseMarks(value);
	const matched = text.match(/.{3,}[「『【]([^」』】]+)[」』】].*/);

	if (!matched) {
		return '';
	}

	return matched[1].trim();
}

function stripMultiBroadcastSuffix(value) {
	let text = String(value || '').trim();

	// 複数話/範囲放送だと判定できたときだけ、
	// 作品名末尾の放送形態語を控えめに除去する。
	// 例: "SAKAMOTO DAYS 一挙放送" -> "SAKAMOTO DAYS"
	text = text.replace(
		/[ 　]*(?:一挙(?:放送)?|まとめて放送|全話放送|連続放送)(?:[ 　]*[（(][0-9０-９]+[）)])?[ 　]*$/,
		''
	).trim();

	return text;
}

function splitProgramTitleAndEpisode(rawTitle, detail, flags = new Set(), description, storedEpisode = null) {
	const titleSource = String(rawTitle || '')
		.replace(flagBracketsRE, '')
		.replace(flagUniRE, '')
		.trim();
	const leadSources = [episodeLeadLines(detail), episodeLeadLines(description)];
	const detailFirstLine = leadSources[0][0] || leadSources[1][0] || '';
	const titleMarker = findEpisodeMarker(titleSource);

	let title = titleSource;
	let subtitle = '';
	let weakTitleTailSubtitle = '';
	let episode = null;
	let hasMulti = false;

	// title を最優先
	if (titleMarker) {
		if (titleMarker.isMulti) {
			hasMulti = true;
			title = titleSource.slice(0, titleMarker.index).trim() || titleSource;
			title = stripMultiBroadcastSuffix(title);

			// 複数話放送は episode に表示用の指定式をそのまま保持する。
			// 例: "3,4", "25-36", "62-65,65.5,66-70"
			episode = titleMarker.episode;
		} else if (titleMarker.episode !== null) {
			title = titleSource.slice(0, titleMarker.index).trim() || titleSource;
			episode = titleMarker.episode;

			const titleTail = titleSource.slice(titleMarker.end);
			const normalizedTitleTail = stripPrivateUseMarks(titleTail)
				.replace(/^[\s　:：\-－―—・]+/, '')
				.trim();

			// 「44:CLOUDY BEACH」の colon 形式と、
			// 「#12「副題」」の明示引用は title 側の強い副題候補として採用する。
			if (titleMarker.kind === 'colon' || /^[「『【]/.test(normalizedTitleTail)) {
				subtitle = subtitleFromTail(titleTail);
			} else {
				// 「#152 ★日本初放送エピソード」のような単なる後続文字列は
				// detail に episode 一致の副題が無い場合だけ最後に使う。
				weakTitleTailSubtitle = subtitleFromTail(titleTail);
			}
		}
	}

	// A stored episode remains authoritative when filling an old ledger entry.
	const titleDisagrees = storedEpisode !== null && episode !== null &&
		normalizeEpisodeSpec(storedEpisode) !== normalizeEpisodeSpec(episode);
	if (storedEpisode !== null) {
		episode = storedEpisode;
		hasMulti = typeof episode === 'string' && /[,-]/.test(normalizeEpisodeSpec(episode));
		if (titleDisagrees) subtitle = weakTitleTailSubtitle = '';
	}
	const markers = !subtitle ? leadSources.flatMap(detailEpisodeMarkers) : [];
	const inferred = episode === null ? inferredDetailEpisode(markers) : null;
	if (inferred && !inferred.conflict && inferred.episode !== null) {
		episode = inferred.episode;
		hasMulti = typeof episode === 'string';
	}
	let subtitleConflict = false;

	// detail 冒頭の数行から、episode と一致する明示話数行を副題候補にする。
	// 単話: #13 見上げて覗いて探して、次！ / #2「僕は大人のなりかけ」
	// 複数: #39「A」 #40「B」 -> A／B、3件以上 -> A／B／他
	if (subtitle === '' && episode !== null) {
		const candidates = leadSources.flatMap(lines => collectEpisodeSubtitles(lines, episode))
			.concat(markers.filter(marker => episodeSpecContains(episode, marker.episode)));
		const unique = new Map();
		for (const { subtitle: value } of candidates) {
			if (value && !unique.has(value.normalize('NFKC'))) unique.set(value.normalize('NFKC'), value);
		}
		subtitleConflict = !hasMulti && unique.size > 1;
		if (!subtitleConflict) subtitle = summarizeSubTitles([...unique.values()]);
	}
	const allowSubtitleFallback = !hasMulti && !subtitleConflict && !inferred?.conflict;
	const firstMarker = findEpisodeMarker(detailFirstLine);
	const detailDisagrees = episode !== null && firstMarker && !episodeSpecContains(episode, firstMarker.episode);

	// detail 先頭の ＜...＞ / <...> は副題・見出し表記として補助的に使う。
	if (allowSubtitleFallback && !detailDisagrees && subtitle === '') {
		subtitle = angleBracketSubtitle(detailFirstLine);
	}

	// 単話の場合だけ副題の引用部を補助的に使う
	if (allowSubtitleFallback && !detailDisagrees && subtitle === '') {
		subtitle = quotedSubtitle(detailFirstLine);
	}

	if (allowSubtitleFallback && !titleDisagrees && subtitle === '') {
		subtitle = quotedSubtitle(titleSource);
	}

	// title の episode 後ろに残った単なる文字列は最弱の fallback。
	// detail 側の episode 一致副題や ＜...＞、引用副題を必ず優先する。
	if (allowSubtitleFallback && subtitle === '' && weakTitleTailSubtitle !== '') {
		subtitle = weakTitleTailSubtitle;
	}

	// [新] は明示話数も複数話表記もない場合だけ最後の fallback として 1。
	// [初] は各話の初回放送にも付くため episode 推測には使わない。
	if (episode === null && !inferred?.conflict && flags.has('新') === true) {
		episode = 1;
	}

	return {
		title: title,
		subTitle: stripPrivateUseMarks(subtitle),
		episode: episode
	};
}

module.exports = { flagBracketsRE, flagExtractRE, flagRE, flagUniRE, splitProgramTitleAndEpisode };
