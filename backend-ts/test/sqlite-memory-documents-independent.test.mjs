import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {deletionFixture} from './fixtures/memory-documents/deletion-support.mjs';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';

test('同轮甲提取失败时已成功的乙仍可完成文档发布，整轮保持失败',async t=>{
 let failedContact;
 const f=await deletionFixture(t,{twoContacts:true,ownerB:false,beforeExtractionPrepare:async({request,input})=>{
  if(request.purpose==='extraction'&&input.scope.contact_id===failedContact)throw Object.assign(new Error('合成单联系人提取失败'),{code:'extraction_model_validation_failed'});
 }});
 failedContact=f.contactId;
 const run=await f.extraction.start('independent-document-after-failure');await f.extraction.waitForIdle(run.runId);
 const snapshot=await f.extraction.read(run.runId),a=snapshot.tasks.find(task=>task.contactId===f.contactId),b=snapshot.tasks.find(task=>task.contactId===f.otherContactId);
 assert.equal(snapshot.state,'failed');assert.equal(a.state,'failed');assert.equal(b.state,'succeeded');
 assert.ok(snapshot.failed>0);assert.ok(snapshot.succeeded>0);assert.equal(snapshot.laterStages,'pending');
 const trace=await f.extraction.trace(b.taskId);assert.ok(trace.events.some(event=>event.kind==='verified_output'),'乙必须真实完成07提取和来源核验');
 const memory=await new SqliteMemoryManagement(f.storage,f.owner).read({scopeKind:'contact',contactId:f.otherContactId});
 assert.ok(memory.memories.some(item=>item.current.body.includes('合成登山')),'乙须经真实08完成正式记忆');
 assert.ok(memory.candidates.every(item=>item.state!=='pending'),'乙没有待裁决候选');
 const document=await f.documents.readTask(b.taskId),view=await f.documents.read({scopeKind:'contact',contactId:f.otherContactId});
 assert.equal(document.outcome,'completed','无关联系人的局部失败不能阻塞乙的09');
 assert.deepEqual(document.stages.map(stage=>stage.status),['succeeded','succeeded']);
 assert.equal(view.publication.members.length,2);assert.ok(view.documents.every(item=>JSON.stringify(item).includes('合成登山')));
 assert.ok(f.calls.filter(call=>call.input.scope.contact_id===f.contactId).length===0,'失败联系人不得发布文档');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('用户暂停整轮后已成功任务不能开始文档阶段',async t=>{
 const f=await deletionFixture(t,{beforeDocuments:async({runId,extraction})=>{await extraction.pause(runId);}});
 const run=await f.extraction.start('document-pause-before-publish');await f.extraction.waitForIdle(run.runId);
 const snapshot=await f.extraction.read(run.runId),task=snapshot.tasks.find(item=>item.contactId===f.contactId);
 assert.equal(snapshot.state,'paused');assert.equal(task.state,'succeeded');
 const memory=await new SqliteMemoryManagement(f.storage,f.owner).read({scopeKind:'contact',contactId:f.contactId});
 assert.ok(memory.memories.length,'暂停前乙的08前置阶段已完成');
 assert.equal((await f.documents.readTask(task.taskId)).outcome,'incomplete');
 assert.equal(await f.storage.execute('memoryDocuments.claimScene',{ownerId:f.owner,taskId:task.taskId}),null,'普通暂停不领取新文档小批');
 assert.equal(await f.storage.execute('memoryDocuments.claimProfile',{ownerId:f.owner,taskId:task.taskId}),null);
 assert.equal(f.calls.length,0);assert.equal((await f.documents.read({scopeKind:'contact',contactId:f.contactId})).publication,null);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

for(const unpausedFailure of [false,true])test(`公共模型配置失败时${unpausedFailure?'缺少暂停标记也':'正常暂停后'}不能启动其他联系人文档`,async t=>{
 let failedContact;
 const f=await deletionFixture(t,{twoContacts:true,ownerB:false,beforeExtractionPrepare:async({request,input})=>{
  if(request.purpose==='extraction'&&input.scope.contact_id===failedContact)throw Object.assign(new Error('合成公共配置缺失'),{code:'extraction_model_unconfigured'});
 },beforeDocuments:async({runId})=>{
  if(unpausedFailure)await f.storage.execute('fixture.failedRunWithoutPause',{ownerId:f.owner,runId});
 }});
 const ordered=f.saved.map(item=>item.contact_id).sort();failedContact=ordered.at(-1);const successfulContact=ordered[0];
 const run=await f.extraction.start(`document-shared-config-${unpausedFailure}`);await f.extraction.waitForIdle(run.runId);
 const snapshot=await f.extraction.read(run.runId),failed=snapshot.tasks.find(task=>task.contactId===failedContact),succeeded=snapshot.tasks.find(task=>task.contactId===successfulContact);
 assert.equal(snapshot.state,unpausedFailure?'failed':'paused');assert.equal(failed.state,'failed');assert.equal(succeeded.state,'succeeded');
 const failures=await f.storage.execute('fixture.extractionFailures',{ownerId:f.owner,taskId:failed.taskId});
 assert.ok(failures.some(attempt=>attempt.state==='failed'&&attempt.error_code==='extraction_model_unconfigured'),'公共配置故障来自真实07尝试');
 assert.equal((await f.documents.readTask(succeeded.taskId)).outcome,'incomplete');
 if(unpausedFailure)await assert.rejects(f.storage.execute('memoryDocuments.claimScene',{ownerId:f.owner,taskId:succeeded.taskId}),{code:'document_preceding_stage_incomplete'});
 else assert.equal(await f.storage.execute('memoryDocuments.claimScene',{ownerId:f.owner,taskId:succeeded.taskId}),null,'普通暂停不领取新文档小批');
 assert.equal(f.calls.length,0);assert.equal((await f.documents.read({scopeKind:'contact',contactId:successfulContact})).publication,null);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('来源删除fence期间不启动其他已成功联系人的文档阶段',async t=>{
 let plan;
 const f=await deletionFixture(t,{twoContacts:true,ownerB:false,beforeDocuments:async()=>{
  plan=await f.deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.contactId,sourceId:f.message.sourceRecordIds[0]}});
 }});
 const run=await f.extraction.start('document-deletion-before-publish');await f.extraction.waitForIdle(run.runId);
 const snapshot=await f.extraction.read(run.runId),b=snapshot.tasks.find(task=>task.contactId===f.otherContactId);
 assert.ok(plan);assert.equal(b.state,'succeeded');assert.equal((await f.documents.readTask(b.taskId)).outcome,'incomplete');
 await assert.rejects(f.storage.execute('memoryDocuments.claimScene',{ownerId:f.owner,taskId:b.taskId}),{code:'memory_source_stale'});
 assert.equal(f.calls.length,0);assert.equal((await f.documents.read({scopeKind:'contact',contactId:f.otherContactId})).publication,null);
 const done=await f.deletion.advance({ownerId:f.owner,operationId:plan.operationId});assert.equal(done.state,'completed',JSON.stringify(done.checks));
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
