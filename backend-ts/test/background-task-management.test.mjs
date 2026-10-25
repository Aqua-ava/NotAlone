import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {
  BusinessTaskApi,
  PostgresBusinessTaskManager,
} from '../src/background-task-management.ts';
import {ExtractionTaskStore} from '../src/extraction-task-store.ts';

async function fixture(t) {
  const storage=await createStorageFixture();
  t.after(()=>storage.close());
  const owner=randomUUID(),otherOwner=randomUUID(),contact=randomUUID(),otherContact=randomUUID();
  const source=randomUUID(),deleteSource=randomUUID();
  await storage.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人'),($2,'另一本人')",[owner,otherOwner]);
  await storage.client.query(`INSERT INTO contact(id,owner_id,display_name) VALUES
    ($1,$2,'合成联系人'),($3,$4,'另一联系人')`,
  [contact,owner,otherContact,otherOwner]);
  await storage.client.query(`INSERT INTO source_document
    (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
    VALUES($1,$2,$3,'wechat_jsonl','synthetic-task.jsonl',$4,4),
      ($5,$2,$3,'wechat_jsonl','synthetic-delete.jsonl',$6,4)`,
  [source,owner,contact,'a'.repeat(64),deleteSource,'b'.repeat(64)]);
  await storage.client.query("UPDATE source_document SET status='delete_failed',deletion_error_code='storage_delete_failed' WHERE id=$1",[deleteSource]);
  await storage.client.query(`INSERT INTO conversation_binding
    (owner_id,contact_id,channel,account_scope,conversation_locator)
    VALUES($1,$2,'wechat','synthetic-owner','synthetic-contact')`,[owner,contact]);
  await storage.client.query(`INSERT INTO skill_learning_scope(owner_id,contact_id,enabled,revision,confirmed_at)
    VALUES($1,$2,true,1,now())`,[owner,contact]);
  return {storage,manager:new PostgresBusinessTaskManager(storage.client),owner,otherOwner,contact,otherContact,source,deleteSource};
}
const leaseLive=()=>new Date(Date.now()+300_000).toISOString();
const leaseExpired=()=>new Date(Date.now()-300_000).toISOString();

async function task(client,values,steps) {
  const id=(await client.query(`INSERT INTO background_task
    (owner_id,contact_id,source_document_id,task_type,status,current_step,message_count,
     retry_count,last_error_code,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
  [values.owner,values.contact,values.source??null,values.type,values.status,values.step,
    values.messages??0,values.retries??0,values.error??null,values.updatedAt??'2026-10-25T00:00:00Z'])).rows[0].id;
  for(const [index,entry] of steps.entries()) {
    await client.query(`INSERT INTO background_task_step
      (task_id,step_name,step_order,status,attempt_count,processed_count,total_count,worker_id,
       lease_generation,lease_expires_at,last_error_code,started_at,finished_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id,entry.name,index+1,entry.status,entry.attempts??0,entry.processed??0,
      entry.total===undefined?values.messages??0:entry.total,
      entry.worker??null,entry.generation??0,entry.expires??null,entry.error??null,
      entry.started??null,entry.finished??null]);
  }
  return id;
}

