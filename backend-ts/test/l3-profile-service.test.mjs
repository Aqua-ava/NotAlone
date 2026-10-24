import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {L3ProfileService} from '../src/l3-profile-service.ts';
import {renderProfile} from '../src/l3-profile-workspace.ts';
import {captureLayeredSnapshot, selectLayeredMaterial, validateLayeredSnapshot} from '../src/reply-context-layered.ts';
import {readReplyContactOverview, readReplyOwnerOverview} from '../src/reply-context-overview.ts';
import {scenarioDigest} from '../src/l2-scenario-workspace.ts';

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

function entry(memory, overrides = {}) {
  return {
    text: '双方有二〇二四年的共同课程经历。',
    kind: 'fact',
    section: 'life_context',
    basis: '底层记忆直接记载共同参加课程。',
    temporal_status: 'historical',
    uncertainty: '',
    references: [{memory_id: memory.memoryId, revision: 1}],
    ...overrides,
  };
}

function profilePort(memory, inspect = () => {}) {
  let calls = 0;
  return {
    get calls() { return calls; },
    async call(input) {
      calls++;
      await input.requireCurrent();
      inspect(calls, input);
      const tool = (name, args) => ({
        blocks: [{type:'tool-call', id:`profile-${calls}`, name, arguments:JSON.stringify(args)}],
        receipt_id: randomUUID(),
      });
      if (calls === 1) return tool('write', {
        path: 'profile.md',
        content: renderProfile({entries: [entry(memory)]}),
      });
      if (calls === 2) return {blocks:[], receipt_id:randomUUID()};
      if (calls === 3) return tool('ProfileVerificationOutput', {results:[{
        entry_index: 0,
        supported: true,
        evidence: [{memory_id: memory.memoryId, quote: memory.text}],
      }]});
      throw new Error('unexpected_profile_call');
    },
  };
}

async function createScope(f, options = {}) {
  const ownerId = randomUUID();
  const contactId = options.owner ? null : randomUUID();
  const sourceId = randomUUID();
  const memoryId = randomUUID();
  const l2BatchId = randomUUID();
  const scenarioId = randomUUID();
  const scenarioVersionId = randomUUID();
  const taskId = randomUUID();
  const stepId = randomUUID();
  const workerId = randomUUID();
  const text = options.text ?? '双方在二〇二四年参加过合成课程。';
  await f.client.query("INSERT INTO owner(id,display_name)VALUES($1,'L3合成所有者')", [ownerId]);
  if (contactId) await f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'L3合成联系人')", [contactId, ownerId]);
  if (contactId) {
    await f.client.query(`INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
      VALUES($1,$2,$3,'manual','l3-synthetic.txt',$4,1)`, [sourceId, ownerId, contactId, 'b'.repeat(64)]);
    await f.client.query(`INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method)
      VALUES($1,$2,$3,$4,'common_fact','study',$5,'manual')`, [memoryId, ownerId, contactId, text, [sourceId]]);
  } else {
    await f.client.query(`INSERT INTO owner_memory(id,owner_id,text_content,category,topic,source_ids,adoption_method)
      VALUES($1,$2,$3,'common_fact','study',$4,'manual')`, [memoryId, ownerId, text, [ownerId]]);
  }
  if (options.validAt) {
    await f.client.query(`UPDATE ${contactId ? 'confirmed_memory' : 'owner_memory'}
      SET valid_at=$2::timestamptz WHERE id=$1`, [memoryId, options.validAt]);
  }
  await f.client.query(`INSERT INTO background_task(id,owner_id,contact_id,task_type,status,current_step,message_count)
    VALUES($1,$2,$3,'layered_memory','running','organize_memory',1)`, [taskId, ownerId, contactId]);
  await f.client.query(`INSERT INTO background_task_step(id,task_id,step_name,step_order,status,worker_id,lease_generation,attempt_count,lease_expires_at)
    VALUES($1,$2,'organize_memory',1,'running',$3,1,1,now()+interval '10 minutes')`, [stepId, taskId, workerId]);
  await f.client.query(`INSERT INTO layered_memory_state
    (owner_id,contact_id,enabled,settings_generation,status,organization_generation,covered_count,maintenance_allowed)
    VALUES($1,$2,true,1,'ready',1,1,true) ON CONFLICT DO NOTHING`, [ownerId, contactId]);
  await f.client.query(`UPDATE layered_memory_state
    SET enabled=true,settings_generation=1,status='ready',organization_generation=1,covered_count=1,maintenance_allowed=true
    WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`, [ownerId, contactId]);
  const overview = contactId
    ? await readReplyContactOverview(f.client, {owner_id:ownerId, contact_id:contactId})
    : await readReplyOwnerOverview(f.client, ownerId, true);
  const projected = overview.entries.find(item => item.memory.memory_id === memoryId);
  assert.ok(projected);
  const manifest = [{
    ...projected.dependency_manifest,
    organization_timing_sha256: scenarioDigest(projected.memory.timing ?? {}),
  }];
  await f.client.query(`INSERT INTO layered_memory_job
    (task_id,owner_id,contact_id,settings_generation,target_key,contract,target_manifest,dependency_ids,state,run_remaining,
     model_call_limit,profile_required,profile_status,pending_receipt,receipt_batch_id,receipt_lease_generation,model_calls_used)
    VALUES($1,$2,$3,1,$4,'profile-tools-v1:document-tools-v1',$5,$6,'active',1,$7,true,'pending',false,NULL,NULL,3)`,
  [taskId, ownerId, contactId, `profile:${taskId}`, JSON.stringify(manifest), [memoryId], budget.max_model_calls]);
  await f.client.query(`INSERT INTO layered_memory_batch
    (id,owner_id,contact_id,settings_generation,work_key,status,input_manifest,input_payload,dependency_ids,created_at,task_id)
    VALUES($1,$2,$3,1,$4,'succeeded',$5,'{}',$6,now(),$7)`,
  [l2BatchId, ownerId, contactId, `l3-seed-${l2BatchId}`, JSON.stringify(manifest), [memoryId], taskId]);
  await f.client.query(`UPDATE layered_memory_job SET pending_receipt=true,receipt_batch_id=$2,receipt_lease_generation=1
    WHERE task_id=$1`, [taskId, l2BatchId]);
  await f.client.query(`INSERT INTO scenario_document_version
    (id,owner_id,contact_id,scenario_id,batch_id,organization_generation,schema_version,title,hint,paragraphs,created_at)
    VALUES($1,$2,$3,$4,$5,1,1,'合成课程','共同经历',$6,now())`,
  [scenarioVersionId, ownerId, contactId, scenarioId, l2BatchId, JSON.stringify([{
    text,
    references:[{memory_id:memoryId, revision:1}],
  }])]);
  await f.client.query(`INSERT INTO layered_memory_generation
    (owner_id,contact_id,organization_generation,schema_version,scenario_version_ids,profile_version_id,dependency_ids)
    VALUES($1,$2,1,2,$3,NULL,$4)`, [ownerId, contactId, [scenarioVersionId], [memoryId]]);
  return {
    ownerId, contactId, sourceId, memoryId, l2BatchId, scenarioId, scenarioVersionId, taskId,
    scope:{owner_id:ownerId, contact_id:contactId},
    claim:{task_id:taskId, step_id:stepId, step_name:'organize_memory', worker_id:workerId, lease_generation:1},
    memory:{memoryId, text},
  };
}

