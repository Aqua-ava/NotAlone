// 独立检查 owned client 观察器的范围、去重、成功与失败清理。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root = process.env.NOTALONE_REVIEW_FIXED_ROOT;
const require = createRequire(join(root, 'backend-ts/package.json'));
const pg = require('pg');
const load = path => import(pathToFileURL(join(root, path)).href);
const {pureTsFixture} = await load('backend-ts/test/pure-ts-runtime-fixture.mjs');
const {HostStorage} = await load('backend-ts/src/host-storage.ts');

async function fixture(t) {
  const f = await pureTsFixture(t);
  const storage = await HostStorage.open({envFilePath: join(f.directory, 'unused-config'),
    migrationsDirectory: join(root, 'backend/database/migrations'), environment: {
      NOTALONE_DISABLE_DOTENV: '1', NOTALONE_DATABASE_URL: `host=/tmp dbname=${f.client.connectionParameters.database}`,
    }});
  t.after(() => storage.close());
  return {f, storage};
}

test('原生队列重复唤醒只装饰一次，成功后恢复描述符且不改变全局原型', async t => {
  const {f, storage} = await fixture(t);
  const prototype = {pulse: pg.Client.prototype._pulseQueryQueue, query: pg.Client.prototype.query,
    handle: pg.Query.prototype.handleError};
  let q, callbackResult, callbackThis, savedDescriptor, seen;
  await storage.businessTransaction(async client => {
    assert.equal(Object.hasOwn(client, '_pulseQueryQueue'), true);
    assert.equal(Object.hasOwn(f.client, '_pulseQueryQueue'), false);
    const blocker = client.query('SELECT pg_sleep(0.03)');
    const values = [73];
    const complete = new Promise((resolve, reject) => {
      function callback(error, result) { callbackThis = this; callbackResult = result; error ? reject(error) : resolve(result); }
      q = new pg.Query({text: 'SELECT $1::int AS value', values}, callback);
      Object.defineProperty(q, 'handleError', {value: pg.Query.prototype.handleError,
        writable: true, configurable: true, enumerable: false});
      Object.defineProperty(q, 'callback', {value: callback, writable: false, configurable: false});
      savedDescriptor = Object.getOwnPropertyDescriptor(q, 'handleError');
      assert.equal(client.query(q), q);
      seen = q.handleError;
      assert.notEqual(seen, savedDescriptor.value);
      assert.equal(q.listenerCount('end'), 1);
      assert.equal(q.values, values);
    });
    const extra = Array.from({length: 5}, () => client.query('SELECT 1'));
    assert.equal(q.handleError, seen);
    assert.equal(q.listenerCount('end'), 1);
    const result = await complete;
    assert.equal(result, callbackResult);
    assert.equal(callbackThis, q);
    assert.deepEqual(result.rows, [{value: 73}]);
    await blocker; await Promise.all(extra);
  });
  assert.deepEqual(Object.getOwnPropertyDescriptor(q, 'handleError'), savedDescriptor);
  assert.equal(q.listenerCount('end'), 0);
  assert.equal(pg.Client.prototype._pulseQueryQueue, prototype.pulse);
  assert.equal(pg.Client.prototype.query, prototype.query);
  assert.equal(pg.Query.prototype.handleError, prototype.handle);
});

for (const mode of ['server-error', 'queued-timeout']) test(`${mode} 结束后删除实例观察器和 end 监听`, async t => {
  const {storage} = await fixture(t);
  let q, nativeError, calls = 0;
  await assert.rejects(storage.businessTransaction(async client => {
    if (mode === 'queued-timeout') void client.query('SELECT pg_sleep(0.03)');
    return new Promise((resolve, reject) => {
      q = new pg.Query(mode === 'server-error' ? 'SELECT * FROM synthetic_cleanup_missing' : 'SELECT 1',
        (error, result) => { calls++; nativeError = error; error ? reject(error) : resolve(result); });
      if (mode === 'queued-timeout') q.query_timeout = 1;
      assert.equal(Object.hasOwn(q, 'handleError'), false);
      client.query(q);
      assert.equal(Object.hasOwn(q, 'handleError'), true);
    });
  }), error => error.name === 'HostStorageError' && error.code === 'database_unavailable' && error !== nativeError);
  assert.equal(calls, 1);
  assert.equal(Object.hasOwn(q, 'handleError'), false);
  assert.equal(q.handleError, pg.Query.prototype.handleError);
  assert.equal(q.listenerCount('end'), 0);
});
