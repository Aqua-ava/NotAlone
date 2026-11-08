import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture as createFixture} from './fixtures/memory-sqlite/support.mjs';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteHistoryService} from '../src/history/sqlite/service.ts';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {EventEmitter} from 'node:events';
import {PureTsEvents} from '../src/host/pure-ts-events.ts';

class EventRequest extends EventEmitter {}
class EventResponse extends EventEmitter {
 statusCode=0;headers={};chunks=[];writableLength=0;destroyed=false;
 writeHead(status,headers){this.statusCode=status;this.headers=headers;return this;}
 write(chunk){this.chunks.push(String(chunk));return true;}
 end(){this.destroyed=true;this.emit('close');}
}

const guardRegistry=new URL('./fixtures/history/guard-registry.mjs',import.meta.url).href;
const fixture=(t,options={})=>createFixture(t,{registryModule:guardRegistry,...options});
const snapshot=(f,contactId)=>f.storage.execute('fixture.guardSnapshot',{ownerId:f.contacts.ownerId,contactId});

function guardedChannelFactory(state){
 return ()=>{
  state.created++;let closed=false;let lost;const loss=new Promise(resolve=>{lost=resolve;});state.lose=()=>lost();
  return {guardSession:{loss},
   inspect:async scope=>({protocol:'private-history-v1',profileId:'synthetic-guarded',adapterVersion:'1',status:'supported',reason:null,accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation,programVersion:'synthetic',build:'1',artifactSha256:'a'.repeat(64),schemaFingerprint:'b'.repeat(64),declaredPrimaryKey:['local_id'],identity:'source-table-local-v1',statusSemantics:'synthetic',continuity:'synthetic-guard',...state.reportOverride}),
   target:async()=>({protocol:'private-history-v1',descriptor:'synthetic-guarded-target',partitions:['p'],tables:[{partition:'p',instance:'t'}],sourceGeneration:'source-1',...state.targetOverride}),
   page:async(_scope,target,cursor,signal)=>{state.pageCalls=(state.pageCalls??0)+1;await state.onPage?.(signal);return {target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[{partition:'p',table:'t',localId:'1',serverId:'0',sender:'contact',kind:'text',text:'合成守卫消息',originalType:'1',sentAt:null,timePrecision:null,orderScheme:null,orderKey:null,stateAssurance:'verified'}],completedPartitions:['p'],exhausted:true,...(state.resumeCursor?{resumeCursor:state.resumeCursor}:{})};},
   tail:async(_scope,target,cursor)=>{state.tailCalls=(state.tailCalls??0)+1;const records=state.tailRecords??[{partition:'p',table:'t',localId:'2',serverId:'0',sender:'contact',kind:'text',text:'合成增量守卫消息',originalType:'1',sentAt:null,timePrecision:null,orderScheme:null,orderKey:null,stateAssurance:'verified'}];return {target:target.descriptor,cursorIn:cursor,cursorOut:state.tailCursorOut??'tail-2',records,caughtUp:true};},
   close:async()=>{if(!closed){closed=true;state.closed++;lost();await state.onClose?.();}},
  };
 };
}

