import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createExtractionFixture} from './extraction-fixture.mjs';
import {startModelHost} from '../src/model-host.ts';
import {createHostModelAccounting,modelTaskRequestId} from '../src/host-model-accounting.ts';

for(const failurePoint of ['record_ack','trace_receipt'])test(`官方profile/原adapter/真实ModelHost与PG：E/V单次attempt、预算、五字段claim、晚结果与${failurePoint}未知`,{timeout:30000},async t=>{
 const db=await createExtractionFixture(),c=db.client;
 const directory=await mkdtemp(join(tmpdir(),'na-extraction-model-'));
 let host,child,exit,provider,dropAck=false,requests=0,firstHttpAccounting;
 t.after(async()=>{if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');if(exit)await exit;await host?.shutdown();if(provider){provider.closeAllConnections();await new Promise(r=>provider.close(r));}await db.close();await rm(directory,{recursive:true,force:true});});
 const owner=(await c.query("INSERT INTO owner(display_name)VALUES('合成') RETURNING id")).rows[0].id;
 const contact=(await c.query("INSERT INTO contact(owner_id,display_name)VALUES($1,'合成') RETURNING id",[owner])).rows[0].id;
 await c.query("INSERT INTO conversation_binding(owner_id,contact_id,channel,account_scope,conversation_locator,status) VALUES($1,$2,'wechat','synthetic','synthetic','active')",[owner,contact]);
 const task=(await c.query("INSERT INTO background_task(owner_id,contact_id,task_type,status,current_step,message_count)VALUES($1,$2,'observation','running','extract_memory',0) RETURNING id",[owner,contact])).rows[0].id;
 const worker=randomUUID();const step=(await c.query("INSERT INTO background_task_step(task_id,step_name,step_order,status,worker_id,lease_generation,attempt_count,lease_expires_at)VALUES($1,'extract_memory',1,'running',$2,1,1,now()+interval '5 minutes') RETURNING id",[task,worker])).rows[0].id;
 const claim={task_id:task,step_id:step,step_name:'extract_memory',worker_id:worker,lease_generation:1};
 const key='b'.repeat(64),tr=randomUUID();
 await c.query('INSERT INTO memory_extraction_trace(trace_id,owner_id,contact_id,run_id,batch_key)VALUES($1,$2,$3,$4,$5)',[tr,owner,contact,randomUUID(),key]);
 await c.query("INSERT INTO memory_extraction_trace_event(event_id,trace_id,owner_id,contact_id,position,stage,payload)VALUES($1,$2,$3,$4,1,'window',$5)",[randomUUID(),tr,owner,contact,{task_runtime:claim}]);
 const transaction=async work=>{await c.query('BEGIN');try{const v=await work(c);await c.query('COMMIT');return v;}catch(e){await c.query('ROLLBACK');throw e;}};
 const accounting=createHostModelAccounting({transaction,provider:'synthetic',typescriptProvider:'synthetic-route',model:'synthetic-model',unconfirmedPermitIds:()=>host?.unconfirmedPermitIds()??[]});
 host=await startModelHost({runtimeEnvironment:{NOTALONE_MANAGED_USER_DATA:directory},businessHome:directory,infoPath:join(directory,'info'),envFilePath:join(directory,'env'),accounting:{...accounting,recordReserved:async r=>{await accounting.recordReserved(r);if(dropAck)throw new Error('synthetic_ack_lost');}}});
 provider=createServer(async(req,res)=>{let raw='';for await(const p of req)raw+=p;requests++;const failureStatus=raw.match(/FAIL_(\d{3})/);
  if(requests===1)firstHttpAccounting={ledgerRows:(await c.query('SELECT count(*)::int n FROM outbound_ledger_entry')).rows[0].n,
   receipt:(await c.query('SELECT ledger_entry_id,outcome,dispatch FROM model_call_receipt')).rows[0]};
  if(failureStatus){res.writeHead(Number(failureStatus[1]));res.end(JSON.stringify({error:{message:'sensitive_synthetic_upstream_detail'}}));return;}
  const events=[{type:'message_start',message:{id:'synthetic',model:'synthetic-model',usage:{input_tokens:3,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'合成候选'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},{type:'message_stop'}];
  if(JSON.parse(raw).tools){events[1]={type:'content_block_start',index:0,content_block:{type:'tool_use',id:'synthetic-tool',name:'SourceVerificationOutput',input:{}}};events[2]={type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify({supported:true})}};events[4].delta.stop_reason='tool_use';}
  res.setHeader('content-type','text/event-stream');res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
 });provider.listen(0,'127.0.0.1');await once(provider,'listening');
 const profile=join(directory,'profiles','notalone');await mkdir(profile,{recursive:true});await writeFile(join(profile,'package.json'),JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}));await writeFile(join(profile,'cordis.patch.yml'),`- insert:\n    - name: '@deepseek-ai/dsh-llm'\n    - name: ${JSON.stringify(resolve('test/extraction-model-plugin.ts'))}\n`);
 child=spawn(process.execPath,[resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','notalone'],{cwd:directory,env:{PATH:process.env.PATH,HOME:directory,DSH_HOME:directory,DSH_TELEMETRY_DISABLED:'1',...host.pythonEnvironment,NOTALONE_SYNTHETIC_PROVIDER_URL:`http://127.0.0.1:${provider.address().port}/anthropic`},stdio:['ignore','pipe','pipe']});exit=once(child,'exit');let log='';child.stderr.on('data',v=>log+=v);
 const url=await new Promise((done,reject)=>{const timer=setTimeout(()=>reject(new Error(log.slice(-1000))),10000);child.stdout.on('data',v=>{log+=v;const m=log.match(/EXTRACTION_MODEL_READY (http:\/\/127\.0\.0\.1:\d+)/);if(m){clearTimeout(timer);done(m[1]);}});child.once('exit',()=>{clearTimeout(timer);reject(new Error(log.slice(-1000)));});});
 const base={request_id:modelTaskRequestId('extraction',task,key),owner_id:owner,contact_id:contact,claim};
 const call=async extra=>await(await fetch(url,{method:'POST',body:JSON.stringify({...base,attempt_id:randomUUID(),...extra})})).json();
 const ledgerId=randomUUID();
 const e=await call({ledger_entry_id:ledgerId,ledgerProvider:'untrusted-call-override'});assert.equal(e.text,'合成候选');assert.equal(e.receipt.outcome,'succeeded');assert.equal(e.receipt.provider,'synthetic-route');assert.equal(e.receipt.ledger_entry_id,ledgerId);assert.equal(e.callbacks,1);assert.equal(e.receipt.usage.input_tokens,3);assert.equal(e.receipt.cost.amount,'0.0001');assert.equal(requests,1);
 assert.equal((await c.query('SELECT ledger_entry_id FROM model_call_receipt WHERE attempt_id=$1',[e.receipt.attempt_id])).rows[0].ledger_entry_id,ledgerId);
 assert.deepEqual((await c.query('SELECT id,outcome FROM outbound_ledger_entry')).rows,[{id:ledgerId,outcome:'succeeded'}]);
 assert.deepEqual(firstHttpAccounting,{ledgerRows:0,receipt:{ledger_entry_id:null,outcome:'pending',dispatch:'authorized_unconfirmed'}},'真实HTTP返回前不得预建010成功行');
 const v=await call({tools:[{name:'SourceVerificationOutput',description:'合成核验',parameters:{type:'object',properties:{supported:{type:'boolean'}},required:['supported']}}]});assert.equal(v.blocks[0].type,'tool-call');assert.equal(v.blocks[0].name,'SourceVerificationOutput');assert.deepEqual(JSON.parse(v.blocks[0].arguments),{supported:true});assert.equal(v.receipt.request_id,e.receipt.request_id);assert.notEqual(v.receipt.attempt_id,e.receipt.attempt_id);assert.equal(requests,2);
 const wrong=await call({wrongLedger:true});assert.equal(wrong.error,'extraction_model_call_failed');assert.equal(requests,2,'错误账本身份不得出站');
 const denied=await call({claim:{...claim,lease_generation:2}});assert.equal(denied.error,'extraction_model_call_failed');assert.equal(requests,2);
 const budget=await call({oversized:true});assert.equal(budget.error,'extraction_model_budget_exceeded');assert.equal(requests,2);
 const cancel=await call({cancelBeforeDispatch:true});assert.equal(cancel.error,'extraction_model_cancelled');assert.equal(cancel.receipt.outcome,'cancelled');assert.equal(cancel.receipt.dispatch,'not_sent');assert.equal(requests,2);
 const revoked=await call({revokeBeforeDispatch:true});assert.equal(revoked.error,'extraction_model_call_failed');assert.equal(revoked.receipt.outcome,'cancelled');assert.equal(requests,2);
 const late=await call({lateInvalid:true});assert.equal(late.error,'extraction_model_source_stale');assert.equal(requests,3);assert.equal((await c.query("SELECT count(*)::int n FROM model_call_receipt WHERE outcome='succeeded'")).rows[0].n,3);
 const invalid=await call({validationReject:true});assert.equal(invalid.error,'extraction_model_validation_failed');assert.equal(invalid.receipt.outcome,'failed');assert.equal(invalid.receipt.legacy_outcome,'rejected_by_validation');assert.equal(invalid.receipt.usage.input_tokens,3);assert.equal(invalid.callbacks,1);assert.equal(requests,4);assert.equal((await c.query('SELECT outcome FROM outbound_ledger_entry WHERE id=$1',[invalid.receipt.attempt_id])).rows[0].outcome,'rejected_by_validation');
 const failureKey='c'.repeat(64),failureTrace=randomUUID();
 await c.query('INSERT INTO memory_extraction_trace(trace_id,owner_id,contact_id,run_id,batch_key)VALUES($1,$2,$3,$4,$5)',[failureTrace,owner,contact,randomUUID(),failureKey]);
 await c.query("INSERT INTO memory_extraction_trace_event(event_id,trace_id,owner_id,contact_id,position,stage,payload)VALUES($1,$2,$3,$4,1,'window',$5)",[randomUUID(),failureTrace,owner,contact,{task_runtime:claim}]);
 const failureLedger=randomUUID(),failure=await call({providerStatus:503,ledger_entry_id:failureLedger,request_id:modelTaskRequestId('extraction',task,failureKey)});
 assert.equal(failure.error,'extraction_model_call_failed');assert.equal(failure.receipt.outcome,'failed');assert.equal(failure.receipt.dispatch,'response_observed');assert.equal(failure.receipt.ledger_entry_id,failureLedger);assert.equal(failure.retryable,true);assert.deepEqual(failure.provider_failure,{name:'LlmFailure',code:'SERVER',status:503});assert.equal(failure.callbacks,1);assert.equal(JSON.stringify(failure).includes('sensitive_synthetic_upstream_detail'),false);assert.equal(requests,5,'官方SDK不得隐式重试503');
 assert.equal((await c.query('SELECT outcome FROM outbound_ledger_entry WHERE id=$1',[failureLedger])).rows[0].outcome,'run_failed');
 for(const [status,code,retryable] of [[408,'HTTP_408',true],[429,'RATE_LIMIT',true],[401,'AUTH',false]]){
  const result=await call({providerStatus:status,request_id:modelTaskRequestId('extraction',task,failureKey)});
  assert.equal(result.receipt.outcome,'failed');assert.equal(result.receipt.dispatch,'response_observed');assert.equal(result.retryable,retryable);assert.deepEqual(result.provider_failure,{name:'LlmFailure',code,status});
 }
 assert.equal(requests,8,'各次调用只发一个真实HTTP，重试由E业务层决定');
 if(failurePoint==='trace_receipt'){
  const attempt=randomUUID(),ledger=randomUUID();
  const callback=await call({attempt_id:attempt,ledger_entry_id:ledger,receiptCallbackFailure:true});
  assert.equal(callback.error,'synthetic_receipt_callback_failed');assert.equal(callback.callbacks,1);assert.equal(callback.retryable,false);assert.equal(requests,9);
  assert.deepEqual((await c.query('SELECT ledger_entry_id,outcome,dispatch FROM model_call_receipt WHERE attempt_id=$1',[attempt])).rows[0],{ledger_entry_id:ledger,outcome:'succeeded',dispatch:'response_observed'},'最小关联失败时PG真实终态保持已知');
  const unknown=await call({op:'unconfirmed'});assert.equal(unknown.ids.includes(base.request_id),true,'关联回调失败不能提前settle journal');
  const blocked=await call({});assert.equal(blocked.error,'extraction_model_recovery_unknown');assert.equal(requests,9,'PG terminal已ACK也不能重发业务未确认的同批模型');
  return;
 }
 dropAck=true;const ack=await call({});assert.equal(ack.error,'extraction_model_ack_unknown');assert.equal(ack.receipt.outcome,'succeeded');assert.equal(ack.retryable,false);assert.equal(requests,9);
 dropAck=false;await call({op:'record',receipt:ack.receipt});const unknown=await call({op:'unconfirmed'});assert.deepEqual(unknown.ids,[base.request_id],JSON.stringify(unknown));
 const blocked=await call({});assert.equal(blocked.error,'extraction_model_recovery_unknown');assert.equal(blocked.retryable,false);assert.equal(requests,9,'PG known不得清除journal孤儿并重放');
 assert.equal((await c.query('SELECT count(*)::int n FROM model_call_receipt')).rows[0].n,11);
});
