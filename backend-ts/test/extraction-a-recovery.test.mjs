import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import pg from 'pg';
import {createExtractionFixture} from './extraction-fixture.mjs';
import {ExtractionTaskStore} from '../src/extraction-task-store.ts';
import {unsettledExtraction,blockedExtraction,quarantineExtraction} from '../src/extraction-task-store-recovery.ts';
import {modelTaskRequestId} from '../src/host-model-accounting.ts';

test('A段begin-only与清正文恢复精确隔离，完整结果和原子B消费可恢复，物理未知仍保留',async()=>{
 const f=await createExtractionFixture();let pool;
 try{
  const c=f.client,owner=randomUUID(),contact=randomUUID(),source=randomUUID(),first=randomUUID(),fresh=randomUUID();
  await c.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
  await c.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
  await c.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,2)",[source,owner,contact,'a'.repeat(64)]);
  for(const id of [first,fresh]){
   await c.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text','合成恢复目标',now())",[id,owner,contact]);
   await c.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,'source_document',$4,$5,'{}')",[id,owner,contact,source,id]);
  }
  pool=new pg.Pool({host:'/tmp',database:c.connectionParameters.database,max:2});
  const store=new ExtractionTaskStore(pool),scope={ownerId:owner,contactId:contact};
  const task=await store.enqueueImport(scope,source,2);
  await c.query("UPDATE background_task_step SET status='succeeded' WHERE task_id=$1 AND step_name IN ('parse','normalize')",[task]);
  const claim=await store.claim(scope,{taskId:task,workerId:randomUUID(),leaseMs:30000});await store.targets(claim);
  const trace=randomUUID(),execution=randomUUID(),key=createHash('sha256').update(first).digest('hex');
  const begin={execution_id:execution,task_id:task,batch_key:key,input_sha256:'b'.repeat(64),rule_version:'c'.repeat(64),request_id:modelTaskRequestId('extraction',task,key)};
  await c.query('INSERT INTO memory_extraction_trace(trace_id,owner_id,contact_id,run_id,batch_key) VALUES($1,$2,$3,$4,$5)',[trace,owner,contact,randomUUID(),key]);
  async function event(stage,payload,target=trace){await c.query('INSERT INTO memory_extraction_trace_event(event_id,trace_id,owner_id,contact_id,position,stage,payload) SELECT $1,$2,$3,$4,COALESCE(max(position),0)+1,$5,$6 FROM memory_extraction_trace_event WHERE trace_id=$2',[randomUUID(),target,owner,contact,stage,payload]);}
  await event('window',{task_runtime:{task_id:task},target_message_ids:[first]});await event('typescript_a_begin',begin);
  function pythonWindows(){
   const script=`import sys,json,psycopg\nfrom uuid import UUID\nfrom notalone.persistence.background_tasks import _unconfirmed_model_requests,_unsettled_extraction_windows\nwith psycopg.connect(sys.argv[1]) as c:\n owner,contact=UUID(sys.argv[2]),UUID(sys.argv[3])\n requests=_unconfirmed_model_requests(c,owner,contact)\n windows={}\n for task,ids in _unsettled_extraction_windows(c,owner,contact,requests): windows.setdefault(str(task),set()).update(map(str,ids))\n print(json.dumps({task:sorted(ids) for task,ids in windows.items()}))`;
   return JSON.parse(execFileSync(`${homedir()}/miniconda3/envs/NotAlone/bin/python`,['-c',script,`host=/tmp dbname=${c.connectionParameters.database}`,owner,contact],{env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname},encoding:'utf8'}));
  }
  async function check(expected){
   const state=await unsettledExtraction(store,c,scope);assert.deepEqual([...(state.windows.get(task)??[])].sort(),expected);
   assert.deepEqual(pythonWindows()[task]??[],expected);return state;
  }
  let state=await check([first]);assert.equal(await blockedExtraction(c,state,task,true),false);assert.equal(await blockedExtraction(c,state,task,false),true);
  await event('typescript_a_not_sent',{a_execution_id:execution,a_input_sha256:'d'.repeat(64),a_rule_version:begin.rule_version,proof:'before_model_invocation'});await check([first]);
  await c.query("DELETE FROM memory_extraction_trace_event WHERE trace_id=$1 AND stage='typescript_a_not_sent'",[trace]);
  await event('typescript_a_not_sent',{a_execution_id:execution,a_input_sha256:begin.input_sha256,a_rule_version:begin.rule_version,proof:'before_model_invocation'});await check([]);
  await c.query("DELETE FROM memory_extraction_trace_event WHERE trace_id=$1 AND stage='typescript_a_not_sent'",[trace]);
  await event('typescript_a_result',{outcome:{accepted:[],failure_reason:null}});await check([]);
  await c.query("DELETE FROM memory_extraction_trace_event WHERE trace_id=$1 AND stage='typescript_a_result'",[trace]);
  const consuming=randomUUID();await c.query('INSERT INTO memory_extraction_trace(trace_id,owner_id,contact_id,run_id,batch_key) VALUES($1,$2,$3,$4,$5)',[consuming,owner,contact,randomUUID(),key]);
  await event('batch_end',{typescript_a_receipt:{a_execution_id:randomUUID(),a_input_sha256:begin.input_sha256,a_rule_version:begin.rule_version}},consuming);await check([first]);
  await event('batch_end',{typescript_a_receipt:{a_execution_id:execution,a_input_sha256:begin.input_sha256,a_rule_version:begin.rule_version}},consuming);await check([]);
  await c.query('DELETE FROM memory_extraction_trace_event WHERE trace_id=ANY($1::uuid[])',[[trace,consuming]]);
  const ledger=randomUUID(),attempt=randomUUID();
  await c.query("INSERT INTO outbound_ledger_entry(id,owner_id,contact_id,provider,model_name,outcome,called_at) VALUES($1,$2,$3,'synthetic','synthetic','succeeded',now())",[ledger,owner,contact]);
  await c.query("INSERT INTO model_call_receipt(attempt_id,owner_id,contact_id,request_id,permit_id,ledger_entry_id,provider,model_name,called_at,dispatch,outcome,cost_status) VALUES($1,$2,$3,$4,$5,$6,'synthetic','synthetic',now(),'not_sent','cancelled','unknown')",[attempt,owner,contact,begin.request_id,randomUUID(),ledger]);
  await c.query("INSERT INTO memory_extraction_trace_call(call_id,trace_id,owner_id,contact_id,purpose,called_at,response_status,provider_attempts,ledger_entry_id,ledger_commit_status,disposition) VALUES($1,$2,$3,$4,'extraction',now(),'unavailable',0,$5,'committed','consumed')",[randomUUID(),trace,owner,contact,ledger]);
  await c.query("INSERT INTO memory_extraction_trace_link(trace_id,owner_id,contact_id,record_kind,record_id,commit_status,operation) VALUES($1,$2,$3,'message',$4,'committed','input')",[trace,owner,contact,first]);
  await check([]);
  await c.query("UPDATE model_call_receipt SET outcome='succeeded',dispatch='response_observed' WHERE attempt_id=$1",[attempt]);
  await c.query('UPDATE memory_extraction_trace_call SET provider_attempts=1 WHERE trace_id=$1',[trace]);
  state=await check([first]);await quarantineExtraction(c,scope,task,state.windows.get(task));
  assert.deepEqual((await c.query('SELECT message_id,outcome FROM memory_processing_receipt WHERE owner_id=$1',[owner])).rows,[{message_id:first,outcome:'unknown'}]);
  assert.equal(await blockedExtraction(c,state,task,true),false);
  await event('typescript_a_result',{outcome:{accepted:[],failure_reason:null}});await check([]);
  await c.query("UPDATE model_call_receipt SET outcome='unknown' WHERE attempt_id=$1",[attempt]);await check([first]);
 }finally{await pool?.end();await f.close();}
});