test('统一任务列表按owner投影全部业务类型、真实步骤与实际处理量',async t=>{
  const f=await fixture(t);
  const runningWorker=randomUUID();
  const imported=await task(f.storage.client,{owner:f.owner,contact:f.contact,source:f.source,type:'import',
    status:'running',step:'extract_memory',messages:4,retries:2,error:null},[
    {name:'parse',status:'succeeded',attempts:1,processed:4,total:4,finished:'2026-10-25T00:01:00Z'},
    {name:'normalize',status:'succeeded',attempts:1,processed:4,total:4,finished:'2026-10-25T00:02:00Z'},
    {name:'extract_memory',status:'running',attempts:2,processed:3,total:4,worker:runningWorker,
      generation:3,expires:leaseLive()},
    {name:'index',status:'pending'},{name:'verify',status:'pending'},
  ]);
  const observed=await task(f.storage.client,{owner:f.owner,contact:f.contact,type:'observation',
    status:'queued',step:'extract_memory',messages:2,error:'model_configuration_unavailable'},[
    {name:'extract_memory',status:'retryable',attempts:1,processed:0,total:null,error:'model_configuration_unavailable'},
    {name:'index',status:'pending'},{name:'verify',status:'pending'},
  ]);
  const deleted=await task(f.storage.client,{owner:f.owner,contact:f.contact,source:f.deleteSource,type:'delete',
    status:'failed',step:'delete_index',messages:0,error:'source_delete_failed'},[
    {name:'mark_deleted',status:'succeeded',attempts:1,processed:0,total:0},
    {name:'delete_derived',status:'succeeded',attempts:1,processed:0,total:0},
    {name:'delete_index',status:'failed',attempts:3,processed:0,total:0,error:'source_delete_failed'},
    {name:'clear_cache',status:'pending'},{name:'verify_not_retrievable',status:'pending'},
  ]);
  const learning=await task(f.storage.client,{owner:f.owner,contact:f.contact,type:'skill_learning',
    status:'failed',step:'verify_skill_drafts',messages:3,error:'skill_learning_temporary_failure'},[
    {name:'propose_skill',status:'succeeded',attempts:1,processed:3,total:3},
    {name:'verify_skill_drafts',status:'failed',attempts:3,processed:0,total:3,
      error:'skill_learning_temporary_failure',generation:2},
  ]);
  const layered=await task(f.storage.client,{owner:f.owner,contact:null,type:'layered_memory',
    status:'running',step:'organize_memory',messages:5},[
    {name:'organize_memory',status:'running',attempts:1,processed:2,total:5,
      worker:randomUUID(),generation:1,expires:leaseExpired()},
  ]);
  await f.storage.client.query(`INSERT INTO layered_memory_state
    (owner_id,contact_id,settings_generation,enabled,status,covered_count,updated_at)
    VALUES($1,NULL,3,true,'paused',2,now())`,[f.owner]);
  await f.storage.client.query(`INSERT INTO layered_memory_job
    (task_id,owner_id,contact_id,settings_generation,target_key,contract,target_manifest,
     dependency_ids,state,run_remaining,model_call_limit,revision)
    VALUES($1,$2,NULL,3,'synthetic-owner','document-tools-v1','[]','{}','paused',1,16,7)`,
  [layered,f.owner]);
  const retired=await task(f.storage.client,{owner:f.owner,contact:f.contact,type:'memory_upgrade',
    status:'failed',step:'preview_upgrade',messages:1,error:'retired'},[
    {name:'preview_upgrade',status:'failed',attempts:1},
  ]);
  await task(f.storage.client,{owner:f.otherOwner,contact:f.otherContact,type:'observation',
    status:'running',step:'extract_memory',messages:1},[
    {name:'extract_memory',status:'running',worker:randomUUID(),expires:leaseLive()},
  ]);

  const list=await f.manager.list(f.owner,{contactId:f.contact});
  assert.deepEqual(list.tasks.map(item=>item.task_id).sort(),
    [imported,observed,deleted,learning,retired].sort());
  assert.equal(list.tasks.some(item=>item.task_id===layered),false,'联系人过滤不能带入本人范围任务');
  const importItem=list.tasks.find(item=>item.task_id===imported);
  assert.equal(importItem.status,'running');
  assert.equal(importItem.phase,'extract_memory');
  assert.equal(importItem.retry_count,2);
  assert.equal(importItem.processed_count,3);
  assert.equal(importItem.total_count,4);
  assert.deepEqual(importItem.steps.map(step=>[step.name,step.status,step.processed_count,step.total_count]),[
    ['parse','succeeded',4,4],['normalize','succeeded',4,4],
    ['extract_memory','running',3,4],['index','pending',0,4],['verify','pending',0,4],
  ]);
  assert.deepEqual(importItem.actions,[{kind:'stop'}]);
  assert.deepEqual(list.tasks.find(item=>item.task_id===observed).actions,[{kind:'stop'}]);
  assert.equal(list.tasks.find(item=>item.task_id===observed).total_count,null,
    '缺少可信目标总量时必须保留未知');
  assert.deepEqual(list.tasks.find(item=>item.task_id===deleted).actions,[],
    '来源删除恢复仍由Ticket 17承接的来源面板发起，不从通用任务面板猜测');
  assert.deepEqual(list.tasks.find(item=>item.task_id===learning).actions,
    [{kind:'recover',target:'skill_learning'}]);
  assert.deepEqual(list.tasks.find(item=>item.task_id===retired).actions,[]);

  const all=await f.manager.list(f.owner);
  const ownerTask=all.tasks.find(item=>item.task_id===layered);
  assert.equal(ownerTask.contact_id,null);
  assert.equal(ownerTask.scope_kind,'owner');
  assert.equal(ownerTask.phase,'organize_memory');
  assert.equal(ownerTask.status,'paused','领域暂停与过期租约不得继续显示运行中');
  assert.equal(ownerTask.processed_count,2);
  assert.equal(ownerTask.total_count,5);
  assert.deepEqual(ownerTask.actions,[{kind:'recover',target:'layered_memory',
    work_revision:7,settings_generation:3}],'过期租约只开放用户显式恢复，不自动宣布成功');
  assert.equal(all.tasks.some(item=>item.task_id===learning),true);
  assert.equal(all.tasks.some(item=>item.task_id===retired),true);
  assert.equal(all.tasks.length,6,'不得读取其他owner的任务');

  const ownerOnly=await f.manager.list(f.owner,{scope:'owner'});
  assert.deepEqual(ownerOnly.tasks.map(item=>item.task_id),[layered],
    '本人任务入口只能返回contact_id为NULL的任务');
  assert.equal(ownerOnly.tasks[0].scope_kind,'owner');

  const before=(await f.storage.client.query(`SELECT id,status,updated_at FROM background_task
    WHERE owner_id=$1 ORDER BY id`,[f.owner])).rows;
  await f.manager.list(f.owner);
  const after=(await f.storage.client.query(`SELECT id,status,updated_at FROM background_task
    WHERE owner_id=$1 ORDER BY id`,[f.owner])).rows;
  assert.deepEqual(after,before,'纯列表读取不得唤醒、重排或写入任务');
});

