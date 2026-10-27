import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {lifecycleHost} from './memory-lifecycle-host-support.mjs';
import {
  seedRoundInput,
  seedRoundMemory,
  sendSyntheticTool,
  untilLifecycle,
} from './memory-lifecycle-round-support.mjs';

async function markExtractionInterrupted(client,task,round,code='lease_expired'){
  await client.query(`UPDATE background_task_step
    SET status='failed',attempt_count=1,last_error_code=$2,finished_at=now()
    WHERE task_id=$1 AND step_name='extract_memory'`,[task,code]);
  await client.query(`UPDATE background_task
    SET status='failed',last_error_code=$2,finished_at=now()
    WHERE id=$1`,[task,code]);
  await client.query("UPDATE memory_processing_round SET status='blocked' WHERE id=$1",[round]);
}

async function seedLayeredInterruption(f,owner,{outcome=null,versionMismatch=false}={}){
  const contact=randomUUID(),scope=randomUUID(),round=randomUUID(),task=randomUUID();
  await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成恢复阻断')",[contact,owner]);
  await f.client.query('INSERT INTO memory_processing_scope(id,owner_id,contact_id) VALUES($1,$2,$3)',[scope,owner,contact]);
  await f.client.query(`INSERT INTO memory_processing_round
    (id,scope_id,owner_id,contact_id,round_number,control_generation,status,phase)
    VALUES($1,$2,$3,$4,1,0,'blocked','profile')`,[round,scope,owner,contact]);
  await f.client.query('UPDATE memory_processing_scope SET active_round_id=$1 WHERE id=$2',[round,scope]);
  await f.client.query(`INSERT INTO background_task
    (id,owner_id,contact_id,task_type,status,current_step,message_count,last_error_code,finished_at)
    VALUES($1,$2,$3,'layered_memory','failed','organize_memory',0,'lease_expired',now())`,
  [task,owner,contact]);
  await f.client.query(`INSERT INTO background_task_step
    (task_id,step_name,step_order,status,attempt_count,last_error_code,finished_at)
    VALUES($1,'organize_memory',1,'failed',1,'lease_expired',now())`,[task]);
  await f.client.query('INSERT INTO memory_processing_round_task(round_id,task_id,owner_id,contact_id) VALUES($1,$2,$3,$4)',
    [round,task,owner,contact]);
  await f.client.query(`INSERT INTO layered_memory_state
    (owner_id,contact_id,enabled,settings_generation,status)
    VALUES($1,$2,true,1,'blocked')`,[owner,contact]);
  await f.client.query(`INSERT INTO layered_memory_job
    (task_id,owner_id,contact_id,settings_generation,target_key,contract,target_manifest,
     dependency_ids,state,run_remaining,pending_receipt,model_calls_used,model_call_limit)
    VALUES($1,$2,$3,1,$4,'synthetic','[]','{}','active',1,false,2,4)`,
  [task,owner,contact,`synthetic:${task}`]);
  if(versionMismatch){
    await f.client.query(`UPDATE layered_memory_state
      SET settings_generation=2,status='stale' WHERE owner_id=$1 AND contact_id=$2`,[owner,contact]);
  }
  if(outcome){
    await f.client.query(`INSERT INTO model_call_receipt
      (attempt_id,owner_id,contact_id,request_id,permit_id,provider,model_name,
       called_at,dispatch,outcome,cost_status)
      VALUES($1,$2,$3,$4,$5,'deepseek','synthetic',now(),'authorized_unconfirmed',$6,'unknown')`,
    [randomUUID(),owner,contact,task,randomUUID(),outcome]);
  }
  return {contact,scope,round,task};
}

