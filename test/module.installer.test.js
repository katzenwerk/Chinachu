'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const repositoryRoot = path.resolve(__dirname, '..');
const launcherPath = path.join(repositoryRoot, 'chinachu');

function createLauncherFixture() {
	const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-installer-'));

	fs.copyFileSync(launcherPath, path.join(temporaryDir, 'chinachu'));
	fs.chmodSync(path.join(temporaryDir, 'chinachu'), 0o755);
	fs.copyFileSync(path.join(repositoryRoot, 'config.sample.json'), path.join(temporaryDir, 'config.sample.json'));
	fs.copyFileSync(path.join(repositoryRoot, 'rules.sample.json'), path.join(temporaryDir, 'rules.sample.json'));
	fs.writeFileSync(path.join(temporaryDir, 'app-operator.js'), "require('fs').writeFileSync('service-ran', 'yes');\n");

	return temporaryDir;
}

function runServiceBootstrap(temporaryDir) {
	return childProcess.spawnSync('bash', [ './chinachu', 'service', 'operator', 'execute' ], {
		cwd: temporaryDir,
		encoding: 'utf8'
	});
}

function writeSourceableLauncher(temporaryDir) {
	const source = fs.readFileSync(launcherPath, 'utf8').replace(/\nmain "\$@"\s*$/, '\n');
	const sourceable = path.join(temporaryDir, 'chinachu-functions.sh');

	fs.writeFileSync(sourceable, source);
	return sourceable;
}

