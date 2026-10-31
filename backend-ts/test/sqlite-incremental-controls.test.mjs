import test from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { StorageFailure } from '../src/storage/sqlite/contracts.ts';
import { SqliteContactService } from '../src/contacts/sqlite/service.ts';
import { SqliteHistoryService } from '../src/history/sqlite/service.ts';
import { IncrementalHistoryCoordinator } from '../src/history/sqlite/incremental-coordinator.ts';
import { FirstHistoryCoordinator } from '../src/history/sqlite/coordinator.ts';
import { ActiveHolders } from '../src/storage/sqlite/deletion/holders.ts';
import { DeletionService } from '../src/storage/sqlite/deletion/service.ts';
import { ManagedFiles } from '../src/storage/sqlite/deletion/managed-files.ts';

const owner = '00000000-0000-4000-8000-000000000085';

test('已遍历但存在未核验消息的历史继续增量，不重复首次读取或假报完整',async t=>{
 const binding={contact_id:'scope-a',binding_id:'binding-a',grant_id:'grant-a',selection_generation:'1',status:'active'};
 const directory={directory:async()=>({read_enabled:true,bindings:[binding]})};
 const coverage={contactId:'scope-a',phase:'incomplete',failureCode:'history_identity_quarantined',traversalComplete:true,
  incremental:{phase:'ready',cursorPresent:true}};let firstReads=0,tailReads=0;
 const history={coverage:async()=>coverage,synchronize:async()=>{firstReads++;throw new Error('不得重复已遍历的历史');},
  synchronizeIncremental:async()=>{tailReads++;return coverage;},stop:async()=>{}};
 const first=new FirstHistoryCoordinator(directory,history),incremental=new IncrementalHistoryCoordinator(directory,history,{intervalMs:0,firstHistoryManagedExternally:true});
 t.after(async()=>{await first.close();await incremental.close();});
 first.wake();incremental.wake();await Promise.all([first.waitForIdle(),incremental.waitForIdle()]);
 assert.equal(firstReads,0);assert.equal(tailReads,1);assert.equal(coverage.phase,'incomplete');
 assert.equal(first.getState().contacts[0].phase,'incomplete');
});

