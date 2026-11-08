import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { SqliteContactService } from '../src/contacts/sqlite/service.ts';
import { SqliteHistoryService } from '../src/history/sqlite/service.ts';
import { SqliteHistoryHttp } from '../src/history/sqlite/http.ts';
import { EventEmitter } from 'node:events';
const owner='00000000-0000-4000-8000-000000000001';
const report={serverAliasSemantics:'verified_within_scope',protocol:'private-history-v1',profileId:'synthetic-v1',adapterVersion:'1',status:'supported',reason:null,programVersion:'synthetic',build:'1',artifactSha256:'a'.repeat(64),schemaFingerprint:'b'.repeat(64),declaredPrimaryKey:['local_id'],identity:'source-table-local-v1',statusSemantics:'synthetic-final-rows',continuity:'synthetic-generation-1'};
const absentReport=base=>({...base,profileId:'wechat-4.0.6-29387-absent-private-target-v1',declaredPrimaryKey:[],statusSemantics:'no-message-table-v1',continuity:'same-source-instances-normal-use-v1',
 capabilities:{programVersion:'supported',exactSchema:'supported',declaredLocalKey:'unsupported',automaticAllocation:'unsupported',statusColumn:'unsupported',statusSemantics:'supported',sourceLifecycle:'supported',restartContinuity:'supported',recoveryMapping:'supported',snapshotBarrier:'supported',partitionCoverage:'supported',normalHistory:'supported',incrementalTail:'unsupported'}});
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
test('聊天首页按消息时间取最近记录，后入库的多年历史不挤掉近期消息且分页不漏',async t=>{
 const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id;
 const recent=record('1',{sentAt:String(Date.parse('2026-10-29T12:00:00Z'))});
 const old=record('2',{sentAt:String(Date.parse('2021-10-14T12:00:00Z'))});
 const latest=record('3',{sentAt:String(Date.parse('2026-10-31T12:00:00Z'))});
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[recent,old,latest],completedPartitions:target.partitions,exhausted:true});
 await service.synchronize(contact);
 const http=new SqliteHistoryHttp(service);
 async function page(before){
  const req=Object.assign(new EventEmitter(),{method:'GET',url:`/api/contacts/${contact}/history-messages?limit=2${before?`&before=${before}`:''}`});
  let status,body;const res={writeHead:code=>{status=code;},end:value=>{body=JSON.parse(value);}};
  assert.equal(await http.handle(req,res),true);assert.equal(status,200);return body;
 }
 const first=await page();
 assert.deepEqual(first.messages.map(m=>m.occurred_at),['2026-10-31T12:00:00.000Z','2026-10-29T12:00:00.000Z']);
 const older=await page(first.next_cursor);
 assert.deepEqual(older.messages.map(m=>m.occurred_at),['2021-10-14T12:00:00.000Z']);
 assert.equal(older.next_cursor,null);
 assert.equal(new Set([...first.messages,...older.messages].map(m=>m.message_id)).size,3);
 assert.deepEqual((await service.read(contact,{limit:2})).messages.map(m=>m.sentAt),[latest.sentAt,old.sentAt],'旧消息读取仍使用原保存游标');
 await assert.rejects(service.readChat(saved[1].contact_id,{before:first.next_cursor}),{code:'history_cursor_invalid'});
 const same=record('4',{sentAt:latest.sentAt});
 const unknownA=record('5',{sentAt:null,timePrecision:null}),unknownB=record('6',{sentAt:null,timePrecision:null});
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[recent,old,latest,same,unknownA,unknownB],completedPartitions:target.partitions,exhausted:true});
 await service.synchronize(contact);
 const pages=[];let cursor;
 do {const result=await page(cursor);pages.push(...result.messages);cursor=result.next_cursor;}while(cursor);
 assert.deepEqual(pages.map(m=>m.occurred_at),['2026-10-31T12:00:00.000Z','2026-10-31T12:00:00.000Z','2026-10-29T12:00:00.000Z','2021-10-14T12:00:00.000Z',null,null]);
 assert.equal(new Set(pages.map(m=>m.message_id)).size,6,'同时间与未知时间跨页无重复或遗漏');
 assert.ok(pages.every(m=>m.ordering==='unknown'),'展示时间不认证渠道的精确先后');
});
test('已有占位按原始类型细分计数，联系人与系统元数据保持隔离且不改变正文资格',async t=>{
 const {service,channel,saved,target}=await fixture(t);const [a,b]=saved;
 const items=[record('1'),record('2',{kind:'image',text:null,originalType:'3'}),
  ...['244813135921','244813135921','21474836529','999'].map((originalType,index)=>record(String(index+3),{
   kind:'other',text:null,originalType,stateAssurance:'unverified',metadataOnly:true})),
  record('7',{kind:'other',text:null,originalType:'10000',sender:'unknown',stateAssurance:'unverified',metadataOnly:true})];
 channel.page=async(scope,_target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,
  records:scope.token.contact_id===a.contact_id?items:[record('8',{kind:'sticker',text:null,originalType:'47'})],
  completedPartitions:target.partitions,exhausted:true});
 await service.synchronize(a.contact_id);await service.synchronize(b.contact_id);
 const read=await service.read(a.contact_id),other=await service.coverage(b.contact_id);
 assert.equal(read.coverage.messageCount,6);assert.equal(read.coverage.nonTextCount,5);assert.equal(read.coverage.metadataOnlyCount,1);
 assert.deepEqual(read.coverage.nonTextTypes,[
  {messageType:'image',label:'图片',count:1},{messageType:'quote',label:'引用回复',count:2},
  {messageType:'link',label:'链接',count:1},{messageType:'other',label:'其他消息（未识别）',count:1}]);
 assert.deepEqual(other.nonTextTypes,[{messageType:'sticker',label:'表情包',count:1}]);
 const quotes=read.messages.filter(row=>row.originalType==='244813135921');
 assert.equal(quotes.length,2);assert.ok(quotes.every(row=>row.kind==='other'&&row.text===null));
 const {projectHistorySyncStatus}=await import('../src/history/sqlite/http.ts');
 assert.deepEqual(projectHistorySyncStatus({},[read.coverage]).cli_history_coverages[0].non_text_types,[
  {message_type:'image',label:'图片',count:1},{message_type:'quote',label:'引用回复',count:2},
  {message_type:'link',label:'链接',count:1},{message_type:'other',label:'其他消息（未识别）',count:1}]);
});
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

