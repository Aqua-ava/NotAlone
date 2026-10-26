import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {HostStorage} from '../src/platform/database/host-storage.ts';
import {ExtractionTaskStore} from '../src/memory/extraction/tasks/store.ts';
import {SkillFiles} from '../src/skills/skill-files.ts';
import {codepointLength,finishBatch,learningInputText,normalizeProposal} from '../src/skills/skill-learning-contract.ts';
import {SkillLearningStore} from '../src/skills/skill-learning-store.ts';
import {SkillLearningTaskRunner} from '../src/skills/skill-learning-worker.ts';
import {SkillLearningRuntime} from '../src/skills/skill-learning-runtime.ts';
import {SkillLibrary} from '../src/skills/skill-library.ts';
import {SkillReviewStore} from '../src/skills/skill-review-store.ts';
import {SkillHistoryPolicyStore} from '../src/skills/skill-history-policy-store.ts';
import {SkillLearningHttp} from '../src/skills/skill-learning-http.ts';
import {prepareReviewContext} from '../src/skills/skill-review-service.ts';
import {captureReviewSources,reviewSourcesCurrent} from '../src/skills/skill-review-sources.ts';
import {readReplyContactOverview,readReplyOwnerOverview} from '../src/reply/context/reply-context-overview.ts';
import {digest} from '../src/memory/overview/evidence/sources.ts';
import {captureSkillGeneration,requireReviewSources} from '../src/skills/skill-source-proof.ts';
import {CONTACT_LAYERED_BUDGET,OWNER_LAYERED_BUDGET,requireLayeredMaterial,selectLayeredMaterial,
  validateLayeredSnapshot} from '../src/reply/context/reply-context-layered.ts';
import {PostgresSkillPort} from '../src/skills/skill-port.ts';
import {eraseSkillLearning,cleanupSkillFiles} from '../src/skills/skill-cleanup.ts';

