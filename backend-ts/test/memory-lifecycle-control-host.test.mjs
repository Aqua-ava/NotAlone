import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {modelTaskRequestId} from '../src/host/host-model-accounting.ts';
import {lifecycleHost} from './memory-lifecycle-host-support.mjs';

test('认证范围暂停与继续持久化意图，幂等重放及旧版本不覆盖更新动作',{timeout:60000},async t=>{
 const host=await lifecycleHost(t),root='/api/owner/memory-processing';
 const initial=await host.request(`${root}/state`);
 assert.equal(initial.data.action_version,0);
 assert.deepEqual(initial.data.current.actions,['pause']);
 const operation_id=randomUUID();
 const pause={action_version:0,operation_id};
 const paused=await host.request(`${root}/pause`,{method:'POST',body:pause});
 assert.equal(paused.status,200);assert.equal(paused.data.accepted,true);assert.equal(paused.data.action_version,1);
 const state=(await host.request(`${root}/state`)).data;
 assert.equal(state.current.status,'paused');assert.deepEqual(state.current.actions,['continue']);
 const resumed=await host.request(`${root}/continue`,{method:'POST',body:{action_version:1,operation_id:randomUUID()}});
 assert.equal(resumed.status,200);assert.equal(resumed.data.action_version,2);
 const replay=await host.request(`${root}/pause`,{method:'POST',body:pause});
 assert.equal(replay.status,200);assert.equal(replay.data.replayed,true);
 assert.equal((await host.request(`${root}/state`)).data.current.status,'waiting');
 assert.equal((await host.request(`${root}/pause`,{method:'POST',body:{...pause,operation_id:randomUUID()}})).status,409);
 assert.equal((await host.request(`${root}/continue`,{method:'POST',body:pause})).status,409);
 assert.equal((await host.request(`${root}/pause`,{authenticated:false,method:'POST',body:{action_version:2,operation_id:randomUUID()}})).status,401);
});

test('持续暂停拦截旧恢复与真实Worker领取，其他范围和独立设置继续保留',{timeout:60000},async t=>{
 const contact=randomUUID(),other=randomUUID(),source=randomUUID(),task=randomUUID();
 const host=await lifecycleHost(t,async(f,owner)=>{
  await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$3,'合成暂停'),($2,$3,'合成其他')",[contact,other,owner]);
  await f.client.query("INSERT INTO memory_processing_scope(owner_id,contact_id,intent,control_generation) VALUES($1,$2,'pause',1)",[owner,contact]);
  await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,0)",[source,owner,contact,'a'.repeat(64)]);
  await f.client.query("INSERT INTO background_task(id,owner_id,contact_id,source_document_id,task_type,status,current_step,message_count) VALUES($1,$2,$3,$4,'import','failed','index',0)",[task,owner,contact,source]);
  await f.client.query("INSERT INTO background_task_step(task_id,step_name,step_order,status) VALUES($1,'extract_memory',1,'succeeded'),($1,'index',2,'pending'),($1,'verify',3,'pending')",[task]);
 });
 const legacy=await host.request(`/api/contacts/${contact}/memory-processing/resume`,{method:'POST',body:{task_id:task,action:'resume'}});
 assert.equal(legacy.status,409);
 assert.equal((await host.request(`/api/contacts/${contact}/memory-processing/state`)).data.current.status,'paused');
 assert.equal((await host.request(`/api/contacts/${other}/memory-processing/state`)).data.current.status,'waiting');
 const before=(await host.request(`/api/contacts/${contact}/layered-memory`)).data.layered_memory.enabled;
 const enabled=await host.request(`/api/contacts/${contact}/layered-memory/enable`,{method:'POST',body:{settings_generation:0,purpose_confirmed:true}});
 assert.equal(enabled.status,409);
 assert.equal((await host.request(`/api/contacts/${contact}/layered-memory`)).data.layered_memory.enabled,before);
});

