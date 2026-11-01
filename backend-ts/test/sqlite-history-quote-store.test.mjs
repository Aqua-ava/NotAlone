import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteContactService} from '../src/contacts/sqlite/service.ts';
import {SqliteHistoryService} from '../src/history/sqlite/service.ts';
import {SqliteQuoteStore} from '../src/history/sqlite/quote-store.ts';
import {projectHistoryMessages} from '../src/history/sqlite/http.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';

const owner='00000000-0000-4000-8000-000000000219';
const metadata=()=>({account:async()=>({externalKey:'synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-metadata-v1'}),
 sessions:async()=>['a','b'].map(name=>({externalKey:`friend-${name}`,displayName:`合成${name}`,kind:'private',identityAssurance:'verified'}))});
const records=[
 {partition:'p',table:'t',localId:'1',serverId:'101',sender:'contact',kind:'other',text:null,originalType:'244813135921',sentAt:'1700000000000',timePrecision:'millisecond',orderScheme:null,orderKey:null,status:'4',stateAssurance:'verified'},
 {partition:'p',table:'t',localId:'2',serverId:'202',sender:'owner',kind:'text',text:'这是被引用的原话',originalType:'1',sentAt:'1699999999000',timePrecision:'millisecond',orderScheme:null,orderKey:null,status:'2',stateAssurance:'verified'},
];
const channel=state=>({
 ...(state.guardSession?{guardSession:{loss:new Promise(()=>{}),failureCode:()=>null}}:{}),
 inspect:async scope=>({protocol:'private-history-v1',profileId:'synthetic-history-v1',adapterVersion:'1',status:'supported',reason:null,
  accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation,programVersion:'synthetic',build:'1',
  artifactSha256:'a'.repeat(64),schemaFingerprint:'b'.repeat(64),declaredPrimaryKey:['local_id'],identity:'source-table-local-v1',
  statusSemantics:'synthetic-final',continuity:'synthetic-source',serverAliasSemantics:'verified_within_scope'}),
 target:async()=>({protocol:'private-history-v1',descriptor:'synthetic-target',partitions:['p'],tables:[{partition:'p',instance:'t'}],sourceGeneration:'source-1'}),
 page:async(scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,completedPartitions:['p'],exhausted:true,
  records:state.recordsByConversation?.[scope.conversationKey]??state.records})
});
async function fixture(t,{records:initialRecords=records,recordsByConversation,guardSession=false}={}){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-history-quote-')));
 const state={records:initialRecords,recordsByConversation,guardSession};
 let storage=await SqliteStorage.open({userData:root,intent:'create',role:'test'}),contacts=new SqliteContactService(storage,owner,metadata());
 let history=new SqliteHistoryService(storage,contacts,()=>channel(state)),store=new SqliteQuoteStore(storage,owner);
 const deletion=new DeletionService(storage,new ActiveHolders(),new ManagedFiles(root),{drainTimeoutMs:20});
 t.after(async()=>{await history.close().catch(()=>{});await contacts.close().catch(()=>{});await storage.close().catch(()=>{});await rm(root,{recursive:true,force:true});});
 await contacts.initialize();const account=await contacts.detectAccount();await contacts.confirmAccount(account.candidate_token);await contacts.setReading(true);
 const snapshot=await contacts.candidates(true);await contacts.confirm(snapshot.snapshot_token,snapshot.sessions.map(row=>({locator:row.username,observed_display_name:row.display_name,expected_selection_generation:'0'})));
 const bindings=(await contacts.directory()).bindings;
 for(const binding of bindings)await history.synchronize(binding.contact_id);
 const context={get storage(){return storage;},get contacts(){return contacts;},get history(){return history;},get store(){return store;},
  bindings,state,deletion,async abruptRestart(){
   const databaseId=storage.status.databaseId;
   await storage.close();
   storage=await SqliteStorage.open({userData:root,intent:'open',role:'test',expectedDatabaseId:databaseId});
   contacts=new SqliteContactService(storage,owner,metadata());await contacts.initialize();
   history=new SqliteHistoryService(storage,contacts,()=>channel(state));store=new SqliteQuoteStore(storage,owner);
   return context;
  }};
 return context;
}
const content={replyText:'收到，我晚点确认。',referencedText:'这是被引用的原话',referencedSender:'我',referencedSenderRole:'owner',referencedType:'1',referencedServerId:'202'};

