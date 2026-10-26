import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import pg from 'pg';
import { HostStorage, HostStorageError } from '../src/platform/database/host-storage.ts';
import { SkillLearningNotFound, normalizeProposal } from '../src/skills/skill-learning-contract.ts';
import { SkillFiles } from '../src/skills/skill-files.ts';
import { SkillLibrary } from '../src/skills/skill-library.ts';
import { ExtractionTaskStore } from '../src/memory/extraction/extraction-task-store.ts';
import { SkillLearningStore } from '../src/skills/skill-learning-store.ts';
import { SkillReviewStore } from '../src/skills/skill-review-store.ts';
import { SkillHistoryPolicyStore } from '../src/skills/skill-history-policy-store.ts';
import { SkillLearningHttp } from '../src/skills/skill-learning-http.ts';
import { ModelLedgerError, PostgresModelLedger, PostgresModelLedgerDetails } from '../src/platform/models/model-ledger.ts';
import { createStorageFixture } from './host-storage-fixture.mjs';

async function storageFixture(t) {
  const fixture = await createStorageFixture();
  const storage = await HostStorage.open({
    ...fixture.options,
    environment: {
      NOTALONE_DISABLE_DOTENV: '1',
      NOTALONE_DATABASE_URL: `host=/tmp dbname=${fixture.client.database}`,
    },
  });
  t.after(async () => { await storage.close(); await fixture.close(); });
  return { fixture, storage };
}

test('业务 NotFound 原样传播并回滚本次全部写入', async t => {
  const { storage } = await storageFixture(t);
  const rejection = new SkillLearningNotFound();
  let actual;
  await assert.rejects(storage.businessTransaction(async client => {
    await client.query('INSERT INTO public.owner(id,display_name) VALUES($1,$2)', [randomUUID(), '必须回滚的合成本人']);
    throw rejection;
  }), error => {
    actual = error;
    return true;
  });
  assert.equal((await storage.setupStatus()).owner_configured, false);
  assert.equal(actual, rejection);
});

test('真实 PostgreSQL 查询失败保持受控数据库错误并回滚写入', async t => {
  const { storage } = await storageFixture(t);
  await assert.rejects(storage.businessTransaction(async client => {
    await client.query('INSERT INTO public.owner(id,display_name) VALUES($1,$2)', [randomUUID(), '数据库失败时必须回滚']);
    await client.query('SELECT * FROM public.synthetic_private_relation_missing');
  }), error => {
    assert.ok(error instanceof HostStorageError);
    assert.equal(error.code, 'database_unavailable');
    assert.equal(error.message, 'database_unavailable');
    assert.doesNotMatch(JSON.stringify(error), /synthetic_private_relation_missing|42P01/);
    return true;
  });
  assert.equal((await storage.setupStatus()).owner_configured, false);
});

test('pg 客户端查询超时的普通 Error 仍保持受控数据库错误', async t => {
  const { storage } = await storageFixture(t);
  await assert.rejects(storage.businessTransaction(async client => {
    await client.query('INSERT INTO public.owner(id,display_name) VALUES($1,$2)', [randomUUID(), '客户端超时时必须回滚']);
    await client.query({ text: 'SELECT pg_sleep(0.05)', query_timeout: 1 });
  }), { name: 'HostStorageError', code: 'database_unavailable' });
  assert.equal((await storage.setupStatus()).owner_configured, false);
});

test('pg 回调查询保留成功返回，客户端超时和同步查询错误仍受控', async t => {
  const { storage } = await storageFixture(t);
  const value = await storage.businessTransaction(client => new Promise((resolve, reject) => {
    const returned = client.query('SELECT 7 AS value', (error, result) => error ? reject(error) : resolve(result.rows[0].value));
    assert.equal(returned, undefined);
  }));
  assert.equal(value, 7);
  await assert.rejects(storage.businessTransaction(client => new Promise((resolve, reject) => {
    client.query({ text: 'SELECT pg_sleep(0.05)', query_timeout: 1 }, (error, result) => error ? reject(error) : resolve(result));
  })), { name: 'HostStorageError', code: 'database_unavailable' });
  await assert.rejects(storage.businessTransaction(async client => { client.query(null); }),
    { name: 'HostStorageError', code: 'database_unavailable' });
});

