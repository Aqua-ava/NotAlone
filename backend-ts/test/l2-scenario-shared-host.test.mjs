/** 官方DSH共享宿主：L2唯一装配、来源复验、公开管理与关闭排空。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {sendEvents,useTool} from './support.mjs';
import {startReplyServiceHost} from './reply-service-runtime-support.mjs';
import {readReplyContactOverview} from '../src/reply-context-overview.ts';
import {captureSnapshot} from '../src/contact-overview-evidence.ts';
import {completeL2ScenarioWorkerStep} from '../src/l2-scenario-worker.ts';

test('共享官方profile：一次L2装配经手录来源发布、读取、summary-error和关闭排空',{timeout:60000},async t=>{
  const f=await createStorageFixture();
  const owner=randomUUID(),contact=randomUUID(),source=randomUUID(),memory=randomUUID(),ownerMemory=randomUUID();
  const task=randomUUID(),step=randomUUID(),worker=randomUUID(),token=randomUUID()+randomUUID();
  let host,fixtureClosing;
  const closeFixture=()=>fixtureClosing??=f.close();
  t.after(async()=>{if(host)await host.stop();await closeFixture();});
  await f.client.query("INSERT INTO owner(id,display_name)VALUES($1,'合成共享宿主本人')",[owner]);
  await f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成共享联系人')",[contact,owner]);
  await f.client.query(`INSERT INTO source_document
    (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count,status)
    VALUES($1,$2,$3,'manual','synthetic-shared-l2',$4,1,'active')`,
  [source,owner,contact,'d'.repeat(64)]);
  await f.client.query(`INSERT INTO confirmed_memory
    (id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method,status,revision)
    VALUES($1,$2,$3,'双方共同参加过共享宿主合成课程。','common_fact','study',$4,'manual','active',1)`,
  [memory,owner,contact,[source]]);
  await f.client.query(`INSERT INTO owner_memory
    (id,owner_id,text_content,category,topic,source_ids,adoption_method,status,revision)
    VALUES($1,$2,'本人偏好共享宿主合成阅读。','preference','study',ARRAY[$2::uuid],'manual','active',1)`,
  [ownerMemory,owner]);
  await f.client.query(`INSERT INTO layered_memory_state
    (owner_id,contact_id,enabled,settings_generation,status,organization_generation)
    VALUES($1,NULL,true,1,'stale',0) ON CONFLICT DO NOTHING`,[owner]);
  await f.client.query(`UPDATE layered_memory_state SET enabled=true,settings_generation=1,status='stale',
    organization_generation=0 WHERE owner_id=$1 AND contact_id IS NULL`,[owner]);
  await f.client.query(`INSERT INTO background_task
    (id,owner_id,contact_id,task_type,status,current_step,message_count)
    VALUES($1,$2,$3,'layered_memory','running','organize_memory',0)`,[task,owner,contact]);
  await f.client.query(`INSERT INTO background_task_step
    (id,task_id,step_name,step_order,status,worker_id,lease_generation,attempt_count,lease_expires_at)
    VALUES($1,$2,'organize_memory',1,'running',$3,1,1,now()+interval '10 minutes')`,[step,task,worker]);
  await f.client.query(`INSERT INTO layered_memory_state
    (owner_id,contact_id,enabled,settings_generation,status,organization_generation)
    VALUES($1,$2,true,1,'stale',0) ON CONFLICT DO NOTHING`,[owner,contact]);
  await f.client.query(`UPDATE layered_memory_state SET enabled=true,settings_generation=1,status='stale',
    organization_generation=0 WHERE owner_id=$1 AND contact_id=$2`,[owner,contact]);
  await f.client.query(`INSERT INTO layered_memory_job
    (task_id,owner_id,contact_id,settings_generation,target_key,contract,target_manifest,dependency_ids,
     state,run_remaining,model_call_limit,profile_required,profile_status)
    VALUES($1,$2,$3,1,$4,'scenario-v3:document-tools-v1:profile-tools-v1','[]','{}','active',1,8,true,'pending')`,
  [task,owner,contact,`synthetic:${task}`]);

  let latestMemory=null,latestMemoryText=null,preferredMemoryText=null,profileMemory=null,profileMemoryText=null;
  host=await startReplyServiceHost(t,{name:f.client.database,user:f.client.user,replyOwner:owner,replyToken:token,close:closeFixture},
    (_req,res,requests,events)=>{
      const body=requests.at(-1).body;
      const names=(body.tools??[]).map(tool=>tool.name);
      if(names.join(',')==='read,write,edit'){
        if(body.messages.length===1){
          const payload=JSON.parse(body.messages[0].content.find(block=>block.type==='text').text);
          if(payload.layer==='l3'){
            const selected=payload.memories[0];
            if(!selected)throw new Error('l3_synthetic_memory_missing');
            profileMemory=selected.memory_id;
            profileMemoryText=selected.text;
            useTool(events,'write',{path:'profile.md',content:`# 长期背景

<!-- ENTRY ${JSON.stringify({
  kind:'fact',section:'life_context',basis:'共享宿主合成记忆直接记载双方共同课程。',
  temporal_status:'historical',uncertainty:'',
  references:[{memory_id:selected.memory_id,revision:selected.revision}],
})} -->
双方有二〇二四年的共享宿主合成课程经历。`},'profile-write');
            sendEvents(res,events);
            return;
          }
          const selected=preferredMemoryText
            ? payload.memories.find(memory=>memory.text===preferredMemoryText)
            : payload.memories.at(-1);
          if(!selected)throw new Error('l2_synthetic_memory_missing');
          latestMemory=selected.memory_id;
          latestMemoryText=selected.text;
          useTool(events,'write',{path:'shared-course.md',content:`<!-- META {"topic_key":"shared-course","title":"共享合成课程","hint":"共同经历与当前状态"} -->

${latestMemoryText}
<!-- SOURCES [{"memory_id":"${latestMemory}","revision":1}] -->`},'shared-write');
        }
        sendEvents(res,events);
        return;
      }
      if(names.join(',')==='ProfileVerificationOutput'){
        useTool(events,'ProfileVerificationOutput',{results:[{
          entry_index:0,supported:true,evidence:[{memory_id:profileMemory,quote:profileMemoryText}],
        }]},'profile-verify');
        sendEvents(res,events);
        return;
      }
      if(names.join(',')==='ScenarioVerificationOutput'){
        useTool(events,'ScenarioVerificationOutput',{results:[{
          scenario_index:0,paragraph_index:0,supported:true,
          evidence:[{memory_id:latestMemory,quote:latestMemoryText}],
        }]},'shared-verify');
        sendEvents(res,events);
        return;
      }
      res.statusCode=500;
      res.end('{}');
    },{pluginPath:'test/host-reply-runtime-plugin.ts',environment:{NOTALONE_SYNTHETIC_L2:'1'}});

  const publicRequest=async(path,body,auth=token,method=body?'POST':'GET')=>{
    const response=await fetch(host.url+path,{method,headers:{Authorization:`Bearer ${auth}`,'content-type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json()};
  };
  const unauthorized=await publicRequest(`/api/contacts/${contact}/layered-memory`,undefined,'synthetic-public-token');
  assert.equal(unauthorized.status,401);
  const ownerInitial=await publicRequest('/api/memories/owner/layered-memory');
  assert.equal(ownerInitial.status,200,JSON.stringify(ownerInitial.body));
  assert.equal(ownerInitial.body.layered_memory.scope_kind,'owner');
  assert.equal(ownerInitial.body.layered_memory.eligible_count,1);
  assert.equal(ownerInitial.body.layered_memory.quality.automatic_use_allowed,false);
  const initial=await publicRequest(`/api/contacts/${contact}/layered-memory`);
  assert.equal(initial.status,200,JSON.stringify(initial.body));
  assert.equal(initial.body.layered_memory.quality_status,'unknown');
  assert.equal(initial.body.layered_memory.quality.automatic_use_allowed,false);
  assert.deepEqual(initial.body.layered_memory.quality.organization.reasons,['quality_store_unconfigured']);
  const missing=await publicRequest(`/api/contacts/${randomUUID()}/layered-memory`);
  assert.equal(missing.status,404,JSON.stringify(missing.body));

  const claim={task_id:task,step_id:step,step_name:'organize_memory',worker_id:worker,lease_generation:1};
  const workerClaim={ownerId:owner,contactId:contact,taskId:task,stepId:step,stepName:'organize_memory',
    workerId:worker,leaseGeneration:1,messageCount:0};
  const unauthorizedRun=await fetch(host.url+'/internal/layered-memory/run',{method:'POST',
    headers:{Authorization:'Bearer synthetic-public-token','content-type':'application/json'},
    body:JSON.stringify({scope:{owner_id:owner,contact_id:contact},claim})});
  assert.equal(unauthorizedRun.status,401);
  const run=await fetch(host.url+'/internal/layered-memory/run',{method:'POST',
    headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},
    body:JSON.stringify({scope:{owner_id:owner,contact_id:contact},claim})});
  const runBody=await run.json();
  assert.equal(run.status,200,JSON.stringify(runBody));
  assert.equal(runBody.status,'completed');
  assert.equal(runBody.processed_count,1);
  assert.equal(runBody.state.scenarios.length,1);
  assert.equal(runBody.state.profile.entries.length,1);
  assert.equal(runBody.state.organization_generation,2);
  assert.equal(host.requests.length,6);
  assert.deepEqual(host.requests.map(request=>(request.body.tools??[]).map(tool=>tool.name)),[
    ['read','write','edit'],['read','write','edit'],['ScenarioVerificationOutput'],
    ['read','write','edit'],['read','write','edit'],['ProfileVerificationOutput'],
  ]);
  assert.equal((await f.client.query('SELECT model_calls_used FROM layered_memory_job WHERE task_id=$1',[task])).rows[0].model_calls_used,6);
  const scenario=runBody.state.scenarios[0];
  const profile=runBody.state.profile;
  await f.client.query('BEGIN');
  try{
    const completion=await completeL2ScenarioWorkerStep(f.client,workerClaim,runBody.processed_count);
    await f.client.query('COMMIT');
    assert.deepEqual(completion,{processedCount:runBody.processed_count,totalCount:0,state:'complete'});
  }catch(error){
    await f.client.query('ROLLBACK');
    throw error;
  }
  assert.deepEqual((await f.client.query(`SELECT j.state AS job_state,j.pending_receipt,
    t.status AS task_status,s.status AS step_status
    FROM layered_memory_job j JOIN background_task t ON t.id=j.task_id
    JOIN background_task_step s ON s.task_id=t.id WHERE j.task_id=$1`,[task])).rows[0],
  {job_state:'complete',pending_receipt:false,task_status:'succeeded',step_status:'succeeded'});
  const profileWithdrawn=await publicRequest(`/api/contacts/${contact}/layered-memory/withdraw-profile`,{
    settings_generation:runBody.state.settings_generation,
    organization_generation:runBody.state.organization_generation,
    profile_version_id:profile.version_id,
  });
  assert.equal(profileWithdrawn.status,200,JSON.stringify(profileWithdrawn.body));
  assert.equal(profileWithdrawn.body.layered_memory.profile,null);
  assert.equal(profileWithdrawn.body.layered_memory.scenarios.length,1);
  assert.equal(profileWithdrawn.body.layered_memory.organization_generation,3);
  const earlyWrongScope=await fetch(host.url+'/internal/layered-memory/run',{method:'POST',
    headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},
    body:JSON.stringify({scope:{owner_id:owner,contact_id:randomUUID()},claim})});
  const earlyWrongScopeBody=await earlyWrongScope.json();
  assert.equal(earlyWrongScope.status,409,JSON.stringify(earlyWrongScopeBody));
  const corrected=await publicRequest(`/api/contacts/${contact}/layered-memory/summary-error`,{
    settings_generation:profileWithdrawn.body.layered_memory.settings_generation,
    organization_generation:profileWithdrawn.body.layered_memory.organization_generation,
    target_kind:'scenario',version_id:scenario.version_id,item_index:0,
    reason:'共享宿主合成段落需要撤回。',operation_id:randomUUID(),
  });
  assert.equal(corrected.status,200,JSON.stringify(corrected.body));
  assert.deepEqual(corrected.body.layered_memory.scenarios,[]);
  assert.equal((await f.client.query(`SELECT target_kind,protected_memory_ids
    FROM layered_memory_feedback WHERE owner_id=$1 AND contact_id=$2`,[owner,contact])).rows[0].target_kind,'scenario');

  const secondSource=randomUUID(),secondMemory=randomUUID();
  await f.client.query(`INSERT INTO source_document
    (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count,status)
    VALUES($1,$2,$3,'manual','synthetic-shared-l2-second',$4,1,'active')`,
  [secondSource,owner,contact,secondSource.replaceAll('-','').padEnd(64,'0')]);
  await f.client.query(`INSERT INTO confirmed_memory
    (id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method,status,revision)
    VALUES($1,$2,$3,'双方共同整理过共享宿主合成课程笔记。','common_fact','study',$4,'manual','active',1)`,
  [secondMemory,owner,contact,[secondSource]]);
  const secondTask=randomUUID(),secondStep=randomUUID(),secondWorker=randomUUID();
  await f.client.query(`INSERT INTO background_task
    (id,owner_id,contact_id,task_type,status,current_step,message_count)
    VALUES($1,$2,$3,'layered_memory','running','organize_memory',0)`,[secondTask,owner,contact]);
  await f.client.query(`INSERT INTO background_task_step
    (id,task_id,step_name,step_order,status,worker_id,lease_generation,attempt_count,lease_expires_at)
    VALUES($1,$2,'organize_memory',1,'running',$3,1,1,now()+interval '10 minutes')`,
  [secondStep,secondTask,secondWorker]);
  await f.client.query(`INSERT INTO layered_memory_job
    (task_id,owner_id,contact_id,settings_generation,target_key,contract,target_manifest,dependency_ids,
     state,run_remaining,model_call_limit,profile_required)
    VALUES($1,$2,$3,1,$4,'scenario-v3:document-tools-v1','[]','{}','active',1,8,false)`,
  [secondTask,owner,contact,`synthetic:${secondTask}`]);
  const secondClaim={task_id:secondTask,step_id:secondStep,step_name:'organize_memory',
    worker_id:secondWorker,lease_generation:1};
  const secondRun=await fetch(host.url+'/internal/layered-memory/run',{method:'POST',
    headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},
    body:JSON.stringify({scope:{owner_id:owner,contact_id:contact},claim:secondClaim})});
  const secondRunBody=await secondRun.json();
  assert.equal(secondRun.status,200,JSON.stringify(secondRunBody));
  const secondScenario=secondRunBody.state.scenarios[0];
  const withdrawn=await publicRequest(`/api/contacts/${contact}/layered-memory/withdraw-scenario`,{
    settings_generation:secondRunBody.state.settings_generation,
    organization_generation:secondRunBody.state.organization_generation,
    scenario_version_id:secondScenario.version_id,
  });
  assert.equal(withdrawn.status,200,JSON.stringify(withdrawn.body));
  assert.deepEqual(withdrawn.body.layered_memory.scenarios,[]);

  const autoSource=randomUUID(),autoMessage=randomUUID(),autoRef=randomUUID(),autoMemory=randomUUID(),autoCandidate=randomUUID(),autoTrace=randomUUID();
  const autoTask=randomUUID(),autoStep=randomUUID(),autoWorker=randomUUID(),autoSourceSha='a'.repeat(64);
  await f.client.query(`INSERT INTO source_document
    (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count,status)
    VALUES($1,$2,$3,'wechat_jsonl','synthetic-shared-auto.jsonl',$4,1,'active')`,
  [autoSource,owner,contact,autoSourceSha]);
  await f.client.query(`INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
    VALUES($1,$2,$3,'contact','text','双方自动来源记录了共享宿主合成课程。','2026-10-25T08:00:00+08:00')`,
  [autoMessage,owner,contact]);
  await f.client.query(`INSERT INTO message_source_ref
    (id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
    VALUES($1,$2,$3,$4,'source_document',$5,$6,$7::jsonb)`,
  [autoRef,autoMessage,owner,contact,autoSource,`jsonl:${autoRef}`,
    JSON.stringify({text:'双方自动来源记录了共享宿主合成课程。'})]);
  const autoEvidence={...await captureSnapshot(f.client,owner,[autoMessage],[autoSource],contact),kind:'generation'};
  await f.client.query(`INSERT INTO memory_candidate
    (id,owner_id,contact_id,text_content,category,source_ids,status,correction_evidence)
    VALUES($1,$2,$3,'双方自动来源记录了共享宿主合成课程。','common_fact',ARRAY[$4::uuid],'confirmed',$5::jsonb)`,
  [autoCandidate,owner,contact,autoMessage,JSON.stringify(autoEvidence)]);
  await f.client.query(`INSERT INTO confirmed_memory
    (id,owner_id,contact_id,text_content,category,topic,source_ids,source_candidate_id,adoption_method,status,revision)
    VALUES($1,$2,$3,'双方自动来源记录了共享宿主合成课程。','common_fact','study',$4,$5,'auto','active',1)`,
  [autoMemory,owner,contact,[autoMessage],autoCandidate]);
  await f.client.query(`INSERT INTO memory_extraction_trace
    (trace_id,owner_id,contact_id,run_id,batch_key,status,finished_at)
    VALUES($1,$2,$3,$4,'synthetic-shared-auto','succeeded',now())`,
  [autoTrace,owner,contact,randomUUID()]);
  await f.client.query(`INSERT INTO memory_extraction_trace_link
    (trace_id,owner_id,contact_id,candidate_trace_id,record_kind,record_id,commit_status,operation)
    VALUES($1,$2,$3,NULL,'contact_memory',$4,'committed','save')`,
  [autoTrace,owner,contact,autoMemory]);
  for(const dependency of [autoSource,autoMessage])await f.client.query(`INSERT INTO memory_extraction_trace_dependency
    (trace_id,owner_id,contact_id,source_id)VALUES($1,$2,$3,$4)`,[autoTrace,owner,contact,dependency]);
  const windowPayload={version:1,owner_id:owner,contact_id:contact,target_message_ids:[autoMessage],
    messages:[{message_id:autoMessage,text:'双方自动来源记录了共享宿主合成课程。',sender:'contact',
      source_snapshots:[{source_ref_id:autoRef,source_id:autoSource,source_kind:'source_document',
        locator:`jsonl:${autoRef}`,source_content_sha256:autoSourceSha}]}]};
  await f.client.query(`INSERT INTO memory_extraction_trace_event
    (event_id,trace_id,owner_id,contact_id,position,stage,payload)
    VALUES($1,$2,$3,$4,1,'window',$5::jsonb),($6,$2,$3,$4,2,'batch_end',$7::jsonb)`,
  [randomUUID(),autoTrace,owner,contact,JSON.stringify(windowPayload),randomUUID(),
    JSON.stringify({status:'succeeded',watermark_message_id:autoMessage})]);
  await f.client.query(`INSERT INTO background_task
    (id,owner_id,contact_id,task_type,status,current_step,message_count)
    VALUES($1,$2,$3,'layered_memory','running','organize_memory',0)`,[autoTask,owner,contact]);
  await f.client.query(`INSERT INTO background_task_step
    (id,task_id,step_name,step_order,status,worker_id,lease_generation,attempt_count,lease_expires_at)
    VALUES($1,$2,'organize_memory',1,'running',$3,1,1,now()+interval '10 minutes')`,
  [autoStep,autoTask,autoWorker]);
  await f.client.query(`INSERT INTO layered_memory_job
    (task_id,owner_id,contact_id,settings_generation,target_key,contract,target_manifest,dependency_ids,
     state,run_remaining,model_call_limit,profile_required)
    VALUES($1,$2,$3,1,$4,'scenario-v3:document-tools-v1','[]','{}','active',1,8,false)`,
  [autoTask,owner,contact,`synthetic:${autoTask}`]);
  const autoClaim={task_id:autoTask,step_id:autoStep,step_name:'organize_memory',
    worker_id:autoWorker,lease_generation:1};
  preferredMemoryText='双方自动来源记录了共享宿主合成课程。';
  const automaticOverview=await readReplyContactOverview(f.client,{owner_id:owner,contact_id:contact});
  assert.ok(automaticOverview.entries.some(entry=>entry.memory.memory_id===autoMemory
    && entry.provenance?.kind==='source_supported'),JSON.stringify(automaticOverview.entries));
  await f.client.query(`UPDATE memory_extraction_trace_event
    SET payload=jsonb_set(payload,'{messages,0,source_snapshots,0,source_content_sha256}',to_jsonb($2::text))
    WHERE trace_id=$1 AND stage='window'`,[autoTrace,'c'.repeat(64)]);
  const requestCountBeforeFail=host.requests.length;
  const sourceChanged=await fetch(host.url+'/internal/layered-memory/run',{method:'POST',
    headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},
    body:JSON.stringify({scope:{owner_id:owner,contact_id:contact},claim:autoClaim})});
  const sourceChangedBody=await sourceChanged.json();
  assert.equal(sourceChanged.status,409,JSON.stringify(sourceChangedBody));
  assert.equal(sourceChangedBody.error,'l2_scenario_source_changed');
  assert.equal(host.requests.length,requestCountBeforeFail);
  await f.client.query(`UPDATE memory_extraction_trace_event
    SET payload=jsonb_set(payload,'{messages,0,source_snapshots,0,source_content_sha256}',to_jsonb($2::text))
    WHERE trace_id=$1 AND stage='window'`,[autoTrace,autoSourceSha]);
  const automaticRun=await fetch(host.url+'/internal/layered-memory/run',{method:'POST',
    headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},
    body:JSON.stringify({scope:{owner_id:owner,contact_id:contact},claim:autoClaim})});
  const automaticRunBody=await automaticRun.json();
  assert.equal(automaticRun.status,200,JSON.stringify(automaticRunBody));
  assert.equal(automaticRunBody.state.scenarios[0].paragraphs[0].text,'双方自动来源记录了共享宿主合成课程。');

  const wrongScope=await fetch(host.url+'/internal/layered-memory/run',{method:'POST',
    headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},
    body:JSON.stringify({scope:{owner_id:owner,contact_id:randomUUID()},claim})});
  const wrongScopeBody=await wrongScope.json();
  assert.equal(wrongScope.status,409,JSON.stringify(wrongScopeBody));

  const closed=await host.request('/close-reply',{});
  assert.equal(closed.closed,true);
  assert.equal(closed.permits.backgroundActive,0);
  const after=await fetch(host.url+'/internal/layered-memory/run',{method:'POST',
    headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},
    body:JSON.stringify({scope:{owner_id:owner,contact_id:contact},claim})});
  assert.equal(after.status,503);
});

test('共享官方profile：唯一TS Worker自动领取L2并在关闭时释放租约',{timeout:60000},async t=>{
  const f=await createStorageFixture();
  const owner=randomUUID(),contact=randomUUID(),token=randomUUID()+randomUUID();
  const firstSource=randomUUID(),firstMemory=randomUUID(),firstTask=randomUUID(),firstStep=randomUUID();
  const secondSource=randomUUID(),secondMemory=randomUUID(),secondTask=randomUUID(),secondStep=randomUUID();
  const firstText='双方自动完成合成课程。',secondText='双方继续整理自动课程笔记。';
  let host,closing;
  const closeFixture=()=>closing??=f.close();
  t.after(async()=>{if(host)await host.stop();await closeFixture();});
  await f.client.query("INSERT INTO owner(id,display_name)VALUES($1,'合成自动Worker本人')",[owner]);
  await f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成自动Worker联系人')",[contact,owner]);
  await f.client.query(`INSERT INTO source_document
    (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count,status)
    VALUES($1,$2,$3,'manual','synthetic-auto-worker-1',$4,1,'active')`,
  [firstSource,owner,contact,'1'.repeat(64)]);
  await f.client.query(`INSERT INTO confirmed_memory
    (id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method,status,revision)
    VALUES($1,$2,$3,$4,'common_fact','study',$5,'manual','active',1)`,
  [firstMemory,owner,contact,firstText,[firstSource]]);
  await f.client.query(`INSERT INTO layered_memory_state
    (owner_id,contact_id,enabled,settings_generation,status,organization_generation)
    VALUES($1,$2,true,1,'stale',0) ON CONFLICT DO NOTHING`,[owner,contact]);
  await f.client.query(`UPDATE layered_memory_state SET enabled=true,settings_generation=1,status='stale',
    organization_generation=0 WHERE owner_id=$1 AND contact_id=$2`,[owner,contact]);
  const seedTask=async(task,step,memory,text)=>{
    await f.client.query(`INSERT INTO background_task
      (id,owner_id,contact_id,task_type,status,current_step,message_count)
      VALUES($1,$2,$3,'layered_memory','queued','organize_memory',1)`,[task,owner,contact]);
    await f.client.query(`INSERT INTO background_task_step
      (id,task_id,step_name,step_order,status,total_count,attempt_count)
      VALUES($1,$2,'organize_memory',1,'pending',1,0)`,[step,task]);
    await f.client.query(`INSERT INTO layered_memory_job
      (task_id,owner_id,contact_id,settings_generation,target_key,contract,target_manifest,dependency_ids,
       state,run_remaining,model_call_limit,profile_required)
      VALUES($1,$2,$3,1,$4,'scenario-v3:document-tools-v1',$5::jsonb,'{}','active',1,8,false)`,
    [task,owner,contact,`synthetic-auto:${task}`,JSON.stringify([{memory_id:memory,text}])]);
  };
  await seedTask(firstTask,firstStep,firstMemory,firstText);

  let latestMemory=null,latestText=null,secondStartedResolve;
  const secondStarted=new Promise(resolve=>{secondStartedResolve=resolve;});
  host=await startReplyServiceHost(t,{name:f.client.database,user:f.client.user,replyOwner:owner,replyToken:token,close:closeFixture},
    async(req,res,requests,events)=>{
      const body=requests.at(-1).body,names=(body.tools??[]).map(tool=>tool.name);
      if(names.join(',')==='read,write,edit'){
        if(body.messages.length===1){
          const payload=JSON.parse(body.messages[0].content.find(block=>block.type==='text').text);
          const selected=payload.memories.find(memory=>memory.text===secondText)
            ??payload.memories.find(memory=>memory.text===firstText);
          if(!selected)throw new Error('l2_auto_memory_missing');
          latestMemory=selected.memory_id;latestText=selected.text;
          if(latestText===secondText){
            secondStartedResolve();
            await new Promise(resolve=>{
              req.once('aborted',resolve);
              res.once('close',resolve);
            });
            return;
          }
          useTool(events,'write',{path:`auto-${latestMemory}.md`,content:`<!-- META {"topic_key":"auto-worker","title":"自动整理课程","hint":"共同经历与当前状态"} -->

${latestText}
<!-- SOURCES [{"memory_id":"${latestMemory}","revision":1}] -->`},'auto-write');
        }
        sendEvents(res,events);
        return;
      }
      if(names.join(',')==='ScenarioVerificationOutput'){
        useTool(events,'ScenarioVerificationOutput',{results:[{
          scenario_index:0,paragraph_index:0,supported:true,
          evidence:[{memory_id:latestMemory,quote:latestText}],
        }]},'auto-verify');
        sendEvents(res,events);
        return;
      }
      res.statusCode=500;res.end('{}');
    },{pluginPath:'test/host-reply-runtime-plugin.ts',environment:{
      NOTALONE_SYNTHETIC_L2:'1',NOTALONE_SYNTHETIC_EXTRACTION:'1',
    }});

  const deadline=Date.now()+10000;
  let firstDone=false;
  while(Date.now()<deadline&&!firstDone){
    const row=(await f.client.query(`SELECT t.status AS task_status,j.state AS job_state,
      s.status AS step_status,s.attempt_count,s.worker_id,s.lease_expires_at,
      state.status AS layer_status,state.organization_generation
      FROM background_task t JOIN layered_memory_job j ON j.task_id=t.id
      JOIN background_task_step s ON s.task_id=t.id
      JOIN layered_memory_state state ON state.owner_id=j.owner_id
        AND state.contact_id IS NOT DISTINCT FROM j.contact_id
      WHERE t.id=$1`,[firstTask])).rows[0];
    firstDone=row.task_status==='succeeded'&&row.job_state==='complete'&&row.step_status==='succeeded';
    if(!firstDone)await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(firstDone,true,'唯一TS Worker未自动领取并收口L2任务');
  assert.deepEqual((await f.client.query(`SELECT s.attempt_count,s.worker_id,s.lease_expires_at,
    j.pending_receipt,j.state AS job_state,state.status AS layer_status
    FROM background_task_step s JOIN layered_memory_job j ON j.task_id=s.task_id
    JOIN layered_memory_state state ON state.owner_id=j.owner_id
      AND state.contact_id IS NOT DISTINCT FROM j.contact_id
    WHERE j.task_id=$1`,[firstTask])).rows[0],{
    attempt_count:1,worker_id:null,lease_expires_at:null,pending_receipt:false,
    job_state:'complete',layer_status:'ready',
  });
  assert.equal((await f.client.query(`SELECT count(*)::int AS versions
    FROM scenario_document_version WHERE owner_id=$1 AND contact_id=$2`,[owner,contact])).rows[0].versions,1);
  assert.equal(host.requests.length,3);

  await f.client.query(`INSERT INTO source_document
    (id,owner_id,contact_id,source_type,file_name,content_sha256,record_count,status)
    VALUES($1,$2,$3,'manual','synthetic-auto-worker-2',$4,1,'active')`,
  [secondSource,owner,contact,'2'.repeat(64)]);
  await f.client.query(`INSERT INTO confirmed_memory
    (id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method,status,revision)
    VALUES($1,$2,$3,$4,'common_fact','study',$5,'manual','active',1)`,
  [secondMemory,owner,contact,secondText,[secondSource]]);
  await seedTask(secondTask,secondStep,secondMemory,secondText);
  await Promise.race([secondStarted,new Promise((_,reject)=>setTimeout(
    ()=>reject(new Error('唯一TS Worker未自动领取第二项L2任务')),10000,
  ))]);
  const closed=await host.request('/close-reply',{});
  assert.equal(closed.closed,true);
  assert.equal(closed.permits.backgroundActive,0);
  assert.deepEqual((await f.client.query(`SELECT j.state AS job_state,j.pending_receipt,
    t.status AS task_status,s.status AS step_status,s.attempt_count,s.worker_id,s.lease_expires_at
    FROM layered_memory_job j JOIN background_task t ON t.id=j.task_id
    JOIN background_task_step s ON s.task_id=j.task_id WHERE j.task_id=$1`,[secondTask])).rows[0],{
    job_state:'active',pending_receipt:false,task_status:'queued',step_status:'pending',
    attempt_count:0,worker_id:null,lease_expires_at:null,
  });
  assert.equal((await f.client.query(`SELECT count(*)::int AS live
    FROM background_task_step s JOIN background_task t ON t.id=s.task_id
    WHERE t.owner_id=$1 AND s.status='running' AND s.lease_expires_at IS NOT NULL`,[owner])).rows[0].live,0);
});
