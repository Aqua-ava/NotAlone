#!/usr/bin/env node
/** 只在自有大库副本验证45→46：来源状态、SQL回滚计时、正式打开、幂等与旧代码拒绝。 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';
import {historySourceProofMigration} from '../../src/storage/sqlite/migrations/history-source-proof.ts';
import {cloneReplayCopy,readQuery,snapshot,assertDataPreserved,openReplayStorage} from './sync-replay-support.mjs';
const args=new Map(process.argv.slice(2).map(value=>{const at=value.indexOf('=');return [value.slice(2,at),value.slice(at+1)];}));
const hash=value=>createHash('sha256').update(value).digest('hex');
const sql=historySourceProofMigration(46).sql,sqlSha256=hash(sql);
const copy=cloneReplayCopy(args.get('source-user-data'),args.get('user-data'));
const file=copy.file,registryModule=new URL('./sync-source-proof-registry.mjs',import.meta.url).href;
const countTables=()=>readQuery(file,"SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").map(r=>r.name);
const version=()=>Number(readQuery(file,'PRAGMA user_version')[0].user_version);
assert.equal(version(),45,'输入必须是独立schema45副本');
const before=snapshot(file),tablesBefore=countTables();
const old=readQuery(file,`WITH candidates AS (
 SELECT owner_id,contact_id FROM history_continuity_scope UNION SELECT owner_id,contact_id FROM history_continuity_fence UNION SELECT owner_id,contact_id FROM history_guard_lease)
 SELECT c.owner_id,c.contact_id,s.conversation_id,s.source_generation,s.tables_json,
 f.contact_id IS NOT NULL AS fenced,b.state binding_state,b.conversation_id binding_conversation,
 a.external_key account_key,a.source_generation account_generation,a.identity_state account_state,v.external_key conversation_key
 FROM candidates c LEFT JOIN history_continuity_scope s ON s.owner_id=c.owner_id AND s.contact_id=c.contact_id
 LEFT JOIN history_continuity_fence f ON f.owner_id=c.owner_id AND f.contact_id=c.contact_id
 LEFT JOIN conversation_binding b ON b.owner_id=c.owner_id AND b.contact_id=c.contact_id AND b.state<>'revoked'
 LEFT JOIN channel_conversation v ON v.owner_id=c.owner_id AND v.id=s.conversation_id
 LEFT JOIN channel_account a ON a.owner_id=v.owner_id AND a.id=v.account_id ORDER BY c.owner_id,c.contact_id`);
const strings=(values,max=10000)=>Array.isArray(values)&&values.length>0&&values.length<=max&&values.every(v=>typeof v==='string'&&v.length>0&&v.length<=512)&&new Set(values).size===values.length;
function validShape(value){
 return value&&strings(value.partitions)&&Array.isArray(value.tables)&&value.tables.length<=10000
  &&value.tables.every(row=>Array.isArray(row)&&row.length===2&&row.every(v=>typeof v==='string'&&v.length>0&&v.length<=512)&&value.partitions.includes(row[0]))
  &&new Set(value.tables.map(row=>JSON.stringify(row))).size===value.tables.length
  &&(value.checkedPartitions===undefined||strings(value.checkedPartitions,128)&&value.partitions.every(p=>value.checkedPartitions.includes(p)));
}
const expected=new Map(old.map(row=>{
 let stored;try{stored=JSON.parse(row.tables_json);}catch{/* 缺失或非法元数据只能保守待确认。 */}
 const matching=row.binding_state==='verified'&&row.conversation_id===row.binding_conversation&&row.account_state==='verified'
  &&row.source_generation===row.account_generation&&typeof row.account_key==='string'&&row.account_key.length>0
  &&stored?.accountKey===row.account_key&&validShape(stored);
 const state=!row.fenced&&matching?'ok':'needs_confirmation';
 return [JSON.stringify([row.owner_id,row.contact_id]),{row,state,storedAccountKey:stored?.accountKey??null,category:row.fenced?'old_fenced':matching?'matched':'unverified_or_mismatched'}];
}));
function compareStates(rows){
 const failures=[],matrix={};
 for(const row of rows){const entry=expected.get(JSON.stringify([row.owner_id,row.contact_id]));
  if(!entry||entry.state!==row.state)failures.push({contactPrefix:row.contact_id.slice(0,8),expected:entry?.state??'absent',actual:row.state});
  else{const key=entry.category+'->'+row.state;matrix[key]=(matrix[key]??0)+1;
   assert.ok(row.account_key===entry.storedAccountKey&&row.conversation_id===entry.row.conversation_id&&row.conversation_key===entry.row.conversation_key&&row.source_generation===entry.row.source_generation&&row.tables_json===entry.row.tables_json,'来源事实逐行保留');}
 }
 if(failures.length)console.log(JSON.stringify({event:'state-mismatch',count:failures.length,samples:failures.slice(0,5)}));
 assert.equal(rows.length,expected.size);assert.equal(failures.length,0);return matrix;
}
const timings={};let db=new DatabaseSync(file,{enableForeignKeyConstraints:true,allowExtension:false,timeout:100});
db.function('notalone_sha256',{deterministic:true},value=>{if(typeof value!=='string'||value.length>1024*1024)throw new Error('storage_value_invalid');return hash(value);});
db.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY;');
function checks(quick){const name=quick?'quick_check':'integrity_check';assert.ok(db.prepare(`PRAGMA ${name}`).all().every(row=>row[name]==='ok'));assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);}
try{
 db.exec('BEGIN IMMEDIATE');let started=performance.now();checks(true);timings.rollbackTrialPrecheckMs=Math.round(performance.now()-started);
 started=performance.now();db.exec(sql);timings.rollbackTrialSqlMs=Math.round(performance.now()-started);
 compareStates(db.prepare('SELECT * FROM source_proof ORDER BY owner_id,contact_id').all());
 started=performance.now();checks(false);timings.rollbackTrialPostcheckMs=Math.round(performance.now()-started);
 db.exec('ROLLBACK');
}finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();db=undefined;}
assert.equal(version(),45);assert.equal(countTables().includes('source_proof'),false);assertDataPreserved(before,snapshot(file));
console.log(JSON.stringify({event:'sql-rollback-trial',sqlSha256,...timings,rolledBack:true}));
let started=performance.now(),storage=await openReplayStorage(copy.userData,{registryModule});
timings.formalWorkerOpenMs=Math.round(performance.now()-started);assert.equal(storage.status.schemaVersion,46);
const ledger=readQuery(file,'SELECT checksum FROM schema_migration WHERE version=46')[0];assert.equal(ledger.checksum,sqlSha256,'迁移源码在本次运行期间未变化');
const proofs=readQuery(file,'SELECT * FROM source_proof ORDER BY owner_id,contact_id'),matrix=compareStates(proofs);
const tablesAfter=countTables(),after=snapshot(file);assertDataPreserved(before,after);assert.equal(after.messages,before.messages);assert.equal(after.readGoals,before.readGoals);assert.equal(after.captures,before.captures);
assert.equal(tablesAfter.length,tablesBefore.length-2);for(const name of ['history_continuity_fence','history_continuity_scope','history_guard_lease'])assert.equal(tablesAfter.includes(name),false);
const eligibility={allowed:0,denied:0};for(const entry of expected.values()){
 try{await storage.execute('identity.eligibility',{ownerId:entry.row.owner_id,contactId:entry.row.contact_id});eligibility.allowed++;assert.equal(entry.row.binding_state,'verified','未核验绑定不得因迁移获得读取授权');}
 catch(error){assert.equal(error.code,'read_not_authorized');eligibility.denied++;}
}
assert.equal(eligibility.allowed,278);assert.equal(eligibility.denied,2);
await storage.close();storage=undefined;
const proofDigest=hash(JSON.stringify(proofs));started=performance.now();storage=await openReplayStorage(copy.userData,{registryModule});timings.idempotentOpenMs=Math.round(performance.now()-started);
assert.equal(hash(JSON.stringify(readQuery(file,'SELECT * FROM source_proof ORDER BY owner_id,contact_id'))),proofDigest,'重开不重复迁移或改写来源状态');assert.equal(readQuery(file,'SELECT count(*) n FROM schema_migration WHERE version=46')[0].n,1);await storage.close();storage=undefined;
const leaseBefore=readQuery(file,'SELECT epoch,runtime_id FROM database_instance WHERE slot=1')[0];
const {openReplayStorage:openOld}=await import(pathToFileURL(join(resolve(args.get('old-source-root')),'backend-ts/scripts/verification/sync-replay-support.mjs')).href);
let rejected=false;try{const oldStorage=await openOld(copy.userData);await oldStorage.close();}catch(error){assert.equal(error.code,'schema_too_new');rejected=true;}assert.equal(rejected,true);
assert.ok(JSON.stringify(readQuery(file,'SELECT epoch,runtime_id FROM database_instance WHERE slot=1')[0])===JSON.stringify(leaseBefore),'旧代码拒绝前不推进新库运行代次');assert.equal(hash(JSON.stringify(readQuery(file,'SELECT * FROM source_proof ORDER BY owner_id,contact_id'))),proofDigest);
const rollback=cloneReplayCopy(args.get('source-user-data'),args.get('rollback-user-data'));const oldStorage=await openOld(rollback.userData);assert.equal(oldStorage.status.schemaVersion,45);await oldStorage.close();assertDataPreserved(before,snapshot(rollback.file));
assert.equal(copy.sourceUnchanged(),true);assert.equal(rollback.sourceUnchanged(),true);
writeFileSync(join(copy.userData,'source-proof-verification.json'),JSON.stringify({kind:'source-proof-migration',version:46,sqlSha256})+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({event:'source-proof-migration-summary',from:45,to:46,sqlSha256,...timings,matrix,proofRows:proofs.length,checkedTimesUnset:proofs.every(p=>p.checked_at===null),eligibility,tablesBefore:tablesBefore.length,tablesAfter:tablesAfter.length,before,after,idempotent:true,oldCodeRejected:'schema_too_new',restoredPreimageOpened:45,sourceUnchanged:true}));
