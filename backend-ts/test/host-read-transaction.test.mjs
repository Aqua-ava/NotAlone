import test from 'node:test';
import assert from 'node:assert/strict';
import { HostStorage } from '../src/host-storage.ts';
import { createStorageFixture } from './host-storage-fixture.mjs';

test('业务只读事务固定快照、拒绝写入且保留原结构资格门禁', async () => {
  const fixture = await createStorageFixture();
  const storage = await HostStorage.open(fixture.options);
  try {
    const owner = await storage.initializeOwner('合成原名称');
    await storage.businessReadTransaction(async client => {
      assert.equal((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
      const before = await client.query('SELECT display_name FROM public.owner WHERE id=$1', [owner.owner_id]);
      await fixture.client.query('UPDATE public.owner SET display_name=$1 WHERE id=$2', ['合成新名称', owner.owner_id]);
      assert.deepEqual((await client.query('SELECT display_name FROM public.owner WHERE id=$1', [owner.owner_id])).rows, before.rows);
    });
    await assert.rejects(storage.businessReadTransaction(client => client.query('DELETE FROM public.owner WHERE id=$1', [owner.owner_id])), { code: 'database_unavailable' });
    assert.equal((await fixture.client.query('SELECT display_name FROM public.owner WHERE id=$1', [owner.owner_id])).rows[0].display_name, '合成新名称');
    await fixture.client.query("UPDATE public.notalone_schema_migration SET checksum='changed' WHERE name='107_history_message_count_comment.sql'");
    let called = false;
    await assert.rejects(storage.businessReadTransaction(async () => { called = true; }), { code: 'migration_history_mismatch' });
    assert.equal(called, false);
  } finally { await storage.close(); await fixture.close(); }
});

test('宿主关闭等待在途只读事务收尾并拒绝后续读取', async () => {
  const fixture = await createStorageFixture();
  const storage = await HostStorage.open(fixture.options);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  try {
    const reading = storage.businessReadTransaction(async () => { entered(); await gate; });
    const rejected = assert.rejects(reading, { code: 'runtime_stopping' });
    await ready;
    let closed = false;
    const closing = storage.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false);
    release();
    await rejected;
    await closing;
    await assert.rejects(storage.businessReadTransaction(async () => {}), { code: 'runtime_stopping' });
  } finally { release(); await storage.close(); await fixture.close(); }
});

test('历史108中间缺口或绑定授权表缺失时不发布业务资格', async () => {
  const fixture = await createStorageFixture();
  const storage = await HostStorage.open(fixture.options);
  try {
    const original = (await fixture.client.query("DELETE FROM public.notalone_schema_migration WHERE name='108_wechat_binding_history_authorization.sql' RETURNING name,checksum")).rows[0];
    assert.deepEqual(await storage.compatibility(), { code: 'migration_history_mismatch' });
    await assert.rejects(storage.businessReadTransaction(async () => {}), { code: 'migration_history_mismatch' });
    await fixture.client.query('INSERT INTO public.notalone_schema_migration(name,checksum) VALUES($1,$2)', [original.name, original.checksum]);
    await fixture.client.query('ALTER TABLE public.wechat_binding_history_authorization RENAME COLUMN binding_id TO missing_binding_id');
    assert.deepEqual(await storage.compatibility(), { code: 'schema_incomplete' });
  } finally { await storage.close(); await fixture.close(); }
});
