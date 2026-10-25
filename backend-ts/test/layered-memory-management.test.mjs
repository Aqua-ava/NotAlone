import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {managementFixture,completeManagementTask} from './layered-memory-management-fixture.mjs';
import {L2ScenarioService} from '../src/l2-scenario-service.ts';
import {DEFAULT_L2_SCENARIO_BUDGET} from '../src/l2-scenario-workspace.ts';

test('公开开启生成唯一合法覆盖任务，暂停使原租约晚写失效', async t => {
  const f=await managementFixture(t);
  const initial=await f.request();
  assert.equal(initial.status,200);
  const generation=initial.body.layered_memory.settings_generation;
  const enabled=await f.request('enable',{settings_generation:generation,purpose_confirmed:true});
  assert.equal(enabled.status,200);
  const state=enabled.body.layered_memory;
  assert.equal(state.enabled,true);
  assert.equal(state.status,'updating');
  assert.equal(state.remaining_count,1);
  assert.equal(state.settings_generation,generation+1);
  assert.match(state.work_id,/^[0-9a-f-]{36}$/);
  const repeated=await f.request('enable',{settings_generation:generation,purpose_confirmed:true});
  assert.equal(repeated.status,200);
  assert.equal(repeated.body.layered_memory.work_id,state.work_id);
  const claim=await f.store.claim(f.taskScope,{taskId:state.work_id,workerId:randomUUID(),leaseMs:30_000,supportedSteps:['organize_memory']});
  assert.equal(claim.taskId,state.work_id);
  const paused=await f.request('pause',{settings_generation:state.settings_generation,work_revision:state.work_revision});
  assert.equal(paused.status,200);
  assert.equal(paused.body.layered_memory.status,'paused');
  assert.equal(paused.body.layered_memory.work_id,state.work_id);
  assert.equal(paused.body.layered_memory.work_revision,state.work_revision+1);
  await assert.rejects(f.store.complete(claim,1));
  assert.equal(await f.store.claim(f.taskScope,{taskId:state.work_id,workerId:randomUUID(),leaseMs:30_000,supportedSteps:['organize_memory']}),null);
});

test('继续只为原暂停工作增加一轮有限额度，重复动作不加额', async t => {
  const f=await managementFixture(t);
  const initial=(await f.request()).body.layered_memory;
  const active=(await f.request('enable',{settings_generation:initial.settings_generation,purpose_confirmed:true})).body.layered_memory;
  const paused=(await f.request('pause',{settings_generation:active.settings_generation,work_revision:active.work_revision})).body.layered_memory;
  const body={settings_generation:paused.settings_generation,work_revision:paused.work_revision};
  const resumed=await f.request('continue',body);
  assert.equal(resumed.status,200);
  assert.equal(resumed.body.layered_memory.work_id,active.work_id);
  assert.equal(resumed.body.layered_memory.status,'updating');
  assert.equal(resumed.body.layered_memory.model_call_limit,active.model_call_limit*2);
  const repeated=await f.request('continue',body);
  assert.equal(repeated.status,200);
  assert.equal(repeated.body.layered_memory.model_call_limit,resumed.body.layered_memory.model_call_limit);
  const claim=await f.store.claim(f.taskScope,{taskId:active.work_id,workerId:randomUUID(),leaseMs:30_000,supportedSteps:['organize_memory']});
  assert.equal(claim.taskId,active.work_id);
});

