import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {fixture} from './fixtures/memory-sqlite/support.mjs';
import {executionEventCallIndexMigration} from '../src/storage/sqlite/migrations/execution-event-call-index.ts';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';

const legacy=new URL('./fixtures/sqlite/schema-53-registry.mjs',import.meta.url).href;
function snapshot(root){
 const db=new DatabaseSync(join(root,'managed/sqlite/notalone.sqlite'),{readOnly:true});
 try{return {ledger:db.prepare('SELECT * FROM schema_migration ORDER BY version').all(),business:Object.fromEntries(['owner','contact','read_grant','message','capture_record','source_proof','execution_event'].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))};}
 finally{db.close();}
}

test('53版已保存来源的旧库原地升级54，仅增加调用索引并保留业务行和历史迁移校验和',async t=>{
 const f=await fixture(t,{registryModule:legacy});assert.equal(f.storage.status.schemaVersion,53);
 for(const contact of f.saved)await f.service.synchronize(contact.contact_id);
 const before=snapshot(f.root),databaseId=f.storage.status.databaseId;
 await f.service.close();await f.storage.close();
 const storage=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:databaseId});t.after(()=>storage.close());
 assert.equal(storage.status.schemaVersion,54);assert.equal(storage.status.databaseId,databaseId);
 const after=snapshot(f.root);assert.deepEqual(after.ledger.slice(0,53),before.ledger);assert.deepEqual(after.business,before.business);
 assert.deepEqual(await storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('记忆核验凭据按用户、模型调用和事件类型定向读取，不扫描本人全部事件',async t=>{
 const f=await fixture(t),db=new DatabaseSync(join(f.root,'managed/sqlite/notalone.sqlite'),{readOnly:true});
 try{
  for(const kind of ['model_input','model_output']){
   const plan=db.prepare(`EXPLAIN QUERY PLAN SELECT payload FROM execution_event WHERE owner_id=? AND originated_call_id=? AND kind='${kind}'`).all('synthetic-owner','synthetic-call').map(row=>row.detail);
   assert.ok(plan.some(detail=>/execution_event_call_kind \(owner_id=\? AND originated_call_id=\? AND kind=\?\)/.test(detail)),`凭据读取必须按完整调用身份定位：${plan.join('; ')}`);
  }
 }finally{db.close();}
});

for(const count of [100,1000,10000])test(`索引迁移在同一${count}条合成事件负载上保持凭据结果并定向查找`,t=>{
 const db=new DatabaseSync(':memory:');
 try{
  // 仅测这两条实际凭据 SQL；不包含业务准备、模型或界面，不作为 App 总耗时。
  db.exec('CREATE TABLE execution_event(owner_id TEXT NOT NULL,id TEXT NOT NULL,originated_call_id TEXT,kind TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(owner_id,id))');
  const insert=db.prepare('INSERT INTO execution_event VALUES(?,?,?,?,?)');
  db.exec('BEGIN');for(let i=0;i<count;i++)insert.run('synthetic-owner',String(i),`call-${i}`,i%2?'model_output':'model_input',`合成凭据${i}`);db.exec('COMMIT');
  const calls=[count-2,count-1].map(i=>({call:`call-${i}`,kind:i%2?'model_output':'model_input',expected:`合成凭据${i}`}));
  const measure=()=>{
   const statements=calls.map(value=>db.prepare(`SELECT payload FROM execution_event WHERE owner_id=? AND originated_call_id=? AND kind='${value.kind}'`));
   const started=performance.now();for(let repeat=0;repeat<200;repeat++)for(let i=0;i<calls.length;i++)assert.equal(statements[i].get('synthetic-owner',calls[i].call)?.payload,calls[i].expected);
   return performance.now()-started;
  };
  const beforeMs=measure();db.exec(executionEventCallIndexMigration(54).sql);const afterMs=measure();
  for(const call of calls){
   const plan=db.prepare('EXPLAIN QUERY PLAN SELECT payload FROM execution_event WHERE owner_id=? AND originated_call_id=? AND kind=?').all('synthetic-owner',call.call,call.kind).map(row=>row.detail);
   assert.ok(plan.some(detail=>/execution_event_call_kind \(owner_id=\? AND originated_call_id=\? AND kind=\?\)/.test(detail)));
   assert.equal(db.prepare('SELECT payload FROM execution_event WHERE owner_id=? AND originated_call_id=? AND kind=?').get('other-owner',call.call,call.kind),undefined);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM execution_event').get().n,count);
  t.diagnostic(JSON.stringify({events:count,lookups:400,beforeMs,afterMs}));
 }finally{db.close();}
});
