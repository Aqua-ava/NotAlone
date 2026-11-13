/** 只在任务临时插件观察原Service、arbiter、LLM stream与store.save边界。 */
import assert from 'node:assert/strict';

export function observePlugin(source){
 const replace=(before,after)=>{
  assert.equal(source.split(before).length,2,'观察接缝源码已变化：'+before);
  source=source.replace(before,after);
 };
 source="import {isTokenDelta} from '@deepseek-ai/dsh-llm/assistant-stream';\nimport {PostgresReplyStore} from '../src/reply-store.ts';\n"+source;
 replace('export function apply(ctx:Context){',`export function apply(ctx:Context){
 let collectorRequest:{id:string;started:number}|null=null,collectorSpan=0;
 const collectorEvent=(type:string,details:Record<string,unknown>={})=>{if(collectorRequest)process.stdout.write('COLLECTOR_EVENT '+JSON.stringify({request_id:collectorRequest.id,clock:'node_performance_now_relative',boundary:'request_json_parsed_before_service_generate',at_ms:performance.now()-collectorRequest.started,type,...details})+'\\n');};
 const originalSave=PostgresReplyStore.prototype.save;
 PostgresReplyStore.prototype.save=async function(...args:Parameters<PostgresReplyStore['save']>){
  const span_id=String(++collectorSpan);collectorEvent('persistence_start',{span_id});
  try{return await originalSave.apply(this,args);}finally{collectorEvent('persistence_end',{span_id});}
 };
 const collectorStream=ctx.on('llm/stream',async function*(options,next){
  if(options.provider!=='notalone-reply-guarded'){yield* next();return;}
  const span_id=String(++collectorSpan);collectorEvent('network_start',{session_id:options.sessionId,span_id});let outcome='failed';
  try{for await(const chunk of next()){
   collectorEvent('model_stream_chunk',{session_id:options.sessionId,span_id,chunk_type:chunk.type,is_token_delta:isTokenDelta(chunk)});
   yield chunk;
  }outcome='succeeded';}
  finally{collectorEvent('network_end',{session_id:options.sessionId,span_id,outcome});}
 });`);
 replace('const arbiter=new ModelPermitArbiter(),ledger=',`const actualArbiter=new ModelPermitArbiter(),arbiter={snapshot:()=>actualArbiter.snapshot(),async acquire(...args:Parameters<ModelPermitArbiter['acquire']>){const span_id=String(++collectorSpan);collectorEvent('queue_acquire_start',{span_id});try{return await actualArbiter.acquire(...args);}finally{collectorEvent('queue_end',{span_id});}}},ledger=`);
 replace('const controller=new AbortController();running.set(input.id,controller);',`collectorRequest={id:input.id,started:performance.now()};collectorEvent('business_service_start',{at_ms:0,wall_at:new Date().toISOString()});
  const controller=new AbortController();running.set(input.id,controller);`);
 replace('res.end(stringifyJson(result));}finally{running.delete(input.id);}',`collectorEvent('business_service_end',{outcome:'succeeded'});res.end(stringifyJson(result));}finally{running.delete(input.id);collectorRequest=null;}`);
 replace("catch(error){res.statusCode=422;res.end(stringifyJson({error:error instanceof Error?error.message:'failed'}));}",`catch(error){collectorEvent('business_service_end',{outcome:'failed',error_type:error instanceof Error?error.name:'unknown'});res.statusCode=422;res.end(stringifyJson({error:error instanceof Error?error.message:'failed'}));}`);
 source=source.replace('ctx.effect(()=>async()=>{ready();barrier?.release();pausePreflight();',"ctx.effect(()=>async()=>{PostgresReplyStore.prototype.save=originalSave;collectorStream();ready();barrier?.release();pausePreflight();");
 return source;
}
