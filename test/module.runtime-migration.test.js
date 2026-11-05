'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const {diagnose}=require('../lib/runtime-diagnostics');

test('runtime diagnosis detects mixed live/saved/backup/startup targets without writes',t=>{
	const root=fs.mkdtempSync(path.join(os.tmpdir(),'chinachu-diagnosis-'));
	t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
	const target='26.13.0',binary=path.join(root,'.nave/installed',target,'bin');
	fs.mkdirSync(binary,{recursive:true});fs.writeFileSync(path.join(binary,'node'),'fixture',{mode:0o755});
	fs.writeFileSync(path.join(binary,'npm'),'fixture',{mode:0o755});
	fs.symlinkSync(path.join(binary,'node'),path.join(root,'.nave/node'));
	fs.symlinkSync(path.join(binary,'npm'),path.join(root,'.nave/npm'));
	const home=path.join(root,'home');fs.mkdirSync(path.join(home,'.pm2'),{recursive:true});
	fs.writeFileSync(path.join(home,'.pm2/pm2.pid'),'102');
	const active=['operator','wui'].map((name,i)=>({name:'chinachu-'+name,pid:100+i,pm2_env:{status:'online',pm_cwd:root,pm_exec_path:path.join(root,'app-'+name+'.js'),exec_mode:'fork_mode',exec_interpreter:path.join(root,'.nave/node')}}));
	const saved=active.map(item=>({name:item.name,...item.pm2_env,exec_interpreter:path.join(root,'.nave/installed/24.20.0/bin/node')}));
	const backup=path.join(home,'.pm2/dump.pm2.bak');fs.writeFileSync(backup,JSON.stringify(saved));
	const unit=path.join(root,'pm2.service');fs.writeFileSync(unit,'ExecStart=/old/installed/24.20.0/bin/pm2 resurrect\n');
	const io=Object.create(fs);io.readlinkSync=file=>file.startsWith('/proc/') ? (file.includes('/100/') ? path.join(binary,'node') : '/old/24/bin/node') : fs.readlinkSync(file);
	const options={rootDir:root,targetVersion:target,fs:io,runtimeInfo:{expected:'v'+target,nave:'v'+target},managers:[{user:'fixture',home,unitPath:unit,active,saved}]};
	const before=fs.readFileSync(backup,'utf8'),result=diagnose(options),codes=new Set(result.issues.map(item=>item.code));
	for(const code of ['daemon-runtime','stale-interpreter','running-runtime','mixed-running-runtimes','startup-old-runtime']) assert(codes.has(code),code);
	assert.equal(fs.readFileSync(backup,'utf8'),before);
	options.managers[0].saved=active;fs.writeFileSync(backup,JSON.stringify(active));
	fs.writeFileSync(unit,'ExecStart=/usr/bin/pm2 resurrect\n');
	io.readlinkSync=file=>file.startsWith('/proc/') ? path.join(binary,'node') : fs.readlinkSync(file);
	assert.deepEqual(diagnose(options).issues,[]);
	options.runtimeInfo.expected='v24.20.0';
	assert(diagnose(options).issues.some(issue=>issue.code==='target-version'));
});

test('Nave adapter never falls back to source without the explicit flag, and profiling preserves command errors',t=>{
	const root=fs.mkdtempSync(path.join(os.tmpdir(),'chinachu-nave-policy-'));
	t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
	const nave=path.join(root,'nave.sh'),adapter=path.resolve(__dirname,'../lib/installer-nave.sh');
	fs.writeFileSync(nave,[
		'NAVE_ROOT="$NAVE_DIR/installed"; NAVE_SRC="$NAVE_DIR/src"',
		'osarch() { echo linux-x64; }',
		'get() { echo download-failed >&2; return 22; }',
		'if [ -z "$_TESTING_NAVE_NO_MAIN" ]; then echo "$NAVE_JOBS:$JOBS:$MAKEFLAGS" > "$NAVE_DIR/source-allowed"; exit 0; fi'
	].join('\n'));
	const env={...process.env,NAVE_DIR:root,NAVE_JOBS:'1',JOBS:'1',MAKEFLAGS:'-j1'};
	const denied=cp.spawnSync('bash',[adapter,nave,'26.13.0',''],{env,encoding:'utf8'});
	assert.notEqual(denied.status,0);assert.match(denied.stderr,/source build was NOT started/);
	assert.equal(fs.existsSync(path.join(root,'source-allowed')),false);
	const allowed=cp.spawnSync('bash',[adapter,nave,'26.13.0','--allow-source-build'],{env,encoding:'utf8'});
	assert.equal(allowed.status,0,allowed.stderr);
	assert.equal(fs.readFileSync(path.join(root,'source-allowed'),'utf8').trim(),'1:1:-j1');
	const profile=cp.spawnSync('python3',[path.resolve(__dirname,'../lib/installer-profile.py'),'failure-fixture','bash','-c','exit 7'],{encoding:'utf8'});
	assert.equal(profile.status,7);assert.match(profile.stderr,/"status":7/);
});
