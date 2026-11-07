/** 测试观测接口：来源事实取自新表，守卫只取当前Worker易失状态，不恢复旧持久租约。 */
export function snapshotContinuity(tx,ownerId,contactId){
 const values=contactId===undefined?[ownerId]:[ownerId,contactId],where=`owner_id=?${contactId===undefined?'':' AND contact_id=?'}`;
 const proofs=tx.all(`SELECT * FROM source_proof WHERE ${where} ORDER BY contact_id`,values);
 const scopes=proofs.filter(proof=>proof.conversation_id!==null&&proof.source_generation!==null).map(proof=>({
  owner_id:proof.owner_id,contact_id:proof.contact_id,conversation_id:proof.conversation_id,source_generation:proof.source_generation,tables_json:proof.tables_json,
 }));
 const fences=proofs.filter(proof=>proof.state==='needs_confirmation').map(proof=>({owner_id:proof.owner_id,contact_id:proof.contact_id,reason:proof.reason}));
 // 枚举联系人而非proof：尚无持久proof的活守卫也必须如实可见。
 const contacts=tx.all(`SELECT id FROM contact WHERE owner_id=?${contactId===undefined?'':' AND id=?'} ORDER BY id`,values);
 const guards=contacts.flatMap(contact=>{const guard=tx.runtimeGet('history-source-guard',JSON.stringify([ownerId,String(contact.id)]));return guard?[guard]:[];});
 const legacyTables=tx.all("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('history_continuity_fence','history_continuity_scope','history_guard_lease') ORDER BY name").map(row=>String(row.name));
 return {proofs,scopes,fences,guards,leases:guards,legacyTables};
}