test('旧empty目标在两协调器启动竞态中仅由新持久证明解除不可用阻断',async t=>{
 const binding={contact_id:'scope-empty-race',binding_id:'binding-empty-race',grant_id:'grant-empty-race',selection_generation:'1',status:'active'};
 const directory={directory:async()=>({read_enabled:true,bindings:[binding]})};
 let coverage={goalId:'old-empty-goal',contactId:binding.contact_id,phase:'complete',failureCode:null,traversalComplete:true,
  incremental:{goalId:null,phase:'unavailable',failureCode:'history_incremental_unavailable',cursorPresent:false}};
 let metadataProbes=0,coverageReads=0,firstRuns=0;
 const history={coverage:async()=>{coverageReads++;return coverage;},synchronize:async()=>{firstRuns++;coverage={...coverage,goalId:'new-certified-empty-goal',phase:'complete',failureCode:null,
   incremental:{...coverage.incremental,emptyTargetAwaitingMessages:true}};return coverage;},
  synchronizeIncremental:async()=>{metadataProbes++;return coverage;},stop:async()=>{}};
 const now=()=>1_800_000_000_000;
 const first=new FirstHistoryCoordinator(directory,history);
 const incremental=new IncrementalHistoryCoordinator(directory,history,{intervalMs:10,firstHistoryManagedExternally:true,now});
 t.after(async()=>{await incremental.close();await first.close();});
 incremental.start();incremental.wake();await incremental.waitForIdle();
 assert.equal(incremental.getState().contacts[0].phase,'blocked');
 assert.equal(metadataProbes,0,'旧目标缺少认证证明时不触碰native metadata');
 const oldCoverageReads=coverageReads;
 await new Promise(resolve=>setTimeout(resolve,35));await incremental.waitForIdle();
 assert.equal(metadataProbes,0,'旧证明不变时每次只读本机coverage');
 assert.ok(coverageReads>oldCoverageReads);
 coverage={...coverage,phase:'incomplete',failureCode:'history_first_read_failed'};
 first.wake();await first.waitForIdle();
 assert.equal(firstRuns,1,'首次历史协调器完成新C2空目标并持久化证明');
 await new Promise(resolve=>setTimeout(resolve,35));await incremental.waitForIdle();
 assert.equal(metadataProbes,1,'观察到新证明后允许一次metadata-only重探');
 assert.equal(incremental.getState().contacts[0].phase,'waiting_new_messages');
 assert.equal(incremental.getState().contacts[0].lastError,null);
});
const evidence = { externalKey: 'synthetic-account', identityScheme: 'wechat.account.v1', sourceGeneration: 'source-1', assurance: 'verified', supportProfile: 'synthetic-metadata-v1' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const record = (localId, changes = {}) => ({
  partition: 'p', table: 't', localId, serverId: '0', sender: 'contact', kind: 'text', text: `合成${localId}`,
  originalType: '1', sentAt: '1700000000000', timePrecision: 'second', orderScheme: null, orderKey: null, stateAssurance: 'verified', status: '0', ...changes,
});
function support(scope, state) {
  if (state.supportFactory) return state.supportFactory(scope, state);
  return {
    protocol: 'private-history-v1', profileId: 'synthetic-history-v1', adapterVersion: '1', status: 'supported', reason: null,
    accountKey: scope.accountKey, conversationKey: scope.conversationKey, sourceGeneration: scope.token.source_generation,
    programVersion: 'synthetic', build: '1', artifactSha256: 'a'.repeat(64), schemaFingerprint: 'b'.repeat(64),
    declaredPrimaryKey: ['local_id'], identity: 'source-table-local-v1', statusSemantics: 'synthetic-raw-codes',
    continuity: 'synthetic-source-1', serverAliasSemantics: 'unverified',
    ...(state.capabilityDeclared ? { capabilities: { incrementalTail: state.tailSupported ? 'supported' : 'unavailable' } } : {}),
    ...state.supportOverrides,
  };
}
function createChannel(state) {
  const factory = () => {
    state.creates++; let closed = false, heldScope;
    return {
      ...(state.guardSession ? { guardSession: { loss: new Promise(() => {}) } } : {}),
      inspect: async scope => { heldScope = scope; state.inspects++; return support(scope, state); },
      target: async scope => {
        state.targets++; state.targetDescriptor = `synthetic:${scope.conversationKey}`;
        if (state.targetFactory) return state.targetFactory(scope, state);
        return { protocol: 'private-history-v1', descriptor: state.targetDescriptor, partitions: ['p'], tables: [{ partition: 'p', instance: 't' }], sourceGeneration: 'source-1' };
      },
      page: async (scope, target, cursor) => {
        state.pages.push({ contactId: scope.token.contact_id, cursor });
        if (state.pageHook) return state.pageHook(scope, target, cursor);
        if (state.pageFactory) return state.pageFactory(scope, target, cursor, state);
        return { target: target.descriptor, cursorIn: cursor, cursorOut: null, completedPartitions: target.partitions, exhausted: true, records: state.historyRecords, ...(state.resumeCursor === null ? {} : { resumeCursor: state.resumeCursor }) };
      },
      ...(state.tailSupported ? {
        tail: async (scope, target, cursor) => {
          state.tails.push({ contactId: scope.token.contact_id, cursor });
          const batch = state.tailHook
            ? await state.tailHook(scope, target, cursor)
            : (state.tailBatches.length ? state.tailBatches.shift() : () => ({ records: [], caughtUp: true, cursorOut: cursor }));
          const next = typeof batch === 'function' ? batch(scope, target, cursor) : batch;
          return { target: next.target ?? target.descriptor, cursorIn: next.cursorIn ?? cursor, cursorOut: next.cursorOut ?? `tail-${++state.tailSerial}`, caughtUp: next.caughtUp ?? false, records: next.records ?? [] };
        },
      } : {}),
      close: async () => { if (closed) return; closed = true; state.closes++; if (state.closeHook) await state.closeHook(heldScope?.token.contact_id); },
    };
  };
  return factory;
}
async function fixture(t, names = ['a'], coordinatorOptions = { intervalMs: 0 }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'notalone-incremental-controls-')));
  const state = { creates: 0, inspects: 0, targets: 0, pages: [], tails: [], closes: 0, supportOverrides: {}, tailSupported: true, capabilityDeclared: true,
    historyRecords: [], tailBatches: [], tailSerial: 0, resumeCursor: 'tail-1', targetDescriptor: null, pageHook: null, tailHook: null, closeHook: null,
    supportFactory: null, targetFactory: null, pageFactory: null, guardSession: false };
  const metadata = () => ({
    account: async () => ({ ...evidence }),
    sessions: async () => names.map(name => ({ externalKey: `friend-${name}`, displayName: `合成${name}`, kind: 'private', identityAssurance: 'verified' })),
  });
  const f = { root, state };
  f.storage = await SqliteStorage.open({ userData: root, intent: 'create', role: 'test' });
  f.contacts = new SqliteContactService(f.storage, owner, metadata());
  await f.contacts.initialize();
  f.history = new SqliteHistoryService(f.storage, f.contacts, createChannel(state));
  f.coordinator = new IncrementalHistoryCoordinator(f.contacts, f.history, coordinatorOptions);
  t.after(async () => {
    await f.coordinator.close(); await f.history.close(); await f.contacts.close(); await f.storage.close();
    await rm(root, { recursive: true, force: true });
  });
  return f;
}
async function select(f, names = ['a']) {
  if (!(await f.contacts.directory()).account) {
    const candidate = await f.contacts.detectAccount();
    await f.contacts.confirmAccount(candidate.candidate_token);
  }
  const snapshot = await f.contacts.candidates(true);
  const choices = snapshot.sessions.filter(row => names.includes(row.username.slice('friend-'.length)))
    .map(row => ({ locator: row.username, observed_display_name: row.display_name, expected_selection_generation: row.selection_generation }));
  await f.contacts.confirm(snapshot.snapshot_token, choices);
  return (await f.contacts.directory()).bindings.filter(binding => binding.status === 'active');
}
async function wake(f) { f.coordinator.wake(); await f.coordinator.waitForIdle(); }
const channelCounts = state => ({ creates: state.creates, inspects: state.inspects, targets: state.targets, pages: state.pages.length, tails: state.tails.length });
function assertNoNewChannel(before, state) { assert.deepEqual(channelCounts(state), before); }

