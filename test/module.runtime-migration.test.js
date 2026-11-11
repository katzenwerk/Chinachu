'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const {diagnose}=require('../lib/runtime-diagnostics');
const {TsDropAnalyzer}=require('../lib/ts-drop-analyzer');

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

test('Nave adapter requires explicit source-build permission and limits build jobs',t=>{
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
});

test('TS analysis preserves CC/TEI/sync and owned pending bytes for all packet/chunk boundaries',()=>{
	const packet=(pid,cc,flags=0)=>{const b=Buffer.alloc(188,0xff);b[0]=0x47;b[1]=(pid>>8)|flags;b[2]=pid&255;b[3]=0x10|cc;return b;};
	const data=Buffer.concat([packet(33,0),packet(33,1),packet(33,4),packet(33,4),packet(34,0,0x80),packet(8191,0),Buffer.from([0,1,2]),packet(33,7),packet(33,8),packet(33,9),Buffer.from([0x47,0])]);
	const run=size=>{
		const analyzer=new TsDropAnalyzer({now:()=>0,hrtime:()=>0n});
		for(let i=0;i<data.length;i+=size) {
			const input=Buffer.from(data.subarray(i,i+size));analyzer.push(input);input.fill(0);
		}
		return analyzer.finish();
	};
	const expected=run(data.length);
	assert.equal(expected.ccErrorEvents,1);assert.equal(expected.duplicatePackets,1);
	assert.equal(expected.teiPackets,1);assert.equal(expected.nullPackets,1);
	assert.equal(expected.syncErrorEvents,1);assert.equal(expected.syncRecoveries,1);assert.equal(expected.trailingBytes,2);
	for(const size of [1,2,17,187,188,189,375,564,1024]) assert.deepEqual(run(size),expected,'chunk size '+size);	const root=fs.mkdtempSync(path.join(os.tmpdir(),'chinachu-ts-cli-'));
	try {
		const input=path.join(root,'sample.ts');
		fs.writeFileSync(input,Buffer.concat([packet(33,0),packet(33,1),packet(33,2)]));
		const cli=cp.spawnSync(process.execPath,[path.resolve(__dirname,'../tools/ts-analyzer.js'),'--json',input],{encoding:'utf8'});
		assert.equal(cli.status,0,cli.stderr);
		const result=JSON.parse(cli.stdout);
		assert.equal(result.completed,true);
		const {externalAnalysis}=require('../lib/saved-ts-analysis');
		const request={path:input,file:{size:564},result};
		const historical=externalAnalysis(request);
		assert.equal(historical.result.analyzerBlobSha,result.analyzerBlobSha);
		delete result.analyzerBlobSha;
		assert.equal(externalAnalysis(request).result.completed,true);
		result.analyzerBlobSha='different-engine';
		assert.equal(externalAnalysis(request).result.analyzerBlobSha,'different-engine');
	} finally {fs.rmSync(root,{recursive:true,force:true});}

});

