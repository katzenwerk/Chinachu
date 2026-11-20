#!/usr/bin/env node
"use strict";

var fs = require("fs");
var path = require("path");
var reservationStore = require("./lib/reservation-store");
var matchDetailResolver = require("./lib/match-detail-resolver");
var matchV2 = require("./lib/match-v2");
var recordingHistoryCsv = require("./lib/recording-history-csv");
var MS_PER_DAY = 24 * 60 * 60 * 1000;
var JST_OFFSET_MS = 9 * 60 * 60 * 1000;
var DEFAULT_KEEP_MONTHS = 3;
var DEFAULT_RETENTION_DAYS = 365;
var DEFAULT_READ_DAYS = 14;

function safeInt(value, defaultValue) {
	if (typeof defaultValue === "undefined") {
		defaultValue = 0;
	}

	var n = parseInt(value, 10);
	return isNaN(n) ? defaultValue : n;
}

function safeBool(value) {
	return value == null ? false : !!value;
}

function readConfigFile(file) {
	if (!file || !fs.existsSync(file)) {
		return {};
	}

	try {
		return JSON.parse(fs.readFileSync(file, { encoding: "utf8" }).replace(/^\uFEFF/, "") || "{}");
	} catch (error) {
		console.error("WARNING: invalid config ignored: " + file + " (" + error.message + ")");
		return {};
	}
}

function getRetentionDays(config, name, defaultDays) {
	var value = config && typeof config === "object" ? Number(config[name]) : NaN;

	if (!Number.isFinite(value)) {
		return defaultDays;
	}

	value = Math.floor(value);

	if (value < 0) {
		return defaultDays;
	}

	return value;
}

function cloneJson(value) {
	if (value == null || typeof value !== "object") {
		return value;
	}

	return JSON.parse(JSON.stringify(value));
}

function getChannelId(program) {
	var channel = program && program.channel || {};
	return channel.id || program && program.channelId || "";
}

function makeCanonicalKeyFromFields(channelId, startMs, seconds) {
	return [
		channelId || "",
		safeInt(startMs, 0),
		safeInt(seconds, 0)
	].join("|");
}

function makeCanonicalKey(program) {
	var channelId = getChannelId(program);
	var start = safeInt(program && program.start, 0);
	var seconds = safeInt(program && program.seconds, 0);

	if (!channelId || !start || !seconds) {
		return "";
	}

	return makeCanonicalKeyFromFields(channelId, start, seconds);
}

function makeKeyFromRecorded(program) {
	return makeCanonicalKey(program) || makeCanonicalKeyFromFields(
		getChannelId(program),
		program && program.start,
		program && program.seconds
	);
}

function getReserves2FallbackKey(entry) {
	var key = entry && entry.key;
	return typeof key === "string" && key ? key : "";
}

function getReserves2LookupKey(entry, stats) {
	var canonicalKey = makeCanonicalKey(entry);
	var fallbackKey = getReserves2FallbackKey(entry);

	if (canonicalKey) {
		if (fallbackKey && fallbackKey !== canonicalKey && stats) {
			stats.reserves2KeyMismatch += 1;
			if (!stats.reserves2KeyMismatchSample) {
				stats.reserves2KeyMismatchSample = {
					canonicalKey: canonicalKey,
					reserves2Key: fallbackKey,
					title: entry && entry.title || ""
				};
			}
		}

		return canonicalKey;
	}

	if (fallbackKey && stats) {
		stats.reserves2KeyFallback += 1;
		if (!stats.reserves2KeyFallbackSample) {
			stats.reserves2KeyFallbackSample = {
				reserves2Key: fallbackKey,
				title: entry && entry.title || ""
			};
		}
	}

	return fallbackKey;
}

function getReserves2SnapshotAt(entry) {
	var updatedAt = safeInt(entry && entry.updatedAt, 0);
	if (updatedAt > 0) {
		return updatedAt;
	}

	return safeInt(entry && entry.snapshotAt, 0);
}

function getMatchEntryStartMs(entry) {
	var program = entry && entry.program;
	var recordingResult = entry && entry.recordingResult;
	var recorded = entry && entry.recorded;
	var reserve = entry && entry.reserve;
	var start;

	start = safeInt(entry && entry.start, 0);
	if (start > 0) {
		return start;
	}

	if (program && typeof program === "object") {
		start = safeInt(program.start, 0);
		if (start > 0) {
			return start;
		}
	}

	if (recordingResult && typeof recordingResult === "object") {
		start = safeInt(recordingResult.start, 0);
		if (start > 0) {
			return start;
		}
	}

	if (recorded && typeof recorded === "object") {
		start = safeInt(recorded.start, 0);
		if (start > 0) {
			return start;
		}
	}

	if (reserve && typeof reserve === "object") {
		start = safeInt(reserve.start, 0);
		if (start > 0) {
			return start;
		}
	}

	return 0;
}

