import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {fixture,owner} from './fixtures/memory-sqlite/support.mjs';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {registry as currentRegistry} from '../src/storage/sqlite/registry.ts';
import {currentSourceScopeCTE,savedSourceScopeCTE} from '../src/history/sqlite/current-scope.ts';
import {historyGoalLatestIndexMigration} from '../src/storage/sqlite/migrations/history-goal-latest-index.ts';

const legacy=new URL('./fixtures/sqlite/schema-57-registry.mjs',import.meta.url).href;
const j=value=>JSON.stringify(value,(_k,v)=>typeof v==='bigint'?`${v}n`:v);
function snapshot(root){
 const db=new DatabaseSync(join(root,'managed/sqlite/notalone.sqlite'),{readOnly:true});
 try{
  const scope=(cte,params)=>db.prepare(`WITH ${cte} SELECT owner_id,contact_id,binding_id,target_json FROM current_history_scope ORDER BY contact_id,binding_id`).all(...params);
  return {ledger:db.prepare('SELECT * FROM schema_migration ORDER BY version').all(),
   schema:db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name").all(),
   business:Object.fromEntries(['owner','contact','read_goal','sync_capture','capture_record','message'].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()])),
   scope:[scope(currentSourceScopeCTE,[owner,null,null]),scope(savedSourceScopeCTE,[owner,null,null])]};
 }finally{db.close();}
}

test('57版库原地升级只新增当前历史目标索引：账本校验和、业务行与当前历史范围不变',async t=>{
 const f=await fixture(t,{registryModule:legacy});assert.equal(f.storage.status.schemaVersion,57);
 for(const contact of f.saved)await f.service.synchronize(contact.contact_id);
 const before=snapshot(f.root),databaseId=f.storage.status.databaseId;
 assert.equal(before.schema.some(row=>row.name==='read_goal_contact_kind_order'),false);
 assert.ok(before.scope[0].length>0,'升级前有当前历史目标（新 SQL 不依赖新索引也正确）');
 await f.service.close();await f.storage.close();
 const storage=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:databaseId});t.after(()=>storage.close());
 assert.equal(storage.status.schemaVersion,currentRegistry.migrations.at(-1).version);assert.ok(storage.status.schemaVersion>=58);
 const after=snapshot(f.root);
 assert.deepEqual(after.ledger.slice(0,57),before.ledger,'已应用迁移的校验和不变');
 assert.deepEqual(after.business,before.business,'没有改动或删除任何业务行');
 assert.equal(j(after.scope),j(before.scope),'升级前后当前历史范围逐字节相同');
 const added=after.schema.filter(row=>!before.schema.some(old=>old.type===row.type&&old.name===row.name&&old.sql===row.sql));
 assert.deepEqual(added.map(row=>`${row.type}:${row.name}`).filter(name=>!name.startsWith('index:sqlite_')),['index:read_goal_contact_kind_order']);
 assert.equal(after.schema.length,before.schema.length+1);
 assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('迁移 58 的 SQL 只含该索引，且文本固定',()=>{
 const migration=currentRegistry.migrations.find(item=>item.version===58);
 assert.equal(migration.sql,historyGoalLatestIndexMigration(58).sql);
 assert.equal(migration.sql.trim(),'CREATE INDEX read_goal_contact_kind_order ON read_goal(owner_id,contact_id,kind,creation_no DESC) WHERE creation_no IS NOT NULL;');
});

test('当前历史目标按联系人沿新索引倒序取首个，不再对全部历史目标排序',async t=>{
 const f=await fixture(t),db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'),{readOnly:true});t.after(()=>db.close());
 for(const [cte,params] of [[currentSourceScopeCTE,[owner,null,null]],[savedSourceScopeCTE,[owner,1,'no-such-contact']]]){
  const plan=db.prepare(`EXPLAIN QUERY PLAN WITH ${cte} SELECT * FROM current_history_scope`).all(...params).map(row=>row.detail);
  assert.ok(plan.some(detail=>/SEARCH g USING INDEX read_goal_contact_kind_order \(owner_id=\? AND contact_id=\? AND kind=\?/.test(detail)),plan.join('; '));
  assert.ok(!plan.some(detail=>/WINDOW|CO-ROUTINE.*read_goal/.test(detail)),plan.join('; '));
 }
});
