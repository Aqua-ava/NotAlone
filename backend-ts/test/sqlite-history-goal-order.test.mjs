import test from'node:test';import assert from'node:assert/strict';
import{fixture,restart,owner,record}from'./sqlite-clear-support.mjs';
const registryModule=new URL('./fixtures/history/goal-order-registry.mjs',import.meta.url).href;
for(const sameTime of [true,false])test(`历史目标以明确接受顺序选择，不受${sameTime?'同时间':'时钟回拨'}和维护行号重排影响`,async t=>{
 const f=await fixture(t,{registryModule});f.state.pageRecords=[record('shard-a','1')];
 const first=await f.current.history.synchronize(f.contactA);const second=await f.current.history.synchronize(f.contactA);
 assert.notEqual(first.goalId,second.goalId);
 await f.current.storage.execute('fixture.reorderGoals',{ownerId:owner,contactId:f.contactA,sameTime});
 assert.equal((await f.current.history.coverage(f.contactA)).goalId,second.goalId);
 await f.current.storage.execute('fixture.compact',{});await restart(f,t);
 const read=await f.current.history.read(f.contactA);assert.equal(read.coverage.goalId,second.goalId);assert.equal(read.coverage.phase,'complete');assert.equal(read.messages.length,1);
});
for(const legacyOnly of [false,true])test(`旧目标审计不能用未来时间取得当前范围${legacyOnly?'，旧库按已核验连续性范围兜底':''}`,async t=>{
 const f=await fixture(t,{registryModule});f.state.pageRecords=[record('shard-a','1')];
 await f.current.history.synchronize(f.contactA);const original=(await f.current.history.read(f.contactA)).messages[0];
 const old=await f.current.storage.execute('fixture.seedLegacyScope',{ownerId:owner,contactId:f.contactA,recordId:original.sourceRecordIds[0],otherTable:true,oldOnly:true});
 await f.current.storage.execute('fixture.reorderGoals',{ownerId:owner,contactId:f.contactA,sameTime:false});
 if(legacyOnly)await f.current.storage.execute('fixture.legacyGoalSequence',{ownerId:owner,contactId:f.contactA});
 const read=await f.current.history.read(f.contactA);assert.equal(read.coverage.quarantinedCount,0);assert.equal(read.coverage.messageCount,1);assert.deepEqual(read.messages.map(m=>m.id),[original.id]);assert.ok(read.messages[0].sourceRecordIds.includes(original.sourceRecordIds[0]));assert.ok(!read.messages[0].sourceRecordIds.includes(old.recordId));
 await assert.rejects(f.current.history.source(f.contactA,old.recordId),{code:'history_source_not_found'});
});

test('同一已核验范围的多个旧目标无顺序证明时，不凭旧完成状态或游标放行',async t=>{
 const f=await fixture(t,{registryModule});f.state.pageRecords=[record('shard-a','1')];
 await f.current.history.synchronize(f.contactA);await f.current.history.synchronize(f.contactA);
 await f.current.storage.execute('fixture.legacyConflictingGoals',{ownerId:owner,contactId:f.contactA});
 const coverage=await f.current.history.coverage(f.contactA);assert.equal(coverage.phase,'incomplete');assert.equal(coverage.failureCode,'history_goal_order_unverified');assert.equal(coverage.cursor,null);
 const token=await f.current.contacts.eligibility(f.contactA),scope=await f.current.storage.execute('history.scope',{token}),report=await f.channel.inspect(scope);
 assert.equal(await f.current.storage.execute('history.pending',{token,report}),null);
});

test('增量覆盖跳过不匹配的更新目标，并对无序号的旧目标隐藏游标',async t=>{
 const f=await fixture(t,{registryModule});f.state.pageRecords=[record('shard-a','1')];
 const history=await f.current.history.synchronize(f.contactA);
 const seed=goals=>f.current.storage.execute('fixture.coverageIncrementalGoals',{ownerId:owner,historyGoalId:history.goalId,goals});
 await seed([
  {id:'legacy-a',generation:'source-1',sequence:null},
  {id:'legacy-b',generation:'source-1',sequence:null},
  {id:'outside-current-scope',generation:'retired-source',sequence:101n},
 ]);
 const legacy=(await f.current.history.coverage(f.contactA)).incremental;
 assert.equal(legacy.goalId,'legacy-b');
 assert.equal(legacy.phase,'incomplete');
 assert.equal(legacy.failureCode,'history_goal_order_unverified');
 assert.equal(legacy.cursorPresent,false);

 await seed([{id:'ordered-current',generation:'source-1',sequence:100n}]);
 const current=(await f.current.history.coverage(f.contactA)).incremental;
 assert.equal(current.goalId,'ordered-current');
 assert.equal(current.phase,'ready');
 assert.equal(current.cursorPresent,true);
});

