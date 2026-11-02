/** 准备一次来源核验；请求、指纹、幂等解码和准入封装在同一 Interface。 */
import {digest} from '../../evidence/canonical-json.ts';
import {readExtractionToolArguments} from '../arguments.ts';
import {verificationFailureDiagnostic} from './diagnostics.ts';
import {buildSourceVerificationContract,buildSourceVerificationPayload} from '../contract.ts';
import {
  ExtractionProtocolError,parseSourceVerification,validateExtractionWindow,uuid,
  type ExtractionWindow,type ExtractedFact,type SourceVerificationResult,
} from '../protocol.ts';
import type {ExtractionInvocation} from '../flow.ts';

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
  requires_all_sources:fact.requires_all_sources,source_dependency_mode:fact.source_dependency_mode,timing:fact.timing,_scene_name:fact._scene_name};
}
/** 来源 receipt 的内部消费者使用；序列化的模型字段本身不授予新策略准入资格。 */
export function assertCompleteClaimAdmission(window:ExtractionWindow,fact:ExtractedFact,result:SourceVerificationResult):void {
 const bound=admittedResults.get(result);
 if(!bound||bound.window!==digest(window)||bound.fact!==digest(factBinding(fact))||bound.result!==digest(result))fail('unbound_admission');
}
const supports=['supported','uncertain','unsupported'] as const;
const repairFields=['results','candidate_index','verdict','issues','evidence','proof','event_verification','condition_verification',
 'stage_evidence','occurrence_evidence','message_id','quote','request_fingerprint','claim_check','version','parts','candidate_span',
 'start','end','attribution','arguments_and_relation','temporal_and_modality','evidence_indices','scope_subject','actor_kind','resolution',
 'field_checks','category','topic','scene_name','alternatives','interpretation_reason','valid_at','invalid_at','speech_act',
 'assertion_status','figurative_type','event','conditions','subject_mentions','kind','evidence_index','source_span'];
const verdict={type:'string',enum:supports};
const references={type:'array',maxItems:60,items:{type:'integer',minimum:0}};
const facet={type:'object',additionalProperties:false,properties:{verdict,evidence_indices:references},required:['verdict','evidence_indices']};
const semanticFields=['category','topic','scene_name','alternatives','interpretation_reason','valid_at','invalid_at',
 'speech_act','assertion_status','figurative_type','event','conditions'] as const;
const spanSchema={type:'object',additionalProperties:false,properties:{start:{type:'integer',minimum:0},end:{type:'integer',minimum:1}},required:['start','end']};
const mentionSchema={type:'object',additionalProperties:false,properties:{
 kind:{type:'string',enum:['first_person','second_person','literal_subject']},evidence_index:{type:'integer',minimum:0},
 source_span:spanSchema,candidate_span:spanSchema},required:['kind','evidence_index','source_span','candidate_span']};
const claimSchema={type:'object',additionalProperties:false,properties:{
 version:{type:'integer',enum:[2]},
 field_checks:{type:'object',additionalProperties:false,properties:Object.fromEntries(semanticFields.map(field=>[field,facet])),required:[...semanticFields]},
 parts:{type:'array',minItems:1,maxItems:4,items:{type:'object',additionalProperties:false,
  properties:{candidate_span:spanSchema,
   attribution:{type:'object',additionalProperties:false,properties:{...facet.properties,
    scope_subject:{type:'string',enum:['self','contact','unknown']},
    actor_kind:{type:'string',enum:['self','contact','shared','third_party','unknown']},
    resolution:{type:'string',enum:['explicit','unique_context','unresolved']},
    subject_mentions:{type:'array',maxItems:8,items:mentionSchema}},
    required:[...facet.required,'scope_subject','actor_kind','resolution','subject_mentions']},
   arguments_and_relation:facet,temporal_and_modality:facet},
  required:['candidate_span','attribution','arguments_and_relation','temporal_and_modality']}},
 },required:['version','parts','field_checks']};
