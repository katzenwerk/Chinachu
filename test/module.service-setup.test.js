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

function registrationFixture(overrides = {}) {
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
			pm2_env: {
				status: 'online',
				restart_time: 0
			}
		},
		{
			name: 'chinachu-wui',
			pid: process.pid,
			pm2_env: {
				status: 'online',
				restart_time: 0
			}
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
		'service_setup_verify_effective_identity() { return ' + (overrides.identityStatus || 0) + '; }',
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
		'    start) echo online > ' + JSON.stringify(stateFile) + '; return ' + (overrides.startStatus || 0) + ';;',
		'    delete) echo empty > ' + JSON.stringify(stateFile) + ';;',
		'    save) return ' + (overrides.saveStatus || 0) + ';;',
		'  esac',
		'}'
	].join('\n');

	return {
		callsFile,
		currentUser,
		script,
		stateFile,
		temporaryDir
	};
}

describe('PM2 state model and installer integration', function() {
	it('keeps active and saved registration as independent state', function() {
		const active = JSON.stringify([
			{ name: 'chinachu-operator' }
		]);
		const saved = JSON.stringify([
			{ name: 'chinachu-wui' }
		]);

		const result = runShell([
			'BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath),
			'SERVICE_SETUP_LOCAL_ACTIVE=' + JSON.stringify(active),
			'SERVICE_SETUP_LOCAL_SAVED=' + JSON.stringify(saved),
			'service_setup_load_persistence_fields LOCAL',
			'printf "active=%s\\nsaved=%s\\n" "$SERVICE_SETUP_LOCAL_ACTIVE_NAMES" "$SERVICE_SETUP_LOCAL_SAVED_NAMES"'
		].join('\n'));

		assert.strictEqual(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /^active=chinachu-operator$/m);
		assert.match(result.stdout, /^saved=chinachu-wui$/m);
	});

	for (const [ label, values ] of [
		[
			'active registration',
			{
				active: '[{"name":"chinachu-operator"}]'
			}
		],
		[
			'saved registration',
			{
				saved: '[{"name":"chinachu-wui"}]'
			}
		],
		[
			'repository process',
			{
				process: '123'
			}
		],
		[
			'PM2 log artifact',
			{
				logs: 1
			}
		],
		[
			'PM2 PID artifact',
			{
				pids: 1
			}
		]
	]) {
		it('treats ' + label + ' as an existing PM2 trace', function() {
			const result = runShell([
				'BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath),
				cleanState(),
				'SERVICE_SETUP_LOCAL_ACTIVE=' + JSON.stringify(values.active || '[]'),
				'SERVICE_SETUP_LOCAL_SAVED=' + JSON.stringify(values.saved || '[]'),
				'SERVICE_SETUP_PROCESS_PIDS=' + JSON.stringify(values.process || ''),
				'SERVICE_SETUP_LOG_COUNT=' + (values.logs || 0),
				'SERVICE_SETUP_PID_COUNT=' + (values.pids || 0),
				'service_setup_state_has_trace'
			].join('\n'));

			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
		});
	}

	it('does not treat a Mirakurun-only list as a Chinachu trace', function() {
		const result = runShell([
			'BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath),
			cleanState(),
			'SERVICE_SETUP_LOCAL_ACTIVE=' + JSON.stringify('[{"name":"mirakurun-server"}]'),
			'service_setup_state_has_trace'
		].join('\n'));

		assert.strictEqual(result.status, 1);
	});

	it('treats an unreadable local state as a trace but ignores uncaptured root state', function() {
		const localUnknown = runShell([
			'BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath),
			cleanState(),
			'SERVICE_SETUP_INCLUDE_ROOT=false',
			'SERVICE_SETUP_LOCAL_SAVED_KNOWN=false',
			'service_setup_state_has_trace'
		].join('\n'));

		assert.strictEqual(
			localUnknown.status,
			0,
			localUnknown.stdout + localUnknown.stderr
		);

		const rootNotCaptured = runShell([
			'BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath),
			cleanState(),
			'SERVICE_SETUP_INCLUDE_ROOT=false',
			'SERVICE_SETUP_ROOT_SAVED_KNOWN=false',
			'service_setup_state_has_trace'
		].join('\n'));

		assert.strictEqual(
			rootNotCaptured.status,
			1,
			rootNotCaptured.stdout + rootNotCaptured.stderr
		);
	});

	it('keeps non-TTY installer setup optional and delegates no state logic', function() {
		const result = runShell([
			'INSTALLER_RED= INSTALLER_RESET= INSTALLER_YELLOW=',
			'id() { case "$1" in -u) echo 1000;; -un) echo testuser;; *) command id "$@";; esac; }',
			'installer_warning() { :; }',
			'service_setup_capture_state() { echo SHOULD_NOT_INSPECT; return 99; }',
			'service_setup_installer_offer auto'
		].join('\n'));

		assert.strictEqual(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /sudo \.\/chinachu service setup/);
		assert.doesNotMatch(result.stdout, /SHOULD_NOT_INSPECT/);
	});

	it('delegates an explicit TTY yes to the sudo Service Setup entry', function() {
		const result = runShell([
			'INSTALLER_RED= INSTALLER_RESET= INSTALLER_YELLOW=',
			'id() { case "$1" in -u) echo 1000;; -un) echo testuser;; *) command id "$@";; esac; }',
			'CHINACHU_DIR=/fixture/chinachu',
			'SERVICE_SETUP_FORCE_TTY=true SERVICE_SETUP_INSTALLER_ANSWER=y',
			'sudo() { printf "SUDO:%s\\n" "$*"; }',
			'service_setup_installer_offer auto'
		].join('\n'));

		assert.strictEqual(result.status, 0, result.stdout + result.stderr);
		assert.match(
			result.stdout,
			/SUDO:-- \/fixture\/chinachu\/chinachu service setup/
		);
	});

	it('keeps an explicit Auto installer no as a successful skip', function() {
		const result = runShell([
			'INSTALLER_RED= INSTALLER_RESET=',
			'id() { case "$1" in -u) echo 1000;; -un) echo testuser;; *) command id "$@";; esac; }',
			'SERVICE_SETUP_FORCE_TTY=true SERVICE_SETUP_INSTALLER_ANSWER=n',
			'service_setup_installer_offer auto'
		].join('\n'));

		assert.strictEqual(result.status, 0, result.stdout + result.stderr);
	});
});

