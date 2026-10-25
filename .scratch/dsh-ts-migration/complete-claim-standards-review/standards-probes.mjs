import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, rename} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';

const snapshot = process.env.STANDARDS_SNAPSHOT;
assert.ok(snapshot);
const moduleAt = path => import(pathToFileURL(join(snapshot, 'backend-ts/src', path)).href);
const {prepareSourceVerification} = await moduleAt('complete-claim-verification.ts');
const {parseDirectExtraction} = await moduleAt('extraction-protocol.ts');
const {attachVerifiedSourceReceipt} = await moduleAt('extraction-evidence.ts');
const {parseStoredJSON, canonicalJSON} = await moduleAt('contact-overview-evidence.ts');
const {createExtractionPolicyVersion, validateExtractionRuntimeConfig} = await moduleAt('extraction-policy-version.ts');
const owner = '11111111-1111-4111-8111-111111111111';
const contact = '22222222-2222-4222-8222-222222222222';
const message = '33333333-3333-4333-8333-333333333333';
const text = '🙂合成角色喜爱 e\u0301 与绿茶。';
const source = {source_ref_id: '44444444-4444-4444-8444-444444444444',
  source_id: '55555555-5555-4555-8555-555555555555', source_kind: 'source_document',
  locator: 'synthetic:standards', source_content_sha256: 'b'.repeat(64),
  raw_payload: parseStoredJSON('{"id":900719925474099312345,"ratio":1.0}')};
const window = {owner_id: owner, contact_id: contact, target_message_ids: [message],
  messages: [{message_id: message, sender: 'contact', occurred_at: null,
    message_type: 'text', text_representation: 'text', text, source_snapshots: [source]}]};
const rawFact = {text, subject: 'contact', category: 'preference', topic: 'other',
  source_message_ids: [message], confidence: 0.8, risk_flags: [], valid_at: null, invalid_at: null,
  speech_act: 'assertion', assertion_status: 'asserted', figurative_type: 'literal',
  alternatives: [], interpretation_reason: '完全合成的接口探针。', event: null, conditions: null};
const facts = parseDirectExtraction({scenes: [{scene_name: '合成场景', memories: [rawFact, rawFact]}]}, window).accepted;
assert.equal(facts.length, 2);
const policy = {id: 'complete-claim-v1', rule_version: 'a'.repeat(64)};
function blocks(prepared, uncertain = true) {
  const facet = verdict => ({verdict, evidence_indices: [0]});
  const part = (start, end, verdict = 'supported') => ({candidate_span: {start, end},
    attribution: {...facet('supported'), scope_subject: 'contact', actor_kind: 'contact', resolution: 'explicit'},
    arguments_and_relation: facet(verdict), temporal_and_modality: facet('supported')});
  const results = [1, 0].map(candidate_index => ({candidate_index, verdict: 'supported', issues: [],
    evidence: [{message_id: message, quote: text}], claim_check: {version: 1,
      parts: [part(0, 2), part(2, [...text].length, candidate_index === 1 && uncertain ? 'uncertain' : 'supported')]}}));
  return [{type: 'tool-call', name: 'SourceVerificationOutput', arguments: JSON.stringify({request_fingerprint: prepared.fingerprint, results})}];
}

test('乱序两候选、组合码点、返回隔离、失效重解码与非序列化receipt', async () => {
  let current = true;
  const prepared = prepareSourceVerification({window, facts, policy,
    requireCurrent: async () => {if (!current) throw new Error('synthetic_source_stale');}});
  const request = prepared.request;
  request.tool.parameters.required.length = 0;
  request.user = 'synthetic mutation';
  assert.ok(prepared.request.tool.parameters.required.includes('request_fingerprint'));
  const response = blocks(prepared);
  await prepared.request.validateOutput(response);
  const result = await prepared.decode(response);
  assert.deepEqual(result.items.map(item => [item.candidate_index, item.admitted]), [[0, true], [1, false]]);
  const bound = attachVerifiedSourceReceipt(window, facts[0], result.items[0].result);
  assert.equal(bound.dimension_evidence.version, 1);
  assert.ok(bound.verified_source_receipt);
  assert.throws(() => attachVerifiedSourceReceipt(window, facts[0], JSON.parse(JSON.stringify(result.items[0].result))), /unbound_admission/);
  const precisionLost = {...window, messages: [{...window.messages[0], source_snapshots: [{...source,
    raw_payload: JSON.parse('{"id":900719925474099312345,"ratio":1.0}')}]}]};
  assert.throws(() => attachVerifiedSourceReceipt(precisionLost, facts[0], result.items[0].result), /unbound_admission/);
  result.items[0].result.verdict = 'unsupported';
  assert.equal((await prepared.decode(response)).items[0].result.verdict, 'supported');
  current = false;
  await assert.rejects(prepared.decode(response), /synthetic_source_stale/);
  const racing = prepareSourceVerification({window, facts, policy, requireCurrent: async () => {}});
  const race = await Promise.allSettled([racing.decode(blocks(racing)), racing.decode(blocks(racing, false))]);
  assert.equal(race.filter(row => row.status === 'fulfilled').length, 1);
  assert.match(race.find(row => row.status === 'rejected').reason.message, /response_changed/);
  console.log(JSON.stringify({probe: 'prepared_interface', passed: true,
    result_order_isolated: true, stale_redecode_rejected: true, serialized_receipt_rejected: true,
    original_numeric_payload: canonicalJSON(source.raw_payload)}));
});

