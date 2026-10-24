import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {PostgresTaskStatusStore,TaskApi} from '../src/task-api.ts';
import {LegacyControlError} from '../src/legacy-backend.ts';
import {PythonTaskControlGateway,TaskControlError} from '../src/task-control.ts';

const scope=()=>({ownerId:randomUUID(),contactId:randomUUID()});
const query=(contactId,taskId)=>new URLSearchParams({contact_id:contactId,task_id:taskId});

async function seed(fixture,ids){
  await fixture.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[ids.ownerId]);
  await fixture.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[ids.contactId,ids.ownerId]);
  ids.sourceId=(await fixture.client.query(`INSERT INTO source_document
    (owner_id,contact_id,source_type,file_name,content_sha256,record_count)
    VALUES($1,$2,'wechat_jsonl','synthetic-task.jsonl',$3,3) RETURNING id`,
  [ids.ownerId,ids.contactId,'a'.repeat(64)])).rows[0].id;
  ids.taskId=(await fixture.client.query(`INSERT INTO background_task
    (owner_id,contact_id,source_document_id,task_type,status,current_step,message_count)
    VALUES($1,$2,$3,'import','queued','parse',3) RETURNING id`,
  [ids.ownerId,ids.contactId,ids.sourceId])).rows[0].id;
  for(const [index,name] of ['parse','normalize','extract_memory','index','verify'].entries()){
    await fixture.client.query(`INSERT INTO background_task_step
      (task_id,step_name,step_order,total_count) VALUES($1,$2,$3,3)`,[ids.taskId,name,index+1]);
  }
}

test('任务适配复用原PG身份并严格经过Python控制门禁',async t=>{
  const fixture=await createStorageFixture();
  const name=(await fixture.client.query('SELECT current_database() AS name')).rows[0].name;
  const pool=new pg.Pool({host:'/tmp',database:name,max:2});
  t.after(async()=>{await pool.end();await fixture.close();});
  const ids=scope();
  await seed(fixture,ids);
  const calls=[];
  const control={
    async run(actualScope,taskId){calls.push({kind:'run',scope:actualScope,taskId});return 'started';},
    async retry(actualScope,taskId){calls.push({kind:'retry',scope:actualScope,taskId});return {task_id:taskId,status:'queued'};},
  };
  const api=new TaskApi({ownerId:ids.ownerId,store:new PostgresTaskStatusStore(pool),control});

  const status=await api.handle('GET','/api/tasks/status',query(ids.contactId,ids.taskId));
  assert.equal(status.status,200);
  assert.deepEqual({
    task_id:status.body.task_id,task_type:status.body.task_type,status:status.body.status,
    step:status.body.step,message_count:status.body.message_count,retry_count:status.body.retry_count,
  },{task_id:ids.taskId,task_type:'import',status:'queued',step:'parse',message_count:3,retry_count:0});
  assert.deepEqual(status.body.steps.map(step=>step.name),['parse','normalize','extract_memory','index','verify']);
  assert.deepEqual(status.body.steps.map(step=>step.status),['pending','pending','pending','pending','pending']);

  const deleteTask=await fixture.client.query(`INSERT INTO background_task
    (owner_id,contact_id,source_document_id,task_type,status,current_step,message_count)
    VALUES($1,$2,$3,'delete','queued','mark_deleted',0) RETURNING id`,[ids.ownerId,ids.contactId,ids.sourceId]);
  for(const [index,name] of ['mark_deleted','delete_derived','delete_index','clear_cache','verify_not_retrievable'].entries()){
    await fixture.client.query(`INSERT INTO background_task_step
      (task_id,step_name,step_order,total_count) VALUES($1,$2,$3,0)`,[deleteTask.rows[0].id,name,index+1]);
  }
  const deletion=await api.handle('GET','/api/tasks/status',query(ids.contactId,deleteTask.rows[0].id));
  assert.equal(deletion.status,200);
  assert.equal(deletion.body.task_type,'delete');
  assert.deepEqual(deletion.body.steps.map(step=>step.name),
    ['mark_deleted','delete_derived','delete_index','clear_cache','verify_not_retrievable']);

  const wrong=await api.handle('GET','/api/tasks/status',query(randomUUID(),ids.taskId));
  assert.deepEqual(wrong,{status:404,body:{error:'task_not_found'}});
  assert.deepEqual(await api.handle('GET','/api/tasks/status',
    new URLSearchParams({contact_id:ids.contactId,task_id:ids.taskId,extra:'1'})),
  {status:400,body:{error:'import_request_invalid'}});

  const run=await api.handle('POST','/api/tasks/run',new URLSearchParams(),{
    contact_id:ids.contactId,task_id:ids.taskId,
  });
  assert.deepEqual(run,{status:200,body:{status:'started'}});
  assert.deepEqual(calls,[{kind:'run',scope:{ownerId:ids.ownerId,contactId:ids.contactId},taskId:ids.taskId}]);
  assert.equal((await fixture.client.query('SELECT count(*)::int AS count FROM background_task')).rows[0].count,2);

  await fixture.client.query("UPDATE background_task SET status='failed',current_step='extract_memory' WHERE id=$1",[ids.taskId]);
  await fixture.client.query("UPDATE background_task_step SET status='failed' WHERE task_id=$1 AND step_name='extract_memory'",[ids.taskId]);
  const retry=await api.handle('POST','/api/tasks/retry',new URLSearchParams(),{
    contact_id:ids.contactId,task_id:ids.taskId,
  });
  assert.deepEqual(retry,{status:200,body:{task_id:ids.taskId,status:'queued'}});
  assert.equal(calls.at(-1).kind,'retry');

  await fixture.client.query("UPDATE background_task SET status='failed',current_step='extract_memory' WHERE id=$1",[ids.taskId]);
  await fixture.client.query("UPDATE background_task_step SET status='failed' WHERE task_id=$1 AND step_name='extract_memory'",[ids.taskId]);
  const failed=(await fixture.client.query("SELECT status,current_step,retry_count FROM background_task WHERE id=$1",[ids.taskId])).rows[0];
  const unavailableControl=new PythonTaskControlGateway();
  const unavailableApi=new TaskApi({ownerId:ids.ownerId,store:new PostgresTaskStatusStore(pool),control:unavailableControl});
  assert.deepEqual(await unavailableApi.handle('POST','/api/tasks/retry',new URLSearchParams(),{
    contact_id:ids.contactId,task_id:ids.taskId,
  }),{status:503,body:{error:'worker_unavailable'}});
  assert.deepEqual((await fixture.client.query("SELECT status,current_step,retry_count FROM background_task WHERE id=$1",[ids.taskId])).rows[0],
    failed,'无Worker时不得重排失败任务');

  await fixture.client.query("UPDATE source_document SET status='delete_requested' WHERE id=$1",[ids.sourceId]);
  const stale=await api.handle('POST','/api/tasks/run',new URLSearchParams(),{
    contact_id:ids.contactId,task_id:ids.taskId,
  });
  assert.deepEqual(stale,{status:409,body:{error:'task_retry_conflict'}});
  assert.equal(calls.length,2,'失效来源不得调用Worker，也不得重新排队');
});

