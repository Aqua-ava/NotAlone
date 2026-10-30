import{registry as base}from'./legacy-scope-registry.mjs';
export const registry={...base,actions:[...base.actions,
 {name:'fixture.reorderGoals',mode:'write',retryBusy:false,execute(tx,i){
  const rows=tx.all("SELECT rowid,id,creation_no FROM read_goal WHERE owner_id=? AND contact_id=? AND kind='history' ORDER BY creation_no DESC",[i.ownerId,i.contactId]);
  let next=tx.get('SELECT coalesce(max(rowid),0) n FROM read_goal').n;
  for(const row of rows)tx.run('UPDATE read_goal SET rowid=?,created_at=? WHERE owner_id=? AND id=?',[++next,i.sameTime?1000n:row.creation_no===null?9999999999999n:100000n-row.creation_no,i.ownerId,row.id]);
 }},
 {name:'fixture.legacyGoalSequence',mode:'write',retryBusy:false,execute(tx,i){
  // 模拟升级前没有显式目标顺序的旧库；仅用于隔离合成验收。
  tx.run('DROP TRIGGER read_goal_creation_immutable');
  tx.run('UPDATE read_goal SET creation_no=NULL WHERE owner_id=? AND contact_id=?',[i.ownerId,i.contactId]);
  tx.run("CREATE TRIGGER read_goal_creation_immutable BEFORE UPDATE OF creation_no ON read_goal BEGIN SELECT RAISE(ABORT,'history_goal_order_immutable'); END");
 }},
 {name:'fixture.legacyConflictingGoals',mode:'write',retryBusy:false,execute(tx,i){
  const rows=tx.all("SELECT id FROM read_goal WHERE owner_id=? AND contact_id=? AND kind='history' ORDER BY creation_no",[i.ownerId,i.contactId]);
  tx.run("UPDATE read_goal SET created_at=2000,state='complete',failure_code=NULL,cursor=NULL WHERE owner_id=? AND id=?",[i.ownerId,rows[0].id]);
  tx.run("UPDATE read_goal SET created_at=1000,state='incomplete',failure_code='history_interrupted',cursor='unproven-legacy-cursor' WHERE owner_id=? AND id=?",[i.ownerId,rows[1].id]);
  tx.run('DROP TRIGGER read_goal_creation_immutable');tx.run('UPDATE read_goal SET creation_no=NULL WHERE owner_id=? AND contact_id=?',[i.ownerId,i.contactId]);
  tx.run("CREATE TRIGGER read_goal_creation_immutable BEFORE UPDATE OF creation_no ON read_goal BEGIN SELECT RAISE(ABORT,'history_goal_order_immutable'); END");
 }},
 {name:'fixture.quarantineRetiredOnly',mode:'write',retryBusy:false,execute(tx,i){
  const message=tx.get('SELECT id FROM message WHERE owner_id=? AND contact_id=? ORDER BY display_no DESC LIMIT 1',[i.ownerId,i.contactId]);
  tx.run("INSERT INTO history_message_quarantine VALUES(?,?,?,'message_state_unverified')",[i.ownerId,i.contactId,message.id]);
 }},
 {name:'fixture.conflictingLegacyMode',mode:'write',retryBusy:false,execute(tx,i){
  tx.run(`INSERT INTO read_goal(owner_id,id,contact_id,binding_id,grant_id,accepted_data_generation,accepted_barrier_generation,kind,target_protocol,target_descriptor,target_json,eligibility_json,support_json,state,coverage_state,created_at)
   SELECT owner_id,'00000000-0000-4000-8000-000000000777',contact_id,binding_id,grant_id,accepted_data_generation,accepted_barrier_generation,kind,target_protocol,target_descriptor,target_json,eligibility_json,json_set(support_json,'$.continuity',?),'complete','complete',9999999999999 FROM read_goal WHERE owner_id=? AND contact_id=? ORDER BY creation_no DESC LIMIT 1`,[i.mode,i.ownerId,i.contactId]);
  tx.run('DROP TRIGGER read_goal_creation_immutable');tx.run('UPDATE read_goal SET creation_no=NULL WHERE owner_id=? AND contact_id=?',[i.ownerId,i.contactId]);
  tx.run("CREATE TRIGGER read_goal_creation_immutable BEFORE UPDATE OF creation_no ON read_goal BEGIN SELECT RAISE(ABORT,'history_goal_order_immutable'); END");
  if(!i.canonical)tx.run("UPDATE history_continuity_scope SET tables_json=json_remove(tables_json,'$.accountKey') WHERE owner_id=? AND contact_id=?",[i.ownerId,i.contactId]);
  if(i.wrongAccount)tx.run("UPDATE history_continuity_scope SET tables_json=json_set(tables_json,'$.accountKey','synthetic-wrong-account') WHERE owner_id=? AND contact_id=?",[i.ownerId,i.contactId]);
 }},
]};
