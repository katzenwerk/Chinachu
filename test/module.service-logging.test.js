'use strict';

const childProcess = require('child_process');
const fs = require('fs');
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
				clearInterval(interval);
				reject(error);
				return;
			}

			if (Date.now() - startedAt >= timeoutMs) {
				clearInterval(interval);
				reject(new Error(message));
			}
		}, 20);
	});
}

function waitForExit(child, timeoutMs) {
	return new Promise((resolve, reject) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolve({ code: child.exitCode, signal: child.signalCode });
			return;
		}

		const timeout = setTimeout(() => {
			child.removeListener('exit', onExit);
			reject(new Error('Child process did not exit within the timeout'));
		}, timeoutMs);

		function onExit(code, signal) {
			clearTimeout(timeout);
			resolve({ code: code, signal: signal });
		}

		child.once('exit', onExit);
	});
}

function processHasOpenPath(pid, targetPath) {
	const fdDir = '/proc/' + pid + '/fd';
	let entries;

	try {
		entries = fs.readdirSync(fdDir);
	} catch (error) {
		if (error.code === 'ENOENT') {
			return false;
		}
		throw error;
	}

	return entries.some(entry => {
		try {
			return fs.readlinkSync(path.join(fdDir, entry)).replace(/ \(deleted\)$/, '') === targetPath;
		} catch (error) {
			return false;
		}
	});
}

function isProcessAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code !== 'ESRCH';
	}
}

function writeOperatorFixture(temporaryDir) {
	const dataDir = path.join(temporaryDir, 'data');
	const logDir = path.join(temporaryDir, 'log');
	const fakeChinachu = path.join(temporaryDir, 'chinachu');

	fs.mkdirSync(dataDir);
	fs.mkdirSync(logDir);
	fs.symlinkSync(path.join(repositoryRoot, 'lib'), path.join(temporaryDir, 'lib'), 'dir');
	fs.symlinkSync(path.join(repositoryRoot, 'node_modules'), path.join(temporaryDir, 'node_modules'), 'dir');
	fs.symlinkSync(path.join(repositoryRoot, 'web'), path.join(temporaryDir, 'web'), 'dir');
	fs.copyFileSync(path.join(repositoryRoot, 'app-operator.js'), path.join(temporaryDir, 'app-operator.js'));
	fs.copyFileSync(path.join(repositoryRoot, 'package.json'), path.join(temporaryDir, 'package.json'));
	fs.writeFileSync(path.join(temporaryDir, 'config.json'), JSON.stringify({
		mirakurunPath: 'http://127.0.0.1:9/',
		recordedDir: path.join(temporaryDir, 'recorded'),
		recordedFormat: '<id>.m2ts',
		mirakurunDropCheckIntervalSec: 0,
		storageLowSpaceAction: 'none'
	}));
	[ 'reserves', 'reserves2', 'recording', 'recorded', 'match' ].forEach(name => {
		fs.writeFileSync(path.join(dataDir, name + '.json'), '[]');
	});

	fs.writeFileSync(fakeChinachu, [
		'#!/usr/bin/env node',
		"'use strict';",
		"const fs = require('fs');",
		"const path = require('path');",
		"const countFile = path.join(process.cwd(), 'scheduler-run-count');",
		"const pidFile = path.join(process.cwd(), 'scheduler-child-pid');",
		"const logFile = path.join(process.cwd(), 'log', 'scheduler');",
		"const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0;",
		"const payload = 'SCHEDULER_EVENT_ONCE\\n' + ('x'.repeat(1023) + '\\n').repeat(1024);",
		"fs.writeFileSync(countFile, String(count + 1));",
		"fs.writeFileSync(pidFile, String(process.pid));",
		"fs.appendFileSync(logFile, payload);",
		"process.stdout.write(payload);"
	].join('\n'));
	fs.chmodSync(fakeChinachu, 0o755);
}

function writeWuiFixture(temporaryDir) {
	const dataDir = path.join(temporaryDir, 'data');

	fs.mkdirSync(dataDir);
	fs.mkdirSync(path.join(temporaryDir, 'log'));
	fs.symlinkSync(path.join(repositoryRoot, 'api'), path.join(temporaryDir, 'api'), 'dir');
	fs.symlinkSync(path.join(repositoryRoot, 'lib'), path.join(temporaryDir, 'lib'), 'dir');
	fs.symlinkSync(path.join(repositoryRoot, 'node_modules'), path.join(temporaryDir, 'node_modules'), 'dir');
	fs.symlinkSync(path.join(repositoryRoot, 'web'), path.join(temporaryDir, 'web'), 'dir');
	fs.copyFileSync(path.join(repositoryRoot, 'app-wui.js'), path.join(temporaryDir, 'app-wui.js'));
	fs.copyFileSync(path.join(repositoryRoot, 'package.json'), path.join(temporaryDir, 'package.json'));
	fs.copyFileSync(path.join(repositoryRoot, 'processes.json'), path.join(temporaryDir, 'processes.json'));
	fs.writeFileSync(path.join(temporaryDir, 'config.json'), JSON.stringify({
		mirakurunPath: 'http://127.0.0.1:9/',
		wuiOpenServer: false
	}));
	fs.writeFileSync(path.join(temporaryDir, 'rules.json'), '[]');
	[ 'rules', 'reserves', 'schedule', 'recording', 'recorded', 'match' ].forEach(name => {
		fs.writeFileSync(path.join(dataDir, name + '.json'), '[]');
	});
}