describe('Service Setup registration', function() {
	it('registers clean local mode without using config uid/gid', function() {
		const fixture = registrationFixture();

		try {
			const result = runShell(
				fixture.script +
				'\nservice_setup_register local'
			);

			assert.strictEqual(
				result.status,
				0,
				result.stdout + result.stderr
			);

			const calls = fs.readFileSync(
				fixture.callsFile,
				'utf8'
			);

			assert.match(
				calls,
				/^start .*processes\.json$/m
			);

			assert.doesNotMatch(
				calls,
				/^save$/m
			);
		} finally {
			fs.rmSync(
				fixture.temporaryDir,
				{
					recursive: true,
					force: true
				}
			);
		}
	});

	it('uses SUDO_USER for clean sudo local registration', function() {
		const fixture = registrationFixture();

		try {
			const result = runShell(
				fixture.script +
				'\nservice_setup_register local'
			);

			assert.strictEqual(
				result.status,
				0,
				result.stdout + result.stderr
			);

			assert.strictEqual(
				fixture.currentUser,
				os.userInfo().username
			);
		} finally {
			fs.rmSync(
				fixture.temporaryDir,
				{
					recursive: true,
					force: true
				}
			);
		}
	});

	it('registers root mode without saving before finalization', function() {
		const fixture = registrationFixture();

		const root = [
			'id() { case "$1" in -u) echo 0;; -un) echo root;; -g) echo 0;; *) command id "$@";; esac; }',
			'SUDO_USER=testuser',
			'service_setup_origin_user() { echo testuser; }',
			'service_setup_resolve_config_identity() { SERVICE_SETUP_RUNTIME_USER=runtime-user; SERVICE_SETUP_CONFIG_GID=testgroup; SERVICE_SETUP_EXPECTED_UID=1200; SERVICE_SETUP_EXPECTED_GID=1300; }'
		].join('\n');

		try {
			const result = runShell(
				fixture.script +
				'\n' +
				root +
				'\nservice_setup_register root'
			);

			assert.strictEqual(
				result.status,
				0,
				result.stdout + result.stderr
			);

			assert.doesNotMatch(
				fs.readFileSync(
					fixture.callsFile,
					'utf8'
				),
				/^save$/m
			);
		} finally {
			fs.rmSync(
				fixture.temporaryDir,
				{
					recursive: true,
					force: true
				}
			);
		}
	});

	it('reports preflight failure as registration not started and saved unchanged', function() {
		const fixture = registrationFixture();

		try {
			const result = runShell(
				fixture.script +
				'\nservice_setup_state_has_trace() { return 0; }\nservice_setup_register local'
			);

			assert.strictEqual(
				result.status,
				1
			);

			assert.doesNotMatch(
				fs.readFileSync(
					fixture.callsFile,
					'utf8'
				),
				/^start /m
			);
		} finally {
			fs.rmSync(
				fixture.temporaryDir,
				{
					recursive: true,
					force: true
				}
			);
		}
	});

	it('rolls back only registration created by this setup', function() {
		const fixture = registrationFixture({
			identityStatus: 1
		});

		try {
			const result = runShell(
				fixture.script +
				'\nservice_setup_register local --save'
			);

			assert.strictEqual(
				result.status,
				1
			);

			assert.match(
				fs.readFileSync(
					fixture.callsFile,
					'utf8'
				),
				/^delete chinachu-operator chinachu-wui$/m
			);
		} finally {
			fs.rmSync(
				fixture.temporaryDir,
				{
					recursive: true,
					force: true
				}
			);
		}
	});

	it('does not pre-create missing PM2 logs during clean setup', function() {
		const source = fs.readFileSync(
			serviceSetupPath,
			'utf8'
		);

		assert.doesNotMatch(
			source,
			/install -o .*chinachu.*\.log/
		);

		assert.doesNotMatch(
			source,
			/service_setup_prepare_pm2_logs/
		);
	});
});

describe('Service Setup finalization', function() {
	it('automatically saves Chinachu, ensures local startup, and verifies the final PM2 state', function() {
		const online = JSON.stringify([
			{
				name: 'chinachu-operator',
				pid: 123,
				pm2_env: {
					status: 'online',
					restart_time: 0
				}
			},
			{
				name: 'chinachu-wui',
				pid: 456,
				pm2_env: {
					status: 'online',
					restart_time: 0
				}
			}
		]);

		const result = runShell([
			'BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath),
			'SERVICE_SETUP_INCLUDE_ROOT=true',
			'SERVICE_SETUP_LOCAL_USER=testuser SERVICE_SETUP_ROOT_USER=root',
			'SERVICE_SETUP_LOCAL_ACTIVE=' + JSON.stringify(online),
			'SERVICE_SETUP_LOCAL_SAVED="[]"',
			'SERVICE_SETUP_ROOT_ACTIVE="[]" SERVICE_SETUP_ROOT_SAVED="[]"',
			'SERVICE_SETUP_LOCAL_ACTIVE_KNOWN=true SERVICE_SETUP_LOCAL_SAVED_KNOWN=true',
			'SERVICE_SETUP_ROOT_ACTIVE_KNOWN=true SERVICE_SETUP_ROOT_SAVED_KNOWN=true',
			'service_setup_register() { printf "REGISTER:%s\\n" "$1"; }',
			'service_setup_capture_state() { return 0; }',
			'service_setup_persistence_save_environment() { printf "SAVE:%s\\n" "$1"; SERVICE_SETUP_LOCAL_SAVED="$SERVICE_SETUP_LOCAL_ACTIVE"; }',
			'service_setup_ensure_local_startup() { printf "STARTUP:%s\\n" "$1"; return 0; }',
			'service_setup_pm2_startup_enabled() { [ "$1" = testuser ]; }',
			'service_setup_log_rotation_review() { echo LOGROTATE; }',
			'service_setup_processes_are_attributed() { return 0; }',
			'service_setup_display_status() { printf "STATUS:%s\\n" "$1"; }',
			'service_setup_run_setup local'
		].join('\n'));

		assert.strictEqual(
			result.status,
			0,
			result.stdout + result.stderr
		);

		assert.match(
			result.stdout,
			/^REGISTER:local$/m
		);

		assert.match(
			result.stdout,
			/^SAVE:LOCAL$/m
		);

		assert.match(
			result.stdout,
			/^STARTUP:testuser$/m
		);

		assert.match(
			result.stdout,
			/^LOGROTATE$/m
		);

		assert.match(
			result.stdout,
			/ONLINE \/ PM2保存済み \/ 自動起動設定済み/
		);

		assert.match(
			result.stdout,
			/^STATUS:/m
		);
	});

	it('does not auto-save unrelated active-only PM2 applications', function() {
		const active = JSON.stringify([
			{
				name: 'chinachu-operator',
				pid: 123,
				pm2_env: {
					status: 'online',
					restart_time: 0
				}
			},
			{
				name: 'chinachu-wui',
				pid: 456,
				pm2_env: {
					status: 'online',
					restart_time: 0
				}
			},
			{
				name: 'other-app',
				pid: 789,
				pm2_env: {
					status: 'online',
					restart_time: 0
				}
			}
		]);

		const result = runShell([
			'INSTALLER_RED= INSTALLER_RESET=',
			'BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath),
			'SERVICE_SETUP_INCLUDE_ROOT=true',
			'SERVICE_SETUP_LOCAL_ACTIVE=' + JSON.stringify(active),
			'SERVICE_SETUP_LOCAL_SAVED="[]"',
			'SERVICE_SETUP_ROOT_ACTIVE="[]" SERVICE_SETUP_ROOT_SAVED="[]"',
			'service_setup_register() { return 0; }',
			'service_setup_capture_state() { return 0; }',
			'service_setup_persistence_save_environment() { echo SHOULD_NOT_SAVE; return 99; }',
			'service_setup_run_setup local'
		].join('\n'));

		assert.strictEqual(
			result.status,
			1
		);

		assert.doesNotMatch(
			result.stdout,
			/SHOULD_NOT_SAVE/
		);
	});
});