test('公开任务真实产生L2与L3，停用保留合法历史，删除清除派生正文并拒绝旧请求', async t => {
  const f=await managementFixture(t);
  const initial=(await f.request()).body.layered_memory;
  const active=(await f.request('enable',{settings_generation:initial.settings_generation,purpose_confirmed:true})).body.layered_memory;
  const completed=await completeManagementTask(f,active);
  assert.equal(completed.result.state.scenarios.length,1);
  assert.equal(completed.result.state.profile.entries.length,1);
  const disabled=await f.request('disable',{settings_generation:active.settings_generation});
  assert.equal(disabled.status,200);
  assert.equal(disabled.body.layered_memory.enabled,false);
  assert.equal(disabled.body.layered_memory.status,'disabled');
  assert.equal(disabled.body.layered_memory.scenarios.length,1);
  assert.equal(disabled.body.layered_memory.profile.entries.length,1);
  const deleted=await f.request('delete',{settings_generation:disabled.body.layered_memory.settings_generation});
  assert.equal(deleted.status,200);
  const state=deleted.body.layered_memory;
  assert.equal(state.enabled,false);
  assert.deepEqual(state.scenarios,[]);
  assert.equal(state.profile,null);
  assert.equal(state.covered_count,0);
  for(const table of ['layered_memory_batch','layered_profile_batch','scenario_document_version','layered_profile_version','layered_memory_feedback','layered_memory_fact_correction']){
    assert.equal((await f.pool.query(`SELECT count(*)::int count FROM public.${table} WHERE owner_id=$1 AND contact_id=$2`,[f.ownerId,f.contactId])).rows[0].count,0);
  }
  assert.equal((await f.request('refresh',{settings_generation:active.settings_generation})).status,409);
  assert.equal((await f.pool.query('SELECT text_content FROM confirmed_memory WHERE id=$1',[f.memoryId])).rows[0].text_content,'双方曾共同参加合成课程。');
});

test('画像事实报错持久定位实际叶版本，重复请求不复活派生内容', async t => {
  const f=await managementFixture(t);
  const initial=(await f.request()).body.layered_memory;
  const active=(await f.request('enable',{settings_generation:initial.settings_generation,purpose_confirmed:true})).body.layered_memory;
  await completeManagementTask(f,active);
  const ready=(await f.request()).body.layered_memory;
  const body={settings_generation:ready.settings_generation,organization_generation:ready.organization_generation,
    target_kind:'profile',version_id:ready.profile.version_id,item_index:0,memory_id:f.memoryId};
  const reported=await f.request('fact-error',body);
  assert.equal(reported.status,200);
  const state=reported.body.layered_memory;
  assert.deepEqual(state.correction_target,{memory_id:f.memoryId,revision:1});
  assert.equal(state.pending_fact_count,1);
  assert.equal(state.profile,null);
  assert.deepEqual(state.scenarios,[]);
  const repeated=await f.request('fact-error',body);
  assert.equal(repeated.status,200);
  assert.equal(repeated.body.layered_memory.pending_fact_count,1);
  const memory=(await f.pool.query('SELECT status,adoption_method FROM confirmed_memory WHERE id=$1',[f.memoryId])).rows[0];
  assert.deepEqual(memory,{status:'active',adoption_method:'manual'});
});

