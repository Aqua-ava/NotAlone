import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import pg from 'pg';
import {lifecycleHost} from './memory-lifecycle-host-support.mjs';
import {createExtractionPolicyVersion} from '../src/memory/extraction/policy-version.ts';
import {ExtractionTaskStore} from '../src/memory/extraction/tasks/store.ts';
import {sendSyntheticTool,untilLifecycle} from './memory-lifecycle-round-support.mjs';

async function legacyImport(fixture,owner,{status='queued',withPlan=true,withTargets=true}={}){
  const contact=randomUUID(),source=randomUUID(),message=randomUUID(),task=randomUUID();
  const policy=(await createExtractionPolicyVersion()).newTaskConfig();
  await fixture.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成存量导入')",[contact,owner]);
  await fixture.client.query(`INSERT INTO source_document
    (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
    VALUES($1,$2,$3,'manual','synthetic-legacy.jsonl',$4,1)`,[source,owner,contact,'a'.repeat(64)]);
  await fixture.client.query(`INSERT INTO import_confirmation
    (id,owner_id,contact_id,source_document_id,method)
    VALUES($1,$2,$3,$4,'manual_create')`,[randomUUID(),owner,contact,source]);
  await fixture.client.query(`INSERT INTO message
    (id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
    VALUES($1,$2,$3,'contact','text','存量合成聊天资料。','2026-10-20T01:00:00Z')`,
  [message,owner,contact]);
  await fixture.client.query(`INSERT INTO message_source_ref
    (message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
    VALUES($1,$2,$3,'source_document',$4,'synthetic:legacy',$5)`,
  [message,owner,contact,source,{synthetic:true,time_iso:'2026-10-20T01:00:00Z'}]);
  await fixture.client.query(`INSERT INTO background_task
    (id,owner_id,contact_id,source_document_id,task_type,status,current_step,message_count,extraction_runtime_config)
    VALUES($1,$2,$3,$4,'import',$5,'extract_memory',1,$6)`,
  [task,owner,contact,source,status,policy]);
  await fixture.client.query(`INSERT INTO background_task_step
    (task_id,step_name,step_order,status,total_count)
    VALUES($1,'parse',1,'succeeded',1),($1,'normalize',2,'succeeded',1),
      ($1,'extract_memory',3,'pending',1),($1,'index',4,'pending',1),($1,'verify',5,'pending',1)`,
  [task]);
  if(withPlan) await fixture.client.query(
    'INSERT INTO memory_processing_plan(task_id,owner_id,contact_id) VALUES($1,$2,$3)',
    [task,owner,contact],
  );
  if(withTargets) await fixture.client.query(`INSERT INTO memory_processing_target
    (task_id,message_id,owner_id,contact_id)
    VALUES($1,$2,$3,$4)`,[task,message,owner,contact]);
  return {contact,source,message,task};
}

async function legacyObservationTask(fixture,owner,contact){
  const task=randomUUID();
  await fixture.client.query(`INSERT INTO background_task
    (id,owner_id,contact_id,task_type,status,current_step,message_count)
    VALUES($1,$2,$3,'observation','queued','extract_memory',0)`,[task,owner,contact]);
  await fixture.client.query(`INSERT INTO background_task_step(task_id,step_name,step_order,status)
    VALUES($1,'extract_memory',1,'pending'),($1,'index',2,'pending'),($1,'verify',3,'pending')`,[task]);
  return task;
}