describe('Service Setup menu policy', function() {
	it('guides a direct non-root invocation to sudo without inspecting state', function() {
		const result = runShell([
			'INSTALLER_RED= INSTALLER_RESET=',
			'id() { case "$1" in -u) echo 1000;; -un) echo testuser;; *) command id "$@";; esac; }',
			'service_setup_capture_state() { echo SHOULD_NOT_INSPECT; return 99; }',
			'service_setup_pm2_as_user() { echo SHOULD_NOT_MUTATE; return 99; }',
			'chinachu_service_setup'
		].join('\n'));

		assert.strictEqual(
			result.status,
			0,
			result.stdout + result.stderr
		);

		assert.match(
			result.stdout,
			/sudo \.\/chinachu service setup/
		);

		assert.doesNotMatch(
			result.stdout,
			/SHOULD_NOT_(?:INSPECT|MUTATE)/
		);
	});

	it('routes clean setup choices to local and root modes', function() {
		for (const [ choice, mode ] of [
			[
				'1',
				'local'
			],
			[
				'2',
				'root'
			]
		]) {
			const result = runShell([
				'INSTALLER_RED= INSTALLER_RESET=',
				'SERVICE_SETUP_MENU_CHOICE=' + choice,
				'resolve_bootstrap_node() { BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath) + '; }',
				'id() { case "$1" in -u) echo 0;; *) command id "$@";; esac; }',
				'service_setup_origin_user() { echo testuser; }',
				'service_setup_capture_state() { ' + cleanState().replace(/\n/g, '; ') + '; }',
				'service_setup_display_status() { :; }',
				'service_setup_run_setup() { printf "SETUP:%s\\n" "$1"; }',
				'service_setup_run_menu'
			].join('\n'));

			assert.strictEqual(
				result.status,
				0,
				result.stdout + result.stderr
			);

			assert.match(
				result.stdout,
				new RegExp(
					'^SETUP:' +
						mode +
						'$',
					'm'
				)
			);
		}
	});

	it('requires a valid non-root SUDO_USER for the sudo entry', function() {
		const result = runShell([
			'INSTALLER_RED= INSTALLER_RESET=',
			'id() { case "$1" in -u) echo 0;; *) command id "$@";; esac; }',
			'resolve_bootstrap_node() { BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath) + '; }',
			'unset SUDO_USER',
			'chinachu_service_setup'
		].join('\n'));

		assert.strictEqual(
			result.status,
			1
		);

		assert.match(
			result.stderr,
			/SUDO_USER/
		);
	});

	it('routes an existing partial Chinachu state to cleanup only', function() {
		const result = runShell([
			'INSTALLER_RED= INSTALLER_RESET=',
			'SERVICE_SETUP_MENU_CHOICE=1',
			'resolve_bootstrap_node() { BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath) + '; }',
			'id() { case "$1" in -u) echo 0;; *) command id "$@";; esac; }',
			'service_setup_origin_user() { echo testuser; }',
			'service_setup_capture_state() { ' + cleanState().replace(/\n/g, '; ') + '; SERVICE_SETUP_LOCAL_ACTIVE=' + JSON.stringify('[{"name":"chinachu-wui"}]') + '; }',
			'service_setup_display_status() { :; }',
			'service_setup_cleanup() { echo CLEANUP; }',
			'service_setup_run_setup() { echo SHOULD_NOT_SETUP; return 99; }',
			'service_setup_run_menu'
		].join('\n'));

		assert.strictEqual(
			result.status,
			0,
			result.stdout + result.stderr
		);

		assert.match(
			result.stdout,
			/^CLEANUP$/m
		);

		assert.doesNotMatch(
			result.stdout,
			/SHOULD_NOT_SETUP/
		);
	});
});

