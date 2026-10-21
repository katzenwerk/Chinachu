'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const MAX_RECORDINGS = 3;
const AVERAGE_MULTIPLIER = 1.30;
const MAX_MULTIPLIER = 1.10;
const MIN_DURATION_SECONDS = 60;
const MAX_EARLY_END_SECONDS = 60;

function roundMbps(value) {
	return Math.round(value * 1000000) / 1000000;
}

function newState() {
	return {
		schemaVersion: SCHEMA_VERSION,
		policy: {
			maxRecordings: MAX_RECORDINGS,
			averageMultiplier: AVERAGE_MULTIPLIER,
			maxMultiplier: MAX_MULTIPLIER,
			minDurationSeconds: MIN_DURATION_SECONDS,
			maxEarlyEndSeconds: MAX_EARLY_END_SECONDS
		},
		channels: {},
		updatedAt: null
	};
}

function readState(fsImpl, filename) {
	let text;

	try {
		text = fsImpl.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '');
	} catch (error) {
		if (error && error.code === 'ENOENT') {
			return newState();
		}
		throw error;
	}

	const state = JSON.parse(text);
	if (!state || state.schemaVersion !== SCHEMA_VERSION || !state.channels || typeof state.channels !== 'object' || Array.isArray(state.channels)) {
		throw new Error('unsupported bitrate stats schema: ' + filename);
	}

	return state;
}

function syncDirectory(fsImpl, directory) {
	if (typeof fsImpl.fsyncSync !== 'function') {
		return;
	}

	let fd;
	try {
		fd = fsImpl.openSync(directory, 'r');
		fsImpl.fsyncSync(fd);
	} catch (_) {
		// Directory fsync is best-effort on platforms/filesystems that support it.
	} finally {
		if (fd !== undefined) {
			try { fsImpl.closeSync(fd); } catch (_) {}
		}
	}
}

function writeStateAtomic(fsImpl, filename, state) {
	const directory = path.dirname(filename);
	const temporary = path.join(
		directory,
		'.' + path.basename(filename) + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp'
	);
	let fd;
	let renamed = false;
	let mode = 0o600;

	try {
		try {
			mode = fsImpl.statSync(filename).mode & 0o777;
		} catch (error) {
			if (!error || error.code !== 'ENOENT') {
				throw error;
			}
		}

		fd = fsImpl.openSync(temporary, 'wx', mode);
		fsImpl.writeFileSync(fd, JSON.stringify(state));
		if (typeof fsImpl.fsyncSync === 'function') {
			fsImpl.fsyncSync(fd);
		}
		fsImpl.closeSync(fd);
		fd = undefined;
		fsImpl.renameSync(temporary, filename);
		renamed = true;
		syncDirectory(fsImpl, directory);
	} finally {
		if (fd !== undefined) {
			try { fsImpl.closeSync(fd); } catch (_) {}
		}
		if (!renamed) {
			try { fsImpl.unlinkSync(temporary); } catch (error) {
				if (!error || error.code !== 'ENOENT') {
					throw error;
				}
			}
		}
	}
}

function getChannelKey(program) {
	const id = program && program.channel && program.channel.id;
	return typeof id === 'string' && id.trim() !== '' ? id.trim() : null;
}

function isEligibleRecording(program, actualSeconds) {
	if (!program || typeof program !== 'object') {
		return false;
	}
	if (!Number.isFinite(actualSeconds) || actualSeconds < MIN_DURATION_SECONDS) {
		return false;
	}
	if (!getChannelKey(program) || !(program.id || program.programId || program.origId)) {
		return false;
	}
	if (program._operatorNg || program._operatorAbort || program.operatorAbort === true ||
		program._operatorEndLack || program.operatorEndLack === true ||
		program.operatorResumePending === true || program.operatorInterruptedAt ||
		program.operatorResumedAt || Number(program.operatorInterruptionCount) > 0) {
		return false;
	}

	const recordingStart = Number(program.operatorRecordingStart);
	const recordingEnd = Number(program.operatorRecordingEnd);
	if (!Number.isFinite(recordingStart) || !Number.isFinite(recordingEnd) || recordingEnd <= recordingStart) {
		return false;
	}

	const scheduledEnd = Number(program.end);
	if (Number.isFinite(scheduledEnd) && scheduledEnd > 0 && recordingEnd + MAX_EARLY_END_SECONDS * 1000 < scheduledEnd) {
		return false;
	}

	return true;
}