test('启动自动续跑可信当前轮中断，保留成功阶段与固定目标且重复重启不重做',{timeout:60000},async t=>{
  let calls=0,seed,before;
  const provider=createServer(async(req,res)=>{
    calls++;
    let raw='';for await(const chunk of req)raw+=chunk;
    const input=JSON.parse(raw);
    assert.equal(input.tools?.[0]?.name,'DirectMemoryExtractionOutput');
    sendSyntheticTool(res,input.tools[0].name,{scenes:[]});
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(async()=>{provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));});

  const host=await lifecycleHost(t,async(f,owner)=>{
    seed=await seedRoundInput(f,owner,{texts:['启动恢复合成资料一。','启动恢复合成资料二。']});
    before={
      steps:(await f.client.query(`SELECT step_name,status,attempt_count,updated_at
        FROM background_task_step WHERE task_id=$1 ORDER BY step_order`,[seed.task])).rows,
      targets:(await f.client.query(`SELECT task_id,message_id FROM memory_processing_round_target
        WHERE round_id=$1 ORDER BY task_id,message_id`,[seed.round])).rows,
    };
    await markExtractionInterrupted(f.client,seed.task,seed.round);
  },{providerUrl:`http://127.0.0.1:${provider.address().port}`});

  const round=await untilLifecycle(async()=>(await host.client.query(
    'SELECT status FROM memory_processing_round WHERE id=$1',[seed.round],
  )).rows[0]?.status==='completed',20000);
  assert.equal(round,true);
  assert.equal(calls,1);

  const state=(await host.request(`/api/contacts/${seed.contactId}/memory-processing/state`)).data.current;
  assert.equal(state.status,'completed');
  assert.equal(state.round_id,seed.round);
  assert.deepEqual([state.processed_count,state.total_count,state.pending_count],[2,2,0]);
  const steps=(await host.client.query(`SELECT step_name,status,attempt_count,finished_at IS NOT NULL AS finished
    FROM background_task_step WHERE task_id=$1 ORDER BY step_order`,[seed.task])).rows;
  assert.deepEqual(steps.map(row=>row.status),['succeeded','succeeded','succeeded','succeeded','succeeded']);
  assert.equal(steps.find(row=>row.step_name==='extract_memory').attempt_count,2);
  const afterTargets=(await host.client.query(`SELECT task_id,message_id FROM memory_processing_round_target
    WHERE round_id=$1 ORDER BY task_id,message_id`,[seed.round])).rows;
  assert.deepEqual(afterTargets,before.targets);
  const afterSteps=(await host.client.query(`SELECT step_name,status,attempt_count,updated_at
    FROM background_task_step WHERE task_id=$1 ORDER BY step_order`,[seed.task])).rows;
  for(const name of ['parse','normalize']){
    assert.deepEqual(afterSteps.find(row=>row.step_name===name),before.steps.find(row=>row.step_name===name));
  }

  const completedAt=(await host.client.query(
    'SELECT finished_at FROM background_task WHERE id=$1',[seed.task],
  )).rows[0].finished_at;
  await host.restartHost();
  assert.equal(calls,1);
  assert.deepEqual((await host.client.query(
    'SELECT status,finished_at FROM background_task WHERE id=$1',[seed.task],
  )).rows[0],{status:'succeeded',finished_at:completedAt});
  assert.deepEqual((await host.client.query(`SELECT task_id,message_id
    FROM memory_processing_round_target WHERE round_id=$1 ORDER BY task_id,message_id`,
  [seed.round])).rows,afterTargets);
});