test('命名空历史支持档须覆盖全部缺表分片，不伪造主键或增量能力',async t=>{
 const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id,inspect=channel.inspect;
 target.partitions=['shard-a','shard-b'];target.tables=[];
 channel.guardSession={loss:new Promise(()=>{})};
 channel.inspect=async(...args)=>absentReport(await inspect(...args));
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[],completedPartitions:[...target.partitions],exhausted:true});
 const coverage=await service.synchronize(contact);
 assert.equal(coverage.phase,'complete');assert.equal(coverage.traversalComplete,true);assert.equal(coverage.messageCount,0);
 assert.equal(coverage.incremental.phase,'unavailable');assert.equal((await service.read(contact)).messages.length,0);
 assert.equal(await service.bodyAvailable([contact]),false);
 await service.close();
});

test('空历史证明不接受伪造正文、尾游标、主键事实或遗漏分片',async t=>{
 for(const variant of ['ordinary-profile','tail-promoted','records','resume-cursor','present-table','missing-partition'])await t.test(variant,async t=>{
  const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id,inspect=channel.inspect;
  target.partitions=['shard-a','shard-b'];target.tables=[];channel.guardSession={loss:new Promise(()=>{})};
  channel.inspect=async(...args)=>{
   const value=absentReport(await inspect(...args));if(variant==='ordinary-profile')value.profileId='unverified-empty';
   if(variant==='tail-promoted')value.capabilities.incrementalTail='supported';return value;
  };
  if(variant==='present-table')target.tables=[{partition:'shard-a',instance:'table-instance-1'}];
  channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:variant==='records'?[record('1')]:[],
   completedPartitions:variant==='missing-partition'?['shard-a']:[...target.partitions],exhausted:true,...(variant==='resume-cursor'?{resumeCursor:'forged-tail'}:{})});
  try{
   if(variant==='missing-partition'){
    const coverage=await service.synchronize(contact);assert.equal(coverage.traversalComplete,false);assert.equal(coverage.phase,'incomplete');
   }else await assert.rejects(service.synchronize(contact),{code:['ordinary-profile','tail-promoted'].includes(variant)?'history_support_unverified':variant==='present-table'?'history_target_unverified':'history_page_invalid'});
   assert.equal((await service.read(contact)).messages.length,0);
  }finally{await service.close();}
 });
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
 assert.equal(result.messages.find(m=>m.text==='合成正文1'&&m.sourceRecordIds.length===2)?.sourceRecordIds.length,2);
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
test('首次终态及未知状态升级的撤回记录不会被后续正常记录复活',async t=>{
 for(const terminal of ['recalled'])for(const prior of ['none','unverified'])await t.test(`${prior}-${terminal}`,async t=>{
  const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id;
  let records=[];channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records,completedPartitions:['shard-a'],exhausted:true});
  if(prior==='unverified'){
   records=[record('1')];await service.synchronize(contact);
   records=[record('1',{stateAssurance:'unverified',sender:'unknown',text:null})];await service.synchronize(contact);
  }
  records=[record('1',{sender:'unknown',kind:'other',text:null,originalType:terminal==='recalled'?'10000':'unknown',messageState:terminal})];
  await service.synchronize(contact);assert.equal((await service.read(contact)).messages.length,0);
  records=[record('1')];await service.synchronize(contact);const result=await service.read(contact);
  assert.equal(result.messages.length,0);assert.equal(result.coverage.phase,'complete');assert.equal(result.coverage.quarantinedCount,0);
 });
});

test('来源消失后保留已同步消息及正常使用资格',async t=>{
 const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id;
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1')],completedPartitions:['shard-a'],exhausted:true});
 await service.synchronize(contact);const old=(await service.read(contact)).messages[0];
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{sender:'unknown',kind:'other',text:null,originalType:'unknown',status:null,messageState:'absent'})],completedPartitions:['shard-a'],exhausted:true});
 const coverage=await service.synchronize(contact);assert.equal(coverage.phase,'complete');assert.equal(coverage.quarantinedCount,0);
 assert.equal((await service.read(contact)).messages[0].text,old.text);assert.equal((await service.source(contact,old.sourceRecordIds[0])).messageId,old.id);
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

