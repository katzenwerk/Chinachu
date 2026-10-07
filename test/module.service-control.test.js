'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const vm = require('vm');

const serviceControlModule = require('../lib/service-control');

function fixture(options) {
	options = options || {};
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-service-control-'));
	const home = path.join(root, 'home');
	const pm2Home = path.join(root, options.pm2Home || 'home/.pm2');
	const data = path.join(root, 'data');
	fs.mkdirSync(pm2Home, { recursive: true });
	fs.mkdirSync(data, { recursive: true });
	fs.writeFileSync(path.join(pm2Home, 'pm2.pid'), '999\n');
	fs.writeFileSync(path.join(pm2Home, 'rpc.sock'), '');
	fs.writeFileSync(path.join(root, 'app-operator.js'), '');
	fs.writeFileSync(path.join(root, 'app-wui.js'), '');
	fs.writeFileSync(path.join(data, 'recording.json'), options.recording === undefined ? '[]' : options.recording);
	fs.writeFileSync(path.join(data, 'chinachu-operator.pid'), '111\n');
	fs.writeFileSync(path.join(data, 'chinachu-wui.pid'), '222\n');

	const list = [
		{
			name: 'chinachu-operator', pid: 111, pm_id: 0,
			pm2_env: {
				status: 'online', restart_time: 2, pm_uptime: 1000,
				pm_cwd: root, pm_exec_path: path.join(root, 'app-operator.js'),
				pm_pid_path: path.join(data, 'chinachu-operator.pid')
			}
		},
		{
			name: 'chinachu-wui', pid: 222, pm_id: 1,
			pm2_env: {
				status: 'online', restart_time: 4, pm_uptime: 2000,
				pm_cwd: root, pm_exec_path: path.join(root, 'app-wui.js'),
				pm_pid_path: path.join(data, 'chinachu-wui.pid')
			}
		}
	];
	if (options.mutateList) options.mutateList(list, root);
	const calls = [];
	const runtimeProcess = {
		pid: 222,
		env: Object.assign({ PM2_HOME: pm2Home, pm_id: '1', PATH: process.env.PATH }, options.env || {}),
		getuid: () => process.getuid(),
		kill: pid => {
			if (pid !== 999 && !list.some(item => Number(item.pid) === Number(pid))) {
				const error = new Error('missing');
				error.code = 'ESRCH';
				throw error;
			}
		}
	};
	const runtimeFs = options.fs || fs;
	const execFile = (command, args, execOptions, callback) => {
		calls.push({ command, args: args.slice(), options: execOptions });
		if (options.execError) return callback(options.execError);
		if (args[0] === 'jlist') return callback(null, JSON.stringify(list));
		if (args[0] === 'restart') {
			if (options.restartError) return callback(options.restartError);
			const item = list.find(candidate => candidate.pm_id === Number(args[1]));
			if (!item) return callback(new Error('unknown id'));
			item.pid += 1000;
			item.pm2_env.restart_time++;
			item.pm2_env.pm_uptime += 10000;
			if (item.name === 'chinachu-wui') runtimeProcess.pid = item.pid;
			fs.writeFileSync(item.pm2_env.pm_pid_path, String(item.pid) + '\n');
			return callback(null, '{}');
		}
		callback(new Error('unexpected command'));
	};
	const control = serviceControlModule.createServiceControl({
		rootDir: root,
		recordingPath: path.join(data, 'recording.json'),
		process: runtimeProcess,
		os: { userInfo: () => ({ username: 'fixture', homedir: home }) },
		fs: runtimeFs,
		execFile: execFile,
		pm2Binary: '/fixture/pm2',
		responseDelayMs: 1,
		pollIntervalMs: 1,
		restartTimeoutMs: 100,
		inspectTimeoutMs: 100
	});
	return { root, home, pm2Home, data, list, calls, control };
}

