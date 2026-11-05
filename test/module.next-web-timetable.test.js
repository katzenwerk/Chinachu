'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const wuiConfig = require('../lib/wui-config');

async function timetableModel() {
	const source = fs.readFileSync(path.join(__dirname, '../next-web/services/timetable-model.js'), 'utf8');
	return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

test('timetable positions preserve duration and clip programmes at the broadcast-day edges', async function () {
	const model = await timetableModel();
	const start = new Date(2026, 9, 15, 4, 0, 0, 0).getTime();
	const sixHours = model.programPosition({ start: start + 2 * 3600000, end: start + 8 * 3600000 }, start, 180);
	assert.deepStrictEqual(sixHours, { top: 360, height: 1080, clippedStart: false, clippedEnd: false });
	const crossing = model.programPosition({ start: start - 3600000, end: start + 3600000 }, start, 180);
	assert.deepStrictEqual(crossing, { top: 0, height: 180, clippedStart: true, clippedEnd: false });
	assert.strictEqual(model.programPosition({ start: start + 25 * 3600000, end: start + 26 * 3600000 }, start, 180), null);

	const now = new Date(2026, 9, 15, 23, 20, 0, 0).getTime();
	const currentRange = model.guideDisplayRange(start, now);
	assert.deepStrictEqual(currentRange, {
		start: new Date(2026, 9, 15, 23, 0, 0, 0).getTime(),
		end: new Date(2026, 9, 16, 4, 0, 0, 0).getTime(),
		current: true,
		currentDayStart: start
	});
	const ongoing = model.programPosition({ start: now - 80 * 60000, end: now + 60 * 60000 }, currentRange.start, 180, currentRange.end);
	assert.deepStrictEqual(ongoing, { top: 0, height: 240, clippedStart: true, clippedEnd: false });
	const earlyMorning = new Date(2026, 9, 16, 2, 30, 0, 0).getTime();
	assert.strictEqual(model.guideDisplayRange(start, earlyMorning).current, true);
	assert.strictEqual(model.guideDisplayRange(start + 86400000, now).start, start + 86400000);
	assert.strictEqual(model.isProgramLive({ start: now, end: now + 1 }, now), true);
	assert.strictEqual(model.isProgramLive({ start: now - 1, end: now }, now), false);
	const program = { id: 'program-1' };
	assert.strictEqual(model.programState(program, [], []).key, 'none');
	assert.strictEqual(model.programState(program, [{ id: program.id, isManualReserved: true }], []).key, 'manual');
	assert.strictEqual(model.programState(program, [{ id: program.id, ruleUid: 'rule-1' }], []).key, 'rule');
	assert.strictEqual(model.programState(program, [{ id: program.id, isConflict: true }], []).key, 'conflict');
	assert.strictEqual(model.programState(program, [{ id: program.id, isConflict: true, isSkip: true }], []).key, 'skip');
	assert.strictEqual(model.programState(program, [{ id: program.id }], [{ id: program.id }]).key, 'recording');
	assert.strictEqual(model.programState(program, [{ id: 'other-program', isConflict: true }], []).key, 'none');
});

test('server WUI config validates timetable ranges and preserves other page settings atomically', async function () {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-wui-config-'));
	const file = path.join(root, 'wui-config.json');
	try {
		assert.deepStrictEqual(wuiConfig.read(file).timetable, { channelWidth: 170, hourHeight: 180 });
		assert.deepStrictEqual(wuiConfig.read(file).timetable, (await timetableModel()).TIMETABLE_DEFAULTS);
		fs.writeFileSync(file, JSON.stringify({ version: 1, home: { layout: 'C' }, timetable: { channelWidth: 150, hourHeight: 180 } }));
		const updated = wuiConfig.update(file, { timetable: { channelWidth: 220, hourHeight: 260 } });
		assert.deepStrictEqual(updated.home, { layout: 'C' });
		assert.deepStrictEqual(updated.timetable, { channelWidth: 220, hourHeight: 260 });
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), updated);
		assert.throws(() => wuiConfig.update(file, { timetable: { channelWidth: 221, hourHeight: 260 } }), /channelWidth/);
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), updated);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
