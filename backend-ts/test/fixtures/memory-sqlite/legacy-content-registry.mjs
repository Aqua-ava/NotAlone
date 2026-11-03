import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {requireCandidate} from '../../../src/memory/sqlite/management/qualification.ts';
/** 旧31只读持久快照不依赖后来新增的目录分页列，升级仍使用真实迁移与当前管理入口。 */
const snapshot={name:'fixture.legacyContentSnapshot',mode:'read',retryBusy:false,execute(tx,{ownerId,contactId}){
 const candidates=tx.all('SELECT * FROM memory_candidate WHERE owner_id=? AND contact_id=? ORDER BY id',[ownerId,contactId]);
 const columns={memory:'owner_id,id,scope_kind,contact_id,current_version_no,head_revision,state,manual_protection,protection_decision_id',memory_citation:'owner_id,id,candidate_id,memory_id,version_no,source_contact_id,message_id,record_id,accepted_revision,span_start,span_end,explanation'};
 return {candidates:candidates.filter(row=>row.state==='pending').map(row=>({id:String(row.id),stateRevision:String(row.state_revision),verificationState:requireCandidate(tx,ownerId,row).state})),
  data:Object.fromEntries(['memory_candidate','memory','memory_version','memory_decision','memory_citation'].map(table=>[table,tx.all(`SELECT ${columns[table]??'*'} FROM ${table} WHERE owner_id=? ORDER BY ${table==='memory_version'?'memory_id,version_no':'id'}`,[ownerId])])),
  ledger:tx.all('SELECT version,checksum,applied_at FROM schema_migration ORDER BY version')};
}};
export const registry={...base,migrations:new URL(import.meta.url).searchParams.get('mode')==='current'?base.migrations:base.migrations.filter(migration=>migration.version<=31),actions:[...base.actions,snapshot]};
