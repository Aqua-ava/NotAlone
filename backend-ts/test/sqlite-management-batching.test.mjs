import {fixture as sourceFixture,owner as sourceOwner,record} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,realpath,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {managementDerivedTriggerNames} from '../src/memory/sqlite/management/batching-schema.ts';
import {registry as currentRegistry} from '../src/storage/sqlite/registry.ts';
async function fixture(t,legacy=false){
 const userData=await realpath(await mkdtemp(path.join(tmpdir(),'na-d-batch-'))),module=new URL('./fixtures/memory-management/d-batch-registry.mjs',import.meta.url);
 if(legacy)module.searchParams.set('legacy','1');
 let storage=await SqliteStorage.open({userData,intent:'create',role:'test',registryModule:module.href});
 t.after(async()=>{await storage.close();await rm(userData,{recursive:true,force:true});});await storage.execute('fixture.batchSeed',{});
 return {get storage(){return storage;},set storage(value){storage=value;},userData};
}

test('同事务重复头更新按范围收尾一次，精确修订及时间线标脏不变',async t=>{
 const f=await fixture(t),manual=await f.storage.execute('fixture.batchManual',{count:1});await f.storage.execute('fixture.batchAudit',{});
 const changed=await f.storage.execute('fixture.batchTouch',{memoryId:manual.ids[0],count:100,dirty:0});
 assert.equal(changed.revisionDelta,200n);assert.equal(changed.dirty,1n);
 assert.equal(changed.audit.find(row=>row.kind==='contact').n,2n,'准备写一次，整批头更新只收尾写一次');
 assert.equal(changed.audit.find(row=>row.kind==='memory').n,102n,'原动作100次头更新，加准备和首次dirty实际写');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});


