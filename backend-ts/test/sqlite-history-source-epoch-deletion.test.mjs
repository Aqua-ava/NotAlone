// 旧副本及认证审计由历史专用夹具建立；断言继续验证当前存储的删除与抑制保护。
import {randomUUID} from 'node:crypto';
import {SqliteContactService} from '../src/contacts/sqlite/service.ts';
import {SqliteHistoryService} from '../src/history/sqlite/service.ts';
import {SqliteDiscussionService} from '../src/reply/sqlite/service.ts';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
import {deletionFixture} from './fixtures/memory-documents/deletion-support.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner,record,createChannel,restart} from './sqlite-clear-support.mjs';

test('同物理出现跨旧绑定副本，删除旧source须清除新副本',async t=>{
 const f=await fixture(t,{registryModule:new URL('./fixtures/history/source-epoch-deletion-registry.mjs',import.meta.url).href});
 f.state.pageRecords=[record('shard-a','1')];
 await f.current.history.synchronize(f.contactA);
 const fresh=(await f.current.history.readChat(f.contactA)).messages[0];
 const [old]=await f.current.storage.execute('fixture.historicalSourceCopy',{token:await f.current.contacts.eligibility(f.contactA)});
 assert.notEqual(fresh.id,old.id);
 const key=JSON.stringify(['source-1','shard-a','table-a','1']);
 const before=await f.current.storage.execute('diag.sourceRows',{ownerId:owner,contactId:f.contactA,key});assert.equal(before.length,2);assert.equal(new Set(before.map(r=>r.binding_id)).size,2);assert.equal(new Set(before.map(r=>r.conversation_id)).size,1);
 const plan=await f.current.deletion.plan({ownerId:owner,requestKey:'delete-old-same-occurrence',scope:{kind:'source',contactId:f.contactA,sourceId:old.sourceRecordIds[0]}});
 assert.ok(before.every(r=>r.accepted_data_generation<plan.acceptedGeneration));const completed=await f.current.deletion.advance(plan);assert.equal(completed.state,'completed');
 await f.current.history.synchronize(f.contactA);
 const remaining=await f.current.storage.execute('diag.sourceRows',{ownerId:owner,contactId:f.contactA,key});
 const readable=(await f.current.history.readChat(f.contactA)).messages;
 const eligible=await f.current.storage.execute('diag.sourceEligible',{owner_id:owner,contact_id:f.contactA,record_id:fresh.sourceRecordIds[0],message_id:fresh.id});

 assert.equal(remaining.filter(r=>r.text_body!==null).length,0,'删除完成后，同一实际来源的跨binding正文副本仍存在');
 assert.equal(readable.length,0);assert.equal(eligible.eligible,false);
});