test('已存引用占位补齐为结构化引用，重复保存保持幂等',async t=>{
 const f=await fixture(t),contact=f.bindings[0].contact_id,token=await f.contacts.eligibility(contact);
 const before=await f.history.read(contact),placeholder=before.messages.find(message=>message.originalType==='244813135921');
 assert.ok(placeholder);assert.equal(placeholder.kind,'other');assert.equal(placeholder.text,null);
 const emptyProjection=projectHistoryMessages(before,20).messages.find(message=>message.message_id===placeholder.id);
 assert.equal(emptyProjection.text,null);assert.equal(emptyProjection.quoted,null);assert.equal(emptyProjection.media_placeholder,'[引用回复]');
 const candidates=await f.store.candidates(contact,'quote-v1');
 assert.deepEqual(candidates,[{messageId:placeholder.id,recordId:placeholder.sourceRecordIds[0]}]);
 const saved={token,recordId:candidates[0].recordId,messageId:candidates[0].messageId,version:'quote-v1',content,proofDigest:'c'.repeat(64)};
 const firstSave=await f.store.save(saved),duplicateSave=await f.store.save(saved);
 assert.deepEqual(duplicateSave,firstSave);
 const after=await f.history.read(contact),quote=after.messages.find(message=>message.id===placeholder.id);
 assert.equal(after.messages.filter(message=>message.originalType==='244813135921').length,1);
 assert.deepEqual(quote.quote,{...content,targetMessageId:after.messages.find(message=>message.text==='这是被引用的原话').id,state:'resolved'});
 const projected=projectHistoryMessages(after,20).messages.find(message=>message.message_id===placeholder.id);
 assert.equal(projected.text,content.replyText);
 assert.deepEqual(projected.quoted,{text:content.referencedText,target_message_id:quote.quote.targetMessageId,sender:content.referencedSender,
  sender_role:'owner',message_type:'1',state:'resolved'});
 assert.deepEqual(await f.store.candidates(contact,'quote-v1'),[]);
});

test('解析失败按版本记账，同一版本不忙重试且新版本可重试',async t=>{
 const f=await fixture(t),contact=f.bindings[0].contact_id,token=await f.contacts.eligibility(contact),message=(await f.history.read(contact)).messages.find(row=>row.originalType==='244813135921');
 const candidate=(await f.store.candidates(contact,'quote-v1'))[0];
 await f.store.fail({token,...candidate,version:'quote-v1',errorCode:'quote_parse_invalid'});
 assert.deepEqual(await f.store.candidates(contact,'quote-v1'),[]);
 assert.equal((await f.history.read(contact)).messages.find(row=>row.id===message.id).quoteErrorCode,undefined,'未知失败码不进入只读投影');
 const retry=(await f.store.candidates(contact,'quote-v2'))[0];assert.equal(retry.messageId,message.id);
 await f.store.fail({token,...retry,version:'quote-v2',errorCode:'history_quote_state_unverified'});
 const failedRead=await f.history.read(contact),failedMessage=failedRead.messages.find(row=>row.id===message.id);
 assert.equal(failedMessage.quoteErrorCode,'history_quote_state_unverified');
 const failedProjection=projectHistoryMessages(failedRead,20).messages.find(row=>row.message_id===message.id);
 assert.equal(failedProjection.text,null);assert.equal(failedProjection.quoted,null);
 assert.equal(failedProjection.media_placeholder,'[引用回复：消息状态尚未核验]');
 assert.deepEqual(await f.store.candidates(contact,'quote-v2'),[]);
});

