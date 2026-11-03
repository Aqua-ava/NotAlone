import type {StorageRow,StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {canonicalJSON} from '../../evidence/canonical-json.ts';
import {replayCompleteClaimVerification} from '../../extraction/verification/complete-claim.ts';
import {replayMultimodalVerification} from '../../extraction/multimodal.ts';
import type {ImageCitationReference} from '../content-citation.ts';
import {readFrozenContent} from '../content.ts';

export interface CandidateVerificationReference {eventId:string;candidateTraceId:string;policyFingerprint:string;callId:string;inputEventId:string;}
export interface AdmissionEvidence {messageId:string;quote:string|null;contentKind?:'image';contentRef?:ImageCitationReference;description?:string}
const same=(a:unknown,b:unknown)=>canonicalJSON(a)===canonicalJSON(b);
const payload=(row:StorageRow)=>JSON.parse(String(row.payload));
/** 新产物的逐事实引用必须沿具名事件和真实模型回执闭合；旧产物不推测补证。 */
export function candidateAdmission(tx:StorageTransaction,ownerId:string,output:StorageRow,fact:Record<string,any>,inputs:StorageRow[],published=false):{state:'pending'|'verified';eventId:string|null;mode:'complete-claim-v1'|'multimodal-claim-v1'|null;evidence:AdmissionEvidence[]}{
 const pending=()=>({state:'pending' as const,eventId:null,mode:null,evidence:[] as AdmissionEvidence[]});
 try{
  let producer=output;
  if(output.scope_kind==='self'){
   const producers=tx.all(`SELECT e.*,s.id AS step_id,t.run_id FROM execution_input x JOIN execution_event e ON e.owner_id=x.owner_id AND e.id=x.producer_event_id
    JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id
    JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE x.owner_id=? AND x.event_id=? AND x.role='verified_contribution'
    AND e.kind='verified_self_contribution' AND a.state='succeeded' AND s.state='succeeded' AND s.successful_attempt_id=a.id AND (? OR t.state='succeeded')`,[ownerId,output.id,published?1:0]);
   if(producers.length!==1||producers[0]!.run_id!==output.run_id||producers[0]!.payload!==output.payload)return pending();
   producer=producers[0]!;
  }
  const ref=payload(producer).verification as CandidateVerificationReference|undefined;
  if(!ref||!ref.eventId||!ref.candidateTraceId||!ref.callId||!ref.inputEventId||!ref.policyFingerprint)return pending();
  const event=tx.get(`SELECT e.*,a.step_id FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id
   WHERE e.owner_id=? AND e.id=? AND e.step_attempt_id=? AND e.kind='verification' AND e.event_no<?`,[ownerId,ref.eventId,producer.step_attempt_id,producer.event_no]);
  if(!event||(event.originated_call_id??event.reused_call_id)!==ref.callId)return pending();
  const checked=payload(event),result=checked.result;
  if(checked.candidateTraceId!==ref.candidateTraceId||checked.verificationInputEventId!==ref.inputEventId||checked.disposition!=='continue'
   ||!['complete-claim-v1','multimodal-claim-v1'].includes(result?.verification_mode)||result.verdict!=='supported'||result.claim_validation?.status!=='checked'
   ||result.claim_validation.semantic_support!=='supported'||result.claim_validation.policy_fingerprint!==ref.policyFingerprint)return pending();
  if(!same({...checked.before,event:result.event,conditions:result.conditions},fact))return pending();
  const inputEvent=tx.get("SELECT * FROM execution_event WHERE owner_id=? AND id=? AND step_attempt_id=? AND kind='verification_input' AND event_no<?",[ownerId,ref.inputEventId,producer.step_attempt_id,event.event_no]);
  if(!inputEvent)return pending();const prepared=payload(inputEvent),index=prepared.candidate_trace_ids?.indexOf(ref.candidateTraceId);
  if(!Number.isSafeInteger(index)||index<0||prepared.candidate_trace_ids.lastIndexOf(ref.candidateTraceId)!==index||!same(prepared.facts?.[index],checked.before)||prepared.policy_fingerprint!==ref.policyFingerprint||result.candidate_index!==index)return pending();
  const call=tx.get(`SELECT c.* FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id
   WHERE c.owner_id=? AND c.id=? AND c.state='succeeded' AND o.purpose='verification' AND o.memory_step_id=?`,[ownerId,ref.callId,event.step_id]);
  if(!call)return pending();
  const requestEvent=tx.get("SELECT payload FROM execution_event WHERE owner_id=? AND originated_call_id=? AND kind='model_input'",[ownerId,ref.callId]);
  const responseEvent=tx.get("SELECT payload FROM execution_event WHERE owner_id=? AND originated_call_id=? AND kind='model_output'",[ownerId,ref.callId]);
  if(!requestEvent||!responseEvent)return pending();const request=payload(requestEvent),requestBody=JSON.parse(request.user);
  if(request.purpose!=='verification'||requestBody.request_fingerprint!==ref.policyFingerprint)return pending();
  const multimodal=result.verification_mode==='multimodal-claim-v1';
  const replay=(multimodal?replayMultimodalVerification:replayCompleteClaimVerification)(prepared.window,prepared.facts,payload(responseEvent).blocks,ref.policyFingerprint,requestBody)[index];
  if(!replay?.admitted||!same(replay.result,result))return pending();
  if(multimodal){
   if(!Array.isArray(result.content_evidence)||!result.content_evidence.length)return pending();
   const evidence:AdmissionEvidence[]=result.content_evidence.map((item:any)=>{
    if(!inputs.some(input=>input.message_id===item.message_id)||!fact.source_message_ids.includes(item.message_id))throw new Error('memory_content_evidence_scope');
    if(item.kind==='text')return {messageId:item.message_id,quote:item.quote};
    const image=prepared.window.messages.find((message:any)=>message.message_id===item.message_id)?.image;
    if(!image||image.file_id!==item.file_id||image.sha256!==item.sha256)throw new Error('memory_content_evidence_version');
    const frozen=inputs.filter(input=>input.message_id===item.message_id).map(input=>readFrozenContent(tx,ownerId,input));
    if(!frozen.length||frozen.some(content=>!content||content.kind!=='image'||content.identity.fileId!==image.file_id||content.identity.sha256!==image.sha256
     ||content.identity.mimeType!==image.mime_type||content.identity.mediaGeneration!==image.media_generation))throw new Error('memory_content_evidence_unbound');
    return {messageId:item.message_id,quote:null,contentKind:'image',contentRef:{file_id:image.file_id,sha256:image.sha256,mime_type:image.mime_type,media_generation:image.media_generation},description:item.description};
   });
   if(fact.source_message_ids.some((id:string)=>!evidence.some(item=>item.messageId===id)))return pending();
   return {state:'verified' as const,eventId:ref.eventId,mode:'multimodal-claim-v1' as const,evidence};
  }
  if(!Array.isArray(result.evidence)||!result.evidence.length||!Array.isArray(fact.source_message_ids)||!fact.source_message_ids.length)return pending();
  const evidence=result.evidence as {message_id:string;quote:string}[];
  if(evidence.some(e=>!fact.source_message_ids.includes(e.message_id)||!inputs.some(i=>i.message_id===e.message_id)||typeof e.quote!=='string'||!e.quote.length)
   ||(fact.requires_all_sources||fact.source_dependency_mode==='all')&&fact.source_message_ids.some((id:string)=>!evidence.some(e=>e.message_id===id)))return pending();
  return {state:'verified' as const,eventId:ref.eventId,mode:'complete-claim-v1' as const,evidence:evidence.map(e=>({messageId:e.message_id,quote:e.quote}))};
 }catch{return pending();}
}
/** 引句按 Unicode 代码点定位；重复引句不能猜测其原文位置。 */
export function quoteSpan(text:string,quote:string):{start:bigint;end:bigint}|null{
 const body=[...text],needle=[...quote],starts:number[]=[];
 if(!needle.length)return null;
 for(let n=0;n<=body.length-needle.length;n++)if(needle.every((c,i)=>body[n+i]===c))starts.push(n);
 return starts.length===1?{start:BigInt(starts[0]!),end:BigInt(starts[0]!+needle.length)}:null;
}
