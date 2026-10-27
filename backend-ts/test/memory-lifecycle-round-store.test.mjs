import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {managementFixture,completeManagementTask} from './layered-memory-management-fixture.mjs';
import {MemoryProcessingQuery} from '../src/memory/processing/query.ts';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {seedRoundInput} from './memory-lifecycle-round-support.mjs';
import {
 completeMemoryProcessingRoundIfReady,
 startNextMemoryProcessingRoundIfReady,
} from '../src/memory/processing/round.ts';
import {ExtractionTaskStore} from '../src/memory/extraction/tasks/store.ts';

async function addUnattachedLayeredTask(fixture,settingsGeneration){
 const task=randomUUID();
 await fixture.pool.query(`INSERT INTO background_task
  (id,owner_id,contact_id,task_type,status,current_step,message_count)
  VALUES($1,$2,$3,'layered_memory','queued','organize_memory',0)`,
 [task,fixture.ownerId,fixture.contactId]);
 await fixture.pool.query(`INSERT INTO background_task_step
  (task_id,step_name,step_order,status,total_count)
  VALUES($1,'organize_memory',1,'pending',0)`,[task]);
 await fixture.pool.query(`INSERT INTO layered_memory_job
  (task_id,owner_id,contact_id,settings_generation,target_key,contract,target_manifest,dependency_ids,
   state,run_remaining,model_call_limit,profile_required,profile_status)
  VALUES($1,$2,$3,$4,$5,'scenario-v3:document-tools-v1:profile-tools-v1','[]','{}',
   'active',1,8,false,'not_required')`,
 [task,fixture.ownerId,fixture.contactId,settingsGeneration,`synthetic:${task}`]);
 return task;
}

async function seedObservationInput(fixture,owner,contactId,{localId,text}){
 const binding=randomUUID(),observation=randomUUID(),message=randomUUID();
 await fixture.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成观察轮次') ON CONFLICT DO NOTHING",
  [contactId,owner]);
 await fixture.client.query(`INSERT INTO conversation_binding
  (id,owner_id,contact_id,channel,account_scope,conversation_locator,status)
  VALUES($1,$2,$3,'wechat','synthetic-observation',$4,'active')`,
 [binding,owner,contactId,`synthetic-${observation}`]);
 await fixture.client.query(`INSERT INTO local_wechat_observation
  (id,owner_id,contact_id,binding_id,mode,cli_version,conversation_locator,
   last_local_id,last_cursor,record_count,event_count)
  VALUES($1,$2,$3,$4,'live','synthetic',$5,$6,$7,1,1)`,
 [observation,owner,contactId,binding,`synthetic-${observation}`,localId,String(localId)]);
 await fixture.client.query(`INSERT INTO message
  (id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
  VALUES($1,$2,$3,'contact','text',$4,now())`,
 [message,owner,contactId,text]);
 await fixture.client.query(`INSERT INTO message_source_ref
  (message_id,owner_id,contact_id,source_kind,observation_id,source_locator,raw_payload)
  VALUES($1,$2,$3,'local_wechat_observation',$4,$5,$6)`,
 [message,owner,contactId,observation,`synthetic:observation:${localId}`,
  {synthetic:true,local_id:localId}]);
 return {binding,observation,message,contactId};
}