test('增量新增与旧消息变化只发无正文ID事件，隔离联系人且不重复提醒',async t=>{
 const f=await fixture(t),state={created:0,closed:0,resumeCursor:'tail-1'},create=guardedChannelFactory(state),events=new PureTsEvents(f.contacts.ownerId);
 const eventRequest=new EventRequest(),eventResponse=new EventResponse();events.open(eventRequest,eventResponse);
 t.after(()=>events.close());let inspections=0,pages=0;
 const history=new SqliteHistoryService(f.storage,f.contacts,()=>{
  const channel=create(),inspect=channel.inspect,page=channel.page;
  channel.inspect=async(...args)=>{inspections++;return {...await inspect(...args),capabilities:Object.fromEntries(['programVersion','exactSchema','declaredLocalKey','automaticAllocation','statusColumn','statusSemantics','sourceLifecycle','restartContinuity','recoveryMapping','snapshotBarrier','partitionCoverage','normalHistory','incrementalTail'].map(key=>[key,'supported']))};};
  channel.page=async(...args)=>{pages++;return page(...args);};return channel;
 },undefined,(contactId,messageId,change='created')=>events.publish(`message.${change}`,contactId,{message_id:messageId}));
 t.after(()=>history.close());const contact=f.saved[0].contact_id;
 assert.equal(await history.bodyAvailable([contact]),false);assert.equal(state.created,0);
 await history.synchronize(contact);
 assert.equal(eventResponse.chunks.join('').includes('event: message.created'),false,'历史补齐本身不触发新消息提醒');
 await history.synchronizeIncremental(contact);
 const counts=[state.created,inspections,pages];
 const firstFrame=eventResponse.chunks.join('');assert.match(firstFrame,/event: message\.created/);
 const firstPayload=JSON.parse(firstFrame.split('data: ')[1].split('\n')[0]);
 assert.equal(firstPayload.owner_id,f.contacts.ownerId);assert.equal(firstPayload.contact_id,contact);
 assert.equal(typeof firstPayload.payload.message_id,'string');assert.equal(firstFrame.includes('合成增量守卫消息'),false);
 assert.equal((await history.read(contact)).messages[0].id,firstPayload.payload.message_id);
 assert.equal(await history.bodyAvailable([contact]),true);assert.deepEqual([state.created,inspections,pages],counts);
 assert.equal(await history.bodyAvailable([f.saved[1].contact_id]),false);
 await history.synchronizeIncremental(contact);
 assert.equal(eventResponse.chunks.join('').split('event: message.created').length-1,1,'重复入库不得重复提醒');
 state.tailRecords=[{partition:'p',table:'t',localId:'2',serverId:'0',sender:'contact',kind:'text',text:'合成增量守卫消息',originalType:'1',sentAt:null,timePrecision:null,orderScheme:null,orderKey:null,status:'1',stateAssurance:'verified'}];
 await history.synchronizeIncremental(contact);
 const updatedFrames=eventResponse.chunks.join('').split('event: message.updated').slice(1);
 assert.equal(updatedFrames.length,1,'已入库消息的可见字段更新要通知当前联系人刷新');
 const updatedPayload=JSON.parse(updatedFrames[0].split('data: ')[1].split('\n')[0]);
 assert.equal(updatedPayload.owner_id,f.contacts.ownerId);assert.equal(updatedPayload.contact_id,contact);
 assert.equal(updatedPayload.payload.message_id,firstPayload.payload.message_id);assert.equal(updatedFrames[0].includes('合成增量守卫消息'),false);
 assert.equal(eventResponse.chunks.join('').split('event: message.created').length-1,1,'旧消息变化不能伪装成新消息提醒');
 state.tailRecords=[{partition:'p',table:'t',localId:'2',serverId:'0',sender:'unknown',kind:'other',text:null,originalType:'10000',sentAt:null,timePrecision:null,orderScheme:null,orderKey:null,messageState:'recalled',stateAssurance:'verified'}];
 await history.synchronizeIncremental(contact);
 const recallFrames=eventResponse.chunks.join('').split('event: message.updated').slice(1);
 assert.equal(recallFrames.length,2,'旧消息撤回提交后要通知小窗清除已撤回正文');
 const recallPayload=JSON.parse(recallFrames[1].split('data: ')[1].split('\n')[0]);
 assert.equal(recallPayload.payload.message_id,firstPayload.payload.message_id);assert.equal(recallFrames[1].includes('合成增量守卫消息'),false);
 assert.equal((await history.read(contact)).messages.some(message=>message.id===firstPayload.payload.message_id),false);
 state.tailRecords=undefined;
 await history.synchronize(f.saved[1].contact_id);await history.synchronizeIncremental(f.saved[1].contact_id);
 const otherFrames=eventResponse.chunks.join('').split('event: message.created').slice(1);
 assert.equal(otherFrames.length,2);assert.match(otherFrames[1],new RegExp(`contact_id\\":\\"${f.saved[1].contact_id}`));
 await f.contacts.setReading(false);assert.equal(await history.bodyAvailable([contact]),false);
 await history.stop();assert.equal(await history.bodyAvailable([contact]),false);
});

test('正文可用性只来自当前授权下的已核验活守卫，状态查询不打开渠道或读取正文',async t=>{
 const f=await fixture(t),state={created:0,closed:0},create=guardedChannelFactory(state);let inspections=0,pages=0;
 const history=new SqliteHistoryService(f.storage,f.contacts,()=>{
  const channel=create(),inspect=channel.inspect,page=channel.page;
  channel.inspect=async(...args)=>{inspections++;return {...await inspect(...args),capabilities:Object.fromEntries(['programVersion','exactSchema','declaredLocalKey','automaticAllocation','statusColumn','statusSemantics','sourceLifecycle','restartContinuity','recoveryMapping','snapshotBarrier','partitionCoverage','normalHistory','incrementalTail'].map(key=>[key,'supported']))};};
  channel.page=async(...args)=>{pages++;return page(...args);};return channel;
 });
 t.after(()=>history.close());const contact=f.saved[0].contact_id;
 assert.equal(await history.bodyAvailable([contact]),false);assert.equal(state.created,0);
 await history.synchronize(contact);const counts=[state.created,inspections,pages];
 assert.equal(await history.bodyAvailable([contact]),true);assert.deepEqual([state.created,inspections,pages],counts);
 assert.equal(await history.bodyAvailable([f.saved[1].contact_id]),false);
 await f.contacts.setReading(false);assert.equal(await history.bodyAvailable([contact]),false);
 await history.stop(contact);assert.equal(await history.bodyAvailable([contact]),false);
});

test('历史已入库但缺少明确正文能力证明时，状态不能声称正文可用',async t=>{
 const f=await fixture(t),state={created:0,closed:0},history=new SqliteHistoryService(f.storage,f.contacts,guardedChannelFactory(state));
 t.after(()=>history.close());const contact=f.saved[0].contact_id;
 assert.equal((await history.synchronize(contact)).phase,'complete');
 assert.equal(await history.bodyAvailable([contact]),false);
 await history.close();
});

