import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {SqliteMemoryDocuments} from '../src/memory/sqlite/documents/service.ts';
import {profileReplayFixture} from './fixtures/memory-documents/profile-replay-support.mjs';

async function interruptedReplay(t,f,taskId,mode='publish'){
 let service,closing,injected=false,workerUnavailable=false;
 const storage={execute:async(name,input)=>{
  if(workerUnavailable)throw new StorageFailure('storage_closed');
  if(name==='memoryDocuments.publish'&&mode==='worker_crash'&&!injected){injected=true;workerUnavailable=true;throw new StorageFailure('storage_timeout');}
  if(name==='memoryDocuments.publish'&&mode==='publish'&&!injected){injected=true;throw new StorageFailure('synthetic_publish_interrupted');}
  const result=await f.storage.execute(name,input);
  if(name==='memoryDocuments.saveProfile'&&mode==='close'&&!injected){injected=true;closing=service.close();}
  return result;
 }};
 service=new SqliteMemoryDocuments(storage,f.owner,undefined,new ActiveHolders());t.after(()=>service.close());
 await assert.rejects(service.replayVerifiedProfile(taskId));await closing;assert.equal(injected,true);
 return service;
}

test('重放保存成功后关闭或发布瞬错可零模型续发原成功尝试',{timeout:20000},async t=>{
 for(const mode of ['publish','close','dedicated_publish','dedicated_worker_crash'])await t.test(mode,async t=>{
  const f=await profileReplayFixture(t),scope={scopeKind:'contact',contactId:f.a};let taskId=f.taskId;
  if(mode.startsWith('dedicated_')){
   await f.documents.replayVerifiedProfile(taskId);f.setOldGuard(true);
   const memory=(await f.management.read(scope)).memories[0];await f.management.decide({requestKey:randomUUID(),action:'correct',memoryId:memory.id,expectedVersionNo:memory.current.versionNo,expectedHeadRevision:memory.headRevision,body:'联系人长期喜欢合成温室。'});
   let schedule=await f.documents.readSchedule(scope);await f.documents.runDueStages(schedule.scene.dueAt);schedule=await f.documents.readSchedule(scope);
   if(schedule.profile.state==='scheduled'){await f.documents.runDueStages(schedule.profile.dueAt);schedule=await f.documents.readSchedule(scope);}
   assert.equal(schedule.profile.state,'failed');taskId=schedule.profile.taskId;f.setOldGuard(false);
  }
  const oldCalls=f.modelCalls.length,oldEffects=await f.storage.execute('fixture.effectScopes',{ownerId:f.owner});
  const first=await interruptedReplay(t,f,taskId,mode==='close'?'close':mode==='dedicated_worker_crash'?'worker_crash':'publish'),saved=await f.storage.execute('fixture.profileReplayFacts',{ownerId:f.owner,taskId});
  assert.deepEqual(saved.attempts.map(a=>a.state),['failed','succeeded']);assert.equal((await f.documents.readTask(taskId)).publicationId,null);
  if(mode==='dedicated_worker_crash'){const stranded=await f.documents.readSchedule(scope);assert.equal(stranded.profile.state,'running');assert.equal(stranded.profile.errorCode,null,'失联worker不能记录任何失败状态');}
  const resumed=['close','dedicated_worker_crash'].includes(mode)?new SqliteMemoryDocuments(f.storage,f.owner,undefined,new ActiveHolders()):first;if(resumed!==first)t.after(()=>resumed.close());
  const result=await resumed.replayVerifiedProfile(taskId);assert.equal(result.outcome,'completed');assert.equal(f.modelCalls.length,oldCalls);
  assert.deepEqual(await f.storage.execute('fixture.profileReplayFacts',{ownerId:f.owner,taskId}),saved,'只发布已保存的成功尝试，不生成新attempt、输出或模型回执');
  assert.deepEqual(await f.storage.execute('fixture.effectScopes',{ownerId:f.owner}),oldEffects);
  if(mode.startsWith('dedicated_'))assert.equal((await f.documents.readSchedule(scope)).profile.state,'succeeded');
  assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 });
});

test('保存后续发仍重核来源修订、回执、未知、文档修订与已复制证据',{timeout:20000},async t=>{
 for(const kind of ['source_revision','receipt_missing','call_unknown','document_revision','saved_event_source','saved_packet','delete'])await t.test(kind,async t=>{
  const f=await profileReplayFixture(t),service=await interruptedReplay(t,f,f.taskId),oldCalls=f.modelCalls.length;
  if(kind==='delete'){
   const plan=await f.deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'contact',contactId:f.a}});assert.equal((await f.deletion.advance({ownerId:f.owner,operationId:plan.operationId})).state,'completed');
  }else await f.storage.execute('fixture.profileReplayFault',{ownerId:f.owner,taskId:f.taskId,kind});
  const before=kind==='delete'?null:await f.storage.execute('fixture.profileReplayFacts',{ownerId:f.owner,taskId:f.taskId});
  await assert.rejects(service.replayVerifiedProfile(f.taskId));assert.equal(f.modelCalls.length,oldCalls);
  if(before)assert.deepEqual(await f.storage.execute('fixture.profileReplayFacts',{ownerId:f.owner,taskId:f.taskId}),before);
  assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
 });
});
