import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {createExtractionFixture} from './extraction-fixture.mjs';
import {ExtractionAdoptionService} from '../src/memory/adoption/service.ts';
import {ExtractionBatchService} from '../src/memory/extraction/service.ts';
import {ExtractionTaskStore} from '../src/memory/extraction/tasks/store.ts';
import {ExtractionTaskRunner} from '../src/memory/extraction/tasks/runner.ts';
import {ExtractionAdoptionError} from '../src/memory/adoption/service.ts';
import {ExtractionWorker} from '../src/memory/extraction/tasks/worker.ts';
import {EMBEDDING_MODEL,EMBEDDING_REVISION} from '../src/retrieval/retrieval-embedding.ts';

async function waitFor(check,timeoutMs=5000){
 const deadline=Date.now()+timeoutMs;
 let last;
 while(Date.now()<deadline){
  last=await check();
  if(last)return last;
  await delay(20);
 }
 throw new Error('synthetic_runner_timeout');
}

async function singleMessageClaim(t,{suffix,text,occurred}){
 const fixture=await createExtractionFixture(),client=fixture.client;
 const pool=new pg.Pool({host:'/tmp',database:client.database,max:3});
 t.after(async()=>{await pool.end();await fixture.close();});
 const owner=randomUUID(),contact=randomUUID(),source=randomUUID(),messageId=randomUUID();
 await client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
 await client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,$3)",[contact,owner,`合成${suffix}联系人`]);
 await client.query(`INSERT INTO source_document
  (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
  VALUES($1,$2,$3,'wechat_jsonl',$4,$5,1)`,
 [source,owner,contact,`synthetic-${suffix}.jsonl`,createHash('sha256').update(`synthetic-${suffix}`).digest('hex')]);
 await client.query(`INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
  VALUES($1,$2,$3,'contact','text',$4,$5)`,[messageId,owner,contact,text,occurred]);
 await client.query(`INSERT INTO message_source_ref
  (message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
  VALUES($1,$2,$3,'source_document',$4,'synthetic:1',$5)`,
 [messageId,owner,contact,source,{time_iso:occurred}]);
 const store=new ExtractionTaskStore(pool);
 const taskId=await store.enqueueImport({ownerId:owner,contactId:contact},source,1);
 await client.query(`UPDATE background_task_step SET status='succeeded',processed_count=1,total_count=1
  WHERE task_id=$1 AND step_name IN ('parse','normalize')`,[taskId]);
 const claim=await store.claim({ownerId:owner,contactId:contact},{
  taskId,workerId:randomUUID(),leaseMs:5000,supportedSteps:['extract_memory'],
 });
 assert.equal(claim?.stepName,'extract_memory');
 return {client,owner,contact,store,claim};
}

