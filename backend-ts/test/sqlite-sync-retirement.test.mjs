import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {SqliteHistoryClearHttp,clearQueryAllowed} from '../src/history/sqlite/clear-http.ts';
import {DeletionService} from '../src/storage/sqlite/deletion/service.ts';
import {ManagedFiles} from '../src/storage/sqlite/deletion/managed-files.ts';
import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';
import {SqliteHistoryService} from '../src/history/sqlite/service.ts';
import {SqliteContactService} from '../src/contacts/sqlite/service.ts';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {fixture,record} from './fixtures/memory-sqlite/support.mjs';

test('同步退役迁移保留新来源事实但不再创建认证和副本清理表',async t=>{
 const f=await fixture(t,{automatic:false});
 assert.equal(f.storage.status.schemaVersion,50);
 await f.service.close();await f.storage.close();
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'),{readOnly:true});
 try{
  const names=db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(r=>r.name);
  for(const retired of ['history_source_recertification','history_source_recertification_cancel','history_superseded_cleanup'])assert.equal(names.includes(retired),false,retired);
  assert.ok(names.includes('source_proof'));assert.ok(names.includes('history_source_equivalence'));
 }finally{db.close();}
});

async function upgradeArchive(t,variant){
 const f=await fixture(t,{automatic:false,registryModule:new URL('./fixtures/history/pre-sync-retirement-registry.mjs',import.meta.url).href});
 const saved=f.saved[0],token=await f.contacts.eligibility(saved.contact_id);
 let legacy,covered;
 if(variant==='incomplete'||variant==='deletion'){f.channel.page=async(_scope,target,cursor)=>({target:target.descriptor,cursorIn:cursor,cursorOut:null,records:variant==='deletion'?[record('99'),record('100')]:[record('99')],completedPartitions:['shard-a'],exhausted:true});await f.service.synchronize(saved.contact_id);}
 if(variant==='deletion'){
  legacy=await f.storage.execute('fixture.historicalSourceCopy',{token,generation:'legacy-proof-generation'});
  covered=await f.storage.execute('fixture.historicalSourceCopy',{token,generation:'covered-point-generation'});
 }
 const scope=await f.storage.execute('history.scope',{token});
 await f.storage.execute('fixture.retirementArchive',{token,conversationKey:scope.conversationKey,variant,otherContactId:f.saved[1].contact_id});
 const id=f.storage.status.databaseId;await f.service.close();await f.storage.close();
 const next=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:id});t.after(()=>next.close());
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'),{readOnly:true});t.after(()=>db.close());
 return {f,next,db,token,legacy,covered};
}
test('47迁移只保留完成且独立证明的表前缀及逐键删除等价',async t=>{
 const {next,db}=await upgradeArchive(t);
 assert.equal(next.status.schemaVersion,50);
 const facts=db.prepare('SELECT kind,generation_a,generation_b,partition_id,table_instance,local_id FROM history_source_equivalence ORDER BY kind').all().map(row=>({...row}));
 assert.deepEqual(facts,[{kind:'point',generation_a:'covered-point-generation',generation_b:'source-1',partition_id:'shard-a',table_instance:'table-instance-1',local_id:'99'},{kind:'prefix',generation_a:'legacy-proof-generation',generation_b:'source-1',partition_id:'shard-a',table_instance:'table-instance-1',local_id:''}]);
 assert.equal(db.prepare('SELECT count(*) n FROM conversation_binding').get().n,3);
 assert.deepEqual(await next.check(),{integrity:'ok',foreignKeys:'ok'});
});
for(const variant of ['digest','incomplete','owner'])test(`47迁移${variant}旧审计不产生删除等价事实`,async t=>{
 const {db}=await upgradeArchive(t,variant);assert.equal(db.prepare('SELECT count(*) n FROM history_source_equivalence').get().n,0);
});

test('退役的来源认证路由不再进入清空与重读处理器',async()=>{
 const id='00000000-0000-4000-8000-000000000001';
 const http=new SqliteHistoryClearHttp({},{});
 for(const path of ['/api/history/recertify/candidates',`/api/contacts/${id}/history/recertify`,`/api/contacts/${id}/history/recertify/cancel`]){
  assert.equal(clearQueryAllowed('GET',new URL(path,'http://localhost')),false);
  assert.equal(await http.handle({url:path,method:'GET'},{}),false);
 }
});

