import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/sqlite-reply-candidates/support.mjs';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {SqliteReplyTurns} from '../src/reply/sqlite/candidates/turns.ts';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';

function memoryToolResponse(res,query){
 const events=[{type:'message_start',message:{id:randomUUID(),model:'synthetic-model',usage:{input_tokens:3,output_tokens:0}}},
  {type:'content_block_start',index:0,content_block:{type:'tool_use',id:randomUUID(),name:'search_relationship_memory',input:{query}}},
  {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:8}},{type:'message_stop'}];
 res.setHeader('content-type','text/event-stream');res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}
function memoryBasis(request){return Number(JSON.stringify(request).match(/实际输入材料\[(\d+)\] memory/)[1]);}

test('正式08管理版本进入12完整输入，修正及保护变更后旧选稿和手改均失效',{timeout:20000},async t=>{
 const f=await fixture(t,{onRequest:async(_req,res,request,n)=>{
  if(n%2===0)return;assert.doesNotMatch(JSON.stringify(request),/合成联系人目前在高雄生活|合成联系人目前在台南生活/);memoryToolResponse(res,'合成联系人目前生活');return true;
 },content:request=>JSON.stringify({candidates:[{parts:['依据当前正式记忆的合成回复'],basis:[memoryBasis(request)]}]})});
 const contactId=f.ids[0],management=new SqliteMemoryManagement(f.storage,f.owner),scope={scopeKind:'contact',contactId};
 const created=await management.decide({requestKey:'manual-before-reply',action:'manual',scope,body:'合成联系人目前在高雄生活。'});
 const d=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 const generate=text=>turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text,confirmedContact:true});
 await generate('聊聊联系人目前的生活');let page=await service.view(contactId,d.id);const first=page[0].candidates[0];
 assert.match(JSON.stringify(f.requests[1]),/合成联系人目前在高雄生活/);assert.equal(page[0].sourceState,'available');assert.equal(first.basis[0].verification,'actual_input');assert.match(first.basis[0].text,/合成联系人目前在高雄生活/);
 const old={contactId,discussionId:d.id,candidateId:first.candidateId,versionNo:1},selected=await service.select(old);
 let memory=(await management.read(scope)).memories.find(m=>m.id===created.memoryId);
 await management.decide({requestKey:'correct-before-reread',action:'correct',memoryId:memory.id,expectedVersionNo:memory.current.versionNo,expectedHeadRevision:memory.headRevision,body:'合成联系人目前在台南生活。'});
 page=await service.view(contactId,d.id);assert.equal(page[0].sourceState,'unavailable');assert.deepEqual(page[0].candidates,[]);
 await assert.rejects(service.select(old),{code:'reply_source_unavailable'});await assert.rejects(service.edit({...old,parts:['不得恢复旧记忆稿']}),{code:'reply_source_unavailable'});
 await assert.rejects(turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text:'旧版本继续',confirmedContact:true,carriedSelectionId:selected.id}),{code:'reply_source_unavailable'});assert.equal(f.requests.length,2);
 await generate('结合修正资料聊聊联系人目前的生活');assert.equal(f.requests.length,4);assert.match(JSON.stringify(f.requests[3]),/合成联系人目前在台南生活/);assert.doesNotMatch(JSON.stringify(f.requests[3]),/合成联系人目前在高雄生活/);
 memory=(await management.read(scope)).memories.find(m=>m.id===created.memoryId);
 await management.decide({requestKey:'protect-before-reread',action:'protect',memoryId:memory.id,expectedVersionNo:memory.current.versionNo,expectedHeadRevision:memory.headRevision});
 page=await service.view(contactId,d.id);assert.ok(page.every(r=>r.sourceState==='unavailable'&&r.candidates.length===0));assert.equal(f.requests.length,4);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});


test('模型在途新增无关记忆不会阻止冻结快照保存或旧候选继续',async t=>{
 let management,scope;
 const f=await fixture(t,{onRequest:async(_req,res,_request,n)=>{if(n!==1)return;memoryToolResponse(res,'本轮原本使用的资料');return true;},content:async request=>{
  await management.decide({requestKey:randomUUID(),action:'manual',scope,body:'新增无关的合成资料。'});
  return JSON.stringify({candidates:[{parts:['保留本轮冻结的回复'],basis:[memoryBasis(request)]}]});
 }});
 const contactId=f.ids[0];management=new SqliteMemoryManagement(f.storage,f.owner);scope={scopeKind:'contact',contactId};
 await management.decide({requestKey:randomUUID(),action:'manual',scope,body:'本轮原本使用的资料。'});
 const d=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 await turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text:'参考本轮原本使用的资料',confirmedContact:true});
 const candidate=(await service.view(contactId,d.id))[0].candidates[0];assert.ok(candidate);
 assert.equal(candidate.basis[0].verification,'actual_input');assert.match(candidate.basis[0].text,/本轮原本使用的资料。/);assert.equal(f.requests.length,2);
 await service.select({contactId,discussionId:d.id,candidateId:candidate.candidateId,versionNo:1});
 assert.match(JSON.stringify(f.requests[1]),/本轮原本使用的资料。/);
 assert.doesNotMatch(JSON.stringify(f.requests[1]),/新增无关/);
});
