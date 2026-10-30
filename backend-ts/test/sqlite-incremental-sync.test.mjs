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

const owner = '00000000-0000-4000-8000-000000000084';
const evidence = { externalKey: 'synthetic-account', identityScheme: 'wechat.account.v1', sourceGeneration: 'source-1', assurance: 'verified', supportProfile: 'synthetic-metadata-v1' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const record = (localId, changes = {}) => ({
  partition: 'p', table: 't', localId, serverId: '0', sender: 'contact', kind: 'text', text: `合成${localId}`,
  originalType: '1', sentAt: '1700000000000', timePrecision: 'second', orderScheme: null, orderKey: null, status: '0', stateAssurance:'verified', ...changes,
});
function support(scope, state) {
  return {
    protocol: 'private-history-v1', profileId: 'synthetic-history-v1', adapterVersion: '1', status: 'supported', reason: null,
    accountKey: scope.accountKey, conversationKey: scope.conversationKey, sourceGeneration: scope.token.source_generation,
    programVersion: 'synthetic', build: '1', artifactSha256: 'a'.repeat(64), schemaFingerprint: 'b'.repeat(64),
    declaredPrimaryKey: ['local_id'], identity: 'source-table-local-v1', statusSemantics: 'synthetic-raw-codes',
    continuity: 'synthetic-source-1', serverAliasSemantics: 'unverified',
    ...(state.tailSupported ? { capabilities: { incrementalTail: 'supported' } } : {}),
    ...state.supportOverrides,
  };
}
function createChannel(state) {
  const factory = () => {
    state.creates++; let closed = false, heldScope;
    return {
      inspect: async scope => { heldScope = scope; state.inspects++; return support(scope, state); },
      target: async scope => {
        state.targets++; state.targetDescriptor = `synthetic:${scope.conversationKey}`;
        return { protocol: 'private-history-v1', descriptor: state.targetDescriptor, partitions: ['p'], tables: [{ partition: 'p', instance: 't' }], sourceGeneration: 'source-1' };
      },
      page: async (scope, target, cursor) => {
        state.pages.push({ contactId: scope.token.contact_id, cursor });
        if (state.pageHook) return state.pageHook(scope, target, cursor);
        return { target: target.descriptor, cursorIn: cursor, cursorOut: null, completedPartitions: ['p'], exhausted: true, records: state.historyRecords, ...(state.resumeCursor === null ? {} : { resumeCursor: state.resumeCursor }) };
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
async function fixture(t, names = ['a']) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'notalone-incremental-')));
  const state = { creates: 0, inspects: 0, targets: 0, pages: [], tails: [], closes: 0, supportOverrides: {}, tailSupported: true,
    historyRecords: [], tailBatches: [], tailSerial: 0, resumeCursor: 'tail-1', targetDescriptor: null, pageHook: null, tailHook: null, closeHook: null };
  const metadata = () => ({
    account: async () => ({ ...evidence }),
    sessions: async () => names.map(name => ({ externalKey: `friend-${name}`, displayName: `合成${name}`, kind: 'private', identityAssurance: 'verified' })),
  });
  const f = { root, state };
  f.storage = await SqliteStorage.open({ userData: root, intent: 'create', role: 'test' });
  f.contacts = new SqliteContactService(f.storage, owner, metadata());
  await f.contacts.initialize();
  f.history = new SqliteHistoryService(f.storage, f.contacts, createChannel(state));
  f.coordinator = new IncrementalHistoryCoordinator(f.contacts, f.history, { intervalMs: 0 });
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

test('增量出现未知状态后不能继续宣称历史完整',async t=>{
 const f=await fixture(t);f.state.historyRecords=[record('1')];const [binding]=await select(f);await f.contacts.setReading(true);
 await f.history.synchronize(binding.contact_id);
 f.state.tailBatches.push(()=>({records:[record('1',{stateAssurance:'unverified',status:'99',sender:'unknown',text:null})],caughtUp:true,cursorOut:'tail-2'}));
 await f.history.synchronizeIncremental(binding.contact_id);
 const result=await f.history.read(binding.contact_id);assert.equal(result.replyEligibility,'history_incomplete');assert.equal(result.coverage.incremental.phase,'incomplete');assert.equal(result.messages.length,0);
});
test('增量未知身份即使后续有正常页也不能恢复完整状态',async t=>{
 const f=await fixture(t);const [binding]=await select(f);await f.contacts.setReading(true);await f.history.synchronize(binding.contact_id);
 f.state.tailBatches.push(()=>({records:[record(null,{stateAssurance:'unverified',status:'99',sender:'unknown',text:null})],caughtUp:true,cursorOut:'tail-2'}));
 await f.history.synchronizeIncremental(binding.contact_id);
 f.state.tailBatches.push(()=>({records:[],caughtUp:true,cursorOut:'tail-3'}));await f.history.synchronizeIncremental(binding.contact_id);
 assert.equal((await f.history.read(binding.contact_id)).replyEligibility,'history_incomplete');
});

test('历史终页与增量交接无缺口，重叠重复读取幂等，续读从持久检查点而不是从头', async t => {
  const f = await fixture(t);
  f.state.historyRecords = [record('1', { text: '历史一' })];
  const [binding] = await select(f); await f.contacts.setReading(true);
  await f.history.synchronize(binding.contact_id);
  let coverage = await f.history.coverage(binding.contact_id);
  assert.equal(coverage.phase, 'complete');
  assert.equal(coverage.incremental.phase, 'ready');
  assert.equal(coverage.incremental.cursorPresent, true);
  assert.equal(coverage.incremental.pagesAccepted, 0);
  // 交接后到来的合法新消息 + 与历史终页重叠的旧消息（渠道保守续读允许重叠、不得跳项）。
  f.state.tailBatches.push(() => ({ records: [record('1', { text: '历史一' }), record('2', { text: '增量新消息' })], caughtUp: true, cursorOut: 'tail-2' }));
  await wake(f);
  assert.equal(f.state.tails.length, 1);
  assert.equal(f.state.tails[0].cursor, 'tail-1', '必须使用历史终页持久化的续读游标，而不是从头读取');
  const read = await f.history.read(binding.contact_id);
  assert.deepEqual(read.messages.map(message => message.text).sort(), ['增量新消息', '历史一'].sort());
  assert.equal(read.messages.length, 2, '重叠读取不得重复建立消息');
  assert.equal(read.messages.find(message => message.text === '历史一').sourceRecordIds.length, 2, '重叠页保留新的实际来源记录但仍指向同一规范消息');
  coverage = read.coverage;
  assert.equal(coverage.messageCount, 2);
  assert.equal(coverage.incremental.phase, 'ready');
  assert.equal(coverage.incremental.pagesAccepted, 1);
  assert.ok(coverage.incremental.lastAcceptedAt > 0);
});

test('乱序、迟到和更小 local_id 的新消息不会因单一水位漏掉，重复唤醒幂等', async t => {
  const f = await fixture(t);
  f.state.historyRecords = [record('9', { text: '较早历史' })];
  const [binding] = await select(f); await f.contacts.setReading(true);
  await f.history.synchronize(binding.contact_id);
  // 迟到消息的 local_id 更小且真实发送时间更早：禁止用 max(local_id) 或排序水位推进读取。
  f.state.tailBatches.push(() => ({ records: [record('3', { text: '迟到但合法', sentAt: '1699999999000' })], caughtUp: true, cursorOut: 'tail-2' }));
  await wake(f);
  let read = await f.history.read(binding.contact_id);
  assert.deepEqual(read.messages.map(message => message.text).sort(), ['迟到但合法', '较早历史'].sort());
  assert.equal(f.state.tails[0].cursor, 'tail-1');
  // 再次唤醒从新游标读取空页：不重复建消息、不重复推进。
  await wake(f);
  assert.equal(f.state.tails[1].cursor, 'tail-2');
  read = await f.history.read(binding.contact_id);
  assert.equal(read.messages.length, 2);
  assert.equal(read.coverage.incremental.pagesAccepted, 2);
});

test('删除排除的历史来源在旧游标重放时不会复活', async t => {
  const f = await fixture(t);
  f.state.historyRecords = [record('1', { text: '被删除的合成历史' })];
  const [binding] = await select(f); await f.contacts.setReading(true);
  await f.history.synchronize(binding.contact_id);
  const sourceId = (await f.history.read(binding.contact_id)).messages[0].sourceRecordIds[0];
  const { DeletionService } = await import('../src/storage/sqlite/deletion/service.ts');
  const { ManagedFiles } = await import('../src/storage/sqlite/deletion/managed-files.ts');
  const deletion = new DeletionService(f.storage, f.history.holders, new ManagedFiles(f.root));
  const plan = await deletion.plan({ ownerId: owner, requestKey: 'synthetic-incremental-source-exclusion', scope: { kind: 'source', contactId: binding.contact_id, sourceId } });
  assert.equal((await deletion.advance(plan)).state, 'completed');

  f.state.tailBatches.push(() => ({ records: [record('1', { text: '重放的合成旧历史' }), record('2', { text: '新的合成消息' })], caughtUp: true, cursorOut: 'tail-2' }));
  await f.history.synchronizeIncremental(binding.contact_id);
  const read = await f.history.read(binding.contact_id);
  assert.deepEqual(read.messages.map(message => message.text), ['新的合成消息']);
  assert.equal(read.coverage.incremental.pagesAccepted, 1);
  assert.equal(f.state.tails.at(-1).cursor, 'tail-1', '从删除前的可靠检查点重放时仍应用来源排除');
});

test('发送状态补齐与可认证更新分别处理：不重复建消息、未知状态不猜完成、冲突进入隔离', async t => {
  const f = await fixture(t);
  f.state.historyRecords = [record('5', { sender: 'owner', text: '你好', sentAt: null, timePrecision: null, status: '0' })];
  const [binding] = await select(f); await f.contacts.setReading(true);
  await f.history.synchronize(binding.contact_id);
  // 已存在行：补齐发送时间与状态，仍只有一条消息。
  f.state.tailBatches.push(() => ({
    records: [record('5', { sender: 'owner', text: '你好', sentAt: '1700000000500', timePrecision: 'second', status: '2' })],
    caughtUp: true, cursorOut: 'tail-2',
  }));
  await wake(f);
  let read = await f.history.read(binding.contact_id);
  assert.equal(read.messages.length, 1);
  assert.equal(read.messages[0].sentAt, '1700000000500');
  assert.equal(read.messages[0].status, '2');
  assert.equal(read.coverage.phase, 'complete');
  // 未知/缺失状态不得猜测为完成，也不清除已有观察。
  f.state.tailBatches.push(() => ({
    records: [record('5', { sender: 'owner', text: '你好', sentAt: '1700000000500', timePrecision: 'second', status: null })],
    caughtUp: true, cursorOut: 'tail-3',
  }));
  await wake(f);
  read = await f.history.read(binding.contact_id);
  assert.equal(read.messages.length, 1);
  assert.equal(read.messages[0].status, '2');
  // 同一来源身份但不可认证的正文变化：隔离原观察，不改写已有消息，也不静默丢弃。
  f.state.tailBatches.push(() => ({
    records: [record('5', { sender: 'owner', text: '被改写', sentAt: '1700000000500', timePrecision: 'second', status: '2' })],
    caughtUp: true, cursorOut: 'tail-4',
  }));
  await wake(f);
  read = await f.history.read(binding.contact_id);
  assert.equal(read.messages.length, 1);
  assert.equal(read.messages[0].text, '你好');
  assert.ok(read.coverage.quarantinedCount >= 1, '身份冲突必须可见隔离');
});

test('在途页在关闭后不推进检查点，旧代次迟到页被拒绝，重新开启从原检查点补齐', async t => {
  const f = await fixture(t);
  f.state.historyRecords = [record('1', { text: '历史一' })];
  const [binding] = await select(f); await f.contacts.setReading(true);
  await f.history.synchronize(binding.contact_id);
  const token = await f.contacts.eligibility(binding.contact_id);
  const { goalId } = (await f.history.coverage(binding.contact_id)).incremental;
  assert.ok(goalId);
  const entered = deferred(), gate = deferred();
  f.state.tailHook = async () => { entered.resolve(); await gate.promise; return { records: [record('2', { text: '在途新消息' })], caughtUp: true, cursorOut: 'tail-9' }; };
  f.coordinator.wake(); await entered.promise;
  // 关闭总开关：推进 read_epoch、停止后续查询并取消在途；随后释放迟到页。
  await f.contacts.setReading(false);
  const stopping = f.coordinator.stop();
  gate.resolve(); await stopping;
  let coverage = await f.history.coverage(binding.contact_id);
  assert.equal(coverage.incremental.pagesAccepted, 0, '取消后的迟到页不得推进水位');
  assert.equal(coverage.incremental.lastAcceptedAt, null);
  assert.equal((await f.history.read(binding.contact_id)).messages.length, 1);
  // 直接提交旧代次迟到页同样被拒绝。
  const latePage = { target: f.state.targetDescriptor, cursorIn: 'tail-1', cursorOut: 'tail-9', caughtUp: true, records: [record('2', { text: '在途新消息' })] };
  await assert.rejects(f.storage.execute('history.acceptIncrementalPage', { token, goalId, captureId: randomUUID(), page: latePage, at: Date.now(), runtimeToken: f.storage.status.runtimeId }), (error) => error instanceof StorageFailure && error.code === 'read_not_authorized');
  assert.equal((await f.history.read(binding.contact_id)).messages.length, 1);
  // 重新开启：从既有检查点续读，补齐关闭期间本机仍可读的消息。
  await f.contacts.setReading(true);
  f.state.tailHook = null;
  f.state.tailBatches.push(() => ({ records: [record('2', { text: '在途新消息' })], caughtUp: true, cursorOut: 'tail-9' }));
  await wake(f);
  const resumed = f.state.tails.at(-1);
  assert.equal(resumed.cursor, 'tail-1', '重开只恢复仍合法允许的读取，并从原检查点继续');
  const read = await f.history.read(binding.contact_id);
  assert.deepEqual(read.messages.map(message => message.text).sort(), ['历史一', '在途新消息'].sort());
  assert.equal(read.coverage.incremental.pagesAccepted, 1);
});

test('分页预算耗尽保留不完整与可见原因，下一轮从检查点续读', async t => {
  const f = await fixture(t);
  f.state.historyRecords = [record('1')];
  const [binding] = await select(f); await f.contacts.setReading(true);
  await f.history.synchronize(binding.contact_id);
  let pages = 0, lastCursor = 'tail-1';
  f.state.tailHook = async (scope, target, cursor) => {
    const recordId = String(100 + pages);
    lastCursor = `tail-budget-${++pages}`;
    return { target: target.descriptor, cursorIn: cursor, cursorOut: lastCursor, caughtUp: false, records: [record(recordId, { text: `批量${pages}` })] };
  };
  await f.history.synchronizeIncremental(binding.contact_id);
  const exhausted = await f.history.coverage(binding.contact_id);
  assert.equal(exhausted.incremental.phase, 'incomplete');
  assert.equal(exhausted.incremental.failureCode, 'history_page_budget_exhausted');
  assert.equal(exhausted.incremental.pagesAccepted, 200);
  f.state.tailHook = null;
  f.state.tailBatches.push(() => ({ records: [record('999', { text: '收尾' })], caughtUp: true, cursorOut: 'tail-done' }));
  await wake(f);
  assert.equal(f.state.tails.at(-1).cursor, lastCursor, '恢复必须从最后接受页的检查点续读');
  const resumed = await f.history.read(binding.contact_id);
  assert.equal(resumed.coverage.incremental.failureCode, null);
  assert.equal(resumed.messages.at(0).text, '收尾');
});

test('增量页预算耗尽后优先接续同一固定目标，不等待其他会话和下一次定时唤醒',async t=>{
 const f=await fixture(t,['a','b','c']);const bindings=await select(f,['a','b','c']);await f.contacts.setReading(true);
 await f.coordinator.close();f.coordinator=new IncrementalHistoryCoordinator({directory:async()=>{
  const directory=await f.contacts.directory();return {...directory,bindings:directory.bindings.toSorted((a,b)=>a.conversation_locator.localeCompare(b.conversation_locator))};
 }},f.history,{intervalMs:0});
 for(const binding of bindings)await f.history.synchronize(binding.contact_id);
 const otherActive=deferred();let pagesA=0,continuationBeforeQueuedContact=false;
 f.state.tailHook=async(scope,target,cursor)=>{
  if(scope.conversationKey==='friend-b')await otherActive.promise;
  if(scope.conversationKey==='friend-c'){
   continuationBeforeQueuedContact=pagesA===201;otherActive.resolve();
  }
  const isA=scope.conversationKey==='friend-a';
  return {records:[],cursorOut:isA?`tail-a-${++pagesA}`:`tail-${scope.conversationKey}`,caughtUp:!isA||pagesA===201};
 };
 await wake(f);
 assert.equal(pagesA,201,'一轮唤醒必须接续预算检查点直至固定扫描结束');
 assert.equal(continuationBeforeQueuedContact,true,'已打开的增量目标优先接力，避免空闲超时');
 const a=bindings.find(binding=>binding.conversation_locator==='friend-a');
 const coverage=await f.history.coverage(a.contact_id);
 assert.equal(coverage.incremental.phase,'ready');assert.equal(coverage.incremental.pagesAccepted,201);
 assert.equal(f.coordinator.getState().contacts.find(row=>row.contactId===a.contact_id).phase,'caught_up');
});

test('增量预算响应没有接受新页时不自动空转',async t=>{
 const binding={contact_id:'synthetic-contact',binding_id:'synthetic-binding',grant_id:'synthetic-grant',selection_generation:'1',status:'active'};
 const coverage={phase:'complete',traversalComplete:true,incremental:{goalId:'synthetic-goal',phase:'incomplete',failureCode:'history_page_budget_exhausted',cursorPresent:true,pagesAccepted:0}};
 let calls=0;
 const history={coverage:async()=>coverage,synchronizeIncremental:async()=>{if(++calls>1)throw new Error('不得再次空转');return coverage;},stop:async()=>{}};
 const coordinator=new IncrementalHistoryCoordinator({directory:async()=>({read_enabled:true,bindings:[binding]})},history,{intervalMs:0,firstHistoryManagedExternally:true});
 t.after(()=>coordinator.close());coordinator.wake();await coordinator.waitForIdle();
 assert.equal(calls,1);assert.equal(coordinator.getState().contacts[0].phase,'degraded');
});