test('同一来源完整重扫后，已保存但未再次出现的消息仍保留',async t=>{
 const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id,inspect=channel.inspect;
 channel.inspect=async(...args)=>({...await inspect(...args),continuity:'same-source-instances-normal-use-v1'});
 channel.guardSession={loss:new Promise(()=>{})};
 let after=false;
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:after?[record('2')]:[record('1'),record('2')],completedPartitions:['shard-a'],exhausted:true});
 await service.synchronize(contact);const before=(await service.read(contact)).messages;const retained=before.find(row=>row.text==='合成正文2');
 after=true;const coverage=await service.synchronize(contact);const rows=(await service.read(contact)).messages;
 assert.equal(coverage.phase,'complete');assert.equal(rows.length,2);assert.equal(rows.find(row=>row.text==='合成正文2').id,retained.id);
 const missing=before.find(row=>row.text==='合成正文1');assert.equal(rows.find(row=>row.text==='合成正文1').id,missing.id);assert.equal((await service.source(contact,missing.sourceRecordIds[0])).messageId,missing.id);
 await service.close();
});
test('未知状态的旧消息不会因完整重扫未出现而推断消失',async t=>{
 const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id,inspect=channel.inspect;
 target.partitions=['shard-a','shard-b'];target.tables=target.partitions.map(partition=>({partition,instance:'table-instance-1'}));
 channel.inspect=async(...args)=>({...await inspect(...args),continuity:'same-source-instances-normal-use-v1'});channel.guardSession={loss:new Promise(()=>{})};
 let records=[record('1'),record('2')],completedPartitions=[...target.partitions];
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records,completedPartitions,exhausted:true});
 await service.synchronize(contact);
 records=[record('1',{stateAssurance:'unverified',sender:'unknown',text:null}),record('2')];await service.synchronize(contact);
 records=[record('2')];completedPartitions=['shard-a'];
 assert.equal((await service.synchronize(contact)).phase,'incomplete');assert.equal((await service.coverage(contact)).quarantinedCount,1);
 completedPartitions=[...target.partitions];const complete=await service.synchronize(contact);
 assert.equal(complete.phase,'incomplete');assert.equal(complete.quarantinedCount,1);
 records=[record('1'),record('2')];await service.synchronize(contact);
 assert.deepEqual((await service.read(contact)).messages.map(row=>row.text).sort(),['合成正文1','合成正文2']);await service.close();
});
test('仅隔离出现键未再次出现时保持待核验，之后可经同源确认恢复',async t=>{
 const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id,inspect=channel.inspect;
 channel.inspect=async(...args)=>({...await inspect(...args),continuity:'same-source-instances-normal-use-v1'});channel.guardSession={loss:new Promise(()=>{})};
 let records=[record('1',{stateAssurance:'unverified',sender:'unknown',text:null})],completedPartitions=['shard-a'];
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records,completedPartitions,exhausted:true});
 await service.synchronize(contact);assert.equal((await service.coverage(contact)).quarantinedCount,1);
 records=[];completedPartitions=[];await service.synchronize(contact);assert.equal((await service.coverage(contact)).quarantinedCount,1);
 completedPartitions=['shard-a'];const complete=await service.synchronize(contact);
 assert.equal(complete.phase,'incomplete');assert.equal(complete.quarantinedCount,1);
 records=[record('1'),record('2')];await service.synchronize(contact);
 assert.deepEqual((await service.read(contact)).messages.map(message=>message.text).sort(),['合成正文1','合成正文2']);assert.equal((await service.coverage(contact)).phase,'complete');await service.close();
});
test('终态来源的长精确出现键不阻断正常来源删除',async t=>{
 const f=await fixture(t),contact=f.saved[0].contact_id,table='terminal-table-'+ 'x'.repeat(480);f.target.tables[0].instance=table;
 let records=[record('1',{table})];f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records,completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contact);const source=(await f.service.read(contact)).messages[0].sourceRecordIds[0];
 records=[record('1',{table,sender:'unknown',kind:'other',text:null,originalType:'10000',messageState:'recalled'})];await f.service.synchronize(contact);
 const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts'),{ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');
 const deletion=new DeletionService(f.storage,f.service.holders,new ManagedFiles(f.root));
 const plan=await deletion.plan({ownerId:owner,requestKey:'long-terminal-source',scope:{kind:'source',contactId:contact,sourceId:source}});
 assert.equal((await deletion.advance(plan)).state,'completed');assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
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
test('增量重新认证历史未知出现后恢复完整覆盖，不重新打开已交接快照',async t=>{
 const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id,inspect=channel.inspect;
 channel.inspect=async(...args)=>({...await inspect(...args),continuity:'same-source-instances-normal-use-v1',capabilities:{incrementalTail:'supported'}});
 channel.guardSession={loss:new Promise(()=>{})};
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{stateAssurance:'unverified',sender:'unknown',text:null}),record('2')],completedPartitions:['shard-a'],exhausted:true,resumeCursor:'tail-1'});
 await service.synchronize(contact);assert.equal((await service.coverage(contact)).phase,'incomplete');
 channel.page=async()=>{throw new Error('不能重读已交接历史快照');};
 channel.tail=async(_scope,_target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:'tail-2',records:[record('1')],caughtUp:true});
 const coverage=await service.synchronizeIncremental(contact);assert.equal(coverage.phase,'complete');assert.equal(coverage.failureCode,null);assert.equal(coverage.quarantinedCount,0);
 assert.equal(coverage.incremental.phase,'ready');assert.equal((await service.read(contact)).messages.length,2);await service.close();
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
 const before=state.created,beforePages=state.pages.length,second=new SqliteHistoryService(f.storage,f.contacts,normalUseChannelFactory(state));
 await assert.rejects(second.synchronize(contact),{code:'history_source_recovery_unsupported'});
 assert.equal(state.created,before+1,'围栏只允许打开渠道核对元数据，缺少恢复能力仍停读');assert.equal(state.pages.length,beforePages,'未核对来源不读正文页');
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
 await service.synchronize(contact);assert.equal((await service.read(contact)).messages.find(m=>m.text==='合成旧文字').id,old.id);
 const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts'),{ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');
 const deletion=new DeletionService(storage,service.holders,new ManagedFiles(root));
 const plan=await deletion.plan({ownerId:owner,requestKey:'synthetic-quarantined-delete',scope:{kind:'source',contactId:contact,sourceId:old.sourceRecordIds[0]}});
 assert.equal((await deletion.advance(plan)).state,'completed');assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
