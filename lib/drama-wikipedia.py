"""Japanese Wikipedia acquisition and table parsing reused from the drama PoC."""
import collections
import datetime as dt
import email.utils
import gzip
import hashlib
import json
import math
import re
import sqlite3
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import zlib
from html.parser import HTMLParser
from pathlib import Path

SITE = "https://ja.wikipedia.org"
ACTION = SITE + "/w/api.php"
REST = SITE + "/w/rest.php/v1"
AGENT = "ChinachuDramaDictionary/1.0 (https://github.com/katzenwerk/Chinachu)"
JST = dt.timezone(dt.timedelta(hours=9))
DRAMA = re.compile(r"テレビドラマ|連続ドラマ|放送日程|放送リスト")


def read_json(path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        if default is not None:
            return default
        raise


def save_json(path, value):
    atomic_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def atomic_text(path, text):
    temp = path.with_suffix(path.suffix + ".part")
    temp.write_text(text, encoding="utf-8")
    temp.replace(path)


def norm(text):
    return unicodedata.normalize("NFKC", text or "").strip()


def key(text):
    return "".join(c for c in norm(text).casefold() if c.isalnum())


def short_title(text):
    return re.sub(r"\s*\([^)]*(?:テレビドラマ|漫画|小説|映画|曖昧さ回避|アルバム|テレビ番組)[^)]*\)$", "", norm(text))


class ApiFailure(RuntimeError):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class StopFetch(RuntimeError):
    pass


def retry_seconds(header, minimum):
    try:
        delay = float(header)
    except (ValueError, TypeError):
        try:
            date = email.utils.parsedate_to_datetime(header)
            delay = (date if date.tzinfo else date.replace(tzinfo=dt.timezone.utc)).timestamp() - time.time()
        except (ValueError, TypeError, OverflowError, OSError):
            delay = 5
    return max(minimum, delay) if math.isfinite(delay) else max(minimum, 5)


class Client:
    def __init__(self, cache, seed, retained, request_after=0):
        self.cache = cache
        self.seed = seed
        self.retained = retained
        self.next_request = time.monotonic() + max(1.05, request_after / 1000 - time.time())
        self.retry_after = None
        self.stats = collections.Counter()
        self.failures = 0

    def request_deadline(self, now):
        remaining = self.next_request - now
        return math.ceil((time.time() + remaining) * 1000) if remaining > 0 else 0

    def get(self, url):
        action = url.startswith(ACTION)
        for attempt in range(2):
            time.sleep(max(0, self.next_request - time.monotonic()))
            start = time.monotonic()
            self.next_request = start + 1.05
            self.stats["requests"] += 1
            self.stats["action" if action else "rest"] += 1
            retry = 0
            server_limited = False
            try:
                request = urllib.request.Request(url, headers={
                    "User-Agent": AGENT, "Accept": "application/json", "Accept-Encoding": "gzip"})
                with urllib.request.urlopen(request, timeout=25) as reply:
                    payload = reply.read()
                    headers = reply.headers
                self.stats["download_bytes"] += len(payload)
                if headers.get("Content-Encoding", "").strip().lower() == "gzip":
                    payload = gzip.decompress(payload)
                record = json.loads(payload)
                if "error" not in record:
                    self.failures = 0
                    self.retry_after = None
                    return record
                status = record["error"].get("code")
                message = str(record["error"])
                if action and status == "maxlag":
                    server_limited = True
                    retry = retry_seconds(headers.get("Retry-After"), 5)
                elif status == "ratelimited":
                    retry = 5
            except urllib.error.HTTPError as error:
                status = error.code
                self.stats[f"http_{status}"] += 1
                delay = error.headers.get("Retry-After")
                if status in (429, 503) or (status in (502, 504) and delay):
                    server_limited = True
                    retry = retry_seconds(delay, 1.05)
                message = str(error)
            except (OSError, EOFError, ValueError, zlib.error) as error:
                status = "transport"
                message = str(error)
                retry = 5
            finally:
                finished = time.monotonic()
                elapsed = finished - start
                self.stats["request_seconds"] += elapsed
                if action and elapsed > 1:
                    self.next_request = max(self.next_request, finished + 5)
            if status not in (404, 410):
                self.failures += 1
            if server_limited:
                self.next_request = max(self.next_request, finished + retry)
                self.retry_after = self.request_deadline(finished)
                if attempt or retry > 60 or self.failures >= 3:
                    raise StopFetch(f"{message}; retry deadline {self.retry_after}")
            if self.failures >= 3:
                raise StopFetch("three consecutive request failures")
            if retry and attempt == 0:
                self.next_request = max(self.next_request, finished + retry)
                continue
            raise ApiFailure(status, message)
        raise AssertionError("request loop exhausted")

    def action(self, **params):
        return self.get(ACTION + "?" + urllib.parse.urlencode(
            dict(action="query", format="json", formatversion=2, maxlag=5, **params)))

    def revisions(self, titles):
        pages = {}
        for batch_start in range(0, len(titles), 25):
            batch = titles[batch_start:batch_start + 25]
            result = self.action(titles="|".join(batch), prop="revisions|pageprops",
                                 rvprop="ids|timestamp", redirects=1)["query"]
            redirects = {x["from"]: x["to"] for field in ("normalized", "redirects", "converted")
                         for x in result.get(field, [])}
            by_title = {p["title"]: p for p in result["pages"]}
            for title in batch:
                resolved = title
                seen = set()
                while resolved in redirects and resolved not in seen:
                    seen.add(resolved)
                    resolved = redirects[resolved]
                pages[title] = by_title.get(resolved, {"title": resolved, "missing": True})
        return pages

    def page_ids(self, ids):
        result = {}
        for start in range(0, len(ids), 40):
            chunk = ids[start:start + 40]
            pages = self.action(pageids="|".join(map(str, chunk)), prop="revisions|pageprops",
                                rvprop="ids|timestamp")["query"]["pages"]
            result.update({page["pageid"]: page for page in pages if "pageid" in page and "missing" not in page})
        return result

    def html(self, page):
        ident = page["pageid"]
        revision = page["revisions"][0]["revid"]

        def html_revision(value):
            if not isinstance(value, dict) or value.get("id") != ident or type(value.get("id")) is not int:
                return None
            latest = value.get("latest")
            if not isinstance(latest, dict) or not isinstance(value.get("html"), str) or not value.get("title"):
                return None
            received = latest.get("id")
            return received if type(received) is int and received > 0 else None

        filename = self.cache / f"page-{ident}-{revision}.json"
        retained = self.retained / f"page-{ident}.json" if self.retained else None
        seed = self.seed / filename.name if self.seed else None
        for cached in (retained, seed, filename):
            if cached and cached.is_file():
                value = read_json(cached)
                if html_revision(value) == revision:
                    self.stats["revision_hits"] += 1
                    return filename.name, value
        title = urllib.parse.quote(page["title"].replace(" ", "_"), safe="")
        value = self.get(REST + "/page/" + title + "/with_html")
        received = html_revision(value)
        if received is None or received < revision:
            raise ApiFailure("revision", f"Wikipedia HTML identity could not be verified (page {ident}, revision {revision})")
        if received != revision:
            self.stats["revision_races"] += 1
            filename = self.cache / f"page-{ident}-{received}.json"
        save_json(filename, value)
        return filename.name, value

    def retain(self, page):
        if self.retained:
            self.retained.mkdir(parents=True, exist_ok=True, mode=0o700)
            save_json(self.retained / f'page-{page["id"]}.json', page)


class Links(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.links = []
        self.current = None
        self.feed(source)

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            href = dict(attrs).get("href") or ""
            if href.startswith(("./", "/wiki/")):
                parts = urllib.parse.urlsplit(href)
                title = urllib.parse.unquote(parts.path.split("/", 2)[-1] if href.startswith("/wiki/")
                                              else parts.path[2:]).replace("_", " ")
                if title and ":" not in title:
                    self.current = (title, [], urllib.parse.unquote(parts.fragment))

    def handle_endtag(self, tag):
        if tag == "a" and self.current:
            title, text, fragment = self.current
            self.links.append((title, "".join(text).strip(), fragment))
            self.current = None

    def handle_data(self, data):
        if self.current:
            self.current[1].append(data)


class Element:
    __slots__ = ("tag", "attrs", "children")

    def __init__(self, tag, attrs=()):
        self.tag = tag
        self.attrs = dict(attrs)
        self.children = []


class Document(HTMLParser):
    void = set("area base br col embed hr img input link meta param source track wbr".split())

    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.root = Element("document")
        self.stack = [self.root]
        self.feed(source)
        self.close()

    def handle_starttag(self, tag, attrs):
        item = Element(tag, attrs)
        self.stack[-1].children.append(item)
        if tag not in self.void:
            self.stack.append(item)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1].children.append(Element(tag, attrs))

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        if data:
            self.stack[-1].children.append(data)


def child_elements(node):
    return (child for child in node.children if isinstance(child, Element))


def descendants(node, wanted, stop=()):
    for child in child_elements(node):
        if child.tag in wanted:
            yield child
        if child.tag not in stop:
            yield from descendants(child, wanted, stop)


def cell_text(node, multiline=False):
    output = []

    def visit(item):
        if isinstance(item, str):
            output.append(item)
            return
        marker = " ".join(item.attrs.get(field, "") or "" for field in ("class", "typeof", "role"))
        if item.tag in ("rt", "rp", "style", "script", "math", "table") or re.search(
                r"mw-ref\b|mw:Extension/ref|reference\b|mw-editsection|sortkey|noprint", marker):
            return
        if item.tag == "br":
            output.append("\n")
            return
        for child in item.children:
            visit(child)
        if item.tag in ("li", "p", "div"):
            output.append("\n")

    for entry in node.children:
        visit(entry)
    text = "".join(output).replace("\xa0", " ")
    parts = [" ".join(line.split()) for line in text.splitlines() if line.strip()]
    return ("\n" if multiline else " ").join(parts).strip()


def table_context(root):
    headings = []
    content = []
    for item in descendants(root, {"h1","h2","h3","h4","h5","h6","table","li","p"}, {"table","p","head","style","script"}):
        if re.fullmatch(r"h[1-6]", item.tag):
            level = int(item.tag[1])
            while headings and headings[-1][0] >= level:
                headings.pop()
            headings.append((level, cell_text(item), item.attrs.get("id")))
        else:
            content.append((item, tuple(headings)))
    return content


def section_names(headings):
    return [title for _, title, _ in headings if title]


def span_number(cell, attribute):
    raw = cell.attrs.get(attribute, "1")
    return min(int(raw), 200) if raw and raw.isdecimal() and int(raw) > 0 else 1


def table_rows(table):
    rows = []
    pending = {}
    for row in descendants(table, {"tr"}, {"table"}):
        cells = [cell for cell in child_elements(row) if cell.tag in ("td", "th")]
        if not cells:
            continue
        grid = {index: cell for index, (left, cell) in pending.items() if left > 0}
        pending = {index: (left - 1, cell) for index, (left, cell) in pending.items() if left > 1}
        index = 0
        for cell in cells:
            while index in grid:
                index += 1
            row_span = span_number(cell, "rowspan")
            col_span = span_number(cell, "colspan")
            value = (cell_text(cell, multiline=True), cell.tag, cell.attrs.get("scope"), id(cell))
            for offset in range(col_span):
                slot = index + offset
                if slot not in grid:
                    grid[slot] = value
                    if row_span > 1:
                        pending[slot] = (row_span - 1, value)
            index += col_span
        rows.append(([grid.get(i) for i in range(max(grid) + 1)], cells))
    return rows


DATE_RE = re.compile(r"(?:(?P<year>19\d{2}|20\d{2})\s*(?:年|[-/.])\s*)?"
                     r"(?P<month>\d{1,2})\s*(?:月|[-/.])\s*(?P<day>\d{1,2})(?:\s*日)?")
YEAR = re.compile(r"(?<!\d)(19\d{2}|20\d{2})年")
SECTION_EPISODES = re.compile(r"放送日程|放送リスト|放送回|放映リスト|各話|エピソード|放送記録|放送作品")
WEEK = re.compile(r"(?:第\s*)?(\d{1,3})\s*週")
RANGE = re.compile(r"\d+\s*(?:[-〜～~]|から)\s*(?:第\s*)?\d+(?:\s*話)?")
SECONDARY = re.compile(r"再放送|総集編|ダイジェスト|番宣|スピンオフ|関連番組|特別番組|劇場版|配信ドラマ")
SEASON_LABEL = re.compile(r"(?:seasons?\s*|シーズン\s*|シリーズ\s*|(?<![A-Za-z])s\s*)(\d{1,2})(?!\d)"
                          r"|第\s*([\d一二三四五六七八九十]+)\s*(?:シリーズ|シーズン|期|部)"
                          r"|(\d{1,2})(?:st|nd|rd|th)\s+season", re.I)
PART_LABEL = re.compile(r"秋冬|前期|後期|夏編|冬編|春編|秋編|ファイナル")
PROSE_LIMIT = 220


def numbered(raw):
    if raw.isdecimal():
        return int(raw)
    values = dict(zip("〇一二三四五六七八九", range(10)))
    if "十" in raw:
        left, right = raw.split("十", 1)
        return (values.get(left, 1) * 10) + values.get(right, 0)
    return values.get(raw)


def explicit_season(text):
    match = SEASON_LABEL.search(norm(text))
    return numbered(next(value for value in match.groups() if value)) if match else None


def year_in(text):
    match = YEAR.search(norm(text))
    return int(match[1]) if match else None


def header_type(value):
    text = norm(value)
    if not text:
        return None
    segments = text.splitlines()
    if len(segments) == 2 and re.search(r"サブタイトル|副題", segments[0]):
        if re.search(r"ラテ欄|EPG", segments[1], re.I):
            return "combined_subtitles"
        if re.search(r"TVer|配信|Hulu|FOD|U-NEXT", segments[1], re.I):
            return "combined_streaming_subtitles"
    if re.search(r"ラテ欄|新聞|番組表|EPG", text, re.I) and not re.search(r"放送日", text):
        return "epg_subtitle"
    if re.search(r"TVer|配信|U-NEXT|FOD|Hulu|Netflix|Lemino|Prime Video", text, re.I) and re.search(r"タイトル|副題|題名|TVer|U-NEXT|FOD|Hulu|Netflix|Lemino|Prime Video|^配信$", text, re.I) and not re.search(r"日|期間", text):
        return "streaming_subtitle"
    if re.search(r"放送日|放映日|初回放送|放送期間|放送日時|放送月日", text) and not re.search(
            r"再放送|遅れ|地域|放送局|チャンネル|曜日|放送時間|配信", text):
        return "airdate"
    if re.search(r"サブタイトル|副題|題名|タイトル", text) and not re.search(r"シーズン|シリーズ|作品名|主題歌|原作", text):
        return "formal_subtitle" if re.search(r"正式|公式(?:サブタイトル|副題)", text) else "listed_subtitle"
    if re.fullmatch(r"(?:[＃#]|(?:放送|放映|各)?回|(?:第?話|各話|話数|回数|回次|エピソード|エピソード番号|話No\.?))", text, re.I):
        return "episode"
    if re.fullmatch(r"(?:シリーズ|シーズン|season)", text, re.I):
        return "season_column"
    if re.fullmatch(r"(?:放送週|週|週数|放送週[・/]話数)", text):
        return "week"
    return None


def row_header(rows):
    if not rows:
        return 0, {}
    header_count = 0
    for grid, cells in rows[:5]:
        values = [value[0] for value in grid if value]
        recognized = any(header_type(v) for v in values)
        if header_count and values and episode_label(values[0]) and any(cell.tag == "td" for cell in cells):
            break
        if not recognized and (not all(cell.tag == "th" for cell in cells)
                               or any(episode_label(value, True) for value in values)):
            break
        if any(cell.attrs.get("scope") == "row" for cell in cells) and not recognized:
            break
        if not recognized and header_count and len(cells) < 2:
            break
        header_count += 1
    if not header_count:
        return 0, {}
    width = max(len(grid) for grid, _ in rows[:header_count])
    fields = {}
    for index in range(width):
        levels = list(dict.fromkeys(grid[index][0] for grid, _ in rows[:header_count] if len(grid) > index and grid[index]))
        for label in reversed(levels):
            column = header_type(label)
            if column:
                slot = column
                if column == "streaming_subtitle" and column in fields:
                    slot = column + "." + str(index)
                current = fields.get(slot)
                if slot == "episode" and current and "エピソード" in current[1] and re.search(r"話数|各話|放送回", label):
                    fields[slot] = (index, " / ".join(levels))
                else:
                    fields.setdefault(slot, (index, " / ".join(levels)))
                break
        else:
            column = header_type(" ".join(levels))
            if column:
                fields.setdefault(column, (index, " / ".join(levels)))
    return header_count, fields


def episode_label(raw, allow_bare=True):
    text = norm(raw)
    if not text or re.search(r"休止|延期|放送なし", text):
        return None
    if RANGE.search(text):
        return {"number": None, "label": text, "kind": "range"}
    if allow_bare and re.fullmatch(r"\d{1,4}", text):
        value = int(text)
        return {"number": value, "label": text, "kind": "normal"} if value else None
    match = re.search(r"(?:第\s*)?([\d〇一二三四五六七八九十]{1,4})\s*(?:[話回夜幕章号]|限目)|(?:#|ep(?:isode)?\s*\.?\s*)\s*(\d{1,4})", text, re.I)
    ordinal = re.fullmatch(r"[A-Za-z][A-Za-z ._:-]{0,33}\s*(\d{1,3})", text)
    special = bool(re.search(r"特別|SP\b|スペシャル|総集編|プロローグ", text, re.I))
    if match or ordinal or re.search(r"最終[話回]|前編|後編|中編|(?:final|last)\s+episode|episode\s*final|最後の", text, re.I) or special:
        value = numbered(match[1] or match[2]) if match else int(ordinal[1]) if ordinal else None
        return {"number": value, "label": text, "kind": "special" if special else "normal"}
    return None


def calendar_date(raw, anchor, previous, start_month=None):
    if not raw:
        return None, None, previous
    text = norm(raw)
    match = DATE_RE.search(text)
    if not match:
        return None, "unparsed", previous
    month, day = int(match["month"]), int(match["day"])
    if match["year"]:
        year, method = int(match["year"]), "explicit"
    elif previous:
        year, method = previous.year, "previous-row"
        if previous.month >= 10 and month <= 3:
            year += 1
            method = "year-rollover"
    elif anchor:
        year, method = anchor, "season-context"
        if start_month and start_month >= 10 and month <= 3:
            year += 1
            method = "season-rollover"
    else:
        return None, "year-unresolved", previous
    try:
        actual = dt.date(year, month, day)
    except ValueError:
        return None, "invalid", previous
    return actual.isoformat(), method, actual


def table_caption(table):
    caption = next((x for x in child_elements(table) if x.tag == "caption"), None)
    return cell_text(caption) if caption else ""


def parse_schedule(table, headings, anchor, start_month=None, extra_context="", expected_season=None):
    title = " > ".join(section_names(headings) + [table_caption(table), extra_context]).strip(" >")
    grid = table_rows(table)
    count, fields = row_header(grid)
    looks_episodic = bool(SECTION_EPISODES.search(title)) or "episode" in fields
    if not looks_episodic:
        return None
    has_titles = any(name.endswith(("subtitle", "subtitles")) for name in fields)
    spans = collections.Counter(attr for _, cells in grid for cell in cells for attr in ("rowspan","colspan")
                                if span_number(cell, attr) > 1)
    profile = {"context": title, "headers": {field: label for field, (_, label) in fields.items()},
               "header_rows": count, "span_cells": dict(spans), "content_rows": max(0, len(grid)-count),
               "anchor": next((ident for _, _, ident in reversed(headings) if ident), None)}
    if "episode" not in fields or not (has_titles or "airdate" in fields):
        if "week" not in fields or "airdate" not in fields:
            profile["reason"] = "missing-semantic-columns"
            return profile, []
    dates = None
    section_year = anchor
    results = []
    for row, _ in grid[count:]:
        def value(field):
            entry = fields.get(field)
            if entry is None or entry[0] >= len(row) or not row[entry[0]]:
                return None
            return row[entry[0]][0] or None

        raw_label = value("episode") or value("week")
        raw_date = value("airdate")
        if raw_label and raw_label == raw_date:
            if re.fullmatch(r"(?:19|20)\d{2}年", norm(raw_label)):
                section_year, dates = year_in(raw_label), None
            continue
        season_label = norm(value("season_column"))
        row_season = explicit_season(season_label) or (int(season_label) if season_label.isdecimal() else None)
        if expected_season and row_season is not None and row_season != expected_season:
            continue
        episode = episode_label(raw_label)
        if not episode:
            if raw_label and not re.search(r"休止|延期|放送なし", norm(raw_label)):
                profile["unparsed_episode_rows"] = True
            continue
        if not value("episode") and value("week") and episode["kind"] != "range":
            episode = {**episode, "kind": "range", "number": None}
        if raw_date and (match := DATE_RE.search(norm(raw_date))) and match["year"]:
            profile.setdefault("first_explicit_year", int(match["year"]))
        date, method, dates = calendar_date(raw_date, section_year, dates, start_month)
        period = None
        if episode["kind"] == "range":
            other_dates = list(DATE_RE.finditer(norm(raw_date)))
            end = calendar_date(other_dates[-1].group(), section_year, dates, start_month)[0] if len(other_dates) > 1 else None
            period = [date, end]
            date, method = None, None
        if SPECIAL_SECTION.search(title) and episode["kind"] == "normal":
            episode["kind"] = "special"
        subtitles = {field: subtitle_clean(value(field)) for field in
                     ("formal_subtitle","listed_subtitle","epg_subtitle","streaming_subtitle")}
        streams = {fields[field][1]: candidate for field in fields if field.startswith("streaming_subtitle")
                   and (candidate := subtitle_clean(value(field)))}
        for field, secondary in (("combined_subtitles", "epg_subtitle"),
                                 ("combined_streaming_subtitles", "streaming_subtitle")):
            combined = (value(field) or "").splitlines()
            if len(combined) == 2:
                subtitles["listed_subtitle"] = subtitles["listed_subtitle"] or subtitle_clean(combined[0])
                subtitles[secondary] = subtitles[secondary] or subtitle_clean(combined[1])
                if secondary == "streaming_subtitle" and subtitles[secondary]:
                    streams.setdefault(fields[field][1].splitlines()[-1], subtitles[secondary])
            elif combined:
                profile["combined_subtitle_unparsed"] = profile.get("combined_subtitle_unparsed", 0) + 1
        results.append({**episode, "streaming_titles": streams, "airdate": date, "airdate_raw": raw_date, "airdate_basis": method,
                        "broadcast_range": period, "week_label": value("week"),
                        "row_season": row_season, **subtitles})
    return profile, results


SPECIAL_SECTION = re.compile(r"特別編|特別番組|スペシャル版|総集編")


def subtitle_clean(raw):
    if not raw:
        return None
    title_lines = []
    for line in raw.splitlines():
        if line.strip().startswith(("→", "⇒")):
            break
        title_lines.append(line)
    text = "\n".join(title_lines).strip()
    return text if text and len(text) <= PROSE_LIMIT else None


DOMESTIC_VERSION = re.compile(r"テレビドラマ|実写(?:版|ドラマ|化)|日本(?:版|のドラマ|ドラマ版)")
OTHER_VERSION = re.compile(r"アニメ(?:ーション|版|化|シリーズ)?|(?:韓国|中国|台湾|米国|アメリカ|英国|海外|タイ|フランス)(?:版|ドラマ)|映画版|劇場版")


def domestic_branch(headings, caption):
    sections = [norm(name) for name in section_names(headings)]
    for index, name in enumerate(sections):
        if DOMESTIC_VERSION.search(name):
            return tuple(sections[:index + 1])
    if DOMESTIC_VERSION.search(norm(caption)):
        return (*sections, norm(caption))
    return None


def has_domestic_branch(entries):
    return any(domestic_branch(headings, table_caption(table)) for table, headings in entries if table.tag == "table")


def edition_year(text):
    return year_in(text) if re.search(r"版|テレビドラマ|シリーズ", text) else None


def scope_for(target, headings, caption):
    texts = section_names(headings) + [caption]
    section = " > ".join(texts)
    if OTHER_VERSION.search(section):
        return False, None, None
    if texts and re.search(r"^(?:キャスト|登場人物|出演者|主題歌|スタッフ|受賞|評価|関連商品|映像ソフト|放送局一覧)$", texts[-1]):
        return False, None, None
    expected_part = PART_LABEL.search(norm(target["name"]))
    page_part = PART_LABEL.search(norm(section))
    if page_part and (not expected_part or page_part[0].removesuffix("編") != expected_part[0].removesuffix("編")):
        return False, None, None
    seasons = [value for text in texts if (value := explicit_season(text)) is not None]
    years = [value for text in texts if (value := year_in(text)) is not None]
    season = seasons[-1] if seasons else None
    year = years[-1] if years else None
    if target["season"] is not None:
        if season is not None and target["season"] != season:
            return False, season, year
        if year is not None and year != target["year"]:
            return False, season, year
    elif year is not None and year != target["year"] and re.search(r"版|テレビドラマ|シリーズ", section):
        return False, season, year
    return True, season, year


PERIOD_LABEL = re.compile(r"放送期間|放送日|初回放送日")
COUNTRY_LABEL = re.compile(r"(?:制作|製作)?国(?:・地域)?|(?:制作|製作)地域")
CHANNEL_LABEL = re.compile(r"放送局|放送チャンネル|放送ネットワーク")
STREAMING = re.compile(r"配信|オンデマンド|Netflix|TVer|FOD|Hulu|Lemino|U-NEXT|Disney\+|Prime Video|ABEMA", re.I)
STREAM_ONLY = re.compile(r"独占配信|配信限定|配信のみ|ウェブドラマ|Webドラマ|ネットドラマ", re.I)
TV_NETWORK = re.compile(r"テレビ|WOWOWプライム|NHK|BS[1-9T]|TBS|MBS|ABC|CBC|TOKYO MX", re.I)
EMPTY_COUNTRY = re.compile(r"^(?:不明|未公表|未定|不詳|なし|[-―—?]+)$")
COLLECTIVE_COUNT = re.compile(r"放送回数|話数|全話数|話数・回数")


def box_sections(table, headings):
    """Keep separately headed blocks in a single infobox separate."""
    if not re.search(r"infobox|基礎情報", table.attrs.get("class", "")):
        return []
    blocks = []
    label, medium, fields = "", None, {}
    for row, _ in table_rows(table):
        if len(row) < 2 or not row[0] or not row[1]:
            continue
        name, value = norm(row[0][0]), norm(row[1][0])
        if row[0][3] == row[1][3]:
            if row[0][1] != "th" or not name:
                continue
            if fields:
                blocks.append((label, medium, fields))
                fields = {}
            label = name
            section = name.splitlines()[0]
            if section in ("放送", "テレビ放送"):
                medium = "television"
            elif section in ("配信", "ネット配信", "動画配信"):
                medium = "streaming"
            elif name in ("製作", "制作") or OTHER_VERSION.search(name):
                medium = None
            continue
        if name and value:
            fields[name] = value
    if fields:
        blocks.append((label, medium, fields))

    caption = table_caption(table)
    context = section_names(headings) + [caption]
    records = []
    for label, medium, fields in blocks:
        if OTHER_VERSION.search(" > ".join(context + [label])) or re.search(r"再放送|刊行|小説|漫画", label):
            continue
        period = next((v for k, v in fields.items() if PERIOD_LABEL.fullmatch(k)), "")
        if not period:
            period = next((v for k, v in fields.items() if k in ("配信期間", "配信日", "配信開始日")), "")
            if period:
                medium = "streaming"
        # An explicit terrestrial/satellite block may follow a streaming block in the same box.
        if re.search(r"地上波|BS放送|衛星放送|テレビ放送", label) or medium == "streaming" and (
                fields.get("放送枠") or any(k in ("放送局", "放送チャンネル") and TV_NETWORK.search(v)
                                         and not STREAMING.search(v) for k, v in fields.items())):
            medium = "television"
        season = next((s for text in reversed(context + [label]) if (s := explicit_season(text)) is not None), None)
        records.append(dict(label=label, medium=medium, fields=fields, period=period, season=season,
                            branch=domestic_branch(headings, caption), headings=headings))
    return records


def box_metadata(records, anchor):
    result = {"article_work_name": None, "aliases": [], "broadcast_channels": [], "production_countries": [],
              "broadcast_format": None, "broadcast_status": None, "first_air_year": None, "first_air_date": None,
              "last_air_date": None, "declared_episode_count": None}
    for record in records:
        for label, value in record["fields"].items():
            if re.fullmatch(r"番組名|作品名|タイトル", label) and not result["article_work_name"]:
                result["article_work_name"] = value
            if re.fullmatch(r"別名|別題|通称|英題", label):
                result["aliases"].extend(v for v in value.splitlines() if v not in result["aliases"])
            if CHANNEL_LABEL.fullmatch(label) and not result["broadcast_channels"] and record["medium"] != "streaming":
                result["broadcast_channels"] = list(dict.fromkeys(
                    re.sub(r"^放送[:：]\s*", "", v) for v in value.splitlines()
                    if not STREAMING.search(v) or TV_NETWORK.search(v)))
            if COUNTRY_LABEL.fullmatch(label):
                result["production_countries"].extend(v for v in value.splitlines()
                                                      if v not in result["production_countries"] and not EMPTY_COUNTRY.fullmatch(v))
            if COLLECTIVE_COUNT.fullmatch(label) and result["declared_episode_count"] is None:
                match = re.fullmatch(r"(?:全)?\s*(\d{1,4})\s*(?:話|回)?", norm(value))
                if match:
                    result["declared_episode_count"] = int(match[1])
        period = record["period"]
        if record["medium"] != "streaming":
            if re.search(r"放送中|放映中", period):
                result["broadcast_status"] = "ongoing"
            elif re.search(r"放送予定|放映予定", period) and not DATE_RE.search(period):
                result["broadcast_status"] = "upcoming"
        if not period or record["medium"] == "streaming" or result["first_air_date"]:
            continue
        found = list(DATE_RE.finditer(period))
        if found:
            first, _, previous = calendar_date(found[0].group(), anchor, None)
            result["first_air_date"] = first
            result["first_air_year"] = int(first[:4]) if first else year_in(period)
            if first and len(found) >= 2 and re.search(r"[-〜～~－–—−]|から", period[found[0].end():found[1].start()]):
                result["last_air_date"] = calendar_date(found[1].group(), anchor, previous)[0]
    return result


def broadcast_evidence(records):
    television = streaming = False
    for record in records:
        fields = record["fields"]
        channel = "\n".join(v for k, v in fields.items() if CHANNEL_LABEL.fullmatch(k))
        genre = fields.get("ジャンル", "")
        stream_channel = any(STREAMING.search(v) and not TV_NETWORK.search(v) for v in channel.splitlines())
        stream_only = record["medium"] == "streaming" or STREAM_ONLY.search(channel + " " + genre)
        streaming |= bool(stream_only)
        if record["medium"] != "streaming":
            television |= bool(any(not STREAMING.search(v) or TV_NETWORK.search(v) for v in channel.splitlines())
                               or not (stream_only or stream_channel) and any(fields.get(k) for k in ("放送時間", "放送枠", "放送分"))
                               or record["medium"] == "television" and record["period"] and not (stream_only or stream_channel))
    return television, streaming


def edition_label_key(text):
    return key(re.sub(r"\s*[（(](?:続編|スピンオフ|特別編)[）)]$", "", text))


def edition_blocks(origins, require_branch, seed, page_title):
    """Resolve edition identity before attaching metadata or episode tables."""
    work_name = key(short_title(page_title))
    seed_name = key(short_title(seed["name"]))
    # A redirect to a series article may name one specific spin-off or special in an infobox.
    def names_edition(record):
        return any(edition_label_key(label) == seed_name
                   for label in [record["label"], *section_names(record["headings"])])

    named = seed_name != work_name and any(
        names_edition(record) for records in origins for record in records if record["period"] and
        (len({r["period"] for r in records if r["period"] and r["medium"] != "streaming"}) > 1
         or record["branch"] is None and bool(record["headings"])))
    common_fields = re.compile(r"番組名|作品名|タイトル|別名|別題|通称|英題|ジャンル|放送国・地域")
    options = collections.defaultdict(list)
    dated_seasons = {}
    wanted_part = PART_LABEL.search(norm(seed["name"]))
    for records in origins:
        dates = [record for record in records if record["period"]]
        has_variants = len({(r["season"], key(r["label"])) for r in dates if r["medium"] != "streaming"}) > 1
        for record in dates:
            record_year = year_in(record["period"]) or next((y for text in reversed(section_names(record["headings"]))
                                                             if (y := edition_year(text))), None)
            if record["season"] and record_year and record["medium"] != "streaming":
                dated_seasons[record["season"]] = record_year
            if require_branch and not record["branch"] or record_year and record_year != seed["year"]:
                continue
            if named and not names_edition(record):
                continue
            part = PART_LABEL.search(record["label"] + " " + " ".join(section_names(record["headings"])))
            if part and wanted_part and part[0].removesuffix("編") != wanted_part[0].removesuffix("編"):
                continue
            if seed["season"] and record["season"] and seed["season"] != record["season"]:
                continue
            season = record["season"] or seed["season"]
            context = []
            for common in records:
                if common is record or common["period"]:
                    continue
                if common["season"] not in (None, season) or common["medium"] == "streaming" and record["medium"] != "streaming":
                    continue
                fields = common["fields"]
                if has_variants and common["season"] is None:
                    fields = {k: v for k, v in fields.items()
                              if COUNTRY_LABEL.fullmatch(k) or CHANNEL_LABEL.fullmatch(k) or common_fields.fullmatch(k)}
                if record["medium"] == "streaming":
                    fields = {k: v for k, v in fields.items() if COUNTRY_LABEL.fullmatch(k) or common_fields.fullmatch(k)}
                context.append({**common, "fields": fields})
            part_label = (part or wanted_part)[0] if part or wanted_part else ""
            options[(season, part_label)].append((record, [record, *context]))

        # Some infoboxes declare only the schedule or broadcaster, with dates in the episode table.
        if not dates and not named:
            scoped = [record for record in records if not require_branch or record["branch"]]
            for record in scoped:
                if broadcast_evidence([record]) != (False, False) or seed["listed"] and any(
                        COUNTRY_LABEL.fullmatch(label) for label in record["fields"]):
                    options[(seed["season"], wanted_part[0] if wanted_part else "")].append((record, scoped))
                    break

    # A franchise summary may repeat a uniquely identified drama, with extra fields such as the total.
    # Corroborate the work label and full period before using its fields, and never use it to create an edition.
    if require_branch:
        for sections in options.values():
            for primary, context in sections:
                if not primary["period"] or primary["medium"] == "streaming":
                    continue
                for records in origins:
                    for summary in records:
                        label = re.sub(r"^ドラマ[:：]\s*", "", summary["label"])
                        if (summary["branch"] or not re.match(r"ドラマ[:：]", summary["label"])
                                or summary["period"] != primary["period"]
                                or not any(key(line) in (seed_name, work_name) for line in label.splitlines())):
                            continue
                        fields = {k: v for k, v in summary["fields"].items() if COLLECTIVE_COUNT.fullmatch(k)}
                        if fields:
                            context.append({**summary, "fields": fields, "period": ""})

    # Generic dates from a summary do not create an extra edition when the article names its seasons.
    if seed["season"] is None:
        for season, part in list(options):
            if season is None and any(other is not None and other_part == part for other, other_part in options):
                del options[(season, part)]
    if not wanted_part and any(part for _, part in options):
        for season, part in list(options):
            if not part and any(other == season and other_part for other, other_part in options):
                del options[(season, part)]
    return options, named, dated_seasons


def select_edition_records(options, year):
    television_options = [(record, context) for record, context in options if broadcast_evidence(context)[0]
                          and record["medium"] != "streaming"]
    broadcast_options = television_options or [(record, context) for record, context in options
                                               if record["medium"] != "streaming"] or options
    metadata = [box_metadata(context, year) for _, context in broadcast_options]
    starts = {meta["first_air_date"] for meta in metadata if meta["first_air_date"]}
    if len(starts) > 1:
        return None
    if not metadata:
        metadata = [box_metadata([], year)]
    meta = {}
    for field, value in metadata[0].items():
        if isinstance(value, list):
            meta[field] = list(dict.fromkeys(item for record in metadata for item in record[field]))
        else:
            values = {record[field] for record in metadata if record[field] is not None}
            meta[field] = values.pop() if len(values) == 1 else None
    # Streaming evidence applies only to this edition; television takes precedence.
    television, streaming = broadcast_evidence([record for _, context in options for record in context])
    meta["broadcast_format"] = "television" if television else "streaming" if streaming else None
    return meta


def expand_page(base, cache_entries, target, multi):
    episodes = []
    profiles = []
    structural = collections.Counter()
    fallback_tables = []
    root_has_branch = has_domestic_branch(cache_entries[0][1])
    for page, entries in cache_entries:
        is_related = page["id"] != base["id"]
        require_branch = has_domestic_branch(entries) or is_related and root_has_branch
        anchor_found = False
        branches = set()
        page_episodes = []
        for table, headings in entries:
            context = " > ".join(section_names(headings))
            if table.tag != "table":
                if table.tag == "li" and DRAMA.search(context):
                    structural["section_list_items"] += 1
                if table.tag in ("li", "p") and SECTION_EPISODES.search(context):
                    text = cell_text(table)
                    if re.search(r"第[0-9０-９一二三四五六七八九十]+話|(?:最終話|特別編).{0,25}放送", text):
                        structural["episode_text_items"] += 1
                continue
            caption = table_caption(table)
            allowed, season, year = scope_for(target, headings, caption)
            if not allowed:
                continue
            branch = domestic_branch(headings, caption)
            if require_branch and not branch:
                continue
            if not is_related and target["_branches"] and branch not in target["_branches"]:
                continue
            if target["_named"] and not any(edition_label_key(text) == target["_named"]
                                             for text in section_names(headings) + [caption]):
                continue
            table_scope = context + " > " + caption
            if re.search(r"再放送|映画版|劇場版|配信版|配信限定|配信日程|スピンオフ|オリジナルストーリー", table_scope) and not SPECIAL_SECTION.search(table_scope):
                continue
            parsed = parse_schedule(table, headings, year or target["year"], start_month=target.get("_start_month"),
                                    expected_season=target["season"])
            if not parsed:
                continue
            profile, rows = parsed
            if profile.get("reason"):
                structural["unsupported_episode_tables"] += 1
            explicit_year = profile.get("first_explicit_year")
            if explicit_year and explicit_year != target["year"] and not SPECIAL_SECTION.search(profile["context"]):
                structural["different_year_tables"] += 1
                continue
            season_scoped = target["season"] is not None and season == target["season"]
            year_scoped = year == target["year"] or explicit_year == target["year"]
            row_scoped = target["season"] is not None and any(row["row_season"] == target["season"] for row in rows)
            # A broadcast year can select a named season within an identified edition, but cannot scope a generic table.
            unnamed_season = target["season"] is None and (year == target["year"] or season is not None and year_scoped)
            version_scoped = season_scoped or row_scoped or unnamed_season or target["_named"]
            if multi and not version_scoped:
                if rows or not profile.get("reason"):
                    structural["unscoped_episode_tables"] += 1
                    fallback_tables.append((page, profile, rows))
                continue
            if season_scoped or year_scoped:
                anchor_found = True
            if rows and branch:
                branches.add(branch)
            if rows or "week" in profile["headers"] or "episode" in profile["headers"] or (SECTION_EPISODES.search(profile["context"]) and "airdate" in profile["headers"]):
                profiles.append({"page_id": page["id"], **profile})
                for episode in rows:
                    if row_scoped and not season_scoped and episode["row_season"] != target["season"]:
                        continue
                    page_episodes.append({**episode, "source": source_info(page), "source_section": profile["anchor"],
                                          "source_headers": profile["headers"], "season": episode["row_season"] or season or target["season"]})
        if len(branches) <= 1:
            episodes.extend(page_episodes)
        if is_related:
            structural["related_pages_scanned"] += 1
        if anchor_found:
            structural["explicit_season_pages"] += 1
    if fallback_tables:
        structural["unscoped_rows"] = sum(len(rows) for _, _, rows in fallback_tables)
    if multi and target["season"] is None:
        seasons = {episode["season"] for episode in episodes if episode["season"] is not None}
        if seasons:
            episodes = [episode for episode in episodes if len(seasons) == 1 and episode["season"] in seasons]
    unique = {}
    conflicts = {}
    for episode in episodes:
        label = episode["number"] if episode["number"] is not None else episode["label"]
        identity = (episode["kind"], label)
        prior = unique.setdefault(identity, episode)
        if prior is not episode:
            fields = ("airdate", "broadcast_range", "formal_subtitle", "listed_subtitle", "epg_subtitle", "streaming_titles")
            differences = [field for field in fields if prior[field] != episode[field]]
            if differences:
                conflicts[identity] = {"episode": label, "fields": differences}
            elif (episode["source"]["page_id"], episode["source_section"] or "") < (prior["source"]["page_id"], prior["source_section"] or ""):
                unique[identity] = episode
            structural["duplicate_rows_held"] += 1
    return [episode for identity, episode in unique.items() if identity not in conflicts], profiles, structural, conflicts


def source_info(page):
    revision = page.get("latest", {})
    return {"page_id": page["id"], "title": page["title"], "revision_id": revision.get("id"),
            "updated_at": revision.get("timestamp"), "license": page.get("license"),
            "url": SITE + "/wiki/" + urllib.parse.quote(page["title"].replace(" ", "_"), safe=""),
            "revision_url": SITE + "/w/index.php?oldid=" + str(revision.get("id"))}



EXCLUDED = re.compile(r"単発|映画版|劇場版|配信限定|再放送のみ|テレビアニメ|特集ドラマ")
EXTRACTOR_REVISION = 3
DOMESTIC = re.compile(r"日本|NHK|テレビ|WOWOW|BS|MBS|ABC|TBS|CBC|TOKYO MX", re.I)


def emit(event, **payload):
    print(json.dumps({"event": event, **payload}, ensure_ascii=False, separators=(",", ":")), flush=True)


def page_title(href):
    if not href.startswith(("./", "/wiki/")):
        return None
    url = urllib.parse.urlsplit(href)
    title = urllib.parse.unquote(url.path.removeprefix("./").removeprefix("/wiki/")).replace("_", " ")
    return title if title and ":" not in title else None


def edition_key(seed):
    part = PART_LABEL.search(norm(seed["name"]))
    return f'{seed["year"]}:{seed["season"] or 0}:{part[0].removesuffix("編") if part else ""}'


WORK_COLUMN = re.compile(r"作品名|番組名|ドラマ名|タイトル")
STATION_COLUMN = re.compile(r"制作局|製作局|放送局|放送チャンネル")
CATALOG_EXCLUDED = re.compile(r"映画版|劇場版|配信限定|再放送のみ|テレビアニメ")
NOT_WORK = re.compile(r"^(?:\d{1,2}月(?:\d{1,2}日)?|\d{4}年|未定|TBA|なし)(?:$|[\s（(〜～-])"
                      r"|^(?:出演|主演|脚本|演出|監督|原作|原案|制作|放送|声の出演|職業)[:：]"
                      r"|^(?:会社員|公式サイト|テレビドラマ|連続ドラマ|単発ドラマ)$")
PROGRAM_CREDIT = re.compile(r"\s+[-–—―]\s*(?=[^\n]*(?:制作|製作|企画|公式サイト)|$)"
                            r"|[-–—―]\s*(?=(?:制作|製作|企画)(?:協力|著作)?[:：])")
PROGRAM_SEPARATOR = re.compile(r"\n|\s+[／/]\s+|(?<=」)\s*[、・]\s*(?=「)")


def catalogue_names(node, year):
    # Use only the title cell or the lead of the programme item, before its nested credits.
    lead = Element(node.tag)
    for child in node.children:
        if isinstance(child, Element) and child.tag in ("ul", "ol", "dl"):
            break
        lead.children.append(child)
    text = PROGRAM_CREDIT.split(cell_text(lead, True), maxsplit=1)[0]
    text = re.sub(r"\s*[（(]公式サイト[）)]\s*$", "", text)
    links = list(descendants(lead, {"a"}, {"li", "table", "sup"}))
    labels = {key(cell_text(link)) for link in links}
    names = []
    for part in PROGRAM_SEPARATOR.split(text):
        segments = re.split(r"[／/]", part)
        names.extend(segments if len(segments) > 1 and all(key(s.strip("『』「」")) in labels for s in segments) else [part])
    for raw in names:
        name = norm(raw).strip("『』「」")
        if not name or "|" in name or NOT_WORK.search(name) or CATALOG_EXCLUDED.search(name):
            continue
        year_in_name = year_in(name)
        if year_in_name and year_in_name != year:
            continue
        name_key = key(name)
        without_season = key(SEASON_LABEL.sub("", name))
        matches = {}
        for link in links:
            label = norm(cell_text(link))
            title = page_title(link.attrs.get("href") or "")
            if not title or not label or NOT_WORK.search(label) or NOT_WORK.search(title):
                continue
            target_year = year_in(title)
            if target_year and target_year != year:
                continue
            name_season, target_season = explicit_season(name), explicit_season(title)
            if name_season is not None and target_season is not None and name_season != target_season:
                season_range = re.search(r"season\s*(\d+)\s*[-–]\s*(?:(?:season\s*)?(\d+))?\s*\)$", title, re.I)
                if not (season_range and re.search(r"エピソード一覧|各話一覧|放送リスト", title)
                        and int(season_range[1]) <= name_season and (not season_range[2] or name_season <= int(season_range[2]))):
                    continue
            label_key, article_key = key(label), key(short_title(title))
            if label_key in (name_key, without_season) or name_key.endswith(label_key) and len(label_key) >= 3:
                if article_key == label_key or article_key.startswith(label_key) or label_key.startswith(article_key):
                    # A linked title after a slot label can stand alone; keep explicit season information from the row.
                    matches[title] = label if name_key != label_key and not name_season and name_key.endswith(label_key) else name
        yield next(iter(matches.items())) if len(matches) == 1 else (name, name)


def discovery_candidates(page, year):
    date_heading = str(year) + "年"
    available = []
    for item, headings in table_context(Document(page["html"]).root):
        sections = section_names(headings)
        if not sections:
            continue
        if item.tag == "table" and sections[0] == date_heading:
            rows = table_rows(item)
            cells_by_id = {id(cell): cell for _, cells in rows for cell in cells}
            indices = {}
            for row, _ in rows:
                for index, field in enumerate(row):
                    if field and field[1] == "th":
                        if WORK_COLUMN.fullmatch(norm(field[0])):
                            indices["work"] = index
                        if STATION_COLUMN.fullmatch(norm(field[0])):
                            indices["station"] = index
                index, station = indices.get("work"), indices.get("station")
                if index is None or station is None or max(index, station) >= len(row):
                    continue
                work, outlet = row[index], row[station]
                if not work or not outlet or WORK_COLUMN.fullmatch(work[0]) or STATION_COLUMN.fullmatch(outlet[0]):
                    continue
                network = outlet[0]
                if network and DOMESTIC.search(network):
                    available.extend((title, name, network, True) for title, name in catalogue_names(cells_by_id[work[3]], year))
        elif item.tag == "li" and sections[0] == date_heading + "のテレビドラマ" and len(sections) > 1:
            if CATALOG_EXCLUDED.search(" ".join(sections)):
                continue
            sublists = [node for node in child_elements(item) if node.tag in ("ul", "ol", "dl")]
            supporting = any(re.match(r"\d{1,2}月|(?:放送|配信)[：:]|(?:脚本|主演|出演|演出|監督)[：:]", norm(cell_text(row)))
                             for sublist in sublists for row in child_elements(sublist))
            lead = cell_text(item, True).split("\n", 1)[0]
            if not supporting and not PROGRAM_CREDIT.search(lead):
                continue
            available.extend((title, name, sections[1], True) for title, name in catalogue_names(item, year))
    return available


def discover(client, year, bangumi):
    title_variants = [f"{year}年のテレビドラマ (日本)", f"日本のテレビドラマ一覧 ({year // 10 * 10}年代)"]
    known = client.revisions(title_variants)
    found = {}
    sources = []
    for page in known.values():
        if "pageid" not in page:
            continue
        _, obj = client.html(page)
        client.retain(obj)
        sources.append(source_info(obj))
        for title, name, network, listed in discovery_candidates(obj, year):
            item = dict(title=title, name=name, year=year, season=explicit_season(name), network=network,
                        listed=listed, discovery=source_info(obj), routes=["list"])
            found.setdefault((title, edition_key(item)), item)
    category = "Category:" + str(year) + "年のテレビドラマ"
    continuation = {}
    while True:
        response = client.action(list="categorymembers", cmtitle=category, cmnamespace=0, cmlimit=500,
                                 **continuation)
        for member in response["query"]["categorymembers"]:
            title = member["title"]
            explicit_year = year_in(title)
            if CATALOG_EXCLUDED.search(title) or explicit_year and explicit_year != year:
                continue
            item = dict(title=title, name=short_title(title), year=year, season=explicit_season(title),
                        network=None, listed=False, discovery=None, routes=["category"])
            entry = found.setdefault((title, edition_key(item)), item)
            if entry is not item:
                entry["routes"].append("category")
        continuation = response.get("continue")
        if not continuation:
            break
    for work in bangumi:
        title = work["title"]
        if CATALOG_EXCLUDED.search(title):
            continue
        item = dict(title=title, name=title, year=year, season=work["season"] or explicit_season(title),
                    network=None, listed=False, discovery=None, routes=["bangumi"])
        # Compare edition identity as well as the title when sharing a lookup with a catalogue entry.
        title_key = key(SEASON_LABEL.sub("", short_title(title)))
        matches = [entry for entry in found.values() if edition_key(entry) == edition_key(item)
                   and title_key in {key(SEASON_LABEL.sub("", short_title(entry[name]))) for name in ("title", "name")}]
        entry = matches[0] if len(matches) == 1 else found.setdefault((title, edition_key(item)), item)
        entry.setdefault("bangumi", []).append(work)
        if "bangumi" not in entry["routes"]:
            entry["routes"].append("bangumi")
    return list(found.values()), sources


def split_articles(client, page, seeds, related_by_title):
    choices = []
    root = key(short_title(page["title"]))
    wanted = {seed["season"] for seed in seeds if seed["season"] is not None}
    for title, label, _ in Links(page["html"]).links:
        if title == page["title"] or not key(title).startswith(root) or not re.search(r"エピソード一覧|各話一覧|放送リスト", title + label):
            continue
        seasons = [int(n) for n in re.findall(r"season\s*(\d+)", title, re.I)]
        if wanted and seasons:
            if len(seasons) > 1:
                if not any(seasons[0] <= season <= seasons[-1] for season in wanted):
                    continue
            elif title.endswith("-)") and not any(season >= seasons[0] for season in wanted):
                continue
        choices.append(title)
    choices = list(dict.fromkeys(choices))[:6]
    related_by_title.update(client.revisions([title for title in choices if title not in related_by_title]))
    pages = []
    canonical = set()
    for title in choices:
        candidate = related_by_title[title]
        if "pageid" in candidate and candidate["pageid"] != page["id"]:
            if candidate["pageid"] in canonical:
                continue
            canonical.add(candidate["pageid"])
            _, obj = client.html(candidate)
            client.retain(obj)
            pages.append(obj)
    return pages


def episode_sections_seasons(entries):
    seasons = set()
    for table, headings in entries:
        if table.tag != "table":
            continue
        texts = section_names(headings) + [table_caption(table)]
        context = " > ".join(texts)
        if SECTION_EPISODES.search(context) and not OTHER_VERSION.search(context):
            seasons.update(season for text in texts if (season := explicit_season(text)) is not None)
    return seasons


def candidate_identity(seed):
    return [seed["year"], seed["title"], seed["season"], seed["name"]]


def prior_candidates(seeds, previous, unconfirmed):
    states = {tuple(item["key"]): item["state"] for item in unconfirmed}
    result = []
    for seed in seeds:
        identity = candidate_identity(seed)
        state = states.get(tuple(identity))
        editions = [] if state else [old["key"] for old in previous if identity in (old.get("candidates") or [])]
        result.append(dict(seed=seed, editionKeys=editions, state=state or "unresolved"))
    return result


def extract_article(obj, entries, load_related, seeds, previous, diagnostics=None):
    children = None
    available_seasons = episode_sections_seasons(entries)
    origins = [records for table, headings in entries if table.tag == "table"
               if (records := box_sections(table, headings))]
    require_branch = has_domestic_branch(entries)
    declared_seasons = {record["season"] for records in origins for record in records
                        if record["season"] is not None and (not require_branch or record["branch"])}
    emitted = {}
    remove = set()
    candidates = []
    seeds = sorted(seeds, key=lambda seed: (not any(key(seed["name"]) == key(old["title"]) for old in previous),
                                           not seed["listed"]))
    for original in seeds:
        options, named, dated_seasons = edition_blocks(origins, require_branch, original, obj["title"])
        previous_for_seed = [old for old in previous
                             if candidate_identity(original) in (old.get("candidates") or [])
                             or old["key"] == edition_key(original) and (not named or key(old["title"]) == key(original["name"]))]
        if not options and original["listed"] and not named and not dated_seasons:
            wanted_part = PART_LABEL.search(norm(original["name"]))
            options[(original["season"], wanted_part[0] if wanted_part else "")] = []

        accepted = []
        excluded = set()
        identified = set()
        versions = {scope: select_edition_records(sections, original["year"]) for scope, sections in options.items()}
        television_count = sum(meta is not None and meta["broadcast_format"] != "streaming" for meta in versions.values())
        for (season, part), sections in options.items():
            named_work = key(short_title(original["name"])) if named else ""
            name = original["name"]
            if part and not PART_LABEL.search(norm(name)):
                name = f"{name} {part}"
            if season is not None and original["season"] is None and television_count > 1 and not explicit_season(name):
                name = f"{name} Season {season}"
            seed = {**original, "name": name, "season": season}
            meta = versions[(season, part)]
            if meta is None:
                continue
            branches = {record["branch"] for record, _ in sections if record["branch"]}
            if len(branches) > 1:
                continue

            country = [country for field in meta["production_countries"]
                       for token in re.split(r"[、,・/／\n]+", field)
                       if (country := norm(token)) and not EMPTY_COUNTRY.fullmatch(country)]
            foreign = bool(country) and not any(re.search(r"日本(?!語)|\bJapan\b", name, re.I) for name in country)
            stream_only = meta["broadcast_format"] == "streaming"
            if foreign or stream_only:
                excluded.add((season, part.removesuffix("編")))
                continue
            if not sections and not seed["listed"]:
                continue
            if not meta["broadcast_format"] and seed.get("network") and not STREAMING.search(seed["network"]):
                meta["broadcast_format"] = "television"

            target = dict(seed, _start_month=int(meta["first_air_date"][5:7]) if meta["first_air_date"] else None,
                          _branches=branches, _named=named_work)
            multi = len(available_seasons | dated_seasons.keys()) > 1 or len(options) > 1
            if children is None:
                children = [(page, table_context(Document(page["html"]).root)) for page in load_related()]
            episodes, profiles, structural, conflicts = expand_page(obj, [(obj, entries), *children], target, multi)
            if diagnostics is not None:
                diagnostics["extract_unscoped_tables"] += structural.get("unscoped_episode_tables", 0)
                diagnostics["extract_conflicting_rows"] += len(conflicts)
                diagnostics["extract_unsupported_tables"] += structural.get("unsupported_episode_tables", 0) + sum(
                    bool(p.get("unparsed_episode_rows")) for p in profiles)
            if not episodes and not meta["first_air_year"] and not meta["declared_episode_count"]:
                continue
            if not meta["first_air_date"]:
                starts = {e["airdate"] for e in episodes if e["kind"] == "normal" and e["number"] == 1
                          and e["airdate"] and e["airdate"][:4] == str(seed["year"])}
                if len(starts) == 1:
                    meta["first_air_date"] = starts.pop()
                    meta["first_air_year"] = seed["year"]
            if not meta["broadcast_channels"] and seed.get("network") and not STREAMING.search(seed["network"]):
                meta["broadcast_channels"] = [seed["network"]]

            page_season = explicit_season(obj["title"])
            stated_season = (page_season == season or any(record["season"] == season for record, _ in sections)
                             or any(e["row_season"] == season for e in episodes)
                             or any(explicit_season(profile["context"]) == season for profile in profiles))
            if original.get("lookupTitle") and (meta["first_air_year"] != seed["year"] or
                                                page_season and season and page_season != season):
                continue
            if seed["season"] and original.get("bangumi") and not stated_season:
                # The Bangumi season is search input; it cannot establish a season on Wikipedia.
                continue

            identity = [seed["year"], season, part.removesuffix("編"), named_work]
            edition_id = edition_key(seed)
            if named:
                edition_id += "~" + hashlib.sha256(named_work.encode()).hexdigest()[:24]
            stable = next((old for old in previous_for_seed if old.get("identity") == identity
                           or not old.get("identity") and old["key"].split(":", 2)[2] == identity[2]
                           and old["season"] == season and (not named or key(old["title"]) == identity[3])), None)
            stable = stable or next((old for old in previous if old.get("identity") == identity), None)
            if not stable and named_work and season is not None and stated_season:
                same_named = [old for old in previous if old.get("identity") == [seed["year"], None, identity[2], named_work]
                              and old.get("firstAirDate") and old["firstAirDate"] == meta["first_air_date"]]
                if len(same_named) == 1:
                    stable = same_named[0]
                    identity = stable["identity"]
                    seed = {**seed, "season": None}
            if stable:
                edition_id = stable["key"]
            # Keep a legacy unnumbered ID only when the same edition is corroborated.
            elif season is not None and television_count == 1 and not part:
                legacy = next((old for old in previous_for_seed if not old.get("identity") and old["season"] is None
                               and key(old["title"]) == key(original["name"]) and old.get("firstAirDate")
                               and old["firstAirDate"] == meta["first_air_date"]), None)
                if legacy:
                    edition_id = legacy["key"]
            existing = next((old for old in previous if old["key"] == edition_id), None)
            if existing and (existing.get("identity") and existing["identity"] != identity
                             or not existing.get("identity") and existing not in previous_for_seed):
                continue
            identified.add((season, identity[2]))
            accepted.append(edition_id)
            edition = emitted.get(edition_id)
            if not edition:
                meta["broadcast_identity"] = identity
                meta["candidate_keys"] = []
                parsed = [profile for profile in profiles if not profile.get("reason")]
                replace = bool(parsed) and not structural.get("unscoped_rows") and not conflicts and not any(
                    profile.get("unparsed_episode_rows") for profile in parsed) and (
                    bool(episodes) or not any(profile["content_rows"] for profile in parsed))
                emitted[edition_id] = edition = dict(key=edition_id, seed=seed, metadata=meta, episodes=episodes,
                                                    replaceEpisodes=replace)
            edition["metadata"]["candidate_keys"].append(candidate_identity(original))

        state = "excluded" if excluded and not accepted and len(excluded) == len(options) else "unresolved"
        candidates.append(dict(seed=original, editionKeys=accepted, state=state))
        for old in previous_for_seed:
            if old["key"] in accepted:
                continue
            season = old["season"]
            old_part = old["identity"][2] if old.get("identity") else old["key"].split(":", 2)[2]
            scoped_rejection = (season, old_part) in excluded or state == "excluded" and season is None and not old_part
            split = (season is None and not old_part and (not old.get("identity") or not old["identity"][3])
                     and (len(identified) > 1 or bool(identified and excluded)))
            # Explicit, dated edition metadata can establish that a previously known season is absent.
            known_scope = not old_part and (not old.get("identity") or not old["identity"][3])
            absent = (known_scope and season is not None and identified and season not in declared_seasons
                      and season not in available_seasons and
                      any(year == original["year"] for year in dated_seasons.values()))
            if scoped_rejection or split or absent:
                remove.add(old["key"])

    return list(emitted.values()), candidates, sorted(remove.difference(emitted))


def alias_titles(seed):
    used = {key(seed["title"]), key(seed["name"])}
    works = seed.get("bangumi", [])
    if len(works) != 1:
        return
    work = works[0]
    for title in [work["title"], *work["aliases"]]:
        title = norm(title)
        normalized = key(title)
        if (not normalized or normalized in used or re.search(r"[|\x00-\x1f]", title)
                or NOT_WORK.search(title) or CATALOG_EXCLUDED.search(title)):
            continue
        yr, season = year_in(title), explicit_season(title)
        if yr and yr != seed["year"] or season and seed["season"] and season != seed["season"]:
            continue
        used.add(normalized)
        yield title


def article_records(db, ids):
    for ident in ids:
        row = db.execute("SELECT revision,source,seeds,related FROM wikipedia_articles WHERE id=?", (ident,)).fetchone()
        if not row:
            continue
        revision, source, seeds, related = row
        source = json.loads(source)
        editions = []
        for edition_id, season, title, data in db.execute(
                "SELECT id,season,title,data FROM wikipedia_editions WHERE article_id=?", (ident,)):
            meta = json.loads(data)
            editions.append(dict(key=edition_id.split(":", 1)[1], season=season, title=title,
                                 firstAirDate=meta.get("first_air_date"), identity=meta.get("broadcast_identity"),
                                 candidates=meta.get("candidate_keys")))
        yield str(ident), dict(id=ident, revision=revision, extractor=source.get("extractor"), seeds=json.loads(seeds),
                               related=json.loads(related), unconfirmed=source.get("unconfirmed_candidates", []),
                               editions=editions)


def confirmed_candidates(editions):
    return {tuple(identity) for edition in editions for identity in (edition.get("candidates") or [])}


def wikipedia_seed(seed, confirmed):
    return (any(route != "bangumi" for route in seed.get("routes", []))
            or "routes" not in seed and seed.get("listed", True)
            or tuple(candidate_identity(seed)) in confirmed)


def process(client, instruction):
    database = instruction.get("database")
    db = sqlite3.connect(Path(database).resolve().as_uri() + "?mode=ro", uri=True) if database else None
    known = instruction.get("known", {})
    tried = {int(ident) for ident in known}

    def load_known(ids):
        missing = set(ids) - tried
        if db is not None and missing:
            tried.update(missing)
            for ident, row in article_records(db, sorted(missing)):
                known[ident] = row
                client.stats["known_articles"] += 1

    try:
        load_known(instruction.get("articleIds", []))
        seeds = instruction["seeds"]
        bangumi_enabled = instruction.get("bangumiEnabled", True)
        if not bangumi_enabled:
            confirmed = confirmed_candidates(edition for article in known.values() for edition in article["editions"])
            seeds = [seed for seed in seeds if wikipedia_seed(seed, confirmed)]
        process_candidates(client, seeds, known, load_known, bangumi_enabled)
    finally:
        if db is not None:
            db.close()


def process_candidates(client, primary, known, load_known, bangumi_enabled=True):
    revisions, id_revisions = {}, {}
    seen = collections.defaultdict(set)
    results = process_seeds(client, primary, known, revisions, id_revisions, seen, load_known,
                            bangumi_enabled=bangumi_enabled)
    if not bangumi_enabled:
        return
    fallback = [(seed, iter(alias_titles(seed))) for seed in primary
                if results.get(tuple(candidate_identity(seed))) in ("missing", "unresolved", "excluded")]
    while fallback:
        wave = []
        for seed, aliases in fallback:
            title = next(aliases, None)
            if title:
                wave.append({**seed, "lookupTitle": title})
        if not wave:
            break
        try:
            results = process_seeds(client, wave, known, revisions, id_revisions, seen, load_known, aliases=True)
        except ApiFailure as exc:
            emit("failed", seeds=wave, message=str(exc), retryAfter=client.retry_after)
            break
        attempted = {tuple(candidate_identity(seed)) for seed in wave}
        fallback = [(seed, titles) for seed, titles in fallback if tuple(candidate_identity(seed)) in attempted and
                    results.get(tuple(candidate_identity(seed))) in ("missing", "unresolved", "excluded")]


def process_seeds(client, seeds, known, revisions, id_revisions, seen, load_known, aliases=False, bangumi_enabled=True):
    results = {}
    # For a previously confirmed alias, check the stored page by ID. A failed lookup must not
    # displace a page that supplied a valid edition for the same candidate.
    prior_ids = {}
    if not aliases:
        for record in known.values():
            ready = confirmed_candidates(record.get("editions", []))
            excluded = {tuple(item["key"]) for item in record.get("unconfirmed", []) if item["state"] == "excluded"}
            for seed in record["seeds"]:
                identity = tuple(candidate_identity(seed))
                if identity in ready or identity in excluded and identity not in prior_ids:
                    prior_ids[identity] = record["id"]
    ids = {prior_ids[tuple(candidate_identity(seed))] for seed in seeds
           if tuple(candidate_identity(seed)) in prior_ids} - id_revisions.keys()
    if ids:
        batch = client.page_ids(sorted(ids))
        id_revisions.update({ident: batch.get(ident, {}) for ident in ids})
        for page in batch.values():
            revisions.setdefault(key(page["title"]), page)
    titles = {}
    for seed in seeds:
        prior = prior_ids.get(tuple(candidate_identity(seed)))
        if id_revisions.get(prior) and "disambiguation" not in id_revisions[prior].get("pageprops", {}):
            continue
        title = seed.get("lookupTitle") if aliases else seed["title"]
        if key(title) not in revisions:
            titles.setdefault(key(title), title)
    if titles:
        looked_up = client.revisions(list(titles.values()))
        revisions.update({normalized: looked_up[title] for normalized, title in titles.items()})
        for page in looked_up.values():
            if "pageid" in page:
                id_revisions.setdefault(page["pageid"], page)
                revisions.setdefault(key(page.get("title")), page)
    by_page = collections.defaultdict(list)
    resolved = {}
    for seed in seeds:
        identity = tuple(candidate_identity(seed))
        title = seed.get("lookupTitle") if aliases else seed["title"]
        prior = prior_ids.get(identity)
        candidate = id_revisions.get(prior, {})
        if not candidate or "disambiguation" in candidate.get("pageprops", {}):
            candidate = revisions[key(title)]
        if "pageid" not in candidate:
            results[identity] = "missing"
            if not aliases:
                emit("missing", seed=seed, pageId=prior)
        elif "disambiguation" in candidate.get("pageprops", {}):
            results[identity] = "unresolved"
            if not aliases:
                emit("unresolved", seed=seed, pageId=prior)
        else:
            page_id = candidate["pageid"]
            if aliases and page_id in seen[identity]:
                results[identity] = "unresolved"
                continue
            seen[identity].add(page_id)
            by_page[page_id].append(seed)
            resolved[page_id] = candidate
    load_known(by_page)
    related_ids = {source["page_id"] for ident in by_page for source in known.get(str(ident), {}).get("related", [])}
    unseen = related_ids - resolved.keys() - id_revisions.keys()
    if unseen:
        batch = client.page_ids(sorted(unseen))
        id_revisions.update({ident: batch.get(ident, {}) for ident in unseen})
    linked_metadata = {ident: resolved.get(ident) or id_revisions[ident] for ident in related_ids}
    related_by_title = {p["title"]: p for p in [*resolved.values(), *linked_metadata.values()] if p}
    for page_id, group in by_page.items():
        page = resolved[page_id]
        revision = page["revisions"][0]["revid"]
        previous = known.get(str(page_id), {})
        old_seeds = previous.get("seeds", [])
        previous_editions = previous.get("editions", [])
        existing = {tuple(candidate_identity(seed)): seed for seed in old_seeds}
        linked_unchanged = all(linked_metadata.get(src["page_id"], {}).get("revisions", [{}])[0].get("revid")
                               == src["revision_id"] for src in previous.get("related", []))
        if (previous.get("revision") == revision and previous.get("extractor") == EXTRACTOR_REVISION
                and linked_unchanged and not aliases and all(
                    (old := existing.get(tuple(candidate_identity(seed)))) is not None
                    and (not seed["listed"] or old["listed"] and old["network"] == seed["network"]) for seed in group)):
            candidates = prior_candidates(group, previous_editions, previous.get("unconfirmed", []))
            for item in candidates:
                seed = item["seed"]
                identity = tuple(candidate_identity(seed))
                state = item["state"]
                if state == "excluded" and existing[identity].get("bangumi") == seed.get("bangumi"):
                    state = "excluded_unchanged"
                results[identity] = "ready" if item["editionKeys"] else state
            emit("unchanged", pageId=page_id, seeds=candidates)
            continue
        by_identity = {tuple(candidate_identity(seed)): seed for seed in old_seeds}
        for seed in group:
            identity = tuple(candidate_identity(seed))
            by_identity[identity] = {**by_identity.get(identity, {}), **seed}
        all_seeds = list(by_identity.values())
        extract_seeds = all_seeds
        if not bangumi_enabled:
            confirmed = confirmed_candidates(previous_editions)
            extract_seeds = [seed for seed in all_seeds if wikipedia_seed(seed, confirmed)]
        try:
            _, obj = client.html(page)
            entries = table_context(Document(obj["html"]).root)
            related = []

            def load_related():
                related.extend(split_articles(client, obj, extract_seeds, related_by_title))
                if related:
                    client.retain(obj)
                return related

            # A rejected alias is not evidence that a different edition disappeared.
            editions, candidates, remove = extract_article(obj, entries, load_related, extract_seeds, previous_editions, client.stats)
            group_keys = {tuple(candidate_identity(seed)) for seed in group}
            confirmed = set()
            for item in candidates:
                identity = tuple(candidate_identity(item["seed"]))
                if identity in group_keys:
                    results[identity] = "ready" if item["editionKeys"] else item["state"]
                    if item["editionKeys"]:
                        confirmed.add(identity)
            if aliases:
                if not confirmed:
                    continue
                retained = existing.keys() | confirmed
                all_seeds = [seed for seed in all_seeds if tuple(candidate_identity(seed)) in retained]
                candidates = [item for item in candidates if tuple(candidate_identity(item["seed"])) in retained]
                remove = []
                client.stats["alias_hits"] += len(confirmed)
            unconfirmed = [dict(key=candidate_identity(item["seed"]), state=item["state"])
                           for item in candidates if not item["editionKeys"]]
            if not bangumi_enabled:
                checked = {tuple(candidate_identity(seed)) for seed in extract_seeds}
                unconfirmed.extend(item for item in previous.get("unconfirmed", []) if tuple(item["key"]) not in checked)
            source = {**source_info(obj), "extractor": EXTRACTOR_REVISION, "unconfirmed_candidates": unconfirmed}
            current_editions = {edition["key"]: edition for edition in previous_editions if edition["key"] not in remove}
            for edition in editions:
                meta = edition["metadata"]
                current_editions[edition["key"]] = dict(key=edition["key"], title=edition["seed"]["name"],
                    season=edition["seed"]["season"], firstAirDate=meta["first_air_date"],
                    identity=meta["broadcast_identity"], candidates=meta["candidate_keys"])
            related = [source_info(a) for a in related]
            known[str(page_id)] = dict(id=page_id, revision=obj["latest"]["id"], extractor=EXTRACTOR_REVISION,
                                       seeds=all_seeds, editions=list(current_editions.values()),
                                       unconfirmed=unconfirmed, related=related)
            emit("page", source=source, seeds=all_seeds, candidates=candidates, editions=editions,
                 removeEditions=remove, related=related)
        except ApiFailure as exc:
            for seed in group:
                results[tuple(candidate_identity(seed))] = "failed"
            emit("failed", seeds=group, message=str(exc), retryAfter=client.retry_after)
    return results


def main():
    instruction = json.load(sys.stdin)
    cache = Path(instruction["cache"])
    cache.mkdir(parents=True, exist_ok=True)
    client = Client(cache, Path(instruction["seedCache"]) if instruction.get("seedCache") else None,
                    Path(instruction["retainedCache"]) if instruction.get("retainedCache") else None,
                    instruction.get("requestAfter") or 0)
    try:
        if instruction["mode"] in ("discover", "discoverMany"):
            for entry in instruction.get("catalogs", [instruction]):
                try:
                    entries, sources = discover(client, entry["year"], entry.get("bangumi", []))
                except ApiFailure as exc:
                    emit("error", year=entry["year"], message=str(exc))
                else:
                    emit("discovered", year=entry["year"], entries=entries, sources=sources)
        else:
            process(client, instruction)
    except (ApiFailure, StopFetch) as exc:
        emit("error", message=str(exc), retryAfter=client.retry_after, stopBatch=isinstance(exc, StopFetch))
    finally:
        if client.stats["requests"]:
            emit("cooldown", requestAfter=client.request_deadline(time.monotonic()))
        emit("metrics", **dict(client.stats))


if __name__ == "__main__":
    main()
