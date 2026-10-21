'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { describe, it } = require('node:test');

const logHistory = require('../lib/log-history');

function withFixture(run) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-log-history-'));
	const logDir = path.join(root, 'log');
	fs.mkdirSync(logDir);
	const options = {
		repositoryRoot: root,
		logDir: logDir,
		operatorStdout: 'log/chinachu-operator.stdout.log',
		operatorStderr: 'log/chinachu-operator.stderr.log',
		scheduler: 'log/scheduler',
		wuiStdout: 'log/chinachu-wui.stdout.log',
		wuiStderr: 'log/chinachu-wui.stderr.log'
	};
	try {
		return run({ root, logDir, options });
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

describe('log history reader', function() {
	it('lists only allowed regular logs and reads bounded pages from the end', function() {
		withFixture(({ root, logDir, options }) => {
			const current = path.join(logDir, 'chinachu-operator.stdout.log');
			fs.writeFileSync(current, Array.from({ length: 700 }, (_, index) => 'line-' + String(index + 1).padStart(4, '0')).join('\n') + '\n');
			fs.writeFileSync(path.join(logDir, 'chinachu-operator.stdout__2026-10-11_00-00-00.log'), 'rotated\n');
			fs.writeFileSync(path.join(logDir, 'unrelated.log'), 'secret\n');
			fs.writeFileSync(path.join(root, 'outside.log'), 'outside\n');
			fs.symlinkSync(path.join(root, 'outside.log'), path.join(logDir, 'chinachu-operator.stdout__symlink.log'));

			const files = logHistory.listFiles(options, 'operator');
			assert.deepStrictEqual(files.map(file => file.filename).sort(), [
				'chinachu-operator.stdout.log',
				'chinachu-operator.stdout__2026-10-11_00-00-00.log'
			].sort());
			const id = files.find(file => file.current && file.stream === 'stdout').id;
			const latest = logHistory.readChunk(options, { id: id, lines: 300 });
			assert.strictEqual(latest.lines.length, 300);
			assert.strictEqual(latest.lines[0], 'line-0401');
			assert.strictEqual(latest.lines.at(-1), 'line-0700');
			assert.strictEqual(latest.hasMore, true);
			assert.ok(latest.limits.bytes <= logHistory.MAX_READ_BYTES);

			const older = logHistory.readChunk(options, { id: id, lines: 300, before: latest.cursor });
			assert.strictEqual(older.lines[0], 'line-0101');
			assert.strictEqual(older.lines.at(-1), 'line-0400');
			assert.strictEqual(older.lines.some(line => latest.lines.includes(line)), false);

			assert.throws(
				() => logHistory.readChunk(options, { id: '../../outside.log', lines: 300 }),
				error => error.statusCode === 404
			);

			fs.renameSync(current, path.join(logDir, 'chinachu-operator.stdout__2026-10-12_00-00-00.log'));
			fs.writeFileSync(current, 'new-current\n');
			assert.throws(
				() => logHistory.readChunk(options, { id: id, lines: 300, before: latest.cursor }),
				error => error.statusCode === 404
			);
		});
	});

	it('keeps the legacy stream defaults while allowing bounded rotation following', function() {
		const source = fs.readFileSync(path.resolve(__dirname, '../api/script-log-stream.vm.js'), 'utf8');
		function run(query) {
			const request = new EventEmitter();
			request.param = { name: 'operator' };
			request.query = query;
			const response = new EventEmitter();
			let writes = 0;
			let spawnArgs;
			response.head = () => {};
			response.write = () => { writes += 1; };
			response.end = () => {};
			response.error = code => { throw new Error('Unexpected HTTP ' + code); };
			response.flushHeaders = () => {};
			vm.runInNewContext(source, {
				request,
				response,
				fs: { existsSync: () => true },
				define: { OPERATOR_LOG_FILE: '/log/operator' },
				child_process: {
					spawn(command, args) {
						spawnArgs = [command].concat(args);
						return { pid: 123, stdout: { pipe() {} }, on() {}, kill() {} };
					}
				},
				children: []
			});
			return { spawnArgs, writes };
		}

		assert.deepStrictEqual(run({}), {
			spawnArgs: ['tail', '-f', '-n', '100', '/log/operator'],
			writes: 1
		});
		assert.deepStrictEqual(run({ lines: '9999', follow: 'rotation', padding: '0' }), {
			spawnArgs: ['tail', '-F', '-n', '300', '/log/operator'],
			writes: 0
		});
	});

	it('proxies only the fixed Mirakurun recent-log and stream methods', async function() {
		const recentSource = fs.readFileSync(path.resolve(__dirname, '../api/script-log.vm.js'), 'utf8');
		const streamSource = fs.readFileSync(path.resolve(__dirname, '../api/script-log-stream.vm.js'), 'utf8');
		let recentBody = '';
		let recentStatus = null;
		await vm.runInNewContext(recentSource, {
			request: { param: { name: 'mirakurun' } },
			response: {
				head(code) { recentStatus = code; },
				end(value) { recentBody = value; },
				error(code) { throw new Error('Unexpected HTTP ' + code); }
			},
			mirakurun: { getLog: async () => 'recent-one\nrecent-two\n' },
			String
		});
		assert.strictEqual(recentStatus, 200);
		assert.strictEqual(recentBody, 'recent-one\nrecent-two\n');

		const request = new EventEmitter();
		request.param = { name: 'mirakurun' };
		let streamStatus = null;
		let flushed = false;
		let piped = false;
		let destroyed = false;
		const response = {
			head(code) { streamStatus = code; },
			flushHeaders() { flushed = true; },
			end() {},
			error(code) { throw new Error('Unexpected HTTP ' + code); }
		};
		const upstream = {
			pipe(target) { piped = target === response; },
			once() {},
			unpipe() {},
			destroy() { destroyed = true; }
		};
		await vm.runInNewContext(streamSource, {
			request,
			response,
			mirakurun: { getLogStream: async () => upstream }
		});
		assert.strictEqual(streamStatus, 200);
		assert.strictEqual(flushed, true);
		assert.strictEqual(piped, true);
		request.emit('close');
		assert.strictEqual(destroyed, true);
	});
});
