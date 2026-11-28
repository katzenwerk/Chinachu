'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const reservationStore = require('./reservation-store');
const matchDetailResolver = require('./match-detail-resolver');

const STATE_SCHEMA_VERSION = 1;
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

	if (!start || !end || start > nowMs || active || recorded?.pid || recorded?.operatorResumePending ||
		recorded?._operatorHistoryPending || recorded?._operatorFilenameFinalTarget) return null;
	if (hasRecordingEvidence) {
		// MATCH can retain a recorded status from a provisional resume row. A
		// new recording result needs the finalized recorded-ledger entry itself.
		if (!recorded) return null;
		if (nowMs < (positiveNumber(recorded?.operatorRecordingEnd) || end)) return null;
		const abnormal = abnormalMetadata(recorded, rawMatch);
		return abnormal ? buildRow(candidate, start, '録画失敗', abnormal.reason) : buildRow(candidate, start, '録画完了', '');
	}
	if (nowMs >= end && (reserve?.isSkip === true || status === 'SKIPPED_ONLY')) {
		return buildRow(candidate, start, 'スキップ', '');
	}
	if (nowMs > end && status === 'MISSED') {
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
	const rows = [];
	allKeys.forEach(key => {
		const reserve = reserves.get(key);
		const recordedEntry = recorded.get(key);
		const matchEntry = matches.get(key);
		const start = positiveNumber(recordedEntry && recordedEntry.start) || positiveNumber(reserve && reserve.start) ||
			positiveNumber(matchEntry && matchEntry.normalized.start);
		if (!start || start < enabledAt) return;
		const row = determineRow({
			key,
			reserve,
			recorded: recordedEntry,
			match: matchEntry && matchEntry.normalized,
			rawMatch: matchEntry && (!recordedEntry || matchDetailResolver.matchesRecordedProgram(matchEntry.raw, recordedEntry)) ?
				matchEntry.raw : null,
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
	return analyses.sort((a, b) => Number(b.checkedAt || 0) - Number(a.checkedAt || 0))[0];
}

function recordingRemarks(candidate, previous = '', analysis = analysisFor(candidate)) {
	const recorded = candidate.recorded || {};
	const count = analysis ? analysis.result.ccErrorEvents : recorded.mirakurunDrop?.dropTotal;
	// Replace our DROP note, retaining the historical interruption and any other notes.
	const isDropNote = note => /^DROPあり（\d+）$/.test(note);
	const notes = stringValue(previous).split('、').filter(note => note && (!analysis || !isDropNote(note)));
	if (!notes.some(isDropNote) && Number.isSafeInteger(count) && count > 0) notes.push('DROPあり（' + count + '）');
	return [...new Set(notes)].join('、');
}

function readCurrentLedgers(options, asynchronous = false) {
	const files = options.ledgerFiles;
	if (!files) return options;
	// All CSV writers acquire the CSV lock first, then recorded -> match. Analysis
	// save hooks call us only AFTER releasing their ledger locks. Release the
	// ledger locks as soon as the snapshots have been read.
	const lock = asynchronous ? reservationStore.withLockAsync : reservationStore.withLock;
	return lock(files.recorded, () => lock(files.match, () => ({
		...options,
		recordingList: reservationStore.readArray(files.recording),
		recordedList: reservationStore.readArray(files.recorded),
		matchList: reservationStore.readArray(files.match)
	}), { timeoutMs: 2000 }), { timeoutMs: 2000 });
}

function matchesHistoryPath(previousPath, program, analysis, root) {
	if (!previousPath || previousPath === program.recorded) return true;
	if (!root || !program.recorded) return false;
	const original = path.resolve(root, previousPath);
	const current = path.resolve(root, program.recorded);
	if (original === current) return true;
	// A verified folder move retains the registration path and changes only the
	// path in the file fingerprint. A new analysis alone cannot prove a move.
	return analysis && analysis === program.savedTsAnalysis && typeof analysis.registeredPath === 'string' && typeof analysis.file?.path === 'string' &&
		path.resolve(root, analysis.registeredPath) === original && path.resolve(root, analysis.file.path) === current &&
		['dev', 'ino', 'size', 'mtimeMs'].every(key => Number.isFinite(analysis.file[key]));
}

function updateMonths(options, additions = [], limitedFiles) {
	const byMonth = new Map();
	for (const item of additions) {
		const filename = 'recording-history_' + item.month + '.csv';
		if (!byMonth.has(filename)) byMonth.set(filename, []);
		byMonth.get(filename).push(item.row);
	}
	const active = new Set((options.recordingList || []).map(makeKey));
	const candidates = new Map();
	const ambiguous = new Set();
	const matchesByKey = new Map();
	for (const raw of options.matchList || []) {
		const key = matchDetailResolver.normalizeMatchEntry(raw).key;
		if (!matchesByKey.has(key)) matchesByKey.set(key, []);
		matchesByKey.get(key).push(raw);
	}
	for (const program of options.recordedList || []) {
		const candidate = candidateFor(program, matchesByKey.get(makeKey(program)) || []);
		if (!candidate || active.has(candidate.key) || program.operatorResumePending || program.pid || ambiguous.has(candidate.key)) continue;
		if (candidates.has(candidate.key)) {
			candidates.delete(candidate.key);
			ambiguous.add(candidate.key);
		} else candidates.set(candidate.key, candidate);
	}
	const filenames = new Set([...(limitedFiles || listFiles(options.outputDir)), ...byMonth.keys()]);
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
				const analysis = analysisFor(candidate);
				if (!saved.legacy && !analysis) continue;
				if (!matchesHistoryPath(row[6], candidate.recorded, analysis, options.root)) continue;
				const remarks = recordingRemarks(candidate, row[5], analysis);
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

function withActivation(options, callback) {
	if (options.enabled !== true) return { enabled: false, initialized: false, appended: 0, files: [] };
	const nowMs = positiveNumber(options.nowMs) || Date.now();
	if (!options.outputDir || !options.stateFile) throw new Error('outputDir and stateFile are required');
	fs.mkdirSync(path.dirname(options.stateFile), { recursive: true });
	return reservationStore.withLock(options.stateFile + '.update', () => {
		const activation = ensureActivationState(options.stateFile, nowMs);
		if (activation.initialized) return { enabled: true, initialized: true, enabledAt: activation.state.enabledAt, appended: 0, files: [] };
		return {
			enabled: true, initialized: false, enabledAt: activation.state.enabledAt,
			...callback(activation.state.enabledAt)
		};
	}, { timeoutMs: UPDATE_TIMEOUT_MS });
}

function exportHistory(options = {}) {
	return withActivation(options, enabledAt => {
		const current = readCurrentLedgers(options);
		const pendingRecordingKeys = (current.recordingList || [])
			.filter(program => positiveNumber(program?.start) >= enabledAt).map(makeKey).filter(Boolean);
		return { ...updateMonths(current, buildRows(current, enabledAt)), pendingRecordingKeys };
	});
}

function completedRecordingEntry(program, nowMs = Date.now()) {
	const key = makeKey(program);
	const row = key && determineRow({ key, recorded: program }, nowMs);
	return row ? { month: jstMonthKey(program.start), startMs: Number(program.start), row } : null;
}

function exportRecording(options, entry) {
	return withActivation(options, enabledAt => updateMonths(options,
		entry && entry.startMs >= enabledAt ? [entry] : [], []));
}

function historyPaths(root) {
	return { root, outputDir: path.join(root, 'data/csv'),
		stateFile: path.join(root, 'data/recording-history-csv-state.json') };
}

function logErrors(result) {
	for (const error of result.errors || []) console.error('WARNING: recording history CSV update failed: ' + error);
}

// Best-effort CSV supplementation cannot turn a successfully saved analysis into
// a failed analysis. Matching retries from the persisted ledgers on its next run.
async function refreshAnalysis(root, config, program) {
	const key = makeKey(program);
	if (config.recordingResultCsvEnabled !== true || !key) return;
	const options = historyPaths(root);
	const { stateFile } = options;
	try {
		let activation;
		try { activation = readState(stateFile); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
		await reservationStore.withLockAsync(stateFile + '.update', async () => {
			const current = await readCurrentLedgers({ ...options,
				ledgerFiles: { recorded: path.join(root, 'data/recorded.json'), match: path.join(root, 'data/match.json'),
					recording: path.join(root, 'data/recording.json') }
			}, true);
			// Include every row for this key so an ambiguous match or recording still blocks supplementation.
			current.recordedList = current.recordedList.filter(item => makeKey(item) === key);
			if (!current.recordedList.some(item => item.id === program.id &&
				matchesHistoryPath(program.recorded, item, item.savedTsAnalysis, root))) return;
			current.matchList = current.matchList.filter(item => matchDetailResolver.normalizeMatchEntry(item).key === key);
			// Analysis may win the CSV lock before the recording-finish writer.
			const additions = current.recordedList.length === 1 && candidateFor(current.recordedList[0], current.matchList) ?
				buildRows(current, activation.enabledAt) : [];
			logErrors(updateMonths(current, additions, ['recording-history_' + jstMonthKey(program.start) + '.csv']));
		}, { timeoutMs: UPDATE_TIMEOUT_MS });
	} catch (error) { console.error('WARNING: recording history CSV update failed: ' + error.message); }
}

if (require.main === module) {
	try {
		try { require('os').setPriority(0, 19); } catch (_) {}
		const entry = JSON.parse(process.argv[3]);
		const result = exportRecording({ ...historyPaths(path.resolve(process.argv[2])), enabled: true }, entry);
		logErrors(result);
		if (result.errors?.length) process.exitCode = 1;
	} catch (error) {
		console.error('WARNING: recording history CSV update failed: ' + error.message);
		process.exitCode = 1;
	}
}

module.exports = {
	HEADER,
	formatJstMinute,
	csvField,
	parseCsvRows,
	buildRows,
	determineRow,
	exportHistory,
	completedRecordingEntry,
	exportRecording,
	refreshAnalysis,
	listFiles,
	readFile
};