test('pg 查询重载的普通驱动错误均受控且回滚写入', async t => {
  const { storage } = await storageFixture(t);
  for (const kind of ['promise', 'positional_callback', 'config_callback', 'query_callback', 'query_positional_callback', 'query_event']) await t.test(kind, async () => {
    let actual;
    await assert.rejects(storage.businessTransaction(async client => {
      await client.query('INSERT INTO owner(id,display_name) VALUES($1,$2)', [randomUUID(), '重载失败时必须回滚']);
      await client.query({ name: 'synthetic_overload', text: 'SELECT 1 AS value' });
      const config = { name: 'synthetic_overload', text: 'SELECT 2 AS value' };
      if (kind === 'promise') return client.query(config);
      return new Promise((resolve, reject) => {
        const callback = (error, result) => error ? reject(error) : resolve(result);
        if (kind === 'positional_callback') return client.query(config, callback);
        if (kind === 'config_callback') return client.query({ ...config, callback });
        const query = kind === 'query_callback' ? new pg.Query(config, callback) : new pg.Query(config);
        if (kind === 'query_event') query.once('error', reject);
        assert.equal(kind === 'query_positional_callback' ? client.query(query, callback) : client.query(query), query);
        assert.equal(query.callback, kind === 'query_event' ? undefined : callback);
      });
    }), error => { actual = error; return true; });
    assert.equal((await storage.setupStatus()).owner_configured, false);
    assert.ok(actual instanceof HostStorageError);
    assert.equal(actual.code, 'database_unavailable');
    assert.equal(actual.message, 'database_unavailable');
  });
});

test('pg 成功重载保留 Query、回调 this、配置回调和结果对象身份', async t => {
  const { storage } = await storageFixture(t);
  for (const kind of ['positional_callback', 'config_callback', 'query_callback', 'query_callback_with_then', 'query_positional_callback', 'query_event']) await t.test(kind, async () => {
    let query, callbackResult, endResult;
    const result = await storage.businessTransaction(client => new Promise((resolve, reject) => {
      function callback(error, value) {
        if (error) return reject(error);
        try {
          assert.ok(this instanceof pg.Query);
          assert.equal(this.callback, callback);
          if (query) assert.equal(this, query);
          callbackResult = value;
          resolve(value);
        } catch (error) { reject(error); }
      }
      const config = { text: 'SELECT 7 AS value' };
      if (kind === 'positional_callback') { assert.equal(client.query(config, callback), undefined); return; }
      if (kind === 'config_callback') {
        config.callback = callback;
        Object.freeze(config);
        assert.equal(client.query(config), undefined);
        assert.equal(config.callback, callback);
        return;
      }
      query = ['query_callback', 'query_callback_with_then'].includes(kind) ? new pg.Query(config, callback) : new pg.Query(config);
      if (kind === 'query_callback_with_then') query.then = () => { assert.fail('不得把 Query 实例消费为 Promise'); };
      if (kind === 'query_event') query.once('error', reject);
      query.once('end', value => { endResult = value; if (kind === 'query_event') resolve(value); });
      assert.equal(kind === 'query_positional_callback' ? client.query(query, callback) : client.query(query), query);
      assert.equal(query.callback, kind === 'query_event' ? undefined : callback);
    }));
    assert.deepEqual(result.rows, [{ value: 7 }]);
    if (kind !== 'query_event') assert.equal(result, callbackResult);
    if (query) {
      assert.equal(result, endResult);
    }
  });
});

test('配置内回调原样保留继承和非枚举字段及原生返回身份', async t => {
  const { storage } = await storageFixture(t);
  const inherited = Object.create({ text: 'SELECT $1::integer AS value', values: [17] });
  const hidden = {};
  Object.defineProperties(hidden, {
    text: { value: 'SELECT $1::integer AS value' }, values: { value: [17] },
  });
  const configs = [inherited, hidden], callbacks = [], callbackResults = [];
  const results = await storage.businessTransaction(client => Promise.all(configs.map((config, index) => new Promise((resolve, reject) => {
    function callback(error, result) {
      if (error) return reject(error);
      try {
        assert.ok(this instanceof pg.Query);
        assert.equal(this.callback, callback);
        callbackResults[index] = result;
        resolve(result);
      } catch (error) { reject(error); }
    }
    callbacks[index] = callback;
    config.callback = callback;
    assert.equal(client.query(config), undefined);
    assert.equal(config.callback, callback);
  }))));
  assert.deepEqual(results.map(result => result.rows), [[{ value: 17 }], [{ value: 17 }]]);
  results.forEach((result, index) => assert.equal(result, callbackResults[index]));
  configs.forEach((config, index) => assert.equal(config.callback, callbacks[index]));
  assert.equal(Object.hasOwn(inherited, 'text'), false);
  assert.equal(Object.getOwnPropertyDescriptor(hidden, 'text').enumerable, false);
});

