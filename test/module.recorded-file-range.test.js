'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Readable, Writable } = require('node:stream');
const { finished } = require('node:stream/promises');
const { it } = require('node:test');
const assert = require('node:assert/strict');
const matchDetailResolver = require('../lib/match-detail-resolver');
const matchDeletionHistory = require('../lib/match-deletion-history');
const recordedThumbnail = require('../lib/recorded-thumbnail');

const script = fs.readFileSync(path.join(__dirname, '../api/script-recorded-program-file.vm.js'), 'utf8');
const recordedProgramScript = fs.readFileSync(path.join(__dirname, '../api/script-recorded-program.vm.js'), 'utf8');
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
	const matchItems = options.match || [{ key: 'fixture', recordingResult: program }];
	const context = {
		request: { method: 'GET', type: 'm2ts', param: { id: 'fixture' }, headers: { range, ...options.headers } },
		response,
		data: { recorded: options.fallback ? [] : [program], reserves: [], schedule: [], status: { feature: { filer: options.filer !== false } } },
		define: { MATCH_DATA_FILE: '/match.json', RESERVES2_DATA_FILE: '/reserves2.json' },
		chinachu: { getProgramById: () => options.fallback ? null : program },
		matchDetailResolver,
		fs: {
			existsSync: filename => filename === '/match.json' || options.exists !== false,
			readFileSync: filename => filename === '/reserves2.json' ? JSON.stringify(options.reserves2 || []) : JSON.stringify(matchItems),
			statSync: () => ({ size: body.length }),
			createReadStream: (_filename, { start, end }) => Readable.from([body.subarray(start, end + 1)])
		}
	};
	vm.runInNewContext(script, context);
	await finished(response);
	return { status, headers, body: Buffer.concat(chunks) };
}

function deleteRecorded(targetScript, fileExists, options = {}) {
	const recordedPath = '/fixture.m2ts';
	const matchPath = '/match.json';
	const recordedPathJson = '/recorded.json';
	const thumbnailDir = '/thumbnails';
	const thumbnailPath = '/thumbnails/fixture.jpg';
	const program = { id: 'fixture', recorded: recordedPath };
	const match = options.match || [{
		key: 'fixture',
		program: { id: 'fixture', recorded: recordedPath },
		recordingResult: { id: 'fixture', recorded: recordedPath, snapshot: { id: 'fixture', recorded: recordedPath } }
	}];
	const writes = options.trace && options.trace.writes || {};
	const unlinked = options.trace && options.trace.unlinked || [];
	const thumbnailRequests = options.trace && options.trace.thumbnailRequests || [];
	let currentMatch = JSON.parse(JSON.stringify(match));
	let status;
	let responseBody = null;
	const response = {
		setHeader() {},
		head(value) { status = value; },
		end(value) { responseBody = value ? JSON.parse(value) : null; },
		error(value) { status = value; }
	};
	const context = {
		request: { method: 'DELETE', type: 'json', param: { id: 'fixture' }, headers: {} },
		response,
		data: { recorded: [program], recording: options.recording || [], reserves: [], schedule: [], status: { feature: { filer: true } } },
		define: {
			MATCH_DATA_FILE: matchPath,
			RECORDED_DATA_FILE: recordedPathJson,
			RESERVES2_DATA_FILE: '/reserves2.json',
			RECORDED_THUMBNAIL_DIR: thumbnailDir,
			RECORDED_THUMBNAIL_SOCKET: '/recorded-thumbnail.sock'
		},
		chinachu: { getProgramById: () => program },
		config: {},
		storageHealth: {
			findDestination: () => ({ id: null }),
			getDestinations: () => [{ id: null, path: '/' }]
		},
		path,
		matchDetailResolver,
		matchDeletionHistory,
		recordedThumbnail,
		storageRefreshIpc: { request(_connection, payload) { thumbnailRequests.push(payload); return Promise.resolve({}); } },
		reservationStore: {
			withLock(_file, callback) { return callback(); },
			readArray(filename) {
				return filename === recordedPathJson ? [JSON.parse(JSON.stringify(program))] : JSON.parse(JSON.stringify(currentMatch));
			},
			writeArrayAtomic(filename, value) {
				if (filename === matchPath && (options.saveFailure || options.matchSaveFailure)) throw new Error('fixture match save failed');
				if (filename === recordedPathJson && options.recordedSaveFailure) throw new Error('fixture recorded save failed');
				const saved = JSON.parse(JSON.stringify(value));
				if (filename === matchPath) currentMatch = saved;
				writes[filename] = saved;
			}
		},
		util: { log() {} },
		fs: {
			existsSync(filename) {
				return filename === matchPath || filename === recordedPathJson ||
					(filename === recordedPath && fileExists) || (filename === thumbnailPath && options.thumbnail === true);
			},
			readFileSync(filename) {
				if (filename === matchPath) return JSON.stringify(match);
				if (filename === '/reserves2.json') return '[]';
				throw new Error('unexpected read: ' + filename);
			},
			statSync() { return { isFile() { return true; } }; },
			unlinkSync(filename) {
				if (filename === thumbnailPath && options.thumbnail !== true) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
				unlinked.push(filename);
				if (filename === recordedPath && options.unlinkFailure) throw new Error('fixture unlink failed');
				if (filename === thumbnailPath && options.thumbnailFailure) throw Object.assign(new Error('fixture thumbnail unlink failed'), { code: 'EACCES' });
			}
		}
	};
	vm.runInNewContext(targetScript, context);
	return { status, body: responseBody, writes, unlinked, thumbnailRequests };
}

