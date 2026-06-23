#!/usr/bin/env node
"use strict";

var fs = require("fs");
var path = require("path");
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

function shouldKeepRecordedSnapshot(config) {
	return !config || config.matchKeepRecordedSnapshot !== false;
}

function isTemporaryRecordingPath(filePath, config) {
	var temporaryDir;
	var resolvedFilePath;
	var resolvedTemporaryDir;

	if (!filePath || !config || typeof config !== "object") {
		return false;
	}

	temporaryDir = config.temporaryDir;

	/*
	 * temporaryDir が明示設定されていない環境では判定しない。
	 * recordedDir のみの運用では、ファイル名に「録画中」等が含まれていても
	 * TEMP_RECORDING_PATH とは扱わない。
	 */
	if (typeof temporaryDir !== "string" || temporaryDir.trim() === "") {
		return false;
	}

	resolvedFilePath = path.resolve(process.cwd(), filePath);
	resolvedTemporaryDir = path.resolve(process.cwd(), temporaryDir.trim());

	return resolvedFilePath === resolvedTemporaryDir ||
		resolvedFilePath.indexOf(resolvedTemporaryDir + path.sep) === 0;
}

function cloneJson(value) {
	if (value == null || typeof value !== "object") {
		return value;
	}

	return JSON.parse(JSON.stringify(value));
}

function isFilled(value) {
	if (typeof value === "undefined" || value === null) {
		return false;
	}

	if (typeof value === "string") {
		return value !== "";
	}

	if (Array.isArray(value)) {
		return value.length > 0;
	}

	if (typeof value === "object") {
		return Object.keys(value).length > 0;
	}

	return true;
}

