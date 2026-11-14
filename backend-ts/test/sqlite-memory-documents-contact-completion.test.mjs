import test from 'node:test';
import assert from 'node:assert/strict';
import {deletionFixture} from './fixtures/memory-documents/deletion-support.mjs';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';

test('显式完成单个联系人主题与概览，仅领取该联系人任务并结清同范围等待队列',async t=>{
 const f=await deletionFixture(t,{twoContacts:true,laterScheduling:true});
 const run=await f.extraction.start('complete-one-contact-documents');await f.extraction.waitForIdle(run.runId);
 const before=await f.extraction.read(run.runId),target=before.tasks.find(task=>task.contactId===f.contactId);
 const other=before.tasks.find(task=>task.contactId===f.otherContactId),self=before.tasks.find(task=>task.scopeKind==='self');
 assert.ok(target&&other&&self,'合成轮次包含两个联系人及独立本人任务');
 const selfMemory=await new SqliteMemoryManagement(f.storage,f.owner).read({scopeKind:'self',contactId:null});
 assert.ok(selfMemory.memories.length,'本人范围有可整理的正式记忆，避免隔离检查空跑');
 const targetScope={scopeKind:'contact',contactId:f.contactId},otherScope={scopeKind:'contact',contactId:f.otherContactId},selfScope={scopeKind:'self',contactId:null};
 const targetBefore=await f.documents.readSchedule(targetScope),otherBefore=await f.documents.readSchedule(otherScope),selfBefore=await f.documents.readSchedule(selfScope);
 assert.equal(targetBefore.scene.state,'scheduled');assert.ok(targetBefore.scene.dueAt>Date.now(),'显式请求不依赖修改真实时钟或全局到期扫描');
 assert.equal(f.calls.length,0);
 assert.deepEqual(await f.storage.execute('memoryDocuments.tasks',{ownerId:f.owner,runId:run.runId,contactId:f.contactId}),[target.taskId]);
 await f.documents.publishRun(run.runId,f.contactId);
 const documents=await f.documents.read(targetScope),state=await f.documents.readTask(target.taskId);
 assert.equal(state.outcome,'completed');assert.deepEqual(state.stages.map(stage=>stage.status),['succeeded','succeeded']);
 assert.deepEqual(documents.documents.map(document=>document.kind).sort(),['profile','scene']);
 assert.ok(f.calls.length>0&&f.calls.every(call=>call.input.scope.contact_id===f.contactId),'所有实际模型输入都属于指定联系人');
 assert.equal((await f.extraction.readContact(f.contactId)).run.laterStages,'completed');
 assert.equal((await f.extraction.readContact(f.contactId)).queue.later.pending,0);
 assert.equal((await f.documents.readSchedule(targetScope)).scene.state,'succeeded');
 assert.deepEqual(await f.documents.readSchedule(otherScope),otherBefore);assert.deepEqual(await f.documents.readSchedule(selfScope),selfBefore);
 assert.deepEqual((await f.documents.readTask(other.taskId)).stages,[]);assert.deepEqual((await f.documents.readTask(self.taskId)).stages,[]);
 assert.equal((await f.documents.read(otherScope)).publication,null);assert.equal((await f.documents.read(selfScope)).publication,null);
 assert.equal((await f.extraction.read(run.runId)).laterStages,'pending','另两个范围仍保留原等待需求');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('单联系人后续登记不把同轮其他联系人及本人任务登记为无需变化的已完成',async t=>{
 const f=await deletionFixture(t,{twoContacts:true,noMemory:true,laterScheduling:true,laterSchedulingContactOnly:true});
 const run=await f.extraction.start('enroll-one-contact-documents');await f.extraction.waitForIdle(run.runId);
 await f.storage.execute('fixture.documentFollowupPending',{ownerId:f.owner,runId:run.runId});
 await f.documents.enrollRun(run.runId,f.contactId);
 const scoped=await f.storage.execute('fixture.documentFollowupState',{ownerId:f.owner,runId:run.runId});
 assert.equal(scoped.run.followup_state,'pending','单scope登记保留整轮恢复标记');assert.equal(scoped.run.state,'incomplete');
 assert.equal(scoped.scopes.length,1);assert.equal(scoped.scopes[0].contact_id,f.contactId);
 assert.equal((await f.extraction.readContact(f.contactId)).run.laterStages,'completed','目标无新记忆时可以明确登记不适用');
 assert.equal((await f.extraction.readContact(f.otherContactId)).run.laterStages,'pending','未请求的其他联系人不登记完成');
 assert.equal(f.calls.length,0);
 const self=await f.documents.read({scopeKind:'self',contactId:null});
 assert.equal(self.publication,null);assert.equal(self.status,'processing','本人范围未被登记为无变化的idle');
 await f.documents.enrollRun(run.runId);
 const complete=await f.storage.execute('fixture.documentFollowupState',{ownerId:f.owner,runId:run.runId});
 assert.equal(complete.run.followup_state,'enrolled');assert.equal(complete.scopes.length,3);
 assert.equal((await f.extraction.readContact(f.otherContactId)).run.laterStages,'completed');
 assert.equal((await f.documents.read({scopeKind:'self',contactId:null})).status,'idle');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('同轮文档在途请求只复用相同联系人，其他联系人及整轮请求明确受阻',async t=>{
 const f=await deletionFixture(t,{twoContacts:true,laterScheduling:true});
 const run=await f.extraction.start('contact-documents-concurrent-scope');await f.extraction.waitForIdle(run.runId);
 const work=f.documents.publishRun(run.runId,f.contactId);
 assert.equal(f.documents.publishRun(run.runId,f.contactId),work,'同范围重复请求复用当前工作');
 await assert.rejects(f.documents.publishRun(run.runId,f.otherContactId),{code:'document_run_busy'});
 await assert.rejects(f.documents.publishRun(run.runId),{code:'document_run_busy'});
 await work;
 assert.ok(f.calls.length>0&&f.calls.every(call=>call.input.scope.contact_id===f.contactId));
 assert.equal((await f.documents.read({scopeKind:'contact',contactId:f.otherContactId})).publication,null);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('指定联系人完整发布不消费尚未登记的其他范围后续标记',async t=>{
 let otherContactId;
 const f=await deletionFixture(t,{twoContacts:true,ownerB:false,laterScheduling:true,laterSchedulingContactOnly:true,
  extractionResponse:async(request,input)=>input.scope.contact_id===otherContactId?{blocks:[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify({scenes:[]})}]}:undefined});
 otherContactId=f.otherContactId;
 const run=await f.extraction.start('publish-one-contact-preserves-followup');await f.extraction.waitForIdle(run.runId);
 await f.storage.execute('fixture.documentFollowupPending',{ownerId:f.owner,runId:run.runId});
 await f.documents.publishRun(run.runId,f.contactId);
 const scoped=await f.storage.execute('fixture.documentFollowupState',{ownerId:f.owner,runId:run.runId});
 assert.equal(scoped.run.followup_state,'pending','完整双阶段发布也不能消费未登记范围的恢复标记');
 assert.equal((await f.extraction.readContact(f.contactId)).run.laterStages,'completed');
 assert.equal(scoped.scopes.some(scope=>scope.contact_id===f.otherContactId),false);
 await f.documents.enrollRun(run.runId);
 const complete=await f.storage.execute('fixture.documentFollowupState',{ownerId:f.owner,runId:run.runId});
 assert.equal(complete.run.followup_state,'enrolled');assert.equal(complete.scopes.length,3);
 assert.equal((await f.extraction.readContact(f.otherContactId)).run.laterStages,'completed');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
