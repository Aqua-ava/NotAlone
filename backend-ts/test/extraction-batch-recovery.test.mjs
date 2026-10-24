import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {createExtractionFixture} from './extraction-fixture.mjs';
import {ExtractionBatchService} from '../src/extraction-batch-service.ts';
import {modelTaskRequestId} from '../src/host-model-accounting.ts';

test('仅无候选旧失败可在新trace下显式让位，已有候选非空仍保持unknown',async()=>{
 const db=await createExtractionFixture(),c=db.client;
 try{
  const owner=randomUUID(),contact=randomUUID(),source=randomUUID(),message=randomUUID(),task=randomUUID(),step=randomUUID(),worker=randomUUID();
  await c.query("INSERT INTO owner(id,display_name)VALUES($1,'合成恢复')",[owner]);
  await c.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成恢复')",[contact,owner]);
  await c.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,1)",[source,owner,contact,'a'.repeat(64)]);
  await c.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)VALUES($1,$2,$3,'contact','text','合成恢复偏好', '2026-01-01T00:00:00Z')",[message,owner,contact]);
  await c.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)VALUES($1,$2,$3,'source_document',$4,'line:1',$5)",[message,owner,contact,source,{time_iso:'2026-01-01T08:00:00+08:00'}]);
  await c.query("INSERT INTO background_task(id,owner_id,contact_id,source_document_id,task_type,status,current_step,message_count)VALUES($1,$2,$3,$4,'import','running','extract_memory',1)",[task,owner,contact,source]);
  await c.query("INSERT INTO background_task_step(id,task_id,step_name,step_order,status,worker_id,lease_generation,attempt_count,lease_expires_at)VALUES($1,$2,'extract_memory',3,'running',$3,1,1,now()+interval '5 minutes')",[step,task,worker]);
  const claim={task_id:task,step_id:step,step_name:'extract_memory',worker_id:worker,lease_generation:1};
  const config=await readFile(db.envFilePath,'utf8'),dsn=config.match(/^NOTALONE_DATABASE_URL=(.*)$/m)[1];
  const seedScript=`import sys,json\nfrom uuid import UUID,uuid4\nfrom notalone.scopes import ContactScope\nfrom notalone.memory_extraction.cli_support import load_contact_messages\nfrom notalone.memory_extraction.command import _plan_batch\nfrom notalone.persistence.extraction_trace import PostgresExtractionTraceStore\nscope=ContactScope(UUID(sys.argv[2]),UUID(sys.argv[3]));messages=load_contact_messages(scope,sys.argv[1]);claim=json.loads(sys.argv[4])\nplan=_plan_batch(batch=messages,messages=messages,message_positions={m.message_id:i for i,m in enumerate(messages)},scope=scope,context_before=5,context_after=0,batch_size=10,provider='synthetic-route',model_name='synthetic-model',task_metadata={'task_runtime':claim},selection_receipts=(),previous_watermark=None)\ntrace=PostgresExtractionTraceStore(sys.argv[1]).begin(scope,run_id=uuid4(),batch_key=plan.batch_key,payload=plan.window_payload)\nprint(json.dumps({'trace_id':str(trace),'batch_key':plan.batch_key}))`;
  const seedTrace=()=>JSON.parse(execFileSync(`${homedir()}/miniconda3/envs/NotAlone/bin/python`,['-c',seedScript,dsn,owner,contact,JSON.stringify(claim)],{
   env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname},encoding:'utf8'}));
  const transaction=async work=>{await c.query('BEGIN');try{const result=await work(c);await c.query('COMMIT');return result;}catch(error){await c.query('ROLLBACK');throw error;}};
  let verificationValid=false,calls=0;
  const serviceFor=ruleVersion=>new ExtractionBatchService({ownerId:owner,transaction,ruleVersion,
   unconfirmedRequests:async()=>[],model:{binding:{provider:'synthetic-route',model:'synthetic-model',maxTokens:512,temperature:0,reasoningEffort:'off'},
    profile:{context_window_tokens:8192,safety_margin_tokens:512}},
   call:async input=>{
    calls++;const name=input.tools[0].name;let args;
    if(name==='DirectMemoryExtractionOutput')args={scenes:[{scene_name:'恢复',memories:[{
     text:'联系人有合成恢复偏好',category:'preference',subject:'contact',topic:'other',source_message_ids:[message],confidence:0.9,
     risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',
     alternatives:[],interpretation_reason:'合成恢复验证'}]}]};
    else args=verificationValid?{results:[{candidate_index:0,verdict:'supported',issues:[],evidence:[{message_id:message,quote:'合成恢复偏好'}]}]}:null;
    const blocks=args?[{type:'tool-call',name,arguments:JSON.stringify(args)}]:[{type:'text',text:'合成非法输出'}];
    const receipt={attempt_id:input.attempt_id,permit_id:randomUUID(),request_id:input.request_id,owner_id:owner,contact_id:contact,
     scope_kind:'contact',provider:input.binding.provider,model:input.binding.model,called_at:new Date().toISOString(),latency_ms:1,
     dispatch:'response_observed',outcome:'succeeded',usage:null,cost:{status:'unknown',amount:null,currency:null,pricing_version:null},
     ledger_entry_id:input.ledger_entry_id};
    const persist=async()=>{
     const ledgerOutcome=receipt.outcome==='failed'?'rejected_by_validation':'succeeded';
     await c.query(`INSERT INTO outbound_ledger_entry(id,owner_id,contact_id,provider,model_name,input_tokens,output_tokens,latency_ms,outcome,called_at)
      VALUES($1,$2,$3,$4,$5,NULL,NULL,1,$6,$7)`,[receipt.ledger_entry_id,owner,contact,receipt.provider,receipt.model,ledgerOutcome,receipt.called_at]);
     await c.query(`INSERT INTO model_call_receipt(attempt_id,owner_id,contact_id,request_id,permit_id,ledger_entry_id,provider,model_name,
      called_at,latency_ms,dispatch,outcome,cost_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,'response_observed',$10,'unknown')`,
      [receipt.attempt_id,owner,contact,receipt.request_id,receipt.permit_id,receipt.ledger_entry_id,receipt.provider,receipt.model,
       receipt.called_at,receipt.outcome]);
     await input.onReceipt(receipt);
    };
    try{await input.validateOutput(blocks);}
    catch(error){receipt.outcome='failed';await persist();throw error;}
    await persist();
    return {text:'',blocks};
   }});
  const firstInput={owner_id:owner,contact_id:contact,claim,...seedTrace()},service=serviceFor('b'.repeat(64));
  const first=await service.run(firstInput,new AbortController().signal);
  assert.equal(first.failure_kind,'invalid_output');assert.equal(first.accepted.length,0);assert.equal(calls,2);
  assert.deepEqual(await service.run(firstInput,new AbortController().signal),first);assert.equal(calls,2);
  const secondInput={owner_id:owner,contact_id:contact,claim,...seedTrace()};
  const second=await service.run(secondInput,new AbortController().signal);
  assert.equal(second.failure_kind,'invalid_output');assert.equal(calls,4);
  assert.equal((await c.query("SELECT count(*)::int n FROM memory_extraction_trace_event WHERE trace_id=$1 AND stage='typescript_a_superseded'",[secondInput.trace_id])).rows[0].n,1);
  const missingTrace={...seedTrace()};
  const requestId=modelTaskRequestId('extraction',task,missingTrace.batch_key);
  await c.query(`INSERT INTO memory_extraction_trace_event(event_id,trace_id,owner_id,contact_id,position,stage,payload)
   SELECT $1,$2,$3,$4,COALESCE(max(position),0)+1,'typescript_a_begin',$5::jsonb FROM memory_extraction_trace_event WHERE trace_id=$2`,
   [randomUUID(),missingTrace.trace_id,owner,contact,{execution_id:missingTrace.trace_id,request_id:requestId,task_id:task,
    batch_key:missingTrace.batch_key,input_sha256:second.a_input_sha256,executor:'typescript',rule_version:'b'.repeat(64)}]);
  await c.query(`INSERT INTO memory_extraction_trace_call(call_id,trace_id,owner_id,contact_id,purpose,called_at,finished_at,
   response_status,provider_attempts,ledger_entry_id,ledger_commit_status,disposition)
   SELECT $1,$2,owner_id,contact_id,purpose,called_at,finished_at,response_status,provider_attempts,ledger_entry_id,
    ledger_commit_status,disposition FROM memory_extraction_trace_call WHERE trace_id=$3 ORDER BY called_at LIMIT 1`,
   [randomUUID(),missingTrace.trace_id,secondInput.trace_id]);
  await c.query(`INSERT INTO memory_extraction_trace_event(event_id,trace_id,owner_id,contact_id,position,stage,payload)
   SELECT $1,$2,$3,$4,COALESCE(max(position),0)+1,'batch_end',$5::jsonb FROM memory_extraction_trace_event WHERE trace_id=$2`,
   [randomUUID(),missingTrace.trace_id,owner,contact,{watermark_before:null,watermark_after:null,watermark_commit:'not_advanced',
    not_executed:['remaining_adoption','remaining_write'],error_code:'model_call_outcome_unknown'}]);
  await c.query("UPDATE memory_extraction_trace SET status='trace_failed',finished_at=now(),failure_stage='batch_end',error_code='model_call_outcome_unknown' WHERE trace_id=$1",[missingTrace.trace_id]);
  const missingInput={owner_id:owner,contact_id:contact,claim,...seedTrace()};
  const missing=await service.run(missingInput,new AbortController().signal);
  assert.equal(missing.failure_kind,'invalid_output');assert.equal(calls,6);
  assert.equal((await c.query("SELECT count(*)::int n FROM memory_extraction_trace_event WHERE trace_id=$1 AND stage='typescript_a_superseded'",[missingInput.trace_id])).rows[0].n,2);
  const thirdInput={owner_id:owner,contact_id:contact,claim,...seedTrace()};verificationValid=true;
  const third=await service.run(thirdInput,new AbortController().signal);
  assert.equal(third.failure_kind,null);assert.equal(third.accepted.length,1);assert.equal(calls,8);
  const changedInput={owner_id:owner,contact_id:contact,claim,...seedTrace()};
  await assert.rejects(serviceFor('c'.repeat(64)).run(changedInput,new AbortController().signal),{code:'extraction_batch_outcome_unknown'});
  assert.equal(calls,8);
 }finally{await db.close();}
});
