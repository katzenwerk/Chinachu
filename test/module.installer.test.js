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
	it('uses working system FFmpeg and falls back to apt only when commands are missing', function() {
		const systemFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-installer-system-ffmpeg-'));
		const aptFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-installer-apt-ffmpeg-'));

		try {
			const systemSourceable = writeSourceableLauncher(systemFixture);
			const systemBin = path.join(systemFixture, 'system-bin');
			const packageMarker = path.join(systemFixture, 'package-install-ran');
			writeFakeFfmpegPair(systemBin);

			const systemResult = childProcess.spawnSync('bash', [ '-c', [
				'. "$1"',
				'CHINACHU_DIR="$2"',
				'USR_DIR="$2/usr"',
				'PATH="$USR_DIR/bin:$3"',
				'install_system_ffmpeg_package() { : > "$4"; return 1; }',
				'chinachu_installer_ffmpeg'
			].join('\n'), 'bash', systemSourceable, systemFixture, systemBin, packageMarker ], { encoding: 'utf8' });

			assert.strictEqual(systemResult.status, 0, systemResult.stdout + systemResult.stderr);
			assert.strictEqual(fs.existsSync(packageMarker), false);
			assert.match(systemResult.stdout, /System ffmpeg:/);
			assert.match(systemResult.stdout, /Runtime ffprobe:/);

			const aptSourceable = writeSourceableLauncher(aptFixture);
			const aptBin = path.join(aptFixture, 'system-bin');
			const aptLog = path.join(aptFixture, 'apt.log');
			fs.mkdirSync(aptBin, { recursive: true });
			writeExecutable(path.join(aptBin, 'sudo'), '[ "$1" = "--" ] && shift\nexec "$@"');
			writeExecutable(path.join(aptBin, 'apt-get'), [
				'printf \'%s\\n\' "$*" >> "' + aptLog + '"',
				'/bin/cat > "' + path.join(aptBin, 'ffmpeg') + '" <<\'EOF\'',
				'#!/bin/sh',
				'printf \'ffmpeg version installed-test\\n\'',
				'EOF',
				'/bin/cat > "' + path.join(aptBin, 'ffprobe') + '" <<\'EOF\'',
				'#!/bin/sh',
				'printf \'ffprobe version installed-test\\n\'',
				'EOF',
				'/bin/chmod +x "' + path.join(aptBin, 'ffmpeg') + '" "' + path.join(aptBin, 'ffprobe') + '"'
			].join('\n'));

			const aptResult = childProcess.spawnSync('bash', [ '-c', [
				'. "$1"',
				'CHINACHU_DIR="$2"',
				'USR_DIR="$2/usr"',
				'PATH="$USR_DIR/bin:$3"',
				'TEST_SYSTEM_BIN="$3"',
				'id() { [ "$1" = "-u" ] && { printf "1000\\n"; return; }; command id "$@"; }',
				'confirm_installer_action() { return 0; }',
				'resolve_apt_commands() { APT_GET_COMMAND="$TEST_SYSTEM_BIN/apt-get"; SUDO_COMMAND="$TEST_SYSTEM_BIN/sudo"; return 0; }',
				'chinachu_installer_ffmpeg'
			].join('\n'), 'bash', aptSourceable, aptFixture, aptBin ], { encoding: 'utf8' });

			assert.strictEqual(aptResult.status, 0, aptResult.stdout + aptResult.stderr);
			assert.strictEqual(fs.readFileSync(aptLog, 'utf8').trim(), 'install -- ffmpeg');
			assert.doesNotMatch(fs.readFileSync(aptLog, 'utf8'), /update|upgrade|autoremove/);
		} finally {
			fs.rmSync(systemFixture, { recursive: true, force: true });
			fs.rmSync(aptFixture, { recursive: true, force: true });
		}
	});

	it('protects unknown local FFmpeg and removes only recognized legacy files after confirmation', function() {
		const unknownFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-installer-unknown-ffmpeg-'));
		const legacyFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-installer-legacy-ffmpeg-'));

		try {
			const unknownSourceable = writeSourceableLauncher(unknownFixture);
			const unknownUsrBin = path.join(unknownFixture, 'usr', 'bin');
			const packageMarker = path.join(unknownFixture, 'package-install-ran');
			fs.mkdirSync(unknownUsrBin, { recursive: true });
			writeExecutable(path.join(unknownUsrBin, 'ffmpeg'), 'printf \'ffmpeg version user-managed\\n\'');

			const unknownResult = childProcess.spawnSync('bash', [ '-c', [
				'. "$1"',
				'CHINACHU_DIR="$2"',
				'USR_DIR="$2/usr"',
				'PATH="$USR_DIR/bin"',
				'install_system_ffmpeg_package() { : > "$3"; return 1; }',
				'chinachu_installer_ffmpeg'
			].join('\n'), 'bash', unknownSourceable, unknownFixture, packageMarker ], { encoding: 'utf8' });

			assert.strictEqual(unknownResult.status, 1, unknownResult.stdout + unknownResult.stderr);
			assert.strictEqual(fs.existsSync(path.join(unknownUsrBin, 'ffmpeg')), true);
			assert.strictEqual(fs.existsSync(packageMarker), false);

			const legacySourceable = writeSourceableLauncher(legacyFixture);
			const systemBin = path.join(legacyFixture, 'system-bin');
			writeFakeFfmpegPair(systemBin);
			writeLegacyFfmpegFixture(path.join(legacyFixture, 'usr'));
			fs.writeFileSync(path.join(legacyFixture, 'usr', 'bin', 'legacy-readme'), 'leave untouched');

			const declined = childProcess.spawnSync('bash', [ '-c', [
				'. "$1"',
				'CHINACHU_DIR="$2"',
				'USR_DIR="$2/usr"',
				'PATH="$USR_DIR/bin:$3:/usr/bin:/bin"',
				'confirm_installer_action() { return 1; }',
				'chinachu_installer_ffmpeg'
			].join('\n'), 'bash', legacySourceable, legacyFixture, systemBin ], { encoding: 'utf8' });

			assert.strictEqual(declined.status, 1, declined.stdout + declined.stderr);
			for (const name of [ 'ffmpeg', 'ffprobe', 'avconv', 'avprobe' ]) {
				assert.strictEqual(fs.existsSync(path.join(legacyFixture, 'usr', 'bin', name)), true);
			}

			const approved = childProcess.spawnSync('bash', [ '-c', [
				'. "$1"',
				'CHINACHU_DIR="$2"',
				'USR_DIR="$2/usr"',
				'PATH="$USR_DIR/bin:$3:/usr/bin:/bin"',
				'confirm_installer_action() { return 0; }',
				'chinachu_installer_ffmpeg'
			].join('\n'), 'bash', legacySourceable, legacyFixture, systemBin ], { encoding: 'utf8' });

			assert.strictEqual(approved.status, 0, approved.stdout + approved.stderr);
			for (const name of [ 'ffmpeg', 'ffprobe', 'avconv', 'avprobe' ]) {
				assert.strictEqual(fs.existsSync(path.join(legacyFixture, 'usr', 'bin', name)), false);
			}
			assert.strictEqual(
				fs.readFileSync(path.join(legacyFixture, 'usr', 'bin', 'legacy-readme'), 'utf8'),
				'leave untouched'
			);
		} finally {
			fs.rmSync(unknownFixture, { recursive: true, force: true });
			fs.rmSync(legacyFixture, { recursive: true, force: true });
		}
	});

	it('creates a missing runtime baseline without replacing existing data', function() {
		const newFixture = createLauncherFixture();
		const existingFixture = createLauncherFixture();

		try {
			const newResult = runServiceBootstrap(newFixture);
			assert.strictEqual(newResult.status, 0, newResult.stdout + newResult.stderr);

			const config = JSON.parse(fs.readFileSync(path.join(newFixture, 'config.json'), 'utf8'));
			assert.strictEqual(config.uid, os.userInfo().username);
			assert.strictEqual(config.gid, currentPrimaryGroup());
			for (const name of [ 'reserves', 'reserves2', 'recording', 'recorded', 'schedule', 'match' ]) {
				assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(newFixture, 'data', name + '.json'), 'utf8')), []);
			}

			fs.mkdirSync(path.join(existingFixture, 'data'));
			fs.mkdirSync(path.join(existingFixture, 'log'));
			fs.mkdirSync(path.join(existingFixture, 'recorded'));
			fs.writeFileSync(path.join(existingFixture, 'config.json'), JSON.stringify({
				uid: 'keep-this-value',
				gid: 'keep-this-group',
				recordedDir: './recorded/'
			}));
			fs.writeFileSync(path.join(existingFixture, 'rules.json'), 'existing rules content');
			for (const name of [ 'reserves', 'reserves2', 'recording', 'recorded', 'schedule', 'match' ]) {
				fs.writeFileSync(path.join(existingFixture, 'data', name + '.json'), 'existing ' + name + ' content');
			}
			fs.writeFileSync(path.join(existingFixture, 'recorded', 'keep.m2ts'), 'recording bytes');
			fs.writeFileSync(path.join(existingFixture, 'log', 'operator'), 'existing log');

			const before = new Map();
			for (const file of [
				'config.json', 'rules.json', 'data/reserves.json', 'data/reserves2.json',
				'data/recording.json', 'data/recorded.json', 'data/schedule.json', 'data/match.json',
				'recorded/keep.m2ts', 'log/operator'
			]) {
				before.set(file, fs.readFileSync(path.join(existingFixture, file)));
			}

			const existingResult = runServiceBootstrap(existingFixture);
			assert.strictEqual(existingResult.status, 0, existingResult.stdout + existingResult.stderr);
			for (const [ file, content ] of before) {
				assert.deepStrictEqual(fs.readFileSync(path.join(existingFixture, file)), content, file);
			}
		} finally {
			fs.rmSync(newFixture, { recursive: true, force: true });
			fs.rmSync(existingFixture, { recursive: true, force: true });
		}
	});

	it('rejects invalid existing config or runtime JSON without replacing it', function() {
		const configFixture = createLauncherFixture();
		const runtimeFixture = createLauncherFixture();

		try {
			fs.writeFileSync(path.join(configFixture, 'config.json'), 'invalid existing config');
			const configResult = runServiceBootstrap(configFixture);

			assert.strictEqual(configResult.status, 1);
			assert.strictEqual(fs.readFileSync(path.join(configFixture, 'config.json'), 'utf8'), 'invalid existing config');
			assert.strictEqual(fs.existsSync(path.join(configFixture, 'data')), false);

			const sourceable = writeSourceableLauncher(runtimeFixture);
			const npmPath = writeSuccessfulNpm(runtimeFixture);
			const systemBin = path.join(runtimeFixture, 'system-bin');
			writeFakeFfmpegPair(systemBin);
			fs.mkdirSync(path.join(runtimeFixture, 'data'));
			fs.writeFileSync(path.join(runtimeFixture, 'data', 'recorded.json'), 'do not replace invalid data');

			const runtimeResult = childProcess.spawnSync('bash', [ '-c', [
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
			].join('; '), 'bash', runtimeFixture, sourceable, process.execPath, npmPath, systemBin ], {
				encoding: 'utf8'
			});

			assert.strictEqual(runtimeResult.status, 1);
			assert.strictEqual(
				fs.readFileSync(path.join(runtimeFixture, 'data', 'recorded.json'), 'utf8'),
				'do not replace invalid data'
			);
		} finally {
			fs.rmSync(configFixture, { recursive: true, force: true });
			fs.rmSync(runtimeFixture, { recursive: true, force: true });
		}
	});

	it('stops Auto(full) on the first failed stage and otherwise succeeds when optional PM2 setup is skipped', function() {
		const failFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-installer-fail-fast-'));
		const successFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-installer-success-'));

		try {
			const failSourceable = writeSourceableLauncher(failFixture);
			const failResult = childProcess.spawnSync('bash', [ '-c', [
				'. "$1"',
				'chinachu_installer_submodule() { printf "submodule\\n"; return 23; }',
				'chinachu_installer_node() { printf "NODE_STAGE_RAN\\n"; return 0; }',
				'chinachu_installer_node_modules() { printf "MODULE_STAGE_RAN\\n"; return 0; }',
				'chinachu_installer_ffmpeg() { printf "FFMPEG_STAGE_RAN\\n"; return 0; }',
				'chinachu_runtime_bootstrap() { printf "BOOTSTRAP_STAGE_RAN\\n"; return 0; }',
				'chinachu_installer_verify() { printf "VERIFY_STAGE_RAN\\n"; return 0; }',
				'chinachu_installer_auto_full'
			].join('; '), 'bash', failSourceable ], { encoding: 'utf8' });

			assert.strictEqual(failResult.status, 1);
			assert.doesNotMatch(
				failResult.stdout,
				/NODE_STAGE_RAN|MODULE_STAGE_RAN|FFMPEG_STAGE_RAN|BOOTSTRAP_STAGE_RAN|VERIFY_STAGE_RAN/
			);

			const successSourceable = writeSourceableLauncher(successFixture);
			const successResult = childProcess.spawnSync('bash', [ '-c', [
				'. "$1"',
				'chinachu_installer_submodule() { return 0; }',
				'chinachu_installer_node() { return 0; }',
				'chinachu_installer_node_modules() { return 0; }',
				'chinachu_installer_ffmpeg() { return 0; }',
				'chinachu_runtime_bootstrap() { return 0; }',
				'chinachu_installer_verify() { return 0; }',
				'chinachu_installer_offer_pm2() { echo PM2_SKIPPED; return 0; }',
				'chinachu_installer_auto_full'
			].join('; '), 'bash', successSourceable ], { encoding: 'utf8' });

			assert.strictEqual(successResult.status, 0, successResult.stdout + successResult.stderr);
			assert.match(successResult.stdout, /PM2_SKIPPED/);
			assert.match(successResult.stdout, /Installation completed successfully/);
		} finally {
			fs.rmSync(failFixture, { recursive: true, force: true });
			fs.rmSync(successFixture, { recursive: true, force: true });
		}
	});

	it('passes the complete read-only verify with the expected runtime tools and dependency tree', function() {
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
});
