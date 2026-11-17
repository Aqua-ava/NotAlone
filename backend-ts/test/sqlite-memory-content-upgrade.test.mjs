import {certifyLegacyMetadata,loadPreSourceProofModule,loadPreSourceProofFixture,cleanupPreSourceProofFixtures} from './fixtures/sqlite/pre-source-proof-registry.mjs';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';

// 升级前使用同一固定历史版本的完整准备链，避免现行守卫生命周期改写旧来源资格。
const {SqliteMemoryExtraction}=await loadPreSourceProofModule('memory/sqlite/service.ts');
const {SqliteMemoryManagement:LegacyMemoryManagement}=await loadPreSourceProofModule('memory/sqlite/management/service.ts');
const {fixture,owner,record,modelPort}=await loadPreSourceProofFixture('memory-sqlite/support.mjs');
const {supplier}=await loadPreSourceProofFixture('memory-management/supplier.mjs');
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
after(cleanupPreSourceProofFixtures);

test('图文引用迁移保留旧文字记忆、来源和核验资格，升级后可继续编辑',async t=>{
 const f=await fixture(t,{registryModule:new URL('./fixtures/memory-sqlite/legacy-content-registry.mjs',import.meta.url).href});
 const contactId=f.saved[0].contact_id,scope={scopeKind:'contact',contactId};
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:'我长期住在高雄。'})],completedPartitions:['shard-a'],exhausted:true});
 certifyLegacyMetadata(f.channel);await f.service.synchronize(contactId);await f.contacts.setReading(false);
 let extraction;const normal=supplier();
 extraction=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>extraction.accounting,normal.respond));
 t.after(()=>extraction.close());
 const run=await extraction.start('before-content-citation-upgrade');await extraction.waitForIdle();
 const management=new LegacyMemoryManagement(f.storage,owner);await management.importRun(run.runId);
 assert.equal(f.storage.status.schemaVersion,31);
 const snapshot=storage=>storage.execute('fixture.legacyContentSnapshot',{ownerId:owner,contactId});
 const candidate=(await snapshot(f.storage)).candidates[0];assert.ok(candidate);assert.equal(candidate.verificationState,'verified');
 await management.decide({requestKey:'before-upgrade-accept',action:'accept',candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision]});
 const before=await snapshot(f.storage);assert.equal(before.sourceSchema.proofs,null);assert.deepEqual(before.sourceSchema.tables,['history_continuity_fence','history_continuity_scope','history_guard_lease']);assert.equal(before.data.memory.length,1);assert.equal(before.ledger.length,31);
 await extraction.close();await f.storage.close();
 let reopened;
 try{
  reopened=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:f.storage.status.databaseId,registryModule:new URL('./fixtures/memory-sqlite/legacy-content-registry.mjs?mode=current',import.meta.url).href});
  assert.ok(reopened.status.schemaVersion>=33);assert.deepEqual(await reopened.check(),{integrity:'ok',foreignKeys:'ok'});
  const retained=await snapshot(reopened);assert.deepEqual(retained.sourceSchema.tables,['source_proof']);assert.equal(retained.sourceSchema.proofs.length,1);assert.equal(retained.sourceSchema.proofs[0].state,'ok');assert.deepEqual(retained.data,before.data);assert.deepEqual(retained.ledger.slice(0,31),before.ledger);
  const next=new SqliteMemoryManagement(reopened,owner),after=await next.read(scope);assert.equal(after.memories.length,1);assert.equal(after.memories[0].current.sources[0].quote,'我长期住在高雄。');assert.equal(after.memories[0].current.verificationState,'verified');
  const memory=after.memories[0];await next.decide({requestKey:'after-upgrade-edit',action:'correct',memoryId:memory.id,expectedVersionNo:memory.current.versionNo,expectedHeadRevision:memory.headRevision,body:'联系人长期住在高雄，旧文字证据保留。'});
  const changed=(await next.read(scope)).memories[0];assert.equal(changed.current.versionNo,'2');assert.equal(changed.current.sources[0].quote,'我长期住在高雄。');
  assert.deepEqual(await reopened.check(),{integrity:'ok',foreignKeys:'ok'});
 }finally{await reopened?.close();}
});