test('目标先删除时登记server排除，后补齐引用只保存回复并投影安全错误',async t=>{
 const f=await fixture(t,{recordsByConversation:{'friend-a':records}}),contact=f.bindings.find(row=>row.conversation_locator==='friend-a').contact_id;
 const before=await f.history.read(contact),target=before.messages.find(row=>row.text==='这是被引用的原话');
 const removeTarget=await f.deletion.plan({ownerId:owner,requestKey:'quote-target-first',scope:{kind:'source',contactId:contact,sourceId:target.sourceRecordIds[0]}});
 assert.equal((await f.deletion.advance(removeTarget)).state,'completed');
 const token=await f.contacts.eligibility(contact),carrier=(await f.history.read(contact)).messages.find(row=>row.originalType==='244813135921');
 const candidate=(await f.store.candidates(contact,'quote-v1'))[0];assert.equal(candidate.messageId,carrier.id);
 const saved={token,...candidate,version:'quote-v1',content,proofDigest:'c'.repeat(64)};
 await f.store.save(saved);await f.store.save(saved);
 let read=await f.history.read(contact);let quote=read.messages.find(row=>row.id===carrier.id).quote;
 assert.equal(quote.replyText,content.replyText);assert.equal(quote.referencedText,null);assert.equal(quote.referencedSender,null);
 assert.equal(quote.referencedSenderRole,'unknown');assert.equal(quote.referencedType,null);assert.equal(quote.referencedServerId,null);
 assert.equal(quote.targetMessageId,null);assert.equal(quote.state,'unavailable');
 assert.deepEqual(await f.store.candidates(contact,'quote-v1'),[],'已记账的重复来源不得重新解析');
 const projected=projectHistoryMessages(read,20).messages.find(row=>row.message_id===carrier.id);
 assert.equal(projected.text,content.replyText);assert.equal(projected.quoted.state,'unavailable');
 assert.equal(projected.quoted.text,'引用内容暂不可用');
 assert.equal(read.messages.find(row=>row.id===carrier.id).quoteErrorCode,undefined,'成功解析后的引用不显示失败码');
});

test('普通同步遇到指向已删除目标的引用时沿用server排除并擦除引用快照',async t=>{
 const placeholder={...records[0],stateAssurance:'unverified',metadataOnly:true};
 const f=await fixture(t,{records:[placeholder,records[1]]}),contact=f.bindings.find(row=>row.conversation_locator==='friend-a').contact_id;
 const before=await f.history.read(contact),target=before.messages.find(row=>row.text==='这是被引用的原话');assert.ok(target);
 const removeTarget=await f.deletion.plan({ownerId:owner,requestKey:'inline-quote-target-first',scope:{kind:'source',contactId:contact,sourceId:target.sourceRecordIds[0]}});
 assert.equal((await f.deletion.advance(removeTarget)).state,'completed');
 const inlineCarrier={...placeholder,quote:{...content,proofDigest:'e'.repeat(64)}};
 f.state.records=[inlineCarrier];
 await f.history.synchronize(contact);
 const read=await f.history.read(contact),carrier=read.messages.find(row=>row.originalType==='244813135921');
 assert.ok(carrier,JSON.stringify(read.messages));assert.equal(carrier.quote.replyText,content.replyText);assert.equal(carrier.quote.referencedText,null);
 assert.equal(carrier.quote.referencedSender,null);assert.equal(carrier.quote.referencedSenderRole,'unknown');
 assert.equal(carrier.quote.referencedServerId,null);assert.equal(carrier.quote.targetMessageId,null);assert.equal(carrier.quote.state,'unavailable');
 assert.deepEqual(await f.store.candidates(contact,'wechat-quote-v2'),[]);
});

