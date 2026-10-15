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
const wait=async(test)=>{const end=Date.now()+3000;while(!await test()&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.ok(await test());};

async function script(name,body){const executable=path.join(directory,name);await writeFile(executable,`#!${process.execPath}\n${body}`,{mode:0o700});return executable;}

test('真实合成子进程只收固定枚举，停用拒绝晚事件且确认旧子退出后替换',async()=>{
 const trace=path.join(directory,'owned-trace.jsonl');
 const executable=await script('events',`
 const fs=require('node:fs');const out=${JSON.stringify(trace)};
 fs.appendFileSync(out,JSON.stringify({event:'start',pid:process.pid,secret:Boolean(process.env.NOTALONE_SYNTHETIC_SECRET),argv:process.argv.slice(2)})+'\\n');
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
  assert.equal(records[0].secret,false);assert.deepEqual(records[0].argv,['--header-change-source','--json']);
  await wait(()=>events.length===2);assert.deepEqual(events,['changed','changed'],'停用后旧子晚事件不能交付');
 }finally{await source.shutdown();delete process.env.NOTALONE_SYNTHETIC_SECRET;}
 await wait(async()=>{try{return(await readFile(trace,'utf8')).trim().split('\n').length===4;}catch{return false;}});
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