test('排队的配置回调超时先通知原函数一次且驱动错误仍受控', async t => {
  const { storage } = await storageFixture(t);
  let calls = 0, callbackThis, callbackArguments;
  const config = Object.create({ text: 'SELECT 17 AS value', query_timeout: 1 });
  function callback(error, result) {
    calls++;
    callbackThis = this;
    callbackArguments = arguments.length;
    error ? rejectTimeout(error) : resolveTimeout(result);
  }
  let resolveTimeout, rejectTimeout;
  config.callback = callback;
  await assert.rejects(storage.businessTransaction(async client => {
    await client.query('INSERT INTO owner(id,display_name) VALUES($1,$2)', [randomUUID(), '回调超时必须回滚']);
    const active = client.query('SELECT pg_sleep(0.05)');
    const timeout = new Promise((resolve, reject) => { resolveTimeout = resolve; rejectTimeout = reject; });
    assert.equal(client.query(config), undefined);
    assert.equal(config.callback, callback);
    return Promise.all([active, timeout]);
  }), { name: 'HostStorageError', code: 'database_unavailable' });
  assert.equal(calls, 1);
  assert.equal(callbackThis, undefined);
  assert.equal(callbackArguments, 1);
  assert.equal(config.callback, callback);
  assert.equal((await storage.setupStatus()).owner_configured, false);
});

test('toPostgres 重入排队后原活动查询超时仍受控并回滚全部写入', async t => {
  const { storage } = await storageFixture(t);
  let actual, nativeFailure, callbacks = 0, nestedCallbacks = 0;
  await assert.rejects(storage.businessTransaction(async client => {
    await client.query('INSERT INTO owner(id,display_name) VALUES($1,$2)', [randomUUID(), '重入超时必须回滚']);
    return new Promise((resolve, reject) => {
      const value = { toPostgres() {
        client.query('SELECT 1 AS nested', error => { assert.ifError(error); nestedCallbacks++; });
        return 'synthetic-only';
      } };
      client.query({ text: 'SELECT pg_sleep(0.05), $1::text AS value', values: [value], query_timeout: 1,
        callback(error, result) {
          callbacks++;
          if (error) { nativeFailure = error; reject(error); } else resolve(result);
        },
      });
    });
  }), error => { actual = error; return true; });
  assert.equal(callbacks, 1);
  assert.equal(nestedCallbacks, 1);
  assert.equal((await storage.setupStatus()).owner_configured, false);
  assert.ok(actual instanceof HostStorageError);
  assert.equal(actual.code, 'database_unavailable');
  assert.notEqual(actual, nativeFailure);
});

test('Query 原回调保持只读身份，行解析错误优先于随后的数据库错误且仍受控', async t => {
  const { storage } = await storageFixture(t);
  const parserError = new Error('synthetic-private-parser-failure');
  let query;
  await assert.rejects(storage.businessTransaction(async client => {
    await client.query('INSERT INTO owner(id,display_name) VALUES($1,$2)', [randomUUID(), '解析错误必须回滚']);
    return new Promise((resolve, reject) => {
      function callback(error, value) {
        try {
          assert.equal(this, query);
          assert.equal(query.callback, callback);
          assert.equal(error, parserError);
          error ? reject(error) : resolve(value);
        } catch (error) { reject(error); }
      }
      query = new pg.Query({ text: "SELECT 'synthetic'::text AS value; SELECT 1/0", types: {
        getTypeParser(oid, format) {
          return oid === 25 ? () => { throw parserError; } : pg.types.getTypeParser(oid, format);
        },
      } }, callback);
      Object.defineProperty(query, 'callback', { value: callback, writable: false, configurable: false });
      assert.equal(client.query(query), query);
      assert.equal(query.callback, callback);
    });
  }), { name: 'HostStorageError', code: 'database_unavailable' });
  assert.equal((await storage.setupStatus()).owner_configured, false);
});

