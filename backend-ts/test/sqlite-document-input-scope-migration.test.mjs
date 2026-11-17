import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {fixture} from './fixtures/memory-sqlite/support.mjs';
import {deletionFixture} from './fixtures/memory-documents/deletion-support.mjs';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';

const legacy=new URL('./fixtures/memory-documents/input-scope-legacy-registry.mjs',import.meta.url).href;
function snapshot(root){
 const db=new DatabaseSync(join(root,'managed/sqlite/notalone.sqlite'),{readOnly:true});
 try{return {ledger:db.prepare('SELECT * FROM schema_migration ORDER BY version').all(),business:Object.fromEntries(['contact','read_grant','message','capture_record','source_proof'].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))};}
 finally{db.close();}
}

test('52版带来源消息的旧库经正式open升级53，历史迁移校验和及业务行原样保留',async t=>{
 const f=await fixture(t,{registryModule:legacy});assert.equal(f.storage.status.schemaVersion,52);
 for(const contact of f.saved)await f.service.synchronize(contact.contact_id);
 const before=snapshot(f.root),databaseId=f.storage.status.databaseId;
 await f.service.close();await f.storage.close();
 const storage=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:databaseId,registryModule:new URL('./fixtures/sqlite/schema-53-registry.mjs',import.meta.url).href});t.after(()=>storage.close());
 assert.equal(storage.status.schemaVersion,53);assert.equal(storage.status.databaseId,databaseId);
 const after=snapshot(f.root);assert.deepEqual(after.ledger.slice(0,52),before.ledger);assert.deepEqual(after.business,before.business);
 assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('新库来源输入触发器保留来源闭包及联系人修订隔离，递归按完整版本主键查找',async t=>{
 const f=await deletionFixture(t,{twoContacts:true,laterScheduling:true});
 const run=await f.extraction.start('input-scope-recursion-guard');await f.extraction.waitForIdle(run.runId);
 const task=(await f.extraction.read(run.runId)).tasks.find(value=>value.contactId===f.contactId);
 const claim=await f.storage.execute('memoryDocuments.claim',{ownerId:f.owner,taskId:task.taskId});assert.ok(claim);
 const db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'));t.after(()=>db.close());db.exec('PRAGMA foreign_keys=ON');
 const all=(sql,values=[])=>{const statement=db.prepare(sql);statement.setReadBigInts(true);return statement.all(...values);};
 const source=all("SELECT source_contact_id,message_id,record_id,accepted_revision FROM step_input WHERE owner_id=? AND step_id=? AND kind='message' ORDER BY input_no LIMIT 1",[f.owner,claim.stepId])[0];
 const foreign=all("SELECT r.contact_id AS source_contact_id,r.message_id,r.id AS record_id,m.interpretation_revision AS accepted_revision FROM capture_record r JOIN message m ON m.owner_id=r.owner_id AND m.contact_id=r.contact_id AND m.id=r.message_id WHERE r.owner_id=? AND r.contact_id=? AND r.state='normalized' LIMIT 1",[f.owner,f.otherContactId])[0];
 const next=all('SELECT max(input_no)+1 AS n FROM step_input WHERE owner_id=? AND step_id=?',[f.owner,claim.stepId])[0].n;
 const attempt=(ref,setup)=>{
  db.exec('SAVEPOINT synthetic_input_guard');
  try{setup?.();db.prepare("INSERT INTO step_input(owner_id,step_id,input_no,kind,source_contact_id,message_id,record_id,accepted_revision) VALUES(?,?,?,'message',?,?,?,?)").run(f.owner,claim.stepId,next,ref.source_contact_id,ref.message_id,ref.record_id,ref.accepted_revision);return true;}
  catch(error){assert.match(error.message,/step_input_scope|FOREIGN KEY/);return false;}
  finally{db.exec('ROLLBACK TO synthetic_input_guard');db.exec('RELEASE synthetic_input_guard');}
 };
 assert.equal(attempt(source),true);assert.equal(attempt(foreign),false);
 assert.equal(attempt({...source,accepted_revision:source.accepted_revision+1n}),false);
 assert.equal(attempt(source,()=>db.prepare("UPDATE capture_record SET availability='deleting' WHERE owner_id=? AND contact_id=? AND id=?").run(f.owner,source.source_contact_id,source.record_id)),false);
 const trigger=db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='step_input_scope'").get().sql;
 const expression=trigger.slice(trigger.indexOf('WHEN ')+5,trigger.indexOf('BEGIN SELECT RAISE'));
 const values={owner_id:f.owner,step_id:claim.stepId,kind:'message',...source};
 const names=new Set();const query='SELECT '+expression.replace(/NEW\.(\w+)/g,(_match,name)=>{names.add(name);return '$'+name;});
 const params=Object.fromEntries([...names].map(name=>['$'+name,values[name]??null]));
 const plan=db.prepare('EXPLAIN QUERY PLAN '+query).all(params),recursive=new Set(plan.filter(row=>row.detail==='RECURSIVE STEP').map(row=>row.id));
 for(let changed=true;changed;){changed=false;for(const row of plan)if(recursive.has(row.parent)&&!recursive.has(row.id)){recursive.add(row.id);changed=true;}}
 const recursivePlan=plan.filter(row=>recursive.has(row.id)).map(row=>String(row.detail));
 assert.ok(recursivePlan.filter(detail=>/SEARCH v .*\(owner_id=\? AND memory_id=\? AND version_no=\?\)/.test(detail)).length>=3,'三条递归臂都按完整版本身份定位');
 assert.equal(recursivePlan.some(detail=>/memory_version_restored \(owner_id=\?\)/.test(detail)),false,'递归层不得扫描该owner全部历史版本');
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
