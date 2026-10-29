import { StorageFailure, type StorageTransaction } from '../../storage/sqlite/contracts.ts';

// 结构兼容实施05的authority；不运行时导入尚未集成的删除模块。
interface IdentityDeletionScope { kind: string; contactId?: string }
interface IdentityDeletionOperation { ownerId: string; scope: IdentityDeletionScope; acceptedGeneration: bigint }
const contactScopes=new Set(['source','contact','contact_history']);
function revokeContact(tx:StorageTransaction,ownerId:string,contactId:string):void {
  tx.run("UPDATE read_grant SET revoked_at=?,reason='deletion_fence' WHERE owner_id=? AND contact_id=? AND revoked_at IS NULL",[Date.now(),ownerId,contactId]);
  tx.run('UPDATE contact SET selection_generation=selection_generation+1 WHERE owner_id=? AND id=?',[ownerId,contactId]);
}
/** 只提供实际资格屏障；来源、运行时文件及清空边界证明分别由所属域注册。 */
export const identityDeletionAuthority={
  fence(tx:StorageTransaction,ownerId:string,scope:IdentityDeletionScope):bigint {
    if(scope.kind==='account'){
      const owner=tx.get('SELECT read_epoch FROM owner WHERE owner_id=?',[ownerId]);
      if(!owner)throw new StorageFailure('identity_not_found');
      tx.run("UPDATE owner SET state='deleting',read_enabled=0,read_epoch=read_epoch+1 WHERE owner_id=?",[ownerId]);
      for(const contact of tx.all('SELECT id FROM contact WHERE owner_id=?',[ownerId]))revokeContact(tx,ownerId,String(contact.id));
      tx.run("UPDATE contact SET state='deleting',data_generation=data_generation+1 WHERE owner_id=?",[ownerId]);
      tx.run("UPDATE channel_account SET identity_state='revoked',scope_revision=scope_revision+1 WHERE owner_id=?",[ownerId]);
      return (owner.read_epoch as bigint)+1n;
    }
    if(!contactScopes.has(scope.kind)||!scope.contactId)throw new StorageFailure('identity_deletion_scope_invalid');
    const contact=tx.get("SELECT data_generation FROM contact WHERE owner_id=? AND id=? AND state<>'deleted'",[ownerId,scope.contactId]);
    if(!contact)throw new StorageFailure('identity_not_found');
    tx.run('UPDATE contact SET data_generation=data_generation+1,source_revision=source_revision+1 WHERE owner_id=? AND id=?',[ownerId,scope.contactId]);
    if(scope.kind==='contact'){
      revokeContact(tx,ownerId,scope.contactId);
      tx.run("UPDATE contact SET state='deleting' WHERE owner_id=? AND id=?",[ownerId,scope.contactId]);
    }
    return (contact.data_generation as bigint)+1n;
  },
  verify(tx:StorageTransaction,operation:IdentityDeletionOperation):{result:'passed'|'blocked';proof:string} {
    const {ownerId,scope,acceptedGeneration}=operation;
    const row=scope.kind==='account'
      ?tx.get("SELECT read_epoch AS generation FROM owner WHERE owner_id=? AND read_enabled=0 AND state IN ('deleting','deleted')",[ownerId])
      :scope.contactId&&contactScopes.has(scope.kind)
        ?tx.get('SELECT data_generation AS generation FROM contact WHERE owner_id=? AND id=?',[ownerId,scope.contactId]):undefined;
    return typeof row?.generation==='bigint'&&row.generation>=acceptedGeneration?{result:'passed',proof:'identity_generation_current'}:{result:'blocked',proof:'identity_control_missing_or_changed'};
  },
};

interface IdentityRowTarget {
  kind:'row'; domain:string; rowKind:string; key:Record<string,string>; identity:string; holderKeys:string[];
}
const rowKinds={manual_confirmation:{keys:['owner_id','id'],ownerKey:'owner_id'},
  read_grant:{keys:['owner_id','id'],ownerKey:'owner_id'},binding_verification:{keys:['owner_id','id'],ownerKey:'owner_id'},
  conversation_binding:{keys:['owner_id','id'],ownerKey:'owner_id'},channel_conversation:{keys:['owner_id','id'],ownerKey:'owner_id'},
  contact:{keys:['owner_id','id'],ownerKey:'owner_id'},channel_account:{keys:['owner_id','id'],ownerKey:'owner_id'},
  owner_control:{keys:['owner_id'],ownerKey:'owner_id'}};