test('仅属于旧来源的消息隔离保持失效，但不阻挡当前独立消息的覆盖',async t=>{
 const f=await fixture(t,{registryModule});f.state.pageRecords=[record('shard-a','1')];await f.current.history.synchronize(f.contactA);
 const original=(await f.current.history.read(f.contactA)).messages[0];
 await f.current.storage.execute('fixture.seedLegacyScope',{ownerId:owner,contactId:f.contactA,recordId:original.sourceRecordIds[0],otherTable:true,oldOnly:true});
 await f.current.storage.execute('fixture.quarantineRetiredOnly',{ownerId:owner,contactId:f.contactA});
 const read=await f.current.history.read(f.contactA);assert.equal(read.coverage.phase,'complete');assert.deepEqual(read.messages.map(m=>m.id),[original.id]);
});

for(const canonical of [true,false])test(`日常续证依据canonical已核验基线，不从无序旧支持报告${canonical?'误拒':'误授'}模式`,async t=>{
 const f=await fixture(t,{registryModule});const inspect=f.channel.inspect;
 f.channel.guardSession={loss:new Promise(()=>{})};
 f.channel.inspect=async scope=>({...await inspect(scope),continuity:'same-source-instances-normal-use-v1',capabilities:Object.fromEntries(['programVersion','exactSchema','declaredLocalKey','automaticAllocation','statusColumn','statusSemantics','sourceLifecycle','restartContinuity','recoveryMapping','snapshotBarrier','partitionCoverage','normalHistory','incrementalTail'].map(key=>[key,'supported']))});
 f.state.pageRecords=[record('shard-a','1')];await f.current.history.synchronize(f.contactA);await f.current.history.close();
 await f.current.storage.execute('fixture.conflictingLegacyMode',{ownerId:owner,contactId:f.contactA,canonical,mode:canonical?'unverified':'same-source-instances-normal-use-v1'});
 const token=await f.current.contacts.eligibility(f.contactA),scope=await f.current.storage.execute('history.scope',{token});
 assert.equal(await f.current.storage.execute('history.normalUseRevalidationCandidate',{token}),canonical);
 const report=await f.channel.inspect(scope),fixed=await f.channel.target(scope);
 const prepared=await f.current.storage.execute('history.prepareNormalUseGuard',{token,report,target:fixed,guardId:'synthetic-revalidated-guard'});
 assert.equal(prepared.ok,canonical);assert.equal(prepared.revalidated,canonical);
});


test('旧目标续证不得借用另一账号的来源基线',async t=>{
 const f=await fixture(t,{registryModule});const inspect=f.channel.inspect;f.channel.guardSession={loss:new Promise(()=>{})};
 f.channel.inspect=async scope=>({...await inspect(scope),continuity:'same-source-instances-normal-use-v1',capabilities:Object.fromEntries(['programVersion','exactSchema','declaredLocalKey','automaticAllocation','statusColumn','statusSemantics','sourceLifecycle','restartContinuity','recoveryMapping','snapshotBarrier','partitionCoverage','normalHistory','incrementalTail'].map(key=>[key,'supported']))});
 f.state.pageRecords=[record('shard-a','1')];await f.current.history.synchronize(f.contactA);await f.current.history.close();
 await f.current.storage.execute('fixture.conflictingLegacyMode',{ownerId:owner,contactId:f.contactA,canonical:true,wrongAccount:true,mode:'same-source-instances-normal-use-v1'});
 const token=await f.current.contacts.eligibility(f.contactA);assert.equal(await f.current.storage.execute('history.normalUseRevalidationCandidate',{token}),false);
});
