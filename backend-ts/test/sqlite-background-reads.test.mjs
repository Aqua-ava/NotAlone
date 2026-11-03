import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';
import {backgroundReadActions,createBackgroundReads} from '../src/storage/sqlite/background-reads.ts';
import {closeSqliteHostResources} from '../src/sqlite-host-plugin.ts';
import {SqliteImageSyncCoordinator} from '../src/media/sqlite/image-sync.ts';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {fixture,owner,record} from './fixtures/memory-sqlite/support.mjs';

const expectedActions=['media.imageRefreshPending','media.imageSyncTargets','memory.history','memory.read'];
function bounded(work,label='后台慢读不应阻塞前台写入',ms=750){
 let timer;return Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);})]).finally(()=>clearTimeout(timer));
}
/** 仅测试用包装：可控地占住指定后台读取，确认前台写者与附属读者不在同一队列。 */
function gatedStorage(storage,action,entered,release,{failCloses=0}={}){
 let opened=0,closeAttempts=0;
 return {openReader:async actions=>{opened++;const actual=await storage.openReader(actions);
  return {execute:async(name,input)=>{if(name===action){entered.resolve();await release.promise;}return actual.execute(name,input);},
   close:async()=>{if(++closeAttempts<=failCloses)throw new Error('合成后台读者关闭失败');await actual.close();}};},
  get opened(){return opened;},get closeAttempts(){return closeAttempts;}};
}

test('后台只读通道固定声明四个动作并拒绝写者、维护和任意动作',async t=>{
 const f=await fixture(t),channel=await createBackgroundReads({storage:f.storage,ownerId:owner});t.after(()=>channel.close());
 assert.deepEqual([...backgroundReadActions].sort(),expectedActions);
 for(const name of ['memory.applyDecision','media.request','identity.foregroundSnapshot','discussion.list','arbitrary.sql']){
  await assert.rejects(channel.execute(name,{ownerId:owner}),{code:'readonly_action_forbidden'});
 }
 await assert.rejects(channel.execute('memory.read',{ownerId:randomUUID(),scope:{scopeKind:'self',contactId:null}}),{code:'background_read_scope_invalid'});
 await assert.rejects(channel.execute('memory.read',null),{code:'background_read_scope_invalid'});
 await assert.rejects(channel.execute('memory.read',{}),{code:'background_read_scope_invalid'});
 const view=await channel.execute('memory.read',{ownerId:owner,scope:{scopeKind:'self',contactId:null}});
 assert.deepEqual(view.candidates,[]);assert.deepEqual(view.memories,[]);
});

test('后台慢读占用附属读者时主存储的前台写入不被串行阻塞',async t=>{
 const f=await fixture(t),entered=Promise.withResolvers(),release=Promise.withResolvers(),gated=gatedStorage(f.storage,'media.imageSyncTargets',entered,release);
 const channel=await createBackgroundReads({storage:gated,ownerId:owner});t.after(()=>channel.close());
 const sync=new SqliteImageSyncCoordinator(channel,{directory:()=>f.contacts.syncDirectory()},{ownerId:owner,extract:async()=>{throw new Error('本测试不提取图片');}});t.after(()=>sync.close());
 sync.wake();await entered.promise;
 assert.equal(gated.opened,1,'后台目录读取应经独立只读通道打开');
 let released=false,writeSettled=false;
 const write=f.storage.execute('memory.applyDecision',{ownerId:owner,request:{requestKey:`foreground-write-${randomUUID()}`,action:'manual',scope:{scopeKind:'contact',contactId:f.saved[0].contact_id},body:'合成前台写入不被后台读取阻塞'}}).finally(()=>{writeSettled=true;});
 try{
  await bounded(write);
  assert.equal(writeSettled,true);assert.equal(released,false,'前台写入必须在后台读取完成前结算');
  assert.ok(f.storage.timingDiagnostic.recent.every(row=>row.action!=='media.imageSyncTargets'),'图片目录读取不应进入主写者队列');
 }finally{released=true;release.resolve();await sync.waitForIdle();await write;}
});

