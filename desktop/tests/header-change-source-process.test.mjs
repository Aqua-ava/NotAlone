import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test, after } from 'node:test';
import { build } from 'esbuild';

const directory = await mkdtemp(path.join(tmpdir(),'notalone-header-process-'));
const built=await build({entryPoints:['src/main/foreground/native-change-source.ts'],bundle:true,platform:'node',format:'esm',write:false});
await writeFile(path.join(directory,'source.mjs'),built.outputFiles[0].text);
const {NativeHeaderChangeSource}=await import(path.join(directory,'source.mjs'));
after(()=>rm(directory,{recursive:true,force:true}));
const wait=async(test)=>{const end=performance.now()+3000;while(!await test()&&performance.now()<end)await new Promise(r=>setTimeout(r,10));assert.ok(await test());};

async function script(name,body){const executable=path.join(directory,name);await writeFile(executable,`#!${process.execPath}\n${body}`,{mode:0o700});return executable;}

test('source时钟锚点与原elapsed同基准，仅显式sink取样一次且默认不读墙钟', (t) => {
 let ticks=[100,104,108],epochCalls=0;
 t.mock.method(performance,'now',()=>ticks.shift()??110);
 t.mock.method(Date,'now',()=>{epochCalls++;return 1792000000000;});
 const records=[];
 const source=new NativeHeaderChangeSource(async()=>undefined,{record:record=>records.push(record),close(){}});
 assert.deepEqual(records,[{kind:'clock-anchor',elapsedMs:6,epochMs:1792000000000,sampleSpanMs:4}]);
 source.update(undefined,()=>{});source.update(undefined,()=>{});source.dispose();
 assert.equal(records.filter(record=>record.kind==='clock-anchor').length,1);
 assert.equal(epochCalls,1);
 assert.ok(records.filter(record=>record.kind==='host').every(record=>record.elapsedMs===10));
 epochCalls=0;
 const disabled=new NativeHeaderChangeSource(async()=>undefined);
 disabled.dispose();
 assert.equal(epochCalls,0);
});

