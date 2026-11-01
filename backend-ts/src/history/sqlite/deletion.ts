import {sourceDeletionIds} from './source-deletion.ts';
import { createHash } from 'node:crypto';
import { StorageFailure, type StorageRow, type StorageTransaction } from '../../storage/sqlite/contracts.ts';
import type { DeletionDomain, DeletionOperation, RowDeletionTarget, CheckResult } from '../../storage/sqlite/deletion/contracts.ts';
import { verifiedCutoffForOperation } from './clear-actions.ts';
const rowKinds=Object.fromEntries(['capture_record','message_alias','message','sync_capture','read_goal'].map(kind=>[kind,{keys:['owner_id','id'],ownerKey:'owner_id'}]));
rowKinds.history_quote={keys:['owner_id','id'],ownerKey:'owner_id'};
rowKinds.history_quote_dependency={keys:['owner_id','id'],ownerKey:'owner_id'};
rowKinds.history_quote_attempt={keys:['owner_id','id'],ownerKey:'owner_id'};
rowKinds.history_continuity_fence={keys:['owner_id','contact_id'],ownerKey:'owner_id'};
rowKinds.history_continuity_scope={keys:['owner_id','contact_id'],ownerKey:'owner_id'};
rowKinds.history_source_recertification_cancel={keys:['owner_id','request_key'],ownerKey:'owner_id'};
rowKinds.history_source_recertification={keys:['owner_id','id'],ownerKey:'owner_id'};
rowKinds.history_guard_lease={keys:['owner_id','contact_id'],ownerKey:'owner_id'};
rowKinds.history_source_terminal={keys:['owner_id','id'],ownerKey:'owner_id'};
const pass=(proof:string):CheckResult=>({result:'passed',proof});
const identity=(kind:string,key:Record<string,string>):string=>createHash('sha256').update(JSON.stringify([kind,Object.keys(key).sort().map(k=>[k,key[k]])])).digest('hex');
const target=(kind:string,key:Record<string,string>):RowDeletionTarget=>({kind:'row',domain:'history',rowKind:kind,key,identity:identity(kind,key),holderKeys:[]});
function idsForScope(tx:StorageTransaction,op:DeletionOperation,records:StorageRow[]):{sourceIds:Set<string>;affectedMessageIds:Set<string>;deletedMessageIds:Set<string>} {
 const sourceIds=new Set(records.map(r=>String(r.id)));
 const candidates=op.scope.kind==='source'?[...new Set(records.flatMap(r=>r.message_id?[String(r.message_id)]:[]))]
  :tx.all(`SELECT id FROM message WHERE owner_id=?${op.scope.kind==='account'?'':' AND contact_id=?'} AND availability='deleting'`,
    op.scope.kind==='account'?[op.ownerId]:[op.ownerId,op.scope.contactId]).map(r=>String(r.id));
 const affectedMessageIds=new Set(candidates);
 const deletedMessageIds=new Set(candidates.filter(messageId=>!tx.all('SELECT id FROM capture_record WHERE owner_id=? AND message_id=?',[op.ownerId,messageId])
  .some(r=>!sourceIds.has(String(r.id)))));
 return {sourceIds,affectedMessageIds,deletedMessageIds};
}
function plannedIds(tx:StorageTransaction,op:DeletionOperation,rowKind:string):Set<string>{
 return new Set(tx.all("SELECT row_key_snapshot FROM deletion_target WHERE operation_id=? AND domain='history' AND row_kind=?",[op.operationId,rowKind])
  .flatMap(row=>{try{const key=JSON.parse(String(row.row_key_snapshot));return typeof key.id==='string'?[key.id]:[];}catch{return [];}}));
}
function quoteTargetAffected(tx:StorageTransaction,ownerId:string,contactId:string,quote:StorageRow,affected:Set<string>):boolean{
 if(quote.target_message_id!==null&&quote.target_message_id!==undefined&&affected.has(String(quote.target_message_id)))return true;
 if(typeof quote.referenced_server_id!=='string'||!quote.referenced_server_id)return false;
 return tx.all(`SELECT message_id FROM message_alias WHERE owner_id=? AND contact_id=? AND binding_id=? AND scheme='server' AND external_key=?`,
  [ownerId,contactId,String(quote.binding_id),quote.referenced_server_id]).some(row=>affected.has(String(row.message_id)));
}
function scopeRows(tx:StorageTransaction,op:DeletionOperation):RowDeletionTarget[]{
 const {ownerId,scope}=op;
 if(!['source','contact_history','contact','account'].includes(scope.kind))return [];
 const args=scope.kind==='account'?[ownerId]:scope.kind==='source'?[ownerId,scope.contactId,JSON.stringify(sourceDeletionIds(tx,op))]:[ownerId,scope.contactId];
 const clause=scope.kind==='account'?'r.owner_id=?':scope.kind==='source'?'r.owner_id=? AND r.contact_id=? AND r.id IN (SELECT value FROM json_each(?))':'r.owner_id=? AND r.contact_id=?';
 const records=tx.all(`SELECT r.*,g.binding_id source_binding_id FROM capture_record r JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id WHERE ${clause}${scope.kind==='account'?'':' AND g.accepted_data_generation<?'}`,scope.kind==='account'?args:[...args,op.acceptedGeneration]);
 const targets:RowDeletionTarget[]=[];
 if(scope.kind==='contact'||scope.kind==='account')for(const r of tx.all(`SELECT id FROM history_source_recertification WHERE owner_id=?${scope.kind==='contact'?' AND contact_id=?':''}`,scope.kind==='contact'?[ownerId,scope.contactId]:[ownerId]))targets.push(target('history_source_recertification',{owner_id:ownerId,id:String(r.id)}));
 if(scope.kind==='contact'||scope.kind==='account')for(const r of tx.all(`SELECT request_key FROM history_source_recertification_cancel WHERE owner_id=?${scope.kind==='contact'?' AND contact_id=?':''}`,scope.kind==='contact'?[ownerId,scope.contactId]:[ownerId]))targets.push(target('history_source_recertification_cancel',{owner_id:ownerId,request_key:String(r.request_key)}));
 // 来源删除及聊天清空保留无正文取消意图，防止旧请求重新启动。
 // 聊天清空保留无正文终态抑制；显式重读不能恢复撤回或已消失的来源。
 if(scope.kind==='source')for(const record of records)if(record.observed_key)for(const terminal of tx.all(`SELECT id FROM history_source_terminal
  WHERE owner_id=? AND contact_id=? AND binding_id=? AND external_key=? AND accepted_data_generation<?`,[ownerId,scope.contactId,record.source_binding_id,record.observed_key,op.acceptedGeneration]))targets.push(target('history_source_terminal',{owner_id:ownerId,id:String(terminal.id)}));
 if(scope.kind==='contact'||scope.kind==='account')for(const terminal of tx.all(`SELECT id FROM history_source_terminal WHERE owner_id=?${scope.kind==='contact'?' AND contact_id=?':''}`,scope.kind==='contact'?[ownerId,scope.contactId]:[ownerId]))targets.push(target('history_source_terminal',{owner_id:ownerId,id:String(terminal.id)}));
 if(scope.kind==='contact'||scope.kind==='account')for(const r of tx.all(`SELECT owner_id,contact_id FROM history_continuity_fence WHERE owner_id=?${scope.kind==='contact'?' AND contact_id=?':''}`,scope.kind==='contact'?[ownerId,scope.contactId]:[ownerId]))targets.push(target('history_continuity_fence',{owner_id:ownerId,contact_id:String(r.contact_id)}));
 if(scope.kind==='contact'||scope.kind==='account')for(const r of tx.all(`SELECT owner_id,contact_id FROM history_continuity_scope WHERE owner_id=?${scope.kind==='contact'?' AND contact_id=?':''}`,scope.kind==='contact'?[ownerId,scope.contactId]:[ownerId]))targets.push(target('history_continuity_scope',{owner_id:ownerId,contact_id:String(r.contact_id)}));
 if(scope.kind==='contact'||scope.kind==='account')for(const r of tx.all(`SELECT owner_id,contact_id FROM history_guard_lease WHERE owner_id=?${scope.kind==='contact'?' AND contact_id=?':''}`,scope.kind==='contact'?[ownerId,scope.contactId]:[ownerId]))targets.push(target('history_guard_lease',{owner_id:ownerId,contact_id:String(r.contact_id)}));
 const {sourceIds,affectedMessageIds,deletedMessageIds}=idsForScope(tx,op,records);
 // 清除派生引用必须先于源出现和规范消息，以满足来源外键并在目标删除前擦除被引副本。
 const quoteRows=tx.all(`SELECT id,contact_id,message_id,source_record_id,binding_id,target_message_id,referenced_server_id FROM history_quote WHERE owner_id=?${scope.kind==='account'?'':' AND contact_id=?'}`,
  scope.kind==='account'?[ownerId]:[ownerId,scope.contactId]);
 for(const quote of quoteRows){
  const quoteId=String(quote.id),carrier=String(quote.message_id),quoteSource=String(quote.source_record_id),targetId=quote.target_message_id===null?null:String(quote.target_message_id);
  if(sourceIds.has(quoteSource)||deletedMessageIds.has(carrier))targets.push(target('history_quote',{owner_id:ownerId,id:quoteId}));
  else if(quoteTargetAffected(tx,ownerId,String(quote.contact_id),quote,affectedMessageIds))
   targets.push(target('history_quote_dependency',{owner_id:ownerId,id:quoteId}));
 }
 const attempts=tx.all(`SELECT id,message_id,record_id FROM history_quote_attempt WHERE owner_id=?${scope.kind==='account'?'':' AND contact_id=?'}`,
  scope.kind==='account'?[ownerId]:[ownerId,scope.contactId]);
 for(const attempt of attempts)if(sourceIds.has(String(attempt.record_id))||deletedMessageIds.has(String(attempt.message_id)))
  targets.push(target('history_quote_attempt',{owner_id:ownerId,id:String(attempt.id)}));
 targets.push(...records.map(r=>target('capture_record',{owner_id:ownerId,id:String(r.id)})));
 for(const id of affectedMessageIds){
  if(!deletedMessageIds.has(id))continue;
  for(const a of tx.all('SELECT * FROM message_alias WHERE owner_id=? AND message_id=?',[ownerId,id]))targets.push(target('message_alias',{owner_id:ownerId,id:String(a.id)}));
  targets.push(target('message',{owner_id:ownerId,id}));
 }
 if(scope.kind!=='source'){
  const goals=tx.all(`SELECT id FROM read_goal WHERE owner_id=?${scope.kind==='account'?'':' AND contact_id=? AND accepted_data_generation<?'}`,scope.kind==='account'?[ownerId]:[ownerId,scope.contactId,op.acceptedGeneration]);
  for(const g of goals){for(const c of tx.all('SELECT id FROM sync_capture WHERE owner_id=? AND goal_id=?',[ownerId,g.id]))targets.push(target('sync_capture',{owner_id:ownerId,id:String(c.id)}));targets.push(target('read_goal',{owner_id:ownerId,id:String(g.id)}));}
 }
 const contacts=scope.kind==='account'?null:scope.contactId;
 const goals=tx.all(`SELECT id FROM read_goal WHERE owner_id=?${contacts?' AND contact_id=? AND accepted_data_generation<?':''}`,contacts?[ownerId,contacts,op.acceptedGeneration]:[ownerId]);
 const holders=goals.map(g=>`history:${g.id}`);
 return targets.map(t=>({...t,holderKeys:holders}));
}
/** 数据库来源域；没有文件副本。消费者的追踪/媒体/运行时闭包必须另注册。 */
export const historyDeletionDomain:DeletionDomain={
 id:'history',rowKinds,
 fence(tx,op){
  const {ownerId,scope}=op;
  if(!['source','contact_history','contact','account'].includes(scope.kind))return [];
  if(scope.kind==='source'){
   const r=tx.get('SELECT r.observed_key,r.message_id,b.conversation_id FROM capture_record r JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id JOIN conversation_binding b ON b.owner_id=g.owner_id AND b.id=g.binding_id WHERE r.owner_id=? AND r.contact_id=? AND r.id=?',[ownerId,scope.contactId,scope.sourceId]);
   if(!r){if(tx.get("SELECT 1 FROM deletion_target WHERE operation_id=? AND domain='history'",[op.operationId]))return [];throw new StorageFailure('history_source_not_found');}
   if(r.observed_key){
    tx.run('INSERT OR IGNORE INTO history_source_exclusion VALUES(?,?,?,?,?)',[ownerId,r.conversation_id,'local',r.observed_key,op.operationId]);
    if(r.message_id)for(const alias of tx.all('SELECT scheme,external_key FROM message_alias WHERE owner_id=? AND message_id=?',[ownerId,r.message_id]))
     tx.run('INSERT OR IGNORE INTO history_source_exclusion VALUES(?,?,?,?,?)',[ownerId,r.conversation_id,alias.scheme,alias.external_key,op.operationId]);
   }
   else tx.run('INSERT OR IGNORE INTO history_deletion_fence VALUES(?,?,?)',[ownerId,scope.contactId,op.operationId]);
  }else{
   const contacts=scope.kind==='account'?tx.all('SELECT id FROM contact WHERE owner_id=?',[ownerId]).map(r=>String(r.id)):[scope.contactId];
   for(const contact of contacts){
    tx.run('INSERT OR IGNORE INTO history_deletion_fence VALUES(?,?,?)',[ownerId,contact,op.operationId]);
    tx.run(`UPDATE message SET availability='deleting' WHERE owner_id=? AND contact_id=? AND id IN (SELECT r.message_id FROM capture_record r JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id WHERE g.owner_id=?${scope.kind==='account'?'':' AND g.accepted_data_generation<?'})`,scope.kind==='account'?[ownerId,contact,ownerId]:[ownerId,contact,ownerId,op.acceptedGeneration]);
   }
  }
  const older=scope.kind==='account'?'':' AND accepted_data_generation<?';
  const args=scope.kind==='account'?[ownerId]:[ownerId,scope.contactId,op.acceptedGeneration];
  const contacts=scope.kind==='account'?'':' AND contact_id=?';
  tx.run(`UPDATE capture_record SET availability='deleting' WHERE owner_id=?${scope.kind==='source'?' AND contact_id=? AND id IN (SELECT value FROM json_each(?))':contacts} AND capture_id IN (SELECT c.id FROM sync_capture c JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id WHERE g.owner_id=?${older})`,scope.kind==='source'?[ownerId,scope.contactId,JSON.stringify(sourceDeletionIds(tx,op)),ownerId,op.acceptedGeneration]:scope.kind==='account'?[ownerId,ownerId]:[ownerId,scope.contactId,ownerId,op.acceptedGeneration]);
  tx.run(`UPDATE read_goal SET state='invalidated',failure_code='history_deleted' WHERE owner_id=?${contacts}${older} AND state<>'invalidated'`,args);
  return [];
 },
 collect:scopeRows,
 clearRow(tx,op,t){
  if(t.domain!=='history'||!Object.hasOwn(rowKinds,t.rowKind)||t.key.owner_id!==op.ownerId||t.identity!==identity(t.rowKind,t.key))throw new StorageFailure('history_deletion_target_invalid');
  // 依赖行先清除后，原计划身份仍由同一删除账本固定，不能扩展到任意新行。
  const planned=tx.all('SELECT target_payload FROM deletion_target WHERE operation_id=?',[op.operationId]).some(r=>{const p=JSON.parse(String(r.target_payload));return p.domain==='history'&&p.identity===t.identity;});
  if(!planned)throw new StorageFailure('history_deletion_target_invalid');
  const keys=rowKinds[t.rowKind]!.keys;
  if(t.rowKind==='history_quote_dependency'){
   const row=tx.get('SELECT * FROM history_quote WHERE owner_id=? AND id=?',[t.key.owner_id,t.key.id]);
   if(!row)return;
   const records=tx.all(`SELECT r.* FROM capture_record r JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id
    JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id WHERE ${op.scope.kind==='account'?'r.owner_id=?':op.scope.kind==='source'?'r.owner_id=? AND r.contact_id=? AND r.id IN (SELECT value FROM json_each(?))':'r.owner_id=? AND r.contact_id=?'}${op.scope.kind==='account'?'':" AND g.accepted_data_generation<?"}`,
    op.scope.kind==='account'?[op.ownerId]:op.scope.kind==='source'?[op.ownerId,op.scope.contactId,JSON.stringify(sourceDeletionIds(tx,op)),op.acceptedGeneration]:[op.ownerId,op.scope.contactId,op.acceptedGeneration]);
   if(quoteTargetAffected(tx,op.ownerId,String(row.contact_id),row,idsForScope(tx,op,records).affectedMessageIds))
    tx.run(`UPDATE history_quote SET referenced_text=NULL,referenced_sender=NULL,referenced_sender_role='unknown',referenced_type=NULL,
     referenced_server_id=NULL,target_message_id=NULL,state='unavailable',interpretation_revision=interpretation_revision+1
     WHERE owner_id=? AND id=?`,[t.key.owner_id,t.key.id]);
   return;
  }
  tx.run(`DELETE FROM ${t.rowKind} WHERE ${keys.map(k=>`${k}=?`).join(' AND ')}`,keys.map(k=>t.key[k]!));
 },
 authorizeFile(){throw new StorageFailure('history_has_no_managed_files');},
 fileCleared(){throw new StorageFailure('history_has_no_managed_files');},
 verify(tx,op){
  const empty=scopeRows(tx,op).length===0;
  const removedRecords=plannedIds(tx,op,'capture_record'),removedMessages=plannedIds(tx,op,'message');
  const quoteRows=tx.all('SELECT id,message_id,source_record_id,binding_id,target_message_id,referenced_server_id,referenced_text,referenced_sender,referenced_type FROM history_quote WHERE owner_id=?'+(op.scope.kind==='account'?'':' AND contact_id=?'),
   op.scope.kind==='account'?[op.ownerId]:[op.ownerId,op.scope.contactId]);
  const clearedDependencies=plannedIds(tx,op,'history_quote_dependency');
  const attemptRows=tx.all('SELECT message_id,record_id FROM history_quote_attempt WHERE owner_id=?'+(op.scope.kind==='account'?'':' AND contact_id=?'),
   op.scope.kind==='account'?[op.ownerId]:[op.ownerId,op.scope.contactId]);
  const quoteClean=quoteRows.every(row=>!removedMessages.has(String(row.message_id))&&!removedRecords.has(String(row.source_record_id))
   &&(row.target_message_id===null||!removedMessages.has(String(row.target_message_id)))
   &&(!clearedDependencies.has(String(row.id))||row.target_message_id===null&&row.referenced_server_id===null&&row.referenced_text===null&&row.referenced_sender===null&&row.referenced_type===null));
  const attemptsClean=attemptRows.every(row=>!removedMessages.has(String(row.message_id))&&!removedRecords.has(String(row.record_id)));
  // 联系人聊天清空只有在该操作自己的完整 B 被原子接受后才通过写入抑制复核；
  // 其他删除范围仍由身份/来源排除证明，不把缺失边界当作成功。
  const suppression=op.scope.kind==='contact_history'
   ?verifiedCutoffForOperation(tx,op.ownerId,op.operationId,op.scope.contactId)
     ?pass('verified_boundary_manifest_accepted')
     :{result:'blocked' as const,proof:'exact_channel_cutoff_required'}
   :pass(op.scope.kind==='source'?'identity_fence_and_source_exclusions':'identity_revoked_or_exact_source_excluded');
  return {database_rows:empty?pass('history_rows_cleared'):{result:'blocked',proof:'history_rows_remain'},
   derived_eligibility:{result:'not_applicable',proof:'history_no_derived_results'},trace_payloads:empty&&quoteClean&&attemptsClean?pass('history_capture_payloads_cleared'):{result:'blocked',proof:'history_payloads_remain'},
   request_replay:pass('identity_fence_and_source_exclusions'),scope_suppression:suppression};
 }
};
