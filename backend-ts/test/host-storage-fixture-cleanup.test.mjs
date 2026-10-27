import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createStorageFixture } from './host-storage-fixture.mjs';

test('隔离夹具在事务已中止时仍关闭连接并删除自己的随机库', async t=>{
  const fixture=await createStorageFixture();
  const database=(await fixture.client.query('SELECT current_database() AS name')).rows[0].name;
  const observed={};
  let admin;
  try {
    await fixture.client.query('BEGIN');
    await assert.rejects(fixture.client.query('SELECT 1/0'),{code:'22012'});
    try { await fixture.close(); observed.closed=true; }
    catch(error) { observed.close_code=error.code; throw error; }
    admin=new pg.Client({host:'/tmp',database:'postgres'});await admin.connect();
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM pg_database WHERE datname=$1',[database])).rows[0].n,0);
  } finally {
    await fixture.client.query('ROLLBACK').catch(()=>{});
    await fixture.close();
    await admin?.end();
    t.diagnostic('隔离夹具关闭观测 '+JSON.stringify(observed));
  }
});