function getMatchEntryKey(entry) {
	var program = entry && entry.program;
	var recordingResult = entry && entry.recordingResult;
	var recorded = entry && entry.recorded;
	var reserve = entry && entry.reserve;
	var key;

	if (program && typeof program === "object") {
		key = makeCanonicalKey(program);
		if (key) {
			return key;
		}
	}

	if (recorded && typeof recorded === "object") {
		key = makeCanonicalKey(recorded);
		if (key) {
			return key;
		}
	}

	if (reserve && typeof reserve === "object") {
		key = makeCanonicalKey(reserve);
		if (key) {
			return key;
		}
	}

	if (recordingResult && typeof recordingResult === "object") {
		key = makeCanonicalKeyFromFields(entry && entry.channel && entry.channel.id || "", recordingResult.start, recordingResult.seconds);
		if (key !== "|0|0") {
			return key;
		}
	}

	key = entry && entry.key;
	return typeof key === "string" && key ? key : "";
}

function withCanonicalMatchKey(entry, key) {
	if (!key || entry.key === key) {
		return entry;
	}

	var output = Object.assign({}, entry);
	output.key = key;
	return output;
}

function hasRecordedEvidence(entry) {
	var recorded = entry && entry.recorded;
	var recordingResult = entry && entry.recordingResult;
	var recording = entry && entry.recording;

	if (recording && typeof recording === "object" && !!recording.recordedId) return true;
	if (recorded && typeof recorded === "object" && (recorded.id || recorded.recordedId || safeInt(recorded.start, 0) > 0)) return true;
	if (recordingResult && typeof recordingResult === "object" && (recordingResult.id || recordingResult.recordedId)) return true;

	return false;
}

function isRecordedStatus(status) {
	return status === "RECORDED" || status === "RECORDED_UNTRACKED";
}

function isClearlyDifferentRecording(oldEntry, newEntry) {
	var oldValue = matchDetailResolver.normalizeMatchEntry(oldEntry);
	var newValue = matchDetailResolver.normalizeMatchEntry(newEntry);
	var oldId = (oldValue.recording || oldValue.fileMissing || {}).recordedId;
	var newId = (newValue.recording || newValue.fileMissing || {}).recordedId;

	return !!(oldId && newId && oldId !== newId);
}

function isSameRecordedEntry(oldEntry, newEntry) {
	var oldValue = matchDetailResolver.normalizeMatchEntry(oldEntry);
	var newValue = matchDetailResolver.normalizeMatchEntry(newEntry);
	var oldId = (oldValue.recording || oldValue.fileMissing || {}).recordedId;
	var newId = (newValue.recording || newValue.fileMissing || {}).recordedId;

	return !!(oldValue.key && newValue.key && oldValue.key === newValue.key && oldId && newId && oldId === newId);
}

function canRecoverRecordedMissing(oldEntry, newEntry, options) {
	var oldValue = matchDetailResolver.normalizeMatchEntry(oldEntry);
	return !!(oldValue.deletion && oldValue.deletion.reason === "recorded-missing" &&
		options && options.recordedReadOk === true && isSameRecordedEntry(oldEntry, newEntry));
}

function preserveDeletion(oldEntry, newEntry, options) {
	var oldValue = matchDetailResolver.normalizeMatchEntry(oldEntry);
	var output;

	if (!oldValue.deletion || Number(newEntry && newEntry.schemaVersion) !== matchV2.SCHEMA_VERSION) {
		return newEntry;
	}
	if (canRecoverRecordedMissing(oldEntry, newEntry, options)) {
		return newEntry;
	}

	output = Object.assign({}, newEntry);
	output.deletion = cloneJson(oldValue.deletion);
	return output;
}

