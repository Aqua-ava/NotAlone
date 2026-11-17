import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,record} from './fixtures/memory-sqlite/support.mjs';
import {SqliteHistoryService} from '../src/history/sqlite/service.ts';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';

async function leaseFixture(t,{storageFor=f=>f.storage,onPage,onClose,shared}={}){
 const f=await fixture(t,{registryModule:new URL('./fixtures/history/guard-registry.mjs',import.meta.url).href});
 const counts={created:0,closed:0,pages:0};
 const history=new SqliteHistoryService(storageFor(f),f.contacts,()=>{
  counts.created++;const loss=Promise.withResolvers();let closed=false;
  return {...f.channel,guardSession:{loss:loss.promise},
   inspect:async scope=>({...await f.channel.inspect(scope),capabilities:Object.fromEntries(['programVersion','exactSchema','declaredLocalKey','automaticAllocation','statusColumn','statusSemantics','sourceLifecycle','restartContinuity','recoveryMapping','snapshotBarrier','partitionCoverage','normalHistory','incrementalTail'].map(key=>[key,'supported']))}),
   page:async(scope,target,cursor,signal)=>{counts.pages++;await onPage?.(signal,scope);return {target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[record('1')],completedPartitions:['shard-a'],exhausted:true};},
   close:async()=>{await onClose?.();if(!closed){closed=true;counts.closed++;loss.resolve();}},
  };
 },undefined,undefined,undefined,shared);
 t.after(()=>history.close().catch(()=>{}));
 const contactId=f.saved[0].contact_id;
 return {...f,history,counts,contactId,snapshot:()=>f.storage.execute('fixture.guardSnapshot',{ownerId:f.contacts.ownerId,contactId})};
}

test('成功读取即释放本轮守卫和通道，保存来源与能力不依赖空闲读者',async t=>{
 const f=await leaseFixture(t);await f.history.synchronize(f.contactId);
 assert.deepEqual(f.counts,{created:1,closed:1,pages:1});
 assert.equal((await f.snapshot()).guardAtKey.state,'lost');assert.equal((await f.snapshot()).proofs[0].state,'ok');
 assert.equal(await f.history.bodyAvailable([f.contactId]),true);
 await f.history.synchronize(f.contactId);assert.deepEqual(f.counts,{created:2,closed:2,pages:2});
 assert.equal((await f.history.read(f.contactId)).messages.length,1,'新租约重复观察仍沿原身份去重');
 await f.history.stop();assert.equal(f.counts.closed,2,'空闲停读不保留另一套通道生命周期');
});

test('取消后等真实分页结束再释放，未结束读者仍阻止停读完成',async t=>{
 const entered=Promise.withResolvers(),page=Promise.withResolvers();let signal;
 const f=await leaseFixture(t,{onPage:async current=>{signal=current;entered.resolve();await page.promise;}});
 const reading=f.history.synchronize(f.contactId).catch(error=>error);await entered.promise;
 let stopped=false;const stopping=f.history.stop(f.contactId).then(()=>{stopped=true;});
 await Promise.resolve();await Promise.resolve();assert.equal(signal.aborted,true);assert.equal(stopped,false);
 page.resolve();await stopping;assert.ok(await reading);assert.equal(f.counts.closed,1);
 assert.equal((await f.history.read(f.contactId)).messages.length,0,'取消后的晚到页不得采纳');
});