test('本人记忆工作独立接纳轮次并在主题与画像后完成可靠记忆计数',async t=>{
 const f=await managementFixture(t);
 const query=new MemoryProcessingQuery(f.pool,f.ownerId);
 const initial=await query.handle('GET',new URL('/api/owner/memory-processing/state','http://localhost'));
 assert.equal(initial.status,200);
 assert.equal(initial.body.current.status,'waiting');
 const enabled=await f.request('enable',{
  settings_generation:initial.body.action_version,
  purpose_confirmed:true,
 },null);
 assert.equal(enabled.status,200);
 const running=(await query.handle('GET',new URL('/api/owner/memory-processing/state','http://localhost'))).body;
 assert.equal(running.current.status,'waiting');
 assert.match(running.current.round_id,/^[a-f0-9-]{36}$/);
 assert.equal(running.current.total_count,1);
 assert.equal(running.current.unit,'memories');
 const completed=await completeManagementTask(f,enabled.body.layered_memory,{owner:true});
 assert.equal(completed.result.state.profile.entries.length,1);
 const done=(await query.handle('GET',new URL('/api/owner/memory-processing/state','http://localhost'))).body;
 assert.equal(done.current.status,'completed');
 assert.equal(done.current.round_id,running.current.round_id);
 assert.equal(done.current.processed_count,1);
 assert.equal(done.current.total_count,1);
 assert.equal(done.current.unit,'memories');
 assert.equal((await f.pool.query(
  'SELECT status FROM memory_processing_round WHERE id=$1',[running.current.round_id],
 )).rows[0].status,'completed');
});

test('任务成功但仍有关键消息目标未完成时整轮不得结束',async t=>{
 const fixture=await createStorageFixture();t.after(()=>fixture.close());
 const owner=(await fixture.client.query("INSERT INTO owner(id,display_name) VALUES(gen_random_uuid(),'合成本人') RETURNING id")).rows[0].id;
 const seed=await seedRoundInput(fixture,owner,{texts:['合成第一条。','合成第二条。']});
 await fixture.client.query("UPDATE background_task SET status='succeeded',last_error_code=NULL WHERE id=$1",[seed.task]);
 const scope={taskId:seed.task,ownerId:owner,contactId:seed.contactId};
 assert.equal(await completeMemoryProcessingRoundIfReady(fixture.client,scope),false);
 assert.equal((await fixture.client.query(
  'SELECT status FROM memory_processing_round WHERE id=$1',[seed.round],
 )).rows[0].status,'waiting');
 const receipt=await fixture.client.query("INSERT INTO memory_processing_receipt(message_id,owner_id,contact_id,outcome) VALUES($1,$2,$3,'succeeded') RETURNING completed_at",[seed.messages[0].id,owner,seed.contactId]);
 await fixture.client.query(`UPDATE memory_processing_target SET completed_at=$2::timestamptz,outcome='succeeded'
  WHERE task_id=$1 AND message_id=$3`,[seed.task,receipt.rows[0].completed_at,seed.messages[0].id]);
 assert.equal(await completeMemoryProcessingRoundIfReady(fixture.client,scope),false);
 const receipt2=await fixture.client.query("INSERT INTO memory_processing_receipt(message_id,owner_id,contact_id,outcome) VALUES($1,$2,$3,'succeeded') RETURNING completed_at",[seed.messages[1].id,owner,seed.contactId]);
 await fixture.client.query(`UPDATE memory_processing_target SET completed_at=$2::timestamptz,outcome='succeeded'
  WHERE task_id=$1 AND message_id=$3`,[seed.task,receipt2.rows[0].completed_at,seed.messages[1].id]);
 assert.equal(await completeMemoryProcessingRoundIfReady(fixture.client,scope),true);
});

