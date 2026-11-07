import {certifyLegacyMetadata,cleanupPreSourceProofFixtures} from './fixtures/sqlite/pre-source-proof-registry.mjs';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fixture,owner,record} from './fixtures/memory-sqlite/support.mjs';
import {registry} from '../src/storage/sqlite/registry.ts';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {StorageFailure} from '../src/storage/sqlite/contracts.ts';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';
after(cleanupPreSourceProofFixtures);

// 已发布35的原始SQL摘要；修改现行触发器须追加迁移，不能重写这个兼容性基线。
const published35Checksum='70afa5d228f0b927353ed2b60484a86b2eb41f6cf20c210790a9010da52592b5';
const registryModule=mode=>new URL(`./fixtures/memory-management/pagination-upgrade-registry.mjs?mode=${mode}`,import.meta.url).href;

test('旧35升级保留原账本与来源时间，删除失败重试不恢复正文或改变独立资料',{timeout:30000},async t=>{
 const migration35=registry.migrations.find(migration=>migration.version===35);
 assert.equal(createHash('sha256').update(migration35.sql).digest('hex'),published35Checksum,'已发布35只能通过后续迁移修订');

 const cleanup=[];let upgraded,history;
 t.after(async()=>{await history?.close();await upgraded?.close();for(const close of cleanup.reverse())await close();});
 const f=await fixture({after:close=>cleanup.push(close)},{registryModule:registryModule('legacy')});history=f.service;
 assert.equal(f.storage.status.schemaVersion,35);
 const [contactId,independentContactId]=f.saved.map(binding=>binding.contact_id),scope={scopeKind:'contact',contactId};
 f.channel.page=async source=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,
  records:[record('1',{text:'合成来源'.repeat(50),sentAt:source.token.contact_id===contactId?'1700000001000':'1700000002000'})],
  completedPartitions:['shard-a'],exhausted:true});
 certifyLegacyMetadata(f.channel);
 for(const id of [contactId,independentContactId])await history.synchronize(id);
 const legacyManagement=new SqliteMemoryManagement(f.storage,owner);
 const affected=await legacyManagement.decide({requestKey:'upgrade-affected',action:'manual',scope,body:'来源支持的合成资料。'});
 const independent=await legacyManagement.decide({requestKey:'upgrade-independent',action:'manual',scope:{scopeKind:'contact',contactId:independentContactId},body:'另一联系人独立资料。'});
 const sourceId=await f.storage.execute('fixture.paginationUpgradeCitations',{ownerId:owner,contactId,memoryId:affected.memoryId,count:40});
 await f.storage.execute('fixture.paginationUpgradeCitations',{ownerId:owner,contactId:independentContactId,memoryId:independent.memoryId,count:1});
 const before=await f.storage.execute('fixture.paginationUpgradeSnapshot',{ownerId:owner}),databaseId=f.storage.status.databaseId;assert.equal(before.sourceSchema.proofs,null);assert.deepEqual(before.sourceSchema.tables,['history_continuity_fence','history_continuity_scope','history_guard_lease']);
 assert.equal(before.ledger[34].checksum,published35Checksum);
 await history.close();await f.storage.close();

 upgraded=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:databaseId,registryModule:registryModule('current')});
 assert.equal(upgraded.status.schemaVersion,registry.migrations.at(-1).version);
 assert.ok(upgraded.status.schemaVersion>35);
 const management=new SqliteMemoryManagement(upgraded,owner),independentScope={scopeKind:'contact',contactId:independentContactId};
 // 从公开读取入口完成实际来源投影；不假设迁移或触发器已同步计算好目录时间。
 const page=await management.read(scope),otherPage=await management.read(independentScope);
 assert.notEqual(page.page?.preparing,true);assert.notEqual(otherPage.page?.preparing,true);
 const after=await upgraded.execute('fixture.paginationUpgradeSnapshot',{ownerId:owner});assert.deepEqual(after.sourceSchema.tables,['source_proof']);assert.equal(after.sourceSchema.proofs.length,2);assert.ok(after.sourceSchema.proofs.every(proof=>proof.state==='ok'));
 assert.deepEqual(after.ledger.slice(0,35),before.ledger);
 assert.deepEqual(after.memories,before.memories);assert.deepEqual(after.versions,before.versions);
 const current=page.memories.find(memory=>memory.id===affected.memoryId);
 assert.equal(current.current.sources.length,40);
 assert.equal(otherPage.memories.find(memory=>memory.id===independent.memoryId).current.body,'另一联系人独立资料。');

 await management.decide({requestKey:'upgrade-correct',action:'correct',memoryId:affected.memoryId,
  expectedVersionNo:current.current.versionNo,expectedHeadRevision:current.headRevision,body:'修正后的合成资料。'});
 const corrected=await management.read(scope);
 assert.notEqual(corrected.page?.preparing,true);
 assert.equal(corrected.memories.find(memory=>memory.id===affected.memoryId).current.sources.length,40);

 // 已清除目标后模拟收尾失败，必须沿同一删除操作恢复；真实清理步骤和事务不替换。
 let failOnce=true;
 const intercepted={execute(name,input,...rest){
  if(name==='deletion.sealTargets'&&failOnce){failOnce=false;throw new StorageFailure('synthetic_deletion_failure');}
  return upgraded.execute(name,input,...rest);
 }};
 const deletion=new DeletionService(intercepted,new ActiveHolders(),new ManagedFiles(f.root));
 const operation=await deletion.plan({ownerId:owner,requestKey:'upgrade-delete-source',scope:{kind:'source',contactId,sourceId}});
 const hidden=await management.read(scope);assert.deepEqual(hidden.memories,[]);assert.deepEqual(hidden.candidates,[]);
 const blocked=await deletion.advance(operation);assert.equal(blocked.state,'blocked');
 const blockedView=await management.read(scope),blockedIndependent=await management.read(independentScope);
 assert.deepEqual(blockedView.memories,[]);assert.deepEqual(blockedView.candidates,[]);
 assert.deepEqual(blockedIndependent.memories,[]);assert.deepEqual(blockedIndependent.candidates,[]);

 const done=await deletion.advance(operation);assert.equal(done.state,'completed',JSON.stringify(done.checks));
 const cleared=await management.read(scope),retained=await management.read(independentScope);
 assert.notEqual(cleared.page?.preparing,true);assert.notEqual(retained.page?.preparing,true);
 assert.ok(cleared.memories.every(memory=>memory.current===null));
 assert.equal(retained.memories.find(memory=>memory.id===independent.memoryId).current.body,'另一联系人独立资料。');
 const final=await upgraded.execute('fixture.paginationUpgradeSnapshot',{ownerId:owner});
 assert.equal(final.memories.find(memory=>memory.id===affected.memoryId).management_source_time,null);
 assert.equal(final.memories.find(memory=>memory.id===independent.memoryId).management_source_time,1700000002000n);
 assert.ok(final.versions.filter(version=>version.memory_id===affected.memoryId).every(version=>version.body===null));
 assert.deepEqual(final.ledger.slice(0,35),before.ledger);
 assert.deepEqual(await upgraded.check(),{integrity:'ok',foreignKeys:'ok'});
 t.diagnostic(`35 → ${upgraded.status.schemaVersion}；旧账本保持；40条来源经公开读取投影；删除 blocked → completed；独立资料保留。`);
});