test('关闭失败保留同一读者给停读重试，删除不能越过未确认的真实关闭',async t=>{
 let attempts=0,allowClose=false;
 const f=await leaseFixture(t,{onClose:async()=>{attempts++;if(!allowClose)throw new StorageFailure('history_native_unavailable');}});
 await assert.rejects(f.history.synchronize(f.contactId),{code:'history_native_unavailable'});
 const source=(await f.history.read(f.contactId)).messages[0].sourceRecordIds[0];
 const deletion=new DeletionService(f.storage,f.history.holders,new ManagedFiles(f.root));
 const planned=await deletion.plan({ownerId:f.contacts.ownerId,requestKey:'lease-close-source',scope:{kind:'source',contactId:f.contactId,sourceId:source}});
 const blocked=await deletion.advance(planned);assert.notEqual(blocked.state,'completed');assert.equal(f.counts.closed,0);
 allowClose=true;await f.history.stop(f.contactId);assert.equal(f.counts.closed,1);assert.ok(attempts>=2);
 const completed=await deletion.advance({ownerId:f.contacts.ownerId,operationId:planned.operationId});assert.equal(completed.state,'completed');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('守卫释放失败先关闭存储并释放通道，已保存来源在重开后保留',async t=>{
 let releases=0,storageCloses=0;
 const f=await leaseFixture(t,{storageFor:f=>({status:f.storage.status,execute:(name,...args)=>name==='history.guardRelease'?(releases++,Promise.reject(new StorageFailure('storage_busy'))):f.storage.execute(name,...args),close:async()=>{storageCloses++;await f.storage.close();}})});
 const databaseId=f.storage.status.databaseId;
 await assert.rejects(f.history.synchronize(f.contactId),{code:'storage_busy'});assert.equal(f.counts.closed,1);assert.equal(storageCloses,1);
 await f.history.stop();assert.equal(releases,1,'存储已关闭后不重发守卫写入');
 const reopened=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:databaseId});t.after(()=>reopened.close());
 assert.equal((await reopened.execute('history.read',{ownerId:f.contacts.ownerId,contactId:f.contactId})).messages.length,1);
 assert.deepEqual(await reopened.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('存储关闭未确认和渠道关闭失败可逐项重试，不重新开放读取',async t=>{
 let storageCloses=0,channelCloses=0,releases=0;
 const f=await leaseFixture(t,{storageFor:f=>({status:f.storage.status,execute:(name,...args)=>name==='history.guardRelease'?(releases++,Promise.reject(new StorageFailure('storage_busy'))):f.storage.execute(name,...args),close:async()=>{if(++storageCloses===1)throw new StorageFailure('storage_close_unconfirmed');await f.storage.close();}}),onClose:async()=>{if(++channelCloses===1)throw new StorageFailure('history_native_unavailable');}});
 await assert.rejects(f.history.synchronize(f.contactId),{code:'storage_busy'});assert.equal(f.counts.closed,0);assert.equal(storageCloses,1);
 await f.history.stop(f.contactId);assert.equal(f.counts.closed,1);assert.equal(storageCloses,2);assert.equal(releases,1);
 await f.history.stop();assert.equal(channelCloses,2);
});

function serialShared(){
 let tail=Promise.resolve();
 return {run:async(_owner,work)=>{const previous=tail;let unlock;tail=new Promise(resolve=>{unlock=resolve;});await previous;try{return await work({});}finally{unlock();}}};
}

test('共享租约包含真实关闭，下一联系人不会抢在关闭完成前读取',async t=>{
 const closing=Promise.withResolvers(),allowClose=Promise.withResolvers();let closes=0;
 const f=await leaseFixture(t,{shared:serialShared(),onClose:async()=>{if(++closes===1){closing.resolve();await allowClose.promise;}}});
 const first=f.history.synchronize(f.contactId);await closing.promise;
 const other=f.saved[1].contact_id,second=f.history.synchronize(other);await Promise.resolve();await Promise.resolve();
 assert.equal(f.counts.pages,1);allowClose.resolve();await Promise.all([first,second]);
 assert.deepEqual(f.counts,{created:2,closed:2,pages:2});
});

test('上一共享租约关闭失败时先排空原条目，再让另一联系人取得新通道',async t=>{
 let closes=0;
 const f=await leaseFixture(t,{shared:serialShared(),onClose:async()=>{if(++closes===1)throw new StorageFailure('history_native_unavailable');}});
 await assert.rejects(f.history.synchronize(f.contactId),{code:'history_native_unavailable'});
 await f.history.synchronize(f.saved[1].contact_id);
 assert.deepEqual(f.counts,{created:2,closed:2,pages:2});assert.equal(closes,3);
});