test('读取四门禁：未选、总开关关闭、撤销/账号失效或协调器关闭时零渠道读取', async t => {
  const f = await fixture(t);
  // 未选择联系人：不读取。
  await wake(f);
  assert.deepEqual(channelCounts(f.state), { creates: 0, inspects: 0, targets: 0, pages: 0, tails: 0 });
  const [binding] = await select(f);
  // 总开关关闭：不读取，服务入口也直接拒绝。
  await wake(f);
  assertNoNewChannel({ creates: 0, inspects: 0, targets: 0, pages: 0, tails: 0 }, f.state);
  await assert.rejects(f.history.synchronizeIncremental(binding.contact_id), { code: 'read_not_authorized' });
  assertNoNewChannel({ creates: 0, inspects: 0, targets: 0, pages: 0, tails: 0 }, f.state);
  // 开启后正常读取一次历史。
  await f.contacts.setReading(true); await wake(f);
  assert.equal(f.state.pages.length, 1);
  // 关闭总开关不发起后续查询，也不创建新渠道。
  const beforeClose = channelCounts(f.state);
  await f.contacts.setReading(false); await wake(f);
  assertNoNewChannel(beforeClose, f.state);
  // 撤销授权后（账号/绑定/许可再无效）不读取。
  await f.contacts.setReading(true);
  await f.contacts.revoke(binding.contact_id, binding.binding_id, binding.selection_generation);
  const beforeRevoke = channelCounts(f.state);
  await wake(f);
  assertNoNewChannel(beforeRevoke, f.state);
  assert.equal((await f.history.read(binding.contact_id)).coverage.phase, 'complete', '撤销读取不删除已保存资料');
  // 协调器关闭（App 退出）后不再发起查询。
  await f.coordinator.close();
  await wake(f);
  assertNoNewChannel(beforeRevoke, f.state);
});