const claimInstructions=`\n逐条核验完整候选，不改写正文或字段。顶层request_fingerprint逐字回传输入同名值，每项results必须填写claim_check。
claim_check.version固定为2；field_checks逐字段独立核验category、topic、scene_name、alternatives、interpretation_reason、valid_at、invalid_at、speech_act、assertion_status、figurative_type、event、conditions。分类、场景、解释不能引入原话未确定的领域、人物状态或长短期性质；不要求分类标签逐字出现在原话，但须由具体来源支持。备选解释保留原有不确定性，不扩成已证实事实。空数组和null不声明额外事实，可用空evidence_indices表示；非空语义字段的supported必须引用支持它的逐字依据。除event（发生时间标注）外，任一字段uncertain/unsupported均阻止接纳，不能以正文或总verdict代签；event是可选的标注，时间不确定时按未核实处理，不用它否决有据的正文。
confidence、risk_flags、requires_all_sources、source_dependency_mode、timing和来源ID是结构、策略或来源定位信息，不要求原话声明这些配置；低confidence、有风险标签或合法any与requires_all_sources=true组合本身不表示命题无支持。结构不授予语义支持。
claim_check.parts按Unicode码点覆盖完整正文（包括空白与标点），默认一段覆盖全文，最多四段，连续、不重叠、不遗漏。
每段分别判断归属、对象与关系、时间与认知模态；evidence_indices只引用本项evidence的0起索引。每个supported facet必须有逐字依据。资料scope_subject只取self/contact；原shared共同事实仍属contact关系范围，actor_kind可为shared或third_party，不能把亲友或转述中的人物变成说话人本人。
听成、理解为、猜测与获悉确定消息不同；不能新增原文未明示的对象、信息确证事件或先后关系。event=null仍须核对正文时间与模态，不以消息时间证明得知或事件发生。来源明确表达尚未确定时，忠实保留该未知可supported。
归属supported还须提供subject_mentions：evidence_index指向本项evidence，source_span按Unicode码点定位该引文内实际承担语义主体的提及，candidate_span定位本段候选中对应的主体。用于主体定位的引文须在对应原消息中唯一，重复时扩大引文；不得裁掉复数限定。first_person仅用于原话中的我/本人/我们/咱们，second_person仅用于你/您/你们；在已定位的人称提及基础上，才能结合sender判断归属，sender本身不证明省略的主体。literal_subject用于原话和候选均逐字保留的第三方主体或对象；不能凭没有命中人称词就断定它是名字，也不能把宾语、所有者或任意重合字当主体。共同主体逐个列出提及，或定位明确的复数人称。指代链须保留上下文中的真实先行主体及对应候选位置；仍有多解时用unresolved/uncertain。省略主体且无实际指代依据时subject_mentions留空，不能把对事物的评价扩成发言者的状态，更不能签explicit。
subject_mentions只列实际出现的主体词，不是每条evidence必须填写一次的清单。多条引文共同支持一个候选时，可以只有一条含真实主体词；其他引文仍可支持谓词，但不得给它们虚构人称提及。例如候选“联系人住在海城，目前没有搬家。”，引文0“我住在海城。”、引文1“目前没有搬家。”：若上下文确实支持同一主体，只列引文0的first_person、source_span={start:0,end:1}、candidate_span={start:0,end:3}；不能给引文1也标first_person并把“目”当成“我”。仍须逐项核验后句与该主体的实际关系；没有真实主体依据时继续用unresolved/uncertain。
归属无法唯一消解用unresolved/uncertain，不根据单个代词猜主体。引文存在与结构完整都不证明含义成立；任何facet未定或无支持不能由顶层supported覆盖。所有结论仅表示来源支持，不认证现实世界真值。`;

