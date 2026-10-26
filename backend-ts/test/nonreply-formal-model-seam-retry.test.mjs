/** 公开批处理接缝回归；实际官方profile/ModelHost故障证据由独立合成探针保存。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createExtractionFixture} from './extraction-fixture.mjs';
import {ExtractionTaskStore} from '../src/memory/extraction/tasks/store.ts';
import {ExtractionTaskRunner} from '../src/memory/extraction/tasks/runner.ts';
import {ExtractionBatchService} from '../src/memory/extraction/service.ts';

async function observeRecovery(policy){
  const fixture=await createExtractionFixture(),c=fixture.client,controller=new AbortController();let pool;
  const owner=randomUUID(),contact=randomUUID(),source=randomUUID(),message=randomUUID();let calls=0;
  try{
    await c.query("INSERT INTO owner(id,display_name)VALUES($1,'合成本人')",[owner]);
    await c.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成联系人')",[contact,owner]);
    await c.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,1)",[source,owner,contact,'a'.repeat(64)]);
    await c.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)VALUES($1,$2,$3,'contact','text','合成明确事实','2026-09-15T00:00:00Z')",[message,owner,contact]);
    await c.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)VALUES($1,$2,$3,'source_document',$4,'line:1',$5)",[message,owner,contact,source,{time_iso:'2026-09-15T00:00:00Z'}]);
    pool=new pg.Pool({host:'/tmp',database:c.database,max:2});const store=new ExtractionTaskStore(pool);
    const task=await store.enqueueImport({ownerId:owner,contactId:contact},source,1);
    await c.query('INSERT INTO memory_processing_plan(task_id,owner_id,contact_id)VALUES($1,$2,$3)',[task,owner,contact]);
    await c.query('INSERT INTO memory_processing_target(task_id,message_id,owner_id,contact_id)VALUES($1,$2,$3,$4)',[task,message,owner,contact]);
    await c.query("UPDATE background_task_step SET status='succeeded',processed_count=1,total_count=1 WHERE task_id=$1 AND step_name IN ('parse','normalize')",[task]);
    const claim=await store.claim({ownerId:owner,contactId:contact},{taskId:task,workerId:randomUUID(),leaseMs:60000,supportedSteps:['extract_memory']});
    let recovery;
    const transaction=async work=>{
      await c.query('BEGIN');let result;
      try{result=await work(c);await c.query('COMMIT');}catch(error){await c.query('ROLLBACK');throw error;}
      const row=(await c.query("SELECT payload FROM memory_extraction_trace_event WHERE owner_id=$1 AND contact_id=$2 AND stage='extraction_recovery' ORDER BY position DESC LIMIT 1",[owner,contact])).rows[0];
      if(row){recovery=row.payload;if(policy===undefined)controller.abort();}
      return result;
    };
    const service=new ExtractionBatchService({ownerId:owner,transaction,ruleVersion:'b'.repeat(64),
      ...(policy===undefined?{}:{extractionRetryPolicy:policy}),unconfirmedRequests:async()=>[],
      model:{binding:{provider:'synthetic',model:'deepseek-flash',maxTokens:4096,temperature:0,reasoningEffort:'off'},profile:{context_window_tokens:128000,safety_margin_tokens:128}},
      call:async()=>{calls++;return {text:'',blocks:[]};}});
    const runner=new ExtractionTaskRunner({store,batches:{async run(input){return service.run(input,controller.signal);}},
      adopt:async()=>{throw Error('失败E不得进入采纳');},provider:'deepseek',modelName:'deepseek-flash',concurrency:1,batchSize:1,contextBefore:0,contextAfter:0});
    await runner.run(claim,controller.signal).catch(()=>{});
    assert.equal(calls,1);assert.ok(recovery,'必须实际经过恢复事件');return recovery;
  }finally{await pool?.end();await fixture.close();}
}
test('显式内部策略0在首次失败后不重试',async()=>{
  assert.equal((await observeRecovery({maxRetries:0,retryDelayMs:0})).will_retry,false);
});
test('省略内部策略保留原默认重试资格',async()=>{
  assert.equal((await observeRecovery(undefined)).will_retry,true);
});