test('缺少正文必需能力时，已认证单次读取不能开启自动正文同步状态',async t=>{
 for(const missing of ['statusColumn','automaticAllocation','incrementalTail','restartContinuity','recoveryMapping'])await t.test(missing,async t=>{
  const f=await fixture(t),state={created:0,closed:0},create=guardedChannelFactory(state);
  const history=new SqliteHistoryService(f.storage,f.contacts,()=>{
   const channel=create(),inspect=channel.inspect;
   channel.inspect=async(...args)=>({...await inspect(...args),capabilities:Object.fromEntries(['programVersion','exactSchema','declaredLocalKey','automaticAllocation','statusColumn','statusSemantics','sourceLifecycle','restartContinuity','recoveryMapping','snapshotBarrier','partitionCoverage','normalHistory','incrementalTail'].map(key=>[key,key===missing?'unverified':'supported']))});
   return channel;
  });
  t.after(()=>history.close());const contact=f.saved[0].contact_id;
  await history.synchronize(contact);assert.equal(await history.bodyAvailable([contact]),false);await history.close();
 });
});

test('应用跨批次持有同一守卫，释放后核验续读且停读授权仍生效',async t=>{
 const f=await fixture(t),state={created:0,closed:0},history=new SqliteHistoryService(f.storage,f.contacts,guardedChannelFactory(state));t.after(()=>history.close());
 const contact=f.saved[0].contact_id;await history.synchronize(contact);const source=(await history.read(contact)).messages[0].sourceRecordIds[0];await history.synchronize(contact);
 assert.equal(state.created,1);assert.equal(state.closed,0);
 await history.stop(contact);assert.equal(state.closed,1);assert.ok(await history.source(contact,source));
 assert.equal((await snapshot(f,contact)).proofs[0].state,'ok');
 assert.equal((await history.synchronize(contact)).phase,'complete');assert.equal(state.created,2);assert.equal((await history.read(contact)).messages.length,1);
 await f.contacts.setReading(false);await history.stop(contact);
 await assert.rejects(history.synchronize(contact),{code:'read_not_authorized'});assert.equal(state.created,2);
});

test('页预算用尽后在同一活守卫和目标内从已提交游标续读',async t=>{
 const f=await fixture(t),state={created:0,closed:0},create=guardedChannelFactory(state),cursors=[];let targets=0;
 const history=new SqliteHistoryService(f.storage,f.contacts,()=>{
  const channel=create(),target=channel.target;
  channel.target=async(...args)=>{targets++;return target(...args);};
  channel.page=async(scope,target,cursor)=>{
   const index=cursors.length;cursors.push(cursor);assert.equal(cursor,index===0?null:`page-${index}`);
   const final=index===1000;
   return {target:target.descriptor,cursorIn:cursor,cursorOut:final?null:`page-${index+1}`,
    records:index===0||final?[{partition:'p',table:'t',localId:final?'2':'1',serverId:'0',sender:'contact',kind:'text',text:`合成续读消息${index}`,originalType:'1',sentAt:null,timePrecision:null,orderScheme:null,orderKey:null,stateAssurance:'verified'}]:[],
    completedPartitions:final?['p']:[],exhausted:final};
  };
  return channel;
 });
 t.after(()=>history.close().catch(()=>{}));const contact=f.saved[0].contact_id;
 const paused=await history.synchronize(contact);assert.equal(paused.phase,'incomplete');assert.equal(paused.failureCode,'history_page_budget_exhausted');assert.equal(paused.pageCount,1000);
 assert.equal(cursors.length,1000);assert.equal(state.created,1);assert.equal(state.closed,0);
 const complete=await history.synchronize(contact);assert.equal(complete.phase,'complete');assert.equal(complete.pageCount,1001);
 assert.equal(cursors.length,1001);assert.equal(cursors[1000],'page-1000');assert.equal(targets,1);assert.equal(state.created,1);assert.equal(state.closed,0);
 assert.equal((await history.read(contact)).messages.length,2);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});await history.close();
});

test('停读等待在途守卫真正关闭，迟到页不能保存',async t=>{
 const f=await fixture(t),entered=Promise.withResolvers(),closeEntered=Promise.withResolvers(),release=Promise.withResolvers(),page=Promise.withResolvers();
 const state={created:0,closed:0,onPage:async()=>{entered.resolve();await page.promise;},onClose:async()=>{closeEntered.resolve();await release.promise;page.resolve();}};
 const history=new SqliteHistoryService(f.storage,f.contacts,guardedChannelFactory(state));t.after(()=>history.close());
 const contact=f.saved[0].contact_id,reading=history.synchronize(contact).then(()=>null,error=>error);await entered.promise;
 let stopped=false;const stopping=history.stop(contact).then(()=>{stopped=true;});await closeEntered.promise;assert.equal(stopped,false);
 release.resolve();await stopping;assert.ok(await reading);assert.equal((await history.read(contact)).messages.length,0);assert.equal(state.closed,1);
});

test('无守卫的其他渠道不能借用同进程的活守卫读取正文',async t=>{
 const f=await fixture(t),state={created:0,closed:0},history=new SqliteHistoryService(f.storage,f.contacts,guardedChannelFactory(state));t.after(()=>history.close());
 const contact=f.saved[0].contact_id;await history.synchronize(contact);let pages=0;f.channel.page=async()=>{pages++;throw new Error('不得读取');};
 await assert.rejects(f.service.synchronize(contact),{code:'history_source_continuity_unverified'});assert.equal(pages,0);await history.close();
});