test('手动暂停在正式宿主重建后保持，本人动作不会恢复联系人',{timeout:60000},async t=>{
 const contact=randomUUID();
 const host=await lifecycleHost(t,async(f,owner)=>{await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成隔离')",[contact,owner]);});
 const root=`/api/contacts/${contact}/memory-processing`;
 assert.equal((await host.request(`${root}/pause`,{method:'POST',body:{action_version:0,operation_id:randomUUID()}})).status,200);
 assert.equal((await host.request('/api/owner/memory-processing/pause',{method:'POST',body:{action_version:0,operation_id:randomUUID()}})).status,200);
 assert.equal((await host.request('/api/owner/memory-processing/continue',{method:'POST',body:{action_version:1,operation_id:randomUUID()}})).status,200);
 await host.restartHost();
 assert.equal((await host.request(`${root}/state`)).data.current.status,'paused');
 assert.equal((await host.request('/api/owner/memory-processing/state')).data.current.status,'waiting');
});

// 只在供应商HTTP边界固定时序；任务、租约、台账、围栏均由正式宿主执行。
test('模型在途暂停结算已发生调用，失去资格的结果不提交且未知回执不盲重发',{timeout:60000},async t=>{
 let entered;const providerEntered=new Promise(resolve=>{entered=resolve;});let calls=0,held;
 const provider=createServer(async(req,res)=>{
  calls++;let raw='';for await(const chunk of req)raw+=chunk;
  const input=JSON.parse(raw);held={res,input};
  res.setHeader('content-type','text/event-stream');
  res.write(`event: message_start\ndata: ${JSON.stringify({type:'message_start',message:{id:'synthetic-held',model:'deepseek-chat',usage:{input_tokens:3,output_tokens:0}}})}\n\n`);
  entered();
 });
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 t.after(async()=>{provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));});
 const contact=randomUUID(),source=randomUUID(),task=randomUUID(),message=randomUUID(),scope=randomUUID(),round=randomUUID();
 const host=await lifecycleHost(t,async(f,owner)=>{
  await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成在途')",[contact,owner]);
  await f.client.query('INSERT INTO memory_processing_scope(id,owner_id,contact_id) VALUES($1,$2,$3)',[scope,owner,contact]);
  await f.client.query("INSERT INTO memory_processing_round(id,scope_id,owner_id,contact_id,round_number,control_generation,status,phase) VALUES($1,$2,$3,$4,1,0,'processing','extraction')",[round,scope,owner,contact]);
  await f.client.query('UPDATE memory_processing_scope SET active_round_id=$1 WHERE id=$2',[round,scope]);
  await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'wechat_jsonl','synthetic-held.jsonl',$4,1)",[source,owner,contact,'b'.repeat(64)]);
  await f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text','合成资料：今天去散步。','2026-10-20T01:00:00Z')",[message,owner,contact]);
  await f.client.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,'source_document',$4,'synthetic:1',$5)",[message,owner,contact,source,{time_iso:'2026-10-20T01:00:00Z'}]);
  await f.client.query("INSERT INTO background_task(id,owner_id,contact_id,source_document_id,task_type,status,current_step,message_count) VALUES($1,$2,$3,$4,'import','queued','extract_memory',1)",[task,owner,contact,source]);
  await f.client.query("INSERT INTO background_task_step(task_id,step_name,step_order,status,total_count) VALUES($1,'extract_memory',1,'pending',1),($1,'index',2,'pending',1),($1,'verify',3,'pending',1)",[task]);
  await f.client.query('INSERT INTO memory_processing_round_task(round_id,task_id,owner_id,contact_id) VALUES($1,$2,$3,$4)',[round,task,owner,contact]);
 },{providerUrl:`http://127.0.0.1:${provider.address().port}`});
 await Promise.race([providerEntered,delay(15000,undefined,{ref:false}).then(()=>{throw Error('供应商未收到实际Worker调用');})]);
 const root=`/api/contacts/${contact}/memory-processing`;
 assert.equal((await host.request(`${root}/state`)).data.current.status,'processing');
 const result=await host.request(`${root}/pause`,{method:'POST',body:{action_version:0,operation_id:randomUUID()}});
 assert.equal(result.status,200);assert.equal(result.data.accepted,true);
 // 供应商迟到的合成结果不能使原租约重新有效。
 const events=[{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'synthetic-tool',name:held.input.tools[0].name,input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'{"scenes":[]}'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:2}},{type:'message_stop'}];
 held.res.end(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
 const state=(await host.request(`${root}/state`)).data;
 assert.equal(state.current.status,'paused');assert.equal(state.current.processed_count,0);
 const usage=(await host.request('/api/ledger/summary')).data;
 assert.equal(usage.total_attempts,1);assert.notEqual(usage.recent[0].outcome,'pending');
 if(usage.recent[0].outcome==='unknown'){
  assert.deepEqual(state.current.actions,[]);
  assert.equal((await host.request(`${root}/continue`,{method:'POST',body:{action_version:1,operation_id:randomUUID()}})).status,409);
 }
 assert.equal(calls,1);
 assert.equal((await host.request(`${root}/state`)).data.current.processed_count,0);
});