async function seedObservationInput(fixture,owner,contactId,{localId,text}){
  const binding=randomUUID(),observation=randomUUID(),message=randomUUID();
  await fixture.client.query(`INSERT INTO conversation_binding
    (id,owner_id,contact_id,channel,account_scope,conversation_locator,status)
    VALUES($1,$2,$3,'wechat','synthetic-restart',$4,'active')`,
  [binding,owner,contactId,`synthetic-${observation}`]);
  await fixture.client.query(`INSERT INTO local_wechat_observation
    (id,owner_id,contact_id,binding_id,mode,cli_version,conversation_locator,
     last_local_id,last_cursor,record_count,event_count,memory_enqueued_at)
    VALUES($1,$2,$3,$4,'live','synthetic',$5,$6,$7,1,1,now())`,
  [observation,owner,contactId,binding,`synthetic-${observation}`,localId,String(localId)]);
  await fixture.client.query(`INSERT INTO message
    (id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
    VALUES($1,$2,$3,'contact','text',$4,now())`,[message,owner,contactId,text]);
  await fixture.client.query(`INSERT INTO message_source_ref
    (message_id,owner_id,contact_id,source_kind,observation_id,source_locator,raw_payload)
    VALUES($1,$2,$3,'local_wechat_observation',$4,$5,$6)`,
  [message,owner,contactId,observation,`synthetic:restart:${localId}`,{synthetic:true,local_id:localId}]);
  return {binding,observation,message};
}

async function queuedObservationTask(fixture,owner,contactId,message){
  const task=randomUUID();
  await fixture.client.query(`INSERT INTO background_task
    (id,owner_id,contact_id,task_type,status,current_step,message_count)
    VALUES($1,$2,$3,'observation','queued','extract_memory',1)`,[task,owner,contactId]);
  await fixture.client.query(`INSERT INTO background_task_step
    (task_id,step_name,step_order,status,total_count)
    VALUES($1,'extract_memory',1,'pending',1),($1,'index',2,'pending',1),($1,'verify',3,'pending',1)`,[task]);
  await fixture.client.query('INSERT INTO memory_processing_plan(task_id,owner_id,contact_id) VALUES($1,$2,$3)',
    [task,owner,contactId]);
  await fixture.client.query(`INSERT INTO memory_processing_target(task_id,message_id,owner_id,contact_id)
    VALUES($1,$2,$3,$4)`,[task,message,owner,contactId]);
  return task;
}

test('可信存量导入接入统一轮次，默认不执行并在显式继续后完成',{timeout:60000},async t=>{
  let calls=0,legacy;
  const provider=createServer(async(req,res)=>{
    calls++;
    let raw='';for await(const chunk of req)raw+=chunk;
    const input=JSON.parse(raw);
    sendSyntheticTool(res,input.tools[0].name,{scenes:[]});
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(async()=>{provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));});
  const host=await lifecycleHost(t,async(f,owner)=>{legacy=await legacyImport(f,owner);},
    {providerUrl:`http://127.0.0.1:${provider.address().port}`});
  const root=`/api/contacts/${legacy.contact}/memory-processing`;

  const initial=(await host.request(`${root}/state`)).data;
  assert.equal(initial.current.status,'blocked');
  assert.match(initial.current.reason,/旧处理|存量|继续/);
  assert.deepEqual(initial.current.actions,['pause','continue'],JSON.stringify(initial));
  assert.ok(initial.current.round_id);
  assert.equal(initial.history.entries.find(task=>task.task_id===legacy.task)?.attribution,'verified');
  assert.equal(calls,0);
  const adopted=(await host.client.query(`SELECT task_id,round_id,decision,evidence_code,resume_required
    FROM memory_processing_legacy_adoption WHERE task_id=$1`,[legacy.task])).rows[0];
  assert.deepEqual(adopted,{task_id:legacy.task,round_id:initial.current.round_id,
    decision:'adopted',evidence_code:'import_confirmed',resume_required:true});
  assert.equal((await host.request(`/api/tasks/recover`,{method:'POST',body:{
    contact_id:legacy.contact,task_id:legacy.task,action:'resume',
  }})).status,409);
  assert.equal(calls,0);

  const continued=await host.request(`${root}/continue`,{method:'POST',body:{
    action_version:initial.action_version,operation_id:randomUUID(),
  }});
  assert.equal(continued.status,200,JSON.stringify(continued.data));
  await untilLifecycle(async()=>(await host.request(`${root}/state`)).data.current.status==='completed',15000);
  assert.equal(calls,1);
  assert.deepEqual((await host.client.query(`SELECT resume_required,resumed_at IS NOT NULL AS resumed
    FROM memory_processing_legacy_adoption WHERE task_id=$1`,[legacy.task])).rows[0],{resume_required:false,resumed:true});
  assert.equal((await host.request(`${root}/state`)).data.history.entries[0].attribution,'verified');

  assert.equal((await host.request(`/api/contacts/${legacy.contact}/memory-processing`)).status,404);
  assert.equal((await host.request(`/api/contacts/${legacy.contact}/memory-processing/resume`,{
    method:'POST',body:{task_id:legacy.task,action:'resume'},
  })).status,404);
  assert.equal((await host.request('/api/owner/memory-processing')).status,404);
});

