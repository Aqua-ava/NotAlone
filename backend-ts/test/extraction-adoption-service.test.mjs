import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {createExtractionFixture} from './extraction-fixture.mjs';
import {ExtractionBatchService} from '../src/extraction-batch-service.ts';
import {ExtractionTaskStore,ExtractionTaskError} from '../src/extraction-task-store.ts';
import {ExtractionAdoptionService,ExtractionAdoptionError,adoptionPurposeRequestId} from '../src/extraction-adoption-service.ts';
import {EMBEDDING_MODEL,EMBEDDING_REVISION} from '../src/retrieval-embedding.ts';

const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const shaPattern=/^[a-f0-9]{64}$/;
const fixedEmbedding=(vectors=async texts=>texts.map((_,index)=>[1,index+1,0]))=>({model:EMBEDDING_MODEL,revision:EMBEDDING_REVISION,embed:vectors});

async function addMessage(client,{owner,contact,source,id,text,occurred,sourceDocument}){
 await client.query("INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)VALUES($1,$2,$3,'contact','text',$4,$5)",
  [id,owner,contact,text,occurred]);
 await client.query(`INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
  VALUES($1,$2,$3,'source_document',$4,$5,$6)`,[id,owner,contact,sourceDocument,`synthetic:${id}`,{synthetic:true,text,time_iso:occurred}]);
 return id;
}