describe('Chinachu-only cleanup', function() {
	it('does not rewrite or save a Mirakurun-only dump during artifact-only cleanup', function() {
		const temporaryDir = fs.mkdtempSync(
			path.join(
				os.tmpdir(),
				'chinachu-cleanup-unchanged-dump-'
			)
		);

		const dump = path.join(
			temporaryDir,
			'dump.pm2'
		);

		const calls = path.join(
			temporaryDir,
			'calls'
		);

		const content =
			'[{"name":"mirakurun-server","keep":"byte-for-byte"}]\n';

		fs.writeFileSync(
			dump,
			content
		);

		fs.writeFileSync(
			calls,
			''
		);

		const before = fs.statSync(
			dump
		);

		try {
			const result = runShell([
				'BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath),
				'SERVICE_SETUP_LOCAL_USER=testuser',
				'SERVICE_SETUP_LOCAL_HOME=' + JSON.stringify(temporaryDir),
				'SERVICE_SETUP_LOCAL_DUMP=' + JSON.stringify(dump),
				'SERVICE_SETUP_LOCAL_ACTIVE="[]"',
				'SERVICE_SETUP_LOCAL_SAVED=' + JSON.stringify('[{"name":"mirakurun-server"}]'),
				'service_setup_pm2_as_user() { printf "%s\\n" "$*" >> ' + JSON.stringify(calls) + '; }',
				'service_setup_backup_environment LOCAL',
				'service_setup_cleanup_environment LOCAL',
				'printf "backup=%s save=%s\\n" "$SERVICE_SETUP_LOCAL_DUMP_BACKUP" "$SERVICE_SETUP_LOCAL_SAVE_EXECUTED"'
			].join('\n'));

			assert.strictEqual(
				result.status,
				0,
				result.stdout + result.stderr
			);

			assert.match(
				result.stdout,
				/backup= save=false/
			);

			assert.strictEqual(
				fs.readFileSync(
					dump,
					'utf8'
				),
				content
			);

			assert.strictEqual(
				fs.statSync(
					dump
				).mtimeMs,
				before.mtimeMs
			);

			assert.strictEqual(
				fs.readFileSync(
					calls,
					'utf8'
				),
				''
			);
		} finally {
			fs.rmSync(
				temporaryDir,
				{
					recursive: true,
					force: true
				}
			);
		}
	});

	it('removes Chinachu active/saved entries while preserving Mirakurun', function() {
		const temporaryDir = fs.mkdtempSync(
			path.join(
				os.tmpdir(),
				'chinachu-cleanup-pm2-'
			)
		);

		const dump = path.join(
			temporaryDir,
			'dump.pm2'
		);

		const backup =
			dump +
			'.backup';

		const calls = path.join(
			temporaryDir,
			'calls'
		);

		const list = [
			{
				name: 'mirakurun-server'
			},
			{
				name: 'chinachu-operator'
			},
			{
				name: 'chinachu-wui'
			}
		];

		fs.writeFileSync(
			dump,
			JSON.stringify(list)
		);

		fs.copyFileSync(
			dump,
			backup
		);

		fs.writeFileSync(
			calls,
			''
		);

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

			assert.strictEqual(
				result.status,
				0,
				result.stdout + result.stderr
			);

			const saved = JSON.parse(
				fs.readFileSync(
					dump,
					'utf8'
				)
			);

			assert.deepStrictEqual(
				saved.map(function(item) {
					return item.name;
				}),
				[
					'mirakurun-server'
				]
			);

			const commands = fs.readFileSync(
				calls,
				'utf8'
			);

			assert.match(
				commands,
				/^testuser stop chinachu-operator chinachu-wui$/m
			);

			assert.match(
				commands,
				/^testuser delete chinachu-operator chinachu-wui$/m
			);

			assert.match(
				commands,
				/^testuser save$/m
			);

			assert.doesNotMatch(
				commands,
				/delete .*mirakurun/
			);
		} finally {
			fs.rmSync(
				temporaryDir,
				{
					recursive: true,
					force: true
				}
			);
		}
	});

	it('removes saved-only Chinachu without invoking pm2 save and keeps other saved entries', function() {
		const temporaryDir = fs.mkdtempSync(
			path.join(
				os.tmpdir(),
				'chinachu-cleanup-saved-only-'
			)
		);

		const dump = path.join(
			temporaryDir,
			'dump.pm2'
		);

		const backup =
			dump +
			'.backup';

		const calls = path.join(
			temporaryDir,
			'calls'
		);

		const saved = [
			{
				name: 'mirakurun-server'
			},
			{
				name: 'old-service'
			},
			{
				name: 'chinachu-wui'
			}
		];

		fs.writeFileSync(
			dump,
			JSON.stringify(saved)
		);

		fs.copyFileSync(
			dump,
			backup
		);

		fs.writeFileSync(
			calls,
			''
		);

		try {
			const result = runShell([
				'BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath),
				'SERVICE_SETUP_LOCAL_USER=testuser',
				'SERVICE_SETUP_LOCAL_ACTIVE="[]"',
				'SERVICE_SETUP_LOCAL_SAVED=' + JSON.stringify(JSON.stringify(saved)),
				'SERVICE_SETUP_LOCAL_DUMP=' + JSON.stringify(dump),
				'SERVICE_SETUP_LOCAL_DUMP_BACKUP=' + JSON.stringify(backup),
				'service_setup_pm2_as_user() { printf "%s\\n" "$*" >> ' + JSON.stringify(calls) + '; }',
				'service_setup_cleanup_environment LOCAL',
				'printf "saved=%s save=%s active=%s\\n" "$SERVICE_SETUP_LOCAL_SAVED_CHANGED" "$SERVICE_SETUP_LOCAL_SAVE_EXECUTED" "$SERVICE_SETUP_LOCAL_ACTIVE_CHANGED"'
			].join('\n'));

			assert.strictEqual(
				result.status,
				0,
				result.stdout + result.stderr
			);

			assert.match(
				result.stdout,
				/saved=true save=false active=false/
			);

			assert.strictEqual(
				fs.readFileSync(
					calls,
					'utf8'
				),
				''
			);

			assert.deepStrictEqual(
				JSON.parse(
					fs.readFileSync(
						dump,
						'utf8'
					)
				).map(function(item) {
					return item.name;
				}),
				[
					'mirakurun-server',
					'old-service'
				]
			);
		} finally {
			fs.rmSync(
				temporaryDir,
				{
					recursive: true,
					force: true
				}
			);
		}
	});

	it('preserves both newly saved active and previously saved non-Chinachu entries', function() {
		const temporaryDir = fs.mkdtempSync(
			path.join(
				os.tmpdir(),
				'chinachu-cleanup-merge-'
			)
		);

		const dump = path.join(
			temporaryDir,
			'dump.pm2'
		);

		const backup =
			dump +
			'.backup';

		fs.writeFileSync(
			dump,
			JSON.stringify([
				{
					name: 'active-other'
				},
				{
					name: 'chinachu-wui'
				}
			])
		);

		fs.writeFileSync(
			backup,
			JSON.stringify([
				{
					name: 'saved-other'
				},
				{
					name: 'chinachu-operator'
				}
			])
		);

		try {
			const result = runShell([
				'BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath),
				'SERVICE_SETUP_LOCAL_DUMP=' + JSON.stringify(dump),
				'SERVICE_SETUP_LOCAL_DUMP_BACKUP=' + JSON.stringify(backup),
				'service_setup_remove_saved_chinachu LOCAL'
			].join('\n'));

			assert.strictEqual(
				result.status,
				0,
				result.stdout + result.stderr
			);

			assert.deepStrictEqual(
				JSON.parse(
					fs.readFileSync(
						dump,
						'utf8'
					)
				).map(function(item) {
					return item.name;
				}),
				[
					'active-other',
					'saved-other'
				]
			);
		} finally {
			fs.rmSync(
				temporaryDir,
				{
					recursive: true,
					force: true
				}
			);
		}
	});

	it('backs up known logs without truncating or changing their content', function() {
		const temporaryDir = fs.mkdtempSync(
			path.join(
				os.tmpdir(),
				'chinachu-cleanup-logs-'
			)
		);

		fs.mkdirSync(
			path.join(
				temporaryDir,
				'log'
			)
		);

		const original = path.join(
			temporaryDir,
			'log',
			'chinachu-wui.stdout.log'
		);

		fs.writeFileSync(
			original,
			'keep-log-content'
		);

		try {
			const result = runShell(
				'CHINACHU_DIR=' +
					JSON.stringify(temporaryDir) +
					'\nservice_setup_backup_logs\nprintf "%s\\n" "${SERVICE_SETUP_LOG_BACKUPS[0]}"'
			);

			assert.strictEqual(
				result.status,
				0,
				result.stdout + result.stderr
			);

			const pair =
				result.stdout
					.trim()
					.split('|');

			assert.strictEqual(
				fs.existsSync(
					original
				),
				false
			);

			assert.strictEqual(
				fs.readFileSync(
					pair[1],
					'utf8'
				),
				'keep-log-content'
			);

			assert.match(
				path.basename(
					pair[1]
				),
				/\.pm2-backup-/
			);
		} finally {
			fs.rmSync(
				temporaryDir,
				{
					recursive: true,
					force: true
				}
			);
		}
	});

	it('restores logs renamed by a failed cleanup', function() {
		const temporaryDir = fs.mkdtempSync(
			path.join(
				os.tmpdir(),
				'chinachu-cleanup-log-rollback-'
			)
		);

		const original = path.join(
			temporaryDir,
			'original.log'
		);

		const backup =
			original +
			'.backup';

		fs.writeFileSync(
			backup,
			'restore-me'
		);

		try {
			const result = runShell(
				'SERVICE_SETUP_LOG_BACKUPS=(' +
					JSON.stringify(
						original +
							'|' +
							backup
					) +
					')\nservice_setup_restore_logs'
			);

			assert.strictEqual(
				result.status,
				0,
				result.stdout + result.stderr
			);

			assert.strictEqual(
				fs.readFileSync(
					original,
					'utf8'
				),
				'restore-me'
			);
		} finally {
			fs.rmSync(
				temporaryDir,
				{
					recursive: true,
					force: true
				}
			);
		}
	});

	it('removes only a confirmed stale PID', function() {
		const temporaryDir = fs.mkdtempSync(
			path.join(
				os.tmpdir(),
				'chinachu-cleanup-pid-'
			)
		);

		fs.mkdirSync(
			path.join(
				temporaryDir,
				'data'
			)
		);

		const stale = path.join(
			temporaryDir,
			'data',
			'chinachu-operator.pid'
		);

		fs.writeFileSync(
			stale,
			'99999999\n'
		);

		try {
			const result = runShell(
				'CHINACHU_DIR=' +
					JSON.stringify(temporaryDir) +
					'\nservice_setup_remove_stale_pids'
			);

			assert.strictEqual(
				result.status,
				0,
				result.stdout + result.stderr
			);

			assert.strictEqual(
				fs.existsSync(
					stale
				),
				false
			);
		} finally {
			fs.rmSync(
				temporaryDir,
				{
					recursive: true,
					force: true
				}
			);
		}
	});

	it('validates every PID file before deleting any of them', function() {
		const temporaryDir = fs.mkdtempSync(
			path.join(
				os.tmpdir(),
				'chinachu-cleanup-pid-preflight-'
			)
		);

		fs.mkdirSync(
			path.join(
				temporaryDir,
				'data'
			)
		);

		const first = path.join(
			temporaryDir,
			'data',
			'chinachu-operator.pid'
		);

		const second = path.join(
			temporaryDir,
			'data',
			'chinachu-wui.pid'
		);

		fs.writeFileSync(
			first,
			'99999998\n'
		);

		fs.writeFileSync(
			second,
			String(process.pid) +
				'\n'
		);

		try {
			const result = runShell([
				'CHINACHU_DIR=' + JSON.stringify(temporaryDir),
				'service_setup_pid_is_stale() { [ "$1" != ' + JSON.stringify(second) + ' ]; }',
				'service_setup_remove_stale_pids'
			].join('\n'));

			assert.strictEqual(
				result.status,
				1
			);

			assert.strictEqual(
				fs.existsSync(
					first
				),
				true
			);

			assert.strictEqual(
				fs.existsSync(
					second
				),
				true
			);
		} finally {
			fs.rmSync(
				temporaryDir,
				{
					recursive: true,
					force: true
				}
			);
		}
	});

	it('refuses to kill an unattributed repository process', function() {
		const calls = path.join(
			fs.mkdtempSync(
				path.join(
					os.tmpdir(),
					'chinachu-cleanup-conflict-'
				)
			),
			'calls'
		);

		fs.writeFileSync(
			calls,
			''
		);

		try {
			const result = runShell([
				'INSTALLER_RED= INSTALLER_RESET=',
				'BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath),
				cleanState(),
				'SERVICE_SETUP_PROCESS_PIDS=12345',
				'service_setup_pm2_as_user() { echo "$*" >> ' + JSON.stringify(calls) + '; }',
				'id() { [ "$1" = -u ] && echo 0 || command id "$@"; }',
				'service_setup_cleanup'
			].join('\n'));

			assert.strictEqual(
				result.status,
				1
			);

			assert.match(
				result.stderr,
				/kill/
			);

			assert.strictEqual(
				fs.readFileSync(
					calls,
					'utf8'
				),
				''
			);
		} finally {
			fs.rmSync(
				path.dirname(
					calls
				),
				{
					recursive: true,
					force: true
				}
			);
		}
	});

	it('refuses cleanup when any PM2 state is unknown', function() {
		const result = runShell([
			'INSTALLER_RED= INSTALLER_RESET=',
			cleanState(),
			'SERVICE_SETUP_INCLUDE_ROOT=true',
			'SERVICE_SETUP_ROOT_SAVED_KNOWN=false',
			'id() { [ "$1" = -u ] && echo 0 || command id "$@"; }',
			'service_setup_cleanup'
		].join('\n'));

		assert.strictEqual(
			result.status,
			1
		);
	});

	it('keeps the recording and imminent reservation guard', function() {
		const temporaryDir = fs.mkdtempSync(
			path.join(
				os.tmpdir(),
				'chinachu-cleanup-guard-'
			)
		);

		fs.mkdirSync(
			path.join(
				temporaryDir,
				'data'
			)
		);

		fs.writeFileSync(
			path.join(
				temporaryDir,
				'data',
				'recording.json'
			),
			'[{"id":"active"}]'
		);

		fs.writeFileSync(
			path.join(
				temporaryDir,
				'data',
				'reserves.json'
			),
			'[]'
		);

		try {
			const result = runShell(
				'cd ' +
					JSON.stringify(
						temporaryDir
					) +
					'\nBOOTSTRAP_NODE_COMMAND=' +
					JSON.stringify(
						process.execPath
					) +
					'\nservice_setup_guard_activity'
			);

			assert.strictEqual(
				result.status,
				1
			);
		} finally {
			fs.rmSync(
				temporaryDir,
				{
					recursive: true,
					force: true
				}
			);
		}
	});

	it('finishes cleanup without starting setup directly', function() {
		const result = runShell([
			'INSTALLER_RED= INSTALLER_RESET=',
			'BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath),
			cleanState(),
			'SERVICE_SETUP_LOCAL_USER=testuser SERVICE_SETUP_ROOT_USER=root',
			'SERVICE_SETUP_CLEANUP_ANSWER=y',
			'id() { [ "$1" = -u ] && echo 0 || command id "$@"; }',
			'service_setup_processes_are_attributed() { return 0; }',
			'service_setup_backup_environment() { return 0; }',
			'service_setup_cleanup_environment() { return 0; }',
			'service_setup_backup_logs() { SERVICE_SETUP_LOG_BACKUPS=(); }',
			'service_setup_guard_activity() { echo SHOULD_NOT_GUARD; return 99; }',
			'service_setup_capture_state() { ' + cleanState().replace(/\n/g, '; ') + '; }',
			'service_setup_remove_stale_pids() { return 0; }',
			'service_setup_register() { echo SHOULD_NOT_SETUP; return 99; }',
			'service_setup_cleanup'
		].join('\n'));

		assert.strictEqual(
			result.status,
			0,
			result.stdout + result.stderr
		);

		assert.doesNotMatch(
			result.stdout,
			/SHOULD_NOT_SETUP/
		);

		assert.doesNotMatch(
			result.stdout,
			/SHOULD_NOT_GUARD/
		);
	});
});