test('同联系人现授权下重开读取后仍能补齐先前合法历史',async t=>{
 const f=await fixture(t),contact=f.bindings[0].contact_id;
 await f.contacts.setReading(false);await f.contacts.setReading(true);
 assert.equal((await f.store.candidates(contact,'quote-v1')).length,1,'历史capture的旧read_epoch不否定当前同绑定来源');
});

test('干净进程重启后候选读取允许旧runtime guard，quote保存仍要求活guard',async t=>{
 const f=await fixture(t,{guardSession:true}),contact=f.bindings[0].contact_id;
 const before=await f.store.candidates(contact,'quote-v1');assert.equal(before.length,1);
 await f.abruptRestart();
 assert.deepEqual(await f.store.candidates(contact,'quote-v1'),before,'旧runtime guard只阻止正文解析，不阻止安全元数据候选');
 const token=await f.contacts.eligibility(contact),candidate=before[0];
 await assert.rejects(f.store.save({token,...candidate,version:'quote-v1',content,proofDigest:'c'.repeat(64)}),
  error=>error.code==='history_source_not_available','实际保存仍须通过当前活guard来源复验');
});

test('v26迁移保留v25引用正文、来源和去重尝试',async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-history-quote-migration-'))),databaseOptions={userData:root,role:'test'};
 let storage,contacts,history;
 t.after(async()=>{await history?.close().catch(()=>{});await contacts?.close().catch(()=>{});await storage?.close().catch(()=>{});await rm(root,{recursive:true,force:true});});
 storage=await SqliteStorage.open({...databaseOptions,intent:'create',registryModule:new URL('./fixtures/history/v25-quote-registry.mjs',import.meta.url).href});
 const databaseId=storage.status.databaseId;contacts=new SqliteContactService(storage,owner,metadata());history=new SqliteHistoryService(storage,contacts,channel({records}));
 await contacts.initialize();const account=await contacts.detectAccount();await contacts.confirmAccount(account.candidate_token);await contacts.setReading(true);
 const snapshot=await contacts.candidates(true);await contacts.confirm(snapshot.snapshot_token,snapshot.sessions.map(row=>({locator:row.username,observed_display_name:row.display_name,expected_selection_generation:'0'})));
 const binding=(await contacts.directory()).bindings.find(row=>row.conversation_locator==='friend-a'),contact=binding.contact_id;
 await history.synchronize(contact);const carrier=(await history.read(contact)).messages.find(row=>row.originalType==='244813135921');
 await storage.execute('fixture.seedQuoteV25',{ownerId:owner,contactId:contact,messageId:carrier.id,recordId:carrier.sourceRecordIds[0],sourceGeneration:'source-1',
  quoteId:'10000000-0000-4000-8000-000000000001',attemptId:'10000000-0000-4000-8000-000000000002',version:'quote-v1',replyText:'迁移后保留回复',referencedText:'迁移后保留引用'});
 await history.close();history=undefined;await contacts.close();contacts=undefined;await storage.close();storage=undefined;
 storage=await SqliteStorage.open({...databaseOptions,intent:'open',expectedDatabaseId:databaseId});
 contacts=new SqliteContactService(storage,owner,metadata());history=new SqliteHistoryService(storage,contacts,channel({records}));await contacts.initialize();
 const quote=(await history.read(contact)).messages.find(row=>row.id===carrier.id).quote;
 assert.equal(quote.replyText,'迁移后保留回复');assert.equal(quote.referencedText,'迁移后保留引用');
 assert.equal((await new SqliteQuoteStore(storage,owner).candidates(contact,'quote-v1')).length,0,'迁移后的稳定来源键继续阻止重复解析');
});

