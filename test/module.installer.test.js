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

			const result = childProcess.spawnSync('bash', [ '-c', [
				'cd "$1"',
				'. "$2"',
				'CHINACHU_DIR=$PWD',
				'NODE_PATH="$3"',
				'NPM_PATH="$4"',
				'NODE_VER=$("$NODE_PATH" --version)',
				'NODE_VER=${NODE_VER#v}',
				'chinachu_runtime_bootstrap',
				'chinachu_installer_verify'
			].join('; '), 'bash', temporaryDir, sourceable, process.execPath, npmPath ], {
				encoding: 'utf8'
			});

			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
		} finally {
			fs.rmSync(temporaryDir, { recursive: true, force: true });
		}
	});

	it('rejects invalid existing runtime JSON without replacing it', function() {
		const temporaryDir = createLauncherFixture();

		try {
			const sourceable = writeSourceableLauncher(temporaryDir);
			const npmPath = writeSuccessfulNpm(temporaryDir);
			fs.mkdirSync(path.join(temporaryDir, 'data'));
			fs.writeFileSync(path.join(temporaryDir, 'data', 'recorded.json'), 'do not replace invalid data');

			const result = childProcess.spawnSync('bash', [ '-c', [
				'cd "$1"',
				'. "$2"',
				'CHINACHU_DIR=$PWD',
				'NODE_PATH="$3"',
				'NPM_PATH="$4"',
				'NODE_VER=$("$NODE_PATH" --version)',
				'NODE_VER=${NODE_VER#v}',
				'chinachu_runtime_bootstrap',
				'chinachu_installer_verify'
			].join('; '), 'bash', temporaryDir, sourceable, process.execPath, npmPath ], {
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