test('唯一TS Worker 从导入任务目标完成A、B、trace、处理回执与水位',{timeout:30000},async t=>{
 const fixture=await createExtractionFixture(),client=fixture.client;
 const pool=new pg.Pool({host:'/tmp',database:client.database,max:6});
 let worker;
 t.after(async()=>{
  await worker?.stop();
  await pool.end();
  await fixture.close();
 });
 const owner=randomUUID(),contact=randomUUID(),source=randomUUID();
 const messages=[
  {id:randomUUID(),text:'合成消息一',occurred:'2026-10-20T02:00:00Z'},
  {id:randomUUID(),text:'合成消息二',occurred:'2026-10-20T02:01:00Z'},
 ];
 await client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
 await client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
 await client.query(`INSERT INTO source_document
  (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
  VALUES($1,$2,$3,'wechat_jsonl','synthetic-runner.jsonl',$4,2)`,
 [source,owner,contact,createHash('sha256').update('synthetic-runner').digest('hex')]);
 for(const message of messages){
  await client.query(`INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
   VALUES($1,$2,$3,'contact','text',$4,$5)`,[message.id,owner,contact,message.text,message.occurred]);
  await client.query(`INSERT INTO message_source_ref
   (message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
   VALUES($1,$2,$3,'source_document',$4,$5,$6)`,
  [message.id,owner,contact,source,`synthetic:${message.id}`,{time_iso:message.occurred}]);
 }
 const store=new ExtractionTaskStore(pool);
 const taskId=await store.enqueueImport({ownerId:owner,contactId:contact},source,messages.length);
 const transaction=async work=>{
  const connection=await pool.connect();
  await connection.query('BEGIN');
  try{
   const result=await work(connection);
   await connection.query('COMMIT');
   return result;
  }catch(error){
   await connection.query('ROLLBACK');
   throw error;
  }finally{
   connection.release();
  }
 };
 let modelCalls=0;
 const batches=new ExtractionBatchService({
  ownerId:owner,
  transaction,
  ruleVersion:'b'.repeat(64),
  unconfirmedRequests:async()=>[],
  model:{
   binding:{provider:'synthetic-route',model:'synthetic-model',maxTokens:512,temperature:0,reasoningEffort:'off'},
   profile:{context_window_tokens:8192,safety_margin_tokens:512},
  },
  call:async input=>{
   modelCalls++;
   const blocks=[{type:'tool-call',name:input.tools[0].name,arguments:JSON.stringify({scenes:[]})}];
   await input.validateOutput(blocks);
   return {text:'',blocks};
  },
 });
 const adoption=new ExtractionAdoptionService({
  ownerId:owner,
  taskStore:store,
  adjudicationPort:{async call(){throw new Error('零候选不得调用裁决模型');}},
  embedding:{
   model:EMBEDDING_MODEL,
   revision:EMBEDDING_REVISION,
   embed:async texts=>texts.map((_,index)=>[1,index+1,0]),
  },
 });
 const runner=new ExtractionTaskRunner({
  store,batches,batchSize:10,concurrency:2,
  provider:'synthetic-route',modelName:'synthetic-model',
  adopt:(input,aResult,signal)=>adoption.run({...input,a_result:aResult},signal),
 });
 worker=new ExtractionWorker({store,ownerId:owner,runner,idleMs:20,leaseMs:5000,heartbeatMs:1000});
 assert.equal(await worker.start(),true);
 assert.equal(worker.wake({ownerId:owner,contactId:contact},taskId),true);
 const completed=await waitFor(async()=>{
  const row=(await client.query(`SELECT s.status,s.processed_count,s.last_error_code,t.current_step,t.status AS task_status
   FROM background_task t JOIN background_task_step s ON s.task_id=t.id
   WHERE t.id=$1 AND s.step_name='extract_memory'`,[taskId])).rows[0];
  if(row?.status==='failed')throw new Error(`synthetic_runner_failed:${row.last_error_code}`);
  return row?.status==='succeeded'?row:null;
 });
 assert.deepEqual({
  status:completed.status,processed_count:completed.processed_count,
  current_step:completed.current_step,task_status:completed.task_status,
 },{status:'succeeded',processed_count:2,current_step:'index',task_status:'running'});
 assert.equal(modelCalls,1);
 assert.equal((await client.query(`SELECT count(*)::int AS n FROM memory_extraction_trace
  WHERE owner_id=$1 AND contact_id=$2 AND batch_key=(SELECT batch_key FROM memory_extraction_trace
   WHERE owner_id=$1 AND contact_id=$2 ORDER BY started_at DESC LIMIT 1) AND status='succeeded'`,
 [owner,contact])).rows[0].n,1);
 assert.equal((await client.query(`SELECT count(*)::int AS n FROM memory_extraction_trace_event e
  JOIN memory_extraction_trace t ON t.trace_id=e.trace_id
  WHERE t.owner_id=$1 AND t.contact_id=$2 AND e.stage='batch_end'`,[owner,contact])).rows[0].n,1);
 assert.deepEqual((await client.query(`SELECT payload->'configuration'->>'provider' AS provider,
   payload->'configuration'->>'model_name' AS model_name FROM memory_extraction_trace_event e
   JOIN memory_extraction_trace t ON t.trace_id=e.trace_id
   WHERE t.owner_id=$1 AND t.contact_id=$2 AND e.stage='window'`,[owner,contact])).rows[0],
  {provider:'synthetic-route',model_name:'synthetic-model'});
 assert.equal((await client.query(`SELECT count(*)::int AS n FROM memory_processing_receipt
  WHERE owner_id=$1 AND contact_id=$2 AND outcome='succeeded'`,[owner,contact])).rows[0].n,2);
 assert.equal((await client.query(`SELECT last_message_id FROM memory_extraction_watermark
  WHERE owner_id=$1 AND contact_id=$2`,[owner,contact])).rows[0].last_message_id,messages.at(-1).id);
 assert.equal(await worker.stop(),true);
 assert.equal(worker.wake({ownerId:owner,contactId:contact},taskId),false);
 assert.equal(modelCalls,1);
});

