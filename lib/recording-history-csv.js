'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const reservationStore = require('./reservation-store');
const matchDetailResolver = require('./match-detail-resolver');

const STATE_SCHEMA_VERSION = 1;
const FINALIZE_GRACE_MS = 5 * 60 * 1000;
const LOCK_TIMEOUT_MS = 250;
const HEADER = 'key,start,channel,title,result,reason,recordedPath';

function positiveNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : 0;
}

function stringValue(value) {
	return value === null || typeof value === 'undefined' ? '' : String(value);
}

function makeKey(program) {
	return matchDetailResolver.makeCanonicalKey(program);
}

function getEnd(program) {
	const start = positiveNumber(program && program.start);
	const seconds = positiveNumber(program && program.seconds);
	return positiveNumber(program && program.end) || (start && seconds ? start + seconds * 1000 : 0);
}

function jstParts(timestamp) {
	const date = new Date(timestamp + 9 * 60 * 60 * 1000);
	return {
		year: String(date.getUTCFullYear()),
		month: String(date.getUTCMonth() + 1).padStart(2, '0'),
		day: String(date.getUTCDate()).padStart(2, '0'),
		hour: String(date.getUTCHours()).padStart(2, '0'),
		minute: String(date.getUTCMinutes()).padStart(2, '0')
	};
}

function jstDateKey(timestamp) {
	const parts = jstParts(timestamp);
	return parts.year + '-' + parts.month + '-' + parts.day;
}

function jstMonthKey(timestamp) {
	const parts = jstParts(timestamp);
	return parts.year + '-' + parts.month;
}

function formatJstMinute(timestamp) {
	const parts = jstParts(timestamp);
	return parts.year + '/' + parts.month + '/' + parts.day + ' ' + parts.hour + ':' + parts.minute;
}

function csvField(value) {
	const text = stringValue(value);
	return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function csvLine(row) {
	return [row.key, row.start, row.channel, row.title, row.result, row.reason, row.recordedPath]
		.map(csvField).join(',');
}

function parseCsvRows(text) {
	const rows = [];
	let row = [];
	let field = '';
	let quoted = false;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (quoted) {
			if (char === '"' && text[i + 1] === '"') {
				field += '"';
				i++;
			} else if (char === '"') {
				quoted = false;
			} else {
				field += char;
			}
		} else if (char === '"') {
			quoted = true;
		} else if (char === ',') {
			row.push(field);
			field = '';
		} else if (char === '\n') {
			row.push(field.replace(/\r$/, ''));
			rows.push(row);
			row = [];
			field = '';
		} else {
			field += char;
		}
	}

	if (quoted) throw new Error('unterminated quoted CSV field');
	if (field !== '' || row.length > 0) {
		row.push(field.replace(/\r$/, ''));
		rows.push(row);
	}
	return rows;
}

function atomicWrite(filePath, content) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const temporary = filePath + '.tmp-' + process.pid + '-' + crypto.randomBytes(8).toString('hex');
	let mode = 0o600;
	let fd;
	try {
		try { mode = fs.statSync(filePath).mode & 0o777; } catch (_) {}
		fd = fs.openSync(temporary, 'wx', mode);
		fs.writeFileSync(fd, content, 'utf8');
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		fs.renameSync(temporary, filePath);
		try {
			const directoryFd = fs.openSync(path.dirname(filePath), 'r');
			try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
		} catch (_) {}
	} catch (error) {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch (_) {}
		}
		try { fs.unlinkSync(temporary); } catch (_) {}
		throw error;
	}
}

function readState(stateFile) {
	const value = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
	if (!value || value.schemaVersion !== STATE_SCHEMA_VERSION || !positiveNumber(value.enabledAt)) {
		throw new Error('recording history CSV state is invalid');
	}
	return value;
}