test('启动恢复不越过暂停、未知回执、撤销来源、版本失效和人工修复，其他联系人完成',{timeout:90000},async t=>{
  const texts={
    healthy:'启动恢复健康联系人合成资料。',
    paused:'启动恢复暂停联系人合成资料。',
    source:'启动恢复撤销来源合成资料。',
    repair:'启动恢复人工修复合成资料。',
  };
  let calls=0,seed,budgets=[],taskCount=0;
  const provider=createServer(async(req,res)=>{
    calls++;
    let raw='';for await(const chunk of req)raw+=chunk;
    const input=JSON.parse(raw);
    if(!raw.includes(texts.healthy)){res.writeHead(500);res.end('{}');return;}
    sendSyntheticTool(res,input.tools[0].name,{scenes:[]});
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(async()=>{provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));});

  const host=await lifecycleHost(t,async(f,owner)=>{
    seed={};
    seed.healthy=await seedRoundInput(f,owner,{texts:[texts.healthy]});
    await markExtractionInterrupted(f.client,seed.healthy.task,seed.healthy.round);
    seed.paused=await seedRoundInput(f,owner,{texts:[texts.paused],paused:true});
    await markExtractionInterrupted(f.client,seed.paused.task,seed.paused.round);
    seed.source=await seedRoundInput(f,owner,{texts:[texts.source]});
    await markExtractionInterrupted(f.client,seed.source.task,seed.source.round);
    await f.client.query("UPDATE source_document SET status='delete_requested' WHERE id=$1",[seed.source.source]);
    seed.repair=await seedRoundInput(f,owner,{texts:[texts.repair]});
    await markExtractionInterrupted(f.client,seed.repair.task,seed.repair.round,'verification_contract_invalid');
    seed.pending=await seedLayeredInterruption(f,owner,{outcome:'pending'});
    seed.unknown=await seedLayeredInterruption(f,owner,{outcome:'unknown'});
    seed.version=await seedLayeredInterruption(f,owner,{versionMismatch:true});
    budgets=(await f.client.query(`SELECT task_id,model_calls_used,model_call_limit
      FROM layered_memory_job ORDER BY task_id`)).rows;
    taskCount=(await f.client.query('SELECT count(*)::int AS n FROM background_task')).rows[0].n;
  },{providerUrl:`http://127.0.0.1:${provider.address().port}`});

  await untilLifecycle(async()=>(await host.client.query(
    `SELECT round.status,task.status AS task_status
     FROM memory_processing_round round JOIN background_task task ON task.id=$2
     WHERE round.id=$1`,[seed.healthy.round,seed.healthy.task],
  )).rows[0]?.status==='completed',20000);
  assert.equal(calls,1);
  assert.equal((await host.request(`/api/contacts/${seed.healthy.contactId}/memory-processing/state`)).data.current.status,'completed');

  const paused=(await host.request(`/api/contacts/${seed.paused.contactId}/memory-processing/state`)).data.current;
  assert.equal(paused.status,'paused');
  assert.deepEqual(paused.actions,['continue']);
  for(const key of ['source','repair','pending','unknown','version']){
    const contact=seed[key].contact??seed[key].contactId;
    const current=(await host.request(`/api/contacts/${contact}/memory-processing/state`)).data.current;
    assert.equal(current.status,'blocked',key);
    assert.deepEqual(current.actions,['pause'],key);
  }
  for(const key of ['paused','source','repair','pending','unknown','version']){
    const fact=(await host.client.query(`SELECT task.status AS task_status,round.status AS round_status
      FROM background_task task JOIN memory_processing_round round ON round.id=$2
      WHERE task.id=$1`,[seed[key].task,seed[key].round])).rows[0];
    assert.deepEqual(fact,{task_status:'failed',round_status:'blocked'},key);
  }
  assert.equal((await host.client.query('SELECT count(*)::int AS n FROM background_task')).rows[0].n,taskCount);
  assert.deepEqual((await host.client.query(`SELECT task_id,model_calls_used,model_call_limit
    FROM layered_memory_job ORDER BY task_id`)).rows,budgets);
});

