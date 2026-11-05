#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {diagnose}=require('../lib/runtime-diagnostics');
const {execFileSync}=require('node:child_process');
const [rootDir,targetVersion]=process.argv.slice(2);
try {
	const snapshot=JSON.parse(fs.readFileSync(0,'utf8'));
	for(const manager of snapshot.managers) {
		const candidates=['/etc/systemd/system','/run/systemd/system','/usr/lib/systemd/system','/lib/systemd/system']
			.map(directory=>path.join(directory,'pm2-'+manager.user+'.service'));
		manager.unitPath=candidates.find(file=>{try {fs.accessSync(file,fs.constants.R_OK);return true;} catch(error) {if(error.code!=='ENOENT') manager.unitReadError=error.message;return false;}});
	}
	const probe = filename => {try {return execFileSync(filename,['--version'],{encoding:'utf8',timeout:3000,stdio:['ignore','pipe','pipe']}).trim();} catch(error) {return String(error.stderr || error.message).trim();}};
	const runtimeInfo={expected:probe(path.join(rootDir,'.nave/installed',targetVersion,'bin/node')),nave:probe(path.join(rootDir,'.nave/node'))};
	const result=diagnose({rootDir,targetVersion,managers:snapshot.managers,runtimeInfo});
	process.stdout.write(JSON.stringify(result,null,2)+'\n');
	process.exitCode=result.issues.length ? 2 : 0;
} catch(error) {console.error('Runtime diagnosis failed: '+error.message);process.exitCode=1;}