test('同源文字状态重新认证后恢复原消息，旧未知捕获不再阻挡历史覆盖',async t=>{
 const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id;
 let records=[record('1')];channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records,completedPartitions:['shard-a'],exhausted:true});
 await service.synchronize(contact);const original=(await service.read(contact)).messages[0],source=await service.source(contact,original.sourceRecordIds[0]);
 records=[record('1',{stateAssurance:'unverified',status:'99',sender:'unknown',text:null})];
 await service.synchronize(contact);assert.equal((await service.read(contact)).messages.length,0);
 records=[record('1')];await service.synchronize(contact);const restored=await service.read(contact);
 assert.equal(restored.coverage.phase,'complete');assert.equal(restored.coverage.quarantinedCount,0);
 assert.equal(restored.messages.length,1);assert.equal(restored.messages[0].id,original.id);assert.equal(restored.messages[0].sourceRecordIds.length,2);
 assert.deepEqual(await service.source(contact,original.sourceRecordIds[0]),source);
});
test('同一接受页的状态观察按出现顺序生效，较早正常记录不能解除较晚未知状态',async t=>{
 const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id,inspect=channel.inspect;
 channel.inspect=async(...args)=>({...await inspect(...args),capabilities:{incrementalTail:'supported'}});
 let records=[record('1')];channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records,completedPartitions:['shard-a'],exhausted:true,resumeCursor:'tail-1'});
 await service.synchronize(contact);const unknown=record('1',{stateAssurance:'unverified',sender:'unknown',text:null});
 records=[record('1'),unknown];await service.synchronize(contact);assert.equal((await service.read(contact)).messages.length,0);
 records=[unknown,record('1')];await service.synchronize(contact);assert.equal((await service.read(contact)).messages.length,1);
 assert.equal((await service.coverage(contact)).phase,'complete');
 channel.tail=async(_scope,_target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:'tail-2',records,caughtUp:true});
 assert.equal((await service.synchronizeIncremental(contact)).incremental.phase,'ready');
});
test('无正文非文字占位与系统观察独立计数，系统同源位置不能恢复成普通文字',async t=>{
 const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id;
 const metadata=(id,extra={})=>record(id,{sender:'unknown',kind:'other',text:null,originalType:'10000',stateAssurance:'unverified',metadataOnly:true,...extra});
 let records=[record('1'),metadata('2',{sender:'contact',kind:'image',originalType:'3'}),metadata('3',{sender:'contact'}),metadata('4',{originalType:'10002'})];
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records,completedPartitions:['shard-a'],exhausted:true});
 await service.synchronize(contact);const first=await service.read(contact),text=first.messages.find(row=>row.kind==='text');
 assert.equal(first.coverage.phase,'complete');assert.equal(first.coverage.quarantinedCount,0);assert.equal(first.coverage.metadataOnlyCount,2);
 assert.equal(first.coverage.nonTextCount,1);assert.equal(first.messages.length,2);assert.equal(first.messages.find(row=>row.kind==='image').text,null);
 await service.synchronize(contact);assert.equal((await service.coverage(contact)).metadataOnlyCount,2);
 records=[metadata('1',{sender:'contact'}),records[1],records[2],records[3]];await service.synchronize(contact);
 assert.equal((await service.read(contact)).messages.some(row=>row.kind==='text'),false);
 await assert.rejects(service.source(contact,text.sourceRecordIds[0]),{code:'history_source_not_found'});
 records=[record('1'),records[1],record('3'),record('5')];await service.synchronize(contact);const final=await service.read(contact);
 assert.deepEqual(final.messages.filter(row=>row.kind==='text').map(row=>row.text),['合成正文5']);
 assert.equal(final.coverage.phase,'complete');assert.equal(final.coverage.quarantinedCount,0);
});
test('状态恢复隔离联系人与分片，无身份观察不能被正常出现静默消除',async t=>{
 const {service,channel,saved,target}=await fixture(t),[a,b]=saved;
 target.partitions=['shard-a','shard-b'];target.tables=target.partitions.map(partition=>({partition,instance:'table-instance-1'}));
 let records=[record('1'),record('1',{partition:'shard-b',text:'乙分片独立文字'})];
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records,completedPartitions:target.partitions,exhausted:true});
 await service.synchronize(a.contact_id);await service.synchronize(b.contact_id);const original=(await service.read(a.contact_id)).messages;
 records=[record('1',{stateAssurance:'unverified',sender:'unknown',text:null}),records[1]];
 await service.synchronize(a.contact_id);await service.synchronize(b.contact_id);
 records=[record('1'),records[1]];await service.synchronize(a.contact_id);
 const restored=await service.read(a.contact_id);assert.equal(restored.coverage.phase,'complete');assert.deepEqual(new Set(restored.messages.map(row=>row.id)),new Set(original.map(row=>row.id)));
 assert.deepEqual((await service.read(b.contact_id)).messages.map(row=>row.text),['乙分片独立文字']);assert.equal((await service.coverage(b.contact_id)).quarantinedCount,1);
 records=[record(null,{stateAssurance:'unverified',sender:'unknown',text:null})];await service.synchronize(a.contact_id);
 records=[record('1'),record('1',{partition:'shard-b',text:'乙分片独立文字'})];await service.synchronize(a.contact_id);
 const unresolved=await service.read(a.contact_id);assert.equal(unresolved.messages.length,2);assert.equal(unresolved.coverage.phase,'incomplete');assert.equal(unresolved.coverage.quarantinedCount,1);
});
test('不合法或没有精确身份的元数据标记不能扩大为整位联系人的失效',async t=>{
 const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id;
 let records=[record('1'),record('2')];channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records,completedPartitions:['shard-a'],exhausted:true});
 await service.synchronize(contact);
 records=[record(null,{sender:'unknown',kind:'other',text:'不得留存的伪元数据正文',originalType:'10000',stateAssurance:'unverified',metadataOnly:true})];
 await service.synchronize(contact);const result=await service.read(contact);
 assert.equal(result.messages.length,2);assert.equal(result.coverage.phase,'incomplete');assert.equal(result.coverage.metadataOnlyCount,0);
});
test('捕获时间相同或倒退时，未知与重新认证仍按实际接受顺序生效',async t=>{
 const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id,inspect=channel.inspect;
 channel.inspect=async(...args)=>({...await inspect(...args),capabilities:{incrementalTail:'supported'}});
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1')],completedPartitions:['shard-a'],exhausted:true,resumeCursor:'tail-1'});
 await service.synchronize(contact);let now=1800000000000,records=[],sequence=1;t.mock.method(Date,'now',()=>now);
 channel.tail=async(_scope,_target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:`tail-${++sequence}`,records,caughtUp:true});
 const unknown=record('1',{stateAssurance:'unverified',sender:'unknown',text:null});
 for(const [time,recordValue,visible] of [[now,unknown,false],[now,record('1'),true],[now-1000,unknown,false],[now-2000,record('1'),true]]){
  now=time;records=[recordValue];await service.synchronizeIncremental(contact);const result=await service.read(contact);
  assert.equal(result.messages.length,visible?1:0);assert.equal(result.coverage.quarantinedCount,visible?0:1);
 }
});
test('旧代次或旧表实例的审计不阻挡当前覆盖，旧实际来源与派生依据不借新来源复活',async t=>{
 for(const otherTable of [false,true])await t.test(otherTable?'旧表实例':'旧来源代次',async t=>{
  const f=await fixture(t,{registryModule:new URL('./fixtures/history/legacy-scope-registry.mjs',import.meta.url).href}),[a,b]=f.saved;
  f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1')],completedPartitions:['shard-a'],exhausted:true});
  await f.service.synchronize(a.contact_id);const current=(await f.service.read(a.contact_id)).messages[0];
  const legacy=await f.storage.execute('fixture.seedLegacyScope',{ownerId:owner,contactId:a.contact_id,recordId:current.sourceRecordIds[0],otherTable,oldOnly:true});
  assert.equal((await f.service.coverage(a.contact_id)).phase,'complete');
  assert.deepEqual((await f.service.read(a.contact_id)).messages[0].sourceRecordIds,current.sourceRecordIds);
  await assert.rejects(f.service.source(a.contact_id,legacy.recordId),{code:'history_source_not_found'});
  await assert.rejects(f.storage.execute('fixture.assertSource',{owner_id:owner,contact_id:a.contact_id,message_id:legacy.messageId,record_id:legacy.recordId}),{code:'history_source_not_available'});
  const {SqliteDiscussionService}=await import('../src/reply/sqlite/service.ts'),{randomUUID}=await import('node:crypto');
  const forCurrent=new SqliteDiscussionService(f.storage,owner),currentDiscussion=await forCurrent.newDiscussion(a.contact_id);
  const selected=await f.storage.execute('discussion.messages',{ownerId:owner,contactId:a.contact_id,discussionId:currentDiscussion.id,messageIds:[current.id]});
  assert.ok(current.sourceRecordIds.includes(selected[0].record_id));
  assert.equal((await f.contacts.directory()).contacts.find(contact=>contact.contact_id===a.contact_id).data_status.message_count,1);
  const discussion=new SqliteDiscussionService(f.storage,owner),d=await discussion.newDiscussion(b.contact_id),key='synthetic-legacy-source';
  const confirmationId=await f.contacts.manualConfirm(b.contact_id,key),attempt=(await discussion.begin(b.contact_id,key,'独立手写要求',{kind:'manual',confirmationId},d.id)).attempt,contextId=randomUUID();
  await f.storage.execute('discussion.freezeContext',{...attempt,contextId,skillRun:{packages:[],eligible:[]},items:[],at:Date.now()});
  await f.storage.execute('fixture.seedCrossContactInput',{ownerId:owner,contextId,sourceContactId:a.contact_id,messageId:legacy.messageId,recordId:legacy.recordId});
  await assert.rejects(discussion.trace(b.contact_id,d.id,attempt.requestId),{code:'discussion_unavailable'});
 });
});
test('接受顺序在隐式行号重排、VACUUM及重开后保持，旧未知仍需精确新认证',async t=>{
 const f=await fixture(t,{registryModule:new URL('./fixtures/history/legacy-scope-registry.mjs',import.meta.url).href}),contact=f.saved[0].contact_id,inspect=f.channel.inspect;
 f.channel.inspect=async(...args)=>({...await inspect(...args),continuity:'same-source-instances-normal-use-v1',capabilities:{incrementalTail:'supported'}});
 f.channel.guardSession={loss:new Promise(()=>{})};
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{stateAssurance:'unverified',sender:'unknown',text:null})],completedPartitions:['shard-a'],exhausted:true,resumeCursor:'tail-1'});
 await f.service.synchronize(contact);
 f.channel.tail=async(_scope,_target,cursor)=>({target:f.target.descriptor,cursorIn:cursor,cursorOut:'tail-2',records:[record('1')],caughtUp:true});
 await f.service.synchronizeIncremental(contact);assert.equal((await f.service.coverage(contact)).phase,'complete');
 await f.storage.execute('fixture.reorderImplicitRows',{ownerId:owner,contactId:contact});
 assert.equal((await f.service.coverage(contact)).phase,'complete');
 await f.storage.execute('fixture.compact',{});assert.equal((await f.service.coverage(contact)).phase,'complete');
 const current=(await f.service.read(contact)).messages[0];
 await f.storage.execute('fixture.seedLegacyScope',{ownerId:owner,contactId:contact,recordId:current.sourceRecordIds[0],currentScope:true});
 assert.equal((await f.service.coverage(contact)).quarantinedCount,1);
 f.channel.tail=async(_scope,_target,cursor)=>({target:f.target.descriptor,cursorIn:cursor,cursorOut:'tail-3',records:[record('500')],caughtUp:true});
 await f.service.synchronizeIncremental(contact);assert.equal((await f.service.coverage(contact)).quarantinedCount,0);
 await f.service.close();await f.storage.close();const reopened=await reopenHistory(t,f.root,f.storage.status.databaseId);t.after(()=>reopened.storage.close());
 const channel={...f.channel,guardSession:{loss:new Promise(()=>{})},page:async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1'),record('500')],completedPartitions:['shard-a'],exhausted:true,resumeCursor:'tail-4'})};
 const service=new SqliteHistoryService(reopened.storage,reopened.contacts,channel);t.after(()=>service.close());
 await service.synchronize(contact);assert.equal((await service.coverage(contact)).phase,'complete');assert.equal((await service.read(contact)).messages.length,2);
 await service.close();await reopened.storage.close();
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
 const {service,channel,saved,target,contacts}=await fixture(t);const contact=saved[0].contact_id,other=saved[1].contact_id;
 channel.page=async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1')],completedPartitions:['shard-a'],exhausted:true});await service.synchronize(contact);await service.synchronize(other);
 channel.page=async()=>{await contacts.setReading(false);return {target:target.descriptor,cursorIn:null,cursorOut:'未接纳的后续游标',records:[record('1',{status:'99',stateAssurance:'unverified',sender:'unknown',text:null}),record('2',{text:'关闭后不得接纳的新正文'})],completedPartitions:[],exhausted:false};};
 await assert.rejects(service.synchronize(contact),{code:'read_not_authorized'});
 const after=await service.read(contact);assert.equal(after.messages.length,0,'已观察的未知状态撤下旧消息，迟到的新正文不能被接纳');
 assert.equal(after.coverage.pageCount,0,'关闭后不接纳该页');assert.equal(after.coverage.cursor,null,'关闭后不推进后续游标');
 assert.equal((await contacts.syncDirectory()).read_enabled,false,'保护旧消息不能恢复同步开关');
 assert.equal((await service.read(other)).messages.length,1,'无关联系人合法资料保持可读');
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
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1'),record('2')],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(a.contact_id);assert.equal((await f.service.read(a.contact_id)).messages.length,2);
 const recoveredImpact=await f.storage.execute('fixture.quarantineImpact',{ownerId:owner});
 assert.ok(recoveredImpact.requests.includes(attempt.requestId));assert.ok(recoveredImpact.requests.includes(attempt2.requestId));assert.ok(!recoveredImpact.requests.includes(other.requestId));
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
 const {service,saved,storage,contacts,channel,target}=await fixture(t,{registryModule:new URL('./fixtures/history/registry.mjs',import.meta.url).href});const contact=saved[0].contact_id;
 channel.page=async(_scope,_target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[record('9007199254740993',{serverId:'45'}),record('998',{serverId:'45',text:'合成正文9007199254740993'}),record('2',{kind:'voice',text:null})],completedPartitions:['shard-a'],exhausted:true});
 await service.synchronize(contact);const before=await service.read(contact);const source=before.messages.find(m=>m.kind==='text').sourceRecordIds[0];
 const voiceSource=before.messages.find(m=>m.kind==='voice').sourceRecordIds[0];
 const old=await contacts.eligibility(contact);
 const planned=await storage.execute('deletion.plan',{ownerId:owner,requestKey:'synthetic-source-delete',scope:{kind:'source',contactId:contact,sourceId:source}});
 assert.ok(planned.targets.some(t=>t.target?.domain==='history'));await assert.rejects(contacts.validate(old),{code:'read_eligibility_stale'});
 const claimed=await storage.execute('deletion.claim',{ownerId:owner,operationId:planned.operationId});
 const runner={ownerId:owner,operationId:planned.operationId,token:claimed.token,planRevision:claimed.planRevision};
 for(const item of claimed.targets)if(item.target?.kind==='row')await storage.execute('deletion.clearTarget',{...runner,targetNo:item.targetNo});
 const after=await service.read(contact);assert.equal(after.messages.length,2);assert.equal(after.messages.find(m=>m.kind==='text').sourceRecordIds.length,1);
 await service.synchronize(contact);const rescanned=await service.read(contact);assert.equal(rescanned.messages.find(m=>m.kind==='text').sourceRecordIds.length,1);
 assert.deepEqual(rescanned.messages.find(m=>m.kind==='voice').sourceRecordIds,[voiceSource]);
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
 await service.synchronize(contact);const after=(await service.read(contact)).messages[0];assert.equal(after.id,before.id);assert.equal(after.orderKey,'9007199254740993');assert.equal(after.ordering,'unknown');assert.equal(after.sentAt,'1700000000000');assert.equal(after.sourceRecordIds.length,1);assert.deepEqual(await service.source(contact,provenance.recordId),provenance);
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


