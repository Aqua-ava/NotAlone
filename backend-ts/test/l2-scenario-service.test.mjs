import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {L2ScenarioService} from '../src/l2-scenario-service.ts';
import {readReplyContactOverview} from '../src/reply-context-overview.ts';
import {captureLayeredSnapshot,validateLayeredSnapshot} from '../src/reply-context-layered.ts';

const budget = {
  max_memories: 20,
  max_batch_memories: 20,
  max_scenarios: 15,
  max_paragraphs: 40,
  max_characters: 128_000,
  max_model_calls: 8,
};
const binding = {provider:'synthetic-provider', model:'synthetic-model', maxTokens:512, temperature:0, reasoningEffort:'off'};
const profile = {context_window_tokens:32_000, safety_margin_tokens:512};

function markdown(memory, text = memory.text) {
  return `<!-- META ${JSON.stringify({topic_key:'synthetic-course',title:'合成课程',hint:'共同经历与当前状态'})} -->

${text}
<!-- SOURCES ${JSON.stringify([{memory_id:memory.memoryId,revision:1}])} -->`;
}

function fakePort(memory, hooks = {}) {
  let calls = 0;
  return {
    get calls() { return calls; },
    async call(input) {
      calls++;
      await input.requireCurrent();
      await hooks.before?.(calls, input);
      if (hooks.failAt === calls) throw new Error('synthetic_model_failed');
      const tool = call => ({blocks:[{type:'tool-call',id:`call-${calls}`,name:call.name,arguments:JSON.stringify(call.arguments)}],receipt_id:randomUUID()});
      if (calls === 1) return tool({name:'write',arguments:{path:'course.md',content:markdown(memory)}});
      if (calls === 2) return {blocks:[],receipt_id:randomUUID()};
      if (calls === 3) return tool({name:'ScenarioVerificationOutput',arguments:{results:[{
        scenario_index:0,paragraph_index:0,supported:true,
        evidence:[{memory_id:memory.memoryId,quote:memory.text}],
      }]}});
      throw new Error('synthetic_unexpected_call');
    },
  };
}

async function createScope(f, {owner = false, text = '双方共同参加过合成课程。'} = {}) {
  const ownerId=randomUUID(),contactId=owner?null:randomUUID(),taskId=randomUUID(),stepId=randomUUID(),workerId=randomUUID(),memoryId=randomUUID();
  await f.client.query("INSERT INTO owner(id,display_name)VALUES($1,'合成所有者')",[ownerId]);
  if(contactId) await f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成联系人')",[contactId,ownerId]);
  if(owner){
    await f.client.query("INSERT INTO owner_memory(id,owner_id,text_content,category,topic,source_ids,adoption_method)VALUES($1,$2,$3,'common_fact','study',$4,'manual')",[memoryId,ownerId,text,[ownerId]]);
  }else{
    const source=randomUUID();
    await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'manual','synthetic-manual',$4,1)",[source,ownerId,contactId,'a'.repeat(64)]);
    await f.client.query("INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method)VALUES($1,$2,$3,$4,'common_fact','study',$5,'manual')",[memoryId,ownerId,contactId,text,[source]]);
  }
  await f.client.query("INSERT INTO background_task(id,owner_id,contact_id,task_type,status,current_step,message_count)VALUES($1,$2,$3,'layered_memory','running','organize_memory',0)",[taskId,ownerId,contactId]);
  await f.client.query("INSERT INTO background_task_step(id,task_id,step_name,step_order,status,worker_id,lease_generation,attempt_count,lease_expires_at)VALUES($1,$2,'organize_memory',1,'running',$3,1,1,now()+interval '10 minutes')",[stepId,taskId,workerId]);
  await f.client.query("INSERT INTO layered_memory_state(owner_id,contact_id,enabled,settings_generation,status,organization_generation)VALUES($1,$2,true,1,'stale',0) ON CONFLICT DO NOTHING",[ownerId,contactId]);
  await f.client.query("UPDATE layered_memory_state SET enabled=true,settings_generation=1,status='stale',organization_generation=0 WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid",[ownerId,contactId]);
  await f.client.query("INSERT INTO layered_memory_job(task_id,owner_id,contact_id,settings_generation,target_key,contract,target_manifest,dependency_ids,state,run_remaining,model_call_limit,profile_required)VALUES($1,$2,$3,1,$4,'scenario-v3:document-tools-v1','[]','{}','active',1,$5,false)",
    [taskId,ownerId,contactId,`synthetic:${taskId}`,budget.max_model_calls]);
  return {
    ownerId,contactId,memoryId,taskId,
    scope:{owner_id:ownerId,contact_id:contactId},
    claim:{task_id:taskId,step_id:stepId,step_name:'organize_memory',worker_id:workerId,lease_generation:1},
    memory:{memoryId,text},
  };
}

