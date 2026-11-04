import {assertSourceEligibility,type SourceEligibility} from '../../../history/sqlite/source.ts';
import type {StorageRow,StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {archivedExtractionOutput} from '../outputs.ts';
interface Parent {candidateId?:string;memoryId?:string;versionNo?:bigint}
function candidateEvents(tx:StorageTransaction,ownerId:string,parent:Parent):StorageRow[]{
 return parent.candidateId?tx.all('SELECT event_id FROM memory_candidate WHERE owner_id=? AND id=?',[ownerId,parent.candidateId]):tx.all(`WITH RECURSIVE versions(memory_id,version_no) AS (
  SELECT ?,? UNION SELECT v.memory_id,v.previous_version_no FROM memory_version v JOIN versions a ON a.memory_id=v.memory_id AND a.version_no=v.version_no WHERE v.owner_id=? AND v.previous_version_no IS NOT NULL
  UNION SELECT v.memory_id,v.restored_from_version_no FROM memory_version v JOIN versions a ON a.memory_id=v.memory_id AND a.version_no=v.version_no WHERE v.owner_id=? AND v.restored_from_version_no IS NOT NULL
  UNION SELECT i.memory_id,i.memory_version_no FROM versions a CROSS JOIN memory_version v ON a.memory_id=v.memory_id AND a.version_no=v.version_no
  JOIN memory_decision d ON d.owner_id=v.owner_id AND d.id=v.decision_id JOIN step_attempt sa ON sa.owner_id=d.owner_id AND sa.id=d.execution_id
  JOIN step_input i ON i.owner_id=sa.owner_id AND i.step_id=sa.step_id AND i.kind='memory' WHERE v.owner_id=? AND (
   NOT EXISTS(SELECT 1 FROM execution_event e WHERE e.owner_id=sa.owner_id AND e.step_attempt_id=sa.id AND e.kind='adjudication_result')
   OR EXISTS(SELECT 1 FROM execution_event e CROSS JOIN execution_input x ON x.owner_id=e.owner_id AND x.event_id=e.id WHERE e.owner_id=sa.owner_id AND e.step_attempt_id=sa.id AND e.kind='adjudication_result' AND x.role='parent_memory' AND x.planned_step_id=i.step_id AND x.planned_input_no=i.input_no)))
  SELECT DISTINCT c.event_id,CASE WHEN EXISTS(SELECT 1 FROM versions old JOIN memory_version ov ON ov.owner_id=v.owner_id AND ov.memory_id=old.memory_id AND ov.version_no=old.version_no
   JOIN memory_decision od ON od.owner_id=ov.owner_id AND od.id=ov.decision_id JOIN step_attempt oa ON oa.owner_id=od.owner_id AND oa.id=od.execution_id JOIN processing_step os ON os.owner_id=oa.owner_id AND os.id=oa.step_id
   WHERE os.kind IN ('adjudication','relation_verification','merge_verification') AND NOT EXISTS(SELECT 1 FROM execution_event e WHERE e.owner_id=oa.owner_id AND e.step_attempt_id=oa.id AND e.kind='adjudication_result')) THEN 1 ELSE 0 END AS legacy_unbound FROM memory_version v JOIN versions a ON a.memory_id=v.memory_id AND a.version_no=v.version_no
  JOIN decision_candidate dc ON dc.owner_id=v.owner_id AND dc.decision_id=v.decision_id JOIN memory_candidate c ON c.owner_id=dc.owner_id AND c.id=dc.candidate_id
  WHERE v.owner_id=?`,[parent.memoryId!,parent.versionNo!,ownerId,ownerId,ownerId,ownerId]);
}
/** 旧整窗引用只作为存档保留；展示和消费均沿原候选事实投影其真实来源范围。 */
export function projectCitations(tx:StorageTransaction,ownerId:string,parent:Parent,rows:StorageRow[],sourceEligibility:SourceEligibility=assertSourceEligibility):StorageRow[]{
 const candidates=candidateEvents(tx,ownerId,parent);if(!candidates.length)return rows;
 const expected=candidates.flatMap(c=>{try{return archivedExtractionOutput(tx,{ownerId,eventId:String(c.event_id)},sourceEligibility).citations;}catch{return [];}});
 const seen=new Set<string>();
 return expected.flatMap(c=>{
  const original=rows.find(r=>r.source_contact_id===c.contactId&&r.message_id===c.messageId&&r.record_id===c.recordId&&r.accepted_revision===c.interpretationRevision
   &&(c.contentKind?(r.content_kind===c.contentKind&&r.content_ref_json===JSON.stringify(c.contentRef)):(r.content_kind??'text')==='text'));
  const key=JSON.stringify([c.contactId,c.messageId,c.recordId,String(c.spanStart),String(c.spanEnd)]);
  if(!original||seen.has(key))return [];seen.add(key);
  return [{...original,span_start:c.spanStart,span_end:c.spanEnd,explanation:c.explanation}];
 });
}

export function sourceVerificationState(tx:StorageTransaction,ownerId:string,parent:Parent,sourceEligibility:SourceEligibility=assertSourceEligibility):'verified'|'pending'{
 if(parent.memoryId){
  const version=tx.get('SELECT v.restored_from_version_no,d.action FROM memory_version v JOIN memory_decision d ON d.owner_id=v.owner_id AND d.id=v.decision_id WHERE v.owner_id=? AND v.memory_id=? AND v.version_no=?',[ownerId,parent.memoryId,parent.versionNo!]);
  if(!version||['edit_accept','correct','change','manual'].includes(String(version.action)))return 'pending';
  if(version.action==='restore'){
   if(typeof version.restored_from_version_no!=='bigint'||version.restored_from_version_no>=parent.versionNo!)return 'pending';
   return sourceVerificationState(tx,ownerId,{memoryId:parent.memoryId,versionNo:version.restored_from_version_no},sourceEligibility);
  }
 }
 const candidates=candidateEvents(tx,ownerId,parent);if(!candidates.length)return 'pending';
 try{return candidates.every(c=>c.legacy_unbound!==1n&&archivedExtractionOutput(tx,{ownerId,eventId:String(c.event_id)},sourceEligibility).semanticVerification.state==='verified')?'verified':'pending';}catch{return 'pending';}
}