test('数据库重开不复活旧守卫，本机来源保留且重新核验后可续读',async t=>{
 const f=await fixture(t),state={created:0,closed:0},history=new SqliteHistoryService(f.storage,f.contacts,guardedChannelFactory(state));t.after(()=>history.close().catch(()=>{}));
 const contact=f.saved[0].contact_id;await history.synchronize(contact);const source=(await history.read(contact)).messages[0].sourceRecordIds[0];
 const guard=(await snapshot(f,contact)).guardAtKey,token=await f.contacts.eligibility(contact);
 const databaseId=f.storage.status.databaseId;await f.storage.close();
 const reopened=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:databaseId,registryModule:guardRegistry});t.after(()=>reopened.close());
 const read=await reopened.execute('history.read',{ownerId:f.contacts.ownerId,contactId:contact,limit:100});assert.equal(read.replyEligibility,'ready');
 assert.ok(await reopened.execute('history.source',{ownerId:f.contacts.ownerId,contactId:contact,recordId:source}));
 assert.equal(await reopened.execute('history.guardCheck',{token,guardId:guard.guard_id}),false);
 const contacts={ownerId:f.contacts.ownerId,
  eligibility:contactId=>reopened.execute('identity.eligibility',{ownerId:f.contacts.ownerId,contactId}),
  validate:token=>reopened.execute('identity.validate',{ownerId:f.contacts.ownerId,token})};
 const resumedState={created:0,closed:0},create=guardedChannelFactory(resumedState);let inspections=0;
 const resumed=new SqliteHistoryService(reopened,contacts,()=>{const channel=create(),inspect=channel.inspect;channel.inspect=async(...args)=>{inspections++;return inspect(...args);};return channel;});
 t.after(()=>resumed.close());
 assert.equal((await resumed.synchronize(contact)).phase,'complete');assert.ok(inspections>=1);assert.equal(resumedState.created,1);assert.equal(resumedState.pageCalls,1);
 assert.equal((await resumed.read(contact)).messages.length,1);assert.equal(await reopened.execute('history.guardCheck',{token,guardId:guard.guard_id}),false);await resumed.close();
});