test('可信存量观察接入原任务并在显式继续后完成',{timeout:60000},async t=>{
  let calls=0,seed;
  const provider=createServer(async(req,res)=>{
    calls++;
    let raw='';for await(const chunk of req)raw+=chunk;
    const input=JSON.parse(raw);
    sendSyntheticTool(res,input.tools[0].name,{scenes:[]});
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(async()=>{provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));});
  const host=await lifecycleHost(t,async(f,owner)=>{
    const contact=randomUUID();
    await f.client.query(
      "INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成存量观察')",
      [contact,owner],
    );
    const input=await seedObservationInput(f,owner,contact,{
      localId:31,text:'存量合成观察：今天一起去散步。',
    });
    const task=await queuedObservationTask(f,owner,contact,input.message);
    seed={contact,input,task};
  },{providerUrl:`http://127.0.0.1:${provider.address().port}`});
  const root=`/api/contacts/${seed.contact}/memory-processing`;
  const initial=(await host.request(`${root}/state`)).data;
  assert.equal(initial.current.status,'blocked');
  assert.deepEqual(initial.current.actions,['pause','continue']);
  assert.deepEqual((await host.client.query(`SELECT task_id,decision,evidence_code,resume_required
    FROM memory_processing_legacy_adoption WHERE task_id=$1`,[seed.task])).rows,
  [{task_id:seed.task,decision:'adopted',evidence_code:'observation_binding',resume_required:true}]);
  assert.equal(calls,0);

  assert.equal((await host.request(`${root}/continue`,{method:'POST',body:{
    action_version:initial.action_version,operation_id:randomUUID(),
  }})).status,200);
  await untilLifecycle(async()=>(await host.request(
    `${root}/state`,
  )).data.current.status==='completed',15000);
  assert.equal(calls,1);
  assert.equal((await host.client.query(
    'SELECT status FROM background_task WHERE id=$1',[seed.task],
  )).rows[0].status,'succeeded');
});

