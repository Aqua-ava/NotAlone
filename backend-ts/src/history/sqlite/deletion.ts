import { createHash } from 'node:crypto';
import { StorageFailure, type StorageTransaction } from '../../storage/sqlite/contracts.ts';
import type { DeletionDomain, DeletionOperation, RowDeletionTarget, CheckResult } from '../../storage/sqlite/deletion/contracts.ts';
import { verifiedCutoffForOperation } from './clear-actions.ts';
const rowKinds=Object.fromEntries(['capture_record','message_alias','message','sync_capture','read_goal'].map(kind=>[kind,{keys:['owner_id','id'],ownerKey:'owner_id'}]));
rowKinds.history_continuity_fence={keys:['owner_id','contact_id'],ownerKey:'owner_id'};
const pass=(proof:string):CheckResult=>({result:'passed',proof});
const identity=(kind:string,key:Record<string,string>):string=>createHash('sha256').update(JSON.stringify([kind,Object.keys(key).sort().map(k=>[k,key[k]])])).digest('hex');
const target=(kind:string,key:Record<string,string>):RowDeletionTarget=>({kind:'row',domain:'history',rowKind:kind,key,identity:identity(kind,key),holderKeys:[]});
function scopeRows(tx:StorageTransaction,op:DeletionOperation):RowDeletionTarget[]{
 const {ownerId,scope}=op;
 if(!['source','contact_history','contact','account'].includes(scope.kind))return [];
 const args=scope.kind==='account'?[ownerId]:scope.kind==='source'?[ownerId,scope.contactId,scope.sourceId]:[ownerId,scope.contactId];
 const clause=scope.kind==='account'?'r.owner_id=?':scope.kind==='source'?'r.owner_id=? AND r.contact_id=? AND r.id=?':'r.owner_id=? AND r.contact_id=?';
 const records=tx.all(`SELECT r.* FROM capture_record r JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id WHERE ${clause}${scope.kind==='account'?'':' AND g.accepted_data_generation<?'}`,scope.kind==='account'?args:[...args,op.acceptedGeneration]);
 const targets=records.map(r=>target('capture_record',{owner_id:ownerId,id:String(r.id)}));
 if(scope.kind==='contact'||scope.kind==='account')for(const r of tx.all(`SELECT owner_id,contact_id FROM history_continuity_fence WHERE owner_id=?${scope.kind==='contact'?' AND contact_id=?':''}`,scope.kind==='contact'?[ownerId,scope.contactId]:[ownerId]))targets.push(target('history_continuity_fence',{owner_id:ownerId,contact_id:String(r.contact_id)}));
 const deleting=new Set(records.map(r=>String(r.id)));
 const messages=scope.kind==='source'?[...new Set(records.flatMap(r=>r.message_id?[String(r.message_id)]:[]))]:tx.all(`SELECT id FROM message WHERE owner_id=?${scope.kind==='account'?'':' AND contact_id=?'} AND availability='deleting'`,scope.kind==='account'?[ownerId]:[ownerId,scope.contactId]).map(r=>String(r.id));
 for(const id of messages){
  if(tx.all('SELECT id FROM capture_record WHERE owner_id=? AND message_id=?',[ownerId,id]).some(r=>!deleting.has(String(r.id))))continue;
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
  tx.run(`UPDATE capture_record SET availability='deleting' WHERE owner_id=?${scope.kind==='source'?' AND contact_id=? AND id=?':contacts} AND capture_id IN (SELECT c.id FROM sync_capture c JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id WHERE g.owner_id=?${older})`,scope.kind==='source'?[ownerId,scope.contactId,scope.sourceId,ownerId,op.acceptedGeneration]:scope.kind==='account'?[ownerId,ownerId]:[ownerId,scope.contactId,ownerId,op.acceptedGeneration]);
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
  tx.run(`DELETE FROM ${t.rowKind} WHERE ${keys.map(k=>`${k}=?`).join(' AND ')}`,keys.map(k=>t.key[k]!));
 },
 authorizeFile(){throw new StorageFailure('history_has_no_managed_files');},
 fileCleared(){throw new StorageFailure('history_has_no_managed_files');},
 verify(tx,op){
  const empty=scopeRows(tx,op).length===0;
  // 联系人聊天清空只有在该操作自己的完整 B 被原子接受后才通过写入抑制复核；
  // 其他删除范围仍由身份/来源排除证明，不把缺失边界当作成功。
  const suppression=op.scope.kind==='contact_history'
   ?verifiedCutoffForOperation(tx,op.ownerId,op.operationId,op.scope.contactId)
     ?pass('verified_boundary_manifest_accepted')
     :{result:'blocked' as const,proof:'exact_channel_cutoff_required'}
   :pass(op.scope.kind==='source'?'identity_fence_and_source_exclusions':'identity_revoked_or_exact_source_excluded');
  return {database_rows:empty?pass('history_rows_cleared'):{result:'blocked',proof:'history_rows_remain'},
   derived_eligibility:{result:'not_applicable',proof:'history_no_derived_results'},trace_payloads:empty?pass('history_capture_payloads_cleared'):{result:'blocked',proof:'history_payloads_remain'},
   request_replay:pass('identity_fence_and_source_exclusions'),scope_suppression:suppression};
 }
};
