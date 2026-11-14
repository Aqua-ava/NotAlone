import {SqliteMemoryAdjudication} from '../src/memory/sqlite/management/adjudication-service.ts';
import {adjudicationSupplier} from './fixtures/memory-management/adjudication-support.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/sqlite-reply-candidates/support.mjs';
import {modelPort} from './fixtures/memory-sqlite/support.mjs';import {supplier} from './fixtures/memory-management/supplier.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {SqliteReplyTurns} from '../src/reply/sqlite/candidates/turns.ts';import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';

function memoryToolResponse(res,query){
 const events=[{type:'message_start',message:{id:randomUUID(),model:'synthetic-model',usage:{input_tokens:3,output_tokens:0}}},
  {type:'content_block_start',index:0,content_block:{type:'tool_use',id:randomUUID(),name:'search_relationship_memory',input:{query}}},
  {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:8}},{type:'message_stop'}];
 res.setHeader('content-type','text/event-stream');res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}

test('真实08写者与12消费者同事务冻结正式版本，删除本人贡献者清另一联系人候选完整闭包',{timeout:20000},async t=>{
 const f=await fixture(t,{registryModule:new URL('./fixtures/memory-management/registry.mjs',import.meta.url).href,synchronizeHistory:false,onRequest:async(_req,res,request,n)=>{
  if(n!==1)return;assert.doesNotMatch(JSON.stringify(request),/用户长期偏好绿茶/);memoryToolResponse(res,'偏好绿茶');return true;
 },content:request=>{
  const itemNo=Number(JSON.stringify(request).match(/实际输入材料\[(\d+)\] memory/)[1]);
  return JSON.stringify({candidates:[{parts:['结合本人记忆的合成回复'],basis:[itemNo]}]});
 }});
 const [a,b]=f.ids,original=f.channel.page;
 f.channel.page=async(...args)=>{const page=await original(...args);return {...page,records:[{...page.records[0],text:'我长期住在高雄。'},{...page.records[0],localId:'2',sender:'owner',text:'我长期偏好绿茶。'}]};};
 await f.contacts.setReading(true);for(const contactId of f.ids)await f.history.synchronize(contactId);await f.contacts.setReading(false);
 const management=new SqliteMemoryManagement(f.storage,f.owner);let extraction;const adjudication=new SqliteMemoryAdjudication(f.storage,f.owner,modelPort(()=>extraction.accounting,adjudicationSupplier()),f.holders);extraction=new SqliteMemoryExtraction(f.storage,f.owner,modelPort(()=>extraction.accounting,supplier().respond),f.holders,runId=>adjudication.publishRun(runId));t.after(async()=>{await adjudication.close();await extraction.close();});
 await extraction.start('08-to-12-writer-consumer');await extraction.waitForIdle();
 const selfView=await management.read({scopeKind:'self',contactId:null});const runView=await extraction.read();const selfTask=runView.tasks.find(t=>t.scopeKind==='self');const selfTrace=await extraction.trace(selfTask.taskId);assert.equal(selfView.memories.length,2,JSON.stringify({failures:selfTrace.events.filter(e=>e.kind==='adjudication_failure').map(e=>e.payload),calls:selfTrace.calls}));
 const d=await f.discussions.newDiscussion(b),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 await turns.generate({contactId:b,discussionId:d.id,requestKey:randomUUID(),text:'结合当前本人资料表达',confirmedContact:true});
 const before=await service.view(b,d.id);assert.equal(before[0].candidates[0].basis[0].verification,'actual_input');
 assert.match(before[0].candidates[0].basis[0].text,/用户长期偏好绿茶/);
 assert.match(JSON.stringify(f.requests[1]),/用户长期偏好绿茶/);assert.equal(f.requests.length,2);
 assert.match(JSON.stringify(f.requests[1]),/用户长期偏好绿茶[^"]*（聊天时间：\d{4}-\d{2}-\d{2}，约\d+年前）/,'记忆随输入附来源聊天时间，而不是只给正文');
 assert.match(JSON.stringify(f.requests[1]),/（\d{4}-\d{2}-\d{2} \d{2}:\d{2}）(?:我|对方)：/,'聊天消息按发送时间标注');
 const frozenKnowledge=await f.storage.execute('fixture.memoryKnowledge',{ownerId:f.owner,contactId:b,discussionId:d.id}),affectedSelf=new Set(frozenKnowledge.filter(k=>k.scopeKind==='owner'&&k.sources.some(s=>s.contactId===a)).map(k=>k.id));
 const deletion=new DeletionService(f.storage,f.holders,new ManagedFiles(f.root)),plan=await deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'contact',contactId:a}}),done=await deletion.advance(plan);
 assert.equal(done.state,'completed',JSON.stringify(done.checks));assert.deepEqual(await service.view(b,d.id),[]);
 const remaining=(await management.read({scopeKind:'self',contactId:null})).memories;for(const previous of selfView.memories){const current=remaining.find(m=>m.id===previous.id)?.current??null;if(affectedSelf.has(previous.id))assert.equal(current,null);else assert.equal(current?.body,previous.current.body);}assert.equal(f.requests.length,2);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