test('实际生产传递闭包包含prompt/schema/compiler/validator/vendorL1与package/lock', async () => {
  const version = await createExtractionPolicyVersion({rootDirectory: join(snapshot, 'backend-ts/src')});
  assert.equal(version.sourceStamp, '2e36ada0f02a44d6cf709a0cd1255f5ffeb7f5a56491e2549b0de9ce274b1b64');
  const config = version.newTaskConfig();
  const mutations = ['src/extraction-prompts.ts', 'src/extraction-protocol-contract.ts',
    'src/extraction-bounded.ts', 'src/extraction-protocol.ts', 'src/deepseek-strict-verification.ts',
    'src/vendor/tencent-memory/l1-extraction.ts', 'src/complete-claim-verification.ts',
    'package.json', 'pnpm-lock.yaml'];
  for (const relative of mutations) {
    const path = join(snapshot, 'backend-ts', relative), original = await readFile(path);
    try {
      await writeFile(path, Buffer.concat([original, Buffer.from('\n/* 合成身份扰动 */\n')]));
      await assert.rejects(version.assertCurrent(), /source_unavailable/);
      const changed = await createExtractionPolicyVersion({rootDirectory: join(snapshot, 'backend-ts/src')});
      assert.notEqual(changed.sourceStamp, version.sourceStamp);
      assert.throws(() => changed.resolve(config), /source_unavailable/);
    } finally {await writeFile(path, original);}
  }
  const missing = join(snapshot, 'backend-ts/src/extraction-protocol-contract.ts');
  await rename(missing, missing + '.standards-held');
  try {await assert.rejects(version.assertCurrent(), /source_unavailable/);}
  finally {await rename(missing + '.standards-held', missing);}
  const vendor = join(snapshot, 'backend-ts/src/vendor/tencent-memory/l1-extraction.ts');
  const original = await readFile(vendor);
  try {
    await writeFile(vendor, Buffer.concat([original, Buffer.from('\nconst standardsLoad=(name:string)=>import(name);\n')]));
    await assert.rejects(createExtractionPolicyVersion({rootDirectory: join(snapshot, 'backend-ts/src')}), /source_unavailable/);
  } finally {await writeFile(vendor, original);}
  await version.assertCurrent();
  console.log(JSON.stringify({probe: 'actual_source_closure', passed: true,
    source_stamp: version.sourceStamp, mutated_paths: mutations,
    missing_source_rejected: true, dynamic_source_rejected: true, restored: true}));
});