function mergeOldNew(oldEntry, newEntry, logger, config, options) {
	var missingFact = matchDetailResolver.normalizeMatchEntry(oldEntry).fileMissing;
	if ((missingFact || matchDetailResolver.isExplicitDeletion(oldEntry)) && isClearlyDifferentRecording(oldEntry, newEntry)) return newEntry;
	if (missingFact && !isClearlyDifferentRecording(oldEntry, newEntry) && !matchDetailResolver.sameRecordingTarget(missingFact, matchDetailResolver.normalizeMatchEntry(newEntry).recording)) return oldEntry;
	// Confirmed deletion is terminal for this recording, not for a later distinct recording.
	if (matchDetailResolver.isExplicitDeletion(oldEntry) && !isClearlyDifferentRecording(oldEntry, newEntry)) {
		var deletedEntry = Object.assign({}, oldEntry); delete deletedEntry.fileMissing; return deletedEntry;
	}
	var oldRuleUid = matchDetailResolver.normalizeMatchEntry(oldEntry).ruleUid;
	if (Number(newEntry && newEntry.schemaVersion) === matchV2.SCHEMA_VERSION &&
		!newEntry.ruleUid && oldRuleUid) {
		newEntry = Object.assign({}, newEntry, { ruleUid: oldRuleUid });
	}

	if (isRecordedStatus(oldEntry.status) && isRecordedStatus(newEntry.status)) {
		var oldDeletion = matchDetailResolver.normalizeMatchEntry(oldEntry).deletion;
		// A missing ledger reference cannot be recovered by a different recording ID.
		if (oldDeletion && oldDeletion.reason === "recorded-missing" &&
			isClearlyDifferentRecording(oldEntry, newEntry)) {
			return oldEntry;
		}
		if (!isClearlyDifferentRecording(oldEntry, newEntry)) {
			var continuedEntry = preserveDeletion(oldEntry, newEntry, options);
			var oldMissing = matchDetailResolver.normalizeMatchEntry(oldEntry).fileMissing;
			if (oldMissing && isSameRecordedEntry(oldEntry, continuedEntry)) {
				continuedEntry = Object.assign({}, continuedEntry, { fileMissing: cloneJson(oldMissing) });
			} else { delete continuedEntry.fileMissing; }
			if (Number(continuedEntry.schemaVersion) === matchV2.SCHEMA_VERSION &&
				oldEntry.status === "RECORDED" && continuedEntry.status === "RECORDED_UNTRACKED") {
				continuedEntry = Object.assign({}, continuedEntry, { status: "RECORDED" });
			}
			return continuedEntry;
		}

		if (logger) {
			logger("NEW_RECORDED_EVENT: " + (matchDetailResolver.normalizeMatchEntry(oldEntry).recording || {}).recordedId +
				" -> " + (matchDetailResolver.normalizeMatchEntry(newEntry).recording || {}).recordedId);
		}
		return newEntry;
	}

	if (isRecordedStatus(oldEntry.status) && !hasRecordedEvidence(newEntry)) {
		if (logger) {
			logger("KEEP_RECORDED_STATUS: " + oldEntry.status + " over " + newEntry.status);
		}
		return oldEntry;
	}

	if (newEntry.status === "RECORDED") {
		return newEntry;
	}

	return newEntry;
}

function getJstParts(ms) {
	var date = new Date(ms + JST_OFFSET_MS);

	return {
		year: date.getUTCFullYear(),
		month: date.getUTCMonth() + 1,
		day: date.getUTCDate(),
		hour: date.getUTCHours(),
		minute: date.getUTCMinutes(),
		second: date.getUTCSeconds()
	};
}

function jstDateToMs(year, month, day, hour, minute, second) {
	return Date.UTC(year, month - 1, day, hour - 9, minute, second, 0);
}

function monthStartNMonthsAgoMs(nowMs, monthsAgo) {
	var parts = getJstParts(nowMs);
	var year = parts.year;
	var month = parts.month - monthsAgo;

	while (month <= 0) {
		year -= 1;
		month += 12;
	}

	return jstDateToMs(year, month, 1, 0, 0, 0);
}

function dayStartNDaysAgoMs(nowMs, daysAgo) {
	var parts = getJstParts(nowMs);
	return jstDateToMs(parts.year, parts.month, parts.day, 0, 0, 0) - daysAgo * MS_PER_DAY;
}

function pad2(value) {
	return String(value < 10 ? "0" + value : value);
}

function formatJstMinute(ms) {
	var parts = getJstParts(ms);

	return [
		parts.year,
		"-",
		pad2(parts.month),
		"-",
		pad2(parts.day),
		" ",
		pad2(parts.hour),
		":",
		pad2(parts.minute)
	].join("");
}

function buildMatchItem(status, key, recorded, reserve, hasRecorded) {
	var startSource, start, seconds, end, recording;
	startSource = recorded && typeof recorded === "object" ? recorded : reserve || {};
	start = safeInt(startSource.start, 0);
	seconds = safeInt(startSource.seconds, 0);
	end = safeInt(startSource.end, 0) || (start && seconds ? start + seconds * 1000 : 0);
	recording = hasRecorded ? {
		recordedId: recorded && (recorded.id || recorded.recordedId || recorded.origId || recorded.programId) || null
	} : null;

	return {
		schemaVersion: matchV2.SCHEMA_VERSION,
		key: key,
		status: status,
		start: start,
		end: end,
		fullTitle: recorded && (recorded.fullTitle || recorded.title) ||
			reserve && (reserve.fullTitle || reserve.title) || "",
		ruleUid: reserve && reserve.ruleUid || recorded && recorded.ruleUid || null,
		recording: recording,
		savedTsAnalysis: recorded && recorded.savedTsAnalysis || undefined,
		recordedDurationSeconds: recorded && recorded.recordedDurationSeconds || undefined,
		deletion: null
	};
}