test('Query 内回调超时仍受控，调用方转换的业务错误保持原对象', async t => {
  const { storage } = await storageFixture(t);
  const domainError = new SkillLearningNotFound();
  for (const mode of ['client_timeout', 'business_mapping']) await t.test(mode, async () => {
    let calls = 0, actual;
    await assert.rejects(storage.businessTransaction(async client => {
      await client.query('INSERT INTO owner(id,display_name) VALUES($1,$2)', [randomUUID(), '回调失败时必须回滚']);
      if (mode === 'business_mapping') await client.query({ name: 'synthetic_mapping', text: 'SELECT 1' });
      return new Promise((resolve, reject) => {
        const config = mode === 'client_timeout' ? { text: 'SELECT pg_sleep(0.05)' }
          : { name: 'synthetic_mapping', text: 'SELECT 2' };
        const query = new pg.Query(config, (error, result) => {
          calls++;
          if (error) reject(mode === 'business_mapping' ? domainError : error);
          else resolve(result);
        });
        // pg.Client 接收 Query 对象上的超时选项，Query 构造器不会复制它。
        if (mode === 'client_timeout') query.query_timeout = 1;
        assert.equal(client.query(query), query);
      });
    }), error => { actual = error; return true; });
    assert.equal(calls, 1);
    assert.equal((await storage.setupStatus()).owner_configured, false);
    if (mode === 'business_mapping') assert.equal(actual, domainError);
    else assert.ok(actual instanceof HostStorageError && actual.code === 'database_unavailable');
  });
});

test('只读事务保留业务错误，真实 PostgreSQL 拒绝写入仍受控', async t => {
  const { storage } = await storageFixture(t);
  const rejection = new SkillLearningNotFound();
  await assert.rejects(storage.businessReadTransaction(async client => {
    await client.query('SELECT 1');
    throw rejection;
  }), error => error === rejection);
  await assert.rejects(storage.businessReadTransaction(client => client.query(
    'INSERT INTO public.owner(id,display_name) VALUES($1,$2)', [randomUUID(), '只读事务不能保存'])),
  { name: 'HostStorageError', code: 'database_unavailable' });
  assert.equal((await storage.setupStatus()).owner_configured, false);
});

test('提交阶段的真实 PostgreSQL 约束错误不能返回成功或重放业务', async t => {
  const { storage } = await storageFixture(t);
  let attempts = 0;
  await assert.rejects(storage.businessTransaction(async client => {
    attempts++;
    await client.query('INSERT INTO public.owner(id,display_name) VALUES($1,$2)', [randomUUID(), '提交失败时必须回滚']);
    await client.query('CREATE TEMP TABLE synthetic_deferred(id integer UNIQUE DEFERRABLE INITIALLY DEFERRED)');
    await client.query('INSERT INTO synthetic_deferred VALUES(1),(1)');
    return '不能恢复为成功';
  }), { name: 'HostStorageError', code: 'database_unavailable' });
  assert.equal(attempts, 1);
  assert.equal((await storage.setupStatus()).owner_configured, false);
});

test('事务连接被真实 PostgreSQL 终止后保持受控错误并释放连接', async t => {
  const { fixture, storage } = await storageFixture(t);
  await assert.rejects(storage.businessTransaction(async client => {
    await client.query('INSERT INTO public.owner(id,display_name) VALUES($1,$2)', [randomUUID(), '断连时必须回滚']);
    const { pid } = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0];
    await fixture.client.query('SELECT pg_terminate_backend($1)', [pid]);
    await client.query('SELECT 1');
  }), { name: 'HostStorageError', code: 'database_unavailable' });
  assert.equal((await storage.setupStatus()).owner_configured, false);
});

test('连接尚未建立时失败仍受控且不会执行业务回调', async t => {
  const { fixture } = await storageFixture(t);
  const unavailable = await HostStorage.open({ ...fixture.options, environment: {
    NOTALONE_DISABLE_DOTENV: '1',
    NOTALONE_DATABASE_URL: `host=${join(fixture.directory, 'missing-socket')} dbname=synthetic_test`,
  } });
  try {
    await assert.rejects(unavailable.businessTransaction(async () => { assert.fail('连接失败不能执行业务'); }),
      { name: 'HostStorageError', code: 'database_unavailable' });
  } finally { await unavailable.close(); }
});

