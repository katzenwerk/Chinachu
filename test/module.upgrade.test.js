'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const vm = require('node:vm');
const test = require('node:test');

function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-upgrade-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const source = fs.readFileSync(path.join(__dirname, '../chinachu'), 'utf8').replace(/\nmain "\$@"\s*$/, '\n');
	fs.writeFileSync(path.join(root, 'launcher.sh'), source);
	return root;
}

function shell(root, source, args = []) {
	return cp.spawnSync('bash', ['-c', 'set -e\n. "$1/launcher.sh"\nCHINACHU_DIR="$1"; NAVE_DIR="$1/.nave"; BOOTSTRAP_NODE_COMMAND="$2"\ncd "$1"\n' + source, 'bash', root, process.execPath, ...args], { encoding: 'utf8' });
}

test('Upgrade reports verification failure without retaining old-runtime backups', t => {
	const root = fixture(t);
	fs.mkdirSync(path.join(root, 'common'));
	fs.mkdirSync(path.join(root, 'lib'));
	fs.writeFileSync(path.join(root, 'lib/service-setup.sh'), '');
	fs.writeFileSync(path.join(root, 'package.json'), '{}');
	fs.writeFileSync(path.join(root, 'common/package.json'), '{}');
	fs.writeFileSync(path.join(root, 'package-lock.json'), '{"packages":{"":{}}}');
	fs.mkdirSync(path.join(root, 'node_modules'));
	fs.writeFileSync(path.join(root, 'node_modules/old-module'), 'old ABI dependencies');
	fs.mkdirSync(path.join(root, '.nave/installed', process.versions.node, 'bin'), { recursive: true });
	fs.symlinkSync(process.execPath, path.join(root, '.nave/installed', process.versions.node, 'bin/node'));
	const npm = path.join(root, '.nave/installed', process.versions.node, 'bin/npm');
	fs.writeFileSync(npm, '#!/bin/sh\ncase "$1" in --version) echo 11.20.0;; ci) mkdir -p node_modules;; ls) exit 0;; esac\n', { mode: 0o755 });
	fs.symlinkSync('installed/24.20.0/bin/node', path.join(root, '.nave/node'));
	fs.symlinkSync('installed/24.20.0/bin/npm', path.join(root, '.nave/npm'));
	const result = shell(root, String.raw`
TARGET=$("$2" -p 'process.versions.node'); NODE_VER=0.0.0
NODE_PATH="$NAVE_DIR/installed/$TARGET/bin/node"; NPM_PATH="$NAVE_DIR/installed/$TARGET/bin/npm"
upgrade_verify_repository_owner() { return 0; }
service_setup_runtime_repair() { [ "$2" = --allow-source-build ] || return 83; echo runtime-repair >> calls; }
resolve_bootstrap_node() { return 0; }
service_setup_origin_user() { command id -un; }
upgrade_inspect_pm2_manager() { manager_prefix=LOCAL; manager_user=$(id -un); online_names='chinachu-operator chinachu-wui'; }
upgrade_pm2_status() { echo online; }
inspect_repository_ffmpeg() { FFMPEG_LOCAL_STATE=none; }
verify_runtime_ffmpeg() { return 0; }
print_ffmpeg_commands() { return 0; }
upgrade_git() {
 case "$1" in
 status|fetch|merge-base) return 0;; branch) echo thorn;;
 rev-parse) if [ "$2" = HEAD ]; then echo previous-revision; else echo origin/thorn; fi;;
 config) echo origin;; diff) echo chinachu;;
 show) case "$2" in *:package.json) printf '{\n  "version": "0.10.7-thorn.37"\n}\n';; *:chinachu) echo "NODE_VER=$TARGET";; esac;;
 merge) echo merge >> calls;; *) return 80;;
 esac
}
upgrade_as_user() {
 if [ "$1" != "$CHINACHU_DIR/chinachu" ]; then "$@"; return $?; fi
 echo "$3" >> calls
 local NODE_VER="$TARGET"
 case "$3" in
 node-prepare) [ "$5" = --allow-source-build ] || return 84; chinachu_installer_node_prepare "$4" "$5";;
 node) chinachu_installer_node;;
 dependencies) chinachu_installer_node_modules "$4";;
 bootstrap) return 0;; verify) return 1;; *) return 81;; esac
}
chinachu_application_processes_running() { return 1; }
upgrade_activity_snapshot() { printf '0\tnone\n'; }
upgrade_show_activity() { return 0; }
upgrade_confirm() { return 0; }
upgrade_revalidate_pm2_manager() { return 0; }
service_setup_pm2_as_user() { echo "$2" >> calls; }
if chinachu_upgrade --allow-source-build; then exit 71; fi
`);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stderr, /Upgrade failed at: post-update verification/);
	assert(!fs.readdirSync(root).some(name=>/^\.(upgrade|installer)-recovery\./.test(name)));
	assert(!fs.existsSync(path.join(root,'node_modules/old-module')));
	assert.equal(fs.readlinkSync(path.join(root, '.nave/node')), path.join(root, '.nave/installed', process.versions.node, 'bin/node'));
	assert.equal(fs.readFileSync(path.join(root, 'node_modules/.chinachu-node-abi'), 'utf8').trim(), process.versions.modules);
	assert.equal(fs.readFileSync(path.join(root, 'calls'), 'utf8'), 'runtime-repair\nnode-prepare\nstop\nmerge\nnode\ndependencies\nbootstrap\nverify\n');
	for (const name of ['pm2-runtime-migrate.js', 'pm2-runtime-client.js']) fs.copyFileSync(path.join(__dirname, '../lib', name), path.join(root, 'lib', name));
	for (const [dirty, failVerify] of [['yes', 'no'], ['no', 'no'], ['yes', 'yes']]) {
		fs.mkdirSync(path.join(root, '.nave/installed/24.20.0'), {recursive: true});
		const unmanaged = shell(root, String.raw`
NODE_VER=$("$2" -p 'process.versions.node'); NODE_PATH="$2"
runtime_dirty="$3"; git_dirty="$3"; fail_verify="$4"
: > unmanaged-calls
upgrade_verify_repository_owner() { return 0; }
resolve_bootstrap_node() { return 0; }
service_setup_origin_user() { id -un; }
upgrade_inspect_pm2_manager() { manager_prefix=''; SERVICE_SETUP_INCLUDE_ROOT=true; }
service_setup_runtime_repair() { echo 'unexpected PM2 repair' >&2; return 85; }
inspect_repository_ffmpeg() { FFMPEG_LOCAL_STATE=none; }
verify_runtime_ffmpeg() { return 0; }
print_ffmpeg_commands() { return 0; }
chinachu_installer_node_ready() { [ "$runtime_dirty" != yes ]; }
chinachu_installer_dependencies_ready() { [ "$runtime_dirty" != yes ]; }
upgrade_as_user() {
 if [ "$1" != "$CHINACHU_DIR/chinachu" ]; then "$@"; return $?; fi
 echo "$3:$4:$5" >> unmanaged-calls
 case "$3" in node-prepare) [ "$5" = --allow-source-build ];; verify) [ "$fail_verify" != yes ];; *) return 0;; esac
}
upgrade_git() {
 echo "git:$1" >> unmanaged-calls
 case "$1" in status) [ "$git_dirty" != yes ] || echo ' M local-file';;
 restore) git_dirty=no;;
 branch) echo thorn;; rev-parse) echo origin/thorn;; config) echo origin;;
 fetch|merge-base|diff) return 0;; show) printf '{\n  "version": "0.10.7-thorn.36"\n}\n';; *) return 86;; esac
}
upgrade_confirm_local_changes() { return 0; }
chinachu_upgrade --allow-source-build
`, [dirty, failVerify]);
		const calls = fs.readFileSync(path.join(root, 'unmanaged-calls'), 'utf8');
		assert.match(calls, /node-prepare:.*:--allow-source-build/);
		assert.match(calls, /verify::/);
		if (failVerify === 'yes') {
			assert.notEqual(unmanaged.status, 0);
			assert.doesNotMatch(unmanaged.stdout, /Runtime verified|Already up to date/);
			assert(calls.includes('git:status'));
			assert.doesNotMatch(calls, /^git:merge$/m);
		} else {
			assert.equal(unmanaged.status, 0, unmanaged.stderr);
			assert(calls.indexOf('git:status') < calls.indexOf('verify::'));
			assert.equal(fs.existsSync(path.join(root, '.nave/installed/24.20.0')), false);
			if (dirty === 'yes') assert.match(calls, /node:--allow-source-build:/);
			else assert.doesNotMatch(calls, /^node:|^dependencies:/m);
		}
	}
});

