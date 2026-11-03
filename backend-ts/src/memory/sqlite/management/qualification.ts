import {qualificationSources} from './dependencies.ts';
import {projectCitations} from './evidence.ts';
import {requireImageCitation} from '../content-citation.ts';
import {StorageFailure,type StorageRow,type StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {assertSourceEligibility} from '../../../history/sqlite/source.ts';
import {verifiedExtractionOutput} from '../outputs.ts';
import type {MemoryScope} from './contracts.ts';
export const fail=(code:string):never=>{throw new StorageFailure(code);};
export const id=(v:unknown):string=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\x00-\x1f]/.test(v)?v:fail('memory_request_invalid');
export const integer=(v:unknown):bigint=>typeof v==='string'&&/^(0|[1-9][0-9]{0,17})$/.test(v)?BigInt(v):fail('memory_request_invalid');
export const body=(v:unknown):string=>typeof v==='string'&&v.trim().length>0&&[...v].length<=12000?v:fail('memory_request_invalid');
export function scope(value:unknown):MemoryScope {
 const s=value as MemoryScope;
 if(!s||!['self','contact'].includes(s.scopeKind)||(s.scopeKind==='self'?s.contactId!==null:typeof s.contactId!=='string'))return fail('memory_scope_invalid');
 return {scopeKind:s.scopeKind,contactId:s.contactId===null?null:id(s.contactId)};
}
export function available(tx:StorageTransaction,ownerId:string,s:MemoryScope,write=false):void{
 if(!tx.get("SELECT 1 FROM owner WHERE owner_id=? AND state='active'",[ownerId])||(s.scopeKind==='contact'&&!tx.get("SELECT 1 FROM contact WHERE owner_id=? AND id=? AND state='active'",[ownerId,s.contactId])))fail('memory_scope_stale');
 if(write&&tx.get("SELECT 1 FROM deletion_operation WHERE owner_identity=? AND state<>'completed'",[ownerId]))fail('memory_source_stale');
}
export function citations(tx:StorageTransaction,ownerId:string,parent:{candidateId?:string;memoryId?:string;versionNo?:bigint}):StorageRow[]{
 const rows=tx.all(`SELECT c.*,m.text_body FROM memory_citation c JOIN message m ON m.owner_id=c.owner_id AND m.contact_id=c.source_contact_id AND m.id=c.message_id WHERE c.owner_id=? AND ${parent.candidateId?'c.candidate_id=?':'c.memory_id=? AND c.version_no=?'} ORDER BY c.source_contact_id,c.message_id,c.record_id`,parent.candidateId?[ownerId,parent.candidateId]:[ownerId,parent.memoryId!,parent.versionNo!]);
 return projectCitations(tx,ownerId,parent,rows);
}
export function requireSources(tx:StorageTransaction,ownerId:string,parent:{candidateId?:string;memoryId?:string;versionNo?:bigint},manual=false):StorageRow[]{
 const rows=citations(tx,ownerId,parent);
 const required=tx.all(`SELECT source_contact_id,message_id FROM memory_required_message WHERE owner_id=? AND ${parent.candidateId?'candidate_id=?':'memory_id=? AND version_no=?'}`,parent.candidateId?[ownerId,parent.candidateId]:[ownerId,parent.memoryId!,parent.versionNo!]);
 if(!manual&&(!rows.length||!required.length))fail('memory_source_stale');
 const uncited=required.filter(r=>!rows.some(c=>c.source_contact_id===r.source_contact_id&&c.message_id===r.message_id));
 if(uncited.length){
  const dependencies=qualificationSources(tx,ownerId,parent);
  if(uncited.some(r=>!dependencies.some(d=>d.contactId===r.source_contact_id&&d.messageId===r.message_id)))fail('memory_source_stale');
 }
 for(const r of rows){
  assertSourceEligibility(tx,{owner_id:ownerId,contact_id:String(r.source_contact_id),message_id:String(r.message_id),record_id:String(r.record_id)});
  const m=tx.get('SELECT interpretation_revision,text_body FROM message WHERE owner_id=? AND contact_id=? AND id=?',[ownerId,r.source_contact_id,r.message_id]);
  if(!m||m.interpretation_revision!==r.accepted_revision)fail('memory_source_stale');
  if(r.content_kind==='image')requireImageCitation(tx,ownerId,String(r.source_contact_id),String(r.message_id),r.content_ref_json);
  else if(r.content_kind&&r.content_kind!=='text'||typeof m!.text_body!=='string'||typeof r.span_start!=='bigint'||typeof r.span_end!=='bigint'||BigInt([...m!.text_body].length)<r.span_end)fail('memory_source_stale');
 }
 return rows;
}
export function requireCandidate(tx:StorageTransaction,ownerId:string,c:StorageRow){
 if(c.state!=='pending'||typeof c.event_id!=='string')fail('memory_candidate_stale');
 const output=verifiedExtractionOutput(tx,{ownerId,eventId:String(c.event_id)});
 if(output.proposedBody!==c.proposed_body||output.producedAttemptId!==c.produced_attempt_id||output.scopeKind!==c.scope_kind||output.contactId!==c.contact_id||output.outputNo!==c.output_no)fail('memory_candidate_stale');
 const actual=requireSources(tx,ownerId,{candidateId:String(c.id)});
 if(output.semanticVerification.state==='verified'&&(actual.length!==output.citations.length||output.citations.some(expected=>!actual.some(row=>row.source_contact_id===expected.contactId&&row.message_id===expected.messageId&&row.record_id===expected.recordId&&row.accepted_revision===expected.interpretationRevision&&row.span_start===expected.spanStart&&row.span_end===expected.spanEnd
  &&(row.content_kind??'text')===(expected.contentKind??'text')&&(expected.contentRef?JSON.stringify(JSON.parse(String(row.content_ref_json)))===JSON.stringify(expected.contentRef):true)))))fail('memory_candidate_stale');
 return output.semanticVerification;
}
export function requireAutomaticCandidate(tx:StorageTransaction,ownerId:string,c:StorageRow):void{
 if(requireCandidate(tx,ownerId,c).state!=='verified')fail('memory_verification_pending');
}
export function requireVersion(tx:StorageTransaction,ownerId:string,m:StorageRow,v:StorageRow):StorageRow[]{
 available(tx,ownerId,{scopeKind:m.scope_kind as 'self'|'contact',contactId:m.contact_id as string|null});
 if(v.content_state!=='present'||v.provenance_state!=='eligible'||typeof v.body!=='string')fail('memory_source_stale');
 return requireSources(tx,ownerId,{memoryId:String(m.id),versionNo:v.version_no as bigint},v.adoption_mode==='manual');
}