test('宿主由首次历史协调器管理时，增量协调器等待首次历史完成后才读尾部', async t => {
  const f = await fixture(t, ['a'], { intervalMs: 0, firstHistoryManagedExternally: true });
  f.state.historyRecords = [record('1')];
  const [binding] = await select(f);
  await f.contacts.setReading(true);

  await wake(f);
  assert.deepEqual(channelCounts(f.state), { creates: 0, inspects: 0, targets: 0, pages: 0, tails: 0 }, '首次历史未完成时不与首次历史协调器争抢渠道');
  assert.equal((await f.history.coverage(binding.contact_id)).phase, 'not_started');
  const waiting = f.coordinator.getState().contacts.find(contact => contact.contactId === binding.contact_id);
  assert.equal(waiting.phase, 'degraded');
  assert.equal(waiting.lastError, 'history_incomplete');

  await f.history.synchronize(binding.contact_id);
  f.state.tailBatches.push(() => ({ records: [record('2')], caughtUp: true, cursorOut: 'tail-2' }));
  const beforeTail = channelCounts(f.state);
  await wake(f);
  assert.equal(f.state.pages.length, beforeTail.pages, '首次历史已完成后不再重读历史页');
  assert.equal(f.state.tails.length, beforeTail.tails + 1, '首次历史完成后由增量协调器读取尾部');
  assert.equal(f.coordinator.getState().contacts.find(contact => contact.contactId === binding.contact_id).phase, 'caught_up');
  assert.deepEqual((await f.history.read(binding.contact_id)).messages.map(message => message.text).sort(), ['合成1', '合成2']);
});

test('关闭总开关保留资料与选择/授权、不撤销手动处理资格；重开只恢复仍合法允许的读取', async t => {
  const f = await fixture(t);
  f.state.historyRecords = [record('1'), record('2')];
  const [binding] = await select(f); await f.contacts.setReading(true);
  await f.history.synchronize(binding.contact_id);
  f.state.tailBatches.push(() => ({ records: [record('3')], caughtUp: true, cursorOut: 'tail-2' }));
  await wake(f);
  const before = {
    read: await f.history.read(binding.contact_id),
    directory: await f.contacts.directory(),
  };
  assert.equal(before.read.messages.length, 3);
  await f.contacts.setReading(false);
  const disabled = await f.contacts.directory();
  const bindingAfter = disabled.bindings.find(row => row.contact_id === binding.contact_id);
  assert.equal(disabled.read_enabled, false);
  assert.equal(bindingAfter.status, 'active', '关闭总开关不撤销联系人选择');
  assert.equal(bindingAfter.grant_id, before.directory.bindings[0].grant_id, '关闭总开关不撤销读取授权');
  assert.equal(bindingAfter.selection_generation, before.directory.bindings[0].selection_generation, '关闭总开关不推进选择代次');
  const kept = await f.history.read(binding.contact_id);
  assert.equal(kept.messages.length, 3, '关闭总开关不删除合法已保存资料');
  assert.equal(kept.coverage.messageCount, 3);
  // 模拟退出重开：新协调器在总开关关闭时不读取；开启后从持久检查点恢复。
  await f.coordinator.close();
  f.coordinator = new IncrementalHistoryCoordinator(f.contacts, f.history, { intervalMs: 0 });
  const beforeReopen = channelCounts(f.state);
  await wake(f);
  assertNoNewChannel(beforeReopen, f.state);
  await f.contacts.setReading(true);
  f.state.tailBatches.push(() => ({ records: [record('4')], caughtUp: true, cursorOut: 'tail-3' }));
  await wake(f);
  assert.equal(f.state.tails.at(-1).cursor, 'tail-2', '重开只按持久检查点恢复，不从头重读');
  const resumed = await f.history.read(binding.contact_id);
  assert.equal(resumed.messages.length, 4);
  assert.equal(resumed.messages.filter(message => message.text === '合成4').length, 1);
});