function service(f, port, hooks = {}) {
  const transaction = async work => {
    await f.client.query('BEGIN');
    try { const value = await work(f.client); await f.client.query('COMMIT'); return value; }
    catch (error) { await f.client.query('ROLLBACK'); throw error; }
  };
  return new L3ProfileService({
    transaction,
    model:port,
    binding,
    profile,
    budget,
    now:() => new Date('2026-10-25T02:00:00Z'),
    ...hooks,
  });
}

async function addTask(f, scope) {
  const taskId = randomUUID(), stepId = randomUUID(), workerId = randomUUID();
  const receipt = (await f.client.query(`SELECT j.receipt_batch_id
    FROM layered_memory_job j WHERE j.owner_id=$1 AND j.contact_id IS NOT DISTINCT FROM $2::uuid
    ORDER BY j.created_at DESC LIMIT 1`, [scope.owner_id, scope.contact_id])).rows[0].receipt_batch_id;
  await f.client.query(`INSERT INTO background_task(id,owner_id,contact_id,task_type,status,current_step,message_count)
    VALUES($1,$2,$3,'layered_memory','running','organize_memory',1)`, [taskId, scope.owner_id, scope.contact_id]);
  await f.client.query(`INSERT INTO background_task_step(id,task_id,step_name,step_order,status,worker_id,lease_generation,attempt_count,lease_expires_at)
    VALUES($1,$2,'organize_memory',1,'running',$3,1,1,now()+interval '10 minutes')`, [stepId, taskId, workerId]);
  await f.client.query(`INSERT INTO layered_memory_job
    (task_id,owner_id,contact_id,settings_generation,target_key,contract,target_manifest,dependency_ids,state,run_remaining,
     model_call_limit,profile_required,profile_status,pending_receipt,receipt_batch_id,receipt_lease_generation,model_calls_used)
    VALUES($1,$2,$3,1,$4,'profile-tools-v1:document-tools-v1','[]','{}','active',1,8,true,'pending',true,$5,1,0)`,
  [taskId, scope.owner_id, scope.contact_id, `profile-next:${taskId}`, receipt]);
  return {task_id:taskId, step_id:stepId, step_name:'organize_memory', worker_id:workerId, lease_generation:1};
}