test('series dictionary search and manual registry preserve projection and publication consistency',async t=>{
	const {DatabaseSync}=require('node:sqlite');
	const {createSeriesResolver}=require('../lib/series-resolver');
	const root=fs.mkdtempSync(path.join(os.tmpdir(),'chinachu-search-index-'));
	t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
	const file=path.join(root,'dictionary.sqlite');
	function publish(title) {
		const stage=file+'.new',db=new DatabaseSync(stage);
		db.exec('CREATE TABLE titles(tid INTEGER PRIMARY KEY,title TEXT,lookup_key TEXT,short_title TEXT,first_year TEXT,first_month TEXT); CREATE TABLE aliases(tid INTEGER,lookup_key TEXT); CREATE TABLE episodes(tid INTEGER,episode INTEGER,subtitle TEXT,lookup_key TEXT); CREATE TABLE dictionary_meta(key TEXT PRIMARY KEY,value TEXT)');
		db.prepare('INSERT INTO titles VALUES (1,?,?,NULL,NULL,NULL)').run(title,title.toLowerCase());
		db.prepare('INSERT INTO dictionary_meta VALUES (?,?)').run('published',JSON.stringify({generation:title,source:'syobocal-official-titlelookup'}));
		db.close();fs.renameSync(stage,file);
	}
	publish('Ａｌｐｈａ 番組');
	const old=createSeriesResolver({dictionaryPath:file});
	t.after(()=>old.close());
	assert.equal(old.searchDictionaryTitles('Alpha',20)[0].tid,1);
	assert.equal(old.searchDictionaryTitles('1',20)[0].match,'tid');
	assert.equal(old.searchDictionaryTitles('alpha 番組',20)[0].match,'exact');
	assert.deepEqual(old.searchDictionaryTitles('  ',20),[]);
	publish('Beta');
	assert.equal(old.searchDictionaryTitles('Alpha',20)[0].title,'Ａｌｐｈａ 番組');
	const next=createSeriesResolver({dictionaryPath:file});t.after(()=>next.close());
	assert.deepEqual(next.searchDictionaryTitles('Alpha',20),[]);
	assert.equal(next.searchDictionaryTitles('Beta',20)[0].title,'Beta');
	fs.writeFileSync(file+'.bad','invalid SQLite');
	assert.throws(()=>createSeriesResolver({dictionaryPath:file+'.bad'}));
	assert.equal(next.searchDictionaryTitles('Beta',20)[0].tid,1);

	const {createSeriesManualStore,parseState}=require('../lib/series-manual-store');
	const {createSeriesService}=require('../lib/series-service');
	const {eventKey}=require('../lib/series-projector');
	const manualPath=path.join(root,'manual.json');
	const manual=createSeriesManualStore({path:manualPath});
	const local=manual.createLocalSeries('Beta'); // A TID with the same title remains a different series.
	assert.match(local.id,/^local:[a-f0-9]{24}$/);
	assert.equal(manual.createLocalSeries(' Ｂｅｔａ ').id,local.id);
	const empty=manual.createLocalSeries('録画なし');
	assert.equal(manual.listLocalSeries().length,2);
	const program={id:'recording-a',title:'Beta',fullTitle:'Beta',start:1794350000000,end:1794351800000,seconds:1800,
		channel:{id:'ch1',name:'Fixture',type:'GR',nid:1,sid:1},recorded:'/fixture/unopened.ts'};
	const key=eventKey(program);
	const ledgerPaths={};
	for(const name of ['recorded','reserves','match']) {
		ledgerPaths[name]=path.join(root,name+'.json'); fs.writeFileSync(ledgerPaths[name],JSON.stringify(name==='recorded'?[program]:[]));
	}
	const options={manualPath,ledgerPaths,dictionaryPath:file,channelMapPath:path.join(root,'map.json'),throwOnFailure:true};
	const service=createSeriesService({...options,manualStore:manual});t.after(()=>service.close());
	assert.equal(service.searchTitles('Beta',20).filter(item=>item.kind==='local').length,1);
	assert.equal(service.searchTitles('1',20,'tid')[0].tid,1);
	assert.equal(service.searchTitles('',20,'tid')[0].tid,1);
	service.setManualOverride({eventKey:key,tid:1,episode:null});
	assert.equal(service.getSnapshot().series[0].id,'syobocal:1');
	manual.setHiddenTid(1,true);service.invalidate();
	assert.equal(service.getSnapshot().hiddenSeries.length,1);
	const recordedGood=fs.readFileSync(ledgerPaths.recorded,'utf8');
	fs.writeFileSync(ledgerPaths.recorded,'{invalid');service.invalidate();
	assert.throws(()=>service.getSnapshot());assert.deepEqual(manual.getHiddenTids(),[1]);
	fs.writeFileSync(ledgerPaths.recorded,recordedGood);service.invalidate();
	const reserveOnly={...program,id:'reserve-only',start:program.start+7200000,end:program.end+7200000};
	fs.writeFileSync(ledgerPaths.reserves,JSON.stringify([reserveOnly]));service.invalidate();
	service.setManualOverride({eventKey:eventKey(reserveOnly),tid:1});
	assert.ok(service.getSnapshot().series.some(item=>item.id==='syobocal:1'));
	fs.writeFileSync(ledgerPaths.reserves,'[]');manual.remove(eventKey(reserveOnly));service.invalidate();
	const preview=service.previewManualSelection({eventKey:key,seriesId:local.id});
	assert.equal(preview.episodeConfirmed,false);
	assert.notEqual(service.getCorrectionRevision({eventKey:key,seriesId:local.id}),service.getCorrectionRevision({eventKey:key,tid:1}));
	service.setManualOverride({eventKey:key,seriesId:local.id});
	const projected=service.getSnapshot();
	assert.equal(projected.series.length,1); assert.equal(projected.series[0].id,local.id);
	assert.equal(projected.series[0].tid,null); assert.equal(projected.series[0].title,'Beta'); assert.equal(projected.series[0].counts.currentRecordings,1);
	assert.equal(projected.series[0].episodes[0].events[0].resolution.manual.seriesId,local.id);
	assert.equal(projected.hiddenSeries.length,0); assert.deepEqual(manual.getHiddenTids(),[]);
	const unknown={...program,id:'unknown',title:'辞書にない番組',fullTitle:'辞書にない番組',start:program.start+3600000,end:program.end+3600000};
	const unknownKey=eventKey(unknown);
	fs.writeFileSync(ledgerPaths.recorded,JSON.stringify([program,unknown]));service.invalidate();
	assert.equal(service.setManualOverrides({eventKeys:[unknownKey],tid:1}).count,1);
	assert.equal(manual.get(unknownKey).tid,1);manual.remove(unknownKey);service.invalidate();
	assert.equal(service.setManualOverrides({eventKeys:[unknownKey],seriesId:local.id}).count,1);
	assert.equal(manual.get(unknownKey).seriesId,local.id);
	fs.writeFileSync(ledgerPaths.recorded,JSON.stringify([program]));service.invalidate();
	const reloaded=createSeriesManualStore({path:manualPath});
	assert.equal(reloaded.get(key).seriesId,local.id);assert.equal(reloaded.getLocalSeries(empty.id).title,'録画なし');
	assert.equal(reloaded.listLocalSeries('Beta',[program])[0].recordingCount,1);
	fs.writeFileSync(ledgerPaths.recorded,'[]');
	fs.writeFileSync(ledgerPaths.match,JSON.stringify([{schemaVersion:2,key,status:'RECORDED',fullTitle:'Beta',start:program.start,end:program.end,recording:{recordedId:program.id}}]));
	service.invalidate();assert.equal(service.getSnapshot().series.filter(item=>item.counts.currentRecordings>0).length,0);
	assert.ok(manual.getLocalSeries(local.id));assert.ok(manual.getLocalSeries(empty.id));
	fs.writeFileSync(ledgerPaths.recorded,JSON.stringify([program]));service.invalidate();
	service.setManualOverride({eventKey:key,tid:1});manual.setHiddenTid(1,true);service.invalidate();
	assert.equal(service.getSnapshot().hiddenSeries.length,1);
	fs.writeFileSync(ledgerPaths.recorded,'[]');service.invalidate();
	assert.equal(service.getSnapshot().hiddenSeries.length,0);assert.deepEqual(manual.getHiddenTids(),[]);
	fs.writeFileSync(ledgerPaths.recorded,JSON.stringify([program]));service.invalidate();
	assert.equal(service.getSnapshot().series[0].hidden,false);
	service.setManualOverride({eventKey:key,seriesId:local.id});
	assert.throws(()=>manual.removeLocalSeries([local.id],manual.getGeneration()-1),/更新/);
	assert.throws(()=>manual.removeLocalSeries(['syobocal:1'],manual.getGeneration()),/不正/);
	const recordedBefore=fs.readFileSync(ledgerPaths.recorded,'utf8'),matchBefore=fs.readFileSync(ledgerPaths.match,'utf8');
	manual.removeLocalSeries([local.id],manual.getGeneration());
	assert.equal(manual.get(key),null);assert.equal(manual.get(unknownKey),null);assert.ok(manual.getLocalSeries(empty.id));
	assert.equal(parseState(fs.readFileSync(manualPath,'utf8')).localSeries[local.id],undefined);
	assert.equal(fs.readFileSync(ledgerPaths.recorded,'utf8'),recordedBefore);
	assert.equal(fs.readFileSync(ledgerPaths.match,'utf8'),matchBefore);
	assert.throws(()=>manual.set(key,{seriesId:local.id}),/存在しません/);
	const legacy=parseState(JSON.stringify({version:3,generation:2,overrides:{[key]:{tid:1,episode:null}},workRules:{},hiddenTids:[1]}));
	assert.equal(legacy.overrides[key].tid,1);assert.deepEqual(legacy.localSeries,{});
	service.close();
	manual.setHiddenTid(1,true);
	fs.writeFileSync(ledgerPaths.recorded,'[]');

	// Exercise the actual Worker publication, cleanup and local-ID correction token path.
	const {createProgLookupStore}=require('../lib/proglookup-store');
	const {createSeriesService:createBackground}=require('../lib/series-background-service');
	const progLookupPath=path.join(root,'prog.json');
	let background;const waiting=new Set();
	const changed=()=>{for(const check of waiting)check();};
	background=createBackground({...options,progLookupPath,progLookupStore:createProgLookupStore({path:progLookupPath}),onStatus:changed});
	t.after(()=>background.close());
	async function ready(generation=0) {
		await background.request('status');
		await new Promise((resolve,reject)=>{
			const timeout=setTimeout(()=>{waiting.delete(check);reject(new Error('Series worker did not publish: '+JSON.stringify(background.getSnapshot())));},5000);
			function check(){const state=background.getSnapshot();if(state.generation&& !state.building && (state.manualGeneration||0)>=generation){clearTimeout(timeout);waiting.delete(check);resolve();}}
			waiting.add(check);check();
		});
	}
	await ready();
	assert.deepEqual(createSeriesManualStore({path:manualPath}).getHiddenTids(),[]);
	assert.deepEqual(background.getSnapshot().hiddenSeries,[]);
	assert.equal(JSON.parse(await background.request('view',{mode:'overview'})).series.length,0);
	fs.writeFileSync(ledgerPaths.recorded,JSON.stringify([program]));
	await ready();
	const added=JSON.parse(await background.request('createLocalSeries',{title:'Worker original'})).result;
	await ready(added.manualGeneration);
	const search=JSON.parse(await background.request('searchTitles',{q:'Worker'}));
	assert.equal(search.results[0].id,added.id);
	const eventView=JSON.parse(await background.request('view',{mode:'event',event:key}));
	const event=[...eventView.attention.flatMap(group=>group.events),...eventView.series.flatMap(item=>item.episodes.flatMap(episode=>episode.events))].find(row=>row.key===key);
	assert.ok(event);
	const selection={eventKey:key,seriesId:added.id,contextToken:event.correctionToken};
	const validated=JSON.parse(await background.request('previewManualSelection',selection)).result;
	const saved=JSON.parse(await background.request('setManualOverride',{...selection,validationToken:validated.validationToken})).result;
	await ready(saved.manualGeneration);
	const detail=JSON.parse(await background.request('view',{mode:'series',id:added.id}));
	assert.equal(detail.series[0].id,added.id);assert.equal(detail.series[0].tid,null);
	const listed=JSON.parse(await background.request('listLocalSeries',{q:'Worker'}));
	assert.equal(listed.results[0].recordingCount,1);
	await background.request('removeLocalSeries',{ids:[added.id],manualGeneration:listed.manualGeneration});
	assert.equal(createSeriesManualStore({path:manualPath}).get(key),null);
});
