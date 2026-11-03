import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,record} from './fixtures/memory-sqlite/support.mjs';
import {SqliteHistoryService} from '../src/history/sqlite/service.ts';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';
import {SqliteContactService} from '../src/contacts/sqlite/service.ts';
import {FirstHistoryCoordinator} from '../src/history/sqlite/coordinator.ts';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';
import {projectHistorySyncStatus} from '../src/history/sqlite/http.ts';

// 替代外部原生读取器；真实服务、授权、守卫和每页接受均使用 SQLite。
async function resumableFixture(t,{third=false}={}){
 const cleanup=[],f=await fixture({after:fn=>cleanup.push(fn)});
 if(third){
  f.contacts=new SqliteContactService(f.storage,f.contacts.ownerId,{account:async()=>({externalKey:'synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-metadata-v1'}),sessions:async()=>['a','b','c'].map(name=>({externalKey:`friend-${name}`,displayName:`合成${name}`,kind:'private',identityAssurance:'verified'}))});
  const snapshot=await f.contacts.candidates(true);const result=await f.contacts.confirm(snapshot.snapshot_token,snapshot.sessions.map(row=>({locator:row.username,observed_display_name:row.display_name,expected_selection_generation:row.selection_generation})));f.saved=result.bindings;
 }
 const a=f.saved.find(row=>row.conversation_locator==='friend-a'),b=f.saved.find(row=>row.conversation_locator==='friend-b');
 const state={tail:Promise.resolve(),owner:null,release:null,current:null,serial:0,checkpoints:new Map(),pages:[],targets:[],resumes:[],hook:null,quarantined:false,totals:new Map([[a.contact_id,80],[b.contact_id,1]])};
 const shared={async run(owner,work,release,signal){
  const previous=state.tail;let unlock;state.tail=new Promise(resolve=>{unlock=resolve;});await previous;
  try{if(signal?.aborted)throw new StorageFailure('history_native_cancelled');if(state.owner!==owner){await state.release?.();state.current=null;}state.owner=owner;state.release=release;return await work({});}finally{unlock();}
 }};
 const create=()=>{
  const loss=Promise.withResolvers();let selected;
  const select=(scope,index)=>{selected=state.current={contactId:scope.token.contact_id,index,target:{...f.target,descriptor:`slice-${++state.serial}`}};return selected.target;};
  return {...f.channel,guardSession:{loss:loss.promise},
   inspect:async scope=>({...await f.channel.inspect(scope),continuity:'same-source-instances-normal-use-v1',capabilities:{incrementalTail:'supported',durableIncremental:'supported',durableHistory:'supported'}}),
   target:async scope=>{state.targets.push(scope.token.contact_id);return select(scope,0);},
   resumeTarget:async(scope,previous,cursor)=>{
    const checkpoint=state.checkpoints.get(cursor);state.resumes.push(cursor);
    if(!checkpoint)return null;
    assert.equal(checkpoint.contactId,scope.token.contact_id);assert.equal(checkpoint.target,previous.descriptor);
    return select(scope,checkpoint.index);
   },
   page:async(scope,target,cursor,_signal,options)=>{
    assert.equal(state.current,selected);assert.equal(selected.contactId,scope.token.contact_id);assert.equal(selected.target.descriptor,target.descriptor);
    assert.equal(cursor,selected.cursor??null,'新快照只能从 null 开始，不能复活旧会话游标');
    const index=++selected.index,exhausted=index>=(state.totals.get(scope.token.contact_id)??1);
    const checkpointCursor=`accepted-slice-${state.serial}-${index}`;
    if(options?.checkpoint||exhausted)state.checkpoints.set(checkpointCursor,{contactId:scope.token.contact_id,index,target:target.descriptor});
    const page={target:target.descriptor,cursorIn:cursor,cursorOut:exhausted?null:`session-${state.serial}-${index}`,
     records:[record(String(index),{text:`合成片段${scope.conversationKey}:${index}`,...(state.quarantined&&(scope.token.contact_id===a.contact_id||scope.token.contact_id===b.contact_id)?{stateAssurance:'unverified',text:null}:{})})],completedPartitions:exhausted?['shard-a']:[],exhausted,
     ...(exhausted?{resumeCursor:checkpointCursor}:options?.checkpoint?{checkpointCursor}:{})};
    selected.cursor=page.cursorOut;state.pages.push({contactId:scope.token.contact_id,index,checkpoint:options?.checkpoint===true});
    await state.hook?.(scope,page,options);return page;
   },park:async()=>{if(state.current===selected)state.current=null;},close:async()=>loss.resolve()};
 };
 const holders=new ActiveHolders(),services=[];const open=()=>{const service=new SqliteHistoryService(f.storage,f.contacts,create,holders,undefined,undefined,shared);services.push(service);return service;};
 const reopen=async()=>{
  for(const service of services)await service.close();await f.service.close();
  const databaseId=f.storage.status.databaseId,ownerId=f.contacts.ownerId;await f.storage.close();
  const storage=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:databaseId});cleanup.push(()=>storage.close());f.storage=storage;
  f.contacts={ownerId,eligibility:contactId=>storage.execute('identity.eligibility',{ownerId,contactId}),validate:token=>storage.execute('identity.validate',{ownerId,token})};
  state.current=null;state.owner=null;state.release=null;return open();
 };
 t.after(async()=>{for(const service of services)await service.close();await f.service.close();for(const cleanupFn of cleanup.reverse())await cleanupFn();});
 return {...f,a,b,state,open,reopen,holders};
}