test('统一停止使原租约失效、幂等取消且不能提交晚结果',async t=>{
  const f=await fixture(t);
  const pool=new pg.Pool({host:'/tmp',database:f.storage.client.database,max:2});
  const store=new ExtractionTaskStore(pool);
  try{
    const otherContact=randomUUID();
    await f.storage.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'停止隔离联系人')",
      [otherContact,f.owner]);
    const taskId=await store.enqueueImport({ownerId:f.owner,contactId:f.contact},f.source,4);
    await f.storage.client.query(`UPDATE background_task_step SET status='succeeded',
      attempt_count=1,processed_count=4,finished_at=now()
      WHERE task_id=$1 AND step_name IN ('parse','normalize')`,[taskId]);
    const claim=await store.claim({ownerId:f.owner,contactId:f.contact},{
      taskId,workerId:randomUUID(),leaseMs:30_000,
    });
    assert.ok(claim);
    const otherId=await task(f.storage.client,{owner:f.owner,contact:otherContact,type:'observation',
      status:'queued',step:'extract_memory',messages:1},[
      {name:'extract_memory',status:'pending',total:1},
    ]);
    const otherBefore=(await f.storage.client.query(`SELECT t.status,s.status step_status,
      s.lease_generation,s.worker_id,s.lease_expires_at FROM background_task t
      JOIN background_task_step s ON s.task_id=t.id WHERE t.id=$1`,[otherId])).rows;
    await assert.rejects(f.manager.stop(f.owner,{contactId:otherContact,taskId}),{code:'task_not_found'});
    await assert.rejects(f.manager.stop(f.owner,{scope:'owner',taskId}),{code:'task_not_found'},
      '本人范围动作不得命中联系人任务');
    await assert.rejects(f.manager.stop(f.otherOwner,{taskId}),{code:'task_not_found'});

    assert.deepEqual(await f.manager.stop(f.owner,{contactId:f.contact,taskId}),{
      task_id:taskId,status:'stopped',
    });
    const stopped=(await f.storage.client.query(`SELECT t.status,t.last_error_code,t.finished_at,
      s.status step_status,s.worker_id,s.lease_expires_at,s.lease_generation
      FROM background_task t JOIN background_task_step s ON s.task_id=t.id
      WHERE t.id=$1 AND s.step_name='extract_memory'`,[taskId])).rows[0];
    assert.equal(stopped.status,'cancelled');
    assert.equal(stopped.last_error_code,'task_stopped');
    assert.ok(stopped.finished_at instanceof Date);
    assert.equal(stopped.step_status,'cancelled');
    assert.equal(stopped.worker_id,null);
    assert.equal(stopped.lease_expires_at,null);
    assert.ok(Number(stopped.lease_generation)>claim.leaseGeneration);
    await assert.rejects(store.complete(claim,4,4),{code:'lease_stale'});
    assert.deepEqual(await f.manager.stop(f.owner,{contactId:f.contact,taskId}),{
      task_id:taskId,status:'stopped',
    });
    assert.deepEqual((await f.storage.client.query(`SELECT t.status,s.status step_status,
      s.lease_generation,s.worker_id,s.lease_expires_at FROM background_task t
      JOIN background_task_step s ON s.task_id=t.id WHERE t.id=$1`,[otherId])).rows,otherBefore,
    '停止一个任务不得改写其他联系人租约');
  }finally{await pool.end();}
});

