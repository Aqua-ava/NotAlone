import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
const knowledgeRegistry=new URL('./fixtures/sqlite-reply-candidates/knowledge-registry.mjs',import.meta.url).href;
function memoryToolResponse(res,query){
 const events=[{type:'message_start',message:{id:randomUUID(),model:'synthetic-model',usage:{input_tokens:3,output_tokens:0}}},
  {type:'content_block_start',index:0,content_block:{type:'tool_use',id:randomUUID(),name:'search_relationship_memory',input:{query}}},
  {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:8}},{type:'message_stop'}];
 res.setHeader('content-type','text/event-stream');res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}
test('媒体占位和文字混合的近期会话仍可生成，媒体占位不冒充正文进入候选输入',async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs');const {SqliteReplyTurns}=await import('../src/reply/sqlite/candidates/turns.ts');
 const f=await realFixture(t,{synchronizeHistory:false,content:JSON.stringify({candidates:[{parts:['混合会话的合成候选'],basis:[1]}]})}),original=f.channel.page;
 f.channel.page=async(...args)=>{const page=await original(...args);return {...page,records:[...page.records,{...page.records[0],localId:'2',kind:'image',text:null,originalType:'3'}]};};await f.contacts.setReading(true);await f.history.synchronize(f.ids[0]);
 const d=await f.discussions.newDiscussion(f.ids[0]),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 await turns.generate({contactId:f.ids[0],discussionId:d.id,requestKey:randomUUID(),text:'根据文字回应',confirmedContact:true});assert.equal((await service.view(f.ids[0],d.id))[0].candidates.length,1);assert.equal(f.requests.length,1);
 assert.doesNotMatch(JSON.stringify(f.requests[0]),/\[图片\]|媒体占位/);assert.equal((await f.history.read(f.ids[0])).messages.length,2);
});

test('普通候选默认上下文取消息时间最近页，晚导入旧文字不挤掉最新聊天且不跨联系人',async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs');const {SqliteReplyTurns}=await import('../src/reply/sqlite/candidates/turns.ts');
 const f=await realFixture(t,{synchronizeHistory:false,content:JSON.stringify({candidates:[{parts:['基于近期聊天的合成候选'],basis:[1]}]})});
 const original=f.channel.page;
 f.channel.page=async(...args)=>{
  const page=await original(...args),base=page.records[0];
  if(args[0].token.contact_id!==f.ids[0])return {...page,records:[{...base,text:'另一联系人的合成资料'}]};
  return {...page,records:[{...base,text:'最新的合成聊天应进入默认上下文',sentAt:'1793318400000'},
   ...Array.from({length:22},(_,i)=>({...base,localId:String(i+2),text:`晚导入的旧归档${i}`,sentAt:String(1700000000000-i*1000)}))]};
 };
 await f.contacts.setReading(true);for(const id of f.ids)await f.history.synchronize(id);
 const d=await f.discussions.newDiscussion(f.ids[0]),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 await turns.generate({contactId:f.ids[0],discussionId:d.id,requestKey:randomUUID(),text:'使用最近聊天回应',confirmedContact:true});
 const request=JSON.stringify(f.requests[0]);assert.match(request,/最新的合成聊天应进入默认上下文/);
 assert.doesNotMatch(request,/无时间的合成消息|另一联系人的合成资料/);
 assert.match((await service.view(f.ids[0],d.id))[0].candidates[0].basis[0].text,/最新的合成聊天应进入默认上下文/);
 assert.equal(f.requests.length,1);
});