test('歧义或无计划存量保持阻塞且不执行，旧停止只保留历史',{timeout:60000},async t=>{
  let calls=0,ambiguous,withoutPlan,emptyPlan,stopped;
  const provider=createServer(async(req,res)=>{calls++;res.writeHead(500);res.end('{}');});
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(async()=>{provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));});
  const host=await lifecycleHost(t,async(f,owner)=>{
    ambiguous=await legacyImport(f,owner);
    await legacyObservationTask(f,owner,ambiguous.contact);
    withoutPlan=await legacyImport(f,owner,{withPlan:false,withTargets:false});
    emptyPlan=await legacyImport(f,owner,{withTargets:false});
    const contact=randomUUID(),task=randomUUID();
    await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成旧停止')",[contact,owner]);
    await f.client.query(`INSERT INTO background_task
      (id,owner_id,contact_id,task_type,status,current_step,message_count,last_error_code)
      VALUES($1,$2,$3,'observation','cancelled','extract_memory',0,'task_stopped')`,[task,owner,contact]);
    await f.client.query(`INSERT INTO background_task_step(task_id,step_name,step_order,status,last_error_code)
      VALUES($1,'extract_memory',1,'cancelled','task_stopped')`,[task]);
    stopped={contact,task};
  },{providerUrl:`http://127.0.0.1:${provider.address().port}`});

  const blocked=(await host.request(`/api/contacts/${ambiguous.contact}/memory-processing/state`)).data;
  assert.equal(blocked.current.status,'blocked');
  assert.deepEqual(blocked.current.actions,[]);
  assert.match(blocked.current.reason,/旧处理|归属|核对/);
  assert.ok(blocked.history.entries.every(task=>task.attribution==='legacy'));
  const unresolved=(await host.client.query(`SELECT decision,evidence_code,resume_required
    FROM memory_processing_legacy_adoption adoption
    JOIN memory_processing_scope scope ON scope.id=adoption.scope_id
    WHERE scope.owner_id=$1 AND scope.contact_id=$2`,[host.owner,ambiguous.contact])).rows[0];
  assert.deepEqual(unresolved,{decision:'unresolved',evidence_code:'ambiguous_incomplete_tasks',resume_required:false});
  assert.deepEqual((await host.client.query(`SELECT count(*)::int AS total,
    count(*) FILTER (WHERE membership.active)::int AS active
    FROM memory_processing_round_task membership
    JOIN memory_processing_scope scope ON scope.id=(SELECT scope_id FROM memory_processing_round WHERE id=membership.round_id)
    WHERE scope.owner_id=$1 AND scope.contact_id=$2`,[host.owner,ambiguous.contact])).rows[0],
  {total:2,active:0});
  for (const legacy of [withoutPlan,emptyPlan]) {
    const state=(await host.request(
      `/api/contacts/${legacy.contact}/memory-processing/state`,
    )).data;
    assert.equal(state.current.status,'blocked');
    assert.deepEqual(state.current.actions,[]);
    assert.match(state.current.reason,/旧处理|归属|核对/);
    assert.deepEqual((await host.client.query(`SELECT decision,evidence_code
      FROM memory_processing_legacy_adoption adoption
      JOIN memory_processing_scope scope ON scope.id=adoption.scope_id
      WHERE scope.owner_id=$1 AND scope.contact_id=$2`,[host.owner,legacy.contact])).rows,
    [{decision:'unresolved',evidence_code:'legacy_evidence_unavailable'}]);
  }
  assert.equal(calls,0);

  const stoppedState=(await host.request(`/api/contacts/${stopped.contact}/memory-processing/state`)).data;
  assert.equal(stoppedState.current.status,'waiting');
  assert.deepEqual(stoppedState.current.actions,['pause']);
  assert.equal(stoppedState.current.round_id,null);
  assert.equal(stoppedState.history.entries[0].task_id,stopped.task);
  assert.equal(stoppedState.history.entries[0].attribution,'legacy');
  assert.equal((await host.client.query(`SELECT count(*)::int AS n FROM memory_processing_scope
    WHERE owner_id=$1 AND contact_id=$2`,[host.owner,stopped.contact])).rows[0].n,0);
});

