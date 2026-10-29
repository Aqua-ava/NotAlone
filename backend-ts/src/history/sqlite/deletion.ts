import { createHash } from 'node:crypto';
import { StorageFailure, type StorageTransaction } from '../../storage/sqlite/contracts.ts';
import type { DeletionDomain, DeletionOperation, RowDeletionTarget, CheckResult } from '../../storage/sqlite/deletion/contracts.ts';
const rowKinds=Object.fromEntries(['capture_record','message_alias','message','sync_capture','read_goal'].map(kind=>[kind,{keys:kind==='message_alias'?['owner_id','contact_id','binding_id','scheme','external_key']:['owner_id','id'],ownerKey:'owner_id'}]));
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
 const deleting=new Set(records.map(r=>String(r.id)));
 const messages=scope.kind==='source'?[...new Set(records.flatMap(r=>r.message_id?[String(r.message_id)]:[]))]:tx.all(`SELECT id FROM message WHERE owner_id=?${scope.kind==='account'?'':' AND contact_id=?'} AND availability='deleting'`,scope.kind==='account'?[ownerId]:[ownerId,scope.contactId]).map(r=>String(r.id));
 for(const id of messages){
  if(tx.all('SELECT id FROM capture_record WHERE owner_id=? AND message_id=?',[ownerId,id]).some(r=>!deleting.has(String(r.id))))continue;
  for(const a of tx.all('SELECT * FROM message_alias WHERE owner_id=? AND message_id=?',[ownerId,id]))targets.push(target('message_alias',{owner_id:ownerId,contact_id:String(a.contact_id),binding_id:String(a.binding_id),scheme:String(a.scheme),external_key:String(a.external_key)}));
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
   const r=tx.get('SELECT r.observed_key,b.conversation_id FROM capture_record r JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id JOIN conversation_binding b ON b.owner_id=g.owner_id AND b.id=g.binding_id WHERE r.owner_id=? AND r.contact_id=? AND r.id=?',[ownerId,scope.contactId,scope.sourceId]);
   if(!r){if(tx.get("SELECT 1 FROM deletion_target WHERE operation_id=? AND domain='history'",[op.operationId]))return [];throw new StorageFailure('history_source_not_found');}
   if(r.observed_key)tx.run('INSERT OR IGNORE INTO history_source_exclusion VALUES(?,?,?,?)',[ownerId,r.conversation_id,r.observed_key,op.operationId]);
   else tx.run('INSERT OR IGNORE INTO history_deletion_fence VALUES(?,?,?)',[ownerId,scope.contactId,op.operationId]);
  }else{
   const contacts=scope.kind==='account'?tx.all('SELECT id FROM contact WHERE owner_id=?',[ownerId]).map(r=>String(r.id)):[scope.contactId];
   for(const contact of contacts){
    tx.run('INSERT OR IGNORE INTO history_deletion_fence VALUES(?,?,?)',[ownerId,contact,op.operationId]);
    tx.run("UPDATE message SET availability='deleting' WHERE owner_id=? AND contact_id=?",[ownerId,contact]);
   }
  }
  tx.run(`UPDATE read_goal SET state='invalidated',failure_code='history_deleted' WHERE owner_id=?${scope.kind==='account'?'':' AND contact_id=?'} AND state<>'invalidated'`,scope.kind==='account'?[ownerId]:[ownerId,scope.contactId]);
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
  const blocked=op.scope.kind==='contact_history'||Boolean('contactId'in op.scope&&tx.get('SELECT 1 FROM history_deletion_fence WHERE owner_id=? AND contact_id=?',[op.ownerId,op.scope.contactId]));
  return {database_rows:empty?pass('history_rows_cleared'):{result:'blocked',proof:'history_rows_remain'},
   derived_eligibility:{result:'not_applicable',proof:'history_no_derived_results'},trace_payloads:empty?pass('history_capture_payloads_cleared'):{result:'blocked',proof:'history_payloads_remain'},
   request_replay:pass('identity_fence_and_source_exclusions'),scope_suppression:blocked&&op.scope.kind!=='contact'&&op.scope.kind!=='account'?{result:'blocked',proof:'exact_channel_cutoff_required'}:pass('identity_revoked_or_exact_source_excluded')};
 }
};
