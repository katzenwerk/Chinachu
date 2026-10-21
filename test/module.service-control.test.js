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
	const pm2Home = path.join(root, 'home/.pm2');
	const data = path.join(root, 'data');
	fs.mkdirSync(pm2Home, { recursive: true });
	fs.mkdirSync(data, { recursive: true });
	fs.writeFileSync(path.join(pm2Home, 'pm2.pid'), '999\n');
	fs.writeFileSync(path.join(pm2Home, 'rpc.sock'), '');
	fs.writeFileSync(path.join(root, 'app-operator.js'), '');
	fs.writeFileSync(path.join(root, 'app-wui.js'), '');
	fs.writeFileSync(path.join(data, 'recording.json'), '[]');
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
	const calls = [];
	const logs = [];
	const runtimeProcess = {
		pid: 222,
		env: { PM2_HOME: pm2Home, pm_id: '1', PATH: process.env.PATH },
		getuid: () => process.getuid(),
		kill: pid => {
			if (pid !== 999 && !list.some(item => Number(item.pid) === Number(pid))) {
				const error = new Error('missing');
				error.code = 'ESRCH';
				throw error;
			}
		}
	};
	const execFile = (command, args, execOptions, callback) => {
		calls.push({ command, args: args.slice(), options: execOptions });
		if (args[0] === 'jlist') return callback(null, JSON.stringify(list));
		if (args[0] === 'restart') {
			if (options.onRestart) options.onRestart();
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
		fs,
		execFile: execFile,
		pm2Binary: '/fixture/pm2',
		responseDelayMs: 1,
		pollIntervalMs: 1,
		restartTimeoutMs: 100,
		inspectTimeoutMs: 100,
		isShuttingDown: options.isShuttingDown,
		log: message => logs.push(message)
	});
	return { root, data, calls, logs, control };
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

test('rejects invalid targets, duplicate execution, and all unsafe Operator activity states', async t => {
	const subject = fixture();
	t.after(() => fs.rmSync(subject.root, { recursive: true, force: true }));
	let report = await subject.control.inspect();
	assert.strictEqual(report.targets.operator.activity, 'idle');
	assert.strictEqual(report.targets.operator.recordingCount, 0);
	assert.strictEqual(report.targets.operator.restartable, true);
	assert.strictEqual(report.targets.wui.restartable, true);
	await assert.rejects(subject.control.prepareRestart('arbitrary'), error => error.code === 'invalid_target' && error.statusCode === 400);

	fs.writeFileSync(path.join(subject.data, 'recording.json'), '[{"id":"preparing-or-recording","operatorPrepareStart":1}]');
	report = await subject.control.inspect();
	assert.strictEqual(report.targets.operator.activity, 'busy');
	assert.strictEqual(report.targets.operator.activityPhase, 'preparing');
	assert.strictEqual(report.targets.operator.recordingCount, 1);
	assert.strictEqual(report.targets.operator.restartable, false);
	await assert.rejects(subject.control.prepareRestart('operator'), error => error.code === 'operator_busy');
	fs.writeFileSync(path.join(subject.data, 'recording.json'), '[{"id":"recording","operatorRecordingStart":10}]');
	report = await subject.control.inspect();
	assert.strictEqual(report.targets.operator.activityPhase, 'recording');
	fs.writeFileSync(path.join(subject.data, 'recording.json'), '[{"id":"finalizing","operatorRecordingStart":10,"operatorRecordingEnd":20}]');
	report = await subject.control.inspect();
	assert.strictEqual(report.targets.operator.activityPhase, 'finalizing');
	fs.writeFileSync(path.join(subject.data, 'recording.json'), '{"count":0}');
	report = await subject.control.inspect();
	assert.strictEqual(report.targets.operator.activity, 'unknown');
	assert.strictEqual(report.targets.operator.restartable, false);
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
	assert.ok(subject.logs.some(line => line === 'SERVICE: Restart requested target=chinachu-operator'));
	assert.ok(subject.logs.some(line => line === 'SERVICE: Restart completed target=chinachu-operator'));
});

test('serializes concurrent requests and rechecks Operator activity immediately before restart', async t => {
	const subject = fixture();
	t.after(() => fs.rmSync(subject.root, { recursive: true, force: true }));
	const simultaneous = await Promise.allSettled([
		subject.control.prepareRestart('operator'),
		subject.control.prepareRestart('wui')
	]);
	assert.strictEqual(simultaneous.filter(result => result.status === 'fulfilled').length, 1);
	const rejected = simultaneous.find(result => result.status === 'rejected');
	assert.strictEqual(rejected.reason.code, 'operation_in_progress');
	const accepted = simultaneous.find(result => result.status === 'fulfilled').value;

	fs.writeFileSync(path.join(subject.data, 'recording.json'), '[{"id":"started-after-acceptance"}]');
	subject.control.startPreparedRestart(accepted.id);
	const failed = await waitFor(async () => {
		const report = await subject.control.inspect();
		return report.operations[accepted.target]?.state === 'failed' ? report.operations[accepted.target] : null;
	});
	assert.match(failed.message, /録画中|開始準備中/);
	assert.strictEqual(subject.calls.filter(call => call.args[0] === 'restart').length, 0);
	assert.ok(subject.logs.some(line => /Restart rejected .*operation_in_progress/.test(line)));
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

	let shuttingDown = false;
	const handoffSubject = fixture({
		restartError: new Error('self restart interrupted the PM2 client'),
		onRestart: () => { shuttingDown = true; },
		isShuttingDown: () => shuttingDown
	});
	t.after(() => fs.rmSync(handoffSubject.root, { recursive: true, force: true }));
	const handoffAccepted = await handoffSubject.control.prepareRestart('wui');
	handoffSubject.control.startPreparedRestart(handoffAccepted.id);
	const handedOff = await waitFor(async () => {
		const report = await handoffSubject.control.inspect();
		return report.operations.wui && report.operations.wui.message === 'WUI再起動後の接続確認を待っています'
			? report.operations.wui : null;
	});
	assert.strictEqual(handedOff.state, 'running');
	assert.ok(handoffSubject.logs.some(line => /Restart handoff .*self_restart_shutdown/.test(line)));
	assert.ok(!handoffSubject.logs.some(line => /Restart failed/.test(line)));
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