test('同一观察任务后来追加的消息目标不进入已冻结轮次',async t=>{
 const fixture=await createStorageFixture();
 const pool=new pg.Pool({host:'/tmp',database:fixture.client.database,max:2});
 t.after(async()=>{await pool.end();await fixture.close();});
 const owner=(await fixture.client.query("INSERT INTO owner(id,display_name) VALUES(gen_random_uuid(),'合成本人') RETURNING id")).rows[0].id;
 const seed=await seedRoundInput(fixture,owner,{texts:['合成首条观察。'],verification:'legacy'});
 const store=new ExtractionTaskStore(pool),scope={ownerId:owner,contactId:seed.contactId};
 const claim=await store.claim(scope,{taskId:seed.task,workerId:randomUUID(),leaseMs:30_000,supportedSteps:['extract_memory']});
 assert.deepEqual((await store.targets(claim)).targetIds,[seed.messages[0].id]);
 const later=randomUUID();
 await fixture.client.query(`INSERT INTO message
  (id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
  VALUES($1,$2,$3,'contact','text','同一任务后来追加。',$4)`,
 [later,owner,seed.contactId,'2026-10-20T03:00:00Z']);
 await fixture.client.query(`INSERT INTO message_source_ref
  (message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
  VALUES($1,$2,$3,'source_document',$4,'synthetic:same-task-later',$5)`,
 [later,owner,seed.contactId,seed.source,{synthetic:true,time_iso:'2026-10-20T03:00:00Z'}]);
 await fixture.client.query(`INSERT INTO memory_processing_target(task_id,message_id,owner_id,contact_id)
  VALUES($1,$2,$3,$4)`,[seed.task,later,owner,seed.contactId]);
 assert.deepEqual((await store.targets(claim)).targetIds,[seed.messages[0].id]);
 assert.equal((await fixture.client.query(`SELECT count(*)::int AS n
  FROM memory_processing_round_target WHERE round_id=$1`,[seed.round])).rows[0].n,1);
});

test('同一观察任务的后续目标在旧轮完成后重新排队为下一轮',async t=>{
 const fixture=await createStorageFixture();
 const pool=new pg.Pool({host:'/tmp',database:fixture.client.database,max:2});
 t.after(async()=>{await pool.end();await fixture.close();});
 const owner=(await fixture.client.query("INSERT INTO owner(id,display_name) VALUES(gen_random_uuid(),'合成本人') RETURNING id")).rows[0].id;
 const first=await seedObservationInput(fixture,owner,randomUUID(),{
  localId:4,text:'同一任务首轮合成观察。',
 });
 const scope={ownerId:owner,contactId:first.contactId},store=new ExtractionTaskStore(pool);
 await store.transaction(scope,client=>store.recordObservation(client,scope,first.observation,[first.message]));
 const task=await store.enqueueObservation(scope,[first.message]);
 assert.ok(task);
 const claim=await store.claim(scope,{taskId:task,workerId:randomUUID(),leaseMs:30_000,supportedSteps:['extract_memory']});
 assert.ok(claim);
 assert.deepEqual((await store.targets(claim)).targetIds,[first.message]);
 const second=await seedObservationInput(fixture,owner,scope.contactId,{
  localId:5,text:'同一任务后续合成观察。',
 });
 await store.transaction(scope,client=>store.recordObservation(client,scope,second.observation,[second.message]));
 await fixture.client.query(`UPDATE memory_extraction_schedule SET threshold=1,due_at=now()
  WHERE owner_id=$1 AND contact_id=$2`,[owner,scope.contactId]);
 assert.equal(await store.enqueueObservation(scope,[second.message]),task);
 assert.equal((await fixture.client.query(`SELECT count(*)::int AS n FROM memory_processing_round_target
  WHERE round_id=(SELECT active_round_id FROM memory_processing_scope
   WHERE owner_id=$1 AND contact_id=$2) AND message_id=$3`,
 [owner,scope.contactId,second.message])).rows[0].n,0);
 await fixture.client.query(`UPDATE background_task_step SET status='succeeded',worker_id=NULL,
  lease_expires_at=NULL WHERE task_id=$1`,[task]);
 const completed=(await fixture.client.query(`INSERT INTO memory_processing_receipt
  (message_id,owner_id,contact_id,outcome) VALUES($1,$2,$3,'succeeded') RETURNING completed_at`,
 [first.message,owner,scope.contactId])).rows[0].completed_at;
 await fixture.client.query(`UPDATE memory_processing_target SET completed_at=$2,outcome='succeeded'
  WHERE task_id=$1 AND message_id=$3`,[task,completed,first.message]);
 await fixture.client.query("UPDATE background_task SET status='succeeded' WHERE id=$1",[task]);
 assert.equal(await completeMemoryProcessingRoundIfReady(fixture.client,{
  taskId:task,ownerId:owner,contactId:scope.contactId,
 }),true);
 const next=(await fixture.client.query(`SELECT round.id,round.round_number,round.status,
   round.target_count,task.status AS task_status,task.current_step,
   (SELECT count(*)::int FROM memory_processing_round_target snapshot
    WHERE snapshot.round_id=round.id AND snapshot.task_id=task.id
      AND snapshot.message_id=$3) AS frozen
  FROM memory_processing_scope control
  JOIN memory_processing_round round ON round.id=control.active_round_id
  JOIN memory_processing_round_task member ON member.round_id=round.id
    AND member.task_id=$1 AND member.active
  JOIN background_task task ON task.id=member.task_id
  WHERE control.owner_id=$2 AND control.contact_id=$4`,
 [task,owner,second.message,scope.contactId])).rows[0];
 assert.ok(next);
 assert.equal(next.round_number,'2');
 assert.equal(next.status,'waiting');
 assert.equal(next.target_count,'1');
 assert.equal(next.task_status,'queued');
 assert.equal(next.current_step,'extract_memory');
 assert.equal(next.frozen,1);
 assert.equal((await fixture.client.query(`SELECT count(*)::int AS n FROM background_task_step
  WHERE task_id=$1 AND status='pending'`,[task])).rows[0].n,3);
});

