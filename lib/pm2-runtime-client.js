'use strict';

// Connect only to an existing, correctly owned PM2 socket. Never launch a daemon.
const fs=require('node:fs'),path=require('node:path');
const NAMES=new Set(['chinachu-operator','chinachu-wui']);

function runtimeConfig(root, env) {
	const nave=path.join(root,'.nave');
	const parts=String(env.PATH || env.env?.PATH || '/usr/bin:/bin').split(':');
	return {exec_interpreter:path.join(nave,'node'),
		PATH:[nave,...parts.filter(value=>value!==nave && !new RegExp('^'+escape(root)+'/\\.nave/installed/[^/]+/bin$').test(value))].join(':')};
}
function escape(value) {return value.replace(/[.*+?^$()|[\]\\]/g,'\\$&');}
function planStart(root, expected, current, names) {
	if(!Array.isArray(expected) || !Array.isArray(current)) throw new Error('Expected PM2 process arrays');
	if(!names.length || new Set(names).size!==names.length) throw new Error('Expected unique Chinachu targets');
	return names.map(name=>{
		if(!NAMES.has(name)) throw new Error('Refusing a non-Chinachu target');
		const old=expected.filter(item=>item.name===name),live=current.filter(item=>item.name===name);
		if(old.length!==1 || live.length!==1 || old[0].pm_id!==live[0].pm_id) throw new Error('PM2 registration changed: '+name);
		const item=live[0],env=item.pm2_env || {};
		if(env.pm_cwd!==root || env.pm_exec_path!==path.join(root,name.replace('chinachu-','app-')+'.js') ||
			!['fork','fork_mode'].includes(env.exec_mode) || env.status!=='stopped' || Number(item.pid)!==0 || env.watch || env.cron_restart) {
			throw new Error('Target is not a verified stopped fork process: '+name);
		}
		const config=runtimeConfig(root,env);
		// Both flat PATH (ForkMode spawn_env) and env.PATH are updated; all other keys remain.
		return {name,id:item.pm_id,env:{PATH:config.PATH,current_conf:config}};
	});
}
async function connectExisting(binary, home, uid) {
	const socketPath=path.join(home,'rpc.sock'),socketStat=fs.statSync(socketPath),pidStat=fs.statSync(path.join(home,'pm2.pid'));
	if(!socketStat.isSocket() || socketStat.uid!==uid || pidStat.uid!==uid) throw new Error('PM2 socket/PID owner mismatch');
	const moduleRoot=path.dirname(path.dirname(fs.realpathSync(binary)));
	if(JSON.parse(fs.readFileSync(path.join(moduleRoot,'package.json'),'utf8')).name!=='pm2') throw new Error('Not the installed PM2 package');
	const axon=require(path.join(moduleRoot,'modules/pm2-axon')),rpc=require(path.join(moduleRoot,'modules/pm2-axon-rpc'));
	const socket=axon.socket('req'),client=new rpc.Client(socket);
	const close=()=>socket.close();
	try {
		await new Promise((resolve,reject)=>{
			const timer=setTimeout(()=>reject(new Error('Existing PM2 connection timed out')),3000);
			socket.once('connect',()=>{clearTimeout(timer);resolve();});
			socket.once('error',error=>{clearTimeout(timer);reject(error);});
			socket.connect(socketPath);
		});
		const call=(method,data)=>new Promise((resolve,reject)=>{
			const timer=setTimeout(()=>reject(new Error('PM2 RPC timed out: '+method)),20000);
			client.call(method,data,(error,value)=>{clearTimeout(timer);error?reject(new Error(String(error))):resolve(value);});
		});
		const report=await call('getReport',{});
		if(Number(report.uid)!==uid) throw new Error('PM2 daemon UID mismatch');
		return {call,close,daemon:{uid:Number(report.uid),nodeVersion:report.node_version}};
	} catch(error) {close();throw error;}
}
async function startExisting(connection,root,expected,names) {
	const current=await connection.call('getMonitorData',{});
	const plans=planStart(root,expected,current,names);
	for(const plan of plans) await connection.call('restartProcessId',{id:plan.id,env:plan.env});
}
module.exports={runtimeConfig,planStart,connectExisting,startExisting};
if(require.main===module) {
	(async()=>{
		const [action,binary,home,uid,root,names='']=process.argv.slice(2);
		if(!['inspect','start'].includes(action)) throw new Error('Unknown existing-PM2 action');
		const expected=action==='start'?JSON.parse(fs.readFileSync(0,'utf8')):null;
		const connection=await connectExisting(binary,home,Number(uid));
		try {
			if(action==='start') await startExisting(connection,root,expected,names.split(' ').filter(Boolean));
			else process.stdout.write(JSON.stringify(await connection.call('getMonitorData',{})));
		} finally {connection.close();}
	})().catch(error=>{console.error(error.message);process.exitCode=1;});
}