function createRecordingMeasurement(program, fileSizeBytes, actualSeconds) {
	if (!isEligibleRecording(program, actualSeconds) || !Number.isSafeInteger(fileSizeBytes) || fileSizeBytes <= 0) {
		return null;
	}

	const recordedAt = Number(program.operatorRecordingEnd);
	const programId = String(program.programId || program.id || program.origId);
	const channel = program.channel || {};

	return {
		channelKey: getChannelKey(program),
		channel: {
			id: getChannelKey(program),
			name: typeof channel.name === 'string' ? channel.name : '',
			type: typeof channel.type === 'string' ? channel.type : '',
			networkId: Number.isFinite(Number(channel.nid)) ? Number(channel.nid) : null,
			serviceId: Number.isFinite(Number(channel.sid)) ? Number(channel.sid) : null
		},
		recording: {
			programId: programId,
			recordedAt: recordedAt,
			seconds: Math.round(actualSeconds * 1000000) / 1000000,
			bytes: fileSizeBytes,
			mbps: roundMbps(fileSizeBytes * 8 / actualSeconds / 1000000),
			source: 'recording'
		}
	};
}

function sameRecording(left, right) {
	return left && right && left.source === right.source &&
		left.programId === right.programId && left.recordedAt === right.recordedAt;
}

function estimateMbps(recordings) {
	if (!Array.isArray(recordings) || recordings.length === 0) {
		return null;
	}

	const values = recordings.map(item => Number(item.mbps)).filter(value => Number.isFinite(value) && value > 0);
	if (values.length === 0) {
		return null;
	}

	const average = values.reduce((sum, value) => sum + value, 0) / values.length;
	const maximum = Math.max.apply(Math, values);
	return roundMbps(Math.max(average * AVERAGE_MULTIPLIER, maximum * MAX_MULTIPLIER));
}

function addMeasurement(state, measurement, nowMs) {
	if (!measurement || !measurement.channelKey || !measurement.recording) {
		throw new Error('invalid bitrate measurement');
	}

	const current = state.channels[measurement.channelKey] || { recordings: [] };
	const recordings = Array.isArray(current.recordings) ? current.recordings.slice() : [];
	if (recordings.some(item => sameRecording(item, measurement.recording))) {
		return false;
	}

	recordings.push(measurement.recording);
	recordings.sort((left, right) => Number(right.recordedAt) - Number(left.recordedAt));
	recordings.splice(MAX_RECORDINGS);

	state.channels[measurement.channelKey] = {
		channel: measurement.channel,
		recordings: recordings,
		sampleCount: recordings.length,
		estimatedMbps: estimateMbps(recordings)
	};
	state.policy = newState().policy;
	state.updatedAt = Number.isFinite(nowMs) ? nowMs : Date.now();
	return true;
}

function updateFile(filename, measurement, options) {
	options = options || {};
	const fsImpl = options.fs || fs;
	const state = readState(fsImpl, filename);
	const updated = addMeasurement(state, measurement, options.nowMs);

	if (updated) {
		writeStateAtomic(fsImpl, filename, state);
	}

	return { updated: updated, state: state };
}

function tryUpdateFile(filename, measurement, options) {
	try {
		return updateFile(filename, measurement, options);
	} catch (error) {
		return { updated: false, error: error };
	}
}

module.exports = {
	AVERAGE_MULTIPLIER,
	MAX_EARLY_END_SECONDS,
	MAX_MULTIPLIER,
	MAX_RECORDINGS,
	MIN_DURATION_SECONDS,
	SCHEMA_VERSION,
	addMeasurement,
	createRecordingMeasurement,
	estimateMbps,
	getChannelKey,
	isEligibleRecording,
	newState,
	readState,
	tryUpdateFile,
	updateFile,
	writeStateAtomic
};