async function setupA(messageText='联系人两项运动都安排'){
 const fixture=await createExtractionFixture(),c=fixture.client;
 const owner=randomUUID(),contact=randomUUID(),source=randomUUID(),message=randomUUID(),task=randomUUID(),step=randomUUID(),worker=randomUUID();
 await c.query("INSERT INTO public.owner(id,display_name)VALUES($1,'合成本人')",[owner]);
 await c.query("INSERT INTO public.contact(id,owner_id,display_name)VALUES($1,$2,'合成联系人')",[contact,owner]);
 await c.query(`INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
  VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,1)`,[source,owner,contact,createHash('sha256').update(messageText).digest('hex')]);
 await addMessage(c,{owner,contact,source,id:message,text:messageText,occurred:'2026-01-03T00:00:00.123456Z',sourceDocument:source});
 await c.query(`INSERT INTO public.background_task(id,owner_id,contact_id,source_document_id,task_type,status,current_step,message_count)
  VALUES($1,$2,$3,$4,'import','running','extract_memory',1)`,[task,owner,contact,source]);
 await c.query(`INSERT INTO public.background_task_step(id,task_id,step_name,step_order,status,worker_id,lease_generation,attempt_count,lease_expires_at)
  VALUES($1,$2,'extract_memory',3,'running',$3,1,1,now()+interval '5 minutes')`,[step,task,worker]);
 const claim={task_id:task,step_id:step,step_name:'extract_memory',worker_id:worker,lease_generation:1};
 const config=await readFile(fixture.envFilePath,'utf8'),dsn=config.match(/^NOTALONE_DATABASE_URL=(.*)$/m)[1];
 const script=`import sys,json\nfrom uuid import UUID,uuid4\nfrom notalone.scopes import ContactScope\nfrom notalone.memory_extraction.cli_support import load_contact_messages\nfrom notalone.memory_extraction.command import _plan_batch\nfrom notalone.persistence.extraction_trace import PostgresExtractionTraceStore\nscope=ContactScope(UUID(sys.argv[2]),UUID(sys.argv[3]));target=UUID(sys.argv[4]);messages=[m for m in load_contact_messages(scope,sys.argv[1]) if m.message_id==target];claim=json.loads(sys.argv[5])\nplan=_plan_batch(batch=messages,messages=messages,message_positions={m.message_id:i for i,m in enumerate(messages)},scope=scope,context_before=0,context_after=0,batch_size=1,provider='deepseek',model_name='synthetic-model',task_metadata={'task_runtime':claim},selection_receipts=(),previous_watermark=None)\ntrace=PostgresExtractionTraceStore(sys.argv[1]).begin(scope,run_id=uuid4(),batch_key=plan.batch_key,payload=plan.window_payload)\nprint(json.dumps({'trace_id':str(trace),'batch_key':plan.batch_key}))`;
 const seedTrace=()=>JSON.parse(execFileSync(`${homedir()}/miniconda3/envs/NotAlone/bin/python`,['-c',script,dsn,owner,contact,message,JSON.stringify(claim)],{
  env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname},encoding:'utf8'}));
 const seeded=seedTrace();
 const seededWindow=(await c.query("SELECT payload FROM public.memory_extraction_trace_event WHERE trace_id=$1 AND stage='window'",[seeded.trace_id])).rows[0].payload;
 assert.deepEqual(seededWindow.task_runtime,claim);
 await c.query('INSERT INTO public.memory_processing_plan(task_id,owner_id,contact_id)VALUES($1,$2,$3)',[task,owner,contact]);
 await c.query('INSERT INTO public.memory_processing_target(task_id,message_id,owner_id,contact_id)VALUES($1,$2,$3,$4)',[task,message,owner,contact]);
 let extractionCalls=0;
 const transaction=async work=>{await c.query('BEGIN');try{const result=await work(c);await c.query('COMMIT');return result;}catch(error){await c.query('ROLLBACK');throw error;}};
 const aService=new ExtractionBatchService({ownerId:owner,transaction,ruleVersion:'b'.repeat(64),unconfirmedRequests:async()=>[],
  model:{binding:{provider:'synthetic-route',model:'synthetic-model',maxTokens:512,temperature:0,reasoningEffort:'off'},
   profile:{context_window_tokens:8192,safety_margin_tokens:512}},
  call:async input=>{
   extractionCalls++;
   const name=input.tools[0].name,args=name==='DirectMemoryExtractionOutput'
    ?{scenes:[{scene_name:'合成运动安排',memories:[{text:messageText,category:'preference',subject:'contact',topic:'health',
      source_message_ids:[message],confidence:0.92,risk_flags:[],valid_at:null,invalid_at:null,speech_act:'assertion',
      assertion_status:'asserted',figurative_type:'literal',alternatives:[],interpretation_reason:'合成原话直接支持'}]}]}
    :{results:[{candidate_index:0,verdict:'supported',issues:[],evidence:[{message_id:message,quote:messageText}]}]};
   const blocks=[{type:'tool-call',name,arguments:JSON.stringify(args)}];
   await input.validateOutput(blocks);
   return {text:'',blocks};
  }});
 const aInput={owner_id:owner,contact_id:contact,claim,...seeded};
 const aResult=await aService.run(aInput,new AbortController().signal);
 assert.equal(extractionCalls,2);assert.equal(aResult.accepted.length,1);
 return {fixture,c,pool:new pg.Pool({host:'/tmp',database:dsn.match(/dbname=([^\s]+)/)[1]}),owner,contact,source,message,task,step,worker,claim,
  seeded,aInput,aResult,addMessage,aService,seedTrace};
}

async function addParent(x,index){
 const source=randomUUID(),message=randomUUID(),memory=randomUUID();
 const text=index===0?'联系人喜欢周三跑步':'联系人喜欢周四游泳';
 await x.c.query(`INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
  VALUES($1,$2,$3,'wechat_jsonl',$4,$5,1)`,[source,x.owner,x.contact,`parent-${index}.jsonl`,createHash('sha256').update(text).digest('hex')]);
 await x.addMessage(x.c,{owner:x.owner,contact:x.contact,source,id:message,text,
  occurred:`2026-01-0${index+1}T00:00:00.123456Z`,sourceDocument:source});
 await x.c.query(`INSERT INTO public.confirmed_memory(id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method,status,revision)
  VALUES($1,$2,$3,$4,'preference','health',$5,'auto','active',1)`,[memory,x.owner,x.contact,text,[message]]);
 return {message,memory,text};
}