test('固定任务gateway保留远端门禁错误并在关闭时排空在途控制',async()=>{
  const ids=scope();
  const requests=[];
  const taskId=randomUUID();
  let release;
  const waiting=new Promise(resolve=>{release=resolve;});
  const gateway=new PythonTaskControlGateway();
  gateway.bind({control(endpoint,method,body){
    requests.push({endpoint,method,body});
    if(endpoint==='/api/tasks/run')return waiting;
    if(endpoint==='/api/tasks/retry')return Promise.reject(new LegacyControlError(503,'model_configuration_unavailable'));
    return Promise.resolve({status:'queued'});
  }});

  const running=gateway.run(ids,taskId);
  await Promise.resolve();
  let closed=false;
  const closing=gateway.close().then(()=>{closed=true;});
  await Promise.resolve();
  assert.equal(closed,false,'关闭必须等待已登记的本机控制回执');
  release({status:'started'});
  assert.equal(await running,'started');
  await closing;
  await assert.rejects(gateway.run(ids,randomUUID()),error=>
    error instanceof TaskControlError&&error.code==='worker_unavailable');
  assert.equal(requests.length,1);
  assert.deepEqual(requests[0],{endpoint:'/api/tasks/run',method:'POST',
    body:{contact_id:ids.contactId,task_id:taskId}});

  const second=new PythonTaskControlGateway();
  second.bind({control(){return Promise.reject(new LegacyControlError(503,'model_configuration_unavailable'));}});
  await assert.rejects(second.run(ids,randomUUID()),error=>
    error instanceof TaskControlError&&error.code==='model_configuration_unavailable'
    &&error.status===503);
});