async function until(read,timeoutMs=8000){
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){const value=await read();if(value)return value;await delay(20);}
 throw Error('合成公开状态未就绪');
}

test('暂停阻止后续阶段领取而另一范围完成，继续复用原任务与成功提取阶段',{timeout:60000},async t=>{
 const paused=randomUUID(),other=randomUUID(),tasks=new Map();
 const host=await lifecycleHost(t,async(f,owner)=>{
  for(const contact of [paused,other]){
   const scope=randomUUID(),round=randomUUID(),task=randomUUID(),source=randomUUID();tasks.set(contact,task);
   await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成阶段')",[contact,owner]);
   await f.client.query('INSERT INTO memory_processing_scope(id,owner_id,contact_id,intent,control_generation) VALUES($1,$2,$3,$4,$5)',[scope,owner,contact,contact===paused?'pause':'run',contact===paused?1:0]);
   await f.client.query("INSERT INTO memory_processing_round(id,scope_id,owner_id,contact_id,round_number,control_generation,status,phase) VALUES($1,$2,$3,$4,1,0,'waiting','verification')",[round,scope,owner,contact]);
   await f.client.query('UPDATE memory_processing_scope SET active_round_id=$1 WHERE id=$2',[round,scope]);
   await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'wechat_jsonl','synthetic-empty.jsonl',$4,0)",[source,owner,contact,'c'.repeat(64)]);
   await f.client.query("INSERT INTO background_task(id,owner_id,contact_id,source_document_id,task_type,status,current_step,message_count) VALUES($1,$2,$3,$4,'import','queued','index',0)",[task,owner,contact,source]);
   await f.client.query("INSERT INTO background_task_step(task_id,step_name,step_order,status) VALUES($1,'extract_memory',1,'succeeded'),($1,'index',2,'pending'),($1,'verify',3,'pending')",[task]);
   await f.client.query('INSERT INTO memory_processing_round_task(round_id,task_id,owner_id,contact_id) VALUES($1,$2,$3,$4)',[round,task,owner,contact]);
  }
 });
 const root=contact=>`/api/contacts/${contact}/memory-processing`;
 const history=async contact=>(await host.request(`${root(contact)}/state`)).data.history.entries;
 await until(async()=>(await history(other)).find(row=>row.task_id===tasks.get(other)&&row.status==='succeeded'));
 assert.equal((await history(paused)).find(row=>row.task_id===tasks.get(paused)).status,'queued');
 const state=(await host.request(`${root(paused)}/state`)).data;
 assert.equal(state.current.status,'paused');assert.deepEqual(state.current.actions,['continue']);
 const op={action_version:1,operation_id:randomUUID()};
 const concurrent=await Promise.all([1,2].map(()=>host.request(`${root(paused)}/continue`,{method:'POST',body:op})));
 assert.ok(concurrent.every(response=>response.status===200));
 assert.equal(concurrent.filter(response=>response.data.replayed).length,1);
 await until(async()=>(await history(paused)).find(row=>row.task_id===tasks.get(paused)&&row.status==='succeeded'));
 const completed=await history(paused);
 assert.equal(completed.length,1);assert.equal(completed[0].task_id,tasks.get(paused));
 assert.equal((await host.request('/api/ledger/summary')).data.total_attempts,0);
});