test('重叠来源中的同一消息只进入一个后续轮次快照',async t=>{
 const fixture=await createStorageFixture();
 t.after(()=>fixture.close());
 const owner=(await fixture.client.query("INSERT INTO owner(id,display_name) VALUES(gen_random_uuid(),'合成本人') RETURNING id")).rows[0].id;
 const first=await seedRoundInput(fixture,owner,{texts:['已完成的合成首轮。']});
 await fixture.client.query("UPDATE memory_processing_round SET status='completed' WHERE id=$1",[first.round]);
 const message=randomUUID(),taskIds=[];
 await fixture.client.query(`INSERT INTO message
  (id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
  VALUES($1,$2,$3,'contact','text','重叠来源中的同一条合成消息。',now())`,
 [message,owner,first.contactId]);
 for(const index of [1,2]){
  const source=randomUUID(),task=randomUUID();
  taskIds.push(task);
  await fixture.client.query(`INSERT INTO source_document
   (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
   VALUES($1,$2,$3,'wechat_jsonl',$4,$5,1)`,
  [source,owner,first.contactId,`synthetic-overlap-${index}.jsonl`,String(index).repeat(64)]);
  await fixture.client.query(`INSERT INTO message_source_ref
   (message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
   VALUES($1,$2,$3,'source_document',$4,$5,$6)`,
  [message,owner,first.contactId,source,`synthetic:overlap:${index}`,{synthetic:true,index}]);
  await fixture.client.query(`INSERT INTO background_task
   (id,owner_id,contact_id,source_document_id,task_type,status,current_step,message_count)
   VALUES($1,$2,$3,$4,'import','queued','parse',1)`,
  [task,owner,first.contactId,source]);
  await fixture.client.query('INSERT INTO memory_processing_plan(task_id,owner_id,contact_id) VALUES($1,$2,$3)',
   [task,owner,first.contactId]);
  await fixture.client.query('INSERT INTO memory_processing_target(task_id,message_id,owner_id,contact_id) VALUES($1,$2,$3,$4)',
   [task,message,owner,first.contactId]);
 }
 const next=await startNextMemoryProcessingRoundIfReady(fixture.client,{
  ownerId:owner,contactId:first.contactId,
 });
 assert.ok(next);
 assert.deepEqual((await fixture.client.query(`SELECT target_count,
   (SELECT count(*)::int FROM memory_processing_round_target snapshot
    WHERE snapshot.round_id=$1) AS frozen,
   (SELECT count(*)::int FROM memory_processing_round_target snapshot
    WHERE snapshot.round_id=$1 AND snapshot.message_id=$2) AS same_message
  FROM memory_processing_round WHERE id=$1`,[next.id,message])).rows[0],{
  target_count:'1',frozen:1,same_message:1,
 });
 assert.equal((await fixture.client.query(`SELECT count(*)::int AS n
  FROM memory_processing_round_task WHERE round_id=$1 AND active`,[next.id])).rows[0].n,1);
 assert.equal((await fixture.client.query(`SELECT count(*)::int AS n
  FROM background_task WHERE id=ANY($1::uuid[]) AND status='queued'`,[taskIds])).rows[0].n,2);
});