describe('Service logging regressions', function() {
	it('records one operator-started scheduler run once and drains its stdout', { timeout: 15000 }, async function() {
		const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-scheduler-log-'));
		const schedulerLog = path.join(temporaryDir, 'log', 'scheduler');
		const operatorSource = fs.readFileSync(path.join(repositoryRoot, 'app-operator.js'), 'utf8');
		const launcherSource = fs.readFileSync(path.join(repositoryRoot, 'chinachu'), 'utf8');
		let operator = null;
		let output = '';

		try {
			writeOperatorFixture(temporaryDir);
			assert.match(launcherSource, /chinachu_update[\s\S]*?tee -a \.\/log\/scheduler/);
			assert.match(operatorSource, /scheduler\.stdout\.resume\(\)/);
			assert.doesNotMatch(operatorSource, /createWriteStream\(['"]\.\/log\/scheduler/);

			operator = childProcess.spawn(process.execPath, [ 'app-operator.js' ], {
				cwd: temporaryDir,
				stdio: [ 'ignore', 'pipe', 'pipe' ]
			});
			operator.stdout.on('data', chunk => { output += chunk.toString(); });
			operator.stderr.on('data', chunk => { output += chunk.toString(); });

			await waitForCondition(
				() => /EXIT: node app-scheduler\.js/.test(output),
				'Operator-started scheduler did not exit. Output:\n' + output,
				10000
			);

			const log = fs.readFileSync(schedulerLog, 'utf8');
			const schedulerPid = Number(fs.readFileSync(path.join(temporaryDir, 'scheduler-child-pid'), 'utf8'));
			assert.strictEqual(fs.readFileSync(path.join(temporaryDir, 'scheduler-run-count'), 'utf8'), '1');
			assert.strictEqual((log.match(/^SCHEDULER_EVENT_ONCE$/gm) || []).length, 1);
			assert.strictEqual((output.match(/SPAWN: \.\/chinachu update/g) || []).length, 1);
			assert.strictEqual((output.match(/EXIT: node app-scheduler\.js/g) || []).length, 1);
			assert.strictEqual(processHasOpenPath(operator.pid, schedulerLog), false);
			assert.strictEqual(isProcessAlive(schedulerPid), false);
			assert.strictEqual(fs.readFileSync('/proc/' + operator.pid + '/task/' + operator.pid + '/children', 'utf8').trim(), '');

			const exitPromise = waitForExit(operator, 2000);
			operator.kill('SIGTERM');
			const exit = await exitPromise;
			assert.strictEqual(exit.signal, null);
			assert.strictEqual(exit.code, 0);
		} finally {
			if (operator && operator.exitCode === null && operator.signalCode === null) {
				operator.kill('SIGKILL');
				await waitForExit(operator, 2000).catch(() => {});
			}
			fs.rmSync(temporaryDir, { recursive: true, force: true });
		}
	});

	it('uses a fixed JST timestamp for WUI service logs even when TZ is UTC', { timeout: 10000 }, async function() {
		const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-wui-log-time-'));
		const startedAt = Date.now();
		let wui = null;
		let output = '';

		try {
			writeWuiFixture(temporaryDir);
			wui = childProcess.spawn(process.execPath, [ 'app-wui.js' ], {
				cwd: temporaryDir,
				env: Object.assign({}, process.env, { TZ: 'UTC' }),
				stdio: [ 'ignore', 'pipe', 'pipe' ]
			});
			wui.stdout.on('data', chunk => { output += chunk.toString(); });
			wui.stderr.on('data', chunk => { output += chunk.toString(); });

			await waitForCondition(
				() => /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} - READ:/m.test(output),
				'WUI did not emit a JST service log. Output:\n' + output,
				5000
			);

			const match = output.match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2}) - READ:/m);
			const loggedAt = Date.UTC(
				Number(match[1]),
				Number(match[2]) - 1,
				Number(match[3]),
				Number(match[4]) - 9,
				Number(match[5]),
				Number(match[6])
			);
			assert.ok(loggedAt >= startedAt - 1000);
			assert.ok(loggedAt <= Date.now() + 1000);
			assert.doesNotMatch(output, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z - /m);

			const exitPromise = waitForExit(wui, 2000);
			wui.kill('SIGTERM');
			const exit = await exitPromise;
			assert.strictEqual(exit.signal, null);
			assert.strictEqual(exit.code, 0);
		} finally {
			if (wui && wui.exitCode === null && wui.signalCode === null) {
				wui.kill('SIGKILL');
				await waitForExit(wui, 2000).catch(() => {});
			}
			fs.rmSync(temporaryDir, { recursive: true, force: true });
		}
	});
});
