'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const reservationStore = require('./reservation-store');

const DEFAULTS = Object.freeze({ version: 1, timetable: { channelWidth: 170, hourHeight: 180 } });

function integerInRange(value, minimum, maximum, step) {
	return Number.isInteger(value) && value >= minimum && value <= maximum && (value - minimum) % step === 0;
}

function normalize(value) {
	value = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
	const timetable = value.timetable && typeof value.timetable === 'object' ? value.timetable : {};
	const channelWidth = integerInRange(timetable.channelWidth, 100, 260, 10)
		? timetable.channelWidth : DEFAULTS.timetable.channelWidth;
	const hourHeight = integerInRange(timetable.hourHeight, 80, 300, 10)
		? timetable.hourHeight : DEFAULTS.timetable.hourHeight;
	return Object.assign({}, value, {
		version: 1,
		timetable: Object.assign({}, timetable, { channelWidth, hourHeight })
	});
}

function validateTimetable(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('timetable config must be an object');
	if (!integerInRange(value.channelWidth, 100, 260, 10)) throw new Error('channelWidth must be 100..260 in steps of 10');
	if (!integerInRange(value.hourHeight, 80, 300, 10)) throw new Error('hourHeight must be 80..300 in steps of 10');
}

function read(file) {
	try {
		return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
	} catch (error) {
		if (error && error.code === 'ENOENT') return normalize(DEFAULTS);
		throw error;
	}
}

function writeAtomic(file, value) {
	const directory = path.dirname(file);
	const temporary = path.join(directory, '.' + path.basename(file) + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp');
	let descriptor;
	try {
		descriptor = fs.openSync(temporary, 'wx', 0o600);
		fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n');
		fs.fsyncSync(descriptor);
		fs.closeSync(descriptor);
		descriptor = undefined;
		fs.renameSync(temporary, file);
	} finally {
		if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch (_) {}
		try { fs.unlinkSync(temporary); } catch (_) {}
	}
}

function update(file, patch) {
	if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('config patch must be an object');
	if (Object.prototype.hasOwnProperty.call(patch, 'timetable')) validateTimetable(patch.timetable);
	const lock = reservationStore.acquire(file);
	try {
		const current = read(file);
		const next = normalize(Object.assign({}, current, patch, {
			timetable: Object.assign({}, current.timetable, patch.timetable || {})
		}));
		writeAtomic(file, next);
		return next;
	} finally {
		lock.release();
	}
}

module.exports = { DEFAULTS, normalize, read, update, validateTimetable, writeAtomic };