test('无法核验归属的存量隔离后，新到达的增量观察仍自动提取',{timeout:60000},async t=>{
 let calls=0,legacy,later,held,startedResolve;
 const started=new Promise(resolve=>{startedResolve=resolve;});
 const provider=createServer(async(req,res)=>{
  calls++;
  let raw='';for await(const chunk of req)raw+=chunk;
  const input=JSON.parse(raw);
  if(raw.includes('隔离旧归属后到达的合成增量聊天')&&held===undefined){
   held={res,input};startedResolve();return;
  }
  sendSyntheticTool(res,input.tools[0].name,{scenes:[]});
 });
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 t.after(async()=>{provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));});
 const host=await lifecycleHost(t,async(f,owner)=>{
  legacy=await legacyImport(f,owner);
  await legacyObservationTask(f,owner,legacy.contact);
  later=await seedObservationInput(f,owner,legacy.contact,{
   localId:51,text:'隔离旧归属后到达的合成增量聊天。',
  });
  const pool=new pg.Pool({host:'/tmp',database:f.client.database,max:2});
  try{
   const store=new ExtractionTaskStore(pool),scope={ownerId:owner,contactId:legacy.contact};
   await store.transaction(scope,client=>store.recordObservation(
    client,scope,later.observation,[later.message],
   ));
  }finally{await pool.end();}
 },{providerUrl:`http://127.0.0.1:${provider.address().port}`});
 const root=`/api/contacts/${legacy.contact}/memory-processing`;
 await Promise.race([started,new Promise((_,reject)=>setTimeout(
  ()=>reject(new Error('新观察未进入独立增量轮次')),15000,
 ))]);
 const active=(await host.request(`${root}/state`)).data;
 assert.equal(active.current.status,'processing');
 assert.notEqual(active.current.round_id,null);
 assert.equal(active.current.total_count,1);
 sendSyntheticTool(held.res,held.input.tools[0].name,{scenes:[]});
 const completed=await untilLifecycle(async()=>{
  const next=(await host.request(`${root}/state`)).data;
  return next.current.status==='completed'?next:null;
 },15000);
 const rounds=(await host.client.query(`SELECT id,round_number,status,target_count
  FROM memory_processing_round WHERE scope_id=(
   SELECT id FROM memory_processing_scope WHERE owner_id=$1 AND contact_id=$2
  ) ORDER BY round_number`,[host.owner,legacy.contact])).rows;
 assert.equal(rounds.length,2);
 assert.deepEqual(rounds.map(round=>round.status),['blocked','completed']);
 assert.equal(completed.current.round_id,rounds[1].id);
 assert.equal(completed.current.total_count,1);
 assert.equal(completed.current.pending_count,0);
 assert.equal(calls,1);
 assert.equal((await host.client.query(
  'SELECT decision FROM memory_processing_legacy_adoption WHERE owner_id=$1 AND contact_id=$2',
  [host.owner,legacy.contact],
 )).rows[0].decision,'unresolved');
 const currentTask=(await host.client.query(`SELECT task_id
  FROM memory_processing_round_task WHERE round_id=$1 AND active`,[rounds[1].id])).rows[0].task_id;
 assert.ok(currentTask);
 assert.equal((await host.client.query(
  'SELECT task_id FROM memory_extraction_receipt WHERE message_id=$1',[later.message],
 )).rows[0].task_id,currentTask);
});

