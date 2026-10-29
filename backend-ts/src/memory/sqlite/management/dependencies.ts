import type {StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import type {ReplySource} from '../../../reply/sqlite/candidates/contracts.ts';
import {assertSourceEligibility} from '../../../history/sqlite/source.ts';
import {fail} from './qualification.ts';
/** 冻结贡献是资格依赖，和证据引句分开；消费者清理需覆盖两者。 */
export function qualificationSources(tx:StorageTransaction,ownerId:string,parent:{candidateId?:string;memoryId?:string;versionNo?:bigint}):ReplySource[]{
 const ancestor=parent.candidateId?'':`WITH RECURSIVE versions(version_no) AS (SELECT ? UNION SELECT v.previous_version_no FROM memory_version v JOIN versions a ON v.version_no=a.version_no WHERE v.owner_id=? AND v.memory_id=? AND v.previous_version_no IS NOT NULL UNION SELECT v.restored_from_version_no FROM memory_version v JOIN versions a ON v.version_no=a.version_no WHERE v.owner_id=? AND v.memory_id=? AND v.restored_from_version_no IS NOT NULL)`;
 const selectCandidate=parent.candidateId?'c.id=?':`c.id IN (SELECT dc.candidate_id FROM decision_candidate dc JOIN memory_version v ON v.owner_id=dc.owner_id AND v.decision_id=dc.decision_id JOIN versions a ON a.version_no=v.version_no WHERE v.owner_id=? AND v.memory_id=?)`;
 const params=parent.candidateId?[ownerId,parent.candidateId]:[parent.versionNo!,ownerId,parent.memoryId!,ownerId,parent.memoryId!,ownerId,ownerId,parent.memoryId!];
 const rows=tx.all(`${ancestor} SELECT DISTINCT i.source_contact_id,i.message_id,i.record_id,i.accepted_interpretation_revision FROM memory_candidate c
 JOIN step_attempt a ON a.owner_id=c.owner_id AND a.id=c.produced_attempt_id
 JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id
 JOIN task_contribution tc ON tc.owner_id=s.owner_id AND tc.task_id=s.task_id
 JOIN run_input i ON i.owner_id=tc.owner_id AND i.run_id=tc.run_id AND i.source_contact_id=tc.source_contact_id
 WHERE c.owner_id=? AND ${selectCandidate} ORDER BY i.source_contact_id,i.message_id,i.record_id`,params);
 return rows.map(r=>{
  const source={contactId:String(r.source_contact_id),messageId:String(r.message_id),recordId:String(r.record_id),acceptedRevision:r.accepted_interpretation_revision as bigint};
  assertSourceEligibility(tx,{owner_id:ownerId,contact_id:source.contactId,message_id:source.messageId,record_id:source.recordId});
  if(!tx.get("SELECT 1 FROM message WHERE owner_id=? AND contact_id=? AND id=? AND interpretation_revision=? AND availability='available'",[ownerId,source.contactId,source.messageId,source.acceptedRevision]))fail('memory_source_stale');return source;
 });
}
export const mergeKnowledgeSources=(...groups:ReplySource[][]):ReplySource[]=>[...new Map(groups.flat().map(s=>[JSON.stringify([s.contactId,s.recordId,s.messageId]),s])).values()].sort((a,b)=>a.contactId.localeCompare(b.contactId)||a.messageId.localeCompare(b.messageId)||a.recordId.localeCompare(b.recordId));