describe('PM2 persistence', function() {
	it('detects active-only and saved-only processes independently', function() {
		const active = JSON.stringify([
			{
				name: 'chinachu-operator'
			},
			{
				name: 'mirakurun-server'
			}
		]);

		const saved = JSON.stringify([
			{
				name: 'mirakurun-server'
			},
			{
				name: 'old-service'
			}
		]);

		const result = runShell([
			'BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath),
			'SERVICE_SETUP_LOCAL_ACTIVE=' + JSON.stringify(active),
			'SERVICE_SETUP_LOCAL_SAVED=' + JSON.stringify(saved),
			'service_setup_load_persistence_fields LOCAL',
			'printf "active-only=%s\\nsaved-only=%s\\n" "$SERVICE_SETUP_LOCAL_ACTIVE_ONLY" "$SERVICE_SETUP_LOCAL_SAVED_ONLY"'
		].join('\n'));

		assert.strictEqual(
			result.status,
			0,
			result.stdout + result.stderr
		);

		assert.match(
			result.stdout,
			/^active-only=chinachu-operator$/m
		);

		assert.match(
			result.stdout,
			/^saved-only=old-service$/m
		);
	});

	it('reports no persistence delta when active and saved names match', function() {
		const state = JSON.stringify([
			{
				name: 'chinachu-operator'
			},
			{
				name: 'chinachu-wui'
			}
		]);

		const result = runShell([
			'BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath),
			'SERVICE_SETUP_LOCAL_ACTIVE=' + JSON.stringify(state),
			'SERVICE_SETUP_LOCAL_SAVED=' + JSON.stringify(state),
			'service_setup_load_persistence_fields LOCAL',
			'printf "active-only=%s\\nsaved-only=%s\\n" "$SERVICE_SETUP_LOCAL_ACTIVE_ONLY" "$SERVICE_SETUP_LOCAL_SAVED_ONLY"'
		].join('\n'));

		assert.strictEqual(
			result.status,
			0,
			result.stdout + result.stderr
		);

		assert.match(
			result.stdout,
			/^active-only=$/m
		);

		assert.match(
			result.stdout,
			/^saved-only=$/m
		);
	});

	it('preserves non-Chinachu saved-only entries when saving PM2 state', function() {
		const temporaryDir = fs.mkdtempSync(
			path.join(
				os.tmpdir(),
				'chinachu-persistence-save-'
			)
		);

		const dump = path.join(
			temporaryDir,
			'dump.pm2'
		);

		const calls = path.join(
			temporaryDir,
			'calls'
		);

		const active = JSON.stringify([
			{
				name: 'chinachu-operator'
			},
			{
				name: 'chinachu-wui'
			},
			{
				name: 'mirakurun-server'
			}
		]);

		fs.writeFileSync(
			dump,
			JSON.stringify([
				{
					name: 'mirakurun-server'
				},
				{
					name: 'old-service'
				}
			])
		);

		fs.writeFileSync(
			calls,
			''
		);

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

			assert.strictEqual(
				result.status,
				0,
				result.stdout + result.stderr
			);

			assert.strictEqual(
				fs.readFileSync(
					calls,
					'utf8'
				),
				'testuser save\n'
			);

			assert.deepStrictEqual(
				JSON.parse(
					fs.readFileSync(
						dump,
						'utf8'
					)
				).map(function(item) {
					return item.name;
				}),
				[
					'chinachu-operator',
					'chinachu-wui',
					'mirakurun-server',
					'old-service'
				]
			);
		} finally {
			fs.rmSync(
				temporaryDir,
				{
					recursive: true,
					force: true
				}
			);
		}
	});

	it('restores the original dump when pm2 save fails', function() {
		const temporaryDir = fs.mkdtempSync(
			path.join(
				os.tmpdir(),
				'chinachu-persistence-rollback-'
			)
		);

		const dump = path.join(
			temporaryDir,
			'dump.pm2'
		);

		const original =
			'[{"name":"old-service","keep":true}]\n';

		fs.writeFileSync(
			dump,
			original
		);

		try {
			const result = runShell([
				'BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath),
				'SERVICE_SETUP_LOCAL_USER=testuser',
				'SERVICE_SETUP_LOCAL_DUMP=' + JSON.stringify(dump),
				'SERVICE_SETUP_LOCAL_ACTIVE="[]"',
				'service_setup_pm2_as_user() { printf "[]" > ' + JSON.stringify(dump) + '; return 1; }',
				'service_setup_persistence_save_environment LOCAL'
			].join('\n'));

			assert.strictEqual(
				result.status,
				1
			);

			assert.strictEqual(
				fs.readFileSync(
					dump,
					'utf8'
				),
				original
			);
		} finally {
			fs.rmSync(
				temporaryDir,
				{
					recursive: true,
					force: true
				}
			);
		}
	});
});