function target(ownerId:string,rowKind:string,id:string):IdentityRowTarget {
 const key:Record<string,string>=rowKind==='owner_control'?{owner_id:ownerId}:{owner_id:ownerId,id};
 return {kind:'row',domain:'identity',rowKind,key,identity:JSON.stringify([ownerId,rowKind,id]),holderKeys:[]};
}
function collectIdentityTargets(tx:StorageTransaction,operation:IdentityDeletionOperation):IdentityRowTarget[]{
 const {ownerId,scope}=operation;const all=scope.kind==='account';
 if(!all&&scope.kind!=='contact'&&scope.kind!=='contact_history')return [];
 const ids=all?tx.all('SELECT id FROM contact WHERE owner_id=?',[ownerId]).map(c=>String(c.id)):[scope.contactId!];
 const targets:IdentityRowTarget[]=[];
 for(const contactId of ids){
  for(const kind of ['manual_confirmation','read_grant']){
   // 聊天清空保留独立助手讨论的手动归属依据；旧资料代次仍使它不可用于新写入。
   if(scope.kind==='contact_history')continue;
   for(const row of tx.all(`SELECT id FROM ${kind} WHERE owner_id=? AND contact_id=?${scope.kind==='contact_history'?' AND accepted_data_generation<?':''}`,scope.kind==='contact_history'?[ownerId,contactId,operation.acceptedGeneration]:[ownerId,contactId]))targets.push(target(ownerId,kind,String(row.id)));
  }
  if(scope.kind==='contact_history')continue;
  for(const row of tx.all('SELECT v.id FROM binding_verification v JOIN conversation_binding b ON b.owner_id=v.owner_id AND b.id=v.binding_id WHERE b.owner_id=? AND b.contact_id=?',[ownerId,contactId]))targets.push(target(ownerId,'binding_verification',String(row.id)));
  for(const b of tx.all("SELECT id FROM conversation_binding WHERE owner_id=? AND contact_id=? AND state<>'revoked'",[ownerId,contactId]))targets.push(target(ownerId,'conversation_binding',String(b.id)));
  for(const c of tx.all('SELECT DISTINCT c.id FROM channel_conversation c JOIN conversation_binding b ON b.owner_id=c.owner_id AND b.conversation_id=c.id WHERE b.owner_id=? AND b.contact_id=? AND c.display_name IS NOT NULL',[ownerId,contactId]))targets.push(target(ownerId,'channel_conversation',String(c.id)));
  const c=tx.get("SELECT id FROM contact WHERE owner_id=? AND id=? AND (state<>'deleted' OR display_name IS NOT NULL OR remark IS NOT NULL)",[ownerId,contactId]);
  if(c)targets.push(target(ownerId,'contact',String(c.id)));
 }
 if(all){
  for(const a of tx.all("SELECT id FROM channel_account WHERE owner_id=? AND (display_name IS NOT NULL OR identity_state<>'revoked')",[ownerId]))targets.push(target(ownerId,'channel_account',String(a.id)));
  if(tx.get("SELECT owner_id FROM owner WHERE owner_id=? AND state<>'deleted'",[ownerId]))targets.push(target(ownerId,'owner_control',ownerId));
 }
 return targets;
}
/** 仅清理身份事实；保留无名称/正文的稳定控制墓碑以维持删除排除。 */
export const identityDeletionDomain={
 id:'identity',rowKinds,
 fence(_tx:StorageTransaction,_operation:IdentityDeletionOperation):{namespace:string;key:string}[]{return [];},
 collect:collectIdentityTargets,
 clearRow(tx:StorageTransaction,operation:IdentityDeletionOperation,row:IdentityRowTarget):void {
  if(row.domain!=='identity'||!Object.hasOwn(rowKinds,row.rowKind)||row.key.owner_id!==operation.ownerId)throw new StorageFailure('identity_deletion_target_invalid');
  const id=row.rowKind==='owner_control'?operation.ownerId:row.key.id;
  if(row.identity!==JSON.stringify([operation.ownerId,row.rowKind,id]))throw new StorageFailure('identity_deletion_target_invalid');
  if(identityDeletionAuthority.verify(tx,operation).result!=='passed')throw new StorageFailure('identity_deletion_generation_stale');
  const current=collectIdentityTargets(tx,operation).find(t=>t.rowKind===row.rowKind&&t.identity===row.identity);
  if(!current)return;
  const args=[operation.ownerId,id];
  if(['manual_confirmation','read_grant','binding_verification'].includes(row.rowKind))tx.run(`DELETE FROM ${row.rowKind} WHERE owner_id=? AND id=?`,args);
  else if(row.rowKind==='conversation_binding')tx.run("UPDATE conversation_binding SET state='revoked',identity_generation=identity_generation+1 WHERE owner_id=? AND id=?",args);
  else if(row.rowKind==='channel_conversation')tx.run('UPDATE channel_conversation SET display_name=NULL WHERE owner_id=? AND id=?',args);
  else if(row.rowKind==='contact')tx.run("UPDATE contact SET state='deleted',display_name=NULL,remark=NULL,current_publication_id=NULL WHERE owner_id=? AND id=?",args);
  else if(row.rowKind==='channel_account')tx.run("UPDATE channel_account SET identity_state='revoked',display_name=NULL WHERE owner_id=? AND id=?",args);
  else if(row.rowKind==='owner_control')tx.run("UPDATE owner SET state='deleted',read_enabled=0,current_publication_id=NULL WHERE owner_id=?",[operation.ownerId]);
 },
 authorizeFile():never {throw new StorageFailure('identity_has_no_managed_files');},
 fileCleared():never {throw new StorageFailure('identity_has_no_managed_files');},
 verify(tx:StorageTransaction,operation:IdentityDeletionOperation){
  if(operation.scope.kind==='discussion'){
   const check={result:'not_applicable' as const,proof:'identity_outside_discussion_scope'};
   return {database_rows:check,derived_eligibility:check,trace_payloads:check,request_replay:check,scope_suppression:check};
  }
  const empty=collectIdentityTargets(tx,operation).length===0;
  return {database_rows:{result:empty?'passed' as const:'blocked' as const,proof:empty?'identity_private_facts_cleared':'identity_private_facts_remain'},
   derived_eligibility:{result:'not_applicable' as const,proof:'derived_domains_verify_their_own_results'},
   trace_payloads:{result:'not_applicable' as const,proof:'identity_has_no_chat_payloads'},
   request_replay:identityDeletionAuthority.verify(tx,operation),
   scope_suppression:{result:operation.scope.kind==='contact'||operation.scope.kind==='account'?(empty?'passed' as const:'blocked' as const):'not_applicable' as const,proof:'identity_tombstones_only_message_suppression_verified_by_message_domain'}};
 },
};
