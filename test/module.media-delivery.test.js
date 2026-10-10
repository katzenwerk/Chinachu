'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Readable, Writable } = require('node:stream');
const { finished } = require('node:stream/promises');
const { it } = require('node:test');
const mediaModule = require('../lib/media-delivery');

function fakeEnvironment(root, options = {}) {
	const calls = { spawns: [], kills: [] };
	const children = [];
	const spawn = (_command, args) => {
		const child = new EventEmitter();
		child.pid = 1000 + children.length;
		child.exitCode = null;
		child.signalCode = null;
		child.stdin = new PassThrough();
		child.stderr = new PassThrough();
		child.kill = signal => {
			calls.kills.push(signal);
			child.signalCode = signal;
			setImmediate(() => child.emit('exit', null, signal));
			return true;
		};
		calls.spawns.push(args);
		children.push(child);
		const output = args.at(-1);
		if (output.endsWith('index.m3u8')) {
			const directory = path.dirname(output);
			fs.writeFileSync(path.join(directory, 'init.mp4'), Buffer.from('init'));
			fs.writeFileSync(path.join(directory, 'segment000000.m4s'), Buffer.from('segment'));
			fs.writeFileSync(output, '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\nsegment000000.m4s\n');
		} else if (options.recordedCompletes !== false) {
			fs.writeFileSync(output, Buffer.from('0123456789abcdef'));
			setImmediate(() => {
				child.exitCode = 0;
				child.emit('exit', 0, null);
			});
		}
		return child;
	};
	const mirakurun = { getServiceStream: async () => Readable.from([Buffer.from('ts')]) };
	const manager = mediaModule.createMediaDelivery({ root, spawn, mirakurun, killTimeoutMs: 10 });
	return { manager, calls, children };
}

async function send(manager, filename, range, method = 'GET') {
	const chunks = [];
	const headers = {};
	let status;
	const response = new Writable({ write(chunk, _encoding, next) { chunks.push(chunk); next(); } });
	response.setHeader = (name, value) => { headers[name.toLowerCase()] = String(value); };
	response.head = code => { status = code; };
	manager.sendFile({ method, headers: range ? { range } : {} }, response, filename);
	await finished(response);
	return { status, headers, body: Buffer.concat(chunks) };
}