test('取消原因原样传播且已开始的业务写入回滚', async t => {
  const { storage } = await storageFixture(t);
  const controller = new AbortController();
  const reason = new DOMException('synthetic-cancelled-operation', 'AbortError');
  await assert.rejects(storage.businessTransaction(async client => {
    await client.query('INSERT INTO public.owner(id,display_name) VALUES($1,$2)', [randomUUID(), '取消时必须回滚']);
    controller.abort(reason);
    controller.signal.throwIfAborted();
  }), error => error === reason);
  assert.equal((await storage.setupStatus()).owner_configured, false);
});

test('关闭排空在途业务并拒绝迟到提交和新事务', async t => {
  const { fixture, storage } = await storageFixture(t);
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const pending = storage.businessTransaction(async client => {
    await client.query('INSERT INTO public.owner(id,display_name) VALUES($1,$2)', [randomUUID(), '关闭时不能迟到保存']);
    entered();
    await blocked;
    return '不能恢复为成功';
  });
  const rejected = assert.rejects(pending, { name: 'HostStorageError', code: 'runtime_stopping' });
  await ready;
  const closing = storage.close();
  release();
  await Promise.all([closing, rejected]);
  await assert.rejects(storage.businessTransaction(async () => { assert.fail('关闭后不能执行业务'); }),
    { name: 'HostStorageError', code: 'runtime_stopping' });
  const reopened = await HostStorage.open({ ...fixture.options, environment: {
    NOTALONE_DISABLE_DOTENV: '1', NOTALONE_DATABASE_URL: `host=/tmp dbname=${fixture.client.database}`,
  } });
  try { assert.equal((await reopened.setupStatus()).owner_configured, false); }
  finally { await reopened.close(); }
});

test('业务拒绝后 unknown 回执保持原样，迟到 pending 不解除禁止重放', async t => {
  const { fixture, storage } = await storageFixture(t);
  const { owner_id } = await storage.initializeOwner('合成账本本人');
  const contact_id = randomUUID();
  await fixture.client.query('INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,$3)', [contact_id, owner_id, '合成账本联系人']);
  const ledger = new PostgresModelLedger({ transaction: work => storage.businessTransaction(work), details: new PostgresModelLedgerDetails() });
  const receipt = { attempt_id: randomUUID(), permit_id: randomUUID(), request_id: randomUUID(), owner_id, contact_id,
    provider: 'synthetic', model: 'synthetic-model', called_at: '2026-10-25T00:00:00.000Z', latency_ms: null,
    dispatch: 'authorized_unconfirmed', outcome: 'pending', usage: null,
    cost: { status: 'unknown', amount: null, currency: null, pricing_version: null } };
  await ledger.reserve(receipt, 10);
  await ledger.recoverUnknownPermits([receipt.permit_id]);
  const state = () => storage.businessReadTransaction(async client => (await client.query(
    'SELECT attempt_id,outcome,dispatch,input_tokens,output_tokens,cost_amount FROM model_call_receipt WHERE request_id=$1',
    [receipt.request_id])).rows);
  const original = [{ attempt_id: receipt.attempt_id, outcome: 'unknown', dispatch: 'authorized_unconfirmed',
    input_tokens: null, output_tokens: null, cost_amount: null }];
  assert.deepEqual(await state(), original);
  const rejected = error => error instanceof ModelLedgerError && error.code === 'model_ledger_unknown_requires_resolution';
  await assert.rejects(ledger.reserve({ ...receipt, attempt_id: randomUUID() }, 10), rejected);
  await ledger.recordReserved(receipt);
  await assert.rejects(ledger.reserve(receipt, 10), rejected);
  assert.deepEqual(await state(), original);
});

