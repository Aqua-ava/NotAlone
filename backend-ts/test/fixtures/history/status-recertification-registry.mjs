import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {currentSourceScopeCTE,savedSourceScopeCTE} from '../../../src/history/sqlite/current-scope.ts';
export const registry={...base,actions:[...base.actions,
 {name:'fixture.statusFallback',mode:'write',retryBusy:false,execute(tx,i){
  const row=tx.get('SELECT conversation_id FROM conversation_binding WHERE owner_id=? AND id=?',[i.ownerId,i.bindingId]);
  tx.run('INSERT INTO history_continuity_scope(owner_id,contact_id,conversation_id,source_generation,tables_json) VALUES(?,?,?,?,?)',
   [i.ownerId,i.contactId,row.conversation_id,'source-1',JSON.stringify({partitions:['shard-a'],tables:[['shard-a','table-instance-1']]})]);
 }},
 {name:'fixture.statusRecertification',mode:'write',retryBusy:false,execute(tx,i){
  tx.run('DELETE FROM history_source_recertification');
  if(i.otherOwner){
   tx.run('INSERT INTO owner(owner_id,created_at) VALUES(?,1) ON CONFLICT(owner_id) DO NOTHING',[i.ownerId]);
   tx.run('INSERT INTO contact(owner_id,id,display_name) VALUES(?,?,?) ON CONFLICT(owner_id,id) DO NOTHING',[i.ownerId,i.contactId,'另一合成本人联系人']);
  }
  if(i.state)tx.run(`INSERT INTO history_source_recertification(owner_id,id,contact_id,request_key,runtime_id,state,stage,started_at,updated_at,old_binding_id,new_binding_id,old_token_json,preserved_message_count,old_fence_json)
   VALUES(?,'synthetic-recertification',?,'synthetic-request','synthetic-runtime',?,'history',1,1,'synthetic-old-binding',?,'{}',0,'{}')`,[i.ownerId,i.contactId,i.state,i.bindingId]);
 }},
 {name:'fixture.statusScopes',mode:'read',retryBusy:false,execute(tx,i){
  const scopes=i.saved?savedSourceScopeCTE:currentSourceScopeCTE;
  return tx.all(`WITH ${scopes} SELECT contact_id,binding_id FROM current_history_scope ORDER BY contact_id`,[i.ownerId,i.contactId??null,i.contactId??null]);
 }}]};
