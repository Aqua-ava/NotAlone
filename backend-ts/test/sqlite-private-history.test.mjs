import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { SqliteContactService } from '../src/contacts/sqlite/service.ts';
import { SqliteHistoryService } from '../src/history/sqlite/service.ts';
const owner='00000000-0000-4000-8000-000000000001';
const report={serverAliasSemantics:'verified_within_scope',protocol:'private-history-v1',profileId:'synthetic-v1',adapterVersion:'1',status:'supported',reason:null,programVersion:'synthetic',build:'1',artifactSha256:'a'.repeat(64),schemaFingerprint:'b'.repeat(64),declaredPrimaryKey:['local_id'],identity:'source-table-local-v1',statusSemantics:'synthetic-final-rows',continuity:'synthetic-generation-1'};
const record=(id,extra={})=>({partition:'shard-a',table:'table-instance-1',localId:id,serverId:'0',sender:'contact',kind:'text',text:`合成正文${id}`,originalType:'1',sentAt:'1700000000000',timePrecision:'second',orderScheme:null,orderKey:null,stateAssurance:'verified',...extra});
async function fixture(t,options={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-history-')));
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test',...options});
 t.after(async()=>{await storage.close();await rm(root,{recursive:true,force:true});});
 const metadata={account:async()=>({externalKey:'synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-metadata-v1'}),sessions:async()=>[{externalKey:'friend-a',displayName:'合成甲',kind:'private',identityAssurance:'verified'},{externalKey:'friend-b',displayName:'合成乙',kind:'private',identityAssurance:'verified'}]};
 const contacts=new SqliteContactService(storage,owner,metadata);await contacts.initialize();
 const candidate=await contacts.detectAccount();await contacts.confirmAccount(candidate.candidate_token);await contacts.setReading(true);
 const snapshot=await contacts.candidates(true);
 const saved=await contacts.confirm(snapshot.snapshot_token,snapshot.sessions.map(s=>({locator:s.username,observed_display_name:s.display_name,expected_selection_generation:s.selection_generation})));
 const target={protocol:'private-history-v1',descriptor:'fixed-synthetic-target',partitions:['shard-a'],tables:[{partition:'shard-a',instance:'table-instance-1'}],sourceGeneration:'source-1'};
 const channel={inspect:async scope=>({...report,accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation}),target:async()=>target,page:async(_scope,_target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[record('9007199254740993'),record('2',{kind:'voice',text:'不应保存媒体转写'})],completedPartitions:['shard-a'],exhausted:true})};
 const service=new SqliteHistoryService(storage,contacts,channel);
 return {storage,contacts,channel,service,saved:saved.bindings,target,root};
}
function normalUseChannelFactory(state){
 const capabilities=Object.fromEntries(['programVersion','exactSchema','declaredLocalKey','automaticAllocation','statusColumn','statusSemantics','sourceLifecycle','restartContinuity','recoveryMapping','snapshotBarrier','partitionCoverage','normalHistory','incrementalTail'].map(key=>[key,'supported']));
 return ()=>{
  const no=++state.created;let resolveLoss;const loss=new Promise(resolve=>{resolveLoss=resolve;});
  state.lose=()=>resolveLoss();
  const target={protocol:'private-history-v1',descriptor:`normal-use-target-${no}`,partitions:['shard-a'],tables:[{partition:'shard-a',instance:state.instance??'table-instance-1'}],sourceGeneration:'source-1'};
  return {guardSession:{loss,failureCode:()=>state.failureCode??null},
   inspect:async scope=>({...report,accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation,
    continuity:'same-source-instances-normal-use-v1',capabilities}),
   target:async()=>target,
   page:async(_scope,usedTarget,cursor)=>{state.pages.push({target:usedTarget.descriptor,cursor});return {target:usedTarget.descriptor,cursorIn:cursor,cursorOut:null,
    resumeCursor:state.resumeCursor??null,records:[...(state.records??[record('1')])],completedPartitions:['shard-a'],exhausted:true};},
   tail:async(_scope,usedTarget,cursor)=>{state.tails.push({target:usedTarget.descriptor,cursor});return {target:usedTarget.descriptor,cursorIn:cursor,cursorOut:'tail-cursor-next',records:[],caughtUp:true};},
   close:async()=>{resolveLoss();state.closeCount++;state.onClose?.();}};
 };
}
async function reopenHistory(t,root,expectedDatabaseId){
 const {SqliteStorage}=await import('../src/storage/sqlite/client.ts'),{SqliteContactService}=await import('../src/contacts/sqlite/service.ts');
 const storage=await SqliteStorage.open({userData:root,intent:'open',role:'test',expectedDatabaseId});
 const contacts=new SqliteContactService(storage,owner,{account:async()=>({externalKey:'synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-metadata-v1'}),sessions:async()=>[]});
 await contacts.initialize();return {storage,contacts};
}
test('已授权单联系人历史正常入库，精确身份和非文字占位可读且覆盖完整',async t=>{
 const {service,saved,storage}=await fixture(t);const contact=saved[0].contact_id;
 assert.equal((await service.read(contact)).replyEligibility,'history_syncing');
 const coverage=await service.synchronize(contact);assert.equal(coverage.phase,'complete');assert.equal(coverage.messageCount,2);
 const result=await service.read(contact);assert.equal(result.replyEligibility,'ready');assert.equal(result.messages.length,2);
 assert.equal(result.messages.find(m=>m.kind==='voice').text,null);assert.equal(result.messages.find(m=>m.kind==='text').text,'合成正文9007199254740993');
 assert.ok(result.messages.every(m=>m.ordering==='unknown'&&m.sourceRecordIds.length===1));
 assert.equal((await service.read(saved[1].contact_id)).messages.length,0);
 assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
test('联系人HTTP目录消息数等于当前可见规范消息，来源删除即时变7、删尽变0且隔离范围',async t=>{
 const {service,contacts,channel,saved,storage,root}=await fixture(t),[a,b]=saved;
 const kinds=['text','image','voice','video','file','sticker','other','text'];
 channel.page=async(scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,completedPartitions:['shard-a'],exhausted:true,
  records:kinds.slice(0,scope.token.contact_id===a.contact_id?8:3).map((kind,index)=>record(String(index+1),{kind,text:kind==='text'?`合成计数文字${index}`:null}))});
 await service.synchronize(a.contact_id);await service.synchronize(b.contact_id);
 const {SqliteContactHttp}=await import('../src/contacts/sqlite/http.ts'),{createServer}=await import('node:http');const http=new SqliteContactHttp(contacts);
 const server=createServer(async(req,res)=>{if(!await http.handle(req,res))res.writeHead(404).end();});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const counts=async()=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/contacts`);assert.equal(response.status,200);return (await response.json()).contacts;};
 const count=async id=>(await counts()).find(row=>row.contact_id===id).data_status.message_count;
 assert.equal((await service.read(a.contact_id)).messages.length,8);assert.equal(await count(a.contact_id),8);assert.equal(await count(b.contact_id),3);
 const other=new SqliteContactService(storage,'00000000-0000-4000-8000-000000000002',{account:async()=>{throw new Error('不读取外部元数据');},sessions:async()=>[]});await other.initialize();assert.deepEqual((await other.directory()).contacts,[]);await other.close();
 const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts'),{ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');const deletion=new DeletionService(storage,service.holders,new ManagedFiles(root));
 const source=(await service.read(a.contact_id)).messages[0].sourceRecordIds[0],plan=await deletion.plan({ownerId:owner,requestKey:'synthetic-directory-source',scope:{kind:'source',contactId:a.contact_id,sourceId:source}});
 assert.equal((await service.read(a.contact_id)).messages.length,7);assert.equal(await count(a.contact_id),7);assert.equal(await count(b.contact_id),3);
 assert.equal((await deletion.advance(plan)).state,'completed');assert.equal(await count(a.contact_id),7);
 for(const message of (await service.read(a.contact_id)).messages){const clear=await deletion.plan({ownerId:owner,requestKey:`synthetic-directory-clear-${message.id}`,scope:{kind:'source',contactId:a.contact_id,sourceId:message.sourceRecordIds[0]}});assert.equal((await deletion.advance(clear)).state,'completed');}
 assert.equal((await service.read(a.contact_id)).messages.length,0);assert.equal(await count(a.contact_id),0);assert.equal(await count(b.contact_id),3);
});
test('跨分片同localId分别保存，server0不合并，补齐别名及排序变化不创建第二条',async t=>{
 const {service,channel,saved,target}=await fixture(t);target.partitions=['shard-a','shard-b'];target.tables=target.partitions.map(partition=>({partition,instance:'table-instance-1'}));
 let turn=0;channel.page=async(_s,_t,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:turn++===0?[record('1'),record('1',{partition:'shard-b'})]:[record('1',{serverId:'18446744073709551615',orderScheme:'synthetic-seq',orderKey:'100'}),record('2',{serverId:'18446744073709551615',text:'合成正文1'})],completedPartitions:target.partitions,exhausted:true});
 const contact=saved[0].contact_id;await service.synchronize(contact);assert.equal((await service.read(contact)).messages.length,2);
 await service.synchronize(contact);const result=await service.read(contact);assert.equal(result.messages.length,2);assert.equal(result.coverage.quarantinedCount,0);
 assert.equal(result.messages.find(m=>m.text==='合成正文1'&&m.sourceRecordIds.length===3)?.sourceRecordIds.length,3);
});
test('未知身份与内容冲突隔离，非文字夹带正文不保存，覆盖不能完整',async t=>{
 const {service,channel,saved,target}=await fixture(t);
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{serverId:'55'}),record('1',{serverId:'55',text:'冲突内容'}),record(null),record('4',{kind:'other',text:'媒体内容不得保存'})],completedPartitions:['shard-a'],exhausted:true});
 const contact=saved[0].contact_id;const coverage=await service.synchronize(contact);assert.equal(coverage.phase,'incomplete');assert.equal(coverage.quarantinedCount,2);
 const result=await service.read(contact);assert.equal(result.messages.length,2);assert.equal(result.replyEligibility,'history_incomplete');assert.equal(result.messages.find(m=>m.kind==='other').text,null);
});
test('未知状态的无正文来源被隔离，合法文字仍可查看但历史不完整',async t=>{
 const {service,channel,saved,target}=await fixture(t);const contact=saved[0].contact_id;
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{status:'99',stateAssurance:'unverified',sender:'unknown',text:null}),record('2',{status:'0',text:'合成合法文字'})],completedPartitions:['shard-a'],exhausted:true});
 const coverage=await service.synchronize(contact);assert.equal(coverage.phase,'incomplete');assert.equal(coverage.quarantinedCount,1);
 const result=await service.read(contact);assert.equal(result.replyEligibility,'history_incomplete');assert.deepEqual(result.messages.map(m=>m.text),['合成合法文字']);
});
test('渠道省略状态认证时不得把正文作为可信消息保存',async t=>{
 const {service,channel,saved,target}=await fixture(t);const contact=saved[0].contact_id;
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{stateAssurance:undefined,text:'不得保存的合成文字'})],completedPartitions:['shard-a'],exhausted:true});
 await service.synchronize(contact);const result=await service.read(contact);assert.equal(result.replyEligibility,'history_incomplete');assert.equal(result.messages.length,0);
});
test('已认证撤回终态撤下旧正文，但不把已完整读取的历史永久判为未知',async t=>{
 const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id;
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1')],completedPartitions:['shard-a'],exhausted:true});
 await service.synchronize(contact);const old=(await service.read(contact)).messages[0];
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{sender:'unknown',kind:'other',text:null,originalType:'10000',status:'4',messageState:'recalled'})],completedPartitions:['shard-a'],exhausted:true});
 const coverage=await service.synchronize(contact);assert.equal(coverage.phase,'complete');assert.equal(coverage.quarantinedCount,0);
 assert.equal((await service.read(contact)).messages.length,0);await assert.rejects(service.source(contact,old.sourceRecordIds[0]),{code:'history_source_not_found'});
 await service.synchronize(contact);assert.equal((await service.coverage(contact)).phase,'complete');
});

test('首次历史中的已认证撤回只保存排除位置，不成为可见消息',async t=>{
 const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id;
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{sender:'unknown',kind:'other',text:null,originalType:'10000',status:'4',messageState:'recalled'}),record('2')],completedPartitions:['shard-a'],exhausted:true});
 const coverage=await service.synchronize(contact);assert.equal(coverage.phase,'complete');assert.equal(coverage.messageCount,1);assert.equal(coverage.quarantinedCount,0);
 assert.deepEqual((await service.read(contact)).messages.map(row=>row.text),['合成正文2']);
});

test('完整增量扫描确认旧记录消失后撤下正文，缺少确认的未知记录仍保持隔离',async t=>{
 const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id;
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1')],completedPartitions:['shard-a'],exhausted:true});
 await service.synchronize(contact);const old=(await service.read(contact)).messages[0];
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{sender:'unknown',kind:'other',text:null,originalType:'unknown',status:null,messageState:'absent'})],completedPartitions:['shard-a'],exhausted:true});
 const coverage=await service.synchronize(contact);assert.equal(coverage.phase,'complete');assert.equal(coverage.quarantinedCount,0);
 assert.equal((await service.read(contact)).messages.length,0);await assert.rejects(service.source(contact,old.sourceRecordIds[0]),{code:'history_source_not_found'});
});

test('缺少精确本地身份的终态记录不能撤下整位联系人历史',async t=>{
 for(const state of ['recalled','absent']){
  const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id;
  channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1'),record('2')],completedPartitions:['shard-a'],exhausted:true});
  await service.synchronize(contact);
  channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record(null,{sender:'unknown',kind:'other',text:null,originalType:state==='recalled'?'10000':'unknown',status:null,messageState:state})],completedPartitions:['shard-a'],exhausted:true});
  const coverage=await service.synchronize(contact);assert.equal(coverage.phase,'incomplete');assert.equal((await service.read(contact)).messages.length,2);
 }
});

test('同一来源完整重扫后，已消失的旧消息撤下而现存消息保持身份',async t=>{
 const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id,inspect=channel.inspect;
 channel.inspect=async(...args)=>({...await inspect(...args),continuity:'same-source-instances-normal-use-v1'});
 channel.guardSession={loss:new Promise(()=>{})};
 let after=false;
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:after?[record('2')]:[record('1'),record('2')],completedPartitions:['shard-a'],exhausted:true});
 await service.synchronize(contact);const before=(await service.read(contact)).messages;const retained=before.find(row=>row.text==='合成正文2');
 after=true;const coverage=await service.synchronize(contact);const rows=(await service.read(contact)).messages;
 assert.equal(coverage.phase,'complete');assert.equal(rows.length,1);assert.equal(rows[0].id,retained.id);
 const missing=before.find(row=>row.text==='合成正文1');await assert.rejects(service.source(contact,missing.sourceRecordIds[0]),{code:'history_source_not_found'});
 await service.close();
});
test('普通续读范围中未知历史保持不完整，但已成功追平的新消息状态可独立就绪',async t=>{
 const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id,inspect=channel.inspect;
 channel.inspect=async(...args)=>({...await inspect(...args),continuity:'same-source-instances-normal-use-v1',capabilities:{incrementalTail:'supported'}});
 channel.guardSession={loss:new Promise(()=>{})};
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1'),record('2',{stateAssurance:'unverified',text:null})],completedPartitions:['shard-a'],exhausted:true,resumeCursor:'tail-1'});
 channel.tail=async(_scope,_target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:'tail-2',records:[],caughtUp:true});
 await service.synchronize(contact);const coverage=await service.synchronizeIncremental(contact);
 assert.equal(coverage.phase,'incomplete');assert.equal(coverage.failureCode,'history_identity_quarantined');
 assert.equal(coverage.traversalComplete,true);assert.equal(coverage.incremental.phase,'ready');assert.equal(coverage.incremental.failureCode,null);
 assert.equal(coverage.incremental.pagesAccepted,1);assert.equal((await service.read(contact)).messages.length,1);
 channel.page=async()=>{throw new Error('已完成遍历的未知历史不得复用已交接的快照');};
 assert.equal((await service.synchronize(contact)).incremental.phase,'ready');
 await service.close();
});
test('日常重启先复验完整来源，再以新目标从头重扫并重建增量检查点',async t=>{
 const f=await fixture(t),contact=f.saved[0].contact_id,state={created:0,closeCount:0,pages:[],tails:[],records:[record('1')],resumeCursor:'resume-after-history-1'};
 const first=new SqliteHistoryService(f.storage,f.contacts,normalUseChannelFactory(state));
 const initial=await first.synchronize(contact);assert.equal(initial.phase,'complete');const oldGoal=initial.goalId;
 const databaseId=f.storage.status.databaseId;await first.close();await f.storage.close();
 const reopened=await reopenHistory(t,f.root,databaseId),second=new SqliteHistoryService(reopened.storage,reopened.contacts,normalUseChannelFactory(state));t.after(async()=>{await second.close();await reopened.storage.close();});
 const staged=await second.synchronizeIncremental(contact);
 assert.equal(staged.phase,'running');assert.notEqual(staged.goalId,oldGoal,'重启后先新建完整历史目标');assert.equal(state.tails.length,0,'不能把旧不透明游标交给新原生进程');
 const rescanned=await second.synchronize(contact);assert.equal(rescanned.phase,'complete');assert.notEqual(rescanned.goalId,oldGoal);
 assert.equal(rescanned.incremental?.cursorPresent,true);assert.equal(state.pages.at(-1).cursor,null);
 const tailed=await second.synchronizeIncremental(contact);assert.equal(tailed.incremental?.phase,'ready');assert.equal(state.tails.length,1);
 await second.close();await reopened.storage.close();
});
test('normal-use 来源表实例改变时在读取正文前永久围栏',async t=>{
 const f=await fixture(t),contact=f.saved[0].contact_id,state={created:0,closeCount:0,pages:[],tails:[],records:[record('1')],resumeCursor:'resume-after-history-1'};
 const first=new SqliteHistoryService(f.storage,f.contacts,normalUseChannelFactory(state));
 await first.synchronize(contact);const databaseId=f.storage.status.databaseId;await first.close();await f.storage.close();
 const reopened=await reopenHistory(t,f.root,databaseId);state.instance='table-instance-replaced';
 const second=new SqliteHistoryService(reopened.storage,reopened.contacts,normalUseChannelFactory(state));t.after(async()=>{await second.close();await reopened.storage.close();});
 await assert.rejects(second.synchronize(contact),{code:'history_source_continuity_unverified'});
 assert.equal(state.pages.length,1,'目标元数据可检查，但改变表实例后不能调用正文页');
 assert.equal((await second.coverage(contact)).phase,'incomplete');
 await second.close();await reopened.storage.close();
});
test('日常重启的全量重扫仍保留已删除来源排除项',async t=>{
 const f=await fixture(t),contact=f.saved[0].contact_id,state={created:0,closeCount:0,pages:[],tails:[],records:[record('1'),record('2')],resumeCursor:'resume-after-history-1'};
 const first=new SqliteHistoryService(f.storage,f.contacts,normalUseChannelFactory(state));
 await first.synchronize(contact);
 const removed=(await first.read(contact)).messages.find(row=>row.text==='合成正文1');assert.ok(removed);
 const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts'),{ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');
 const deletion=new DeletionService(f.storage,first.holders,new ManagedFiles(f.root));
 const operation=await deletion.plan({ownerId:owner,requestKey:'normal-use-restart-deleted-source',scope:{kind:'source',contactId:contact,sourceId:removed.sourceRecordIds[0]}});
 assert.equal((await deletion.advance(operation)).state,'completed');
 const databaseId=f.storage.status.databaseId;await first.close();await f.storage.close();
 const reopened=await reopenHistory(t,f.root,databaseId),second=new SqliteHistoryService(reopened.storage,reopened.contacts,normalUseChannelFactory(state));
 const coverage=await second.synchronize(contact);
 assert.equal(coverage.phase,'complete');assert.deepEqual((await second.read(contact)).messages.map(row=>row.text),['合成正文2']);
 await second.close();await reopened.storage.close();
});
test('守卫明确报告 source change 时即使空闲也持久围栏',async t=>{
 const f=await fixture(t),contact=f.saved[0].contact_id,state={created:0,closeCount:0,pages:[],tails:[],records:[record('1')],resumeCursor:'resume-after-history-1'};
 const first=new SqliteHistoryService(f.storage,f.contacts,normalUseChannelFactory(state));
 await first.synchronize(contact);state.failureCode='history_source_changed';
 let closed;
 const didClose=new Promise(resolve=>{closed=resolve;});state.onClose=closed;state.lose();await didClose;
 const before=state.created,second=new SqliteHistoryService(f.storage,f.contacts,normalUseChannelFactory(state));
 await assert.rejects(second.synchronize(contact),{code:'history_source_continuity_unverified'});
 assert.equal(state.created,before,'已知来源变更的围栏在打开新渠道前拦截');
 assert.equal((await second.coverage(contact)).phase,'incomplete');
 await first.close();await second.close();
});
test('normal-use 完整遍历含未知状态时仍交接尾游标，但历史资格保持不完整',async t=>{
 const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id,inspect=channel.inspect,state={created:0,closeCount:0,pages:[],tails:[],records:[],resumeCursor:'verified-resume-cursor'};
 channel.guardSession={loss:new Promise(()=>{}),failureCode:()=>null};
 channel.inspect=async(...args)=>({...await inspect(...args),continuity:'same-source-instances-normal-use-v1',capabilities:Object.fromEntries(['programVersion','exactSchema','declaredLocalKey','automaticAllocation','statusColumn','statusSemantics','sourceLifecycle','restartContinuity','recoveryMapping','snapshotBarrier','partitionCoverage','normalHistory','incrementalTail'].map(key=>[key,'supported']))});
 channel.page=async(_scope,usedTarget,cursor)=>({target:usedTarget.descriptor,cursorIn:cursor,cursorOut:null,resumeCursor:state.resumeCursor,
  records:[record('1',{stateAssurance:'unverified',status:'unknown',text:null}),record('2')],completedPartitions:['shard-a'],exhausted:true});
 const coverage=await service.synchronize(contact);
 assert.equal(coverage.phase,'incomplete');assert.equal(coverage.traversalComplete,true);assert.equal(coverage.incremental?.cursorPresent,true);
 assert.equal(coverage.incremental?.phase,'ready');assert.equal((await service.read(contact)).replyEligibility,'history_incomplete');
 await service.close();
});
test('已见消息后续状态未知时，旧正文不能继续作为可信聊天展示',async t=>{
 const {service,channel,saved,target,storage,root,contacts}=await fixture(t);const contact=saved[0].contact_id;
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{status:'0',text:'合成旧文字'})],completedPartitions:['shard-a'],exhausted:true});
 await service.synchronize(contact);const old=(await service.read(contact)).messages[0];assert.equal(old.text,'合成旧文字');
 const {SqliteDiscussionService}=await import('../src/reply/sqlite/service.ts');const discussion=new SqliteDiscussionService(storage,owner);const d=await discussion.newDiscussion(contact);
 const key='synthetic-quarantine-request',confirmationId=await contacts.manualConfirm(contact,key);
 await discussion.begin(contact,key,'用户手写的合成内容',{kind:'manual',confirmationId},d.id);
 assert.equal((await storage.execute('discussion.messages',{ownerId:owner,contactId:contact,discussionId:d.id,messageIds:[old.id]}))[0].text_body,'合成旧文字');
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{status:'99',stateAssurance:'unverified',sender:'unknown',text:null})],completedPartitions:['shard-a'],exhausted:true});
 await service.synchronize(contact);const result=await service.read(contact);
 assert.equal(result.replyEligibility,'history_incomplete');assert.ok(!result.messages.some(m=>m.text==='合成旧文字'));
 await assert.rejects(service.source(contact,old.sourceRecordIds[0]),error=>error.code==='history_source_not_found');
 await assert.rejects(storage.execute('discussion.messages',{ownerId:owner,contactId:contact,discussionId:d.id,messageIds:[old.id]}),{code:'discussion_source_unavailable'});
 assert.equal((await discussion.view(contact,d.id)).entries[0].body,'用户手写的合成内容');
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{status:'0',text:'合成旧文字'})],completedPartitions:['shard-a'],exhausted:true});
 await service.synchronize(contact);assert.ok(!(await service.read(contact)).messages.some(m=>m.text==='合成旧文字'));
 const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts'),{ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');
 const deletion=new DeletionService(storage,service.holders,new ManagedFiles(root));
 const plan=await deletion.plan({ownerId:owner,requestKey:'synthetic-quarantined-delete',scope:{kind:'source',contactId:contact,sourceId:old.sourceRecordIds[0]}});
 assert.equal((await deletion.advance(plan)).state,'completed');assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
test('未知状态通过已认证服务端别名或缺失本地身份出现时，旧正文不能继续可见',async t=>{
 for(const localId of ['2',null]){
  const {service,channel,saved,target}=await fixture(t);const contact=saved[0].contact_id;
  channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{serverId:'55',text:'合成别名旧正文'})],completedPartitions:['shard-a'],exhausted:true});
  await service.synchronize(contact);
  channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record(localId,{serverId:'55',status:'99',stateAssurance:'unverified',sender:'unknown',text:null})],completedPartitions:['shard-a'],exhausted:true});
  await service.synchronize(contact);assert.equal((await service.read(contact)).messages.length,0);
 }
});
test('已认证的新来源状态未知时，不隐藏没有关联的旧消息',async t=>{
 const {service,channel,saved,target}=await fixture(t);const contact=saved[0].contact_id;
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1')],completedPartitions:['shard-a'],exhausted:true});await service.synchronize(contact);
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('2',{status:'99',stateAssurance:'unverified',sender:'unknown',text:null})],completedPartitions:['shard-a'],exhausted:true});await service.synchronize(contact);
 assert.deepEqual((await service.read(contact)).messages.map(m=>m.text),['合成正文1']);
});
test('已排除本地编号与其他消息的已认证别名冲突时仍隔离关联消息',async t=>{
 const {service,channel,saved,target,storage,root}=await fixture(t);const contact=saved[0].contact_id;
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{serverId:'11'}),record('2',{serverId:'55'})],completedPartitions:['shard-a'],exhausted:true});await service.synchronize(contact);
 const source=(await service.read(contact)).messages.find(m=>m.text==='合成正文1').sourceRecordIds[0];
 const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts'),{ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');const deletion=new DeletionService(storage,service.holders,new ManagedFiles(root));
 const plan=await deletion.plan({ownerId:owner,requestKey:'synthetic-excluded-alias',scope:{kind:'source',contactId:contact,sourceId:source}});assert.equal((await deletion.advance(plan)).state,'completed');
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{serverId:'55',status:'99',stateAssurance:'unverified',sender:'unknown',text:null})],completedPartitions:['shard-a'],exhausted:true});await service.synchronize(contact);
 assert.equal((await service.read(contact)).messages.length,0);
});
test('页后续校验失败或重开也不能撤销已观察的未知状态隔离',async t=>{
 const {service,channel,saved,target,storage,root}=await fixture(t);const contact=saved[0].contact_id;
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1')],completedPartitions:['shard-a'],exhausted:true});
 await service.synchronize(contact);
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:'不合法的终页游标',records:[record('1',{status:'99',stateAssurance:'unverified',sender:'unknown',text:null})],completedPartitions:['shard-a'],exhausted:true});
 await assert.rejects(service.synchronize(contact),{code:'history_page_invalid'});assert.equal((await service.read(contact)).messages.length,0);
 const databaseId=storage.status.databaseId;await service.close();await storage.close();
 const reopened=await SqliteStorage.open({userData:root,intent:'open',role:'test',expectedDatabaseId:databaseId});t.after(()=>reopened.close());
 assert.equal((await reopened.execute('history.read',{ownerId:owner,contactId:contact,limit:100})).messages.length,0);
});
test('已认证的同编号文字变为系统消息时撤下旧文字，页失败后也保持撤下',async t=>{
 const {service,channel,saved,target}=await fixture(t);const contact=saved[0].contact_id;
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{serverId:'55'}),record('2')],completedPartitions:['shard-a'],exhausted:true});await service.synchronize(contact);
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:'不合法的终页游标',records:[record('1',{serverId:'55',kind:'other',originalType:'10000',status:'4',text:null})],completedPartitions:['shard-a'],exhausted:true});
 await assert.rejects(service.synchronize(contact),{code:'history_page_invalid'});assert.deepEqual((await service.read(contact)).messages.map(m=>m.text),['合成正文2']);
});
test('页返回时同步已关闭，已观察的未知状态仍保护旧消息',async t=>{
 const {service,channel,saved,target,contacts}=await fixture(t);const contact=saved[0].contact_id;
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1')],completedPartitions:['shard-a'],exhausted:true});await service.synchronize(contact);
 channel.page=async()=>{await contacts.setReading(false);return {target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{status:'99',stateAssurance:'unverified',sender:'unknown',text:null})],completedPartitions:['shard-a'],exhausted:true};};
 await assert.rejects(service.synchronize(contact),{code:'read_not_authorized'});assert.equal((await service.read(contact)).messages.length,0);
});
test('失证来源影响跨联系人本人资料的实际依赖，不影响无关讨论',async t=>{
 const f=await fixture(t,{registryModule:new URL('./fixtures/history/quarantine-registry.mjs',import.meta.url).href}),[a,b]=f.saved;
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1'),record('2')],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(a.contact_id);const [message,secondMessage]=(await f.service.read(a.contact_id)).messages;
 const {SqliteDiscussionService}=await import('../src/reply/sqlite/service.ts'),{randomUUID}=await import('node:crypto');
 const discussion=new SqliteDiscussionService(f.storage,owner),d=await discussion.newDiscussion(b.contact_id),key='synthetic-cross-scope';
 const confirmationId=await f.contacts.manualConfirm(b.contact_id,key),attempt=(await discussion.begin(b.contact_id,key,'合成手写要求',{kind:'manual',confirmationId},d.id)).attempt,contextId=randomUUID();
 await f.storage.execute('discussion.freezeContext',{...attempt,contextId,skillRun:{packages:[],eligible:[]},items:[],at:Date.now()});
 await f.storage.execute('fixture.seedCrossContactInput',{ownerId:owner,contextId,sourceContactId:a.contact_id,messageId:message.id,recordId:message.sourceRecordIds[0]});
 const d2=await discussion.newDiscussion(b.contact_id),key2='synthetic-cross-scope-2',confirmation2=await f.contacts.manualConfirm(b.contact_id,key2);
 const attempt2=(await discussion.begin(b.contact_id,key2,'第二个合成要求',{kind:'manual',confirmationId:confirmation2},d2.id)).attempt,context2=randomUUID();
 await f.storage.execute('discussion.freezeContext',{...attempt2,contextId:context2,skillRun:{packages:[],eligible:[]},items:[],at:Date.now()});
 await f.storage.execute('fixture.seedCrossContactInput',{ownerId:owner,contextId:context2,sourceContactId:a.contact_id,messageId:secondMessage.id,recordId:secondMessage.sourceRecordIds[0]});
 const independent=await discussion.newDiscussion(b.contact_id),otherKey='synthetic-independent',otherConfirmation=await f.contacts.manualConfirm(b.contact_id,otherKey);
 const other=(await discussion.begin(b.contact_id,otherKey,'另一合成要求',{kind:'manual',confirmationId:otherConfirmation},independent.id)).attempt;
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:['1','2'].map(id=>record(id,{stateAssurance:'unverified',status:'99',sender:'unknown',text:null})),completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(a.contact_id);const impact=await f.storage.execute('fixture.quarantineImpact',{ownerId:owner});
 assert.ok(impact.requests.includes(attempt.requestId));assert.ok(impact.requests.includes(attempt2.requestId));assert.ok(!impact.requests.includes(other.requestId));
 await assert.rejects(discussion.trace(b.contact_id,d.id,attempt.requestId),{code:'discussion_unavailable'});
 assert.equal((await discussion.view(b.contact_id,independent.id)).entries[0].body,'另一合成要求');
});
test('部分分片和分页中断保持真实缺口，重试从已提交cursor继续',async t=>{
 const {service,channel,saved,target}=await fixture(t);target.partitions=['shard-a','shard-b'];target.tables=target.partitions.map(partition=>({partition,instance:'table-instance-1'}));
 let interrupted=false;channel.page=async(_s,_t,cursor)=>{if(cursor==='page-2'&&!interrupted){interrupted=true;throw new Error('synthetic interruption');}return {target:target.descriptor,cursorIn:cursor,cursorOut:cursor===null?'page-2':null,records:[record(cursor===null?'1':'2')],completedPartitions:cursor===null?['shard-a']:['shard-b'],exhausted:cursor!==null};};
 const contact=saved[0].contact_id;await assert.rejects(service.synchronize(contact));assert.equal((await service.read(contact)).coverage.cursor,'page-2');assert.equal((await service.read(contact)).replyEligibility,'history_incomplete');
 await service.synchronize(contact);assert.equal((await service.coverage(contact)).phase,'complete');assert.equal((await service.read(contact)).messages.length,2);
});
test('读取前未授权不调用正文，停读拒绝迟到页',async t=>{
 const {service,channel,saved,contacts,target}=await fixture(t);let pages=0;
 const a=saved[0],b=saved[1];await contacts.revoke(b.contact_id,b.binding_id,b.selection_generation);
 channel.page=async()=>{pages++;await contacts.setReading(false);return {target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1')],completedPartitions:['shard-a'],exhausted:true};};
 await assert.rejects(service.synchronize(b.contact_id),{code:'read_not_authorized'});assert.equal(pages,0);
 await assert.rejects(service.synchronize(a.contact_id),{code:'read_not_authorized'});assert.equal(pages,1);assert.equal((await service.read(a.contact_id)).messages.length,0);assert.notEqual((await service.coverage(a.contact_id)).phase,'complete');
});
test('05真实删除注册封禁旧页，单来源删除保留其他合法来源且不会自动恢复',async t=>{
 const {service,saved,storage,contacts}=await fixture(t,{registryModule:new URL('./fixtures/history/registry.mjs',import.meta.url).href});const contact=saved[0].contact_id;
 await service.synchronize(contact);await service.synchronize(contact);const before=await service.read(contact);const source=before.messages.find(m=>m.kind==='text').sourceRecordIds[0];
 const old=await contacts.eligibility(contact);
 const planned=await storage.execute('deletion.plan',{ownerId:owner,requestKey:'synthetic-source-delete',scope:{kind:'source',contactId:contact,sourceId:source}});
 assert.ok(planned.targets.some(t=>t.target?.domain==='history'));await assert.rejects(contacts.validate(old),{code:'read_eligibility_stale'});
 const claimed=await storage.execute('deletion.claim',{ownerId:owner,operationId:planned.operationId});
 const runner={ownerId:owner,operationId:planned.operationId,token:claimed.token,planRevision:claimed.planRevision};
 for(const item of claimed.targets)if(item.target?.kind==='row')await storage.execute('deletion.clearTarget',{...runner,targetNo:item.targetNo});
 const after=await service.read(contact);assert.equal(after.messages.length,2);assert.equal(after.messages.find(m=>m.kind==='text').sourceRecordIds.length,1);
 await service.synchronize(contact);assert.equal((await service.read(contact)).messages.find(m=>m.kind==='text').sourceRecordIds.length,1);
});
test('已删除来源的表实例失证后，重试和重开都在读取正文前停读',async t=>{
 const f=await fixture(t,{registryModule:new URL('./fixtures/history/registry.mjs',import.meta.url).href});const contact=f.saved[0].contact_id;
 await f.service.synchronize(contact);
 const source=(await f.service.read(contact)).messages.find(m=>m.kind==='text').sourceRecordIds[0];
 const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts');const {ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');
 const deletion=new DeletionService(f.storage,f.service.holders,new ManagedFiles(f.root));
 const plan=await deletion.plan({ownerId:owner,requestKey:'synthetic-source-continuity',scope:{kind:'source',contactId:contact,sourceId:source}});
 assert.equal((await deletion.advance(plan)).state,'completed');
 f.target.tables=[{partition:'shard-a',instance:'table-instance-replaced'}];let pages=0;
 f.channel.page=async()=>{pages++;throw new Error('失证时不得读取正文');};
 await assert.rejects(f.service.synchronize(contact),{code:'history_source_continuity_unverified'});assert.equal(pages,0);
 f.target.tables=[{partition:'shard-a',instance:'table-instance-1'}];
 await assert.rejects(f.service.synchronize(contact),{code:'history_source_continuity_unverified'});assert.equal(pages,0);
 await f.service.close();const old=f.storage.status;await f.storage.close();
 const reopened=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:old.databaseId,registryModule:new URL('./fixtures/history/registry.mjs',import.meta.url).href});t.after(()=>reopened.close());
 const contacts=new SqliteContactService(reopened,owner,{account:async()=>{throw new Error('不访问渠道');},sessions:async()=>[]});
 const history=new SqliteHistoryService(reopened,contacts,f.channel);t.after(()=>history.close());
 await assert.rejects(history.synchronize(contact),{code:'history_source_continuity_unverified'});assert.equal(pages,0);
 assert.equal((await history.coverage(contact)).failureCode,'history_source_continuity_unverified');
 assert.equal((await history.read(contact)).replyEligibility,'history_incomplete');
});
test('原表仍在但新增未经认证的表时，不能读取可能复现旧来源的正文',async t=>{
 const f=await fixture(t);const contact=f.saved[0].contact_id;await f.service.synchronize(contact);
 f.target.partitions.push('shard-b');f.target.tables.push({partition:'shard-b',instance:'new-table'});let pages=0;
 f.channel.page=async()=>{pages++;throw new Error('失证时不得读取正文');};
 await assert.rejects(f.service.synchronize(contact),{code:'history_source_continuity_unverified'});
 assert.equal(pages,0);
});
test('渠道报告来源失证后，即使恢复原读者也必须持续停读',async t=>{
 const f=await fixture(t);const contact=f.saved[0].contact_id;await f.service.synchronize(contact);
 const inspect=f.channel.inspect;let lost=true,pages=0;
 f.channel.inspect=async scope=>{if(lost){const {StorageFailure}=await import('../src/storage/sqlite/contracts.ts');throw new StorageFailure('history_source_changed');}return inspect(scope);};
 f.channel.page=async()=>{pages++;throw new Error('失证时不得读取正文');};
 await assert.rejects(f.service.synchronize(contact),{code:'history_source_changed'});lost=false;
 await assert.rejects(f.service.synchronize(contact),{code:'history_source_continuity_unverified'});
 assert.equal(pages,0);assert.equal((await f.service.coverage(contact)).failureCode,'history_source_continuity_unverified');
});
test('失证与关闭同步交错时仍持久停读，重新开启不能恢复',async t=>{
 const f=await fixture(t);const contact=f.saved[0].contact_id;await f.service.synchronize(contact);
 const inspect=f.channel.inspect;let lost=true,pages=0;
 f.channel.inspect=async scope=>{if(lost){await f.contacts.setReading(false);const {StorageFailure}=await import('../src/storage/sqlite/contracts.ts');throw new StorageFailure('history_source_changed');}return inspect(scope);};
 f.channel.page=async()=>{pages++;throw new Error('失证时不得读取正文');};
 await assert.rejects(f.service.synchronize(contact),{code:'history_source_changed'});lost=false;await f.contacts.setReading(true);
 await assert.rejects(f.service.synchronize(contact),{code:'history_source_continuity_unverified'});assert.equal(pages,0);
});
test('首次建目标前失证不毒化空范围，后续显式唤醒可从头读取',async t=>{
 const f=await fixture(t);const contact=f.saved[0].contact_id;const inspect=f.channel.inspect;let lost=true,pages=0;
 f.channel.inspect=async scope=>{if(lost){const {StorageFailure}=await import('../src/storage/sqlite/contracts.ts');throw new StorageFailure('history_source_changed');}return inspect(scope);};
 f.channel.page=async(_scope,target,cursor)=>{pages++;return {target:target.descriptor,cursorIn:cursor,cursorOut:null,
  records:[record('1')],completedPartitions:['shard-a'],exhausted:true};};
 await assert.rejects(f.service.synchronize(contact),{code:'history_source_changed'});lost=false;
 const retried=await f.service.synchronize(contact);assert.equal(retried.phase,'complete',JSON.stringify(retried));assert.equal(pages,1);
 assert.equal((await f.service.read(contact)).messages[0].text,'合成正文1');
});
test('删除等待在途读取释放，超时不得完成，迟到页不能提交',async t=>{
 const {service,channel,saved,storage,target,root}=await fixture(t,{registryModule:new URL('./fixtures/history/registry.mjs',import.meta.url).href});const contact=saved[0].contact_id;
 await service.synchronize(contact);const source=(await service.read(contact)).messages[0].sourceRecordIds[0];
 let entered;const reading=new Promise(r=>entered=r);let release;const pending=new Promise(r=>release=r);
 channel.page=async()=>{entered();await pending;return {target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('10')],completedPartitions:['shard-a'],exhausted:true};};
 const run=service.synchronize(contact);run.catch(()=>{});await reading;
 const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts');const {ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');
 const deletion=new DeletionService(storage,service.holders,new ManagedFiles(root),{drainTimeoutMs:25});
 assert.equal(typeof source,'string');assert.equal(typeof contact,'string');
 const plan=await deletion.plan({ownerId:owner,requestKey:'active-source',scope:{kind:'source',contactId:contact,sourceId:source}}).catch(e=>{throw new Error('plan stage',{cause:e});});
 const blocked=await deletion.advance({ownerId:owner,operationId:plan.operationId}).catch(e=>{throw new Error('advance stage',{cause:e});});assert.equal(blocked.state,'blocked');
 release();await assert.rejects(run,{code:'history_interrupted'});
 const done=await deletion.advance({ownerId:owner,operationId:plan.operationId});assert.equal(done.state,'completed',JSON.stringify({checks:done.checks,targets:done.targets.map(t=>({kind:t.target?.rowKind,state:t.state}))}));
 assert.equal((await service.read(contact)).messages.length,1);
});
test('实际来源引用不可被重复读取改写，非文字来源不含正文或任意媒体字段',async t=>{
 const {service,channel,saved,target}=await fixture(t);const contact=saved[0].contact_id;await service.synchronize(contact);
 const initial=await service.read(contact);const voice=initial.messages.find(m=>m.kind==='voice');const sourceId=voice.sourceRecordIds[0];
 const before=await service.source(contact,sourceId);assert.equal(before.messageId,voice.id);assert.doesNotMatch(JSON.stringify(before.raw),/不应保存/);
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('2',{kind:'voice',text:'另一段媒体',url:'https://media.invalid'})],completedPartitions:['shard-a'],exhausted:true});
 await service.synchronize(contact);assert.deepEqual(await service.source(contact,sourceId),before);
 await assert.rejects(service.source(saved[1].contact_id,sourceId),{code:'history_source_not_found'});
});
test('外部账号或来源在页返回后变化，提交前复验拒绝正文与覆盖',async t=>{
 const {service,channel,saved}=await fixture(t);let inspected=0;
 channel.inspect=async scope=>({...report,accountKey:inspected++===0?scope.accountKey:'other-account',conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation});
 await assert.rejects(service.synchronize(saved[0].contact_id),{code:'history_external_scope_changed'});
 assert.equal((await service.read(saved[0].contact_id)).messages.length,0);
});
test('真正重开同一SQLite实例保留消息、来源和中断cursor，旧运行租约作废',async t=>{
 const f=await fixture(t);const contact=f.saved[0].contact_id;let stage=0;
 f.channel.page=async(_s,_t,cursor)=>{if(stage++===1)throw new Error('synthetic');return {target:f.target.descriptor,cursorIn:cursor,cursorOut:cursor===null?'page-2':null,records:[record(cursor===null?'1':'2')],completedPartitions:cursor===null?[]:['shard-a'],exhausted:cursor!==null};};
 await assert.rejects(f.service.synchronize(contact));const oldLease=f.storage.status;await f.service.close();await f.storage.close();
 const reopened=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:oldLease.databaseId});t.after(()=>reopened.close());
 const metadata={account:async()=>({externalKey:'synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-metadata-v1'}),sessions:async()=>[]};
 const contacts=new SqliteContactService(reopened,owner,metadata);const history=new SqliteHistoryService(reopened,contacts,f.channel);
 assert.equal((await history.coverage(contact)).cursor,'page-2');assert.equal((await history.read(contact)).messages.length,1);
 await assert.rejects(reopened.execute('history.read',{ownerId:owner,contactId:contact,limit:20},oldLease));
 assert.equal((await history.synchronize(contact)).phase,'complete');assert.equal((await history.read(contact)).messages.length,2);
});
test('正式HTTP消息路径可分页且只读，跨联系人游标与owner不能读到他人资料',async t=>{
 const {service,saved,channel}=await fixture(t);const contact=saved[0].contact_id;await service.synchronize(contact);
 const {createServer}=await import('node:http');const {SqliteHistoryHttp}=await import('../src/history/sqlite/http.ts');const handler=new SqliteHistoryHttp(service);
 const server=createServer(async(req,res)=>{if(!await handler.handle(req,res)){res.writeHead(404);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base=`http://127.0.0.1:${server.address().port}`;channel.page=async()=>{throw new Error('GET must not read channel');};
 const first=await (await fetch(`${base}/api/contacts/${contact}/messages?limit=1`)).json();assert.equal(first.messages.length,1);assert.ok(first.next_cursor);assert.equal(first.messages[0].text,null);
 const second=await (await fetch(`${base}/api/contacts/${contact}/messages?limit=1&before=${first.next_cursor}`)).json();assert.equal(second.messages[0].text,'合成正文9007199254740993');
 const denied=await fetch(`${base}/api/contacts/${saved[1].contact_id}/messages?before=${first.next_cursor}`);assert.notEqual(denied.status,200);
 const other=await fetch(`${base}/api/contacts/00000000-0000-4000-8000-000000000099/messages`);assert.notEqual(other.status,200);
});
test('来源消息游标覆盖同事务回滚，响应重放幂等且身份正文受约束',async t=>{
 const {service,saved,storage,contacts,channel,target}=await fixture(t,{registryModule:new URL('./fixtures/history/atomic-registry.mjs',import.meta.url).href});const a=saved[0],b=saved[1];
 const token=await contacts.eligibility(a.contact_id);const scope=await storage.execute('history.scope',{token});const support=await channel.inspect(scope);
 const {randomUUID}=await import('node:crypto');const goalId=randomUUID();await storage.execute('history.preflightContinuity',{token,target});await storage.execute('history.begin',{token,target,report:support,id:goalId,at:Date.now()});
 const input={token,goalId,captureId:randomUUID(),runtimeToken:storage.status.runtimeId,at:Date.now(),page:await channel.page(scope,target,null)};
 await assert.rejects(storage.execute('fixture.acceptThenFail',input));assert.equal((await service.read(a.contact_id)).messages.length,0);assert.equal((await service.coverage(a.contact_id)).pageCount,0);
 await storage.execute('history.acceptPage',input);await storage.execute('history.acceptPage',input);assert.equal((await service.coverage(a.contact_id)).pageCount,1);
 const voice=(await service.read(a.contact_id)).messages.find(m=>m.kind==='voice');
 const message=(await service.read(a.contact_id)).messages.find(m=>m.kind==='text');
 assert.equal(await storage.execute('fixture.assertSource',{owner_id:owner,contact_id:a.contact_id,record_id:message.sourceRecordIds[0],message_id:message.id}),true);
 await assert.rejects(storage.execute('fixture.assertSource',{owner_id:owner,contact_id:b.contact_id,record_id:message.sourceRecordIds[0],message_id:message.id}),{code:'history_source_not_available'});
 await assert.rejects(storage.execute('fixture.constraints',{kind:'record',owner,message:message.id,record:voice.sourceRecordIds[0]}));
 await assert.rejects(storage.execute('fixture.constraints',{kind:'body',owner,message:message.id}));
 await assert.rejects(storage.execute('fixture.constraints',{kind:'alias',owner,contact:b.contact_id,binding:b.binding_id,message:message.id}));
});
test('可靠排序后补保留内部身份与旧来源，未知时间可合法补齐',async t=>{
 const {service,channel,saved,target}=await fixture(t);const contact=saved[0].contact_id;let turn=0;
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',turn++===0?{sentAt:null,timePrecision:null}:{serverId:'5',orderScheme:'synthetic-seq',orderKey:'9007199254740993'})],completedPartitions:['shard-a'],exhausted:true});
 await service.synchronize(contact);const before=(await service.read(contact)).messages[0];const provenance=await service.source(contact,before.sourceRecordIds[0]);
 await service.synchronize(contact);const after=(await service.read(contact)).messages[0];assert.equal(after.id,before.id);assert.equal(after.orderKey,'9007199254740993');assert.equal(after.ordering,'unknown');assert.equal(after.sentAt,'1700000000000');assert.equal(after.sourceRecordIds.length,2);assert.deepEqual(await service.source(contact,provenance.recordId),provenance);
});
test('能力三值分别保留，真实未认证适配器不读正文，不能冒充正常路径',async t=>{
 const {createWechatHistoryChannel}=await import('../src/history/sqlite/wechat-channel.ts');const unavailable=createWechatHistoryChannel();
 assert.equal((await unavailable.inspect({})).status,'unverified');await assert.rejects(unavailable.target({}),{code:'history_support_unverified'});
 const {service,channel,saved}=await fixture(t);let pages=0;channel.page=async()=>{pages++;throw new Error('must not read');};
 channel.inspect=async scope=>({...report,accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation,status:'unsupported'});
 await assert.rejects(service.synchronize(saved[0].contact_id),{code:'history_support_unsupported'});assert.equal(pages,0);
});
test('未认证支持档保留已知缺口原因，未知原因不泄露且不打开正文目标',async t=>{
 const {service,channel,saved}=await fixture(t);let targets=0,pages=0;
 channel.target=async()=>{targets++;throw new Error('不得打开正文目标');};
 channel.page=async()=>{pages++;throw new Error('不得读取正文');};
 for(const reason of ['history_message_state_unverified','history_source_lifecycle_unverified','history_snapshot_runtime_proof_required','history_partition_coverage_runtime_proof_required','private_internal_reason']){
  channel.inspect=async scope=>({...report,accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation,status:'unverified',reason});
  await assert.rejects(service.synchronize(saved[0].contact_id),{code:reason==='private_internal_reason'?'history_support_unverified':reason});
 }
 assert.equal(targets,0);assert.equal(pages,0);
});
test('source删除接收即撤下待删来源，旧删除refresh不误停新代次合法消息',async t=>{
 const {service,channel,saved,storage,target,root}=await fixture(t,{registryModule:new URL('./fixtures/history/registry.mjs',import.meta.url).href});const contact=saved[0].contact_id;
 await service.synchronize(contact);const original=(await service.read(contact)).messages.find(m=>m.kind==='text');const source=original.sourceRecordIds[0];
 const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts');const {ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');const deletion=new DeletionService(storage,service.holders,new ManagedFiles(root));
 const plan=await deletion.plan({ownerId:owner,requestKey:'old-new-generation',scope:{kind:'source',contactId:contact,sourceId:source}});
 await assert.rejects(storage.execute('fixture.assertSource',{owner_id:owner,contact_id:contact,record_id:source,message_id:original.id}),{code:'history_source_not_available'});
 await assert.rejects(service.source(contact,source),{code:'history_source_not_found'});assert.equal((await service.read(contact)).messages.length,1);
 let entered;const reading=new Promise(r=>entered=r);let release;const page=new Promise(r=>release=r);
 channel.page=async()=>{entered();await page;return {target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('10')],completedPartitions:['shard-a'],exhausted:true};};
 const run=service.synchronize(contact);run.catch(()=>{});await reading;
 assert.equal((await deletion.advance({ownerId:owner,operationId:plan.operationId})).state,'completed');release();assert.equal((await run).phase,'complete');
 assert.ok((await service.read(contact)).messages.some(m=>m.text==='合成正文10'));
});
test('最后来源删除保留已知服务端别名抑制，长出现键不阻断删除注册',async t=>{
 const f=await fixture(t,{registryModule:new URL('./fixtures/history/registry.mjs',import.meta.url).href});const contact=f.saved[0].contact_id;f.target.partitions=['p'.repeat(180)];f.target.tables=[{partition:f.target.partitions[0],instance:'t'.repeat(180)}];let next=false;
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record(next?'2':'1',{partition:f.target.partitions[0],table:'t'.repeat(180),serverId:'9007199254740993',text:'合成同一消息'})],completedPartitions:f.target.partitions,exhausted:true});
 await f.service.synchronize(contact);const source=(await f.service.read(contact)).messages[0].sourceRecordIds[0];
 const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts');const {ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');const deletion=new DeletionService(f.storage,f.service.holders,new ManagedFiles(f.root));
 const plan=await deletion.plan({ownerId:owner,requestKey:'alias-excluded-large-key',scope:{kind:'source',contactId:contact,sourceId:source}});
 assert.equal((await deletion.advance({ownerId:owner,operationId:plan.operationId})).state,'completed');next=true;
 await f.service.synchronize(contact);assert.equal((await f.service.read(contact)).messages.length,0);
});
test('固定目标之外的表实例不能伪装已认证来源',async t=>{
 const {service,channel,saved,target}=await fixture(t);target.tables=[{partition:'shard-a',instance:'table-instance-1'}];
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{table:'unverified-instance'})],completedPartitions:['shard-a'],exhausted:true});
 const coverage=await service.synchronize(saved[0].contact_id);assert.equal(coverage.phase,'incomplete');assert.equal(coverage.quarantinedCount,1);assert.equal((await service.read(saved[0].contact_id)).messages.length,0);
});
test('未核验服务端别名唯一性时不凭相同正文合并不同本地身份',async t=>{
 const {service,channel,saved,target}=await fixture(t);const inspect=channel.inspect;
 channel.inspect=async scope=>({...await inspect(scope),serverAliasSemantics:'unverified'});
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{serverId:'55',text:'同文同秒'}),record('2',{serverId:'55',text:'同文同秒'})],completedPartitions:['shard-a'],exhausted:true});
 await service.synchronize(saved[0].contact_id);assert.equal((await service.read(saved[0].contact_id)).messages.length,2);
});
