import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {deletionFixture} from './fixtures/memory-documents/deletion-support.mjs';
import {record} from './fixtures/memory-sqlite/support.mjs';

test('新消息未产生记忆变更时复核并重新发布完整旧文档集合',async t=>{
 let unchanged=false;
 const f=await deletionFixture(t,{extractionResponse:async request=>unchanged&&request.purpose==='extraction'?{blocks:[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify({scenes:[]})}]}:undefined,
  documentResponse:async({payload})=>unchanged&&payload.layer==='l2'?{blocks:[]}:undefined});
 const first=await f.extraction.start('document-unchanged-first');await f.extraction.waitForIdle(first.runId);
 const scope={scopeKind:'contact',contactId:f.contactId},old=await f.documents.read(scope),firstTask=(await f.extraction.read(first.runId)).tasks.find(task=>task.contactId===f.contactId),oldState=await f.documents.readTask(firstTask.taskId);
 assert.equal(old.publication.members.length,2);assert.equal(oldState.outcome,'completed');
 unchanged=true;const previousCalls=f.calls.length;
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('2',{text:'谢谢今天的合成问候。',sentAt:'1700000001000'})],completedPartitions:['shard-a'],exhausted:true});
 await f.contacts.setReading(true);await f.service.synchronize(f.contactId);await f.contacts.setReading(false);
 const second=await f.extraction.start('document-unchanged-second');await f.extraction.waitForIdle(second.runId);
 const snapshot=await f.extraction.read(second.runId),task=snapshot.tasks.find(item=>item.contactId===f.contactId),state=await f.documents.readTask(task.taskId),current=await f.documents.read(scope);
 assert.equal(task.state,'succeeded');assert.equal(snapshot.total,1);assert.equal(snapshot.succeeded,1);assert.deepEqual(snapshot.candidates,[]);
 assert.equal(state.basis.memoryRevision,oldState.basis.memoryRevision,'08未改变记忆修订');
 assert.equal(state.basis.publicationId,old.publication.id,'并发基线固定为旧集合');
 assert.equal(state.outcome,'completed','无变更不应导致主题工作区失败');
 assert.deepEqual(state.stages.map(stage=>({kind:stage.kind,status:stage.status,reason:stage.reason})),[
  {kind:'scene',status:'not_applicable',reason:'unchanged_memories'},
  {kind:'profile',status:'not_applicable',reason:'unchanged_memories'},
 ]);
 assert.notEqual(current.publication.id,old.publication.id);assert.deepEqual(current.publication.members,old.publication.members);
 assert.deepEqual(current.documents,old.documents);assert.equal(snapshot.state,'completed');
 assert.equal(f.calls.slice(previousCalls).filter(call=>call.input.scope.contact_id===f.contactId).length,0,'已验证无变更时无需发送文档模型请求');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('新增正式记忆后仍运行文档阶段，不能按旧集合跳过',async t=>{
 const f=await deletionFixture(t),scope={scopeKind:'contact',contactId:f.contactId};
 const first=await f.extraction.start('document-changed-first');await f.extraction.waitForIdle(first.runId);
 const old=await f.documents.read(scope),prior=(await f.extraction.read(first.runId)).tasks.find(task=>task.contactId===f.contactId),oldState=await f.documents.readTask(prior.taskId),calls=f.calls.length;
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('2',{text:'我长期喜欢合成象棋。',sentAt:'1700000001000'})],completedPartitions:['shard-a'],exhausted:true});
 await f.contacts.setReading(true);await f.service.synchronize(f.contactId);await f.contacts.setReading(false);
 const next=await f.extraction.start('document-changed-second');await f.extraction.waitForIdle(next.runId);
 const task=(await f.extraction.read(next.runId)).tasks.find(item=>item.contactId===f.contactId),state=await f.documents.readTask(task.taskId);
 assert.notEqual(state.basis.memoryRevision,oldState.basis.memoryRevision);assert.equal(state.outcome,'completed');
 assert.deepEqual(state.stages.map(stage=>stage.status),['succeeded','succeeded']);
 assert.ok(f.calls.slice(calls).some(call=>call.input.scope.contact_id===f.contactId));
 assert.notEqual((await f.documents.read(scope)).publication.id,old.publication.id);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('联系人贡献范围变化时不复用旧本人混合集合',async t=>{
 let unchanged=false;
 const f=await deletionFixture(t,{twoContacts:true,targetOnly:true,orderOwnerA:true,preferText:'白茶',extractionResponse:async request=>unchanged&&request.purpose==='extraction'?{blocks:[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify({scenes:[]})}]}:undefined});
 const first=await f.extraction.start('document-unchanged-scope-first');await f.extraction.waitForIdle(first.runId);
 const self={scopeKind:'self',contactId:null},old=await f.documents.read(self),firstTask=(await f.extraction.read(first.runId)).tasks.find(task=>task.scopeKind==='self'),oldState=await f.documents.readTask(firstTask.taskId);
 assert.equal(old.documents.length,2);
 const binding=f.saved.find(item=>item.contact_id===f.otherContactId);await f.contacts.revoke(f.otherContactId,binding.binding_id,binding.selection_generation);
 unchanged=true;const calls=f.calls.length;
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('3',{sender:'owner',text:'合成问候。',sentAt:'1700000001000'})],completedPartitions:['shard-a'],exhausted:true});
 await f.contacts.setReading(true);await f.service.synchronize(f.contactId);await f.contacts.setReading(false);
 const next=await f.extraction.start('document-unchanged-scope-second');await f.extraction.waitForIdle(next.runId);
 const task=(await f.extraction.read(next.runId)).tasks.find(item=>item.scopeKind==='self'),state=await f.documents.readTask(task.taskId),current=await f.documents.read(self);
 assert.equal(state.basis.memoryRevision,oldState.basis.memoryRevision);assert.equal(state.outcome,'completed');
 assert.deepEqual(state.stages.map(stage=>stage.status),['succeeded','succeeded']);
 assert.ok(f.calls.slice(calls).some(call=>call.input.scope.contact_id===null),'范围变化后须重新整理');
 const oldKeys=new Set(old.publication.members.map(member=>`${member.documentId}:${member.versionNo}`));
 assert.ok(current.publication.members.every(member=>!oldKeys.has(`${member.documentId}:${member.versionNo}`)));
 const knowledge=(await f.storage.execute('fixture.documentKnowledge',{ownerId:f.owner,contactId:f.contactId,discussionId:randomUUID()})).filter(item=>item.scopeKind==='owner');
 assert.ok(knowledge.length);assert.ok(knowledge.every(item=>item.sources.every(source=>source.contactId===f.contactId)));
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('旧集合成员损坏时不得标记无变更或发布不完整集合',async t=>{
 let unchanged=false;
 const f=await deletionFixture(t,{extractionResponse:async request=>unchanged&&request.purpose==='extraction'?{blocks:[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify({scenes:[]})}]}:undefined});
 const first=await f.extraction.start('document-corrupt-first');await f.extraction.waitForIdle(first.runId);
 const scope={scopeKind:'contact',contactId:f.contactId},old=await f.documents.read(scope);assert.equal(old.publication.members.length,2);
 await f.storage.execute('fixture.removeDocumentMember',{ownerId:f.owner,publicationId:old.publication.id});
 unchanged=true;f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('2',{text:'合成问候。',sentAt:'1700000001000'})],completedPartitions:['shard-a'],exhausted:true});
 await f.contacts.setReading(true);await f.service.synchronize(f.contactId);await f.contacts.setReading(false);
 const next=await f.extraction.start('document-corrupt-second');await f.extraction.waitForIdle(next.runId);
 const task=(await f.extraction.read(next.runId)).tasks.find(item=>item.contactId===f.contactId),state=await f.documents.readTask(task.taskId);
 assert.equal(state.outcome,'incomplete');assert.equal(state.errorCode,'document_publication_incomplete');
 assert.ok(state.stages.every(stage=>stage.reason!=='unchanged_memories'));assert.equal((await f.documents.read(scope)).publication,null);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('旧资料来源已删除时不得把旧版本当作无变更集合重发',async t=>{
 let unchanged=false;
 const f=await deletionFixture(t,{extractionResponse:async request=>unchanged&&request.purpose==='extraction'?{blocks:[{type:'tool-call',name:request.tool.name,arguments:JSON.stringify({scenes:[]})}]}:undefined});
 const first=await f.extraction.start('document-stale-first');await f.extraction.waitForIdle(first.runId);
 const scope={scopeKind:'contact',contactId:f.contactId},old=await f.documents.read(scope);assert.equal(old.publication.members.length,2);
 const plan=await f.deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.contactId,sourceId:f.message.sourceRecordIds[0]}});
 assert.equal((await f.deletion.advance({ownerId:f.owner,operationId:plan.operationId})).state,'completed');
 assert.equal((await f.documents.read(scope)).publication,null);
 unchanged=true;f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('2',{text:'合成问候。',sentAt:'1700000001000'})],completedPartitions:['shard-a'],exhausted:true});
 await f.contacts.setReading(true);await f.service.synchronize(f.contactId);await f.contacts.setReading(false);
 const next=await f.extraction.start('document-stale-second');await f.extraction.waitForIdle(next.runId);
 const task=(await f.extraction.read(next.runId)).tasks.find(item=>item.contactId===f.contactId),state=await f.documents.readTask(task.taskId),current=await f.documents.read(scope);
 assert.equal(state.outcome,'completed');assert.deepEqual(state.stages.map(stage=>stage.reason),['no_eligible_memories','no_eligible_memories']);
 assert.notEqual(current.publication.id,old.publication.id);assert.deepEqual(current.publication.members,[]);assert.deepEqual(current.documents,[]);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
