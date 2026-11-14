import type {StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import type {DeletionOperation} from '../../../storage/sqlite/deletion/contracts.ts';
import {memoryDeletionImpact} from '../../../memory/sqlite/deletion-impact.ts';
import {sourceDeletionIds} from '../../../history/sqlite/source-deletion.ts';
import {decode,encode} from '../requests.ts';

/** 搜索准备范围不是模型实际依据；删除时只剪除受影响锚点，不撤下无关候选或重置尝试。 */
export function pruneReplySearchMetadata(tx:StorageTransaction,op:DeletionOperation):void{
 if(op.scope.kind==='discussion')return;
 const rows=tx.all("SELECT id,payload FROM execution_event WHERE owner_id=? AND kind='reply_search' AND json_extract(payload,'$.phase') IN ('scope','begin')",[op.ownerId]);
 if(!rows.length)return;
 const all=op.scope.kind==='account',impact=all?null:memoryDeletionImpact(tx,op);
 const memories=new Set(impact?.memories??[]),versions=new Set(impact?.versions.map(item=>encode([item.memoryId,item.versionNo]))??[]);
 const records=new Set(op.scope.kind==='source'?sourceDeletionIds(tx,op):[]);
 if(op.scope.kind==='contact'||op.scope.kind==='contact_history'){
  for(const row of tx.all(`SELECT r.id FROM capture_record r JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id
   JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id WHERE r.owner_id=? AND r.contact_id=? AND g.accepted_data_generation<?`,[op.ownerId,op.scope.contactId,op.acceptedGeneration]))records.add(String(row.id));
 }
 // 原始行可能已在前次清理中消失；已冻结的删除计划仍是重试依据。
 for(const row of tx.all("SELECT row_key_snapshot FROM deletion_target WHERE operation_id=? AND domain='history' AND row_kind='capture_record' AND row_key_snapshot IS NOT NULL",[op.operationId])){
  const key=JSON.parse(String(row.row_key_snapshot));if(key.owner_id===op.ownerId&&typeof key.id==='string')records.add(key.id);
 }
 for(const row of rows){
  const payload=decode<Record<string,unknown>>(String(row.payload));let changed=false;
  if(Array.isArray(payload.memories)){
   const before=payload.memories as {id:string;versionNo:bigint}[];
   const after=before.filter(item=>!all&&!memories.has(item.id)&&!versions.has(encode([item.id,item.versionNo])));
   if(after.length!==before.length){payload.memories=after;changed=true;}
  }
  if(Array.isArray(payload.history)){
   const before=payload.history as {recordId:string}[],after=before.filter(item=>!all&&!records.has(item.recordId));
   if(after.length!==before.length){payload.history=after;changed=true;}
  }
  if(changed)tx.run("UPDATE execution_event SET payload=? WHERE owner_id=? AND id=? AND kind='reply_search'",[encode(payload),op.ownerId,row.id]);
 }
}