test('删除来源排空空闲守卫，随后同步仍不能复活被抑制来源',async t=>{
 const f=await fixture(t),state={created:0,closed:0},history=new SqliteHistoryService(f.storage,f.contacts,guardedChannelFactory(state));t.after(()=>history.close());
 const contact=f.saved[0].contact_id;await history.synchronize(contact);const source=(await history.read(contact)).messages[0].sourceRecordIds[0];
 const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts'),{ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');
 const deletion=new DeletionService(f.storage,history.holders,new ManagedFiles(f.root));const op=await deletion.plan({ownerId:f.contacts.ownerId,requestKey:'synthetic-guarded-source-delete',scope:{kind:'source',contactId:contact,sourceId:source}});
 assert.equal((await deletion.advance(op)).state,'completed');assert.equal(state.closed,1);
 await assert.rejects(history.source(contact,source),{code:'history_source_not_found'});
 await history.synchronize(contact);assert.equal((await history.read(contact)).messages.length,0);assert.equal((await snapshot(f,contact)).proofs[0].state,'ok');await history.close();
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('普通守卫释放不失效本机依据，实际来源失效仍隔离跨联系人旧回复',async t=>{
 const f=await fixture(t,{registryModule:new URL('./fixtures/history/quarantine-registry.mjs',import.meta.url).href}),state={created:0,closed:0};
 const history=new SqliteHistoryService(f.storage,f.contacts,guardedChannelFactory(state));t.after(()=>history.close());const [a,b]=f.saved;
 await history.synchronize(a.contact_id);const message=(await history.read(a.contact_id)).messages[0];
 const {SqliteDiscussionService}=await import('../src/reply/sqlite/service.ts'),{randomUUID}=await import('node:crypto');
 const discussion=new SqliteDiscussionService(f.storage,f.contacts.ownerId),d=await discussion.newDiscussion(b.contact_id),key='synthetic-guard-dependency';
 const confirmationId=await f.contacts.manualConfirm(b.contact_id,key),attempt=(await discussion.begin(b.contact_id,key,'合成手写内容',{kind:'manual',confirmationId},d.id)).attempt,contextId=randomUUID();
 await f.storage.execute('discussion.freezeContext',{...attempt,contextId,skillRun:{packages:[],eligible:[]},items:[],at:Date.now()});
 await f.storage.execute('fixture.seedCrossContactInput',{ownerId:f.contacts.ownerId,contextId,sourceContactId:a.contact_id,messageId:message.id,recordId:message.sourceRecordIds[0]});
 assert.ok(!(await f.storage.execute('fixture.quarantineImpact',{ownerId:f.contacts.ownerId})).requests.includes(attempt.requestId));
 await history.stop(a.contact_id);
 assert.ok(!(await f.storage.execute('fixture.quarantineImpact',{ownerId:f.contacts.ownerId})).requests.includes(attempt.requestId));
 assert.ok(await discussion.trace(b.contact_id,d.id,attempt.requestId));
 await f.storage.execute('history.markContinuityLost',{token:await f.contacts.eligibility(a.contact_id)});
 assert.ok((await f.storage.execute('fixture.quarantineImpact',{ownerId:f.contacts.ownerId})).requests.includes(attempt.requestId));
 await assert.rejects(discussion.trace(b.contact_id,d.id,attempt.requestId),{code:'discussion_unavailable'});
 assert.equal((await discussion.view(b.contact_id,d.id)).entries[0].body,'合成手写内容');
});

test('后台守卫意外退出后重新核验相同来源可续读，旧守卫仍失效',async t=>{
 const f=await fixture(t),state={created:0,closed:0},history=new SqliteHistoryService(f.storage,f.contacts,guardedChannelFactory(state));t.after(()=>history.close());
 const contact=f.saved[0].contact_id;await history.synchronize(contact);const guard=(await snapshot(f,contact)).guardAtKey,token=await f.contacts.eligibility(contact);state.lose();await history.stop(contact);
 assert.equal((await history.synchronize(contact)).phase,'complete');assert.equal(state.created,2);assert.equal(state.closed,1);
 assert.equal((await history.read(contact)).messages.length,1);assert.equal((await snapshot(f,contact)).proofs[0].state,'ok');
 assert.equal(await f.storage.execute('history.guardCheck',{token,guardId:guard.guard_id}),false);await history.close();
});

test('旧模式守卫退出后仍逐项核验账号会话代次和物理表，冲突不读正文',async t=>{
 for(const change of ['accountKey','conversationKey','sourceGeneration','table'])await t.test(change,async t=>{
  const f=await fixture(t),state={created:0,closed:0},history=new SqliteHistoryService(f.storage,f.contacts,guardedChannelFactory(state));t.after(()=>history.close());
  const contact=f.saved[0].contact_id;await history.synchronize(contact);state.lose();await history.stop(contact);
  if(change==='table')state.targetOverride={tables:[{partition:'p',instance:'replacement-t'}]};
  else state.reportOverride={[change]:'synthetic-changed-identity'};
  await assert.rejects(history.synchronize(contact),{code:change==='table'?'history_source_continuity_unverified':'history_external_scope_changed'});
  assert.equal(state.pageCalls,1);assert.equal((await history.read(contact)).messages.length,1);
  assert.equal((await snapshot(f,contact)).proofs[0].state,'needs_confirmation');
 });
});

test('守卫意外退出时立即中断在途读取，不等待失证写入',async t=>{
 const f=await fixture(t),entered=Promise.withResolvers(),pageGate=Promise.withResolvers(),releaseGate=Promise.withResolvers();
 let pageSignal;const state={created:0,closed:0,onPage:async signal=>{pageSignal=signal;entered.resolve();await pageGate.promise;}};
 const proxy={status:f.storage.status,execute:async(name,input,...rest)=>{if(name==='history.guardRelease')await releaseGate.promise;return f.storage.execute(name,input,...rest);},close:()=>f.storage.close()};
 const history=new SqliteHistoryService(proxy,f.contacts,guardedChannelFactory(state));t.after(async()=>{pageGate.resolve();releaseGate.resolve();await history.close().catch(()=>{});});
 const contact=f.saved[0].contact_id,reading=history.synchronize(contact).then(()=>null,error=>error);await entered.promise;
 state.lose();await Promise.resolve();
 try{assert.equal(pageSignal.aborted,true);}finally{pageGate.resolve();releaseGate.resolve();}
 assert.ok(await reading);assert.equal((await history.read(contact)).messages.length,0);
});

test('尚未读取时守卫已经退出，不能进入正文分页',async t=>{
 const f=await fixture(t),state={created:0,closed:0};let pages=0;
 const create=guardedChannelFactory(state),history=new SqliteHistoryService(f.storage,f.contacts,()=>{const channel=create();channel.guardSession={loss:Promise.resolve()};channel.page=async()=>{pages++;throw new Error('不得读取');};return channel;});
 t.after(()=>history.close().catch(()=>{}));const contact=f.saved[0].contact_id;
 await assert.rejects(history.synchronize(contact));assert.equal(pages,0);assert.notEqual((await history.coverage(contact)).phase,'complete');assert.equal(await history.bodyAvailable([contact]),false);
});

test('易失守卫释放事务失败时关闭存储，重开后旧凭证失效且本机依据保留',async t=>{
 const f=await fixture(t),state={created:0,closed:0};let releases=0,storageCloses=0;
 const proxy={status:f.storage.status,execute:(name,input,...rest)=>name==='history.guardRelease'?(releases++,Promise.reject(new StorageFailure('storage_busy'))):f.storage.execute(name,input,...rest),close:()=>{storageCloses++;return f.storage.close();}};
 const history=new SqliteHistoryService(proxy,f.contacts,guardedChannelFactory(state));t.after(()=>history.close().catch(()=>{}));
 const contact=f.saved[0].contact_id;await history.synchronize(contact);const databaseId=f.storage.status.databaseId,guard=(await snapshot(f,contact)).guardAtKey,token=await f.contacts.eligibility(contact);
 await assert.rejects(history.stop(contact),{code:'storage_busy'});assert.equal(state.closed,1);
 await assert.rejects(f.storage.execute('history.read',{ownerId:f.contacts.ownerId,contactId:contact}),{code:'worker_failed'});
 await history.stop(contact);await history.close();
 assert.equal(releases,1,'存储已关闭后的重试不得再执行守卫写入');assert.equal(storageCloses,1);
 const reopened=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:databaseId});t.after(()=>reopened.close());
 assert.equal((await reopened.execute('history.read',{ownerId:f.contacts.ownerId,contactId:contact,limit:100})).replyEligibility,'ready');
 assert.equal(await reopened.execute('history.guardCheck',{token,guardId:guard.guard_id}),false);
});