async function ownerFixture(t){
  const f=await createStorageFixture();
  let storage,pool;
  t.after(async()=>{await pool?.end();await storage?.close();await f.close();});
  storage=await HostStorage.open(f.options);
  await storage.initializeOwner('合成所有者');
  const owner=storage.runtimeOwnerId,contact=randomUUID(),binding=randomUUID();
  await f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成联系人')",[contact,owner]);
  await f.client.query("INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator,status)VALUES($1,$2,$3,'wechat','synthetic','synthetic-contact','active')",[binding,owner,contact]);
  pool=await storage.businessPool();
  return {f,storage,owner,contact,binding,pool};
}
function transaction(pool){
  return async work=>{const client=await pool.connect();try{await client.query('BEGIN');const value=await work(client);await client.query('COMMIT');return value;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};
}
function proposal(name='synthetic-calm-reply'){
  return {outcome:'draft',proposal_kind:'create',target_skill_ids:[],name,
    description:'用于需要先回应情绪再表达信息的合成沟通场景。',scene:'合成冲突澄清',
    scope_suggestion:{kind:'contact',reason:'合成经验只属于当前确认联系人。'},
    methods:[{key:'acknowledge-first',title:'先确认理解',instruction:'先说明理解对方处境，再表达己方信息。',replaces_method_ids:[]}]};
}
function baseBatch(overrides={}){
  const material={material_id:randomUUID(),digest:'a'.repeat(64),dependency_ids:[],session_id:randomUUID(),
    kind:'assistant_discussion',priority:'correction',
    content:{correction:'先确认对方此刻的难处，再清楚说明自己的安排。'},
    candidates:[],external_messages:[],created_at:'2026-10-25 10:00:00'};
  return finishBatch({materials:[material],targets:[],dependency_ids:[],library_revision:0,scope_revision:1,
    source_generation:{version:1,dependencies:[],messages:{message_ids:[],source_ids:[],source_refs:[],
      message_digests:{},message_snapshots:{},message_scopes:{}},sources:{},observations:{},memories:{},preferences:{}},
    material_budget_limited:false,...overrides});
}
async function insertDraft(x,tx,normalized,batch=baseBatch()){
  const draftId=randomUUID(),generation=await tx(client=>captureSkillGeneration(
    client,x.owner,x.contact,batch.dependency_ids));
  await x.f.client.query(`INSERT INTO skill_draft(id,owner_id,contact_id,logical_skill_id,proposal_kind,strategy,
    private_evidence,target_versions,dependency_ids,source_generation,batch_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [draftId,x.owner,x.contact,normalized.logical_skill_id,normalized.proposal_kind,normalized.strategy,
    {materials:batch.materials,existing_skills:batch.targets,source_dependencies:batch.dependency_ids},
    JSON.stringify(normalized.target_versions),batch.dependency_ids,generation,`synthetic-batch-${draftId}`]);
  return draftId;
}
async function seedLayered(x){
  const source=randomUUID(),contactMemory=randomUUID(),ownerMemory=randomUUID();
  const contactBatch=randomUUID(),contactScenario=randomUUID(),contactVersion=randomUUID();
  const ownerBatch=randomUUID(),ownerScenario=randomUUID(),ownerVersion=randomUUID();
  const task=randomUUID(),step=randomUUID(),profileBatch=randomUUID(),profileVersion=randomUUID();
  await x.f.client.query(`INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count,status)
    VALUES($1,$2,$3,'manual','synthetic-skill-review.jsonl',$4,1,'active')`,[source,x.owner,x.contact,'c'.repeat(64)]);
  await x.f.client.query(`INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,topic,source_ids,
    adoption_method,status,revision) VALUES($1,$2,$3,'对方近期在准备合成课程安排。','common_fact','study',$4,'manual','active',1)`,
  [contactMemory,x.owner,x.contact,[source]]);
  await x.f.client.query(`INSERT INTO owner_memory(id,owner_id,text_content,category,topic,source_ids,adoption_method,status,revision)
    VALUES($1,$2,'偏好直接说明时间安排。','preference','other',$3,'manual','active',1)`,[ownerMemory,x.owner,[x.owner]]);
  const contactOverview=await readReplyContactOverview(x.f.client,{owner_id:x.owner,contact_id:x.contact},true);
  const ownerOverview=await readReplyOwnerOverview(x.f.client,x.owner,true);
  const manifest=entry=>({...entry.dependency_manifest,organization_timing_sha256:digest(entry.memory.timing)});
  const contactManifest=[manifest(contactOverview.entries[0])],ownerManifest=[manifest(ownerOverview.entries[0])];
  await x.f.client.query(`INSERT INTO layered_memory_state(owner_id,contact_id,enabled,settings_generation,status,
    organization_generation) VALUES($1,$2,true,1,'ready',1)
    ON CONFLICT(owner_id,scope_kind,scope_key) DO UPDATE SET enabled=true,settings_generation=1,status='ready',organization_generation=1`,
  [x.owner,x.contact]);
  await x.f.client.query(`INSERT INTO layered_memory_batch(id,owner_id,contact_id,settings_generation,work_key,status,
    input_manifest,input_payload,dependency_ids,created_at)
    VALUES($1,$2,$3,1,'synthetic-contact-review','succeeded',$4,'{}',$5,now())`,
  [contactBatch,x.owner,x.contact,JSON.stringify(contactManifest),[source,contactMemory]]);
  await x.f.client.query(`INSERT INTO scenario_document_version(id,owner_id,contact_id,scenario_id,batch_id,
    organization_generation,schema_version,title,hint,paragraphs,created_at)
    VALUES($1,$2,$3,$4,$5,1,1,'合成课程安排','共同经历的当前进展',$6,now())`,
  [contactVersion,x.owner,x.contact,contactScenario,contactBatch,
    JSON.stringify([{text:'对方近期在准备合成课程安排。',references:[{memory_id:contactMemory,revision:1}]}])]);
  await x.f.client.query(`INSERT INTO layered_memory_generation(owner_id,contact_id,organization_generation,
    schema_version,scenario_version_ids,dependency_ids) VALUES($1,$2,1,2,$3,$4)`,
  [x.owner,x.contact,[contactVersion],[source,contactMemory]]);

  await x.f.client.query(`INSERT INTO layered_memory_state(owner_id,contact_id,enabled,settings_generation,status,
    organization_generation) VALUES($1,NULL,true,1,'ready',1)
    ON CONFLICT(owner_id,scope_kind,scope_key) DO UPDATE SET enabled=true,settings_generation=1,status='ready',organization_generation=1`,
  [x.owner]);
  await x.f.client.query(`INSERT INTO layered_memory_batch(id,owner_id,contact_id,settings_generation,work_key,status,
    input_manifest,input_payload,dependency_ids,created_at)
    VALUES($1,$2,NULL,1,'synthetic-owner-review','succeeded',$3,'{}',$4,now())`,
  [ownerBatch,x.owner,JSON.stringify(ownerManifest),[x.owner,ownerMemory]]);
  await x.f.client.query(`INSERT INTO scenario_document_version(id,owner_id,contact_id,scenario_id,batch_id,
    organization_generation,schema_version,title,hint,paragraphs,created_at)
    VALUES($1,$2,NULL,$3,$4,1,1,'合成表达偏好','本人偏好的背景与变化',$5,now())`,
  [ownerVersion,x.owner,ownerScenario,ownerBatch,
    JSON.stringify([{text:'偏好直接说明时间安排。',references:[{memory_id:ownerMemory,revision:1}]}])]);
  await x.f.client.query(`INSERT INTO layered_memory_generation(owner_id,contact_id,organization_generation,
    schema_version,scenario_version_ids,dependency_ids) VALUES($1,NULL,1,2,$2,$3)`,
  [x.owner,[ownerVersion],[x.owner,ownerMemory]]);
  await x.f.client.query(`INSERT INTO background_task(id,owner_id,contact_id,task_type,status,current_step,message_count)
    VALUES($1,$2,NULL,'layered_memory','succeeded','organize_memory',1)`,[task,x.owner]);
  await x.f.client.query(`INSERT INTO background_task_step(id,task_id,step_name,step_order,status,total_count,
    attempt_count,processed_count) VALUES($1,$2,'organize_memory',1,'succeeded',1,1,1)`,[step,task]);
  await x.f.client.query(`INSERT INTO layered_memory_job(task_id,owner_id,contact_id,settings_generation,target_key,
    contract,target_manifest,dependency_ids,state,run_remaining,model_call_limit,profile_required,profile_status)
    VALUES($1,$2,NULL,1,'synthetic-owner-profile','scenario-v3:document-tools-v1:profile-tools-v1','[]','{}',
      'complete',0,1,true,'succeeded')`,[task,x.owner]);
  await x.f.client.query(`INSERT INTO layered_profile_batch(id,owner_id,contact_id,settings_generation,
    organization_generation,work_key,work_token,budget_batch_id,task_id,status,lease_expires_at,
    scenario_version_ids,input_manifest,input_payload,output_payload,dependency_ids,created_at)
    VALUES($1,$2,NULL,1,1,'synthetic-owner-profile',$3,$4,$5,'succeeded',now()+interval '1 hour',
      $6,$7,'{}','{}',$8,now())`,
  [profileBatch,x.owner,randomUUID(),ownerBatch,task,[ownerVersion],JSON.stringify(ownerManifest),[x.owner,ownerMemory]]);
  const entries=[{text:'偏好直接说明时间安排。',kind:'inference',uncertainty:'低',references:[{memory_id:ownerMemory,revision:1}]}];
  await x.f.client.query(`INSERT INTO layered_profile_version(id,owner_id,contact_id,batch_id,schema_version,entries,
    withdrawn,created_at) VALUES($1,$2,NULL,$3,2,$4,false,now())`,
  [profileVersion,x.owner,profileBatch,JSON.stringify(entries)]);
  await x.f.client.query(`UPDATE layered_memory_generation SET profile_version_id=$3
    WHERE owner_id=$1 AND contact_id IS NULL AND organization_generation=$2`,[x.owner,1,profileVersion]);
  return {source,contactMemory,ownerMemory,contactVersion,ownerVersion,profileVersion};
}
async function readyComparison(x,tx,review,scope,built,normalized){
  const draftId=await insertDraft(x,tx,normalized),input={incoming_text:'明天我们怎么安排？',intent:'直接说明时间安排。',scene:'合成冲突澄清'};
  const confirmed={kind:'contact',contact_id:x.contact,scene:null};
  const started=await review.beginComparison(scope,{draftId,expectedRevision:1,operationKey:randomUUID(),input,
    scopeConfirmation:confirmed,contextFingerprint:built.fingerprint,contextDependencies:built.dependencies,
    contextRevisions:built.revisions,navigation:built.navigation,layered:built.layered});
  const persisted=await tx(client=>client.query('SELECT dependency_ids,source_generation FROM skill_review_comparison WHERE id=$1',
    [started.comparison.id]).then(result=>result.rows[0]));
  if(persisted.source_generation.sources.layered){
    for(const [index,item] of persisted.source_generation.sources.layered.entries()){
      const budget=item.scope.contact_id===null?OWNER_LAYERED_BUDGET:CONTACT_LAYERED_BUDGET;
      assert.ok(selectLayeredMaterial(item.snapshot,budget),`分层材料重选 ${index}`);
      assert.equal(await tx(client=>validateLayeredSnapshot(client,item.snapshot)),true,`分层快照 ${index}`);
      try{await tx(client=>requireLayeredMaterial(client,item.scope,selectLayeredMaterial(item.snapshot,budget),
        budget));}
      catch(error){throw new Error(`持久化分层材料 ${index} 不可复验`,{cause:error});}
    }
    await tx(client=>requireReviewSources(client,scope.owner_id,scope.contact_id,
      persisted.source_generation.sources.base_dependencies,persisted.source_generation.sources.base,
      {checking:new Set(),validated:new Set()}));
  }
  assert.equal(await tx(client=>reviewSourcesCurrent(client,scope,persisted.dependency_ids,persisted.source_generation.sources,
    {checking:new Set(),validated:new Set()})),true,JSON.stringify(persisted.source_generation.sources).slice(0,4000));
  await review.finishComparison(scope,started.comparison.id,started.comparison.run_token,built.fingerprint,{
    before:{name:null,version_id:null,load_state:'not_used',candidates:[]},
    after:{name:normalized.strategy.name,version_id:started.comparison.id,load_state:'loaded',candidates:[]}});
  return {draftId,comparisonId:started.comparison.id,input,confirmed};
}
test('学习提案严格拒绝未知目标、非法方法身份和私人原文复述',()=>{
  const scope={owner_id:randomUUID(),contact_id:randomUUID()},batch=baseBatch();
  const normalized=normalizeProposal(scope,batch,proposal());
  assert.equal(normalized.outcome,'draft');
  assert.match(normalized.proposal.strategy.document,/合成冲突澄清/);
  assert.equal(normalized.proposal.strategy.methods[0].mapping_status,'new');
  assert.deepEqual(normalizeProposal(scope,batch,{outcome:'no_change'}),{proposal:null,outcome:'no_change'});
  assert.throws(()=>normalizeProposal(scope,batch,{...proposal(),target_skill_ids:[randomUUID()]}));
  const privateBatch=baseBatch({materials:[{...batch.materials[0],
    content:{correction:'先说明我理解你的顾虑，然后把安排讲具体。'}}]});
  assert.throws(()=>normalizeProposal(scope,privateBatch,{...proposal(),methods:[{
    key:'unsafe',title:'复述',instruction:'先说明我理解你的顾虑，然后把安排讲具体。',replaces_method_ids:[],
  }]}));
  assert.throws(()=>normalizeProposal(scope,batch,{...proposal(),name:'Synthetic Bad'}));
  const target=(name)=>{const skill_id=randomUUID(),method_id=randomUUID();return {
    skill_id,version_id:randomUUID(),version_number:2,name,description:`合成${name}说明`,
    document:`---\nname: ${name}\ndescription: "合成说明"\n---\n原方法`,methods:[{method_id,logical_skill_id:skill_id}],
    scope:{kind:'contact',contact_id:scope.contact_id,scene:null},source_dependency_count:0,
  };};
  const first=target('existing-calm-reply'),second=target('existing-boundary-reply');
  const targeted=baseBatch({targets:[first,second]});
  assert.deepEqual(normalizeProposal(scope,targeted,{outcome:'reuse',target_skill_ids:[first.skill_id]}),
    {proposal:null,outcome:'reuse'});
  assert.throws(()=>normalizeProposal(scope,targeted,{outcome:'reuse',target_skill_ids:[]}));
  const updated=normalizeProposal(scope,targeted,{outcome:'draft',proposal_kind:'update',
    target_skill_ids:[first.skill_id],name:'existing-calm-reply',description:'更新后的合成说明。',
    scene:'合成冲突澄清',scope_suggestion:{kind:'contact',reason:'继续限于当前联系人。'},
    methods:[{key:'refined-acknowledgement',title:'细化确认',instruction:'先确认对方担心什么，再说明可行安排。',
      replaces_method_ids:first.methods.map(item=>item.method_id)}]});
  assert.equal(updated.proposal?.proposal_kind,'update');
  assert.equal(updated.proposal?.logical_skill_id,first.skill_id);
  assert.deepEqual(updated.proposal?.target_versions,[{skill_id:first.skill_id,version_id:first.version_id,version_number:2}]);
  const merged=normalizeProposal(scope,targeted,{outcome:'draft',proposal_kind:'merge',
    target_skill_ids:[first.skill_id,second.skill_id],name:'merged-calm-reply',description:'合并后的合成说明。',
    scene:'合成冲突澄清',scope_suggestion:{kind:'contact',reason:'合并仍只供当前联系人审核。'},
    methods:[{key:'combined-approach',title:'合并方法',instruction:'先确认顾虑，再说明边界与可选安排。',
      replaces_method_ids:[...first.methods,...second.methods].map(item=>item.method_id)}]});
  assert.equal(merged.proposal?.proposal_kind,'merge');assert.equal(merged.proposal?.target_versions.length,2);
  assert.equal(merged.proposal?.strategy.scope_suggestion.kind,'contact');
  const emojiBatch=baseBatch({materials:[{...batch.materials[0],
    content:{correction:'😀'.repeat(12_000)}}]});
  assert.ok(codepointLength(learningInputText(emojiBatch.materials,emojiBatch.targets))<=24_000);
  assert.equal(emojiBatch.ready,true,'字符预算按Unicode码点计算，不把表情拆成两个字符');
});
test('来源核验不会把数据库暂时故障当成用户资料失效',async()=>{
  const scope={owner_id:randomUUID(),contact_id:randomUUID()};
  const store=new SkillLearningStore({transaction:async work=>work({}),files:{},taskStore:{}});
  const client={query:async()=>{throw Object.assign(new Error('synthetic database failure'),{code:'57P01'});}};
  await assert.rejects(store.dependenciesCurrent(client,scope,[]),{code:'57P01'});
});
test('没有已验证绑定的联系人不能开启学习授权',async t=>{
  const x=await ownerFixture(t),tx=transaction(x.pool),files=new SkillFiles(join(x.f.directory,'skills'));
  const store=new SkillLearningStore({transaction:tx,files,taskStore:new ExtractionTaskStore(x.pool)});
  const contact=randomUUID();
  await x.f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成未绑定联系人')",[contact,x.owner]);
  await assert.rejects(store.configure({owner_id:x.owner,contact_id:contact},
    {enabled:true,operationKey:randomUUID(),expectedRevision:0}),
  {code:'skill_learning_stale_or_disabled'});
  assert.equal((await x.f.client.query('SELECT count(*)::int AS count FROM skill_learning_scope WHERE contact_id=$1',
    [contact])).rows[0].count,0);
});
test('学习任务并发只领取一次，租约过期恢复后拒绝旧保存和取消后的晚结果',async t=>{
  const x=await ownerFixture(t),tx=transaction(x.pool),files=new SkillFiles(join(x.f.directory,'skills'));
  const taskStore=new ExtractionTaskStore(x.pool);
  const store=new SkillLearningStore({transaction:tx,files,taskStore});
  const scope={owner_id:x.owner,contact_id:x.contact},taskScope={ownerId:x.owner,contactId:x.contact};
  await store.configure(scope,{enabled:true,operationKey:randomUUID(),expectedRevision:0});
  const session=randomUUID(),input=randomUUID();
  await x.f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id)VALUES($1,$2,$3)',[session,x.owner,x.contact]);
  await x.f.client.query(`INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,
    input_type,content)VALUES($1,$2,$3,$4,$5,'purpose_exploration',$6)`,
  [input,session,x.owner,x.contact,x.binding,{type:'purpose_exploration',correction:'合成纠正：先确认对方的难处再说明安排。'}]);
  await x.f.client.query('UPDATE assistant_session SET current_input_version_id=$2 WHERE id=$1',[session,input]);
  const taskId=await store.enqueue(scope);
  assert.ok(taskId);
  const supportedSteps=['propose_skill','verify_skill_drafts'];
  const [left,right]=await Promise.all([
    taskStore.claim(taskScope,{workerId:randomUUID(),leaseMs:30_000,supportedSteps}),
    taskStore.claim(taskScope,{workerId:randomUUID(),leaseMs:30_000,supportedSteps}),
  ]);
  assert.equal([left,right].filter(Boolean).length,1);
  const first=left??right;
  assert.equal(await taskStore.pause(first),true);
  const recovered=await taskStore.claim(taskScope,{workerId:randomUUID(),leaseMs:30_000,supportedSteps});
  assert.ok(recovered);
  const staleBatch=await store.capture(scope);
  await x.f.client.query(`UPDATE background_task_step SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,
    [recovered.stepId]);
  const replacement=await taskStore.claim(taskScope,{workerId:randomUUID(),leaseMs:60_000,supportedSteps});
  assert.ok(replacement);assert.notEqual(replacement.leaseGeneration,recovered.leaseGeneration);
  await assert.rejects(taskStore.check(recovered),{code:'lease_stale'});
  await assert.rejects(store.save(scope,recovered,staleBatch,proposal()));
  assert.equal((await x.f.client.query('SELECT count(*)::int AS count FROM skill_draft')).rows[0].count,0);

  let enteredResolve,releaseResolve;
  const entered=new Promise(resolve=>{enteredResolve=resolve;}),released=new Promise(resolve=>{releaseResolve=resolve;});
  const controller=new AbortController();
  const runner=new SkillLearningTaskRunner({store,runtime:{async propose(){enteredResolve();await released;return proposal();}}});
  const late=runner.run(replacement,controller.signal);
  await entered;controller.abort();releaseResolve();
  await assert.rejects(late);assert.equal((await x.f.client.query('SELECT count(*)::int AS count FROM skill_draft')).rows[0].count,0);
  await taskStore.pause(replacement);

  const cancelled=await taskStore.claim(taskScope,{workerId:randomUUID(),leaseMs:30_000,supportedSteps});
  assert.ok(cancelled);
  const liveBatch=await store.capture(scope);
  let sourceEnteredResolve,sourceReleaseResolve;
  const sourceEntered=new Promise(resolve=>{sourceEnteredResolve=resolve;});
  const sourceRelease=new Promise(resolve=>{sourceReleaseResolve=resolve;});
  const sourceRunner=new SkillLearningTaskRunner({store,runtime:{async propose(){sourceEnteredResolve();await sourceRelease;return proposal();}}});
  const sourceLate=sourceRunner.run(cancelled,new AbortController().signal);
  await sourceEntered;
  await x.f.client.query('BEGIN');await x.f.client.query(`UPDATE assistant_session_input SET state='redacted',
    content=NULL,dependency_ids='{}' WHERE id=$1 AND owner_id=$2`,[input,x.owner]);
  await eraseSkillLearning(x.f.client,x.owner,[input]);await x.f.client.query('COMMIT');
  sourceReleaseResolve();
  await assert.rejects(sourceLate);
  assert.equal((await x.f.client.query('SELECT count(*)::int AS count FROM skill_draft')).rows[0].count,0);
  await assert.rejects(store.save(scope,cancelled,liveBatch,proposal()));
  await store.configure(scope,{enabled:false,operationKey:randomUUID(),expectedRevision:1});
  assert.equal((await x.f.client.query('SELECT status FROM background_task WHERE id=$1',[taskId])).rows[0].status,'cancelled');
});
test('学习尝试达到上限后保持失败，等待显式恢复而不是自动进入后续步骤',async t=>{
  const x=await ownerFixture(t),tx=transaction(x.pool),files=new SkillFiles(join(x.f.directory,'skills'));
  const taskStore=new ExtractionTaskStore(x.pool),store=new SkillLearningStore({transaction:tx,files,taskStore});
  const scope={owner_id:x.owner,contact_id:x.contact},taskScope={ownerId:x.owner,contactId:x.contact};
  await store.configure(scope,{enabled:true,operationKey:randomUUID(),expectedRevision:0});
  const session=randomUUID(),input=randomUUID();
  await x.f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id)VALUES($1,$2,$3)',[session,x.owner,x.contact]);
  await x.f.client.query(`INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,
    input_type,content)VALUES($1,$2,$3,$4,$5,'purpose_exploration',$6)`,
  [input,session,x.owner,x.contact,x.binding,{type:'purpose_exploration',
    correction:'合成终态纠正：先确认对方意思，再说明安排。'}]);
  await x.f.client.query('UPDATE assistant_session SET current_input_version_id=$2 WHERE id=$1',[session,input]);
  const taskId=await store.enqueue(scope),supportedSteps=['propose_skill','verify_skill_drafts'];
  assert.ok(taskId);assert.ok(await taskStore.claim(taskScope,{workerId:randomUUID(),leaseMs:30_000,supportedSteps}));
  await x.f.client.query(`UPDATE background_task_step SET attempt_count=3,
    lease_expires_at=clock_timestamp()-interval '1 second' WHERE task_id=$1 AND step_name='propose_skill'`,[taskId]);
  assert.equal(await taskStore.claim(taskScope,{workerId:randomUUID(),leaseMs:30_000,supportedSteps}),null);
  assert.deepEqual((await x.f.client.query('SELECT status,last_error_code FROM background_task WHERE id=$1',[taskId])).rows[0],
    {status:'failed',last_error_code:'lease_expired'});
  assert.equal(await store.enqueue(scope,true),taskId);
  assert.deepEqual((await x.f.client.query('SELECT status,current_step FROM background_task WHERE id=$1',[taskId])).rows[0],
    {status:'queued',current_step:'propose_skill'});
});
test('学习运行时只接受单次结构化提案，不自行发布且预算、取消与非法输出不重试',async t=>{
  const x=await ownerFixture(t),tx=transaction(x.pool),files=new SkillFiles(join(x.f.directory,'skills'));
  const taskStore=new ExtractionTaskStore(x.pool),store=new SkillLearningStore({transaction:tx,files,taskStore});
  const scope={owner_id:x.owner,contact_id:x.contact},taskScope={ownerId:x.owner,contactId:x.contact};
  await store.configure(scope,{enabled:true,operationKey:randomUUID(),expectedRevision:0});
  const session=randomUUID(),input=randomUUID();
  await x.f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id)VALUES($1,$2,$3)',[session,x.owner,x.contact]);
  await x.f.client.query(`INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,
    input_type,content)VALUES($1,$2,$3,$4,$5,'purpose_exploration',$6)`,
  [input,session,x.owner,x.contact,x.binding,{type:'purpose_exploration',correction:'合成纠正：先确认对方的难处再说明安排。'}]);
  await x.f.client.query('UPDATE assistant_session SET current_input_version_id=$2 WHERE id=$1',[session,input]);
  await store.enqueue(scope);
  const supportedSteps=['propose_skill','verify_skill_drafts'];
  const claim=await taskStore.claim(taskScope,{workerId:randomUUID(),leaseMs:60_000,supportedSteps});
  assert.ok(claim);
  const batch=await store.capture(scope);
  let calls=0,inputs=[];
  const binding={provider:'synthetic-provider',model:'synthetic-model',maxTokens:256,temperature:0,reasoningEffort:'off'};
  const profile={context_window_tokens:65536,safety_margin_tokens:128};
  const runtime=new SkillLearningRuntime({store,binding,profile,call:async request=>{
    calls++;inputs.push(request);
    const blocks=[{type:'tool-call',name:'SkillLearningProposal',arguments:JSON.stringify(proposal())}];
    await request.validateOutput(blocks);return {text:'',blocks};
  }});
  const output=await runtime.propose(scope,claim,batch,new AbortController().signal);
  assert.equal(calls,1);assert.equal(inputs[0].tools.length,1);assert.equal(inputs[0].tools[0].name,'SkillLearningProposal');
  assert.equal(output.outcome,'draft');
  assert.equal((await x.f.client.query('SELECT count(*)::int AS count FROM skill_draft')).rows[0].count,0);

  const invalid=new SkillLearningRuntime({store,binding,profile,call:async request=>{
    calls++;const blocks=[
      {type:'tool-call',name:'SkillLearningProposal',arguments:JSON.stringify(proposal())},
      {type:'tool-call',name:'SkillLearningProposal',arguments:JSON.stringify({outcome:'no_change'})},
    ];
    await request.validateOutput(blocks);return {text:'',blocks};
  }});
  await assert.rejects(invalid.propose(scope,claim,batch,new AbortController().signal),
    error=>error?.code==='skill_learning_stale_or_disabled');
  assert.equal(calls,2);
  let validationMarker;
  const semanticInvalid=new SkillLearningRuntime({store,binding,profile,call:async request=>{
    calls++;const blocks=[{type:'tool-call',name:'SkillLearningProposal',arguments:JSON.stringify({
      ...proposal(),target_skill_ids:[randomUUID()],
    })}];
    try{await request.validateOutput(blocks);}
    catch(error){
      validationMarker=error?.failure_kind;
      throw Object.assign(new Error('synthetic validation failure'),{code:'extraction_model_validation_failed'});
    }
    return {text:'',blocks};
  }});
  await assert.rejects(semanticInvalid.propose(scope,claim,batch,new AbortController().signal),
    error=>error?.code==='skill_learning_stale_or_disabled'&&error.retryable===false);
  assert.equal(validationMarker,'invalid_output');
  assert.equal(calls,3);
  const budgeted=new SkillLearningRuntime({store,binding,profile,call:async()=>{
    calls++;throw Object.assign(new Error('synthetic budget'),{code:'extraction_model_budget_exceeded'});
  }});
  await assert.rejects(budgeted.propose(scope,claim,batch,new AbortController().signal),
    error=>error?.code==='skill_learning_budget_exceeded'&&error.retryable===true);
  assert.equal(calls,4);
  const controller=new AbortController();controller.abort();
  const aborted=new SkillLearningRuntime({store,binding,profile,call:async()=>{calls++;throw new Error('不应调用');}});
  await assert.rejects(aborted.propose(scope,claim,batch,controller.signal));assert.equal(calls,4);
  assert.equal((await x.f.client.query('SELECT count(*)::int AS count FROM skill_draft')).rows[0].count,0);
  await taskStore.pause(claim);
});
test('提案提交后丢失步骤回执，显式恢复复用已提交批次并只进入核验步骤',async t=>{
  const x=await ownerFixture(t),tx=transaction(x.pool),files=new SkillFiles(join(x.f.directory,'skills'));
  const taskStore=new ExtractionTaskStore(x.pool),store=new SkillLearningStore({transaction:tx,files,taskStore});
  const scope={owner_id:x.owner,contact_id:x.contact},taskScope={ownerId:x.owner,contactId:x.contact};
  await store.configure(scope,{enabled:true,operationKey:randomUUID(),expectedRevision:0});
  const session=randomUUID(),input=randomUUID();
  await x.f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id)VALUES($1,$2,$3)',[session,x.owner,x.contact]);
  await x.f.client.query(`INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,
    input_type,content)VALUES($1,$2,$3,$4,$5,'purpose_exploration',$6)`,
  [input,session,x.owner,x.contact,x.binding,{type:'purpose_exploration',correction:'合成纠正：先确认对方难处再说明安排。'}]);
  await x.f.client.query('UPDATE assistant_session SET current_input_version_id=$2 WHERE id=$1',[session,input]);
  const taskId=await store.enqueue(scope);
  const supportedSteps=['propose_skill','verify_skill_drafts'];
  const claim=await taskStore.claim(taskScope,{workerId:randomUUID(),leaseMs:30_000,supportedSteps});
  assert.ok(claim);
  let calls=0;
  const runner=new SkillLearningTaskRunner({store,runtime:{async propose(){calls++;return proposal();}}});
  const proposed=await runner.run(claim,new AbortController().signal);
  assert.equal(proposed.processedCount,1);
  await x.f.client.query(`UPDATE background_task_step SET status='failed',worker_id=NULL,lease_expires_at=NULL,
    last_error_code='synthetic_lost_receipt' WHERE id=$1`,[claim.stepId]);
  await x.f.client.query(`UPDATE background_task SET status='failed',last_error_code='synthetic_lost_receipt' WHERE id=$1`,[taskId]);
  assert.equal(await store.enqueue(scope),null);
  assert.equal(await store.enqueue(scope,true),taskId);
  const verify=await taskStore.claim(taskScope,{workerId:randomUUID(),leaseMs:30_000,supportedSteps});
  assert.equal(verify?.stepName,'verify_skill_drafts');
  const verified=await runner.run(verify,new AbortController().signal);
  await taskStore.complete(verify,verified.processedCount,verified.totalCount);
  assert.equal(calls,1);
  assert.equal((await x.f.client.query('SELECT count(*)::int AS count FROM skill_draft')).rows[0].count,1);
  assert.deepEqual((await x.f.client.query('SELECT status,current_step FROM background_task WHERE id=$1',[taskId])).rows[0],
    {status:'succeeded',current_step:'verify_skill_drafts'});
});
test('学习取材纠正优先、每批至多八份且只消费当前联系人，无变化仍按批记账并继续剩余材料',async t=>{
  const x=await ownerFixture(t),tx=transaction(x.pool),files=new SkillFiles(join(x.f.directory,'skills'));
  const taskStore=new ExtractionTaskStore(x.pool),store=new SkillLearningStore({transaction:tx,files,taskStore});
  const scope={owner_id:x.owner,contact_id:x.contact},taskScope={ownerId:x.owner,contactId:x.contact};
  await store.configure(scope,{enabled:true,operationKey:randomUUID(),expectedRevision:0});
  const session=randomUUID(),ids=[];
  await x.f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id)VALUES($1,$2,$3)',[session,x.owner,x.contact]);
  for(let index=0;index<10;index++){
    const id=randomUUID();ids.push(id);
    await x.f.client.query(`INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,
      input_type,content)VALUES($1,$2,$3,$4,$5,'purpose_exploration',$6)`,
    [id,session,x.owner,x.contact,x.binding,{type:'purpose_exploration',purpose_hint:`合成普通经验${index}`}]);
  }
  const correction=randomUUID();ids.push(correction);
  await x.f.client.query(`INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,
    input_type,content)VALUES($1,$2,$3,$4,$5,'purpose_exploration',$6)`,
  [correction,session,x.owner,x.contact,x.binding,{type:'purpose_exploration',
    correction:'合成明确纠正：先核对对方指的事情，再回答。'}]);
  await x.f.client.query('UPDATE assistant_session SET current_input_version_id=$2 WHERE id=$1',[session,correction]);
  const otherSession=randomUUID(),otherInput=randomUUID(),otherContact=randomUUID(),otherBinding=randomUUID();
  await x.f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成第二联系人')",[otherContact,x.owner]);
  await x.f.client.query(`INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator,status)
    VALUES($1,$2,$3,'wechat','synthetic','synthetic-other','active')`,[otherBinding,x.owner,otherContact]);
  await x.f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id)VALUES($1,$2,$3)',
    [otherSession,x.owner,otherContact]);
  await x.f.client.query(`INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,
    input_type,content)VALUES($1,$2,$3,$4,$5,'purpose_exploration',$6)`,
  [otherInput,otherSession,x.owner,otherContact,otherBinding,{type:'purpose_exploration',
    correction:'不得跨联系人读取的合成纠正内容。'}]);
  const first=await store.capture(scope);
  assert.equal(first.materials.length,8);assert.equal(first.materials[0].material_id,correction);
  assert.ok(first.materials.every(item=>item.session_id!==otherSession));assert.equal(first.ready,true);
  assert.ok(learningInputText(first.materials,first.targets).length<=24_000);
  assert.ok(await store.enqueue(scope));
  let calls=0;
  const runner=new SkillLearningTaskRunner({store,runtime:{async propose(){calls++;return {outcome:'no_change'};}}});
  const supportedSteps=['propose_skill','verify_skill_drafts'];
  const propose=await taskStore.claim(taskScope,{workerId:randomUUID(),leaseMs:30_000,supportedSteps});
  assert.ok(propose);
  const result=await runner.run(propose,new AbortController().signal);
  await taskStore.complete(propose,result.processedCount,result.totalCount);
  const verify=await taskStore.claim(taskScope,{workerId:randomUUID(),leaseMs:30_000,supportedSteps});
  const verified=await runner.run(verify,new AbortController().signal);
  await taskStore.complete(verify,verified.processedCount,verified.totalCount);
  assert.equal(calls,1);assert.equal((await x.f.client.query('SELECT count(*)::int AS count FROM skill_draft')).rows[0].count,0);
  const second=await store.capture(scope);
  assert.equal(second.materials.length,3);assert.ok(second.materials.every(item=>item.material_id!==correction));
  assert.equal(second.materials.some(item=>item.material_id===otherInput),false);
  assert.equal((await x.f.client.query("SELECT status,current_step FROM background_task WHERE owner_id=$1 AND contact_id=$2 AND task_type='skill_learning'",
    [x.owner,x.contact])).rows[0].status,'queued');
});
test('学习材料继承消息的原始文档来源，并以稳定UTC时间参与批次身份',async t=>{
  const x=await ownerFixture(t),tx=transaction(x.pool),files=new SkillFiles(join(x.f.directory,'skills'));
  const taskStore=new ExtractionTaskStore(x.pool),store=new SkillLearningStore({transaction:tx,files,taskStore});
  const scope={owner_id:x.owner,contact_id:x.contact};
  await store.configure(scope,{enabled:true,operationKey:randomUUID(),expectedRevision:0});
  const source=randomUUID(),message=randomUUID(),session=randomUUID(),input=randomUUID();
  await x.f.client.query(`INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,
    record_count,status) VALUES($1,$2,$3,'manual','synthetic-learning-source.jsonl',$4,1,'active')`,
  [source,x.owner,x.contact,'d'.repeat(64)]);
  await x.f.client.query(`INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
    VALUES($1,$2,$3,'contact','text','合成联系人说明近期安排。','2026-10-25T09:00:00Z')`,[message,x.owner,x.contact]);
  await x.f.client.query(`INSERT INTO message_source_ref(id,message_id,owner_id,contact_id,source_kind,
    source_document_id,source_locator,raw_payload)
    VALUES($1,$2,$3,$4,'source_document',$5,'line:1','{}')`,[randomUUID(),message,x.owner,x.contact,source]);
  await x.f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id)VALUES($1,$2,$3)',[session,x.owner,x.contact]);
  await x.f.client.query(`INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,
    input_type,content,dependency_ids,created_at) VALUES($1,$2,$3,$4,$5,'purpose_exploration',$6,$7,$8)`,
  [input,session,x.owner,x.contact,x.binding,
    {type:'purpose_exploration',correction:'合成纠正：先核对安排，再给出明确回应。'},[message],'2026-10-25T10:00:00Z']);
  const batch=await store.capture(scope);
  assert.equal(batch.materials.length,1);
  assert.equal(batch.materials[0].created_at,'2026-10-25 10:00:00+00:00');
  assert.ok(batch.materials[0].dependency_ids.includes(source));
  assert.equal(batch.materials[0].external_messages[0].message_id,message);
  const normalized=normalizeProposal(scope,batch,proposal()).proposal;
  assert.ok(normalized);
  const draftId=await insertDraft(x,tx,normalized,batch);
  await tx(client=>eraseSkillLearning(client,x.owner,[source]));
  assert.equal((await x.f.client.query('SELECT status,strategy FROM skill_draft WHERE id=$1',[draftId])).rows[0].status,'invalidated');
  assert.equal((await x.f.client.query('SELECT strategy FROM skill_draft WHERE id=$1',[draftId])).rows[0].strategy,null);
});
test('授权学习经唯一任务租约至多一次提案并保存可查看草稿；旧启停重放和来源删除不复活',async t=>{
  const x=await ownerFixture(t),tx=transaction(x.pool),files=new SkillFiles(join(x.f.directory,'skills'));
  const taskStore=new ExtractionTaskStore(x.pool);
  const store=new SkillLearningStore({transaction:tx,files,taskStore});
  const scope={owner_id:x.owner,contact_id:x.contact};
  const enableKey=randomUUID();
  await store.configure(scope,{enabled:true,operationKey:enableKey,expectedRevision:0});
  await store.configure(scope,{enabled:true,operationKey:enableKey,expectedRevision:0});

  const session=randomUUID(),input=randomUUID();
  await x.f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id)VALUES($1,$2,$3)',[session,x.owner,x.contact]);
  await x.f.client.query(`INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,
    input_type,content)VALUES($1,$2,$3,$4,$5,'purpose_exploration',$6)`,
  [input,session,x.owner,x.contact,x.binding,
    {type:'purpose_exploration',correction:'合成纠正：先确认对方的难处再说明安排。'}]);
  await x.f.client.query('UPDATE assistant_session SET current_input_version_id=$2 WHERE id=$1',[session,input]);

  const taskId=await store.enqueue(scope);
  assert.ok(taskId);
  const taskScope={ownerId:x.owner,contactId:x.contact};
  const workerId=randomUUID(),claim=await taskStore.claim(taskScope,{workerId,leaseMs:30_000,
    supportedSteps:['propose_skill','verify_skill_drafts']});
  assert.equal(claim?.stepName,'propose_skill');assert.equal(claim?.taskType,'skill_learning');
  let calls=0;
  const runner=new SkillLearningTaskRunner({store,runtime:{async propose(){calls++;return proposal();}}});
  const result=await runner.run(claim,new AbortController().signal);
  assert.equal(calls,1);assert.equal(result.processedCount,1);
  await taskStore.complete(claim,result.processedCount,result.totalCount);
  let verifyClaim=await taskStore.claim(taskScope,{workerId,leaseMs:30_000,supportedSteps:['propose_skill','verify_skill_drafts']});
  assert.equal(verifyClaim?.stepName,'verify_skill_drafts');
  assert.equal(await taskStore.pause(verifyClaim),true);
  assert.deepEqual((await x.f.client.query('SELECT status,current_step FROM background_task WHERE id=$1',[taskId])).rows[0],
    {status:'queued',current_step:'verify_skill_drafts'});
  verifyClaim=await taskStore.claim(taskScope,{workerId,leaseMs:30_000,supportedSteps:['propose_skill','verify_skill_drafts']});
  assert.equal(verifyClaim?.stepName,'verify_skill_drafts');
  const verified=await runner.run(verifyClaim,new AbortController().signal);
  await taskStore.complete(verifyClaim,verified.processedCount,verified.totalCount);
  const task=(await x.f.client.query('SELECT status,current_step FROM background_task WHERE id=$1',[taskId])).rows[0];
  assert.deepEqual(task,{status:'succeeded',current_step:'verify_skill_drafts'});
  const listed=await store.list(scope);
  assert.equal(listed.drafts.length,1);assert.equal(listed.drafts[0].status,'pending');
  assert.equal(listed.recent_outcomes[0],'draft');
  assert.equal(await store.enqueue(scope),null);assert.equal(calls,1);
  const receipt=(await x.f.client.query('SELECT material_id,digest FROM skill_learning_receipt WHERE owner_id=$1 AND contact_id=$2',
    [x.owner,x.contact])).rows[0];
  assert.equal(receipt.material_id,input);assert.ok(receipt.digest);

  await x.f.client.query('BEGIN');await eraseSkillLearning(x.f.client,x.owner,[input]);await x.f.client.query('COMMIT');
  const draft=(await x.f.client.query('SELECT status,strategy,private_evidence FROM skill_draft WHERE owner_id=$1 AND contact_id=$2',
    [x.owner,x.contact])).rows[0];
  assert.deepEqual(draft,{status:'invalidated',strategy:null,private_evidence:null});
  assert.equal((await x.f.client.query('SELECT digest FROM skill_learning_receipt WHERE material_id=$1',[input])).rows[0].digest,null);
  const staleKey=randomUUID();
  await store.configure(scope,{enabled:false,operationKey:staleKey,expectedRevision:1});
  await store.configure(scope,{enabled:true,operationKey:randomUUID(),expectedRevision:2});
  await assert.rejects(store.configure(scope,{enabled:false,operationKey:staleKey,expectedRevision:1}));
});
test('同输入审核批准只发布一次，历史与范围政策可用，来源删除擦除发布与文件',async t=>{
  const x=await ownerFixture(t),tx=transaction(x.pool),filesRoot=join(x.f.directory,'skills'),files=new SkillFiles(filesRoot);
  const taskStore=new ExtractionTaskStore(x.pool);
  const learning=new SkillLearningStore({transaction:tx,files,taskStore});
  const library=new SkillLibrary(x.storage,files);
  const review=new SkillReviewStore({transaction:tx,learning,files,library});
  const historyPolicy=new SkillHistoryPolicyStore({transaction:tx,files,library});
  const scope={owner_id:x.owner,contact_id:x.contact};
  const normalized=normalizeProposal(scope,baseBatch(),proposal()).proposal;
  assert.ok(normalized);
  const draftId=randomUUID(),generation=await tx(client=>captureSkillGeneration(client,x.owner,x.contact,[]));
  await x.f.client.query(`INSERT INTO skill_draft(id,owner_id,contact_id,logical_skill_id,proposal_kind,strategy,
    private_evidence,target_versions,dependency_ids,source_generation,batch_key)
    VALUES($1,$2,$3,$4,'create',$5,$6,$7,'{}',$8,'synthetic-batch')`,
  [draftId,x.owner,x.contact,normalized.logical_skill_id,normalized.strategy,
    {materials:baseBatch().materials,existing_skills:[]},'[]',generation]);
  const fingerprint=createHash('sha256').update('synthetic-context').digest('hex');
  const input={incoming_text:'我们需要把安排说清楚。',intent:'先理解对方，再说明安排。',scene:'合成冲突澄清'};
  const confirmed={kind:'contact',contact_id:x.contact,scene:null};
  const revisions={library:0,memory:0,index:null,preferences:null,binding_id:x.binding};
  const started=await review.beginComparison(scope,{draftId,expectedRevision:1,operationKey:randomUUID(),
    input,scopeConfirmation:confirmed,contextFingerprint:fingerprint,contextDependencies:[],
    contextRevisions:revisions,navigation:[]});
  assert.equal(started.comparison.state,'running');
  const preview={before:{name:null,version_id:null,load_state:'not_used',candidates:[
    {text:'我会先了解情况。',basis:'用户明确审核输入。',risk_notes:[]}]},
    after:{name:normalized.strategy.name,version_id:started.comparison.id,load_state:'loaded',
      candidates:[{text:'听起来你现在不容易，我想先把安排说明白。',basis:'用户明确审核输入与合成草稿。',risk_notes:[]}]}};
  await review.finishComparison(scope,started.comparison.id,started.comparison.run_token,fingerprint,preview);
  const approveCommand={draftId,expectedRevision:1,operationKey:randomUUID(),comparisonId:started.comparison.id,
    scopeConfirmation:confirmed};
  const approved=await review.approve(scope,approveCommand);
  assert.equal(approved.draft.status,'published');
  assert.equal(approved.published.version_number,1);
  assert.deepEqual(approved.published.scope,confirmed);
  assert.equal((await x.f.client.query('SELECT count(*)::int AS count FROM reply_skill_version')).rows[0].count,1);
  const version=approved.published.version_id;
  const row=(await x.f.client.query('SELECT review_origin,method_manifest_path,directory_available FROM reply_skill_version WHERE id=$1',[version])).rows[0];
  assert.equal(row.review_origin,true);assert.ok(row.method_manifest_path);assert.equal(row.directory_available,true);

  const port=new PostgresSkillPort({read:work=>x.storage.businessReadTransaction(work)},filesRoot);
  const catalog=await port.catalog({ownerId:x.owner,contactId:x.contact,scene:'合成冲突澄清'});
  assert.equal(catalog.entries.length,1);
  const loaded=await port.loadVersion({ownerId:x.owner,contactId:x.contact,scene:'合成冲突澄清'},
    catalog.entries[0],catalog.revision);
  assert.match(loaded.content,/先确认理解/);
  port.dispose();

  const history=await historyPolicy.readHistory(scope);
  assert.equal(history.skills.length,1);assert.equal(history.skills[0].versions.length,1);
  const policies=await historyPolicy.readPolicies(scope);
  const disabled=await historyPolicy.changePolicy(scope,{skillId:approved.published.skill_id,versionId:version,
    methodId:history.skills[0].versions[0].methods[0].method_id,scope:confirmed,disabled:true,
    expectedRevision:policies.revision,operationKey:randomUUID()});
  assert.equal(disabled.policies.length,1);
  const blockedPort=new PostgresSkillPort({read:work=>x.storage.businessReadTransaction(work)},filesRoot);
  assert.equal((await blockedPort.catalog({ownerId:x.owner,contactId:x.contact,scene:'合成冲突澄清'})).entries.length,0);
  blockedPort.dispose();
  const undone=await historyPolicy.undoPolicy(scope,{policyId:disabled.policies[0].policy_id,
    expectedRevision:disabled.revision,operationKey:randomUUID()});
  assert.deepEqual(undone.policies,[]);

  const replay=await review.approve(scope,approveCommand);
  assert.equal(replay.published.version_id,version);
  assert.equal((await x.f.client.query('SELECT count(*)::int AS count FROM reply_skill_version')).rows[0].count,1);
  await assert.rejects(review.approve(scope,{...approveCommand,operationKey:randomUUID()}));

  await x.f.client.query('BEGIN');await eraseSkillLearning(x.f.client,x.owner,[version],async()=>{});await x.f.client.query('COMMIT');
  assert.equal((await x.f.client.query('SELECT status FROM skill_draft WHERE id=$1',[draftId])).rows[0].status,'invalidated');
  assert.equal((await x.f.client.query('SELECT deleted FROM reply_skill_publication WHERE version_id=$1',[version])).rows[0].deleted,true);
  assert.equal((await x.f.client.query('SELECT status,content_path FROM reply_skill_version WHERE id=$1',[version])).rows[0].status,'deleted');
  await cleanupSkillFiles(x.f.client,x.owner,files);
});
test('版本历史回滚复验当前修订并把原操作键结算为幂等',async t=>{
  const x=await ownerFixture(t),tx=transaction(x.pool),filesRoot=join(x.f.directory,'skills'),files=new SkillFiles(filesRoot);
  const taskStore=new ExtractionTaskStore(x.pool),learning=new SkillLearningStore({transaction:tx,files,taskStore});
  const library=new SkillLibrary(x.storage,files),review=new SkillReviewStore({transaction:tx,learning,files,library});
  const historyPolicy=new SkillHistoryPolicyStore({transaction:tx,files,library});
  const http=new SkillLearningHttp({ownerId:x.owner,learning,review,historyPolicy,canSchedule:false,
    wake:async()=>{throw new Error('不应唤醒未启用调度')}});
  const scope={owner_id:x.owner,contact_id:x.contact},path=join(x.f.directory,'history-skill');
  await mkdir(path);await writeFile(join(path,'SKILL.md'),'---\nname: history-skill\ndescription: "用于合成历史回滚场景。"\n---\n\n第一版正文');
  const imported=await library.importPackage(x.owner,path);
  const firstVersion=(await x.f.client.query('SELECT id FROM reply_skill_version WHERE skill_id=$1 AND version_number=1',
    [imported.skill_id])).rows[0].id;
  await writeFile(join(path,'SKILL.md'),'---\nname: history-skill\ndescription: "用于合成历史回滚场景。"\n---\n\n第二版正文');
  const updated=await library.updatePackage(x.owner,path);
  let history=await historyPolicy.readHistory(scope,imported.skill_id);
  assert.equal(history.current_version_id,updated.version_id);
  const unchangedAt=(await x.f.client.query('SELECT updated_at::text FROM reply_skill WHERE id=$1',
    [imported.skill_id])).rows[0].updated_at;
  const unchanged=await historyPolicy.rollback(scope,{skillId:imported.skill_id,versionId:updated.version_id,
    expectedRevision:history.revision,expectedCurrentVersionId:history.current_version_id,operationKey:randomUUID()});
  assert.equal(unchanged.current_version_id,updated.version_id);assert.equal(unchanged.revision,history.revision);
  assert.equal((await x.f.client.query('SELECT updated_at::text FROM reply_skill WHERE id=$1',
    [imported.skill_id])).rows[0].updated_at,unchangedAt);
  const operation=randomUUID();
  const command={skillId:imported.skill_id,versionId:firstVersion,expectedRevision:history.revision,
    expectedCurrentVersionId:history.current_version_id,operationKey:operation};
  const signal=new AbortController().signal,url=new URL(
    `http://synthetic.invalid/api/contacts/${x.contact}/skill-learning/skills/${imported.skill_id}/rollback`);
  const rolled=await http.handle('POST',url,{version_id:command.versionId,expected_revision:command.expectedRevision,
    expected_current_version_id:command.expectedCurrentVersionId,operation_key:command.operationKey},signal);
  assert.equal(rolled.status,200,JSON.stringify(rolled.body));
  history=rolled.body;
  assert.equal(history.current_version_id,firstVersion);
  const revision=history.revision;
  const replay=await http.handle('POST',url,{version_id:command.versionId,expected_revision:command.expectedRevision,
    expected_current_version_id:command.expectedCurrentVersionId,operation_key:command.operationKey},signal);
  assert.equal(replay.status,200,JSON.stringify(replay.body));
  history=replay.body;
  assert.equal(history.current_version_id,firstVersion);assert.equal(history.revision,revision);
});
test('更新草稿冻结目标版本，目标发布新版本后旧对照不能批准',async t=>{
  const x=await ownerFixture(t),tx=transaction(x.pool),filesRoot=join(x.f.directory,'skills'),files=new SkillFiles(filesRoot);
  const taskStore=new ExtractionTaskStore(x.pool),learning=new SkillLearningStore({transaction:tx,files,taskStore});
  const library=new SkillLibrary(x.storage,files),review=new SkillReviewStore({transaction:tx,learning,files,library});
  const scope={owner_id:x.owner,contact_id:x.contact},path=join(x.f.directory,'target-skill');
  await mkdir(path);await writeFile(join(path,'SKILL.md'),
    '---\nname: target-skill\ndescription: "合成目标方法。"\n---\n\n# 原方法\n\n先确认对方意思。');
  await library.importPackage(x.owner,path);
  await learning.configure(scope,{enabled:true,operationKey:randomUUID(),expectedRevision:0});
  const batch=await learning.capture(scope),target=batch.targets[0];
  assert.ok(target,JSON.stringify((await x.f.client.query(`SELECT skill.id,skill.status,version.is_current,version.enabled,
    version.status AS version_status,version.content_path,version.directory_available,version.review_origin
    FROM reply_skill skill JOIN reply_skill_version version ON version.skill_id=skill.id WHERE skill.owner_id=$1`,[x.owner])).rows));
  const normalized=normalizeProposal(scope,batch,{outcome:'draft',proposal_kind:'update',
    target_skill_ids:[target.skill_id],name:target.name,description:'更新后的合成目标方法。',scene:'合成目标场景',
    scope_suggestion:{kind:'contact',reason:'更新仍只供当前联系人审核。'},
    methods:[{key:'clarify-target',title:'核对目标',instruction:'先确认对方指的目标，再说明处理方式。',
      replaces_method_ids:target.methods.map(item=>item.method_id)}]}).proposal;
  assert.ok(normalized);
  const draftId=await insertDraft(x,tx,normalized,batch);
  const built=await prepareReviewContext(tx,scope,{incoming_text:'这件事怎么处理？',intent:'先核对目标。',scene:'合成目标场景'});
  const ready=await readyComparison(x,tx,review,scope,built,normalized);
  await writeFile(join(path,'SKILL.md'),
    '---\nname: target-skill\ndescription: "合成目标方法。"\n---\n\n# 新方法\n\n先确认目标，再说明选择。');
  await library.updatePackage(x.owner,path);
  await assert.rejects(review.approve(scope,{draftId,expectedRevision:1,operationKey:randomUUID(),
    comparisonId:ready.comparisonId,scopeConfirmation:ready.confirmed}),
  error=>error?.code==='skill_learning_stale_or_disabled');
  assert.equal((await x.f.client.query('SELECT count(*)::int AS count FROM reply_skill_version WHERE skill_id=$1',
    [target.skill_id])).rows[0].count,2);
});
test('HTTP 入口覆盖授权、列表、草稿读取编辑暂留拒绝、对照、批准、历史以及范围政策撤销',async t=>{
  const x=await ownerFixture(t),tx=transaction(x.pool),filesRoot=join(x.f.directory,'skills'),files=new SkillFiles(filesRoot);
  const taskStore=new ExtractionTaskStore(x.pool),learning=new SkillLearningStore({transaction:tx,files,taskStore});
  const library=new SkillLibrary(x.storage,files),review=new SkillReviewStore({transaction:tx,learning,files,library});
  const historyPolicy=new SkillHistoryPolicyStore({transaction:tx,files,library});
  const scope={owner_id:x.owner,contact_id:x.contact},comparisons=[];
  const http=new SkillLearningHttp({ownerId:x.owner,learning,review,
    reviewService:{compare:async(...args)=>{comparisons.push(args);return {synthetic_comparison:true};}},
    historyPolicy,canSchedule:false,wake:async()=>{throw new Error('不应唤醒未启用调度')}});
  const signal=new AbortController().signal;
  const call=(method,suffix='',body)=>http.handle(method,
    new URL(`http://synthetic.invalid/api/contacts/${x.contact}/skill-learning${suffix}`),body,signal);

  assert.equal((await call('POST','',{enabled:true,confirmed:true,operation_key:randomUUID(),expected_revision:0})).status,200);
  const pending=normalizeProposal(scope,baseBatch(),proposal()).proposal,draftId=await insertDraft(x,tx,pending);
  const listed=await call('GET');
  assert.equal(listed.body.enabled,true);assert.equal(listed.body.drafts[0].draft_id,draftId);
  assert.equal((await call('GET',`/drafts/${draftId}`)).body.draft.revision,1);
  const strategy={name:pending.strategy.name,description:pending.strategy.description,scene:pending.strategy.scene,
    methods:pending.strategy.methods.map(({key,title,instruction,replaces_method_ids})=>({key,title,instruction,replaces_method_ids}))};
  const edited=await call('POST',`/drafts/${draftId}/edit`,{expected_revision:1,operation_key:randomUUID(),strategy});
  assert.equal(edited.status,200,JSON.stringify(edited.body));assert.equal(edited.body.draft.revision,2);
  const deferred=await call('POST',`/drafts/${draftId}/decision`,{expected_revision:2,operation_key:randomUUID(),decision:'defer'});
  assert.equal(deferred.body.draft.status,'pending');
  const rejected=await call('POST',`/drafts/${draftId}/decision`,{expected_revision:3,operation_key:randomUUID(),decision:'reject'});
  assert.equal(rejected.body.draft.status,'rejected');

  const approvalDraft=await insertDraft(x,tx,pending);
  const input={incoming_text:'我们需要把安排说清楚。',intent:'先理解对方，再说明安排。',scene:'合成冲突澄清'};
  const confirmed={kind:'contact',contact_id:x.contact,scene:null};
  assert.equal((await call('POST',`/drafts/${approvalDraft}/compare`,{expected_revision:1,operation_key:randomUUID(),
    input,scope:confirmed})).status,200);
  assert.equal(comparisons.length,1);assert.equal(comparisons[0][1].draftId,approvalDraft);
  const fingerprint=createHash('sha256').update('http-review-context').digest('hex');
  const comparison=await review.beginComparison(scope,{draftId:approvalDraft,expectedRevision:1,
    operationKey:randomUUID(),input,scopeConfirmation:confirmed,contextFingerprint:fingerprint,
    contextDependencies:[],contextRevisions:{library:0,memory:0,index:null,preferences:null,binding_id:x.binding},
    navigation:[]});
  const result={before:{name:null,version_id:null,load_state:'not_used',candidates:[]},
    after:{name:pending.strategy.name,version_id:comparison.comparison.id,load_state:'loaded',candidates:[]}};
  await review.finishComparison(scope,comparison.comparison.id,comparison.comparison.run_token,fingerprint,result);
  const approved=await call('POST',`/drafts/${approvalDraft}/approve`,{expected_revision:1,operation_key:randomUUID(),
    comparison_id:comparison.comparison.id,scope:confirmed,confirmed:true,replacements_confirmed:true});
  assert.equal(approved.body.draft.status,'published');
  const version=approved.body.published.version_id;

  const history=await call('GET','/skills');
  assert.equal(history.body.skills.length,1);assert.equal(history.body.skills[0].versions[0].version_id,version);
  const oneHistory=await call('GET',`/skills/${approved.body.published.skill_id}`);
  assert.equal(oneHistory.status,200);
  assert.equal(oneHistory.body.skill_id,approved.body.published.skill_id);
  assert.equal(oneHistory.body.versions[0].version_id,version);
  const methodId=history.body.skills[0].versions[0].methods[0].method_id;
  const policyKey=randomUUID();
  const disabled=await call('POST','/policies',{skill_id:approved.body.published.skill_id.toUpperCase(),
    version_id:version.toUpperCase(),method_id:methodId.toUpperCase(),scope:{kind:'contact',
      contact_id:x.contact.toUpperCase(),scene:null},disabled:true,expected_revision:0,operation_key:policyKey.toUpperCase()});
  assert.equal(disabled.body.policies.length,1);
  const disabledReplay=await call('POST','/policies',{skill_id:approved.body.published.skill_id,version_id:version,
    method_id:methodId,scope:{kind:'contact',contact_id:x.contact,scene:null},disabled:true,
    expected_revision:0,operation_key:policyKey});
  assert.deepEqual(disabledReplay.body,disabled.body);
  const undone=await call('POST',`/policies/${disabled.body.policies[0].policy_id}/undo`,
    {expected_revision:disabled.body.revision,operation_key:randomUUID()});
  assert.deepEqual(undone.body.policies,[]);
  assert.equal((await call('POST','',{resume:true})).status,503);
  assert.equal((await call('GET','?unexpected=true')).status,400);
  const malformed=await call('POST','',{enabled:true,confirmed:true,operation_key:'not-a-uuid',expected_revision:0});
  assert.equal(malformed.status,400);assert.equal(malformed.body.error,'skill_learning_request_invalid');
  const invalidScope=await call('POST',`/drafts/${approvalDraft}/compare`,{expected_revision:1,
    operation_key:randomUUID(),input,scope:{kind:'contact',contact_id:randomUUID(),scene:null}});
  assert.equal(invalidScope.status,400);assert.equal(invalidScope.body.error,'skill_learning_request_invalid');
  await x.f.client.query("UPDATE conversation_binding SET status='revoked',revoked_at=now() WHERE id=$1",[x.binding]);
  const staleBinding=await call('POST','',{enabled:true,confirmed:true,operation_key:randomUUID(),expected_revision:1});
  assert.equal(staleBinding.status,409);
  assert.equal(staleBinding.body.error,'skill_learning_stale_or_disabled');

  const listedState={drafts:[],enabled:true,task:null,recent_outcomes:[],scope_revision:1};
  const wakeFailure=new SkillLearningHttp({ownerId:x.owner,
    learning:{enqueue:async()=>randomUUID(),list:async()=>listedState},
    review,historyPolicy,canSchedule:true,wake:async()=>{throw new Error('synthetic wake failure');}});
  const persisted=await wakeFailure.handle('GET',new URL(`http://synthetic.invalid/api/contacts/${x.contact}/skill-learning`),
    undefined,signal);
  assert.equal(persisted.status,200);assert.deepEqual(persisted.body,listedState);
  const internalFailure=new SkillLearningHttp({ownerId:x.owner,
    learning:{enqueue:async()=>null,list:async()=>{throw new TypeError('synthetic internal failure');}},
    review,historyPolicy,canSchedule:true,wake:async()=>{}});
  const failed=await internalFailure.handle('GET',new URL(`http://synthetic.invalid/api/contacts/${x.contact}/skill-learning`),
    undefined,signal);
  assert.equal(failed.status,500);assert.deepEqual(failed.body,{error:'internal_error'});
  const databaseFailure=new SkillLearningHttp({ownerId:x.owner,
    learning:{enqueue:async()=>null,list:async()=>{throw Object.assign(new Error('synthetic database failure'),{code:'57P01'});}},
    review,historyPolicy,canSchedule:true,wake:async()=>{}});
  const unavailable=await databaseFailure.handle('GET',
    new URL(`http://synthetic.invalid/api/contacts/${x.contact}/skill-learning`),undefined,signal);
  assert.equal(unavailable.status,503);assert.deepEqual(unavailable.body,{error:'skill_learning_unavailable'});
});
test('审核预览经生产上下文读取L2与L3，来源、记忆、分层、偏好、库修订或绑定变化均拒绝旧批准',async t=>{
  const x=await ownerFixture(t),tx=transaction(x.pool),filesRoot=join(x.f.directory,'skills'),files=new SkillFiles(filesRoot);
  const taskStore=new ExtractionTaskStore(x.pool),learning=new SkillLearningStore({transaction:tx,files,taskStore});
  const library=new SkillLibrary(x.storage,files),review=new SkillReviewStore({transaction:tx,learning,files,library});
  const scope={owner_id:x.owner,contact_id:x.contact},normalized=normalizeProposal(scope,baseBatch(),proposal()).proposal;
  const seeded=await seedLayered(x);
  const input={incoming_text:'明天我们怎么安排？',intent:'直接说明时间安排。',scene:'合成冲突澄清'};
  const built=await prepareReviewContext(tx,scope,input);
  assert.ok(built.context.layered_context);assert.ok(built.context.owner_layered_context);
  const contactMaterial=JSON.parse(built.context.layered_context.payload_json);
  const ownerMaterial=JSON.parse(built.context.owner_layered_context.payload_json);
  assert.equal(contactMaterial.directory[0].title,'合成课程安排');
  assert.equal(ownerMaterial.profile_entries[0].text,'偏好直接说明时间安排。');
  assert.equal(built.layered.length,2);
  assert.ok(built.dependencies.includes(seeded.source));
  assert.ok(built.layered.some(item=>item.snapshot.dependency_ids.includes(seeded.ownerMemory)));
  const captured=await tx(client=>captureReviewSources(client,scope,[],built.dependencies,built.navigation,[],{
    checking:new Set(),validated:new Set()},built.layered));
  assert.equal(captured.frozen.version,4);
  assert.equal(await tx(client=>reviewSourcesCurrent(client,scope,captured.dependencies,captured.frozen,{
    checking:new Set(),validated:new Set()})),true);
  const emptyLayered=structuredClone(captured.frozen);
  emptyLayered.layered[0].snapshot.profile_entries=[];emptyLayered.layered[0].snapshot.scenarios=[];
  assert.equal(await tx(client=>reviewSourcesCurrent(client,scope,captured.dependencies,emptyLayered,{
    checking:new Set(),validated:new Set()})),false);

  const first=await readyComparison(x,tx,review,scope,built,normalized);
  const reject=async ready=>assert.rejects(review.approve(scope,{draftId:ready.draftId,expectedRevision:1,
    operationKey:randomUUID(),comparisonId:ready.comparisonId,scopeConfirmation:ready.confirmed}),
  error=>error?.code==='skill_learning_stale_or_disabled');
  await x.f.client.query(`UPDATE scenario_document_version SET title='合成课程安排已变化' WHERE id=$1`,[seeded.contactVersion]);
  await reject(first);

  let next=await prepareReviewContext(tx,scope,input);
  let ready=await readyComparison(x,tx,review,scope,next,normalized);
  await x.f.client.query(`UPDATE layered_profile_version SET entries=$2::jsonb WHERE id=$1`,
    [seeded.profileVersion,JSON.stringify([{text:'偏好先简短问候再说明安排。',kind:'inference',uncertainty:'低',references:[]}])]);
  await reject(ready);

  next=await prepareReviewContext(tx,scope,input);
  ready=await readyComparison(x,tx,review,scope,next,normalized);
  await x.f.client.query(`INSERT INTO contact_memory_state(owner_id,contact_id,memory_revision) VALUES($1,$2,1)
    ON CONFLICT(owner_id,contact_id) DO UPDATE SET memory_revision=contact_memory_state.memory_revision+1`,
  [x.owner,x.contact]);
  await reject(ready);

  next=await prepareReviewContext(tx,scope,input);
  ready=await readyComparison(x,tx,review,scope,next,normalized);
  await x.f.client.query(`INSERT INTO skill_library(owner_id,revision) VALUES($1,1)
    ON CONFLICT(owner_id) DO UPDATE SET revision=skill_library.revision+1`,[x.owner]);
  await reject(ready);

  next=await prepareReviewContext(tx,scope,input);
  ready=await readyComparison(x,tx,review,scope,next,normalized);
  await x.f.client.query(`INSERT INTO expression_preference_state(owner_id,revision) VALUES($1,1)
    ON CONFLICT(owner_id) DO UPDATE SET revision=expression_preference_state.revision+1`,[x.owner]);
  await reject(ready);

  next=await prepareReviewContext(tx,scope,input);
  ready=await readyComparison(x,tx,review,scope,next,normalized);
  await x.f.client.query(`UPDATE source_document SET status='delete_requested' WHERE id=$1`,[seeded.source]);
  await reject(ready);

  next=await prepareReviewContext(tx,scope,input);
  ready=await readyComparison(x,tx,review,scope,next,normalized);
  await x.f.client.query(`UPDATE conversation_binding SET status='revoked',revoked_at=now() WHERE id=$1`,[x.binding]);
  await reject(ready);
});