function fail(reason:string):never{throw new ExtractionProtocolError(`complete_claim_${reason}`);}
function object(value:unknown,keys:readonly string[]):Row{
 if(!value||typeof value!=='object'||Array.isArray(value))fail('structure_invalid');
 const row=value as Row;
 if(Object.keys(row).sort().join('|')!==[...keys].sort().join('|'))fail('structure_invalid');
 return row;
}
function checkFacet(value:unknown,evidenceCount:number,attribution=false,emptyValue=false):Row{
 const row=object(value,attribution?['verdict','evidence_indices','scope_subject','actor_kind','resolution','subject_mentions']:['verdict','evidence_indices']);
 if(!supports.includes(row.verdict)||!Array.isArray(row.evidence_indices)||row.evidence_indices.length>60
  ||new Set(row.evidence_indices).size!==row.evidence_indices.length
  ||row.evidence_indices.some((index:unknown)=>!Number.isSafeInteger(index)||Number(index)<0||Number(index)>=evidenceCount)
  ||row.verdict==='supported'&&!row.evidence_indices.length&&!emptyValue)fail('facet_invalid');
 if(attribution&&(!['self','contact','unknown'].includes(row.scope_subject)
  ||!['self','contact','shared','third_party','unknown'].includes(row.actor_kind)
  ||!['explicit','unique_context','unresolved'].includes(row.resolution)))fail('attribution_invalid');
 return row;
}
function locatedSpan(value:unknown,text:string):{start:number;end:number;text:string}{
 const span=object(value,['start','end']),points=[...text];
 if(!Number.isSafeInteger(span.start)||!Number.isSafeInteger(span.end)||span.start<0||span.end<=span.start||span.end>points.length)fail('mention_invalid');
 const located=points.slice(span.start,span.end).join('');
 if(!located.trim())fail('mention_invalid');
 return {start:span.start,end:span.end,text:located};
}
function groundedAttribution(row:Row,part:Row,fact:ExtractedFact,evidence:SourceVerificationResult['evidence'],window:ExtractionWindow):boolean{
 if(!Array.isArray(row.subject_mentions)||row.subject_mentions.length>8)fail('mention_invalid');
 const actors=new Set<string>();
 for(const value of row.subject_mentions){
  const mention=object(value,['kind','evidence_index','source_span','candidate_span']);
  if(!['first_person','second_person','literal_subject'].includes(mention.kind)||!Number.isSafeInteger(mention.evidence_index)
   ||!row.evidence_indices.includes(mention.evidence_index))fail('mention_invalid');
  const ref=evidence[mention.evidence_index];if(!ref)fail('mention_invalid');
  const source=locatedSpan(mention.source_span,ref.quote),candidate=locatedSpan(mention.candidate_span,fact.text);
  if(candidate.start<part.start||candidate.end>part.end)fail('mention_invalid');
  const message=window.messages.find(message=>uuid(message.message_id)===ref.message_id);if(!message)fail('mention_invalid');
  const quoteStart=message.text.indexOf(ref.quote);
  if(quoteStart<0||message.text.indexOf(ref.quote,quoteStart+1)>=0)return false;
  const mentionEnd=[...message.text.slice(0,quoteStart)].length+source.end;
  if(['我','你','您'].includes(source.text)&&[...message.text][mentionEnd]==='们')return false;
  if(mention.kind==='literal_subject'){
   if(source.text!==candidate.text||['我','本人','我们','咱们','你','您','你们'].includes(source.text))return false;
   actors.add('third_party');
  }else{
   const singular=mention.kind==='first_person'?['我','本人']:['你','您'];
   const plural=mention.kind==='first_person'?['我们','咱们']:['你们'];
   if(plural.includes(source.text))actors.add('shared');
   else if(singular.includes(source.text))actors.add(mention.kind==='first_person'?message.sender:message.sender==='self'?'contact':'self');
   else return false;
  }
 }
 const actor=actors.size>1||actors.has('shared')?'shared':[...actors][0];
 return actor!==undefined&&actor===row.actor_kind;
}
function checkClaim(value:unknown,fact:ExtractedFact,evidence:SourceVerificationResult['evidence'],window:ExtractionWindow):{verdict:Support;issues:string[];eventSupport:Support}{
 const root=object(value,['version','parts','field_checks']);
 if(root.version!==2||!Array.isArray(root.parts)||!root.parts.length||root.parts.length>4)fail('parts_invalid');
 let cursor=0;const statuses:Support[]=[],issues=new Set<string>();let eventSupport:Support='supported';
 const fields=object(root.field_checks,semanticFields);
 for(const field of semanticFields){
  const fieldValue=field==='scene_name'?fact._scene_name:fact[field];
  const checked=checkFacet(fields[field],evidence.length,false,fieldValue===null||Array.isArray(fieldValue)&&!fieldValue.length);
  // 发生时间标注是可选信息：仍校验结构，但不参与整条候选的准入聚合；不可采纳时由 validateSourceVerification 丢弃。
  if(field==='event'){eventSupport=checked.verdict;continue;}
  statuses.push(checked.verdict);
  if(checked.verdict!=='supported')issues.add(['valid_at','invalid_at'].includes(field)?'time'
   :field==='conditions'?'condition':['speech_act','assertion_status','figurative_type'].includes(field)?'pragmatics':'meaning');
 }
 for(const entry of root.parts){
  const part=object(entry,['candidate_span','attribution','arguments_and_relation','temporal_and_modality']);
  const span=object(part.candidate_span,['start','end']);
  if(!Number.isSafeInteger(span.start)||!Number.isSafeInteger(span.end)||span.start!==cursor||span.end<=span.start||span.end>[...fact.text].length)fail('coverage_invalid');
  cursor=span.end;
  const attribution=checkFacet(part.attribution,evidence.length,true);
  const relation=checkFacet(part.arguments_and_relation,evidence.length);
  const temporal=checkFacet(part.temporal_and_modality,evidence.length);
  statuses.push(attribution.verdict,relation.verdict,temporal.verdict);
  if(attribution.verdict!=='supported')issues.add('subject');
  if(relation.verdict!=='supported')issues.add('meaning');
  if(temporal.verdict!=='supported'){issues.add('time');issues.add('pragmatics');}
  const expectedScope=fact.subject==='self'?'self':'contact';
  if(!groundedAttribution(attribution,span,fact,evidence,window)||attribution.scope_subject!==expectedScope
   ||attribution.actor_kind==='unknown'||attribution.resolution==='unresolved'){
   statuses.push('uncertain');issues.add('subject');
  }
 }
 if(cursor!==[...fact.text].length)fail('coverage_invalid');
 return {verdict:statuses.includes('unsupported')?'unsupported':statuses.includes('uncertain')?'uncertain':'supported',issues:[...issues],eventSupport};
}

