import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite/client.ts';
import { StorageFailure } from '../src/storage/sqlite/contracts.ts';
import { SqliteContactService } from '../src/contacts/sqlite/service.ts';
import { SqliteHistoryService } from '../src/history/sqlite/service.ts';
import { FirstHistoryCoordinator } from '../src/history/sqlite/coordinator.ts';
import { setTimeout as delay } from 'node:timers/promises';

const owner='00000000-0000-4000-8000-000000000083';
const evidence={externalKey:'synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-metadata-v1'};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function page(scope,target,cursor,changes={}) {
 return {target:target.descriptor,cursorIn:cursor,cursorOut:null,completedPartitions:['p'],exhausted:true,
 records:[{partition:'p',table:'t',localId:'1',serverId:'0',sender:'contact',kind:'text',text:`合成${scope.conversationKey}`,originalType:'1',sentAt:'1700000000000',timePrecision:'second',orderScheme:null,orderKey:null,stateAssurance:'verified',status:'0'}],...changes};
}
async function fixture(t,names=['a','b','c']) {
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-first-history-')));
 const state={creates:0,inspects:0,inspectedContacts:[],targets:0,pages:[],closes:0,support:'supported',continuity:'source-1',pageHook:null,closeHook:null};
 const createMetadata=()=>({account:async()=>({...evidence}),sessions:async()=>names.map(name=>({externalKey:`friend-${name}`,displayName:`合成${name}`,kind:'private',identityAssurance:'verified'}))});
 const createChannel=()=>{state.creates++;let closed=false,heldContact;
  return {...(state.continuity==='same-source-instances-normal-use-v1'?{guardSession:{loss:new Promise(()=>{})}}:{}),inspect:async scope=>{heldContact=scope.token.contact_id;state.inspects++;state.inspectedContacts.push(scope.token.contact_id);return {protocol:'private-history-v1',profileId:'synthetic-history-v1',adapterVersion:'1',status:state.support,reason:state.support==='supported'?null:'synthetic_unverified',accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation,programVersion:'synthetic',build:'1',artifactSha256:'a'.repeat(64),schemaFingerprint:'b'.repeat(64),declaredPrimaryKey:['local_id'],identity:'source-table-local-v1',statusSemantics:'synthetic-final',continuity:state.continuity,serverAliasSemantics:'unverified'};},
  target:async scope=>{state.targets++;return {protocol:'private-history-v1',descriptor:`synthetic:${scope.conversationKey}`,partitions:['p'],tables:[{partition:'p',instance:'t'}],sourceGeneration:'source-1'};},
  page:async(scope,target,cursor,signal)=>{state.pages.push({contactId:scope.token.contact_id,conversation:scope.conversationKey,cursor});return state.pageHook?state.pageHook(scope,target,cursor,signal):page(scope,target,cursor);},
  close:async()=>{if(closed)return;closed=true;state.closes++;await state.closeHook?.(heldContact);}};
 };
 const f={root,state,createMetadata,createChannel};
 f.storage=await SqliteStorage.open({userData:root,intent:'create',role:'test'});f.databaseId=f.storage.status.databaseId;
 f.contacts=new SqliteContactService(f.storage,owner,createMetadata());await f.contacts.initialize();
 f.history=new SqliteHistoryService(f.storage,f.contacts,createChannel);f.coordinator=new FirstHistoryCoordinator(f.contacts,f.history);
 t.after(async()=>{await f.coordinator.close();await f.history.close();await f.contacts.close();await f.storage.close();await rm(root,{recursive:true,force:true});});
 return f;
}
async function select(f,names=['a']) {
 if(!(await f.contacts.directory()).account){const candidate=await f.contacts.detectAccount();await f.contacts.confirmAccount(candidate.candidate_token);}
 const snapshot=await f.contacts.candidates(true);
 const choices=snapshot.sessions.filter(row=>names.includes(row.username.slice('friend-'.length))).map(row=>({locator:row.username,observed_display_name:row.display_name,expected_selection_generation:row.selection_generation}));
 await f.contacts.confirm(snapshot.snapshot_token,choices);
 return (await f.contacts.directory()).bindings.filter(binding=>binding.status==='active');
}
async function wake(f){f.coordinator.wake();await f.coordinator.waitForIdle();}