test('合成本人记忆消费者保留跨联系人真实来源，删除贡献联系人也清另一讨论候选完整闭包',async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs');const {SqliteReplyTurns}=await import('../src/reply/sqlite/candidates/turns.ts');const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts');const {ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');
 const f=await realFixture(t,{registryModule:knowledgeRegistry,onRequest:async(_req,res,request,n)=>{
  if(n!==1)return;assert.doesNotMatch(JSON.stringify(request),/合成本人已采纳资料/);memoryToolResponse(res,'喜欢安静散步');return true;
 },content:request=>{
  const wire=JSON.stringify(request);assert.match(wire,/合成本人已采纳资料/);
  const itemNo=Number(wire.match(/实际输入材料\[(\d+)\] memory/)[1]);
  return JSON.stringify({candidates:[{parts:['依据本人资料形成的合成候选'],basis:[itemNo]}]});
 }});const contactId=f.ids[1],sourceContact=f.ids[0];
 await f.storage.execute('synthetic.publishReplyKnowledge',{ownerId:f.owner,contactId,sourceContactId:sourceContact,mode:'owner'});
 const d=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 await turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text:'结合本人资料表达',confirmedContact:true});
 const basis=(await service.view(contactId,d.id))[0].candidates[0].basis[0];assert.match(basis.text,/本人已采纳/);assert.equal(basis.verification,'actual_input');assert.equal(f.requests.length,2);
 const deletion=new DeletionService(f.storage,f.holders,new ManagedFiles(f.root)),op=await deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'contact',contactId:sourceContact}}),done=await deletion.advance(op);assert.equal(done.state,'completed',JSON.stringify(done.checks));assert.deepEqual(await service.view(contactId,d.id),[]);assert.equal((await f.contacts.directory()).contacts.length,1);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('多段历史讨论与同讨论旧发言不进入新候选，显式携入选稿仍按合同进入',async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs');const {SqliteReplyTurns}=await import('../src/reply/sqlite/candidates/turns.ts');const {SqliteDiscussionTurns}=await import('../src/reply/sqlite/turns.ts');
 const f=await realFixture(t,{content:(_request,count)=>count<=3?`旧讨论助手正文-${count}`:JSON.stringify({candidates:[{parts:['基于本次输入的合成候选'],basis:[1]}]})}),contactId=f.ids[0];
 const discussions=new SqliteDiscussionTurns({...f,authorize:async()=>{}});t.after(()=>discussions.close());
 const oldA=await f.discussions.newDiscussion(contactId);await discussions.generate({contactId,discussionId:oldA.id,requestKey:randomUUID(),text:'旧讨论用户发言-甲',confirmedContact:true});
 const oldB=await f.discussions.newDiscussion(contactId);await discussions.generate({contactId,discussionId:oldB.id,requestKey:randomUUID(),text:'旧讨论用户发言-乙',confirmedContact:true});
 const current=await f.discussions.newDiscussion(contactId);await discussions.generate({contactId,discussionId:current.id,requestKey:randomUUID(),text:'当前讨论早前用户发言',confirmedContact:true});
 assert.equal(f.requests.length,3);const before=await f.discussions.view(contactId,current.id),copiesBefore=await f.storage.execute('runtime.inventory',{ownerId:f.owner});assert.equal(copiesBefore.length,3);
 const service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 const oldPattern=/旧讨论用户发言-甲|旧讨论用户发言-乙|当前讨论早前用户发言|旧讨论助手正文-[123]/;
 // 候选装配不得读取讨论目录/正文；读取讨论 entry 应直接失败。
 const originalView=f.discussions.view.bind(f.discussions);f.discussions.view=async()=>{throw new Error('候选不得读取讨论目录');};
 try{await turns.generate({contactId,discussionId:current.id,requestKey:randomUUID(),text:'本次帮我表达',confirmedContact:true});}finally{f.discussions.view=originalView;}
 assert.equal(f.requests.length,4);
 assert.doesNotMatch(JSON.stringify(f.requests[3]),oldPattern,'新候选模型请求不得含旧讨论正文');
 const page=(await service.view(contactId,current.id)).at(-1);assert.ok(page.candidates[0]);assert.doesNotMatch(JSON.stringify(page.candidates[0].basis),oldPattern,'候选依据不得指向旧讨论');
 const after=await f.discussions.view(contactId,current.id),copiesAfter=await f.storage.execute('runtime.inventory',{ownerId:f.owner});
 assert.equal(copiesAfter.length,4,'每次候选使用独立运行副本');assert.notEqual(after.discussion.currentRuntimeId,before.discussion.currentRuntimeId);
 assert.ok(copiesAfter.some(copy=>copy.id===before.discussion.currentRuntimeId&&copy.state==='ready'),'旧讨论运行副本保留而不被复用或删除');
 const selected=await service.select({contactId,discussionId:current.id,candidateId:page.candidates[0].candidateId,versionNo:1});
 const workspace={action:'suggest',draftText:'',tone:'warm',instruction:'',contextText:'本次补充背景-显式携入检查',includeRelationshipContext:true};
 await turns.generate({contactId,discussionId:current.id,requestKey:randomUUID(),text:'',workspace,confirmedContact:true,carriedSelectionId:selected.id});assert.equal(f.requests.length,5);
 const carried=JSON.stringify(f.requests[4]);assert.match(carried,/用户明确选择继续的候选/);assert.match(carried,/基于本次输入的合成候选/);assert.match(carried,/本次补充背景-显式携入检查/);assert.doesNotMatch(carried,oldPattern);
});

