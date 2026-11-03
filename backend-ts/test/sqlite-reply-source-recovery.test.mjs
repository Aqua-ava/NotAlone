import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/sqlite-reply-candidates/support.mjs';
import {SqliteReplyTurns} from '../src/reply/sqlite/candidates/turns.ts';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
const registryModule=new URL('./fixtures/sqlite/reply-source-recovery-registry.mjs',import.meta.url).href;
const content=JSON.stringify({candidates:[{parts:['合成本机候选'],basis:[1]}]});
const workspace=()=>({action:'express',draftText:'我想说晚点再聊',tone:'original',instruction:'',contextText:'',includeRelationshipContext:true,excludedMessageIds:[]});

for(const state of ['lost','old-runtime','binding-unverified'])test(`本机回复忽略 ${state}，挂起的微信恢复器不被调用且回放不重复生成`,{timeout:10000},async t=>{
 const f=await fixture(t,{registryModule,content}),contactId=f.ids[0],discussion=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner);
 await f.storage.execute('sourceRecoveryTest.runtimeState',{ownerId:f.owner,contactId,state});
 let externalReads=0,release;const blocked=new Promise(resolve=>{release=resolve;});
 const turns=new SqliteReplyTurns({...f,service,authorize:async()=>{},prepareSources:()=>{externalReads++;return blocked;}});t.after(()=>turns.close());
 const w=workspace(),input={contactId,discussionId:discussion.id,requestKey:randomUUID(),text:w.draftText,workspace:w,confirmedContact:true};
 let timer;await Promise.race([turns.generate(input),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('reply waited for WeChat')),2000);})]).finally(()=>{clearTimeout(timer);release();});
 assert.equal(externalReads,0);assert.match(JSON.stringify(f.requests[0]),/已保存聊天/);
 assert.equal((await turns.generate(input)).replayed,true);assert.equal(f.requests.length,1);
 assert.equal((await service.view(contactId,discussion.id))[0].candidates.length,1);
 await assert.rejects(f.storage.execute('sourceRecoveryTest.strict',{ownerId:f.owner,contactId}));
});

test('旧选稿与跨联系人本人资料也只核验本机实际来源',async t=>{
 const f=await fixture(t,{registryModule,content}),contactId=f.ids[0],sourceContactId=f.ids[1],discussion=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner);
 await f.storage.execute('synthetic.publishReplyKnowledge',{ownerId:f.owner,contactId,sourceContactId,mode:'owner'});
 const turns=new SqliteReplyTurns({...f,service,authorize:async()=>{},prepareSources:()=>assert.fail('不应访问微信')});t.after(()=>turns.close());
 const w={...workspace(),draftText:'我想安静散步'},base={contactId,discussionId:discussion.id,text:w.draftText,workspace:w,confirmedContact:true};
 await turns.generate({...base,requestKey:randomUUID()});
 assert.match(JSON.stringify(f.requests[0]),/合成本人已采纳资料/);
 const candidate=(await service.view(contactId,discussion.id))[0].candidates[0],selection=await service.select({contactId,discussionId:discussion.id,candidateId:candidate.candidateId,versionNo:1});
 for(const id of f.ids)await f.storage.execute('sourceRecoveryTest.runtimeState',{ownerId:f.owner,contactId:id,state:'lost'});
 await turns.generate({...base,requestKey:randomUUID(),carriedSelectionId:selection.id});
 assert.equal(f.requests.length,2);assert.match(JSON.stringify(f.requests[1]),/合成本人已采纳资料/);
});

test('不明旧来源围栏不自动恢复，也不调用微信准备器',async t=>{
 const f=await fixture(t,{registryModule,content}),contactId=f.ids[0],discussion=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner);
 await f.storage.execute('sourceRecoveryTest.fence',{token:await f.contacts.eligibility(contactId)});
 const turns=new SqliteReplyTurns({...f,service,authorize:async()=>{},prepareSources:()=>assert.fail('不应恢复旧围栏')});t.after(()=>turns.close());
 const w=workspace();await assert.rejects(turns.generate({contactId,discussionId:discussion.id,requestKey:randomUUID(),text:w.draftText,workspace:w,confirmedContact:true}));
 assert.equal(f.requests.length,0);
});
