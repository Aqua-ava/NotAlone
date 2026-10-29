import {archivedExtractionOutput} from '../outputs.ts';
import {sourceVerificationState} from './evidence.ts';
import {memoryTimeEligibility} from './temporal.ts';
import {qualificationSources,frozenContributingContactIds} from './dependencies.ts';
import type {StorageRow,StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {available,citations,fail,id,requireCandidate,requireSources,requireVersion,scope} from './qualification.ts';
import type {MemoryCandidateView,MemoryManagementView,MemoryScope,MemorySource,MemoryVersionView} from './contracts.ts';
export function sourceViews(rows:StorageRow[]):MemorySource[]{return rows.map(r=>({contactId:String(r.source_contact_id),messageId:String(r.message_id),recordId:String(r.record_id),acceptedRevision:String(r.accepted_revision),quote:[...String(r.text_body)].slice(Number(r.span_start),Number(r.span_end)).join('')}));}
function mergeParents(tx:StorageTransaction,ownerId:string,decisionId:string){
 return tx.all("SELECT m.id,m.current_version_no,m.head_revision FROM memory_decision r JOIN memory_decision d ON d.owner_id=r.owner_id AND d.execution_id=r.execution_id JOIN memory m ON m.owner_id=r.owner_id AND m.id=r.target_memory_id WHERE d.owner_id=? AND d.id=? AND d.action='auto_update' AND r.action='auto_retire' AND r.actor_kind='system' AND r.outcome='applied' ORDER BY m.id",[ownerId,decisionId]).map(m=>({memoryId:String(m.id),versionNo:String(m.current_version_no),headRevision:String(m.head_revision)}));
}
export function versionView(tx:StorageTransaction,ownerId:string,v:StorageRow):MemoryVersionView{const parents=mergeParents(tx,ownerId,String(v.decision_id));if(v.content_state==='present')qualificationSources(tx,ownerId,{memoryId:String(v.memory_id),versionNo:v.version_no as bigint});return {timeStatus:v.content_state==='present'?memoryTimeEligibility(tx,ownerId,{memoryId:String(v.memory_id),versionNo:v.version_no as bigint}):'invalid',mergeParents:parents,mergeParentCount:parents.length?parents.length+1:0,verificationState:v.content_state==='present'?sourceVerificationState(tx,ownerId,{memoryId:String(v.memory_id),versionNo:v.version_no as bigint}):'pending',versionNo:String(v.version_no),body:v.body as string|null,formationKind:String(v.formation_kind),adoptionMode:String(v.adoption_mode),previousVersionNo:v.previous_version_no===null?null:String(v.previous_version_no),restoredFromVersionNo:v.restored_from_version_no===null?null:String(v.restored_from_version_no),contentState:String(v.content_state),provenanceState:String(v.provenance_state),decisionId:String(v.decision_id),contributingContactIds:v.content_state==='present'?frozenContributingContactIds(tx,ownerId,{memoryId:String(v.memory_id),versionNo:v.version_no as bigint}):[],sources:sourceViews(citations(tx,ownerId,{memoryId:String(v.memory_id),versionNo:v.version_no as bigint}))};}
export function managementRead(tx:StorageTransaction,input:unknown):MemoryManagementView{
 const q=input as any,ownerId=id(q?.ownerId),s=scope(q?.scope);available(tx,ownerId,s);
 // 删除进行期间立即撤下全部快照，不以按钮禁用替代敏感正文清除。
 if(tx.get("SELECT 1 FROM deletion_operation WHERE owner_identity=? AND state<>'completed'",[ownerId]))return {candidates:[],memories:[]};
 const candidates=tx.all('SELECT * FROM memory_candidate WHERE owner_id=? AND scope_kind=? AND contact_id IS ? ORDER BY id',[ownerId,s.scopeKind,s.contactId]).flatMap(c=>{
  if(!['pending','adopted','rejected','duplicate'].includes(String(c.state)))return [];
  let verificationState:'verified'|'pending';
  try{
   if(c.state==='pending')verificationState=requireCandidate(tx,ownerId,c).state;
   else{
    const out=archivedExtractionOutput(tx,{ownerId,eventId:String(c.event_id)});
    if(out.proposedBody!==c.proposed_body||out.producedAttemptId!==c.produced_attempt_id||out.scopeKind!==c.scope_kind||out.contactId!==c.contact_id||out.outputNo!==c.output_no)fail('memory_candidate_stale');
    requireSources(tx,ownerId,{candidateId:String(c.id)});verificationState=out.semanticVerification.state;
   }
  }catch{return [];}
  qualificationSources(tx,ownerId,{candidateId:String(c.id)});
  return [{verificationState,id:String(c.id),scopeKind:s.scopeKind,contactId:s.contactId,body:String(c.proposed_body),state:c.state as MemoryCandidateView['state'],stateRevision:String(c.state_revision),eventId:String(c.event_id),contributingContactIds:frozenContributingContactIds(tx,ownerId,{candidateId:String(c.id)}),sources:sourceViews(citations(tx,ownerId,{candidateId:String(c.id)}))}];
 });
 const memories=tx.all('SELECT * FROM memory WHERE owner_id=? AND scope_kind=? AND contact_id IS ? ORDER BY id',[ownerId,s.scopeKind,s.contactId]).map(m=>{
  const versions=tx.all('SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? ORDER BY version_no',[ownerId,m.id]).map(v=>{
   try{if(v.content_state==='present')requireVersion(tx,ownerId,m,v);return versionView(tx,ownerId,v);}catch{return {...versionView(tx,ownerId,{...v,body:null,content_state:'redacted'}),sources:[],provenanceState:'invalidated'};}
  });
  const current=m.state==='active'?versions.find(v=>v.versionNo===String(m.current_version_no)&&v.body!==null&&v.provenanceState==='eligible')??null:null;
  const decisions=tx.all('SELECT * FROM memory_decision WHERE owner_id=? AND target_memory_id=? ORDER BY COALESCE(expected_head_revision,-1),id',[ownerId,m.id]).map(d=>({id:String(d.id),action:String(d.action),actorKind:String(d.actor_kind),createdAt:String(d.created_at),expectedHeadRevision:d.expected_head_revision===null?null:String(d.expected_head_revision),expectedVersionNo:d.expected_version_no===null?null:String(d.expected_version_no),outcome:String(d.outcome)}));
  return {id:String(m.id),scopeKind:s.scopeKind,contactId:s.contactId,headRevision:String(m.head_revision),state:String(m.state),manualProtection:m.manual_protection===1n,current,versions,decisions};
 });return {candidates,memories};
}
