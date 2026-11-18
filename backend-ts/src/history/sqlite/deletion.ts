import {deleteProof} from './source-proof.ts';
import {getSourceGuard} from './source-guard.ts';
import {sourceDeletionIds,sourceDeletionPhysicalKeys} from './source-deletion.ts';
import { StorageFailure, type StorageRow, type StorageTransaction } from '../../storage/sqlite/contracts.ts';
import type { DeletionDomain, DeletionOperation, RowDeletionTarget, CheckResult } from '../../storage/sqlite/deletion/contracts.ts';
import { verifiedCutoffForOperation } from './clear-actions.ts';
import { deletionTargetKey } from '../../storage/sqlite/deletion/actions.ts';
import {historyTarget as target,rowIdentity as identity} from './deletion-target.ts';
const rowKinds=Object.fromEntries(['capture_record','message_alias','message','sync_capture','read_goal'].map(kind=>[kind,{keys:['owner_id','id'],ownerKey:'owner_id'}]));
rowKinds.history_quote={keys:['owner_id','id'],ownerKey:'owner_id'};
rowKinds.history_quote_dependency={keys:['owner_id','id'],ownerKey:'owner_id'};
rowKinds.history_quote_attempt={keys:['owner_id','id'],ownerKey:'owner_id'};
rowKinds.history_source_equivalence={keys:['owner_id','id'],ownerKey:'owner_id'};
rowKinds.source_proof={keys:['owner_id','contact_id'],ownerKey:'owner_id'};
rowKinds.history_source_terminal={keys:['owner_id','id'],ownerKey:'owner_id'};
const pass=(proof:string):CheckResult=>({result:'passed',proof});
function idsForScope(tx:StorageTransaction,op:DeletionOperation,records:StorageRow[]):{sourceIds:Set<string>;affectedMessageIds:Set<string>;deletedMessageIds:Set<string>} {
 const sourceIds=new Set(records.map(r=>String(r.id)));
 // 每条待删消息的反查补上 contact_id 并固定走 capture_record_message 索引：
 // capture_record(owner_id,contact_id,message_id) 是指向 message(owner_id,contact_id,id) 的复合外键，
 // 因此带 message_id 的行必然与该消息同 contact_id，集合与旧查询（只按 owner_id+message_id）逐行相同；
 // 库内无统计信息时优化器会退回 autoindex_capture_record_4 的 (owner_id,contact_id) 前缀，
 // 对每条消息扫描整个联系人分区（4.3 万消息夹具实测整个联系人删除计划约 64 秒，补索引查找后见下方性能档）。
 const candidates=op.scope.kind==='source'?records.flatMap(r=>r.message_id?[{id:String(r.message_id),contactId:String(r.contact_id)}]:[])
  :tx.all(`SELECT id,contact_id FROM message WHERE owner_id=?${op.scope.kind==='account'?'':' AND contact_id=?'} AND availability='deleting'`,
    op.scope.kind==='account'?[op.ownerId]:[op.ownerId,op.scope.contactId]).map(r=>({id:String(r.id),contactId:String(r.contact_id)}));
 const affectedMessageIds=new Set(candidates.map(c=>c.id));
 const deletedMessageIds=new Set(candidates.filter(({id,contactId})=>!tx.all('SELECT id FROM capture_record INDEXED BY capture_record_message WHERE owner_id=? AND contact_id=? AND message_id=?',[op.ownerId,contactId,id])
  .some(r=>!sourceIds.has(String(r.id)))).map(c=>c.id));
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
 // 聊天清空保留无正文终态抑制；显式重读不能恢复撤回或已消失的来源。
 if(scope.kind==='source')for(const record of records)if(record.observed_key)for(const terminal of tx.all(`SELECT id FROM history_source_terminal
  WHERE owner_id=? AND contact_id=? AND binding_id=? AND external_key=? AND accepted_data_generation<?`,[ownerId,scope.contactId,record.source_binding_id,record.observed_key,op.acceptedGeneration]))targets.push(target('history_source_terminal',{owner_id:ownerId,id:String(terminal.id)}));
 if(scope.kind==='contact'||scope.kind==='account')for(const terminal of tx.all(`SELECT id FROM history_source_terminal WHERE owner_id=?${scope.kind==='contact'?' AND contact_id=?':''}`,scope.kind==='contact'?[ownerId,scope.contactId]:[ownerId]))targets.push(target('history_source_terminal',{owner_id:ownerId,id:String(terminal.id)}));
 // 等价表随迁移47引入；尚未升级的46库没有该表，只按既有范围收集，不当作缺行错误。
 if((scope.kind==='contact'||scope.kind==='account')&&tx.get("SELECT 1 FROM sqlite_schema WHERE name='history_source_equivalence'"))for(const r of tx.all(`SELECT id FROM history_source_equivalence WHERE owner_id=?${scope.kind==='contact'?' AND contact_id=?':''}`,scope.kind==='contact'?[ownerId,scope.contactId]:[ownerId]))targets.push(target('history_source_equivalence',{owner_id:ownerId,id:String(r.id)}));
 if(scope.kind==='contact'||scope.kind==='account')for(const r of tx.all(`SELECT c.id,p.contact_id FROM contact c
  LEFT JOIN source_proof p ON p.owner_id=c.owner_id AND p.contact_id=c.id
  WHERE c.owner_id=?${scope.kind==='contact'?' AND c.id=?':''}`,scope.kind==='contact'?[ownerId,scope.contactId]:[ownerId])){
  const contactId=String(r.id);
  if(r.contact_id!==null||getSourceGuard(tx,ownerId,contactId))targets.push(target('source_proof',{owner_id:ownerId,contact_id:contactId}));
 }
 const {sourceIds,affectedMessageIds,deletedMessageIds}=idsForScope(tx,op,records);
 // 清除派生引用必须先于源出现和规范消息，以满足来源外键并在目标删除前擦除被引副本。
 const quoteRows=tx.all(`SELECT id,contact_id,message_id,source_record_id,binding_id,target_message_id,referenced_server_id FROM history_quote WHERE owner_id=?${scope.kind==='account'?'':' AND contact_id=?'}`,
  scope.kind==='account'?[ownerId]:[ownerId,scope.contactId]);
 for(const quote of quoteRows){
  const quoteId=String(quote.id),carrier=String(quote.message_id),quoteSource=String(quote.source_record_id);
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
  // message_alias_message 索引（迁移 43）让本查询按 message_id 定位，不再扫整个 owner 分区的别名（4.3 万消息夹具上反查总耗时从约 50 秒降到亚毫秒级/条）。
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
    const physicalKeys=sourceDeletionPhysicalKeys(tx,op);
    for(const key of physicalKeys.length?physicalKeys:[String(r.observed_key)])tx.run('INSERT OR IGNORE INTO history_source_exclusion VALUES(?,?,?,?,?)',[ownerId,r.conversation_id,'local',key,op.operationId]);
    // 同上：依赖迁移 43 的 message_alias_message 索引，每个来源一次的排除查询按 message_id 定位。
    if(r.message_id)for(const alias of tx.all('SELECT scheme,external_key FROM message_alias WHERE owner_id=? AND message_id=?',[ownerId,r.message_id]))
     tx.run('INSERT OR IGNORE INTO history_source_exclusion VALUES(?,?,?,?,?)',[ownerId,r.conversation_id,alias.scheme,alias.external_key,op.operationId]);
   }
   else tx.run('INSERT OR IGNORE INTO history_deletion_fence VALUES(?,?,?)',[ownerId,scope.contactId,op.operationId]);
  }else{
   const contacts=scope.kind==='account'?tx.all('SELECT id FROM contact WHERE owner_id=?',[ownerId]).map(r=>String(r.id)):[scope.contactId];
   for(const contact of contacts){
    tx.run('INSERT OR IGNORE INTO history_deletion_fence VALUES(?,?,?)',[ownerId,contact,op.operationId]);
    // 逐条消息按 capture_record_message 索引做存在性判断：旧写法的 IN 子查询先物化整个 owner 的全部消息 ID
    // （36.9 万条 capture_record 关联 sync_capture 与 read_goal），联系人再小每次也要约 6 秒，且计划、领任务、
    // 重新收集、核验各执行一次。选中的行集合不变：capture_record 带 message_id 的行与该消息同 contact_id（复合外键）。
    tx.run(`UPDATE message SET availability='deleting' WHERE owner_id=? AND contact_id=? AND availability<>'deleting' AND EXISTS (SELECT 1 FROM capture_record r INDEXED BY capture_record_message JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id WHERE r.owner_id=message.owner_id AND r.contact_id=message.contact_id AND r.message_id=message.id${scope.kind==='account'?'':' AND g.accepted_data_generation<?'})`,scope.kind==='account'?[ownerId,contact]:[ownerId,contact,op.acceptedGeneration]);
   }
  }
  const older=scope.kind==='account'?'':' AND accepted_data_generation<?';
  const args=scope.kind==='account'?[ownerId]:[ownerId,scope.contactId,op.acceptedGeneration];
  const contacts=scope.kind==='account'?'':' AND contact_id=?';
  // 同上改为逐条记录的存在性判断：旧 IN 子查询每次物化全部 owner 的 sync_capture（含已退役目标）。
  tx.run(`UPDATE capture_record SET availability='deleting' WHERE owner_id=?${scope.kind==='source'?' AND contact_id=? AND id IN (SELECT value FROM json_each(?))':contacts} AND availability<>'deleting' AND EXISTS (SELECT 1 FROM sync_capture c JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id WHERE c.owner_id=capture_record.owner_id AND c.id=capture_record.capture_id${scope.kind==='account'?'':' AND g.accepted_data_generation<?'})`,scope.kind==='source'?[ownerId,scope.contactId,JSON.stringify(sourceDeletionIds(tx,op)),op.acceptedGeneration]:scope.kind==='account'?[ownerId]:[ownerId,scope.contactId,op.acceptedGeneration]);
  tx.run(`UPDATE read_goal SET state='invalidated',failure_code='history_deleted' WHERE owner_id=?${contacts}${older} AND state<>'invalidated'`,args);
  return [];
 },
 collect:scopeRows,
 clearRow(tx,op,t){
  if(t.domain!=='history'||!Object.hasOwn(rowKinds,t.rowKind)||t.key.owner_id!==op.ownerId||t.identity!==identity(t.rowKind,t.key))throw new StorageFailure('history_deletion_target_invalid');
  // 依赖行先清除后，原计划身份仍由同一删除账本固定，不能扩展到任意新行。
  // 按账本唯一键（operation_id,domain,target_key）点查：旧写法每清一个目标就读出并解析本操作的全部目标，
  // 目标数 N 时总量是 N 的平方（3 万目标的联系人清除需要数小时）。目标本身取自账本，键由同样的字段计算。
  const planned=tx.get("SELECT 1 FROM deletion_target WHERE operation_id=? AND domain='history' AND target_key=? AND target_payload IS NOT NULL",[op.operationId,deletionTargetKey(t)]);
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
  if(t.rowKind==='source_proof'){deleteProof(tx,String(t.key.owner_id),String(t.key.contact_id));return;}
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
