import {StorageFailure,type StorageRow,type StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import type {ReplySource} from '../../../reply/sqlite/candidates/contracts.ts';
import {assertSourceEligibility,type SourceEligibility} from '../../../history/sqlite/source.ts';
type QualificationParent={candidateId?:string;memoryId?:string;versionNo?:bigint};
interface QualificationMemo {rows:Map<string,StorageRow[]>;verified:Map<SourceEligibility,Set<string>>;}
const qualificationMemos=new WeakMap<StorageTransaction,QualificationMemo>();
const parentKey=(ownerId:string,parent:QualificationParent)=>JSON.stringify([ownerId,parent.candidateId??null,parent.memoryId??null,parent.versionNo?.toString()??null]);
const copyRows=(rows:StorageRow[]):StorageRow[]=>rows.map(row=>({...row}));
/** 仅在一次同步领域动作内复用冻结依赖；退出（含异常）即清除，不跨动作或来源策略授予资格。 */
export function withQualificationSources<T>(tx:StorageTransaction,work:()=>T):T {
 if(qualificationMemos.has(tx))return work();
 qualificationMemos.set(tx,{rows:new Map(),verified:new Map()});
 try{return work();}finally{qualificationMemos.delete(tx);}
}
/** 只收集冻结依赖身份；调用方仍须在同一事务核验来源及消息修订。 */
export function qualificationSourceRows(tx:StorageTransaction,ownerId:string,parent:QualificationParent):StorageRow[]{
 const memo=qualificationMemos.get(tx),key=parentKey(ownerId,parent),cached=memo?.rows.get(key);
 if(cached)return copyRows(cached);
 const rows=tx.all(`WITH RECURSIVE versions(memory_id,version_no) AS (
 SELECT ?,? WHERE ? IS NOT NULL
 UNION SELECT v.memory_id,v.previous_version_no FROM memory_version v JOIN versions a ON a.memory_id=v.memory_id AND a.version_no=v.version_no WHERE v.owner_id=? AND v.previous_version_no IS NOT NULL
 UNION SELECT v.memory_id,v.restored_from_version_no FROM memory_version v JOIN versions a ON a.memory_id=v.memory_id AND a.version_no=v.version_no WHERE v.owner_id=? AND v.restored_from_version_no IS NOT NULL
 UNION SELECT i.memory_id,i.memory_version_no FROM versions a CROSS JOIN memory_version v ON a.memory_id=v.memory_id AND a.version_no=v.version_no JOIN memory_decision d ON d.owner_id=v.owner_id AND d.id=v.decision_id JOIN step_attempt sa ON sa.owner_id=d.owner_id AND sa.id=d.execution_id JOIN step_input i ON i.owner_id=sa.owner_id AND i.step_id=sa.step_id AND i.kind='memory' WHERE v.owner_id=?
 ), candidates(candidate_id) AS (
 SELECT ? WHERE ? IS NOT NULL UNION SELECT dc.candidate_id FROM decision_candidate dc JOIN memory_version v ON v.owner_id=dc.owner_id AND v.decision_id=dc.decision_id JOIN versions a ON a.memory_id=v.memory_id AND a.version_no=v.version_no WHERE dc.owner_id=?
 ), sources(source_contact_id,message_id,record_id,accepted_interpretation_revision) AS (
 SELECT i.source_contact_id,i.message_id,i.record_id,i.accepted_interpretation_revision FROM candidates c CROSS JOIN memory_candidate mc ON mc.owner_id=? AND mc.id=c.candidate_id CROSS JOIN execution_input x ON x.owner_id=mc.owner_id AND x.event_id=mc.event_id JOIN step_input si ON si.owner_id=x.owner_id AND si.step_id=x.planned_step_id AND si.input_no=x.planned_input_no JOIN run_input i ON i.owner_id=si.owner_id AND i.run_id=si.run_id AND i.input_no=si.run_input_no
 UNION SELECT i.source_contact_id,i.message_id,i.record_id,i.accepted_revision FROM versions a JOIN memory_version v ON v.owner_id=? AND v.memory_id=a.memory_id AND v.version_no=a.version_no JOIN memory_decision d ON d.owner_id=v.owner_id AND d.id=v.decision_id JOIN step_attempt sa ON sa.owner_id=d.owner_id AND sa.id=d.execution_id JOIN step_input i ON i.owner_id=sa.owner_id AND i.step_id=sa.step_id AND i.kind='message'
 ) SELECT DISTINCT * FROM sources ORDER BY source_contact_id,message_id,record_id`,[parent.memoryId??null,parent.versionNo??null,parent.memoryId??null,ownerId,ownerId,ownerId,parent.candidateId??null,parent.candidateId??null,ownerId,ownerId,ownerId]);
 memo?.rows.set(key,copyRows(rows));return rows;
}
/** 冻结贡献是资格依赖，和证据引句分开；消费者清理需覆盖两者。 */
export function qualificationSources(tx:StorageTransaction,ownerId:string,parent:QualificationParent,sourceEligibility:SourceEligibility=assertSourceEligibility):ReplySource[]{
 const memo=qualificationMemos.get(tx),verified=memo?.verified.get(sourceEligibility),checked=new Set<string>();
 let sources:ReplySource[];
 try{sources=qualificationSourceRows(tx,ownerId,parent).map(r=>{
  const source={contactId:String(r.source_contact_id),messageId:String(r.message_id),recordId:String(r.record_id),acceptedRevision:r.accepted_interpretation_revision as bigint};
  const key=JSON.stringify([ownerId,source.contactId,source.messageId,source.recordId,String(source.acceptedRevision)]);
  if(!verified?.has(key)&&!checked.has(key)){
   sourceEligibility(tx,{owner_id:ownerId,contact_id:source.contactId,message_id:source.messageId,record_id:source.recordId});
   if(!tx.get("SELECT 1 FROM message WHERE owner_id=? AND contact_id=? AND id=? AND interpretation_revision=? AND availability='available'",[ownerId,source.contactId,source.messageId,source.acceptedRevision]))throw new StorageFailure('memory_source_stale');
   checked.add(key);
  }
  return source;
 });}catch(error){memo?.rows.delete(parentKey(ownerId,parent));throw error;}
 // 整个父项核验成功后才公开新增资格；失败及部分成功不能变成另一次读取的授权。
 if(memo){const accepted=verified??new Set<string>();for(const key of checked)accepted.add(key);memo.verified.set(sourceEligibility,accepted);}
 return sources;
}
export const mergeKnowledgeSources=(...groups:ReplySource[][]):ReplySource[]=>[...new Map(groups.flat().map(s=>[JSON.stringify([s.contactId,s.recordId,s.messageId]),s])).values()].sort((a,b)=>a.contactId.localeCompare(b.contactId)||a.messageId.localeCompare(b.messageId)||a.recordId.localeCompare(b.recordId));

/** 冻结任务联系人仅供归属展示；不扩大实际消息资格或删除依赖，也不复验旧处理授权。 */
export function frozenContributingContactIds(tx:StorageTransaction,ownerId:string,parent:{candidateId?:string;memoryId?:string;versionNo?:bigint}):string[]{
 const rows=tx.all(`WITH RECURSIVE versions(memory_id,version_no) AS (
  SELECT ?,? WHERE ? IS NOT NULL
  UNION SELECT v.memory_id,v.previous_version_no FROM memory_version v JOIN versions a ON a.memory_id=v.memory_id AND a.version_no=v.version_no WHERE v.owner_id=? AND v.previous_version_no IS NOT NULL
  UNION SELECT v.memory_id,v.restored_from_version_no FROM memory_version v JOIN versions a ON a.memory_id=v.memory_id AND a.version_no=v.version_no WHERE v.owner_id=? AND v.restored_from_version_no IS NOT NULL
  UNION SELECT i.memory_id,i.memory_version_no FROM versions a CROSS JOIN memory_version v ON a.memory_id=v.memory_id AND a.version_no=v.version_no
   JOIN memory_decision d ON d.owner_id=v.owner_id AND d.id=v.decision_id JOIN step_attempt sa ON sa.owner_id=d.owner_id AND sa.id=d.execution_id
   JOIN step_input i ON i.owner_id=sa.owner_id AND i.step_id=sa.step_id AND i.kind='memory' WHERE v.owner_id=? AND (
    NOT EXISTS(SELECT 1 FROM execution_event e WHERE e.owner_id=sa.owner_id AND e.step_attempt_id=sa.id AND e.kind='adjudication_result')
    OR EXISTS(SELECT 1 FROM execution_event e CROSS JOIN execution_input x ON x.owner_id=e.owner_id AND x.event_id=e.id WHERE e.owner_id=sa.owner_id AND e.step_attempt_id=sa.id AND e.kind='adjudication_result' AND x.role='parent_memory' AND x.planned_step_id=i.step_id AND x.planned_input_no=i.input_no))
 ), candidates(candidate_id) AS (
  SELECT ? WHERE ? IS NOT NULL UNION SELECT dc.candidate_id FROM decision_candidate dc JOIN memory_version v ON v.owner_id=dc.owner_id AND v.decision_id=dc.decision_id
   JOIN versions a ON a.memory_id=v.memory_id AND a.version_no=v.version_no WHERE dc.owner_id=?)
 SELECT DISTINCT tc.source_contact_id FROM candidates c JOIN memory_candidate mc ON mc.owner_id=? AND mc.id=c.candidate_id
 JOIN step_attempt a ON a.owner_id=mc.owner_id AND a.id=mc.produced_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id
 JOIN task_contribution tc ON tc.owner_id=s.owner_id AND tc.task_id=s.task_id ORDER BY tc.source_contact_id`,[parent.memoryId??null,parent.versionNo??null,parent.memoryId??null,ownerId,ownerId,ownerId,parent.candidateId??null,parent.candidateId??null,ownerId,ownerId]);
 return rows.map(r=>String(r.source_contact_id));
}
