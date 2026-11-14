import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fixture} from './fixtures/sqlite-reply-candidates/support.mjs';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
import {SqliteReplyTurns} from '../src/reply/sqlite/candidates/turns.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';

const workspace={action:'suggest',draftText:'',tone:'original',instruction:'',contextText:'',includeRelationshipContext:true};
function toolResponse(res,name,query){
 const events=[{type:'message_start',message:{id:randomUUID(),model:'synthetic-model',usage:{input_tokens:3,output_tokens:0}}},
  {type:'content_block_start',index:0,content_block:{type:'tool_use',id:randomUUID(),name,input:{}}},
  {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify({query})}},
  {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:8}},{type:'message_stop'}];
 res.setHeader('content-type','text/event-stream');res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}
function actualItem(request,kind){
 const text=JSON.stringify(request),match=text.match(new RegExp(`实际输入材料\\[(\\d+)\\] ${kind}`));
 assert.ok(match,`后续真实模型请求应包含${kind}搜索结果`);return Number(match[1]);
}
async function turn(f,t,options={}){
 const contactId=f.ids[0],d=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner);
 const turns=new SqliteReplyTurns({...f,service,authorize:async()=>{},...options});t.after(()=>turns.close());
 try{await turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text:'',confirmedContact:true,workspace});}
 catch(error){throw f.supplierErrors[0]??error;}
 return (await service.view(contactId,d.id))[0];
}

test('候选先看最近50条，首次请求不预检索记忆或计算语义向量',async t=>{
 const memory='不应预注入的园艺偏好。';let embeddings=0;
 const f=await fixture(t,{synchronizeHistory:false,content:JSON.stringify({candidates:[{parts:['先回应当前聊天。'],basis:[1]}]})});
 const page=f.channel.page;f.channel.page=async(...args)=>{const value=await page(...args);return {...value,records:Array.from({length:55},(_,i)=>({...value.records[0],localId:String(i+1),text:`园艺话题${i}`,sentAt:String(1700000000000+i*1000)}))};};
 await f.contacts.setReading(true);await f.history.synchronize(f.ids[0]);
 await new SqliteMemoryManagement(f.storage,f.owner).decide({requestKey:'no-pre-recall',action:'manual',scope:{scopeKind:'contact',contactId:f.ids[0]},body:memory});
 await turn(f,t,{embed:async texts=>{embeddings++;return texts.map(()=>[1,0]);}});
 const request=f.requests[0],text=JSON.stringify(request);
 assert.ok(!text.includes(memory),'首次请求不应自动注入相关L1');
 assert.ok(text.includes('园艺话题54'));assert.ok(text.includes('园艺话题5'));
 assert.ok(!text.includes('园艺话题4\\n'),'原文上下文仍限最近50条');
 assert.deepEqual(request.tools.map(tool=>tool.name).sort(),['search_relationship_history','search_relationship_memory']);
 assert.equal(embeddings,0);
});

test('模型主动检索L1后由DSH继续生成，候选仅引用实际入模的结果',async t=>{
 const memory='关系记忆：喜欢安静的园艺活动。';
 const f=await fixture(t,{onRequest:async(_req,res,request,n)=>{
  if(n===1){assert.ok(!JSON.stringify(request).includes(memory));toolResponse(res,'search_relationship_memory','园艺偏好');return true;}
 },content:request=>JSON.stringify({candidates:[{parts:['可以聊聊最近种的植物。'],basis:[actualItem(request,'memory')]}]})});
 await new SqliteMemoryManagement(f.storage,f.owner).decide({requestKey:'on-demand-memory',action:'manual',scope:{scopeKind:'contact',contactId:f.ids[0]},body:memory});
 const view=await turn(f,t);
 assert.equal(f.requests.length,2);assert.equal(view.candidates[0].basis[0].kind,'memory');
 assert.match(view.candidates[0].basis[0].text,/喜欢安静的园艺活动/);
 assert.equal(view.candidates[0].basis[0].verification,'actual_input');
});

test('模型可搜索初始50条之外的同联系人历史，原作者和时间随实际结果入模',async t=>{
 const oldText='更早的原话：我们约好周末一起散步。';
 const f=await fixture(t,{synchronizeHistory:false,onRequest:async(_req,res,request,n)=>{
  if(n===1){assert.ok(!JSON.stringify(request).includes(oldText));toolResponse(res,'search_relationship_history','周末散步约定');return true;}
 },content:request=>JSON.stringify({candidates:[{parts:['周末散步的事还记得。'],basis:[actualItem(request,'message')]}]})});
 // 合成供应商按UTF-8字节估算token，为50条中文及新增工具保留足够容量。
 f.model.budgetProfile.context_window_tokens=16384;
 const page=f.channel.page;f.channel.page=async(...args)=>{const value=await page(...args);return {...value,records:Array.from({length:55},(_,i)=>({...value.records[0],localId:String(i+1),sender:i===0?'owner':'contact',text:i===0?oldText:`近期无关消息${i}`,sentAt:String(1700000000000+i*1000)}))};};
 await f.contacts.setReading(true);await f.history.synchronize(f.ids[0]);
 const view=await turn(f,t);
 assert.equal(f.requests.length,2);assert.equal(view.candidates[0].basis[0].kind,'message');
 assert.match(view.candidates[0].basis[0].text,/2023-11-15.*我：更早的原话/);
 assert.equal(view.candidates[0].basis[0].verification,'actual_input');
});