test('重复扫描同一消息时保留一份稳定来源',async t=>{
 const {service,saved}=await fixture(t),contact=saved[0].contact_id;
 await service.synchronize(contact);
 const first=(await service.read(contact)).messages.find(message=>message.kind==='text');
 assert.ok(first);
 const source=await service.source(contact,first.sourceRecordIds[0]);assert.equal(source.raw.text,first.text);
 await service.synchronize(contact);
 const again=(await service.read(contact)).messages.find(message=>message.kind==='text');
 assert.equal(again.id,first.id);
 assert.deepEqual(again.sourceRecordIds,first.sourceRecordIds);
});

test('重复扫描待核验来源不会重复累计待核验数量',async t=>{
 const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id;
 channel.page=async(_scope,_target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[record('7',{stateAssurance:'unverified',text:null})],completedPartitions:['shard-a'],exhausted:true});
 await service.synchronize(contact);
 assert.equal((await service.coverage(contact)).quarantinedCount,1);
 await service.synchronize(contact);
 assert.equal((await service.coverage(contact)).quarantinedCount,1);
});

test('同一来源的未知状态经确认后正常入库且不再显示缺口',async t=>{
 const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id;
 let current=record('1',{stateAssurance:'unverified',sender:'unknown',text:null,status:'4',serverId:'55'});
 channel.page=async(_scope,_target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[current],completedPartitions:['shard-a'],exhausted:true});
 assert.equal((await service.synchronize(contact)).phase,'incomplete');
 current=record('1',{status:'4',serverId:'55'});const coverage=await service.synchronize(contact);
 assert.equal(coverage.quarantinedCount,0);assert.equal(coverage.phase,'complete');assert.equal((await service.read(contact)).messages[0].text,'合成正文1');
});

