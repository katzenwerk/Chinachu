'use strict';

const childProcess = require('child_process');

const DEFAULT_TIMEOUT_MS = 1000 * 60;
const DEFAULT_KILL_GRACE_MS = 1000 * 5;

function normalizeCommand(value) {
	if (typeof value === 'string' && value.length > 0) {
		return {
			executable: value,
			args: []
		};
	}

	if (Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string') && value[0].length > 0) {
		return {
			executable: value[0],
			args: value.slice(1)
		};
	}

	return null;
}

function hasCommandValue(value) {
	return value !== null && typeof value !== 'undefined' && value !== '';
}

function resolveNotificationCommand(config) {
	const warnings = [];
	const notificationCommand = config.notificationCommand;
	const legacyCommand = config.storageLowSpaceCommand;

	if (config.storageLowSpaceNotifyTo) {
		warnings.push('storageLowSpaceNotifyTo is deprecated and ignored. Configure notificationCommand and send mail from the external notifier.');
	}

	if (hasCommandValue(notificationCommand)) {
		if (!normalizeCommand(notificationCommand)) {
			warnings.push('notificationCommand is invalid and notifications are disabled. Use an executable path or an array of executable and arguments.');
			return { command: null, source: null, warnings: warnings };
		}

		if (hasCommandValue(legacyCommand)) {
			warnings.push('storageLowSpaceCommand is deprecated and ignored because notificationCommand is configured.');
		}

		return { command: notificationCommand, source: 'notificationCommand', warnings: warnings };
	}

	if (hasCommandValue(legacyCommand)) {
		if (!normalizeCommand(legacyCommand)) {
			warnings.push('storageLowSpaceCommand is deprecated and invalid; notifications are disabled.');
			return { command: null, source: null, warnings: warnings };
		}

		warnings.push('storageLowSpaceCommand is deprecated; using it as a notificationCommand compatibility fallback.');
		return { command: legacyCommand, source: 'storageLowSpaceCommand', warnings: warnings };
	}

	return { command: null, source: null, warnings: warnings };
}

function createNotificationSender(commandValue, options) {
	const command = normalizeCommand(commandValue);
	const log = options && typeof options.log === 'function' ? options.log : function() {};
	const timeoutMs = getPositiveTimeout(options && options.timeoutMs, DEFAULT_TIMEOUT_MS);
	const killGraceMs = getPositiveTimeout(options && options.killGraceMs, DEFAULT_KILL_GRACE_MS);
	let inFlight = null;

	function getPositiveTimeout(value, defaultValue) {
		return Number.isFinite(value) && value > 0 ? value : defaultValue;
	}

	return function sendNotification(payload) {
		if (!command) {
			return Promise.resolve({ ok: false, skipped: true });
		}
		if (inFlight) {
			log('WARNING: Notification command is already running; skipping duplicate notification.');
			return Promise.resolve({ ok: false, skipped: true, reason: 'in-flight' });
		}

		let input;
		try {
			input = JSON.stringify(payload) + '\n';
		} catch (err) {
			log('WARNING: Notification payload serialization failed: ' + err.message);
			return Promise.resolve({ ok: false, error: err });
		}

		return new Promise(resolve => {
			let child;
			let finished = false;
			let timedOut = false;
			let timeoutTimer = null;
			let forceKillTimer = null;

			function finish(result) {
				if (finished) {
					return;
				}
				finished = true;
				if (timeoutTimer) {
					clearTimeout(timeoutTimer);
				}
				if (forceKillTimer) {
					clearTimeout(forceKillTimer);
				}
				if (inFlight === child) {
					inFlight = null;
				}
				resolve(result);
			}

			function killChild(signal) {
				try {
					if (!child.kill(signal)) {
						log('WARNING: Notification command could not be sent ' + signal + '.');
						return false;
					}
					return true;
				} catch (err) {
					log('WARNING: Notification command ' + signal + ' failed: ' + err.message);
					return false;
				}
			}

			try {
				child = childProcess.spawn(command.executable, command.args, {
				shell: false,
				stdio: [ 'pipe', 'ignore', 'ignore' ]
				});
			} catch (err) {
				log('WARNING: Notification command could not be started: ' + err.message);
				finish({ ok: false, error: err });
				return;
			}
			inFlight = child;
			timeoutTimer = setTimeout(() => {
				timedOut = true;
				log('WARNING: Notification command timed out after ' + timeoutMs + ' ms; sending SIGTERM.');
				killChild('SIGTERM');
				forceKillTimer = setTimeout(() => {
					if (finished) {
						return;
					}
					log('WARNING: Notification command did not exit after SIGTERM; sending SIGKILL.');
					const forceKilled = killChild('SIGKILL');
					finish({ ok: false, signal: 'SIGKILL', timedOut: true, forceKilled: forceKilled });
				}, killGraceMs);
			}, timeoutMs);

			child.once('spawn', () => {
				log('NOTIFY: External notification command started (pid=' + child.pid + ')');
			});

			child.once('error', err => {
				log('WARNING: Notification command failed to start: ' + err.message);
				finish({ ok: false, error: err, timedOut: timedOut });
			});

			child.once('close', (code, signal) => {
				if (finished) {
					return;
				}

				if (timedOut) {
					finish({ ok: false, code: code, signal: signal, timedOut: true });
					return;
				}

				if (code === 0) {
					finish({ ok: true, code: code });
					return;
				}

				const status = signal ? 'signal=' + signal : 'exit=' + code;
				log('WARNING: Notification command failed (' + status + ').');
				finish({ ok: false, code: code, signal: signal });
			});

			child.stdin.once('error', err => {
				log('WARNING: Notification command stdin failed: ' + err.message);
			});
			child.stdin.end(input, 'utf8');
		});
	};
}

function shouldSendStorageLowNotification(source, now, lastNotifiedAt, intervalMs) {
	if (source === 'storageLowSpaceCommand') {
		return true;
	}

	return source === 'notificationCommand' && now - lastNotifiedAt > intervalMs;
}

function createStorageLowNotification(details) {
	return {
		event: 'storage-low',
		severity: 'critical',
		title: '[Chinachu] ALERT: Storage Low Space!',
		message: 'Current Free Space is ' + details.availableMB + ' MB.\nThreshold is ' + details.thresholdMB + ' MB.',
		timestamp: new Date().toISOString(),
		metadata: {
			availableBytes: details.availableBytes,
			availableMB: details.availableMB,
			thresholdMB: details.thresholdMB,
			recordedDir: details.recordedDir,
			action: details.action
		}
	};
}

module.exports = {
	DEFAULT_KILL_GRACE_MS: DEFAULT_KILL_GRACE_MS,
	DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
	createNotificationSender: createNotificationSender,
	createStorageLowNotification: createStorageLowNotification,
	normalizeCommand: normalizeCommand,
	resolveNotificationCommand: resolveNotificationCommand,
	shouldSendStorageLowNotification: shouldSendStorageLowNotification
};