async function waitFor(predicate, timeout) {
	const deadline = Date.now() + (timeout || 500);
	while (Date.now() <= deadline) {
		const value = await predicate();
		if (value) return value;
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	throw new Error('condition was not met');
}

test('enables only verified normal-user PM2 targets and keeps target decisions independent', async t => {
	const subject = fixture();
	t.after(() => fs.rmSync(subject.root, { recursive: true, force: true }));
	let report = await subject.control.inspect();
	assert.strictEqual(report.targets.operator.operable, true);
	assert.strictEqual(report.targets.wui.operable, true);
	assert.strictEqual(report.targets.operator.manager, 'pm2-user');
	assert.deepStrictEqual(subject.calls[0].args, [ 'jlist' ]);
	assert.strictEqual(subject.calls[0].options.env.PM2_HOME, subject.pm2Home);
	const suffixedPidFile = path.join(subject.data, 'chinachu-operator-0.pid');
	fs.writeFileSync(suffixedPidFile, '111\n');
	subject.list[0].pm2_env.pm_pid_path = suffixedPidFile;
	report = await subject.control.inspect();
	assert.strictEqual(report.targets.operator.operable, true);

	subject.list[0].pm2_env.pm_exec_path = path.join(subject.root, 'another-app-operator.js');
	report = await subject.control.inspect();
	assert.strictEqual(report.targets.operator.operable, false);
	assert.match(report.targets.operator.summary, /同名プロセス/);
	assert.strictEqual(report.targets.wui.operable, true);

	const customHomeSubject = fixture({ pm2Home: 'runtime/pm2-home' });
	t.after(() => fs.rmSync(customHomeSubject.root, { recursive: true, force: true }));
	const customReport = await customHomeSubject.control.inspect();
	assert.strictEqual(customReport.targets.wui.operable, true);
	assert.strictEqual(customHomeSubject.calls[0].options.env.PM2_HOME, customHomeSubject.pm2Home);
});

test('classifies confirmed sudo PM2, inaccessible normal PM2, and unsupported management independently', async t => {
	const sudoSubject = fixture({
		env: { PM2_HOME: '/root/.pm2', pm_id: '1' },
		mutateList(list) { list.splice(1, 1); }
	});
	t.after(() => fs.rmSync(sudoSubject.root, { recursive: true, force: true }));
	const sudoReport = await sudoSubject.control.inspect();
	assert.strictEqual(sudoReport.targets.operator.manager, 'pm2-user');
	assert.strictEqual(sudoReport.targets.operator.operable, true);
	assert.strictEqual(sudoReport.targets.wui.manager, 'pm2-sudo');
	assert.strictEqual(sudoReport.targets.wui.operable, false);
	assert.strictEqual(sudoSubject.calls.length, 1);

	const baseFs = fs;
	const inaccessibleSubject = fixture({
		fs: Object.assign({}, baseFs, {
			statSync(file) {
				const stat = baseFs.statSync(file);
				if (/\.(?:pm2)[/\\](?:pm2\.pid|rpc\.sock)$/.test(file)) {
					return Object.assign(Object.create(stat), stat, { uid: process.getuid() + 1 });
				}
				return stat;
			}
		})
	});
	t.after(() => fs.rmSync(inaccessibleSubject.root, { recursive: true, force: true }));
	const unavailableReport = await inaccessibleSubject.control.inspect();
	assert.strictEqual(unavailableReport.targets.operator.manager, 'unavailable');
	assert.match(unavailableReport.targets.operator.summary, /操作できません/);
	assert.strictEqual(inaccessibleSubject.calls.length, 0);

	const unsupportedSubject = fixture({ env: { pm_id: undefined } });
	t.after(() => fs.rmSync(unsupportedSubject.root, { recursive: true, force: true }));
	fs.rmSync(path.join(unsupportedSubject.pm2Home, 'pm2.pid'));
	fs.rmSync(path.join(unsupportedSubject.pm2Home, 'rpc.sock'));
	const unsupportedReport = await unsupportedSubject.control.inspect();
	assert.strictEqual(unsupportedReport.targets.operator.manager, 'unknown');
	assert.strictEqual(unsupportedReport.targets.wui.manager, 'unsupported');
	assert.match(unsupportedReport.targets.wui.summary, /未対応/);
	assert.strictEqual(unsupportedSubject.calls.length, 0);
});

test('rejects invalid targets, duplicate execution, and all unsafe Operator activity states', async t => {
	const subject = fixture();
	t.after(() => fs.rmSync(subject.root, { recursive: true, force: true }));
	await assert.rejects(subject.control.prepareRestart('arbitrary'), error => error.code === 'invalid_target' && error.statusCode === 400);

	fs.writeFileSync(path.join(subject.data, 'recording.json'), '[{"id":"preparing-or-recording"}]');
	await assert.rejects(subject.control.prepareRestart('operator'), error => error.code === 'operator_busy');
	fs.writeFileSync(path.join(subject.data, 'recording.json'), '{"count":0}');
	await assert.rejects(subject.control.prepareRestart('operator'), error => error.code === 'operator_state_unknown');
	fs.writeFileSync(path.join(subject.data, 'recording.json'), 'not-json');
	await assert.rejects(subject.control.prepareRestart('operator'), error => error.code === 'operator_state_unknown');
	fs.writeFileSync(path.join(subject.data, 'recording.json'), '[]');

	const accepted = await subject.control.prepareRestart('operator');
	await assert.rejects(subject.control.prepareRestart('wui'), error => error.code === 'operation_in_progress');
	assert.strictEqual(subject.control.startPreparedRestart(accepted.id), true);
	assert.strictEqual(subject.control.startPreparedRestart(accepted.id), false);
	const completed = await waitFor(async () => {
		const report = await subject.control.inspect();
		return report.operations.operator && report.operations.operator.state === 'succeeded' ? report : null;
	});
	assert.strictEqual(completed.targets.operator.pid, 1111);
	assert.ok(subject.calls.some(call => call.args[0] === 'restart' && call.args[1] === '0'));
	assert.ok(!subject.calls.some(call => call.args[0] === 'restart' && call.args[1] === 'chinachu-operator'));
});

test('accepts WUI restart before scheduling it and exposes verified recovery without resending', async t => {
	const subject = fixture();
	t.after(() => fs.rmSync(subject.root, { recursive: true, force: true }));
	const accepted = await subject.control.prepareRestart('wui');
	assert.strictEqual(accepted.state, 'accepted');
	assert.strictEqual(subject.calls.filter(call => call.args[0] === 'restart').length, 0);
	assert.strictEqual(subject.control.startPreparedRestart(accepted.id), true);
	const completed = await waitFor(async () => {
		const report = await subject.control.inspect();
		return report.operations.wui && report.operations.wui.state === 'succeeded' ? report : null;
	});
	assert.strictEqual(completed.targets.wui.pid, 1222);
	assert.strictEqual(subject.calls.filter(call => call.args[0] === 'restart').length, 1);

	const failedSubject = fixture({ restartError: new Error('private command detail') });
	t.after(() => fs.rmSync(failedSubject.root, { recursive: true, force: true }));
	const failedAccepted = await failedSubject.control.prepareRestart('wui');
	failedSubject.control.startPreparedRestart(failedAccepted.id);
	const failed = await waitFor(async () => {
		const report = await failedSubject.control.inspect();
		return report.operations.wui && report.operations.wui.state === 'failed' ? report.operations.wui : null;
	});
	assert.strictEqual(failed.message, 'このWUIの実行ユーザーからPM2を操作できません');
	assert.doesNotMatch(failed.message, /private command detail/);
});

test('service-control API returns status, rejects server errors safely, and sends acceptance before execution', async () => {
	const source = fs.readFileSync(path.join(__dirname, '../api/script-service-control.vm.js'), 'utf8');
	const resource = JSON.parse(fs.readFileSync(path.join(__dirname, '../api/resource-service-control.json'), 'utf8'));
	assert.deepStrictEqual(resource['/'].methods, [ 'get' ]);
	assert.deepStrictEqual(resource['/:target'].methods, [ 'post' ]);
	assert.doesNotMatch(source, /request\.query|PM2_HOME|command/);
	const order = [];
	let result;
	const response = {
		head(code) { result = { code }; },
		end(body) { result.body = JSON.parse(body); order.push('response'); },
		error(code) { result = { code }; }
	};
	const serviceControl = {
		inspect: async () => ({ schemaVersion: 1 }),
		prepareRestart: async target => ({ id: 'op-1', target, state: 'accepted' }),
		startPreparedRestart(id) { order.push('start:' + id); return true; }
	};
	await vm.runInNewContext(source, {
		request: { method: 'POST', param: { target: 'wui' } },
		response,
		serviceControl,
		JSON,
		Number
	});
	assert.strictEqual(result.code, 202);
	assert.deepStrictEqual(order, [ 'response', 'start:op-1' ]);
	assert.strictEqual(result.body.accepted, true);

	serviceControl.prepareRestart = async () => {
		throw new serviceControlModule.ServiceControlError('invalid_target', 400, '再起動対象が不正です');
	};
	await vm.runInNewContext(source, {
		request: { method: 'POST', param: { target: 'other' } }, response, serviceControl, JSON, Number
	});
	assert.strictEqual(result.code, 400);
	assert.deepStrictEqual(result.body, { error: 'invalid_target', message: '再起動対象が不正です' });
});