function buildMatchLedger(options) {
	options = options || {};

	var oldResults = Array.isArray(options.oldResults) ? options.oldResults : [];
	var recordedAll = Array.isArray(options.recordedList) ? options.recordedList : [];
	var reserves2All = Array.isArray(options.reserves2List) ? options.reserves2List : [];
	var nowMs = safeInt(options.nowMs, Date.now());
	var keepDays = safeInt(options.keepDays, DEFAULT_RETENTION_DAYS);
	var keepMonths = safeInt(options.keepMonths, DEFAULT_KEEP_MONTHS);
	var readDays = safeInt(options.readDays, DEFAULT_READ_DAYS);
	var config = options.config || {};
	var initialBuild = !!options.initialBuild;
	var logger = options.logger || null;
	var stats = {
		reserves2KeyFallback: 0,
		reserves2KeyFallbackSample: null,
		reserves2KeyMismatch: 0,
		reserves2KeyMismatchSample: null
	};

	var keepCutoffMs = initialBuild || keepDays === 0 ? 0 : dayStartNDaysAgoMs(nowMs, keepDays);
	var updateCutoffMs = initialBuild ? 0 : dayStartNDaysAgoMs(nowMs, readDays);

	if (initialBuild) {
		oldResults = [];
	} else {
		oldResults = oldResults.filter(function (entry) {
			return getMatchEntryStartMs(entry) >= keepCutoffMs;
		});
	}

	var oldByKey = {};
	oldResults.forEach(function (entry) {
		var key = getMatchEntryKey(entry);

		if (key) {
			oldByKey[key] = withCanonicalMatchKey(entry, key);
		}
	});

	var recordedKeep = initialBuild ? recordedAll.slice() : recordedAll.filter(function (program) {
		return safeInt(program && program.start, 0) >= keepCutoffMs;
	});

	var reserves2Keep = initialBuild ? reserves2All.slice() : reserves2All.filter(function (program) {
		return safeInt(program && program.start, 0) >= keepCutoffMs;
	});

	var recordedWindow = initialBuild ? recordedKeep.slice() : recordedKeep.filter(function (program) {
		return safeInt(program && program.start, 0) >= updateCutoffMs;
	});

	var reserves2Window = initialBuild ? reserves2Keep.slice() : reserves2Keep.filter(function (program) {
		return safeInt(program && program.start, 0) >= updateCutoffMs;
	});

	var reserves2ByKey = {};

	reserves2Window.forEach(function (entry) {
		var key = getReserves2LookupKey(entry, stats);
		var current;

		if (!key) {
			return;
		}

		current = reserves2ByKey[key];

		if (!current || getReserves2SnapshotAt(entry) >= getReserves2SnapshotAt(current)) {
			reserves2ByKey[key] = entry;
		}
	});

	var usedReserveKeys = {};
	var windowByKey = {};

	recordedWindow.slice().sort(function (a, b) {
		return safeInt(a && a.start, 0) - safeInt(b && b.start, 0);
	}).forEach(function (recorded) {
		var recordedKey = makeKeyFromRecorded(recorded);
		var hit = reserves2ByKey[recordedKey];

		if (hit) {
			usedReserveKeys[recordedKey] = true;

			windowByKey[recordedKey] = buildMatchItem("RECORDED", recordedKey, recorded, hit, true);

			return;
		}

		windowByKey[recordedKey] = buildMatchItem("RECORDED_UNTRACKED", recordedKey, recorded, null, true);
	});

	Object.keys(reserves2ByKey).forEach(function (key) {
		var reserve;
		var isSkip;
		var status;
		var end;

		if (usedReserveKeys[key]) {
			return;
		}

		reserve = reserves2ByKey[key];
		isSkip = safeBool(reserve && reserve.isSkip);
		end = safeInt(reserve && reserve.end, 0) || (safeInt(reserve && reserve.start, 0) + safeInt(reserve && reserve.seconds, 0) * 1000);
		/*
		 * MISSED must be decided by end time, not start time.
		 * While a programme is on-air, keep it as RESERVED so it does not appear as NG.
		 */
		status = isSkip ? "SKIPPED_ONLY" : end > 0 && nowMs > end ? "MISSED" : "RESERVED";

		windowByKey[key] = buildMatchItem(status, key, null, reserve, false);
	});

	var ngStatuses = {
		MISSED: true,
		SKIPPED_ONLY: true
	};
	var prunedOldByKey = {};
	var pruneRemoved = 0;
	var pruneSample = null;

	/*
	 * oldMatch は前回までの match.json 台帳であり、今回の recorded/reserves2 から
	 * 再構築した windowByKey とマージされる。
	 *
	 * reserves2 は「reserves.json に準拠し、過去だけ keep」するため、
	 * 未来/進行中の RESERVED が今回の windowByKey に存在しない場合は、
	 * 予約削除・ルール解除などで現在台帳から外れた予約残骸として oldMatch から落とす。
	 *
	 * 一方、過去の RESERVED はここでは機械的に消さない。
	 * 過去分が reserves2 に残っていれば、上の reserve-only 判定で MISSED/SKIPPED_ONLY 等へ
	 * 再分類される。reserves2 にも recorded にも存在しない過去 RESERVED は、
	 * 別途 retention/read-days の対象として扱う。
	 */
	if (!initialBuild) {
		Object.keys(oldByKey).forEach(function (key) {
			var oldEntry = oldByKey[key];
			var oldStatus = oldEntry.status;
			var oldStart = getMatchEntryStartMs(oldEntry);
			var oldProgram = oldEntry.program || oldEntry.reserve || oldEntry.recorded || {};
			var oldSeconds = safeInt(oldProgram && oldProgram.seconds, 0);
			var oldEnd = safeInt(oldEntry && oldEntry.end, 0) || safeInt(oldProgram && oldProgram.end, 0) ||
				(oldStart > 0 && oldSeconds > 0 ? oldStart + oldSeconds * 1000 : 0);
			var isFutureOrCurrentReserved = oldStatus === "RESERVED" && oldEnd > 0 && oldEnd >= nowMs;
			var shouldPrune = oldStart > 0 &&
				oldStart >= updateCutoffMs &&
				!windowByKey[key] &&
				!hasRecordedEvidence(oldEntry) &&
				(ngStatuses[oldStatus] || isFutureOrCurrentReserved);

			if (shouldPrune) {
				pruneRemoved += 1;

				if (!pruneSample) {
					pruneSample = {
						key: key,
						status: oldStatus,
						start: oldStart,
						title: oldEntry.fullTitle || (oldProgram && typeof oldProgram === "object" ? oldProgram.title || "" : "")
					};
				}

				return;
			}

			prunedOldByKey[key] = oldEntry;
		});
	}

	var mergedByKey = Object.assign({}, prunedOldByKey);

	Object.keys(windowByKey).forEach(function (key) {
		var oldEntry = prunedOldByKey[key];
		var newEntry = windowByKey[key];

		mergedByKey[key] = oldEntry ? mergeOldNew(oldEntry, newEntry, logger, config, {
			recordedReadOk: options.recordedReadOk === true
		}) : newEntry;
	});

	var results = Object.keys(mergedByKey).map(function (key) {
		return matchDetailResolver.withoutRecordingPaths(mergedByKey[key]);
	}).filter(function (entry) {
		return getMatchEntryStartMs(entry) >= keepCutoffMs;
	}).sort(function (a, b) {
		return getMatchEntryStartMs(a) - getMatchEntryStartMs(b);
	});

	results = matchV2.markRecordedMissing(results, recordedAll, {
		recordedReadOk: options.recordedReadOk === true,
		recordingList: options.recordingList,
		nowMs: nowMs,
		graceMs: options.recordedMissingGraceMs
	});

	return {
		results: results,
		summary: {
			nowMs: nowMs,
			initialBuild: initialBuild,
			keepDays: keepDays,
			keepMonths: keepMonths,
			readDays: readDays,
			keepCutoffMs: keepCutoffMs,
			updateCutoffMs: updateCutoffMs,
			keepCutoffJst: initialBuild || keepDays === 0 ? null : formatJstMinute(keepCutoffMs),
			updateCutoffJst: initialBuild ? null : formatJstMinute(updateCutoffMs),
			recordedAll: recordedAll.length,
			reserves2All: reserves2All.length,
			recordedWindow: recordedWindow.length,
			reserves2Window: reserves2Window.length,
			windowByKey: Object.keys(windowByKey).length,
			pruneRemoved: pruneRemoved,
			pruneSample: pruneSample,
			total: results.length,
			reserves2KeyFallback: stats.reserves2KeyFallback,
			reserves2KeyFallbackSample: stats.reserves2KeyFallbackSample,
			reserves2KeyMismatch: stats.reserves2KeyMismatch,
			reserves2KeyMismatchSample: stats.reserves2KeyMismatchSample
		}
	};
}