test('运行中通知进入后续等待，当前轮完成后并发重放只接纳一个后续轮次',async t=>{
 const fixture=await createStorageFixture();
 const pool=new pg.Pool({host:'/tmp',database:fixture.client.database,max:2});
 t.after(async()=>{await pool.end();await fixture.close();});
 const owner=(await fixture.client.query("INSERT INTO owner(id,display_name) VALUES(gen_random_uuid(),'合成本人') RETURNING id")).rows[0].id;
 const first=await seedRoundInput(fixture,owner,{texts:['当前轮合成资料。']});
 await fixture.client.query("UPDATE memory_processing_round SET status='processing' WHERE id=$1",[first.round]);
 const later=await seedObservationInput(fixture,owner,first.contactId,{
  localId:2,text:'运行中到达的合成观察。',
 });
 const scope={ownerId:owner,contactId:first.contactId},store=new ExtractionTaskStore(pool);
 await store.transaction(scope,client=>store.recordObservation(client,scope,later.observation,[later.message]));
 const waitingTask=await store.enqueueObservation(scope,[later.message]);
 assert.ok(waitingTask);
 assert.deepEqual((await fixture.client.query(`SELECT
   (SELECT count(*)::int FROM background_task WHERE contact_id=$1) AS tasks,
   (SELECT count(*)::int FROM memory_processing_target WHERE contact_id=$1) AS targets,
   (SELECT count(*)::int FROM memory_processing_round_target WHERE round_id=$2) AS frozen,
   (SELECT task_id FROM memory_extraction_receipt WHERE message_id=$3) AS receipt_task`,
  [first.contactId,first.round,later.message])).rows[0],{
   tasks:2,targets:2,frozen:1,receipt_task:waitingTask,
  });
 const completed=(await fixture.client.query(`INSERT INTO memory_processing_receipt
  (message_id,owner_id,contact_id,outcome) VALUES($1,$2,$3,'succeeded') RETURNING completed_at`,
 [first.messages[0].id,owner,first.contactId])).rows[0].completed_at;
 await fixture.client.query(`UPDATE memory_processing_target SET completed_at=$2,outcome='succeeded'
  WHERE task_id=$1`,[first.task,completed]);
 await fixture.client.query("UPDATE background_task SET status='succeeded' WHERE id=$1",[first.task]);
 assert.equal(await completeMemoryProcessingRoundIfReady(fixture.client,{
  taskId:first.task,ownerId:owner,contactId:first.contactId,
 }),true);
 const replay=await Promise.all(Array.from({length:5},()=>store.enqueueObservation(scope,[later.message])));
 assert.equal(new Set(replay).size,1);
 assert.deepEqual(new Set(replay),new Set([waitingTask]));
 const current=(await fixture.client.query(`SELECT control.active_round_id,round.round_number,
   round.target_count,round.status,
   (SELECT count(*)::int FROM memory_processing_round_target snapshot
    WHERE snapshot.round_id=round.id) AS frozen
  FROM memory_processing_scope control
  JOIN memory_processing_round round ON round.id=control.active_round_id
  WHERE control.owner_id=$1 AND control.contact_id=$2`,[owner,first.contactId])).rows[0];
 assert.notEqual(current.active_round_id,first.round);
 assert.equal(current.round_number,'2');
 assert.equal(current.status,'waiting');
 assert.equal(current.target_count,'1');
 assert.equal(current.frozen,1);
 assert.equal((await fixture.client.query(`SELECT count(*)::int AS n
  FROM background_task WHERE owner_id=$1 AND contact_id=$2 AND task_type='observation'`,
 [owner,first.contactId])).rows[0].n,1);
 assert.equal((await fixture.client.query(`SELECT count(*)::int AS n
  FROM memory_processing_round WHERE scope_id=$1`,[first.scope])).rows[0].n,2);
 assert.equal((await fixture.client.query('SELECT count(*)::int AS n FROM model_call_receipt')).rows[0].n,0);
});