test('取消单个联系人只停该人并撤销其提交资格，其他合法联系人继续', async t => {
  const f = await fixture(t, ['a', 'b']);
  f.state.historyRecords = [record('1')];
  const bindings = await select(f, ['a', 'b']); await f.contacts.setReading(true);
  for (const binding of bindings) await f.history.synchronize(binding.contact_id);
  const contactA = bindings.find(binding => binding.conversation_locator === 'friend-a').contact_id;
  const contactB = bindings.find(binding => binding.conversation_locator === 'friend-b').contact_id;
  const tokenA = await f.contacts.eligibility(contactA);
  const { goalId: goalA } = (await f.history.coverage(contactA)).incremental;
  const entered = deferred(), gate = deferred();
  f.state.tailHook = async (scope, target, cursor) => {
    if (scope.conversationKey === 'friend-a') { entered.resolve(); await gate.promise; return { records: [record('2', { text: '合成a2' })], caughtUp: true, cursorOut: 'tail-a2' }; }
    return { records: [record('2', { text: '合成b2' })], caughtUp: true, cursorOut: 'tail-b2' };
  };
  f.coordinator.wake(); await entered.promise;
  const revoke = bindings.find(binding => binding.contact_id === contactA);
  await f.contacts.revoke(revoke.contact_id, revoke.binding_id, revoke.selection_generation);
  const stopping = f.coordinator.stop(contactA);
  gate.resolve(); await stopping; await f.coordinator.waitForIdle();
  // A 的在途页不提交；B 不受影响继续完成。
  const readA = await f.history.read(contactA);
  assert.equal(readA.coverage.incremental.pagesAccepted, 0);
  assert.equal(readA.messages.length, 1, 'A 的历史资料保留，但取消后不再写入新读取');
  const readB = await f.history.read(contactB);
  assert.ok(readB.coverage.incremental.pagesAccepted >= 1, '其他合法联系人继续读取');
  assert.equal(readB.messages.length, 2);
  // A 的旧代次迟到页被拒绝。
  const pageA = { target: f.state.targetDescriptor.replace('friend-b', 'friend-a'), cursorIn: 'tail-1', cursorOut: 'tail-a2', caughtUp: true, records: [record('2', { text: '合成a2' })] };
  await assert.rejects(f.storage.execute('history.acceptIncrementalPage', { token: tokenA, goalId: goalA, captureId: randomUUID(), page: pageA, at: Date.now(), runtimeToken: f.storage.status.runtimeId }), error => error instanceof StorageFailure && ['read_not_authorized', 'read_eligibility_stale', 'history_goal_closed'].includes(error.code));
});


test('重选只在新资格下补齐本机仍可读缺口，不复活旧执行且不清除旧排除', async t => {
  const f = await fixture(t);
  f.state.historyRecords = [record('1'), record('2'), record('3')];
  const [binding] = await select(f); await f.contacts.setReading(true);
  await f.history.synchronize(binding.contact_id);
  const before = await f.history.read(binding.contact_id);
  const oldGoalId = before.coverage.incremental.goalId;
  const oldToken = await f.contacts.eligibility(binding.contact_id);
  const oldGeneration = binding.selection_generation;
  // 通过正式来源删除建立持久排除：删除消息 2 的实际来源。
  const message2 = before.messages.find(message => message.text === '合成2');
  const holders = new ActiveHolders();
  const deletion = new DeletionService(f.storage, holders, new ManagedFiles(f.root), { drainTimeoutMs: 20 });
  const operation = await deletion.plan({ ownerId: owner, requestKey: 'incremental-reselect-exclusion', scope: { kind: 'source', contactId: binding.contact_id, sourceId: message2.sourceRecordIds[0] } });
  assert.equal((await deletion.advance(operation)).state, 'completed');
  assert.equal((await f.history.read(binding.contact_id)).messages.length, 2);
  // 取消选择，期间出现新消息；随后重选建立新授权。
  await f.contacts.revoke(binding.contact_id, binding.binding_id, binding.selection_generation);
  await f.coordinator.stop(binding.contact_id);
  const [resumedBinding] = await select(f);
  assert.notEqual(resumedBinding.selection_generation, oldGeneration, '重选建立新资格');
  f.state.tailBatches.push(() => ({ records: [record('1'), record('2'), record('3'), record('4')], caughtUp: true, cursorOut: 'tail-2' }));
  await wake(f);
  const read = await f.history.read(binding.contact_id);
  // 旧排除不清零：被删除的来源记录即使被重新读到也不复活。
  assert.deepEqual(read.messages.map(message => message.text).sort(), ['合成1', '合成3', '合成4'].sort());
  // 旧执行不复活：新检查点目标身份不同，旧目标不再接受写入。
  assert.notEqual(read.coverage.incremental.goalId, oldGoalId);
  await assert.rejects(f.storage.execute('history.acceptIncrementalPage', { token: oldToken, goalId: oldGoalId, captureId: randomUUID(), page: { target: f.state.targetDescriptor, cursorIn: 'tail-1', cursorOut: 'tail-9', caughtUp: true, records: [record('9')] }, at: Date.now(), runtimeToken: f.storage.status.runtimeId }), error => error instanceof StorageFailure);
});

