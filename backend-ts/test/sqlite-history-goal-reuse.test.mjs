import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { SqliteContactService } from '../src/contacts/sqlite/service.ts';
import { SqliteHistoryService } from '../src/history/sqlite/service.ts';
import { FirstHistoryCoordinator } from '../src/history/sqlite/coordinator.ts';
import { IncrementalHistoryCoordinator } from '../src/history/sqlite/incremental-coordinator.ts';
import { serializeSupport } from '../src/history/sqlite/goal-reuse.ts';

const owner = '00000000-0000-4000-8000-000000000090';
const registryUrl = () => new URL('./fixtures/history/goal-reuse-registry.mjs', import.meta.url).href;
const evidence = { externalKey: 'synthetic-account', identityScheme: 'wechat.account.v1', sourceGeneration: 'source-1', assurance: 'verified', supportProfile: 'synthetic-metadata-v1' };
const normalUseContinuity = 'same-source-instances-normal-use-v1';
const record = (localId, changes = {}) => ({
  partition: 'p', table: 't', localId, serverId: '0', sender: 'contact', kind: 'text', text: `合成${localId}`,
  originalType: '1', sentAt: '1700000000000', timePrecision: 'second', orderScheme: null, orderKey: null,
  status: '0', stateAssurance: 'verified', ...changes,
});
function support(scope, overrides = {}) {
  return {
    protocol: 'private-history-v1', profileId: 'synthetic-history-v1', adapterVersion: '1', status: 'supported', reason: null,
    accountKey: scope.accountKey, conversationKey: scope.conversationKey, sourceGeneration: scope.token.source_generation,
    programVersion: 'synthetic', build: '1', artifactSha256: 'a'.repeat(64), schemaFingerprint: 'b'.repeat(64),
    declaredPrimaryKey: ['local_id'], identity: 'source-table-local-v1', statusSemantics: 'synthetic-raw-codes',
    continuity: normalUseContinuity, serverAliasSemantics: 'unverified',
    capabilities: { incrementalTail: 'supported',durableIncremental:'supported',durableHistory:'supported', normalHistory: 'supported', snapshotBarrier: 'supported',
      partitionCoverage: 'supported', sourceLifecycle: 'supported', restartContinuity: 'supported',
      recoveryMapping: 'supported', exactSchema: 'supported', declaredLocalKey: 'supported',
      automaticAllocation: 'supported', statusColumn: 'supported' }, ...overrides,
  };
}
function createChannel(state) {
  return () => {
    const loss = Promise.withResolvers();
    let current, resumed=false, tailCursor;
    const target = scope => current = {
      protocol:'private-history-v1',descriptor:`synthetic:${scope.conversationKey}:${++state.serial}${state.descriptorSuffix??''}`,
      partitions:['p'],tables:[{partition:'p',instance:state.table??'t'}],sourceGeneration:'source-1',
    };
    return {
      guardSession:{loss:loss.promise},
      inspect:async scope=>support(scope,state.supportOverrides),
      target:async scope=>target(scope),
      resumeTarget:async(scope,previous,cursor)=>{
        state.resumes.push({previous,cursor});
        if(state.resumeUnavailable)return null;
        resumed=true;return target(scope);
      },
      page:async(_scope,requested,cursor)=>{
        state.pages++;
        assert.equal(requested.descriptor,current.descriptor);
        if(state.pageFailure){state.pageFailure=false;throw new Error('synthetic_page_interrupted');}
        tailCursor=state.resumeCursor;
        return {target:current.descriptor,cursorIn:cursor,cursorOut:null,records:resumed?(state.resumeRecords??[]):state.historyRecords,
          completedPartitions:['p'],exhausted:true,resumeCursor:tailCursor};
      },
      tail:async(scope,requested,cursor)=>{
        assert.equal(requested.descriptor,current.descriptor);
        assert.equal(cursor,tailCursor,'resume只恢复差异snapshot，必须本轮page终页后才能tail');
        state.tails.push({contactId:scope.token.contact_id,cursor});
        const batch=state.tailBatches.length?state.tailBatches.shift():{records:[],caughtUp:true,cursorOut:cursor};
        tailCursor=batch.cursorOut??cursor;
        return {target:current.descriptor,cursorIn:cursor,cursorOut:tailCursor,caughtUp:batch.caughtUp??true,records:batch.records??[]};
      },
      close:async()=>{state.closes++;if(state.closeFailure)throw new Error('synthetic_close_failed');loss.resolve();},
    };
  };
}
async function fixture(t, { names = ['a'] } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'notalone-goal-reuse-')));
  const state = { historyRecords: [], tailBatches: [], tails: [], resumes:[], serial:0, pages:0, closes:0, resumeCursor: 'tail-1', descriptorSuffix: null, supportOverrides: {} };
  const f = { root, state, names };
  const openStorage = async intent => SqliteStorage.open({ userData: root, intent, role: 'test',
    expectedDatabaseId: intent === 'open' ? f.storage.status.databaseId : undefined, registryModule: registryUrl() });
  f.storage = await openStorage('create');
  f.contacts = new SqliteContactService(f.storage, owner, {
    account: async () => ({ ...evidence }),
    sessions: async () => names.map(name => ({ externalKey: `friend-${name}`, displayName: `合成${name}`, kind: 'private', identityAssurance: 'verified' })),
  });
  await f.contacts.initialize();
  f.history = new SqliteHistoryService(f.storage, f.contacts, createChannel(state));
  const attachCoordinators = () => {
    const first = new FirstHistoryCoordinator({ directory: () => f.contacts.syncDirectory() }, f.history);
    f.history.setFirstHistoryWake(contactId => first.wakeContact(contactId));
    const incremental = new IncrementalHistoryCoordinator({ directory: () => f.contacts.syncDirectory() }, f.history,
      { intervalMs: 0, firstHistoryManagedExternally: true });
    f.first = first; f.coordinator = incremental;
  };
  attachCoordinators();
  f.restart = async () => {
    await f.first.close(); await f.coordinator.close();
    await f.history.close(); await f.contacts.close(); await f.storage.close();
    f.storage = await openStorage('open');
    f.contacts = new SqliteContactService(f.storage, owner, {
      account: async () => { throw new Error('重开后不得重选账号'); },
      sessions: async () => { throw new Error('重开后不得扩大会话范围'); },
    });
    await f.contacts.initialize();
    f.history = new SqliteHistoryService(f.storage, f.contacts, createChannel(state));
    attachCoordinators();
  };
  t.after(async () => {
    await f.first.close(); await f.coordinator.close();
    await f.history.close(); await f.contacts.close();
    await f.storage.close(); await rm(root, { recursive: true, force: true });
  });
  return f;
}
async function select(f, names = f.names) {
  if (!(await f.contacts.directory()).account) {
    const candidate = await f.contacts.detectAccount();
    await f.contacts.confirmAccount(candidate.candidate_token);
  }
  const snapshot = await f.contacts.candidates(true);
  const choices = snapshot.sessions.filter(row => names.includes(row.username.slice('friend-'.length)))
    .map(row => ({ locator: row.username, observed_display_name: row.display_name, expected_selection_generation: row.selection_generation }));
  await f.contacts.confirm(snapshot.snapshot_token, choices);
  await f.contacts.setReading(true);
  return (await f.contacts.directory()).bindings.filter(binding => binding.status === 'active');
}
const settle = async f => {
  for (let round = 0; round < 6; round++) {
    f.first.wake();
    f.coordinator.wake(); await f.coordinator.waitForIdle();
    try { await f.first.waitForIdle(); } catch {/* 已排空时立即返回 */ }
    const phases = f.coordinator.getState().contacts.map(row => row.phase);
    if (phases.length && phases.every(phase => ['caught_up', 'waiting_new_messages', 'stopped'].includes(phase))) return;
  }
};
const goals = async (f, contactId) =>
  (await f.storage.execute('fixture.listGoals', { ownerId: owner, contactId })).map(row => ({ ...row }));