async function addIncrementalScenarioGeneration(f, x, text, options = {}) {
  const source = randomUUID(), memoryId = randomUUID(), taskId = randomUUID(), stepId = randomUUID(), workerId = randomUUID();
  const batchId = randomUUID(), scenarioId = randomUUID(), versionId = randomUUID();
  const organizationGeneration = options.organizationGeneration ?? 3;
  const generationScenarioIds = options.retainPrevious === false
    ? [versionId]
    : [x.scenarioVersionId, versionId];
  await f.client.query(`INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
    VALUES($1,$2,$3,'manual',$4,$5,1)`, [source,x.ownerId,x.contactId,`l3-incremental-${source}`,
    source.replaceAll('-','').padEnd(64,'0')]);
  await f.client.query(`INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,topic,source_ids,adoption_method)
    VALUES($1,$2,$3,$4,'preference','study',$5,'manual')`, [memoryId,x.ownerId,x.contactId,text,[source]]);
  await f.client.query(`INSERT INTO background_task(id,owner_id,contact_id,task_type,status,current_step,message_count)
    VALUES($1,$2,$3,'layered_memory','running','organize_memory',1)`, [taskId,x.ownerId,x.contactId]);
  await f.client.query(`INSERT INTO background_task_step(id,task_id,step_name,step_order,status,worker_id,lease_generation,attempt_count,lease_expires_at)
    VALUES($1,$2,'organize_memory',1,'running',$3,1,1,now()+interval '10 minutes')`, [stepId,taskId,workerId]);
  await f.client.query(`INSERT INTO layered_memory_job
    (task_id,owner_id,contact_id,settings_generation,target_key,contract,target_manifest,dependency_ids,state,run_remaining,
     model_call_limit,profile_required,profile_status,pending_receipt,receipt_batch_id,receipt_lease_generation,model_calls_used)
    VALUES($1,$2,$3,1,$4,'profile-tools-v1:document-tools-v1','[]','{}','active',1,8,true,'pending',false,NULL,NULL,0)`,
  [taskId,x.ownerId,x.contactId,`profile-incremental:${taskId}`]);
  const projected = (await readReplyContactOverview(f.client, x.scope)).entries.find(item => item.memory.memory_id === memoryId);
  const manifest = [{...projected.dependency_manifest, organization_timing_sha256:scenarioDigest(projected.memory.timing ?? {})}];
  await f.client.query(`INSERT INTO layered_memory_batch
    (id,owner_id,contact_id,settings_generation,work_key,status,input_manifest,input_payload,dependency_ids,created_at,task_id)
    VALUES($1,$2,$3,1,$4,'succeeded',$5,'{}',$6,now(),$7)`,
  [batchId,x.ownerId,x.contactId,`l3-incremental-${batchId}`,JSON.stringify(manifest),[memoryId],taskId]);
  await f.client.query(`INSERT INTO scenario_document_version
    (id,owner_id,contact_id,scenario_id,batch_id,organization_generation,schema_version,title,hint,paragraphs,created_at)
    VALUES($1,$2,$3,$4,$5,$6,1,'合成阅读偏好','增量偏好',$7,now())`,
  [versionId,x.ownerId,x.contactId,scenarioId,batchId,organizationGeneration,JSON.stringify([{
    text,references:[{memory_id:memoryId,revision:1}],
  }])]);
  await f.client.query(`INSERT INTO layered_memory_generation
    (owner_id,contact_id,organization_generation,schema_version,scenario_version_ids,profile_version_id,dependency_ids)
    VALUES($1,$2,$3,2,$4,NULL,$5)`,
  [x.ownerId,x.contactId,organizationGeneration,generationScenarioIds,
    options.retainPrevious === false ? [memoryId] : [x.memoryId,memoryId]]);
  await f.client.query(`UPDATE layered_memory_state SET organization_generation=$3,status='ready',error_code=NULL
    WHERE owner_id=$1 AND contact_id=$2`, [x.ownerId,x.contactId,organizationGeneration]);
  await f.client.query(`UPDATE layered_memory_job SET pending_receipt=true,receipt_batch_id=$2,receipt_lease_generation=1
    WHERE task_id=$1`, [taskId,batchId]);
  return {
    memory:{memoryId,text},scenarioId,versionId,
    claim:{task_id:taskId,step_id:stepId,step_name:'organize_memory',worker_id:workerId,lease_generation:1},
  };
}

