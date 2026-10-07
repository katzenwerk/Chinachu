'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Readable, Writable } = require('node:stream');
const { finished } = require('node:stream/promises');
const { it } = require('node:test');
const assert = require('node:assert/strict');

const script = fs.readFileSync(path.join(__dirname, '../api/script-recorded-program-file.vm.js'), 'utf8');
const bytes = Buffer.alloc(1049600);
for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;

async function requestFile(range, options = {}) {
	const body = options.body || bytes;
	const chunks = [];
	const headers = {};
	let status;
	const response = new Writable({ write(chunk, _encoding, next) { chunks.push(chunk); next(); } });
	response.setHeader = (name, value) => { headers[name.toLowerCase()] = String(value); };
	response.head = value => { status = value; };
	response.error = value => { status = value; response.end(); };
	const program = { id: 'fixture', recorded: '/fixture.m2ts' };
	const context = {
		request: { method: 'GET', type: 'm2ts', param: { id: 'fixture' }, headers: { range, ...options.headers } },
		response,
		data: { recorded: [], status: { feature: { filer: options.filer !== false } } },
		define: { MATCH_DATA_FILE: '/match.json' },
		chinachu: { getProgramById: () => options.fallback ? null : program },
		fs: {
			existsSync: filename => filename === '/match.json' || options.exists !== false,
			readFileSync: () => JSON.stringify([{ key: 'fixture', recordingResult: program }]),
			statSync: () => ({ size: body.length }),
			createReadStream: (_filename, { start, end }) => Readable.from([body.subarray(start, end + 1)])
		}
	};
	vm.runInNewContext(script, context);
	await finished(response);
	return { status, headers, body: Buffer.concat(chunks) };
}

it('raw recorded download returns exact single-range bytes including suffix and clamped bounds', async () => {
	for (const [range, start, end] of [
		['bytes=0-999', 0, 999], ['bytes=1000-', 1000, bytes.length - 1],
		['bytes=-1048576', 1024, bytes.length - 1], ['bytes=0-0', 0, 0],
		['bytes=1049599-', bytes.length - 1, bytes.length - 1],
		['bytes=1000-9999999', 1000, bytes.length - 1],
		['bytes=-9999999', 0, bytes.length - 1]
	]) {
		const result = await requestFile(range);
		assert.equal(result.status, 206, range);
		assert.equal(result.headers['accept-ranges'], 'bytes');
		assert.equal(result.headers['content-range'], `bytes ${start}-${end}/${bytes.length}`);
		assert.equal(result.headers['content-length'], String(end - start + 1));
		assert.deepEqual(result.body, bytes.subarray(start, end + 1));
	}
});

it('unsatisfiable byte ranges return 416 with file size and no body', async () => {
	for (const range of ['bytes=1049600-', 'bytes=20-10', 'bytes=-0', 'bytes=999999999999999999999-']) {
		const result = await requestFile(range);
		assert.equal(result.status, 416, range);
		assert.equal(result.headers['content-range'], `bytes */${bytes.length}`);
		assert.equal(result.headers['content-length'], '0');
		assert.equal(result.body.length, 0);
	}
	const empty = await requestFile('bytes=0-', { body: Buffer.alloc(0) });
	assert.equal(empty.status, 416);
	assert.equal(empty.headers['content-range'], 'bytes */0');
});

it('normal downloads, ignored Range forms and match fallback preserve attachment and file contents', async () => {
	for (const range of [undefined, 'bytes=0-1,4-5', 'bytes=oops', 'items=0-1', 'bytes=-']) {
		const result = await requestFile(range);
		assert.equal(result.status, 200);
		assert.equal(result.headers['content-range'], undefined);
		assert.equal(result.headers['content-disposition'], 'attachment; filename="fixture.m2ts"');
		assert.deepEqual(result.body, bytes);
	}
	assert.equal((await requestFile('bytes=0-1', { headers: { 'if-range': '"unknown"' } })).status, 200);
	assert.deepEqual((await requestFile('bytes=0-999', { fallback: true })).body, bytes.subarray(0, 1000));
	const empty = await requestFile(undefined, { body: Buffer.alloc(0) });
	assert.equal(empty.status, 200);
	assert.equal(empty.headers['content-length'], '0');
	assert.equal((await requestFile('bytes=0-999', { filer: false })).status, 403);
	assert.equal((await requestFile('bytes=0-999', { exists: false })).status, 410);
});