function mergePort(parents,message,messageText){
 const mergedText='联系人喜欢周三跑步，也喜欢周四游泳';
 const evidence=[...parents.map(parent=>({message_id:parent.message,quote:parent.text})),{message_id:message,quote:messageText}];
 const calls=[];
 const port={async call(input){
  calls.push({purpose:input.purpose,request_id:input.request_id,owner_id:input.owner_id,contact_id:input.contact_id,
   trace_id:input.trace_id,batch_key:input.batch_key,claim:input.claim});
  let args;
  if(input.purpose==='adjudication')args={decisions:[{candidate_index:0,action:'merge',replaced_memory_id:null,
   merged_memory_ids:parents.map(parent=>parent.memory),merged_text:mergedText,duplicate_memory_id:null,
   relation:{kind:'supplement',related_memory_ids:parents.map(parent=>parent.memory),explanation:'合成来源补充两项运动安排',
    evidence,claim_changed:false,condition_changed:false}}]};
  else if(input.purpose==='relation_verification')args={results:[{candidate_index:0,supported:true,evidence,
   claim_changed:false,condition_changed:false}]};
  else if(input.purpose==='merge_verification')args={supported:true,text:mergedText,evidence};
  else throw new Error('unexpected purpose');
  const blocks=[{type:'tool-call',name:input.schema.title,arguments:JSON.stringify(args)}];
  await input.validateOutput(blocks);
  return {blocks,usage:{call_id:randomUUID(),model_name:'synthetic-dsh',input_tokens:10,output_tokens:2,purpose:input.purpose}};
 }};
 return {port,calls,mergedText};
}

async function close(x){await x.pool.end();await x.fixture.close();}

