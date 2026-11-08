import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageFailure } from '../src/storage/sqlite/contracts.ts';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { SqliteContactService } from '../src/contacts/sqlite/service.ts';
import { FirstHistoryCoordinator } from '../src/history/sqlite/coordinator.ts';
import { SqliteHistoryService } from '../src/history/sqlite/service.ts';
import { fixture, owner, record } from './fixtures/memory-sqlite/support.mjs';

const fileA = 'a'.repeat(64);
const fileB = 'b'.repeat(64);
const oldTarget = {
  protocol: 'private-history-v1', descriptor: 'target-v1', sourceGeneration: 'source-1',
  partitions: [fileA], tables: [{ partition: fileA, instance: 'table-v1' }], checkedPartitions: [fileA, fileB],
};
const grownTarget = {
  protocol: 'private-history-v1', descriptor: 'target-v2', sourceGeneration: 'source-1',
  partitions: [fileA, fileB], tables: [{ partition: fileA, instance: 'table-v1' }, { partition: fileB, instance: 'table-v2' }],
  checkedPartitions: [fileA, fileB],
};
const message = (id, partition, table) => record(id, { partition, table, kind: 'text', text: `合成${table}-${id}` });

function installGrowthChannel(f) {
  const state = { growing: false, resumed: false, pages: [], tails: [], resumes: [], wakeups: [], pageHook: null, tailHook: null };
  f.target.checkedPartitions = [...oldTarget.checkedPartitions];
  f.channel.guardSession = { loss: new Promise(() => {}) };
  const inspect = f.channel.inspect;
  f.channel.inspect = async scope => ({
    ...await inspect(scope),
    profileId: 'synthetic-v1', adapterVersion: '1',
    schemaFingerprint: state.growing ? 'd'.repeat(64) : 'b'.repeat(64),
    continuity: 'same-source-instances-normal-use-v1',
    capabilities: { incrementalTail: 'supported', durableIncremental: 'supported', partitionGrowth: 'supported' },
  });
  f.channel.target = async () => state.growing ? structuredClone(grownTarget) : structuredClone(oldTarget);
  f.channel.resumeTarget = async (_scope, previous, cursor) => {
    state.resumes.push({ previous: structuredClone(previous), cursor });
    state.resumed = state.growing?'growth':'same';
    return structuredClone(state.growing?grownTarget:oldTarget);
  };
  f.channel.page = async (scope, target, cursor) => {
    state.pages.push({ target: structuredClone(target), cursor });
    if (state.pageHook) return state.pageHook(scope, target, cursor);
    const records = state.resumed==='growth' ? [message('1', fileB, 'table-v2')] : state.resumed==='same' ? [] : [message('1', fileA, 'table-v1')];
    return { target: target.descriptor, cursorIn: cursor, cursorOut: null, records,
      completedPartitions: [...target.partitions], exhausted: true, resumeCursor: state.resumed==='growth' ? 'resume-v2' : 'resume-v1' };
  };
  f.channel.tail = async (scope, target, cursor) => {
    state.tails.push({ target: structuredClone(target), cursor });
    const page = state.tailHook ? await state.tailHook(scope, target, cursor) : { records: [], caughtUp: true, cursorOut: cursor };
    return { target: page.target ?? target.descriptor, cursorIn: page.cursorIn ?? cursor,
      cursorOut: page.cursorOut ?? 'tail-v2', records: page.records ?? [], caughtUp: page.caughtUp ?? false };
  };
  f.service.setFirstHistoryWake(contactId => state.wakeups.push(contactId));
  return state;
}