test('真实合成子进程只收固定枚举，停用拒绝晚事件且确认旧子退出后替换',async()=>{
 const trace=path.join(directory,'owned-trace.jsonl');
 const executable=await script('events',`
 const fs=require('node:fs');const out=${JSON.stringify(trace)};
 fs.appendFileSync(out,JSON.stringify({event:'start',pid:process.pid,secret:Boolean(process.env.NOTALONE_SYNTHETIC_SECRET),diagnostics:Boolean(process.env.NOTALONE_HEADER_CHANGE_DIAGNOSTICS),argv:process.argv.slice(2)})+'\\n');
 process.stdout.write('{"event":"changed"}\\n');
 process.on('SIGTERM',()=>setTimeout(()=>{process.stdout.write('{"event":"changed"}\\n');fs.appendFileSync(out,JSON.stringify({event:'exit',pid:process.pid})+'\\n');process.exit(0);},100));
 setInterval(()=>{},1000);
 `);
 process.env.NOTALONE_SYNTHETIC_SECRET='must-not-cross';
 const events=[];const source=new NativeHeaderChangeSource(async()=>executable);
 const callback=event=>events.push(event);
 try{
  source.update({scope:'1:1',observation:'first'},callback);await wait(()=>events.length===1);
  source.update(undefined,callback);source.update({scope:'2:1',observation:'second'},callback);
  await wait(async()=>{try{return(await readFile(trace,'utf8')).trim().split('\n').length===3;}catch{return false;}});
  const records=(await readFile(trace,'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(x=>x.event),['start','exit','start']);
  assert.equal(records[0].secret,false);assert.equal(records[0].diagnostics,false);assert.deepEqual(records[0].argv,['--header-change-source','--json']);
  await wait(()=>events.length===2);assert.deepEqual(events,['changed','changed'],'停用后旧子晚事件不能交付');
 }finally{await source.shutdown();delete process.env.NOTALONE_SYNTHETIC_SECRET;}
 await wait(async()=>{try{return(await readFile(trace,'utf8')).trim().split('\n').length===4;}catch{return false;}});
});

test('显式诊断仅透传固定原生行和生命周期，stderr拒绝不改变stdout协议及连续失败锁', async () => {
 const trace=path.join(directory,'diagnostic-trace');
 const executable=await script('diagnostics',`
 require('node:fs').appendFileSync(${JSON.stringify(trace)},JSON.stringify({enabled:process.env.NOTALONE_HEADER_CHANGE_DIAGNOSTICS})+'\\n');
 process.stderr.write('notalone-header-change-v1 streaming first_frame 12.5\\n');
 setTimeout(()=>{process.stderr.write('NSError private-diagnostic-value\\n');process.stdout.write('{"event":"changed"}\\n');},20);
 setTimeout(()=>process.exit(7),60);
 `);
 const records=[],events=[];
 const source=new NativeHeaderChangeSource(async()=>executable,{record:record=>records.push(record),close(){}});
 try{
  source.update(undefined,event=>events.push(event));
  source.update({scope:'private-scope-value',observation:'private-observation-value'},event=>events.push(event));
  await wait(()=>records.some(record=>record.event==='close'));
  source.update({scope:'private-scope-value',observation:'new-private-observation-value'},event=>events.push(event));
  assert.deepEqual(events,['changed','paused']);
  assert.equal((await readFile(trace,'utf8')).trim(),'{"enabled":"1"}');
  assert.equal(records.filter(record=>record.kind==='native').length,1);
  assert.deepEqual(records.find(record=>record.kind==='native'),{kind:'native',ordinal:1,
   elapsedMs:records.find(record=>record.kind==='native').elapsedMs,stage:'streaming',reason:'first_frame',nativeElapsedMs:12.5});
  const closed=records.find(record=>record.event==='close');
  assert.equal(closed.code,7);assert.equal(closed.signal,'none');assert.equal(closed.blocked,true);
  assert.equal(closed.epochCurrent,true);assert.equal(closed.stopping,false);assert.equal(closed.paused,true);
  assert.equal(closed.renewalEligible,false);
  assert.ok(records.some(record=>record.reason==='no_permit'));
  assert.ok(records.some(record=>record.reason==='native_diagnostic_rejected'));
  assert.ok(records.some(record=>record.reason==='scope_blocked'));
  assert.ok(records.every(record=>Number.isFinite(record.elapsedMs)&&record.elapsedMs>=0));
  assert.doesNotMatch(JSON.stringify(records),/private-scope|private-observation|private-diagnostic|NSError/);
 }finally{await source.shutdown();}
});

test('上下文诊断不进入stdout事件，原code1暂停与同scope新proof失败锁保持', async () => {
 const executable=await script('context-diagnostic',`
 process.stderr.write('notalone-header-context-v1 identity_mismatch 111011 12.5\\n');
 process.stdout.write('{"event":"paused"}\\n');
 setTimeout(()=>process.exit(1),30);
 `);
 const records=[],events=[];
 const source=new NativeHeaderChangeSource(async()=>executable,{record:record=>records.push(record),close(){}});
 try{
  source.update({scope:'context-scope',observation:'first'},event=>events.push(event));
  await wait(()=>records.some(record=>record.event==='close'));
  source.update({scope:'context-scope',observation:'fresh'},event=>events.push(event));
  assert.deepEqual(events,['paused']);
  assert.deepEqual(records.find(record=>record.kind==='native-context'),{
   kind:'native-context',ordinal:1,elapsedMs:records.find(record=>record.kind==='native-context').elapsedMs,
   reason:'identity_mismatch',nativeElapsedMs:12.5,processMatches:true,windowMatches:true,
   originMatches:true,sizeMatches:false,versionMatches:true,buildMatches:true});
  const closed=records.find(record=>record.event==='close');
  assert.equal(closed.code,1);assert.equal(closed.paused,true);assert.equal(closed.stopping,false);
  assert.equal(closed.renewalEligible,false);assert.equal(closed.blocked,true);
  assert.equal(records.filter(record=>record.event==='launch').length,1);
  assert.ok(records.some(record=>record.reason==='scope_blocked'&&record.freshProof));
 }finally{await source.shutdown();}
});

test('实例分类仍走原code1失败锁，锚点不随墙钟跳变或fresh proof重复写入', async (t) => {
 let epoch=1792000000000;
 t.mock.method(Date,'now',()=>epoch);
 const executable=await script('instance-clock',`
 process.stderr.write('notalone-header-context-v1 instances_multiple ------ 12.5\\n');
 process.stdout.write('{"event":"paused"}\\n');
 setTimeout(()=>process.exit(1),30);
 `);
 const records=[],events=[];
 const source=new NativeHeaderChangeSource(async()=>executable,{record:record=>records.push(record),close(){}});
 try{
  source.update({scope:'instance-scope',observation:'first'},event=>events.push(event));
  await wait(()=>records.some(record=>record.event==='close'));
  for(const now of [1792086400000,1791913600000]){
   epoch=now;
   source.update({scope:'instance-scope',observation:String(now)},event=>events.push(event));
  }
  assert.deepEqual(events,['paused']);
  assert.equal(records.filter(record=>record.kind==='clock-anchor').length,1);
  assert.equal(records.find(record=>record.kind==='clock-anchor').epochMs,1792000000000);
  const context=records.find(record=>record.kind==='native-context');
  assert.equal(context.reason,'instances_multiple');assert.equal(context.processMatches,null);
  assert.equal(context.windowMatches,null);
  const closed=records.find(record=>record.event==='close');
  assert.equal(closed.code,1);assert.equal(closed.blocked,true);assert.equal(closed.renewalEligible,false);
  assert.equal(records.filter(record=>record.event==='launch').length,1);
  assert.ok(records.some(record=>record.reason==='scope_blocked'&&record.freshProof));
 }finally{await source.shutdown();}
});

test('最终帧分账经真实合成子进程转发，计数不是stdout事件且code1仍锁住连续许可', async () => {
 const executable=await script('capture-counts',`
 process.stderr.write('notalone-header-counts-v1 final 1 5 2 1000\\n');
 process.stdout.write('{"event":"paused"}\\n');
 setTimeout(()=>process.exit(1),30);
 `);
 const records=[],events=[];
 const source=new NativeHeaderChangeSource(async()=>executable,{record:record=>records.push(record),close(){}});
 try{
  source.update({scope:'capture-counts',observation:'first'},event=>events.push(event));
  await wait(()=>records.some(record=>record.event==='close'));
  source.update({scope:'capture-counts',observation:'fresh'},event=>events.push(event));
  assert.deepEqual(events,['paused']);
  const counts=records.find(record=>record.kind==='native-counts');
  assert.deepEqual(counts,{kind:'native-counts',ordinal:1,elapsedMs:counts.elapsedMs,
   status:'final',initialImages:1,screenCallbacks:5,processedFrames:2,nativeElapsedMs:1000});
  const closed=records.find(record=>record.event==='close');
  assert.equal(closed.code,1);assert.equal(closed.blocked,true);assert.equal(closed.renewalEligible,false);
  assert.equal(records.filter(record=>record.event==='launch').length,1);
  assert.ok(records.some(record=>record.reason==='scope_blocked'&&record.freshProof));
 }finally{await source.shutdown();}
});

test('完整合成租期仅凭新鲜正式proof续租；复用proof保留门禁，诊断回调失败不影响停源', async (t) => {
 const originalNow=Date.now;
 let offset=0;
 t.mock.method(Date,'now',()=>originalNow()+offset);
 const executable=await script('lease',`
 process.stdout.write('{"event":"changed"}\\n');
 setTimeout(()=>{process.stdout.write('{"event":"paused"}\\n');process.exit(0);},40);
 `);
 for(const fresh of [false,true]){
  const records=[];
  let changes=0;
  const source=new NativeHeaderChangeSource(async()=>executable,{record:record=>records.push(record),close(){}});
  const listener=event=>{
   if(event==='paused')offset+=55_010;
   if(event==='changed'&&++changes===1&&fresh)source.update({scope:'scope',observation:'fresh-proof'},listener);
   if(event==='changed'&&changes===2)source.update(undefined,listener);
  };
  try{
   source.update({scope:'scope',observation:'original-proof'},listener);
   await wait(()=>records.some(record=>record.event==='close'&&record.ordinal===1));
   const first=records.find(record=>record.event==='close'&&record.ordinal===1);
   assert.equal(first.renewalEligible,true);assert.equal(first.blocked,false);assert.equal(first.freshProof,fresh);
   if(fresh){await wait(()=>changes===2);await wait(()=>records.some(record=>record.event==='close'&&record.ordinal===2));}
   else{assert.ok(records.some(record=>record.reason==='proof_reused'));assert.equal(changes,1);}
  }finally{await source.shutdown();}
 }
 const events=[];
 const faulty=new NativeHeaderChangeSource(async()=>executable,{record(){throw new Error('synthetic sink failure');},close(){}});
 try{faulty.update({scope:'fault',observation:'first'},event=>events.push(event));await wait(()=>events.includes('changed'));}
 finally{await faulty.shutdown();}
});

test('未知或超限输出不转交且同一连续许可不循环重启；异步配置迟到不启动',async()=>{
 const trace=path.join(directory,'invalid-trace');
 const executable=await script('invalid',`require('node:fs').appendFileSync(${JSON.stringify(trace)},'start\\n');process.stdout.write('{"event":"changed","name":"禁止转交"}\\n');setInterval(()=>{},1000);`);
 const events=[];const source=new NativeHeaderChangeSource(async()=>executable);
 try{
  source.update({scope:'1',observation:'a'},event=>events.push(event));
  await wait(async()=>{try{return(await readFile(trace,'utf8')).length>0;}catch{return false;}});
  await new Promise(r=>setTimeout(r,100));
  for(let i=0;i<10;i++)source.update({scope:'1',observation:`b${i}`},event=>events.push(event));
  await new Promise(r=>setTimeout(r,100));
  assert.equal(await readFile(trace,'utf8'),'start\n');assert.deepEqual(events,['paused']);
 }finally{source.dispose();}
 let release;const late=new NativeHeaderChangeSource(()=>new Promise(resolve=>{release=resolve;}));
 late.update({scope:'late',observation:'a'},event=>events.push(event));late.dispose();release(executable);
 await new Promise(r=>setTimeout(r,100));
 assert.equal(await readFile(trace,'utf8'),'start\n');
 const excessive=await script('excessive',`process.stdout.write('x'.repeat(8193));setInterval(()=>{},1000);`);
 const bound=new NativeHeaderChangeSource(async()=>excessive);
 try{bound.update({scope:'bound',observation:'a'},event=>events.push(event));await wait(()=>events.length===2);assert.deepEqual(events,['paused','paused']);}
 finally{bound.dispose();}
});