it('creates isolated fMP4 HLS sessions, restricts assets, and cleans up explicitly or after failure', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-media-live-'));
	const { manager, calls, children } = fakeEnvironment(root);
	try {
		const first = await manager.createLiveSession('gr011');
		const second = await manager.createLiveSession('gr011');
		assert.match(first.id, /^[a-f0-9]{48}$/);
		assert.notEqual(first.id, second.id);
		const args = calls.spawns[0];
		assert.deepEqual(args.slice(args.indexOf('-hls_time'), args.indexOf('-hls_time') + 2), ['-hls_time', '2']);
		assert.equal(args[args.indexOf('-hls_list_size') + 1], '6');
		assert.equal(args[args.indexOf('-hls_segment_type') + 1], 'fmp4');
		assert.match(args[args.indexOf('-hls_flags') + 1], /delete_segments/);
		assert.match(args[args.indexOf('-hls_flags') + 1], /independent_segments/);
		assert.equal(manager.getLiveAsset('gr011', first.id, 'index.m3u8').size > 0, true);
		assert.equal(manager.getLiveAsset('gr011', first.id, 'init.mp4').size, 4);
		assert.equal(manager.getLiveAsset('other', first.id, 'index.m3u8'), null);
		assert.equal(manager.getLiveAsset('gr011', first.id, '../index.m3u8'), null);
		assert.equal(manager.getLiveAsset('gr011', first.id, 'secret.txt'), null);
		const firstDirectory = path.join(root, 'live', first.id);
		assert.equal(manager.stopLiveSession(first.id, 'test close'), true);
		assert.equal(fs.existsSync(firstDirectory), false);
		assert.equal(calls.kills.includes('SIGTERM'), true);

		const secondDirectory = path.join(root, 'live', second.id);
		children[1].exitCode = 1;
		children[1].emit('exit', 1, null);
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(fs.existsSync(secondDirectory), false, 'abnormal FFmpeg exit removes the session directory');
		await assert.rejects(manager.createLiveSession('../bad'));
	} finally {
		manager.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

it('builds a reusable faststart recording and serves exact HEAD and single byte ranges', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-media-recorded-'));
	const source = path.join(root, 'source.m2ts');
	fs.writeFileSync(source, Buffer.from('source-ts'));
	const { manager, calls } = fakeEnvironment(path.join(root, 'cache'));
	try {
		const handle = manager.acquireRecorded(source);
		const mp4 = await handle.promise;
		handle.release();
		const args = calls.spawns[0];
		assert.equal(args.includes('-re'), false);
		assert.equal(args[args.indexOf('-movflags') + 1], '+faststart');
		assert.equal(args[args.indexOf('-profile:v') + 1], 'high');
		assert.equal(args[args.indexOf('-level:v') + 1], '4.0');

		const head = await send(manager, mp4, undefined, 'HEAD');
		assert.equal(head.status, 200);
		assert.equal(head.headers['content-length'], '16');
		assert.equal(head.headers['accept-ranges'], 'bytes');
		assert.equal(head.body.length, 0);
		const full = await send(manager, mp4);
		assert.equal(full.status, 200);
		assert.equal(full.body.toString(), '0123456789abcdef');
		for (const [range, expected, contentRange] of [
			['bytes=0-1', '01', 'bytes 0-1/16'],
			['bytes=5-', '56789abcdef', 'bytes 5-15/16'],
			['bytes=-4', 'cdef', 'bytes 12-15/16']
		]) {
			const result = await send(manager, mp4, range);
			assert.equal(result.status, 206, range);
			assert.equal(result.headers['content-range'], contentRange);
			assert.equal(result.body.toString(), expected);
		}
		const invalid = await send(manager, mp4, 'bytes=20-30');
		assert.equal(invalid.status, 416);
		assert.equal(invalid.headers['content-range'], 'bytes */16');
		assert.equal(invalid.body.length, 0);

		const cached = manager.acquireRecorded(source);
		assert.equal(await cached.promise, mp4);
		cached.release();
		assert.equal(calls.spawns.length, 1, 'the completed cache is reused');
	} finally {
		manager.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

it('creates progressive recorded fMP4 HLS sessions and cleans them up without changing live HLS', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-media-recorded-hls-'));
	const source = path.join(root, 'source.m2ts');
	fs.writeFileSync(source, Buffer.from('source-ts'));
	const { manager, calls, children } = fakeEnvironment(path.join(root, 'cache'));
	try {
		const session = await manager.createRecordedHlsSession('recorded-id', source);
		assert.match(session.id, /^[a-f0-9]{48}$/);
		const args = calls.spawns[0];
		assert.equal(args.includes('-re'), false, 'recorded HLS converts without realtime input throttling');
		assert.equal(args[args.indexOf('-hls_time') + 1], '2');
		assert.equal(args[args.indexOf('-hls_list_size') + 1], '0');
		assert.equal(args[args.indexOf('-hls_playlist_type') + 1], 'event');
		assert.equal(args[args.indexOf('-hls_segment_type') + 1], 'fmp4');
		assert.match(args[args.indexOf('-hls_flags') + 1], /independent_segments/);
		assert.doesNotMatch(args[args.indexOf('-hls_flags') + 1], /delete_segments/);
		assert.equal(manager.getRecordedHlsAsset('recorded-id', session.id, 'index.m3u8').size > 0, true);
		assert.equal(manager.getRecordedHlsAsset('recorded-id', session.id, 'init.mp4').size, 4);
		assert.equal(manager.getRecordedHlsAsset('other', session.id, 'index.m3u8'), null);
		assert.equal(manager.getRecordedHlsAsset('recorded-id', session.id, '../index.m3u8'), null);
		const directory = path.join(root, 'cache', 'recorded-hls', session.id);
		assert.equal(manager.stopRecordedHlsSession('recorded-id', session.id, 'test close'), true);
		assert.equal(fs.existsSync(directory), false);
		assert.equal(calls.kills.includes('SIGTERM'), true);

		const failed = await manager.createRecordedHlsSession('recorded-id', source);
		const failedDirectory = path.join(root, 'cache', 'recorded-hls', failed.id);
		children[1].exitCode = 1;
		children[1].emit('exit', 1, null);
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(fs.existsSync(failedDirectory), false, 'abnormal FFmpeg exit removes recorded HLS assets');

		const completed = await manager.createRecordedHlsSession('recorded-id', source);
		const completedDirectory = path.join(root, 'cache', 'recorded-hls', completed.id);
		children[2].exitCode = 0;
		children[2].emit('exit', 0, null);
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(fs.existsSync(completedDirectory), true, 'normal FFmpeg completion keeps HLS assets available');
		assert.equal(manager.getRecordedHlsAsset('recorded-id', completed.id, 'segment000000.m4s').size, 7);
		assert.equal(manager.stopRecordedHlsSession('recorded-id', completed.id, 'playback ended'), true);
		assert.equal(fs.existsSync(completedDirectory), false);
		await assert.rejects(manager.createRecordedHlsSession('../bad', source));
	} finally {
		manager.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

it('terminates an unfinished recorded conversion when its last client disconnects', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-media-disconnect-'));
	const source = path.join(root, 'source.m2ts');
	fs.writeFileSync(source, Buffer.from('source-ts'));
	const { manager, calls } = fakeEnvironment(path.join(root, 'cache'), { recordedCompletes: false });
	try {
		const handle = manager.acquireRecorded(source);
		handle.promise.catch(() => {});
		handle.release();
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(calls.kills[0], 'SIGTERM');
	} finally {
		manager.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

it('rejects a symlink as the temporary media root', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-media-root-'));
	const real = path.join(root, 'real');
	const link = path.join(root, 'link');
	fs.mkdirSync(real);
	fs.symlinkSync(real, link, 'dir');
	try {
		assert.throws(() => mediaModule.createMediaDelivery({ root: link }), /not a real directory/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