test('未选和读取关闭时零渠道IO，正常确认与开启wake首次形成正式来源消息和complete',async t=>{
 const f=await fixture(t);await wake(f);assert.equal(f.state.creates,0);
 await f.contacts.setReading(true);await wake(f);assert.equal(f.state.creates,0);
 await f.contacts.setReading(false);const [binding]=await select(f);await wake(f);assert.equal(f.state.creates,0);
 assert.deepEqual((await f.history.read(binding.contact_id)).messages,[]);
 await f.contacts.setReading(true);await wake(f);
 const read=await f.history.read(binding.contact_id);
 assert.equal(read.coverage.phase,'complete');assert.equal(read.messages.length,1);assert.equal(read.messages[0].text,'合成friend-a');
 assert.equal(read.messages[0].sourceRecordIds.length,1);assert.equal(f.coordinator.getState().lastError,null);
 assert.equal(f.state.pages.length,1);assert.equal(f.state.closes,1);
 await wake(f);assert.equal(f.state.pages.length,1);
});

test('未知支持档只有结构检查且不读正文，重复wake合并，失败仅新wake重试且不回传异常',async t=>{
 const f=await fixture(t);await select(f);await f.contacts.setReading(true);f.state.support='unverified';
 for(let n=0;n<20;n++)f.coordinator.wake();await f.coordinator.waitForIdle();
 assert.equal(f.state.inspects,1);assert.equal(f.state.targets,0);assert.equal(f.state.pages.length,0);
 assert.equal(f.coordinator.getState().phase,'blocked');assert.equal(f.coordinator.getState().lastError,'history_support_unverified');
 await wake(f);assert.equal(f.state.inspects,2);assert.equal(f.state.pages.length,0);
 f.state.support='supported';f.state.pageHook=async()=>{throw new Error('PRIVATE_CHAT_SHOULD_NEVER_LEAK');};
 await wake(f);assert.equal(f.coordinator.getState().lastError,'history_first_read_failed');
 assert.equal(JSON.stringify(f.coordinator.getState()).includes('PRIVATE_CHAT'),false);
 const attempts=f.state.pages.length;await f.coordinator.waitForIdle();assert.equal(f.state.pages.length,attempts);
 f.state.pageHook=null;await wake(f);assert.equal(f.coordinator.getState().lastError,null);
 assert.equal((await f.history.coverage((await f.contacts.directory()).bindings[0].contact_id)).phase,'complete');
});

test('wakeContact 只重试指定联系人的首次历史',async t=>{
 const f=await fixture(t);const bindings=await select(f,['a','b']);await f.contacts.setReading(true);f.state.support='unverified';
 f.coordinator.wake();await f.coordinator.waitForIdle();assert.equal(f.state.inspectedContacts.length,2);
 const target=bindings.find(binding=>binding.conversation_locator==='friend-a');assert.ok(target);
 const other=bindings.find(binding=>binding.contact_id!==target.contact_id);assert.ok(other);
 f.coordinator.wakeContact(target.contact_id);await f.coordinator.waitForIdle();
 assert.equal(f.state.inspectedContacts.length,3);
 assert.equal(f.state.inspectedContacts[2],target.contact_id);
 assert.equal(f.state.inspectedContacts.filter(id=>id===other.contact_id).length,1);
});

test('历史遍历完成但存在未核验状态时保留准确原因，不误报首次读取失败',async t=>{
 const f=await fixture(t);await select(f);await f.contacts.setReading(true);
 f.state.pageHook=async(scope,target,cursor)=>{const result=page(scope,target,cursor);result.records[0].stateAssurance='unverified';result.records[0].text=null;return result;};
 await wake(f);
 assert.equal(f.coordinator.getState().contacts[0].phase,'incomplete');
 assert.equal(f.coordinator.getState().lastError,'history_identity_quarantined');
});

test('历史页预算耗尽后自动接续当前目标，直到所有分片遍历结束',async t=>{
 const f=await fixture(t);const [binding]=await select(f);await f.contacts.setReading(true);
 f.state.pageHook=async(scope,target,cursor)=>{
  const index=cursor===null?0:Number(cursor.slice('synthetic-page-'.length));
  assert.equal(index,f.state.pages.length-1);
  const final=index===1000;
  return page(scope,target,cursor,{cursorOut:final?null:`synthetic-page-${index+1}`,records:final?page(scope,target,cursor).records:[],completedPartitions:final?['p']:[],exhausted:final});
 };
 await wake(f);
 const coverage=await f.history.coverage(binding.contact_id);
 assert.equal(coverage.phase,'complete');assert.equal(coverage.pageCount,1001);
 assert.equal(f.state.pages.length,1001);assert.equal(f.state.pages[1000].cursor,'synthetic-page-1000');
 assert.equal(f.coordinator.getState().contacts[0].phase,'complete');
});