async function copies(t,records=[record('shard-a','1')]){
 const f=await fixture(t,{registryModule:new URL('./fixtures/history/source-epoch-deletion-registry.mjs',import.meta.url).href});f.state.pageRecords=records;
 await f.current.history.synchronize(f.contactA);await f.current.history.synchronize(f.contactB);
 const old=await f.current.storage.execute('fixture.historicalSourceCopy',{token:await f.current.contacts.eligibility(f.contactA)});
 return {...f,old,fresh:(await f.current.history.readChat(f.contactA)).messages};
}
test('删除只扩展相同owner联系人会话和可信物理tuple，异tuple及他人同tuple保留',async t=>{
 const f=await copies(t,[record('shard-a','1',{text:'相同合成正文'}),record('shard-a','2',{text:'相同合成正文'}),record('shard-b','1',{text:'相同合成正文'})]);
 const otherOwner='00000000-0000-4000-8000-000000000002',metadata={account:async()=>({externalKey:'synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-metadata-v1'}),sessions:async()=>[{externalKey:'friend-a',displayName:'合成同名',kind:'private',identityAssurance:'verified'}]};
 const contacts=new SqliteContactService(f.current.storage,otherOwner,metadata);await contacts.initialize();const account=await contacts.detectAccount();await contacts.confirmAccount(account.candidate_token);await contacts.setReading(true);const snapshot=await contacts.candidates(true);
 const other=(await contacts.confirm(snapshot.snapshot_token,snapshot.sessions.map(s=>({locator:s.username,observed_display_name:s.display_name,expected_selection_generation:s.selection_generation})))).bindings[0];
 const channel=createChannel();channel.state.pageRecords=[record('shard-a','1',{text:'相同合成正文'})];const history=new SqliteHistoryService(f.current.storage,contacts,channel.channel);t.after(()=>history.close());await history.synchronize(other.contact_id);
 const key=JSON.stringify(['source-1','shard-a','table-a','1']);
 const source=(await f.current.storage.execute('diag.sourceRows',{ownerId:owner,contactId:f.contactA,key})).find(r=>f.old.some(m=>m.sourceRecordIds.includes(r.id)));
 const plan=await f.current.deletion.plan({ownerId:owner,requestKey:'isolated-delete',scope:{kind:'source',contactId:f.contactA,sourceId:source.id}});
 const frozen=await f.current.storage.execute('diag.sourceIds',{operation:plan});assert.equal(frozen.length,2);assert.equal(plan.targets.filter(x=>x.target?.domain==='history'&&x.target.rowKind==='capture_record').length,2);
 const before=await f.current.storage.execute('diag.sourceRows',{ownerId:owner,contactId:f.contactA,key});assert.ok(before.every(r=>r.availability==='deleting'));const fresh=f.fresh.find(m=>m.sourceRecordIds.some(id=>frozen.includes(id)));assert.equal((await f.current.storage.execute('diag.sourceEligible',{owner_id:owner,contact_id:f.contactA,record_id:fresh.sourceRecordIds[0],message_id:fresh.id})).eligible,false);
 assert.equal((await f.current.deletion.advance(plan)).state,'completed');await f.current.history.synchronize(f.contactA);
 assert.equal((await f.current.history.readChat(f.contactA)).messages.length,2);assert.equal((await f.current.history.read(f.contactB)).messages.length,3);assert.equal((await history.read(other.contact_id)).messages.length,1);
 assert.deepEqual(await f.current.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
test('种子capture已擦除再重启，冻结计划仍找回并清除新epoch副本',async t=>{
 const f=await copies(t),sourceId=f.old[0].sourceRecordIds[0],plan=await f.current.deletion.plan({ownerId:owner,requestKey:'restart-frozen-sources',scope:{kind:'source',contactId:f.contactA,sourceId}});
 const frozen=await f.current.storage.execute('diag.sourceIds',{operation:plan});assert.equal(frozen.length,2);
 const claim=await f.current.storage.execute('deletion.claim',{ownerId:owner,operationId:plan.operationId});const seedTarget=claim.targets.find(x=>x.target?.rowKind==='capture_record'&&x.target.key.id===sourceId);
 await f.current.storage.execute('deletion.clearTarget',{ownerId:owner,operationId:plan.operationId,token:claim.token,planRevision:claim.planRevision,targetNo:seedTarget.targetNo});
 assert.deepEqual(await f.current.storage.execute('diag.sourceIds',{operation:plan}),frozen);const current=await restart(f,t);
 assert.deepEqual(await current.storage.execute('diag.sourceIds',{operation:plan}),frozen);assert.equal((await current.deletion.advance(plan)).state,'completed');
 assert.equal((await current.storage.execute('diag.sourceRows',{ownerId:owner,contactId:f.contactA,key:JSON.stringify(['source-1','shard-a','table-a','1'])})).length,0);assert.deepEqual(await current.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
test('删旧source同时清除新epoch的候选输入、讨论上下文和媒体尝试闭包',async t=>{
 const f=await copies(t,[record('shard-a','1',{kind:'image',text:null,originalType:'3'})]),message=f.fresh[0],sourceId=message.sourceRecordIds[0],contactId=f.contactA;
 await f.current.storage.execute('diag.mediaHead',{ownerId:owner,contactId,messageId:message.id});await f.current.storage.execute('media.begin',{ownerId:owner,contactId,messageId:message.id,requestKey:'new-epoch-media',goal:'extract',token:await f.current.contacts.eligibility(contactId),adapterVersion:'synthetic'});
 const discussions=new SqliteDiscussionService(f.current.storage,owner),discussion=await discussions.newDiscussion(contactId),key='new-epoch-reply',confirmationId=await f.current.storage.execute('identity.manualConfirm',{ownerId:owner,contactId,contextToken:key,id:randomUUID(),at:Date.now()});
 const candidate=new SqliteReplyCandidateService(f.current.storage,owner),{attempt}=await candidate.begin({contactId,discussionId:discussion.id,requestKey:key,text:'合成候选',identity:{kind:'manual',confirmationId}});
 await f.current.storage.execute('reply.freezeInput',{...attempt,contextId:randomUUID(),callId:randomUUID(),skillRun:{packages:[],eligible:[]},items:[{kind:'message',sourceContactId:contactId,messageId:message.id,recordId:sourceId,acceptedRevision:1n}],at:Date.now()});
 const before=await f.current.storage.execute('diag.dependencies',{ownerId:owner});assert.ok(before.reply_context_item>0&&before.reply_candidate_input_source>0&&before.media_extraction_attempt>0);
 const plan=await f.current.deletion.plan({ownerId:owner,requestKey:'delete-ancestor-source-derived',scope:{kind:'source',contactId,sourceId:f.old[0].sourceRecordIds[0]}});assert.ok(plan.targets.some(x=>x.target?.domain==='reply_candidates'));assert.ok(plan.targets.some(x=>x.target?.domain==='discussion'));assert.ok(plan.targets.some(x=>x.target?.domain==='media'));
 const result=await f.current.deletion.advance(plan);assert.equal(result.state,'completed',JSON.stringify(result.checks));assert.deepEqual(await f.current.storage.execute('diag.dependencies',{ownerId:owner}),{reply_context:0,reply_context_item:0,reply_candidate_input_source:0,media_extraction_attempt:0,message_media:0});assert.deepEqual(await f.current.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
test('旧来源删除撤下仅由新epoch实际输入产生的长期记忆和L2L3文档',async t=>{
 const f=await deletionFixture(t),contactId=f.contactId;await f.contacts.setReading(true);
 const [copy]=await f.storage.execute('fixture.historicalSourceCopy',{token:await f.contacts.eligibility(contactId)}),oldSource=copy.sourceRecordIds[0];
 await f.contacts.setReading(false);
 const run=await f.extraction.start('derived-from-new-epoch');assert.ok(run.inputs.every(i=>i.recordId!==oldSource));await f.extraction.waitForIdle(run.runId);const scope={scopeKind:'contact',contactId};assert.equal((await f.documents.read(scope)).documents.length,2);
 const plan=await f.deletion.plan({ownerId:owner,requestKey:'delete-old-source-new-epoch-documents',scope:{kind:'source',contactId,sourceId:oldSource}});assert.equal((await f.documents.read(scope)).publication,null);
 const result=await f.deletion.advance(plan);assert.equal(result.state,'completed',JSON.stringify(result.checks));assert.deepEqual((await f.documents.read(scope)).documents,[]);assert.deepEqual(await f.storage.execute('fixture.documentErasure',{ownerId:owner,text:'合成园艺'}),{statements:0n,versions:0n,blocks:0n,events:0n,references:0n});assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