test('A结果在真实租约围栏内完成三类裁决、合并、trace与水位收尾',async()=>{
 const x=await setupA();
 try{
  const parents=[await addParent(x,0),await addParent(x,1)];
  const runtime=mergePort(parents,x.message,'联系人两项运动都安排');
  const store=new ExtractionTaskStore(x.pool);
  const service=new ExtractionAdoptionService({ownerId:x.owner,taskStore:store,adjudicationPort:runtime.port,embedding:fixedEmbedding()});
  const input={owner_id:x.owner,contact_id:x.contact,...x.seeded,claim:x.claim,a_result:x.aResult};
  const result=await service.run(input,new AbortController().signal);
  assert.equal(result.cached,false);assert.equal(result.stats.merged,1);assert.equal(result.watermark,x.message);
  assert.equal(result.receipt.accepted_count,1);assert.equal(result.receipt.rejected_count,x.aResult.rejected_count);
  assert.deepEqual(runtime.calls.map(row=>row.purpose),['adjudication','relation_verification','merge_verification']);
  assert.equal(new Set(runtime.calls.map(row=>row.request_id)).size,3);
  for(const [index,call] of runtime.calls.entries()){
   assert.match(call.request_id,uuidPattern);
   const detail=call.purpose==='merge_verification'?'0':'batch';
   assert.equal(call.request_id,adoptionPurposeRequestId(call.purpose,x.task,x.seeded.batch_key,detail));
   assert.deepEqual({owner_id:call.owner_id,contact_id:call.contact_id,trace_id:call.trace_id,batch_key:call.batch_key,claim:call.claim},
    {owner_id:x.owner,contact_id:x.contact,trace_id:x.seeded.trace_id,batch_key:x.seeded.batch_key,claim:x.claim});
  }
  const trace=(await x.c.query('SELECT status FROM public.memory_extraction_trace WHERE trace_id=$1',[x.seeded.trace_id])).rows[0];
  assert.equal(trace.status,'succeeded');
  const stages=(await x.c.query(`SELECT stage,count(*)::int AS n FROM public.memory_extraction_trace_event
   WHERE trace_id=$1 AND stage IN ('typescript_b_begin','typescript_b_result','batch_end','candidate_result') GROUP BY stage`,[x.seeded.trace_id])).rows;
  assert.deepEqual(Object.fromEntries(stages.map(row=>[row.stage,row.n])),{typescript_b_begin:1,typescript_b_result:1,batch_end:1,candidate_result:1});
  const end=(await x.c.query(`SELECT payload FROM public.memory_extraction_trace_event
   WHERE trace_id=$1 AND stage='batch_end'`,[x.seeded.trace_id])).rows[0].payload;
  assert.equal(end.adoption.merged,1);assert.equal(end.watermark_after,x.message);
  assert.equal(end.typescript_a_receipt.a_execution_id,x.aResult.a_execution_id);
  assert.equal(end.typescript_b_receipt.b_execution_id,result.b_execution_id);
  assert.equal((await x.c.query(`SELECT count(*)::int AS n FROM public.memory_extraction_trace_link
   WHERE trace_id=$1 AND record_kind='message' AND record_id=$2 AND operation='input' AND commit_status='committed'`,
   [x.seeded.trace_id,x.message])).rows[0].n,1);
  assert.equal((await x.c.query(`SELECT count(*)::int AS n FROM public.memory_extraction_trace_link
   WHERE trace_id=$1 AND record_kind='contact_memory' AND commit_status='committed'`,[x.seeded.trace_id])).rows[0].n,1);
  const dependencies=(await x.c.query('SELECT source_id FROM public.memory_extraction_trace_dependency WHERE trace_id=$1',
   [x.seeded.trace_id])).rows.map(row=>row.source_id);
  for(const source of [x.message,...parents.map(parent=>parent.message)])assert.ok(dependencies.includes(source));
  assert.equal((await x.c.query("SELECT count(*)::int AS n FROM public.memory_processing_receipt WHERE message_id=$1 AND outcome='succeeded'",
   [x.message])).rows[0].n,1);
  assert.equal((await x.c.query("SELECT last_message_id FROM public.memory_extraction_watermark WHERE owner_id=$1 AND contact_id=$2",
   [x.owner,x.contact])).rows[0].last_message_id,x.message);
  const children=(await x.c.query("SELECT status FROM public.confirmed_memory WHERE id=ANY($1::uuid[]) ORDER BY id",[parents.map(row=>row.memory)])).rows;
  assert.deepEqual(children.map(row=>row.status),['invalidated','invalidated']);
  assert.equal((await x.c.query("SELECT count(*)::int AS n FROM public.confirmed_memory WHERE status='active' AND merge_parent_ids<>'{}'")).rows[0].n,1);
  const callsBefore=runtime.calls.length;
  const replay=await service.run(input,new AbortController().signal);
  assert.equal(replay.cached,true);assert.equal(runtime.calls.length,callsBefore);assert.deepEqual(replay.stats,result.stats);
  assert.equal((await x.c.query("SELECT count(*)::int AS n FROM public.memory_extraction_trace_event WHERE trace_id=$1 AND stage='batch_end'",
   [x.seeded.trace_id])).rows[0].n,1);
  const recovered=x.seedTrace();
  const recoverableA=await x.c.query(`SELECT b.payload AS begun,r.payload->'outcome' AS outcome,
   EXISTS(SELECT 1 FROM memory_extraction_trace_event e WHERE e.owner_id=$1 AND e.contact_id=$2
    AND e.stage='batch_end' AND e.payload#>>'{typescript_a_receipt,a_execution_id}'=b.payload->>'execution_id'
    AND e.payload#>>'{typescript_a_receipt,a_input_sha256}'=b.payload->>'input_sha256'
    AND e.payload#>>'{typescript_a_receipt,a_rule_version}'=b.payload->>'rule_version') AS consumed
   FROM memory_extraction_trace_event b JOIN memory_extraction_trace tr ON tr.trace_id=b.trace_id
   LEFT JOIN memory_extraction_trace_event r ON r.trace_id=b.trace_id AND r.stage='typescript_a_result'
   WHERE tr.owner_id=$1 AND tr.contact_id=$2 AND tr.batch_key=$3 AND b.stage='typescript_a_begin'
    AND b.payload->>'task_id'=$4`,[x.owner,x.contact,x.seeded.batch_key,x.task]);
  assert.equal(recoverableA.rowCount,1);
  assert.equal(recoverableA.rows[0].begun.input_sha256,x.aResult.a_input_sha256);
  assert.equal(recoverableA.rows[0].consumed,true);
  assert.equal(recoverableA.rows[0].begun.rule_version,x.aResult.a_rule_version);
  assert.equal(recoverableA.rows[0].outcome.a_execution_id,x.aResult.a_execution_id);
  assert.equal(recoverableA.rows[0].outcome.a_input_sha256,x.aResult.a_input_sha256);
  assert.deepEqual(recoverableA.rows[0].outcome.model_call_ids,x.aResult.model_call_ids);
  const recoveredA=await x.aService.run({...x.aInput,...recovered},new AbortController().signal);
  assert.equal(recoveredA.a_execution_id,x.aResult.a_execution_id,JSON.stringify({
   stored:{execution:x.aResult.a_execution_id,input:x.aResult.a_input_sha256,rule:x.aResult.a_rule_version},
   recovered:{execution:recoveredA.a_execution_id,input:recoveredA.a_input_sha256,rule:recoveredA.a_rule_version},
  }));
  const recoveredB=await service.run({owner_id:x.owner,contact_id:x.contact,...recovered,claim:x.claim,a_result:recoveredA},
   new AbortController().signal);
  assert.equal(recoveredB.cached,true);assert.equal(recoveredB.trace_id,recovered.trace_id);
  assert.deepEqual(recoveredB.stats,result.stats);assert.equal(runtime.calls.length,callsBefore);
  assert.equal((await x.c.query("SELECT count(*)::int AS n FROM public.memory_extraction_trace_event WHERE trace_id=$1 AND stage='typescript_b_recovered'",
   [recovered.trace_id])).rows[0].n,1);
  assert.equal((await x.c.query("SELECT count(*)::int AS n FROM public.memory_extraction_trace_event WHERE trace_id=$1 AND stage='batch_end'",
   [recovered.trace_id])).rows[0].n,1);
  assert.equal((await x.c.query("SELECT count(*)::int AS n FROM public.memory_extraction_trace_event WHERE owner_id=$1 AND contact_id=$2 AND stage='batch_end'",
   [x.owner,x.contact])).rows[0].n,2);
  const recoveredReplay=await service.run({owner_id:x.owner,contact_id:x.contact,...recovered,claim:x.claim,a_result:recoveredA},
   new AbortController().signal);
  assert.equal(recoveredReplay.cached,true);assert.equal(runtime.calls.length,callsBefore);
  assert.equal((await x.c.query("SELECT last_message_id FROM public.memory_extraction_watermark WHERE owner_id=$1 AND contact_id=$2",
   [x.owner,x.contact])).rows[0].last_message_id,x.message);
 }finally{await close(x);}
});