describe('PM2 status rendering', function() {
	it('does not call PM2 when rendering an environment without a daemon', function() {
		const result = runShell([
			'SERVICE_SETUP_LOCAL_USER=testuser SERVICE_SETUP_LOCAL_DAEMON_ACTIVE=false SERVICE_SETUP_LOCAL_ACTIVE="[]"',
			'service_setup_pm2_as_user() { echo SHOULD_NOT_CALL_PM2; return 99; }',
			'service_setup_render_status_environment Local LOCAL'
		].join('\n'));

		assert.strictEqual(
			result.status,
			0,
			result.stdout + result.stderr
		);

		assert.doesNotMatch(
			result.stdout,
			/SHOULD_NOT_CALL_PM2/
		);
	});

	it('passes through native PM2 status output for a running environment', function() {
		const result = runShell([
			'SERVICE_SETUP_LOCAL_USER=testuser SERVICE_SETUP_LOCAL_DAEMON_ACTIVE=true',
			'service_setup_pm2_as_user() { printf "CALL:%s:%s\\nNATIVE_PM2_STATUS\\n" "$1" "$2"; }',
			'service_setup_render_status_environment Local LOCAL'
		].join('\n'));

		assert.strictEqual(
			result.status,
			0,
			result.stdout + result.stderr
		);

		assert.match(
			result.stdout,
			/^CALL:testuser:status$/m
		);

		assert.match(
			result.stdout,
			/^NATIVE_PM2_STATUS$/m
		);
	});
});

