'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const repositoryRoot = path.resolve(__dirname, '..');
const serviceSetupPath = path.join(repositoryRoot, 'lib', 'service-setup.sh');

function runShell(body) {
	return childProcess.spawnSync('bash', [ '-c', '. "$1"\n' + body, 'test', serviceSetupPath ], {
		cwd: repositoryRoot,
		encoding: 'utf8',
		env: { ...process.env, SERVICE_SETUP_STABILITY_SECONDS: '0' }
	});
}

function cleanState() {
	return [
		'SERVICE_SETUP_LOCAL_ACTIVE="[]"',
		'SERVICE_SETUP_LOCAL_ACTIVE_KNOWN=true',
		'SERVICE_SETUP_LOCAL_SAVED="[]"',
		'SERVICE_SETUP_LOCAL_SAVED_KNOWN=true',
		'SERVICE_SETUP_ROOT_ACTIVE="[]"',
		'SERVICE_SETUP_ROOT_ACTIVE_KNOWN=true',
		'SERVICE_SETUP_ROOT_SAVED="[]"',
		'SERVICE_SETUP_ROOT_SAVED_KNOWN=true',
		'SERVICE_SETUP_LOCAL_USER=testuser',
		'SERVICE_SETUP_ROOT_USER=root',
		'SERVICE_SETUP_LOCAL_DAEMON_ACTIVE=false',
		'SERVICE_SETUP_ROOT_DAEMON_ACTIVE=false',
		'SERVICE_SETUP_LOCAL_LOGROTATE_INSTALLED=false',
		'SERVICE_SETUP_ROOT_LOGROTATE_INSTALLED=false',
		'SERVICE_SETUP_LOCAL_LOGROTATE_PARTIAL=false',
		'SERVICE_SETUP_ROOT_LOGROTATE_PARTIAL=false',
		'SERVICE_SETUP_PROCESS_PIDS=',
		'SERVICE_SETUP_LOG_COUNT=0',
		'SERVICE_SETUP_PID_COUNT=0'
	].join('\n');
}

function registrationFixture() {
	const currentUser = os.userInfo().username;
	const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-service-setup-'));
	const callsFile = path.join(temporaryDir, 'calls');
	const stateFile = path.join(temporaryDir, 'state');

	fs.writeFileSync(callsFile, '');
	fs.writeFileSync(stateFile, 'empty');

	const online = JSON.stringify([
		{
			name: 'chinachu-operator',
			pid: process.pid,
			pm2_env: { status: 'online', restart_time: 0 }
		},
		{
			name: 'chinachu-wui',
			pid: process.pid,
			pm2_env: { status: 'online', restart_time: 0 }
		}
	]);

	const script = [
		'INSTALLER_RED= INSTALLER_RESET= INSTALLER_YELLOW=',
		'CHINACHU_DIR=' + JSON.stringify(temporaryDir),
		'BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath),
		'resolve_bootstrap_node() { BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath) + '; }',
		'service_setup_origin_user() { echo ' + JSON.stringify(currentUser) + '; }',
		'chinachu_runtime_bootstrap() { return 0; }',
		'chinachu_installer_verify() { return 0; }',
		'service_setup_validate_processes() { return 0; }',
		'service_setup_capture_state() { ' + cleanState().replace(/\n/g, '; ') + '; }',
		'service_setup_verify_effective_identity() { return 0; }',
		'service_setup_verify_wui_listen() { return 0; }',
		'service_setup_verify_pm2_logs() { return 0; }',
		'service_setup_verify_process_ownership() { return 0; }',
		'service_setup_verify_scheduler_log() { return 0; }',
		'service_setup_scheduler_log_size() { echo 0; }',
		'installer_warning() { :; }',
		'command() { if [ "$1" = -v ] && [ "$2" = pm2 ]; then echo /fixture/pm2; else builtin command "$@"; fi; }',
		'service_setup_pm2() {',
		'  printf "%s\\n" "$*" >> ' + JSON.stringify(callsFile),
		'  case "$1" in',
		'    jlist) [ "$(cat ' + JSON.stringify(stateFile) + ')" = online ] && printf ' + JSON.stringify(online) + ' || printf "[]";;',
		'    start) echo online > ' + JSON.stringify(stateFile) + ';;',
		'    delete) echo empty > ' + JSON.stringify(stateFile) + ';;',
		'    save) return 0;;',
		'  esac',
		'}'
	].join('\n');

	return { callsFile, script, temporaryDir };
}

