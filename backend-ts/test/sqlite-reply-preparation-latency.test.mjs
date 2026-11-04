import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createBackgroundReads} from '../src/storage/sqlite/background-reads.ts';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
import {SqliteReplyTurns} from '../src/reply/sqlite/candidates/turns.ts';
import {fixture,owner} from './fixtures/sqlite-reply-candidates/support.mjs';

const slowReadRegistry=new URL('./fixtures/sqlite-reply-preparation-slow-reads.mjs',import.meta.url).href;
const sampleRuns=20;
const p95TargetMs=1000;
const maxTargetMs=2000;
const candidateContent=JSON.stringify({candidates:[{parts:['合成准备延迟候选'],basis:[1]}]});

function syntheticProviderResponse(){
 const events=[
  {type:'message_start',message:{id:randomUUID(),model:'synthetic-model',usage:{input_tokens:3,output_tokens:0}}},
  {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
  {type:'content_block_delta',index:0,delta:{type:'text_delta',text:candidateContent}},
  {type:'content_block_stop',index:0},
  {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:8}},
  {type:'message_stop'},
 ];
 return new Response(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),{status:200,headers:{'content-type':'text/event-stream'}});
}

function quantile(samples,p){
 const sorted=[...samples].sort((left,right)=>left-right);
 return sorted[Math.min(sorted.length-1,Math.ceil(p*sorted.length)-1)];
}
function rounded(value){return Number(value.toFixed(3));}
function stats(values){
 return {samples:values.length,p50Ms:rounded(quantile(values,0.5)),p95Ms:rounded(quantile(values,0.95)),maxMs:rounded(Math.max(...values))};
}
function backgroundObservation(action,value){
 if(action==='media.imageSyncTargets')return {action,count:Array.isArray(value)?value.length:-1};
 return {action,count:value&&typeof value==='object'?(value.memories?.length??0)+(value.candidates?.length??0):-1,pagePreparing:value?.page?.preparing??null};
}