const contactRows = (rows, contactId) => rows.filter(row => String(row.contact_id) === String(contactId));
const invalidatedCount = rows => rows.filter(row => row.state === 'invalidated' &&
  ['history_runtime_revalidated', 'history_snapshot_replaced'].includes(String(row.failure_code))).length;
const goalsOfAll = (f, bindings) => Promise.all(bindings.map(binding => goals(f, binding.contact_id))).then(list => list.flat());

test('重启恢复新nonce差异快照，page终页后tail且来源目标不改写',async t=>{
 const f=await fixture(t);f.state.historyRecords=[record('1')];const [binding]=await select(f);
 await f.history.synchronize(binding.contact_id);
 const before=await goals(f,binding.contact_id),historyBefore=before.find(row=>row.kind==='history'),incrementalBefore=before.find(row=>row.kind==='incremental');
 await f.restart();const pages=f.state.pages;
 await f.history.synchronizeIncremental(binding.contact_id);
 const after=await goals(f,binding.contact_id),running=after.find(row=>row.kind==='incremental'&&row.state==='running');
 assert.equal(f.state.pages,pages+1,'恢复必须读取本轮差异page');
 assert.equal(f.state.tails.length,1);assert.notEqual(running.id,incrementalBefore.id);
 assert.equal(after.find(row=>row.id===incrementalBefore.id),undefined,'已被新持久恢复点替代的空增量退役');
 assert.equal(after.find(row=>row.id===historyBefore.id).target_json,historyBefore.target_json,'有来源资料的旧目标不改写');
 assert.notEqual(running.target_json,historyBefore.target_json,'真实恢复使用新nonce目标');
 assert.equal(after.length,3);assert.equal((await f.history.read(binding.contact_id)).messages.length,1);
 assert.equal((await f.history.coverage(binding.contact_id)).phase,'complete');
});