test('可信当前轮次的安全受阻直接提供继续，不要求先暂停且不重做成功提取',{timeout:60000},async t=>{
 const contact=randomUUID(),source=randomUUID(),task=randomUUID(),scope=randomUUID(),round=randomUUID();
 const host=await lifecycleHost(t,async(f,owner)=>{
  await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成安全受阻')",[contact,owner]);
  await f.client.query('INSERT INTO memory_processing_scope(id,owner_id,contact_id) VALUES($1,$2,$3)',[scope,owner,contact]);
  await f.client.query("INSERT INTO memory_processing_round(id,scope_id,owner_id,contact_id,round_number,control_generation,status,phase) VALUES($1,$2,$3,$4,1,0,'blocked','verification')",[round,scope,owner,contact]);
  await f.client.query('UPDATE memory_processing_scope SET active_round_id=$1 WHERE id=$2',[round,scope]);
  await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'wechat_jsonl','synthetic-recoverable.jsonl',$4,0)",[source,owner,contact,'d'.repeat(64)]);
  await f.client.query("INSERT INTO background_task(id,owner_id,contact_id,source_document_id,task_type,status,current_step,message_count,last_error_code) VALUES($1,$2,$3,$4,'import','failed','index',0,'lease_expired')",[task,owner,contact,source]);
  await f.client.query("INSERT INTO background_task_step(task_id,step_name,step_order,status,attempt_count,last_error_code) VALUES($1,'extract_memory',1,'succeeded',1,NULL),($1,'index',2,'failed',1,'lease_expired'),($1,'verify',3,'pending',0,NULL)",[task]);
  await f.client.query('INSERT INTO memory_processing_round_task(round_id,task_id,owner_id,contact_id) VALUES($1,$2,$3,$4)',[round,task,owner,contact]);
 });
 const root=`/api/contacts/${contact}/memory-processing`;
 const state=(await host.request(`${root}/state`)).data;
 assert.equal(state.current.status,'blocked');assert.ok(state.current.actions.includes('continue'));
 const continued=await host.request(`${root}/continue`,{method:'POST',body:{action_version:0,operation_id:randomUUID()}});
 assert.equal(continued.status,200);
 await until(async()=>(await host.request(`${root}/state`)).data.history.entries.find(row=>row.task_id===task&&row.status==='succeeded'));
 assert.equal((await host.request('/api/ledger/summary')).data.total_attempts,0);
});

test('同范围独立Skill与回复未决回执不阻止记忆继续，也不清除独立回执',{timeout:60000},async t=>{
 const contact=randomUUID(),skill=randomUUID();
 const host=await lifecycleHost(t,async(f,owner)=>{
  await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成独立用途')",[contact,owner]);
  await f.client.query("INSERT INTO memory_processing_scope(owner_id,contact_id,intent,control_generation) VALUES($1,$2,'pause',1)",[owner,contact]);
  await f.client.query("INSERT INTO background_task(id,owner_id,contact_id,task_type,status,current_step,message_count) VALUES($1,$2,$3,'skill_learning','failed','propose_skill',0)",[skill,owner,contact]);
  for(const outcome of ['pending','unknown'])await f.client.query(`INSERT INTO model_call_receipt(attempt_id,owner_id,contact_id,request_id,permit_id,provider,model_name,called_at,dispatch,outcome,cost_status)
   VALUES($1,$2,$3,$4,$5,'deepseek','synthetic',now(),'authorized_unconfirmed',$6,'unknown')`,[randomUUID(),owner,contact,outcome==='pending'?modelTaskRequestId('skill_learning',skill,'a'.repeat(64)):randomUUID(),randomUUID(),outcome]);
 });
 const root=`/api/contacts/${contact}/memory-processing`;
 const paused=(await host.request(`${root}/state`)).data;
 assert.equal(paused.current.status,'paused');assert.deepEqual(paused.current.actions,['continue']);
 assert.equal((await host.request(`${root}/continue`,{method:'POST',body:{action_version:1,operation_id:randomUUID()}})).status,200);
 const usage=(await host.request('/api/ledger/summary')).data;
 assert.equal(usage.total_attempts,2);assert.deepEqual(usage.recent.map(row=>row.outcome).sort(),['pending','unknown']);
});

