/** 仅使用固定快照和本轮合成PG，核对Query错误归类及原生配置合同。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const root = process.env.REVIEW_SNAPSHOT;
const {default: pg} = await import(pathToFileURL(join(root, 'backend-ts/node_modules/pg/lib/index.js')));
const {HostStorage, HostStorageError} = await import(pathToFileURL(join(root, 'backend-ts/src/host-storage.ts')));
const {createStorageFixture} = await import(pathToFileURL(join(root, 'backend-ts/test/host-storage-fixture.mjs')));
async function fixture(t) {
  const pgFixture = await createStorageFixture();
  const storage = await HostStorage.open({...pgFixture.options, environment: {
    NOTALONE_DISABLE_DOTENV: '1', NOTALONE_DATABASE_URL: `host=/tmp dbname=${pgFixture.client.database}`,
  }});
  t.after(async () => {await storage.close(); await pgFixture.close();});
  return {storage, pgFixture};
}
const runQuery = (client, config) => new Promise((resolve, reject) => {
  config.callback = (error, result) => error ? reject(error) : resolve(result);
  client.query(config);
});

test('独立反例：Query实例的普通prepared错误必须受控且回滚', async t => {
  const {storage} = await fixture(t);
  await assert.rejects(storage.businessTransaction(async client => {
    await client.query('INSERT INTO owner(id,display_name) VALUES($1,$2)', [randomUUID(), '合成回滚本人']);
    await client.query({name: 'synthetic_spec_statement', text: 'SELECT 1'});
    return new Promise((resolve, reject) => {
      const query = new pg.Query({name: 'synthetic_spec_statement', text: 'SELECT 2'});
      query.once('error', reject);
      query.once('end', resolve);
      assert.equal(client.query(query), query);
    });
  }), error => error instanceof HostStorageError && error.code === 'database_unavailable');
  assert.equal((await storage.setupStatus()).owner_configured, false);
});

test('成功配置回调必须保留合法的继承和非枚举查询字段', async t => {
  const {storage} = await fixture(t);
  const inherited = Object.create({text: 'SELECT $1::integer AS value', values: [17]});
  const hidden = {};
  Object.defineProperties(hidden, {
    text: {value: 'SELECT $1::integer AS value'}, values: {value: [17]},
  });
  for (const config of [inherited, hidden]) {
    const result = await storage.businessTransaction(client => runQuery(client, config));
    assert.deepEqual(result.rows, [{value: 17}]);
  }
});

test('Query成功后的普通业务Error保留同一对象并回滚', async t => {
  const {storage} = await fixture(t);
  const original = Object.assign(new Error('synthetic-business-error'), {code: '42P01'});
  await assert.rejects(storage.businessTransaction(async client => {
    await client.query('INSERT INTO owner(id,display_name) VALUES($1,$2)', [randomUUID(), '合成普通业务异常']);
    await new Promise((resolve, reject) => {
      const query = new pg.Query('SELECT 7 AS value', (error, result) => error ? reject(error) : resolve(result));
      assert.equal(client.query(query), query);
    });
    throw original;
  }), error => error === original);
  assert.equal((await storage.setupStatus()).owner_configured, false);
});