function getRecordedEndMs(program) {
	var start;
	var seconds;

	if (!program || typeof program !== "object") {
		return 0;
	}

	if (safeInt(program.end, 0) > 0) {
		return safeInt(program.end, 0);
	}

	start = safeInt(program.start, 0);
	seconds = safeInt(program.seconds, 0);

	if (start > 0 && seconds > 0) {
		return start + seconds * 1000;
	}

	return start;
}

function cleanupRecordedHistory(recordedList, days, nowMs) {
	var cutoff;
	var kept = [];
	var removed = [];

	if (!Array.isArray(recordedList)) {
		recordedList = [];
	}

	if (!Number.isFinite(Number(days)) || Number(days) <= 0) {
		return {
			enabled: false,
			days: days,
			cutoffMs: null,
			kept: recordedList.slice(),
			removed: [],
			removedCount: 0
		};
	}

	cutoff = dayStartNDaysAgoMs(nowMs, Math.floor(Number(days)));

	recordedList.forEach(function (program) {
		var end = getRecordedEndMs(program);

		if (!end || end >= cutoff) {
			kept.push(program);
		} else {
			removed.push(program);
		}
	});

	return {
		enabled: true,
		days: Math.floor(Number(days)),
		cutoffMs: cutoff,
		cutoffJst: formatJstMinute(cutoff),
		kept: kept,
		removed: removed,
		removedCount: removed.length
	};
}

