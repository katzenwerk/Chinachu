'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const vm = require('node:vm');
const wuiConfig = require('../lib/wui-config');

async function timetableModel() {
	const source = fs.readFileSync(path.join(__dirname, '../next-web/services/timetable-model.js'), 'utf8');
	return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

test('timetable and recording-history positions preserve intervals and tuner identity', async function () {
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

	const warningSource = fs.readFileSync(path.join(__dirname, '../next-web/services/recorded-result-warnings.js'), 'utf8');
	const { operatorRecordingInfo } = await import('data:text/javascript;base64,' + Buffer.from(warningSource).toString('base64'));
	const timelineSource = fs.readFileSync(path.join(__dirname, '../next-web/pages/conflicts-page.js'), 'utf8');
	const context = vm.createContext({ operatorRecordingInfo });
	vm.runInContext(timelineSource.slice(timelineSource.indexOf('function placeTimelineEntry('),
		timelineSource.indexOf('function createTimeline(')), context);
	const tuners = [{ name: 'PT3 BS 1', index: 2, types: ['BS'] }, { name: 'PT3 GR 1', index: 0, types: ['GR'] }];
	const recording = (id, begin, end, tuner = { tunerName: 'PT3 GR 1', tunerIndex: 0 }) => ({ id,
		start: start - 86400000, end: start - 86400000 + 60000, tuner: { name: 'dummy' },
		operatorRecordingStart: start + begin, operatorRecordingEnd: start + end, mirakurunDrop: tuner });
	const history = context.historyTracks([
		recording('next', 47280, 300000), recording('prior', 0, 45280), recording('overlap', 40000, 50000),
		recording('unknown', 0, 10000, {}), recording('past', 0, 10000, { tunerName: 'Old PT3', tunerIndex: 0 }),
		{ id: 'missing-times', start, end: start + 60000, tuner: { name: 'PT3 GR 1' } },
		recording('outside', -60000, -1)
	], { start, end: start + 3 * 3600000 });
	assert.deepStrictEqual(Array.from(history.rows, row => row.label), ['Old PT3', 'PT3 GR 1', '割当不明']);
	assert.strictEqual(history.unavailable, 1);
	const recordedTuner = history.rows.find(row => row.key === `recorded:${JSON.stringify(['PT3 GR 1', 0])}`);
	assert.strictEqual(recordedTuner.tracks.length, 2);
	assert.deepStrictEqual(Array.from(recordedTuner.tracks[0], entry => entry.program.id), ['prior', 'next']);
	assert.strictEqual(recordedTuner.tracks[0][1].period.start - recordedTuner.tracks[0][0].period.end, 2000);
	assert.strictEqual(recordedTuner.tracks[0][1].period.start, start + 47280);
	assert.match(operatorRecordingInfo(recording('precise', 47280, 60000)).startLabel, /:47\.280$/);
	assert.match(operatorRecordingInfo(recording('precise', 47280, 60000)).endLabel, /:00$/);
	assert.strictEqual(operatorRecordingInfo({ start, end: start + 10000, tuner: { name: 'dummy' } }).startLabel, '未取得');
	assert.strictEqual(operatorRecordingInfo({ mirakurunDrop: { tunerIndex: null } }).tunerLabel, '割当不明');
	const partial = context.historyTracks([
		recording('name-only', 0, 1000, { tunerName: 'same' }),
		recording('index-only', 0, 1000, { tunerIndex: 0 }),
		recording('both', 0, 1000, { tunerName: 'same', tunerIndex: 0 }),
		recording('other-index', 0, 1000, { tunerName: 'same', tunerIndex: 1 })
	], { start, end: start + 2000 });
	assert.deepStrictEqual(Array.from(partial.rows, row => row.label), ['same', 'チューナー #0', 'same', 'same']);
	assert.notStrictEqual(partial.rows[2].key, partial.rows[3].key);
	assert.deepStrictEqual(Array.from(partial.rows, row => Array.from(row.tracks[0], entry => entry.program.id)),
		[['name-only'], ['index-only'], ['both'], ['other-index']]);
	for (const [saved, expected] of [
		[{ tunerName: 'PT3-S3', tunerIndex: 0 }, 'PT3-S3'],
		[{ tunerName: 'e-better DTV02A-4TS-P #1', tunerIndex: 2 }, 'e-better DTV02A-4TS-P #1'],
		[{ tunerIndex: 2 }, 'チューナー #2'], [{}, '割当不明'],
		[{ tunerName: ' PT3-S3 ', tunerIndex: 0 }, ' PT3-S3 ']
	]) {
		const info = operatorRecordingInfo({ mirakurunDrop: saved });
		assert.strictEqual(info.tunerLabel, expected);
		assert.strictEqual(info.tunerIndex, saved.tunerIndex ?? null);
	}

	// Exercise the existing API script without Mirakurun or service operations.
	const api = fs.readFileSync(path.join(__dirname, '../api/script-tuners.vm.js'), 'utf8');
	let output, status;
	await vm.runInNewContext(api, { mirakurun: { getTuners: async () => tuners.map(tuner => ({ ...tuner, command: 'private-command', users: [] })) },
		response: { head(code) { status = code; }, end(body) { output = JSON.parse(body); }, error(code) { status = code; } } });
	assert.strictEqual(status, 200);
	assert.deepStrictEqual(output, tuners.map(tuner => ({ types: tuner.types, name: tuner.name, index: tuner.index })));
	await vm.runInNewContext(api, { mirakurun: { getTuners: async () => [{ types: [] }] },
		response: { error(code) { status = code; } } });
	assert.strictEqual(status, 502);
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