test('图片同步目录查询与 pending 探测经后台只读通道执行',async t=>{
 const f=await fixture(t),channel=await createBackgroundReads({storage:f.storage,ownerId:owner});t.after(()=>channel.close());
 const calls=[];const reader={execute:(name,input)=>{calls.push(name);return channel.execute(name,input);}};
 const sync=new SqliteImageSyncCoordinator(reader,{directory:()=>f.contacts.syncDirectory()},{ownerId:owner,extract:async()=>{}});t.after(()=>sync.close());
 sync.wake();await sync.waitForIdle();
 assert.ok(calls.includes('media.imageSyncTargets'));
 assert.ok(calls.includes('media.imageRefreshPending'));
 assert.deepEqual(calls.filter(name=>!expectedActions.includes(name)),[]);
 assert.equal(sync.status().failed,0);
});

test('记忆 read/readHistory 走隔离读者，prepareTimeline 与决定写入仍走主存储',async t=>{
 const f=await fixture(t),scope={scopeKind:'contact',contactId:f.saved[0].contact_id};
 const manual=await f.storage.execute('memory.applyDecision',{ownerId:owner,request:{requestKey:`routing-manual-${randomUUID()}`,action:'manual',scope,body:'合成的后台读取路由资料'}});
 const main=[],reads=[],channel=await createBackgroundReads({storage:f.storage,ownerId:owner});t.after(()=>channel.close());
 const management=new SqliteMemoryManagement({execute:(name,input)=>{main.push(name);return f.storage.execute(name,input);}},owner,
  {reader:{execute:(name,input)=>{reads.push(name);return channel.execute(name,input);}}});
 const view=await management.read(scope);
 assert.equal(view.memories.find(memory=>memory.id===manual.memoryId).current.body,'合成的后台读取路由资料');
 assert.ok(main.includes('memory.prepareTimeline'),'时间线准备仍是主 worker 写动作');
 assert.ok(reads.includes('memory.read'));assert.equal(main.includes('memory.read'),false);
 const history=await management.readHistory(scope,manual.memoryId);
 assert.equal(history.versions[0].body,'合成的后台读取路由资料');
 assert.ok(reads.includes('memory.history'));assert.equal(main.includes('memory.history'),false);
 const second=await management.decide({requestKey:`routing-decide-${randomUUID()}`,action:'manual',scope,body:'第二条合成资料'});
 assert.ok(second.memoryId);assert.ok(main.includes('memory.applyDecision'));assert.equal(reads.includes('memory.applyDecision'),false);
 assert.equal((await management.read(scope)).memories.length,2);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('后台读者关闭排空在途读取且不交付迟到结果，关闭失败保留重试',async t=>{
 const f=await fixture(t),entered=Promise.withResolvers(),release=Promise.withResolvers(),gated=gatedStorage(f.storage,'memory.read',entered,release,{failCloses:1});
 const channel=await createBackgroundReads({storage:gated,ownerId:owner});
 const reading=channel.execute('memory.read',{ownerId:owner,scope:{scopeKind:'self',contactId:null}});
 await entered.promise;
 const closing=channel.close();
 await assert.rejects(closing,/合成后台读者关闭失败/);
 await assert.rejects(reading,{code:'background_read_cancelled'});
 release.resolve();
 await assert.rejects(channel.execute('memory.read',{ownerId:owner,scope:{scopeKind:'self',contactId:null}}),{code:'readonly_closed'});
 await channel.close();
 assert.equal(gated.closeAttempts,2,'确认关闭后的重试不得丢失退休读者');
});

test('后台读取遇到租约失效关闭旧读者，下次读取重建且不交付旧快照',async t=>{
 const f=await fixture(t),opens=[];let attempts=0;
 const storage={openReader:async actions=>{const current=++attempts;opens.push(current);const actual=await f.storage.openReader(actions);let first=current===1;
  return {execute:async(name,input)=>{if(first){first=false;throw new StorageFailure('stale_lease');}return actual.execute(name,input);},close:()=>actual.close()};}};
 const channel=await createBackgroundReads({storage,ownerId:owner});t.after(()=>channel.close());
 await assert.rejects(channel.execute('memory.read',{ownerId:owner,scope:{scopeKind:'self',contactId:null}}),{code:'stale_lease'});
 const view=await channel.execute('memory.read',{ownerId:owner,scope:{scopeKind:'self',contactId:null}});
 assert.deepEqual(view.candidates,[]);assert.equal(attempts,2,'失效读者关闭后应重建附属读者');
});

test('后台读取遇到维护推进的 schema 版本时重建读者，不交付旧连接结果',async t=>{
 const f=await fixture(t);let attempts=0;
 const storage={openReader:async actions=>{const current=++attempts,actual=await f.storage.openReader(actions);
  return {execute:async(name,input)=>{if(current===1&&name==='memory.read')throw new StorageFailure('schema_drift');return actual.execute(name,input);},close:()=>actual.close()};}};
 const channel=await createBackgroundReads({storage,ownerId:owner});t.after(()=>channel.close());
 const view=await channel.execute('memory.read',{ownerId:owner,scope:{scopeKind:'self',contactId:null}});
 assert.deepEqual(view.candidates,[]);assert.equal(attempts,2,'schema 版本推进后应重建附属读者');
});

test('隔离读者上的记忆读取仍受删除排空保护，独立手录不因来源删除误删',async t=>{
 const f=await fixture(t),contactId=f.saved[0].contact_id,scope={scopeKind:'contact',contactId};
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:'合成待删除来源'})],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);
 const sourceId=(await f.service.read(contactId)).messages[0].sourceRecordIds[0];
 const manual=await f.storage.execute('memory.applyDecision',{ownerId:owner,request:{requestKey:`deletion-read-manual-${randomUUID()}`,action:'manual',scope,body:'合成删除排空前的资料'}});
 const channel=await createBackgroundReads({storage:f.storage,ownerId:owner});t.after(()=>channel.close());
 const management=new SqliteMemoryManagement(f.storage,owner,{reader:channel});
 assert.equal((await management.read(scope)).memories[0].id,manual.memoryId);
 const {DeletionService}=await import('../src/storage/sqlite/deletion/service.ts');
 const {ActiveHolders}=await import('../src/storage/sqlite/deletion/holders.ts');
 const {ManagedFiles}=await import('../src/storage/sqlite/deletion/managed-files.ts');
 const deletion=new DeletionService(f.storage,new ActiveHolders(),new ManagedFiles(f.root));
 const plan=await deletion.plan({ownerId:owner,requestKey:`deletion-read-${randomUUID()}`,scope:{kind:'source',contactId,sourceId}});
 const clearing=await management.read(scope);
 assert.deepEqual(clearing.memories,[]);assert.deepEqual(clearing.candidates,[]);assert.equal(clearing.page.nextCursor,null);
 await assert.rejects(management.readHistory(scope,manual.memoryId),{code:'memory_source_stale'});
 const done=await deletion.advance({ownerId:owner,operationId:plan.operationId});
 assert.equal(done.state,'completed');
 assert.equal((await management.read(scope)).memories.find(memory=>memory.id===manual.memoryId).current.body,'合成删除排空前的资料');
 assert.equal((await management.readHistory(scope,manual.memoryId)).versions[0].body,'合成删除排空前的资料');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('宿主关闭同批排空 backgroundReads，关闭失败保留共享存储供重试',async()=>{
 const gate=Promise.withResolvers(),started=Promise.withResolvers(),calls=[],failure=new Error('合成后台读者关闭失败');let fail=true;
 const resources={backgroundReads:{close:async()=>{calls.push('background-start');started.resolve();await gate.promise;if(fail)throw failure;calls.push('background-done');}},
  media:{close:async()=>{calls.push('media');}},storage:{close:async()=>{calls.push('storage');}}};
 const closing=closeSqliteHostResources(resources);
 await started.promise;assert.deepEqual(calls,['background-start','media']);
 gate.resolve();
 await assert.rejects(closing,error=>error instanceof AggregateError&&error.errors[0]===failure);
 assert.equal(calls.includes('storage'),false,'后台读者未确认关闭时不能关闭仍可能被服务写入的存储');
 fail=false;await closeSqliteHostResources(resources);
 assert.equal(calls.at(-1),'storage');assert.ok(calls.includes('background-done'));
});
