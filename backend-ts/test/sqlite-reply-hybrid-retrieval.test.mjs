import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/sqlite-reply-candidates/support.mjs';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
import {SqliteReplyTurns} from '../src/reply/sqlite/candidates/turns.ts';
import {createRetrievalIndex} from '../src/retrieval/index-runtime.ts';

const vector=(x,y=0)=>[x,y,...Array(510).fill(0)];
const query='徒步';
function toolResponse(res,name){
 const events=[{type:'message_start',message:{id:randomUUID(),model:'synthetic-model',usage:{input_tokens:3,output_tokens:0}}},
  {type:'content_block_start',index:0,content_block:{type:'tool_use',id:randomUUID(),name,input:{}}},
  {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify({query})}},
  {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:8}},{type:'message_stop'}];
 res.setHeader('content-type','text/event-stream');res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}
function firstActual(request,kind){
 const match=JSON.stringify(request).match(new RegExp(`实际输入材料\\[(\\d+)\\] ${kind}`));
 assert.ok(match,'正式后续供应商请求须含已编号的搜索正文');return Number(match[1]);
}
function supplier(kind,initialCheck=()=>{}){
 return {synchronizeHistory:false,onRequest:async(_req,res,request,n)=>{
  if(n%2===0)return;
  assert.ok(request.tools.some(tool=>tool.name===`search_relationship_${kind==='memory'?'memory':'history'}`));
  initialCheck(request);toolResponse(res,`search_relationship_${kind==='memory'?'memory':'history'}`);return true;
 },content:request=>JSON.stringify({candidates:[{parts:['合成回复。'],basis:[firstActual(request,kind)]}]})};
}
function searches(f){
 const results=[],execute=f.storage.execute.bind(f.storage);
 f.storage.execute=async(name,input,...rest)=>{const value=await execute(name,input,...rest);if(name==='reply.finishSearch')results.push(value);return value;};
 return results;
}
async function generate(f,retrieval){
 const contactId=f.ids[0],d=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner);
 const turns=new SqliteReplyTurns({...f,service,retrieval,authorize:async()=>{}}),before=f.requests.length;
 const workspace={action:'express',draftText:'帮我想个自然的回应',contextText:'',includeRelationshipContext:true};
 try{
  try{await turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text:workspace.draftText,confirmedContact:true,workspace});}
  catch(error){throw f.supplierErrors[0]??error;}
  assert.equal(f.requests.length,before+2,'官方DSH执行搜索Tool后继续同轮生成');
  return {view:(await service.view(contactId,d.id))[0],request:f.requests[before+1]};
 }finally{await turns.close();}
}
async function memory(f,key,body,contactId=f.ids[0]){
 return new SqliteMemoryManagement(f.storage,f.owner).decide({requestKey:key,action:'manual',scope:{scopeKind:'contact',contactId},body});
}

// 语言模型与embedding使用明确合成边界；SQLite、来源核验、正式DSH运行与Tool循环均沿真实实现。
test('L1无字面重合的同义记忆由vector命中，正式Tool两轮查询复用一次正文索引且隔离联系人',async t=>{
 const target='偏爱登山。',unrelated='公司报销流程复杂。',foreign='其他联系人的越野承诺。';
 const f=await fixture(t,supplier('memory',request=>assert.doesNotMatch(JSON.stringify(request),/偏爱登山|其他联系人的越野承诺/))),results=searches(f);
 await memory(f,'hybrid-l1-target',target);await memory(f,'hybrid-l1-other',unrelated);await memory(f,'hybrid-l1-foreign',foreign,f.ids[1]);
 const calls=[];let preparing=true;
 const retrieval=createRetrievalIndex({storage:f.storage,ownerId:f.owner,holders:f.holders,embed:async texts=>{
  calls.push([...texts]);
  if(!preparing){assert.deepEqual(texts,[query]);assert.equal(f.requests.length%2,1,'必须等模型明确搜索后才计算query');}
  return texts.map(text=>text===query||text===target||text===foreign?vector(1):vector(0,1));
 }});
 try{
  await retrieval.flushForTests();preparing=false;const coldCalls=calls.length;
  assert.deepEqual(calls.flat().sort(),[target,unrelated,foreign].sort());
  for(let n=0;n<2;n++){
   const result=await generate(f,retrieval),search=results.at(-1);
   assert.equal(search.strategy,'vector');assert.equal(search.indexIncomplete,false);
   assert.equal(search.items[0].text.startsWith(target),true);assert.ok(search.items.every(item=>!item.text.includes(foreign)));
   assert.match(JSON.stringify(result.request),/偏爱登山/);assert.doesNotMatch(JSON.stringify(result.request),/其他联系人的越野承诺/);
   assert.equal(result.view.candidates[0].basis[0].verification,'actual_input');assert.match(result.view.candidates[0].basis[0].text,/偏爱登山/);
  }
  assert.deepEqual(calls.slice(coldCalls),[[query],[query]],'后续轮次只embedding各自query，正文不重算');
 }finally{await retrieval.close();}
});