test('合成PG：L3从完整L2集合发布可追溯画像并推进同一generation', async () => {
  const f = await createStorageFixture();
  try {
    const x = await createScope(f), port = profilePort(x.memory);
    const result = await service(f, port).run(x.scope, x.claim, new AbortController().signal);
    assert.equal(port.calls, 3);
    assert.equal(result.profile.entries.length, 1);
    assert.equal(result.profile.entries[0].references[0].memory_id, x.memoryId);
    assert.equal(result.organization_generation, 2);
    const generation = (await f.client.query(`SELECT scenario_version_ids,profile_version_id,dependency_ids
      FROM layered_memory_generation WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid
        AND organization_generation=2`, [x.ownerId, x.contactId])).rows[0];
    assert.deepEqual(generation.scenario_version_ids, [x.scenarioVersionId]);
    assert.equal(generation.profile_version_id, result.profile.version_id);
    assert.ok(generation.dependency_ids.includes(x.memoryId));
    const state = (await f.client.query(`SELECT status,error_code,organization_generation
      FROM layered_memory_state WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`, [x.ownerId, x.contactId])).rows[0];
    assert.deepEqual(state, {status:'ready', error_code:null, organization_generation:'2'});
    const snapshot = await captureLayeredSnapshot(f.client, x.scope);
    assert.equal(snapshot.profile_version_id, result.profile.version_id);
    const material = selectLayeredMaterial(snapshot, {
      profile_entries:4,directory_entries:4,characters:4000,
      scenario_read:{calls:2,paragraphs:8,characters:4000},
    });
    assert.equal(material.snapshot.organization_generation, result.organization_generation);
    assert.match(material.payload_json, new RegExp(result.profile.version_id));
  } finally { await f.close(); }
});

test('合成PG：同一合法画像和场景无变化时跳过模型并保持版本', async () => {
  const f = await createStorageFixture();
  try {
    const x = await createScope(f);
    await service(f, profilePort(x.memory)).run(x.scope, x.claim, new AbortController().signal);
    const before = (await f.client.query(`SELECT s.organization_generation,g.profile_version_id
      FROM layered_memory_state s JOIN layered_memory_generation g
        ON g.owner_id=s.owner_id AND g.contact_id=s.contact_id AND g.organization_generation=s.organization_generation
      WHERE s.owner_id=$1 AND s.contact_id IS NOT DISTINCT FROM $2::uuid`, [x.ownerId, x.contactId])).rows[0];
    await f.client.query(`UPDATE layered_memory_job SET state='active',profile_status='pending'
      WHERE task_id=$1`, [x.taskId]);
    const noChangePort = {calls:0, async call(){this.calls++;throw new Error('must_not_call_model');}};
    const result = await service(f, noChangePort).run(x.scope, x.claim, new AbortController().signal);
    assert.equal(noChangePort.calls, 0);
    assert.equal(result.profile.version_id, before.profile_version_id);
    assert.equal(result.organization_generation, Number(before.organization_generation));
  } finally { await f.close(); }
});

test('合成PG：新场景只增量更新画像并逐字保留未受影响的旧条目', async () => {
  const f = await createStorageFixture();
  try {
    const x = await createScope(f);
    const first = await service(f, profilePort(x.memory)).run(x.scope, x.claim, new AbortController().signal);
    const next = await addIncrementalScenarioGeneration(f, x, '双方开始持续交换合成阅读书单。');
    let calls = 0, modelPayload;
    const port = {async call(input) {
      calls++;
      await input.requireCurrent();
      const tool = (name,args) => ({blocks:[{type:'tool-call',id:`incremental-${calls}`,name,arguments:JSON.stringify(args)}],
        receipt_id:randomUUID()});
      if (calls === 1) {
        modelPayload = JSON.parse(input.messages[0].content.find(block => block.type === 'text').text);
        const oldEntry = first.profile.entries[0];
        return tool('write', {path:'profile.md',content:renderProfile({entries:[oldEntry,{
          text:'双方开始持续交换合成阅读书单。',kind:'preference',section:'long_term_preferences',
          basis:'新增来源明确记载持续交换书单。',temporal_status:'stable',uncertainty:'',
          references:[{memory_id:next.memory.memoryId,revision:1}],
        }]})});
      }
      if (calls === 2) return {blocks:[],receipt_id:randomUUID()};
      if (calls === 3) return tool('ProfileVerificationOutput',{results:[
        {entry_index:0,supported:true,evidence:[{memory_id:x.memoryId,quote:x.memory.text}]},
        {entry_index:1,supported:true,evidence:[{memory_id:next.memory.memoryId,quote:next.memory.text}]},
      ]});
      throw new Error('unexpected_incremental_call');
    }};
    const updated = await service(f, port).run(x.scope, next.claim, new AbortController().signal);
    assert.equal(calls, 3);
    assert.equal(modelPayload.existing_profile.version_id, first.profile.version_id);
    assert.deepEqual(modelPayload.changed_scenario_ids, [next.scenarioId]);
    assert.deepEqual(updated.profile.entries[0], first.profile.entries[0]);
    assert.equal(updated.profile.entries[1].references[0].memory_id, next.memory.memoryId);
    assert.equal(updated.scenarios.length, 2);
    assert.equal(updated.organization_generation, 4);
  } finally { await f.close(); }
});

