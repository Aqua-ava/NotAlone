// 旧副本及认证审计由历史专用夹具建立；断言继续验证当前存储的删除与抑制保护。
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,owner,record,report,createChannel,target} from './sqlite-clear-support.mjs';
import {SqliteHistoryRecertifyService} from './fixtures/history/legacy-recertify-service.ts';

const registry=new URL('./fixtures/history/recall-coverage-registry.mjs',import.meta.url).href;
const OLD='legacy-source',CURRENT='source-1';
const key=(generation,localId)=>JSON.stringify([generation,'shard-a','table-a',String(localId)]);
const capabilities={normalHistory:'supported',snapshotBarrier:'supported',partitionCoverage:'supported',incrementalTail:'supported'};
const normal=(scope,artifact='b'.repeat(64))=>({...report,artifactSha256:artifact,continuity:'same-source-instances-normal-use-v1',
 accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation,
 capabilities:{...report.capabilities,...capabilities}});

/** 合成夹具：旧代次撤回记录 + 当前代次同位置独立撤回记录；不读取正文或真实数据库。 */
async function setup(t,options={}){
 const f=await fixture(t,{registryModule:registry});
 f.state.pageRecords=options.initialPages??[record('shard-a','1')];
 f.state.inspectFactory=scope=>normal(scope,'a'.repeat(64));
 f.channel.guardSession={loss:new Promise(()=>{})};
 const synced=[f.contactA,...(options.syncB?[f.contactB]:[])];
 for(const contactId of synced)await f.current.history.synchronize(contactId);
 for(const contactId of synced)
  await f.current.storage.execute('fixture.legacyRecalls',{ownerId:owner,contactId,generation:OLD,
   locals:options.oldLocals??['9'],...(options.oldReason?{reason:options.oldReason}:{})});
 for(const contactId of [f.contactA,...(options.coverB?[f.contactB]:[])])
  await f.current.storage.execute('fixture.legacyRecalls',{ownerId:owner,contactId,generation:CURRENT,append:true,
   locals:options.coverLocals??['9'],...(options.coverReason?{reason:options.coverReason}:{})});
 for(const contactId of synced)await f.current.storage.execute('history.markContinuityLost',{token:await f.current.contacts.eligibility(contactId)});
 for(const localId of options.oldTerminals??[])
  await f.current.storage.execute('fixture.recallOldTerminal',{ownerId:owner,contactId:options.oldTerminalContact??f.contactA,key:key(OLD,localId)});
 const channels=[];let proofCalls=0;
 const create=()=>{const {channel,state}=createChannel();
  state.pageRecords=options.pageRecords??[record('shard-a','1')];
  state.pageFactory=(_scope,cursor,s)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:s.pageRecords,
   completedPartitions:[...target.partitions],exhausted:true,resumeCursor:'synthetic-tail-0'});
  state.inspectFactory=scope=>normal(scope);
  channel.target=async()=>({...target,checkedPartitions:target.partitions});
  channel.guardSession={loss:new Promise(()=>{})};
  channels.push({channel,state});return channel;};
 const service=new SqliteHistoryRecertifyService(f.current.storage,f.current.contacts,create,f.current.holders,
  {stopHistory:id=>f.current.history.stop(id),...(options.prove?{proveLegacyTerminals:async()=>{proofCalls++;throw new Error('合成维护证明不应被请求');}}:{})});
 t.after(()=>service.close());
 return {...f,service,channels,snapshot:(contactId=f.contactA)=>f.current.storage.execute('fixture.recertifySnapshot',{ownerId:owner,contactId}),
  captures:(contactId=f.contactA)=>f.current.storage.execute('fixture.recallCaptures',{ownerId:owner,contactId}),proofCalls:()=>proofCalls};
}