test('重启只补成功主题后的失败画像，保留原批次、任务与累计预算',{timeout:90000},async t=>{
  const state={text:'双方共同参加过启动恢复合成课程。',memory:null,seen:[],profileSupported:false};
  const provider=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const input=JSON.parse(raw),names=(input.tools??[]).map(tool=>tool.name);
    const toolName=names[0]??input.tools?.[0]?.function?.name;
    if(toolName==='DirectMemoryExtractionOutput'){
      state.seen.push('extraction');
      sendSyntheticTool(res,toolName,{scenes:[]});return;
    }
    if(['read','write','edit'].every(name=>names.includes(name))&&!names.includes('ProfileProposalComplete')){
      state.seen.push('topic');
      if(input.messages.length===1)sendSyntheticTool(res,'write',{path:'round-course.md',content:
        `<!-- META {"topic_key":"restart-course","title":"合成课程","hint":"共同经历"} -->\n\n${state.text}\n`+
        `<!-- SOURCES [{"memory_id":"${state.memory}","revision":1}] -->`});
      else sendSyntheticTool(res);
      return;
    }
    if(names.join(',')==='ScenarioVerificationOutput'){
      state.seen.push('scenario_verification');
      sendSyntheticTool(res,'ScenarioVerificationOutput',{results:[{scenario_index:0,paragraph_index:0,supported:true,
        evidence:[{memory_id:state.memory,quote:state.text}]}]});return;
    }
    if(['read','write','edit'].every(name=>names.includes(name))&&names.includes('ProfileProposalComplete')){
      state.seen.push('profile');
      if(input.messages.length===1)sendSyntheticTool(res,'write',{path:'profile.md',content:`# 长期背景

<!-- ENTRY ${JSON.stringify({kind:'fact',section:'life_context',basis:'合成课程记忆直接记载。',
  temporal_status:'historical',uncertainty:'',references:[{memory_id:state.memory,revision:1}]})} -->
双方有二〇二四年的共同合成课程经历。`});
      else sendSyntheticTool(res);
      return;
    }
    if(names.join(',')==='ProfileVerificationOutput'){
      state.seen.push('profile_verification');
      sendSyntheticTool(res,'ProfileVerificationOutput',{results:[{entry_index:0,
        supported:state.profileSupported,evidence:[{memory_id:state.memory,quote:state.text}]}]});return;
    }
    res.writeHead(500);res.end('{}');
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(async()=>{provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));});

  let seed;
  const host=await lifecycleHost(t,async(f,owner)=>{
    seed=await seedRoundMemory(f,owner,{text:state.text});
    state.memory=seed.memory;
    await f.client.query(`UPDATE layered_memory_state
      SET maintenance_allowed=false,next_due_at=NULL
      WHERE owner_id=$1 AND contact_id=$2`,[owner,seed.contactId]);
  },{providerUrl:`http://127.0.0.1:${provider.address().port}`});
  const root=`/api/contacts/${seed.contactId}/memory-processing`;

  await untilLifecycle(async()=>{
    const facts=(await host.client.query(`SELECT round.status AS round_status,batch.status AS batch_status
      FROM memory_processing_round round
      JOIN layered_memory_batch batch ON batch.owner_id=round.owner_id AND batch.contact_id=round.contact_id
      WHERE round.id=$1 AND batch.status='succeeded'`,[seed.round])).rows;
    const profile=(await host.client.query(`SELECT status FROM layered_profile_batch
      WHERE owner_id=$1 AND contact_id=$2`,[host.owner,seed.contactId])).rows[0];
    return facts[0]?.round_status==='blocked'&&profile?.status==='failed';
  },30000);
  const before={
    batches:(await host.client.query(`SELECT id,status,settings_generation FROM layered_memory_batch
      WHERE owner_id=$1 AND contact_id=$2 ORDER BY id`,[host.owner,seed.contactId])).rows,
    profiles:(await host.client.query(`SELECT id,status,attempt_count FROM layered_profile_batch
      WHERE owner_id=$1 AND contact_id=$2 ORDER BY id`,[host.owner,seed.contactId])).rows,
    budgets:(await host.client.query(`SELECT task_id,model_calls_used,model_call_limit,target_manifest
      FROM layered_memory_job WHERE owner_id=$1 AND contact_id=$2`,[host.owner,seed.contactId])).rows,
    tasks:(await host.client.query(`SELECT task_id FROM memory_processing_round_task
      WHERE round_id=$1 ORDER BY task_id`,[seed.round])).rows,
    seen:[...state.seen],
  };
  const blocked=(await host.request(`${root}/state`)).data;
  assert.equal(blocked.current.status,'blocked');
  assert.ok(blocked.current.actions.includes('continue'));
  assert.equal((await host.request(`/api/contacts/${seed.contactId}/layered-memory`)).data.layered_memory.scenarios.length,1);

  await host.stopHost();
  state.profileSupported=true;
  await host.restartHost();
  await untilLifecycle(async()=>(await host.client.query(
    'SELECT status FROM memory_processing_round WHERE id=$1',[seed.round],
  )).rows[0]?.status==='completed',25000);
  const completed=(await host.request(`${root}/state`)).data.current;
  assert.equal(completed.status,'completed');
  assert.equal(completed.round_id,seed.round);
  const afterRestartSeen=state.seen.slice(before.seen.length);
  assert.equal(afterRestartSeen.includes('topic'),false);
  assert.equal(afterRestartSeen.includes('scenario_verification'),false);
  assert.ok(afterRestartSeen.includes('profile'));
  assert.ok(afterRestartSeen.includes('profile_verification'));

  const batches=(await host.client.query(`SELECT id,status,settings_generation FROM layered_memory_batch
    WHERE owner_id=$1 AND contact_id=$2 ORDER BY id`,[host.owner,seed.contactId])).rows;
  assert.deepEqual(batches,before.batches);
  const profiles=(await host.client.query(`SELECT id,status FROM layered_profile_batch
    WHERE owner_id=$1 AND contact_id=$2 ORDER BY id`,[host.owner,seed.contactId])).rows;
  assert.deepEqual(profiles,before.profiles.map(row=>({id:row.id,status:'succeeded'})));
  const budgets=(await host.client.query(`SELECT task_id,model_calls_used,model_call_limit,target_manifest
    FROM layered_memory_job WHERE owner_id=$1 AND contact_id=$2 AND task_id=$3`,
  [host.owner,seed.contactId,before.budgets[0].task_id])).rows;
  assert.equal(budgets.length,1);
  assert.equal(budgets[0].model_call_limit,before.budgets[0].model_call_limit);
  assert.deepEqual(budgets[0].target_manifest,before.budgets[0].target_manifest);
  assert.ok(Number(budgets[0].model_calls_used)>Number(before.budgets[0].model_calls_used));
  assert.ok(Number(budgets[0].model_calls_used)<=Number(budgets[0].model_call_limit));
  assert.deepEqual((await host.client.query(`SELECT task_id FROM memory_processing_round_task
    WHERE round_id=$1 ORDER BY task_id`,[seed.round])).rows,before.tasks);
  const layered=(await host.request(`/api/contacts/${seed.contactId}/layered-memory`)).data.layered_memory;
  assert.equal(layered.scenarios.length,1);
  assert.equal(layered.profile.entries.length,1);

  const seenAtCompletion=state.seen.length,budgetAtCompletion=budgets[0].model_calls_used;
  await host.restartHost();
  assert.equal(state.seen.length,seenAtCompletion);
  assert.equal((await host.client.query(`SELECT model_calls_used FROM layered_memory_job
    WHERE owner_id=$1 AND contact_id=$2`,[host.owner,seed.contactId])).rows[0].model_calls_used,budgetAtCompletion);
});

