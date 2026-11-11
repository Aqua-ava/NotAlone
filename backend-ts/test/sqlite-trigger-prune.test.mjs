import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';

const current=new URL('./fixtures/sqlite/trigger-prune-registry.mjs',import.meta.url).href;
const legacy=new URL('./fixtures/sqlite/trigger-prune-legacy-registry.mjs',import.meta.url).href;
const failing=new URL('./fixtures/sqlite/trigger-prune-failing-registry.mjs',import.meta.url).href;
const removed=[
 'adjudication_operation_step','auto_noop_execution','candidate_real_producer','capture_record_binding',
 'decision_candidate_scope','document_basis_producer','document_member_scope','document_producer_scope',
 'document_publication_scope','document_task_basis_fixed','grant_verification_generation','media_head_kind',
 'memory_version_decision','reply_execution_input_scope','reply_version_call','runtime_commit_request',
 'runtime_context_scope','skill_default_enabled_update_guard',
];
async function fixture(t,registryModule=current){
 const userData=await realpath(await mkdtemp(join(tmpdir(),'na-trigger-prune-')));
 let storage=await SqliteStorage.open({userData,intent:'create',role:'test',registryModule});
 t.after(async()=>{await storage?.close();await rm(userData,{recursive:true,force:true});});
 return {userData,get storage(){return storage;},set storage(next){storage=next;}};
}

test('默认启用在正式写入口拒绝失效修订，并回滚同事务先前写入',async t=>{
 const f=await fixture(t);await f.storage.execute('fixture.triggerSeed',{});
 const input={ownerId:'owner-a',id:'skill-a',expectedHead:1n};
 await assert.rejects(f.storage.execute('skills.defaultEnable',input),{code:'skill_default_enable_not_qualified'});
 await assert.rejects(f.storage.execute('fixture.rollbackInvalidSkill',input),{code:'skill_default_enable_not_qualified'});
 const state=await f.storage.execute('fixture.triggerState',{});
 assert.deepEqual(state.owners.map(row=>row.owner_id),['owner-a']);
 assert.deepEqual(state.skill,{default_enabled:0n,head_revision:1n});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('新建库仅去掉已由正式写入口复验的18条触发器，外键仍拒绝跨归属坏输入',async t=>{
 const f=await fixture(t);
 assert.equal(f.storage.status.schemaVersion,49);
 const triggers=await f.storage.execute('fixture.triggerNames',{}),names=triggers.map(row=>row.name);
 assert.equal(names.length,102);
 for(const name of removed)assert.equal(names.includes(name),false,name);
 for(const name of ['memory_citation_scope','grant_revocation_final','execution_input_immutable','memory_candidate_management_insert','memory_citation_timeline_insert'])assert.ok(names.includes(name),name);
 await assert.rejects(f.storage.execute('fixture.invalidContact',{}),{code:'storage_invalid'});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('48升级49仅调整指定触发器，原迁移账本与资料不变且重开幂等',async t=>{
 const f=await fixture(t,legacy);await f.storage.execute('fixture.triggerSeed',{});
 const before=await f.storage.execute('fixture.triggerState',{}),oldTriggers=await f.storage.execute('fixture.triggerNames',{});
 const databaseId=f.storage.status.databaseId;await f.storage.close();
 f.storage=await SqliteStorage.open({userData:f.userData,intent:'open',role:'test',registryModule:current,expectedDatabaseId:databaseId});
 assert.equal(f.storage.status.schemaVersion,49);
 const after=await f.storage.execute('fixture.triggerState',{});
 assert.deepEqual(after.owners,before.owners);assert.deepEqual(after.skill,before.skill);
 assert.deepEqual(after.migrations.slice(0,48),before.migrations);
 const afterTriggers=await f.storage.execute('fixture.triggerNames',{});
 assert.deepEqual(afterTriggers.filter(row=>row.name!=='memory_timeline_update'),oldTriggers.filter(row=>!removed.includes(row.name)&&row.name!=='memory_timeline_update'));
 assert.ok(afterTriggers.some(row=>row.name==='memory_timeline_update'));
 await f.storage.close();
 f.storage=await SqliteStorage.open({userData:f.userData,intent:'open',role:'test',registryModule:current,expectedDatabaseId:databaseId});
 assert.deepEqual(await f.storage.execute('fixture.triggerState',{}),after);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('后续升级失败会回滚49的触发器清理，48库可原样重开',async t=>{
 const f=await fixture(t,legacy);await f.storage.execute('fixture.triggerSeed',{});
 const before=await f.storage.execute('fixture.triggerState',{}),oldTriggers=await f.storage.execute('fixture.triggerNames',{});
 const databaseId=f.storage.status.databaseId;await f.storage.close();
 await assert.rejects(SqliteStorage.open({userData:f.userData,intent:'open',role:'test',registryModule:failing,expectedDatabaseId:databaseId}),{code:'storage_invalid'});
 f.storage=await SqliteStorage.open({userData:f.userData,intent:'open',role:'test',registryModule:legacy,expectedDatabaseId:databaseId});
 assert.deepEqual(await f.storage.execute('fixture.triggerNames',{}),oldTriggers);
 assert.deepEqual(await f.storage.execute('fixture.triggerState',{}),before);
});

test('已标脏记忆的重复头更新减少行写，self/contact修订增量和失败回滚不变',async t=>{
 const f=await fixture(t);await f.storage.execute('fixture.triggerSeed',{});
 for(const self of [false,true]){
  const result=await f.storage.execute('memory.applyDecision',{ownerId:'owner-a',request:{requestKey:`timeline-${self}`,action:'manual',scope:{scopeKind:self?'self':'contact',contactId:self?null:'contact-a'},body:'合成时间线记忆'}});
  for(const dirty of [0,1]){
   const observed=await f.storage.execute('fixture.timelineWrites',{memoryId:result.memoryId,self,dirty,count:10});
   assert.equal(observed.dirty,1n);assert.equal(observed.revisionDelta,20n);
   assert.equal(observed.writeDelta,dirty===0?31n:30n);
  }
  const before=await f.storage.execute('fixture.timelineState',{memoryId:result.memoryId});
  await assert.rejects(f.storage.execute('fixture.timelineWrites',{memoryId:result.memoryId,self,dirty:0,count:3,fail:true}));
  assert.deepEqual(await f.storage.execute('fixture.timelineState',{memoryId:result.memoryId}),before);
 }
});