test('账号变化、支持语义变化、游标失效、目标不连续或交接不可证明时停止该范围并可见报错', async t => {
  const scenarios = [
    ['账号变化', f => { f.state.supportOverrides = { accountKey: 'other-account' }; }, 'history_external_scope_changed'],
    ['来源语义变化', f => { f.state.supportOverrides = { continuity: 'synthetic-source-2' }; }, 'history_support_changed'],
    ['游标失效', f => { f.state.tailHook = async () => { throw new StorageFailure('history_cursor_invalid'); }; }, 'history_cursor_invalid'],
    ['目标不连续', f => { f.state.tailHook = async (scope, target, cursor) => ({ target: 'synthetic:other-target', cursorIn: cursor, cursorOut: 'tail-9', caughtUp: true, records: [record('9')] }); }, 'history_page_invalid'],
  ];
  for (const [name, arrange, code] of scenarios) {
    await t.test(name, async t => {
      const f = await fixture(t);
      f.state.historyRecords = [record('1')];
      const [binding] = await select(f); await f.contacts.setReading(true);
      await f.history.synchronize(binding.contact_id);
      arrange(f);
      await wake(f);
      const state = f.coordinator.getState();
      assert.equal(state.lastError, code, `${name}必须可见报错`);
      assert.ok(state.contacts.some(contact => contact.phase === 'blocked' && contact.lastError === code));
      const read = await f.history.read(binding.contact_id);
      assert.equal(read.messages.length, 1, '失败不写入未认证读取');
      assert.equal(read.coverage.incremental.pagesAccepted, 0, '失败不推进检查点');
      assert.equal(JSON.stringify(state).includes('friend-'), false, '状态不得泄露渠道会话细节');
    });
  }
  await t.test('支持档未声明增量能力', async t => {
    const f = await fixture(t);
    f.state.historyRecords = [record('1')];
    f.state.capabilityDeclared = false;
    const [binding] = await select(f); await f.contacts.setReading(true);
    await f.history.synchronize(binding.contact_id);
    const before = channelCounts(f.state);
    await wake(f);
    assert.equal(f.state.tails.length - before.tails, 0, '未声明能力的适配器不得进入尾部读取');
    assert.equal(f.coordinator.getState().lastError, 'history_tail_unsupported');
    assert.equal((await f.history.read(binding.contact_id)).coverage.incremental.pagesAccepted, 0);
  });
  await t.test('交接不可证明', async t => {
    const f = await fixture(t);
    f.state.resumeCursor = null;
    f.state.historyRecords = [record('1')];
    const [binding] = await select(f); await f.contacts.setReading(true);
    await f.history.synchronize(binding.contact_id);
    const before = channelCounts(f.state);
    await wake(f);
    assert.deepEqual(channelCounts(f.state), before, '交接不可证明时不发起增量渠道读取');
    const coverage = await f.history.coverage(binding.contact_id);
    assert.equal(coverage.phase, 'complete');
    assert.equal(coverage.incremental.phase, 'unavailable');
    assert.equal(coverage.incremental.failureCode, 'history_incremental_unavailable');
    const state = f.coordinator.getState();
    assert.equal(state.lastError, 'history_incremental_unavailable');
  });
  await t.test('未认证的空历史保持不可用且不重探渠道', async t => {
    const f = await fixture(t, ['a'], { intervalMs: 0, firstHistoryManagedExternally: true });
    f.state.resumeCursor = null;
    const [binding] = await select(f); await f.contacts.setReading(true);
    const first = new FirstHistoryCoordinator(f.contacts, f.history);
    t.after(async () => first.close());
    first.wake(); await first.waitForIdle();
    const before = channelCounts(f.state);
    await wake(f);
    assert.deepEqual(channelCounts(f.state), before, '未知空目标不得触发metadata/page/tail重探');
    const coverage = await f.history.coverage(binding.contact_id);
    assert.equal(coverage.incremental.emptyTargetAwaitingMessages, undefined);
    assert.equal(f.coordinator.getState().contacts.find(contact => contact.contactId === binding.contact_id).phase, 'blocked');
  });
});