test('真实nonce轮换的空闲多轮只保留来源目标与当前恢复链',async t=>{
 const f=await fixture(t);f.state.historyRecords=[record('1')];const [binding]=await select(f);
 await f.history.synchronize(binding.contact_id);
 for(let round=0;round<6;round++){
  await f.history.synchronizeIncremental(binding.contact_id);
  const rows=await goals(f,binding.contact_id);assert.equal(rows.length,3,`第${round+1}轮目标有界`);
  assert.equal(rows.filter(row=>row.kind==='incremental'&&row.state==='running').length,1);
 }
 assert.equal((await f.history.read(binding.contact_id)).messages.length,1);
 assert.equal(f.state.pages,7);assert.equal(f.state.tails.length,6);
});

test('多联系人重启后每位保留来源与当前nonce恢复链',async t=>{
 const f=await fixture(t,{names:['a','b','c']});f.state.historyRecords=[record('1')];const bindings=await select(f);
 for(const binding of bindings)await f.history.synchronize(binding.contact_id);
 await f.restart();await settle(f);
 for(const binding of bindings){
  const rows=await goals(f,binding.contact_id);assert.equal(rows.length,3);
  assert.equal(rows.filter(row=>row.kind==='incremental'&&row.state==='running').length,1);
  assert.equal((await f.history.read(binding.contact_id)).messages.length,1);
  assert.equal((await f.history.coverage(binding.contact_id)).phase,'complete');
 }
});

test('真实表实例变化不因成功resume而保留旧goal',async t=>{
 const f=await fixture(t);f.state.historyRecords=[record('1')];const [binding]=await select(f);await f.history.synchronize(binding.contact_id);
 const before=await goals(f,binding.contact_id),old=before.find(row=>row.kind==='incremental');
 f.state.table='different-instance';
 await assert.rejects(f.history.synchronizeIncremental(binding.contact_id),{code:'history_source_continuity_unverified'});
 assert.ok((await goals(f,binding.contact_id)).some(row=>row.id===old.id),'真实来源变化保留旧恢复事实供围栏/删除');
 assert.equal(f.state.tails.length,0);
});

/** 端到端复用判据负向：条件破坏后重验链仍回旧路径（作废＋新建）。 */
async function settledContact(t) {
  const f = await fixture(t);
  f.state.historyRecords = [record('1')];
  const [binding] = await select(f);
  await f.history.synchronize(binding.contact_id);
  const before = await goals(f, binding.contact_id);
  return { f, binding, before };
}

test('接受过空页的旧增量在新持久恢复点和真实关闭后退役',async t=>{
 const {f,binding}=await settledContact(t);
 await f.history.synchronizeIncremental(binding.contact_id);
 const old=(await goals(f,binding.contact_id)).find(row=>row.kind==='incremental'&&row.state==='running');
 assert.equal(Number(old.pages_accepted),1);
 await f.restart();await f.history.synchronizeIncremental(binding.contact_id);
 const rows=await goals(f,binding.contact_id);assert.equal(rows.length,3);assert.equal(rows.find(row=>row.id===old.id),undefined);
 assert.equal((await f.history.coverage(binding.contact_id)).phase,'complete');
});