test('47迁移移除未完成用户删除的旧元数据目标并强制重新收集',async t=>{
 const {db}=await upgradeArchive(t,'ledger-valid');
 const op=db.prepare('SELECT state,plan_revision,runner_token,runner_runtime FROM deletion_operation').get();
 assert.deepEqual({...op},{state:'fenced',plan_revision:2,runner_token:null,runner_runtime:null});
 assert.equal(db.prepare('SELECT count(*) n FROM deletion_target').get().n,0);
 assert.equal(db.prepare('SELECT count(*) n FROM deletion_check').get().n,0);
});
test('47迁移移除已经完成的旧副本清理账本和请求墓碑',async t=>{
 const {db}=await upgradeArchive(t,'ledger-completed-superseded');
 for(const table of ['deletion_operation','deletion_target','deletion_check','request_tombstone'])assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0,table);
});
for(const variant of ['ledger-owner','ledger-contact','ledger-payload','ledger-pending-superseded'])test(`47迁移${variant}拒绝并完整回滚`,async t=>{
 const f=await fixture(t,{automatic:false,registryModule:new URL('./fixtures/history/pre-sync-retirement-registry.mjs',import.meta.url).href});
 const token=await f.contacts.eligibility(f.saved[0].contact_id),scope=await f.storage.execute('history.scope',{token});
 await f.storage.execute('fixture.retirementArchive',{token,conversationKey:scope.conversationKey,variant,otherContactId:f.saved[1].contact_id});
 const databaseId=f.storage.status.databaseId;await f.service.close();await f.storage.close();
 await assert.rejects(SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:databaseId}));
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'),{readOnly:true});t.after(()=>db.close());
 assert.equal(db.prepare('SELECT max(version) version FROM schema_migration').get().version,46);
 assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='history_source_equivalence'").get().n,0);
 assert.equal(db.prepare('SELECT count(*) n FROM history_source_recertification').get().n,1);
 assert.equal(db.prepare('SELECT count(*) n FROM deletion_target').get().n,1);
});

test('未完成换绑的旧认证页不因审计退役取得本机读取或自动恢复资格',async t=>{
 const {db,next,token}=await upgradeArchive(t,'incomplete');
 assert.equal(db.prepare('SELECT count(*) n FROM message').get().n,1,'旧页仍可由删除闭包定位');
 assert.deepEqual({...db.prepare('SELECT state,reason FROM source_proof').get()},{state:'needs_confirmation',reason:'history_legacy_recertification_incomplete'});
 assert.equal((await next.execute('history.readChat',{ownerId:token.owner_id,contactId:token.contact_id,limit:20})).messages.length,0);
 const eligibility=await next.execute('identity.eligibility',{ownerId:token.owner_id,contactId:token.contact_id});
 assert.deepEqual(await next.execute('history.readPreflight',{token:eligibility}),{ok:false,metadataRevalidation:false});
});
test('旧删除已清除行而仍留定位时允许迁移并重收',async t=>{
 const {db}=await upgradeArchive(t,'ledger-cleared');
 assert.deepEqual({...db.prepare('SELECT state,plan_revision FROM deletion_operation').get()},{state:'fenced',plan_revision:2});
 assert.equal(db.prepare('SELECT count(*) n FROM deletion_target').get().n,0);
});

test('来源删除沿同一行遍历三代证明并抑制回流，点证明不扩展到相邻行',async t=>{
 const {f,next,db,token,legacy,covered}=await upgradeArchive(t,'deletion');
 const ownerId=token.owner_id,contactId=token.contact_id;
 const holders=new ActiveHolders(),deletion=new DeletionService(next,holders,new ManagedFiles(f.root));
 const contacts=new SqliteContactService(next,ownerId,{}),history=new SqliteHistoryService(next,contacts,f.channel,holders);t.after(()=>history.close());
 assert.equal((await history.readChat(contactId)).messages.length,2,'旧等价并不提升本机读取资格');
 const remove=async sourceId=>{
  const plan=await deletion.plan({ownerId,requestKey:sourceId,scope:{kind:'source',contactId,sourceId}});
  const sources=plan.targets.filter(row=>row.target?.rowKind==='capture_record');
  assert.equal((await deletion.advance(plan)).state,'completed');return sources.length;
 };
 assert.equal(await remove(covered.find(row=>row.localId==='99').sourceRecordIds[0]),3);
 const exclusions=()=>db.prepare('SELECT external_key FROM history_source_exclusion ORDER BY external_key').all().map(row=>JSON.parse(row.external_key));
 assert.deepEqual(exclusions().map(row=>[row[0],row[3]]),[['covered-point-generation','99'],['legacy-proof-generation','99'],['source-1','99']]);
 await history.synchronize(contactId);
 assert.equal((await history.readChat(contactId)).messages.length,1);
 assert.equal(await remove(legacy.find(row=>row.localId==='100').sourceRecordIds[0]),2);
 assert.equal(db.prepare('SELECT count(*) n FROM message').get().n,1);
 assert.equal(db.prepare('SELECT count(*) n FROM message WHERE id=?').get(covered.find(row=>row.localId==='100').id).n,1);
 assert.ok(exclusions().every(row=>row[0]!=='covered-point-generation'||row[3]==='99'));
 assert.deepEqual(await next.check(),{integrity:'ok',foreignKeys:'ok'});
});