test('守卫释放事务失败后的停读重试仍须排空未关闭的渠道',async t=>{
 const f=await fixture(t),state={created:0,closed:0},create=guardedChannelFactory(state);let releases=0,closeAttempts=0;
 const proxy={status:f.storage.status,execute:(name,input,...rest)=>name==='history.guardRelease'?(releases++,Promise.reject(new StorageFailure('storage_busy'))):f.storage.execute(name,input,...rest),close:()=>f.storage.close()};
 const history=new SqliteHistoryService(proxy,f.contacts,()=>{const channel=create(),close=channel.close;channel.close=async()=>{if(++closeAttempts===1)throw new StorageFailure('history_native_unavailable');await close();};return channel;});
 t.after(()=>history.close().catch(()=>{}));const contact=f.saved[0].contact_id;await history.synchronize(contact);
 await assert.rejects(history.stop(contact),{code:'storage_busy'});assert.equal(state.closed,0);
 await history.stop(contact);assert.equal(state.closed,1);assert.equal(closeAttempts,2);assert.equal(releases,1);
 await history.stop(contact);assert.equal(closeAttempts,2,'真实排空完成后才结算并移除守卫');
});

test('存储关闭未获确认时保留守卫并在停读重试中继续关闭',async t=>{
 const f=await fixture(t),state={created:0,closed:0};let releases=0,storageCloses=0;
 const proxy={status:f.storage.status,execute:(name,input,...rest)=>name==='history.guardRelease'?(releases++,Promise.reject(new StorageFailure('storage_busy'))):f.storage.execute(name,input,...rest),close:async()=>{if(++storageCloses===1)throw new StorageFailure('storage_close_unconfirmed');await f.storage.close();}};
 const history=new SqliteHistoryService(proxy,f.contacts,guardedChannelFactory(state));t.after(()=>history.close().catch(()=>{}));const contact=f.saved[0].contact_id;
 await history.synchronize(contact);await assert.rejects(history.stop(contact),{code:'storage_busy'});assert.equal(storageCloses,1);
 await history.stop(contact);assert.equal(storageCloses,2);assert.equal(releases,1);
 await assert.rejects(f.storage.execute('history.read',{ownerId:f.contacts.ownerId,contactId:contact}),{code:'worker_failed'});
});

test('预目标空proof恢复仅清除本联系人空事实，不触碰其他历史与排除',async t=>{
 const f=await fixture(t),[a,b]=f.saved,token=await f.contacts.eligibility(a.contact_id),other=await f.contacts.eligibility(b.contact_id);
 await f.service.synchronize(b.contact_id);await f.storage.execute('fixture.guardSeedExclusion',{token:other});
 await f.storage.execute('fixture.guardSeedEmpty',{token});const before=await snapshot(f,a.contact_id);
 assert.equal(before.proofs[0].state,'needs_confirmation');assert.equal(before.guards[0].state,'lost');assert.ok(before.counts.message>0n);assert.equal(before.exclusions.length,1);
 assert.equal(await f.storage.execute('history.preflightGeneration',{token}),true);
 const after=await snapshot(f,a.contact_id);assert.equal(after.proofs.length,0);assert.equal(after.guards.length,0);
 assert.deepEqual(after.counts,before.counts);assert.deepEqual(after.exclusions,before.exclusions);assert.equal(after.legacyTables.length,0);
 assert.equal(await f.storage.execute('history.preflightGeneration',{token}),true);assert.deepEqual(await snapshot(f,a.contact_id),after);
});

