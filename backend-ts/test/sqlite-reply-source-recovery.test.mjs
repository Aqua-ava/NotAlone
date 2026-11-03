import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/sqlite-reply-candidates/support.mjs';
import {SqliteReplyTurns} from '../src/reply/sqlite/candidates/turns.ts';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';

const registryModule=new URL('./fixtures/sqlite/reply-source-recovery-registry.mjs',import.meta.url).href;
const content=JSON.stringify({candidates:[{parts:['合成恢复后的候选'],basis:[1]}]});
const workspace=()=>({action:'express',draftText:'我想说晚点再聊',tone:'original',instruction:'',contextText:'',includeRelationshipContext:true,excludedMessageIds:[]});

test('过期读取状态在候选准备阶段恢复一次，原请求回放不重复恢复或生成',async t=>{
 const f=await fixture(t,{registryModule,content}),contactId=f.ids[0],discussion=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner),prepared=[];
 await f.storage.execute('provenanceTest.guardLost',{ownerId:f.owner,contactId});
 const turns=new SqliteReplyTurns({...f,service,authorize:async()=>{},prepareSources:async(id,signal)=>{
  signal?.throwIfAborted();prepared.push(id);await f.storage.execute('sourceRecoveryTest.ready',{ownerId:f.owner,contactId:id});
 }});t.after(()=>turns.close());
 const w=workspace(),input={contactId,discussionId:discussion.id,requestKey:randomUUID(),text:w.draftText,workspace:w,confirmedContact:true};
 await turns.generate(input);
 assert.deepEqual((await service.view(contactId,discussion.id))[0].candidates[0].parts,['合成恢复后的候选']);
 assert.deepEqual(prepared,[contactId]);assert.equal(f.requests.length,1);
 assert.equal((await turns.generate(input)).replayed,true);assert.deepEqual(prepared,[contactId]);assert.equal(f.requests.length,1);
});

test('来源恢复失败保留可重试的未发送状态，不调用模型或保留半成品',async t=>{
 const f=await fixture(t,{registryModule,content}),contactId=f.ids[0],discussion=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner);
 await f.storage.execute('provenanceTest.guardLost',{ownerId:f.owner,contactId});
 const turns=new SqliteReplyTurns({...f,service,authorize:async()=>{},prepareSources:async()=>{throw new StorageFailure('history_source_continuity_unverified');}});t.after(()=>turns.close());
 const w=workspace(),input={contactId,discussionId:discussion.id,requestKey:randomUUID(),text:w.draftText,workspace:w,confirmedContact:true};
 await assert.rejects(turns.generate(input),{code:'reply_sources_not_ready'});
 const state=await service.status(contactId,discussion.id,input.requestKey);
 assert.equal(state.phase,'failed');assert.equal(state.sent,false);assert.equal(state.retryable,true);assert.equal(state.errorCode,'reply_sources_not_ready');
 assert.equal(f.requests.length,0);assert.deepEqual((await service.view(contactId,discussion.id))[0].candidates,[]);
});

test('关闭关系背景或没有聊天资料时，生成不要求恢复来源或新增读取授权',async t=>{
 for(const includeRelationshipContext of [false,true])await t.test(String(includeRelationshipContext),async t=>{
  const f=await fixture(t,{registryModule,content,synchronizeHistory:false}),contactId=f.ids[0],discussion=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner);
  const turns=new SqliteReplyTurns({...f,service,authorize:async()=>{},prepareSources:async()=>{assert.fail('无聊天依赖不应访问微信来源');}});t.after(()=>turns.close());
  const w={...workspace(),includeRelationshipContext};
  await turns.generate({contactId,discussionId:discussion.id,requestKey:randomUUID(),text:w.draftText,workspace:w,confirmedContact:true});
  assert.equal((await f.contacts.directory()).read_enabled,false);assert.equal(f.requests.length,1);
 });
});

test('本人资料引用另一联系人时，只准备本次实际引用的来源联系人',async t=>{
 const f=await fixture(t,{registryModule,content}),contactId=f.ids[0],sourceContactId=f.ids[1],discussion=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner),prepared=[];
 await f.storage.execute('synthetic.publishReplyKnowledge',{ownerId:f.owner,contactId,sourceContactId,mode:'owner'});
 await f.storage.execute('provenanceTest.guardLost',{ownerId:f.owner,contactId:sourceContactId});
 const turns=new SqliteReplyTurns({...f,service,authorize:async()=>{},prepareSources:async(id)=>{prepared.push(id);await f.storage.execute('sourceRecoveryTest.ready',{ownerId:f.owner,contactId:id});}});t.after(()=>turns.close());
 const w=workspace();await turns.generate({contactId,discussionId:discussion.id,requestKey:randomUUID(),text:w.draftText,workspace:w,confirmedContact:true});
 assert.deepEqual(new Set(prepared),new Set([contactId,sourceContactId]));assert.equal(f.requests.length,1);
 assert.match(JSON.stringify(f.requests[0]),/合成本人已采纳资料/);
});

test('明确继续旧选稿时也能恢复过期读取状态，仍只生成一轮新候选',async t=>{
 const f=await fixture(t,{registryModule,content}),contactId=f.ids[0],discussion=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner),prepared=[];
 const turns=new SqliteReplyTurns({...f,service,authorize:async()=>{},prepareSources:async(id)=>{prepared.push(id);await f.storage.execute('sourceRecoveryTest.ready',{ownerId:f.owner,contactId:id});}});t.after(()=>turns.close());
 const w=workspace(),base={contactId,discussionId:discussion.id,text:w.draftText,workspace:w,confirmedContact:true};
 await turns.generate({...base,requestKey:randomUUID()});
 const candidate=(await service.view(contactId,discussion.id))[0].candidates[0],selection=await service.select({contactId,discussionId:discussion.id,candidateId:candidate.candidateId,versionNo:1});
 await f.storage.execute('provenanceTest.guardLost',{ownerId:f.owner,contactId});
 await turns.generate({...base,requestKey:randomUUID(),carriedSelectionId:selection.id});
 assert.equal(f.requests.length,2);assert.deepEqual(prepared,[contactId]);assert.equal((await service.view(contactId,discussion.id))[1].candidates.length,1);
});

test('恢复发现真实来源变化时终结原请求，不留下永久准备中的任务',async t=>{
 const f=await fixture(t,{registryModule,content}),contactId=f.ids[0],discussion=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner);
 await f.storage.execute('provenanceTest.guardLost',{ownerId:f.owner,contactId});
 const turns=new SqliteReplyTurns({...f,service,authorize:async()=>{},prepareSources:async(id)=>{
  await f.storage.execute('sourceRecoveryTest.fence',{token:await f.contacts.eligibility(id)});throw new StorageFailure('history_source_continuity_unverified');
 }});t.after(()=>turns.close());
 const w=workspace(),input={contactId,discussionId:discussion.id,requestKey:randomUUID(),text:w.draftText,workspace:w,confirmedContact:true};
 await assert.rejects(turns.generate(input),{code:'reply_sources_not_ready'});
 const status=await service.status(contactId,discussion.id,input.requestKey);
 assert.equal(status.phase,'failed');assert.equal(status.sent,false);assert.equal(status.errorCode,'reply_sources_not_ready');assert.equal(f.requests.length,0);
});
