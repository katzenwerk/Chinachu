'use strict';

const fs = require('node:fs');
const path = require('node:path');

function diagnose(options) {
	const root = path.resolve(options.rootDir), target = options.targetVersion;
	const io = options.fs || fs;
	const issues = [], observations = [];
	const add = (code, location, message) => issues.push({code, location, message});
	const expected = path.join(root, '.nave/installed', target, 'bin/node');
	const stable = path.join(root, '.nave/node');
	const canonical = filename => {try {return io.realpathSync(filename);} catch {return filename;}};
	const read = filename => {try {return {text:io.readFileSync(filename,'utf8')};} catch(error) {return {error};}};
	const runtime = options.runtimeInfo || {};
	if(runtime.expected !== 'v'+target) add('target-version',expected,runtime.expected || 'Target binary version could not be verified.');
	const expectedReal = canonical(expected);
	const linkReal = canonical(stable);
	if(runtime.nave !== 'v'+target) add('nave-version',stable,runtime.nave || 'Linked binary version could not be verified.');
	if(canonical(path.join(root,'.nave/npm'))!==canonical(path.join(root,'.nave/installed',target,'bin/npm'))) add('npm-link',path.join(root,'.nave/npm'),'npm and Node links do not select the same target release.');
	if(linkReal !== expectedReal) add('nave-target',stable,'Nave link does not resolve to the target runtime.');
	try {io.accessSync(expected, fs.constants.X_OK);} catch(error) {add('target-unavailable',expected,error.message);}
	const names = ['chinachu-operator','chinachu-wui'];
	const interpreters = [];
	for(const manager of options.managers || []) {
		if(manager.activeKnown === false || manager.savedKnown === false) add('manager-unreadable',manager.user,'Active/saved state could not be read; do not treat it as empty.');
		const home = manager.home;
		const otherNames=list=>(list || []).filter(item=>item && !names.includes(item.name)).map(item=>item.name).filter(Boolean);
		const otherActive=otherNames(manager.active), otherSaved=otherNames(manager.saved);
		observations.push({manager:manager.user,dumpPath:manager.home ? path.join(manager.home,'.pm2/dump.pm2') : null,
			unitPath:manager.unitPath || null,otherActive,otherSaved,savedOnly:otherSaved.filter(name=>!otherActive.includes(name))});
		if(home && (manager.active || []).some(item=>names.includes(item.name))) {
			try {
				const pid=Number(io.readFileSync(path.join(home,'.pm2/pm2.pid'),'utf8').trim());
				if(!Number.isSafeInteger(pid) || pid<=0) throw new Error('Invalid PM2 daemon PID');
				const executable=io.readlinkSync('/proc/'+pid+'/exe');
				observations.push({manager:manager.user,daemonPid:pid,daemonExecutable:executable});
				if(canonical(executable)!==expectedReal) add('daemon-runtime',manager.user,'PM2 daemon must be rebuilt with the target Node; run service runtime-repair.');
			} catch(error) {add('daemon-unreadable',manager.user,error.message);}
		}
		const sources = [['active',manager.active || []],['saved',manager.saved || []]];
		if(home) {
			const backup = path.join(home,'.pm2/dump.pm2.bak'), value = read(backup);
			if(value.error && value.error.code !== 'ENOENT') add('backup-unreadable',backup,value.error.message);
			else if(!value.error) {
				try {
					const parsed=JSON.parse(value.text);
					if(!Array.isArray(parsed)) throw new Error('expected array');
					sources.push(['backup',parsed]);
				} catch(error) {add('backup-invalid',backup,error.message);}
			}
		}
		for(const [label,list] of sources) {
			for(const name of names) {
				const found=list.filter(item=>item && item.name===name);
				if(!found.length && label!=='active' && (manager.active || []).some(item=>item && item.name===name)) add(label+'-missing',manager.user+'/'+label+'/'+name,'No saved restoration entry; review this manager explicitly without registering automatically.');
				if(found.length>1) add('duplicate-registration',manager.user+'/'+label+'/'+name,'Duplicate Chinachu registration.');
				for(const item of found) {
					const env=item.pm2_env || item, location=manager.user+'/'+label+'/'+name;
					const cwd=env.pm_cwd || env.cwd || root;
					if(path.resolve(cwd, env.pm_exec_path || env.script || '') !== path.join(root,name.replace('chinachu-','app-')+'.js')) {
						add('foreign-registration',location,'Script belongs to a different path; do not change it.'); continue;
					}
					const interpreter=env.exec_interpreter;
					const resolved=interpreter && interpreter !== 'node' ? path.resolve(cwd,interpreter) : null;
					if(!resolved || (resolved!==stable && canonical(resolved)!==expectedReal)) add('stale-interpreter',location,'Set only this Chinachu interpreter to the absolute .nave/node path after reviewing the manager.');
					if(env.exec_mode && !['fork','fork_mode'].includes(env.exec_mode)) add('execution-mode',location,'Chinachu requires fork mode; cluster inherits the daemon runtime.');
					if(label==='active' && env.status==='online') {
						try {
							const executable=io.readlinkSync('/proc/'+Number(item.pid)+'/exe');
							interpreters.push(executable);
							observations.push({manager:manager.user,name,executable});
							if(canonical(executable)!==expectedReal) add('running-runtime',location,'Running executable differs from the target. Restart only after recording checks.');
						} catch(error) {
						observations.push({manager:manager.user,name,reportedNodeVersion:env.node_version || null,evidence:'PM2 child IPC; process executable could not be read'});
						if(env.node_version && env.node_version!==target) add('running-node-version',location,'PM2 child reports Node '+env.node_version+' instead of '+target);
						add('running-unreadable',location,error.message);
					}
					}
				}
			}
		}
		if(!sources.some(([,list])=>list.some(item=>item && names.includes(item.name)))) continue;
		if(manager.unitReadError) add('startup-unreadable',manager.user,manager.unitReadError);
		if(!manager.unitPath) add('startup-missing',manager.user,'Inspect/enable the selected PM2 startup unit explicitly; no unit was changed.');
		else {
			const unit=read(manager.unitPath);
			if(unit.error) add('startup-unreadable',manager.unitPath,unit.error.message);
			else {
				// Runtime repair includes the PM2 daemon and its startup unit.
				const versions=[...unit.text.matchAll(/(?:installed\/|node-v?)(\d+\.\d+\.\d+)\/(?:bin|lib)/g)].map(match=>match[1]);
				if(versions.some(version=>version!==target)) add('startup-old-runtime',manager.unitPath,'Startup still depends on an old installed Node. Run service runtime-repair for this manager to rebuild it on the target runtime.');
				const user=unit.text.match(/^User=(.+)$/m);
				if(user && user[1].trim()!==manager.user) add('startup-user',manager.unitPath,'Startup unit runs as a different PM2 manager.');
				const home=unit.text.match(/PM2_HOME=([^"\n ]+)/);
				if(home && manager.home && home[1]!==path.join(manager.home,'.pm2')) add('startup-home',manager.unitPath,'Startup restores a different PM2_HOME.');
				if(!/ExecStart=.*\bresurrect\b/.test(unit.text)) add('startup-restore',manager.unitPath,'Unit does not use the expected PM2 resurrect command; review restoration manually.');
			}
		}
	}
	if(new Set(interpreters.map(canonical)).size>1) add('mixed-running-runtimes',root,'Operator and WUI use different Node executables.');
	return {schemaVersion:1,targetVersion:target,scope:{managers:(options.managers || []).map(item=>item.user),rootIncluded:(options.managers || []).some(item=>item.user==='root')},nave:{expected,actual:linkReal},observations,issues,
		next:'Read-only diagnosis. Repair the target Node 26 environment; preserve saved-only and unrelated service settings. Migration switches configuration, removes managed Node 24, then starts and verifies Node 26 services. No Node 24 backup or rollback is provided.'};
}
module.exports={diagnose};