function usage() {
	console.log([
		"Usage:",
		"  node app-matching.js --output <path> [options]",
		"",
		"Options:",
		"  --recorded <path>    recorded.json path (default: ./data/recorded.json)",
		"  --recording <path>   recording.json path used to guard recorded-missing",
		"  --reserves2 <path>   reserves2.json path (default: ./data/reserves2.json)",
		"  --old-match <path>   existing match.json path used as the merge base",
		"  --output <path>      comparison output path; required",
		"  --read-days <days>   update window in days (default: 14)",
		"  --keep-days <days>   keep match range in days (default: 365; 0 disables cleanup)",
		"  --keep-months <n>    compatibility option; converted to roughly n*31 days",
		"  --recorded-history-days <days>  keep recorded.json history in days (default: config/default; 0 disables cleanup)",
		"  --config <path>      config.json path (default: ./config.json)",
		"  --now <value>        current time override, epoch milliseconds or ISO date",
		"  --initial-build      build from all recorded/reserves2 input and ignore old match",
		"  --help              show this help"
	].join("\n"));
}

function parseArgs(argv) {
	var options = {
		recorded: path.join(__dirname, "data", "recorded.json"),
		recording: path.join(__dirname, "data", "recording.json"),
		reserves2: path.join(__dirname, "data", "reserves2.json"),
		oldMatch: null,
		output: null,
		readDays: DEFAULT_READ_DAYS,
		keepMonths: DEFAULT_KEEP_MONTHS,
		keepDays: null,
		recordedHistoryDays: null,
		config: path.join(__dirname, "config.json"),
		initialBuild: false,
		nowMs: Date.now()
	};
	var i;
	var name;
	var value;

	for (i = 2; i < argv.length; i++) {
		name = argv[i];

		if (name === "--help" || name === "-h") {
			options.help = true;
			continue;
		}

		if (name === "--initial-build") {
			options.initialBuild = true;
			continue;
		}

		if (name.indexOf("--") !== 0) {
			throw new Error("unexpected argument: " + name);
		}

		value = argv[i + 1];
		if (typeof value === "undefined" || value.indexOf("--") === 0) {
			throw new Error("missing value for " + name);
		}

		i += 1;

		switch (name) {
		case "--recorded":
			options.recorded = value;
			break;
		case "--recording":
			options.recording = value;
			break;
		case "--reserves2":
			options.reserves2 = value;
			break;
		case "--old-match":
			options.oldMatch = value;
			break;
		case "--output":
			options.output = value;
			break;
		case "--read-days":
			options.readDays = safeInt(value, DEFAULT_READ_DAYS);
			break;
		case "--keep-days":
			options.keepDays = safeInt(value, DEFAULT_RETENTION_DAYS);
			break;
		case "--keep-months":
			options.keepMonths = safeInt(value, DEFAULT_KEEP_MONTHS);
			if (options.keepDays === null) {
				options.keepDays = Math.max(0, options.keepMonths * 31);
			}
			break;
		case "--recorded-history-days":
			options.recordedHistoryDays = safeInt(value, DEFAULT_RETENTION_DAYS);
			break;
		case "--config":
			options.config = value;
			break;
		case "--now":
			options.nowMs = parseNow(value);
			break;
		default:
			throw new Error("unknown option: " + name);
		}
	}

	return options;
}

function parseNow(value) {
	var numeric = safeInt(value, NaN);
	var parsed;

	if (!isNaN(numeric) && String(numeric) === String(value).trim()) {
		return numeric;
	}

	parsed = Date.parse(value);
	if (isNaN(parsed)) {
		throw new Error("invalid --now value: " + value);
	}

	return parsed;
}

function readJsonArray(file, options) {
	var text;
	var data;

	options = options || {};

	if (!file || !fs.existsSync(file)) {
		if (options.createIfMissing) {
			ensureParentDirectory(file);
			fs.writeFileSync(file, "[]");
			console.log("INIT JSON: " + file);
			return [];
		}

		if (options.allowMissing) {
			return [];
		}

		throw new Error("file not found: " + file);
	}

	text = fs.readFileSync(file, { encoding: "utf8" }).replace(/^\uFEFF/, "");
	data = JSON.parse(text);
	if (!Array.isArray(data)) throw new Error("JSON array expected: " + file);

	return data;
}

function ensureParentDirectory(file) {
	var dir = path.dirname(path.resolve(file));
	fs.mkdirSync(dir, { recursive: true });
}

function writeJsonAtomic(file, data) {
	var tmp = file + "." + process.pid + ".tmp";

	try {
		fs.writeFileSync(tmp, JSON.stringify(data));
		fs.renameSync(tmp, file);
	} catch (error) {
		try {
			if (fs.existsSync(tmp)) {
				fs.unlinkSync(tmp);
			}
		} catch (_) {}

		throw error;
	}
}