test('批次最终提交失败保留已采纳 partial，且不推进水位，重试不重复采纳',async()=>{
 const x=await setupA('联系人喜欢周末看展');
 try{
  const store=new ExtractionTaskStore(x.pool);
  const input={owner_id:x.owner,contact_id:x.contact,...x.seeded,claim:x.claim,a_result:x.aResult};
  let fences=0;
  const flakyStore={assertVerificationPolicy:(...args)=>store.assertVerificationPolicy(...args),fenced:async(claim,work)=>{
   fences++;
   if(fences===5)throw new ExtractionTaskError('synthetic_finalize_failed');
   return store.fenced(claim,work);
  }};
  const neverPort={async call(){throw new Error('no similar parent should invoke dsh');}};
  const flaky=new ExtractionAdoptionService({ownerId:x.owner,taskStore:flakyStore,adjudicationPort:neverPort,embedding:fixedEmbedding()});
  let failed;
  try{await flaky.run(input,new AbortController().signal);}catch(error){failed=error;}
  assert.ok(failed instanceof ExtractionAdoptionError);
  assert.equal(failed.code,'synthetic_finalize_failed');assert.equal(failed.partial.adopted,1);assert.equal(failed.partial.results[0].candidate_index,0);
  assert.equal((await x.c.query("SELECT count(*)::int AS n FROM public.confirmed_memory WHERE status='active' AND adoption_method='auto'")).rows[0].n,1);
  assert.equal((await x.c.query('SELECT count(*)::int AS n FROM public.memory_extraction_watermark')).rows[0].n,0);
  assert.equal((await x.c.query("SELECT count(*)::int AS n FROM public.memory_extraction_trace_event WHERE trace_id=$1 AND stage IN ('typescript_b_result','batch_end')",
   [x.seeded.trace_id])).rows[0].n,0);
  assert.equal((await x.c.query('SELECT status FROM public.memory_extraction_trace WHERE trace_id=$1',[x.seeded.trace_id])).rows[0].status,'running');
  const retried=await new ExtractionAdoptionService({ownerId:x.owner,taskStore:store,adjudicationPort:neverPort,embedding:fixedEmbedding()})
   .run(input,new AbortController().signal);
  assert.equal(retried.stats.skipped_duplicate,1);
  assert.equal((await x.c.query("SELECT count(*)::int AS n FROM public.confirmed_memory WHERE status='active' AND adoption_method='auto'")).rows[0].n,1);
  assert.equal((await x.c.query("SELECT last_message_id FROM public.memory_extraction_watermark WHERE owner_id=$1 AND contact_id=$2",
   [x.owner,x.contact])).rows[0].last_message_id,x.message);
 }finally{await close(x);}
});