test('本联系人已有排除时空proof不得自动恢复或擦除抑制',async t=>{
 const f=await fixture(t),token=await f.contacts.eligibility(f.saved[0].contact_id);
 await f.storage.execute('fixture.guardSeedEmpty',{token});await f.storage.execute('fixture.guardSeedExclusion',{token});
 const before=await snapshot(f,token.contact_id);assert.equal(before.exclusions.length,1);
 assert.equal(await f.storage.execute('history.preflightGeneration',{token}),false);
 const after=await snapshot(f,token.contact_id);assert.deepEqual(after,before);assert.equal(after.proofs[0].state,'needs_confirmation');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('空历史首次尝试的守卫断开后可安全重建连续性，旧守卫仍失效',async t=>{
 const f=await fixture(t),contact=f.saved[0].contact_id,token=await f.contacts.eligibility(contact);
 assert.equal(await f.storage.execute('history.preflightGeneration',{token}),true);
 assert.equal(await f.storage.execute('history.guardAcquire',{token,guardId:'synthetic-guard-1'}),true);
 assert.equal(await f.storage.execute('history.guardCheck',{token,guardId:'synthetic-guard-1'}),true);
 assert.equal(await f.storage.execute('history.guardRelease',{token,guardId:'synthetic-guard-1'}),true);
 assert.equal(await f.storage.execute('history.guardCheck',{token,guardId:'synthetic-guard-1'}),false);
 assert.equal((await f.service.coverage(contact)).phase,'not_started','释放守卫不制造持久来源事实或历史覆盖');
 assert.equal((await snapshot(f,contact)).proofs.length,0);
 assert.equal(await f.storage.execute('history.preflightGeneration',{token}),true,'无历史和边界时，预检允许新守卫');
 assert.equal((await f.service.coverage(contact)).phase,'not_started','预检没有制造历史覆盖');
 assert.equal(await f.storage.execute('history.guardAcquire',{token,guardId:'synthetic-guard-2'}),true);
 assert.equal(await f.storage.execute('history.guardCheck',{token,guardId:'synthetic-guard-1'}),false,'旧守卫凭证不能恢复');
 assert.equal((await f.service.coverage(contact)).messageCount,0);
});

test('同范围活守卫的竞争申请失败但不毒化当前守卫',async t=>{
 const f=await fixture(t),contact=f.saved[0].contact_id,token=await f.contacts.eligibility(contact);
 assert.equal(await f.storage.execute('history.preflightGeneration',{token}),true);
 assert.equal(await f.storage.execute('history.guardAcquire',{token,guardId:'synthetic-live-guard'}),true);
 assert.equal(await f.storage.execute('history.guardAcquire',{token,guardId:'synthetic-competing-guard'}),false);
 assert.equal(await f.storage.execute('history.preflightGeneration',{token}),true);
 assert.equal(await f.storage.execute('history.guardCheck',{token,guardId:'synthetic-live-guard'}),true);
});

test('已观察目标即使无消息也不允许自动重建连续性基线',async t=>{
 const f=await fixture(t),contact=f.saved[0].contact_id,token=await f.contacts.eligibility(contact);
 assert.equal(await f.storage.execute('history.preflightGeneration',{token}),true);
 assert.equal(await f.storage.execute('history.preflightContinuity',{token,target:f.target}),true);
 await f.storage.execute('history.markContinuityLost',{token});
 assert.equal(await f.storage.execute('history.preflightGeneration',{token}),false,'目标分片清单已经成为读取基线的一部分');
 assert.equal((await f.service.coverage(contact)).messageCount,0);
});

test('未完成目标的暂时读取失败保留来源事实，重新核验可续读',async t=>{
 const f=await fixture(t),state={created:0,closed:0},create=guardedChannelFactory(state),contact=f.saved[0].contact_id;let first=true;
 const history=new SqliteHistoryService(f.storage,f.contacts,()=>{
  const channel=create(),page=channel.page;channel.page=async(...args)=>{if(first){first=false;throw new StorageFailure('history_native_unavailable');}return page(...args);};return channel;
 });t.after(()=>history.close());
 await assert.rejects(history.synchronize(contact),{code:'history_native_unavailable'});
 const coverage=await history.coverage(contact);assert.equal(coverage.phase,'incomplete');assert.equal(coverage.messageCount,0);assert.equal(coverage.failureCode,'history_native_unavailable');
 const token=await f.contacts.eligibility(contact);
 assert.equal(await f.storage.execute('history.preflightGeneration',{token}),true);assert.equal((await snapshot(f,contact)).proofs[0].state,'ok');
 assert.equal((await history.synchronize(contact)).phase,'complete');assert.equal((await history.read(contact)).messages.length,1);await history.close();
});

test('实际数据库重开后的运行代次不同，未续证的旧守卫不能续读',async t=>{
 const f=await fixture(t),token=await f.contacts.eligibility(f.saved[0].contact_id);
 assert.equal(await f.storage.execute('history.preflightGeneration',{token}),true);
 assert.equal(await f.storage.execute('history.guardAcquire',{token,guardId:'synthetic-guard-1'}),true);
 const databaseId=f.storage.status.databaseId;await f.service.close();await f.storage.close();
 const reopened=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:databaseId});t.after(()=>reopened.close());
 assert.equal(await reopened.execute('history.guardCheck',{token,guardId:'synthetic-guard-1'}),false);
 assert.equal(await reopened.execute('history.preflightGeneration',{token}),true);
 assert.equal(await reopened.execute('history.guardAcquire',{token,guardId:'synthetic-guard-2'}),true);
 assert.equal(await reopened.execute('history.guardCheck',{token,guardId:'synthetic-guard-1'}),false);
 assert.equal(await reopened.execute('history.guardCheck',{token,guardId:'synthetic-guard-2'}),true);
});

test('已有合格来源可申请本次新守卫，物理目标冲突仍失证且不删除历史',async t=>{
 const f=await fixture(t),contact=f.saved[0].contact_id;await f.service.synchronize(contact);
 const token=await f.contacts.eligibility(contact);
 assert.equal(await f.storage.execute('history.guardAcquire',{token,guardId:'synthetic-new-guard'}),true);
 assert.equal(await f.storage.execute('history.preflightGeneration',{token}),true);
 assert.equal(await f.storage.execute('history.guardCheck',{token,guardId:'synthetic-new-guard'}),true);
 assert.equal(await f.storage.execute('history.preflightContinuity',{token,target:{...f.target,tables:[{partition:'shard-a',instance:'changed-table'}]}}),false);
 assert.equal(await f.storage.execute('history.guardCheck',{token,guardId:'synthetic-new-guard'}),false);
 assert.equal((await snapshot(f,contact)).proofs[0].state,'needs_confirmation');assert.equal((await f.service.read(contact)).messages.length,2);
});

