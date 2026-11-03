import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,owner,record,modelPort} from './fixtures/memory-sqlite/support.mjs';
import {supplier} from './fixtures/memory-management/supplier.mjs';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';

test('图文引用迁移保留旧文字记忆、来源和核验资格，升级后可继续编辑',async t=>{
 const f=await fixture(t,{registryModule:new URL('./fixtures/memory-sqlite/legacy-content-registry.mjs',import.meta.url).href});
 const contactId=f.saved[0].contact_id,scope={scopeKind:'contact',contactId};
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:'我长期住在高雄。'})],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);await f.contacts.setReading(false);
 let extraction;const normal=supplier();
 extraction=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>extraction.accounting,normal.respond));
 t.after(()=>extraction.close());
 const run=await extraction.start('before-content-citation-upgrade');await extraction.waitForIdle();
 const management=new SqliteMemoryManagement(f.storage,owner);await management.importRun(run.runId);
 const candidate=(await management.read(scope)).candidates[0];assert.ok(candidate);assert.equal(candidate.verificationState,'verified');
 await management.decide({requestKey:'before-upgrade-accept',action:'accept',candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision]});
 const before=await management.read(scope);assert.equal(before.memories.length,1);assert.equal(before.memories[0].current.sources[0].quote,'我长期住在高雄。');
 await extraction.close();await f.storage.close();
 let reopened;
 try{
  reopened=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:f.storage.status.databaseId});
  assert.ok(reopened.status.schemaVersion>=33);assert.deepEqual(await reopened.check(),{integrity:'ok',foreignKeys:'ok'});
  const next=new SqliteMemoryManagement(reopened,owner),after=await next.read(scope);assert.deepEqual(after,before);
  const memory=after.memories[0];await next.decide({requestKey:'after-upgrade-edit',action:'correct',memoryId:memory.id,expectedVersionNo:memory.current.versionNo,expectedHeadRevision:memory.headRevision,body:'联系人长期住在高雄，旧文字证据保留。'});
  const changed=(await next.read(scope)).memories[0];assert.equal(changed.current.versionNo,'2');assert.equal(changed.current.sources[0].quote,'我长期住在高雄。');
  assert.deepEqual(await reopened.check(),{integrity:'ok',foreignKeys:'ok'});
 }finally{await reopened?.close();}
});