test('零目标或旧暂停L2/L3保持不执行，可信本人整理只待显式继续',{timeout:60000},async t=>{
  const zeroContact=randomUUID(),zeroTask=randomUUID(),pausedContact=randomUUID(),pausedTask=randomUUID(),ownerTask=randomUUID();
  const host=await lifecycleHost(t,async(f,owner)=>{
    await f.client.query(`INSERT INTO contact(id,owner_id,display_name)
      VALUES($1,$3,'合成零目标整理'),($2,$3,'合成旧暂停整理')`,
    [zeroContact,pausedContact,owner]);
    for (const [task,contact,manifest,jobState] of [
      [zeroTask,zeroContact,[],'active'],
      [pausedTask,pausedContact,[randomUUID()],'paused'],
      [ownerTask,null,[randomUUID()],'active'],
    ]) {
      await f.client.query(`INSERT INTO background_task
        (id,owner_id,contact_id,task_type,status,current_step,message_count,last_error_code,finished_at)
        VALUES($1,$2,$3,'layered_memory','failed','organize_memory',0,'lease_expired',now())`,
      [task,owner,contact]);
      await f.client.query(`INSERT INTO background_task_step
        (task_id,step_name,step_order,status,attempt_count,last_error_code,finished_at)
        VALUES($1,'organize_memory',1,'failed',1,'lease_expired',now())`,
      [task]);
      await f.client.query(`INSERT INTO layered_memory_state
        (owner_id,contact_id,enabled,settings_generation,status)
        VALUES($1,$2,true,1,'blocked')`,[owner,contact]);
      await f.client.query(`INSERT INTO layered_memory_job
        (task_id,owner_id,contact_id,settings_generation,target_key,contract,target_manifest,
         dependency_ids,state,run_remaining,model_calls_used,model_call_limit)
        VALUES($1,$2,$3,1,$4,'synthetic',$5::jsonb,'{}',$6,1,0,4)`,
      [task,owner,contact,`synthetic:${task}`,JSON.stringify(manifest),jobState]);
    }
  });

  for (const [contact,reason] of [
    [zeroContact,'legacy_evidence_unavailable'],
    [pausedContact,'legacy_evidence_unavailable'],
  ]) {
    const zero=(await host.request(
      `/api/contacts/${contact}/memory-processing/state`,
    )).data;
    assert.equal(zero.current.status,'blocked');
    assert.deepEqual(zero.current.actions,[]);
    assert.deepEqual((await host.client.query(`SELECT decision,reason_code
      FROM memory_processing_legacy_adoption adoption
      JOIN memory_processing_scope scope ON scope.id=adoption.scope_id
      WHERE scope.owner_id=$1 AND scope.contact_id=$2`,[host.owner,contact])).rows,
    [{decision:'unresolved',reason_code:reason}]);
  }

  const owner=(await host.request('/api/owner/memory-processing/state')).data;
  assert.equal(owner.current.status,'blocked');
  assert.deepEqual(owner.current.actions,['pause','continue']);
  assert.deepEqual((await host.client.query(`SELECT adoption.decision,adoption.evidence_code,
    adoption.resume_required,scope.contact_id,round.target_count
    FROM memory_processing_legacy_adoption adoption
    JOIN memory_processing_scope scope ON scope.id=adoption.scope_id
    JOIN memory_processing_round round ON round.id=adoption.round_id
    WHERE adoption.task_id=$1`,[ownerTask])).rows,
  [{decision:'adopted',evidence_code:'layered_job',resume_required:true,
    contact_id:null,target_count:'1'}]);
  assert.equal((await host.client.query(
    'SELECT status FROM background_task WHERE id=$1',[ownerTask],
  )).rows[0].status,'failed','启动只接入管理身份，不自动执行本人整理');
});

