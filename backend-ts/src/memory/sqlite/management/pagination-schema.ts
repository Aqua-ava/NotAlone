import type {StorageMigration} from '../../../storage/sqlite/contracts.ts';

// 查看修订独立于记忆裁决修订；导入、红删及决定历史变化都会撤销旧分页游标。
function directTriggers(table:string):string {
 return ['INSERT','UPDATE','DELETE'].map(operation=>{
  const row=operation==='DELETE'?'OLD':'NEW';
  return `CREATE TRIGGER ${table}_management_${operation.toLowerCase()} AFTER ${operation} ON ${table} BEGIN
   UPDATE owner SET management_revision=management_revision+1 WHERE owner_id=${row}.owner_id AND ${row}.scope_kind='self';
   UPDATE contact SET management_revision=management_revision+1 WHERE owner_id=${row}.owner_id AND id=${row}.contact_id AND ${row}.scope_kind='contact';
  END;`;
 }).join('\n');
}
function dependentTriggers(table:string,memoryColumn:string):string {
 return ['INSERT','UPDATE','DELETE'].map(operation=>{
  const row=operation==='DELETE'?'OLD':'NEW';
  return `CREATE TRIGGER ${table}_management_${operation.toLowerCase()} AFTER ${operation} ON ${table} BEGIN
   UPDATE owner SET management_revision=management_revision+1 WHERE owner_id=${row}.owner_id AND EXISTS(SELECT 1 FROM memory m WHERE m.owner_id=${row}.owner_id AND m.id=${row}.${memoryColumn} AND m.scope_kind='self');
   UPDATE contact SET management_revision=management_revision+1 WHERE owner_id=${row}.owner_id AND id IN(SELECT contact_id FROM memory m WHERE m.owner_id=${row}.owner_id AND m.id=${row}.${memoryColumn} AND m.scope_kind='contact');
  END;`;
 }).join('\n');
}
export const memoryManagementPaginationMigration=(version:number):StorageMigration=>({version,sql:`
ALTER TABLE owner ADD COLUMN management_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contact ADD COLUMN management_revision INTEGER NOT NULL DEFAULT 0;
CREATE INDEX memory_management_page ON memory(owner_id,scope_kind,contact_id,id);
CREATE INDEX candidate_management_page ON memory_candidate(owner_id,scope_kind,contact_id,id);
CREATE INDEX decision_management_page ON memory_decision(owner_id,target_memory_id,created_at,id);
${directTriggers('memory')}
${directTriggers('memory_candidate')}
${dependentTriggers('memory_version','memory_id')}
${dependentTriggers('memory_decision','target_memory_id')}
`});