test('提交回滚和SAVEPOINT回滚均撤销聚合增量，不把失败重试带入下一事务',async t=>{
 const f=await fixture(t),manual=await f.storage.execute('fixture.batchManual',{count:1});
 const before=await f.storage.execute('fixture.batchState',{});
 await assert.rejects(f.storage.execute('fixture.batchTouch',{memoryId:manual.ids[0],count:13,dirty:0,fail:true}));
 assert.deepEqual(await f.storage.execute('fixture.batchState',{}),before);
 for(const flushInSavepoint of [false,true]){
  const kept=await f.storage.execute('fixture.batchSavepoint',{memoryId:manual.ids[0],flushInSavepoint});assert.equal(kept.revisionDelta,2n);
 }
 const stable=await f.storage.execute('fixture.batchState',{});
 await assert.rejects(f.storage.execute('fixture.batchSavepoint',{memoryId:manual.ids[0],fail:true}));
 assert.deepEqual(await f.storage.execute('fixture.batchState',{}),stable);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('同事务先写入再走正式分页读取时，返回游标立即可用于后续请求',async t=>{
 const f=await fixture(t),first=await f.storage.execute('fixture.batchCreateAndRead',{count:21});
 assert.equal(first.memories.length,20);assert.ok(first.page.nextCursor);assert.equal(first.page.preparing,undefined);
 const second=await f.storage.execute('memory.read',{ownerId:'owner-a',scope:{scopeKind:'contact',contactId:'contact-a'},cursor:first.page.nextCursor});
 assert.equal(second.page.revision,first.page.revision);assert.equal(second.memories.length,1);
 assert.equal(first.memories.some(memory=>memory.id===second.memories[0].id),false);
});

test('v49参照与批量化对self/contact、已标脏/未标脏和候选批量的修订完全一致',async t=>{
 const old=await fixture(t,true),current=await fixture(t),traces=[];
 for(const f of [old,current]){
  const trace=[];
  for(const self of [false,true]){
   const made=await f.storage.execute('fixture.batchManual',{count:12,self});trace.push(made.revisionDelta);
   for(const dirty of [0,1]){
    const touched=await f.storage.execute('fixture.batchTouch',{memoryId:made.ids[0],count:37,self,dirty,readPage:true});trace.push(touched.revisionDelta,touched.dirty);
   }
   trace.push((await f.storage.execute('fixture.batchCandidates',{count:73,self})).revisionDelta);
  }
  const state=await f.storage.execute('fixture.batchState',{});trace.push(state.owner,state.contact,state.memories.map(memory=>memory.dirty));traces.push(trace);
 }
 assert.deepEqual(traces[1],traces[0]);
});


test('49升级50只移走20条派生维护，旧账本和5条业务原子触发器保持，重开继续聚合',async t=>{
 const f=await fixture(t,true);await f.storage.execute('fixture.batchManual',{count:3});
 const state=await f.storage.execute('fixture.batchState',{}),schema=await f.storage.execute('fixture.batchSchema',{}),databaseId=f.storage.status.databaseId;
 await f.storage.close();f.storage=await SqliteStorage.open({userData:f.userData,intent:'open',expectedDatabaseId:databaseId,role:'test',registryModule:new URL('./fixtures/memory-management/d-batch-registry.mjs',import.meta.url).href});
 assert.equal(f.storage.status.schemaVersion,currentRegistry.migrations.length);assert.deepEqual(await f.storage.execute('fixture.batchState',{}),state);
 const next=await f.storage.execute('fixture.batchSchema',{});assert.deepEqual(next.ledger.slice(0,49),schema.ledger);
 // 53版仅调整来源资格递归的连接顺序，其余业务触发器仍与49版逐项一致。
 const expected=schema.triggers.filter(row=>!managementDerivedTriggerNames.includes(row.name));
 assert.deepEqual(next.triggers.map(row=>row.name),expected.map(row=>row.name));
 assert.deepEqual(next.triggers.filter(row=>row.name!=='step_input_scope'),expected.filter(row=>row.name!=='step_input_scope'));
 assert.equal(next.temporary.filter(row=>managementDerivedTriggerNames.includes(row.name)).length,20);
 for(const name of ['auto_noop_consume','noop_candidate_removed','document_publication_identity_insert','document_identity_task_cleanup','document_identity_input_cleanup'])assert.ok(next.triggers.some(row=>row.name===name),name);
 await f.storage.close();f.storage=await SqliteStorage.open({userData:f.userData,intent:'open',expectedDatabaseId:databaseId,role:'test',registryModule:new URL('./fixtures/memory-management/d-batch-registry.mjs',import.meta.url).href});
 assert.equal((await f.storage.execute('fixture.batchCandidates',{count:3})).revisionDelta,3n);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('50之后升级失败完整回滚触发器替换，原49库仍可原样读写',async t=>{
 const f=await fixture(t,true),schema=await f.storage.execute('fixture.batchSchema',{}),databaseId=f.storage.status.databaseId;
 await f.storage.close();
 const fail=new URL('./fixtures/memory-management/d-batch-registry.mjs?failing=1',import.meta.url).href;
 await assert.rejects(SqliteStorage.open({userData:f.userData,intent:'open',expectedDatabaseId:databaseId,role:'test',registryModule:fail}),{code:'storage_invalid'});
 f.storage=await SqliteStorage.open({userData:f.userData,intent:'open',expectedDatabaseId:databaseId,role:'test',registryModule:new URL('./fixtures/memory-management/d-batch-registry.mjs?legacy=1',import.meta.url).href});
 assert.deepEqual(await f.storage.execute('fixture.batchSchema',{}),schema);assert.equal((await f.storage.execute('fixture.batchCandidates',{count:2})).revisionDelta,2n);
});


test('全部20条派生维护在混合引用迁出迁入、版本红删和候选删除中与49逐阶段一致',async t=>{
 const traces=[];
 for(const legacy of [true,false]){
  const module=new URL('./fixtures/memory-management/d-batch-registry.mjs',import.meta.url);if(legacy)module.searchParams.set('legacy','1');
  const f=await sourceFixture(t,{registryModule:module.href});
  f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:'合成的独立来源语句。'})],completedPartitions:['shard-a'],exhausted:true});
  const contactId=f.saved[0].contact_id,scope={scopeKind:'contact',contactId};await f.service.synchronize(contactId);await f.contacts.setReading(false);
  const management=new SqliteMemoryManagement(f.storage,sourceOwner),made=await management.decide({requestKey:'mixed-first',action:'manual',scope,body:'合成记忆第一版'});
  await f.storage.execute('fixture.paginationUpgradeCitations',{ownerId:sourceOwner,contactId,memoryId:made.memoryId,count:3});
  const first=(await management.read(scope,{memoryId:made.memoryId})).memories[0];
  await management.decide({requestKey:'mixed-correct',action:'correct',memoryId:made.memoryId,expectedVersionNo:first.current.versionNo,expectedHeadRevision:first.headRevision,body:'合成记忆第二版'});
  await management.read(scope);
  traces.push(await f.storage.execute('fixture.batchExerciseChildren',{ownerId:sourceOwner,contactId,memoryId:made.memoryId,count:29}));
  assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});await f.service.close();
 }
 assert.deepEqual(traces[1],traces[0]);
});


test('结清部分范围后失败即使被动作吞掉也整事务回滚，下次动作重新开始',async t=>{
 const f=await fixture(t),before=await f.storage.execute('fixture.batchState',{});
 await assert.rejects(f.storage.execute('fixture.batchCaughtFlushFailure',{}),{code:'storage_invalid'});
 assert.deepEqual(await f.storage.execute('fixture.batchState',{}),before);
 assert.equal((await f.storage.execute('fixture.batchCandidates',{count:3})).revisionDelta,3n);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});


test('带未结清self/contact增量删除父范围后，不能把旧增量应用到同键新范围',async t=>{
 for(const legacy of [true,false]){
  const f=await fixture(t,legacy);
  assert.deepEqual(await f.storage.execute('fixture.batchParentDelete',{}),{owner:0n,contact:0n});
  assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 }
});