test('明确重读尚未接入守卫时在读取正文前停下',async t=>{
 const f=await fixture(t),state={created:0,closed:0};let pages=0;
 const {SqliteHistoryResyncService}=await import('../src/history/sqlite/resync.ts'),create=guardedChannelFactory(state);
 const resync=new SqliteHistoryResyncService(f.storage,f.contacts,()=>{const channel=create();channel.page=async()=>{pages++;throw new Error('不得读取');};return channel;});t.after(()=>resync.close());
 await assert.rejects(resync.resync(f.saved[0].contact_id,{requestKey:'synthetic-guarded-resync'}),{code:'history_source_continuity_unverified'});
 assert.equal(pages,0);assert.equal(state.closed,1);
});

test('联系人没有持久来源事实时删除仍清除易失守卫并保持外键完整',async t=>{
 const f=await fixture(t),contact=f.saved[0].contact_id,token=await f.contacts.eligibility(contact);
 assert.equal(await f.storage.execute('history.preflightGeneration',{token}),true);
 assert.equal(await f.storage.execute('history.guardAcquire',{token,guardId:'synthetic-delete-guard'}),true);
 assert.equal((await snapshot(f,contact)).proofs.length,0);assert.equal((await snapshot(f,contact)).guardAtKey.state,'active');
 const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts'),{ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');
 const deletion=new DeletionService(f.storage,f.service.holders,new ManagedFiles(f.root));
 const op=await deletion.plan({ownerId:token.owner_id,requestKey:'synthetic-guard-delete',scope:{kind:'contact',contactId:contact}});
 assert.equal((await deletion.advance(op)).state,'completed');const after=await snapshot(f,contact);assert.equal(after.proofs.length,0);assert.equal(after.guardAtKey,null);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});


test('整账号没有持久来源事实时删除仍清除每位联系人的易失守卫',async t=>{
 const f=await fixture(t),tokens=await Promise.all(f.saved.map(contact=>f.contacts.eligibility(contact.contact_id)));
 for(const [index,token] of tokens.entries()){
  assert.equal(await f.storage.execute('history.guardAcquire',{token,guardId:`synthetic-account-guard-${index}`}),true);
  const before=await snapshot(f,token.contact_id);assert.equal(before.proofs.length,0);assert.equal(before.guardAtKey.state,'active');
 }
 const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts'),{ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');
 const deletion=new DeletionService(f.storage,f.service.holders,new ManagedFiles(f.root));
 const op=await deletion.plan({ownerId:f.contacts.ownerId,requestKey:'synthetic-account-guard-delete',scope:{kind:'account'}});
 assert.equal((await deletion.advance(op)).state,'completed');
 for(const token of tokens){const after=await snapshot(f,token.contact_id);assert.equal(after.proofs.length,0);assert.equal(after.guardAtKey,null);}
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('守卫释放写失败但读者与通道都已关闭时，删除不再被残留holder阻挡',async t=>{
 const f=await createFixture(t),holders=new ActiveHolders(),id=f.saved[0].contact_id,token=await f.contacts.eligibility(id);
 const proxy={status:f.storage.status,
  execute:(name,input,...rest)=>name==='history.guardRelease'?Promise.reject(new StorageFailure('storage_busy')):f.storage.execute(name,input,...rest),
  close:()=>f.storage.close()};
 const history=new SqliteHistoryService(proxy,f.contacts,guardedChannelFactory({created:0,closed:0}),holders);
 t.after(async()=>{await history.close().catch(()=>{});});
 // 保留条目在停读时统一释放守卫并关闭通道；保留语义下读取本身继续成功。
 await history.synchronize(id);
 await assert.rejects(history.stop(id),{code:'storage_busy'});
 // 排空失败只负责上报：读者与通道的官方关闭都已完成，holder不得继续阻挡删除。
 const operation={ownerId:f.contacts.ownerId,scope:{kind:'source',contactId:id,sourceId:'synthetic-source'},acceptedGeneration:BigInt(token.data_generation)+1n};
 assert.equal(holders.verify(operation,[]),true);
});

test('关闭失败后来源准备应重试真实排空，不循环等待已结束的工作',async t=>{
 const f=await createFixture(t),id=f.saved[0].contact_id;let closes=0;
 const create=()=>{
  const loss=Promise.withResolvers();
  return {...f.channel,guardSession:{loss:loss.promise},
   close:async()=>{if(++closes===1)throw new StorageFailure('history_native_unavailable');}};
 };
 const history=new SqliteHistoryService(f.storage,f.contacts,create);
 t.after(async()=>{await history.close().catch(()=>{});});
 // 保留条目的通道关闭延后到停读统一执行；关闭失败后来源准备先重试真实排空再新开读者。
 await history.synchronize(id);
 await assert.rejects(history.stop(id),{code:'history_native_unavailable'});
 await history.prepareSource(id);
 assert.ok(closes>=2,`来源准备为排除失败读者真实重试了 ${closes} 次关闭`);
});
