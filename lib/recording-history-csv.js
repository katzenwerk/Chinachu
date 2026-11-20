'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const reservationStore = require('./reservation-store');
const matchDetailResolver = require('./match-detail-resolver');

const STATE_SCHEMA_VERSION = 1;
const FINALIZE_GRACE_MS = 5 * 60 * 1000;
const LOCK_TIMEOUT_MS = 250;
const HEADER = 'key,start,channel,title,result,remarks,recordedPath';
const LEGACY_HEADER = HEADER.replace(',remarks,', ',reason,');
const FILE_PATTERN = /^recording-history_\d{4}-(?:0[1-9]|1[0-2])\.csv$/;
const UPDATE_TIMEOUT_MS = 10000;

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
	return [row.key, row.start, row.channel, row.title, row.result, row.remarks, row.recordedPath]
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
		remarks: recordingRemarks(candidate, reason),
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

// CSV contents are authoritative history; never rebuild old rows from today's ledgers.
function readCsv(filePath) {
	const bytes = fs.readFileSync(filePath);
	let text, encoding = 'UTF-8';
	try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
	catch (_) {
		text = new TextDecoder('shift_jis', { fatal: true }).decode(bytes);
		encoding = 'CP932';
	}
	const parsed = parseCsvRows(text);
	const header = parsed.shift()?.join(',');
	if (![HEADER, LEGACY_HEADER].includes(header) || parsed.some(row => row.length !== 7 || !row[0]) ||
		new Set(parsed.map(row => row[0])).size !== parsed.length) {
		throw new Error('recording history CSV format is invalid: ' + path.basename(filePath));
	}
	return { rows: parsed, legacy: header === LEGACY_HEADER, encoding };
}