test('新增表目标尚无检查点就中断时，仍能从已核验旧分片的恢复点接续',async t=>{
 const f=await fixture(t),contactId=f.saved[0].contact_id,state=installGrowthChannel(f);
 await f.service.synchronize(contactId);state.growing=true;
 // 保留语义等价：非持久读取器不进入交接切片，新增表目标在租约边界交回首次历史；
 // 安全性质等“中断表达式”用进程重启覆盖：重启不得丢失已核验恢复点，仍以旧分片游标接续
 await f.service.synchronizeIncremental(contactId,undefined,{followHistoryHandoff:true});await f.service.close();
 const restarted=new SqliteHistoryService(f.storage,f.contacts,()=>f.channel);t.after(()=>restarted.close());
 const result=await restarted.synchronize(contactId);assert.equal(result.phase,'complete');
 assert.equal(state.resumes.length,2);assert.ok(state.resumes.every(row=>row.cursor==='resume-v1'));
 assert.deepEqual((await restarted.read(contactId)).messages.map(row=>row.text).sort(),['合成table-v1-1','合成table-v2-1']);
 await restarted.close();
});

test('已接受单分片历史遇到安全表增长时从原游标建立新目标，只收新表消息', async t => {
  const f = await fixture(t);
  const contactId = f.saved[0].contact_id;
  const state = installGrowthChannel(f);
  await f.service.synchronize(contactId);
  assert.deepEqual((await f.service.read(contactId)).messages.map(item => item.text), ['合成table-v1-1']);

  state.growing = true;
  // 保留语义等价：安全表增长的读取交回首次历史（定向唤醒），已核验旧分片恢复点保持；随后一轮必须从原游标建立新目标且只收新表消息
  const pending = await f.service.synchronizeIncremental(contactId,undefined,{followHistoryHandoff:true});
  assert.equal(pending.phase, 'running');
  assert.deepEqual(state.wakeups, [contactId]);
  assert.equal(state.resumes.length, 1);
  assert.equal(state.resumes[0].cursor, 'resume-v1');
  assert.deepEqual(state.resumes[0].previous.tables, oldTarget.tables);

  await f.service.synchronize(contactId);
  assert.deepEqual(state.pages.at(-1).target.tables, grownTarget.tables);
  const read = await f.service.read(contactId);
  assert.equal(read.coverage.phase, 'complete');
  assert.deepEqual(read.messages.map(item => item.text).sort(), ['合成table-v1-1', '合成table-v2-1'].sort());
  assert.equal(read.messages.length, 2, '同一 local ID 位于另一张表时仍是独立来源');
});

test('增量尾部发现安全表增长时不接受旧目标页并定向唤醒首次历史', async t => {
  const f = await fixture(t);
  const contactId = f.saved[0].contact_id;
  const state = installGrowthChannel(f);
  await f.service.synchronize(contactId);
  state.tailHook = async (_scope, target, cursor) => {
    state.growing = true;
    return { target: target.descriptor, cursorIn: cursor, cursorOut: 'tail-stale',
      records: [message('stale', fileA, 'table-v1')], caughtUp: false };
  };

  const interrupted = await f.service.synchronizeIncremental(contactId,undefined,{followHistoryHandoff:true});
  assert.equal(interrupted.incremental.failureCode, 'history_target_growth_required');
  assert.deepEqual(state.wakeups, [contactId]);
  assert.equal((await f.service.read(contactId)).messages.length, 1, '变化检测前返回的旧目标页不能入库');
  await f.service.synchronize(contactId);
  const read = await f.service.read(contactId);
  assert.equal(read.coverage.phase, 'complete');
  assert.deepEqual(read.messages.map(item => item.text).sort(), ['合成table-v1-1', '合成table-v2-1'].sort());
  assert.equal(state.resumes.at(-1).cursor, 'resume-v1');
});