test('有来源记录的旧增量保留原身份，不参与空节点退役',async t=>{
 const {f,binding}=await settledContact(t);
 f.state.tailBatches.push({records:[record('2',{text:'重启前的增量消息'})],caughtUp:true,cursorOut:'tail-2'});
 await f.history.synchronizeIncremental(binding.contact_id);
 const old=(await goals(f,binding.contact_id)).find(row=>row.kind==='incremental'&&row.state==='running');
 await f.restart();await f.history.synchronizeIncremental(binding.contact_id);
 const rows=await goals(f,binding.contact_id),saved=rows.find(row=>row.id===old.id);
 assert.ok(saved);assert.equal(saved.target_json,old.target_json);assert.equal(saved.cursor,old.cursor);assert.equal(saved.state,'invalidated');
 assert.equal((await f.history.read(binding.contact_id)).messages.length,2);
});

for(const failure of ['page','close'])test(`恢复${failure}失败保留原持久checkpoint，不提前清理空目标`,async t=>{
 const {f,binding}=await settledContact(t),old=(await goals(f,binding.contact_id)).find(row=>row.kind==='incremental');
 f.state[failure==='page'?'pageFailure':'closeFailure']=true;
 await assert.rejects(f.history.synchronizeIncremental(binding.contact_id));
 const saved=(await goals(f,binding.contact_id)).find(row=>row.id===old.id);
 assert.ok(saved);assert.equal(saved.cursor,old.cursor);assert.equal(saved.target_json,old.target_json);
 f.state.closeFailure=false;await f.history.stop(binding.contact_id);
});

