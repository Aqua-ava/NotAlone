import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {historySourceProofMigration} from '../../../src/history/sqlite/source-proof-schema.ts';

// 先在隔离注册表验证完整正式入口，再接入默认迁移。
export const registry={...base,migrations:base.migrations.length===45?[...base.migrations,historySourceProofMigration(46)]:base.migrations,
 actions:[...base.actions,{name:'fixture.sourceProofSnapshot',mode:'read',retryBusy:true,execute(tx,i){return {
  guard:tx.runtimeGet('history-source-guard',JSON.stringify([i.ownerId,i.contactId]))??null,
  proofs:tx.all('SELECT * FROM source_proof WHERE owner_id=? AND contact_id=?',[i.ownerId,i.contactId]),
  retiredTables:tx.all("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('history_continuity_fence','history_continuity_scope','history_guard_lease')"),
  bindings:tx.all('SELECT id,state FROM conversation_binding WHERE owner_id=? AND contact_id=?',[i.ownerId,i.contactId]),
  messages:tx.all('SELECT id,text_body FROM message WHERE owner_id=? AND contact_id=?',[i.ownerId,i.contactId]),
 };}}]};
