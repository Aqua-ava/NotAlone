import {loadPreSourceProofRegistry,sourceSchemaSnapshot} from '../sqlite/pre-source-proof-registry.mjs';
import {randomUUID} from 'node:crypto';
import {registry as current} from '../../../src/storage/sqlite/registry.ts';

const legacy=new URL(import.meta.url).searchParams.get('mode')==='legacy';

/** 只有合成来源准备和只读核验是夹具；迁移、管理决定及删除均沿正式动作。 */
export const paginationUpgradeActions=[
 {name:'fixture.paginationUpgradeCitations',mode:'write',retryBusy:false,execute(tx,{ownerId,contactId,memoryId,count}){
  const source=tx.get(`SELECT m.id,m.interpretation_revision,r.id record_id FROM message m
   JOIN capture_record r ON r.owner_id=m.owner_id AND r.message_id=m.id
   WHERE m.owner_id=? AND m.contact_id=? AND m.kind='text' ORDER BY m.id LIMIT 1`,[ownerId,contactId]);
  if(!source)throw new Error('缺少合成来源');
  tx.run('INSERT INTO memory_required_message VALUES(?,?,NULL,?,1,?,?)',[ownerId,randomUUID(),memoryId,contactId,source.id]);
  for(let index=0;index<count;index++)tx.run(`INSERT INTO memory_citation(
   owner_id,id,candidate_id,memory_id,version_no,source_contact_id,message_id,record_id,accepted_revision,span_start,span_end,explanation)
   VALUES(?,?,NULL,?,1,?,?,?,?,?,?,NULL)`,[ownerId,randomUUID(),memoryId,contactId,source.id,source.record_id,source.interpretation_revision,index,index+1]);
  return String(source.record_id);
 }},
 {name:'fixture.paginationUpgradeSnapshot',mode:'read',retryBusy:false,execute(tx,{ownerId}){
  return {
   sourceSchema:sourceSchemaSnapshot(tx,ownerId),ledger:tx.all('SELECT version,checksum,applied_at FROM schema_migration ORDER BY version'),
   memories:tx.all('SELECT id,current_version_no,state,management_source_time FROM memory WHERE owner_id=? ORDER BY id',[ownerId]),
   versions:tx.all('SELECT memory_id,version_no,body,content_state,provenance_state FROM memory_version WHERE owner_id=? ORDER BY memory_id,version_no',[ownerId]),
  };
 }},
];
const base=legacy?await loadPreSourceProofRegistry():current;
export const registry={...base,migrations:legacy?base.migrations.filter(migration=>migration.version<=35):base.migrations,actions:[...base.actions,...paginationUpgradeActions]};
