import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, owner } from './fixtures/memory-sqlite/support.mjs';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { SqliteContactService } from '../src/contacts/sqlite/service.ts';
import { SqliteHistoryService } from '../src/history/sqlite/service.ts';
import { FirstHistoryCoordinator } from '../src/history/sqlite/coordinator.ts';

async function emptyFixture(t) {
 const cleanup=[],f=await fixture({after:fn=>cleanup.push(fn)}),contactId=f.saved[0].contact_id;
 const state={artifact:'a'.repeat(64),partitions:['shard-a','shard-b'],pages:0,targets:0};
 const create=()=>{
  const loss=Promise.withResolvers();
  return {...f.channel,guardSession:{loss:loss.promise},
   inspect:async scope=>({...await f.channel.inspect(scope),profileId:'wechat-4.0.6-29387-absent-private-target-v1',
    artifactSha256:state.artifact,declaredPrimaryKey:[],statusSemantics:'no-message-table-v1',continuity:'same-source-instances-normal-use-v1',
    capabilities:{normalHistory:'supported',snapshotBarrier:'supported',partitionCoverage:'supported',sourceLifecycle:'supported',restartContinuity:'supported',recoveryMapping:'supported',partitionGrowth:'supported',incrementalTail:'unsupported'}}),
   target:async()=>({protocol:'private-history-v1',descriptor:`empty-${++state.targets}`,sourceGeneration:'source-1',tables:[],partitions:[...state.partitions],checkedPartitions:[...state.partitions]}),
   page:async(_scope,target,cursor)=>{state.pages++;return {target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[],completedPartitions:[...target.partitions],exhausted:true};},
   close:async()=>loss.resolve()};
 };
 let current={storage:f.storage,contacts:f.contacts,history:new SqliteHistoryService(f.storage,f.contacts,create)},first;
 await current.history.synchronize(contactId);
 assert.equal((await current.history.coverage(contactId)).incremental.emptyTargetAwaitingMessages,true);
 const reopen=async()=>{
  await current.history.close();await current.contacts.close();await current.storage.close();
  const storage=await SqliteStorage.open({userData:f.root,intent:'open',expectedDatabaseId:f.storage.status.databaseId,role:'test'});
  const contacts=new SqliteContactService(storage,owner,{account:async()=>{throw Error('不得重新选择账号');},sessions:async()=>{throw Error('不得扩大会话范围');}});
  await contacts.initialize();current={storage,contacts,history:new SqliteHistoryService(storage,contacts,create)};
 };
 const attachFirst=()=>{
  first=new FirstHistoryCoordinator({directory:()=>current.contacts.syncDirectory()},current.history);
  current.history.setFirstHistoryWake(id=>first.wakeContact(id));return first;
 };
 t.after(async()=>{await first?.close();await current.history.close();await current.contacts.close();await current.storage.close();await f.service.close();for(const fn of cleanup.reverse())await fn();});
 return {contactId,state,reopen,attachFirst,get current(){return current;}};
}

test('已认证空目标跨运行时更换制品后先核验完整来源目标，再恢复等待新消息',async t=>{
 const f=await emptyFixture(t),oldGoal=(await f.current.history.coverage(f.contactId)).goalId;
 await f.reopen();f.state.artifact='c'.repeat(64);const first=f.attachFirst();
 const token=await f.current.contacts.eligibility(f.contactId);
 assert.equal(await f.current.storage.execute('history.normalUseRevalidationCandidate',{token}),true);
 await f.current.history.synchronizeIncremental(f.contactId);await first.waitForIdle();
 const coverage=await f.current.history.coverage(f.contactId);
 assert.equal(coverage.phase,'complete');assert.equal(coverage.incremental.emptyTargetAwaitingMessages,true);
 assert.notEqual(coverage.goalId,oldGoal,'新运行时须建立当前报告下的新认证目标');
 assert.equal(f.state.pages,2);assert.equal(coverage.messageCount,0);
 assert.equal(await f.current.storage.execute('history.preflightGeneration',{token}),true);
 const before=f.state.pages;
 for(let probe=0;probe<2;probe++){await f.current.history.synchronizeIncremental(f.contactId);await first.waitForIdle();}
 assert.equal(f.state.pages,before,'报告相同时空目标释放守卫后的连续metadata重探也不重读历史页');
});

test('空目标跨运行时重验仍拒绝完整检查分片变化',async t=>{
 const f=await emptyFixture(t);await f.reopen();f.state.artifact='c'.repeat(64);f.state.partitions=['shard-a'];
 await assert.rejects(f.current.history.synchronizeIncremental(f.contactId),{code:'history_source_continuity_unverified'});
 assert.equal(f.state.pages,1,'未验证几何不能接受新空页');
 const token=await f.current.contacts.eligibility(f.contactId);
 assert.equal(await f.current.storage.execute('history.normalUseRevalidationCandidate',{token}),false);
});

test('空目标当前活守卫中的支持报告变化仍拒绝，不借重验放宽',async t=>{
 const f=await emptyFixture(t);f.state.artifact='c'.repeat(64);
 await assert.rejects(f.current.history.synchronizeIncremental(f.contactId),{code:'history_support_changed'});
 assert.equal(f.state.pages,1);
});

test('已有真实来源围栏的空目标不能借运行时和制品更新恢复',async t=>{
 const f=await emptyFixture(t),token=await f.current.contacts.eligibility(f.contactId);
 await f.current.storage.execute('history.markContinuityLost',{token});await f.reopen();f.state.artifact='c'.repeat(64);
 const before=f.state.targets;
 await assert.rejects(f.current.history.synchronizeIncremental(f.contactId),{code:'history_source_continuity_unverified'});
 assert.equal(f.state.targets,before);assert.equal(f.state.pages,1);
});
