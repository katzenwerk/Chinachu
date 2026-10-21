'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

async function liveProgramController() {
	const source = fs.readFileSync(path.join(__dirname, '../next-web/services/live-program-controller.js'), 'utf8');
	return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

test('live programme follows exact channel boundaries, schedule changes, visibility and disposal', async function () {
	const model = await liveProgramController();
	const midnight = new Date(2026, 9, 17, 0, 0, 0, 0).getTime();
	let now = midnight - 1000;
	let nextSchedule = [];
	let scheduleListener = null;
	let unsubscribed = 0;
	let nextTimerId = 0;
	const timers = new Map();
	const visibilityListeners = new Set();
	const documentRef = {
		visibilityState: 'visible',
		addEventListener(type, listener) { if (type === 'visibilitychange') visibilityListeners.add(listener); },
		removeEventListener(type, listener) { if (type === 'visibilitychange') visibilityListeners.delete(listener); }
	};
	const updates = [];
	const schedule = [{
		id: 'GR_1',
		programs: [
			{ id: 'A', title: '前番組', detail: 'A', start: midnight - 60000, end: midnight },
			{ id: 'B', title: '次番組', detail: 'B', start: midnight, end: midnight + 60000 }
		]
	}, { id: 'GR_10', programs: [{ id: 'wrong', start: midnight - 60000, end: midnight + 60000 }] }];
	const controller = model.createLiveProgramController({
		channelId: 'GR_1',
		initialSchedule: schedule,
		clock: () => now,
		setTimer(callback, delay) {
			const id = ++nextTimerId;
			timers.set(id, { callback, delay });
			return id;
		},
		clearTimer: id => timers.delete(id),
		documentRef,
		subscribeSchedule(listener) {
			scheduleListener = listener;
			return () => { unsubscribed += 1; scheduleListener = null; };
		},
		loadSchedule: async () => nextSchedule,
		onProgram: (program, info) => updates.push({ id: program?.id || null, title: program?.title || null, ...info })
	});

	assert.strictEqual(updates.at(-1).id, 'A');
	assert.strictEqual(timers.size, 1);
	assert.strictEqual([...timers.values()][0].delay, 1000);
	now = midnight;
	const boundaryTimer = [...timers.entries()][0];
	timers.delete(boundaryTimer[0]);
	boundaryTimer[1].callback();
	assert.strictEqual(updates.at(-1).id, 'B');
	assert.strictEqual(timers.size, 1);

	nextSchedule = [{ id: 'GR_1', programs: [{ id: 'B', title: '次番組・訂正', detail: '更新', start: midnight, end: midnight + 90000 }] }];
	await scheduleListener();
	assert.strictEqual(updates.at(-1).title, '次番組・訂正');
	assert.strictEqual(updates.at(-1).reason, 'schedule');
	assert.strictEqual(timers.size, 1);
	assert.strictEqual([...timers.values()][0].delay, 90000);

	nextSchedule = [{ id: 'GR_1', programs: [{ id: 'C', title: '深夜番組', start: midnight + 120000, end: midnight + 180000 }] }];
	await controller.refreshSchedule();
	assert.strictEqual(updates.at(-1).id, null);
	assert.strictEqual(timers.size, 1);
	now = midnight + 120000;
	const futureTimer = [...timers.entries()][0];
	timers.delete(futureTimer[0]);
	futureTimer[1].callback();
	assert.strictEqual(updates.at(-1).id, 'C');

	now += 5000;
	visibilityListeners.forEach(listener => listener());
	assert.strictEqual(updates.at(-1).reason, 'visibility');
	assert.strictEqual(updates.at(-1).rebaseProgress, true);
	assert.strictEqual(timers.size, 1);

	controller.dispose();
	assert.strictEqual(timers.size, 0);
	assert.strictEqual(visibilityListeners.size, 0);
	assert.strictEqual(unsubscribed, 1);
	assert.strictEqual(scheduleListener, null);
});
