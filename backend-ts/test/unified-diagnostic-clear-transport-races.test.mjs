import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,chmod,mkdir,rm,lstat,open,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {configureDiagnosticLog} from '../src/diagnostics/unified.ts';
import {UnifiedDiagnosticLog,readDiagnosticRecords,writeObservedDiagnostic} from '../src/diagnostics/unified-log.mjs';

async function privateRoot(t,mode=0o700){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-clear-races-'))),cleanups=[];
 await chmod(root,0o700);await mkdir(join(root,'logs'),{mode:0o700});await chmod(root,mode);
 t.after(async()=>{try{for(const cleanup of cleanups.reverse())await cleanup();}finally{await rm(root,{recursive:true,force:true});}});
 return {root,closeWith:cleanup=>cleanups.push(cleanup)};
}

test('属主持有且不可被他人写入的0755资料根继续支持0700日志目录和清除',async t=>{
 const f=await privateRoot(t,0o755),log=new UnifiedDiagnosticLog(f.root,{proc:'main'});f.closeWith(()=>log.close());
 log.diagnose({event:'diagnostics.changed',count:1});await log.flush();
 assert.equal(log.stats().available,true);
 assert.equal((await lstat(f.root)).mode&0o777,0o755);
 assert.equal((await lstat(join(f.root,'logs'))).mode&0o777,0o700);
 assert.deepEqual((await readDiagnosticRecords(f.root)).map(row=>row.count),[1]);
 assert.equal(await log.clear(),true);
 log.diagnose({event:'diagnostics.changed',count:2});await log.flush();
 assert.deepEqual((await readDiagnosticRecords(f.root)).map(row=>row.count),[2]);
});

// 仅在真实Node Worker的投递边界暂存原包；不改业务动作、SQL、回执或诊断封套。
function holdCommittedDiagnostic(storage){
 const worker=storage.worker,listeners=worker.listeners('message'),held=Promise.withResolvers();let packet,released=false;
 worker.removeAllListeners('message');
 const receive=message=>{
  if(!packet&&message.diagnostics?.some(event=>event.event==='processing.task_changed')){packet=message;held.resolve();return;}
  for(const listener of listeners)listener.call(worker,message);
 };
 worker.on('message',receive);
 return {received:held.promise,release(){
  if(released)return;released=true;worker.removeListener('message',receive);
  for(const listener of listeners)worker.on('message',listener);
  if(packet)worker.emit('message',packet);
 }};
}

test('真实SQLite已提交诊断包在全清除后才投递，不得恢复旧状态事件',{timeout:10000},async t=>{
 const f=await privateRoot(t),log=configureDiagnosticLog(f.root,{proc:'backend',development:true});f.closeWith(()=>log.close());
 await log.flush();
 const storage=await SqliteStorage.open({userData:f.root,intent:'create',role:'test',registryModule:new URL('./fixtures/sqlite/unified-diagnostic-registry.mjs',import.meta.url).href});f.closeWith(()=>storage.close());
 const held=holdCommittedDiagnostic(storage),operation=storage.execute('diagnostic.commit',{});
 try{
  await held.received;assert.equal(await log.clear(),true);
  held.release();assert.equal(await operation,true);await log.flush();
  assert.equal((await readDiagnosticRecords(f.root)).filter(row=>row.event==='processing.task_changed').length,0);
  log.diagnose({event:'diagnostics.changed',count:17});await log.flush();
  assert.deepEqual((await readDiagnosticRecords(f.root)).map(row=>[row.event,row.count]),[['diagnostics.changed',17]]);
 }finally{held.release();await operation.catch(()=>{});}
});

test('同trace的旧回放和新SQL观察不跨清除屏障合并',async t=>{
 for(const oldFirst of [true,false])await t.test(oldFirst?'旧观察先入队':'新观察先入队',async t=>{
  const f=await privateRoot(t),log=new UnifiedDiagnosticLog(f.root,{proc:'backend',development:true});f.closeWith(()=>log.close());await log.flush();
  const observedAt=Date.now(),observedNs=process.hrtime.bigint();assert.equal(await log.clear(),true);
  const event={event:'sql.summary',module:'memory.management',caller:'sqlite_worker',traceId:'11111111-1111-4111-8111-111111111111',sqlFingerprint:'a'.repeat(64),count:1};
  const old=()=>writeObservedDiagnostic(log,{...event,durationMs:1},observedAt,observedNs),fresh=()=>log.diagnose({...event,durationMs:2});
  if(oldFirst){old();fresh();}else{fresh();old();}await log.flush();
  const rows=await readDiagnosticRecords(f.root);
  assert.deepEqual(rows.map(({event,count,durationMs})=>({event,count,durationMs})),[{event:'sql.summary',count:1,durationMs:2}]);
  assert.doesNotMatch(JSON.stringify(rows),/observedNs|clearedNs/);
 });
});