test('合成PG：来源或人工修正变化后晚到画像不发布', async () => {
  const f = await createStorageFixture();
  try {
    const x = await createScope(f);
    let calls = 0;
    const port = {async call(input) {
      calls++;
      await input.requireCurrent();
      if (calls === 1) return {blocks:[{type:'tool-call',id:'late-write',name:'write',arguments:JSON.stringify({
        path:'profile.md', content:renderProfile({entries:[entry(x.memory)]}),
      })}], receipt_id:randomUUID()};
      await f.client.query(`UPDATE layered_memory_state SET correction_revision=correction_revision+1
        WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`, [x.ownerId, x.contactId]);
      return {blocks:[], receipt_id:randomUUID()};
    }};
    await assert.rejects(service(f, port).run(x.scope, x.claim, new AbortController().signal));
    assert.equal((await f.client.query(`SELECT count(*)::int n FROM layered_profile_version
      WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`, [x.ownerId, x.contactId])).rows[0].n, 0);
  } finally { await f.close(); }
});

test('合成PG：画像批次清单与冻结场景或底层版本不一致时拒绝晚结果', async () => {
  const f = await createStorageFixture();
  try {
    const x = await createScope(f);
    const port = {async call(input) {
      await f.client.query(`UPDATE layered_profile_batch
        SET input_manifest=jsonb_set(input_manifest,'{0,record_sha256}','"tampered"')
        WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND status='running'`,
      [x.ownerId,x.contactId]);
      await assert.rejects(input.requireCurrent(), /batch_stale|changed/i);
      return {blocks:[],receipt_id:randomUUID()};
    }};
    await assert.rejects(service(f, port).run(x.scope, x.claim, new AbortController().signal), /batch_stale|changed/i);
    assert.equal((await f.client.query(`SELECT count(*)::int n FROM layered_profile_version
      WHERE owner_id=$1 AND contact_id=$2`, [x.ownerId,x.contactId])).rows[0].n, 0);
  } finally { await f.close(); }
});

test('合成PG：generation场景集合缺失或重复时不投影部分目录', async () => {
  const f = await createStorageFixture();
  try {
    for (const kind of ['missing','duplicate']) {
      const x = await createScope(f);
      const invalidId = randomUUID();
      const port = {calls:0,async call(){this.calls++;throw new Error('must_not_call_model');}};
      await f.client.query(`UPDATE layered_memory_generation
        SET scenario_version_ids=$4::uuid[]
        WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid AND organization_generation=$3`,
      [x.ownerId,x.contactId,1,kind === 'missing'
        ? [invalidId]
        : [x.scenarioVersionId,invalidId,invalidId]]);
      await assert.rejects(
        service(f, port).run(x.scope, x.claim, new AbortController().signal),
        /generation_changed/,
        kind,
      );
      assert.equal(port.calls, 0, kind);
      assert.equal((await f.client.query(`SELECT count(*)::int n FROM layered_profile_version
        WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`, [x.ownerId,x.contactId])).rows[0].n, 0, kind);
      assert.equal((await f.client.query(`SELECT organization_generation
        FROM layered_memory_state WHERE owner_id=$1 AND contact_id IS NOT DISTINCT FROM $2::uuid`,
      [x.ownerId,x.contactId])).rows[0].organization_generation, '1', kind);
    }
  } finally { await f.close(); }
});

test('合成PG：场景冻结输入清单与当前底层版本不一致时不静默替换', async () => {
  const f = await createStorageFixture();
  try {
    const x = await createScope(f);
    await f.client.query(`UPDATE layered_memory_batch
      SET input_manifest=jsonb_set(input_manifest,'{0,record_sha256}','"tampered"')
      WHERE id=$1`, [x.l2BatchId]);
    const port = {calls:0, async call(){this.calls++;throw new Error('must_not_call_model');}};
    const result = await service(f, port).run(x.scope, x.claim, new AbortController().signal);
    assert.equal(port.calls, 0);
    assert.equal(result.profile, null);
    assert.deepEqual(result.scenarios, []);
    assert.equal(result.status, 'empty');
    assert.equal(result.organization_generation, 2);
    assert.equal((await f.client.query(
      'SELECT profile_status FROM layered_memory_job WHERE task_id=$1', [x.taskId],
    )).rows[0].profile_status, 'not_required');
  } finally { await f.close(); }
});

test('合成PG：亚毫秒未来有效期在L3输入前排除', async () => {
  const f = await createStorageFixture();
  try {
    const x = await createScope(f, {validAt:'2026-10-25T02:00:00.000500Z'});
    const port = {calls:0, async call(){this.calls++;throw new Error('must_not_call_model');}};
    const result = await service(f, port).run(x.scope, x.claim, new AbortController().signal);
    assert.equal(port.calls, 0);
    assert.equal(result.profile, null);
    assert.deepEqual(result.scenarios, []);
    assert.equal(result.status, 'empty');
  } finally { await f.close(); }
});

