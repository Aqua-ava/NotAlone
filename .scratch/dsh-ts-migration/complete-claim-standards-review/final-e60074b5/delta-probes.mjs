import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createHash, randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const root = process.env.STANDARDS_FINAL_SNAPSHOT;
assert.ok(root);
const at = (path, base = root) => import(pathToFileURL(join(base, path)).href);
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
const owner = '11111111-1111-4111-8111-111111111111', contact = '22222222-2222-4222-8222-222222222222';
const message = '33333333-3333-4333-8333-333333333333', text = '合成联系人喜欢绿茶。';
const window = {owner_id: owner, contact_id: contact, target_message_ids: [message], messages: [{message_id: message,
  sender: 'contact', occurred_at: null, message_type: 'text', text_representation: 'text', text}]};
const memory = {text, subject: 'contact', category: 'preference', topic: 'other', source_message_ids: [message],
  confidence: 0.8, risk_flags: [], valid_at: null, invalid_at: null, speech_act: 'assertion', assertion_status: 'asserted',
  figurative_type: 'literal', alternatives: [], interpretation_reason: '合成协议探针。', event: null, conditions: null};
const extraction = count => [{type: 'tool-call', name: 'DirectMemoryExtractionOutput', arguments: JSON.stringify({scenes: [
  {scene_name: '合成场景', memories: Array.from({length: count}, () => ({...memory}))}]})}];

test('同一61候选输入在bcc复现P2，在最终pin关闭；来源与取消异常继续传播', async () => {
  const observations = {};
  for (const [label, base] of [['bcc', join(root, 'bcc')], ['final', root]]) {
    const {runExtractionFlow} = await at('backend-ts/src/extraction-flow.ts', base);
    const calls = [];
    try {
      const result = await runExtractionFlow({window, signal: new AbortController().signal, max_retries: 0,
        requireCurrent: async () => {}, record: async () => {}, invoke: async request => {
          calls.push(request.purpose); assert.equal(request.purpose, 'extraction'); return {blocks: extraction(61)};
        }});
      observations[label] = {returned: true, kind: result.failure_kind, completed: result.extraction_completed,
        accepted: result.accepted.length, calls};
    } catch (error) {observations[label] = {returned: false, message: error.message, calls};}
  }
  assert.equal(observations.bcc.message, 'complete_claim_policy_invalid');
  assert.deepEqual(observations.final, {returned: true, kind: 'invalid_output', completed: true, accepted: 0, calls: ['extraction']});
  const {runExtractionFlow} = await at('backend-ts/src/extraction-flow.ts');
  for (const mode of ['source_revoked', 'trace_failed', 'cancelled']) {
    const controller = new AbortController(); let afterPrepare = false, calls = 0;
    const task = runExtractionFlow({window, signal: controller.signal, max_retries: 0,
      requireCurrent: async () => {if (mode === 'source_revoked' && afterPrepare) throw new Error('synthetic_scope_revoked');},
      record: async event => {if (event.stage === 'verification_input') {
        afterPrepare = true;
        if (mode === 'trace_failed') throw Object.assign(new Error('synthetic_trace_failed'), {code: 'trace_write_failed'});
        if (mode === 'cancelled') controller.abort();
      }}, invoke: async request => {calls++; assert.equal(request.purpose, 'extraction'); return {blocks: extraction(1)};}});
    await assert.rejects(task, error => mode === 'cancelled' ? error.name === 'AbortError'
      : error.message === (mode === 'source_revoked' ? 'synthetic_scope_revoked' : 'synthetic_trace_failed'));
    assert.equal(calls, 1);
  }
  console.log(JSON.stringify({probe: 'P2_fixed_at_final_pin', observations, source_trace_cancel_propagated: true}));
});