test('事实待修的原叶不再交给模型，修正后的新合法叶仍可整理', async t => {
  const f=await managementFixture(t);
  const initial=(await f.request()).body.layered_memory;
  const active=(await f.request('enable',{settings_generation:initial.settings_generation,purpose_confirmed:true})).body.layered_memory;
  await completeManagementTask(f,active);
  const ready=(await f.request()).body.layered_memory;
  await f.request('fact-error',{settings_generation:ready.settings_generation,organization_generation:ready.organization_generation,
    target_kind:'scenario',version_id:ready.scenarios[0].version_id,item_index:0,memory_id:f.memoryId});
  const otherMemory=randomUUID();
  await f.pool.query(`INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method)
    VALUES($1,$2,$3,'双方共同完成过合成练习。','common_fact','study',$4,'manual')`,[otherMemory,f.ownerId,f.contactId,[f.sourceId]]);
  const refreshed=await f.request('refresh',{settings_generation:active.settings_generation});
  assert.equal(refreshed.status,200);
  const state=refreshed.body.layered_memory;
  const claim=await f.store.claim(f.taskScope,{taskId:state.work_id,workerId:randomUUID(),leaseMs:30_000,supportedSteps:['organize_memory']});
  const service=new L2ScenarioService({transaction:f.transaction,model:{async call(){throw new Error('待修原叶不得进入模型');}},
    binding:{provider:'synthetic',model:'synthetic',maxTokens:512,temperature:0,reasoningEffort:'off'},
    profile:{context_window_tokens:128_000,safety_margin_tokens:512},budget:DEFAULT_L2_SCENARIO_BUDGET});
  const prepared=await service.prepare(f.scope,{task_id:claim.taskId,step_id:claim.stepId,step_name:'organize_memory',
    worker_id:claim.workerId,lease_generation:claim.leaseGeneration});
  assert.deepEqual(prepared.inputs.map(input=>input.memory_id),[otherMemory]);
  // 用户修正属于真实 L1 版本动作；不伪造整理成功或沿用旧来源证明。
  const {mutateMemory}=await import('../src/memory-mutations.ts');
  const {lockManagementScope}=await import('../src/layered-memory-management-store.ts');
  const corrected=await f.transaction(async client=>{
    await lockManagementScope(client,f.scope);
    return mutateMemory(client,f.ownerId,{level:'contact',contactId:f.contactId},'correct',f.memoryId,
      {text:'双方只参加过合成讲座。',change_kind:'error_correction'});
  });
  const refreshedNew=(await f.request('refresh',{settings_generation:active.settings_generation})).body.layered_memory;
  const newClaim=await f.store.claim(f.taskScope,{taskId:refreshedNew.work_id,workerId:randomUUID(),leaseMs:30_000,supportedSteps:['organize_memory']});
  const newWork=await service.prepare(f.scope,{task_id:newClaim.taskId,step_id:newClaim.stepId,step_name:'organize_memory',
    worker_id:newClaim.workerId,lease_generation:newClaim.leaseGeneration});
  assert.deepEqual(newWork.inputs.map(input=>input.memory_id).sort(),[otherMemory,corrected.id].sort());
  assert.equal(newWork.inputs.find(input=>input.memory_id===corrected.id).text,'双方只参加过合成讲座。');
});

test('本人L3撤回和主题纠错在模型未配置时仍可用，纠错保护跨停用保留且不跨联系人', async t => {
  let available=true;
  const f=await managementFixture(t,{modelWorkAvailable:()=>available});
  const initial=(await f.request('',undefined,null)).body.layered_memory;
  const active=(await f.request('enable',{settings_generation:initial.settings_generation,purpose_confirmed:true},null)).body.layered_memory;
  await completeManagementTask(f,active,{owner:true});
  const ready=(await f.request('',undefined,null)).body.layered_memory;
  available=false;
  const cross=await f.request('withdraw-profile',{settings_generation:0,organization_generation:ready.organization_generation,
    profile_version_id:ready.profile.version_id});
  assert.equal(cross.status,409);
  const withdrawn=await f.request('withdraw-profile',{settings_generation:ready.settings_generation,
    organization_generation:ready.organization_generation,profile_version_id:ready.profile.version_id},null);
  assert.equal(withdrawn.status,200);
  const state=withdrawn.body.layered_memory;
  assert.equal(state.profile,null);
  assert.equal(state.scenarios.length,1);
  const body={settings_generation:state.settings_generation,organization_generation:state.organization_generation,
    target_kind:'scenario',version_id:state.scenarios[0].version_id,item_index:0,reason:'合成主题概括有误。',operation_id:randomUUID()};
  const corrected=await f.request('summary-error',body,null);
  assert.equal(corrected.status,200);
  assert.equal(corrected.body.layered_memory.feedback.length,1);
  assert.deepEqual(corrected.body.layered_memory.scenarios,[]);
  const repeated=await f.request('summary-error',body,null);
  assert.equal(repeated.status,200);
  assert.equal(repeated.body.layered_memory.feedback.length,1);
  const disabled=(await f.request('disable',{settings_generation:active.settings_generation},null)).body.layered_memory;
  assert.equal(disabled.enabled,false);
  assert.equal((await f.request('enable',{settings_generation:disabled.settings_generation,purpose_confirmed:true},null)).status,503);
  available=true;
  const resumed=await f.request('enable',{settings_generation:disabled.settings_generation,purpose_confirmed:true},null);
  assert.equal(resumed.status,200);
  assert.equal(resumed.body.layered_memory.feedback.length,1);
  assert.equal(resumed.body.layered_memory.protected_count,1);
  const contact=(await f.request()).body.layered_memory;
  assert.equal(contact.feedback.length,0);
  assert.equal(contact.protected_count,0);
  assert.equal(contact.work_id,null);
  const deleted=await f.request('delete',{settings_generation:resumed.body.layered_memory.settings_generation},null);
  assert.equal(deleted.status,200);
  assert.equal(deleted.body.layered_memory.feedback.length,0);
});