test('116最小合成表的SQL/TS五键差分与B权威策略读取', {timeout: 20000}, async () => {
  const require = createRequire(join(snapshot, 'backend-ts/package.json'));
  const pg = require('pg');
  const {ExtractionTaskStore} = await moduleAt('extraction-task-store.ts');
  const database = 'notalone_standards_' + randomUUID().replaceAll('-', '') + '_test';
  assert.match(database, /^notalone_standards_[a-f0-9]{32}_test$/);
  const admin = new pg.Client({host: '/tmp', database: 'postgres', connectionTimeoutMillis: 3000});
  let client, pool, created = false, dropped = false;
  let rowsChecked = 0;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`); created = true;
    client = new pg.Client({host: '/tmp', database, connectionTimeoutMillis: 3000}); await client.connect();
    await client.query(`CREATE TABLE public.background_task(id uuid PRIMARY KEY, owner_id uuid, contact_id uuid,
      extraction_runtime_config jsonb, CONSTRAINT background_task_extraction_runtime_config_check CHECK (true))`);
    const old = [null, {version: 1, mode: 'legacy', rule_set_sha256: null},
      {version: 1, mode: 'bounded-runtime-v1', rule_set_sha256: 'b'.repeat(64)}];
    for (const config of old) await client.query('INSERT INTO background_task VALUES($1,$2,$3,$4::jsonb)',
      [randomUUID(), owner, contact, config === null ? null : JSON.stringify(config)]);
    const before = (await client.query('SELECT id,extraction_runtime_config::text FROM background_task ORDER BY id')).rows;
    await client.query(await readFile(join(snapshot, 'backend/database/migrations/116_complete_claim_verification_policy.sql'), 'utf8'));
    assert.deepEqual((await client.query('SELECT id,extraction_runtime_config::text FROM background_task ORDER BY id')).rows, before);
    const valid = {version: 2, mode: 'legacy', rule_set_sha256: null, verification_policy: 'complete-claim-v1', source_stamp: 'a'.repeat(64)};
    const matrix = [...old, valid, {...valid, extra: true}, [], 2,
      ...Object.keys(valid).map(key => Object.fromEntries(Object.entries(valid).filter(([name]) => name !== key))),
      ...Object.keys(valid).filter(key => key !== 'rule_set_sha256').map(key => ({...valid, [key]: null})),
      {...valid, version: true}, {...valid, version: '2'}, {...valid, version: 2.5},
      {...valid, mode: ['legacy']}, {...valid, mode: 'bounded-runtime-v1'},
      {...valid, rule_set_sha256: 'b'.repeat(64)}, {...valid, verification_policy: {}},
      {...valid, source_stamp: 'A'.repeat(64)}, {...valid, source_stamp: 'a'.repeat(65)}];
    for (const value of matrix) {
      let ts = true, sql = true;
      try {validateExtractionRuntimeConfig(value);} catch {ts = false;}
      try {await client.query('INSERT INTO background_task VALUES($1,$2,$3,$4::jsonb)',
        [randomUUID(), owner, contact, value === null ? null : JSON.stringify(value)]);}
      catch (error) {if (error.code !== '23514') throw error; sql = false;}
      assert.equal(sql, ts, JSON.stringify(value)); rowsChecked++;
    }
    // v2 JSONB 的合法数值写法 2.0 同样映射到版本2。
    const numeric = JSON.stringify(valid).replace('"version":2', '"version":2.0');
    await client.query('INSERT INTO background_task VALUES($1,$2,$3,$4::jsonb)', [randomUUID(), owner, contact, numeric]);
    assert.equal(validateExtractionRuntimeConfig(JSON.parse(numeric)).version, 2);
    const version = await createExtractionPolicyVersion({rootDirectory: join(snapshot, 'backend-ts/src')});
    const config = version.newTaskConfig(), task = randomUUID();
    const claim = {taskId: task, ownerId: owner, contactId: contact};
    await client.query('INSERT INTO background_task VALUES($1,$2,$3,$4::jsonb)', [task, owner, contact, JSON.stringify(config)]);
    pool = new pg.Pool({host: '/tmp', database, max: 1});
    const store = new ExtractionTaskStore(pool, {policyVersion: version});
    const resolved = version.resolve(config);
    const runtime = parseStoredJSON(JSON.stringify({config_version: 2, mode: 'legacy', rule_set_sha256: null,
      verification_policy: config.verification_policy, source_stamp: config.source_stamp, rule_version: resolved.ruleVersion}));
    await store.assertVerificationPolicy(client, claim, runtime, resolved.ruleVersion);
    await assert.rejects(store.assertVerificationPolicy(client, claim, runtime, 'f'.repeat(64)), /window_mismatch/);
    await assert.rejects(store.assertVerificationPolicy(client, {...claim, ownerId: randomUUID()}, runtime, resolved.ruleVersion), /lease_stale/);
    await client.query('UPDATE background_task SET extraction_runtime_config=NULL WHERE id=$1', [task]);
    await assert.rejects(store.assertVerificationPolicy(client, claim, runtime, resolved.ruleVersion), /window_mismatch/);
    await client.query('UPDATE background_task SET extraction_runtime_config=$2::jsonb WHERE id=$1', [task, JSON.stringify({...config, source_stamp: 'e'.repeat(64)})]);
    await assert.rejects(store.assertVerificationPolicy(client, claim, runtime, resolved.ruleVersion), /source_unavailable/);
  } finally {
    if (pool) await pool.end();
    if (client) await client.end();
    if (created) {
      const active = (await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1', [database])).rows[0].n;
      assert.equal(active, 0);
      await admin.query(`DROP DATABASE "${database}"`);
      dropped = (await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount === 0;
      assert.ok(dropped);
    }
    await admin.end();
    console.log(JSON.stringify({probe: 'sql_ts_and_policy', database, created, dropped,
      matrix_rows: rowsChecked, full_schema_migration: false, full_b_lease_or_write_test: false}));
  }
});
