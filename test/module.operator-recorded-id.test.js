'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const repositoryRoot = path.resolve(__dirname, '..');

function waitForCondition(predicate, message, timeoutMs) {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const interval = setInterval(() => {
			try {
				if (predicate()) {
					clearInterval(interval);
					resolve();
					return;
				}
			} catch (error) {
				if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
					clearInterval(interval);
					reject(error);
					return;
				}
			}

			if (Date.now() - startedAt >= timeoutMs) {
				clearInterval(interval);
				reject(new Error(message));
			}
		}, 20);
	});
}

function createProgram(start, title, recordedDir) {
	const end = Date.now() + 3000;
	return {
		id: '2',
		programId: '2',
		start: start,
		end: end,
		seconds: Math.ceil((end - start) / 1000),
		title: title,
		fullTitle: title,
		channel: {
			id: 'channel-2',
			type: 'GR',
			channel: '2',
			sid: 2,
			name: 'Channel 2'
		},
		isManualReserved: true,
		recordedDir: recordedDir
	};
}

async function stopChild(child) {
	if (!child || child.exitCode !== null || child.signalCode !== null) {
		return;
	}

	const exited = new Promise(resolve => child.once('exit', resolve));
	child.kill('SIGKILL');
	await exited;
}

describe('Operator recorded ID collisions', function() {
	it('keeps repeated recordings for one program as unique ledger entries and files', { timeout: 30000 }, async function() {
		const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-recorded-id-'));
		const dataDir = path.join(temporaryDir, 'data');
		const recordedDirs = [ 'A', 'B', 'C' ].map(name => path.join(temporaryDir, name));
		const sockets = new Set();
		const fixedStart = Date.now() - 1000;
		const baseCollisionId = '2-' + fixedStart.toString(36);
		let streamRequestCount = 0;
		let operator = null;
		let mirakurunServer = null;

		function readData(name) {
			return JSON.parse(fs.readFileSync(path.join(dataDir, name + '.json'), 'utf8'));
		}

		try {
			fs.mkdirSync(dataDir);
			fs.mkdirSync(path.join(temporaryDir, 'log'));
			recordedDirs.forEach(dir => fs.mkdirSync(dir));
			[ 'lib', 'node_modules' ].forEach(name => {
				fs.symlinkSync(path.join(repositoryRoot, name), path.join(temporaryDir, name), 'dir');
			});
			[ 'app-operator.js', 'package.json' ].forEach(name => {
				fs.copyFileSync(path.join(repositoryRoot, name), path.join(temporaryDir, name));
			});
			[ 'reserves2', 'recording', 'recorded', 'match' ].forEach(name => {
				fs.writeFileSync(path.join(dataDir, name + '.json'), '[]');
			});

			const docs = {
				swagger: '2.0',
				basePath: '/api',
				paths: {
					'/programs/{id}/stream': {
						parameters: [ { name: 'id', in: 'path', required: true, type: 'integer' } ],
						get: {
							tags: [ 'stream' ],
							operationId: 'getProgramStream',
							parameters: [ { name: 'decode', in: 'query', type: 'integer' } ]
						}
					}
				}
			};

			mirakurunServer = http.createServer((req, res) => {
				if (req.url === '/api/docs') {
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify(docs));
					return;
				}

				if (/^\/api\/programs\/2\/stream\?/.test(req.url)) {
					streamRequestCount++;
					res.writeHead(200, { 'Content-Type': 'video/MP2T' });
					res.write(Buffer.from('PART' + streamRequestCount));
					return;
				}

				res.writeHead(404, { 'Content-Type': 'application/json' });
				res.end('{}');
			});
			mirakurunServer.on('connection', socket => {
				sockets.add(socket);
				socket.once('close', () => sockets.delete(socket));
			});
			await new Promise((resolve, reject) => {
				mirakurunServer.once('error', reject);
				mirakurunServer.listen(0, '127.0.0.1', resolve);
			});

			const config = {
				mirakurunPath: 'http://127.0.0.1:' + mirakurunServer.address().port + '/',
				recordedDir: recordedDirs[0],
				recordedFormat: '<id>.m2ts',
				handoffPrepSeconds: 20,
				operatorReserveCheckIntervalSec: 1,
				operatorPrepReserveCheckIntervalSec: 1,
				mirakurunDropCheckIntervalSec: 0,
				storageLowSpaceAction: 'none'
			};
			fs.writeFileSync(path.join(temporaryDir, 'config.json'), JSON.stringify(config));
			fs.writeFileSync(path.join(dataDir, 'reserves.json'), JSON.stringify([
				createProgram(fixedStart, 'Part 1 metadata', recordedDirs[0])
			]));

			operator = childProcess.spawn(process.execPath, [ 'app-operator.js' ], {
				cwd: temporaryDir,
				stdio: 'ignore',
				env: Object.assign({}, process.env, { CHINACHU_RUNTIME_DIR: path.join(temporaryDir, 'runtime') })
			});

			const expectedIds = [
				[ '2' ],
				[ baseCollisionId, '2' ],
				[ baseCollisionId, baseCollisionId + '-2', '2' ]
			];

			for (let index = 0; index < 3; index++) {
				const recordedPath = path.join(recordedDirs[index], '2.m2ts');
				await waitForCondition(
					() => streamRequestCount === index + 1 &&
						fs.existsSync(recordedPath) &&
						fs.readFileSync(recordedPath, 'utf8') === 'PART' + (index + 1),
					'Operator did not start recording part ' + (index + 1),
					8000
				);

				const recording = readData('recording');
				assert.strictEqual(recording.length, 1);
				recording[0].abort = true;
				fs.writeFileSync(path.join(dataDir, 'recording.json'), JSON.stringify(recording));

				await waitForCondition(
					() => readData('recording').length === 0 &&
						readData('recorded').some(program => program.title === 'Part ' + (index + 1) + ' metadata'),
					'Operator did not finalize part ' + (index + 1),
					4000
				);

				const finalized = readData('recorded');
				assert.deepStrictEqual(finalized.map(program => program.id), expectedIds[index]);
				assert.strictEqual(new Set(finalized.map(program => program.id)).size, finalized.length);
				assert.strictEqual(new Set(finalized.map(program => program.recorded)).size, finalized.length);
				assert.ok(finalized.every(program => program.programId === '2'));

				if (index < 2) {
					const current = finalized.find(program => program.id === '2');
					await waitForCondition(
						() => Date.now() > current.end,
						'Recording window did not close before part ' + (index + 2),
						5000
					);

					const next = createProgram(fixedStart, 'Part ' + (index + 2) + ' metadata', recordedDirs[index + 1]);
					fs.writeFileSync(path.join(dataDir, 'reserves.json'), JSON.stringify([ next ]));
				}
			}

			const finalRecorded = readData('recorded');
			assert.deepStrictEqual(finalRecorded.map(program => program.id), expectedIds[2]);
			assert.deepStrictEqual(finalRecorded.map(program => program.recorded), recordedDirs.map(dir => path.join(dir, '2.m2ts')));
			recordedDirs.forEach((dir, index) => {
				assert.strictEqual(fs.readFileSync(path.join(dir, '2.m2ts'), 'utf8'), 'PART' + (index + 1));
			});
		} finally {
			await stopChild(operator);
			for (const socket of sockets) {
				socket.destroy();
			}
			if (mirakurunServer && mirakurunServer.listening) {
				await new Promise(resolve => mirakurunServer.close(resolve));
			}
			fs.rmSync(temporaryDir, { recursive: true, force: true });
		}
	});
});