test('批次调用失败只结束一次trace并保留原错误码',{timeout:20000},async t=>{
 const {client,owner,contact,store,claim}=await singleMessageClaim(t,{
  suffix:'failure',text:'合成失败消息',occurred:'2026-10-20T03:00:00Z',
 });
 const runner=new ExtractionTaskRunner({
  store,
  batches:{async run(){throw Object.assign(new Error('synthetic batch failure'),{code:'synthetic_batch_failure'});}},
  adopt:async()=>{throw new Error('失败批次不得进入采纳');},
 });
 await assert.rejects(runner.run(claim,new AbortController().signal),error=>error.code==='synthetic_batch_failure');
 const trace=(await client.query(`SELECT status,error_code FROM memory_extraction_trace
  WHERE owner_id=$1 AND contact_id=$2`,[owner,contact])).rows[0];
 assert.deepEqual(trace,{status:'trace_failed',error_code:'synthetic_batch_failure'});
 assert.equal((await client.query(`SELECT count(*)::int AS n FROM memory_extraction_trace_event e
  JOIN memory_extraction_trace t ON t.trace_id=e.trace_id
  WHERE t.owner_id=$1 AND t.contact_id=$2 AND e.stage='batch_end'`,[owner,contact])).rows[0].n,1);
});

test('B采纳失败保留business_failed与原错误码且不推进水位',{timeout:20000},async t=>{
 const {client,owner,contact,store,claim}=await singleMessageClaim(t,{
  suffix:'adoption-failure',text:'合成采纳失败消息',occurred:'2026-10-20T04:00:00Z',
 });
 const runner=new ExtractionTaskRunner({
  store,
  batches:{async run(){return {failure_reason:null,extraction_completed:true};}},
  adopt:async()=>{throw new ExtractionAdoptionError('adoption_commit_failed',false,null);},
 });
 await assert.rejects(runner.run(claim,new AbortController().signal),error=>error.code==='adoption_commit_failed');
 const trace=(await client.query(`SELECT status,error_code FROM memory_extraction_trace
  WHERE owner_id=$1 AND contact_id=$2`,[owner,contact])).rows[0];
 assert.deepEqual(trace,{status:'business_failed',error_code:'adoption_commit_failed'});
 assert.equal((await client.query(`SELECT count(*)::int AS n FROM memory_extraction_trace_event e
  JOIN memory_extraction_trace t ON t.trace_id=e.trace_id
  WHERE t.owner_id=$1 AND t.contact_id=$2 AND e.stage='batch_end'`,[owner,contact])).rows[0].n,1);
 assert.equal((await client.query(`SELECT count(*)::int AS n FROM memory_extraction_watermark
  WHERE owner_id=$1 AND contact_id=$2`,[owner,contact])).rows[0].n,0);
 assert.equal((await client.query(`SELECT count(*)::int AS n FROM memory_processing_receipt
  WHERE owner_id=$1 AND contact_id=$2`,[owner,contact])).rows[0].n,0);
 assert.deepEqual((await client.query(`SELECT payload->'not_executed' AS not_executed
  FROM memory_extraction_trace_event e JOIN memory_extraction_trace t ON t.trace_id=e.trace_id
  WHERE t.owner_id=$1 AND t.contact_id=$2 AND e.stage='batch_end'`,[owner,contact])).rows[0].not_executed,
  ['remaining_write']);
});