async function addMemory(f,x,text){
  const source=randomUUID(),memory=randomUUID();
  await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'manual',$4,$5,1)",
    [source,x.ownerId,x.contactId,`synthetic-${source}`,source.replaceAll('-','').padEnd(64,'0')]);
  await f.client.query("INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method)VALUES($1,$2,$3,$4,'common_fact','study',$5,'manual')",
    [memory,x.ownerId,x.contactId,text,[source]]);
  return {source,memory:{memoryId:memory,text}};
}

async function addScenarioReply(f,x,versionId){
  const request=randomUUID();
  await f.client.query(`INSERT INTO reply_request
    (id,owner_id,contact_id,conversation_binding_id,idempotency_key,normalized_input,state,attempt,lease_expires_at,context_snapshot,skill_library_revision)
    VALUES($1,$2,$3,$4,$5,'合成请求','completed',1,now(),$6,0)`,
  [request,x.ownerId,x.contactId,randomUUID(),randomUUID(),{navigation_dependency_ids:[versionId]}]);
  return request;
}

function service(f, port) {
  const transaction=async work=>{await f.client.query('BEGIN');try{const value=await work(f.client);await f.client.query('COMMIT');return value;}catch(error){await f.client.query('ROLLBACK');throw error;}};
  return new L2ScenarioService({transaction,model:port,binding,profile,budget,now:()=>new Date('2026-10-25T02:00:00Z')});
}

async function addTask(f,x){
  const taskId=randomUUID(),stepId=randomUUID(),workerId=randomUUID();
  await f.client.query("INSERT INTO background_task(id,owner_id,contact_id,task_type,status,current_step,message_count)VALUES($1,$2,$3,'layered_memory','running','organize_memory',0)",[taskId,x.ownerId,x.contactId]);
  await f.client.query("INSERT INTO background_task_step(id,task_id,step_name,step_order,status,worker_id,lease_generation,attempt_count,lease_expires_at)VALUES($1,$2,'organize_memory',1,'running',$3,1,1,now()+interval '10 minutes')",[stepId,taskId,workerId]);
  await f.client.query("INSERT INTO layered_memory_job(task_id,owner_id,contact_id,settings_generation,target_key,contract,target_manifest,dependency_ids,state,run_remaining,model_call_limit,profile_required)VALUES($1,$2,$3,1,$4,'scenario-v3:document-tools-v1','[]','{}','active',1,$5,false)",[taskId,x.ownerId,x.contactId,`synthetic:${taskId}`,budget.max_model_calls]);
  return {task_id:taskId,step_id:stepId,step_name:'organize_memory',worker_id:workerId,lease_generation:1};
}

