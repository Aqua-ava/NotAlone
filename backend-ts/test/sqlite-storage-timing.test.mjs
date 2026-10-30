import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';

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
