import {cleanupPreSourceProofFixtures} from './fixtures/sqlite/pre-source-proof-registry.mjs';
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {fixture,owner,record,modelPort} from './fixtures/memory-sqlite/support.mjs';
import {supplier} from './fixtures/memory-management/supplier.mjs';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';
import {registry} from '../src/storage/sqlite/registry.ts';
import {memoryManagementPendingIndexMigration} from '../src/memory/sqlite/management/pending-index-schema.ts';
after(cleanupPreSourceProofFixtures);

const registryModule=mode=>new URL(`./fixtures/memory-management/pending-index-upgrade-registry.mjs?mode=${mode}`,import.meta.url).href;
const query="SELECT * FROM memory_candidate WHERE owner_id=? AND scope_kind=? AND contact_id IS ? AND state='pending' AND id>? ORDER BY id LIMIT ?";
const databasePath=root=>join(root,'managed/sqlite/notalone.sqlite');

function snapshot(db){
 return Object.fromEntries(['schema_migration','memory_candidate','memory','memory_version','decision_candidate','memory_citation'].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

test('38升级39只增加待处理索引，旧迁移账本与候选、版本、来源保持不变',{timeout:20000},async t=>{
 const cleanup=[];let upgraded,extraction;
 t.after(async()=>{await extraction?.close();await upgraded?.close();for(const close of cleanup.reverse())await close();});
 const f=await fixture({after:close=>cleanup.push(close)},{registryModule:registryModule('legacy')});
 assert.equal(f.storage.status.schemaVersion,38);
 const contactId=f.saved[0].contact_id,scope={scopeKind:'contact',contactId};
 f.channel.page=async()=>({target:f.target.descriptor,cursorIn:null,cursorOut:null,records:[record('1',{text:'我长期住在高雄。'}),record('2',{text:'我长期偏好绿茶。'})],completedPartitions:['shard-a'],exhausted:true});
 await f.service.synchronize(contactId);await f.contacts.setReading(false);
 extraction=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>extraction.accounting,supplier().respond));
 const run=await extraction.start('pending-index-upgrade');await extraction.waitForIdle();
 const management=new SqliteMemoryManagement(f.storage,owner);await management.importRun(run.runId);
 const candidate=(await management.read(scope)).candidates[0];
 await management.decide({requestKey:'upgrade-adopted',action:'accept',candidateIds:[candidate.id],candidateRevisions:[candidate.stateRevision]});
 const databaseId=f.storage.status.databaseId;
 await extraction.close();extraction=undefined;await f.service.close();await f.storage.close();
 const beforeDb=new DatabaseSync(databasePath(f.root),{readOnly:true}),before=snapshot(beforeDb);beforeDb.close();
 assert.deepEqual(before.memory_candidate.map(candidate=>candidate.state).sort(),['adopted','pending']);
 upgraded=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:databaseId,registryModule:registryModule('index39')});
 assert.equal(upgraded.status.schemaVersion,39);
 const afterDb=new DatabaseSync(databasePath(f.root),{readOnly:true}),after=snapshot(afterDb);
 assert.deepEqual(after.schema_migration.slice(0,38),before.schema_migration);
 assert.equal(after.schema_migration[38].checksum,createHash('sha256').update(memoryManagementPendingIndexMigration(39).sql).digest('hex'));
 for(const table of Object.keys(before).filter(table=>table!=='schema_migration'))assert.deepEqual(after[table],before[table],table);
 const plan=afterDb.prepare(`EXPLAIN QUERY PLAN ${query}`).all(owner,'contact',contactId,'',21).map(row=>row.detail).join('\n');afterDb.close();
 assert.match(plan,/USING INDEX candidate_management_pending_page/);assert.doesNotMatch(plan,/TEMP B-TREE/);
 assert.equal((await new SqliteMemoryManagement(upgraded,owner).read(scope)).candidates.length,1);
 assert.deepEqual(await upgraded.check(),{integrity:'ok',foreignKeys:'ok'});
 t.diagnostic('38 → 39；前38条迁移账本与候选、版本、来源完全相同；正式读取只返回1条待处理。');
});

test('真实候选表及索引下100与10000条已采纳记录不增加待处理查询范围',{timeout:20000},async t=>{
 const f=await fixture(t,{registryModule:registryModule('legacy')}),actual=new DatabaseSync(databasePath(f.root),{readOnly:true});
 // 只测候选枚举SQL：沿实际38库复制表和索引，省略无关来源生产触发器及外键依赖。
 const tableSql=actual.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='memory_candidate'").get().sql;
 const indexes=actual.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name='memory_candidate' AND sql IS NOT NULL ORDER BY name").all();actual.close();
 const contactId=f.saved[0].contact_id,parameters=[owner,'contact',contactId,'',21],results=[];
 for(const adoptedCount of [100,10000]){
  const db=new DatabaseSync(':memory:',{enableForeignKeyConstraints:false});
  try{
   db.exec(tableSql);for(const index of indexes)db.exec(index.sql);
   const insert=db.prepare('INSERT INTO memory_candidate(owner_id,id,scope_kind,contact_id,proposed_body,produced_attempt_id,event_id,output_no,state,state_revision) VALUES(?,?,\'contact\',?,?,?,?,?,?,0)');
   db.exec('BEGIN');
   for(let index=0;index<adoptedCount+3;index++){
    const pending=index>=adoptedCount,id=`00000000-0000-4000-8000-${String(pending?900000+index-adoptedCount:index).padStart(12,'0')}`;
    insert.run(owner,id,contactId,'合成原稿',`attempt-${index}`,`event-${index}`,index,pending?'pending':'adopted');
   }
   db.exec('COMMIT');
   const measure=()=>{
    const statement=db.prepare(query),rows=statement.all(...parameters),plan=db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...parameters).map(row=>row.detail).join('\n');
    for(let run=0;run<20;run++)statement.all(...parameters);
    const start=performance.now();for(let run=0;run<1000;run++)statement.all(...parameters);
    return {rows,plan,meanMs:(performance.now()-start)/1000};
   };
   const before=measure();db.exec(memoryManagementPendingIndexMigration(39).sql);const after=measure();
   assert.deepEqual(after.rows,before.rows);assert.equal(after.rows.length,3);
   assert.match(after.plan,/USING INDEX candidate_management_pending_page/);assert.doesNotMatch(after.plan,/TEMP B-TREE/);
   const page=db.prepare(query).all(owner,'contact',contactId,after.rows[0].id,2);assert.deepEqual(page,after.rows.slice(1));
   db.prepare("UPDATE memory_candidate SET state='adopted' WHERE owner_id=? AND id=?").run(owner,after.rows[0].id);
   assert.deepEqual(db.prepare(query).all(...parameters).map(row=>row.id),after.rows.slice(1).map(row=>row.id));
   results.push({adoptedCount,beforePlan:before.plan,afterPlan:after.plan,beforeMeanMs:Number(before.meanMs.toFixed(5)),afterMeanMs:Number(after.meanMs.toFixed(5))});
  }finally{db.close();}
 }
 assert.equal(registry.migrations.find(migration=>migration.version===39).sql,memoryManagementPendingIndexMigration(39).sql);
 for(const result of results)t.diagnostic(JSON.stringify(result));
});
