'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
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

function reservePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const port = server.address().port;
			server.close(error => error ? reject(error) : resolve(port));
		});
	});
}

function request(port, requestPath, method) {
	return new Promise((resolve, reject) => {
		const req = http.request({
			host: '127.0.0.1',
			port: port,
			path: requestPath,
			method: method || 'GET'
		}, response => {
			const chunks = [];
			response.on('data', chunk => chunks.push(chunk));
			response.once('end', () => resolve({
				statusCode: response.statusCode,
				body: Buffer.concat(chunks)
			}));
		});
		req.once('error', reject);
		req.end();
	});
}

function createProgram(start, title, recordedDir) {
	return {
		id: '2',
		programId: '2',
		start: start,
		end: start + 60000,
		seconds: 60,
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
	it('keeps four recordings for one program uniquely addressable and individually deletable', { timeout: 40000 }, async function() {
		const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-recorded-id-'));
		const dataDir = path.join(temporaryDir, 'data');
		const recordedDirs = [ 'A', 'B', 'C', 'D' ].map(name => path.join(temporaryDir, name));
		const sockets = new Set();
		const fixedStart = Date.now() - 1000;
		const baseCollisionId = '2-' + fixedStart.toString(36);
		let streamRequestCount = 0;
		let operator = null;
		let wui = null;
		let mirakurunServer = null;
		let operatorOutput = '';
		let wuiOutput = '';

		function readData(name) {
			return JSON.parse(fs.readFileSync(path.join(dataDir, name + '.json'), 'utf8'));
		}

		try {
			fs.mkdirSync(dataDir);
			fs.mkdirSync(path.join(temporaryDir, 'log'));
			recordedDirs.forEach(dir => fs.mkdirSync(dir));
			[ 'lib', 'node_modules', 'web' ].forEach(name => {
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
				stdio: [ 'ignore', 'pipe', 'pipe' ]
			});
			operator.stdout.on('data', chunk => { operatorOutput += chunk.toString(); });
			operator.stderr.on('data', chunk => { operatorOutput += chunk.toString(); });

			const expectedIds = [
				[ '2' ],
				[ baseCollisionId, '2' ],
				[ baseCollisionId, baseCollisionId + '-2', '2' ],
				[ baseCollisionId, baseCollisionId + '-2', baseCollisionId + '-3', '2' ]
			];

			for (let index = 0; index < 4; index++) {
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
				assert.ok(finalized.every(program => program.programId === '2'));

				if (index < 3) {
					const current = finalized.find(program => program.id === '2');
					current.end = Date.now() - 100;
					const recordedReads = (operatorOutput.match(/READ: .*recorded\.json.*updated/g) || []).length;
					fs.writeFileSync(path.join(dataDir, 'recorded.json'), JSON.stringify(finalized));
					await waitForCondition(
						() => (operatorOutput.match(/READ: .*recorded\.json.*updated/g) || []).length > recordedReads,
						'Operator did not reload recorded data before part ' + (index + 2),
						3000
					);

					const next = createProgram(fixedStart, 'Part ' + (index + 2) + ' metadata', recordedDirs[index + 1]);
					next.end = Date.now() + 60000;
					fs.writeFileSync(path.join(dataDir, 'reserves.json'), JSON.stringify([ next ]));
				}
			}

			const finalRecorded = readData('recorded');
			assert.deepStrictEqual(finalRecorded.map(program => program.id), expectedIds[3]);
			recordedDirs.forEach((dir, index) => {
				assert.strictEqual(fs.readFileSync(path.join(dir, '2.m2ts'), 'utf8'), 'PART' + (index + 1));
			});

			await stopChild(operator);
			operator = null;
			for (const socket of sockets) {
				socket.destroy();
			}
			await new Promise(resolve => mirakurunServer.close(resolve));
			mirakurunServer = null;

			fs.symlinkSync(path.join(repositoryRoot, 'api'), path.join(temporaryDir, 'api'), 'dir');
			[ 'app-wui.js', 'processes.json' ].forEach(name => {
				fs.copyFileSync(path.join(repositoryRoot, name), path.join(temporaryDir, name));
			});
			fs.writeFileSync(path.join(temporaryDir, 'rules.json'), '[]');
			[ 'rules', 'schedule' ].forEach(name => {
				fs.writeFileSync(path.join(dataDir, name + '.json'), '[]');
			});

			const wuiPort = await reservePort();
			config.mirakurunPath = 'http://127.0.0.1:9/';
			config.wuiOpenServer = true;
			config.wuiOpenHost = '127.0.0.1';
			config.wuiOpenPort = wuiPort;
			fs.writeFileSync(path.join(temporaryDir, 'config.json'), JSON.stringify(config));

			wui = childProcess.spawn(process.execPath, [ 'app-wui.js' ], {
				cwd: temporaryDir,
				stdio: [ 'ignore', 'pipe', 'pipe' ]
			});
			wui.stdout.on('data', chunk => { wuiOutput += chunk.toString(); });
			wui.stderr.on('data', chunk => { wuiOutput += chunk.toString(); });
			await waitForCondition(
				() => /HTTP Open Server Listening/.test(wuiOutput),
				'WUI did not start. Output:\n' + wuiOutput,
				8000
			);

			for (let index = 0; index < expectedIds[3].length; index++) {
				const id = expectedIds[3][index];
				const metadata = await request(wuiPort, '/api/recorded/' + encodeURIComponent(id) + '.json');
				const download = await request(wuiPort, '/api/recorded/' + encodeURIComponent(id) + '/file.m2ts');
				assert.strictEqual(metadata.statusCode, 200);
				assert.strictEqual(JSON.parse(metadata.body).id, id);
				assert.strictEqual(download.statusCode, 200);
				assert.strictEqual(download.body.toString(), 'PART' + (index + 1));
			}

			const deletedId = baseCollisionId + '-2';
			const deletedPath = path.join(recordedDirs[1], '2.m2ts');
			const deleteResponse = await request(
				wuiPort,
				'/api/recorded/' + encodeURIComponent(deletedId) + '.json',
				'DELETE'
			);
			assert.strictEqual(deleteResponse.statusCode, 200);
			await waitForCondition(
				() => readData('recorded').length === 3 && !fs.existsSync(deletedPath),
				'DELETE did not remove exactly one recorded entry and file',
				3000
			);

			const remaining = readData('recorded');
			assert.deepStrictEqual(remaining.map(program => program.id), [
				baseCollisionId,
				baseCollisionId + '-3',
				'2'
			]);
			assert.strictEqual(fs.existsSync(deletedPath), false);
			[ 0, 2, 3 ].forEach(index => {
				assert.strictEqual(fs.readFileSync(path.join(recordedDirs[index], '2.m2ts'), 'utf8'), 'PART' + (index + 1));
			});
		} finally {
			await stopChild(operator);
			await stopChild(wui);
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