test('全部旧代次撤回被当前代次同位置独立撤回覆盖时完成认证、解除围栏并写独立覆盖审计',async t=>{
 const f=await setup(t,{oldLocals:['25','29','31'],coverLocals:['25','29','31'],prove:true});
 const done=await f.service.recertify(f.contactA,{requestKey:randomUUID()});
 assert.equal(done.state,'completed',JSON.stringify(done));assert.equal(done.completed,true);
 assert.equal(f.proofCalls(),0,'覆盖后的旧撤回候选不应再要求维护证明');
 const snapshot=await f.snapshot();
 assert.equal(snapshot.fences.length,0);
 const op=snapshot.operations.find(row=>row.state==='completed');assert.ok(op);
 const archived=JSON.parse(op.old_fence_json);
 assert.equal(archived.legacy_terminal_mapping,undefined,'覆盖映射不得伪装成ADR-161双读取器证明');
 const audit=archived.covered_terminal_mapping;assert.ok(audit);
 assert.match(audit.digest,/^[a-f0-9]{64}$/);
 assert.equal(audit.mappings.length,3);
 for(const localId of ['25','29','31']){
  assert.ok(audit.mappings.some(mapping=>mapping.from===key(OLD,localId)&&mapping.to===key(CURRENT,localId)&&mapping.reason==='source_recalled'),localId);
 }
 const terminals=snapshot.terminals.filter(row=>row.binding_id===op.new_binding_id);
 assert.equal(terminals.length,3);
 assert.ok(terminals.every(row=>row.reason==='source_recalled'&&JSON.parse(String(row.external_key))[0]===CURRENT));
 // 旧代次资料与当前代次覆盖记录都保留；认证只新增映射与终态。
 const keys=snapshot.captures.map(row=>String(row.observed_key));
 assert.ok(keys.includes(key(OLD,'25')));assert.ok(keys.includes(key(CURRENT,'25')));
 assert.deepEqual(await f.current.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('部分覆盖时仍报suppression_unmapped，读取正文前停读且围栏保留',async t=>{
 const f=await setup(t,{oldLocals:['25','29'],coverLocals:['25']});
 const done=await f.service.recertify(f.contactA,{requestKey:randomUUID()});
 assert.equal(done.state,'failed');assert.equal(done.failure_code,'history_recertify_suppression_unmapped');
 assert.equal(f.channels.reduce((count,item)=>count+item.state.pageCalls,0),0);
 const snapshot=await f.snapshot();assert.equal(snapshot.fences.length,1);assert.equal(snapshot.operations[0].stage,'metadata');
 assert.equal((await f.current.history.readChat(f.contactA)).messages.length,0);
});

test('位置相同但当前代次或旧代次原因不是撤回时不构成覆盖',async t=>{
 for(const [name,options] of [['current-not-recalled',{coverReason:'source_system_replaced'}],['old-not-recalled',{oldReason:'source_system_replaced'}]]){
  const f=await setup(t,{oldLocals:['9'],coverLocals:['9'],...options});
  const done=await f.service.recertify(f.contactA,{requestKey:randomUUID()});
  assert.equal(done.failure_code,'history_recertify_suppression_unmapped',name);
  assert.equal((await f.snapshot()).fences.length,1,name);
  assert.equal((await f.current.history.readChat(f.contactA)).messages.length,0,name);
 }
});

test('覆盖只限同一联系人与会话，其他联系人同位置的独立撤回记录不构成覆盖',async t=>{
 const f=await setup(t,{syncB:true,coverB:false});
 const a=await f.service.recertify(f.contactA,{requestKey:'isolation-a'});
 assert.equal(a.state,'completed',JSON.stringify(a));
 const b=await f.service.recertify(f.contactB,{requestKey:'isolation-b'});
 assert.equal(b.failure_code,'history_recertify_suppression_unmapped');
 assert.equal((await f.snapshot(f.contactB)).fences.length,1);
 assert.equal((await f.current.history.readChat(f.contactB)).messages.length,0);
});

test('已完成的覆盖审计可继续支撑再次认证，后续旧候选不再要求维护证明',async t=>{
 const f=await setup(t,{oldLocals:['9'],coverLocals:['9'],prove:true});
 assert.equal((await f.service.recertify(f.contactA,{requestKey:'first-recertify'})).state,'completed');
 const removed=await f.current.storage.execute('fixture.recallDropCover',{ownerId:owner,contactId:f.contactA,generation:CURRENT});
 assert.ok(removed>=1,'应先删除当前代次同位置覆盖记录以只依赖已完成审计');
 const token=await f.current.contacts.eligibility(f.contactA);
 await f.current.storage.execute('history.markContinuityLost',{token});
 const done=await f.service.recertify(f.contactA,{requestKey:'second-recertify'});
 assert.equal(done.state,'completed',JSON.stringify(done));
 assert.equal(f.proofCalls(),0,'已完成覆盖审计仍不应请求维护证明');
});

for(const direction of ['old','new'])test(`按${direction}代次删除来源时清理两代捕获与终态，并保留两代未来排除`,async t=>{
 const f=await setup(t,{oldLocals:['9'],coverLocals:['9'],oldTerminals:['9'],
  pageRecords:[record('shard-a','1'),record('shard-a','9')]});
 const first=await f.service.recertify(f.contactA,{requestKey:`delete-${direction}`});assert.equal(first.state,'completed',JSON.stringify(first));
 const token=await f.current.contacts.eligibility(f.contactA),captures=await f.captures();
 const seed=direction==='old'
  ?captures.find(row=>row.observed_key===key(OLD,'9'))
  :captures.find(row=>row.observed_key===key(CURRENT,'9')&&row.binding_id===token.binding_id);
 assert.ok(seed,`${direction}: ${JSON.stringify(captures.map(row=>[row.observed_key,row.binding_id]))}`);
 const plan=await f.current.deletion.plan({ownerId:owner,requestKey:randomUUID(),scope:{kind:'source',contactId:f.contactA,sourceId:seed.id}});
 const planned=await f.current.storage.execute('diag.sourceIds',{operation:plan});
 const keys=planned.map(id=>captures.find(row=>row.id===id)?.observed_key);
 assert.ok(keys.includes(key(OLD,'9'))&&keys.includes(key(CURRENT,'9')),`${direction}: ${JSON.stringify(keys)}`);
 assert.equal((await f.current.deletion.advance(plan)).state,'completed');
 const snapshot=await f.snapshot();
 assert.ok(!snapshot.captures.some(row=>[key(OLD,'9'),key(CURRENT,'9')].includes(String(row.observed_key))),direction);
 assert.ok(!snapshot.terminals.some(row=>[key(OLD,'9'),key(CURRENT,'9')].includes(String(row.external_key))),direction);
 const exclusions=await f.current.storage.execute('fixture.legacyExclusions',{ownerId:owner,conversationId:token.conversation_id});
 assert.ok(exclusions.includes(key(OLD,'9')),`${direction}: ${JSON.stringify(exclusions)}`);
 assert.ok(exclusions.includes(key(CURRENT,'9')),`${direction}: ${JSON.stringify(exclusions)}`);
 // 未来再同步同一位置不能复活已删除来源。
 f.state.inspectFactory=scope=>normal(scope);f.state.pageRecords=[record('shard-a','1'),record('shard-a','9')];
 f.channel.target=async()=>({...target,checkedPartitions:target.partitions});f.channel.guardSession={loss:new Promise(()=>{})};
 await f.current.history.synchronize(f.contactA);
 const messages=(await f.current.history.readChat(f.contactA)).messages;
 assert.ok(!messages.some(message=>message.text==='合成正文9'),direction);
 assert.deepEqual(await f.current.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