test('可恢复共享历史有界让出，另一联系人完成后继续最后已接受片段',async t=>{
 const f=await resumableFixture(t),service=f.open();
 const [slice,small]=await Promise.all([service.synchronize(f.a.contact_id),service.synchronize(f.b.contact_id)]);
 assert.equal(slice.phase,'running');assert.equal(slice.failureCode,null);
 assert.ok(slice.pageCount>0&&slice.pageCount<=32);assert.equal(small.phase,'complete');
 const status=projectHistorySyncStatus({sync_enabled:true},[await service.coverage(f.a.contact_id),small],undefined,undefined,true);
 assert.equal(status.cli_sync_phase,'active');assert.equal(status.cli_backfill_phase,'backfilling');assert.equal(status.cli_failure_code,null);
 assert.equal(JSON.stringify(slice).includes('resumable'),false,'进程内调度信息不进入状态 JSON');
 const firstPages=f.state.pages.filter(row=>row.contactId===f.a.contact_id).length;
 assert.equal(firstPages,slice.pageCount);assert.equal(f.state.pages.at(-1).contactId,f.b.contact_id);
 let latest=slice;for(let attempt=0;attempt<10&&latest.phase!=='complete';attempt++)latest=await service.synchronize(f.a.contact_id);
 assert.equal(latest.phase,'complete');assert.equal((await service.read(f.a.contact_id)).coverage.messageCount,80);
 assert.equal(f.state.targets.filter(id=>id===f.a.contact_id).length,1,'后续片段不能从第一条重新扫描');
 assert.equal(f.state.pages.filter(row=>row.contactId===f.a.contact_id).length,80);
 assert.ok(f.state.resumes.length>0);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

for(const quarantined of [false,true])test(`两位大联系人分段后排到队尾，第三位不等待大历史结束（隔离状态${quarantined}）`,async t=>{
 const f=await resumableFixture(t,{third:true}),service=f.open(),c=f.saved.find(row=>row.conversation_locator==='friend-c');
 f.state.totals.set(f.b.contact_id,80);f.state.quarantined=quarantined;
 const coordinator=new FirstHistoryCoordinator({directory:async()=>({...await f.contacts.directory(),bindings:[f.a,f.b,c]})},service);
 t.after(()=>coordinator.close());coordinator.wake();await coordinator.waitForIdle();
 assert.equal((await service.coverage(c.contact_id)).phase,'complete');
 const smallAt=f.state.pages.findIndex(row=>row.contactId===c.contact_id);
 assert.ok(smallAt>=0);assert.ok(f.state.pages.slice(0,smallAt).every(row=>row.index<=32),'小联系人必须在两个大联系人首个片段之后得到执行权');
 assert.equal((await service.coverage(f.a.contact_id)).phase,quarantined?'incomplete':'complete');assert.equal((await service.coverage(f.b.contact_id)).phase,quarantined?'incomplete':'complete');
});

test('重开 SQLite 与原生会话后仅恢复已接受检查点，不使用迟到页的新证明',async t=>{
 const f=await resumableFixture(t),service=f.open();const first=await service.synchronize(f.a.contact_id);
 assert.equal(first.phase,'running');assert.equal(first.failureCode,null);
 const acceptedCheckpoint=[...f.state.checkpoints.keys()].at(-1),entered=Promise.withResolvers(),release=Promise.withResolvers(),controller=new AbortController();
 f.state.hook=async(scope,page,options)=>{if(scope.token.contact_id===f.a.contact_id&&options?.checkpoint){entered.resolve(page);await release.promise;}};
 const pending=service.synchronize(f.a.contact_id,controller.signal).then(value=>({value}),error=>({error}));
 t.after(()=>{controller.abort();release.resolve();});
 const latePage=await entered.promise;assert.notEqual(latePage.checkpointCursor,acceptedCheckpoint);
 controller.abort();release.resolve();assert.ok((await pending).error,'迟到页不能更新业务检查点');
 f.state.hook=null;const resumed=await f.reopen();
 let latest=await resumed.synchronize(f.a.contact_id);
 assert.equal(f.state.resumes.at(-1),acceptedCheckpoint,'较新原生证明没有得到业务事务接受，不能用于跳过正文');
 for(let attempt=0;attempt<10&&latest.phase!=='complete';attempt++)latest=await resumed.synchronize(f.a.contact_id);
 assert.equal(latest.phase,'complete');assert.equal((await resumed.read(f.a.contact_id)).coverage.messageCount,80);
 assert.equal(f.state.targets.filter(id=>id===f.a.contact_id).length,1,'重开后不能从头扫描已经接受的片段');
});

test('隔离记录不使已遍历终页的恢复证明在下一目标中断后丢失',async t=>{
 const f=await resumableFixture(t),service=f.open();f.state.quarantined=true;f.state.totals.set(f.a.contact_id,1);
 const terminal=await service.synchronize(f.a.contact_id);
 assert.equal(terminal.phase,'incomplete');assert.equal(terminal.traversalComplete,true);assert.equal(terminal.failureCode,'history_identity_quarantined');
 const checkpoint=[...f.state.checkpoints.keys()].at(-1);
 await service.stop(f.a.contact_id);await service.synchronizeIncremental(f.a.contact_id);
 const restarted=await f.reopen();await restarted.synchronize(f.a.contact_id);
 assert.equal(f.state.resumes.at(-1),checkpoint);
 assert.equal(f.state.targets.filter(id=>id===f.a.contact_id).length,1,'业务隔离不应丢失已经核验的原生终页位置');
 assert.equal((await restarted.coverage(f.a.contact_id)).phase,'incomplete','恢复点不提升业务覆盖资格');
});

for(const mode of ['pause','revoke'])test(`片段检查点页迟到时${mode}拒绝正文与检查点`,async t=>{
 const f=await resumableFixture(t),service=f.open(),entered=Promise.withResolvers(),release=Promise.withResolvers();
 f.state.hook=async(scope,_page,options)=>{if(scope.token.contact_id===f.a.contact_id&&options?.checkpoint){entered.resolve();await release.promise;}};
 const pending=service.synchronize(f.a.contact_id).then(value=>({value}),error=>({error}));t.after(()=>release.resolve());
 await entered.promise;const before=await service.coverage(f.a.contact_id);
 if(mode==='pause')await f.contacts.setReading(false);else await f.contacts.revoke(f.a.contact_id,f.a.binding_id,f.a.selection_generation);
 release.resolve();assert.ok((await pending).error);assert.equal((await service.coverage(f.a.contact_id)).pageCount,before.pageCount);
 assert.equal(f.state.pages.filter(row=>row.contactId===f.a.contact_id).length,before.pageCount+1);
 if(mode==='revoke'){f.state.hook=null;assert.equal((await service.synchronize(f.b.contact_id)).phase,'complete');}
});

test('删除联系人时在途片段排空，迟到正文和恢复证明不复活删除范围',async t=>{
 const f=await resumableFixture(t),service=f.open(),entered=Promise.withResolvers(),release=Promise.withResolvers();
 f.state.hook=async(scope,_page,options)=>{if(scope.token.contact_id===f.a.contact_id&&options?.checkpoint){entered.resolve();await release.promise;}};
 const pending=service.synchronize(f.a.contact_id).then(value=>({value}),error=>({error}));t.after(()=>release.resolve());await entered.promise;
 const deletion=new DeletionService(f.storage,f.holders,new ManagedFiles(f.root));
 const plan=await deletion.plan({ownerId:f.contacts.ownerId,requestKey:'delete-slice-in-flight',scope:{kind:'contact',contactId:f.a.contact_id}});
 release.resolve();assert.ok((await pending).error);
 const completed=await deletion.advance(plan);assert.equal(completed.state,'completed',JSON.stringify(completed.checks));
 await assert.rejects(service.read(f.a.contact_id));
 f.state.hook=null;assert.equal((await service.synchronize(f.b.contact_id)).phase,'complete');
 await assert.rejects(service.synchronize(f.a.contact_id));
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
