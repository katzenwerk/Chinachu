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
	fs.mkdirSync(path.join(temporaryDir, 'lib'));
	for (const name of ['installer-nave.sh', 'installer-profile.py']) {
		fs.copyFileSync(path.join(repositoryRoot, 'lib', name), path.join(temporaryDir, 'lib', name));
	}
	fs.copyFileSync(path.join(repositoryRoot, 'config.sample.json'), path.join(temporaryDir, 'config.sample.json'));
	fs.copyFileSync(path.join(repositoryRoot, 'rules.sample.json'), path.join(temporaryDir, 'rules.sample.json'));

	return temporaryDir;
}

function runServiceBootstrap(temporaryDir) {
	const sourceable = writeSourceableLauncher(temporaryDir);
	return childProcess.spawnSync('bash', [ '-c', [
		'cd "$1"',
		'. "$2"',
		'CHINACHU_DIR=$PWD',
		'USR_DIR="$PWD/usr"',
		'NODE_PATH="$3"',
		'NODE_VER=$("$NODE_PATH" --version)',
		'NODE_VER=${NODE_VER#v}',
		'chinachu_runtime_bootstrap'
	].join('; '), 'bash', temporaryDir, sourceable, process.execPath ], { encoding: 'utf8' });
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
	it('checks FFmpeg first, keeps the compact menu/name dispatch, and protects local FFmpeg files', function() {
		const unknownFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-installer-unknown-ffmpeg-'));
		const legacyFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-installer-legacy-ffmpeg-'));
		const orderFixture = createLauncherFixture();

		try {
			const menu = childProcess.spawnSync('bash', [ './chinachu', 'installer' ], {
				cwd: orderFixture,
				encoding: 'utf8'
			});
			assert.strictEqual(menu.status, 1);
			assert.match(menu.stdout, /1\) Auto \(Full\)\n2\) Node\.js\n3\) Dependencies\n4\) Runtime Bootstrap\n5\) Verify\n6\) PM2 Service Setup\n0\) Exit/);
			assert.doesNotMatch(menu.stdout, /\d+\) FFmpeg/);

			const orderSourceable = writeSourceableLauncher(orderFixture);
			const failedOrderLog = path.join(orderFixture, 'failed-order.log');
			const successfulOrderLog = path.join(orderFixture, 'successful-order.log');
			const runOrder = (logPath, ffmpegStatus) => childProcess.spawnSync('bash', [ '-c', [
				'. "$1"',
				'ORDER_LOG="$2"',
				'FFMPEG_STATUS="$3"',
				'chinachu_installer_ffmpeg() { echo ffmpeg >> "$ORDER_LOG"; return "$FFMPEG_STATUS"; }',
				'chinachu_installer_node_ready() { echo node-check >> "$ORDER_LOG"; return 0; }',
				'chinachu_installer_node() { echo node-install >> "$ORDER_LOG"; return 0; }',
				'chinachu_installer_dependencies_ready() { echo dependencies-check >> "$ORDER_LOG"; return 0; }',
				'chinachu_installer_node_modules() { echo dependencies-install >> "$ORDER_LOG"; return 0; }',
				'chinachu_runtime_bootstrap() { echo bootstrap >> "$ORDER_LOG"; return 0; }',
				'chinachu_installer_verify() { echo verify >> "$ORDER_LOG"; return 0; }',
				'chinachu_installer_offer_pm2() { echo pm2-offer >> "$ORDER_LOG"; return 0; }',
				'chinachu_installer_auto_full'
			].join('\n'), 'bash', orderSourceable, logPath, String(ffmpegStatus) ], { encoding: 'utf8' });

			const stopped = runOrder(failedOrderLog, 1);
			assert.strictEqual(stopped.status, 1);
			assert.strictEqual(fs.readFileSync(failedOrderLog, 'utf8'), 'ffmpeg\n');

			const ordered = runOrder(successfulOrderLog, 0);
			assert.strictEqual(ordered.status, 0, ordered.stdout + ordered.stderr);
			assert.deepStrictEqual(fs.readFileSync(successfulOrderLog, 'utf8').trim().split('\n'), [
				'ffmpeg', 'node-check', 'dependencies-check', 'node-check', 'bootstrap', 'verify', 'pm2-offer'
			]);

			const ffmpegDispatchMarker = path.join(orderFixture, 'ffmpeg-dispatch');
			const dispatched = childProcess.spawnSync('bash', [ '-c', [
				'. "$1"',
				'CHINACHU_DIR="$2"',
				'USR_DIR="$2/usr"',
				'FFMPEG_DISPATCH_MARKER="$3"',
				'chinachu_installer_ffmpeg() { : > "$FFMPEG_DISPATCH_MARKER"; }',
				'chinachu_installer ffmpeg'
			].join('\n'), 'bash', orderSourceable, orderFixture, ffmpegDispatchMarker ], { encoding: 'utf8' });
			assert.strictEqual(dispatched.status, 0, dispatched.stdout + dispatched.stderr);
			assert.strictEqual(fs.existsSync(ffmpegDispatchMarker), true);

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
			fs.rmSync(orderFixture, { recursive: true, force: true });
		}
	});

	it('prepares and activates Node 26 without switching active links prematurely', function() {
		const root = createLauncherFixture();
		try {
			const source = writeSourceableLauncher(root);
			const result = childProcess.spawnSync('bash', ['-c', `
set -e
. "$1"
CHINACHU_DIR="$2"; NAVE_DIR="$2/.nave"; export NAVE_DIR
NODE_PATH="$NAVE_DIR/installed/$NODE_VER/bin/node"
NPM_PATH="$NAVE_DIR/installed/$NODE_VER/bin/npm"
mkdir -p "$NAVE_DIR/installed/24.20.0/bin"
ln -s installed/24.20.0/bin/node "$NAVE_DIR/node"
ln -s installed/24.20.0/bin/npm "$NAVE_DIR/npm"
cat > "$NAVE_DIR/nave.sh" <<'NAVE'
NAVE_ROOT="$NAVE_DIR/installed"
NAVE_SRC="$NAVE_DIR/src"
osarch() { echo linux-x64; }
get() {
 [ "$NAVE_JOBS:$JOBS:$MAKEFLAGS" = 1:1:-j1 ] || return 74
 [ "$(ps -o ni= -p $$ | tr -d ' ')" -ge 10 ] || return 75
 version=$(printf '%s' "$1" | cut -d/ -f1 | cut -c2-)
 mkdir -p "$NAVE_DIR/payload/bin"
 printf '#!/bin/sh\\necho v%s\\n' "$version" > "$NAVE_DIR/payload/bin/node"
 printf '#!/bin/sh\\necho 11.20.0\\n' > "$NAVE_DIR/payload/bin/npm"
 chmod +x "$NAVE_DIR/payload/bin/"*
 tar czf "$NAVE_DIR/binary.tgz" -C "$NAVE_DIR" payload
 printf '%s\\n' "$NAVE_DIR/binary.tgz"
}

NAVE
chmod +x "$NAVE_DIR/nave.sh"
chinachu_installer_node_prepare
[ "$(readlink "$NAVE_DIR/node")" = installed/24.20.0/bin/node ]
[ -x "$NODE_PATH" ]
chinachu_application_processes_running() { return 1; }
chinachu_installer_node
chinachu_installer_node_ready
[ "$(readlink -f "$NAVE_DIR/node")" = "$NODE_PATH" ]
[ "$(readlink -f "$NAVE_DIR/npm")" = "$NPM_PATH" ]
# A bad target or failed download must not replace the selected runtime.
selected_node=$(readlink "$NAVE_DIR/node")
mkdir -p "$NAVE_DIR/installed/26.12.0"
if chinachu_installer_node_prepare 26.12.0; then exit 72; fi
printf 'NAVE_ROOT="$NAVE_DIR/installed"\\nNAVE_SRC="$NAVE_DIR/src"\\nosarch() { echo linux-x64; }\\nget() { return 1; }\\n' > "$NAVE_DIR/nave.sh"
if chinachu_installer_node_prepare 26.12.1; then exit 73; fi
[ "$(readlink "$NAVE_DIR/node")" = "$selected_node" ]
# An invisible positive PM2 PID is unknown, never a proof of stopped state.
unset -f chinachu_application_processes_running
mkdir -p "$CHINACHU_DIR/home/.pm2/pids"
printf '999999999\\n' > "$CHINACHU_DIR/home/.pm2/pids/chinachu-operator-2.pid"
getent() { printf 'fixture:x:1000:1000::%s/home:/bin/bash\\n' "$CHINACHU_DIR"; }
if chinachu_installer_require_stopped; then exit 74; fi
[ "$(readlink "$NAVE_DIR/node")" = "$selected_node" ]
`, 'bash', source, root], {encoding: 'utf8'});
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
		} finally { fs.rmSync(root, {recursive: true, force: true}); }
	});

	it('keeps existing dependencies on ci failure and publishes only ABI-verified replacements', function() {
		const root = createLauncherFixture();
		try {
			const source = writeSourceableLauncher(root);
			fs.mkdirSync(path.join(root, 'common'));
			fs.writeFileSync(path.join(root, 'common/package.json'), '{}');
			fs.mkdirSync(path.join(root, 'node_modules'));
			fs.writeFileSync(path.join(root, 'node_modules', 'keep'), 'previous dependencies');
			fs.writeFileSync(path.join(root, 'package.json'), '{}');
			fs.writeFileSync(path.join(root, 'package-lock.json'), '{"packages":{"":{}}}');
			const npm = path.join(root, 'npm');
			writeExecutable(npm, 'case "$1" in --version) echo 11.20.0;; ci) mkdir -p node_modules; [ "$CI_FAIL" != yes ];; ls) exit 0;; esac');
			const result = childProcess.spawnSync('bash', ['-c', `
set -e
. "$1"
cd "$2"; CHINACHU_DIR=$PWD; NODE_PATH="$3"; NPM_PATH="$4"
NODE_VER=$("$NODE_PATH" -p 'process.versions.node')
chinachu_application_processes_running() { return 1; }
export CI_FAIL=yes
if chinachu_installer_node_modules; then exit 71; fi
[ "$(cat node_modules/keep)" = 'previous dependencies' ]
export CI_FAIL=no
prepared=$(chinachu_installer_dependencies_prepare)
chinachu_application_processes_running() { return 2; }
if chinachu_installer_dependencies_publish "$prepared"; then exit 75; fi
[ "$(cat node_modules/keep)" = 'previous dependencies' ]
chinachu_application_processes_running() { return 1; }
printf '{"changed":true}' > package.json
if chinachu_installer_dependencies_publish "$prepared"; then exit 76; fi
printf '{}' > package.json
[ "$(cat node_modules/keep)" = 'previous dependencies' ]
# A failed publication is an error and never creates an old-runtime backup.
mv() {
 case "$1:$2:$3:$4" in -T:--:*/.dependencies.*/node_modules:node_modules) return 1;; esac
 command mv "$@"
}
if chinachu_installer_node_modules; then exit 73; fi
[ ! -e node_modules ]
unset -f mv
chinachu_installer_node_modules
chinachu_installer_dependencies_ready
[ ! -e node_modules/keep ]
! compgen -G "$CHINACHU_DIR/.*-recovery.*" > /dev/null
if upgrade_failed 'post-update verification'; then exit 74; fi
[ -d node_modules ]
! compgen -G "$CHINACHU_DIR/.*-recovery.*" > /dev/null
echo incompatible > node_modules/.chinachu-node-abi
if chinachu_installer_dependencies_ready; then exit 72; fi
`, 'bash', source, root, process.execPath, npm], {encoding: 'utf8'});
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
		} finally { fs.rmSync(root, {recursive: true, force: true}); }
	});

	it('creates a missing runtime baseline without replacing existing data', function() {
		const newFixture = createLauncherFixture();
		const existingFixture = createLauncherFixture();

		try {
			const newResult = runServiceBootstrap(newFixture);
			assert.strictEqual(newResult.status, 0, newResult.stdout + newResult.stderr);

			// Standalone verify must initialize its own runtime context, without bootstrap.
			const standaloneSource = writeSourceableLauncher(newFixture);
			const standaloneNpm = writeSuccessfulNpm(newFixture);
			const standaloneBin = path.join(newFixture, 'system-bin');
			writeFakeFfmpegPair(standaloneBin);
			fs.mkdirSync(path.join(newFixture, '.nave'));
			fs.symlinkSync(process.execPath, path.join(newFixture, '.nave/node'));
			fs.symlinkSync(standaloneNpm, path.join(newFixture, '.nave/npm'));
			fs.mkdirSync(path.join(newFixture, 'node_modules'));
			fs.writeFileSync(path.join(newFixture, 'node_modules/.chinachu-node-abi'), process.versions.modules);
			fs.writeFileSync(path.join(newFixture, 'package.json'), '{}');
			fs.writeFileSync(path.join(newFixture, 'package-lock.json'), '{"packages":{"":{}}}');
			const verified = childProcess.spawnSync('bash', ['-c', [
				'. "$2"', 'cd "$1"', 'CHINACHU_DIR=$PWD', 'NAVE_DIR=$PWD/.nave', 'USR_DIR=$PWD/usr',
				'NODE_PATH="$3"', 'NPM_PATH="$4"', 'PATH="$5:$PATH"',
				'NODE_VER=$("$NODE_PATH" -p process.versions.node)',
				'BOOTSTRAP_NODE_COMMAND=', 'chinachu_installer_verify'
			].join('; '), 'bash', newFixture, standaloneSource, process.execPath, standaloneNpm, standaloneBin], {encoding:'utf8'});
			assert.strictEqual(verified.status, 0, verified.stdout + verified.stderr);

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
			fs.mkdirSync(path.join(runtimeFixture, '.nave'));
			fs.symlinkSync(process.execPath, path.join(runtimeFixture, '.nave/node'));
			fs.symlinkSync(npmPath, path.join(runtimeFixture, '.nave/npm'));
			fs.mkdirSync(path.join(runtimeFixture, 'node_modules'));
			fs.writeFileSync(path.join(runtimeFixture, 'node_modules/.chinachu-node-abi'), process.versions.modules);
			fs.writeFileSync(path.join(runtimeFixture, 'package.json'), '{}');
			fs.writeFileSync(path.join(runtimeFixture, 'package-lock.json'), '{"packages":{"":{}}}');

			const runtimeResult = childProcess.spawnSync('bash', [ '-c', [
				'cd "$1"',
				'. "$2"',
				'CHINACHU_DIR=$PWD',
				'USR_DIR="$PWD/usr"',
				'NODE_PATH="$3"',
				'NPM_PATH="$4"',
				'PATH="$5:$PATH"',
				'NAVE_DIR="$PWD/.nave"',
				'NODE_VER=$("$NODE_PATH" --version)',
				'NODE_VER=${NODE_VER#v}',
				'chinachu_runtime_bootstrap',
				'chinachu_installer_verify'
			].join('; '), 'bash', runtimeFixture, sourceable, process.execPath, npmPath, systemBin ], {
				encoding: 'utf8'
			});

			assert.strictEqual(runtimeResult.status, 1);
			assert.match(runtimeResult.stderr, /Configuration or runtime JSON validation failed/);
			assert.strictEqual(
				fs.readFileSync(path.join(runtimeFixture, 'data', 'recorded.json'), 'utf8'),
				'do not replace invalid data'
			);
		} finally {
			fs.rmSync(configFixture, { recursive: true, force: true });
			fs.rmSync(runtimeFixture, { recursive: true, force: true });
		}
	});

});
