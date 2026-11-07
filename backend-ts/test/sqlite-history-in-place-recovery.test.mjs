import {StorageFailure} from '../src/storage/sqlite/contracts.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, owner, record, report, restart} from './sqlite-clear-support.mjs';

const capabilities=Object.fromEntries(['programVersion','exactSchema','declaredLocalKey','automaticAllocation','serverIdUniqueConstraint','statusColumn','statusSemantics','sourceLifecycle','restartContinuity','recoveryMapping','snapshotBarrier','partitionCoverage','normalHistory','incrementalTail','durableIncremental','durableHistory','partitionGrowth','recoverFromLocalIds'].map(key=>[key,'supported']));
function readerFixture(){
 const state={records:[record('shard-a','1'),record('shard-a','2')],readIds:[],recovered:0,positions:[],instance:0,reportOverride:{},targetOverride:{}};
 const create=()=>{
  let positions=null;const loss=Promise.withResolvers();
  const target={protocol:'private-history-v1',descriptor:`fixed-${++state.instance}`,sourceGeneration:'source-1',partitions:['shard-a'],tables:[{partition:'shard-a',instance:'table-a'}],checkedPartitions:['shard-a']};
  return {guardSession:{loss:loss.promise},
   async inspect(scope){if(state.inspectError)throw new StorageFailure(state.inspectError);return {...report,continuity:'same-source-instances-normal-use-v1',capabilities,accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation,...state.reportOverride};},
   async target(){return {...structuredClone(target),...state.targetOverride};},
   async recoverTarget(_scope,_previous,wanted){positions=wanted;state.positions=structuredClone(wanted);state.recovered++;return {target:{...structuredClone(target),...state.targetOverride},cursor:'signed-recovery',anchors:state.records.filter(r=>wanted.some(p=>p.partition===r.partition&&p.table===r.table&&p.anchorLocalIds.includes(r.localId)))};},
   async page(_scope,fixed,cursor){const records=state.records.filter(r=>!positions||positions.some(p=>p.partition===r.partition&&p.table===r.table&&BigInt(r.localId)>BigInt(p.maxLocalId)));state.readIds.push(...records.map(r=>r.localId));return {target:fixed.descriptor,cursorIn:cursor,cursorOut:null,records,completedPartitions:['shard-a'],exhausted:true,...(fixed.tables.length?{resumeCursor:'signed-tail'}:{})};},
   async tail(_scope,fixed,cursor){return {target:fixed.descriptor,cursorIn:cursor,cursorOut:cursor,records:[],caughtUp:true};},
   async close(){loss.resolve();}};
 };return {state,create};
}
test('围栏元数据一致时原地恢复，保持绑定且仅续读最大 localId 后的新消息',async t=>{
 const reader=readerFixture();
 const f=await fixture(t,{channel:reader.create(),state:reader.state,registryModule:new URL('./fixtures/history/recovery-snapshot-registry.mjs',import.meta.url).href});
 await f.current.history.synchronize(f.contactA);
 const before=await f.current.contacts.eligibility(f.contactA);
 await f.current.storage.execute('history.markContinuityLost',{token:before});
 f.channel=reader.create();await restart(f,t);
 reader.state.records.push(record('shard-a','3'));reader.state.readIds=[];
 assert.equal((await f.current.history.synchronize(f.contactA)).phase,'complete');
 assert.equal((await f.current.contacts.eligibility(f.contactA)).binding_id,before.binding_id);
 assert.equal(reader.state.recovered,1);
 assert.deepEqual(reader.state.readIds,['3']);
 assert.equal(reader.state.positions[0].maxLocalId,'2');
 assert.equal((await f.current.history.readChat(f.contactA)).messages.length,3);
 const snapshot=await f.current.storage.execute('fixture.recoverySnapshot',{ownerId:owner,contactId:f.contactA});
 assert.equal(snapshot.fences.length,0);assert.equal(snapshot.proofs.length,1);assert.equal(snapshot.proofs[0].state,'ok');assert.deepEqual(snapshot.legacyTables,[]);
 assert.deepEqual(await f.current.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

for(const [name,change] of [
 ['账号变化',r=>{r.state.reportOverride.accountKey='different-account';}],
 ['会话变化',r=>{r.state.reportOverride.conversationKey='different-conversation';}],
 ['来源代次变化',r=>{r.state.reportOverride.sourceGeneration='source-2';}],
 ['分片消失',r=>{r.state.targetOverride={partitions:[],tables:[],checkedPartitions:['shard-a']};}],
 ['表实例替换',r=>{r.state.targetOverride.tables=[{partition:'shard-a',instance:'table-replaced'}];}],
 ['文件身份变化',r=>{r.state.targetOverride.checkedPartitions=['file-replaced'];}],
 ['已存锚点被改写',r=>{r.state.records[1]={...r.state.records[1],text:'合成改写'};}],
 ['已存锚点消失',r=>{r.state.records.pop();}],
]) test(`原地恢复反例：${name}仍围栏且不读新正文`,async t=>{
 const reader=readerFixture();const f=await fixture(t,{channel:reader.create(),state:reader.state,registryModule:new URL('./fixtures/history/recovery-snapshot-registry.mjs',import.meta.url).href});
 await f.current.history.synchronize(f.contactA);const before=await f.current.contacts.eligibility(f.contactA);
 await f.current.storage.execute('history.markContinuityLost',{token:before});f.channel=reader.create();await restart(f,t);change(reader);reader.state.readIds=[];
 await assert.rejects(f.current.history.synchronize(f.contactA));
 const after=await f.current.storage.execute('fixture.recoverySnapshot',{ownerId:owner,contactId:f.contactA});
 assert.equal(after.fences.length,1);assert.equal(after.proofs.length,1);assert.equal(after.proofs[0].state,'needs_confirmation');assert.deepEqual(after.legacyTables,[]);assert.equal((await f.current.contacts.eligibility(f.contactA)).binding_id,before.binding_id);assert.deepEqual(reader.state.readIds,[]);
 assert.equal(after.messages.length,2);
});

test('正常重启缺少可用持久游标时按已存水位接续，不重读旧正文',async t=>{
 const reader=readerFixture();const f=await fixture(t,{channel:reader.create(),state:reader.state});
 await f.current.history.synchronize(f.contactA);const before=await f.current.contacts.eligibility(f.contactA);
 f.channel=reader.create();await restart(f,t);reader.state.records.push(record('shard-a','3'));reader.state.readIds=[];
 await f.current.history.synchronize(f.contactA);
 assert.deepEqual(reader.state.readIds,['3']);assert.equal((await f.current.contacts.eligibility(f.contactA)).binding_id,before.binding_id);
});

test('正常重启的锚点不一致也持久围栏，不能因此前未围栏而放行',async t=>{
 const reader=readerFixture();const f=await fixture(t,{channel:reader.create(),state:reader.state,registryModule:new URL('./fixtures/history/recovery-snapshot-registry.mjs',import.meta.url).href});
 await f.current.history.synchronize(f.contactA);f.channel=reader.create();await restart(f,t);reader.state.records[1]={...reader.state.records[1],text:'合成改写'};f.channel=reader.create();
 await assert.rejects(f.current.history.synchronize(f.contactA));
 const snapshot=await f.current.storage.execute('fixture.recoverySnapshot',{ownerId:owner,contactId:f.contactA});assert.equal(snapshot.fences.length,1);
});

test('空物理目标无正文和锚点时可仅核对元数据恢复，不要求正文恢复能力',async t=>{
 const reader=readerFixture();reader.state.records=[];reader.state.targetOverride={tables:[]};reader.state.reportOverride={profileId:'wechat-4.0.6-29387-absent-private-target-v1',declaredPrimaryKey:[],statusSemantics:'no-message-table-v1',capabilities:{...capabilities,recoverFromLocalIds:'unsupported',incrementalTail:'unsupported',durableIncremental:'unsupported',durableHistory:'unsupported'}};
 const f=await fixture(t,{channel:reader.create(),state:reader.state,registryModule:new URL('./fixtures/history/recovery-snapshot-registry.mjs',import.meta.url).href});
 await f.current.history.synchronize(f.contactA);const token=await f.current.contacts.eligibility(f.contactA);await f.current.storage.execute('history.markContinuityLost',{token});f.channel=reader.create();await restart(f,t);
 await f.current.history.synchronize(f.contactA);
 const snapshot=await f.current.storage.execute('fixture.recoverySnapshot',{ownerId:owner,contactId:f.contactA});assert.equal(snapshot.fences.length,0);assert.equal(snapshot.messages.length,0);assert.equal(reader.state.recovered,0);
});

test('旧支持档尚未声明增长能力时，经新读取器独立核对仍可原地接纳安全表增长',async t=>{
 const reader=readerFixture();const oldCapabilities={...capabilities};delete oldCapabilities.partitionGrowth;delete oldCapabilities.recoverFromLocalIds;reader.state.reportOverride={capabilities:oldCapabilities};
 const f=await fixture(t,{channel:reader.create(),state:reader.state});await f.current.history.synchronize(f.contactA);const token=await f.current.contacts.eligibility(f.contactA);await f.current.storage.execute('history.markContinuityLost',{token});
 reader.state.reportOverride={schemaFingerprint:'c'.repeat(64),capabilities};reader.state.targetOverride={tables:[{partition:'shard-a',instance:'table-a'},{partition:'shard-a',instance:'table-new'}]};f.channel=reader.create();await restart(f,t);reader.state.records.push(record('shard-a','3'));reader.state.readIds=[];
 await f.current.history.synchronize(f.contactA);assert.deepEqual(reader.state.readIds,['3']);assert.equal((await f.current.contacts.eligibility(f.contactA)).binding_id,token.binding_id);
});

test('删除最后一条来源后从抑制记录保留已读水位，不重读或恢复已删正文',async t=>{
 const reader=readerFixture();const f=await fixture(t,{channel:reader.create(),state:reader.state});await f.current.history.synchronize(f.contactA);
 const message=(await f.current.history.readChat(f.contactA)).messages.find(m=>m.text==='合成正文2');
 const plan=await f.current.deletion.plan({ownerId:owner,requestKey:'delete-last-before-restart',scope:{kind:'source',contactId:f.contactA,sourceId:message.sourceRecordIds[0]}});assert.equal((await f.current.deletion.advance(plan)).state,'completed');
 f.channel=reader.create();await restart(f,t);reader.state.records.push(record('shard-a','3'));reader.state.readIds=[];await f.current.history.synchronize(f.contactA);
 assert.deepEqual(reader.state.readIds,['3']);assert.deepEqual((await f.current.history.readChat(f.contactA)).messages.map(m=>m.text).sort(),['合成正文1','合成正文3']);
});

test('同一服务的下一次读取也必须核对恢复锚点，改写不能绕过围栏',async t=>{
 const reader=readerFixture();const f=await fixture(t,{channel:reader.create(),state:reader.state,registryModule:new URL('./fixtures/history/recovery-snapshot-registry.mjs',import.meta.url).href});
 await f.current.history.synchronize(f.contactA);reader.state.records[1]={...reader.state.records[1],text:'合成改写'};f.channel=reader.create();
 await assert.rejects(f.current.history.synchronize(f.contactA));
 const snapshot=await f.current.storage.execute('fixture.recoverySnapshot',{ownerId:owner,contactId:f.contactA});assert.equal(snapshot.fences.length,1);assert.equal(snapshot.messages.length,2);
});


test('来源暂不可核验时五次重启均停读但不新增围栏，元数据恢复后自动接续',async t=>{
 const reader=readerFixture();const f=await fixture(t,{channel:reader.create(),state:reader.state,registryModule:new URL('./fixtures/history/recovery-snapshot-registry.mjs',import.meta.url).href});await f.current.history.synchronize(f.contactA);reader.state.inspectError='history_source_unverified';reader.state.readIds=[];
 for(let i=0;i<5;i++){
  f.channel=reader.create();await restart(f,t);await assert.rejects(f.current.history.synchronize(f.contactA),{code:'history_source_unverified'});
  const snapshot=await f.current.storage.execute('fixture.recoverySnapshot',{ownerId:owner,contactId:f.contactA});assert.equal(snapshot.fences.length,0);assert.deepEqual(reader.state.readIds,[]);
 }
 reader.state.inspectError=null;reader.state.records.push(record('shard-a','3'));f.channel=reader.create();await f.current.history.synchronize(f.contactA);assert.deepEqual(reader.state.readIds,['3']);
});
