import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import {L3ProfileService} from '../src/l3-profile-service.ts';
import {createHostModelAccounting} from '../src/host-model-accounting.ts';
import {renderProfile} from '../src/l3-profile-workspace.ts';
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
  if (options.invalidAt) {
    await f.client.query(`UPDATE ${contactId ? 'confirmed_memory' : 'owner_memory'}
      SET invalid_at=$2::timestamptz WHERE id=$1`, [memoryId, options.invalidAt]);
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

const contentAsOf = '2026-10-23T04:00:00.000Z';

// 仅通过本机 socket 建立随机合成库；不加载应用配置或 .env。
async function fixture(t) {
  const database = `notalone_l3_clock_${randomUUID().replaceAll('-', '')}_test`;
  const admin = new pg.Client({host:'/tmp', database:'postgres'});
  await admin.connect();
  let client;
  t.after(async () => {
    await client?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  });
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
  client = new pg.Client({host:'/tmp', database});
  await client.connect();
  const migrations = new URL('../database/migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
    await client.query(await readFile(new URL(name, migrations), 'utf8'));
  }
  const transaction = async work => {
    await client.query('BEGIN');
    try { const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
  };
  return {client, transaction};
}

function service(f, model = {async call() { throw new Error('unexpected_model_call'); }}, options = {}) {
  return new L3ProfileService({
    transaction:f.transaction, model, binding, profile, budget,
    now:() => new Date(contentAsOf), ...options,
  });
}

function receipt(scope, claim) {
  return {
    attempt_id:randomUUID(), permit_id:randomUUID(), request_id:claim.task_id,
    owner_id:scope.owner_id, contact_id:scope.contact_id, scope_kind:'contact',
    provider:binding.provider, model:binding.model, called_at:new Date().toISOString(),
    latency_ms:null, dispatch:'authorized_unconfirmed', outcome:'pending', usage:null,
    cost:{status:'unknown', amount:null, currency:null, pricing_version:null},
  };
}

function accounting(f) {
  return createHostModelAccounting({
    transaction:f.transaction, provider:binding.provider, model:binding.model,
    unconfirmedPermitIds:() => [],
  });
}

// 替换外部模型响应，保留真实 PG 预约、结算与全部 L3 发布校验。
function accountedProfilePort(f, memory) {
  const synthetic = profilePort(memory), host = accounting(f);
  return {
    get calls() { return synthetic.calls; },
    async call(input) {
      await input.requireCurrent();
      const reserved = receipt(input, input.claim);
      await host.reserve(reserved, input.claim);
      const result = await synthetic.call(input);
      await host.recordReserved({...reserved, dispatch:'response_observed', outcome:'succeeded'});
      return {...result, receipt_id:reserved.attempt_id};
    },
  };
}

test('合成PG：过去内容时钟创建的L3工作仍可通过真实PG模型租约校验', async t => {
  const f = await fixture(t), x = await createScope(f);
  const l3 = service(f);
  const work = await l3.prepare(x.scope, x.claim);
  assert.ok(work && work !== 'settled');
  await l3.requireCurrent(work);
  t.diagnostic(JSON.stringify((await f.client.query(`SELECT
    lease_expires_at > clock_timestamp() AS operational_lease_current,
    lease_expires_at > $2::timestamptz AS content_clock_lease_current,
    (SELECT count(*)::int FROM layered_memory_batch WHERE task_id=$3 AND status='running') AS running_l2
    FROM layered_profile_batch WHERE id=$1`, [work.profile_batch_id, contentAsOf, x.taskId])).rows[0]));
  await accounting(f).reserve(receipt(x.scope, x.claim), x.claim);
});

test('合成PG：真实时间已过期的L3工作不能被过去内容时钟继续使用', async t => {
  const f = await fixture(t), x = await createScope(f);
  const l3 = service(f), work = await l3.prepare(x.scope, x.claim);
  assert.ok(work && work !== 'settled');
  await f.client.query(`UPDATE layered_profile_batch
    SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [work.profile_batch_id]);
  await assert.rejects(l3.requireCurrent(work), {code:'l3_profile_batch_stale'});
  await assert.rejects(l3.publish(work, {entries:[]}), {code:'l3_profile_batch_stale'});
  await assert.rejects(accounting(f).reserve(receipt(x.scope, x.claim), x.claim),
    {code:'model_accounting_work_ambiguous'});
});

test('合成PG：冻结内容时钟不阻止重新领取过期L3且旧工作失效', async t => {
  const f = await fixture(t), x = await createScope(f);
  const l3 = service(f), first = await l3.prepare(x.scope, x.claim);
  assert.ok(first && first !== 'settled');
  assert.equal(await l3.prepare(x.scope, x.claim), null);
  await f.client.query(`UPDATE layered_profile_batch
    SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [first.profile_batch_id]);
  const renewed = await l3.prepare(x.scope, x.claim);
  assert.ok(renewed && renewed !== 'settled', '同一冻结材料允许用真实时间重新领取');
  assert.equal(renewed.profile_batch_id, first.profile_batch_id);
  assert.notEqual(renewed.work_token, first.work_token);
  await assert.rejects(l3.requireCurrent(first), {code:'l3_profile_batch_stale'});
  await l3.requireCurrent(renewed);
  await accounting(f).reserve(receipt(x.scope, x.claim), x.claim);
});

test('合成PG：未来内容时间不能抢占真实时间仍有效的L3工作', async t => {
  const f = await fixture(t), x = await createScope(f);
  const l3 = service(f, undefined, {now:() => new Date('2100-01-01T00:00:00Z')});
  const work = await l3.prepare(x.scope, x.claim);
  assert.ok(work && work !== 'settled');
  await l3.requireCurrent(work);
  assert.equal(await l3.prepare(x.scope, x.claim), null);
  await accounting(f).reserve(receipt(x.scope, x.claim), x.claim);
});

for (const mode of ['task_cancelled', 'step_expired', 'claim_generation', 'settings_generation', 'organization_generation', 'disabled']) {
  test(`合成PG：冻结内容时间下${mode}仍拒绝旧工作与模型预约`, async t => {
    const f = await fixture(t), x = await createScope(f);
    const l3 = service(f), work = await l3.prepare(x.scope, x.claim);
    assert.ok(work && work !== 'settled');
    let l3Code = 'l3_profile_changed', hostCode = 'model_accounting_job_stale';
    if (mode === 'task_cancelled') {
      await f.client.query("UPDATE background_task SET status='cancelled' WHERE id=$1", [x.taskId]);
      l3Code = 'l3_profile_claim_stale'; hostCode = 'model_accounting_claim_stale';
    } else if (mode === 'step_expired') {
      await f.client.query(`UPDATE background_task_step
        SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [x.claim.step_id]);
      l3Code = 'l3_profile_claim_stale'; hostCode = 'model_accounting_claim_stale';
    } else if (mode === 'claim_generation') {
      await f.client.query('UPDATE background_task_step SET lease_generation=2 WHERE id=$1', [x.claim.step_id]);
      l3Code = 'l3_profile_claim_stale'; hostCode = 'model_accounting_claim_stale';
    } else {
      const change = mode === 'disabled' ? 'enabled=false'
        : mode === 'settings_generation' ? 'settings_generation=2' : 'organization_generation=2';
      await f.client.query(`UPDATE layered_memory_state SET ${change} WHERE owner_id=$1 AND contact_id=$2`,
        [x.ownerId, x.contactId]);
      if (mode === 'organization_generation') hostCode = 'model_accounting_work_ambiguous';
    }
    await assert.rejects(l3.requireCurrent(work), {code:l3Code});
    await assert.rejects(l3.publish(work, {entries:[]}), {code:l3Code});
    await assert.rejects(accounting(f).reserve(receipt(x.scope, x.claim), x.claim), {code:hostCode});
    assert.equal((await l3.read(x.scope)).profile, null);
  });
}

test('合成PG：真实租约与模型记账完成后资料有效期和发布时间仍遵守as_of', async t => {
  const f = await fixture(t), x = await createScope(f, {
    validAt:contentAsOf, invalidAt:'2026-10-24T04:00:00Z',
  });
  const model = accountedProfilePort(f, x.memory), l3 = service(f, model);
  const result = await l3.run(x.scope, x.claim, new AbortController().signal);
  assert.equal(result.status, 'ready');
  assert.equal(result.organization_generation, 2);
  assert.equal(result.profile.updated_at, contentAsOf);
  assert.equal(result.profile.entries[0].references[0].memory_id, x.memoryId);
  assert.equal(model.calls, 3);
  assert.deepEqual(await l3.read(x.scope), result);
});

test('合成PG：未注入内容时钟时默认发布行为仍使用真实时间', async t => {
  const f = await fixture(t), x = await createScope(f);
  const l3 = service(f, accountedProfilePort(f, x.memory), {now:undefined});
  const before = Date.now();
  const result = await l3.run(x.scope, x.claim, new AbortController().signal);
  const after = Date.now();
  assert.equal(result.status, 'ready');
  assert.ok(before <= Date.parse(result.profile.updated_at) && Date.parse(result.profile.updated_at) <= after);
});