test('无正文的已识别系统记录不阻挡正常文字同步',async t=>{
 const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id;
 const system=record('99',{kind:'other',sender:'unknown',text:null,originalType:'10000',status:'4',stateAssurance:'unverified',metadataOnly:true});
 channel.page=async(_scope,_target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[record('1',{status:'4',serverId:'55'}),system],completedPartitions:['shard-a'],exhausted:true});
 const coverage=await service.synchronize(contact);assert.equal(coverage.phase,'complete');assert.equal(coverage.quarantinedCount,0);
 assert.deepEqual((await service.read(contact)).messages.map(m=>m.text),['合成正文1']);
 await service.synchronize(contact);assert.equal((await service.coverage(contact)).phase,'complete');
});

test('伪装成非文字元数据的文字不得进入消息',async t=>{
 const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id;
 channel.page=async(_scope,_target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[record('1',{stateAssurance:'unverified',metadataOnly:true})],completedPartitions:['shard-a'],exhausted:true});
 const coverage=await service.synchronize(contact);assert.equal(coverage.phase,'incomplete');assert.equal((await service.read(contact)).messages.length,0);
});

test('系统元数据与已保存文字身份相同时仍保留旧正文的使用保护',async t=>{
 const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id;let current=record('1');
 channel.page=async(_scope,_target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[current],completedPartitions:['shard-a'],exhausted:true});
 await service.synchronize(contact);const old=(await service.read(contact)).messages[0];
 current=record('1',{kind:'other',sender:'unknown',text:null,originalType:'10000',status:'4',stateAssurance:'unverified',metadataOnly:true});await service.synchronize(contact);
 assert.equal((await service.read(contact)).messages.length,0);await assert.rejects(service.source(contact,old.sourceRecordIds[0]),{code:'history_source_not_found'});
});