test('历史分页中途安全表增长时保留最后接受游标并唤醒delta历史', async t => {
  const f = await fixture(t);
  const contactId = f.saved[0].contact_id;
  const state = installGrowthChannel(f);
  let pageNo = 0;
  state.pageHook = async (scope, target, cursor) => {
    pageNo++;
    if (state.resumed) return { target: target.descriptor, cursorIn: cursor, cursorOut: null,
      records: [message('1', fileB, 'table-v2')], completedPartitions: [...target.partitions], exhausted: true, resumeCursor: 'resume-v2' };
    if (pageNo === 1) return { target: target.descriptor, cursorIn: cursor, cursorOut: 'page-2',
      records: [message('1', fileA, 'table-v1')], completedPartitions: [], exhausted: false };
    state.growing = true;
    return { target: target.descriptor, cursorIn: cursor, cursorOut: null,
      records: [message('stale', fileA, 'table-v1')], completedPartitions: [...target.partitions], exhausted: true, resumeCursor: 'resume-stale' };
  };

  const interrupted = await f.service.synchronize(contactId);
  assert.equal(interrupted.failureCode, 'history_target_growth_required');
  assert.deepEqual(state.wakeups, [contactId]);
  assert.deepEqual((await f.service.read(contactId)).messages.map(item => item.text), ['合成table-v1-1']);
  await f.service.synchronize(contactId);
  const read = await f.service.read(contactId);
  assert.equal(read.coverage.phase, 'complete');
  assert.equal(state.resumes.at(-1).cursor, 'page-2');
  assert.deepEqual(read.messages.map(item => item.text).sort(), ['合成table-v1-1', '合成table-v2-1'].sort());
  assert.equal(read.messages.some(item => item.text.includes('stale')), false);
});

test('已证明的空目标出现首张表时建立新历史且不复用旧检查点', async t => {
  const f = await fixture(t);
  const contactId = f.saved[0].contact_id;
  const state = { growing: false, resumes: [] };
  const emptyTarget = { protocol: 'private-history-v1', descriptor: 'empty-v1', sourceGeneration: 'source-1',
    partitions: [fileA, fileB], tables: [], checkedPartitions: [fileA, fileB] };
  const firstTableTarget = { protocol: 'private-history-v1', descriptor: 'one-table-v2', sourceGeneration: 'source-1',
    partitions: [fileB], tables: [{ partition: fileB, instance: 'table-v2' }], checkedPartitions: [fileA, fileB] };
  const inspect = f.channel.inspect;
  f.channel.guardSession = { loss: new Promise(() => {}) };
  f.channel.inspect = async scope => {
    const report = await inspect(scope);
    return {
      ...report,
      profileId: state.growing ? 'wechat-4.0.6-29387-observed-states-v1' : 'wechat-4.0.6-29387-absent-private-target-v1',
      schemaFingerprint: state.growing ? 'e'.repeat(64) : 'b'.repeat(64),
      declaredPrimaryKey: state.growing ? ['local_id'] : [],
      statusSemantics: state.growing ? 'verified-message-state-v1' : 'no-message-table-v1',
      continuity: 'same-source-instances-normal-use-v1',
      capabilities: {
        durableIncremental: 'supported', incrementalTail: state.growing ? 'supported' : 'unsupported',
        partitionGrowth: 'supported', normalHistory: 'supported', snapshotBarrier: 'supported',
        partitionCoverage: 'supported', sourceLifecycle: 'supported', restartContinuity: 'supported', recoveryMapping: 'supported',
      },
    };
  };
  f.channel.target = async () => structuredClone(state.growing ? firstTableTarget : emptyTarget);
  f.channel.resumeTarget = async (_scope, target, cursor) => { state.resumes.push({ target, cursor }); return null; };
  f.channel.page = async (_scope, target, cursor) => ({ target: target.descriptor, cursorIn: cursor, cursorOut: null,
    records: state.growing ? [message('3', fileB, 'table-v2')] : [], completedPartitions: [...target.partitions], exhausted: true });

  await f.service.synchronize(contactId);
  assert.equal((await f.service.coverage(contactId)).phase, 'complete');
  state.growing = true;
  await f.service.synchronize(contactId);
  assert.equal(state.resumes.length, 0, '空目标没有可安全复用的历史游标');
  const read = await f.service.read(contactId);
  assert.deepEqual(read.messages.map(item => item.text), ['合成table-v2-3'], JSON.stringify(read.coverage));
  const scope = await f.storage.execute('history.preflightGeneration', { token: await f.contacts.eligibility(contactId) });
  assert.equal(scope, true, '已认证空目标扩展不应建立连续性围栏');
});

