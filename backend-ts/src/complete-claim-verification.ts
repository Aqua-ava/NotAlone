/** 准备一次来源核验；请求、指纹、幂等解码和准入封装在同一 Interface。 */
import {digest} from './contact-overview-evidence.ts';
import {readExtractionToolArguments} from './extraction-arguments.ts';
import {verificationFailureDiagnostic} from './extraction-verification-diagnostics.ts';
import {buildSourceVerificationContract,buildSourceVerificationPayload} from './extraction-protocol-contract.ts';
import {
  ExtractionProtocolError,parseSourceVerification,validateExtractionWindow,
  type ExtractionWindow,type ExtractedFact,type SourceVerificationResult,
} from './extraction-protocol.ts';
import type {ExtractionInvocation} from './extraction-flow.ts';

type Support='supported'|'uncertain'|'unsupported';
export type VerificationPolicyId='legacy-v4'|'nullable-proof-v3'|'complete-claim-v1';
export interface PreparedVerificationPolicy {id:VerificationPolicyId;rule_version?:string;}
export interface VerificationAdmission {candidate_index:number;admitted:boolean;result:SourceVerificationResult|null;}
export interface PreparedVerification {
 readonly fingerprint:string;
 readonly request:ExtractionInvocation|null;
 readonly selection:readonly number[];
 decode(blocks:readonly unknown[]):Promise<{items:VerificationAdmission[]}>;
}
type Row=Record<string,any>;
const admittedResults=new WeakMap<object,{window:string;fact:string;result:string}>();
function factBinding(fact:ExtractedFact):unknown {
 return {text:fact.text,category:fact.category,subject:fact.subject,topic:fact.topic,source_message_ids:fact.source_message_ids,
  valid_at:fact.valid_at,invalid_at:fact.invalid_at,speech_act:fact.speech_act,assertion_status:fact.assertion_status,
  figurative_type:fact.figurative_type,event:fact.event,conditions:fact.conditions,confidence:fact.confidence,
  risk_flags:fact.risk_flags,alternatives:fact.alternatives,interpretation_reason:fact.interpretation_reason,
  requires_all_sources:fact.requires_all_sources,source_dependency_mode:fact.source_dependency_mode,timing:fact.timing};
}
/** 来源 receipt 的内部消费者使用；序列化的模型字段本身不授予新策略准入资格。 */
export function assertCompleteClaimAdmission(window:ExtractionWindow,fact:ExtractedFact,result:SourceVerificationResult):void {
 const bound=admittedResults.get(result);
 if(!bound||bound.window!==digest(window)||bound.fact!==digest(factBinding(fact))||bound.result!==digest(result))fail('unbound_admission');
}
const supports=['supported','uncertain','unsupported'] as const;
const repairFields=['results','candidate_index','verdict','issues','evidence','proof','event_verification','condition_verification',
 'stage_evidence','occurrence_evidence','message_id','quote','request_fingerprint','claim_check','version','parts','candidate_span',
 'start','end','attribution','arguments_and_relation','temporal_and_modality','evidence_indices','scope_subject','actor_kind','resolution'];
const verdict={type:'string',enum:supports};
const references={type:'array',maxItems:60,items:{type:'integer',minimum:0}};
const facet={type:'object',additionalProperties:false,properties:{verdict,evidence_indices:references},required:['verdict','evidence_indices']};
const claimSchema={type:'object',additionalProperties:false,properties:{
 version:{type:'integer',enum:[1]},parts:{type:'array',minItems:1,maxItems:4,items:{type:'object',additionalProperties:false,
  properties:{candidate_span:{type:'object',additionalProperties:false,properties:{start:{type:'integer',minimum:0},end:{type:'integer',minimum:1}},required:['start','end']},
   attribution:{type:'object',additionalProperties:false,properties:{...facet.properties,
    scope_subject:{type:'string',enum:['self','contact','unknown']},
    actor_kind:{type:'string',enum:['self','contact','shared','third_party','unknown']},
    resolution:{type:'string',enum:['explicit','unique_context','unresolved']}},
    required:[...facet.required,'scope_subject','actor_kind','resolution']},
   arguments_and_relation:facet,temporal_and_modality:facet},
  required:['candidate_span','attribution','arguments_and_relation','temporal_and_modality']}},
 },required:['version','parts']};