function listFiles(outputDir) {
	try { return fs.readdirSync(outputDir).filter(name => FILE_PATTERN.test(name)).sort().reverse(); }
	catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function readFile(outputDir, filename) {
	if (typeof filename !== 'string' || !FILE_PATTERN.test(filename)) {
		const error = new Error('invalid CSV filename'); error.statusCode = 400; throw error;
	}
	return readCsv(path.join(outputDir, filename));
}

function candidateFor(program, matches) {
	const key = makeKey(program);
	const linked = matches.filter(entry => matchDetailResolver.matchesRecordedProgram(entry, program));
	// An ambiguous link must not cause another recording's findings to be copied.
	if (!key || linked.length > 1 || linked.length !== matches.length) return null;
	const rawMatch = linked[0];
	const normalized = rawMatch && matchDetailResolver.normalizeMatchEntry(rawMatch);
	if (normalized?.deletion || normalized?.fileMissing || program.fileMissing ||
		program.deleted === true || program.cleanupState === 'deleted') return null;
	return { key, recorded: program, rawMatch, match: normalized };
}

function analysisFor(candidate) {
	const raw = candidate.rawMatch || {};
	const sources = [candidate.recorded, raw, raw.recordingResult, raw.recorded, raw.program].filter(Boolean);
	const analyses = sources.map(item => item.savedTsAnalysis).filter(value =>
		value?.result?.completed === true && ['NO_FINDINGS', 'SUSPECT'].includes(value.result.status) &&
		Number.isSafeInteger(value.result.ccErrorEvents) && value.result.ccErrorEvents >= 0);
	return analyses.sort((a, b) => Number(b.checkedAt || 0) - Number(a.checkedAt || 0))[0]?.result;
}

function recordingRemarks(candidate, previous = '') {
	const analysis = analysisFor(candidate);
	const recorded = candidate.recorded || {};
	const count = analysis ? analysis.ccErrorEvents : recorded.mirakurunDrop?.dropTotal;
	// Replace our DROP note, retaining the historical interruption and any other notes.
	const notes = stringValue(previous).split('、').filter(note => note && !/^DROPあり（\d+）$/.test(note));
	if (Number.isSafeInteger(count) && count > 0) notes.push('DROPあり（' + count + '）');
	else if (!analysis && count == null) {
		const previousDrop = stringValue(previous).split('、').find(note => /^DROPあり（\d+）$/.test(note));
		if (previousDrop) notes.push(previousDrop);
	}
	return [...new Set(notes)].join('、');
}

function withCurrentLedgers(options, callback, asynchronous = false) {
	const files = options.ledgerFiles;
	if (!files) return callback(options);
	// All CSV writers acquire the CSV lock first, then recorded -> match. Analysis
	// save hooks call us only AFTER releasing their ledger locks.
	const lock = asynchronous ? reservationStore.withLockAsync : reservationStore.withLock;
	return lock(files.recorded, () => lock(files.match, () => callback({
		...options,
		recordedList: reservationStore.readArray(files.recorded),
		matchList: reservationStore.readArray(files.match),
		recordingList: reservationStore.readArray(files.recording)
	}), { timeoutMs: 2000 }), { timeoutMs: 2000 });
}

function updateMonths(options, additions = []) {
	const byMonth = new Map();
	for (const item of additions) {
		const filename = 'recording-history_' + item.month + '.csv';
		if (!byMonth.has(filename)) byMonth.set(filename, []);
		byMonth.get(filename).push(item.row);
	}
	const active = new Set((options.recordingList || []).map(makeKey));
	const candidates = new Map();
	const matchesByKey = new Map();
	for (const raw of options.matchList || []) {
		const key = matchDetailResolver.normalizeMatchEntry(raw).key;
		if (!matchesByKey.has(key)) matchesByKey.set(key, []);
		matchesByKey.get(key).push(raw);
	}
	for (const program of options.recordedList || []) {
		const candidate = candidateFor(program, matchesByKey.get(makeKey(program)) || []);
		if (candidate && !active.has(candidate.key)) candidates.set(candidate.key, candidate);
	}
	const filenames = new Set([...listFiles(options.outputDir), ...byMonth.keys()]);
	const result = { appended: 0, updated: 0, files: [], errors: [], failedFiles: [] };
	for (const filename of filenames) {
		try {
			const filePath = path.join(options.outputDir, filename);
			let saved;
			try { saved = readCsv(filePath); }
			catch (error) { if (error.code !== 'ENOENT') throw error; saved = { rows: [], legacy: false, encoding: 'UTF-8' }; }
			const rows = saved.rows;
			let updated = 0;
			for (const row of rows) {
				const candidate = candidates.get(row[0]);
				if (!candidate || !['録画完了', '録画失敗'].includes(row[4])) continue;
				// Once migrated, only completed TS findings supplement a saved row.
				// Missing/failed analysis must not downgrade historical notes to Mirakurun.
				if (!saved.legacy && !analysisFor(candidate)) continue;
				// A different recording path must not overwrite the original history.
				if (row[6] && row[6] !== candidate.recorded.recorded) continue;
				const remarks = recordingRemarks(candidate, row[5]);
				if (remarks !== row[5]) { row[5] = remarks; updated++; }
			}
			const keys = new Set(rows.map(row => row[0]));
			const fresh = [];
			for (const row of byMonth.get(filename) || []) {
				if (!keys.has(row.key)) { fresh.push(row); keys.add(row.key); }
			}
			if (fresh.length || updated || saved.legacy) {
				const content = [HEADER, ...rows.map(row => row.map(csvField).join(',')), ...fresh.map(csvLine)].join('\n') + '\n';
				atomicWrite(filePath, content);
				result.files.push({ path: filePath, appended: fresh.length, updated });
			}
			result.appended += fresh.length;
			result.updated += updated;
		} catch (error) {
			// One unreadable month must not prevent independent months from saving.
			result.errors.push(filename + ': ' + error.message);
			result.failedFiles.push(filename);
		}
	}
	return result;
}

function exportHistory(options = {}) {
	if (options.enabled !== true) return { enabled: false, initialized: false, appended: 0, files: [] };
	const nowMs = positiveNumber(options.nowMs) || Date.now();
	if (!options.outputDir || !options.stateFile) throw new Error('outputDir and stateFile are required');
	fs.mkdirSync(path.dirname(options.stateFile), { recursive: true });
	return reservationStore.withLock(options.stateFile + '.update', () => {
		const activation = ensureActivationState(options.stateFile, nowMs);
		if (activation.initialized) return { enabled: true, initialized: true, enabledAt: activation.state.enabledAt, appended: 0, files: [] };
		return withCurrentLedgers(options, current => ({
			enabled: true, initialized: false, enabledAt: activation.state.enabledAt,
			...updateMonths(current, buildRows(current, activation.state.enabledAt))
		}));
	}, { timeoutMs: UPDATE_TIMEOUT_MS });
}

// Best-effort CSV supplementation cannot turn a successfully saved analysis into
// a failed analysis. Matching retries from the persisted ledgers on its next run.
async function refreshAnalysis(root, config) {
	if (config.recordingResultCsvEnabled !== true) return;
	const stateFile = path.join(root, 'data/recording-history-csv-state.json');
	try {
		try { readState(stateFile); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
		await reservationStore.withLockAsync(stateFile + '.update', () => withCurrentLedgers({
			outputDir: path.join(root, 'data/csv'),
			ledgerFiles: { recorded: path.join(root, 'data/recorded.json'), match: path.join(root, 'data/match.json'),
				recording: path.join(root, 'data/recording.json') }
		}, current => {
			const result = updateMonths(current);
			for (const error of result.errors) console.error('WARNING: recording history CSV update failed: ' + error);
		}, true), { timeoutMs: UPDATE_TIMEOUT_MS });
	} catch (error) { console.error('WARNING: recording history CSV update failed: ' + error.message); }
}

module.exports = {
	FINALIZE_GRACE_MS,
	HEADER,
	formatJstMinute,
	csvField,
	parseCsvRows,
	buildRows,
	determineRow,
	exportHistory,
	refreshAnalysis,
	listFiles,
	readFile
};