describe('PM2 log rotation', function() {
	it('requires both the PM2 module database entry and installed package', function() {
		const temporaryDir = fs.mkdtempSync(
			path.join(
				os.tmpdir(),
				'chinachu-logrotate-capture-'
			)
		);

		const modulePath = path.join(
			temporaryDir,
			'.pm2',
			'modules',
			'pm2-logrotate',
			'node_modules',
			'pm2-logrotate'
		);

		fs.mkdirSync(
			modulePath,
			{
				recursive: true
			}
		);

		fs.writeFileSync(
			path.join(
				modulePath,
				'package.json'
			),
			'{}'
		);

		fs.writeFileSync(
			path.join(
				temporaryDir,
				'.pm2',
				'module_conf.json'
			),
			JSON.stringify({
				'module-db-v2': {
					'pm2-logrotate': {}
				}
			})
		);

		try {
			const result = runShell([
				'BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath),
				'SERVICE_SETUP_PM2_BIN=/fixture/pm2',
				'service_setup_user_home() { printf "%s\\n" ' + JSON.stringify(temporaryDir) + '; }',
				'service_setup_pm2_daemon_active() { return 1; }',
				'service_setup_capture_pm2_environment LOCAL testuser',
				'printf "installed=%s partial=%s daemon=%s\\n" "$SERVICE_SETUP_LOCAL_LOGROTATE_INSTALLED" "$SERVICE_SETUP_LOCAL_LOGROTATE_PARTIAL" "$SERVICE_SETUP_LOCAL_DAEMON_ACTIVE"'
			].join('\n'));

			assert.strictEqual(
				result.status,
				0,
				result.stdout + result.stderr
			);

			assert.match(
				result.stdout,
				/installed=true partial=false daemon=false/
			);
		} finally {
			fs.rmSync(
				temporaryDir,
				{
					recursive: true,
					force: true
				}
			);
		}
	});

	it('detects the pm2-logrotate entry in the PM2 module database', function() {
		const temporaryDir = fs.mkdtempSync(
			path.join(
				os.tmpdir(),
				'chinachu-logrotate-detect-'
			)
		);

		const config = path.join(
			temporaryDir,
			'module_conf.json'
		);

		try {
			fs.writeFileSync(
				config,
				JSON.stringify({
					'module-db-v2': {
						'pm2-logrotate': {
							max_size: '10M'
						}
					}
				})
			);

			const configured = runShell(
				'BOOTSTRAP_NODE_COMMAND=' +
					JSON.stringify(
						process.execPath
					) +
					'\nservice_setup_module_configured ' +
					JSON.stringify(
						config
					)
			);

			assert.strictEqual(
				configured.status,
				0,
				configured.stdout +
					configured.stderr
			);

			fs.writeFileSync(
				config,
				'{}'
			);

			const missing = runShell(
				'BOOTSTRAP_NODE_COMMAND=' +
					JSON.stringify(
						process.execPath
					) +
					'\nservice_setup_module_configured ' +
					JSON.stringify(
						config
					)
			);

			assert.strictEqual(
				missing.status,
				1
			);
		} finally {
			fs.rmSync(
				temporaryDir,
				{
					recursive: true,
					force: true
				}
			);
		}
	});

	it('does not reinstall an existing module or rewrite its settings', function() {
		const result = runShell([
			'BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath),
			cleanState(),
			'SERVICE_SETUP_LOCAL_ACTIVE="[{\\"name\\":\\"chinachu-wui\\"}]"',
			'SERVICE_SETUP_LOCAL_LOGROTATE_INSTALLED=true',
			'service_setup_pm2_as_user() { echo SHOULD_NOT_INSTALL; return 99; }',
			'service_setup_log_rotation_review'
		].join('\n'));

		assert.strictEqual(
			result.status,
			0,
			result.stdout + result.stderr
		);

		assert.doesNotMatch(
			result.stdout,
			/SHOULD_NOT_INSTALL/
		);
	});

	it('installs the pinned module for Local Chinachu only after explicit confirmation', function() {
		const result = runShell([
			'BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath),
			cleanState(),
			'SERVICE_SETUP_FORCE_TTY=true SERVICE_SETUP_LOCAL_LOGROTATE_ANSWER=y',
			'SERVICE_SETUP_LOCAL_ACTIVE="[{\\"name\\":\\"chinachu-operator\\"},{\\"name\\":\\"chinachu-wui\\"}]"',
			'SERVICE_SETUP_LOCAL_DAEMON_ACTIVE=true',
			'service_setup_pm2_as_user() { printf "CALL:%s\\n" "$*"; }',
			'service_setup_capture_pm2_environment() { SERVICE_SETUP_LOCAL_LOGROTATE_INSTALLED=true; }',
			'service_setup_log_rotation_review'
		].join('\n'));

		assert.strictEqual(
			result.status,
			0,
			result.stdout + result.stderr
		);

		assert.match(
			result.stdout,
			/CALL:testuser install pm2-logrotate@3\.0\.0/
		);

		assert.doesNotMatch(
			result.stdout,
			/CALL:.* save/
		);
	});

	it('leaves Root PM2 unchanged when logrotate installation is declined', function() {
		const result = runShell([
			'BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath),
			cleanState(),
			'SERVICE_SETUP_FORCE_TTY=true SERVICE_SETUP_ROOT_LOGROTATE_ANSWER=n',
			'SERVICE_SETUP_ROOT_ACTIVE="[{\\"name\\":\\"mirakurun-server\\"},{\\"name\\":\\"other-app\\"}]"',
			'SERVICE_SETUP_ROOT_DAEMON_ACTIVE=true',
			'service_setup_pm2_as_user() { echo SHOULD_NOT_INSTALL; return 99; }',
			'service_setup_log_rotation_review'
		].join('\n'));

		assert.strictEqual(
			result.status,
			0,
			result.stdout + result.stderr
		);

		assert.doesNotMatch(
			result.stdout,
			/SHOULD_NOT_INSTALL/
		);
	});

	it('installs for the entire Root PM2 environment only after explicit yes', function() {
		const result = runShell([
			'BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath),
			cleanState(),
			'SERVICE_SETUP_FORCE_TTY=true SERVICE_SETUP_ROOT_LOGROTATE_ANSWER=y',
			'SERVICE_SETUP_ROOT_ACTIVE="[{\\"name\\":\\"mirakurun-server\\"},{\\"name\\":\\"chinachu-wui\\"}]"',
			'SERVICE_SETUP_ROOT_DAEMON_ACTIVE=true',
			'service_setup_pm2_as_user() { printf "CALL:%s\\n" "$*"; }',
			'service_setup_capture_pm2_environment() { SERVICE_SETUP_ROOT_LOGROTATE_INSTALLED=true; }',
			'service_setup_log_rotation_review'
		].join('\n'));

		assert.strictEqual(
			result.status,
			0,
			result.stdout + result.stderr
		);

		assert.match(
			result.stdout,
			/CALL:root install pm2-logrotate@3\.0\.0/
		);

		assert.doesNotMatch(
			result.stdout,
			/CALL:.* save/
		);
	});

	it('reports install failure without deleting Chinachu registration', function() {
		const result = runShell([
			'BOOTSTRAP_NODE_COMMAND=' + JSON.stringify(process.execPath),
			cleanState(),
			'SERVICE_SETUP_FORCE_TTY=true SERVICE_SETUP_LOCAL_LOGROTATE_ANSWER=y',
			'SERVICE_SETUP_LOCAL_ACTIVE="[{\\"name\\":\\"chinachu-wui\\"}]"',
			'SERVICE_SETUP_LOCAL_DAEMON_ACTIVE=true',
			'service_setup_pm2_as_user() { printf "CALL:%s\\n" "$*"; return 1; }',
			'service_setup_log_rotation_review'
		].join('\n'));

		assert.strictEqual(
			result.status,
			1
		);

		assert.match(
			result.stdout,
			/CALL:testuser install pm2-logrotate@3\.0\.0/
		);

		assert.doesNotMatch(
			result.stdout,
			/CALL:.*delete/
		);
	});
});