test('已认证空目标低频只重探元数据，首次表出现后无需用户唤醒即可由首次历史入库', async t => {
  const f = await fixture(t, ['a'], { intervalMs: 10, firstHistoryManagedExternally: true, now: () => now });
  const [binding] = await select(f); await f.contacts.setReading(true);
  const fileA = 'file-a-stable-id', fileB = 'file-b-stable-id';
  const absentTarget = { protocol: 'private-history-v1', descriptor: 'empty-v1', sourceGeneration: 'source-1',
    partitions: [fileA, fileB], tables: [], checkedPartitions: [fileA, fileB] };
  const tableTarget = { protocol: 'private-history-v1', descriptor: 'table-v2', sourceGeneration: 'source-1',
    partitions: [fileA], tables: [{ partition: fileA, instance: 'table-v2' }], checkedPartitions: [fileA, fileB] };
  let now = 1_800_000_000_000;
  let tableAppeared = false;
  let resolveFirstTable;
  const firstTableRead = new Promise(resolve => { resolveFirstTable = resolve; });
  const absentReport = scope => ({ protocol: 'private-history-v1', profileId: 'wechat-4.0.6-29387-absent-private-target-v1', adapterVersion: '1',
    status: 'supported', reason: null, accountKey: scope.accountKey, conversationKey: scope.conversationKey, sourceGeneration: 'source-1',
    programVersion: 'wechat', build: '29387', artifactSha256: 'a'.repeat(64), schemaFingerprint: 'b'.repeat(64), declaredPrimaryKey: [],
    identity: 'source-table-local-v1', statusSemantics: 'no-message-table-v1', continuity: 'same-source-instances-normal-use-v1',
    capabilities: { normalHistory: 'supported', snapshotBarrier: 'supported', partitionCoverage: 'supported', sourceLifecycle: 'supported',
      restartContinuity: 'supported', recoveryMapping: 'supported', incrementalTail: 'unsupported', partitionGrowth: 'supported' } });
  const observedReport = scope => ({ ...absentReport(scope), profileId: 'wechat-4.0.6-29387-observed-states-v1', schemaFingerprint: 'c'.repeat(64),
    declaredPrimaryKey: ['local_id'], statusSemantics: 'verified-message-state-v1',
    capabilities: { ...absentReport(scope).capabilities, incrementalTail: 'supported' } });
  f.state.resumeCursor = null;
  f.state.guardSession = true;
  f.state.supportFactory = scope => tableAppeared ? observedReport(scope) : absentReport(scope);
  f.state.targetFactory = () => tableAppeared ? structuredClone(tableTarget) : structuredClone(absentTarget);
  f.state.pageFactory = async (scope, target, cursor, state) => {
    if (target.tables.length) {
      resolveFirstTable();
      return { target: target.descriptor, cursorIn: cursor, cursorOut: null, completedPartitions: [...target.partitions], exhausted: true,
        records: [record('42', { partition: fileA, table: 'table-v2' })] };
    }
    return { target: target.descriptor, cursorIn: cursor, cursorOut: null, completedPartitions: [...target.partitions], exhausted: true, records: [] };
  };
  const first = new FirstHistoryCoordinator(f.contacts, f.history);
  f.history.setFirstHistoryWake(contactId => first.wakeContact(contactId));
  t.after(async () => first.close());
  first.wake(); await first.waitForIdle();
  assert.equal((await f.history.coverage(binding.contact_id)).phase, 'complete', JSON.stringify({ first: first.getState(), counts: channelCounts(f.state) }));
  const initialPages = f.state.pages.length;
  const initialTails = f.state.tails.length;
  const initialTargets = f.state.targets;
  const initialHistoryGoals = (await f.storage.execute('history.coverage', { ownerId: owner, contactId: binding.contact_id })).goalId;

  await f.coordinator.close();
  f.coordinator = new IncrementalHistoryCoordinator(f.contacts, f.history,
    { intervalMs: 10, firstHistoryManagedExternally: true, now: () => now });
  f.coordinator.start(); f.coordinator.wake(); await f.coordinator.waitForIdle();
  const empty = f.coordinator.getState().contacts.find(contact => contact.contactId === binding.contact_id);
  assert.equal(empty.phase, 'waiting_new_messages');
  assert.equal(empty.lastError, null);
  assert.equal((await f.history.coverage(binding.contact_id)).incremental.emptyTargetAwaitingMessages,true,
    '等待状态来自持久认证证明，不由零消息计数推断');
  assert.equal(f.state.pages.length, initialPages, '空目标metadata探测不能调用page');
  assert.equal(f.state.tails.length, initialTails, '空目标metadata探测不能调用tail');
  assert.equal(f.state.targets, initialTargets + 1, '初次受控探测只读取一次target metadata');
  assert.equal((await f.storage.execute('history.coverage', { ownerId: owner, contactId: binding.contact_id })).goalId, initialHistoryGoals,
    '仍为空时不得创建重复历史目标');

  await new Promise(resolve => setTimeout(resolve, 40)); await f.coordinator.waitForIdle();
  assert.equal(f.state.targets, initialTargets + 1, '五分钟窗口内不重复探测');
  tableAppeared = true;
  now += 300_000;
  await Promise.race([firstTableRead, new Promise((_, reject) => setTimeout(() => reject(new Error(JSON.stringify({
    message:'首表出现后未由定时探测唤醒首次历史',incremental:f.coordinator.getState(),first:first.getState(),counts:channelCounts(f.state),
  }))), 1500))]);
  await first.waitForIdle();
  const read = await f.history.read(binding.contact_id);
  assert.deepEqual(read.messages.map(message => message.text), ['合成42']);
  assert.notEqual(read.coverage.goalId, initialHistoryGoals, '发现首表后会创建新的历史目标');
  assert.equal(f.state.tails.length, initialTails, '新历史目标通过首次历史协调器消费，不走旧target tail');
});