test('同一来源在正常和未知状态间切换时，以最后一次观察为准',async t=>{
 const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id;
 let current=record('1');channel.page=async(_scope,_target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[current],completedPartitions:['shard-a'],exhausted:true});
 await service.synchronize(contact);
 current=record('1',{status:'99',stateAssurance:'unverified',sender:'unknown',text:null});assert.equal((await service.synchronize(contact)).phase,'incomplete');
 current=record('1');assert.equal((await service.synchronize(contact)).phase,'complete');
 current=record('1',{status:'99',stateAssurance:'unverified',sender:'unknown',text:null});assert.equal((await service.synchronize(contact)).phase,'incomplete');assert.equal((await service.read(contact)).messages.length,0);
 current=record('1');assert.equal((await service.synchronize(contact)).phase,'complete');assert.equal((await service.read(contact)).messages.length,1);
});

test('重复完整同步后增量继续使用新目标，已保存消息不会因旧游标被停读',async t=>{
 const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id,inspect=channel.inspect;
 let serial=0,currentTarget='';channel.guardSession={loss:new Promise(()=>{})};
 channel.inspect=async(...args)=>({...await inspect(...args),continuity:'same-source-instances-normal-use-v1',capabilities:Object.fromEntries(['programVersion','exactSchema','declaredLocalKey','automaticAllocation','statusColumn','statusSemantics','sourceLifecycle','restartContinuity','recoveryMapping','snapshotBarrier','partitionCoverage','normalHistory','incrementalTail'].map(k=>[k,'supported']))});
 channel.target=async()=>({...target,descriptor:currentTarget=`snapshot-${++serial}`});
 channel.page=async(_scope,used,cursor)=>({target:used.descriptor,cursorIn:cursor,cursorOut:null,records:[record('1')],completedPartitions:['shard-a'],exhausted:true,resumeCursor:`resume-${serial}`});
 channel.tail=async(_scope,used,cursor)=>{if(used.descriptor!==currentTarget){const {StorageFailure}=await import('../src/storage/sqlite/contracts.ts');throw new StorageFailure('history_target_unverified');}return {target:used.descriptor,cursorIn:cursor,cursorOut:`tail-${serial}`,records:[],caughtUp:true};};
 assert.equal((await service.synchronize(contact)).phase,'complete');
 assert.equal((await service.synchronizeIncremental(contact)).incremental.phase,'ready');
 assert.equal((await service.synchronize(contact)).phase,'complete');
 const tail=await service.synchronizeIncremental(contact);assert.equal(tail.incremental.phase,'ready');assert.equal(tail.phase,'complete');
 assert.equal((await service.read(contact)).messages[0].sourceRecordIds.length,1);
});


