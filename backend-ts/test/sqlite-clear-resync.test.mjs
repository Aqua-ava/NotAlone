import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareBoundaryCandidate } from '../src/history/sqlite/boundary.ts';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { SqliteContactService } from '../src/contacts/sqlite/service.ts';
import { owner, fixture, restart, identity, identities, record, buildCandidate, createChannel, waitFor, target } from './sqlite-clear-support.mjs';

const ids = (...values) => values.map(value => value.split('/'));
const allIdentities = [identity('shard-a', '1'), identity('shard-a', '2'), identity('shard-b', '3'), identity('shard-b', '4')];

test('清空覆盖该联系人全部已存消息/来源/目标并保留联系人与同步选择，05操作完成且不读正文', async t => {
  const f = await fixture(t);
  const { history, clear, storage, contacts, deletion } = f.current;
  f.state.pageRecords = [record('shard-a', '1'), record('shard-a', '2', { kind: 'voice', text: null }),
    record('shard-b', '3'), record('shard-b', '4')];
  f.state.boundaryMembers = allIdentities;
  await history.synchronize(f.contactA);
  await history.synchronize(f.contactB);
  const beforeDirectory = await contacts.directory();
  const beforeA = beforeDirectory.contacts.find(row => row.contact_id === f.contactA);
  const pagesBeforeClear = f.state.pageCalls;
  const status = await clear.clear(f.contactA);
  assert.equal(status.phase, 'completed');
  assert.equal(status.completed, true);
  assert.equal(status.boundary.state, 'verified');
  assert.equal(status.boundary.memberCount, 4);
  assert.match(status.boundary.manifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(f.state.pageCalls, pagesBeforeClear, '清空边界不得读取旧正文/媒体页');
  assert.equal((await history.read(f.contactA)).messages.length, 0);
  assert.equal((await history.read(f.contactA)).coverage.phase, 'not_started');
  assert.equal((await history.read(f.contactB)).messages.length, 4, '其他联系人消息保持');
  const afterDirectory = await contacts.directory();
  const afterA = afterDirectory.contacts.find(row => row.contact_id === f.contactA);
  assert.ok(afterA, '清空保留联系人');
  assert.equal(afterA.selection_generation, beforeA.selection_generation, '清空不改变同步选择代次');
  assert.equal(afterDirectory.read_enabled, true);
  assert.equal(afterDirectory.bindings.find(row => row.contact_id === f.contactA).status, 'active');
  const operation = await deletion.status({ ownerId: owner, operationId: status.operationId });
  assert.equal(operation.state, 'completed');
  assert.ok(operation.checks.length > 0);
  assert.ok(operation.checks.every(check => check.result !== 'blocked'), JSON.stringify(operation.checks));
  assert.deepEqual(await storage.check(), { integrity: 'ok', foreignKeys: 'ok' });
});

test('S(B)覆盖本机已有而应用从未读过的旧页；旧页迟到只能按身份排除，B后合法新消息进入新资格', async t => {
  const f = await fixture(t);
  const { history, clear } = f.current;
  f.state.pageRecords = [record('shard-a', '1'), record('shard-a', '2')];
  f.state.boundaryMembers = identities([['shard-a', '1'], ['shard-a', '2'], ['shard-b', '3'], ['shard-b', '4'], ['shard-a', '5']]);
  await history.synchronize(f.contactA);
  assert.equal((await history.read(f.contactA)).messages.length, 2);
  const status = await clear.clear(f.contactA);
  assert.equal(status.completed, true);
  assert.equal(status.boundary.memberCount, 5, '边界集合包含从未读入的旧页');
  // 清空后重新读取：旧页全部按身份排除，只有 B 之后的新消息进入。
  f.state.pageRecords = [record('shard-b', '4'), record('shard-a', '1'), record('shard-a', '6'),
    record('shard-b', '3'), record('shard-a', '2'), record('shard-a', '5')];
  const coverage = await history.synchronize(f.contactA);
  assert.equal(coverage.phase, 'complete');
  const read = await history.read(f.contactA);
  assert.equal(read.messages.length, 1, '只有边界后的新消息进入');
  assert.equal(read.messages[0].text, '合成正文6');
  assert.equal(read.replyEligibility, 'ready');
  const diagnostics = await clear.statusOf(f.contactA);
  assert.equal(diagnostics.boundary.memberCount, 5);
  f.state.pageRecords = [record('shard-a', '1'), record('shard-a', '2'), record('shard-b', '3'), record('shard-b', '4'), record('shard-a', '5')];
  await history.synchronize(f.contactA);
  const afterLateRead = await history.read(f.contactA);
  assert.deepEqual(afterLateRead.messages.map(message => message.text), ['合成正文6'], '旧历史读取不得复活已清空内容');
  assert.equal(afterLateRead.coverage.phase, 'complete');
});

test('分段候选在原子接受前不生效；中断后保持boundary_pending并可沿用同一barrier续做', async t => {
  const f = await fixture(t);
  const { storage, contacts, deletion, clear } = f.current;
  const channel = f.channel;
  f.state.pageRecords = [record('shard-a', '1'), record('shard-a', '2')];
  f.state.boundaryMembers = allIdentities;
  await f.current.history.synchronize(f.contactA);
  const plan = await deletion.plan({ ownerId: owner, requestKey: 'synthetic-clear-interrupt', scope: { kind: 'contact_history', contactId: f.contactA } });
  const begin = await storage.execute('history.clearBegin', { ownerId: owner, contactId: f.contactA, operationId: plan.operationId, at: Date.now() });
  assert.equal(begin.state, 'pending');
  const token = await contacts.eligibility(f.contactA);
  const scope = await storage.execute('history.scope', { token });
  const prepared = prepareBoundaryCandidate(scope, buildCandidate(scope, f.state.boundaryMembers));
  await storage.execute('history.boundaryPersist', { ownerId: owner, operationId: plan.operationId, contactId: f.contactA,
    barrierGeneration: begin.barrierGeneration, accountKey: scope.accountKey, conversationKey: scope.conversationKey, prepared });
  const pending = await storage.execute('history.cutoffStatus', { ownerId: owner, operationId: plan.operationId });
  assert.equal(pending.state, 'pending');
  assert.equal(pending.memberCount, 4);
  // 候选持久化但未接受：history.begin 仍被旧写入屏障拒绝，候选成员不能提前当正式排除。
  const fixed = await channel.target(scope);
  const support = await channel.inspect(scope);
  await assert.rejects(storage.execute('history.begin', { token, target: fixed, report: support, id: crypto.randomUUID(), at: Date.now() }),
    { code: 'history_suppression_unverified' });
  const restarted = await restart(f, t);
  const pendingStatus = await restarted.clear.statusOf(f.contactA);
  assert.equal(pendingStatus.phase, 'boundary_pending');
  assert.equal(pendingStatus.completed, false);
  assert.equal((await restarted.storage.execute('history.cutoffStatus', { ownerId: owner, operationId: plan.operationId })).state, 'pending');
  const resumed = await restarted.clear.clear(f.contactA);
  assert.equal(resumed.phase, 'completed');
  assert.equal(resumed.boundary.barrierGeneration, begin.barrierGeneration, '重试不得后移/前移已分配的代次');
  assert.equal((await restarted.storage.execute('history.cutoffStatus', { ownerId: owner, operationId: plan.operationId })).state, 'verified');
});

test('获取窗口变化仅接受前有界重试；实例或命名空间不连续立即失效', async t => {
  const retrying = await fixture(t);
  retrying.state.pageRecords = [record('shard-a', '1'), record('shard-a', '2')];
  retrying.state.boundaryMembers = allIdentities;
  retrying.state.boundaryFactory = (scope, state) => buildCandidate(scope, retrying.state.boundaryMembers,
    state.boundaryCalls < 3 ? { samples: { 'shard-a': { pre: 'window-a', post: 'window-b' } } } : {});
  await retrying.current.history.synchronize(retrying.contactA);
  const retried = await retrying.current.clear.clear(retrying.contactA);
  assert.equal(retrying.state.boundaryCalls, 3, '窗口变化在有界次数内重试');
  assert.equal(retried.phase, 'completed');

  const failed = await fixture(t);
  failed.state.pageRecords = [record('shard-a', '1')];
  failed.state.boundaryMembers = [identity('shard-a', '1')];
  failed.state.boundaryFactory = scope => buildCandidate(scope, failed.state.boundaryMembers,
    { samples: { 'shard-a': { pre: 'window-a', post: 'window-b' } } });
  await failed.current.history.synchronize(failed.contactA);
  const failedClear = await failed.current.clear.clear(failed.contactA);
  assert.equal(failed.state.boundaryCalls, 3, '始终变化只重试有界次数');
  assert.equal(failedClear.phase, 'boundary_pending');
  assert.equal(failedClear.completed, false);
  assert.equal(failedClear.boundaryReason, 'history_boundary_window_changed');
  assert.equal(failedClear.storedMessages, 0, '缺边界仍清理已保存资料');
  await assert.rejects(failed.current.history.synchronize(failed.contactA), { code: 'history_suppression_unverified' });

  for (const [label, options, reason] of [
    ['实例替换', { instanceContinuity: false }, 'history_boundary_instance_changed'],
    ['命名空间不连续', { namespaceContinuity: false }, 'history_boundary_namespace_changed'],
  ]) {
    const f = await fixture(t);
    f.state.pageRecords = [record('shard-a', '1')];
    f.state.boundaryMembers = [identity('shard-a', '1')];
    f.state.boundaryFactory = scope => buildCandidate(scope, f.state.boundaryMembers, options);
    await f.current.history.synchronize(f.contactA);
    const status = await f.current.clear.clear(f.contactA);
    assert.equal(f.state.boundaryCalls, 1, `${label}不得重试`);
    assert.equal(status.phase, 'boundary_pending');
    assert.equal(status.boundaryReason, reason);
  }
});

test('关闭读取或撤销后不为边界偷读元数据，缺边界明确boundary_pending且不显示成功', async t => {
  const f = await fixture(t);
  f.state.pageRecords = [record('shard-a', '1')];
  f.state.boundaryMembers = [identity('shard-a', '1')];
  await f.current.history.synchronize(f.contactA);
  await f.current.contacts.setReading(false);
  const disabled = await f.current.clear.clear(f.contactA);
  assert.equal(f.state.boundaryCalls, 0, '关闭总开关后不得读取渠道元数据');
  assert.equal(disabled.phase, 'boundary_pending');
  assert.equal(disabled.completed, false);
  assert.equal(disabled.boundaryReason, 'read_not_authorized');
  assert.equal(disabled.storedMessages, 0);
  await f.current.contacts.setReading(true);
  const resumed = await f.current.clear.clear(f.contactA);
  assert.equal(resumed.phase, 'completed', '重新允许读取后同一操作可完成');

  const revoked = await fixture(t);
  revoked.state.pageRecords = [record('shard-a', '1')];
  revoked.state.boundaryMembers = [identity('shard-a', '1')];
  await revoked.current.history.synchronize(revoked.contactA);
  const binding = revoked.saved.find(row => row.contact_id === revoked.contactA);
  await revoked.current.contacts.revoke(revoked.contactA, binding.binding_id, binding.selection_generation);
  const revokedStatus = await revoked.current.clear.clear(revoked.contactA);
  assert.equal(revoked.state.boundaryCalls, 0);
  assert.equal(revokedStatus.phase, 'boundary_pending');
  assert.equal(revokedStatus.completed, false);

  const racing = await fixture(t);
  racing.state.pageRecords = [record('shard-a', '1')];
  racing.state.boundaryMembers = [identity('shard-a', '1')];
  await racing.current.history.synchronize(racing.contactA);
  const raceBinding = racing.saved.find(row => row.contact_id === racing.contactA);
  racing.state.boundaryHook = async () => {
    await racing.current.contacts.revoke(racing.contactA, raceBinding.binding_id, raceBinding.selection_generation);
  };
  const raceStatus = await racing.current.clear.clear(racing.contactA);
  assert.equal(racing.state.boundaryCalls, 1);
  assert.equal(raceStatus.phase, 'boundary_pending');
  assert.ok(['read_eligibility_stale', 'read_not_authorized'].includes(raceStatus.boundaryReason), `分段后复验撤销并拒绝接受，实际 ${raceStatus.boundaryReason}`);
  assert.equal(raceStatus.completed, false);
});

test('清空期间在途旧页被05排空，迟到页不能提交；普通暂停小批规则不放行旧写入', async t => {
  const f = await fixture(t);
  const { history, clear } = f.current;
  f.state.pageRecords = [record('shard-a', '1'), record('shard-a', '2')];
  f.state.boundaryMembers = allIdentities;
  await history.synchronize(f.contactA);
  let releasePage;
  const pageGate = new Promise(resolve => { releasePage = resolve; });
  let entered;
  const pageEntered = new Promise(resolve => { entered = resolve; });
  f.state.pageHook = async () => { entered(); await pageGate; };
  const inflight = history.synchronize(f.contactA);
  inflight.catch(() => {});
  await pageEntered;
  const clearRun = clear.clear(f.contactA);
  await waitFor(() => f.state.boundaryCalls > 0, '清空进入边界阶段');
  f.state.pageHook = null;
  releasePage();
  const [writeResult, clearStatus] = await Promise.all([
    inflight.then(coverage => ({ coverage }), error => ({ error })),
    clearRun,
  ]);
  assert.ok(writeResult.error, '清空代次变化后旧在途页不能提交或完成');
  assert.equal(['read_eligibility_stale', 'history_interrupted', 'read_not_authorized'].includes(writeResult.error.code), true,
    `迟到写入必须按旧资格拒绝，实际 ${writeResult.error.code}`);
  assert.equal(clearStatus.phase, 'completed');
  f.state.pageRecords = [record('shard-a', '6')];
  const coverage = await history.synchronize(f.contactA);
  assert.equal(coverage.phase, 'complete');
  assert.deepEqual((await history.read(f.contactA)).messages.map(message => message.text), ['合成正文6']);
});

test('显式重读创建全新授权与来源、幂等处理重叠消息，且不解除来源删除排除', async t => {
  const f = await fixture(t);
  const { history, clear, resync, deletion, contacts, storage } = f.current;
  f.state.pageRecords = [record('shard-a', '1'), record('shard-a', '2'), record('shard-b', '3')];
  f.state.boundaryMembers = identities([['shard-a', '1'], ['shard-a', '2'], ['shard-b', '3']]);
  await history.synchronize(f.contactA);
  // 先单独删除一条来源，形成持久来源排除；清空与重读都不能复活它。
  const read = await history.read(f.contactA);
  const removed = read.messages.find(message => message.text === '合成正文2');
  const removedSource = removed.sourceRecordIds[0];
  const sourcePlan = await deletion.plan({ ownerId: owner, requestKey: 'synthetic-source-delete', scope: { kind: 'source', contactId: f.contactA, sourceId: removedSource } });
  assert.equal((await deletion.advance(sourcePlan)).state, 'completed');
  assert.equal((await history.read(f.contactA)).messages.length, 2);
  // 清空后自动同步只按 B 排除；显式重读才恢复清空前的本机可读历史。
  const cleared = await clear.clear(f.contactA);
  assert.equal(cleared.phase, 'completed');
  const grantBefore = await contacts.eligibility(f.contactA);
  const covered = await history.synchronize(f.contactA);
  assert.equal(covered.phase, 'complete');
  assert.equal((await history.read(f.contactA)).messages.length, 0);
  const restored = await resync.resync(f.contactA, { requestKey: 'explicit-resync-1' });
  assert.equal(restored.state, 'completed');
  assert.equal(restored.completed, true);
  const after = await history.read(f.contactA);
  assert.deepEqual(after.messages.map(message => message.text).sort(), ['合成正文1', '合成正文3'], '来源删除排除仍保持，重叠消息幂等去重');
  const grantAfter = await contacts.eligibility(f.contactA);
  assert.notEqual(grantAfter.grant_id, grantBefore.grant_id, '显式重读建立独立新许可');
  assert.notEqual(grantAfter.verification_id, grantBefore.verification_id, '显式重读建立新的身份核验');
  assert.equal(grantAfter.barrier_generation, grantBefore.barrier_generation, '重读不移动已接受 B');
  const pagesAfterRestore = f.state.pageCalls;
  const repeated = await resync.resync(f.contactA, { requestKey: 'explicit-resync-1' });
  assert.equal(repeated.state, 'completed');
  assert.equal(f.state.pageCalls, pagesAfterRestore, '同一请求键幂等，不重新读取');
  assert.equal((await history.read(f.contactA)).messages.length, 2);
  assert.deepEqual(await storage.check(), { integrity: 'ok', foreignKeys: 'ok' });
});

test('普通重启/重选/后台重试不解除历史抑制；显式重读只由明确操作触发', async t => {
  const f = await fixture(t);
  f.state.pageRecords = [record('shard-a', '1'), record('shard-a', '2')];
  f.state.boundaryMembers = allIdentities;
  await f.current.history.synchronize(f.contactA);
  const cleared = await f.current.clear.clear(f.contactA);
  assert.equal(cleared.phase, 'completed');
  let current = await restart(f, t);
  f.state.pageRecords = [record('shard-a', '1'), record('shard-a', '2'), record('shard-b', '3')];
  await current.history.synchronize(f.contactA);
  await current.history.synchronize(f.contactA);
  assert.equal((await current.history.read(f.contactA)).messages.length, 0, '普通重启重试不恢复旧历史');
  await current.contacts.setReading(false);
  await current.contacts.setReading(true);
  await current.history.synchronize(f.contactA);
  assert.equal((await current.history.read(f.contactA)).messages.length, 0, '重选不解除抑制');
  const restored = await current.resync.resync(f.contactA, { requestKey: 'explicit-resync-after-restart' });
  assert.equal(restored.state, 'completed');
  assert.equal((await current.history.read(f.contactA)).messages.length, 3);
});

test('已接受B后重启只沿用固定切面：不清边界、不后移，清理已完成且迟页仍拒绝', async t => {
  const f = await fixture(t);
  f.state.pageRecords = [record('shard-a', '1'), record('shard-a', '2')];
  f.state.boundaryMembers = allIdentities;
  await f.current.history.synchronize(f.contactA);
  const cleared = await f.current.clear.clear(f.contactA);
  assert.equal(cleared.phase, 'completed');
  const manifest = cleared.boundary.manifestSha256;
  const barrier = cleared.boundary.barrierGeneration;
  const current = await restart(f, t);
  const status = await current.clear.statusOf(f.contactA);
  assert.equal(status.phase, 'completed');
  assert.equal(status.boundary.barrierGeneration, barrier);
  assert.equal(status.boundary.manifestSha256, manifest);
  const cutoff = await current.storage.execute('history.cutoffStatus', { ownerId: owner, operationId: cleared.operationId });
  assert.equal(cutoff.state, 'verified');
  assert.equal(cutoff.manifestSha256, manifest);
  f.state.pageRecords = [record('shard-a', '1'), record('shard-a', '2'), record('shard-b', '7')];
  await current.history.synchronize(f.contactA);
  assert.deepEqual((await current.history.read(f.contactA)).messages.map(message => message.text), ['合成正文7']);
});

test('二次清空推进单调代次，旧B不后移且旧成员继续排除；同秒乱序按身份而非时间判定', async t => {
  const f = await fixture(t);
  const { history, clear } = f.current;
  f.state.pageRecords = [record('shard-a', '1'), record('shard-a', '2'), record('shard-b', '3'), record('shard-b', '4')];
  f.state.boundaryMembers = allIdentities;
  await history.synchronize(f.contactA);
  const first = await clear.clear(f.contactA);
  assert.equal(first.phase, 'completed');
  const firstCutoff = await f.current.storage.execute('history.cutoffStatus', { ownerId: owner, operationId: first.operationId });
  f.state.boundaryMembers = identities([['shard-a', '1'], ['shard-a', '2']]);
  const second = await clear.clear(f.contactA);
  assert.equal(second.phase, 'completed');
  const secondCutoff = await f.current.storage.execute('history.cutoffStatus', { ownerId: owner, operationId: second.operationId });
  assert.equal(BigInt(secondCutoff.barrierGeneration), BigInt(firstCutoff.barrierGeneration) + 1n, '二次清空单调推进代次');
  const firstAfter = await f.current.storage.execute('history.cutoffStatus', { ownerId: owner, operationId: first.operationId });
  assert.equal(firstAfter.state, 'verified');
  assert.equal(firstAfter.manifestSha256, firstCutoff.manifestSha256, '旧B不得后移或被覆盖');
  assert.equal(firstAfter.memberCount, 4);
  // 同秒、乱序：1/2 属于第二次B，3/4 只属于第一次B，5 为B后新消息。
  f.state.pageRecords = [record('shard-b', '4'), record('shard-a', '5'), record('shard-a', '1'),
    record('shard-b', '3'), record('shard-a', '2')];
  const coverage = await history.synchronize(f.contactA);
  assert.equal(coverage.phase, 'complete');
  assert.deepEqual((await history.read(f.contactA)).messages.map(message => message.text), ['合成正文5']);
});

test('边界能力未认证时先封禁旧写入并清理已存资料、明确boundary_pending，能力可用后同操作完成', async t => {
  const f = await fixture(t);
  const { history, clear } = f.current;
  f.state.pageRecords = [record('shard-a', '1'), record('shard-a', '2')];
  f.state.boundaryMembers = allIdentities;
  await history.synchronize(f.contactA);
  f.state.boundaryAvailable = false;
  delete f.channel.boundarySnapshot;
  const pending = await clear.clear(f.contactA);
  assert.equal(pending.phase, 'boundary_pending');
  assert.equal(pending.completed, false);
  assert.equal(pending.boundaryReason, 'history_boundary_unverified');
  assert.equal(pending.storedMessages, 0, '缺边界仍清理已保存资料');
  await assert.rejects(history.synchronize(f.contactA), { code: 'history_suppression_unverified' });
  f.state.boundaryAvailable = true;
  f.channel.boundarySnapshot = async scope => {
    f.state.boundaryCalls++;
    return buildCandidate(scope, f.state.boundaryMembers);
  };
  const done = await clear.clear(f.contactA);
  assert.equal(done.phase, 'completed');
  assert.equal(done.operationId, pending.operationId, '续做同一删除操作');
  assert.equal((await clear.statusOf(f.contactA)).completed, true);
});

test('late page identities never resurrect and channel boundary uses identity metadata only', async t => {
  const f = await fixture(t);
  const { history, clear } = f.current;
  f.state.pageRecords = [record('shard-a', '1'), record('shard-a', '2')];
  f.state.boundaryMembers = allIdentities;
  await history.synchronize(f.contactA);
  const before = f.state.pageCalls;
  const status = await clear.clear(f.contactA);
  assert.equal(status.phase, 'completed');
  assert.equal(f.state.pageCalls, before, '边界阶段不读取正文/媒体分页');
  // 边界候选只从必要的身份元数据拼装，不含正文。
  for (const member of f.state.boundaryMembers) assert.equal(Object.keys(member).sort().join(','), 'localId,partition');
});

test('边界候选校验拒绝窗口/覆盖/实例/成员/摘要不一致，并允许空历史集合完整接受', async t => {
  const f = await fixture(t);
  const { storage, contacts, clear } = f.current;
  const token = await contacts.eligibility(f.contactA);
  const scope = await storage.execute('history.scope', { token });
  const members = [identity('shard-a', '1'), identity('shard-b', '2')];
  const good = buildCandidate(scope, members);
  assert.doesNotThrow(() => prepareBoundaryCandidate(scope, good));
  const cases = [
    ['分片覆盖缺失', candidate => { candidate.partitions = candidate.partitions.slice(1); }, 'history_boundary_candidate_incomplete'],
    ['分片成员数不符', candidate => { candidate.partitions[0].memberCount = 9; }, 'history_boundary_candidate_incomplete'],
    ['每分片计数与成员不符', candidate => { candidate.partitions[0].memberCount = 0; candidate.partitions[1].memberCount = 2; }, 'history_boundary_candidate_incomplete'],
    ['实例替换', candidate => { candidate.instanceContinuity = false; }, 'history_boundary_instance_changed'],
    ['命名空间变化', candidate => { candidate.namespaceContinuity = false; }, 'history_boundary_namespace_changed'],
    ['成员表实例不符', candidate => { candidate.members[0].table = 'other-instance'; }, 'history_boundary_member_invalid'],
    ['成员重复', candidate => { candidate.members[1] = { ...candidate.members[0] }; }, 'history_boundary_member_duplicate'],
    ['manifest不符', candidate => { candidate.manifestSha256 = 'd'.repeat(64); }, 'history_boundary_manifest_mismatch'],
    ['支持档未认证边界能力', candidate => { candidate.support = { ...candidate.support, capabilities: {} }; }, 'history_boundary_support_unverified'],
  ];
  for (const [label, mutate, reason] of cases) {
    const candidate = structuredClone(good);
    mutate(candidate);
    assert.throws(() => prepareBoundaryCandidate(scope, candidate), error => error.reason === reason, label);
  }
  const window = structuredClone(good);
  window.partitions[0].preSample = 'window-a';
  window.partitions[0].postSample = 'window-b';
  assert.throws(() => prepareBoundaryCandidate(scope, window), error => error.reason === 'history_boundary_window_changed' && error.retryable === true);

  // 空历史集合也是完整 S(B)：允许 0 成员并完成清空/清理。
  f.state.pageRecords = [];
  f.state.boundaryMembers = [];
  const status = await clear.clear(f.contactB);
  assert.equal(status.phase, 'completed');
  assert.equal(status.boundary.state, 'verified');
  assert.equal(status.boundary.memberCount, 0);
});


test('取消/中断使S(B)候选失效：不持久化接受、不显示完成，旧写入继续封禁', async t => {
  const f = await fixture(t);
  f.state.pageRecords = [record('shard-a', '1')];
  f.state.boundaryMembers = [identity('shard-a', '1')];
  await f.current.history.synchronize(f.contactA);
  let releaseBoundary;
  const gate = new Promise(resolve => { releaseBoundary = resolve; });
  let enteredBoundary;
  const boundaryEntered = new Promise(resolve => { enteredBoundary = resolve; });
  f.state.boundaryHook = async () => { enteredBoundary(); await gate; };
  const run = f.current.clear.clear(f.contactA);
  await boundaryEntered;
  const stopping = f.current.clear.stop(f.contactA);
  releaseBoundary();
  const [status] = await Promise.all([run, stopping]);
  assert.equal(status.phase, 'boundary_pending');
  assert.equal(status.completed, false);
  assert.equal(status.boundaryReason, 'history_interrupted');
  const cutoff = await f.current.storage.execute('history.cutoffStatus', { ownerId: owner, operationId: status.operationId });
  assert.notEqual(cutoff.state, 'verified', '取消后候选不得被接受');
  await assert.rejects(f.current.history.synchronize(f.contactA), { code: 'history_suppression_unverified' });
  f.state.boundaryHook = null;
  const resumed = await (await restart(f, t)).clear.clear(f.contactA);
  assert.equal(resumed.phase, 'completed', '恢复后同一操作仍可重新建立边界');
});

test('已接受B但清理未完成时新消息保留，重启后沿同一B续清且不重读边界', async t => {
  const f = await fixture(t);
  const { storage, contacts, deletion, history } = f.current;
  f.state.pageRecords = [record('shard-a', '1'), record('shard-a', '2')];
  f.state.boundaryMembers = identities([['shard-a', '1'], ['shard-a', '2']]);
  await history.synchronize(f.contactA);
  const plan = await deletion.plan({ ownerId: owner, requestKey: 'synthetic-slow-cleanup', scope: { kind: 'contact_history', contactId: f.contactA } });
  const begin = await storage.execute('history.clearBegin', { ownerId: owner, contactId: f.contactA, operationId: plan.operationId, at: Date.now() });
  const token = await contacts.eligibility(f.contactA);
  const scope = await storage.execute('history.scope', { token });
  const prepared = prepareBoundaryCandidate(scope, buildCandidate(scope, f.state.boundaryMembers));
  await storage.execute('history.boundaryPersist', { ownerId: owner, operationId: plan.operationId, contactId: f.contactA,
    barrierGeneration: begin.barrierGeneration, accountKey: scope.accountKey, conversationKey: scope.conversationKey, prepared });
  const accepted = await storage.execute('history.boundaryAccept', { ownerId: owner, operationId: plan.operationId,
    contactId: f.contactA, barrierGeneration: begin.barrierGeneration, at: Date.now() });
  assert.equal(accepted.state, 'verified');
  const manifest = accepted.manifestSha256;
  // 慢清理期间新消息按新资格进入；旧消息此时尚未被05清理。
  f.state.pageRecords = [record('shard-a', '1'), record('shard-a', '2'), record('shard-b', '6')];
  const coverage = await history.synchronize(f.contactA);
  assert.equal(coverage.phase, 'complete');
  assert.ok((await history.read(f.contactA)).messages.some(message => message.text === '合成正文6'));
  const boundaryCalls = f.state.boundaryCalls;
  const restarted = await restart(f, t);
  const pendingStatus = await restarted.clear.statusOf(f.contactA);
  assert.equal(pendingStatus.phase, 'cleaning');
  assert.equal(pendingStatus.completed, false);
  const done = await restarted.clear.clear(f.contactA);
  assert.equal(done.phase, 'completed');
  assert.equal(f.state.boundaryCalls, boundaryCalls, '已接受B后重试不得重新读取边界');
  assert.equal(done.boundary.barrierGeneration, begin.barrierGeneration);
  assert.equal(done.boundary.manifestSha256, manifest);
  const read = await restarted.history.read(f.contactA);
  assert.deepEqual(read.messages.map(message => message.text), ['合成正文6'], '慢清理只清旧代次消息');
});

test('来源代次变化后旧B不放行普通读取，已清空旧成员不得复活', async t => {
  const f = await fixture(t, { registryModule: new URL('./fixtures/history/source-change-registry.mjs', import.meta.url).href });
  f.state.pageRecords = [record('shard-a', '1'), record('shard-a', '2')];
  f.state.boundaryMembers = identities([['shard-a', '1'], ['shard-a', '2']]);
  await f.current.history.synchronize(f.contactA);
  const cleared = await f.current.clear.clear(f.contactA);
  assert.equal(cleared.phase, 'completed');
  await f.current.storage.execute('fixture.changeSourceGeneration', { ownerId: owner, sourceGeneration: 'source-2' });
  const token = await f.current.contacts.eligibility(f.contactA);
  assert.equal(token.source_generation, 'source-2');
  assert.notEqual(token.barrier_generation, '0');
  f.state.pageRecords = [record('shard-a', '1'), record('shard-a', '2'), record('shard-b', '7')];
  await assert.rejects(f.current.history.synchronizeIncremental(f.contactA), { code: 'history_source_continuity_unverified' });
  await assert.rejects(f.current.history.synchronize(f.contactA), { code: 'history_source_continuity_unverified' });
  const blockedCoverage=await f.current.history.coverage(f.contactA);
  assert.equal(blockedCoverage.phase,'incomplete');assert.equal(blockedCoverage.failureCode,'history_source_continuity_unverified');
  assert.ok(blockedCoverage.bindingId,'删除旧目标后仍须显示持久失证状态');
  assert.equal((await f.current.history.read(f.contactA)).messages.length, 0, '跨来源代次不能复活旧消息');
  await f.current.storage.execute('fixture.changeSourceGeneration', { ownerId: owner, sourceGeneration: 'source-1' });
  await assert.rejects(f.current.history.synchronize(f.contactA), { code: 'history_source_continuity_unverified' });
});

test('v12旧结构库升级到当前19后联系人、同步与清空重读仍可工作', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'notalone-clear-upgrade-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = await SqliteStorage.open({ userData: root, intent: 'create', role: 'test',
    registryModule: new URL('./fixtures/history/v12-registry.mjs', import.meta.url).href });
  const databaseId = legacy.status.databaseId;
  assert.equal(legacy.status.schemaVersion, 12);
  const legacyContacts = new SqliteContactService(legacy, owner, { account: async () => { throw new Error('no metadata'); }, sessions: async () => [] });
  await legacyContacts.initialize();
  await legacy.close();
  const upgraded = await SqliteStorage.open({ userData: root, intent: 'open', role: 'test', expectedDatabaseId: databaseId });
  t.after(() => upgraded.close());
  assert.equal(upgraded.status.schemaVersion, 19);
  assert.deepEqual(await upgraded.check(), { integrity: 'ok', foreignKeys: 'ok' });
  const { channel, state } = createChannel();
  const holders = new (await import('../src/storage/sqlite/deletion/holders.ts')).ActiveHolders();
  const { DeletionService } = await import('../src/storage/sqlite/deletion/service.ts');
  const { ManagedFiles } = await import('../src/storage/sqlite/deletion/managed-files.ts');
  const { SqliteHistoryService } = await import('../src/history/sqlite/service.ts');
  const { SqliteHistoryClearService } = await import('../src/history/sqlite/clear.ts');
  const { SqliteHistoryResyncService } = await import('../src/history/sqlite/resync.ts');
  const contacts = new SqliteContactService(upgraded, owner, {
    account: async () => ({ externalKey: 'synthetic-account', identityScheme: 'wechat.account.v1', sourceGeneration: 'source-1', assurance: 'verified', supportProfile: 'synthetic-metadata-v1' }),
    sessions: async () => [{ externalKey: 'friend-a', displayName: '合成甲', kind: 'private', identityAssurance: 'verified' }] });
  await contacts.initialize();
  const detected = await contacts.detectAccount();
  await contacts.confirmAccount(detected.candidate_token);
  await contacts.setReading(true);
  const snapshot = await contacts.candidates(true);
  const saved = await contacts.confirm(snapshot.snapshot_token, snapshot.sessions.map(session => ({
    locator: session.username, observed_display_name: session.display_name, expected_selection_generation: session.selection_generation })));
  const contact = saved.bindings[0].contact_id;
  state.pageRecords = [record('shard-a', '1')];
  state.boundaryMembers = [identity('shard-a', '1')];
  const deletion = new DeletionService(upgraded, holders, new ManagedFiles(root), { drainTimeoutMs: 2_000 });
  const history = new SqliteHistoryService(upgraded, contacts, () => channel, holders);
  const clear = new SqliteHistoryClearService(upgraded, contacts, () => channel, deletion, holders);
  const resync = new SqliteHistoryResyncService(upgraded, contacts, () => channel, holders);
  t.after(async () => { await resync.close(); await clear.close(); await history.close(); });
  await history.synchronize(contact);
  const cleared = await clear.clear(contact);
  assert.equal(cleared.phase, 'completed');
  const restored = await resync.resync(contact, { requestKey: 'upgrade-resync-1' });
  assert.equal(restored.state, 'completed');
  assert.equal((await history.read(contact)).messages.length, 1);
});
