'use strict';

const EventEmitter = require('events');
const { once } = require('events');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const epgJobWatch = require('../lib/mirakurun-epg-job-watch');

class FakeStream extends EventEmitter {
	constructor() {
		super();
		this.destroyed = false;
		this.req = {
			destroyed: false,
			destroy: () => {
				this.req.destroyed = true;
			}
		};
	}

	write(chunk) {
		this.emit('data', Buffer.from(chunk));
	}

	destroy() {
		this.destroyed = true;
	}
}

function jobEvent(data) {
	return {
		resource: 'job',
		type: 'update',
		data: data,
		time: Date.now()
	};
}

function writeEvent(stream, event) {
	stream.write(JSON.stringify(event) + '\n,\n');
}

function createClient(streams) {
	let calls = 0;
	return {
		getEventsStream: async query => {
			assert.deepStrictEqual(query, { type: 'update' });
			const stream = streams[calls++];
			if (!stream) {
				throw new Error('No fake stream available');
			}
			return stream;
		},
		getCallCount: () => calls
	};
}

async function startWatcher(options) {
	const connected = once(options.watcher, 'connected');
	options.watcher.start();
	await connected;
	return options.watcher;
}

function openCycle(stream, parentId, startedAt, finishedAt) {
	writeEvent(stream, jobEvent({
		id: parentId,
		key: 'EPG.Gatherer',
		status: 'running',
		startedAt: startedAt
	}));
	writeEvent(stream, jobEvent({
		id: parentId,
		key: 'EPG.Gatherer',
		status: 'finished',
		startedAt: startedAt,
		finishedAt: finishedAt
	}));
}

function createManualTimers() {
	const timers = [];
	return {
		timers: timers,
		setTimeout: (callback, delay) => {
			const timer = { callback: callback, delay: delay, cleared: false };
			timers.push(timer);
			return timer;
		},
		clearTimeout: timer => {
			timer.cleared = true;
		}
	};
}

describe('Mirakurun EPG Job watcher', function() {
	it('classifies all terminal states and settles a cycle exactly once', async function() {
		const stream = new FakeStream();
		const childIds = [ 'completed-child', 'skipped-child', 'failed-child', 'aborted-child' ];
		const watcher = epgJobWatch.createWatcher({
			client: createClient([ stream ]),
			fetchJobs: async () => childIds.map((id, index) => ({
				id: id,
				key: 'EPG.Gather.NID.' + (index + 1),
				status: 'running',
				createdAt: 110 + index
			}))
		});
		let settledCount = 0;
		watcher.on('cycleSettled', () => { settledCount++; });

		await startWatcher({ watcher: watcher });
		const frozen = once(watcher, 'childrenFrozen');
		openCycle(stream, 'parent-terminal', 100, 200);
		await frozen;

		const settled = once(watcher, 'cycleSettled');
		writeEvent(stream, jobEvent({ id: 'completed-child', key: 'EPG.Gather.NID.1', status: 'finished' }));
		writeEvent(stream, jobEvent({ id: 'skipped-child', key: 'EPG.Gather.NID.2', status: 'finished', hasSkipped: true, hasAborted: true }));
		writeEvent(stream, jobEvent({ id: 'failed-child', key: 'EPG.Gather.NID.3', status: 'finished', hasFailed: true }));
		writeEvent(stream, jobEvent({ id: 'aborted-child', key: 'EPG.Gather.NID.4', status: 'finished', hasAborted: true }));

		const result = await settled;
		assert.strictEqual(result[0], 'parent-terminal');
		assert.deepStrictEqual(result[1], {
			total: 4,
			completed: 1,
			skipped: 1,
			failed: 1,
			aborted: 1
		});

		writeEvent(stream, jobEvent({ id: 'aborted-child', key: 'EPG.Gather.NID.4', status: 'finished', hasAborted: true }));
		assert.strictEqual(settledCount, 1);
		watcher.stop();
	});

	it('releases active streams and pending reconnect work on shutdown', async function() {
		const activeStream = new FakeStream();
		const activeWatcher = epgJobWatch.createWatcher({
			client: createClient([ activeStream ]),
			fetchJobs: async () => []
		});

		await startWatcher({ watcher: activeWatcher });
		writeEvent(activeStream, jobEvent({
			id: 'parent-shutdown',
			key: 'EPG.Gatherer',
			status: 'running',
			startedAt: 100
		}));
		activeWatcher.stop();

		assert.strictEqual(activeStream.req.destroyed, true);
		assert.strictEqual(activeStream.destroyed, true);
		assert.deepStrictEqual(activeWatcher.getState(), {
			started: false,
			stopped: true,
			connected: false,
			reconnectPending: false,
			cycle: null
		});

		const reconnectStream = new FakeStream();
		const timers = createManualTimers();
		const client = createClient([ reconnectStream ]);
		const reconnectWatcher = epgJobWatch.createWatcher({
			client: client,
			fetchJobs: async () => [],
			setTimeout: timers.setTimeout,
			clearTimeout: timers.clearTimeout
		});

		await startWatcher({ watcher: reconnectWatcher });
		reconnectStream.emit('end');
		assert.strictEqual(timers.timers.length, 1);

		reconnectWatcher.stop();

		assert.strictEqual(timers.timers[0].cleared, true);
		assert.strictEqual(reconnectWatcher.getState().reconnectPending, false);
		timers.timers[0].callback();
		assert.strictEqual(client.getCallCount(), 1);
	});
});