test('未核验旧行不遮蔽页预算接续，自动读完后仍诚实标为历史不完整',async t=>{
 const f=await fixture(t);const [binding]=await select(f);await f.contacts.setReading(true);
 f.state.pageHook=async(scope,target,cursor)=>{
  const index=cursor===null?0:Number(cursor.slice('synthetic-page-'.length)),final=index===1000;
  const records=final?page(scope,target,cursor).records:index===0?[{...page(scope,target,cursor).records[0],localId:'2',stateAssurance:'unverified',text:null}]:[];
  return page(scope,target,cursor,{cursorOut:final?null:`synthetic-page-${index+1}`,records,completedPartitions:final?['p']:[],exhausted:final});
 };
 await wake(f);const coverage=await f.history.coverage(binding.contact_id);
 assert.equal(coverage.traversalComplete,true);assert.equal(coverage.pageCount,1001);assert.equal(coverage.phase,'incomplete');
 assert.equal(coverage.failureCode,'history_identity_quarantined');assert.equal(coverage.messageCount,1);
});

test('预算接续没有推进游标时停止，不形成后台空转',async t=>{
 const binding={contact_id:'synthetic-contact',binding_id:'synthetic-binding',grant_id:'synthetic-grant',selection_generation:'1',status:'active'};
 let calls=0;
 const history={coverage:async()=>({phase:'not_started'}),synchronize:async()=>{
  if(++calls>2)throw new Error('不得再次空转');
  return {phase:'incomplete',cursor:'unchanged-cursor',traversalComplete:false,failureCode:'history_page_budget_exhausted'};
 },stop:async()=>{}};
 const coordinator=new FirstHistoryCoordinator({directory:async()=>({read_enabled:true,bindings:[binding]})},history);
 t.after(()=>coordinator.close());coordinator.wake();await coordinator.waitForIdle();
 assert.equal(calls,2);assert.equal(coordinator.getState().contacts[0].phase,'incomplete');
});

test('大历史的预算接续优先于尚未打开的会话，避免固定快照在队尾过期',async t=>{
 const f=await fixture(t);await select(f,['a','b','c']);await f.contacts.setReading(true);
 await f.coordinator.close();f.coordinator=new FirstHistoryCoordinator({directory:async()=>{
  const directory=await f.contacts.directory();return {...directory,bindings:directory.bindings.toSorted((a,b)=>a.conversation_locator.localeCompare(b.conversation_locator))};
 }},f.history);
 const otherActive=deferred();let pagesA=0,continuationBeforeQueuedContact=false;
 f.state.pageHook=async(scope,target,cursor)=>{
  if(scope.conversationKey==='friend-b')await otherActive.promise;
  if(scope.conversationKey==='friend-c'){
   continuationBeforeQueuedContact=pagesA===1001;otherActive.resolve();
  }
  if(scope.conversationKey!=='friend-a')return page(scope,target,cursor);
  const final=++pagesA===1001;
  return page(scope,target,cursor,{cursorOut:final?null:`synthetic-page-${pagesA}`,records:[],completedPartitions:final?['p']:[],exhausted:final});
 };
 await wake(f);
 assert.equal(continuationBeforeQueuedContact,true,'已有固定目标必须先接续，再为新会话打开快照');
 assert.equal(pagesA,1001);
});

test('并发最多两个联系人，同联系人duplicate wake不并发且消息来源不串人',async t=>{
 const f=await fixture(t);const bindings=await select(f,['a','b','c']);await f.contacts.setReading(true);
 const allEntered=[deferred(),deferred(),deferred()],gates=new Map();let active=0,maximum=0,count=0;
 f.state.pageHook=async(scope,target,cursor)=>{const gate=deferred();gates.set(scope.token.contact_id,gate);active++;maximum=Math.max(maximum,active);allEntered[count++].resolve();try{await gate.promise;return page(scope,target,cursor);}finally{active--;}};
 f.coordinator.wake();await allEntered[1].promise;assert.equal(f.state.pages.length,2);assert.equal(maximum,2);
 for(let i=0;i<25;i++)f.coordinator.wake();for(const gate of gates.values())gate.resolve();
 await allEntered[2].promise;for(const gate of gates.values())gate.resolve();await f.coordinator.waitForIdle();
 assert.equal(f.state.pages.length,3);assert.equal(maximum,2);
 const sources=new Set();for(const binding of bindings){const read=await f.history.read(binding.contact_id);assert.equal(read.coverage.phase,'complete');assert.equal(read.messages.length,1);assert.equal(read.messages[0].text,`合成${binding.conversation_locator}`);sources.add(read.messages[0].sourceRecordIds[0]);}
 assert.equal(sources.size,3);assert.equal(active,0);
});