test('显式恢复只重排原失败任务并保留成功步骤、来源和未知调用资格',async t=>{
  const f=await fixture(t);
  const pool=new pg.Pool({host:'/tmp',database:f.storage.client.database,max:2});
  const store=new ExtractionTaskStore(pool);
  try{
    const taskId=await store.enqueueImport({ownerId:f.owner,contactId:f.contact},f.source,4);
    await f.storage.client.query(`UPDATE background_task_step SET status='succeeded',
      attempt_count=1,processed_count=4,total_count=4,finished_at=now()
      WHERE task_id=$1 AND step_name IN ('parse','normalize')`,[taskId]);
    await f.storage.client.query(`UPDATE background_task_step SET status='failed',attempt_count=3,
      last_error_code='temporary_model_failure' WHERE task_id=$1 AND step_name='extract_memory'`,[taskId]);
    await f.storage.client.query(`UPDATE background_task SET status='failed',current_step='extract_memory',
      last_error_code='temporary_model_failure',retry_count=3,finished_at=now() WHERE id=$1`,[taskId]);
    const before=(await f.storage.client.query(`SELECT source_document_id,owner_id,contact_id,message_count
      FROM background_task WHERE id=$1`,[taskId])).rows[0];

    await assert.rejects(f.manager.recover(f.owner,{scope:'owner',taskId,action:'resume'}),
      {code:'task_not_found'},'本人范围恢复不得命中联系人任务');
    assert.deepEqual(await f.manager.recover(f.owner,{
      contactId:f.contact,taskId,action:'resume',
    }),{task_id:taskId,status:'queued'});
    const resumed=(await f.storage.client.query(`SELECT t.status,t.current_step,t.last_error_code,
      t.source_document_id,t.owner_id,t.contact_id,t.message_count,s.step_name,s.status step_status,
      s.attempt_count,s.lease_generation
      FROM background_task t JOIN background_task_step s ON s.task_id=t.id
      WHERE t.id=$1 ORDER BY s.step_order`,[taskId])).rows;
    assert.deepEqual({
      status:resumed[0].status,current_step:resumed[0].current_step,
      last_error_code:resumed[0].last_error_code,source_document_id:resumed[0].source_document_id,
      owner_id:resumed[0].owner_id,contact_id:resumed[0].contact_id,message_count:resumed[0].message_count,
    },{
      status:'queued',current_step:'extract_memory',last_error_code:null,
      source_document_id:before.source_document_id,owner_id:before.owner_id,
      contact_id:before.contact_id,message_count:before.message_count,
    });
    assert.deepEqual(resumed.map(row=>[row.step_name,row.step_status,row.attempt_count]),[
      ['parse','succeeded',1],['normalize','succeeded',1],
      ['extract_memory','pending',0],['index','pending',0],['verify','pending',0],
    ]);
    assert.equal(Number(resumed[2].lease_generation),1,'重排推进代次但不重新写入旧结果');

    await f.storage.client.query(`UPDATE background_task SET status='failed',
      last_error_code='model_call_outcome_unknown',finished_at=now() WHERE id=$1`,[taskId]);
    await f.storage.client.query(`UPDATE background_task_step SET status='failed',
      last_error_code='model_call_outcome_unknown' WHERE task_id=$1 AND step_name='extract_memory'`,[taskId]);
    await assert.rejects(f.manager.recover(f.owner,{
      contactId:f.contact,taskId,action:'resume',
    }),{code:'task_recovery_unknown'});
    assert.equal((await f.storage.client.query('SELECT status,last_error_code FROM background_task WHERE id=$1',[taskId])).rows[0].status,'failed',
      '未知物理调用不能被统一恢复入口清零');
    assert.deepEqual((await f.manager.list(f.owner,{contactId:f.contact})).tasks
      .find(item=>item.task_id===taskId).actions,[],'未知调用不得向界面暴露恢复动作');

    await f.storage.client.query(`UPDATE background_task SET status='cancelled',
      last_error_code='task_stopped',finished_at=now() WHERE id=$1`,[taskId]);
    await f.storage.client.query(`UPDATE background_task_step SET status='cancelled',
      lease_generation=lease_generation+1,last_error_code='task_stopped'
      WHERE task_id=$1 AND status<>'succeeded'`,[taskId]);
    await assert.rejects(f.manager.recover(f.owner,{
      contactId:f.contact,taskId,action:'resume',
    }),{code:'task_recovery_conflict'});
    assert.deepEqual(await f.manager.recover(f.owner,{
      contactId:f.contact,taskId,action:'restart',
    }),{task_id:taskId,status:'queued'});
    await assert.rejects(f.manager.recover(f.owner,{
      contactId:f.contact,taskId,action:'resume',
    }),{code:'task_recovery_conflict'},'排队任务不能伪装成失败恢复');
  }finally{await pool.end();}
});