test('公开Batch接缝冻结0/0策略，外部修改不恢复重试，缺省仍保留原恢复资格', {timeout: 25000}, async () => {
  const pg = createRequire(join(root, 'backend-ts/package.json'))('pg');
  const {prepareDatabaseSchema} = await at('backend-ts/src/schema-prepare.ts');
  const {ExtractionTaskStore} = await at('backend-ts/src/extraction-task-store.ts');
  const {ExtractionTaskRunner} = await at('backend-ts/src/extraction-task-runner.ts');
  const {ExtractionBatchService} = await at('backend-ts/src/extraction-batch-service.ts');
  const database = 'notalone_standards_delta_' + randomUUID().replaceAll('-', '') + '_test';
  assert.match(database, /^notalone_standards_delta_[a-f0-9]{32}_test$/);
  const admin = new pg.Client({host: '/tmp', database: 'postgres', connectionTimeoutMillis: 3000});
  let created = false, client, pool, dropped = false;
  const observed = [];
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`); created = true;
    const schema = await prepareDatabaseSchema({databaseUrl: 'host=/tmp dbname=' + database,
      migrationsDirectory: join(root, 'backend/database/migrations'),
      environment: {NOTALONE_DISABLE_DOTENV: '1', NOTALONE_MANAGED_USER_DATA: join(root, 'synthetic-home')}});
    assert.equal(schema.code, 'ready');
    client = new pg.Client({host: '/tmp', database}); await client.connect();
    pool = new pg.Pool({host: '/tmp', database, max: 2});
    for (const explicit of [true, false]) {
      const own = randomUUID(), person = randomUUID(), source = randomUUID(), id = randomUUID();
      await client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')", [own]);
      await client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')", [person, own]);
      await client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,1)", [source, own, person, 'a'.repeat(64)]);
      await client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text',$4,'2026-09-15T00:00:00Z')", [id, own, person, text]);
      await client.query("INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,'source_document',$4,'synthetic:1',$5)", [id, own, person, source, {synthetic: true}]);
      const store = new ExtractionTaskStore(pool), task = await store.enqueueImport({ownerId: own, contactId: person}, source, 1);
      await client.query('INSERT INTO memory_processing_plan(task_id,owner_id,contact_id) VALUES($1,$2,$3)', [task, own, person]);
      await client.query('INSERT INTO memory_processing_target(task_id,message_id,owner_id,contact_id) VALUES($1,$2,$3,$4)', [task, id, own, person]);
      await client.query("UPDATE background_task_step SET status='succeeded',processed_count=1,total_count=1 WHERE task_id=$1 AND step_name IN ('parse','normalize')", [task]);
      const claim = await store.claim({ownerId: own, contactId: person}, {taskId: task, workerId: randomUUID(), leaseMs: 20000, supportedSteps: ['extract_memory']});
      assert.ok(claim);
      const controller = new AbortController(); let calls = 0, recovery;
      const transaction = async work => {
        await client.query('BEGIN'); let result;
        try {result = await work(client); await client.query('COMMIT');}
        catch (error) {await client.query('ROLLBACK'); throw error;}
        const found = (await client.query("SELECT payload FROM memory_extraction_trace_event WHERE owner_id=$1 AND contact_id=$2 AND stage='extraction_recovery' ORDER BY position DESC LIMIT 1", [own, person])).rows[0];
        if (found) {recovery = found.payload; if (!explicit) controller.abort();}
        return result;
      };
      const policy = {maxRetries: 0, retryDelayMs: 0};
      const service = new ExtractionBatchService({ownerId: own, transaction, ruleVersion: 'b'.repeat(64),
        ...(explicit ? {extractionRetryPolicy: policy} : {}), unconfirmedRequests: async () => [],
        model: {binding: {provider: 'synthetic', model: 'deepseek-flash', maxTokens: 131072, temperature: 0, reasoningEffort: 'off'},
          profile: {context_window_tokens: 1048576, safety_margin_tokens: 65536}},
        call: async () => {calls++; return {text: '', blocks: []};}});
      policy.maxRetries = 1; policy.retryDelayMs = 0;
      const runner = new ExtractionTaskRunner({store, batches: {run: input => service.run(input, controller.signal)},
        adopt: async () => {throw new Error('failed_E_must_not_adopt');}, batchSize: 1, concurrency: 1, contextBefore: 0, contextAfter: 0});
      await assert.rejects(runner.run(claim, controller.signal));
      assert.equal(calls, 1); assert.ok(recovery); assert.equal(recovery.will_retry, !explicit);
      observed.push({explicit_zero_policy: explicit, calls, will_retry: recovery.will_retry, caller_policy_mutated: true});
    }
  } finally {
    await pool?.end(); await client?.end();
    if (created) {
      let active;
      for (let i = 0; i < 25; i++) {
        active = (await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [database])).rows[0].n;
        if (active === 0) break;
        await delay(20);
      }
      assert.equal(active, 0); await admin.query(`DROP DATABASE "${database}"`);
      dropped = (await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount === 0;
      assert.ok(dropped);
    }
    await admin.end();
    console.log(JSON.stringify({probe: 'retry_policy_constructor_to_batch', observed, database, created, dropped, real_model_calls: 0}));
  }
});

test('显式131072输出进入最终strict实体和预约；来源失效与预取消不派发', async () => {
  const {resolveHostReplyConfiguration} = await at('backend-ts/src/host-reply-config.ts');
  const {installModelProvider} = await at('backend-ts/src/model-provider.ts');
  const {modelLedgerInputBudget} = await at('backend-ts/src/model-ledger.ts');
  const env = {NOTALONE_DEEPSEEK_API_KEY: 'synthetic-standards-key', NOTALONE_DEEPSEEK_MAX_OUTPUT_TOKENS: '131072'};
  const config = resolveHostReplyConfiguration(env);
  assert.equal(config.status, 'configured'); assert.equal(config.model.maxTokens, 131072);
  assert.equal(config.provider.connection.maxTokens, 131072); assert.equal(config.provider.connection.models[0].maxTokens, 131072);
  for (const value of ['1e5', '0131072', '393217', '131072\n'])
    assert.equal(resolveHostReplyConfiguration({...env, NOTALONE_DEEPSEEK_MAX_OUTPUT_TOKENS: value}).status, 'unavailable');
  const oldFetch = globalThis.fetch, requests = []; let reservations = 0, reservation;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.deepseek.com/beta/chat/completions');
    requests.push({raw: init.body, body: JSON.parse(init.body)});
    return new Response(JSON.stringify({choices: [{finish_reason: 'tool_calls', message: {role: 'assistant', content: null,
      tool_calls: [{id: 'synthetic', type: 'function', function: {name: 'SourceVerificationOutput', arguments: '{"results":[]}'}}]}}], usage: {prompt_tokens: 3, completion_tokens: 1}}), {status: 200, headers: {'content-type': 'application/json'}});
  };
  const provider = installModelProvider({llm: {registerAdapter: () => () => {}}}, {...config.provider, resolveUserId: () => 'synthetic-standards'});
  try {
    const binding = {provider: config.model.provider, model: config.model.model, maxTokens: config.model.maxTokens, temperature: 0, reasoningEffort: 'off'};
    for (const mode of ['valid', 'source_stale', 'cancelled']) {
      const controller = new AbortController(); if (mode === 'cancelled') controller.abort();
      const call = provider.beginStrictVerificationCall({sessionId: randomUUID(), attempt_id: randomUUID(), permit_id: randomUUID(),
        binding, profile: config.model.budgetProfile,
        requireCurrent: async () => {if (mode === 'source_stale') throw new Error('synthetic_source_stale');},
        beforeDispatch: async value => {reservations++; reservation = modelLedgerInputBudget(value.budget);}});
      const request = {system: '合成配置探针。', user: '保持来源守卫。', signal: controller.signal,
        tool: {name: 'SourceVerificationOutput', description: '合成', parameters: {type: 'object', additionalProperties: false, properties: {}, required: []}}};
      try {
        if (mode === 'valid') await call.send(request); else await assert.rejects(call.send(request));
      } finally {call.close();}
    }
    assert.equal(requests.length, 1); assert.equal(reservations, 1);
    assert.equal(requests[0].body.max_tokens, 131072); assert.equal(reservation.max_output_tokens, 131072);
    assert.equal(reservation.request_sha256, hash(requests[0].raw));
  } finally {globalThis.fetch = oldFetch; await provider.dispose();}
  console.log(JSON.stringify({probe: 'output_and_dispatch_guards', output_tokens: 131072, fake_fetch_calls: requests.length,
    reservations, real_network_calls: 0, stale_and_cancelled_not_dispatched: true}));
});

const policyPath = '.scratch/dsh-ts-migration/reply-output-cost-update/execution-policy.json';
test('双臂输出绑定以最终wire为准，冻结runtime记录适配前后SHA且不改材料', async () => {
  const {freezeExecutionPolicy, verifyExecutionPolicyBinding, captureEvaluationRuntime} = await at('.scratch/dsh-ts-migration/ticket25-final-run/execution-snapshot.mjs');
  const primary = await readFile(join(root, '.scratch/dsh-ts-migration/ticket25-final-run/primary.json'));
  const input = JSON.parse(await readFile(join(root, policyPath), 'utf8'));
  const policy = freezeExecutionPolicy(input, primary), policySha = hash(policy);
  const scope = await readFile(join(root, '.scratch/dsh-ts-migration/reply-output-cost-update/scope-snapshot.md'));
  assert.equal(hash(scope), policy.scope_sha256);
  input.controls.max_output_tokens = 1; assert.equal(policy.controls.max_output_tokens, 393216);
  assert.ok(Object.isFrozen(policy.controls));
  const snapshot = await captureEvaluationRuntime({collectorRoot: join(root, '.scratch/dsh-ts-migration/ticket25-final-run'),
    moduleRoot: join(root, 'backend/src'), executionPolicy: policy});
  assert.equal(snapshot.control_adaptations.length, 3);
  assert.equal(snapshot.original_files['collector/primary.json'], hash(primary));
  for (const row of snapshot.control_adaptations) assert.notEqual(row.before_sha256, row.after_sha256);
  for (const [name, bytes] of snapshot.bytes) assert.equal(snapshot.files[name], hash(bytes));
  assert.equal(hash(await readFile(join(root, '.scratch/dsh-ts-migration/ticket25-final-run/primary.json'))), hash(primary));
  const make = () => ({execution_policy: policy, execution_policy_sha256: policySha,
    source_bindings: {old_profile: {controls: policy.controls}}, records: ['old', 'new'].map(arm => {
      const body = {model: 'deepseek-flash', max_tokens: 393216, temperature: 0, top_p: 1, thinking: {type: 'disabled'}, stream: true};
      const raw = JSON.stringify(body);
      return {arm, physical_calls: 1, runtime_sources: {attempts: [{request: {hash_kind: 'wire_utf8_sha256', raw_utf8: raw, sha256: hash(raw), body}}]}};
    })});
  verifyExecutionPolicyBinding(make(), policy);
  const wrong = make(), request = wrong.records[1].runtime_sources.attempts[0].request;
  request.body.max_tokens = 4096; request.raw_utf8 = JSON.stringify(request.body); request.sha256 = hash(request.raw_utf8);
  assert.throws(() => verifyExecutionPolicyBinding(wrong, policy), /wire_output/);
  assert.throws(() => verifyExecutionPolicyBinding(make(), undefined), /explicit_execution_policy_required/);
  const attempts = make(); attempts.records[0].physical_calls = 2;
  assert.throws(() => verifyExecutionPolicyBinding(attempts, policy), /attempt_count/);
  console.log(JSON.stringify({probe: 'frozen_policy_wire_binding', policy_sha256: policySha,
    original_primary_sha256: hash(primary), adaptations: snapshot.control_adaptations,
    wrong_wire_output_rejected: true, implicit_policy_rejected: true}));
});

test('费用豁免不改变旧默认报告，usage未知与严重假事仍阻止通过；范围摘要不可伪造', async () => {
  const {buildReplyComparisonReport, createReplyComparisonPlan} = await at('backend-ts/src/reply-comparison.ts');
  const {buildReplyComparisonReport: historical} = await at('backend-ts/src/reply-comparison.ts', join(root, 'bcc'));
  const manifestText = await readFile(join(root, 'backend-ts/test/fixtures/reply-comparison-material-manifest.json'), 'utf8');
  const datasetText = await readFile(join(root, 'backend/tests/fixtures/fidelity/synthetic-v1.json'), 'utf8');
  const authorSource = await readFile(join(root, '.scratch/dsh-ts-migration/reply-output-cost-update/output-cost.test.mjs'), 'utf8');
  const start = authorSource.indexOf('function reporterFixture(){'), end = authorSource.indexOf('\ntest(', start);
  assert.ok(start > 0 && end > start);
  // 仅复用公开合成载体，所有断言为本轴增量反例；不执行作者测试或采集器。
  const fixture = new Function('createReplyComparisonPlan', 'manifestText', 'datasetText', 'manifest', 'dataset', 'hash',
    authorSource.slice(start, end) + '; return reporterFixture;')(createReplyComparisonPlan, manifestText, datasetText,
      JSON.parse(manifestText), JSON.parse(datasetText), hash);
  const policy = JSON.parse(await readFile(join(root, policyPath), 'utf8'));
  const waiver = {costWaiver: {status: policy.cost_status, scope_ref: policy.scope_ref, scope_sha256: policy.scope_sha256}};
  const original = fixture(), originalSha = hash(original);
  assert.deepEqual(buildReplyComparisonReport(manifestText, datasetText, original), historical(manifestText, datasetText, original));
  assert.equal(hash(original), originalSha);
  const missingUsage = fixture(); missingUsage.price_snapshot = null;
  for (const row of missingUsage.records) row.cost = null;
  missingUsage.records[0].usage = null;
  const unknown = buildReplyComparisonReport(manifestText, datasetText, missingUsage, waiver);
  assert.notEqual(unknown.overall.status, 'passed'); assert.equal(unknown.population.planned, 96);
  assert.equal(unknown.metrics.cost.status, 'undetermined');
  assert.equal(unknown.records.find(row => row.blind_id === missingUsage.records[0].blind_id).usage, null);
  assert.ok(unknown.unknowns.some(row => row.reason === 'total_tokens_unknown' && row.blocking !== false));
  const severe = fixture();
  for (const review of severe.records.find(row => row.arm === 'new').reviews) {
    review.candidates[0].scores.no_unsupported_content = 0; review.candidates[0].severe_errors.false_fact = 1;
  }
  assert.equal(buildReplyComparisonReport(manifestText, datasetText, severe, waiver).overall.status, 'failed');
  const {reportCurrent} = await at('.scratch/dsh-ts-migration/reply-output-cost-update/report-current.mjs');
  const policySha = hash(policy), run = fixture();
  run.execution_policy = policy; run.execution_policy_sha256 = policySha;
  run.configuration.execution_policy_sha256 = policySha; run.config_hash = hash(run.configuration);
  for (const row of run.records) row.config_hash = run.config_hash;
  const files = {manifest: join(root, 'synthetic-manifest.json'), dataset: join(root, 'synthetic-dataset.json'),
    run: join(root, 'synthetic-report-run.json'), executionPolicy: join(root, 'synthetic-policy.json'), output: join(root, 'synthetic-current-report.json')};
  for (const [path, bytes] of [[files.manifest, manifestText], [files.dataset, datasetText], [files.run, JSON.stringify(run)], [files.executionPolicy, JSON.stringify(policy)]])
    await writeFile(path, bytes, {mode: 0o600});
  const reported = await reportCurrent(files);
  assert.equal(reported.cost_status, 'waived_by_user'); assert.equal(reported.metrics.cost.status, 'failed');
  const forged = {...policy, scope_sha256: 'f'.repeat(64)};
  await writeFile(files.executionPolicy, JSON.stringify(forged), {mode: 0o600});
  const rejectedOutput = join(root, 'forged-report-must-not-exist.json');
  await assert.rejects(reportCurrent({...files, output: rejectedOutput}), /scope_snapshot_binding/);
  await assert.rejects(stat(rejectedOutput), {code: 'ENOENT'});
  console.log(JSON.stringify({probe: 'waiver_preserves_other_gates', fixture_kind: 'reporter_fixture_only',
    author_fixture_source_sha256: hash(authorSource), original_default_equal_to_bcc: true,
    unknown_usage_blocked: true, severe_false_fact_blocked: true, scope_digest_forgery_blocked: true,
    fixed_planned_denominator: 96, real_model_calls: 0}));
});
