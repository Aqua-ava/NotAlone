import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteContactService} from '../src/contacts/sqlite/service.ts';
import {SqliteHistoryService} from '../src/history/sqlite/service.ts';

const owner='00000000-0000-4000-8000-000000000001';
const capabilities=Object.fromEntries(['programVersion','exactSchema','declaredLocalKey','automaticAllocation','statusColumn','statusSemantics','sourceLifecycle','restartContinuity','recoveryMapping','snapshotBarrier','partitionCoverage','normalHistory','incrementalTail'].map(k=>[k,'supported']));
async function fixture(t,{shared}={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-source-preparation-')));
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test',registryModule:new URL('./fixtures/history/registry.mjs',import.meta.url).href});
 const contacts=new SqliteContactService(storage,owner,{
  account:async()=>({externalKey:'synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-v1'}),
  sessions:async()=>[{externalKey:'friend',displayName:'合成联系人',kind:'private',identityAssurance:'verified'}],
 });
 let history;
 t.after(async()=>{await history?.close();await storage.close();await rm(root,{recursive:true,force:true});});
 await contacts.initialize();await contacts.confirmAccount((await contacts.detectAccount()).candidate_token);await contacts.setReading(true);
 const snapshot=await contacts.candidates(true),saved=(await contacts.confirm(snapshot.snapshot_token,snapshot.sessions.map(s=>({locator:s.username,observed_display_name:s.display_name,expected_selection_generation:s.selection_generation})))).bindings[0];
 const state={created:0,inspections:0,pages:0,tails:0,instance:'table-1',failureCode:null,lose:()=>{},beforeInspect:null,beforePage:null};
 const create=()=>{
  ++state.created;const loss=Promise.withResolvers();let closed=false;
  state.lose=()=>loss.resolve();
  const target={protocol:'private-history-v1',descriptor:'synthetic-target',partitions:['p'],tables:[{partition:'p',instance:state.instance}],sourceGeneration:'source-1'};
  return {guardSession:{loss:loss.promise,failureCode:()=>state.failureCode},
   inspect:async(scope,signal)=>{++state.inspections;await state.beforeInspect?.(signal);return {protocol:'private-history-v1',profileId:'synthetic-v1',adapterVersion:'1',status:'supported',reason:null,programVersion:'synthetic',build:'1',artifactSha256:'a'.repeat(64),schemaFingerprint:'b'.repeat(64),declaredPrimaryKey:['local_id'],identity:'source-table-local-v1',statusSemantics:'synthetic-final-rows',continuity:'same-source-instances-normal-use-v1',capabilities,accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation};},
   target:async()=>target,
   page:async(_scope,_target,cursor)=>{++state.pages;await state.beforePage?.();return {target:target.descriptor,cursorIn:cursor,cursorOut:null,resumeCursor:'synthetic-tail',records:[{partition:'p',table:state.instance,localId:'1',serverId:'0',sender:'contact',kind:'text',text:'合成来源正文',originalType:'1',sentAt:'1700000000000',timePrecision:'second',orderScheme:null,orderKey:null,stateAssurance:'verified'}],completedPartitions:['p'],exhausted:true};},
   tail:async(_scope,_target,cursor)=>{++state.tails;return {target:target.descriptor,cursorIn:cursor,cursorOut:'tail-next',records:[],caughtUp:true};},
   close:async()=>{if(!closed){closed=true;loss.resolve();}},
  };
 };
 history=new SqliteHistoryService(storage,contacts,create,undefined,undefined,undefined,shared);
 return {storage,contacts,history,state,contactId:saved.contact_id,saved};
}

test('准备来源复用活守卫，正常释放后只续证元数据且不重读正文',async t=>{
 const f=await fixture(t),{history,state,contactId}=f;
 await history.synchronize(contactId);
 const source=(await history.read(contactId)).messages[0].sourceRecordIds[0];
 const before={created:state.created,inspections:state.inspections,pages:state.pages,tails:state.tails};
 await history.prepareSource(contactId);
 assert.deepEqual({created:state.created,inspections:state.inspections,pages:state.pages,tails:state.tails},before);
 await history.stop(contactId);
 await assert.rejects(f.storage.execute('fixture.assertSource',{owner_id:owner,contact_id:contactId,record_id:source,message_id:(await history.read(contactId)).messages[0].id}),{code:'history_source_not_available'});
 await history.prepareSource(contactId);
 assert.equal(state.created,before.created+1);assert.equal(state.inspections,before.inspections+1);
 assert.equal(state.pages,before.pages);assert.equal(state.tails,before.tails);
 const message=(await history.read(contactId)).messages[0];
 assert.equal(await f.storage.execute('fixture.assertSource',{owner_id:owner,contact_id:contactId,record_id:source,message_id:message.id}),true);
});

test('同联系人同步已在准备时等待已有读者，并发来源准备不重复打开渠道',async t=>{
 const {history,state,contactId}=await fixture(t),entered=Promise.withResolvers(),release=Promise.withResolvers();
 state.beforeInspect=async()=>{entered.resolve();await release.promise;};
 const synchronizing=history.synchronize(contactId);await entered.promise;
 const a=history.prepareSource(contactId),b=history.prepareSource(contactId);
 release.resolve();await Promise.all([synchronizing,a,b]);
 assert.equal(state.created,1);assert.equal(state.inspections,2);assert.equal(state.pages,1);
});

test('共享通道排队时来源准备可取消，取消不打断已有同步',async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers();
 const shared={run:async(_owner,work)=>{entered.resolve();await release.promise;return work();}};
 const {history,state,contactId}=await fixture(t,{shared});
 const synchronizing=history.synchronize(contactId);await entered.promise;
 const controller=new AbortController(),preparing=history.prepareSource(contactId,controller.signal);
 const rejected=assert.rejects(preparing,{code:'history_native_cancelled'});
 controller.abort();await rejected;assert.equal(state.created,0);
 release.resolve();await synchronizing;assert.equal(state.created,1);
});