test('任务HTTP入口严格限定owner范围、固定动作与闭集字段',async()=>{
  const ownerId=randomUUID(),contactId=randomUUID(),taskId=randomUUID(),calls=[];
  const api=new BusinessTaskApi({ownerId,manager:{
    async list(owner,options){calls.push({kind:'list',owner,options});return {tasks:[],has_more:false};},
    async stop(owner,request){calls.push({kind:'stop',owner,request});return {task_id:taskId,status:'stopped'};},
    async recover(owner,request){calls.push({kind:'recover',owner,request});return {task_id:taskId,status:'queued'};},
  }});
  assert.deepEqual(await api.handle('GET','/api/tasks',
    new URLSearchParams({contact_id:contactId}),undefined),
  {status:200,body:{tasks:[],has_more:false}});
  assert.deepEqual(calls.shift(),{kind:'list',owner:ownerId,options:{contactId,limit:100}});
  assert.deepEqual(await api.handle('GET','/api/tasks',
    new URLSearchParams({scope:'owner',limit:'3'}),undefined),
  {status:200,body:{tasks:[],has_more:false}});
  assert.deepEqual(calls.shift(),{kind:'list',owner:ownerId,options:{scope:'owner',limit:3}});
  assert.deepEqual(await api.handle('POST','/api/tasks/stop',new URLSearchParams(),{task_id:taskId}),
    {status:200,body:{task_id:taskId,status:'stopped'}});
  assert.deepEqual(calls.shift(),{kind:'stop',owner:ownerId,request:{contactId:undefined,taskId}});
  assert.deepEqual(await api.handle('POST','/api/tasks/stop',new URLSearchParams(),
    {scope:'owner',task_id:taskId}),
  {status:200,body:{task_id:taskId,status:'stopped'}});
  assert.deepEqual(calls.shift(),{kind:'stop',owner:ownerId,
    request:{contactId:undefined,scope:'owner',taskId}});
  assert.deepEqual(await api.handle('POST','/api/tasks/recover',new URLSearchParams(),
    {contact_id:contactId,task_id:taskId,action:'resume'}),
  {status:200,body:{task_id:taskId,status:'queued'}});
  assert.deepEqual(calls.shift(),{kind:'recover',owner:ownerId,
    request:{contactId,taskId,action:'resume'}});
  assert.deepEqual(await api.handle('POST','/api/tasks/recover',new URLSearchParams(),
    {scope:'owner',task_id:taskId,action:'resume'}),
  {status:200,body:{task_id:taskId,status:'queued'}});
  assert.deepEqual(calls.shift(),{kind:'recover',owner:ownerId,
    request:{contactId:undefined,scope:'owner',taskId,action:'resume'}});
  for(const [method,path,query,body] of [
    ['GET','/api/tasks',new URLSearchParams({contact_id:contactId,extra:'1'}),undefined],
    ['GET','/api/tasks',new URLSearchParams({scope:'all'}),undefined],
    ['GET','/api/tasks',new URLSearchParams({scope:'owner',contact_id:contactId}),undefined],
    ['GET','/api/tasks/stop',new URLSearchParams(),undefined],
    ['POST','/api/tasks/stop',new URLSearchParams({contact_id:contactId}),{task_id:taskId}],
    ['POST','/api/tasks/stop',new URLSearchParams(),{task_id:'bad'}],
    ['POST','/api/tasks/stop',new URLSearchParams(),{scope:'all',task_id:taskId}],
    ['POST','/api/tasks/stop',new URLSearchParams(),{scope:'owner',contact_id:contactId,task_id:taskId}],
    ['POST','/api/tasks/recover',new URLSearchParams(),{task_id:taskId,action:'retry'}],
    ['POST','/api/tasks/recover',new URLSearchParams(),{scope:'owner',contact_id:contactId,task_id:taskId,action:'resume'}],
    ['POST','/api/tasks/recover',new URLSearchParams(),{task_id:taskId,action:'resume',extra:true}],
  ]) assert.equal((await api.handle(method,path,query,body)).status,400);
  assert.equal(calls.length,0);
});

