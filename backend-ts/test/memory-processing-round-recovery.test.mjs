import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {resumeInterruptedCurrentRound} from '../src/memory/processing/round-recovery.ts';

test('已排队的未完成原任务无需重置步骤也会返回唤醒身份',async t=>{
  const fixture=await createStorageFixture();
  t.after(()=>fixture.close());
  const owner=randomUUID(),contact=randomUUID(),scope=randomUUID(),round=randomUUID(),task=randomUUID();
  await fixture.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
  await fixture.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
  await fixture.client.query('INSERT INTO memory_processing_scope(id,owner_id,contact_id) VALUES($1,$2,$3)',[scope,owner,contact]);
  await fixture.client.query(`INSERT INTO memory_processing_round
    (id,scope_id,owner_id,contact_id,round_number,control_generation,status,phase)
    VALUES($1,$2,$3,$4,1,0,'blocked','topics')`,[round,scope,owner,contact]);
  await fixture.client.query('UPDATE memory_processing_scope SET active_round_id=$1 WHERE id=$2',[round,scope]);
  await fixture.client.query(`INSERT INTO background_task
    (id,owner_id,contact_id,task_type,status,current_step,message_count)
    VALUES($1,$2,$3,'layered_memory','queued','organize_memory',0)`,[task,owner,contact]);
  await fixture.client.query(`INSERT INTO background_task_step
    (task_id,step_name,step_order,status) VALUES($1,'organize_memory',1,'pending')`,[task]);
  await fixture.client.query('INSERT INTO memory_processing_round_task(round_id,task_id,owner_id,contact_id) VALUES($1,$2,$3,$4)',
    [round,task,owner,contact]);

  const wake=await resumeInterruptedCurrentRound(fixture.client,{ownerId:owner,contactId:contact},round);
  assert.deepEqual(wake,[task]);
  assert.equal((await fixture.client.query(
    'SELECT status FROM background_task WHERE id=$1',[task],
  )).rows[0].status,'queued');
  assert.equal((await fixture.client.query(
    'SELECT status FROM memory_processing_round WHERE id=$1',[round],
  )).rows[0].status,'waiting');
});