function writeSuccessfulNpm(temporaryDir) {
	const npmPath = path.join(temporaryDir, 'npm');

	fs.writeFileSync(npmPath, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 11.19.0; fi\nexit 0\n');
	fs.chmodSync(npmPath, 0o755);
	return npmPath;
}

function writeExecutable(filePath, source) {
	fs.writeFileSync(filePath, '#!/bin/sh\n' + source + '\n');
	fs.chmodSync(filePath, 0o755);
}

function writeFakeFfmpegPair(binDir, logPath) {
	fs.mkdirSync(binDir, { recursive: true });
	for (const name of [ 'ffmpeg', 'ffprobe' ]) {
		writeExecutable(path.join(binDir, name), [
			logPath ? 'printf \'%s %s\\n\' "' + name + '" "$*" >> "' + logPath + '"' : ':',
			'[ "$1" = "-version" ] || exit 64',
			'printf \'%s version system-test\\n\' "' + name + '"'
		].join('\n'));
	}
}

function writeLegacyFfmpegFixture(usrDir) {
	const binDir = path.join(usrDir, 'bin');
	fs.mkdirSync(binDir, { recursive: true });
	writeExecutable(
		path.join(binDir, 'ffmpeg'),
		'printf \'ffmpeg version 4.1.4-static https://johnvansickle.com/ffmpeg/ test\\n\''
	);
	writeExecutable(
		path.join(binDir, 'ffprobe'),
		'printf \'ffprobe version 4.1.4-static https://johnvansickle.com/ffmpeg/ test\\n\''
	);
	fs.symlinkSync(path.join(binDir, 'ffmpeg'), path.join(binDir, 'avconv'));
	fs.symlinkSync(path.join(binDir, 'ffprobe'), path.join(binDir, 'avprobe'));
}

function currentPrimaryGroup() {
	const gid = os.userInfo().gid;
	const entry = fs.readFileSync('/etc/group', 'utf8').split('\n').find(line => Number(line.split(':')[2]) === gid);
	return entry ? entry.split(':')[0] : String(gid);
}

describe('Installer bootstrap', function() {
	it('exposes bootstrap, verify, and Chinachu PM2 registration in the installer menu', function() {
		const source = fs.readFileSync(launcherPath, 'utf8');
		assert.match(source, /6\) Runtime Bootstrap/);
		assert.match(source, /7\) Verify/);
		assert.match(source, /8\) ChinachuのPM2サービス設定・確認/);
		assert.doesNotMatch(source, /failed somehow/);
	});

	it('delegates installer menu 8 to the same PM2 Service Setup offer', function() {
		const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-installer-pm2-menu-'));
		try {
			const sourceable = writeSourceableLauncher(temporaryDir);
			const result = childProcess.spawnSync('bash', [ '-c', [
				'. "$1"',
				'ensure_dir() { :; }',
				'chinachu_installer_offer_pm2() { printf "DELEGATED:%s\\n" "$1"; }',
				'chinachu_installer 8'
			].join('; '), 'bash', sourceable ], { encoding: 'utf8' });
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			assert.match(result.stdout, /DELEGATED:menu/);
		} finally {
			fs.rmSync(temporaryDir, { recursive: true, force: true });
		}
	});

	it('uses working system FFmpeg commands without entering the package installation path', function() {
		const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-installer-system-ffmpeg-'));
		try {
			const sourceable = writeSourceableLauncher(temporaryDir);
			const systemBin = path.join(temporaryDir, 'system-bin');
			const packageMarker = path.join(temporaryDir, 'package-install-ran');
			writeFakeFfmpegPair(systemBin);

			const result = childProcess.spawnSync('bash', [ '-c', [
				'. "$1"',
				'CHINACHU_DIR="$2"',
				'USR_DIR="$2/usr"',
				'PATH="$USR_DIR/bin:$3"',
				'install_system_ffmpeg_package() { : > "$4"; return 1; }',
				'chinachu_installer_ffmpeg'
			].join('\n'), 'bash', sourceable, temporaryDir, systemBin, packageMarker ], { encoding: 'utf8' });

			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			assert.strictEqual(fs.existsSync(packageMarker), false);
			assert.match(result.stdout, /System ffmpeg: .*system-bin\/ffmpeg/);
			assert.match(result.stdout, /Runtime ffprobe: .*system-bin\/ffprobe/);
		} finally {
			fs.rmSync(temporaryDir, { recursive: true, force: true });
		}
	});

	it('uses the confirmed apt-get FFmpeg package path only when system commands are missing', function() {
		const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-installer-apt-ffmpeg-'));
		try {
			const sourceable = writeSourceableLauncher(temporaryDir);
			const systemBin = path.join(temporaryDir, 'system-bin');
			const aptLog = path.join(temporaryDir, 'apt.log');
			fs.mkdirSync(systemBin, { recursive: true });
			writeExecutable(path.join(systemBin, 'sudo'), '[ "$1" = "--" ] && shift\nexec "$@"');
			writeExecutable(path.join(systemBin, 'apt-get'), [
				'printf \'%s\\n\' "$*" >> "' + aptLog + '"',
				'/bin/cat > "' + path.join(systemBin, 'ffmpeg') + '" <<\'EOF\'',
				'#!/bin/sh',
				'printf \'ffmpeg version installed-test\\n\'',
				'EOF',
				'/bin/cat > "' + path.join(systemBin, 'ffprobe') + '" <<\'EOF\'',
				'#!/bin/sh',
				'printf \'ffprobe version installed-test\\n\'',
				'EOF',
				'/bin/chmod +x "' + path.join(systemBin, 'ffmpeg') + '" "' + path.join(systemBin, 'ffprobe') + '"'
			].join('\n'));

			const nonRootGuidance = childProcess.spawnSync('bash', [ '-c', [
				'. "$1"',
				'id() { [ "$1" = "-u" ] && { printf "1000\\n"; return; }; command id "$@"; }',
				'resolve_apt_commands() { return 1; }',
				'install_system_ffmpeg_package'
			].join('\n'), 'bash', sourceable ], { encoding: 'utf8' });
			assert.strictEqual(nonRootGuidance.status, 1, nonRootGuidance.stdout + nonRootGuidance.stderr);
			assert.match(nonRootGuidance.stderr, /sudo -- apt-get install -- ffmpeg/);

			const rootGuidance = childProcess.spawnSync('bash', [ '-c', [
				'. "$1"',
				'id() { [ "$1" = "-u" ] && { printf "0\\n"; return; }; command id "$@"; }',
				'resolve_apt_commands() { return 1; }',
				'install_system_ffmpeg_package'
			].join('\n'), 'bash', sourceable ], { encoding: 'utf8' });
			assert.strictEqual(rootGuidance.status, 1, rootGuidance.stdout + rootGuidance.stderr);
			assert.match(rootGuidance.stderr, /rerun this stage: apt-get install -- ffmpeg/);
			assert.doesNotMatch(rootGuidance.stderr, /rerun this stage: sudo -- apt-get install -- ffmpeg/);

			const result = childProcess.spawnSync('bash', [ '-c', [
				'. "$1"',
				'CHINACHU_DIR="$2"',
				'USR_DIR="$2/usr"',
				'PATH="$USR_DIR/bin:$3"',
				'TEST_SYSTEM_BIN="$3"',
				'id() { [ "$1" = "-u" ] && { printf "1000\\n"; return; }; command id "$@"; }',
				'confirm_installer_action() { return 0; }',
				'resolve_apt_commands() { APT_GET_COMMAND="$TEST_SYSTEM_BIN/apt-get"; SUDO_COMMAND="$TEST_SYSTEM_BIN/sudo"; return 0; }',
				'chinachu_installer_ffmpeg'
			].join('\n'), 'bash', sourceable, temporaryDir, systemBin ], { encoding: 'utf8' });

			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			assert.strictEqual(fs.readFileSync(aptLog, 'utf8').trim(), 'install -- ffmpeg');
			assert.doesNotMatch(fs.readFileSync(aptLog, 'utf8'), /update|upgrade|autoremove/);
		} finally {
			fs.rmSync(temporaryDir, { recursive: true, force: true });
		}
	});

	it('stops without package or file changes for an unknown repository-local override', function() {
		const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-installer-unknown-ffmpeg-'));
		try {
			const sourceable = writeSourceableLauncher(temporaryDir);
			const usrBin = path.join(temporaryDir, 'usr', 'bin');
			const packageMarker = path.join(temporaryDir, 'package-install-ran');
			fs.mkdirSync(usrBin, { recursive: true });
			writeExecutable(path.join(usrBin, 'ffmpeg'), 'printf \'ffmpeg version user-managed\\n\'');

			const result = childProcess.spawnSync('bash', [ '-c', [
				'. "$1"',
				'CHINACHU_DIR="$2"',
				'USR_DIR="$2/usr"',
				'PATH="$USR_DIR/bin"',
				'install_system_ffmpeg_package() { : > "$3"; return 1; }',
				'chinachu_installer_ffmpeg'
			].join('\n'), 'bash', sourceable, temporaryDir, packageMarker ], { encoding: 'utf8' });

			assert.strictEqual(result.status, 1, result.stdout + result.stderr);
			assert.strictEqual(fs.existsSync(path.join(usrBin, 'ffmpeg')), true);
			assert.strictEqual(fs.existsSync(packageMarker), false);
			assert.match(result.stderr, /Unknown repository-local FFmpeg override/);
		} finally {
			fs.rmSync(temporaryDir, { recursive: true, force: true });
		}
	});

	it('removes recognized legacy FFmpeg only after system verification and explicit confirmation', function() {
		const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-installer-legacy-ffmpeg-'));
		try {
			const sourceable = writeSourceableLauncher(temporaryDir);
			const systemBin = path.join(temporaryDir, 'system-bin');
			const ffmpegLog = path.join(temporaryDir, 'ffmpeg.log');
			writeFakeFfmpegPair(systemBin, ffmpegLog);
			writeLegacyFfmpegFixture(path.join(temporaryDir, 'usr'));
			fs.writeFileSync(path.join(temporaryDir, 'usr', 'bin', 'legacy-readme'), 'leave untouched');

			const declined = childProcess.spawnSync('bash', [ '-c', [
				'. "$1"',
				'CHINACHU_DIR="$2"',
				'USR_DIR="$2/usr"',
				'PATH="$USR_DIR/bin:$3:/usr/bin:/bin"',
				'confirm_installer_action() { return 1; }',
				'chinachu_installer_ffmpeg'
			].join('\n'), 'bash', sourceable, temporaryDir, systemBin ], { encoding: 'utf8' });
			assert.strictEqual(declined.status, 1, declined.stdout + declined.stderr);
			for (const name of [ 'ffmpeg', 'ffprobe', 'avconv', 'avprobe' ]) {
				assert.strictEqual(fs.existsSync(path.join(temporaryDir, 'usr', 'bin', name)), true);
			}
			assert.deepStrictEqual(
				fs.readFileSync(ffmpegLog, 'utf8').trim().split('\n'),
				[ 'ffmpeg -version', 'ffprobe -version' ]
			);

			const approved = childProcess.spawnSync('bash', [ '-c', [
				'. "$1"',
				'CHINACHU_DIR="$2"',
				'USR_DIR="$2/usr"',
				'PATH="$USR_DIR/bin:$3:/usr/bin:/bin"',
				'confirm_installer_action() { return 0; }',
				'chinachu_installer_ffmpeg'
			].join('\n'), 'bash', sourceable, temporaryDir, systemBin ], { encoding: 'utf8' });

			assert.strictEqual(approved.status, 0, approved.stdout + approved.stderr);
			for (const name of [ 'ffmpeg', 'ffprobe', 'avconv', 'avprobe' ]) {
				assert.strictEqual(fs.existsSync(path.join(temporaryDir, 'usr', 'bin', name)), false);
			}
			assert.strictEqual(
				fs.readFileSync(path.join(temporaryDir, 'usr', 'bin', 'legacy-readme'), 'utf8'),
				'leave untouched'
			);
			assert.strictEqual(
				fs.readFileSync(ffmpegLog, 'utf8').trim().split('\n').slice(-4).join('\n'),
				[ 'ffmpeg -version', 'ffprobe -version', 'ffmpeg -version', 'ffprobe -version' ].join('\n')
			);
		} finally {
			fs.rmSync(temporaryDir, { recursive: true, force: true });
		}
	});

	it('removes the bundled archive download and libav alias creation paths', function() {
		const source = fs.readFileSync(launcherPath, 'utf8');

		assert.doesNotMatch(source, /johnvansickle\.com\/ffmpeg\/old-releases/);
		assert.doesNotMatch(source, /FFMPEG_FN|FFMPEG_XZ/);
		assert.doesNotMatch(source, /ln -sv .*avconv|ln -sv .*avprobe/);
	});

	it('creates a complete missing-only runtime baseline through the legacy service path', function() {
		const temporaryDir = createLauncherFixture();

		try {
			const result = runServiceBootstrap(temporaryDir);
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);

			const config = JSON.parse(fs.readFileSync(path.join(temporaryDir, 'config.json'), 'utf8'));
			assert.strictEqual(config.uid, os.userInfo().username);
			assert.strictEqual(config.gid, currentPrimaryGroup());
			assert.deepStrictEqual(
				JSON.parse(fs.readFileSync(path.join(temporaryDir, 'rules.json'), 'utf8')),
				JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'rules.sample.json'), 'utf8'))
			);

			for (const name of [ 'reserves', 'reserves2', 'recording', 'recorded', 'schedule', 'match' ]) {
				assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(temporaryDir, 'data', name + '.json'), 'utf8')), []);
			}

			assert.strictEqual(fs.statSync(path.join(temporaryDir, 'data')).isDirectory(), true);
			assert.strictEqual(fs.statSync(path.join(temporaryDir, 'log')).isDirectory(), true);
			assert.strictEqual(fs.statSync(path.join(temporaryDir, 'recorded')).isDirectory(), true);
			assert.strictEqual(fs.readFileSync(path.join(temporaryDir, 'service-ran'), 'utf8'), 'yes');
		} finally {
			fs.rmSync(temporaryDir, { recursive: true, force: true });
		}
	});

	it('does not replace existing config, rules, runtime JSON, recordings, or logs', function() {
		const temporaryDir = createLauncherFixture();
		const existing = new Map();

		try {
			fs.mkdirSync(path.join(temporaryDir, 'data'));
			fs.mkdirSync(path.join(temporaryDir, 'log'));
			fs.mkdirSync(path.join(temporaryDir, 'recorded'));
			fs.writeFileSync(path.join(temporaryDir, 'config.json'), JSON.stringify({
				uid: 'keep-this-value',
				gid: 'keep-this-group',
				recordedDir: './recorded/'
			}));
			fs.writeFileSync(path.join(temporaryDir, 'rules.json'), 'existing rules content');
			for (const name of [ 'reserves', 'reserves2', 'recording', 'recorded', 'schedule', 'match' ]) {
				fs.writeFileSync(path.join(temporaryDir, 'data', name + '.json'), 'existing ' + name + ' content');
			}
			fs.writeFileSync(path.join(temporaryDir, 'recorded', 'keep.m2ts'), 'recording bytes');
			fs.writeFileSync(path.join(temporaryDir, 'log', 'operator'), 'existing log');

			for (const file of [
				'config.json', 'rules.json', 'data/reserves.json', 'data/reserves2.json',
				'data/recording.json', 'data/recorded.json', 'data/schedule.json', 'data/match.json',
				'recorded/keep.m2ts', 'log/operator'
			]) {
				existing.set(file, fs.readFileSync(path.join(temporaryDir, file)));
			}

			const result = runServiceBootstrap(temporaryDir);
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			for (const [ file, content ] of existing) {
				assert.deepStrictEqual(fs.readFileSync(path.join(temporaryDir, file)), content, file);
			}
		} finally {
			fs.rmSync(temporaryDir, { recursive: true, force: true });
		}
	});

	it('fails before creating runtime data when an existing config is invalid', function() {
		const temporaryDir = createLauncherFixture();

		try {
			fs.writeFileSync(path.join(temporaryDir, 'config.json'), 'invalid existing config');
			const result = runServiceBootstrap(temporaryDir);

			assert.strictEqual(result.status, 1);
			assert.match(result.stderr, /config\.json must contain an object with a non-empty recordedDir/);
			assert.strictEqual(fs.readFileSync(path.join(temporaryDir, 'config.json'), 'utf8'), 'invalid existing config');
			assert.strictEqual(fs.existsSync(path.join(temporaryDir, 'data')), false);
			assert.strictEqual(fs.existsSync(path.join(temporaryDir, 'log')), false);
			assert.strictEqual(fs.existsSync(path.join(temporaryDir, 'service-ran')), false);
		} finally {
			fs.rmSync(temporaryDir, { recursive: true, force: true });
		}
	});

	it('stops Auto(full) before later stages after the first failed stage', function() {
		const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-installer-fail-fast-'));

		try {
			const sourceable = writeSourceableLauncher(temporaryDir);
			const result = childProcess.spawnSync('bash', [ '-c', [
				'. "$1"',
				'chinachu_installer_submodule() { printf "submodule\\n"; return 23; }',
				'chinachu_installer_node() { printf "NODE_STAGE_RAN\\n"; return 0; }',
				'chinachu_installer_node_modules() { printf "MODULE_STAGE_RAN\\n"; return 0; }',
				'chinachu_installer_ffmpeg() { printf "FFMPEG_STAGE_RAN\\n"; return 0; }',
				'chinachu_runtime_bootstrap() { printf "BOOTSTRAP_STAGE_RAN\\n"; return 0; }',
				'chinachu_installer_verify() { printf "VERIFY_STAGE_RAN\\n"; return 0; }',
				'chinachu_installer_auto_full'
			].join('; '), 'bash', sourceable ], { encoding: 'utf8' });

			assert.strictEqual(result.status, 1);
			assert.match(result.stdout, /submodule/);
			assert.doesNotMatch(result.stdout, /NODE_STAGE_RAN|MODULE_STAGE_RAN|FFMPEG_STAGE_RAN|BOOTSTRAP_STAGE_RAN|VERIFY_STAGE_RAN/);
		} finally {
			fs.rmSync(temporaryDir, { recursive: true, force: true });
		}
	});

	it('keeps Auto(full) successful when optional PM2 registration is skipped', function() {
		const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-installer-success-'));

		try {
			const sourceable = writeSourceableLauncher(temporaryDir);
			const result = childProcess.spawnSync('bash', [ '-c', [
				'. "$1"',
				'chinachu_installer_submodule() { return 0; }',
				'chinachu_installer_node() { return 0; }',
				'chinachu_installer_node_modules() { return 0; }',
				'chinachu_installer_ffmpeg() { return 0; }',
				'chinachu_runtime_bootstrap() { return 0; }',
				'chinachu_installer_verify() { return 0; }',
				'chinachu_installer_offer_pm2() { echo PM2_SKIPPED; return 0; }',
				'chinachu_installer_auto_full'
			].join('; '), 'bash', sourceable ], { encoding: 'utf8' });

			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			assert.match(result.stdout, /PM2_SKIPPED/);
			assert.match(result.stdout, /Installation completed successfully/);
		} finally {
			fs.rmSync(temporaryDir, { recursive: true, force: true });
		}
	});

	it('prints a consistent separator around every Auto(full) stage', function() {
		const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-installer-stages-'));
		try {
			const sourceable = writeSourceableLauncher(temporaryDir);
			const result = childProcess.spawnSync('bash', [ '-c', [
				'. "$1"',
				'for fn in chinachu_installer_submodule chinachu_installer_node chinachu_installer_node_modules chinachu_installer_ffmpeg chinachu_runtime_bootstrap chinachu_installer_verify; do eval "$fn() { return 0; }"; done',
				'chinachu_installer_offer_pm2() { return 0; }',
				'chinachu_installer_auto_full'
			].join('; '), 'bash', sourceable ], { encoding: 'utf8' });
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			for (let index = 1; index <= 6; index++) {
				assert.match(result.stdout, new RegExp('─+\\n\\[' + index + '/6\\] .+\\n─+'));
			}
		} finally {
			fs.rmSync(temporaryDir, { recursive: true, force: true });
		}
	});

	it('passes the complete read-only verify with the expected Nave tools and dependency tree', function() {
		const temporaryDir = createLauncherFixture();

		try {
			const sourceable = writeSourceableLauncher(temporaryDir);
			const npmPath = writeSuccessfulNpm(temporaryDir);
			const systemBin = path.join(temporaryDir, 'system-bin');
			const ffmpegLog = path.join(temporaryDir, 'ffmpeg.log');
			writeFakeFfmpegPair(systemBin, ffmpegLog);

			const result = childProcess.spawnSync('bash', [ '-c', [
				'cd "$1"',
				'. "$2"',
				'CHINACHU_DIR=$PWD',
				'USR_DIR="$PWD/usr"',
				'NODE_PATH="$3"',
				'NPM_PATH="$4"',
				'PATH="$5:$PATH"',
				'NODE_VER=$("$NODE_PATH" --version)',
				'NODE_VER=${NODE_VER#v}',
				'chinachu_runtime_bootstrap',
				'chinachu_installer_verify'
			].join('; '), 'bash', temporaryDir, sourceable, process.execPath, npmPath, systemBin ], {
				encoding: 'utf8'
			});

			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			assert.deepStrictEqual(
				fs.readFileSync(ffmpegLog, 'utf8').trim().split('\n'),
				[ 'ffmpeg -version', 'ffprobe -version' ]
			);
		} finally {
			fs.rmSync(temporaryDir, { recursive: true, force: true });
		}
	});

	it('rejects invalid existing runtime JSON without replacing it', function() {
		const temporaryDir = createLauncherFixture();

		try {
			const sourceable = writeSourceableLauncher(temporaryDir);
			const npmPath = writeSuccessfulNpm(temporaryDir);
			const systemBin = path.join(temporaryDir, 'system-bin');
			writeFakeFfmpegPair(systemBin);
			fs.mkdirSync(path.join(temporaryDir, 'data'));
			fs.writeFileSync(path.join(temporaryDir, 'data', 'recorded.json'), 'do not replace invalid data');

			const result = childProcess.spawnSync('bash', [ '-c', [
				'cd "$1"',
				'. "$2"',
				'CHINACHU_DIR=$PWD',
				'USR_DIR="$PWD/usr"',
				'NODE_PATH="$3"',
				'NPM_PATH="$4"',
				'PATH="$5:$PATH"',
				'NODE_VER=$("$NODE_PATH" --version)',
				'NODE_VER=${NODE_VER#v}',
				'chinachu_runtime_bootstrap',
				'chinachu_installer_verify'
			].join('; '), 'bash', temporaryDir, sourceable, process.execPath, npmPath, systemBin ], {
				encoding: 'utf8'
			});

			assert.strictEqual(result.status, 1);
			assert.match(result.stderr, /Configuration or runtime JSON validation failed/);
			assert.strictEqual(fs.readFileSync(path.join(temporaryDir, 'data', 'recorded.json'), 'utf8'), 'do not replace invalid data');
		} finally {
			fs.rmSync(temporaryDir, { recursive: true, force: true });
		}
	});
});
