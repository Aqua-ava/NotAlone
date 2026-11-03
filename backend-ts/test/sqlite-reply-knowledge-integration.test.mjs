import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/sqlite-reply-candidates/support.mjs';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {SqliteReplyTurns} from '../src/reply/sqlite/candidates/turns.ts';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';

test('正式08管理版本进入12完整输入，修正及保护变更后旧选稿和手改均失效',{timeout:20000},async t=>{
 const f=await fixture(t,{content:JSON.stringify({candidates:[{parts:['依据当前正式记忆的合成回复'],basis:[1]}]})});
 const contactId=f.ids[0],management=new SqliteMemoryManagement(f.storage,f.owner),scope={scopeKind:'contact',contactId};
 const created=await management.decide({requestKey:'manual-before-reply',action:'manual',scope,body:'合成联系人目前在高雄生活。'});
 const d=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 const generate=text=>turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text,confirmedContact:true});
 await generate('结合当前资料回复');let page=await service.view(contactId,d.id);const first=page[0].candidates[0];
 assert.match(JSON.stringify(f.requests[0]),/合成联系人目前在高雄生活/);assert.equal(page[0].sourceState,'available');
 const old={contactId,discussionId:d.id,candidateId:first.candidateId,versionNo:1},selected=await service.select(old);
 let memory=(await management.read(scope)).memories.find(m=>m.id===created.memoryId);
 await management.decide({requestKey:'correct-before-reread',action:'correct',memoryId:memory.id,expectedVersionNo:memory.current.versionNo,expectedHeadRevision:memory.headRevision,body:'合成联系人目前在台南生活。'});
 page=await service.view(contactId,d.id);assert.equal(page[0].sourceState,'unavailable');assert.deepEqual(page[0].candidates,[]);
 await assert.rejects(service.select(old),{code:'reply_source_unavailable'});await assert.rejects(service.edit({...old,parts:['不得恢复旧记忆稿']}),{code:'reply_source_unavailable'});
 await assert.rejects(turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text:'旧版本继续',confirmedContact:true,carriedSelectionId:selected.id}),{code:'reply_source_unavailable'});assert.equal(f.requests.length,1);
 await generate('使用修正后的当前资料重新表达');assert.equal(f.requests.length,2);assert.match(JSON.stringify(f.requests[1]),/合成联系人目前在台南生活/);assert.doesNotMatch(JSON.stringify(f.requests[1]),/合成联系人目前在高雄生活/);
 memory=(await management.read(scope)).memories.find(m=>m.id===created.memoryId);
 await management.decide({requestKey:'protect-before-reread',action:'protect',memoryId:memory.id,expectedVersionNo:memory.current.versionNo,expectedHeadRevision:memory.headRevision});
 page=await service.view(contactId,d.id);assert.ok(page.every(r=>r.sourceState==='unavailable'&&r.candidates.length===0));assert.equal(f.requests.length,2);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});


test('模型在途新增无关记忆不会阻止冻结快照保存或旧候选继续',async t=>{
 let management,scope;
 const f=await fixture(t,{content:async()=>{
  await management.decide({requestKey:randomUUID(),action:'manual',scope,body:'新增无关的合成资料。'});
  return JSON.stringify({candidates:[{parts:['保留本轮冻结的回复'],basis:[1]}]});
 }});
 const contactId=f.ids[0];management=new SqliteMemoryManagement(f.storage,f.owner);scope={scopeKind:'contact',contactId};
 await management.decide({requestKey:randomUUID(),action:'manual',scope,body:'本轮原本使用的资料。'});
 const d=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 await turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text:'继续聊',confirmedContact:true});
 const candidate=(await service.view(contactId,d.id))[0].candidates[0];assert.ok(candidate);
 await service.select({contactId,discussionId:d.id,candidateId:candidate.candidateId,versionNo:1});
 assert.doesNotMatch(JSON.stringify(f.requests[0]),/新增无关/);
});
