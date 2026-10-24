import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import pg from 'pg';
import {SourceProcessingTraceStore} from '../src/source-processing-trace.ts';
import {SourceProcessingTraceApi} from '../src/source-processing-trace-http.ts';
import {eraseSourceTraces} from '../src/memory-mutations-erasure.ts';

const syntheticText='合成联系人喜欢周三散步';
const syntheticSecret='合成敏感正文不得进入诊断';

async function fixture(){
 const name=`notalone_task12_trace_${randomUUID().replaceAll('-','')}_test`;
 const python=`${homedir()}/miniconda3/envs/NotAlone/bin/python`,root=new URL('../../',import.meta.url).pathname;
 const env={...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:`${root}/backend/src`};
 execFileSync(python,['-c',`import sys,psycopg\nfrom pathlib import Path\nfrom psycopg import sql\nfrom notalone.database_migrations import migrate\nwith psycopg.connect('host=/tmp dbname=postgres',autocommit=True) as c: c.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0').format(sql.Identifier(sys.argv[1])))\nmigrate('host=/tmp dbname='+sys.argv[1],Path(sys.argv[2]))`,name,`${root}/backend/database/migrations`],{env,stdio:'pipe'});
 const pool=new pg.Pool({host:'/tmp',database:name,max:5});
 const owner=randomUUID(),contact=randomUUID(),otherContact=randomUUID(),source=randomUUID(),otherSource=randomUUID();
 await pool.query("INSERT INTO owner(id,display_name)VALUES($1,'合成 owner')",[owner]);
 await pool.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成联系人'),($3,$2,'合成其他联系人')",[contact,owner,otherContact]);
 await pool.query(`INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
  VALUES($1,$2,$3,'wechat_jsonl','synthetic-primary.jsonl',$4,1),($5,$2,$6,'wechat_jsonl','synthetic-other.jsonl',$7,0)`,
 [source,owner,contact,'a'.repeat(64),otherSource,otherContact,'b'.repeat(64)]);
 return {pool,name,python,env,owner,contact,otherContact,source,otherSource,store:new SourceProcessingTraceStore(pool),
  async close(){await pool.end();execFileSync(python,['-c',`import sys,psycopg\nfrom psycopg import sql
assert sys.argv[1].startswith('notalone_task12_trace_') and sys.argv[1].endswith('_test')
with psycopg.connect('host=/tmp dbname=postgres',autocommit=True) as c: c.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(sys.argv[1])))`,name],{env,stdio:'pipe'});}};
}