function bounded(promise,label,ms=10000){
 let timer;
 return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label}超时`)),ms);})]).finally(()=>clearTimeout(timer));
}

test('后台图片和记忆长读期间候选从受理到 provider 收到请求保持秒级',{timeout:120000},async t=>{
 let providerArrival;
 const originalFetch=globalThis.fetch,providerRequests=[];
 globalThis.fetch=async(_url,init)=>{
  providerRequests.push(JSON.parse(String(init?.body)));
  providerArrival?.resolve(performance.now());
  return syntheticProviderResponse();
 };
 t.after(()=>{globalThis.fetch=originalFetch;});
 const f=await fixture(t,{registryModule:slowReadRegistry,providerTransport:'in-process'});
 const contactId=f.ids[0],scope={scopeKind:'contact',contactId};
 await f.storage.execute('memory.applyDecision',{ownerId:owner,request:{requestKey:`latency-memory-${randomUUID()}`,action:'manual',scope,body:'合成长期资料，用于后台慢读。'}});
 const background=await createBackgroundReads({storage:f.storage,ownerId:owner});t.after(()=>background.close());
 const service=new SqliteReplyCandidateService(f.storage,owner);
 let stages=[];
 // Skill 预载不在本规格内；保留候选真实存储、运行时和 provider 链路。
 const turns=new SqliteReplyTurns({storage:f.storage,service,discussions:f.discussions,runtime:f.runtime,model:f.model,provider:f.provider,arbiter:f.arbiter,authorize:async()=>{},onPreparationStage(stage){stages.push({stage,at:performance.now()});}});t.after(()=>turns.close());

 const samples=[],backgroundResults=[];
 for(let index=0;index<sampleRuns;index++){
  const action=index%2===0?'media.imageSyncTargets':'memory.read';
  const barrier=new Int32Array(new SharedArrayBuffer(8));
  const input=action==='media.imageSyncTargets'
   ?{ownerId:owner,contactId,after:'0',now:Date.now(),holdBarrier:barrier.buffer}
   :{ownerId:owner,scope,holdBarrier:barrier.buffer};
  let backgroundSettled=false;
  const reading=background.execute(action,input).finally(()=>{backgroundSettled=true;});void reading.catch(()=>{});
  const entered=Atomics.waitAsync(barrier,0,0);
  assert.equal(entered.async,true,'后台慢读必须由附属 Worker 实际进入');
  assert.equal(await entered.value,'ok');

  const discussion=await f.discussions.newDiscussion(contactId);
  providerArrival=Promise.withResolvers();
  stages=[];
  const startedAt=performance.now();
  const generation=turns.generate({contactId,discussionId:discussion.id,requestKey:randomUUID(),text:'请生成一条合成候选',confirmedContact:true});
  let providerAt,providerError;
  try{
   providerAt=await bounded(Promise.race([
    providerArrival.promise,
    generation.then(()=>{throw new Error('候选在 provider 收到请求前结束');},error=>{throw error;}),
   ]),'等待合成provider收到请求');
   assert.equal(backgroundSettled,false,'候选到达 provider 时后台长读必须仍在进行');
  }catch(error){providerError=error;}
  finally{Atomics.store(barrier,1,1);Atomics.notify(barrier,1);}
  const [generated,read]=await bounded(Promise.allSettled([generation,reading]),'候选与后台慢读收尾');
  if(providerError)throw providerError;
  if(generated.status==='rejected')throw generated.reason;
  if(read.status==='rejected')throw read.reason;

  const byStage=Object.fromEntries(stages.map(event=>[event.stage,event.at]));
  const ordered=['accepted','context-frozen','runtime-available'].map(stage=>byStage[stage]);
  assert.ok(ordered.every(Number.isFinite),`缺少准备阶段：${JSON.stringify(stages)}`);
  assert.ok(ordered[0]<=ordered[1]&&ordered[1]<=ordered[2]&&ordered[2]<=providerAt,'准备阶段必须按受理→冻结→运行时→provider 排序');
  samples.push({
   action,
   acceptedToFrozenMs:ordered[1]-ordered[0],
   frozenToRuntimeMs:ordered[2]-ordered[1],
   runtimeToProviderMs:providerAt-ordered[2],
   acceptedToProviderMs:providerAt-ordered[0],
   invocationToProviderMs:providerAt-startedAt,
  });
  backgroundResults.push(backgroundObservation(action,read.value));
 }
 assert.equal(providerRequests.length,sampleRuns,'每个候选只应在合成 provider 收到一次请求');
 assert.ok(backgroundResults.filter((_result,index)=>index%2===1).every(result=>result.count===0&&result.pagePreparing===true),`记忆慢读应返回确定的空投影结果：${JSON.stringify(backgroundResults)}`);
 assert.ok(backgroundResults.filter((_result,index)=>index%2===0).every(result=>result.count===0),`图片慢读应返回确定的空目录结果：${JSON.stringify(backgroundResults)}`);
 const total=samples.map(sample=>sample.acceptedToProviderMs),measured=stats(total);
 const stagesReport={
  acceptedToFrozenMs:stats(samples.map(sample=>sample.acceptedToFrozenMs)),
  frozenToRuntimeMs:stats(samples.map(sample=>sample.frozenToRuntimeMs)),
  runtimeToProviderMs:stats(samples.map(sample=>sample.runtimeToProviderMs)),
  invocationToAcceptedMs:stats(samples.map(sample=>sample.invocationToProviderMs-sample.acceptedToProviderMs)),
 };
 t.diagnostic(JSON.stringify({boundary:'候选受理至合成provider收到请求；不含模型生成与网络耗时',sampleRuns,backgroundReads:{image:sampleRuns/2,memory:sampleRuns/2,results:backgroundResults},total:measured,stages:stagesReport}));
 assert.ok(measured.p95Ms<=p95TargetMs,`候选本地准备 P95 ${measured.p95Ms}ms 超过 ${p95TargetMs}ms`);
 assert.ok(measured.maxMs<=maxTargetMs,`候选本地准备最大值 ${measured.maxMs}ms 超过 ${maxTargetMs}ms`);
});