function writeMatchLedgerLocked(options) {
	var store = options.reservationStore || reservationStore;
	var output = path.resolve(options.output);
	var oldMatchPath = path.resolve(options.oldMatchPath || output);
	// Stable order for distinct CLI input/output paths; never acquire the same
	// lock twice or rewrite the read-only merge source.
	var lockPaths = Array.from(new Set([output, oldMatchPath])).sort();
	function locked(index) {
		if (index < lockPaths.length) return store.withLock(lockPaths[index], function () { return locked(index + 1); });
		var latestRecordedList = options.recordedPath ? store.readArray(options.recordedPath) : options.recordedList;
		var latestReserves2List = options.reserves2Path ? store.readArray(options.reserves2Path) : options.reserves2List;
		var outputEntries = oldMatchPath !== output ? store.readArray(output) : null;
		if (options.initialBuild && outputEntries && outputEntries.length > 0) {
			throw new Error("match v2 initial-build cannot replace existing history");
		}
		var migration = matchV2.runV2FixLocked({
			matchFile: oldMatchPath,
			backupFile: oldMatchPath + '.v1-backup',
			reuseMatchingBackup: true,
			legacyOnly: true,
			save: false,
			initialBuild: options.initialBuild,
			reservationStore: store
		});
		var latestOldResults = migration.entries;
		var ledger = buildMatchLedger({
			oldResults: latestOldResults,
			recordedList: latestRecordedList,
			recordingList: options.recordingList,
			recordedReadOk: true,
			reserves2List: latestReserves2List,
			nowMs: options.nowMs,
			keepDays: options.keepDays,
			keepMonths: options.keepMonths,
			readDays: options.readDays,
			config: options.config,
			initialBuild: options.initialBuild,
			logger: options.logger
		});
		store.writeArrayAtomic(output, ledger.results);
		ledger.sourceRecordedList = latestRecordedList;
		ledger.sourceReserves2List = latestReserves2List;
		return ledger;
	}
	return locked(0);
}

function printSummary(summary, output) {
	console.log("---- match summary ----");
	console.log("initial_build: " + (summary.initialBuild ? "true" : "false"));
	console.log("keep_cutoff_month_start(JST): " + (summary.keepCutoffJst || "disabled"));
	console.log("update_cutoff_day_start(JST): " + (summary.updateCutoffJst || "disabled"));
	console.log("read_days: " + summary.readDays);
	console.log("keep_days: " + summary.keepDays);
	console.log("keep_months_compat: " + summary.keepMonths);
	console.log("recorded_all: " + summary.recordedAll);
	console.log("reserves2_all: " + summary.reserves2All);
	console.log("recorded_win: " + summary.recordedWindow);
	console.log("reserves2_win: " + summary.reserves2Window);
	console.log("window_by_key: " + summary.windowByKey);
	console.log("MATCH_PRUNE_OLD_NG removed=" + summary.pruneRemoved);

	if (summary.pruneSample) {
		console.log(
			"MATCH_PRUNE_OLD_NG_SAMPLE " +
			"key=" + summary.pruneSample.key + " " +
			"status=" + summary.pruneSample.status + " " +
			"start=" + summary.pruneSample.start + " " +
			"title=" + summary.pruneSample.title
		);
	}

	console.log("reserves2_key_fallback: " + summary.reserves2KeyFallback);
	console.log("reserves2_key_mismatch: " + summary.reserves2KeyMismatch);

	if (summary.reserves2KeyMismatchSample) {
		console.log(
			"RESERVES2_KEY_MISMATCH_SAMPLE " +
			"canonical=" + summary.reserves2KeyMismatchSample.canonicalKey + " " +
			"reserves2=" + summary.reserves2KeyMismatchSample.reserves2Key + " " +
			"title=" + summary.reserves2KeyMismatchSample.title
		);
	}

	console.log("total: " + summary.total);
	console.log("saved: " + output);
}

