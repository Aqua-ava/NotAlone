import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';
const registryModule=version=>new URL(`./fixtures/history/source-proof-deletion-restart-registry.mjs?version=${version}`,import.meta.url).href;
for(const scopeKind of ['contact','account'])test(`45未完成${scopeKind}删除经46迁移后重新收集多个goal守卫并完成`,async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-proof-delete-restart-')));
 let storage=await SqliteStorage.open({userData:root,intent:'create',role:'test',registryModule:registryModule(45)});
 t.after(async()=>{await storage.close();await rm(root,{recursive:true,force:true});});
 const ownerId='11111111-1111-4111-8111-111111111111';
 const {token,contactId}=await storage.execute('fixture.seedIdentityV25',{ownerId});
 const {id:goalId}=await storage.execute('fixture.seedGoalV25',{token,target:{protocol:'private-history-v1',descriptor:'synthetic',sourceGeneration:'source-1',partitions:['partition-a'],tables:[{partition:'partition-a',instance:'table-a'}],checkedPartitions:['partition-a']},report:{accountKey:'synthetic-account'}});
 const seeded=await storage.execute('fixture.seedOldDelete',{ownerId,contactId,goalId,scopeKind});
 assert.equal(seeded.goals.length,scopeKind==='account'?3:2);
 const ownGoals=seeded.goals.filter(goal=>goal.contact_id===contactId);
 assert.equal(ownGoals.length,2);assert.ok('z-synthetic-earlier-goal'>goalId);
 assert.ok(ownGoals.find(goal=>goal.id==='z-synthetic-earlier-goal').created_at<ownGoals.find(goal=>goal.id===goalId).created_at);
 assert.equal(seeded.contacts.length,scopeKind==='account'?2:1);
 const id=storage.status.databaseId;await storage.close();
 storage=await SqliteStorage.open({userData:root,intent:'open',role:'test',expectedDatabaseId:id,registryModule:registryModule(46)});
 const migrated=await storage.execute('fixture.migratedDeletionTargets',{ownerId});
 assert.equal(migrated.stored.length,seeded.contacts.length);
 const byContact=targets=>targets.toSorted((a,b)=>a.key.contact_id.localeCompare(b.key.contact_id));
 assert.deepEqual(byContact(migrated.stored),byContact(migrated.collected),'迁移目标必须与正式收集器的完整目标和守卫顺序一致');
 for(const target of migrated.stored)assert.deepEqual(target.holderKeys,seeded.goals.map(goal=>'history:'+goal.id));
 const deletion=new DeletionService(storage,new ActiveHolders(),new ManagedFiles(root));
 const op={ownerId,operationId:'synthetic-delete'};
 assert.equal((await deletion.advance(op)).state,'completed');
 // 完成即收敛台账：逐行记录清零，操作行只留按领域与行种汇总条数的摘要。
 const ledger=new DatabaseSync(join(root,'managed/sqlite/notalone.sqlite'),{readOnly:true});
 try{assert.equal(ledger.prepare("SELECT count(*) n FROM deletion_target WHERE operation_id='synthetic-delete'").get().n,0);
  assert.ok(JSON.parse(ledger.prepare("SELECT target_summary s FROM deletion_operation WHERE operation_id='synthetic-delete'").get().s)['history:source_proof']>0);}
 finally{ledger.close();}
 assert.deepEqual(await storage.execute('fixture.migratedDeletionState',{}),{proofs:[],goals:[]});
 assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