const claimInstructions=`\n逐条核验完整候选，不改写正文或字段。顶层request_fingerprint逐字回传输入同名值，每项results必须填写claim_check。
claim_check.parts按Unicode码点覆盖完整正文（包括空白与标点），默认一段覆盖全文，最多四段，连续、不重叠、不遗漏。
每段分别判断归属、对象与关系、时间与认知模态；evidence_indices只引用本项evidence的0起索引。每个supported facet必须有逐字依据。资料scope_subject只取self/contact；原shared共同事实仍属contact关系范围，actor_kind可为shared或third_party，不能把亲友或转述中的人物变成说话人本人。
听成、理解为、猜测与获悉确定消息不同；不能新增原文未明示的对象、信息确证事件或先后关系。event=null仍须核对正文时间与模态，不以消息时间证明得知或事件发生。来源明确表达尚未确定时，忠实保留该未知可supported。
归属无法唯一消解用unresolved/uncertain，不根据单个代词猜主体。引文存在与结构完整都不证明含义成立；任何facet未定或无支持不能由顶层supported覆盖。所有结论仅表示来源支持，不认证现实世界真值。`;

function fail(reason:string):never{throw new ExtractionProtocolError(`complete_claim_${reason}`);}
function object(value:unknown,keys:readonly string[]):Row{
 if(!value||typeof value!=='object'||Array.isArray(value))fail('structure_invalid');
 const row=value as Row;
 if(Object.keys(row).sort().join('|')!==[...keys].sort().join('|'))fail('structure_invalid');
 return row;
}
function checkFacet(value:unknown,evidenceCount:number,attribution=false):Row{
 const row=object(value,attribution?['verdict','evidence_indices','scope_subject','actor_kind','resolution']:['verdict','evidence_indices']);
 if(!supports.includes(row.verdict)||!Array.isArray(row.evidence_indices)||row.evidence_indices.length>60
  ||new Set(row.evidence_indices).size!==row.evidence_indices.length
  ||row.evidence_indices.some((index:unknown)=>!Number.isSafeInteger(index)||Number(index)<0||Number(index)>=evidenceCount)
  ||row.verdict==='supported'&&!row.evidence_indices.length)fail('facet_invalid');
 if(attribution&&(!['self','contact','unknown'].includes(row.scope_subject)
  ||!['self','contact','shared','third_party','unknown'].includes(row.actor_kind)
  ||!['explicit','unique_context','unresolved'].includes(row.resolution)))fail('attribution_invalid');
 return row;
}
function checkClaim(value:unknown,fact:ExtractedFact,evidenceCount:number):{verdict:Support;issues:string[]}{
 const root=object(value,['version','parts']);
 if(root.version!==1||!Array.isArray(root.parts)||!root.parts.length||root.parts.length>4)fail('parts_invalid');
 let cursor=0;const statuses:Support[]=[],issues=new Set<string>();
 for(const entry of root.parts){
  const part=object(entry,['candidate_span','attribution','arguments_and_relation','temporal_and_modality']);
  const span=object(part.candidate_span,['start','end']);
  if(!Number.isSafeInteger(span.start)||!Number.isSafeInteger(span.end)||span.start!==cursor||span.end<=span.start||span.end>[...fact.text].length)fail('coverage_invalid');
  cursor=span.end;
  const attribution=checkFacet(part.attribution,evidenceCount,true);
  const relation=checkFacet(part.arguments_and_relation,evidenceCount);
  const temporal=checkFacet(part.temporal_and_modality,evidenceCount);
  statuses.push(attribution.verdict,relation.verdict,temporal.verdict);
  if(attribution.verdict!=='supported')issues.add('subject');
  if(relation.verdict!=='supported')issues.add('meaning');
  if(temporal.verdict!=='supported'){issues.add('time');issues.add('pragmatics');}
  const expectedScope=fact.subject==='self'?'self':'contact';
  if(attribution.scope_subject!==expectedScope||attribution.actor_kind==='unknown'||attribution.resolution==='unresolved'){
   statuses.push('uncertain');issues.add('subject');
  }
 }
 if(cursor!==[...fact.text].length)fail('coverage_invalid');
 return {verdict:statuses.includes('unsupported')?'unsupported':statuses.includes('uncertain')?'uncertain':'supported',issues:[...issues]};
}