function main() {
	var options;
	var oldMatchPath;
	var recordedList;
	var reserves2List;
	var ledger;
	var config;
	var cleanup;
	var recordingList;

	try {
		// Both Operator and Scheduler invoke this worker. Yield CPU to recording.
		try { require("os").setPriority(0, 19); } catch (priorityError) {
			console.error("WARNING: match priority adjustment failed: " + priorityError.message);
		}
		options = parseArgs(process.argv);

		if (options.help) {
			usage();
			return;
		}

		if (!options.output) {
			throw new Error("--output is required so production match.json is not overwritten accidentally");
		}

		config = readConfigFile(options.config);
		if (options.keepDays === null) {
			options.keepDays = getRetentionDays(config, "matchRetentionDays", DEFAULT_RETENTION_DAYS);
		}
		if (options.recordedHistoryDays === null) {
			options.recordedHistoryDays = getRetentionDays(config, "recordedHistoryRetentionDays", DEFAULT_RETENTION_DAYS);
		}

		oldMatchPath = options.oldMatch || options.output;
		recordedList = readJsonArray(options.recorded, { createIfMissing: true });
		recordingList = readJsonArray(options.recording, { allowMissing: true });
		reserves2List = readJsonArray(options.reserves2, { createIfMissing: true });
		ensureParentDirectory(options.output);
		reservationStore.ensureArrayFile(options.output);
		ledger = writeMatchLedgerLocked({
			oldMatchPath: oldMatchPath,
			output: options.output,
			recordedPath: options.recorded,
			recordedList: recordedList,
			recordingList: recordingList,
			reserves2Path: options.reserves2,
			reserves2List: reserves2List,
			nowMs: options.nowMs,
			keepDays: options.keepDays,
			keepMonths: options.keepMonths,
			readDays: options.readDays,
			config: config,
			initialBuild: options.initialBuild,
			logger: console.log,
			reservationStore: reservationStore
		});
		recordedList = ledger.sourceRecordedList;
		reserves2List = ledger.sourceReserves2List;

		var csvSaveFailed = false;
		var csvFailedFiles = new Set();
		try {
			var historyResult = recordingHistoryCsv.exportHistory({
				enabled: config.recordingResultCsvEnabled === true,
				ledgerFiles: { recorded: options.recorded, match: options.output, recording: options.recording },
				outputDir: path.join(path.dirname(options.config), "data", "csv"),
				stateFile: path.join(path.dirname(options.config), "data", "recording-history-csv-state.json"),
				nowMs: options.nowMs,
				recordedList: recordedList,
				recordingList: recordingList,
				reserves2List: reserves2List,
				matchList: ledger.results
			});
			if (historyResult.initialized) {
				console.log("RECORDING_HISTORY_CSV initialized enabled_at=" + historyResult.enabledAt);
			} else if (historyResult.appended > 0) {
				console.log("RECORDING_HISTORY_CSV appended=" + historyResult.appended + " files=" + historyResult.files.length);
			}
			csvFailedFiles = new Set(historyResult.failedFiles || []);
			if (historyResult.updated > 0) console.log("RECORDING_HISTORY_CSV updated=" + historyResult.updated);
			(historyResult.errors || []).forEach(function (message) { console.error("WARNING: recording history CSV update failed: " + message); });
		} catch (historyError) {
			csvSaveFailed = true;
			console.error("WARNING: recording history CSV update failed: " + historyError.message);
		}

		// Do not write back the snapshot used to build match: recordings may have
		// finished (or acquired duration metadata) while this process was running.
		// Never hold the match lock while acquiring the recorded lock.
		cleanup = reservationStore.withLock(options.recorded, function () {
			var latest = reservationStore.readArray(options.recorded);
			var result = cleanupRecordedHistory(latest, options.recordedHistoryDays, options.nowMs);
			if (csvSaveFailed || csvFailedFiles.size) {
				var held = result.removed.filter(function (program) {
					var month = formatJstMinute(safeInt(program.start, 0)).slice(0, 7).replace('/', '-');
					return csvSaveFailed || csvFailedFiles.has('recording-history_' + month + '.csv');
				});
				var heldSet = new Set(held);
				result.removed = result.removed.filter(function (program) { return !heldSet.has(program); });
				var removedSet = new Set(result.removed);
				result.kept = latest.filter(function (program) { return !removedSet.has(program); });
				result.removedCount = result.removed.length;
				if (held.length) console.error('WARNING: CSV保存失敗のため録画履歴' + held.length + '件の整理を延期。CSV保存成功後のMatchingで整理を再試行します。');
			}
			if (result.enabled && result.removedCount > 0) {
				reservationStore.writeArrayAtomic(options.recorded, result.kept);
			}
			return result;
		});

		printSummary(ledger.summary, options.output);
		if (cleanup.enabled) {
			console.log("RECORDED_HISTORY_CLEANUP days=" + cleanup.days + " cutoff=" + cleanup.cutoffJst + " keep=" + cleanup.kept.length + " removed=" + cleanup.removedCount);
		} else {
			console.log("RECORDED_HISTORY_CLEANUP disabled");
		}
	} catch (error) {
		console.error("ERROR: " + error.message);
		process.exitCode = 1;
	}
}

if (require.main === module) {
	main();
}

module.exports = {
	DEFAULT_KEEP_MONTHS: DEFAULT_KEEP_MONTHS,
	DEFAULT_RETENTION_DAYS: DEFAULT_RETENTION_DAYS,
	DEFAULT_READ_DAYS: DEFAULT_READ_DAYS,
	safeInt: safeInt,
	safeBool: safeBool,
	readConfigFile: readConfigFile,
	getRetentionDays: getRetentionDays,
	makeCanonicalKeyFromFields: makeCanonicalKeyFromFields,
	makeCanonicalKey: makeCanonicalKey,
	makeKeyFromRecorded: makeKeyFromRecorded,
	getReserves2LookupKey: getReserves2LookupKey,
	getMatchEntryKey: getMatchEntryKey,
	getMatchEntryStartMs: getMatchEntryStartMs,
	hasRecordedEvidence: hasRecordedEvidence,
	mergeOldNew: mergeOldNew,
	monthStartNMonthsAgoMs: monthStartNMonthsAgoMs,
	dayStartNDaysAgoMs: dayStartNDaysAgoMs,
	formatJstMinute: formatJstMinute,
	buildMatchItem: buildMatchItem,
	buildMatchLedger: buildMatchLedger,
	parseArgs: parseArgs,
	cleanupRecordedHistory: cleanupRecordedHistory,
	readJsonArray: readJsonArray,
	writeJsonAtomic: writeJsonAtomic,
	writeMatchLedgerLocked: writeMatchLedgerLocked
};
