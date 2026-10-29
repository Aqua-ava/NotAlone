import {assertSourceEligibility} from '../../history/sqlite/source.ts';
import {candidateAdmission,quoteSpan} from './management/admission.ts';
import type {StorageRow,StorageTransaction} from '../../storage/sqlite/contracts.ts';
import type {VerifiedExtractionOutputReference} from './contracts.ts';
import {assertInputs,assertTaskContributions,fail,textId} from './qualification.ts';
interface OutputCitation {contactId:string;recordId:string;messageId:string;interpretationRevision:bigint;spanStart:bigint;spanEnd:bigint;explanation:string|null}
/** 08须在创建正式候选的同一短事务调用；阶段产物不授予自动采纳资格。 */
function extractionOutput(tx:StorageTransaction,ref:VerifiedExtractionOutputReference,published=false){
 const ownerId=textId(ref.ownerId),eventId=textId(ref.eventId);
 const e=tx.get(`SELECT e.*,t.id AS task_id,t.run_id,t.scope_kind,t.contact_id FROM execution_event e
 JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id
 JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id
 JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
 WHERE e.owner_id=? AND e.id=? AND e.kind='verified_output' AND a.state='succeeded'
 AND s.state='succeeded' AND s.successful_attempt_id=a.id AND (? OR t.state IN ('succeeded','awaiting_decision'))`,[ownerId,eventId,published?1:0]);
 if(!e)return fail('memory_extraction_output_not_eligible');
 if(!published)assertTaskContributions(tx,ownerId,String(e.run_id),String(e.task_id));
 const payload=JSON.parse(String(e.payload));
 if(payload.scopeKind!==e.scope_kind||payload.contactId!==e.contact_id||payload.origin!=='auto'||typeof payload.fact?.text!=='string'||!payload.fact.text.trim())fail('memory_extraction_output_not_eligible');
 const inputs=tx.all(`SELECT i.* FROM execution_input x JOIN step_input si ON si.owner_id=x.owner_id AND si.step_id=x.planned_step_id AND si.input_no=x.planned_input_no JOIN run_input i ON i.owner_id=si.owner_id AND i.run_id=si.run_id AND i.input_no=si.run_input_no WHERE x.owner_id=? AND x.event_id=? ORDER BY x.presentation_no`,[ownerId,eventId]);
 if(!inputs.length)fail('memory_extraction_output_not_eligible');
 if(!published)assertInputs(tx,ownerId,String(e.run_id),inputs);
 else for(const input of inputs){assertSourceEligibility(tx,{owner_id:ownerId,contact_id:String(input.source_contact_id),record_id:String(input.record_id),message_id:String(input.message_id)});if(!tx.get("SELECT 1 FROM message WHERE owner_id=? AND contact_id=? AND id=? AND interpretation_revision=? AND availability='available'",[ownerId,input.source_contact_id,input.message_id,input.accepted_interpretation_revision]))fail('memory_extraction_source_stale');}
 const sources=tx.all('SELECT source_contact_id,record_id FROM event_source WHERE owner_id=? AND event_id=?',[ownerId,eventId]);
 const expected=new Set(inputs.map(i=>JSON.stringify([i.source_contact_id,i.record_id])));
 if(sources.length!==expected.size||sources.some(s=>!expected.has(JSON.stringify([s.source_contact_id,s.record_id]))))fail('memory_extraction_output_not_eligible');
 let semanticVerification=candidateAdmission(tx,ownerId,e,payload.fact,inputs,published);
 const frozen:StorageRow[]=inputs.map(i=>({...i,text_body:tx.get('SELECT text_body FROM message WHERE owner_id=? AND contact_id=? AND id=?',[ownerId,i.source_contact_id,i.message_id])?.text_body??null}));
 const verifiedCitations:OutputCitation[]=semanticVerification.evidence.flatMap(reference=>frozen.filter(i=>i.message_id===reference.messageId).flatMap(i=>{
  const span=typeof i.text_body==='string'?quoteSpan(i.text_body,reference.quote):null;
  return span?[{contactId:String(i.source_contact_id),recordId:String(i.record_id),messageId:String(i.message_id),interpretationRevision:i.accepted_interpretation_revision as bigint,spanStart:span.start,spanEnd:span.end,explanation:null}]:[];
 }));
 if(semanticVerification.state==='verified'&&semanticVerification.evidence.some(reference=>!verifiedCitations.some(c=>c.messageId===reference.messageId)))semanticVerification={state:'pending',eventId:null,mode:null,evidence:[]};
 const citations:OutputCitation[]=semanticVerification.state==='verified'?verifiedCitations:frozen.filter(i=>payload.fact.source_message_ids?.includes(i.message_id)&&typeof i.text_body==='string').map(i=>({contactId:String(i.source_contact_id),recordId:String(i.record_id),messageId:String(i.message_id),interpretationRevision:i.accepted_interpretation_revision as bigint,spanStart:0n,spanEnd:BigInt([...String(i.text_body)].length),explanation:'待核验的原始来源消息'}));
 return {semanticVerification,citations,eventId,ownerId,scopeKind:e.scope_kind as 'self'|'contact',contactId:e.contact_id===null?null:String(e.contact_id),producedAttemptId:String(e.step_attempt_id),outputNo:e.event_no as bigint,proposedBody:payload.fact.text as string,fact:payload.fact,origin:'auto' as const,
  sources:inputs.map(i=>({contactId:String(i.source_contact_id),recordId:String(i.record_id),messageId:String(i.message_id),interpretationRevision:i.accepted_interpretation_revision as bigint}))};
}

/** 未决产物仍复验原处理授权；已发布版本只重验存档核验链与当前保存来源。 */
export const verifiedExtractionOutput=(tx:StorageTransaction,ref:VerifiedExtractionOutputReference)=>extractionOutput(tx,ref);
export const archivedExtractionOutput=(tx:StorageTransaction,ref:VerifiedExtractionOutputReference)=>extractionOutput(tx,ref,true);