test('关闭读取排空active与queued，旧页迟到不写入；重新开启的新wake可继续',async t=>{
 const f=await fixture(t);const bindings=await select(f,['a','b','c']);await f.contacts.setReading(true);
 const entered=deferred(),release=deferred();let running=0,returned=0;
 f.state.pageHook=async(scope,target,cursor)=>{running++;if(running===2)entered.resolve();await release.promise;returned++;return page(scope,target,cursor);};
 f.state.closeHook=async()=>release.resolve();
 f.coordinator.wake();await entered.promise;await f.contacts.setReading(false);await f.coordinator.stop();await f.coordinator.waitForIdle();
 assert.equal(returned,2);assert.equal(f.state.pages.length,2);
 for(const binding of bindings)assert.equal((await f.history.read(binding.contact_id)).messages.length,0);
 f.state.pageHook=null;f.state.closeHook=null;await f.contacts.setReading(true);await wake(f);
 for(const binding of bindings)assert.equal((await f.history.coverage(binding.contact_id)).phase,'complete');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('撤销active或queued联系人会排空其旧读者，不停止其他联系人，重选新grant可再wake',async t=>{
 for(const mode of ['active','queued']){
  const f=await fixture(t);const bindings=await select(f,['a','b','c']);await f.contacts.setReading(true);
  const gates=new Map(),entered=[deferred(),deferred(),deferred()];let count=0;
  f.state.pageHook=async(scope,target,cursor)=>{const gate=deferred();gates.set(scope.token.contact_id,gate);entered[count++].resolve();await gate.promise;return page(scope,target,cursor);};
  f.state.closeHook=async contactId=>gates.get(contactId)?.resolve();
  f.coordinator.wake();await entered[1].promise;
  const targetId=mode==='active'?[...gates.keys()][0]:bindings.find(binding=>!gates.has(binding.contact_id)).contact_id;
  const target=bindings.find(binding=>binding.contact_id===targetId);
  await f.contacts.revoke(target.contact_id,target.binding_id,target.selection_generation);await f.coordinator.stop(targetId);
  if(mode==='active')await entered[2].promise;
  for(const gate of gates.values())gate.resolve();await f.coordinator.waitForIdle();
  assert.equal((await f.history.read(targetId)).messages.length,0);
  for(const binding of bindings.filter(binding=>binding.contact_id!==targetId))assert.equal((await f.history.coverage(binding.contact_id)).phase,'complete');
  assert.equal(f.state.pages.filter(row=>row.contactId===targetId).length,mode==='active'?1:0);
  f.state.pageHook=null;f.state.closeHook=null;
  await select(f,[target.conversation_locator.slice('friend-'.length)]);await wake(f);
  assert.equal((await f.history.coverage(targetId)).phase,'complete');
 }
});

test('close等待真实page返回及渠道关闭，清空queued后不再响应wake',async t=>{
 const f=await fixture(t);const bindings=await select(f,['a','b','c']);await f.contacts.setReading(true);
 const entered=deferred(),release=deferred();let active=0;
 f.state.pageHook=async(scope,target,cursor)=>{active++;if(active===2)entered.resolve();try{await release.promise;return page(scope,target,cursor);}finally{active--;}};
 f.state.closeHook=async()=>release.resolve();
 f.coordinator.wake();await entered.promise;await f.coordinator.close();
 assert.equal(active,0);assert.equal(f.state.closes,2);assert.equal(f.state.pages.length,2);assert.equal(f.coordinator.getState().phase,'closed');
 f.coordinator.wake();await f.coordinator.waitForIdle();assert.equal(f.state.pages.length,2);
 for(const binding of bindings)assert.equal((await f.history.read(binding.contact_id)).messages.length,0);
});

async function reopen(f){
 await f.coordinator.close();await f.history.close();await f.contacts.close();await f.storage.close();
 f.storage=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:f.databaseId});
 f.contacts=new SqliteContactService(f.storage,owner,f.createMetadata());await f.contacts.initialize();
 f.history=new SqliteHistoryService(f.storage,f.contacts,f.createChannel);f.coordinator=new FirstHistoryCoordinator(f.contacts,f.history);
}
test('重开按持久cursor继续首次历史；来源不承认旧cursor时明确保留缺口，不重置为完整',async t=>{
 for(const mode of ['resume','invalid']){
  const f=await fixture(t);const [binding]=await select(f);await f.contacts.setReading(true);let resumed=false;
  f.state.pageHook=async(scope,target,cursor)=>{
   if(cursor===null)return page(scope,target,cursor,{cursorOut:'c1',completedPartitions:[],exhausted:false});
   if(!resumed)throw new StorageFailure('history_native_timeout');
   if(mode==='invalid')throw new StorageFailure('history_cursor_invalid');
   const value=page(scope,target,cursor);value.records[0]={...value.records[0],localId:'2',text:'合成后续页'};return value;
  };
  await wake(f);assert.equal((await f.history.coverage(binding.contact_id)).phase,'incomplete');
  assert.equal((await f.history.read(binding.contact_id)).messages.length,1);
  await reopen(f);resumed=true;await wake(f);
  const read=await f.history.read(binding.contact_id);
  assert.deepEqual(f.state.pages.map(page=>page.cursor),[null,'c1','c1']);assert.equal(f.state.targets,1);
  assert.equal(read.coverage.phase,mode==='resume'?'complete':'incomplete');assert.equal(read.messages.length,mode==='resume'?2:1);
  if(mode==='invalid'){assert.equal(read.coverage.failureCode,'history_cursor_invalid');assert.equal(f.coordinator.getState().lastError,'history_cursor_invalid');}
 }
});