function pickFilled(primary, secondary, field, defaultValue) {
	if (primary && isFilled(primary[field])) {
		return cloneJson(primary[field]);
	}

	if (secondary && isFilled(secondary[field])) {
		return cloneJson(secondary[field]);
	}

	return cloneJson(defaultValue);
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

function toChannelDictFromRecorded(program) {
	var channel = program && program.channel || {};

	return {
		id: channel.id || "",
		name: channel.name || "",
		type: channel.type || "",
		sid: typeof channel.sid === "undefined" ? null : channel.sid,
		nid: typeof channel.nid === "undefined" ? null : channel.nid
	};
}

function toChannelDictFromReserves2(entry) {
	var channel = entry && entry.channel || {};

	if (channel && typeof channel === "object" && channel.id) {
		return {
			id: channel.id || "",
			name: channel.name || "",
			type: channel.type || "",
			sid: typeof channel.sid === "undefined" ? null : channel.sid,
			nid: typeof channel.nid === "undefined" ? null : channel.nid
		};
	}

	return {
		id: entry && entry.channelId || "",
		name: entry && entry.channelName || "",
		type: entry && entry.channelType || "",
		sid: entry && typeof entry.sid !== "undefined" ? entry.sid : null,
		nid: entry && typeof entry.nid !== "undefined" ? entry.nid : null
	};
}

function normalizeChannel(channel) {
	channel = channel && typeof channel === "object" ? channel : {};

	return {
		id: channel.id || "",
		name: channel.name || "",
		type: channel.type || "",
		sid: typeof channel.sid === "undefined" ? null : channel.sid,
		nid: typeof channel.nid === "undefined" ? null : channel.nid
	};
}

function buildChannelIdToName(recordedList, reserves2List) {
	var map = {};

	recordedList.forEach(function (program) {
		var channel = program && program.channel || {};
		var channelId = channel.id;
		var channelName = channel.name;

		if (typeof channelId === "string" && channelId && typeof channelName === "string" && channelName && !map[channelId]) {
			map[channelId] = channelName;
		}
	});

	reserves2List.forEach(function (entry) {
		var channel = entry && entry.channel || {};
		var channelId = channel.id || entry && entry.channelId || "";
		var channelName = channel.name || entry && entry.channelName || "";

		if (typeof channelId === "string" && channelId && typeof channelName === "string" && channelName && !map[channelId]) {
			map[channelId] = channelName;
		}
	});

	return map;
}

function mergeChannelName(channel, idToName) {
	var output = Object.assign({}, channel || {});
	var channelId = output.id || "";

	if (!output.name && channelId && idToName[channelId]) {
		output.name = idToName[channelId];
	}

	return output;
}

function getMatchEntryStartMs(entry) {
	var program = entry && entry.program;
	var recordingResult = entry && entry.recordingResult;
	var recorded = entry && entry.recorded;
	var reserve = entry && entry.reserve;
	var start;

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

	if (recorded && typeof recorded === "object") {
		if (!!recorded.path || !!recorded.recorded || safeInt(recorded.start, 0) > 0) {
			return true;
		}
	}

	if (recordingResult && typeof recordingResult === "object") {
		if (!!recordingResult.path || !!recordingResult.recorded || !!recordingResult.id || !!recordingResult.recordedId) {
			return true;
		}
	}

	return false;
}

function buildRecdFlg(hasRecorded, hasReserve, isSkip, exactMatch, nearMatch) {
	return {
		hasRecorded: !!hasRecorded,
		hasReserve: !!hasReserve,
		isSkip: !!isSkip,
		exactMatch: !!exactMatch,
		nearMatch: !!nearMatch
	};
}

function getRecordingPath(entry) {
	var recordingResult = entry && entry.recordingResult;
	var recorded = entry && entry.recorded;

	if (recordingResult && typeof recordingResult === "object") {
		return recordingResult.path || recordingResult.recorded || "";
	}

	if (recorded && typeof recorded === "object") {
		return recorded.path || recorded.recorded || "";
	}

	return "";
}

function mergeOldNew(oldEntry, newEntry, logger, config) {
	if (oldEntry.status === "RECORDED" && newEntry.status === "RECORDED") {
		var oldPath = getRecordingPath(oldEntry);
		var newPath = getRecordingPath(newEntry);
		var oldIsTemp = isTemporaryRecordingPath(oldPath, config);
		var newIsTemp = isTemporaryRecordingPath(newPath, config);
		var oldIsFinal = typeof oldPath === "string" && oldPath && !oldIsTemp;
		var newIsFinal = typeof newPath === "string" && newPath && !newIsTemp;

		if (oldIsFinal && newIsTemp) {
			if (logger) {
				logger("KEEP_FINAL_RECORDED_PATH: " + oldPath + " over " + newPath);
			}
			return oldEntry;
		}

		if (oldPath !== newPath && newIsFinal && logger) {
			logger("UPDATE_RECORDED_PATH: " + oldPath + " -> " + newPath);
		}

		return newEntry;
	}

	if (oldEntry.status === "RECORDED" && !hasRecordedEvidence(newEntry)) {
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

function normalizeProgramSource(source, channel) {
	var output = source && typeof source === "object" ? cloneJson(source) : {};
	var start = safeInt(output.start, 0);
	var seconds = safeInt(output.seconds, 0);

	output.start = start;
	output.seconds = seconds;
	output.end = safeInt(output.end, 0) || (start + seconds * 1000);
	output.title = output.title || "";
	output.fullTitle = output.fullTitle || output.title || "";
	output.detail = output.detail || "";
	output.origId = output.origId || output.programId || output.id || "";
	output.channel = channel;

	return output;
}

function mergeProgram(recorded, reserve, preferRecorded, channel) {
	var primary = preferRecorded ? recorded : reserve;
	var secondary = preferRecorded ? reserve : recorded;
	var start;
	var seconds;
	var program;

	primary = primary && typeof primary === "object" ? primary : null;
	secondary = secondary && typeof secondary === "object" ? secondary : null;

	program = {
		id: pickFilled(primary, secondary, "id", null),
		origId: pickFilled(primary, secondary, "origId", pickFilled(primary, secondary, "id", null)),
		programId: pickFilled(primary, secondary, "programId", pickFilled(primary, secondary, "id", null)),
		category: pickFilled(primary, secondary, "category", null),
		title: pickFilled(primary, secondary, "title", ""),
		fullTitle: pickFilled(primary, secondary, "fullTitle", pickFilled(primary, secondary, "title", "")),
		detail: pickFilled(primary, secondary, "detail", ""),
		description: pickFilled(primary, secondary, "description", ""),
		extra: pickFilled(primary, secondary, "extra", null),
		start: safeInt(pickFilled(primary, secondary, "start", 0), 0),
		end: safeInt(pickFilled(primary, secondary, "end", 0), 0),
		seconds: safeInt(pickFilled(primary, secondary, "seconds", 0), 0),
		channel: normalizeChannel(channel || pickFilled(primary, secondary, "channel", {})),
		subTitle: pickFilled(primary, secondary, "subTitle", null),
		episode: pickFilled(primary, secondary, "episode", null),
		flags: pickFilled(primary, secondary, "flags", [])
	};

	start = safeInt(program.start, 0);
	seconds = safeInt(program.seconds, 0);
	if (!program.end && start && seconds) {
		program.end = start + seconds * 1000;
	}

	return program;
}

function buildReservationMeta(reserve, hasReserve) {
	if (!reserve || typeof reserve !== "object") {
		return {
			hasReserve: !!hasReserve,
			ruleId: null,
			recordedFormat: "",
			isSkip: false,
			isConflict: false,
			source: null,
			reserveSnapshotAt: null,
			reserveUpdatedAt: null
		};
	}

	return {
		hasReserve: true,
		ruleId: typeof reserve.ruleId === "undefined" ? null : reserve.ruleId,
		recordedFormat: reserve.recordedFormat || "",
		isSkip: safeBool(reserve.isSkip),
		isConflict: safeBool(reserve.isConflict),
		source: reserve.source || null,
		reserveSnapshotAt: typeof reserve.snapshotAt === "undefined" ? null : reserve.snapshotAt,
		reserveUpdatedAt: typeof reserve.updatedAt === "undefined" ? null : reserve.updatedAt
	};
}

function buildRecordingResult(recorded, nowMs, keepSnapshot) {
	var output;
	var recPath;
	var start;
	var seconds;
	var channel;

	if (!recorded || typeof recorded !== "object") {
		return null;
	}

	recPath = recorded.recorded || recorded.path || "";
	start = safeInt(recorded.start, 0);
	seconds = safeInt(recorded.seconds, 0);
	channel = toChannelDictFromRecorded(recorded);

	output = {
		hasRecorded: true,
		id: recorded.id || recorded.origId || recorded.programId || "",
		recordedId: recorded.id || recorded.origId || recorded.programId || "",
		origId: recorded.origId || recorded.id || recorded.programId || "",
		programId: recorded.programId || recorded.id || recorded.origId || "",
		path: recPath,
		recorded: recPath,
		start: start,
		end: safeInt(recorded.end, 0) || (start + seconds * 1000),
		seconds: seconds,
		title: recorded.title || "",
		fullTitle: recorded.fullTitle || recorded.title || "",
		detail: recorded.detail || "",
		description: recorded.description || "",
		category: recorded.category || null,
		channel: normalizeChannel(channel),
		subTitle: typeof recorded.subTitle === "undefined" ? null : cloneJson(recorded.subTitle),
		episode: typeof recorded.episode === "undefined" ? null : cloneJson(recorded.episode),
		flags: Array.isArray(recorded.flags) ? cloneJson(recorded.flags) : [],
		extra: typeof recorded.extra === "undefined" ? null : cloneJson(recorded.extra),
		command: recorded.command || "",
		tuner: recorded.tuner ? cloneJson(recorded.tuner) : null,
		priority: typeof recorded.priority === "undefined" ? null : recorded.priority,
		recordedFormat: recorded.recordedFormat || "",
		fileExists: null,
		fileSize: null,
		cleanupState: recPath ? "active" : "unknown",
		snapshotAt: nowMs
	};

	if (keepSnapshot !== false) {
		output.snapshot = cloneJson(recorded);
	}

	return output;
}

function getProgramIds(value) {
	var ids = [];
	var candidates = [
		value && value.id,
		value && value.origId,
		value && value.programId,
		value && value.recordedId
	];

	candidates.forEach(function (id) {
		if (typeof id !== "undefined" && id !== null && String(id) !== "" && ids.indexOf(String(id)) === -1) {
			ids.push(String(id));
		}
	});

	return ids;
}

function hasIdIntersection(a, b) {
	var ai = getProgramIds(a);
	var bi = getProgramIds(b);
	var i;

	for (i = 0; i < ai.length; i++) {
		if (bi.indexOf(ai[i]) !== -1) {
			return true;
		}
	}

	return false;
}

function buildMatchMeta(status, key, recorded, reserve, hasRecorded, hasReserve, exactMatch, nearMatch, nowMs, config) {
	var warnings = [];
	var matchedBy;
	var confidence;

	if (hasRecorded && hasReserve && exactMatch) {
		matchedBy = "canonical-key";
		confidence = "exact";
	} else if (hasRecorded && hasReserve && nearMatch) {
		matchedBy = "near";
		confidence = "near";
	} else if (hasRecorded && !hasReserve) {
		matchedBy = "recorded-only";
		confidence = "recorded-only";
		warnings.push("NO_RESERVATION_MATCH");
	} else if (!hasRecorded && hasReserve) {
		matchedBy = "reserve-only";
		confidence = "reserve-only";
		if (status === "MISSED") {
			warnings.push("NO_RECORDED_MATCH");
		}
		if (status === "SKIPPED_ONLY") {
			warnings.push("RESERVE_SKIPPED");
		}
	} else {
		matchedBy = null;
		confidence = "none";
	}

	if (hasRecorded && hasReserve && !hasIdIntersection(recorded, reserve)) {
		warnings.push("PROGRAM_ID_MISMATCH");
	}

	if (hasRecorded && recorded && isTemporaryRecordingPath(recorded.recorded || recorded.path || "", config)) {
		warnings.push("TEMP_RECORDING_PATH");
	}

	return {
		key: key,
		status: status,
		matchedBy: matchedBy,
		confidence: confidence,
		hasMismatch: warnings.length > 0,
		warnings: warnings,
		snapshotAt: nowMs
	};
}

function buildSources(programSource, hasReserve, hasRecorded) {
	return {
		program: programSource,
		reservationMeta: hasReserve ? "reserves2" : null,
		recordingResult: hasRecorded ? "recorded" : null
	};
}

function buildMatchItem(status, key, recorded, reserve, channel, hasRecorded, hasReserve, isSkip, exactMatch, nearMatch, nowMs, keepRecordedSnapshot, config) {
	var preferRecorded = !!hasRecorded;
	var programSource = hasRecorded && hasReserve ? "recorded+reserves2" : hasRecorded ? "recorded" : "reserves2";
	var program = mergeProgram(recorded, reserve, preferRecorded, channel);
	var recordingResult = hasRecorded ? buildRecordingResult(recorded, nowMs, keepRecordedSnapshot) : null;
	var reservationMeta = buildReservationMeta(reserve, hasReserve);
	var matchMeta = buildMatchMeta(status, key, recorded, reserve, hasRecorded, hasReserve, exactMatch, nearMatch, nowMs, config);

	return {
		status: status,
		key: key,
		channel: normalizeChannel(channel || program.channel),
		program: program,
		reservationMeta: reservationMeta,
		recordingResult: recordingResult,
		matchMeta: matchMeta,
		recd_flg: buildRecdFlg(hasRecorded, hasReserve, isSkip, exactMatch, nearMatch),
		sources: buildSources(programSource, hasReserve, hasRecorded),
		snapshotAt: nowMs
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
	var keepRecordedSnapshot = options.keepRecordedSnapshot !== false;
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

	var idToName = buildChannelIdToName(recordedKeep, reserves2Keep);
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
		var recordedChannel = mergeChannelName(toChannelDictFromRecorded(recorded), idToName);
		var reserveChannel;
		var topChannel;
		var isSkip;

		if (hit) {
			usedReserveKeys[recordedKey] = true;
			reserveChannel = mergeChannelName(toChannelDictFromReserves2(hit), idToName);
			isSkip = safeBool(hit.isSkip);
			topChannel = recordedChannel.name ? recordedChannel : reserveChannel;

			windowByKey[recordedKey] = buildMatchItem(
				"RECORDED",
				recordedKey,
				recorded,
				hit,
				topChannel,
				true,
				true,
				isSkip,
				true,
				false,
				nowMs,
				keepRecordedSnapshot,
				config
			);

			return;
		}

		windowByKey[recordedKey] = buildMatchItem(
			"RECORDED_UNTRACKED",
			recordedKey,
			recorded,
			null,
			recordedChannel,
			true,
			false,
			false,
			false,
			false,
			nowMs,
			keepRecordedSnapshot,
			config
		);
	});

	Object.keys(reserves2ByKey).forEach(function (key) {
		var reserve;
		var isSkip;
		var reserveChannel;
		var status;
		var end;

		if (usedReserveKeys[key]) {
			return;
		}

		reserve = reserves2ByKey[key];
		isSkip = safeBool(reserve && reserve.isSkip);
		reserveChannel = mergeChannelName(toChannelDictFromReserves2(reserve), idToName);
		end = safeInt(reserve && reserve.end, 0) || (safeInt(reserve && reserve.start, 0) + safeInt(reserve && reserve.seconds, 0) * 1000);
		/*
		 * MISSED must be decided by end time, not start time.
		 * While a programme is on-air, keep it as RESERVED so it does not appear as NG.
		 */
		status = isSkip ? "SKIPPED_ONLY" : end > 0 && nowMs > end ? "MISSED" : "RESERVED";

		windowByKey[key] = buildMatchItem(
			status,
			key,
			null,
			reserve,
			reserveChannel,
			false,
			true,
			isSkip,
			false,
			false,
			nowMs,
			keepRecordedSnapshot,
			config
		);
	});

	var ngStatuses = {
		MISSED: true,
		SKIPPED_ONLY: true
	};
	var prunedOldByKey = {};
	var pruneRemoved = 0;
	var pruneSample = null;

	if (!initialBuild) {
		Object.keys(oldByKey).forEach(function (key) {
			var oldEntry = oldByKey[key];
			var oldStatus = oldEntry.status;
			var oldStart = getMatchEntryStartMs(oldEntry);
			var oldProgram = oldEntry.program || oldEntry.reserve || oldEntry.recorded || {};
			var shouldPrune = oldStart > 0 &&
				oldStart >= updateCutoffMs &&
				ngStatuses[oldStatus] &&
				!windowByKey[key] &&
				!hasRecordedEvidence(oldEntry);

			if (shouldPrune) {
				pruneRemoved += 1;

				if (!pruneSample) {
					pruneSample = {
						key: key,
						status: oldStatus,
						start: oldStart,
						title: oldProgram && typeof oldProgram === "object" ? oldProgram.title || "" : ""
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

		mergedByKey[key] = oldEntry ? mergeOldNew(oldEntry, newEntry, logger, config) : newEntry;
	});

	var results = Object.keys(mergedByKey).map(function (key) {
		return mergedByKey[key];
	}).filter(function (entry) {
		return getMatchEntryStartMs(entry) >= keepCutoffMs;
	}).sort(function (a, b) {
		return getMatchEntryStartMs(a) - getMatchEntryStartMs(b);
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

	try {
		text = fs.readFileSync(file, { encoding: "utf8" }).replace(/^\uFEFF/, "");
		data = JSON.parse(text || "[]");
	} catch (error) {
		if (options.allowInvalid) {
			console.error("WARNING: invalid JSON ignored: " + file + " (" + error.message + ")");
			return [];
		}
		throw error;
	}

	if (!Array.isArray(data)) {
		if (options.allowInvalid) {
			console.error("WARNING: JSON array expected, ignored: " + file);
			return [];
		}

		throw new Error("JSON array expected: " + file);
	}

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
	var oldResults;
	var oldMatchPath;
	var recordedList;
	var reserves2List;
	var ledger;
	var config;
	var cleanup;

	try {
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
		oldResults = options.initialBuild ? [] : readJsonArray(oldMatchPath, { createIfMissing: true, allowInvalid: true });
		recordedList = readJsonArray(options.recorded, { createIfMissing: true });
		reserves2List = readJsonArray(options.reserves2, { createIfMissing: true });

		ledger = buildMatchLedger({
			oldResults: oldResults,
			recordedList: recordedList,
			reserves2List: reserves2List,
			nowMs: options.nowMs,
			keepDays: options.keepDays,
			keepMonths: options.keepMonths,
			readDays: options.readDays,
			keepRecordedSnapshot: shouldKeepRecordedSnapshot(config),
			config: config,
			initialBuild: options.initialBuild,
			logger: console.log
		});

		ensureParentDirectory(options.output);
		writeJsonAtomic(options.output, ledger.results);

		cleanup = cleanupRecordedHistory(recordedList, options.recordedHistoryDays, options.nowMs);
		if (cleanup.enabled && cleanup.removedCount > 0) {
			writeJsonAtomic(options.recorded, cleanup.kept);
		}

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
	shouldKeepRecordedSnapshot: shouldKeepRecordedSnapshot,
	makeCanonicalKeyFromFields: makeCanonicalKeyFromFields,
	makeCanonicalKey: makeCanonicalKey,
	makeKeyFromRecorded: makeKeyFromRecorded,
	getReserves2LookupKey: getReserves2LookupKey,
	getMatchEntryKey: getMatchEntryKey,
	getMatchEntryStartMs: getMatchEntryStartMs,
	hasRecordedEvidence: hasRecordedEvidence,
	buildRecdFlg: buildRecdFlg,
	mergeOldNew: mergeOldNew,
	monthStartNMonthsAgoMs: monthStartNMonthsAgoMs,
	dayStartNDaysAgoMs: dayStartNDaysAgoMs,
	formatJstMinute: formatJstMinute,
	mergeProgram: mergeProgram,
	buildReservationMeta: buildReservationMeta,
	buildRecordingResult: buildRecordingResult,
	buildMatchMeta: buildMatchMeta,
	buildMatchItem: buildMatchItem,
	isTemporaryRecordingPath: isTemporaryRecordingPath,
	buildMatchLedger: buildMatchLedger,
	parseArgs: parseArgs,
	cleanupRecordedHistory: cleanupRecordedHistory,
	readJsonArray: readJsonArray,
	writeJsonAtomic: writeJsonAtomic
};