describe('PM2 process definition and shutdown contract', function() {
	it('uses repository-local logs/pids and bounded tree shutdown', function() {
		const apps = JSON.parse(
			fs.readFileSync(
				path.join(
					repositoryRoot,
					'processes.json'
				),
				'utf8'
			)
		).apps;

		for (const app of apps) {
			assert.strictEqual(
				app.cwd,
				'.'
			);

			assert.strictEqual(
				app.exec_interpreter,
				'.nave/node'
			);

			assert.strictEqual(
				app.treekill,
				true
			);

			assert.strictEqual(
				app.kill_timeout,
				12000
			);

			assert.strictEqual(
				path.isAbsolute(
					app.out_file
				),
				false
			);

			assert.strictEqual(
				path.isAbsolute(
					app.error_file
				),
				false
			);

			assert.strictEqual(
				path.isAbsolute(
					app.pid_file
				),
				false
			);
		}
	});

	it('keeps graceful SIGINT, SIGTERM, and SIGQUIT handlers', function() {
		for (const name of [
			'app-operator.js',
			'app-wui.js'
		]) {
			assert.match(
				fs.readFileSync(
					path.join(
						repositoryRoot,
						name
					),
					'utf8'
				),
				/\[ 'SIGINT', 'SIGTERM', 'SIGQUIT' \]/
			);
		}
	});
});