test('合成PG：合格记忆经受控文档、核验后事务发布；回放幂等且可查看追溯与撤回',async()=>{
  const f=await createStorageFixture();try{
    const x=await createScope(f),port=fakePort(x.memory),l2=service(f,port);
    const overview=await readReplyContactOverview(f.client,x.scope);
    assert.equal(overview.entries.length,1,JSON.stringify(overview.entries));
    assert.equal(overview.entries[0].is_latest,true);
    assert.equal(overview.entries[0].provenance.kind,'manual_entry');
    const additional=await addMemory(f,x,'双方共同整理过合成课程笔记。');
    const run=await l2.run(x.scope,x.claim,new AbortController().signal);
    assert.equal(run.status,'completed');
    assert.equal(port.calls,3);
    assert.equal(run.state.status,'ready');
    assert.equal(run.state.scenarios.length,1);
    assert.equal(run.state.scenarios[0].paragraphs[0].text,x.memory.text);
    assert.equal(run.state.scenarios[0].paragraphs[0].references[0].memory_id,x.memoryId);
    assert.equal((await f.client.query("SELECT count(*)::int n FROM scenario_document_version WHERE owner_id=$1 AND contact_id=$2",[x.ownerId,x.contactId])).rows[0].n,1);
    assert.equal((await f.client.query("SELECT count(*)::int n FROM layered_memory_generation WHERE owner_id=$1 AND contact_id=$2",[x.ownerId,x.contactId])).rows[0].n,1);
    const replay=await l2.run(x.scope,x.claim,new AbortController().signal);
    assert.equal(replay.status,'idle');assert.equal(replay.state.scenarios.length,1);assert.equal(port.calls,3);
    assert.deepEqual((await f.client.query("SELECT settings_generation,organization_generation FROM layered_memory_state WHERE owner_id=$1 AND contact_id=$2",[x.ownerId,x.contactId])).rows[0],
      {settings_generation:'1',organization_generation:'1'});
    const firstDocument=run.state.scenarios[0];
    let updateCalls=0;
    const updatePort={async call(input){
      updateCalls++;await input.requireCurrent();
      const tool=(name,args)=>({blocks:[{type:'tool-call',id:`update-${updateCalls}`,name,arguments:JSON.stringify(args)}],receipt_id:randomUUID()});
      if(updateCalls===1)return tool('read',{path:`${firstDocument.scenario_id}.md`});
      if(updateCalls===2)return tool('edit',{path:`${firstDocument.scenario_id}.md`,edits:[{oldText:'"title":"合成课程"',newText:'"title":"合成课程安排"'}]});
      if(updateCalls===3)return {blocks:[],receipt_id:randomUUID()};
      if(updateCalls===4)return tool('ScenarioVerificationOutput',{results:[{scenario_index:0,paragraph_index:0,supported:true,evidence:[{memory_id:x.memoryId,quote:x.memory.text}]}]});
      throw new Error('unexpected_update_call');
    }};
    const updated=await service(f,updatePort).run(x.scope,await addTask(f,x),new AbortController().signal);
    assert.equal(updated.status,'completed');assert.equal(updated.state.organization_generation,2);
    assert.equal(updated.state.scenarios[0].scenario_id,firstDocument.scenario_id);
    assert.notEqual(updated.state.scenarios[0].version_id,firstDocument.version_id);
    assert.equal(updated.state.scenarios[0].title,'合成课程安排');
    assert.equal((await f.client.query("SELECT count(*)::int n FROM scenario_document_version WHERE owner_id=$1 AND contact_id=$2 AND scenario_id=$3",[x.ownerId,x.contactId,firstDocument.scenario_id])).rows[0].n,2);
    assert.equal(updated.state.scenario_mappings.length,1);
    assert.equal(updated.state.scenario_mappings[0].source_version_id,firstDocument.version_id);
    assert.equal(updated.state.scenario_mappings[0].targets[0].version_id,updated.state.scenarios[0].version_id);
    await assert.rejects(l2.read(x.scope,'invalid-cursor'),/mapping_cursor_invalid/);
    await assert.rejects(l2.read(x.scope,'999:0'),/mapping_cursor_stale/);
    const document=updated.state.scenarios[0];
    const frozen=await captureLayeredSnapshot(f.client,x.scope);
    assert.ok(frozen);
    const dependentReply=await addScenarioReply(f,x,document.version_id);
    const operationId=randomUUID();
    const corrected=await l2.reportParagraphError(x.scope,{
      settings_generation:updated.state.settings_generation,
      organization_generation:updated.state.organization_generation,
      version_id:document.version_id,item_index:0,memory_id:x.memoryId,
      operation_id:operationId,reason:'合成段落需要撤回并重新核验。',
    });
    assert.deepEqual(corrected.scenarios,[]);
    assert.equal(await validateLayeredSnapshot(f.client,frozen),false);
    assert.equal(corrected.feedback.length,1);
    assert.equal(corrected.feedback[0].target_kind,'scenario');
    assert.equal(corrected.feedback[0].target_text,document.paragraphs[0].text);
    assert.equal(corrected.eligible_count,2);
    assert.equal(corrected.protected_count,2);
    assert.equal((await f.client.query('SELECT count(*)::int n FROM reply_request WHERE id=$1',[dependentReply])).rows[0].n,0);
    const feedbackTarget=(await f.client.query('SELECT protected_memory_ids,protected_message_ids FROM layered_memory_feedback WHERE operation_id=$1',[operationId])).rows[0];
    assert.deepEqual([...feedbackTarget.protected_memory_ids].sort(),[x.memoryId,additional.memory.memoryId].sort());
    assert.deepEqual(feedbackTarget.protected_message_ids,[]);
    assert.equal((await f.client.query(`SELECT count(*)::int n FROM scenario_document_version v
      JOIN layered_memory_state s ON s.owner_id=v.owner_id AND s.contact_id=v.contact_id
      JOIN layered_memory_generation g ON g.owner_id=s.owner_id AND g.contact_id=s.contact_id
        AND g.organization_generation=s.organization_generation
      WHERE v.owner_id=$1 AND v.contact_id=$2 AND v.id=ANY(g.scenario_version_ids)`,[x.ownerId,x.contactId])).rows[0].n,0);
    const replayCorrection=await l2.reportParagraphError(x.scope,{
      settings_generation:updated.state.settings_generation,
      organization_generation:updated.state.organization_generation,
      version_id:document.version_id,item_index:0,memory_id:x.memoryId,
      operation_id:operationId,reason:'合成段落需要撤回并重新核验。',
    });
    assert.equal(replayCorrection.feedback.length,1);
    await f.client.query(`UPDATE layered_memory_feedback SET state='erased_guard',reason=NULL,rejected_text=NULL,
      request_digest=NULL,version_id=NULL,input_manifest='[]',dependency_ids='{}' WHERE operation_id=$1`,[operationId]);
    const guarded=await l2.read(x.scope);
    assert.equal(guarded.feedback[0].state,'erased_guard');
    assert.equal(guarded.feedback[0].reason,null);
    assert.equal(guarded.feedback[0].target_text,null);
    assert.equal(guarded.protected_count,2);
    const third=await addMemory(f,x,'双方仍有独立的合成资料。');
    const nextWork=await l2.prepare(x.scope,await addTask(f,x));
    assert.deepEqual(nextWork.inputs.map(memory=>memory.memory_id),[third.memory.memoryId]);
  }finally{await f.close();}
});