function ensureActivationState(stateFile, nowMs) {
	fs.mkdirSync(path.dirname(stateFile), { recursive: true });
	return reservationStore.withLock(stateFile, function () {
		if (fs.existsSync(stateFile)) {
			return { initialized: false, state: readState(stateFile) };
		}
		const state = { schemaVersion: STATE_SCHEMA_VERSION, enabledAt: nowMs };
		atomicWrite(stateFile, JSON.stringify(state));
		return { initialized: true, state };
	}, { timeoutMs: LOCK_TIMEOUT_MS });
}

function abnormalMetadata(recorded, rawMatch) {
	const legacyResult = rawMatch && (rawMatch.recordingResult || rawMatch.recorded) || {};
	const snapshot = legacyResult.snapshot && typeof legacyResult.snapshot === 'object' ? legacyResult.snapshot : {};
	const sources = [recorded || {}, legacyResult, snapshot, rawMatch && rawMatch.program || {}];
	const source = sources.find(item => item && (item.operatorAbort === true || item.operatorEndLack === true));
	if (!source) return null;
	const reason = stringValue(source.operatorAbortReason || source.operatorEndLackReason);
	return {
		reason: /LOW STORAGE/i.test(reason) ? '容量不足' : '中断'
	};
}

function determineRow(candidate, nowMs) {
	const normalized = candidate.match;
	const reserve = candidate.reserve;
	const recorded = candidate.recorded;
	const rawMatch = candidate.rawMatch;
	const active = candidate.active;
	const start = positiveNumber(recorded && recorded.start) || positiveNumber(reserve && reserve.start) ||
		positiveNumber(normalized && normalized.start);
	const end = getEnd(recorded) || getEnd(reserve) || positiveNumber(normalized && normalized.end);
	const status = stringValue(normalized && normalized.status);
	const hasRecordingEvidence = Boolean(recorded || normalized && normalized.recording ||
		status === 'RECORDED' || status === 'RECORDED_UNTRACKED');

	if (!start || !end || active) return null;
	if (reserve && reserve.isSkip === true || status === 'SKIPPED_ONLY') {
		return buildRow(candidate, start, 'スキップ', '');
	}

	const abnormal = abnormalMetadata(recorded, rawMatch);
	if (hasRecordingEvidence && abnormal) {
		return buildRow(candidate, start, '録画失敗', abnormal.reason);
	}
	if (hasRecordingEvidence) {
		return buildRow(candidate, start, '録画完了', '');
	}
	if (status === 'MISSED' || status === 'RESERVED' && reserve && nowMs >= end + FINALIZE_GRACE_MS) {
		return buildRow(candidate, start, '録画漏れ', '');
	}
	return null;
}

function buildRow(candidate, start, result, reason) {
	const source = candidate.recorded || candidate.reserve || {};
	const normalized = candidate.match || {};
	const channel = source.channel || {};
	return {
		key: candidate.key,
		start: formatJstMinute(start),
		channel: stringValue(channel.name || source.channelName),
		title: stringValue(source.fullTitle || source.title || normalized.fullTitle),
		result,
		reason,
		recordedPath: stringValue(candidate.recorded && candidate.recorded.recorded)
	};
}

function indexByKey(list) {
	const output = new Map();
	(list || []).forEach(item => {
		const key = makeKey(item);
		if (key) output.set(key, item);
	});
	return output;
}

