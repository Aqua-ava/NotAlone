import {putScope} from '../../../src/history/sqlite/source-proof.ts';
import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {currentSourceScopeCTE,savedSourceScopeCTE} from '../../../src/history/sqlite/current-scope.ts';
export const registry={...base,actions:[...base.actions,
 {name:'fixture.statusFallback',mode:'write',retryBusy:false,execute(tx,i){
  const row=tx.get('SELECT b.conversation_id,c.account_id,a.external_key account_key FROM conversation_binding b JOIN channel_conversation c ON c.owner_id=b.owner_id AND c.id=b.conversation_id JOIN channel_account a ON a.owner_id=c.owner_id AND a.id=c.account_id WHERE b.owner_id=? AND b.id=?',[i.ownerId,i.bindingId]);
  putScope(tx,{owner_id:i.ownerId,contact_id:i.contactId,account_id:row.account_id,conversation_id:row.conversation_id,source_generation:'source-1'},JSON.stringify({accountKey:row.account_key,partitions:['shard-a'],tables:[['shard-a','table-instance-1']]}),{state:'ok'});
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