// 合成已成功批次的最小元数据；只验证原回执的确定性收尾，不冒充主题或画像质量验收。
test('额度耗尽仍允许成功回执的无模型收尾，未完成画像继续保留预算门禁',{timeout:60000},async t=>{
 const ids=['succeeded','pending'].map(profile=>({profile,contact:randomUUID(),scope:randomUUID(),round:randomUUID(),task:randomUUID(),batch:randomUUID(),memory:randomUUID()}));
 const host=await lifecycleHost(t,async(f,owner)=>{
  for(const x of ids){
   await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成收尾')",[x.contact,owner]);
   await f.client.query("INSERT INTO memory_processing_scope(id,owner_id,contact_id,intent,control_generation) VALUES($1,$2,$3,'pause',1)",[x.scope,owner,x.contact]);
   await f.client.query("INSERT INTO memory_processing_round(id,scope_id,owner_id,contact_id,round_number,control_generation,status,phase) VALUES($1,$2,$3,$4,1,0,'waiting','topics')",[x.round,x.scope,owner,x.contact]);
   await f.client.query('UPDATE memory_processing_scope SET active_round_id=$1 WHERE id=$2',[x.round,x.scope]);
   await f.client.query("INSERT INTO background_task(id,owner_id,contact_id,task_type,status,current_step,message_count) VALUES($1,$2,$3,'layered_memory','queued','organize_memory',1)",[x.task,owner,x.contact]);
   await f.client.query("INSERT INTO background_task_step(task_id,step_name,step_order,status,total_count) VALUES($1,'organize_memory',1,'pending',1)",[x.task]);
   await f.client.query('INSERT INTO memory_processing_round_task(round_id,task_id,owner_id,contact_id) VALUES($1,$2,$3,$4)',[x.round,x.task,owner,x.contact]);
   await f.client.query("INSERT INTO layered_memory_state(owner_id,contact_id,enabled,status,covered_count) VALUES($1,$2,true,'ready',1)",[owner,x.contact]);
   await f.client.query("INSERT INTO layered_memory_generation(owner_id,contact_id,organization_generation,schema_version,scenario_version_ids) VALUES($1,$2,0,2,'{}')",[owner,x.contact]);
   const manifest=JSON.stringify([{memory_id:x.memory,revision:1}]);
   await f.client.query("INSERT INTO layered_memory_job(task_id,owner_id,contact_id,settings_generation,target_key,contract,target_manifest,dependency_ids,state,run_remaining,pending_receipt,model_calls_used,model_call_limit,profile_required,profile_status,receipt_lease_generation) VALUES($1,$2,$3,0,$4,'document-tools-v1:profile-tools-v1',$5,'{}','active',1,true,$6,2,true,$7,1)",[x.task,owner,x.contact,randomUUID(),manifest,2,x.profile]);
   await f.client.query("INSERT INTO layered_memory_batch(id,owner_id,contact_id,settings_generation,work_key,status,input_manifest,input_payload,dependency_ids,created_at,task_id) VALUES($1,$2,$3,0,$4,'succeeded',$5,'{}','{}',now(),$6)",[x.batch,owner,x.contact,randomUUID(),manifest,x.task]);
   await f.client.query('UPDATE layered_memory_job SET receipt_batch_id=$2 WHERE task_id=$1',[x.task,x.batch]);
  }
 });
 const [finished,needsProfile]=ids,root=x=>`/api/contacts/${x.contact}/memory-processing`;
 const layered=async x=>(await host.request(`/api/contacts/${x.contact}/layered-memory`)).data.layered_memory;
 const before=await layered(finished);
 const state=(await host.request(`${root(finished)}/state`)).data;
 assert.deepEqual(state.current.actions,['continue']);
 assert.equal((await host.request(`${root(finished)}/continue`,{method:'POST',body:{action_version:1,operation_id:randomUUID()}})).status,200);
 const task=await until(async()=>(await host.request(`${root(finished)}/state`)).data.history.entries.find(row=>row.task_id===finished.task&&row.status==='succeeded'));
 assert.equal(task.task_id,finished.task);
 const after=await layered(finished);
 for(const field of ['work_id','work_revision','current_batch','model_calls_used','model_call_limit','organization_generation','covered_count'])assert.equal(after[field],before[field],field);
 assert.equal(after.model_calls_used,2);assert.equal(after.model_call_limit,2);
 const blocked=(await host.request(`${root(needsProfile)}/state`)).data;
 assert.deepEqual(blocked.current.actions,[]);
 assert.equal((await host.request(`${root(needsProfile)}/continue`,{method:'POST',body:{action_version:1,operation_id:randomUUID()}})).status,409);
 assert.equal((await host.request('/api/ledger/summary')).data.total_attempts,0);
});