test('L0最近50条之外且无字面重合的旧原话由vector命中，保留原作者时间和实际依据',async t=>{
 const old='旧约定：周末一起登山。';
 const f=await fixture(t,supplier('message',request=>{
  assert.ok(!JSON.stringify(request).includes(old),'首次请求的最近50条不应夹带更早原话');
  assert.match(JSON.stringify(request),/近期消息59/);
 })),results=searches(f),page=f.channel.page;
 f.channel.page=async(...args)=>{
  const value=await page(...args);return {...value,records:Array.from({length:60},(_,i)=>({...value.records[0],localId:String(i+1),sender:i===0?'owner':'contact',text:i===0?old:`近期消息${i}`,sentAt:String(1700000000000+i*1000)}))};
 };
 await f.contacts.setReading(true);await f.history.synchronize(f.ids[0]);
 const calls=[];let preparing=true;
 const retrieval=createRetrievalIndex({storage:f.storage,ownerId:f.owner,holders:f.holders,embed:async texts=>{
  calls.push([...texts]);if(!preparing){assert.deepEqual(texts,[query]);assert.equal(f.requests.length,1);}
  return texts.map(text=>text===query||text===old?vector(1):vector(0,1));
 }});
 try{
  await retrieval.flushForTests();preparing=false;const coldCalls=calls.length;
  assert.equal(calls.flat().length,60);assert.equal(calls.flat().filter(text=>text===old).length,1);
  const result=await generate(f,retrieval),search=results.at(-1);
  assert.equal(search.strategy,'vector');assert.equal(search.indexIncomplete,false);
  assert.match(search.items[0].text,/2023-11-15.*我：旧约定：周末一起登山/);
  assert.equal(search.items[0].identity.senderRole,'owner');
  const basis=result.view.candidates[0].basis[0];assert.equal(basis.kind,'message');assert.equal(basis.verification,'actual_input');assert.match(basis.text,/我：旧约定：周末一起登山/);
  assert.deepEqual(calls.slice(coldCalls),[[query]],'旧历史正文只在准备阶段计算向量');
 }finally{await retrieval.close();}
});

test('BM25与vector共现的记忆经RRF排在余弦更高的纯vector项之前',async t=>{
 const both='徒步徒步。',denseOnly='偏爱登山。',lexical='徒步装备清单请按天气和路线准备。';
 const f=await fixture(t,supplier('memory')),results=searches(f);
 for(const [n,body] of [both,denseOnly,lexical].entries())await memory(f,`hybrid-rrf-${n}`,body);
 const calls=[];let preparing=true;
 const retrieval=createRetrievalIndex({storage:f.storage,ownerId:f.owner,holders:f.holders,embed:async texts=>{
  calls.push([...texts]);if(!preparing){assert.deepEqual(texts,[query]);assert.equal(f.requests.length,1);}
  return texts.map(text=>text===query||text===denseOnly?vector(1):text===both?vector(.8,.6):vector(0,1));
 }});
 try{
  await retrieval.flushForTests();preparing=false;const coldCalls=calls.length;
  const result=await generate(f,retrieval),search=results.at(-1);
  assert.equal(search.strategy,'hybrid');assert.equal(search.indexIncomplete,false);
  assert.equal(search.items[0].text.startsWith(both),true,'等权RRF双路命中应优先，不能仅按原始余弦排序');
  assert.ok(search.items.find(item=>item.text.startsWith(denseOnly)),'RRF没有旧0.48相关性门槛；保留合法单路候选');
  assert.match(result.view.candidates[0].basis[0].text,/徒步徒步/);assert.equal(result.view.candidates[0].basis[0].verification,'actual_input');
  assert.deepEqual(calls.slice(coldCalls),[[query]]);
 }finally{await retrieval.close();}
});