test('控制原件与原子临时文件同时存在时，含孤儿清理的实际磁盘峰值仍不越总预算',{timeout:10000},async t=>{
 const f=await privateRoot(t),totalBudget=8192;
 const main=new UnifiedDiagnosticLog(f.root,{proc:'main',maxTotalBytes:totalBudget,maxFileBytes:512});
 const backend=new UnifiedDiagnosticLog(f.root,{proc:'backend',maxTotalBytes:totalBudget,maxFileBytes:512});
 f.closeWith(async()=>{await main.close();await backend.close();});await Promise.all([main.flush(),backend.flush()]);
 const directory=join(f.root,'logs'),now=Date.now(),prefixes=[];
 const control=()=>JSON.stringify({version:1,epoch:0,clearedAt:0,clearedNs:'0',prefixes});
 for(let n=0;n<4096;n++){
  prefixes.push({prefix:n.toString(16).padStart(8,'0'),createdAt:now,expiresAt:now+14*86400_000});
  if(Buffer.byteLength(control())>main.controlBudget-64){prefixes.pop();break;}
 }
 const original=control();assert.ok(Buffer.byteLength(original)>main.controlBudget/2);
 await writeFile(join(directory,'diagnostic-control.json'),original,{mode:0o600});
 const orphan=join(directory,`.diagnostic-control-${randomUUID()}.tmp`);await writeFile(orphan,original,{mode:0o600});
 // 按两个真实写者各自的预算填满普通日志，不把测试的预算换算复制为被测实现。
 const day=new Date(now).toISOString().slice(0,10);
 for(const [proc,log] of [['main',main],['backend',backend]]){
  for(let remaining=log.processBudget,number=1;remaining>0;number++){
   const bytes=Math.min(512,remaining);await writeFile(join(directory,`${proc}-${day}-${number}.jsonl`),'\n'.repeat(bytes),{mode:0o600});remaining-=bytes;
  }
 }
 const bytesOnDisk=async()=>{let bytes=0;for(const name of await readdir(directory)){const stat=await lstat(join(directory,name));assert.ok(stat.isFile());assert.equal(stat.mode&0o777,0o600);bytes+=stat.size;}return bytes;};
 const before=await bytesOnDisk();assert.ok(before<=totalBudget);
 const probe=join(f.root,'prototype'),handle=await open(probe,'wx',0o600),prototype=Object.getPrototypeOf(handle),originalSync=prototype.sync;
 await handle.close();await rm(probe);
 const atSync=Promise.withResolvers(),resume=Promise.withResolvers();let held=false;
 t.mock.method(prototype,'sync',async function(...args){
  const value=await originalSync.apply(this,args),current=await this.stat();
  for(const name of await readdir(directory)){
   if(!/^\.diagnostic-control-.*\.tmp$/.test(name))continue;
   const candidate=await lstat(join(directory,name));
   if(!held&&candidate.dev===current.dev&&candidate.ino===current.ino){held=true;atSync.resolve();await resume.promise;}
  }
  return value;
 });
 const clearing=main.clear();
 try{
  await Promise.race([atSync.promise,clearing.then(()=>{throw new Error('control_replace_gate_not_reached');})]);
  await assert.rejects(lstat(orphan),{code:'ENOENT'});
  const during=await bytesOnDisk();assert.ok(during<=totalBudget,`同步门闩处磁盘占用${during}超过预算${totalBudget}`);
  t.diagnostic(JSON.stringify({totalBudget,beforeBytes:before,replacePeakBytes:during}));
 }finally{resume.resolve();await clearing;}
 assert.equal(await clearing,true);assert.ok(await bytesOnDisk()<=totalBudget);
});