test('模型失败保留稳定failure_kind且不推进水位',{timeout:20000},async t=>{
 const {client,owner,contact,store,claim}=await singleMessageClaim(t,{
  suffix:'model-failure',text:'合成模型失败消息',occurred:'2026-10-20T05:00:00Z',
 });
 const runner=new ExtractionTaskRunner({
  store,
  batches:{async run(){
   return {failure_reason:'synthetic_failure',failure_kind:'model_rate_limited',extraction_completed:false};
  }},
  adopt:async()=>{throw new Error('模型失败不得进入采纳');},
 });
 await assert.rejects(runner.run(claim,new AbortController().signal),
  error=>error.code==='model_rate_limited'&&error.retryable===true);
 const trace=(await client.query(`SELECT status,error_code FROM memory_extraction_trace
  WHERE owner_id=$1 AND contact_id=$2`,[owner,contact])).rows[0];
 assert.deepEqual(trace,{status:'model_failed',error_code:'model_rate_limited'});
 assert.equal((await client.query(`SELECT count(*)::int AS n FROM memory_extraction_trace_event e
  JOIN memory_extraction_trace t ON t.trace_id=e.trace_id
  WHERE t.owner_id=$1 AND t.contact_id=$2 AND e.stage='batch_end'`,[owner,contact])).rows[0].n,1);
 assert.equal((await client.query(`SELECT count(*)::int AS n FROM memory_extraction_watermark
  WHERE owner_id=$1 AND contact_id=$2`,[owner,contact])).rows[0].n,0);
});

test('运行中取消把trace收尾为stopped且不推进水位',{timeout:20000},async t=>{
 const {client,owner,contact,store,claim}=await singleMessageClaim(t,{
  suffix:'cancelled',text:'合成取消消息',occurred:'2026-10-20T06:00:00Z',
 });
 const controller=new AbortController();
 const runner=new ExtractionTaskRunner({
  store,
  batches:{run(_input,signal){
   return new Promise((_,reject)=>signal.addEventListener('abort',
    ()=>reject(new DOMException('synthetic cancelled','AbortError')),{once:true}));
  }},
  adopt:async()=>{throw new Error('取消批次不得进入采纳');},
 });
 const execution=runner.run(claim,controller.signal);
 await waitFor(async()=>(await client.query(`SELECT 1 FROM memory_extraction_trace_event e
  JOIN memory_extraction_trace t ON t.trace_id=e.trace_id
  WHERE t.owner_id=$1 AND t.contact_id=$2 AND e.stage='window'`,[owner,contact])).rowCount);
 controller.abort();
 await assert.rejects(execution,error=>error.name==='AbortError');
 const trace=(await client.query(`SELECT status,error_code FROM memory_extraction_trace
  WHERE owner_id=$1 AND contact_id=$2`,[owner,contact])).rows[0];
 assert.deepEqual(trace,{status:'stopped',error_code:'cancelled'});
 assert.equal((await client.query(`SELECT count(*)::int AS n FROM memory_extraction_trace_event e
  JOIN memory_extraction_trace t ON t.trace_id=e.trace_id
  WHERE t.owner_id=$1 AND t.contact_id=$2 AND e.stage='batch_end'`,[owner,contact])).rows[0].n,1);
 assert.equal((await client.query(`SELECT count(*)::int AS n FROM memory_extraction_watermark
  WHERE owner_id=$1 AND contact_id=$2`,[owner,contact])).rows[0].n,0);
});