describe('Service Setup safety contract', function() {
	it('registers Chinachu in clean local PM2 without saving during registration', function() {
		const fixture = registrationFixture();

		try {
			const result = runShell(fixture.script + '\nservice_setup_register local');

			assert.strictEqual(result.status, 0, result.stdout + result.stderr);

			const calls = fs.readFileSync(fixture.callsFile, 'utf8');
			assert.match(calls, /^start .*processes\.json$/m);
			assert.doesNotMatch(calls, /^save$/m);
		} finally {
			fs.rmSync(fixture.temporaryDir, { recursive: true, force: true });
		}
	});

	it('preserves non-Chinachu saved entries when saving PM2 state', function() {
		const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-persistence-save-'));
		const dump = path.join(temporaryDir, 'dump.pm2');
		const calls = path.join(temporaryDir, 'calls');
		const active = JSON.stringify([
			{ name: 'chinachu-operator' },
			{ name: 'chinachu-wui' },
			{ name: 'mirakurun-server' }
		]);

		fs.writeFileSync(dump, JSON.stringify([
			{ name: 'mirakurun-server' },
			{ name: 'old-service' }
		]));
		fs.writeFileSync(calls, '');

		try {
			const result = runShell([
				'BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath),
				'SERVICE_SETUP_LOCAL_USER=testuser',
				'SERVICE_SETUP_LOCAL_DUMP=' + JSON.stringify(dump),
				'SERVICE_SETUP_LOCAL_ACTIVE=' + JSON.stringify(active),
				'SERVICE_SETUP_LOCAL_SAVED=' + JSON.stringify(fs.readFileSync(dump, 'utf8')),
				'service_setup_pm2_as_user() { printf "%s\\n" "$*" >> ' + JSON.stringify(calls) + '; printf %s ' + JSON.stringify(active) + ' > ' + JSON.stringify(dump) + '; }',
				'service_setup_capture_pm2_environment() { SERVICE_SETUP_LOCAL_SAVED=$(<' + JSON.stringify(dump) + '); SERVICE_SETUP_LOCAL_SAVED_KNOWN=true; }',
				'service_setup_persistence_save_environment LOCAL'
			].join('\n'));

			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			assert.strictEqual(fs.readFileSync(calls, 'utf8'), 'testuser save\n');
			assert.deepStrictEqual(
				JSON.parse(fs.readFileSync(dump, 'utf8')).map(item => item.name),
				[ 'chinachu-operator', 'chinachu-wui', 'mirakurun-server', 'old-service' ]
			);
		} finally {
			fs.rmSync(temporaryDir, { recursive: true, force: true });
		}
	});

	it('removes only Chinachu PM2 entries while preserving Mirakurun', function() {
		const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-cleanup-pm2-'));
		const dump = path.join(temporaryDir, 'dump.pm2');
		const backup = dump + '.backup';
		const calls = path.join(temporaryDir, 'calls');
		const list = [
			{ name: 'mirakurun-server' },
			{ name: 'chinachu-operator' },
			{ name: 'chinachu-wui' }
		];

		fs.writeFileSync(dump, JSON.stringify(list));
		fs.copyFileSync(dump, backup);
		fs.writeFileSync(calls, '');

		try {
			const result = runShell([
				'BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath),
				'SERVICE_SETUP_LOCAL_USER=testuser',
				'SERVICE_SETUP_LOCAL_ACTIVE=' + JSON.stringify(JSON.stringify(list)),
				'SERVICE_SETUP_LOCAL_DUMP=' + JSON.stringify(dump),
				'SERVICE_SETUP_LOCAL_DUMP_BACKUP=' + JSON.stringify(backup),
				'service_setup_pm2_as_user() { printf "%s\\n" "$*" >> ' + JSON.stringify(calls) + '; }',
				'service_setup_cleanup_environment LOCAL'
			].join('\n'));

			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			assert.deepStrictEqual(
				JSON.parse(fs.readFileSync(dump, 'utf8')).map(item => item.name),
				[ 'mirakurun-server' ]
			);

			const commands = fs.readFileSync(calls, 'utf8');
			assert.match(commands, /^testuser stop chinachu-operator chinachu-wui$/m);
			assert.match(commands, /^testuser delete chinachu-operator chinachu-wui$/m);
			assert.doesNotMatch(commands, /delete .*mirakurun/);
		} finally {
			fs.rmSync(temporaryDir, { recursive: true, force: true });
		}
	});

	it('refuses dangerous cleanup while recording or when a process cannot be attributed', function() {
		const recordingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-cleanup-guard-'));
		const conflictDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-cleanup-conflict-'));
		const calls = path.join(conflictDir, 'calls');

		fs.mkdirSync(path.join(recordingDir, 'data'));
		fs.writeFileSync(path.join(recordingDir, 'data', 'recording.json'), '[{"id":"active"}]');
		fs.writeFileSync(path.join(recordingDir, 'data', 'reserves.json'), '[]');
		fs.writeFileSync(calls, '');

		try {
			const recordingResult = runShell([
				'cd ' + JSON.stringify(recordingDir),
				'BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath),
				'service_setup_guard_activity'
			].join('\n'));

			assert.strictEqual(recordingResult.status, 1);

			const conflictResult = runShell([
				'INSTALLER_RED= INSTALLER_RESET=',
				'BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath),
				cleanState(),
				'SERVICE_SETUP_PROCESS_PIDS=12345',
				'service_setup_pm2_as_user() { echo "$*" >> ' + JSON.stringify(calls) + '; }',
				'id() { [ "$1" = -u ] && echo 0 || command id "$@"; }',
				'service_setup_cleanup'
			].join('\n'));

			assert.strictEqual(conflictResult.status, 1);
			assert.strictEqual(fs.readFileSync(calls, 'utf8'), '');
		} finally {
			fs.rmSync(recordingDir, { recursive: true, force: true });
			fs.rmSync(conflictDir, { recursive: true, force: true });
		}
	});
});