test('合成PG：停用、人工修正、来源删除、并发世代、模型失败和取消都不发布旧文档',async()=>{
  const f=await createStorageFixture();try{
    const cases=[
      ['disabled',async () => f.client.query("UPDATE layered_memory_state SET enabled=false")],
      ['manual correction',async x => f.client.query("UPDATE layered_memory_state SET correction_revision=correction_revision+1 WHERE owner_id=$1 AND contact_id=$2",[x.ownerId,x.contactId])],
      ['source deletion',async x => f.client.query("UPDATE source_document SET status='deleted' WHERE owner_id=$1 AND contact_id=$2",[x.ownerId,x.contactId])],
      ['concurrent generation',async x => f.client.query("UPDATE layered_memory_state SET organization_generation=organization_generation+1 WHERE owner_id=$1 AND contact_id=$2",[x.ownerId,x.contactId])],
    ];
    for(const [name,change] of cases){
      const x=await createScope(f),port=fakePort(x.memory,{before:async call=>{if(call===2)await change(x);}}),l2=service(f,port);
      await assert.rejects(l2.run(x.scope,x.claim,new AbortController().signal),undefined,name);
      assert.equal((await f.client.query("SELECT count(*)::int n FROM scenario_document_version WHERE owner_id=$1 AND contact_id=$2",[x.ownerId,x.contactId])).rows[0].n,0,name);
      assert.equal(port.calls,2,name);
    }
    const stale=await createScope(f),staleService=service(f,fakePort(stale.memory));
    const staleWork=await staleService.prepare(stale.scope,stale.claim);
    assert.ok(staleWork);
    await f.client.query("UPDATE background_task_step SET lease_generation=2,worker_id=$2 WHERE id=$1",[stale.claim.step_id,randomUUID()]);
    await staleService.fail(staleWork,'synthetic_stale_failure');
    assert.equal((await f.client.query('SELECT status FROM layered_memory_state WHERE owner_id=$1 AND contact_id=$2',[stale.ownerId,stale.contactId])).rows[0].status,'updating');
    assert.equal((await f.client.query('SELECT status FROM layered_memory_batch WHERE id=$1',[staleWork.batch_id])).rows[0].status,'running');
    const failed=await createScope(f),failedPort=fakePort(failed.memory,{failAt:1});
    await assert.rejects(service(f,failedPort).run(failed.scope,failed.claim,new AbortController().signal),/model_failed/);
    assert.equal((await f.client.query("SELECT count(*)::int n FROM scenario_document_version WHERE owner_id=$1 AND contact_id=$2",[failed.ownerId,failed.contactId])).rows[0].n,0);
    assert.equal((await f.client.query("SELECT status FROM layered_memory_state WHERE owner_id=$1 AND contact_id=$2",[failed.ownerId,failed.contactId])).rows[0].status,'failed');
    const cancelled=await createScope(f),controller=new AbortController();
    const cancelPort=fakePort(cancelled.memory,{before:async call=>{if(call===2){controller.abort();}}});
    await assert.rejects(service(f,cancelPort).run(cancelled.scope,cancelled.claim,controller.signal),/aborted|cancel/i);
    assert.equal((await f.client.query("SELECT count(*)::int n FROM scenario_document_version WHERE owner_id=$1 AND contact_id=$2",[cancelled.ownerId,cancelled.contactId])).rows[0].n,0);
  }finally{await f.close();}
});

