import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { DeletionService } from '../src/storage/sqlite/deletion/service.ts';
import { ActiveHolders } from '../src/storage/sqlite/deletion/holders.ts';
import { ManagedFiles } from '../src/storage/sqlite/deletion/managed-files.ts';

// 隔离合成库：联系人 a 的资料要被删除，联系人 b 的跨联系人贡献必须保留。
const registryModule = new URL('./fixtures/sqlite/deletion-slow-compact-registry.mjs', import.meta.url).href;
async function fixture(t, delayMs, extra = {}) {
  const userData = await realpath(await mkdtemp(join(tmpdir(), 'notalone-delete-compaction-')));
  process.env.NOTALONE_TEST_COMPACT_DELAY_MS = String(delayMs);
  t.after(async () => { delete process.env.NOTALONE_TEST_COMPACT_DELAY_MS; await handle.storage?.close().catch(() => {}); await rm(userData, { recursive: true, force: true }); });
  const handle = { userData, storage: await SqliteStorage.open({ userData, intent: 'create', role: 'test', registryModule, ...extra }) };
  handle.service = () => new DeletionService(handle.storage, new ActiveHolders(), new ManagedFiles(userData), { drainTimeoutMs: 100 });
  handle.reopen = async (delay, options = {}) => {
    const id = handle.storage.status.databaseId;
    await handle.storage.close().catch(() => {});
    process.env.NOTALONE_TEST_COMPACT_DELAY_MS = String(delay);
    handle.storage = await SqliteStorage.open({ userData, intent: 'open', expectedDatabaseId: id, role: 'test', registryModule, ...options });
  };
  return handle;
}
const request = { ownerId: 'o', requestKey: 'delete-contact-a', scope: { kind: 'contact', contactId: 'a' } };
const survivors = { bodies: [{ body: '合成本人跨联系人贡献', eligible: 1n }], ledger: 0n, generation: 1n };
const kinds = op => op.checks.map(check => check.kind).sort();

test('压缩超过普通15秒预算：仍记录完整核验并结案，联系人范围数据保持清除', async t => {
  const f = await fixture(t, 16_000);
  await f.storage.execute('sample.seed', {});
  const op = await f.service().plan(request);
  const done = await f.service().advance(op);
  assert.equal(done.state, 'completed');
  assert.ok(done.completedAt, '结案必须记录完成时间');
  assert.equal(done.checks.find(check => check.kind === 'sqlite_pages_wal').result.proof, 'checkpoint_vacuum_verified');
  assert.equal(done.checks.find(check => check.kind === 'final_recheck').result.proof, 'closure_rechecked');
  assert.ok(kinds(done).includes('runtime_files') && kinds(done).includes('runtime_live_refs'));
  assert.deepEqual(await f.storage.execute('sample.read', {}), survivors);
  assert.equal(f.storage.failureDiagnostic, null);
  assert.deepEqual(await f.storage.check(), { integrity: 'ok', foreignKeys: 'ok' });
});

test('压缩中途存储Worker失效后：任务停在清理态，重开后沿原任务重试并完成核验', async t => {
  // 维护预算压到 400ms，模拟旧缺陷：压缩期间 Worker 被监督定时器关闭。
  const f = await fixture(t, 1_500, { maintenanceTimeoutMs: 400 });
  await f.storage.execute('sample.seed', {});
  const op = await f.service().plan(request);
  await assert.rejects(f.service().advance(op), { code: 'worker_failed' });
  assert.equal(f.storage.failureDiagnostic.cause, 'action_timeout');
  assert.equal(f.storage.failureDiagnostic.action, 'deletion.compact');
  // 失败现场：没有 verify 阶段记录，也没有结案。
  await f.reopen(0);
  const stuck = await f.service().status(op);
  assert.equal(stuck.state, 'cleaning');
  assert.equal(stuck.completedAt, null);
  assert.deepEqual(kinds(stuck), ['runtime_files', 'runtime_live_refs']);
  // 已清除的数据没有因失败而恢复。
  assert.deepEqual(await f.storage.execute('sample.read', {}), survivors);
  // 同一任务重试：幂等，补齐核验并结案；再次推进不产生新状态。
  const retried = await f.service().advance(op);
  assert.equal(retried.state, 'completed');
  assert.equal(retried.checks.find(check => check.kind === 'sqlite_pages_wal').result.result, 'passed');
  assert.deepEqual(await f.storage.execute('sample.read', {}), survivors);
  const again = await f.service().advance(op);
  assert.equal(again.state, 'completed');
  assert.equal(again.completedAt, retried.completedAt);
});