test('旧读者关闭期间到来的新enable wake不会丢失，旧页拒绝后由新资格继续',async t=>{
 const f=await fixture(t);const [binding]=await select(f);await f.contacts.setReading(true);
 const entered=deferred(),pageRelease=deferred(),closeEntered=deferred(),closeRelease=deferred();
 f.state.pageHook=async(scope,target,cursor)=>{entered.resolve();await pageRelease.promise;return page(scope,target,cursor);};
 f.state.closeHook=async()=>{closeEntered.resolve();await closeRelease.promise;pageRelease.resolve();};
 f.coordinator.wake();await entered.promise;await f.contacts.setReading(false);
 const stopping=f.coordinator.stop();await closeEntered.promise;
 await f.contacts.setReading(true);f.state.pageHook=null;f.coordinator.wake();
 closeRelease.resolve();await stopping;await f.coordinator.waitForIdle();
 const read=await f.history.read(binding.contact_id);assert.equal(read.coverage.phase,'complete');assert.equal(read.messages.length,1);
 assert.equal(f.state.pages.length,2);
});

test('扫描尚未排队时单人stop会重扫其余合法范围，不漏派也不恢复该联系人',async t=>{
 for(const mode of ['revoke','stop-only']){
  const f=await fixture(t);await select(f,['a','b','c']);await f.contacts.setReading(true);
  await f.coordinator.close();const captured=deferred(),release=deferred();let initial=true;
  f.coordinator=new FirstHistoryCoordinator({directory:async()=>{
   const snapshot=await f.contacts.directory();
   if(initial){initial=false;captured.resolve(snapshot);await release.promise;}
   return snapshot;
  }},f.history);
  f.coordinator.wake();const snapshot=await captured.promise;const target=snapshot.bindings[0];
  if(mode==='revoke')await f.contacts.revoke(target.contact_id,target.binding_id,target.selection_generation);
  await f.coordinator.stop(target.contact_id);release.resolve();await f.coordinator.waitForIdle();
  assert.equal((await f.history.read(target.contact_id)).messages.length,0);
  for(const binding of snapshot.bindings.filter(binding=>binding.contact_id!==target.contact_id))assert.equal((await f.history.coverage(binding.contact_id)).phase,'complete');
  assert.equal(f.state.pages.length,2);assert.equal(f.state.pages.some(page=>page.contactId===target.contact_id),false);
  if(mode==='stop-only'){await wake(f);assert.equal((await f.history.coverage(target.contact_id)).phase,'complete');assert.equal(f.state.pages.length,3);}
 }
});