function buildRows(options, enabledAt) {
	const nowMs = positiveNumber(options.nowMs) || Date.now();
	const reserves = indexByKey(options.reserves2List);
	const recorded = indexByKey(options.recordedList);
	const active = indexByKey(options.recordingList);
	const matches = new Map();
	(options.matchList || []).forEach(entry => {
		const normalized = matchDetailResolver.normalizeMatchEntry(entry);
		if (normalized.key) matches.set(normalized.key, { normalized, raw: entry });
	});

	const allKeys = new Set([...reserves.keys(), ...recorded.keys()]);
	const latestEndByDay = new Map();
	const activeDays = new Set();
	allKeys.forEach(key => {
		const reserve = reserves.get(key);
		const item = recorded.get(key) || reserve;
		const start = positiveNumber(item && item.start);
		const end = getEnd(item);
		if (!start || !end) return;
		const day = jstDateKey(start);
		latestEndByDay.set(day, Math.max(latestEndByDay.get(day) || 0, end));
		if (active.has(key)) activeDays.add(day);
	});

	const rows = [];
	allKeys.forEach(key => {
		const reserve = reserves.get(key);
		const recordedEntry = recorded.get(key);
		const matchEntry = matches.get(key);
		const start = positiveNumber(recordedEntry && recordedEntry.start) || positiveNumber(reserve && reserve.start) ||
			positiveNumber(matchEntry && matchEntry.normalized.start);
		if (!start || start < enabledAt) return;
		const day = jstDateKey(start);
		if (activeDays.has(day) || nowMs < (latestEndByDay.get(day) || 0) + FINALIZE_GRACE_MS) return;
		const row = determineRow({
			key,
			reserve,
			recorded: recordedEntry,
			match: matchEntry && matchEntry.normalized,
			rawMatch: matchEntry && matchEntry.raw,
			active: active.has(key)
		}, nowMs);
		if (row) rows.push({ month: jstMonthKey(start), startMs: start, row });
	});

	return rows.sort((a, b) => a.startMs - b.startMs || a.row.key.localeCompare(b.row.key));
}

function appendMonthRows(filePath, rows) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	return reservationStore.withLock(filePath, function () {
		let content = '';
		let keys = new Set();
		if (fs.existsSync(filePath)) {
			content = fs.readFileSync(filePath, 'utf8');
			const parsed = parseCsvRows(content);
			if (!parsed[0] || parsed[0].join(',') !== HEADER) {
				throw new Error('recording history CSV header is invalid: ' + filePath);
			}
			keys = new Set(parsed.slice(1).map(row => row[0]).filter(Boolean));
		} else {
			content = HEADER + '\n';
		}

		const additions = rows.filter(item => !keys.has(item.key));
		if (additions.length === 0) return 0;
		const prefix = content === '' || content.endsWith('\n') ? content : content + '\n';
		atomicWrite(filePath, prefix + additions.map(csvLine).join('\n') + '\n');
		return additions.length;
	}, { timeoutMs: LOCK_TIMEOUT_MS });
}

function exportHistory(options) {
	options = options || {};
	if (options.enabled !== true) return { enabled: false, initialized: false, appended: 0, files: [] };
	const nowMs = positiveNumber(options.nowMs) || Date.now();
	const outputDir = options.outputDir;
	const stateFile = options.stateFile;
	if (!outputDir || !stateFile) throw new Error('outputDir and stateFile are required');

	const activation = ensureActivationState(stateFile, nowMs);
	if (activation.initialized) {
		return { enabled: true, initialized: true, enabledAt: activation.state.enabledAt, appended: 0, files: [] };
	}

	const rows = buildRows(options, activation.state.enabledAt);
	const byMonth = new Map();
	rows.forEach(item => {
		if (!byMonth.has(item.month)) byMonth.set(item.month, []);
		byMonth.get(item.month).push(item.row);
	});
	let appended = 0;
	const files = [];
	byMonth.forEach((monthRows, month) => {
		const filePath = path.join(outputDir, 'recording-history_' + month + '.csv');
		const count = appendMonthRows(filePath, monthRows);
		if (count > 0) files.push({ path: filePath, appended: count });
		appended += count;
	});
	return { enabled: true, initialized: false, enabledAt: activation.state.enabledAt, appended, files };
}

module.exports = {
	FINALIZE_GRACE_MS,
	HEADER,
	formatJstMinute,
	csvField,
	parseCsvRows,
	buildRows,
	determineRow,
	exportHistory
};