test('临时故障按累计尝试有界重试，耗尽后新通知只排队且不清除阻碍',async t=>{
 const fixture=await createStorageFixture();
 const pool=new pg.Pool({host:'/tmp',database:fixture.client.database,max:2});
 t.after(async()=>{await pool.end();await fixture.close();});
 const owner=(await fixture.client.query("INSERT INTO owner(id,display_name) VALUES(gen_random_uuid(),'合成本人') RETURNING id")).rows[0].id;
 const first=await seedRoundInput(fixture,owner,{texts:['临时故障合成资料。'],verification:'legacy'});
 const later=await seedObservationInput(fixture,owner,first.contactId,{
  localId:3,text:'故障期间保存的合成资料。',
 });
 const scope={ownerId:owner,contactId:first.contactId},store=new ExtractionTaskStore(pool);
 await store.transaction(scope,client=>store.recordObservation(client,scope,later.observation,[later.message]));
 for(let attempt=1;attempt<=3;attempt++){
  const claim=await store.claim(scope,{
   taskId:first.task,workerId:randomUUID(),leaseMs:30_000,supportedSteps:['extract_memory'],
  });
  assert.ok(claim);
  assert.equal(await store.fail(claim,'temporary_model_failure',true),
   attempt<3?'retryable':'failed');
  const before=(await fixture.client.query(`SELECT task.retry_count,step.attempt_count,task.status,
    round.status AS round_status
   FROM background_task task
   JOIN background_task_step step ON step.task_id=task.id AND step.step_name='extract_memory'
   JOIN memory_processing_scope control ON control.owner_id=task.owner_id AND control.contact_id=task.contact_id
   JOIN memory_processing_round round ON round.id=control.active_round_id
   WHERE task.id=$1`,[first.task])).rows[0];
  await Promise.all(Array.from({length:4},()=>store.enqueueObservation(scope,[later.message])));
  const after=(await fixture.client.query(`SELECT task.retry_count,step.attempt_count,task.status,
    round.status AS round_status
   FROM background_task task
   JOIN background_task_step step ON step.task_id=task.id AND step.step_name='extract_memory'
   JOIN memory_processing_scope control ON control.owner_id=task.owner_id AND control.contact_id=task.contact_id
   JOIN memory_processing_round round ON round.id=control.active_round_id
   WHERE task.id=$1`,[first.task])).rows[0];
  assert.deepEqual(after,before);
 }
 assert.deepEqual((await fixture.client.query(`SELECT task.status,task.retry_count,
   (SELECT attempt_count FROM background_task_step WHERE task_id=task.id AND step_name='extract_memory') AS attempts,
   round.status AS round_status
  FROM background_task task
  JOIN memory_processing_scope control ON control.owner_id=task.owner_id AND control.contact_id=task.contact_id
  JOIN memory_processing_round round ON round.id=control.active_round_id
  WHERE task.id=$1`,[first.task])).rows[0],{
   status:'failed',retry_count:3,attempts:3,round_status:'blocked',
  });
 assert.equal((await fixture.client.query(`SELECT count(*)::int AS n FROM background_task
  WHERE owner_id=$1 AND contact_id=$2 AND task_type='observation'`,
 [owner,first.contactId])).rows[0].n,1);
 assert.deepEqual((await fixture.client.query(`SELECT task.status,
   (SELECT count(*)::int FROM memory_processing_round_task member
    WHERE member.task_id=task.id AND member.active) AS active_memberships
  FROM background_task task WHERE task.owner_id=$1 AND task.contact_id=$2
   AND task.task_type='observation'`,[owner,first.contactId])).rows[0],{
  status:'queued',active_memberships:0,
 });
 const waitingTask=(await fixture.client.query(`SELECT id FROM background_task
  WHERE owner_id=$1 AND contact_id=$2 AND task_type='observation'`,[owner,first.contactId])).rows[0]?.id;
 assert.ok(waitingTask);
 assert.equal((await fixture.client.query(`SELECT task_id FROM memory_extraction_receipt WHERE message_id=$1`,
  [later.message])).rows[0].task_id,waitingTask);

 const otherContact=randomUUID(),other=await seedRoundInput(fixture,owner,{
  contactId:otherContact,texts:['另一联系人合成资料。'],
 });
 const otherReceipt=(await fixture.client.query(`INSERT INTO memory_processing_receipt
  (message_id,owner_id,contact_id,outcome) VALUES($1,$2,$3,'succeeded') RETURNING completed_at`,
 [other.messages[0].id,owner,otherContact])).rows[0].completed_at;
 await fixture.client.query(`UPDATE memory_processing_target SET completed_at=$2,outcome='succeeded'
  WHERE task_id=$1`,[other.task,otherReceipt]);
 await fixture.client.query("UPDATE background_task SET status='succeeded' WHERE id=$1",[other.task]);
 assert.equal(await completeMemoryProcessingRoundIfReady(fixture.client,{
  taskId:other.task,ownerId:owner,contactId:otherContact,
 }),true);
});