test('公开 Skill 审批缺失对照返回 404，待审修订与已启用 v1 均不变', async t => {
  const { fixture, storage } = await storageFixture(t);
  const { owner_id: owner } = await storage.initializeOwner('合成审核本人');
  const contact = randomUUID();
  await fixture.client.query('INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,$3)', [contact, owner, '合成审核联系人']);
  await fixture.client.query(`INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator,status)
    VALUES($1,$2,$3,'wechat','synthetic','synthetic-review','active')`, [randomUUID(), owner, contact]);
  const scope = { owner_id: owner, contact_id: contact };
  let businessFault;
  const transaction = work => storage.businessTransaction(async client => {
    if (businessFault) throw businessFault;
    return work(client);
  });
  const files = new SkillFiles(join(fixture.directory, 'skills'));
  const library = new SkillLibrary(storage, files);
  const packagePath = join(fixture.directory, 'synthetic-review-target');
  await mkdir(packagePath);
  await writeFile(join(packagePath, 'SKILL.md'), '---\nname: synthetic-review-target\ndescription: "合成审核目标。"\n---\n\n先核对对方的问题。\n');
  const imported = await library.importPackage(owner, packagePath);
  const originalVersions = await library.versions(owner, imported.skill_id);
  assert.equal(originalVersions.length, 1);
  assert.equal(originalVersions[0].version_number, 1);
  assert.equal(originalVersions[0].is_current, true);
  assert.equal(originalVersions[0].enabled, true);
  const originalPreview = await library.preview(owner, imported.skill_id);
  const pool = await storage.businessPool();
  let server;
  try {
    const learning = new SkillLearningStore({ transaction, files, taskStore: new ExtractionTaskStore(pool) });
    const review = new SkillReviewStore({ transaction, learning, files, library });
    const historyPolicy = new SkillHistoryPolicyStore({ transaction, files, library });
    const http = new SkillLearningHttp({ ownerId: owner, learning, review, historyPolicy, canSchedule: false,
      wake: async () => { assert.fail('审核拒绝不能调度模型任务'); } });
    await learning.configure(scope, { enabled: true, operationKey: randomUUID(), expectedRevision: 0 });
    const batch = await learning.capture(scope);
    const target = batch.targets.find(item => item.skill_id === imported.skill_id);
    assert.ok(target);
    const { proposal } = normalizeProposal(scope, batch, {
      outcome: 'draft', proposal_kind: 'update', target_skill_ids: [target.skill_id], name: target.name,
      description: '更新后的合成审核目标。', scene: '合成问题澄清',
      scope_suggestion: { kind: 'contact', reason: '仅供当前联系人审核。' },
      methods: [{ key: 'clarify-first', title: '先澄清问题', instruction: '先核对问题所指，再说明处理方式。',
        replaces_method_ids: target.methods.map(item => item.method_id) }],
    });
    assert.ok(proposal);
    const draft = randomUUID();
    await fixture.client.query(`INSERT INTO skill_draft(id,owner_id,contact_id,logical_skill_id,proposal_kind,strategy,
      private_evidence,target_versions,dependency_ids,source_generation,batch_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [draft, owner, contact, proposal.logical_skill_id, proposal.proposal_kind, proposal.strategy,
      { materials: batch.materials, existing_skills: batch.targets }, JSON.stringify(proposal.target_versions),
      batch.dependency_ids, batch.source_generation, `synthetic-review-${draft}`]);
    const before = await review.read(scope, draft);
    assert.equal(before.draft.status, 'pending');
    assert.equal(before.draft.revision, 1);
    assert.deepEqual(before.draft.target_versions, [{ skill_id: target.skill_id, version_id: target.version_id, version_number: 1 }]);

    // 仅用 localhost 传输适配，审批、来源核验与事务均为生产业务对象；不装配模型。
    server = createServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const result = await http.handle(request.method, new URL(request.url, 'http://127.0.0.1'),
          JSON.parse(Buffer.concat(chunks).toString()), new AbortController().signal);
        response.writeHead(result.status, { 'Content-Type': 'application/json', Connection: 'close' }).end(JSON.stringify(result.body));
      } catch { response.writeHead(500).end('{"error":"fixture_failed"}'); }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const approve = () => fetch(`http://127.0.0.1:${server.address().port}/api/contacts/${contact}/skill-learning/drafts/${draft}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5000),
      body: JSON.stringify({ expected_revision: 1, operation_key: randomUUID(), comparison_id: randomUUID(),
        scope: { kind: 'contact', contact_id: contact, scene: null }, confirmed: true, replacements_confirmed: true }),
    });
    const response = await approve();
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'not_found' });
    assert.deepEqual(await review.read(scope, draft), before);
    assert.deepEqual(await library.versions(owner, imported.skill_id), originalVersions);
    assert.deepEqual(await library.preview(owner, imported.skill_id), originalPreview);
    // 在已约定事务接缝注入未知回调错误；形似领域错误也不得公开其正文或伪装成 404。
    businessFault = Object.assign(new TypeError('synthetic-private-callback-details'), { code: 'not_found', status: 404 });
    const unknown = await approve();
    assert.equal(unknown.status, 500);
    assert.deepEqual(await unknown.json(), { error: 'internal_error' });
    businessFault = undefined;
    assert.deepEqual(await review.read(scope, draft), before);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await pool.end();
  }
});