test('合成PG：部分场景输入失效时不复用覆盖旧集合的画像', async () => {
  const f = await createStorageFixture();
  try {
    const x = await createScope(f);
    const l3 = service(f, profilePort(x.memory));
    const first = await l3.run(x.scope, x.claim, new AbortController().signal);
    const next = await addIncrementalScenarioGeneration(f, x, '双方持续交换合成阅读书单。');
    const nextEntry = {
      ...entry(next.memory),
      text:'双方持续交换合成阅读书单。',
      kind:'preference',
      section:'long_term_preferences',
      basis:'新增记忆直接记载持续交换书单。',
      temporal_status:'stable',
    };
    let calls = 0;
    const port = {async call(input) {
      calls++;
      await input.requireCurrent();
      const tool = (name,args) => ({
        blocks:[{type:'tool-call',id:`partial-${calls}`,name,arguments:JSON.stringify(args)}],
        receipt_id:randomUUID(),
      });
      if (calls === 1) return tool('write', {
        path:'profile.md',
        content:renderProfile({entries:[first.profile.entries[0], nextEntry]}),
      });
      if (calls === 2) return {blocks:[],receipt_id:randomUUID()};
      if (calls === 3) return tool('ProfileVerificationOutput', {results:[
        {entry_index:0,supported:true,evidence:[{memory_id:x.memoryId,quote:x.memory.text}]},
        {entry_index:1,supported:true,evidence:[{memory_id:next.memory.memoryId,quote:next.memory.text}]},
      ]});
      throw new Error('unexpected_partial_call');
    }};
    const updated = await service(f, port).run(x.scope, next.claim, new AbortController().signal);
    assert.equal(updated.profile.entries.length, 2);
    assert.equal(updated.organization_generation, 4);
    await f.client.query(`UPDATE layered_memory_batch
      SET input_manifest=jsonb_set(input_manifest,'{0,record_sha256}','"tampered"')
      WHERE id=$1`, [x.l2BatchId]);
    await f.client.query(`UPDATE layered_memory_job
      SET state='active',profile_status='pending' WHERE task_id=$1`, [next.claim.task_id]);
    const work = await service(f, {
      async call(){throw new Error('prepare_must_not_call_model');},
    }).prepare(x.scope, next.claim);
    assert.ok(work && work !== 'settled');
    assert.equal(work.existing_profile, null);
    assert.deepEqual(work.scenarios.map(scenario => scenario.version_id), [next.versionId]);
    assert.deepEqual(work.changed_scenarios.map(scenario => scenario.version_id), [next.versionId]);
    assert.deepEqual(work.removed_scenario_version_ids, []);
  } finally { await f.close(); }
});

test('合成PG：底层来源失效物理清除L3、目录和冻结回复快照', async () => {
  const f = await createStorageFixture();
  try {
    const x = await createScope(f), l3 = service(f, profilePort(x.memory));
    const ready = await l3.run(x.scope, x.claim, new AbortController().signal);
    const snapshot = await captureLayeredSnapshot(f.client, x.scope);
    assert.ok(ready.profile);
    await f.client.query("UPDATE source_document SET status='delete_requested' WHERE id=$1", [x.sourceId]);
    const current = await l3.read(x.scope);
    assert.equal(current.profile, null);
    assert.deepEqual(current.scenarios, []);
    assert.equal(await validateLayeredSnapshot(f.client, snapshot), false);
    assert.equal((await f.client.query(`SELECT count(*)::int n FROM layered_profile_batch
      WHERE owner_id=$1 AND contact_id=$2`, [x.ownerId,x.contactId])).rows[0].n, 0);
  } finally { await f.close(); }
});

test('合成PG：取消不发布，显式恢复只重试同一L3并受两次尝试上限约束', async () => {
  const f = await createStorageFixture();
  try {
    const x = await createScope(f), controller = new AbortController();
    const cancelledPort = {calls:0, async call(input) {
      this.calls++;
      await input.requireCurrent();
      controller.abort();
      input.signal.throwIfAborted();
    }};
    await assert.rejects(service(f, cancelledPort).run(x.scope, x.claim, controller.signal), /abort/i);
    assert.equal(cancelledPort.calls, 1);
    assert.equal((await f.client.query(`SELECT count(*)::int n FROM layered_profile_version
      WHERE owner_id=$1 AND contact_id=$2`, [x.ownerId,x.contactId])).rows[0].n, 0);
    await f.client.query(`UPDATE layered_memory_state SET status='ready',error_code=NULL
      WHERE owner_id=$1 AND contact_id=$2`, [x.ownerId,x.contactId]);
    await f.client.query(`UPDATE layered_memory_job SET state='active',profile_status='pending'
      WHERE task_id=$1`, [x.taskId]);
    const recoveredPort = profilePort(x.memory);
    const recovered = await service(f, recoveredPort).run(x.scope, x.claim, new AbortController().signal);
    assert.equal(recoveredPort.calls, 3);
    assert.ok(recovered.profile);
    assert.equal((await f.client.query(`SELECT attempt_count FROM layered_profile_batch
      WHERE owner_id=$1 AND contact_id=$2`, [x.ownerId,x.contactId])).rows[0].attempt_count, 2);
  } finally { await f.close(); }
});