test('受阻轮次不能领取未归属的主题画像维护任务',async t=>{
 const fixture=await managementFixture(t);
 const initial=(await fixture.request()).body.layered_memory;
 const enabled=(await fixture.request('enable',{
  settings_generation:initial.settings_generation,purpose_confirmed:true,
 })).body.layered_memory;
 assert.ok(enabled.work_id);
 const task=await addUnattachedLayeredTask(fixture,enabled.settings_generation);
 await fixture.pool.query(`UPDATE memory_processing_round SET status='blocked'
  WHERE id=(SELECT active_round_id FROM memory_processing_scope
    WHERE owner_id=$1 AND contact_id=$2)`,[fixture.ownerId,fixture.contactId]);
 assert.equal(await fixture.store.claim(fixture.taskScope,{
  taskId:task,workerId:randomUUID(),leaseMs:30_000,supportedSteps:['organize_memory'],
 }),null);
});

test('轮次完成后未归属的主题画像任务保持等待且不可执行',async t=>{
 const fixture=await managementFixture(t);
 const initial=(await fixture.request()).body.layered_memory;
 const enabled=(await fixture.request('enable',{
  settings_generation:initial.settings_generation,purpose_confirmed:true,
 })).body.layered_memory;
 await completeManagementTask(fixture,enabled);
 const task=await addUnattachedLayeredTask(fixture,enabled.settings_generation);
 const query=new MemoryProcessingQuery(fixture.pool,fixture.ownerId);
 const state=(await query.handle('GET',new URL(
  `/api/contacts/${fixture.contactId}/memory-processing/state`,'http://localhost',
 ))).body.current;
 assert.equal(state.status,'waiting');
 assert.equal(state.reason,'后续资料等待新一轮处理。');
 assert.equal(state.pending_count,0);
 assert.equal(await fixture.store.claim(fixture.taskScope,{
  taskId:task,workerId:randomUUID(),leaseMs:30_000,supportedSteps:['organize_memory'],
 }),null);
});