test('启动恢复覆盖本人范围且不触碰联系人任务',{timeout:60000},async t=>{
  let calls=0,ids;
  const provider=createServer(async(req,res)=>{
    calls++;
    res.writeHead(500,{'content-type':'application/json'});
    res.end('{}');
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(async()=>{provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));});
  const host=await lifecycleHost(t,async(f,owner)=>{
    const contact=randomUUID(),scope=randomUUID(),round=randomUUID(),task=randomUUID();
    ids={contact,scope,round,task};
    await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'不应触碰的合成联系人')",[contact,owner]);
    await f.client.query('INSERT INTO memory_processing_scope(id,owner_id,contact_id) VALUES($1,$2,NULL)',[scope,owner]);
    await f.client.query(`INSERT INTO memory_processing_round
      (id,scope_id,owner_id,contact_id,round_number,control_generation,status,phase,target_unit,target_count)
      VALUES($1,$2,$3,NULL,1,0,'blocked','topics','memories',0)`,[round,scope,owner]);
    await f.client.query('UPDATE memory_processing_scope SET active_round_id=$1 WHERE id=$2',[round,scope]);
    await f.client.query(`INSERT INTO background_task
      (id,owner_id,contact_id,task_type,status,current_step,message_count,last_error_code,finished_at)
      VALUES($1,$2,NULL,'layered_memory','failed','organize_memory',0,'lease_expired',now())`,[task,owner]);
    await f.client.query(`INSERT INTO background_task_step
      (task_id,step_name,step_order,status,attempt_count,last_error_code,finished_at)
      VALUES($1,'organize_memory',1,'failed',1,'lease_expired',now())`,[task]);
    await f.client.query('INSERT INTO memory_processing_round_task(round_id,task_id,owner_id,contact_id) VALUES($1,$2,$3,NULL)',
      [round,task,owner]);
    await f.client.query(`INSERT INTO layered_memory_state
      (owner_id,contact_id,enabled,settings_generation,organization_generation,status,maintenance_allowed)
      VALUES($1,NULL,true,0,0,'failed',false)`,[owner]);
    await f.client.query(`INSERT INTO layered_memory_generation
      (owner_id,contact_id,organization_generation,schema_version,scenario_version_ids)
      VALUES($1,NULL,0,2,'{}')`,[owner]);
    await f.client.query(`INSERT INTO layered_memory_job
      (task_id,owner_id,contact_id,settings_generation,target_key,contract,target_manifest,
       dependency_ids,state,run_remaining,pending_receipt,model_calls_used,model_call_limit,profile_required)
      VALUES($1,$2,NULL,0,$3,'scenario-v3:document-tools-v1','[]','{}','active',1,false,0,2,false)`,
    [task,owner,`synthetic-owner:${task}`]);
  },{providerUrl:`http://127.0.0.1:${provider.address().port}`});

  await untilLifecycle(async()=>(await host.client.query(
    'SELECT status FROM memory_processing_round WHERE id=$1',[ids.round],
  )).rows[0]?.status==='completed',20000);
  const state=(await host.request('/api/owner/memory-processing/state')).data.current;
  assert.equal(state.status,'completed');
  assert.equal(state.round_id,ids.round);
  assert.equal(calls,0);
  assert.deepEqual((await host.client.query(`SELECT scope.id
    FROM memory_processing_scope scope WHERE scope.owner_id=$1 AND scope.contact_id=$2`,
  [host.owner,ids.contact])).rows,[]);
  assert.deepEqual((await host.client.query(`SELECT task.id
    FROM background_task task WHERE task.owner_id=$1 AND task.contact_id=$2`,
  [host.owner,ids.contact])).rows,[]);
});
