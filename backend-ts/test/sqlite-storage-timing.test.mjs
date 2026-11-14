import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {configureDiagnosticLog} from '../src/diagnostics/unified.ts';
import {readDiagnosticRecords} from '../src/diagnostics/unified-log.mjs';

async function fixture(t){
 const userData=await realpath(await mkdtemp(join(tmpdir(),'notalone-sqlite-timing-')));
 const storage=await SqliteStorage.open({userData,intent:'create',role:'test',registryModule:new URL('./fixtures/sqlite/timing-registry.mjs',import.meta.url).href});
 t.after(async()=>{await storage.close();await rm(userData,{recursive:true,force:true});});
 return storage;
}

test('正常关闭及其Worker退出不产生故障诊断',async t=>{
 const storage=await fixture(t);await storage.close();assert.equal(storage.failureDiagnostic,null);
});

test('串行慢动作总排队超过15秒时，每个动作按实际执行起点计时',async t=>{
 const storage=await fixture(t),started=performance.now();
 const results=await Promise.all([1,2,3].map(sequence=>storage.execute('timing.block',{milliseconds:6_000,sequence})));
 assert.deepEqual(results,[1,2,3]);assert.ok(performance.now()-started>=18_000);
 assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
 assert.equal(storage.failureDiagnostic,null);
});