test('合成PG：场景撤回同步清除回复副本并使冻结快照失效',async()=>{
  const f=await createStorageFixture();try{
    const x=await createScope(f),l2=service(f,fakePort(x.memory));
    const ready=await l2.run(x.scope,x.claim,new AbortController().signal),document=ready.state.scenarios[0];
    const frozen=await captureLayeredSnapshot(f.client,x.scope);
    assert.ok(frozen);
    const dependentReply=await addScenarioReply(f,x,document.version_id);
    const withdrawn=await l2.withdrawScenario(
      x.scope,
      ready.state.settings_generation,
      ready.state.organization_generation,
      document.version_id,
    );
    assert.deepEqual(withdrawn.scenarios,[]);
    assert.equal(await validateLayeredSnapshot(f.client,frozen),false);
    assert.equal((await f.client.query('SELECT count(*)::int n FROM reply_request WHERE id=$1',[dependentReply])).rows[0].n,0);
    await assert.rejects(l2.withdrawScenario(
      x.scope,
      ready.state.settings_generation,
      ready.state.organization_generation,
      document.version_id,
    ),/changed|stale/);
  }finally{await f.close();}
});

test('合成PG：同一纠错操作不能跨停用再启用世代回放',async()=>{
  const f=await createStorageFixture();try{
    const x=await createScope(f),port=fakePort(x.memory),l2=service(f,port);
    const ready=await l2.run(x.scope,x.claim,new AbortController().signal),document=ready.state.scenarios[0],operationId=randomUUID();
    const command={
      settings_generation:ready.state.settings_generation,
      organization_generation:ready.state.organization_generation,
      version_id:document.version_id,item_index:0,memory_id:x.memoryId,
      operation_id:operationId,reason:'合成世代隔离。',
    };
    await l2.reportParagraphError(x.scope,command);
    await f.client.query('UPDATE layered_memory_state SET settings_generation=settings_generation+1 WHERE owner_id=$1 AND contact_id=$2',[x.ownerId,x.contactId]);
    await assert.rejects(l2.reportParagraphError(x.scope,command),/operation_changed/);
  }finally{await f.close();}
});

test('合成PG：本人NULL范围同样从合法记忆经过独立工作、发布和读取',async()=>{
  const f=await createStorageFixture();try{
    const x=await createScope(f,{owner:true,text:'本人偏好周末阅读。'}),port=fakePort(x.memory),l2=service(f,port);
    const run=await l2.run(x.scope,x.claim,new AbortController().signal);
    assert.equal(run.status,'completed');
    assert.equal(run.state.scope_kind,'owner');assert.equal(run.state.contact_id,null);
    assert.equal(run.state.scenarios[0].scenario_id.length,36);
    assert.equal((await f.client.query("SELECT count(*)::int n FROM scenario_document_version WHERE owner_id=$1 AND contact_id IS NULL",[x.ownerId])).rows[0].n,1);
  }finally{await f.close();}
});