export function prepareSourceVerification(options:{
 window:ExtractionWindow;facts:readonly ExtractedFact[];policy?:PreparedVerificationPolicy;
 requireCurrent():Promise<void>;
 record?(event:{stage:string;payload:unknown}):Promise<void>;
}):PreparedVerification{
 // 来源原始 JSONB 的大整数/1.0 摘要必须在普通结构克隆丢失原型前冻结。
 const windowSha=digest(options.window),window=structuredClone(options.window),allFacts=structuredClone([...options.facts]);
 const policy:PreparedVerificationPolicy=structuredClone(options.policy??{id:'legacy-v4'});
 const modern=policy.id==='complete-claim-v1';
 const selection=allFacts.flatMap((fact,index)=>modern||fact.speech_act!=='question'&&!['joke','sarcasm','hyperbole'].includes(fact.figurative_type)?[index]:[]);
 const facts=selection.map(index=>allFacts[index]!);
 validateExtractionWindow(window);
 if(!['legacy-v4','nullable-proof-v3','complete-claim-v1'].includes(policy.id)||facts.length>60)fail('policy_invalid');
 if(modern&&!/^[a-f0-9]{64}$/.test(policy.rule_version??''))fail('policy_version_missing');
 const contract=buildSourceVerificationContract(facts,policy.id==='nullable-proof-v3'?'nullable-proof-v3':'legacy-v4',
  {require_complete_evidence:policy.id!=='nullable-proof-v3'});
 const schema=structuredClone(contract.schema),system=contract.prompt+(modern?claimInstructions:'');
 const payload=buildSourceVerificationPayload(window,facts);
 if(modern){
  schema.properties.results.items.properties.claim_check=claimSchema;
  schema.properties.results.items.required.push('claim_check');
  schema.properties.request_fingerprint={type:'string',pattern:'^[a-f0-9]{64}$'};
  schema.required.push('request_fingerprint');
  payload.claim_scope=facts.map((fact,candidate_index)=>({candidate_index,codepoint_length:[...fact.text].length,scope_subject:fact.subject==='self'?'self':'contact'}));
 }
 const fingerprint=digest({policy,window_sha256:windowSha,allFacts,selection,system,schema,payload});
 if(modern){schema.properties.request_fingerprint.enum=[fingerprint];payload.request_fingerprint=fingerprint;}
 const requestData={purpose:'verification' as const,system,user:JSON.stringify(payload),
  tool:{name:'SourceVerificationOutput',description:schema.description??'',parameters:schema}};
 let responseDigest:string|undefined,decoded:Promise<{items:VerificationAdmission[]}>|undefined,reportedInvalid=false;
 const decode=async(blocks:readonly unknown[]):Promise<{items:VerificationAdmission[]}>=>{
  await options.requireCurrent();
  if(!selection.length){if(blocks.length)fail('unexpected_response');return {items:allFacts.map((_,candidate_index)=>({candidate_index,admitted:true,result:null}))};}
  try{
  const raw=readExtractionToolArguments(blocks,'SourceVerificationOutput',{repair:true,field_names:repairFields,root_array_key:'results'}).value as Row;
  const currentDigest=digest(raw);
  if(responseDigest!==undefined&&responseDigest!==currentDigest)fail('response_changed');
  if(!decoded){
   responseDigest=currentDigest;
   decoded=Promise.resolve().then(()=>{
    if(modern&&raw.request_fingerprint!==fingerprint)fail('fingerprint_mismatch');
    if(modern)object(raw,['results','request_fingerprint']);
    const rows=Array.isArray(raw.results)?raw.results:fail('results_invalid');
    const baseRows=rows.map((entry:unknown)=>{
     if(!modern||!entry||typeof entry!=='object'||Array.isArray(entry))return entry;
     const {claim_check,...base}=entry as Row;return base;
    });
    const results=parseSourceVerification({results:baseRows},window,facts,
     {isolate_items:true,...(policy.id==='nullable-proof-v3'?{mode:'nullable-proof-v3' as const}:{})});
    const selected=results.map((original,index)=>{
     let result=original;
     const fact=facts[index]!;
     if(policy.id!=='nullable-proof-v3'&&result.verdict==='supported'&&fact.requires_all_sources){
      const cited=new Set(result.evidence.map(reference=>reference.message_id));
      if(fact.source_message_ids.some(source=>!cited.has(source)))result={...result,verdict:'unsupported',issues:[...new Set([...result.issues,'insufficient_evidence'])]};
     }
     if(!modern)return {candidate_index:index,admitted:result.verdict!=='unsupported',result};
     const matches=rows.filter((row:Row)=>row&&row.candidate_index===index),modelClaim=matches.length===1?matches[0].claim_check:null;
     let state:'checked'|'invalid'='checked',reason='complete',support:Support=result.verdict;
     try{
      const checked=checkClaim(modelClaim,fact,result.evidence.length);
      support=result.verdict==='unsupported'||checked.verdict==='unsupported'?'unsupported'
       :result.verdict==='uncertain'||checked.verdict==='uncertain'?'uncertain':'supported';
      result={...result,verdict:support,issues:[...new Set([...result.issues,...checked.issues])]};
     }catch(error){
      if(!(error instanceof ExtractionProtocolError))throw error;
      state='invalid';reason='structure_invalid';support='unsupported';
      result={...result,verdict:support,issues:[...new Set([...result.issues,'insufficient_evidence'])]};
     }
     result={...result,verification_mode:'complete-claim-v1',proof:null,proof_verification:null,model_claim_check:structuredClone(modelClaim),
      claim_validation:{status:state,policy_fingerprint:fingerprint,reason,semantic_support:support}};
     return {candidate_index:index,admitted:state==='checked'&&support==='supported',result};
    });
    const mapped=new Map(selection.map((index,local)=>[index,{...selected[local]!,candidate_index:index}]));
    return {items:allFacts.map((_,index)=>mapped.get(index)??{candidate_index:index,admitted:true,result:null})};
   });
  }
  const output=structuredClone(await decoded);
  if(modern)for(const item of output.items)if(item.admitted&&item.result){
   const fact=allFacts[item.candidate_index]!;
   admittedResults.set(item.result,{window:windowSha,fact:digest(factBinding({...fact,event:item.result.event,conditions:item.result.conditions})),result:digest(item.result)});
  }
  return output;
  }catch(error){
   if(!reportedInvalid){reportedInvalid=true;await options.record?.({stage:'verification_validation_failure',
    payload:verificationFailureDiagnostic(blocks,'SourceVerificationOutput',facts.length,error)});}
   throw error;
  }
 };
 return Object.freeze({fingerprint,get selection(){return [...selection];},get request(){return selection.length?{...structuredClone(requestData),validateOutput:async(blocks:readonly unknown[])=>{await decode(blocks);}}:null;},decode});
}