test('背景关闭时不发布搜索工具，不计算向量或读取自动聊天与记忆',async t=>{
 const f=await fixture(t,{content:JSON.stringify({candidates:[{parts:['仅依据本次想法。'],basis:[1]}]})}),contactId=f.ids[0];
 await new SqliteMemoryManagement(f.storage,f.owner).decide({requestKey:'closed-search',action:'manual',scope:{scopeKind:'contact',contactId},body:'不应被带入的长期记忆。'});
 const d=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner);
 const turns=new SqliteReplyTurns({...f,service,authorize:async()=>{},embed:async()=>assert.fail('背景关闭不应计算向量')});t.after(()=>turns.close());
 await turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text:'',confirmedContact:true,workspace:{...workspace,includeRelationshipContext:false}});
 assert.deepEqual(f.requests[0].tools??[],[]);
 assert.ok(!JSON.stringify(f.requests[0]).includes('不应被带入的长期记忆'));
 assert.ok(!JSON.stringify(f.requests[0]).includes('已保存聊天'));
});

test('空结果可换词或换工具，三次尝试耗尽后仍可根据已有材料生成',async t=>{
 const f=await fixture(t,{onRequest:async(_req,res,_request,n)=>{
  if(n<=4){toolResponse(res,n%2?'search_relationship_memory':'search_relationship_history',`不存在的星际资料${n}`);return true;}
 },content:JSON.stringify({candidates:[{parts:['先接住当前话题。'],basis:[1]}]})});
 await turn(f,t);
 assert.equal(f.requests.length,5);
 const second=JSON.stringify(f.requests[1]),last=JSON.stringify(f.requests[4]);
 assert.match(second,/本次查询未命中/);assert.match(last,/本轮检索预算已耗尽/);
});

test('已读取的记忆在Skill降级后的新运行副本仍真实入模且可引用',async t=>{
 const memory='降级后保留的关系记忆：喜欢合成园艺。';let changed=false;
 const f=await fixture(t,{onRequest:async(_req,res,request,n)=>{
  if(n===1){toolResponse(res,'search_relationship_memory','园艺');return true;}
  assert.deepEqual(request.tools.map(tool=>tool.name).sort(),['search_relationship_history','search_relationship_memory']);
 },content:request=>JSON.stringify({candidates:[{parts:['可以继续聊园艺。'],basis:[Number(JSON.stringify(request).match(/\[(\d+)\] memory\\n/)[1])]}]})});
 f.model.budgetProfile.context_window_tokens=16384;
 const directory=join(f.skillRoot,'gentle'),path=join(directory,'SKILL.md');await mkdir(directory);
 await writeFile(path,'---\nname: gentle\ndescription: 合成园艺聊天方法\n---\n自然回应当前话题。\n');
 let skill=await f.library.discover('gentle');await f.library.setEnabled(skill.id,skill.headRevision,'enabled');
 await new SqliteMemoryManagement(f.storage,f.owner).decide({requestKey:'fallback-memory',action:'manual',scope:{scopeKind:'contact',contactId:f.ids[0]},body:memory});
 const view=await turn(f,t,{embed:async texts=>{if(!changed){changed=true;await writeFile(path,'已改变的合成Skill内容。');}return texts.map(()=>[1,0]);}});
 assert.equal(changed,true);assert.equal(f.requests.length,2);
 assert.ok(JSON.stringify(f.requests[1]).includes(memory));
 assert.match(view.candidates[0].basis[0].text,/降级后保留的关系记忆/);
 assert.equal(view.candidates[0].basis[0].verification,'actual_input');
});

test('删除仅在冻结池中且从未返回的历史来源，清除元数据并保留无关候选',async t=>{
 const oldText='旧原话仅用于搜索范围，未进入实际输入。';
 const f=await fixture(t,{synchronizeHistory:false,content:JSON.stringify({candidates:[{parts:['只依据当前聊天。'],basis:[1]}]})});
 f.model.budgetProfile.context_window_tokens=16384;
 const page=f.channel.page;f.channel.page=async(...args)=>{const value=await page(...args);return {...value,records:Array.from({length:55},(_,i)=>({...value.records[0],localId:String(i+1),text:i===0?oldText:`当前消息${i}`,sentAt:String(1700000000000+i*1000)}))};};
 await f.contacts.setReading(true);await f.history.synchronize(f.ids[0]);
 const before=await turn(f,t),db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'),{readOnly:true});t.after(()=>db.close());
 const old=db.prepare('SELECT m.id,r.id record_id FROM message m JOIN capture_record r ON r.owner_id=m.owner_id AND r.message_id=m.id WHERE m.owner_id=? AND m.contact_id=? AND m.text_body=?').get(f.owner,f.ids[0],oldText);
 const metadata=()=>JSON.stringify(db.prepare("SELECT payload FROM execution_event WHERE owner_id=? AND kind='reply_search'").all(f.owner));
 assert.ok(metadata().includes(old.id));assert.ok(metadata().includes(old.record_id));
 const deletion=new DeletionService(f.storage,f.holders,new ManagedFiles(f.root)),operation=await deletion.plan({ownerId:f.owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.ids[0],sourceId:old.record_id}});
 assert.equal((await deletion.advance(operation)).state,'completed');
 assert.ok(!metadata().includes(old.id));assert.ok(!metadata().includes(old.record_id));
 const after=(await new SqliteReplyCandidateService(f.storage,f.owner).view(f.ids[0],before.discussionId??before.candidates[0].discussionId));
 assert.equal(after[0].candidates[0].candidateId,before.candidates[0].candidateId);
});