function verificationPayload(window:ExtractionWindow,facts:ExtractedFact[],modern:boolean):Row{
 const payload=buildSourceVerificationPayload(window,facts);
 if(modern){
  payload.candidates=(payload.candidates as Row[]).map((candidate,index)=>{
   const fact=facts[index]!;
   return {...candidate,scene_name:fact._scene_name,alternatives:fact.alternatives,
    interpretation_reason:fact.interpretation_reason,confidence:fact.confidence,risk_flags:fact.risk_flags,
    requires_all_sources:fact.requires_all_sources,source_dependency_mode:fact.source_dependency_mode,
    timing:fact.timing,event:candidate.event??null,conditions:candidate.conditions??null};
  });
  payload.claim_scope=facts.map((fact,candidate_index)=>({candidate_index,codepoint_length:[...fact.text].length,scope_subject:fact.subject==='self'?'self':'contact'}));
 }
 return payload;
}

function decodeVerificationRows(raw:Row,window:ExtractionWindow,facts:ExtractedFact[],policy:PreparedVerificationPolicy,fingerprint:string):VerificationAdmission[]{
 const modern=policy.id==='complete-claim-v1';
 if(modern&&raw.request_fingerprint!==fingerprint)fail('fingerprint_mismatch');
 if(modern)object(raw,['results','request_fingerprint']);
 const rows=Array.isArray(raw.results)?raw.results:fail('results_invalid');
 const baseRows=rows.map((entry:unknown)=>{
  if(!modern||!entry||typeof entry!=='object'||Array.isArray(entry))return entry;
  const {claim_check,...base}=entry as Row;return base;
 });
 const results=parseSourceVerification({results:baseRows},window,facts,
  {isolate_items:true,...(policy.id==='nullable-proof-v3'?{mode:'nullable-proof-v3' as const}:{})});
 return results.map((original,index)=>{
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
   const checked=checkClaim(modelClaim,fact,result.evidence,window);
   support=result.verdict==='unsupported'||checked.verdict==='unsupported'?'unsupported'
    :result.verdict==='uncertain'||checked.verdict==='uncertain'?'uncertain':'supported';
   result={...result,verdict:support,issues:[...new Set([...result.issues,...checked.issues])]};
   // claim_check 对时间的逐字段判定也不支持时，丢弃结构上可能已采纳的时间标注，只丢时间不拒绝正文。
   if(fact.event!==null&&!result.time_unverified&&checked.eventSupport!=='supported')result={...result,event:null,time_unverified:true};
  }catch(error){
   if(!(error instanceof ExtractionProtocolError))throw error;
   state='invalid';reason='structure_invalid';support='unsupported';
   result={...result,verdict:support,issues:[...new Set([...result.issues,'insufficient_evidence'])]};
  }
  result={...result,verification_mode:'complete-claim-v1',proof:null,proof_verification:null,model_claim_check:structuredClone(modelClaim),
   claim_validation:{status:state,policy_fingerprint:fingerprint,reason,semantic_support:support}};
  return {candidate_index:index,admitted:state==='checked'&&support==='supported',result};
 });
}

/** 存档消费者重放原模型回复的同一确定性校验，不能以JSON准入标志代替。 */
export function replayCompleteClaimVerification(window:ExtractionWindow,facts:ExtractedFact[],blocks:readonly unknown[],fingerprint:string,requestBody:unknown):VerificationAdmission[]{
 if(digest(requestBody)!==digest({...verificationPayload(window,facts,true),request_fingerprint:fingerprint}))fail('stored_request_mismatch');
 const raw=readExtractionToolArguments(blocks,'SourceVerificationOutput',{repair:true,field_names:repairFields,root_array_key:'results'}).value as Row;
 return decodeVerificationRows(raw,window,facts,{id:'complete-claim-v1'},fingerprint);
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
 const payload=verificationPayload(window,facts,modern);
 if(modern){
  schema.properties.results.items.properties.claim_check=claimSchema;
  schema.properties.results.items.required.push('claim_check');
  schema.properties.request_fingerprint={type:'string',pattern:'^[a-f0-9]{64}$'};
  schema.required.push('request_fingerprint');
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
    const selected=decodeVerificationRows(raw,window,facts,policy,fingerprint);
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