test('进程重开后按旧已接受游标复验安全表增长', async t => {
  const f = await fixture(t);
  const contactId = f.saved[0].contact_id;
  const state = installGrowthChannel(f);
  await f.service.synchronize(contactId);
  const databaseId = f.storage.status.databaseId;
  await f.service.close();
  await f.storage.close();

  const storage = await SqliteStorage.open({ userData: f.root, intent: 'open', role: 'test', expectedDatabaseId: databaseId });
  const contacts = new SqliteContactService(storage, owner, {
    account: async () => ({ externalKey: 'synthetic-account', identityScheme: 'wechat.account.v1', sourceGeneration: 'source-1', assurance: 'verified', supportProfile: 'synthetic-metadata-v1' }),
    sessions: async () => [],
  });
  await contacts.initialize();
  const service = new SqliteHistoryService(storage, contacts, () => f.channel);
  t.after(async () => { await service.close(); await contacts.close(); await storage.close(); });

  state.growing = true;
  await service.synchronize(contactId);
  const read = await service.read(contactId);
  assert.equal(read.coverage.phase, 'complete');
  assert.equal(state.resumes.length, 1);
  assert.equal(state.resumes[0].cursor, 'resume-v1');
  assert.deepEqual(read.messages.map(item => item.text).sort(), ['合成table-v1-1', '合成table-v2-1'].sort());
  await service.close(); await contacts.close(); await storage.close();
});

test('安全表增长候选中旧表被替换时仍建立连续性围栏', async t => {
  const f = await fixture(t);
  const contactId = f.saved[0].contact_id;
  const state = installGrowthChannel(f);
  await f.service.synchronize(contactId);
  const replacedTarget = { ...structuredClone(grownTarget), tables: [
    { partition: fileA, instance: 'table-replaced' }, { partition: fileB, instance: 'table-v2' },
  ] };
  f.channel.resumeTarget = async () => { state.resumed = true; return replacedTarget; };
  state.growing = true;

  await assert.rejects(f.service.synchronizeIncremental(contactId), { code: 'history_source_continuity_unverified' });
  assert.equal(await f.storage.execute('history.preflightGeneration', { token: await f.contacts.eligibility(contactId) }), false);
  assert.equal((await f.service.read(contactId)).messages.length, 1, '新表消息不能入库到已围栏联系人');
});

test('首次协调器在生产历史分页发现增长后自动接住服务finally的定点唤醒',async t=>{
 const cleanup=[],f=await fixture({after:callback=>cleanup.push(callback)}),contactId=f.saved[0].contact_id,state=installGrowthChannel(f);
 const directory={directory:async()=>{const saved=await f.contacts.syncDirectory();return {...saved,bindings:saved.bindings.filter(row=>row.contact_id===contactId)};}};
 const first=new FirstHistoryCoordinator(directory,f.service);f.service.setFirstHistoryWake(id=>{state.wakeups.push(id);first.wakeContact(id);});
 t.after(async()=>{await first.close();for(const clean of cleanup.reverse())await clean();});
 state.pageHook=async(_scope,target,cursor)=>{state.growing=true;state.pageHook=null;return {target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[],completedPartitions:target.partitions,exhausted:true,resumeCursor:'synthetic-before-growth'};};
 first.wake();await first.waitForIdle();
 assert.equal(state.wakeups.length,1);assert.equal((await f.service.coverage(contactId)).phase,'complete','服务在本次任务finally发出的真实增长唤醒必须接续');
 assert.equal(state.pages.length,2,'新目标完成后不得继续重复读取');
});