async function primaryTrace(f,taskStatus='succeeded'){
 const message=randomUUID(),ref=randomUUID(),batch=randomUUID(),record=randomUUID(),capture=randomUUID();
 const source=randomUUID(),sourceSha=createHash('sha256').update(source).digest('hex');
 const task=randomUUID(),step=randomUUID(),trace=randomUUID(),candidate=randomUUID(),memory=randomUUID(),candidateTrace=randomUUID();
 await f.pool.query(`INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
  VALUES($1,$2,$3,'wechat_jsonl','synthetic-primary.jsonl',$4,1)`,[source,f.owner,f.contact,sourceSha]);
 await f.pool.query(`INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
  VALUES($1,$2,$3,'contact','text',$4,'2026-10-25T08:00:00.123456+08:00')`,[message,f.owner,f.contact,syntheticText]);
 await f.pool.query(`INSERT INTO message_source_ref(id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
  VALUES($1,$2,$3,$4,'source_document',$5,$6,$7::jsonb)`,[ref,message,f.owner,f.contact,source,`jsonl:${ref}`,
  JSON.stringify({time_iso:'2026-10-25T08:00:00.123456+08:00',text:syntheticText,source_version:'v1'})]);
 await f.pool.query(`INSERT INTO source_processing_batch(batch_id,owner_id,contact_id,source_kind,source_id)
  VALUES($1,$2,$3,'source_document',$4)`,[batch,f.owner,f.contact,source]);
 await f.pool.query(`INSERT INTO source_processing_record(record_id,batch_id,owner_id,contact_id,position,locator,message_id,source_ref_id,outcome,payload)
  VALUES($1,$2,$3,$4,0,$5,$6,$7,'normalized',$8::jsonb)`,[record,batch,f.owner,f.contact,`jsonl:${ref}`,message,ref,
  JSON.stringify({capture_record_id:capture,capture_layer:'raw_jsonl_line',parsed:{text:syntheticSecret}})]);
 await f.pool.query(`INSERT INTO background_task(id,owner_id,contact_id,source_document_id,task_type,status,current_step,message_count)
  VALUES($1,$2,$3,$4,'import',$5,'extract_memory',1)`,[task,f.owner,f.contact,source,taskStatus]);
 await f.pool.query(`INSERT INTO background_task_step(id,task_id,step_name,step_order,status,attempt_count,total_count)
  VALUES($1,$2,'extract_memory',3,$3,1,1)`,[step,task,taskStatus==='running'?'running':'succeeded']);
 await f.pool.query(`INSERT INTO memory_processing_plan(task_id,owner_id,contact_id)VALUES($1,$2,$3)`,[task,f.owner,f.contact]);
 await f.pool.query(`INSERT INTO memory_processing_target(task_id,message_id,owner_id,contact_id,completed_at,outcome)
  VALUES($1,$2,$3,$4,CASE WHEN $5='running' THEN NULL ELSE now() END,CASE WHEN $5='running' THEN NULL ELSE 'succeeded' END)`,
  [task,message,f.owner,f.contact,taskStatus]);
 await f.pool.query(`INSERT INTO memory_extraction_trace(trace_id,owner_id,contact_id,run_id,batch_key,status,finished_at,failure_stage,error_code)
  VALUES($1,$2,$3,$4,'synthetic-batch',$5,CASE WHEN $5='running' THEN NULL ELSE now() END,$6,$7)`,
  [trace,f.owner,f.contact,randomUUID(),taskStatus,taskStatus==='business_failed'?'adoption':null,
   taskStatus==='business_failed'?'source_changed':null]);
 const window={version:1,owner_id:f.owner,contact_id:f.contact,target_message_ids:[message],task_runtime:{task_id:task,step_id:step},
  messages:[{message_id:message,text:syntheticText,sender:'contact',occurred_at:'2026-10-25T00:00:00.123456+00:00',
   source_snapshots:[{source_ref_id:ref,source_id:source,source_kind:'source_document',locator:`jsonl:${ref}`,
    raw_payload:{text:syntheticSecret,source_version:'v1'},source_content_sha256:sourceSha}]}]};
 const events=[
  ['window',null,window],
  ['model_request',null,{purpose:'extraction',messages:[{role:'user',content:syntheticSecret}],capture_layer:'application_request'}],
  ['extraction_return',null,{candidate_trace_ids:[candidateTrace],blocks:[{text:syntheticSecret}]}],
  ['candidate_raw',candidateTrace,{index:0,fields:{text:syntheticText}}],
  ['parse',candidateTrace,{status:'accepted',after:{text:syntheticText}}],
  ['verification_input',null,{facts:[{text:syntheticText}],window}],
  ['verification_return',null,{blocks:[{text:'supported'}]}],
  ['verification',candidateTrace,{status:'validated',result:{verdict:'supported'},disposition:'continue'}],
  ['adjudication',candidateTrace,{action:'add',reason:'合成来源明确支持'}],
  ['candidate_result',candidateTrace,{candidate_index:0,result:{disposition:'adopted',decision:'add',candidate_id:candidate,memory_id:memory},
    usages:[{purpose:'adjudication',call_id:'synthetic'}]}],
  ['batch_end',null,{status:'succeeded',watermark_message_id:message}],
 ];
 for(const [position,[stage,candidate_trace,payload]] of events.entries())await f.pool.query(`INSERT INTO memory_extraction_trace_event
  (event_id,trace_id,owner_id,contact_id,position,stage,candidate_trace_id,payload)VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
  [randomUUID(),trace,f.owner,f.contact,position+1,stage,candidate_trace,JSON.stringify(payload)]);
 await f.pool.query(`INSERT INTO memory_candidate(id,owner_id,contact_id,text_content,category,source_ids,status)
  VALUES($1,$2,$3,$4,'common_fact',ARRAY[$5::uuid],'confirmed')`,[candidate,f.owner,f.contact,syntheticText,message]);
 await f.pool.query(`INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,source_candidate_id,
  adoption_method,status,revision)VALUES($1,$2,$3,$4,'common_fact',ARRAY[$5::uuid],$6,'auto','active',1)`,
  [memory,f.owner,f.contact,syntheticText,message,candidate]);
 for(const [kind,id,operation] of [['message',message,'input'],['candidate',candidate,'save'],['contact_memory',memory,'save']])
  await f.pool.query(`INSERT INTO memory_extraction_trace_link(trace_id,owner_id,contact_id,candidate_trace_id,record_kind,record_id,
   commit_status,operation)VALUES($1,$2,$3,$4,$5,$6,'committed',$7)`,
   [trace,f.owner,f.contact,kind==='message'?null:candidateTrace,kind,id,operation]);
 for(const id of [source,message])await f.pool.query(`INSERT INTO memory_extraction_trace_dependency(trace_id,owner_id,contact_id,source_id)
  VALUES($1,$2,$3,$4)`,[trace,f.owner,f.contact,id]);
 const callIds=[];
 for(const purpose of ['extraction','verification','adjudication']){
  const call=randomUUID(),ledger=randomUUID();callIds.push(call);
  await f.pool.query(`INSERT INTO outbound_ledger_entry(id,owner_id,contact_id,provider,model_name,input_tokens,output_tokens,latency_ms,outcome,called_at)
   VALUES($1,$2,$3,'synthetic-provider','synthetic-model',10,2,5,'succeeded','2026-10-25T00:00:01Z')`,
   [ledger,f.owner,f.contact]);
  await f.pool.query(`INSERT INTO model_call_receipt(attempt_id,owner_id,contact_id,scope_kind,request_id,permit_id,ledger_entry_id,
   provider,model_name,called_at,dispatch,outcome,input_tokens,output_tokens,cost_status)
   VALUES($1,$2,$3,'contact',$4,$5,$6,'synthetic-provider','synthetic-model','2026-10-25T00:00:01Z','response_observed','succeeded',10,2,'unknown')`,
   [randomUUID(),f.owner,f.contact,randomUUID(),randomUUID(),ledger]);
  await f.pool.query(`INSERT INTO memory_extraction_trace_call(call_id,trace_id,owner_id,contact_id,purpose,called_at,finished_at,
   response_status,provider_attempts,ledger_entry_id,ledger_commit_status,disposition)
   VALUES($1,$2,$3,$4,$5,'2026-10-25T00:00:01Z','2026-10-25T00:00:02Z','returned',1,$6,'committed','consumed')`,
   [call,trace,f.owner,f.contact,purpose,ledger]);
 }
 return {source,sourceSha,message,ref,batch,record,capture,task,step,trace,candidate,memory,candidateTrace,callIds};
}

test('合成PG：记忆与任务反查到实际来源、规范消息、处理批次、提取核验裁决和最小台账',async()=>{
 const f=await fixture();try{
  const x=await primaryTrace(f),detail=await f.store.getMemoryTrace({ownerId:f.owner,contactId:f.contact},x.trace);
  assert.equal(detail.availability,'recorded');assert.equal(detail.completeness,'complete');assert.equal(detail.failure,null);
  assert.equal(detail.messages[0].text_content,syntheticText);assert.equal(detail.source_documents[0].content_sha256,x.sourceSha);
  assert.equal(detail.source_documents[0].file_name,'synthetic-primary.jsonl');
  assert.equal(detail.source_processing_batches[0].batch_id,x.batch);
  assert.equal(detail.source_processing_batches[0].records[0].payload.capture_record_id,x.capture);
  assert.equal(detail.source_processing_batches[0].records[0].payload.capture_layer,'raw_jsonl_line');
  assert.equal(detail.tasks[0].id,x.task);assert.deepEqual(detail.tasks[0].steps.map(step=>step.step_name),['extract_memory']);
  assert.deepEqual(detail.events.map(event=>event.stage),['window','model_request','extraction_return','candidate_raw','parse',
   'verification_input','verification_return','verification','adjudication','candidate_result','batch_end']);
  assert.equal(detail.candidates[0].disposition,'adopted');assert.equal(detail.process_record.contains_body,true);
  assert.equal(detail.model_ledger.contains_body,false);assert.deepEqual(detail.model_ledger.calls.map(call=>call.purpose).sort(),
   ['adjudication','extraction','verification']);
  assert.equal(detail.write_receipts.find(receipt=>receipt.record_kind==='contact_memory').adoption_method,'auto');
  assert.equal(detail.versions[0].adoption_method,'auto');
  const memoryLookup=await f.store.findMemoryTraceRecord({ownerId:f.owner,contactId:f.contact},'contact_memory',x.memory);
  assert.equal(memoryLookup.availability,'recorded');assert.deepEqual(memoryLookup.batches.map(batch=>batch.trace_id),[x.trace]);
  const taskLookup=await f.store.findTaskTrace({ownerId:f.owner,contactId:f.contact},x.task);
  assert.equal(taskLookup.availability,'recorded');assert.deepEqual(taskLookup.batches.map(batch=>batch.trace_id),[x.trace]);
  assert.equal(taskLookup.source_processing_batches[0].batch_id,x.batch);
  const sourceLookup=await f.store.findSourceRecord({ownerId:f.owner,contactId:f.contact},'message',x.message);
  assert.equal(sourceLookup.availability,'recorded');assert.deepEqual(sourceLookup.batches.map(batch=>batch.batch_id),[x.batch]);
  const sourcePage=await f.store.listSourceBatches({ownerId:f.owner,contactId:f.contact},{limit:20});
  assert.deepEqual(sourcePage.batches.map(batch=>batch.batch_id),[x.batch]);assert.equal(sourcePage.next_before,null);
  const manual=randomUUID();
  await f.pool.query(`INSERT INTO owner_memory(id,owner_id,text_content,category,topic,source_ids,adoption_method,status)
   VALUES($1,$2,'合成手录本人资料','common_fact','other',ARRAY[$2::uuid],'manual','active')`,[manual,f.owner]);
  const manualLookup=await f.store.findMemoryTraceRecord({ownerId:f.owner,contactId:f.contact},'owner_memory',manual);
  assert.equal(manualLookup.availability,'not_applicable');
  const diagnostic=await f.store.diagnoseMemoryTrace({ownerId:f.owner,contactId:f.contact},x.trace);
  assert.equal(diagnostic.redaction,'metadata_only');assert.equal(diagnostic.contains_body,false);assert.equal(diagnostic.call_count,3);
  const diagnosticText=JSON.stringify(diagnostic);
  for(const secret of [syntheticText,syntheticSecret,'synthetic-primary.jsonl','jsonl:1'])assert.ok(!diagnosticText.includes(secret));
  const api=new SourceProcessingTraceApi(f.store,f.owner);
  const shown=await api.handle('GET',new URL(`http://localhost/api/contacts/${f.contact}/memory-traces/${x.trace}`));
  assert.equal(shown.status,200);assert.equal(shown.body.trace_id,x.trace);
  const byTask=await api.handle('GET',new URL(`http://localhost/api/contacts/${f.contact}/memory-traces/tasks/${x.task}`));
  assert.equal(byTask.status,200);assert.equal(byTask.body.batches[0].trace_id,x.trace);
  await assert.rejects(f.store.getMemoryTrace({ownerId:f.owner,contactId:f.otherContact},x.trace),{code:'trace_not_found'});
  const foreign=await api.handle('GET',new URL(`http://localhost/api/contacts/${f.otherContact}/memory-traces/${x.trace}`));
  assert.equal(foreign.status,404);assert.equal(foreign.body.error,'trace_not_found');
  await f.pool.query("UPDATE memory_extraction_trace SET status='running',finished_at=NULL WHERE trace_id=$1",[x.trace]);
  const running=await f.store.getMemoryTrace({ownerId:f.owner,contactId:f.contact},x.trace);
  assert.equal(running.processing_state,'in_progress');assert.equal(running.completeness,'partial');
  await f.pool.query(`UPDATE memory_extraction_trace SET status='business_failed',finished_at=now(),failure_stage='adoption',
   error_code='source_changed' WHERE trace_id=$1`,[x.trace]);
  const failed=await f.store.getMemoryTrace({ownerId:f.owner,contactId:f.contact},x.trace);
  assert.deepEqual(failed.failure,{stage:'adoption',code:'source_changed'});
  await f.pool.query("UPDATE source_document SET status='deleting' WHERE id=$1",[x.source]);
  await assert.rejects(f.store.getMemoryTrace({ownerId:f.owner,contactId:f.contact},x.trace),{code:'trace_sources_unavailable'});
  await f.pool.query("UPDATE source_document SET status='active' WHERE id=$1",[x.source]);
 }finally{await f.close();}
});