test('停读取消等待中的来源准备，完成停读后不重新开启渠道',async t=>{
 const {history,state,contactId}=await fixture(t),entered=Promise.withResolvers(),release=Promise.withResolvers();
 state.beforeInspect=async()=>{entered.resolve();await release.promise;};
 const synchronizing=history.synchronize(contactId),syncRejected=assert.rejects(synchronizing);await entered.promise;
 const preparing=history.prepareSource(contactId),prepareRejected=assert.rejects(preparing,{code:'history_native_cancelled'});
 const stopping=history.stop(contactId);release.resolve();await Promise.all([stopping,syncRejected,prepareRejected]);
 assert.equal(state.created,1);assert.equal(state.pages,0);
});

test('总开关关闭、授权撤销和服务关闭均不能借来源准备恢复读取',async t=>{
 const {history,state,contactId,contacts,saved}=await fixture(t);
 await history.synchronize(contactId);await history.stop(contactId);const created=state.created;
 await contacts.setReading(false);await assert.rejects(history.prepareSource(contactId),{code:'read_not_authorized'});
 await contacts.setReading(true);await contacts.revoke(contactId,saved.binding_id,saved.selection_generation);
 await assert.rejects(history.prepareSource(contactId),{code:'read_not_authorized'});
 await history.close();await assert.rejects(history.prepareSource(contactId),{code:'history_closed'});
 assert.equal(state.created,created);
});

test('真实来源表实例变化保持围栏，不能恢复旧来源或读取正文',async t=>{
 const {history,state,contactId}=await fixture(t);
 await history.synchronize(contactId);await history.stop(contactId);const pages=state.pages;
 state.instance='changed-table';await assert.rejects(history.prepareSource(contactId),{code:'history_source_continuity_unverified'});
 assert.equal(state.pages,pages);assert.equal((await history.coverage(contactId)).failureCode,'history_source_continuity_unverified');
});

test('来源准备的总期限包含原生元数据等待，超时后可再次正常准备',async t=>{
 const {history,state,contactId}=await fixture(t),entered=Promise.withResolvers(),release=Promise.withResolvers();
 await history.synchronize(contactId);await history.stop(contactId);
 state.beforeInspect=signal=>new Promise(resolve=>{entered.resolve();signal.addEventListener('abort',resolve,{once:true});release.promise.then(resolve);});
 t.mock.timers.enable({apis:['setTimeout','Date']});
 const preparing=history.prepareSource(contactId);await entered.promise;
 const rejected=assert.rejects(preparing,{code:'history_native_timeout'});
 t.mock.timers.tick(15000);release.resolve();await rejected;t.mock.timers.reset();
 state.beforeInspect=null;await history.prepareSource(contactId);assert.equal(state.pages,1);
});