test('合成PG：L3不足提案与核验两次额度时暂停且不再发起物理模型调用', async () => {
  const f = await createStorageFixture();
  try {
    for (const [used, limit] of [[1, 1], [7, 8]]) {
      const x = await createScope(f);
      await f.client.query(`UPDATE layered_memory_job SET model_calls_used=$2,model_call_limit=$3
        WHERE task_id=$1`, [x.taskId, used, limit]);
      const port = {calls:0,async call(){this.calls++;throw new Error('must_not_call_model');}};
      const state = await service(f, port).run(x.scope, x.claim, new AbortController().signal);
      assert.equal(port.calls, 0);
      assert.equal(state.status, 'paused');
      assert.equal(state.error_code, 'model_call_budget_exhausted');
      assert.equal(state.profile, null);
      assert.equal((await f.client.query(`SELECT state,profile_status FROM layered_memory_job
        WHERE task_id=$1`, [x.taskId])).rows[0].state, 'paused');
    }
  } finally { await f.close(); }
});

test('合成PG：仅剩提案与核验两次额度时仍完成并保留一次核验', async () => {
  const f = await createStorageFixture();
  try {
    const x = await createScope(f);
    let calls = 0;
    const port = {async call() {
      calls++;
      const tool = (name,args) => ({
        blocks:[{type:'tool-call',id:`exact-budget-${calls}`,name,arguments:JSON.stringify(args)}],
        receipt_id:randomUUID(),
      });
      if (calls === 1) return tool('write', {
        path:'profile.md',content:renderProfile({entries:[entry(x.memory)]}),
      });
      if (calls === 2) return tool('ProfileVerificationOutput', {results:[{
        entry_index:0,supported:true,evidence:[{memory_id:x.memoryId,quote:x.memory.text}],
      }]});
      throw new Error('unexpected_exact_budget_call');
    }};
    await f.client.query(`UPDATE layered_memory_job
      SET model_calls_used=6,model_call_limit=8 WHERE task_id=$1`, [x.taskId]);
    const ready = await service(f, port).run(x.scope, x.claim, new AbortController().signal);
    assert.equal(calls, 2);
    assert.equal(ready.status, 'ready');
    assert.ok(ready.profile);
  } finally { await f.close(); }
});

test('合成PG：画像撤回同步清除依赖回复并保留合法L2', async () => {
  const f = await createStorageFixture();
  try {
    const x = await createScope(f), l3 = service(f, profilePort(x.memory));
    const ready = await l3.run(x.scope, x.claim, new AbortController().signal);
    const snapshot = await captureLayeredSnapshot(f.client, x.scope);
    const requestId = randomUUID();
    await f.client.query(`INSERT INTO reply_request
      (id,owner_id,contact_id,conversation_binding_id,idempotency_key,normalized_input,state,attempt,lease_expires_at,context_snapshot,skill_library_revision)
      VALUES($1,$2,$3,$4,$5,'合成请求','completed',1,now(),$6,0)`,
    [requestId, x.ownerId, x.contactId, randomUUID(), randomUUID(), {navigation_dependency_ids:[ready.profile.version_id]}]);
    const withdrawn = await l3.withdraw(x.scope, ready.settings_generation, ready.organization_generation, ready.profile.version_id);
    assert.equal(withdrawn.profile, null);
    assert.equal(withdrawn.scenarios.length, 1);
    assert.equal(withdrawn.organization_generation, ready.organization_generation + 1);
    assert.equal(await validateLayeredSnapshot(f.client, snapshot), false);
    assert.equal((await f.client.query('SELECT count(*)::int n FROM reply_request WHERE id=$1',[requestId])).rows[0].n, 0);
  } finally { await f.close(); }
});

test('合成PG：画像总结纠错撤下当前版本并保护完整底层窗口', async () => {
  const f = await createStorageFixture();
  try {
    const x = await createScope(f), l3 = service(f, profilePort(x.memory));
    const ready = await l3.run(x.scope, x.claim, new AbortController().signal);
    const operationId = randomUUID();
    const corrected = await l3.reportError(x.scope, {
      settings_generation:ready.settings_generation,
      organization_generation:ready.organization_generation,
      version_id:ready.profile.version_id,
      item_index:0,
      operation_id:operationId,
      reason:'合成画像把共同经历概括得过强，需要撤回。',
    });
    assert.equal(corrected.profile, null);
    assert.equal(corrected.organization_generation, ready.organization_generation + 1);
    const feedback = (await f.client.query(`SELECT target_kind,protected_memory_ids,state
      FROM layered_memory_feedback WHERE operation_id=$1`, [operationId])).rows[0];
    assert.equal(feedback.target_kind, 'profile');
    assert.equal(feedback.state, 'active');
    assert.deepEqual(feedback.protected_memory_ids, [x.memoryId]);
    const replay = await l3.reportError(x.scope, {
      settings_generation:ready.settings_generation,
      organization_generation:ready.organization_generation,
      version_id:ready.profile.version_id,
      item_index:0,
      operation_id:operationId,
      reason:'合成画像把共同经历概括得过强，需要撤回。',
    });
    assert.equal(replay.profile, null);
    assert.equal((await f.client.query('SELECT count(*)::int n FROM layered_memory_feedback WHERE operation_id=$1',
      [operationId])).rows[0].n, 1);
  } finally { await f.close(); }
});

