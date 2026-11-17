import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { DeletionService } from '../src/storage/sqlite/deletion/service.ts';
import { ActiveHolders } from '../src/storage/sqlite/deletion/holders.ts';
import { ManagedFiles } from '../src/storage/sqlite/deletion/managed-files.ts';
import { StorageFailure } from '../src/storage/sqlite/contracts.ts';

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

const requestB = { ownerId: 'o', requestKey: 'delete-contact-b', scope: { kind: 'contact', contactId: 'b' } };
function countCompactions(storage) {
  const counter = { n: 0 };
  const execute = storage.execute.bind(storage);
  storage.execute = (name, ...rest) => { if (name === 'deletion.compact') counter.n++; return execute(name, ...rest); };
  return counter;
}

test('批量推进：多个联系人删除只压缩一次，且每个操作都在压缩后核验结案', async t => {
  const f = await fixture(t, 0);
  await f.storage.execute('sample.seed', {});
  const service = f.service();
  const a = await service.plan(request), b = await service.plan(requestB);
  const compactions = countCompactions(f.storage);
  const [doneB, doneA] = await service.advanceBatch([b, a]);
  assert.deepEqual([doneB.operationId, doneA.operationId], [b.operationId, a.operationId], '返回顺序保持输入顺序');
  assert.equal(compactions.n, 1, '批量只做一次压缩');
  for (const done of [doneA, doneB]) {
    assert.equal(done.state, 'completed');
    assert.ok(done.completedAt);
    assert.equal(done.checks.find(check => check.kind === 'sqlite_pages_wal').result.proof, 'checkpoint_vacuum_verified');
    assert.equal(done.checks.find(check => check.kind === 'final_recheck').result.proof, 'closure_rechecked');
  }
  assert.deepEqual(await f.storage.execute('sample.read', {}), { bodies: [], ledger: 0n, generation: 2n });
  assert.deepEqual(await f.storage.check(), { integrity: 'ok', foreignKeys: 'ok' });
});

test('批量闭包扩展只重跑原操作，新清理之后重新压缩且旧runner被拒绝', async t => {
  const f = await fixture(t, 0);await f.storage.execute('sample.seed', {});
  const service = f.service(),op = await service.plan({...request, scope:{kind:'source',contactId:'a',sourceId:'r1'}});
  await f.storage.execute('sample.spawnOnClear', {});
  const execute = f.storage.execute.bind(f.storage),events = [];
  f.storage.execute = (name, input, ...rest) => {events.push({name,input});return execute(name,input,...rest);};
  const [done] = await service.advanceBatch([op]);assert.equal(done.state,'completed');
  const compactIndexes = events.flatMap((event,index)=>event.name==='deletion.compact'?[index]:[]);
  const verifies = events.filter(event=>event.name==='deletion.verify');
  assert.equal(compactIndexes.length,2);
  assert.deepEqual(verifies.map(event=>event.input.planRevision),[op.planRevision,op.planRevision+1n]);
  const newClear = events.findIndex(event=>event.name==='deletion.clearTarget'&&event.input.planRevision===op.planRevision+1n);
  assert.ok(newClear>events.indexOf(verifies[0])&&newClear<compactIndexes[1],'扩展闭包清除后才开始第二次压缩');
  await assert.rejects(f.storage.execute('deletion.recollect',verifies[0].input),{code:'deletion_stale_runner'});
  assert.deepEqual((await f.storage.execute('sample.read',{})).bodies,[]);
});

test('批量后续领取失败不压缩或结案早先操作，重开后按原顺序恢复', async t => {
  const f = await fixture(t,0);await f.storage.execute('sample.seed',{});
  const service=f.service(),a=await service.plan(request),b=await service.plan(requestB);
  await f.storage.execute('deletion.claim',b);
  const compactions=countCompactions(f.storage);
  await assert.rejects(service.advanceBatch([a,b]),{code:'deletion_busy'});
  assert.equal(compactions.n,0);
  for(const op of [a,b]){const status=await service.status(op);assert.equal(status.state,'cleaning');assert.equal(status.completedAt,null);}
  const sealed=await service.status(a);assert.deepEqual(kinds(sealed),['runtime_files','runtime_live_refs']);
  await f.reopen(0);
  const recovered=await f.service().advanceBatch([a,b]);
  assert.deepEqual(recovered.map(op=>[op.operationId,op.state]),[[a.operationId,'completed'],[b.operationId,'completed']]);
});

test('批量共用压缩失败逐个保留blocked，原任务重试后才结案', async t => {
  const f=await fixture(t,0);await f.storage.execute('sample.seed',{});
  const service=f.service(),a=await service.plan(request),b=await service.plan(requestB);
  const execute=f.storage.execute.bind(f.storage);let compactions=0;
  f.storage.execute=(name,...args)=>{if(name==='deletion.compact'){compactions++;return Promise.reject(new StorageFailure('synthetic_compact_failed'));}return execute(name,...args);};
  const blocked=await service.advanceBatch([b,a]);assert.equal(compactions,1);
  assert.deepEqual(blocked.map(op=>[op.operationId,op.state,op.completedAt]),[[b.operationId,'blocked',null],[a.operationId,'blocked',null]]);
  for(const op of blocked)assert.equal(op.checks.some(check=>check.kind==='sqlite_pages_wal'&&check.result.result==='passed'),false);
  assert.deepEqual((await execute('sample.read',{})).bodies,[],'维护失败不恢复已清除正文');
  f.storage.execute=execute;
  const done=await service.advanceBatch([b,a]);assert.deepEqual(done.map(op=>[op.operationId,op.state]),[[b.operationId,'completed'],[a.operationId,'completed']]);
});

test('批量推进：已结案的操作原样返回且不触发多余压缩', async t => {
  const f = await fixture(t, 0);
  await f.storage.execute('sample.seed', {});
  const service = f.service();
  const a = await service.plan(request);
  const first = await service.advance(a);
  assert.equal(first.state, 'completed');
  const compactions = countCompactions(f.storage);
  const [again] = await service.advanceBatch([a]);
  assert.equal(again.state, 'completed');
  assert.equal(again.completedAt, first.completedAt);
  assert.equal(compactions.n, 0);
});

test('批量推进：压缩中途Worker失效后重开，沿原任务再次批量推进即可全部结案', async t => {
  const f = await fixture(t, 1_500, { maintenanceTimeoutMs: 400 });
  await f.storage.execute('sample.seed', {});
  const a = await f.service().plan(request), b = await f.service().plan(requestB);
  await assert.rejects(f.service().advanceBatch([a, b]), { code: 'worker_failed' });
  assert.equal(f.storage.failureDiagnostic.action, 'deletion.compact');
  await f.reopen(0);
  for (const op of [a, b]) {
    const stuck = await f.service().status(op);
    assert.equal(stuck.state, 'cleaning');
    assert.equal(stuck.completedAt, null);
  }
  const compactions = countCompactions(f.storage);
  const done = await f.service().advanceBatch([a, b]);
  assert.deepEqual(done.map(op => op.state), ['completed', 'completed']);
  assert.equal(compactions.n, 1);
  assert.deepEqual(await f.storage.execute('sample.read', {}), { bodies: [], ledger: 0n, generation: 2n });
});