test('重启恢复当前轮后自动衔接运行中形成的后续资料',{timeout:90000},async t=>{
  const provider=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const input=JSON.parse(raw);
    sendSyntheticTool(res,input.tools[0].name,{scenes:[]});
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(async()=>{provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));});
  let seed;
  const host=await lifecycleHost(t,async(f,owner)=>{
    const contact=randomUUID(),source=randomUUID(),scope=randomUUID(),round=randomUUID(),task=randomUUID(),message=randomUUID();
    const policy=(await createExtractionPolicyVersion()).newTaskConfig();
    await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成重启接续')",[contact,owner]);
    await f.client.query(`INSERT INTO source_document
      (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
      VALUES($1,$2,$3,'wechat_jsonl','synthetic-restart.jsonl',$4,1)`,[source,owner,contact,'b'.repeat(64)]);
    await f.client.query(`INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
      VALUES($1,$2,$3,'contact','text','重启当前轮合成资料。','2026-10-20T01:00:00Z')`,[message,owner,contact]);
    await f.client.query(`INSERT INTO message_source_ref
      (message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
      VALUES($1,$2,$3,'source_document',$4,'synthetic:restart:first',$5)`,
    [message,owner,contact,source,{synthetic:true,time_iso:'2026-10-20T01:00:00Z'}]);
    await f.client.query('INSERT INTO memory_processing_scope(id,owner_id,contact_id) VALUES($1,$2,$3)',[scope,owner,contact]);
    await f.client.query(`INSERT INTO memory_processing_round
      (id,scope_id,owner_id,contact_id,round_number,control_generation,status,phase,target_unit,target_count)
      VALUES($1,$2,$3,$4,1,0,'blocked','extraction','messages',1)`,[round,scope,owner,contact]);
    await f.client.query('UPDATE memory_processing_scope SET active_round_id=$1 WHERE id=$2',[round,scope]);
    await f.client.query(`INSERT INTO background_task
      (id,owner_id,contact_id,source_document_id,task_type,status,current_step,message_count,
       last_error_code,finished_at,extraction_runtime_config)
      VALUES($1,$2,$3,$4,'import','failed','extract_memory',1,'lease_expired',now(),$5)`,
    [task,owner,contact,source,policy]);
    await f.client.query(`INSERT INTO background_task_step(task_id,step_name,step_order,status,total_count)
      VALUES($1,'parse',1,'succeeded',1),($1,'normalize',2,'succeeded',1),
        ($1,'extract_memory',3,'failed',1),($1,'index',4,'pending',1),($1,'verify',5,'pending',1)`,[task]);
    await f.client.query('INSERT INTO memory_processing_plan(task_id,owner_id,contact_id) VALUES($1,$2,$3)',[task,owner,contact]);
    await f.client.query(`INSERT INTO memory_processing_target(task_id,message_id,owner_id,contact_id)
      VALUES($1,$2,$3,$4)`,[task,message,owner,contact]);
    await f.client.query('INSERT INTO memory_processing_round_task(round_id,task_id,owner_id,contact_id) VALUES($1,$2,$3,$4)',
      [round,task,owner,contact]);
    await f.client.query(`INSERT INTO memory_processing_round_target(round_id,task_id,message_id)
      VALUES($1,$2,$3)`,[round,task,message]);
    const later=await seedObservationInput(f,owner,contact,{localId:41,text:'重启后自动衔接的合成资料。'});
    const laterTask=await queuedObservationTask(f,owner,contact,later.message);
    seed={contact,scope,round,task,later,laterTask};
  },{providerUrl:`http://127.0.0.1:${provider.address().port}`});
  const root=`/api/contacts/${seed.contact}/memory-processing`;
  let diagnostics;
  try {
    await untilLifecycle(async()=>{
      const rounds=(await host.client.query(`SELECT id,status,target_count FROM memory_processing_round
        WHERE scope_id=$1 ORDER BY round_number`,[seed.scope])).rows;
      const state=(await host.request(`${root}/state`)).data;
      diagnostics={rounds,state};
      return rounds.length===2&&rounds.every(round=>round.status==='completed')
        && state.current.status==='completed';
    },25000);
  } catch (error) {
    const tasks=(await host.client.query(`SELECT task.id,task.task_type,task.status,task.current_step,
      task.last_error_code,step.step_name,step.step_order,step.status AS step_status,
      step.attempt_count,step.last_error_code AS step_error
      FROM background_task task
      LEFT JOIN background_task_step step ON step.task_id=task.id
      WHERE task.owner_id=$1 AND task.contact_id=$2
      ORDER BY task.created_at,step.step_order`,[host.owner,seed.contact])).rows;
    const memberships=(await host.client.query(`SELECT round.round_number,round.status AS round_status,
      membership.task_id,membership.active
      FROM memory_processing_round round
      LEFT JOIN memory_processing_round_task membership ON membership.round_id=round.id
      WHERE round.scope_id=$1 ORDER BY round.round_number,membership.task_id`,[seed.scope])).rows;
    assert.fail(`${error.message}\n${JSON.stringify({diagnostics,tasks,memberships})}`);
  }
  const rounds=(await host.client.query(`SELECT id,round_number,status,target_count
    FROM memory_processing_round WHERE scope_id=$1 ORDER BY round_number`,[seed.scope])).rows;
  assert.deepEqual(rounds.map(round=>({round_number:round.round_number,status:round.status,target_count:round.target_count})),
    [{round_number:'1',status:'completed',target_count:'1'},{round_number:'2',status:'completed',target_count:'1'}]);
  assert.ok((await host.client.query(`SELECT 1 FROM memory_processing_round_target
    WHERE round_id=$1 AND message_id=$2`,[rounds[1].id,seed.later.message])).rowCount);
  assert.equal((await host.client.query(`SELECT task_id FROM memory_processing_round_task
    WHERE round_id=$1`,[rounds[1].id])).rows[0].task_id,seed.laterTask);
});