for(const protection of ['restore','handoff','quarantine'])test(`已替换的空增量仍被${protection}依赖时不退役`,async t=>{
 const {f,binding}=await settledContact(t),old=(await goals(f,binding.contact_id)).find(row=>row.kind==='incremental');
 const token=await f.contacts.eligibility(binding.contact_id);
 if(protection==='quarantine')await f.storage.execute('fixture.patchGoal',{ownerId:owner,goalId:old.id,patch:{coverage_state:'partial'}});
 else if(protection==='restore')await f.storage.execute('fixture.protectGoal',{token,goalId:old.id,id:randomUUID(),kind:'restore'});
 else await f.storage.execute('fixture.cloneGoal',{ownerId:owner,goalId:old.id,id:randomUUID(),patch:{creation_no:null,state:'invalidated',failure_code:'synthetic',handoff_from_goal_id:old.id}});
 await f.history.synchronizeIncremental(binding.contact_id);
 const saved=(await goals(f,binding.contact_id)).find(row=>row.id===old.id);
 assert.ok(saved,'被恢复或后继引用的原检查点不能定向清理');assert.equal(saved.target_json,old.target_json);assert.equal(saved.cursor,old.cursor);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('非共享读者关闭后仍等待本轮空目标退役完成，close不提前结束',async t=>{
 const {f,binding}=await settledContact(t),entered=Promise.withResolvers(),allow=Promise.withResolvers();
 const execute=f.storage.execute.bind(f.storage);
 f.storage.execute=async(name,...args)=>{if(name==='history.retireResumedEmptyGoals'){entered.resolve();await allow.promise;}return execute(name,...args);};
 const reading=f.history.synchronizeIncremental(binding.contact_id);await entered.promise;
 assert.equal(f.state.closes,2,'读者已实际关闭，退役仍属于本轮生命周期');
 let closed=false;const closing=f.history.close().then(()=>{closed=true;});
 await Promise.resolve();await Promise.resolve();assert.equal(closed,false,'close必须等退役写排空');
 allow.resolve();await Promise.all([reading,closing]);assert.equal(closed,true);
});

test('端到端负向：读取开关回转（read_epoch 变化）后资格不匹配，保持旧行为', async t => {
  const { f, binding, before } = await settledContact(t);
  const incrementalBefore = before.find(row => row.kind === 'incremental');
  await f.contacts.setReading(false);
  await f.contacts.setReading(true);
  await f.restart();
  await settle(f);
  const after = await goals(f, binding.contact_id);
  assert.ok(after.length > before.length, '资格变化后仍新建目标');
  assert.equal(after.find(row => row.id === incrementalBefore.id).state, 'invalidated', '旧增量目标仍被作废');
  assert.ok(after.find(row => row.kind === 'incremental' && row.state === 'running'), '新建增量目标');
  const coverage = await f.history.coverage(binding.contact_id);
  assert.equal(coverage.phase, 'complete');
});

/** 复用判据可独立驱动；重启前的稳定基线：历史完成＋增量 ready、pages_accepted=0。 */
async function reuseStand(t) {
  const f = await fixture(t);
  f.state.historyRecords = [record('1')];
  const [binding] = await select(f);
  await f.history.synchronize(binding.contact_id);
  const rows = await goals(f, binding.contact_id);
  const token = await f.contacts.eligibility(binding.contact_id);
  const scope = await f.storage.execute('history.scope', { token });
  const report = support(scope);
  const target = JSON.parse(String(rows.find(row => row.kind === 'history').target_json));
  const incremental = rows.find(row => row.kind === 'incremental');
  assert.ok(incremental, '初次交接已产生增量目标');
  const preview = await f.storage.execute('fixture.reusePreview', { token, report, target });
  assert.ok(preview.some(row => row.id === incremental.id), '同范围 0 页空增量目标可复用');
  assert.equal(preview.filter(row => row.kind === 'history').length, 0, '完成的历史目标不在 running 复用范围');
  return { f, binding, rows, token, report, target };
}

test('复用判据逐一单独破坏：基础行被识别，任一前提破坏即拒绝', async t => {
  const { f, rows, binding, token, report, target } = await reuseStand(t);
  const incremental = rows.find(row => row.kind === 'incremental');
  const contactId = String(incremental.contact_id);
  const cases = [
    { name: 'binding_id 不同', keepBase: false, token: { ...token, binding_id: '00000000-0000-4000-8000-00000000ffff' } },
    { name: 'grant_id 不同', keepBase: false, token: { ...token, grant_id: '00000000-0000-4000-8000-00000000ffff' } },
    { name: 'accepted_data_generation 不同', patch: { accepted_data_generation: BigInt(String(incremental.accepted_data_generation)) - 1n } },
    { name: 'accepted_barrier_generation 不同', patch: { accepted_barrier_generation: BigInt(String(incremental.accepted_barrier_generation)) - 1n } },
    { name: 'cursor_scope_digest 不同', patch: { cursor_scope_digest: 'synthetic-other-digest' } },
    { name: 'pages_accepted>0', patch: { pages_accepted: 1n } },
    { name: 'support_json 不同', patch: { support_json: serializeSupport({ ...report, profileId: 'synthetic-history-variant-v1' }) } },
    { name: 'eligibility_json 不同（read_epoch 漂移）', patch: { eligibility_json: JSON.stringify({ ...token, read_epoch: '999' }) } },
    { name: 'target_json 字段漂移', patch: { target_json: JSON.stringify({ ...JSON.parse(String(incremental.target_json)), extraField: 'x' }) } },
    { name: '无 cursor 的增量目标', patch: { cursor: null } },
    { name: '名下有 capture_record', patch: { withCapture: true } },
    { name: '本轮目标已替换（descriptor/表实例）', keepBase: false,
      previewTarget: { ...target, descriptor: 'synthetic-replaced', tables: [{ partition: 'p', instance: 'replaced-t' }] } },
  ];
  for (const single of cases) {
    const cloneId = randomUUID();
    try {
      await f.storage.execute('fixture.cloneGoal', { ownerId: owner, goalId: incremental.id, id: cloneId,
        patch: single.patch ? { ...single.patch } : {} });
      if (single.patch?.withCapture) await f.storage.execute('fixture.seedCaptureRecord', { ownerId: owner, contactId,
        goalId: cloneId, captureId: randomUUID(), recordId: randomUUID(), withRecord: true });
    } catch (error) { throw new Error(`用例 ${single.name} 造数失败：${error.code ?? error.message}`); }
    const outcome = await f.storage.execute('fixture.reusePreview',
      { token: single.token ?? token, report, target: single.previewTarget ?? target });
    assert.ok(!outcome.some(row => row.id === cloneId), `复用前提破坏（${single.name}）的克隆行不可续用`);
    if (single.keepBase !== false) {
      assert.ok(outcome.some(row => row.id === incremental.id), `原始行不受 ${single.name} 影响仍可续用`);
    }
  }
});

for(const variant of ['goal','cursor','changed_cursor','digest','generation','target','support','capability','newer_goal'])test(`持久增量目标的恢复事务拒绝保留${variant}不一致的原行`,async t=>{
 const {f,binding}=await settledContact(t);
 f.state.tailBatches.push({records:[],caughtUp:true,cursorOut:'accepted-cursor'});
 await f.history.synchronizeIncremental(binding.contact_id);
 const token=await f.contacts.eligibility(binding.contact_id),scope=await f.storage.execute('history.scope',{token}),report=support(scope);
 const checkpoint=await f.storage.execute('history.resumeCheckpoint',{token,report});assert.ok(checkpoint);
 const request={token,report,target:checkpoint.target,guardId:randomUUID(),resumedCheckpoint:{goalId:checkpoint.goalId,cursor:checkpoint.cursor,target:checkpoint.target}};
 if(variant==='goal')request.resumedCheckpoint.goalId=randomUUID();
 if(variant==='cursor')request.resumedCheckpoint.cursor='forged-cursor';
 if(variant==='changed_cursor')await f.storage.execute('fixture.patchGoal',{ownerId:owner,goalId:checkpoint.goalId,patch:{cursor:'later-accepted-cursor'}});
 if(variant==='digest')await f.storage.execute('fixture.patchGoal',{ownerId:owner,goalId:checkpoint.goalId,patch:{cursor_scope_digest:'different-scope'}});
 if(variant==='generation')await f.storage.execute('fixture.patchGoal',{ownerId:owner,goalId:checkpoint.goalId,patch:{accepted_data_generation:BigInt(token.data_generation)+1n}});
 if(variant==='target')request.resumedCheckpoint.target={...checkpoint.target,descriptor:'forged-original-target'};
 if(variant==='support')request.report={...report,profileId:'different-supported-profile'};
 if(variant==='capability')request.report={...report,capabilities:{...report.capabilities,durableIncremental:'unsupported'}};
 if(variant==='newer_goal'){
  const current=(await goals(f,binding.contact_id)).find(goal=>goal.id===checkpoint.goalId);
  assert.equal(await f.storage.execute('fixture.cloneGoal',{ownerId:owner,goalId:current.id,id:randomUUID(),patch:{creation_no:current.creation_no+1n}}),undefined);
 }
 const prepared=await f.storage.execute('history.prepareNormalUseGuard',request);
 assert.equal(prepared.resumedGoalId,undefined,'复核不一致不能保留原目标及其普通游标');
 assert.equal((await goals(f,binding.contact_id)).find(goal=>goal.id===checkpoint.goalId).state,'invalidated');
 await f.storage.execute('history.guardRelease',{token,guardId:request.guardId});
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('读取器未实际恢复检查点时，即使当前descriptor相同也不保留旧增量目标',async t=>{
 const {f,binding}=await settledContact(t);
 f.state.tailBatches.push({records:[],caughtUp:true,cursorOut:'accepted-cursor'});await f.history.synchronizeIncremental(binding.contact_id);
 const old=(await goals(f,binding.contact_id)).find(goal=>goal.kind==='incremental'&&goal.state==='running');
 const tails=f.state.tails.length;f.state.resumeUnavailable=true;
 await f.history.synchronizeIncremental(binding.contact_id);
 assert.equal(f.state.tails.length,tails,'未恢复的旧游标不能发给当前读取器');
 assert.equal((await goals(f,binding.contact_id)).find(goal=>goal.id===old.id).state,'invalidated');
});

test('来源准备恢复持久目标时不读page或tail、不改目标或未知覆盖',async t=>{
 const f=await fixture(t);f.state.historyRecords=[record('1'),record('2',{stateAssurance:'unverified',text:null})];
 const [binding]=await select(f);await f.history.synchronize(binding.contact_id);await f.history.synchronizeIncremental(binding.contact_id);
 const before=await goals(f,binding.contact_id),coverage=await f.history.coverage(binding.contact_id),pages=f.state.pages,tails=f.state.tails.length;
 assert.equal(coverage.phase,'incomplete');assert.equal(coverage.failureCode,'history_identity_quarantined');assert.equal(coverage.traversalComplete,true);
 await f.history.prepareSource(binding.contact_id);
 assert.deepEqual(await goals(f,binding.contact_id),before,'元数据准备不创建、复位或推进同步目标');
 assert.deepEqual(await f.history.coverage(binding.contact_id),coverage,'不能把来源准备当作未知行核验或完整遍历');
 assert.equal(f.state.pages,pages);assert.equal(f.state.tails.length,tails);
 const guards=await f.storage.execute('fixture.guardLease',{ownerId:owner});assert.ok(guards.every(guard=>guard.state==='lost'));
});
