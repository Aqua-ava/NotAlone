/** 原legacy-v4核验的version1依据：摘要绑定真实候选和完整窗口，不把来源核验当采纳门槛。 */
import {canonicalJSON,digest,parseStoredJSON,sha} from './contact-overview-evidence.ts';
import {instantMicros,uuid,when,validateExtractionWindow,type ExtractedFact,type ExtractionWindow,type ExtractionMessage,type SourceVerificationResult,type MemoryEvent} from './extraction-protocol.ts';
import {boundedMessages,normalizeBoundedWindow,validateBoundedBodySources} from './extraction-bounded.ts';
import {verifyBoundedProof} from './extraction-bounded-proof.ts';
import {assertCompleteClaimAdmission} from './complete-claim-verification.ts';
export interface EvidenceMessage {
 message_id:string;text_sha256:string;text_length:number;sender:string;message_type:string;text_representation:string;
 source_state_sha256:string|null;occurred_at:string|null;source_refs:{ref_id:string;source_id:string}[];
}
export interface EvidenceSpan {start:number;end:number;sha256:string;}
export interface LegacyDimensionEvidence {
 version:1;scope:{owner_id:string;contact_id:string};candidate_sha256:string;window_sha256:string;
 pragmatics:{speech_act:string;assertion_status:string;figurative_type:string};messages:EvidenceMessage[];
 paraphrase:{candidate:EvidenceSpan;source:{message_id:string;span:EvidenceSpan}}[]|null;
 reference:null;media:{message_id:string;message_type:string;representation:string}[]|null;reported:null;
 readonly source_bound:boolean;
}
export interface BoundedDimensionEvidence {
 version:4;scope:{owner_id:string;contact_id:string};candidate_sha256:string;window_sha256:string;
 pragmatics:{speech_act:string;assertion_status:string;figurative_type:string};messages:EvidenceMessage[];
 paraphrase:{candidate:EvidenceSpan;source:{message_id:string;span:EvidenceSpan}}[]|null;
 reference:null;media:{message_id:string;message_type:string;representation:string}[]|null;reported:null;
 semantic_basis:Record<string,unknown>|null;target_message_ids:string[];
 readonly source_bound:boolean;
}
export type ExtractionDimensionEvidence=LegacyDimensionEvidence|BoundedDimensionEvidence;
export type VerifiedSourceReceipt=readonly [string,string,'any'|'all',boolean];
export type EvidenceFact=ExtractedFact&{dimension_evidence:ExtractionDimensionEvidence|null;verified_source_receipt:VerifiedSourceReceipt|null};
export class ExtractionEvidenceError extends Error {
 readonly code:string;constructor(code:string){super(code);this.code=code;}
}
const fail=(code:string):never=>{throw new ExtractionEvidenceError(code);};
/** Python datetime.astimezone(UTC).isoformat 保留六位微秒；不改原始来源time_iso。 */
export function evidenceTimestamp(value:string|null):string|null {
 if(value===null)return null;when(value);const micros=instantMicros(value),fraction=(micros%1000000n+1000000n)%1000000n;
 const seconds=(micros-fraction)/1000000n;
 return new Date(Number(seconds*1000n)).toISOString().slice(0,-5)+(fraction?'.'+String(fraction).padStart(6,'0'):'')+'+00:00';
}
function modelTimestamp(value:string|null):string|null {
 if(value===null)return null;when(value);
 const match=value.match(/^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d)(:\d\d)?(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/)!;
 const fraction=(match[4]??'').slice(0,6).padEnd(6,'0');
 return `${match[1]}T${match[2]}${match[3]??':00'}${Number(fraction)?'.'+fraction:''}${match[5]==='Z'?'+00:00':match[5]}`;
}
function eventPayload(event:MemoryEvent):Record<string,unknown>{
 return {version:event.version,stage:event.stage,stage_evidence:event.stage_evidence,stage_verified:event.stage_verified,
  occurrence_start:modelTimestamp(event.occurrence_start),occurrence_end:modelTimestamp(event.occurrence_end),
  occurrence_evidence:event.occurrence_evidence,occurrence_verified:event.occurrence_verified,
  ...(event.version===2?{occurrence_precision:event.occurrence_precision,occurrence_expression:event.occurrence_expression,anchor_message_id:event.anchor_message_id}:{} )};
}
function pythonFloat(value:number):unknown{
 if(!Number.isFinite(value))return fail('candidate_confidence_invalid');
 let token=Object.is(value,-0)?'-0.0':String(value);
 if(!/[.eE]/.test(token))token+='.0';
 return parseStoredJSON(`{"value":${token}}`).value;
}
export function candidateDigest(fact:ExtractedFact,version=1):string {
 if(version!==1&&version!==4)fail('candidate_digest_version_invalid');if(version===4&&fact.source_dependency_mode!=='all')fail('candidate_digest_requires_all');
 return digest({...(version===4?{source_dependency_mode:'all'}:{}),text:fact.text,category:fact.category,topic:fact.topic,subject:fact.subject,
  source_ids:fact.source_message_ids.map(uuid).sort(),valid_at:evidenceTimestamp(fact.valid_at),invalid_at:evidenceTimestamp(fact.invalid_at),
  confidence:pythonFloat(fact.confidence),risk_flags:fact.risk_flags,alternatives:fact.alternatives,interpretation_reason:fact.interpretation_reason,
  ...(fact.event?{event:eventPayload(fact.event)}:{}),...(fact.conditions?{conditions:fact.conditions}:{})});
}
export function sourceStateDigest(snapshots:readonly Record<string,unknown>[]):string|null {
 const names=['source_ref_id','source_id','source_kind','locator','raw_payload','source_content_sha256'];
 const rows:Record<string,unknown>[]=[];
 for(const item of snapshots){
  if(!names.every(name=>Object.hasOwn(item,name))||!['source_document','local_wechat_observation'].includes(item.source_kind as string)
   ||typeof item.locator!=='string'||!item.locator.trim()||!item.raw_payload||typeof item.raw_payload!=='object'||Array.isArray(item.raw_payload)
   ||item.source_kind==='source_document'&&(typeof item.source_content_sha256!=='string'||!/^[0-9a-f]{64}$/.test(item.source_content_sha256)))return null;
  rows.push(Object.fromEntries(names.map(name=>[name,item[name]])));
 }
 if(!rows.length)return null;
 try{return digest(rows.sort((a,b)=>String(a.source_ref_id)<String(b.source_ref_id)?-1:String(a.source_ref_id)>String(b.source_ref_id)?1:0));}catch{return null;}
}
function messageType(message:ExtractionMessage):string {
 const value=(message as ExtractionMessage&{message_type?:string}).message_type??message.message_snapshot?.message_type??'unknown';
 if(typeof value!=='string'||!value.trim())return fail('evidence_message_type_invalid');return value;
}
function metadata(window:ExtractionWindow):EvidenceMessage[]{
 return window.messages.map(m=>{
  let refs:{ref_id:string;source_id:string}[]=[];
  try{const unique=new Map<string,{ref_id:string;source_id:string}>();for(const snapshot of m.source_snapshots??[]){
   const ref_id=uuid(snapshot.source_ref_id),source_id=uuid(snapshot.source_id);unique.set(`${ref_id}:${source_id}`,{ref_id,source_id});
  }refs=[...unique.values()].sort((a,b)=>a.ref_id.localeCompare(b.ref_id));}catch{refs=[];}
  if(new Set(refs.map(r=>r.ref_id)).size!==refs.length)return fail('evidence_source_refs_duplicate');
  const representation=m.text_representation??'unknown';if(!['text','processed_text','placeholder','unknown'].includes(representation))return fail('evidence_representation_invalid');
  return {message_id:uuid(m.message_id),text_sha256:sha(m.text),text_length:[...m.text].length,sender:m.sender,
   message_type:messageType(m),text_representation:representation,source_state_sha256:sourceStateDigest(m.source_snapshots??[]),occurred_at:evidenceTimestamp(m.occurred_at),source_refs:refs};
 });
}
export function dimensionEvidencePayload(evidence:ExtractionDimensionEvidence):Record<string,unknown>{
 const {version,scope,candidate_sha256,window_sha256,pragmatics,messages,paraphrase,reference,media,reported,source_bound,...rest}=evidence;
 return {version,scope,candidate_sha256,window_sha256,pragmatics,messages,paraphrase,reference,media,reported,...rest};
}
function runtime<T extends ExtractionDimensionEvidence>(payload:Omit<T,'source_bound'>,bound:boolean):T {
 const result={...payload} as T;Object.defineProperty(result,'source_bound',{value:bound,enumerable:false});
 const freeze=(value:unknown):void=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}};
 freeze(result);return result;
}
/** JSON往返只恢复未绑定依据；每次绑定必须重算实际正文、来源和完整context窗口。 */
export function bindDimensionEvidence(evidence:LegacyDimensionEvidence,window:ExtractionWindow,fact:ExtractedFact):LegacyDimensionEvidence {
 const unbound=()=>runtime<LegacyDimensionEvidence>(dimensionEvidencePayload(evidence) as Omit<LegacyDimensionEvidence,'source_bound'>,false);
 if(evidence.version!==1||fact.source_dependency_mode==='all')return unbound();
 const messages=metadata(window),pragmatics={speech_act:fact.speech_act,assertion_status:fact.assertion_status,figurative_type:fact.figurative_type};
 if(canonicalJSON(evidence.scope)!==canonicalJSON({owner_id:uuid(window.owner_id),contact_id:uuid(window.contact_id)})
  ||evidence.candidate_sha256!==candidateDigest(fact)||canonicalJSON(evidence.pragmatics)!==canonicalJSON(pragmatics)
  ||canonicalJSON(evidence.messages)!==canonicalJSON(messages)
  ||evidence.window_sha256!==digest({owner_id:uuid(window.owner_id),contact_id:uuid(window.contact_id),messages})
  ||new Set(window.messages.map(m=>uuid(m.message_id))).size!==window.messages.length
  ||messages.some(m=>!m.source_refs.length||m.source_state_sha256===null))return unbound();
 const texts=new Map(window.messages.map(m=>[uuid(m.message_id),[...m.text]]));
 for(const alignment of evidence.paraphrase??[]){
  const source=texts.get(alignment.source.message_id),span=alignment.source.span,candidate=alignment.candidate;
  if(!source||!Number.isSafeInteger(span.start)||!Number.isSafeInteger(span.end)||span.start<0||span.start>=span.end||span.end>source.length||sha(source.slice(span.start,span.end).join(''))!==span.sha256
   ||!Number.isSafeInteger(candidate.start)||!Number.isSafeInteger(candidate.end)||candidate.start<0||candidate.start>=candidate.end||candidate.end>[...fact.text].length||sha([...fact.text].slice(candidate.start,candidate.end).join(''))!==candidate.sha256)return unbound();
 }
 return runtime<LegacyDimensionEvidence>(dimensionEvidencePayload(evidence) as Omit<LegacyDimensionEvidence,'source_bound'>,true);
}
export function buildDimensionEvidence(window:ExtractionWindow,fact:ExtractedFact,verification:SourceVerificationResult|null=null,options:{verificationMode?:'legacy-v4'|'complete-claim-v1'}={}):LegacyDimensionEvidence {
 validateExtractionWindow(window);
 const mode=options.verificationMode??verification?.verification_mode??'legacy-v4';
 if(!['legacy-v4','complete-claim-v1'].includes(mode)||verification&&verification.verification_mode!==mode)return fail('evidence_mode_unsupported');
 if(mode==='complete-claim-v1'){
  if(!verification||verification.verdict!=='supported'||verification.claim_validation?.status!=='checked'
   ||verification.claim_validation.semantic_support!=='supported')return fail('evidence_claim_unverified');
  assertCompleteClaimAdmission(window,fact,verification);
 }
 if(fact.source_dependency_mode==='all')return fail('legacy_evidence_cannot_bind_all');
 const messages=metadata(window),alignments:NonNullable<LegacyDimensionEvidence['paraphrase']>=[];
 if(verification?.verdict==='supported')for(const quote of verification.evidence){
  const source=window.messages.find(m=>uuid(m.message_id)===uuid(quote.message_id));if(!source)return fail('evidence_quote_message_missing');
  if(quote.quote!==source.text||fact.text!==source.text)continue;
  const span={start:0,end:[...fact.text].length,sha256:sha(fact.text)};alignments.push({candidate:span,source:{message_id:uuid(source.message_id),span:{...span}}});
 }
 const evidence=runtime<LegacyDimensionEvidence>({version:1,scope:{owner_id:uuid(window.owner_id),contact_id:uuid(window.contact_id)},candidate_sha256:candidateDigest(fact),
  window_sha256:digest({owner_id:uuid(window.owner_id),contact_id:uuid(window.contact_id),messages}),messages,
  pragmatics:{speech_act:fact.speech_act,assertion_status:fact.assertion_status,figurative_type:fact.figurative_type},paraphrase:alignments.length?alignments:null,
  reference:null,media:window.messages.filter(m=>fact.source_message_ids.map(uuid).includes(uuid(m.message_id))).map(m=>({message_id:uuid(m.message_id),message_type:messageType(m),representation:m.text_representation??'unknown'})),reported:null},false);
 return bindDimensionEvidence(evidence,window,fact);
}
function boundedMetadata(window:ExtractionWindow):EvidenceMessage[]{
 const current=new Map(boundedMessages(window).map(message=>[message.message_id,message.occurred_at])),rows=metadata(window);
 return rows.map(row=>({...row,occurred_at:current.get(row.message_id)??row.occurred_at}));
}
export function buildBoundedDimensionEvidence(window:ExtractionWindow,fact:ExtractedFact,verification:SourceVerificationResult|null=null):BoundedDimensionEvidence|null{
 validateExtractionWindow(window);if(fact.source_dependency_mode!=='all')fail('bounded_evidence_requires_all');
 validateBoundedBodySources(window,fact);
 if(window.messages.length>4||[...fact.text].length>4096||window.messages.some(message=>[...message.text].length>4096))return null;
 const proof=verification?.proof_verification??verifyBoundedProof(verification?.proof??null,window,fact,
  new Map(window.messages.map(message=>[uuid(message.message_id),message.text])));
 const messages=boundedMetadata(window),targets=(window.target_message_ids??[]).map(uuid)
  .filter(id=>window.messages.some(message=>uuid(message.message_id)===id));
 const semantic_basis=proof.status==='verified'?proof.semantic_basis:null;
 const payload:Omit<BoundedDimensionEvidence,'source_bound'>=({version:4,scope:{owner_id:uuid(window.owner_id),contact_id:uuid(window.contact_id)},candidate_sha256:candidateDigest(fact,4),
  window_sha256:digest({version:4,scope:{owner_id:uuid(window.owner_id),contact_id:uuid(window.contact_id)},messages,target_message_ids:targets}),
  pragmatics:{speech_act:fact.speech_act,assertion_status:fact.assertion_status,figurative_type:fact.figurative_type},messages,
  paraphrase:null,reference:null,media:window.messages.filter(message=>fact.source_message_ids.includes(uuid(message.message_id))).map(message=>({
   message_id:uuid(message.message_id),message_type:messageType(message),representation:message.text_representation??'unknown'})),reported:null,
  semantic_basis,target_message_ids:targets});
 return runtime<BoundedDimensionEvidence>(payload,true);
}
/** 保留原Flow同次回执合同；风险与采纳算法由后续职责判断，不代签supported。 */
export function attachVerifiedSourceReceipt(window:ExtractionWindow,fact:ExtractedFact,verification:SourceVerificationResult|null):EvidenceFact {
 const changed={...fact,event:verification?verification.event:fact.event,conditions:verification?verification.conditions:fact.conditions};
 if(changed.source_dependency_mode==='all')return {...changed,dimension_evidence:buildBoundedDimensionEvidence(normalizeBoundedWindow(window),changed,verification),verified_source_receipt:null};
 const evidence=buildDimensionEvidence(window,changed,verification);
 return {...changed,dimension_evidence:evidence,verified_source_receipt:verification?.verdict==='supported'&&evidence.source_bound?
  [evidence.candidate_sha256,evidence.window_sha256,changed.source_dependency_mode,changed.requires_all_sources]:null};
}
