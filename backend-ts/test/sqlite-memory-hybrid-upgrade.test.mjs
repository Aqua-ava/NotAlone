import test,{after} from 'node:test';
import {loadHybridProcessingModule,loadHybridProcessingFixture,certifyLegacyMetadata,cleanupPreSourceProofFixtures} from './fixtures/sqlite/pre-source-proof-registry.mjs';
after(cleanupPreSourceProofFixtures);
import assert from 'node:assert/strict';
const {fixture,owner,modelPort,record}=await loadHybridProcessingFixture('memory-sqlite/support.mjs');
import {randomUUID} from 'node:crypto';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
const {SqliteMemoryExtraction}=await loadHybridProcessingModule('memory/sqlite/service.ts');
const {SqliteContactService}=await loadHybridProcessingModule('contacts/sqlite/service.ts');
const {SqliteHistoryService}=await loadHybridProcessingModule('history/sqlite/service.ts');
const {DeletionService}=await loadHybridProcessingModule('storage/sqlite/deletion/service.ts');
const {ManagedFiles}=await loadHybridProcessingModule('storage/sqlite/deletion/managed-files.ts');
const {ActiveHolders}=await loadHybridProcessingModule('storage/sqlite/deletion/holders.ts');

test('启用边界保留既有消息和账本，旧增量不自动处理且清空后新消息序号不回退',async t=>{
 const cleanups=[];let storage,extraction,contacts,history;
 t.after(async()=>{await extraction?.close();await history?.close();await contacts?.close();await storage?.close();for(const cleanup of cleanups.reverse())await cleanup();});
 const legacy=new URL('./fixtures/memory-documents/hybrid-upgrade-registry.mjs?legacy=true',import.meta.url).href;
 const current=new URL('./fixtures/memory-documents/hybrid-upgrade-registry.mjs',import.meta.url).href;
 const f=await fixture({after:cleanup=>cleanups.push(cleanup)},{registryModule:legacy}),contactId=f.saved[0].contact_id;
 f.channel.page=async(_scope,target)=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('1')],completedPartitions:['shard-a'],exhausted:true,resumeCursor:'tail-1'});
 certifyLegacyMetadata(f.channel);await f.service.synchronize(contactId);
 extraction=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>extraction.accounting));
 const run=await extraction.start('hybrid-upgrade-existing-history');await extraction.waitForIdle(run.runId);await extraction.close();
 f.channel.tail=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:'tail-2',caughtUp:true,records:[record('2')]});
 await f.service.synchronizeIncremental(contactId);
 assert.equal((await f.storage.execute('memoryExtraction.readSchedule',{ownerId:owner,now:Date.now()})).pending,1);
 const before=await f.storage.execute('fixture.hybridUpgradeInspect',{}),databaseId=f.storage.status.databaseId;
 assert.equal(f.storage.status.schemaVersion,26);assert.ok(before.tables.message.length>0);assert.ok(before.tables.model_call.length>0);
 assert.equal(before.tables.processing_run.some(row=>Object.hasOwn(row,'followup_state')),false);
 await f.service.close();await f.contacts.close();await f.storage.close();
 storage=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:databaseId,registryModule:current});
 const after=await storage.execute('fixture.hybridUpgradeInspect',{});
 assert.equal(storage.status.schemaVersion,28);assert.deepEqual(after.ledger.slice(0,26),before.ledger);
 for(const [name,rows] of Object.entries(before.tables)){
  const projected=after.tables[name].map(row=>Object.fromEntries(Object.keys(rows[0]??{}).map(key=>[key,row[key]])));
  assert.deepEqual(projected,rows,`${name}既有内容不被结构升级改写`);
 }
 assert.ok(after.tables.processing_run.every(row=>row.followup_state==='none'));
 assert.deepEqual(await storage.execute('memoryExtraction.pendingFollowups',{ownerId:owner}),[]);
 assert.deepEqual(await storage.execute('memoryExtraction.readSchedule',{ownerId:owner,now:Date.now()}),{pending:0,nextDueAt:null,blockedContacts:0});
 const unavailable=async()=>{throw Error('此验收不读取真实渠道');};
 contacts=new SqliteContactService(storage,owner,{account:unavailable,conversations:unavailable});await contacts.initialize();
 history=new SqliteHistoryService(storage,contacts,f.channel);
 certifyLegacyMetadata(f.channel);
 f.channel.tail=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:'tail-3',caughtUp:true,records:[record('3')]});
 // 历史版本重连先经正常历史入口完成运行代次核对，再进入增量。
 f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:[record('1'),record('2')],completedPartitions:['shard-a'],exhausted:true,resumeCursor:'tail-2'});
 await history.synchronize(contactId);await history.synchronizeIncremental(contactId);
 assert.equal((await storage.execute('memoryExtraction.readSchedule',{ownerId:owner,now:Date.now()})).pending,1,'启用之后新增文字仍自动排队');
 await history.close();await contacts.close();
 const deletion=new DeletionService(storage,new ActiveHolders(),new ManagedFiles(f.root)),plan=await deletion.plan({ownerId:owner,requestKey:'hybrid-baseline-account-delete',scope:{kind:'account'}});
 assert.equal((await deletion.advance({ownerId:owner,operationId:plan.operationId})).state,'completed');
 const sequence=await storage.execute('fixture.nextDisplay',{});assert.equal(sequence.remaining,0n);assert.ok(sequence.baseline>0n);assert.equal(sequence.next,sequence.baseline+1n);
 assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
