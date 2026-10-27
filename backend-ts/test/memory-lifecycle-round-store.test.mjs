import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {managementFixture,completeManagementTask} from './layered-memory-management-fixture.mjs';
import {MemoryProcessingQuery} from '../src/memory/processing/query.ts';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {seedRoundInput} from './memory-lifecycle-round-support.mjs';
import {completeMemoryProcessingRoundIfReady} from '../src/memory/processing/round.ts';
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
