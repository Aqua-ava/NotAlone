import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/sqlite-reply-candidates/support.mjs';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
import {SqliteReplyTurns} from '../src/reply/sqlite/candidates/turns.ts';
import {createRetrievalIndex} from '../src/retrieval/index-runtime.ts';

function toolResponse(res,query){
 const events=[{type:'message_start',message:{id:randomUUID(),model:'synthetic-model',usage:{input_tokens:3,output_tokens:0}}},
  {type:'content_block_start',index:0,content_block:{type:'tool_use',id:randomUUID(),name:'search_relationship_history',input:{}}},
  {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify({query})}},
  {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:8}},{type:'message_stop'}];
 res.setHeader('content-type','text/event-stream');res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const vector=()=>[1,...Array(511).fill(0)];
const workspace={action:'express',draftText:'帮我回应当前话题',contextText:'',includeRelationshipContext:true};

test('历史Tool预算包含query排队与推理，内部超时不追加正文且继续保留三次尝试',async t=>{
 const budget=120,inference=deferred(),begins=[],finishes=[],old='历史查询1、历史查询2、历史查询3的旧原话。';let embeddingCalls=0;
 const f=await fixture(t,{synchronizeHistory:false,onRequest:async(_req,res,request,n)=>{
  if(n>=2)assert.match(JSON.stringify(request),/本次历史检索已超时/,'内部预算超时须作为Tool结果继续官方DSH循环');
  assert.ok(!JSON.stringify(request).includes(old),'超时检索不能把可命中的旧正文追加进后续请求');
  if(n<=4){toolResponse(res,`历史查询${n}`);return true;}
 },content:request=>{
  assert.match(JSON.stringify(request),/本轮检索预算已耗尽/);
  return JSON.stringify({candidates:[{parts:['依据当前想法回应。'],basis:[1]}]});
 }});
 const page=f.channel.page;
 f.channel.page=async(...args)=>{const value=await page(...args);return {...value,records:Array.from({length:55},(_,i)=>({...value.records[0],localId:String(i+1),text:i===0?old:`近期消息${i}`,sentAt:String(1700000000000+i*1000)}))};};
 await f.contacts.setReading(true);await f.history.synchronize(f.ids[0]);
 const prepared=createRetrievalIndex({storage:f.storage,ownerId:f.owner,holders:f.holders,embed:async texts=>texts.map(vector)});
 try{await prepared.flushForTests();}finally{await prepared.close();}
 const execute=f.storage.execute.bind(f.storage);
 f.storage.execute=async(name,input,...rest)=>{
  const sentAt=Date.now(),value=await execute(name,input,...rest);
  if(name==='reply.beginSearch')begins.push({sentAt,value});
  if(name==='reply.finishSearch')finishes.push({input,value});
  return value;
 };
 const retrieval=createRetrievalIndex({storage:f.storage,ownerId:f.owner,holders:f.holders,queryTimeoutMs:500,embed:async()=>{embeddingCalls++;await inference.promise;return [vector()];}});
 const contactId=f.ids[0],d=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner);
 const turns=new SqliteReplyTurns({...f,service,retrieval,historySearchTimeoutMs:budget,authorize:async()=>{}});
 try{
  try{await turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text:workspace.draftText,confirmedContact:true,workspace});}
  catch(error){throw f.supplierErrors[0]??error;}
  assert.equal(f.requests.length,5);assert.equal(embeddingCalls,1,'后续query在同一推理lane排队期间也计入各自预算');
  assert.equal(begins.filter(row=>row.value.status==='accepted').length,3);assert.equal(begins.at(-1).value.code,'reply_search_budget_exceeded');
  assert.equal(finishes.length,3);
  for(const [n,row] of finishes.entries()){
   assert.equal(row.input.error,'timeout');assert.equal(row.value.code,'reply_search_timeout');assert.deepEqual(row.value.items,[]);
   assert.ok(row.input.deadlineAt>=begins[n].sentAt&&row.input.deadlineAt<=begins[n].sentAt+budget+2,'finish必须沿用搜索开始时的epoch截止时间');
  }
  const view=(await service.view(contactId,d.id))[0];assert.equal(view.candidates[0].basis[0].verification,'actual_input');assert.ok(!view.candidates[0].basis[0].text.includes(old));
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1)),/实际输入材料\[\d+\] message/);
  let closed=false;const closing=retrieval.close().then(()=>{closed=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false,'超时不能释放仍未settle的本机推理');
  inference.resolve();await closing;
 }finally{inference.resolve();await turns.close();await retrieval.close();}
});

test('begin资格耗时扣除后同一deadline传入SQLite，Worker排队耗尽剩余预算返回超时',async t=>{
 const budget=250;let beginAt,finishQueuedAt,finishInput,finished;
 const f=await fixture(t,{synchronizeHistory:false,onRequest:async(_req,res,_request,n)=>{if(n===1){toolResponse(res,'历史残余预算');return true;}},content:request=>{
  assert.ok(JSON.stringify(request).includes('本次历史检索已超时'),'Worker排队过期也须返回正常Tool超时回执');
  return JSON.stringify({candidates:[{parts:['仍依据当前想法回应。'],basis:[1]}]});
 }}),execute=f.storage.execute.bind(f.storage);
 f.storage.execute=async(name,input,...rest)=>{
  if(name==='reply.beginSearch'){
   beginAt=Date.now();const value=await execute(name,input,...rest);
   // 可信存储边界模拟begin资格/排队；真实SQLite动作与后续来源核验仍照常执行。
   await new Promise(resolve=>setTimeout(resolve,35));return value;
  }
  if(name==='reply.finishSearch'){
   finishInput=input;finishQueuedAt=Date.now();
   await new Promise(resolve=>setTimeout(resolve,Math.max(0,input.deadlineAt-Date.now()+5)));
   finished=await execute(name,input,...rest);return finished;
  }
  return execute(name,input,...rest);
 };
 const retrieval=createRetrievalIndex({storage:f.storage,ownerId:f.owner,holders:f.holders,embed:async texts=>{assert.deepEqual(texts,['历史残余预算']);return [vector()];}});
 const contactId=f.ids[0],d=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner),turns=new SqliteReplyTurns({...f,service,retrieval,historySearchTimeoutMs:budget,authorize:async()=>{}});
 try{
  try{await turns.generate({contactId,discussionId:d.id,requestKey:randomUUID(),text:workspace.draftText,confirmedContact:true,workspace});}
  catch(error){throw f.supplierErrors[0]??error;}
  assert.equal(f.requests.length,2);assert.equal(finishInput.error,undefined,'宿主尚有余额时交给Worker复验');
  assert.ok(Number.isFinite(finishInput.deadlineAt));
  assert.ok(finishInput.deadlineAt<=beginAt+budget+2,'不能在begin资格完成后重开一整份预算');
  assert.ok(finishInput.deadlineAt-finishQueuedAt<budget-20,'剩余预算确实已扣除begin资格耗时');
  assert.equal(finishInput.queryVector.length,512);assert.equal(finished.code,'reply_search_timeout');assert.deepEqual(finished.items,[]);
  assert.equal((await service.view(contactId,d.id))[0].candidates[0].basis[0].kind,'entry');
 }finally{await turns.close();await retrieval.close();}
});