test('停止Skill、删除与L2/L3只撤销执行，不重置授权或扩大来源',async t=>{
  const f=await fixture(t);
  const skill=await task(f.storage.client,{owner:f.owner,contact:f.contact,type:'skill_learning',
    status:'queued',step:'propose_skill',messages:3},[
    {name:'propose_skill',status:'pending',total:3},{name:'verify_skill_drafts',status:'pending',total:3},
  ]);
  const deletion=await task(f.storage.client,{owner:f.owner,contact:f.contact,source:f.deleteSource,
    type:'delete',status:'queued',step:'mark_deleted',messages:0},[
    {name:'mark_deleted',status:'pending'},{name:'delete_derived',status:'pending'},
    {name:'delete_index',status:'pending'},{name:'clear_cache',status:'pending'},
    {name:'verify_not_retrievable',status:'pending'},
  ]);
  const layered=await task(f.storage.client,{owner:f.owner,contact:null,type:'layered_memory',
    status:'queued',step:'organize_memory',messages:3},[
    {name:'organize_memory',status:'pending',total:3},
  ]);
  await f.storage.client.query(`INSERT INTO layered_memory_state
    (owner_id,contact_id,settings_generation,enabled,status,updated_at)
    VALUES($1,NULL,2,true,'updating',now())`,[f.owner]);
  await f.storage.client.query(`INSERT INTO layered_memory_job
    (task_id,owner_id,contact_id,settings_generation,target_key,contract,target_manifest,
     dependency_ids,state,run_remaining,model_call_limit)
    VALUES($1,$2,NULL,2,'stop-owner','document-tools-v1','[]','{}','active',1,16)`,
  [layered,f.owner]);

  assert.equal((await f.manager.stop(f.owner,{contactId:f.contact,taskId:skill})).status,'stopped');
  assert.deepEqual((await f.storage.client.query(`SELECT setting.enabled,setting.revision,t.status
    FROM skill_learning_scope setting JOIN background_task t ON t.owner_id=setting.owner_id
    AND t.contact_id=setting.contact_id WHERE t.id=$1`,[skill])).rows,
  [{enabled:true,revision:'1',status:'cancelled'}]);
  assert.equal((await f.manager.stop(f.owner,{contactId:f.contact,taskId:deletion})).status,'stopped');
  assert.deepEqual((await f.storage.client.query('SELECT status FROM source_document WHERE id=$1',
    [f.deleteSource])).rows,[{status:'delete_failed'}]);
  assert.equal((await f.manager.stop(f.owner,{taskId:layered})).status,'stopped');
  assert.deepEqual((await f.storage.client.query(`SELECT job.state,job.last_action,
    state.status state_status,state.enabled,t.status task_status
    FROM layered_memory_job job JOIN layered_memory_state state
      ON state.owner_id=job.owner_id AND state.contact_id IS NOT DISTINCT FROM job.contact_id
    JOIN background_task t ON t.id=job.task_id WHERE job.task_id=$1`,[layered])).rows,
  [{state:'paused',last_action:'pause',state_status:'paused',enabled:true,task_status:'cancelled'}]);
});