test('结果未知的覆盖任务不能通过继续或刷新重放', async t => {
  const f=await managementFixture(t);
  const initial=(await f.request()).body.layered_memory;
  const active=(await f.request('enable',{settings_generation:initial.settings_generation,purpose_confirmed:true})).body.layered_memory;
  const claim=await f.store.claim(f.taskScope,{taskId:active.work_id,workerId:randomUUID(),leaseMs:30_000,supportedSteps:['organize_memory']});
  await f.store.fail(claim,'model_call_outcome_unknown',false);
  const failed=(await f.request()).body.layered_memory;
  const continued=await f.request('continue',{settings_generation:failed.settings_generation,work_revision:failed.work_revision});
  assert.equal(continued.status,409);
  const refreshed=await f.request('refresh',{settings_generation:failed.settings_generation});
  assert.equal(refreshed.status,200);
  assert.equal(refreshed.body.layered_memory.work_id,active.work_id);
  assert.equal(refreshed.body.layered_memory.model_call_limit,active.model_call_limit);
  assert.equal(await f.store.claim(f.taskScope,{taskId:active.work_id,workerId:randomUUID(),leaseMs:30_000,supportedSteps:['organize_memory']}),null);
  await f.pool.query(`INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method)
    VALUES($1,$2,$3,'结果未知后新增合成事实。','common_fact','study',$4,'manual')`,[randomUUID(),f.ownerId,f.contactId,[f.sourceId]]);
  assert.equal((await f.request('refresh',{settings_generation:failed.settings_generation})).status,409);
  assert.equal((await f.request()).body.layered_memory.work_id,active.work_id);
});

test('空合法范围经公开开启确定性完成，不启动模型或留下可领取工作', async t => {
  const f=await managementFixture(t);
  const emptyContact=randomUUID();
  await f.pool.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成空范围')",[emptyContact,f.ownerId]);
  const initial=(await f.request('',undefined,emptyContact)).body.layered_memory;
  assert.equal(initial.work_id,null);
  const enabled=await f.request('enable',{settings_generation:initial.settings_generation,purpose_confirmed:true},emptyContact);
  assert.equal(enabled.status,200);
  const state=enabled.body.layered_memory;
  assert.equal(state.status,'empty');
  assert.equal(state.model_calls_used,0);
  assert.equal(state.remaining_count,0);
  assert.equal(await f.store.claim({ownerId:f.ownerId,contactId:emptyContact},{taskId:state.work_id,
    workerId:randomUUID(),leaseMs:30_000,supportedSteps:['organize_memory']}),null);
  const paused=await f.request('pause',{settings_generation:state.settings_generation,work_revision:state.work_revision},emptyContact);
  assert.equal(paused.status,409);
  assert.equal((await f.request('',undefined,emptyContact)).body.layered_memory.status,'empty');
});