test('前台回复动作优先于已排队的后台动作，且各通道内保持先进先出',async t=>{
 const storage=await fixture(t),order=[];
 const track=(label,work)=>work.then(value=>{order.push(label);return value;});
 // 首个动作在调用时即进入 Worker，其后的请求必然排在它后面。
 const work=[track('running',storage.execute('timing.block',{milliseconds:150,sequence:'running'})),
  track('background-1',storage.execute('timing.block',{milliseconds:10,sequence:'background-1'})),
  track('background-2',storage.execute('timing.block',{milliseconds:10,sequence:'background-2'})),
  track('foreground-1',storage.execute('discussion.timingProbe',{sequence:'foreground-1'})),
  track('foreground-2',storage.execute('discussion.timingProbe',{sequence:'foreground-2'}))];
 await Promise.all(work);
 assert.deepEqual(order,['running','foreground-1','foreground-2','background-1','background-2']);
 const diagnostic=storage.timingDiagnostic;
 assert.equal(diagnostic.pendingCount,0);assert.equal(diagnostic.queuedCount,0);
 assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('生成所需的分组范围优先读取，分组管理写入及相近动作仍按后台顺序完成',async t=>{
 const storage=await fixture(t),order=[];
 const track=(label,name,input)=>storage.execute(name,{...input,sequence:label}).then(value=>{assert.equal(value,label);order.push(label);});
 const work=[track('running','timing.block',{milliseconds:150}),
  track('background-1','timing.block',{milliseconds:10}),
  track('management-1','skillGroups.assign',{}),
  track('scope-1','skillGroups.scope',{}),
  track('reply','discussion.timingProbe',{}),
  track('scope-2','skillGroups.scope',{}),
  track('management-2','skillGroups.assign',{}),
  track('unknown-scope','skillGroups.scopeExtra',{}),
  track('background-2','timing.block',{milliseconds:10})];
 await Promise.all(work);
 assert.deepEqual(order,['running','scope-1','reply','scope-2','background-1','management-1','management-2','unknown-scope','background-2']);
 assert.equal(storage.timingDiagnostic.pendingCount,0);assert.equal(storage.timingDiagnostic.queuedCount,0);
 assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('单个动作超过15秒仍关闭Worker并拒绝其后排队动作',async t=>{
 const storage=await fixture(t),started=performance.now();
 const results=await Promise.allSettled([
  storage.execute('timing.block',{milliseconds:20_000,sequence:'合成敏感输入'}),
  storage.execute('timing.block',{milliseconds:1,sequence:'不能执行'}),
 ]);
 assert.ok(results.every(result=>result.status==='rejected'&&result.reason.code==='worker_failed'));
 assert.ok(performance.now()-started>=14_500);assert.ok(performance.now()-started<19_000);
 assert.deepEqual(storage.failureDiagnostic,{cause:'action_timeout',action:'timing.block',pendingCount:2,queuedCount:1});
 assert.ok(Object.isFrozen(storage.failureDiagnostic));
 await assert.rejects(storage.check(),{code:'worker_failed'});
 const first=storage.failureDiagnostic;await storage.close();assert.deepEqual(storage.failureDiagnostic,first);
});

test('离线维护工具可经 actionTimeoutMs 放宽单动作预算，缺省仍按15秒',async t=>{
 const userData=await realpath(await mkdtemp(join(tmpdir(),'notalone-sqlite-timing-')));
 const registryModule=new URL('./fixtures/sqlite/timing-registry.mjs',import.meta.url).href;
 const created=await SqliteStorage.open({userData,intent:'create',role:'test',registryModule});
 const databaseId=created.status.databaseId;await created.close();
 t.after(()=>rm(userData,{recursive:true,force:true}));
 const relaxed=await SqliteStorage.open({userData,intent:'open',role:'test',expectedDatabaseId:databaseId,registryModule,actionTimeoutMs:60_000});
 try{assert.equal(await relaxed.execute('timing.block',{milliseconds:16_000,sequence:'长动作'}),'长动作');assert.equal(relaxed.failureDiagnostic,null);}
 finally{await relaxed.close();}
});

for(const [name,cause]of[['timing.exit','worker_exit'],['timing.error','worker_error']])test(`Worker异常只保留首个非敏感诊断：${cause}`,async t=>{
 const storage=await fixture(t);
 await Promise.allSettled([storage.execute(name,{private:'不得出现在诊断'}),storage.execute('timing.block',{milliseconds:100,sequence:'私密'})]);
 await assert.rejects(storage.check(),{code:'worker_failed'});
 const diagnostic=storage.failureDiagnostic;
 assert.equal(diagnostic.cause,cause);assert.ok(diagnostic.pendingCount>0);
 assert.deepEqual(Object.keys(diagnostic).filter(key=>!['cause','action','pendingCount','queuedCount'].includes(key)),[]);
 assert.doesNotMatch(JSON.stringify(diagnostic),/私密|不得|private|SELECT|Error/);
 await storage.close();assert.deepEqual(storage.failureDiagnostic,diagnostic);
});

test('存储诊断区分排队和执行，只保留有界的具名动作计时',async t=>{
 const userData=await realpath(await mkdtemp(join(tmpdir(),'notalone-storage-timing-')));
 const storage=await SqliteStorage.open({userData,intent:'create',role:'test',registryModule:new URL('./fixtures/sqlite/readonly-registry.mjs',import.meta.url).href});
 const barrier=new Int32Array(new SharedArrayBuffer(8));
 t.after(async()=>{Atomics.store(barrier,1,1);Atomics.notify(barrier,1);await storage.close();await rm(userData,{recursive:true,force:true});});
 const held=storage.execute('reader.hold',{barrier:barrier.buffer,privateText:'合成敏感正文不能进入诊断'});
 await Atomics.waitAsync(barrier,0,0,5000).value;
 assert.equal(Atomics.load(barrier,0),1);
 const reading=storage.execute('reader.value',{});
 // 固定占用一小段时间，验证真实 Worker 队列；不以轮询等待就绪。
 await new Promise(resolve=>setTimeout(resolve,80));
 Atomics.store(barrier,1,1);Atomics.notify(barrier,1);
 assert.deepEqual(await Promise.all([held,reading]),[7n,7n]);
 const diagnostic=storage.timingDiagnostic;
 assert.ok(diagnostic,'应提供无正文的排队与执行诊断');
 const execution=diagnostic.recent.find(row=>row.action==='reader.hold');
 const queued=diagnostic.recent.find(row=>row.action==='reader.value');
 assert.ok(execution.executionMs>=50,'占用记录应体现 Worker 执行时间');
 assert.ok(queued.queuedMs>=50,'后续读取应体现排队时间');
 assert.equal(diagnostic.pendingCount,0);
 assert.equal(diagnostic.queuedCount,0);
 assert.doesNotMatch(JSON.stringify(diagnostic),/合成敏感|privateText|barrier/);
 for(let i=0;i<70;i++)await storage.execute('reader.value',{});
 assert.ok(storage.timingDiagnostic.recent.length<=3,'状态接口只返回少量摘要');
 assert.ok(JSON.stringify(storage.timingDiagnostic).length<1000,'计时摘要不可撑大受控状态响应');
});

test('维护动作不受普通15秒预算限制：长压缩期间状态保持可用，排队动作等其结束',async t=>{
 const storage=await fixture(t),started=performance.now();
 const maintaining=storage.execute('timing.maintain',{milliseconds:17_000,sequence:'compact'});
 const queued=storage.execute('timing.block',{milliseconds:1,sequence:'after'});
 // 越过普通动作的15秒点后，句柄仍应可用，诊断指出正在执行的是维护动作。
 await new Promise(resolve=>setTimeout(resolve,15_800));
 assert.doesNotThrow(()=>storage.verifyIdentity());
 assert.equal(storage.failureDiagnostic,null);
 assert.equal(storage.timingDiagnostic.active.action,'timing.maintain');
 assert.deepEqual(await Promise.all([maintaining,queued]),[{result:'passed',proof:'compact'},'after']);
 assert.ok(performance.now()-started>=16_500);
 assert.equal(storage.failureDiagnostic,null);
 assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('维护动作仍有上限：超过自己的预算关闭Worker并保留诊断',async t=>{
 const userData=await realpath(await mkdtemp(join(tmpdir(),'notalone-sqlite-maintenance-')));
 const storage=await SqliteStorage.open({userData,intent:'create',role:'test',maintenanceTimeoutMs:400,registryModule:new URL('./fixtures/sqlite/timing-registry.mjs',import.meta.url).href});
 t.after(async()=>{await storage.close();await rm(userData,{recursive:true,force:true});});
 const started=performance.now();
 await assert.rejects(storage.execute('timing.maintain',{milliseconds:3_000,sequence:'hung'}),{code:'worker_failed'});
 assert.ok(performance.now()-started>=350);assert.ok(performance.now()-started<2_500);
 assert.deepEqual(storage.failureDiagnostic,{cause:'action_timeout',action:'timing.maintain',pendingCount:1,queuedCount:0});
 assert.throws(()=>storage.verifyIdentity(),{code:'worker_failed'});
});

test('动作超时终止存储线程时留下受控动作名、持续时间与请求编号，不含输入内容',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-storage-failed-diag-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const log=configureDiagnosticLog(root,{proc:'backend',development:true});t.after(()=>log.close());
 const userData=await realpath(await mkdtemp(join(tmpdir(),'notalone-sqlite-timing-')));t.after(()=>rm(userData,{recursive:true,force:true}));
 const storage=await SqliteStorage.open({userData,intent:'create',role:'test',actionTimeoutMs:300,registryModule:new URL('./fixtures/sqlite/timing-registry.mjs',import.meta.url).href});
 t.after(()=>storage.close());
 const results=await Promise.allSettled([storage.execute('timing.block',{milliseconds:5_000,sequence:'合成敏感输入'}),storage.execute('timing.block',{milliseconds:1,sequence:'不能执行'})]);
 assert.ok(results.every(result=>result.status==='rejected'));
 await log.flush();
 const failed=(await readDiagnosticRecords(root)).filter(row=>row.event==='storage.failed');
 assert.equal(failed.length,1,'一次失效只记录一次');
 const [row]=failed;
 assert.equal(row.reasonCode,'action_timeout');assert.equal(row.action,'timing.block');assert.equal(row.count,2);assert.equal(row.level,'error');
 assert.ok(row.durationMs>=250&&row.durationMs<3_000,'持续时间应接近动作超时上限');
 assert.doesNotMatch(JSON.stringify(row),/合成敏感输入|不能执行/);
});