test('PM2 runtime checks reject a different executable and report stale saved interpreters without saving', async t => {
	const root = fixture(t);
	fs.mkdirSync(path.join(root, '.nave/installed', process.versions.node, 'bin'), { recursive: true });
	fs.symlinkSync(process.execPath, path.join(root, '.nave/installed', process.versions.node, 'bin/node'));
	fs.mkdirSync(path.join(root, '.nave/installed/wrong/bin'), { recursive: true });
	fs.symlinkSync('/bin/false', path.join(root, '.nave/installed/wrong/bin/node'));
	const active = ['chinachu-operator', 'chinachu-wui'].map(name => ({name, pid: 321, pm2_env: {
		pm_cwd: root, pm_exec_path: path.join(root, name.replace('chinachu-', 'app-') + '.js'),
		exec_interpreter: path.join(root, '.nave/node'), exec_mode: 'fork_mode', status: 'online'
	}}));
	const saved = active.map(item => ({name: item.name, ...item.pm2_env, exec_interpreter: path.join(root, '.nave/installed/24.20.0/bin/node')}));
	const dump = JSON.stringify(saved);
	fs.writeFileSync(path.join(root, 'dump.pm2'), dump);
	const result = shell(root, String.raw`
manager_prefix=ROOT; manager_user=root; upstream_node_version=$("$2" -p 'process.versions.node')
manager_active="$3"; manager_saved="$4"
# Model /proc independently of the test runner process namespace.
readlink() {
 case "$*" in *'/proc/321/exe') command readlink -f -- "$BOOTSTRAP_NODE_COMMAND";; *) command readlink "$@";; esac
}
upgrade_pm2_state_valid "$manager_active" active
upgrade_pm2_runtime_valid "$manager_active" 'chinachu-operator chinachu-wui' "$upstream_node_version"
if upgrade_pm2_runtime_valid "$manager_active" chinachu-wui wrong; then exit 71; fi
if upgrade_pm2_persistence_report > persistence.stdout 2> persistence.stderr; then exit 72; else [ "$?" = 2 ]; fi
manager_saved="$manager_active"
upgrade_pm2_persistence_report
`, [JSON.stringify(active), dump]);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(fs.readFileSync(path.join(root, 'persistence.stderr'), 'utf8'), /PM2 root saved: chinachu-operator is not pinned/);
	assert.equal(fs.readFileSync(path.join(root, 'dump.pm2'), 'utf8'), dump);
	// Keep authority checks independent of the pre-restart PID inventory.
	const current = active.map(item => ({...item, pid: process.pid}));
	fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({uid: 1000, gid: 2000}));
	const identity = shell(root, String.raw`
. "$4"
current="$3"; UPGRADE_USER=fixture; mock_uid=1000; mock_gid=1000
id() {
 case "$1" in -u|-g) echo 1000;; -un) echo fixture;; *) return 91;; esac
}
getent() { [ "$1" = group ] && printf 'configured:x:%s:\n' "$2"; }
awk() {
 case "$2" in /proc/*/status)
  case "$1" in *Uid:*) echo "$mock_uid";; *Gid:*) echo "$mock_gid";; *) return 92;; esac;;
 *) command awk "$@";; esac
}
# A changed PID must not affect UID/GID validation, even with a stale inventory.
SERVICE_SETUP_PROCESS_PIDS=999999
upgrade_pm2_identity_valid "$current" 'chinachu-operator chinachu-wui' 1000 1000
if upgrade_processes_match_state "$current"; then exit 71; fi
for mismatch in uid gid; do
 mock_uid=1000; mock_gid=1000
 if [ "$mismatch" = uid ]; then mock_uid=1001; else mock_gid=1001; fi
 if upgrade_pm2_identity_valid "$current" 'chinachu-operator chinachu-wui' 1000 1000; then exit 72; fi
done
mock_uid=1000; mock_gid=1000
service_setup_find_pm2() { echo fixture-pm2; }
upgrade_pm2_daemon_state_safe() { return 0; }
service_setup_capture_state() {
 SERVICE_SETUP_LOCAL_ACTIVE='[]'; SERVICE_SETUP_LOCAL_SAVED='[]'
 SERVICE_SETUP_ROOT_ACTIVE='[]'; SERVICE_SETUP_ROOT_SAVED='[]'
 if [ "$mode" = local ]; then SERVICE_SETUP_LOCAL_ACTIVE="$current"; else SERVICE_SETUP_ROOT_ACTIVE="$current"; fi
 SERVICE_SETUP_PROCESS_PIDS=$(printf '%s' "$current" | "$BOOTSTRAP_NODE_COMMAND" -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8"))[0].pid))')
}
service_setup_all_pm2_state_known() { return 0; }
mode=local; manager_prefix=''
# sudo invocation and config.gid must not change Local PM2 expectations.
SUDO_USER=someone-else
upgrade_inspect_pm2_manager true
[ "$manager_prefix:$manager_expected_uid:$manager_expected_gid" = LOCAL:1000:1000 ]
mode=root; manager_prefix=''; mock_gid=2000
upgrade_inspect_pm2_manager true
[ "$manager_prefix:$manager_expected_uid:$manager_expected_gid" = ROOT:1000:2000 ]
mock_gid=1000
if upgrade_inspect_pm2_manager true; then exit 73; fi
`, [JSON.stringify(current), path.join(__dirname, '../lib/service-setup.sh')]);
	assert.equal(identity.status, 0, identity.stdout + identity.stderr);
	assert.match(identity.stderr, /unexpected UID\/GID/);
	const {patchProcesses,startupUnit}=require('../lib/pm2-runtime-migrate');
	const unchanged=JSON.stringify(saved);
	const foreign={name:'another-service',exec_interpreter:'/usr/bin/node',env:{PATH:'/usr/bin',KEEP:'value'}};
	const migrated=patchProcesses(root,[...saved,foreign]);
	assert.equal(JSON.stringify(saved),unchanged);
	assert.deepEqual(migrated.at(-1),foreign);
	assert(migrated.slice(0,2).every(row=>row.exec_interpreter===path.join(root,'.nave/node') && row.env.PATH.startsWith(path.join(root,'.nave')+':')));
	assert.deepEqual(patchProcesses(root,migrated),migrated);
	const unit=startupUnit(root,'/usr/lib/node_modules/pm2/bin/pm2','fixture','/home/fixture');
	assert.match(unit,/ExecStart=.*\.nave\/node.*pm2.*resurrect/);
	assert.doesNotMatch(unit,/24\.20|installed\//);
	assert.match(unit,/^PIDFile=\/home\/fixture\/\.pm2\/pm2\.pid$/m);
	assert.throws(()=>patchProcesses(root,[{...saved[0],pm_exec_path:'/other/app-operator.js'}]),/Foreign/);
	const oldNode = path.join(root, '.nave/installed/24.20.0/bin/node');
	assert.throws(() => patchProcesses(root, [{...foreign, exec_interpreter: oldNode}]), /another-service.*exec_interpreter/);
	assert.deepEqual(foreign.env, {PATH: '/usr/bin', KEEP: 'value'});
	const own = patchProcesses(root, [{...saved[0], env: {NODE_BINARY: oldNode}}])[0];
	assert.equal(own.env.NODE_BINARY, path.join(root, '.nave/installed/26.13.0/bin/node'));
	const module = {name: 'pm2-logrotate', pm2_env: {pmx_module: true, exec_interpreter: oldNode}};
	assert.equal(patchProcesses(root, [module])[0].pm2_env.exec_interpreter, path.join(root, '.nave/installed/26.13.0/bin/node'));
	const {planStart}=require('../lib/pm2-runtime-client');
	const expected=active.map((item,index)=>({...item,pm_id:index+1}));
	const stopped=expected.map(item=>({...item,pid:0,pm2_env:{...item.pm2_env,status:'stopped',
		PATH:path.join(root,'.nave/installed/24.20.0/bin')+':/usr/bin',env:{OTHER:'keep'}}}));
	const previous=JSON.stringify(stopped);
	const plans=planStart(root,expected,stopped,['chinachu-operator','chinachu-wui']);
	assert.equal(JSON.stringify(stopped),previous);
	assert.deepEqual(plans.map(item=>item.id),[1,2]);
	assert(plans.every(item=>item.env.PATH.startsWith(path.join(root,'.nave')+':') && !item.env.PATH.includes('24.20.0')));
	assert(plans.every(item=>item.env.current_conf.exec_interpreter===path.join(root,'.nave/node')));
	assert.throws(()=>planStart(root,expected,stopped,['pm2-logrotate']),/non-Chinachu/);
	assert.throws(()=>planStart(root,expected,active,['chinachu-wui']),/registration changed|stopped/);

	const clustered = structuredClone(active);
	clustered[0].pm2_env.exec_mode = 'cluster_mode';
	assert.notEqual(shell(root, 'upgrade_pm2_state_valid "$3" active', [JSON.stringify(clustered)]).status, 0);

	// Execute the real migration against temporary files and mocked PM2/systemd only.
	for (const failStart of [false, true]) {
		const fixtureRoot = path.join(root, failStart ? 'failed-start' : 'successful-start');
		const home = path.join(fixtureRoot, 'home'), pmHome = path.join(home, '.pm2');
		const bin = path.join(fixtureRoot, 'pm2/bin/pm2'), unit = path.join(fixtureRoot, 'unit');
		const old = path.join(fixtureRoot, '.nave/installed/24.20.0');
		fs.mkdirSync(pmHome, {recursive: true}); fs.mkdirSync(path.dirname(bin), {recursive: true});
		fs.mkdirSync(old, {recursive: true}); fs.mkdirSync(path.join(fixtureRoot, 'data'));
		fs.symlinkSync(process.execPath, path.join(fixtureRoot, '.nave/node'));
		fs.writeFileSync(bin, 'fixture'); fs.writeFileSync(path.resolve(bin, '../../package.json'), '{"name":"pm2"}');
		for (const name of ['recording', 'recorded', 'reserves', 'reserves2']) fs.writeFileSync(path.join(fixtureRoot, 'data', name + '.json'), '[]');
		const entries = ['chinachu-operator', 'chinachu-wui'].map((name, index) => ({name, pid: 100 + index, pm_id: index,
			pm2_env: {name, status: 'online', pm_cwd: fixtureRoot, pm_exec_path: path.join(fixtureRoot, name.replace('chinachu-', 'app-') + '.js'),
				exec_interpreter: path.join(old, 'bin/node'), exec_mode: 'fork_mode', PATH: path.join(old, 'bin') + ':/usr/bin'}}));
		const parked = {name: 'parked-service', status: 'stopped', exec_interpreter: '/usr/bin/node'};
		const dump = path.join(pmHome, 'dump.pm2');
		fs.writeFileSync(dump, JSON.stringify([...entries.map(row => row.pm2_env), parked]));
		fs.copyFileSync(dump, dump + '.bak');
		fs.writeFileSync(path.join(pmHome, 'pm2.pid'), '99'); fs.writeFileSync(path.join(pmHome, 'rpc.sock'), 'mock');
		fs.writeFileSync(unit, 'old startup');
		let afterStart = null;
		const events = [], io = Object.create(fs);
		const remap = file => String(file).replace('/etc/systemd/system/pm2-fixture.service', unit);
		for (const method of ['readFileSync', 'writeFileSync']) io[method] = (file, ...args) => fs[method](remap(file), ...args);
		io.renameSync = (from, to) => fs.renameSync(remap(from), remap(to));
		io.chownSync = () => {};
		io.existsSync = file => file === '/proc/99' || fs.existsSync(remap(file));
		io.readlinkSync = file => String(file).startsWith('/proc/') ? (afterStart ? fs.realpathSync(process.execPath) : path.join(old, 'bin/node')) : fs.readlinkSync(file);
		const context = {module: {exports: {}}, structuredClone, process: {getuid: () => 0, pid: process.pid},
			console: {log: message => events.push(message), error() {}},
			setTimeout: () => { throw new Error('Unexpected restoration retry'); },
			require(name) {
				if (name === 'node:fs') return io;
				if (name === './pm2-runtime-client') return {runtimeConfig: require('../lib/pm2-runtime-client').runtimeConfig,
					connectExisting: async () => ({call: async () => afterStart || entries, close() {}})};
				if (name === 'node:child_process') return {spawnSync(binary, args) {
					let stdout = '';
					if (binary === 'getent') stdout = `fixture:x:1000:1000::${home}:/bin/bash`;
					else if (binary.endsWith('/.nave/node')) stdout = '26.13.0';
					else if (binary === 'systemctl') {
						events.push('systemctl:' + args[0]);
						if (args[0] === 'is-enabled') stdout = 'enabled';
						if (args[0] === 'show') stdout = 'loaded';
						if (args[0] === 'start') {
							assert(!fs.existsSync(old), 'Node 24 must be removed before starting services');
							assert(fs.readFileSync(unit, 'utf8').includes('.nave/node'));
							assert(!fs.readFileSync(dump, 'utf8').includes('24.20.0'));
							assert(!fs.readFileSync(dump + '.bak', 'utf8').includes('24.20.0'));
							if (failStart) return {status: 1, stderr: 'simulated startup failure'};
							afterStart = JSON.parse(fs.readFileSync(dump, 'utf8')).map((env, i) => ({name: env.name, pid: 100 + i, pm_id: i, pm2_env: env}));
						}
					} else assert.equal(binary, 'runuser');
					return {status: 0, stdout, stderr: ''};
				}};
				return require(name);
			}};
		vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/pm2-runtime-migrate.js'), 'utf8'), context);
		const operation = context.module.exports.repair(fixtureRoot, bin, 'fixture');
		if (failStart) await assert.rejects(operation, /simulated startup failure/); else await operation;
		assert(!fs.existsSync(old), 'Startup failure must not retain or restore Node 24');
		assert.deepEqual(JSON.parse(fs.readFileSync(dump, 'utf8')).find(row => row.name === parked.name), parked);
		assert(events.indexOf('systemctl:enable') < events.findIndex(value => value.startsWith('Removed Chinachu Node')));
	}
});