test('合成PG：过程与来源删除清除正文和恢复路径，联系删除后不可查询且权威记忆不因删追踪丢失',async()=>{
 const f=await fixture();try{
  const x=await primaryTrace(f),scope={ownerId:f.owner,contactId:f.contact};
  const first=await f.store.deleteMemoryTrace(scope,x.trace);
  assert.deepEqual(first,{availability:'deleted',batch_id:x.trace});
  const deleted=await f.store.getMemoryTrace(scope,x.trace);
  assert.equal(deleted.availability,'deleted');assert.deepEqual(deleted.events,[]);assert.deepEqual(deleted.messages,[]);
  assert.equal(deleted.calls.length,3,'最小无正文台账保留');
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM memory_extraction_trace_event WHERE trace_id=$1',[x.trace])).rows[0].n,0);
  assert.equal((await f.pool.query("SELECT count(*)::int n FROM confirmed_memory WHERE id=$1 AND status='active'",[x.memory])).rows[0].n,1);

  const second=await primaryTrace(f),secondScope=scope;
  await f.pool.query("DELETE FROM public.memory_extraction_trace_dependency WHERE trace_id=$1",[second.trace]);
  await f.pool.query("DELETE FROM public.memory_extraction_trace_link WHERE trace_id=$1 AND record_kind='message'",[second.trace]);
  const secondDeleted=await f.store.deleteSourceBatch(secondScope,second.batch);
  assert.deepEqual(secondDeleted,{availability:'deleted',batch_id:second.batch});
  assert.equal((await f.pool.query("SELECT count(*)::int n FROM source_processing_capture_tombstone WHERE owner_id=$1 AND contact_id=$2 AND capture_record_id=$3",
   [f.owner,f.contact,second.capture])).rows[0].n,1);
  const processing=await f.store.getSourceBatch(secondScope,second.batch);
  assert.equal(processing.status,'deleted');assert.equal(processing.records[0].payload,null);assert.equal(processing.records[0].locator,null);
  const sourceDeletedTrace=await f.store.getMemoryTrace(scope,second.trace);
  assert.equal(sourceDeletedTrace.status,'deleted');assert.deepEqual(sourceDeletedTrace.events,[]);
  await f.store.deleteSourceBatch(secondScope,second.batch);
  assert.equal((await f.pool.query("SELECT count(*)::int n FROM source_processing_capture_tombstone WHERE owner_id=$1 AND contact_id=$2 AND capture_record_id=$3",
   [f.owner,f.contact,second.capture])).rows[0].n,1,'重放不新增或恢复捕获路径');

  const third=await primaryTrace(f);
  await f.pool.query("DELETE FROM public.memory_extraction_trace_dependency WHERE trace_id=$1",[third.trace]);
  await f.pool.query("DELETE FROM public.memory_extraction_trace_link WHERE trace_id=$1 AND record_kind='message'",[third.trace]);
  await f.pool.query("UPDATE source_document SET status='deleting' WHERE id=$1",[third.source]);
  await assert.rejects(f.store.getMemoryTrace(scope,third.trace),{code:'trace_sources_unavailable'});
  await f.pool.query("UPDATE source_document SET status='active' WHERE id=$1",[third.source]);
  const sourceClient=await f.pool.connect();
  try{await sourceClient.query('BEGIN');await eraseSourceTraces(sourceClient,f.owner,[third.source],f.contact);
   await sourceClient.query('COMMIT');}
  catch(error){await sourceClient.query('ROLLBACK');throw error;}
  finally{sourceClient.release();}
  const sourceDeleted=await f.store.getMemoryTrace(scope,third.trace);
  assert.equal(sourceDeleted.status,'deleted');assert.equal(sourceDeleted.events.length,0);

  await f.pool.query('DELETE FROM contact WHERE owner_id=$1 AND id=$2',[f.owner,f.contact]);
  const checked=await (async()=>{try{await f.store.getMemoryTrace(scope,x.trace);return false;}catch(error){return error.code;}})();
  assert.equal(checked,'trace_not_found');
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM memory_extraction_trace WHERE owner_id=$1 AND contact_id=$2',
   [f.owner,f.contact])).rows[0].n,0);
 }finally{await f.close();}
});
