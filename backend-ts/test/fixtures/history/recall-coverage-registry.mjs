import {registry as base} from './legacy-source-deletion-registry.mjs';
import {randomUUID} from 'node:crypto';

/** 只用于合成夹具：在当前代次为同一物理位置追加独立撤回记录、读取捕获与终态。 */
export const registry={...base,actions:[...base.actions,
 {name:'fixture.recallCaptures',mode:'read',retryBusy:true,execute(tx,i){
  return tx.all(`SELECT r.id,r.contact_id,r.observed_key,r.state,r.reason_code,r.message_id,r.availability,
   g.id goal_id,g.binding_id,g.accepted_data_generation,b.conversation_id
   FROM capture_record r JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id
   JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id
   JOIN conversation_binding b ON b.owner_id=g.owner_id AND b.id=g.binding_id
   WHERE r.owner_id=? AND r.contact_id=? ORDER BY r.observed_key,r.id`,[i.ownerId,i.contactId]);
 }},
 {name:'fixture.recallDropCover',mode:'write',retryBusy:true,execute(tx,i){
  const rows=tx.all(`SELECT r.id FROM capture_record r
   WHERE r.owner_id=? AND r.contact_id=? AND r.state='excluded' AND r.reason_code='source_recalled'
    AND json_extract(r.observed_key,'$[0]')=?`,[i.ownerId,i.contactId,i.generation]);
  for(const row of rows)tx.run('DELETE FROM capture_record WHERE owner_id=? AND id=?',[i.ownerId,row.id]);
  return rows.length;
 }},
 {name:'fixture.recallOldTerminal',mode:'write',retryBusy:true,execute(tx,i){
  const row=tx.get(`SELECT g.binding_id FROM capture_record r JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id
   JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id
   WHERE r.owner_id=? AND r.contact_id=? AND r.observed_key=? LIMIT 1`,[i.ownerId,i.contactId,i.key]);
  if(!row)return false;
  tx.run('INSERT OR IGNORE INTO history_source_terminal VALUES(?,?,?,?,?,?,?)',[i.ownerId,randomUUID(),i.contactId,row.binding_id,i.key,'source_recalled',0n]);
  return true;
 }}
]};