test('新历史目标没有续读凭据时不能复用旧目标的增量游标',async t=>{
 const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id,inspect=channel.inspect;let serial=0,currentTarget='',canResume=true;channel.guardSession={loss:new Promise(()=>{})};
 channel.inspect=async(...args)=>({...await inspect(...args),continuity:'same-source-instances-normal-use-v1',capabilities:Object.fromEntries(['programVersion','exactSchema','declaredLocalKey','automaticAllocation','statusColumn','statusSemantics','sourceLifecycle','restartContinuity','recoveryMapping','snapshotBarrier','partitionCoverage','normalHistory','incrementalTail'].map(k=>[k,'supported']))});
 channel.target=async()=>({...target,descriptor:currentTarget=`snapshot-${++serial}`});
 channel.page=async(_scope,used,cursor)=>({target:used.descriptor,cursorIn:cursor,cursorOut:null,records:[record('1')],completedPartitions:['shard-a'],exhausted:true,...(canResume?{resumeCursor:`resume-${serial}`}:{})});
 let tailCalls=0;channel.tail=async(_scope,used,cursor)=>{tailCalls++;return {target:used.descriptor,cursorIn:cursor,cursorOut:`tail-${serial}`,records:[],caughtUp:true};};
 await service.synchronize(contact);await service.synchronizeIncremental(contact);canResume=false;await service.synchronize(contact);
 await assert.rejects(service.synchronizeIncremental(contact),{code:'history_incremental_not_ready'});assert.equal(tailCalls,1);assert.equal((await service.read(contact)).messages.length,1);
});


test('明确来源消失即使沿用系统类型也不撤下已同步正文',async t=>{
 const {service,channel,saved,target}=await fixture(t),contact=saved[0].contact_id;let current=record('1');
 channel.page=async(_scope,_target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[current],completedPartitions:['shard-a'],exhausted:true});
 await service.synchronize(contact);const savedMessage=(await service.read(contact)).messages[0];
 current=record('1',{kind:'other',sender:'unknown',text:null,originalType:'10000',messageState:'absent'});await service.synchronize(contact);
 assert.equal((await service.read(contact)).messages[0].id,savedMessage.id);assert.equal((await service.source(contact,savedMessage.sourceRecordIds[0])).messageId,savedMessage.id);
 current=record('1');await service.synchronize(contact);assert.equal((await service.read(contact)).messages[0].id,savedMessage.id);
});