test('关闭协调器取消在途增量读取，迟到页不提交且关闭不被挂起',async t=>{
  const f=await fixture(t);
  f.state.historyRecords=[record('1')];
  const [binding]=await select(f); await f.contacts.setReading(true);
  await f.history.synchronize(binding.contact_id);
  const entered=deferred(),gate=deferred();
  f.state.tailHook=async()=>{entered.resolve();await gate.promise;return {records:[record('2')],caughtUp:true,cursorOut:'tail-9'};};
  // 关闭必须由自身取消路径驱动：不手动释放 gate，由渠道 close 解除在途并应在有界时间内结束。
  f.state.closeHook=async()=>{gate.resolve();};
  f.coordinator.wake(); await entered.promise;
  const started=Date.now();
  await f.coordinator.close();
  assert.ok(Date.now()-started<2000,'关闭应在有界时间内结束');
  assert.equal((await f.history.read(binding.contact_id)).coverage.incremental.pagesAccepted,0,'退出时在途页不得提交');
  assert.equal((await f.history.read(binding.contact_id)).messages.length,1);
  assert.equal(f.coordinator.getState().phase,'closed');
});

test('瞬时故障降级后恢复成功时清除可见错误，不残留旧失败',async t=>{
  const f=await fixture(t);
  f.state.historyRecords=[record('1')];
  const [binding]=await select(f); await f.contacts.setReading(true);
  await f.history.synchronize(binding.contact_id);
  let attempts=0;
  f.state.tailHook=async(scope,target,cursor)=>{ if(++attempts===1)throw new StorageFailure('history_snapshot_window_changed'); return {records:[record('2')],caughtUp:true,cursorOut:'tail-2'}; };
  await wake(f);
  let state=f.coordinator.getState();
  assert.equal(state.contacts[0].phase,'degraded');
  assert.equal(state.lastError,'history_snapshot_window_changed');
  await wake(f);
  state=f.coordinator.getState();
  assert.equal(state.contacts[0].phase,'caught_up');
  assert.equal(state.lastError,null,'恢复后不再报告旧失败');
  assert.equal((await f.history.read(binding.contact_id)).messages.length,2);
});