function requestRecordedDetail(options = {}) {
	const recordedPath = '/fixture.m2ts';
	const start = 1760194800000;
	const matchPath = '/match.json';
	const reserves2Path = '/reserves2.json';
	const direct = { id: 'fixture', fullTitle: 'Recorded detail', recorded: recordedPath };
	const match = options.match || [{
		schemaVersion: 2,
		key: `channel-a|${start}|1800`,
		status: 'RECORDED',
		start,
		end: start + 1800000,
		fullTitle: 'Minimal match title',
		recording: { recordedId: 'fixture', path: recordedPath },
		deletion: null
	}];
	let status;
	let body;
	const context = {
		request: { method: 'GET', param: { id: 'fixture' } },
		response: {
			head(value) { status = value; },
			end(value) { body = value; },
			error(value) { status = value; }
		},
		data: { recorded: options.direct === false ? [] : [direct], reserves: [], schedule: [], status: { feature: {} } },
		define: { MATCH_DATA_FILE: matchPath, RESERVES2_DATA_FILE: reserves2Path },
		matchDetailResolver,
		matchDeletionHistory,
		reservationStore: {},
		util: { log() {} },
		fs: {
			existsSync(filename) { return filename === matchPath || filename === reserves2Path || filename === recordedPath && options.fileExists !== false; },
			readFileSync(filename) {
				if (filename === matchPath) return JSON.stringify(match);
				if (filename === reserves2Path) return JSON.stringify(options.reserves2 || []);
				throw new Error('unexpected read: ' + filename);
			}
		}
	};
	vm.runInNewContext(recordedProgramScript, context);
	return { status, body: body ? JSON.parse(body) : null };
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

it('resolves recorded detail and file GET from recorded first, then v2 match and external metadata', async () => {
	const direct = requestRecordedDetail();
	assert.equal(direct.status, 200);
	assert.equal(direct.body.fullTitle, 'Recorded detail');
	assert.equal(direct.body._recordedSource, 'recorded');

	const start = 1760194800000;
	const reserve = {
		id: 'reserve-fixture',
		start,
		end: start + 1800000,
		seconds: 1800,
		fullTitle: 'Reserve detail',
		channel: { id: 'channel-a', name: 'Channel A', type: 'GR' }
	};
	const fallback = requestRecordedDetail({ direct: false, reserves2: [reserve] });
	assert.equal(fallback.status, 200);
	assert.equal(fallback.body.fullTitle, 'Reserve detail');
	assert.equal(fallback.body.recorded, '/fixture.m2ts');
	assert.equal(fallback.body._recordedSource, 'match');

	const minimal = requestRecordedDetail({ direct: false });
	assert.equal(minimal.status, 200);
	assert.equal(minimal.body.fullTitle, 'Minimal match title');
	assert.equal(minimal.body.recorded, '/fixture.m2ts');

	const v2File = await requestFile('bytes=0-999', {
		fallback: true,
		match: [{
			schemaVersion: 2,
			key: `channel-a|${start}|1800`,
			status: 'RECORDED',
			start,
			end: start + 1800000,
			fullTitle: 'Minimal match title',
			recording: { recordedId: 'fixture', path: '/fixture.m2ts' },
			deletion: null
		}]
	});
	assert.equal(v2File.status, 206);
	assert.deepEqual(v2File.body, bytes.subarray(0, 1000));
});

it('manual DELETE records its reason only when it actually removes the recording file', () => {
	for (const targetScript of [script, recordedProgramScript]) {
		const deleted = deleteRecorded(targetScript, true);
		assert.equal(deleted.status, 200);
		assert.deepEqual(deleted.unlinked, ['/fixture.m2ts']);
		const item = deleted.writes['/match.json'][0];
		for (const value of [item.recordingResult, item.recordingResult.snapshot, item.program]) {
			assert.equal(value.fileExists, false);
			assert.equal(value.cleanupState, 'deleted');
			assert.equal(value.cleanupReason, 'manual');
			assert.ok(value.deletedAt > 0);
		}

		const historyOnly = deleteRecorded(targetScript, false);
		assert.equal(historyOnly.status, 410);
		assert.deepEqual(historyOnly.unlinked, []);
		assert.equal(historyOnly.writes['/match.json'], undefined);
		assert.equal(historyOnly.body.code, 'recorded-file-missing');
	}
});

it('does not update deletion history when file removal fails', () => {
	for (const targetScript of [script, recordedProgramScript]) {
		const trace = { writes: {}, unlinked: [] };
		const failed = deleteRecorded(targetScript, true, { unlinkFailure: true, trace });
		assert.equal(failed.status, 500);
		assert.equal(failed.body.code, 'file-delete-failed');
		assert.equal(failed.body.fileDeleted, false);
		assert.deepEqual(trace.unlinked, ['/fixture.m2ts']);
		assert.equal(trace.writes['/match.json'], undefined);
	}
});

it('stops DELETE before unlink when no corresponding match history entry exists', () => {
	const unrelated = [{
		schemaVersion: 2,
		key: 'channel-other|1760194800000|1800',
		status: 'RECORDED',
		start: 1760194800000,
		end: 1760196600000,
		fullTitle: 'Other',
		recording: { recordedId: 'other', path: '/other.m2ts' },
		deletion: null
	}];
	for (const targetScript of [script, recordedProgramScript]) {
		const deleted = deleteRecorded(targetScript, true, { match: unrelated });
		assert.equal(deleted.status, 409);
		assert.deepEqual(deleted.unlinked, []);
		assert.equal(deleted.writes['/match.json'], undefined);
		assert.equal(deleted.body.code, 'target-not-found');
	}
});

it('manual DELETE updates only the matching v2 entry and preserves recorded history fields', () => {
	const start = 1760194800000;
	const target = {
		schemaVersion: 2,
		key: `channel-a|${start}|1800`,
		status: 'RECORDED',
		start,
		end: start + 1800000,
		fullTitle: 'Target',
		recording: { recordedId: 'fixture', path: '/fixture.m2ts' },
		deletion: null
	};
	const other = {
		schemaVersion: 2,
		key: `channel-b|${start}|1800`,
		status: 'RECORDED',
		start,
		end: start + 1800000,
		fullTitle: 'Other',
		recording: { recordedId: 'fixture', path: '/other.m2ts' },
		deletion: null
	};

	for (const targetScript of [script, recordedProgramScript]) {
		const deleted = deleteRecorded(targetScript, true, { match: [target, other] });
		assert.equal(deleted.status, 200);
		const items = deleted.writes['/match.json'];
		assert.equal(items[0].status, 'RECORDED');
		assert.deepEqual(items[0].recording, { recordedId: 'fixture', path: '/fixture.m2ts' });
		assert.equal(items[0].deletion.reason, 'manual');
		assert.ok(items[0].deletion.deletedAt > 0);
			assert.equal(items[0].program, undefined);
			assert.equal(items[0].recordingResult, undefined);
			assert.equal(items[1].deletion, null);
			if (targetScript === recordedProgramScript) {
				assert.deepEqual(deleted.body.storageRefresh, { targetKnown: true, storageId: null });
			}
		}
});

it('reports a match history save failure after deletion without claiming history success', () => {
	for (const targetScript of [script, recordedProgramScript]) {
		const failed = deleteRecorded(targetScript, true, { saveFailure: true });
		assert.equal(failed.status, 500);
		assert.deepEqual(failed.unlinked, ['/fixture.m2ts']);
		assert.equal(failed.writes['/match.json'], undefined);
		assert.equal(failed.body.status, 'partial');
		assert.equal(failed.body.fileDeleted, true);
		assert.equal(failed.body.matchUpdated, false);
		assert.equal(failed.body.recordedUpdated, false);
	}
});

it('stops ambiguous and active targets before deleting the recording file', () => {
	const duplicate = [{
		key: 'fixture-a', program: { id: 'fixture', recorded: '/fixture.m2ts' },
		recordingResult: { id: 'fixture', recorded: '/fixture.m2ts' }
	}, {
		key: 'fixture-b', program: { id: 'fixture', recorded: '/fixture.m2ts' },
		recordingResult: { id: 'fixture', recorded: '/fixture.m2ts' }
	}];
	for (const targetScript of [script, recordedProgramScript]) {
		const ambiguous = deleteRecorded(targetScript, true, { match: duplicate });
		assert.equal(ambiguous.status, 409);
		assert.equal(ambiguous.body.code, 'ambiguous-target');
		assert.deepEqual(ambiguous.unlinked, []);
		const active = deleteRecorded(targetScript, true, { recording: [{ id: 'fixture', recorded: '/fixture.m2ts' }] });
		assert.equal(active.status, 409);
		assert.equal(active.body.code, 'recording-active');
		assert.deepEqual(active.unlinked, []);
	}
});

it('reports recorded ledger failure independently and retains thumbnails after file deletion', () => {
	for (const targetScript of [script, recordedProgramScript]) {
		const ledgerFailed = deleteRecorded(targetScript, true, { recordedSaveFailure: true });
		assert.equal(ledgerFailed.status, 500);
		assert.equal(ledgerFailed.body.status, 'partial');
		assert.equal(ledgerFailed.body.fileDeleted, true);
		assert.equal(ledgerFailed.body.matchUpdated, true);
		assert.equal(ledgerFailed.body.recordedUpdated, false);

			const thumbnailRetained = deleteRecorded(targetScript, true, { thumbnail: true, thumbnailFailure: true });
			assert.equal(thumbnailRetained.status, 200);
			assert.equal(thumbnailRetained.body.status, 'complete');
			assert.equal(thumbnailRetained.body.thumbnail.status, 'retained');
			assert.deepEqual(thumbnailRetained.unlinked, ['/fixture.m2ts']);
			assert.equal(thumbnailRetained.thumbnailRequests.length, 1);
			assert.equal(thumbnailRetained.thumbnailRequests[0].id, 'fixture');
			assert.equal(thumbnailRetained.thumbnailRequests[0].action, 'cancel');
	}
});
