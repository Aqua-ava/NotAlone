import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createExtractionFixture} from './extraction-fixture.mjs';
import {ExtractionBatchService} from '../src/extraction-batch-service.ts';
import {createExtractionBatchHttp} from '../src/extraction-batch-http.ts';
import {modelTaskRequestId} from '../src/host-model-accounting.ts';

test('原Python窗口→TS批处理保留同一claim/trace，重复结果只读回，来源变化后不调用模型',async()=>{
 const db=await createExtractionFixture(),c=db.client;let server;
 try{
  const owner=randomUUID(),contact=randomUUID(),source=randomUUID(),message=randomUUID(),task=randomUUID(),step=randomUUID(),worker=randomUUID();
  await c.query("INSERT INTO owner(id,display_name)VALUES($1,'合成')",[owner]);
  await c.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成')",[contact,owner]);
  await c.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,1)",[source,owner,contact,'a'.repeat(64)]);
  await c.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)VALUES($1,$2,$3,'contact','text','有事爱直接打电话','2026-01-01T00:00:00.123456Z')",[message,owner,contact]);
  await c.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)VALUES($1,$2,$3,'source_document',$4,'line:1',$5)",[message,owner,contact,source,{time_iso:'2026-01-01T08:00:00.123456+08:00'}]);
  await c.query("INSERT INTO background_task(id,owner_id,contact_id,source_document_id,task_type,status,current_step,message_count)VALUES($1,$2,$3,$4,'import','running','extract_memory',1)",[task,owner,contact,source]);
  await c.query("INSERT INTO background_task_step(id,task_id,step_name,step_order,status,worker_id,lease_generation,attempt_count,lease_expires_at)VALUES($1,$2,'extract_memory',3,'running',$3,1,1,now()+interval '5 minutes')",[step,task,worker]);
  const claim={task_id:task,step_id:step,step_name:'extract_memory',worker_id:worker,lease_generation:1};
  const config=await readFile(db.envFilePath,'utf8'),dsn=config.match(/^NOTALONE_DATABASE_URL=(.*)$/m)[1];
  const script=`import sys,json\nfrom uuid import UUID,uuid4\nfrom notalone.scopes import ContactScope\nfrom notalone.memory_extraction.cli_support import load_contact_messages\nfrom notalone.memory_extraction.command import _plan_batch\nfrom notalone.persistence.extraction_trace import PostgresExtractionTraceStore\nscope=ContactScope(UUID(sys.argv[2]),UUID(sys.argv[3])); messages=load_contact_messages(scope,sys.argv[1]); claim=json.loads(sys.argv[4])\nplan=_plan_batch(batch=messages,messages=messages,message_positions={m.message_id:i for i,m in enumerate(messages)},scope=scope,context_before=5,context_after=0,batch_size=10,provider='deepseek',model_name='synthetic-model',task_metadata={'task_runtime':claim},selection_receipts=(),previous_watermark=None)\ntrace=PostgresExtractionTraceStore(sys.argv[1]).begin(scope,run_id=uuid4(),batch_key=plan.batch_key,payload=plan.window_payload)\nprint(json.dumps({'trace_id':str(trace),'batch_key':plan.batch_key}))`;
  const seedTrace=()=>JSON.parse(execFileSync(`${homedir()}/miniconda3/envs/NotAlone/bin/python`,['-c',script,dsn,owner,contact,JSON.stringify(claim)],{env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname},encoding:'utf8'}));
  const seeded=seedTrace();
  let calls=0;
  let afterCommit=null;
  const transaction=async work=>{await c.query('BEGIN');try{const result=await work(c);await c.query('COMMIT');const after=afterCommit;afterCommit=null;await after?.();return result;}catch(e){await c.query('ROLLBACK');throw e;}};
  let unconfirmed=[];
  const service=new ExtractionBatchService({ownerId:owner,transaction,ruleVersion:'b'.repeat(64),unconfirmedRequests:async()=>unconfirmed,model:{binding:{provider:'synthetic-route',model:'synthetic-model',maxTokens:512,temperature:0,reasoningEffort:'off'},profile:{context_window_tokens:8192,safety_margin_tokens:512}},
   call:async input=>{calls++;const name=input.tools[0].name;let args;
    if(name==='DirectMemoryExtractionOutput')args={scenes:[{scene_name:'沟通偏好',memories:[{text:'联系人有事爱直接打电话',category:'preference',subject:'contact',topic:'other',source_message_ids:[message],confidence:0.9,risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',alternatives:[],interpretation_reason:'原话明确表达偏好'}]}]};
    else args={results:[{candidate_index:0,verdict:'supported',issues:[],evidence:[{message_id:message,quote:'有事爱直接打电话'}]}]};
    const blocks=[{type:'tool-call',name,arguments:JSON.stringify(args)}];await input.validateOutput(blocks);return {text:'',blocks};
   }});
  const input={owner_id:owner,contact_id:contact,claim,...seeded};
  const http=createExtractionBatchHttp({token:'synthetic-private-token',execute:(value,signal)=>service.run(value,signal)});
  server=createServer((req,res)=>{void http.handle(req,res);});server.listen(0,'127.0.0.1');await once(server,'listening');
  const url=`http://127.0.0.1:${server.address().port}/internal/extraction/run`;
  const request=token=>fetch(url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(input)});
  assert.equal((await request('public-token')).status,401);assert.equal(calls,0);
  const duplicate=JSON.stringify(input).replace('{"owner_id":','{"owner_id":"'+owner+'","owner_id":');
  assert.equal((await fetch(url,{method:'POST',headers:{authorization:'Bearer synthetic-private-token'},body:duplicate})).status,400);assert.equal(calls,0);
  const response=await request('synthetic-private-token');assert.equal(response.status,200);
  const first=(await response.json()).outcome;
  assert.equal(first.accepted.length,1);assert.equal(first.model_accounting_owner,'typescript');assert.equal(first.candidate_trace_ids.length,1);assert.equal(calls,2);
  assert.deepEqual(await service.run(input,new AbortController().signal),first);assert.equal(calls,2);
  // 原调用者丢失HTTP回包后会新建trace；已持久结果仍属于同一A执行。
  const recoveredInput={...input,...seedTrace()};
  assert.deepEqual(await service.run(recoveredInput,new AbortController().signal),first);assert.equal(calls,2);
  unconfirmed=[modelTaskRequestId('extraction',task,input.batch_key)];
  await assert.rejects(service.run({...input,...seedTrace()},new AbortController().signal),{code:'extraction_batch_outcome_unknown'});assert.equal(calls,2);
  unconfirmed=[];
  const receipt=Object.fromEntries(['a_execution_id','a_input_sha256','a_rule_version'].map(key=>[key,first[key]]));
  const consume=receipt=>execFileSync(`${homedir()}/miniconda3/envs/NotAlone/bin/python`,['-c',
   `import sys,json\nfrom uuid import UUID\nfrom notalone.scopes import ContactScope\nfrom notalone.persistence.extraction_trace import PostgresExtractionTraceStore\nfrom notalone.memory_trace.ports import TraceWriteError\ntry:\n PostgresExtractionTraceStore(sys.argv[1]).complete(ContactScope(UUID(sys.argv[2]),UUID(sys.argv[3])),UUID(sys.argv[4]),status='model_failed',payload={'typescript_a_receipt':json.loads(sys.argv[5])})\n print('consumed')\nexcept TraceWriteError: print('rejected')`,
   dsn,owner,contact,recoveredInput.trace_id,JSON.stringify(receipt)],{env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname},encoding:'utf8'}).trim();
  assert.equal(consume({...receipt,a_input_sha256:'c'.repeat(64)}),'rejected');
  assert.equal((await c.query("SELECT 1 FROM memory_extraction_trace_event WHERE trace_id=$1 AND stage='batch_end'",[recoveredInput.trace_id])).rowCount,0);
  assert.equal(consume(receipt),'consumed');
  const abortedInput={...input,...seedTrace()},controller=new AbortController();
  afterCommit=async()=>{await c.query("UPDATE background_task_step SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[step]);controller.abort();};
  await assert.rejects(service.run(abortedInput,controller.signal),{name:'AbortError'});assert.equal(calls,2);
  assert.equal((await c.query("SELECT 1 FROM memory_extraction_trace_event WHERE trace_id=$1 AND stage='typescript_a_not_sent'",[abortedInput.trace_id])).rowCount,0,
   '已消费A只读恢复，不生成新的零派发证明');
  await c.query("UPDATE background_task_step SET lease_expires_at=now()+interval '5 minutes' WHERE id=$1",[step]);
  const retryInput={...input,...seedTrace()};
  const retried=await service.run(retryInput,new AbortController().signal);
  assert.equal(calls,2);assert.equal(retried.a_execution_id,first.a_execution_id);
  await c.query("UPDATE source_document SET status='delete_requested' WHERE id=$1",[source]);
  await assert.rejects(service.run(input,new AbortController().signal),{code:'extraction_batch_stale'});assert.equal(calls,2);
 }finally{if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await db.close();}
});

test('bounded运行时批处理只走GroundedMemoryLabels与nullable-proof-v3，并恢复同一E/V结果',async()=>{
 const db=await createExtractionFixture(),c=db.client;
 try{
  const owner=randomUUID(),contact=randomUUID(),source=randomUUID(),message=randomUUID(),task=randomUUID(),step=randomUUID(),worker=randomUUID();
  await c.query("INSERT INTO owner(id,display_name)VALUES($1,'合成bounded本人')",[owner]);
  await c.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成bounded联系人')",[contact,owner]);
  await c.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'wechat_jsonl','bounded.jsonl',$4,1)",[source,owner,contact,'a'.repeat(64)]);
  await c.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)VALUES($1,$2,$3,'contact','text','我刚到家。','2026-01-01T00:00:00.123456Z')",[message,owner,contact]);
  await c.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)VALUES($1,$2,$3,'source_document',$4,'line:1',$5)",[message,owner,contact,source,{time_iso:'2026-01-01T08:00:00.123456+08:00'}]);
  await c.query("INSERT INTO background_task(id,owner_id,contact_id,source_document_id,task_type,status,current_step,message_count,extraction_runtime_config)VALUES($1,$2,$3,$4,'import','running','extract_memory',1,$5)",[task,owner,contact,source,{version:1,mode:'bounded-runtime-v1',rule_set_sha256:'b'.repeat(64)}]);
  await c.query("INSERT INTO background_task_step(id,task_id,step_name,step_order,status,worker_id,lease_generation,attempt_count,lease_expires_at)VALUES($1,$2,'extract_memory',3,'running',$3,1,1,now()+interval '5 minutes')",[step,task,worker]);
  const claim={task_id:task,step_id:step,step_name:'extract_memory',worker_id:worker,lease_generation:1};
  const config=await readFile(db.envFilePath,'utf8'),dsn=config.match(/^NOTALONE_DATABASE_URL=(.*)$/m)[1];
  const script=`import sys,json\nfrom uuid import UUID,uuid4\nfrom notalone.scopes import ContactScope\nfrom notalone.memory_extraction.cli_support import load_contact_messages\nfrom notalone.memory_extraction.command import _plan_batch\nfrom notalone.persistence.extraction_trace import PostgresExtractionTraceStore\nscope=ContactScope(UUID(sys.argv[2]),UUID(sys.argv[3]));messages=load_contact_messages(scope,sys.argv[1]);claim=json.loads(sys.argv[4])\nplan=_plan_batch(batch=messages,messages=messages,message_positions={m.message_id:i for i,m in enumerate(messages)},scope=scope,context_before=5,context_after=0,batch_size=10,provider='deepseek',model_name='synthetic-model',task_metadata={'task_runtime':claim},selection_receipts=(),previous_watermark=None)\ntrace=PostgresExtractionTraceStore(sys.argv[1]).begin(scope,run_id=uuid4(),batch_key=plan.batch_key,payload=plan.window_payload)\nprint(json.dumps({'trace_id':str(trace),'batch_key':plan.batch_key}))`;
  const seedTrace=()=>JSON.parse(execFileSync(`${homedir()}/miniconda3/envs/NotAlone/bin/python`,['-c',script,dsn,owner,contact,JSON.stringify(claim)],{env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname},encoding:'utf8'}));
  const seeded=seedTrace(),input={owner_id:owner,contact_id:contact,claim,...seeded};
  const label={kind:'event',subject:'contact',topic:'other',dependency:null,unresolved:false,confidence:0.92,sensitivity:'none'};
  const arrivalProof={version:3,atom_links:[{rule_id:'BR_AUTHOR_ARRIVAL_V1',variant_id:'direct_quote',source:{message_id:message,start:0,end:5},candidate:{start:7,end:12}}],
   reference:[{rule_id:'BR_AUTHOR_ARRIVAL_V1',mention:{message_id:message,start:0,end:1},target:{message_id:message,start:0,end:1},binding:null}],
   reported:[{rule_id:'BR_AUTHOR_ARRIVAL_V1',frame:'direct',source:{message_id:message,start:0,end:5},candidate:{start:7,end:12}}]};
  let physicalCalls=0;const tools=[];
  const transaction=async work=>{await c.query('BEGIN');try{const result=await work(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}};
  const recordReceipt=async receipt=>{
   await c.query(`INSERT INTO outbound_ledger_entry(id,owner_id,contact_id,provider,model_name,input_tokens,output_tokens,latency_ms,outcome,called_at)
    VALUES($1,$2,$3,$4,$5,NULL,NULL,$6,'succeeded',$7)`, [receipt.ledger_entry_id,owner,contact,receipt.provider,receipt.model,receipt.latency_ms,receipt.called_at]);
   await c.query(`INSERT INTO model_call_receipt(attempt_id,owner_id,contact_id,request_id,permit_id,ledger_entry_id,provider,model_name,called_at,latency_ms,dispatch,outcome,cost_status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'response_observed','succeeded','unknown')`,
    [receipt.attempt_id,owner,contact,receipt.request_id,receipt.permit_id,receipt.ledger_entry_id,receipt.provider,receipt.model,receipt.called_at,receipt.latency_ms]);
  };
  const service=new ExtractionBatchService({ownerId:owner,transaction,ruleVersion:'b'.repeat(64),unconfirmedRequests:async()=>[],model:{binding:{provider:'synthetic-route',model:'synthetic-model',maxTokens:512,temperature:0,reasoningEffort:'off'},profile:{context_window_tokens:8192,safety_margin_tokens:512}},
   call:async input=>{
    physicalCalls++;const name=input.tools[0].name;tools.push(name);
    const args=name==='GroundedMemoryLabels'?{units:{'0:0':label}}:{results:[{candidate_index:0,verdict:'supported',issues:[],evidence:[{message_id:message,quote:'我刚到家。'}],proof:arrivalProof}]};
    const blocks=[{type:'tool-call',name,arguments:JSON.stringify(args)}];await input.validateOutput(blocks);
    const receipt={attempt_id:input.attempt_id,permit_id:randomUUID(),request_id:input.request_id,owner_id:owner,contact_id:contact,scope_kind:'contact',
     provider:input.binding.provider,model:input.binding.model,called_at:new Date().toISOString(),latency_ms:1,dispatch:'response_observed',outcome:'succeeded',
     usage:null,cost:{status:'unknown',amount:null,currency:null,pricing_version:null},ledger_entry_id:input.ledger_entry_id};
    await input.onReceipt(receipt);await recordReceipt(receipt);return {text:'',blocks,receipt};
   }});
  const first=await service.run(input,new AbortController().signal);
  assert.deepEqual(tools,['GroundedMemoryLabels','SourceVerificationOutput']);
  assert.equal(first.failure_kind,null);assert.equal(first.model_call_ids.length,2);assert.equal(physicalCalls,2);
  assert.equal(first.accepted.length,1);assert.equal(first.accepted[0].source_dependency_mode,'all');
  assert.equal(first.accepted[0].dimension_evidence.version,4);assert.ok(first.accepted[0].dimension_evidence.semantic_basis);
  assert.equal((await c.query('SELECT count(*)::int n FROM model_call_receipt')).rows[0].n,2);
  assert.equal((await c.query('SELECT count(*)::int n FROM outbound_ledger_entry')).rows[0].n,2);
  assert.equal((await c.query("SELECT count(*)::int n FROM memory_extraction_trace_call WHERE ledger_commit_status='committed'")).rows[0].n,2);
  const resultEvent=(await c.query("SELECT payload->'outcome' AS outcome FROM memory_extraction_trace_event WHERE trace_id=$1 AND stage='typescript_a_result'",[seeded.trace_id])).rows[0];
  assert.deepEqual(resultEvent.outcome.accepted[0].source_message_ids,[message]);
  assert.deepEqual(await service.run(input,new AbortController().signal),first);assert.equal(physicalCalls,2);
  const recoveredInput={...input,...seedTrace()},recovered=await service.run(recoveredInput,new AbortController().signal);
  assert.deepEqual(recovered,first);assert.equal(physicalCalls,2);
  assert.equal((await c.query("SELECT count(*)::int n FROM memory_extraction_trace_event WHERE trace_id=$1 AND stage='typescript_a_recovered'",[recoveredInput.trace_id])).rows[0].n,1);
  assert.equal((await c.query('SELECT count(*)::int n FROM model_call_receipt')).rows[0].n,2);
 }finally{await db.close();}
});