test('并发同代开启只产生一个工作，越权联系人和夹带内部字段均拒绝', async t => {
  const f=await managementFixture(t);
  const initial=(await f.request()).body.layered_memory;
  const body={settings_generation:initial.settings_generation,purpose_confirmed:true};
  const responses=await Promise.all(Array.from({length:4},()=>f.request('enable',body)));
  assert.deepEqual(responses.map(response=>response.status),[200,200,200,200]);
  assert.equal(new Set(responses.map(response=>response.body.layered_memory.work_id)).size,1);
  assert.equal((await f.pool.query("SELECT count(*)::int count FROM background_task WHERE owner_id=$1 AND contact_id=$2 AND task_type='layered_memory'",[f.ownerId,f.contactId])).rows[0].count,1);
  const otherOwner=randomUUID(),otherContact=randomUUID();
  await f.pool.query("INSERT INTO owner(id,display_name) VALUES($1,'其他合成所有者')",[otherOwner]);
  await f.pool.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'其他合成联系人')",[otherContact,otherOwner]);
  assert.equal((await f.request('enable',body,otherContact)).status,404);
  assert.equal((await f.request('enable',{...body,owner_id:otherOwner,verified_scope:{owner_id:f.ownerId,contact_id:f.contactId}})).status,400);
  assert.equal((await f.request('',undefined,otherContact)).status,404);
});

test('首次覆盖超过一批后，显式继续原任务推进剩余真实版本', async t => {
  const f=await managementFixture(t);
  for(let index=0;index<20;index++)await f.pool.query(`INSERT INTO confirmed_memory
    (id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method)
    VALUES($1,$2,$3,$4,'common_fact','study',$5,'manual')`,
  [randomUUID(),f.ownerId,f.contactId,`另一条合成课程事实${index+1}。`,[f.sourceId]]);
  const initial=(await f.request()).body.layered_memory;
  const active=(await f.request('enable',{settings_generation:initial.settings_generation,purpose_confirmed:true})).body.layered_memory;
  assert.equal(active.eligible_count,21);
  await completeManagementTask(f,active);
  const paused=(await f.request()).body.layered_memory;
  assert.equal(paused.covered_count,20);
  assert.equal(paused.remaining_count,1);
  assert.equal(paused.status,'paused');
  const continued=await f.request('continue',{settings_generation:paused.settings_generation,work_revision:paused.work_revision});
  assert.equal(continued.status,200);
  assert.equal(continued.body.layered_memory.work_id,active.work_id);
  await completeManagementTask(f,continued.body.layered_memory,{topic:'synthetic-course-next'});
  const completed=(await f.request()).body.layered_memory;
  assert.equal(completed.covered_count,21);
  assert.equal(completed.remaining_count,0);
  assert.equal(completed.status,'ready');
  assert.equal(completed.work_id,active.work_id);
});

test('入队后新增L1不混入原L2/L3目标，继续不扩大范围，刷新另建真实目标', async t => {
  const f=await managementFixture(t);
  const initial=(await f.request()).body.layered_memory;
  const active=(await f.request('enable',{settings_generation:initial.settings_generation,purpose_confirmed:true})).body.layered_memory;
  const added=randomUUID();
  await f.pool.query(`INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,topic,source_ids,
    adoption_method,created_at) VALUES($1,$2,$3,'新增合成课程事实。','common_fact','study',$4,'manual','2025-01-01Z')`,
  [added,f.ownerId,f.contactId,[f.sourceId]]);
  const completed=await completeManagementTask(f,active);
  assert.equal(completed.result.processed_count,1);
  const batch=(await f.pool.query('SELECT input_manifest FROM layered_memory_batch WHERE task_id=$1',[active.work_id])).rows[0];
  assert.deepEqual(batch.input_manifest.map(item=>item.memory_id),[f.memoryId]);
  const profile=(await f.pool.query('SELECT input_manifest FROM layered_profile_batch WHERE task_id=$1',[active.work_id])).rows[0];
  assert.deepEqual(profile.input_manifest.map(item=>item.memory_id),[f.memoryId]);
  const state=(await f.request()).body.layered_memory;
  assert.equal(state.remaining_count,1);
  assert.equal(state.maintenance_pending,true);
  const continued=await f.request('continue',{settings_generation:state.settings_generation,work_revision:state.work_revision});
  assert.equal(continued.status,409);
  const refreshed=await f.request('refresh',{settings_generation:state.settings_generation});
  assert.equal(refreshed.status,200);
  assert.notEqual(refreshed.body.layered_memory.work_id,active.work_id);
  const target=(await f.pool.query('SELECT target_manifest FROM layered_memory_job WHERE task_id=$1',[refreshed.body.layered_memory.work_id])).rows[0];
  assert.deepEqual(target.target_manifest.map(item=>item.memory_id).sort(),[f.memoryId,added].sort());
});

