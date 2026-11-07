import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, owner, record, report, restart} from './sqlite-clear-support.mjs';
import {SqliteHistoryRecertifyService} from '../src/history/sqlite/recertify.ts';

const continuity = 'same-source-instances-normal-use-v1';
const capabilities = Object.fromEntries([
  'programVersion', 'exactSchema', 'declaredLocalKey', 'automaticAllocation',
  'serverIdUniqueConstraint', 'statusColumn', 'statusSemantics', 'sourceLifecycle',
  'restartContinuity', 'recoveryMapping', 'snapshotBarrier', 'partitionCoverage', 'normalHistory',
].map(name => [name, 'supported']));

function channelFixture(checkedPartitions, durable) {
  const state = {inspectCalls: 0, pageCalls: 0, channels: 0};
  const physical = {
    protocol: 'private-history-v1',
    partitions: ['shard-a'], tables: [{partition: 'shard-a', instance: 'table-a'}],
    sourceGeneration: 'source-1', ...(checkedPartitions ? {checkedPartitions} : {}),
  };
  const create = () => {
    const loss = Promise.withResolvers();
    const target = {...physical, descriptor: `synthetic-fixed-snapshot-${++state.channels}`};
    return {
      guardSession: {loss: loss.promise},
      async inspect(scope) {
        state.inspectCalls++;
        return {...report, continuity,
          capabilities: {...capabilities, partitionGrowth: 'supported',
            ...(durable ? {incrementalTail: 'supported', durableIncremental: 'supported', durableHistory: 'supported'} : {})},
          accountKey: scope.accountKey, conversationKey: scope.conversationKey,
          sourceGeneration: scope.token.source_generation};
      },
      async target() { return structuredClone(target); },
      async page(_scope, fixed, cursor) {
        state.pageCalls++;
        return {target: fixed.descriptor, cursorIn: cursor, cursorOut: null,
          records: [record('shard-a', '1')], completedPartitions: ['shard-a'], exhausted: true,
          ...(durable ? {resumeCursor: 'synthetic-durable-tail'} : {})};
      },
      async tail(_scope, fixed, cursor) {
        return {target: fixed.descriptor, cursorIn: cursor, cursorOut: cursor, records: [], caughtUp: true};
      },
      async close() { loss.resolve(); },
    };
  };
  return {create, state};
}

// 回归捕获点：认证完成后持久化的支持档或目标若不能被正常重验接纳，
// 首次 synchronize 会新增围栏、无法续租和读取，此测试应失败。
for (const checkedPartitions of [undefined, ['shard-a'], ['shard-a', 'shard-b']]) for (const durable of [false, true]) {
  test(`正常来源重新认证完成后干净重启，首次同步自动重验且不新增围栏（checked=${checkedPartitions?.length ?? 0},durable=${durable}）`, async t => {
    const reader = channelFixture(checkedPartitions, durable);
    const f = await fixture(t, {channel: reader.create(), state: reader.state,
      registryModule: new URL('./fixtures/history/recertify-restart-registry.mjs', import.meta.url).href});
    const snapshot = () => f.current.storage.execute('fixture.recertifyRestartSnapshot',
      {ownerId: owner, contactId: f.contactA});
    await f.current.history.synchronize(f.contactA);
    const beforeRepair = await f.current.contacts.eligibility(f.contactA);
    await f.current.storage.execute('history.markContinuityLost', {token: beforeRepair});
    const service = new SqliteHistoryRecertifyService(f.current.storage, f.current.contacts,
      reader.create, f.current.holders, {stopHistory: id => f.current.history.stop(id)});
    t.after(() => service.close());
    const completed = await service.recertify(f.contactA, {requestKey: 'synthetic-recertify-restart'});
    assert.equal(completed.state, 'completed', JSON.stringify(completed));
    await service.close();
    const repaired = await snapshot();
    assert.equal(repaired.fences.length, 0);
    assert.equal(repaired.leases[0].state, 'lost');
    assert.equal(JSON.parse(repaired.operations[0].support_json).continuity, continuity);
    assert.deepEqual(JSON.parse(repaired.scopes[0].tables_json).checkedPartitions, checkedPartitions);

    f.channel = reader.create();
    await restart(f, t);
    const restarted = await snapshot();
    assert.notEqual(restarted.runtime.runtime_id, repaired.runtime.runtime_id);
    assert.equal(restarted.fences.length, 0);
    const token = await f.current.contacts.eligibility(f.contactA);
    assert.equal(await f.current.storage.execute('history.normalUseRevalidationCandidate', {token}), true,
      '真实认证写入的支持档和完整目标应允许重启后的元数据重验');
    const calls = {...reader.state};
    const result = await f.current.history.synchronize(f.contactA);
    const after = await snapshot();
    assert.equal(after.fences.length, 0, JSON.stringify({result, fences: after.fences,
      goalsBefore: restarted.goals.length, goalsAfter: after.goals.length,
      capturesBefore: restarted.captures.length, capturesAfter: after.captures.length}));
    assert.ok(reader.state.inspectCalls > calls.inspectCalls, '先用当前读取器重验来源元数据');
    assert.ok(reader.state.pageCalls > calls.pageCalls, '自动续读，无需再次手动修复同步');
    assert.equal(after.leases[0].runtime_id, after.runtime.runtime_id);
    assert.equal(after.leases[0].binding_id, repaired.leases[0].binding_id);
    assert.equal((await f.current.history.readChat(f.contactA)).messages.length, 1);
    assert.deepEqual(await f.current.storage.check(), {integrity: 'ok', foreignKeys: 'ok'});
  });
}