test('新wake发现active A撤销且C新授权时，扫描内部取消A后仍派发C',async t=>{
 const f=await fixture(t);const initialBindings=await select(f,['a','b']);await f.contacts.setReading(true);
 const bothEntered=deferred(),aClosed=deferred(),gates=new Map();let entered=0,targetId;
 f.state.pageHook=async(scope,target,cursor)=>{
  if(scope.conversationKey==='friend-c')return page(scope,target,cursor);
  const gate=deferred();gates.set(scope.token.contact_id,gate);if(++entered===2)bothEntered.resolve();
  await gate.promise;return page(scope,target,cursor);
 };
 f.state.closeHook=async contactId=>{gates.get(contactId)?.resolve();if(contactId===targetId)aClosed.resolve();};
 f.coordinator.wake();await bothEntered.promise;
 targetId=f.state.pages[0].contactId;const target=initialBindings.find(binding=>binding.contact_id===targetId);
 await f.contacts.revoke(target.contact_id,target.binding_id,target.selection_generation);
 const updated=await select(f,['c']);const added=updated.find(binding=>binding.conversation_locator==='friend-c');
 f.coordinator.wake();await aClosed.promise;
 for(const gate of gates.values())gate.resolve();await f.coordinator.waitForIdle();
 assert.equal((await f.history.read(targetId)).messages.length,0);
 for(const binding of updated)assert.equal((await f.history.coverage(binding.contact_id)).phase,'complete');
 assert.equal((await f.history.read(added.contact_id)).messages[0].text,'合成friend-c');
 assert.equal(f.state.pages.length,3);assert.equal(f.state.pages.filter(row=>row.contactId===targetId).length,1);
});


test('已认证来源的瞬时快照窗口失败会退避重试并清除旧失败，无需用户wake',{timeout:3000},async t=>{
 const f=await fixture(t);await f.coordinator.close();f.coordinator=new FirstHistoryCoordinator(f.contacts,f.history,{retryMinMs:10,retryMaxMs:20});
 f.state.continuity='same-source-instances-normal-use-v1';const [binding]=await select(f);await f.contacts.setReading(true);
 const retried=deferred();let initial=true;
 f.state.pageHook=async(scope,target,cursor)=>{if(initial){initial=false;throw new StorageFailure('history_snapshot_window_changed');}retried.resolve();return page(scope,target,cursor);};
 f.coordinator.wake();await retried.promise;await f.coordinator.waitForIdle();
 assert.equal((await f.history.coverage(binding.contact_id)).phase,'complete');assert.equal((await f.history.read(binding.contact_id)).messages.length,1);
 assert.equal(f.state.pages.length,2);assert.equal(f.coordinator.getState().lastError,null);
});

test('停读或关闭会取消待重试的瞬时失败，不再创建读取者',async t=>{
 for(const action of ['stop','close'])await t.test(action,async t=>{
  const f=await fixture(t);await f.coordinator.close();f.coordinator=new FirstHistoryCoordinator(f.contacts,f.history,{retryMinMs:30,retryMaxMs:60});
  f.state.continuity='same-source-instances-normal-use-v1';await select(f);await f.contacts.setReading(true);
  f.state.pageHook=async()=>{throw new StorageFailure('history_snapshot_unavailable');};await wake(f);
  assert.equal(f.coordinator.getState().phase,'scheduled');const creates=f.state.creates;
  if(action==='stop')await f.coordinator.stop();else await f.coordinator.close();
  await delay(80);assert.equal(f.state.creates,creates);
 });
});

test('实际来源变化不进入瞬时失败重试',async t=>{
 const f=await fixture(t);await f.coordinator.close();f.coordinator=new FirstHistoryCoordinator(f.contacts,f.history,{retryMinMs:10,retryMaxMs:20});
 f.state.continuity='same-source-instances-normal-use-v1';await select(f);await f.contacts.setReading(true);
 f.state.pageHook=async()=>{throw new StorageFailure('history_source_changed');};await wake(f);
 assert.equal(f.coordinator.getState().phase,'blocked');const creates=f.state.creates;
 await delay(40);assert.equal(f.state.creates,creates);
});