test('A结果来源撤销后停止B且不写记忆或水位',async()=>{
 const x=await setupA('联系人不接受临时邀约');
 try{
  const store=new ExtractionTaskStore(x.pool);
  await x.c.query("UPDATE public.source_document SET status='delete_requested' WHERE id=$1",[x.source]);
  const input={owner_id:x.owner,contact_id:x.contact,...x.seeded,claim:x.claim,a_result:x.aResult};
  const service=new ExtractionAdoptionService({ownerId:x.owner,taskStore:store,adjudicationPort:{async call(){throw new Error('must not call model');}},
   embedding:fixedEmbedding()});
  await assert.rejects(service.run(input,new AbortController().signal),{code:'lease_stale'});
  assert.equal((await x.c.query("SELECT count(*)::int AS n FROM public.confirmed_memory WHERE status='active'")).rows[0].n,0);
  assert.equal((await x.c.query('SELECT count(*)::int AS n FROM public.memory_extraction_watermark')).rows[0].n,0);
  assert.equal((await x.c.query("SELECT count(*)::int AS n FROM public.memory_extraction_trace_event WHERE trace_id=$1 AND stage='typescript_b_begin'",
   [x.seeded.trace_id])).rows[0].n,0);
 }finally{await close(x);}
});

test('模型ACK未知沿因果链保留稳定错误码，不写记忆或水位',async()=>{
 const x=await setupA('联系人准备调整运动安排');
 try{
  await addParent(x,0);await addParent(x,1);
  const port={async call(){
   throw Object.assign(new Error('synthetic ACK ambiguity'),{code:'extraction_model_ack_unknown',receipt:{outcome:'unknown'}});
  }};
  const service=new ExtractionAdoptionService({ownerId:x.owner,taskStore:new ExtractionTaskStore(x.pool),adjudicationPort:port,embedding:fixedEmbedding()});
  const input={owner_id:x.owner,contact_id:x.contact,...x.seeded,claim:x.claim,a_result:x.aResult};
  await assert.rejects(service.run(input,new AbortController().signal),{code:'extraction_model_ack_unknown'});
  assert.equal((await x.c.query("SELECT count(*)::int AS n FROM public.confirmed_memory WHERE status='active'")).rows[0].n,2);
  assert.equal((await x.c.query('SELECT count(*)::int AS n FROM public.memory_extraction_watermark')).rows[0].n,0);
  assert.equal((await x.c.query("SELECT count(*)::int AS n FROM public.memory_extraction_trace_event WHERE trace_id=$1 AND stage='typescript_b_result'",
   [x.seeded.trace_id])).rows[0].n,0);
 }finally{await close(x);}
});