test('合成PG：纠错反馈最小化进入提案与核验，撤回正文不能换源重现', async () => {
  const f = await createStorageFixture();
  try {
    const x = await createScope(f);
    const original = await service(f, profilePort(x.memory)).run(
      x.scope,
      x.claim,
      new AbortController().signal,
    );
    const rejectedText = original.profile.entries[0].text;
    await service(f, profilePort(x.memory)).reportError(x.scope, {
      settings_generation:original.settings_generation,
      organization_generation:original.organization_generation,
      version_id:original.profile.version_id,
      item_index:0,
      operation_id:randomUUID(),
      reason:'合成画像把共同经历概括得过强。',
    });
    const next = await addIncrementalScenarioGeneration(
      f,
      x,
      '双方近期开始独立交换阅读书单。',
      {organizationGeneration:4, retainPrevious:false},
    );
    let calls = 0, proposalPayload, verificationPayload;
    const freshText = '双方近期开始独立交换阅读书单。';
    const port = {async call(input) {
      calls++;
      await input.requireCurrent();
      const tool = (name,args) => ({
        blocks:[{type:'tool-call',id:`correction-${calls}`,name,arguments:JSON.stringify(args)}],
        receipt_id:randomUUID(),
      });
      if (calls === 1) {
        proposalPayload = JSON.parse(input.messages[0].content.find(block => block.type === 'text').text);
        return tool('write', {path:'profile.md',content:renderProfile({entries:[
          {...entry(next.memory),text:rejectedText},
          {
            ...entry(next.memory),
            text:freshText,
            basis:'新增底层记忆直接记载近期交换书单。',
          },
        ]})});
      }
      if (calls === 2) return {blocks:[],receipt_id:randomUUID()};
      if (calls === 3) {
        verificationPayload = JSON.parse(input.messages[0].content.find(block => block.type === 'text').text);
        return tool('ProfileVerificationOutput', {results:[{
          entry_index:0,
          supported:true,
          evidence:[{memory_id:next.memory.memoryId,quote:freshText}],
        }]});
      }
      throw new Error('unexpected_correction_call');
    }};
    const corrected = await service(f, port).run(
      x.scope,
      next.claim,
      new AbortController().signal,
    );
    assert.deepEqual(corrected.profile.entries.map(item => item.text), [freshText]);
    const correctionKeys = ['feedback_id','rejected_text','reason','rule'];
    assert.deepEqual(Object.keys(proposalPayload.corrections[0]).sort(), correctionKeys.slice().sort());
    assert.deepEqual(Object.keys(verificationPayload.corrections[0]).sort(), correctionKeys.slice().sort());
    assert.equal(proposalPayload.corrections[0].rejected_text, rejectedText);
    const output = (await f.client.query(`SELECT output_payload FROM layered_profile_batch
      WHERE task_id=$1`, [next.claim.task_id])).rows[0].output_payload;
    assert.equal(output.rejected[0].index, 0);
    assert.match(output.rejected[0].reason, /纠错|撤回|correction/i);
  } finally { await f.close(); }
});

test('合成PG：本人和联系人L3严格隔离且本人范围不读取联系人正文', async () => {
  const f = await createStorageFixture();
  try {
    const contact = await createScope(f);
    const owner = await createScope(f, {owner:true, text:'本人长期偏好合成阅读。'});
    assert.notEqual(contact.ownerId, owner.ownerId);
    const contactResult = await service(f, profilePort(contact.memory)).run(contact.scope, contact.claim, new AbortController().signal);
    const ownerResult = await service(f, profilePort(owner.memory)).run(owner.scope, owner.claim, new AbortController().signal);
    assert.equal(contactResult.scope_kind, 'contact');
    assert.equal(ownerResult.scope_kind, 'owner');
    assert.equal((await f.client.query(`SELECT count(*)::int n FROM layered_profile_version
      WHERE owner_id=$1 AND contact_id IS NULL`, [owner.ownerId])).rows[0].n, 1);
    assert.equal((await f.client.query(`SELECT count(*)::int n FROM layered_profile_version
      WHERE owner_id=$1 AND contact_id=$2`, [owner.ownerId, contact.contactId])).rows[0].n, 0);
  } finally { await f.close(); }
});