test('旧输入合同显式携带讨论entry时在冻结输入中被过滤，当前请求正文仍保留',async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs');
 const f=await realFixture(t,{content:JSON.stringify({candidates:[{parts:['合成候选'],basis:[1]}]})}),contactId=f.ids[0];
 const d=await f.discussions.newDiscussion(contactId);
 const legacyKey=randomUUID(),legacyConfirmation=await f.storage.execute('identity.manualConfirm',{ownerId:f.owner,contactId,contextToken:legacyKey,id:randomUUID(),at:Date.now()});
 await f.discussions.begin(contactId,legacyKey,'旧输入合同的讨论发言正文-合成',{kind:'manual',confirmationId:legacyConfirmation});
 const legacyEntry=(await f.discussions.view(contactId,d.id)).entries.find(entry=>entry.body==='旧输入合同的讨论发言正文-合成');assert.ok(legacyEntry);
 const requestKey=randomUUID(),confirmationId=await f.storage.execute('identity.manualConfirm',{ownerId:f.owner,contactId,contextToken:requestKey,id:randomUUID(),at:Date.now()});
 const service=new SqliteReplyCandidateService(f.storage,f.owner),accepted=await service.begin({contactId,discussionId:d.id,requestKey,text:'本次旧合同请求正文-合成',identity:{kind:'manual',confirmationId}});
 const frozen=await f.storage.execute('reply.freezeInput',{...accepted.attempt,contextId:randomUUID(),skillRun:{packages:[],eligible:[]},items:[{kind:'entry',entryId:legacyEntry.id}],queryText:'本次旧合同请求正文-合成',at:Date.now()});
 assert.ok(Array.isArray(frozen)&&frozen.length>0);assert.ok(!frozen.some(item=>item.text.includes('旧输入合同的讨论发言正文')),'讨论entry兼容路径必须被过滤');
 assert.ok(frozen.some(item=>item.text.includes('本次旧合同请求正文-合成')),'本次请求正文仍进入冻结输入');assert.ok(frozen.every(item=>item.kind!=='entry'||item.identity.requestInput===true));
});

test('失败候选与另一联系人的旧讨论不进入后续新候选输入',async t=>{
 const {fixture:realFixture}=await import('./fixtures/sqlite-reply-candidates/support.mjs');const {SqliteReplyTurns}=await import('../src/reply/sqlite/candidates/turns.ts');
 const f=await realFixture(t,{content:(_request,count)=>count===1?'不是JSON的合成模型输出':JSON.stringify({candidates:[{parts:[`第${count}次合成候选`],basis:[1]}]})}),contactId=f.ids[0];
 const d=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 await assert.rejects(turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text:'失败请求的合成用户正文',confirmedContact:true}));assert.equal(f.requests.length,1);
 await turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text:'第二次合成请求正文',confirmedContact:true});assert.equal(f.requests.length,2);
 assert.doesNotMatch(JSON.stringify(f.requests[1]),/失败请求的合成用户正文/,'失败候选的旧正文不得进入后续候选');
 const other=await f.discussions.newDiscussion(f.ids[1]);
 await turns.generate({contactId:f.ids[1],discussionId:other.id,requestKey:randomUUID(),text:'另一联系人的合成请求正文',confirmedContact:true});assert.equal(f.requests.length,3);
 assert.doesNotMatch(JSON.stringify(f.requests[2]),/失败请求的合成用户正文|第二次合成请求正文/);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
