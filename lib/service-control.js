'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TARGETS = Object.freeze({
	operator: { name: 'chinachu-operator', script: 'app-operator.js', legacyPidFile: 'data/chinachu-operator.pid' },
	wui: { name: 'chinachu-wui', script: 'app-wui.js', legacyPidFile: 'data/chinachu-wui.pid' }
});

class ServiceControlError extends Error {
	constructor(code, statusCode, publicMessage) {
		super(publicMessage);
		this.name = 'ServiceControlError';
		this.code = code;
		this.statusCode = statusCode;
		this.publicMessage = publicMessage;
	}
}

function createServiceControl(options) {
	options = options || {};
	const rootDir = path.resolve(options.rootDir || path.join(__dirname, '..'));
	const recordingPath = options.recordingPath || path.join(rootDir, 'data/recording.json');
	const runtimeProcess = options.process || process;
	const runtimeFs = options.fs || fs;
	const runtimeOs = options.os || os;
	const execFile = options.execFile || childProcess.execFile;
	const pm2Binary = options.pm2Binary || 'pm2';
	const now = options.now || Date.now;
	const schedule = options.setTimeout || setTimeout;
	const isShuttingDown = typeof options.isShuttingDown === 'function' ? options.isShuttingDown : function() { return false; };
	const inspectTimeoutMs = options.inspectTimeoutMs || 3000;
	const restartTimeoutMs = options.restartTimeoutMs || 15000;
	const pollIntervalMs = options.pollIntervalMs || 250;
	const responseDelayMs = options.responseDelayMs || 250;
	const log = typeof options.log === 'function' ? options.log : function() {};
	let operationSequence = 0;
	let activeOperation = null;
	let preparingOperation = false;
	const lastOperations = { operator: null, wui: null };

	function publicTarget(target, manager, operable, summary, item) {
		const result = {
			target: target,
			name: TARGETS[target].name,
			manager: manager,
			operable: operable === true,
			summary: summary
		};
		if (item) {
			result.status = item.pm2_env && item.pm2_env.status || 'unknown';
			result.pid = Number(item.pid) > 0 ? Number(item.pid) : null;
			result.pmId = Number.isInteger(Number(item.pm_id)) ? Number(item.pm_id) : null;
			result.restartCount = item.pm2_env && Number.isFinite(Number(item.pm2_env.restart_time))
				? Number(item.pm2_env.restart_time) : null;
			result.startedAt = item.pm2_env && Number.isFinite(Number(item.pm2_env.pm_uptime))
				? Number(item.pm2_env.pm_uptime) : null;
		}
		return result;
	}

	function unavailableTargets(manager, summary) {
		return {
			operator: publicTarget('operator', manager, false, summary),
			wui: publicTarget('wui', manager, false, summary)
		};
	}

	function readInteger(file) {
		const value = String(runtimeFs.readFileSync(file, 'utf8')).trim();
		return /^\d+$/.test(value) ? Number(value) : null;
	}

	function processExists(pid) {
		try {
			runtimeProcess.kill(pid, 0);
			return true;
		} catch (_) {
			return false;
		}
	}

	function getUserContext() {
		let uid;
		let user;
		try {
			uid = runtimeProcess.getuid();
			user = runtimeOs.userInfo();
		} catch (_) {
			return { ok: false, manager: 'unknown', summary: 'PM2の管理先を確認できません' };
		}
		if (!user || !user.homedir || !Number.isInteger(uid)) {
			return { ok: false, manager: 'unknown', summary: 'PM2の管理先を確認できません' };
		}

		const expectedHome = path.resolve(user.homedir, '.pm2');
		const inheritedHome = runtimeProcess.env && runtimeProcess.env.PM2_HOME
			? path.resolve(runtimeProcess.env.PM2_HOME) : null;
		const inheritedPmId = runtimeProcess.env && runtimeProcess.env.pm_id;
		if (uid === 0) {
			return {
				ok: false,
				manager: 'unknown',
				summary: '通常ユーザーPM2の管理先を確認できません',
				wuiManager: inheritedPmId !== undefined && inheritedHome === path.resolve('/root/.pm2')
					? 'pm2-sudo' : 'unsupported'
			};
		}

		const selectedHome = inheritedPmId !== undefined && inheritedHome && inheritedHome !== path.resolve('/root/.pm2')
			? inheritedHome : expectedHome;
		return {
			ok: true,
			uid: uid,
			home: user.homedir,
			pm2Home: selectedHome,
			wuiManager: inheritedPmId !== undefined && inheritedHome === path.resolve('/root/.pm2')
				? 'pm2-sudo' : (inheritedPmId === undefined ? 'unsupported' : null)
		};
	}

	function checkDaemon(context) {
		const pidFile = path.join(context.pm2Home, 'pm2.pid');
		const rpcFile = path.join(context.pm2Home, 'rpc.sock');
		try {
			const pidStat = runtimeFs.statSync(pidFile);
			const rpcStat = runtimeFs.statSync(rpcFile);
			const daemonPid = readInteger(pidFile);
			if (pidStat.uid !== context.uid || rpcStat.uid !== context.uid || !daemonPid || !processExists(daemonPid)) {
				return { ok: false, summary: 'このWUIの実行ユーザーからPM2を操作できません' };
			}
			return { ok: true, daemonPid: daemonPid };
		} catch (error) {
			if (error && error.code === 'ENOENT') {
				return { ok: false, state: 'missing', summary: 'PM2の管理先を確認できません' };
			}
			return { ok: false, state: 'unavailable', summary: 'このWUIの実行ユーザーからPM2を操作できません' };
		}
	}

	function pm2Environment(context) {
		return Object.assign({}, runtimeProcess.env || {}, {
			HOME: context.home,
			PM2_HOME: context.pm2Home
		});
	}

	function runPm2(context, args, timeout) {
		return new Promise((resolve, reject) => {
			const daemon = checkDaemon(context);
			if (!daemon.ok) {
				return reject(new ServiceControlError('pm2_unavailable', 503, daemon.summary));
			}
			execFile(pm2Binary, args, {
				cwd: rootDir,
				env: pm2Environment(context),
				timeout: timeout,
				maxBuffer: 1024 * 1024
			}, (error, stdout) => {
				if (error) {
					return reject(new ServiceControlError('pm2_unavailable', 503, 'このWUIの実行ユーザーからPM2を操作できません'));
				}
				resolve(stdout);
			});
		});
	}

	function samePath(left, right) {
		return typeof left === 'string' && path.resolve(left) === path.resolve(right);
	}

	function classifyTarget(target, list, context) {
		const definition = TARGETS[target];
		const matches = list.filter(item => item && item.name === definition.name);
		if (matches.length !== 1) {
			return publicTarget(target, 'unknown', false, 'PM2の管理先を確認できません');
		}
		const item = matches[0];
		const env = item.pm2_env || {};
		const expectedScript = path.join(rootDir, definition.script);
		const pmId = Number(item.pm_id);
		const expectedPidFiles = [
			path.join(rootDir, definition.legacyPidFile),
			path.join(rootDir, 'data', definition.name + '-' + pmId + '.pid'),
			path.join(context.pm2Home, 'pids', definition.name + '-' + pmId + '.pid')
		];
		const registeredPidFile = expectedPidFiles.find(file => samePath(env.pm_pid_path, file));
		if (!Number.isInteger(pmId) || pmId < 0 || !samePath(env.pm_cwd, rootDir) ||
			!samePath(env.pm_exec_path, expectedScript) || !registeredPidFile) {
			return publicTarget(target, 'unknown', false, '同名プロセスの実体を確認できません');
		}

		const pid = Number(item.pid);
		if (env.status === 'online') {
			if (!Number.isInteger(pid) || pid <= 0 || !processExists(pid)) {
				return publicTarget(target, 'pm2-user', false, 'PM2のプロセス状態を確認できません', item);
			}
			try {
				if (readInteger(registeredPidFile) !== pid) {
					return publicTarget(target, 'unknown', false, '同名プロセスの実体を確認できません', item);
				}
			} catch (_) {
				return publicTarget(target, 'unknown', false, '同名プロセスの実体を確認できません', item);
			}
		}

		if (target === 'wui' && env.status === 'online' && pid !== runtimeProcess.pid) {
			return publicTarget(target, 'unknown', false, '同名WUIが現在の画面を提供するプロセスと一致しません', item);
		}

		return publicTarget(target, 'pm2-user', true, 'PM2管理／再起動可能', item);
	}

	async function inspect() {
		const checkedAt = now();
		const context = getUserContext();
		let targets;
		if (!context.ok) {
			targets = unavailableTargets(context.manager, context.summary);
			if (context.wuiManager === 'pm2-sudo') {
				targets.wui = publicTarget('wui', 'pm2-sudo', false,
					'sudo pm2で管理されているため、この画面からは再起動できません');
			} else if (context.wuiManager === 'unsupported') {
				targets.wui = publicTarget('wui', 'unsupported', false,
					'この管理方式からの再起動には未対応です');
			}
		} else {
			const daemon = checkDaemon(context);
			if (!daemon.ok) {
				const manager = daemon.state === 'missing' ? 'unknown' : 'unavailable';
				targets = unavailableTargets(manager, daemon.summary);
				if (context.wuiManager === 'pm2-sudo') {
					targets.wui = publicTarget('wui', 'pm2-sudo', false,
						'sudo pm2で管理されているため、この画面からは再起動できません');
				} else if (context.wuiManager === 'unsupported') {
					targets.wui = publicTarget('wui', 'unsupported', false,
						'この管理方式からの再起動には未対応です');
				}
			} else {
				try {
					const output = await runPm2(context, [ 'jlist' ], inspectTimeoutMs);
					const list = JSON.parse(output);
					if (!Array.isArray(list)) throw new TypeError('invalid PM2 list');
					targets = {
							operator: classifyTarget('operator', list, context),
							wui: classifyTarget('wui', list, context)
					};
					if (!targets.wui.operable && context.wuiManager === 'pm2-sudo') {
						targets.wui = publicTarget('wui', 'pm2-sudo', false,
							'sudo pm2で管理されているため、この画面からは再起動できません');
					} else if (!targets.wui.operable && context.wuiManager === 'unsupported') {
						targets.wui = publicTarget('wui', 'unsupported', false,
							'この管理方式からの再起動には未対応です');
					}
				} catch (error) {
					targets = unavailableTargets('unavailable',
						error instanceof ServiceControlError ? error.publicMessage : 'PM2の管理先を確認できません');
				}
			}
		}

		const operatorActivity = inspectOperatorActivity();
		const operationBusy = preparingOperation || activeOperation &&
			(activeOperation.state === 'accepted' || activeOperation.state === 'running');
		targets.operator.activity = operatorActivity.state;
		targets.operator.activityPhase = operatorActivity.phase;
		targets.operator.recordingCount = operatorActivity.count;
		targets.operator.restartable = targets.operator.operable === true && operatorActivity.state === 'idle' && !operationBusy;
		targets.operator.restartSummary = operatorActivity.message || targets.operator.summary;
		targets.wui.restartable = targets.wui.operable === true && !operationBusy;
		targets.wui.restartSummary = operationBusy ? '再起動処理を実行中です' : targets.wui.summary;

		return {
			schemaVersion: 1,
			checkedAt: checkedAt,
			targets: targets,
			operations: {
				operator: lastOperations.operator,
				wui: lastOperations.wui
			}
		};
	}

	function inspectOperatorActivity() {
		let value;
		try {
			value = JSON.parse(runtimeFs.readFileSync(recordingPath, 'utf8'));
		} catch (_) {
			return { state: 'unknown', count: null, message: '録画・開始準備状態を確認できません' };
		}
		if (!Array.isArray(value)) {
			return { state: 'unknown', count: null, message: '録画・開始準備状態を確認できません' };
		}
		if (value.length > 0) {
			const recordingCount = value.filter(program => Number.isFinite(program && program.operatorRecordingStart) &&
				!Number.isFinite(program && program.operatorRecordingEnd)).length;
			const finalizingCount = value.filter(program => Number.isFinite(program && program.operatorRecordingEnd)).length;
			const phase = finalizingCount > 0
				? (finalizingCount === value.length ? 'finalizing' : 'processing')
				: (recordingCount === value.length ? 'recording' : (recordingCount === 0 ? 'preparing' : 'processing'));
			return { state: 'busy', phase: phase, count: value.length, message: '録画中または開始・終了処理中です' };
		}
		return { state: 'idle', phase: 'idle', count: 0, message: '録画していません' };
	}

	function readOperatorActivity() {
		const activity = inspectOperatorActivity();
		if (activity.state === 'unknown') {
			throw new ServiceControlError('operator_state_unknown', 409, '録画・開始準備状態を確認できないため再起動できません');
		}
		if (activity.state === 'busy') {
			throw new ServiceControlError('operator_busy', 409, '録画中または開始準備中のためOperatorを再起動できません');
		}
	}

	function generationOf(info) {
		return {
			pid: info && info.pid || null,
			restartCount: info && info.restartCount,
			startedAt: info && info.startedAt
		};
	}

	function generationChanged(before, after) {
		if (!before || !after) return false;
		return (before.pid !== null && after.pid !== null && before.pid !== after.pid) ||
			(typeof before.restartCount === 'number' && typeof after.restartCount === 'number' && after.restartCount > before.restartCount) ||
			(typeof before.startedAt === 'number' && typeof after.startedAt === 'number' && after.startedAt > before.startedAt);
	}

	function publicOperation(operation) {
		if (!operation) return null;
		return {
			id: operation.id,
			target: operation.target,
			state: operation.state,
			message: operation.message,
			requestedAt: operation.requestedAt,
			completedAt: operation.completedAt || null,
			before: operation.before
		};
	}

	async function prepareRestart(target) {
		if (!Object.prototype.hasOwnProperty.call(TARGETS, target)) {
			throw new ServiceControlError('invalid_target', 400, '再起動対象が不正です');
		}
		log('SERVICE: Restart requested target=' + TARGETS[target].name);
		if (preparingOperation || activeOperation && (activeOperation.state === 'accepted' || activeOperation.state === 'running')) {
			log('SERVICE: Restart rejected target=' + TARGETS[target].name + ' reason=operation_in_progress');
			throw new ServiceControlError('operation_in_progress', 409, '別の再起動処理を実行中です');
		}
		preparingOperation = true;
		try {
			const report = await inspect();
			const info = report.targets[target];
			if (!info || !info.operable || info.manager !== 'pm2-user' || !Number.isInteger(info.pmId)) {
				throw new ServiceControlError('target_unavailable', 409, info && info.summary || 'PM2の管理先を確認できません');
			}
			if (target === 'operator') readOperatorActivity();

			const operation = {
				id: String(now()) + '-' + (++operationSequence),
				target: target,
				pmId: info.pmId,
				state: 'accepted',
				message: '再起動を受け付けました',
				requestedAt: now(),
				before: generationOf(info),
				scheduled: false
			};
			activeOperation = operation;
			lastOperations[target] = publicOperation(operation);
			return publicOperation(operation);
		} catch (error) {
			log('SERVICE: Restart rejected target=' + TARGETS[target].name + ' reason=' +
				(error instanceof ServiceControlError ? error.code : 'inspection_failed'));
			throw error;
		} finally {
			preparingOperation = false;
		}
	}

	function delay(milliseconds) {
		return new Promise(resolve => schedule(resolve, milliseconds));
	}

	async function executeOperation(operation) {
		operation.state = 'running';
		operation.message = '再起動中です';
		lastOperations[operation.target] = publicOperation(operation);
		log('SERVICE: Restart started target=' + TARGETS[operation.target].name);
		try {
			const context = getUserContext();
			if (!context.ok) throw new ServiceControlError('target_unavailable', 409, context.summary);
			const fresh = await inspect();
			const current = fresh.targets[operation.target];
			if (!current || !current.operable || current.manager !== 'pm2-user' || current.pmId !== operation.pmId) {
				throw new ServiceControlError('target_changed', 409, '再起動直前に管理対象を確認できなくなりました');
			}
			if (operation.target === 'operator') readOperatorActivity();
			await runPm2(context, [ 'restart', String(operation.pmId) ], restartTimeoutMs);

			const deadline = now() + restartTimeoutMs;
			while (now() <= deadline) {
				const report = await inspect();
				const after = report.targets[operation.target];
				if (after && after.operable && after.status === 'online' && generationChanged(operation.before, generationOf(after))) {
					operation.state = 'succeeded';
					operation.message = '再起動後の稼働を確認しました';
					operation.completedAt = now();
					lastOperations[operation.target] = publicOperation(operation);
					activeOperation = null;
					log('SERVICE: Restart completed target=' + TARGETS[operation.target].name);
					return;
				}
				await delay(pollIntervalMs);
			}
			throw new ServiceControlError('verification_timeout', 504, '再起動後の復旧を確認できません');
		} catch (error) {
			if (operation.target === 'wui' && error instanceof ServiceControlError &&
				error.code === 'pm2_unavailable' && isShuttingDown()) {
				operation.message = 'WUI再起動後の接続確認を待っています';
				lastOperations[operation.target] = publicOperation(operation);
				log('SERVICE: Restart handoff target=' + TARGETS[operation.target].name + ' reason=self_restart_shutdown');
				return;
			}
			operation.state = 'failed';
			operation.message = error instanceof ServiceControlError
				? error.publicMessage : '再起動に失敗しました';
			operation.completedAt = now();
			lastOperations[operation.target] = publicOperation(operation);
			activeOperation = null;
			log('SERVICE: Restart failed target=' + TARGETS[operation.target].name + ' reason=' +
				(error instanceof ServiceControlError ? error.code : 'restart_failed'));
		}
	}

	function startPreparedRestart(id) {
		if (!activeOperation || activeOperation.id !== id || activeOperation.scheduled) return false;
		activeOperation.scheduled = true;
		const operation = activeOperation;
		schedule(() => {
			executeOperation(operation).catch(() => {});
		}, responseDelayMs);
		return true;
	}

	return {
		inspect: inspect,
		prepareRestart: prepareRestart,
		startPreparedRestart: startPreparedRestart
	};
}

module.exports = {
	ServiceControlError: ServiceControlError,
	createServiceControl: createServiceControl
};