test('默认到期维护只建合法新工作，读取不调度，暂停和停用不会自动恢复', async t => {
  let clock=Date.now()+1_000;
  const f=await managementFixture(t,{now:()=>new Date(clock)});
  assert.equal((await f.request()).body.layered_memory.work_id,null);
  const first=await f.manager.runMaintenance(new AbortController().signal);
  assert.equal(first.enqueued.length,2);
  const contact=(await f.request()).body.layered_memory;
  const owner=(await f.request('',undefined,null)).body.layered_memory;
  assert.equal(contact.status,'updating');
  assert.equal(owner.status,'updating');
  const again=await f.manager.runMaintenance(new AbortController().signal);
  assert.deepEqual(again.enqueued,[]);
  const paused=await f.request('pause',{settings_generation:owner.settings_generation,work_revision:owner.work_revision},null);
  assert.equal(paused.status,200);
  await f.request('disable',{settings_generation:contact.settings_generation});
  await f.pool.query(`INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method)
    VALUES($1,$2,$3,'停用后新增合成事实。','common_fact','study',$4,'manual')`,[randomUUID(),f.ownerId,f.contactId,[f.sourceId]]);
  await f.pool.query(`INSERT INTO owner_memory(id,owner_id,text_content,category,topic,source_ids,adoption_method)
    VALUES($1,$2,'暂停后新增本人合成事实。','common_fact','study',$3,'manual')`,[randomUUID(),f.ownerId,[f.ownerId]]);
  clock+=1_000;
  assert.deepEqual((await f.manager.runMaintenance(new AbortController().signal)).enqueued,[]);
  assert.equal((await f.request('',undefined,null)).body.layered_memory.status,'paused');
  assert.equal((await f.request()).body.layered_memory.enabled,false);
});

test('有效期边界持久调度合法新输入，到期后撤下旧L2/L3而不重放旧目标', async t => {
  let clock=Date.now()+1_000;
  const f=await managementFixture(t,{now:()=>new Date(clock)});
  const validAt=new Date(clock+2_000).toISOString(),invalidAt=new Date(clock+4_000).toISOString();
  await f.pool.query('UPDATE confirmed_memory SET valid_at=$2,invalid_at=$3 WHERE id=$1',[f.memoryId,validAt,invalidAt]);
  await f.manager.runMaintenance(new AbortController().signal);
  const empty=(await f.request()).body.layered_memory;
  assert.equal(empty.status,'empty');
  assert.equal((await f.pool.query('SELECT next_boundary_at FROM layered_memory_state WHERE owner_id=$1 AND contact_id=$2',
    [f.ownerId,f.contactId])).rows[0].next_boundary_at.toISOString(),validAt);
  clock=Date.parse(validAt)+1;
  await f.manager.runMaintenance(new AbortController().signal);
  const active=(await f.request()).body.layered_memory;
  assert.equal(active.status,'updating');
  await completeManagementTask(f,active);
  const ready=(await f.request()).body.layered_memory;
  assert.equal(ready.scenarios.length,1);
  assert.equal(ready.profile.entries.length,1);
  clock=Date.parse(invalidAt)+1;
  await f.manager.runMaintenance(new AbortController().signal);
  const expired=(await f.request()).body.layered_memory;
  assert.equal(expired.status,'empty');
  assert.deepEqual(expired.scenarios,[]);
  assert.equal(expired.profile,null);
  assert.equal(expired.covered_count,0);
});