test('目录失败经定点唤醒恢复后，全局状态不残留已经恢复的目录错误',{timeout:3000},async t=>{
 const binding={contact_id:'synthetic-contact',binding_id:'synthetic-binding',grant_id:'synthetic-grant',selection_generation:'1',status:'active'};
 let failed=true,calls=0;
 const directory={directory:async()=>{if(failed)throw new Error('合成目录暂不可用');return {read_enabled:true,bindings:[binding]};}};
 const history={coverage:async()=>({phase:'not_started'}),synchronize:async()=>{calls++;return {phase:'complete'};},stop:async()=>{}};
 const coordinator=new FirstHistoryCoordinator(directory,history);t.after(()=>coordinator.close());
 coordinator.wake();await coordinator.waitForIdle();
 assert.equal(coordinator.getState().lastError,'history_first_directory_failed');
 failed=false;coordinator.wakeContact(binding.contact_id);await coordinator.waitForIdle();
 assert.equal(calls,1);assert.equal(coordinator.getState().phase,'idle');assert.equal(coordinator.getState().lastError,null);
});

test('定点恢复只清除当前联系人错误，同身份失败不会因其他联系人唤醒而重复执行',{timeout:3000},async t=>{
 const bindings=['a','b'].map(contact_id=>({contact_id,binding_id:`binding-${contact_id}`,grant_id:`grant-${contact_id}`,selection_generation:'1',status:'active'}));
 const calls=[],failed=new Set(['a','b']);
 const history={coverage:async()=>({phase:'not_started'}),synchronize:async contactId=>{calls.push(contactId);if(failed.has(contactId))throw new StorageFailure('history_support_unverified');return {phase:'complete'};},stop:async()=>{}};
 const coordinator=new FirstHistoryCoordinator({directory:async()=>({read_enabled:true,bindings})},history);t.after(()=>coordinator.close());
 coordinator.wake();await coordinator.waitForIdle();assert.deepEqual(calls,['a','b']);
 failed.delete('a');coordinator.wakeContact('a');await coordinator.waitForIdle();
 assert.deepEqual(calls,['a','b','a']);assert.equal(coordinator.getState().lastError,'history_support_unverified');
 assert.equal(coordinator.getState().contacts.find(row=>row.contactId==='b').phase,'blocked');
 failed.delete('b');coordinator.wakeContact('b');await coordinator.waitForIdle();
 assert.deepEqual(calls,['a','b','a','b']);assert.equal(coordinator.getState().lastError,null);
});

test('成功目录移除失授权联系人后，不保留旧失败或重新读取正文',{timeout:3000},async t=>{
 const binding={contact_id:'synthetic-contact',binding_id:'synthetic-binding',grant_id:'synthetic-grant',selection_generation:'1',status:'active'};
 let bindings=[binding],calls=0;
 const history={coverage:async()=>({phase:'not_started'}),synchronize:async()=>{calls++;throw new StorageFailure('history_support_unverified');},stop:async()=>{}};
 const coordinator=new FirstHistoryCoordinator({directory:async()=>({read_enabled:true,bindings})},history);t.after(()=>coordinator.close());
 coordinator.wake();await coordinator.waitForIdle();assert.equal(coordinator.getState().lastError,'history_support_unverified');
 bindings=[];coordinator.wake();await coordinator.waitForIdle();
 assert.equal(calls,1);assert.equal(coordinator.getState().lastError,null);assert.equal(coordinator.getState().phase,'idle');assert.deepEqual(coordinator.getState().contacts,[]);
});

test('目录撤销在途联系人时等待取消完成，迟到失败不能重新插回旧状态',{timeout:3000},async t=>{
 const binding={contact_id:'synthetic-contact',binding_id:'synthetic-binding',grant_id:'synthetic-grant',selection_generation:'1',status:'active'};
 let bindings=[binding],calls=0,signal;
 const entered=deferred(),released=deferred();
 const history={coverage:async()=>({phase:'not_started'}),synchronize:async(_contactId,currentSignal)=>{calls++;signal=currentSignal;entered.resolve();await released.promise;throw new StorageFailure('history_source_changed');},stop:async()=>{released.resolve();}};
 const coordinator=new FirstHistoryCoordinator({directory:async()=>({read_enabled:true,bindings})},history);t.after(()=>coordinator.close());
 coordinator.wake();let timer;
 try{await Promise.race([entered.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('缺少首次历史 synchronize 请求，未进入取消闸门')),1000);})]);}
 finally{clearTimeout(timer);}
 bindings=[];coordinator.wake();await coordinator.waitForIdle();
 assert.equal(signal.aborted,true);assert.equal(calls,1);assert.equal(coordinator.getState().lastError,null);assert.deepEqual(coordinator.getState().contacts,[]);
});
