import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const root = process.env.NOTALONE_REVIEW_ROOT;
const require = createRequire(root + '/backend-ts/package.json');
const pg = require('pg');
const { pureTsFixture } = await import(pathToFileURL(root + '/backend-ts/test/pure-ts-runtime-fixture.mjs'));
const { HostStorage, HostStorageError } = await import(pathToFileURL(root + '/backend-ts/src/host-storage.ts'));
const { prepareDatabaseSchema } = await import(pathToFileURL(root + '/backend-ts/src/schema-prepare.ts'));

async function fixture(t) {
  const f = await pureTsFixture(t);
  const storage = await HostStorage.open({ envFilePath: f.directory + '/does-not-exist',
    migrationsDirectory: root + '/backend/database/migrations', environment: {
      NOTALONE_DISABLE_DOTENV: '1', NOTALONE_DATABASE_URL: `host=/tmp dbname=${f.client.database}`,
    } });
  t.after(() => storage.close());
  return { f, storage };
}

for (const shape of ['config', 'native_query', 'queued']) {
  test(`独立PG：${shape}超时回滚、驱动错误受控且原回调只通知一次`, { timeout: 20000 }, async t => {
    const { f, storage } = await fixture(t);
    let actual, native, callbacks = 0, nested = 0;
    await assert.rejects(storage.businessTransaction(async client => {
      await client.query('INSERT INTO owner(id,display_name) VALUES($1,$2)', [randomUUID(), '合成本人']);
      return new Promise((resolve, reject) => {
        const callback = (error, value) => { callbacks++; if (error) { native = error; reject(error); } else resolve(value); };
        const value = { toPostgres() { client.query('SELECT 1', error => { assert.ifError(error); nested++; }); return 'synthetic'; } };
        const config = { text: 'SELECT pg_sleep(0.08),$1::text', values: [value], query_timeout: 10, callback };
        if (shape === 'native_query') {
          const query = new pg.Query(config); query.query_timeout = 10;
          assert.equal(client.query(query), query);
        } else if (shape === 'queued') {
          client.query('SELECT pg_sleep(0.08)', error => assert.ifError(error));
          client.query({ text: 'SELECT 2', query_timeout: 10, callback });
        } else client.query(Object.freeze(config));
      });
    }), error => { actual = error; return true; });
    assert.ok(actual instanceof HostStorageError); assert.equal(actual.code, 'database_unavailable');
    assert.notEqual(actual, native); assert.equal(callbacks, 1);
    assert.equal(nested, shape === 'queued' ? 0 : 1);
    assert.equal((await f.client.query('SELECT count(*)::int AS n FROM owner')).rows[0].n, 0);
  });
}

test('独立PG：同名业务错误仍原样传播，不能按消息误归类驱动错误', { timeout: 20000 }, async t => {
  const { f, storage } = await fixture(t);
  const business = new Error('Query read timeout'); let actual;
  await assert.rejects(storage.businessTransaction(async client => {
    await client.query('INSERT INTO owner(id,display_name) VALUES($1,$2)', [randomUUID(), '合成本人']);
    throw business;
  }), error => { actual = error; return true; });
  assert.equal(actual, business);
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM owner')).rows[0].n, 0);
});