test('同server ID跨联系人不关联，目标后续入库后仅在同绑定读投影补关联',async t=>{
 const onlyQuote=[records[0]],onlyTarget=[records[1]];
 const f=await fixture(t,{recordsByConversation:{'friend-a':onlyQuote,'friend-b':onlyTarget}}),a=f.bindings.find(binding=>binding.conversation_locator==='friend-a').contact_id;
 const token=await f.contacts.eligibility(a),candidate=(await f.store.candidates(a,'quote-v1'))[0];
 await f.store.save({token,...candidate,version:'quote-v1',content,proofDigest:'c'.repeat(64)});
 let read=await f.history.read(a),quote=read.messages.find(row=>row.id===candidate.messageId).quote;
 assert.equal(quote.targetMessageId,null,'friend-b 的同号server alias不得跨联系人命中');assert.equal(quote.state,'unresolved');
 f.state.recordsByConversation['friend-a']=[...onlyQuote,...onlyTarget];
 await f.history.synchronize(a);
 read=await f.history.read(a);quote=read.messages.find(row=>row.id===candidate.messageId).quote;
 assert.equal(quote.targetMessageId,read.messages.find(row=>row.text==='这是被引用的原话').id);
 assert.equal(quote.state,'resolved');
 const target=read.messages.find(row=>row.text==='这是被引用的原话');
 const removeTarget=await f.deletion.plan({ownerId:owner,requestKey:'late-quote-target',scope:{kind:'source',contactId:a,sourceId:target.sourceRecordIds[0]}});
 assert.ok(removeTarget.targets.some(item=>item.target?.rowKind==='history_quote_dependency'),'计划应识别动态关联的目标副本');
 const fenced=await f.history.read(a),fencedQuote=fenced.messages.find(row=>row.id===candidate.messageId).quote;
 assert.equal(fencedQuote.referencedText,null,'即使清理尚未执行，server exclusion 也先阻断副本投影');
 assert.equal(fencedQuote.referencedSender,null);assert.equal(fencedQuote.state,'unavailable');
 assert.equal((await f.deletion.advance(removeTarget)).state,'completed');
 read=await f.history.read(a);quote=read.messages.find(row=>row.id===candidate.messageId).quote;
 assert.equal(quote.referencedText,null,'动态补关联的目标删除后也擦除引用副本');assert.equal(quote.targetMessageId,null);assert.equal(quote.state,'unavailable');
});

test('删除原目标来源清除引用副本并保留回复，删除引用载体清空全部quote资料',async t=>{
 const f=await fixture(t),contact=f.bindings[0].contact_id,token=await f.contacts.eligibility(contact),candidate=(await f.store.candidates(contact,'quote-v1'))[0];
 await f.store.save({token,...candidate,version:'quote-v1',content,proofDigest:'c'.repeat(64)});
 let read=await f.history.read(contact),target=read.messages.find(row=>row.text==='这是被引用的原话');
 const removeTarget=await f.deletion.plan({ownerId:owner,requestKey:'quote-target-source',scope:{kind:'source',contactId:contact,sourceId:target.sourceRecordIds[0]}});
 assert.equal((await f.deletion.advance(removeTarget)).state,'completed');
 read=await f.history.read(contact);let carrier=read.messages.find(row=>row.id===candidate.messageId);
 assert.equal(carrier.quote.replyText,content.replyText);assert.equal(carrier.quote.referencedText,null);assert.equal(carrier.quote.targetMessageId,null);assert.equal(carrier.quote.state,'unavailable');
 const projected=projectHistoryMessages(read,20).messages.find(row=>row.message_id===candidate.messageId);
 assert.deepEqual(projected.quoted,{text:'引用内容暂不可用',target_message_id:null,sender:null,sender_role:'unknown',message_type:null,state:'unavailable'});
 const removeCarrier=await f.deletion.plan({ownerId:owner,requestKey:'quote-carrier-source',scope:{kind:'source',contactId:contact,sourceId:carrier.sourceRecordIds[0]}});
 assert.equal((await f.deletion.advance(removeCarrier)).state,'completed');
 read=await f.history.read(contact);assert.equal(read.messages.some(row=>row.id===candidate.messageId),false);
});
