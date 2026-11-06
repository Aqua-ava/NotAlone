/** 图文共同核验：图片引用实际文件版本，观察描述不冒充逐字原文。 */
import {digest} from '../evidence/canonical-json.ts';
import {sha256} from '../../platform/sha256.ts';
import {ExtractionArgumentsError,readExtractionToolArguments} from './arguments.ts';
import {ExtractionProtocolError,validateExtractionWindow,uuid,type ExtractionWindow,type ExtractedFact,type SourceVerificationResult} from './protocol.ts';
import type {ExtractionInvocation} from './flow.ts';
import type {PreparedVerification,VerificationAdmission} from './verification/complete-claim.ts';

export type ContentEvidence=NonNullable<SourceVerificationResult['content_evidence']>[number];
type Row=Record<string,any>;
const policyId='multimodal-claim-v1';
const fields=['category','topic','scene_name','alternatives','interpretation_reason','valid_at','invalid_at','speech_act','assertion_status','figurative_type','event','conditions'] as const;
const facets=['attribution','body','temporal_and_modality'] as const;
const supports=['supported','uncertain','unsupported'] as const;
const boundResults=new WeakMap<object,{window:string;fact:string;result:string}>();
const verdict={type:'string',enum:supports};
const facet={type:'object',additionalProperties:false,properties:{verdict,evidence_indices:{type:'array',maxItems:60,items:{type:'integer',minimum:0}},explanation:{type:'string',minLength:1,maxLength:2000}},required:['verdict','evidence_indices','explanation']};
const attributionFacet={...facet,properties:{...facet.properties,scope_subject:{type:'string',enum:['self','contact','unknown']},actor_kind:{type:'string',enum:['self','contact','shared','third_party','unknown']},resolution:{type:'string',enum:['explicit','unique_context','unresolved']}},required:[...facet.required,'scope_subject','actor_kind','resolution']};
const nullableString={type:['string','null']};
const evidenceSchema={type:'object',additionalProperties:false,properties:{message_id:{type:'string',format:'uuid'},kind:{type:'string',enum:['text','image']},quote:nullableString,file_id:nullableString,sha256:nullableString,description:nullableString},required:['message_id','kind','quote','file_id','sha256','description']};
const checkNames=[...facets,...fields] as const;
const checkSchema={...facet,properties:{field:{type:'string',enum:checkNames},...facet.properties},required:['field',...facet.required]};
const schema={title:'SourceVerificationOutput',type:'object',additionalProperties:false,properties:{request_fingerprint:{type:'string'},results:{type:'array',maxItems:60,items:{type:'object',additionalProperties:false,properties:{candidate_index:{type:'integer',minimum:0},verdict,issues:{type:'array',maxItems:30,items:{type:'string',minLength:1,maxLength:200}},evidence:{type:'array',minItems:1,maxItems:60,items:evidenceSchema},scope_subject:attributionFacet.properties.scope_subject,actor_kind:attributionFacet.properties.actor_kind,resolution:attributionFacet.properties.resolution,checks:{type:'array',minItems:15,maxItems:15,items:checkSchema}},required:['candidate_index','verdict','issues','evidence','scope_subject','actor_kind','resolution','checks']}}},required:['request_fingerprint','results']};
const prompt=`你是图文记忆来源核验器。只核验本次同一联系人的固定对话窗口与实际附图，不补写候选，不把图片占位文案当图片内容。按消息顺序、发送者、时间和image_id结合语境核验，每项只引用候选明确声明的source_message_ids。
输出采用flat-fields-v2：每条results记录直接填写scope_subject、actor_kind、resolution，以及扁平checks数组。checks严格包含15项，各field恰好一次：attribution、body、temporal_and_modality、category、topic、scene_name、alternatives、interpretation_reason、valid_at、invalid_at、speech_act、assertion_status、figurative_type、event、conditions。每项只有field、verdict、evidence_indices、explanation这4个键；没有claim_check、field_checks或explanation_note等嵌套槽。
每个check独立核验对应字段。supported只表示来源支持，不认证现实真值。所有非空语义字段都须有具体证据。完整核验正文中的所有限定、否定、时间与认知模态，不用总verdict代替独立检查。空数组及null不声明额外事实，可用空索引；非空字段以及attribution/body/temporal_and_modality的supported都必须有依据。event时间标注若不能验证可为uncertain，其他字段不确定须拒绝采纳。
scope_subject对应关系资料归属（self/contact/unknown），shared共同事实属于contact范围；actor_kind保留实际语义主体（self/contact/shared/third_party/unknown），resolution只取explicit/unique_context/unresolved。图片发件人不自动等于图片内人物、物品所有者或截图说话人。不能把亲友或截图作者改成发件人本人；无法从对话明确或唯一归属时须unresolved/uncertain。图片不能证明未出现的动机、疾病、身份、长期偏好或因果关系。
文字证据kind=text，quote必须是该文字消息内唯一出现的逐字引文，file_id/sha256/description都为null。图片证据kind=image，file_id/sha256逐字回传对应消息的实际文件标识与摘要，quote为null，description仅描述看见且支持候选的内容。图片观察描述不是新的聊天原文，不得伪造图片引文。不得引用未附上的图片、其他窗口或其他文件版本。
候选依赖的每条来源都必须分别列入evidence。evidence_indices只引用当前候选evidence的0起索引，explanation解释支持或不支持的具体关系。request_fingerprint原样回传。issues只属于results记录。严格使用工具schema中的键，完整闭合每个check对象、checks数组、结果对象、results数组及最外层对象。`;

function fail(reason:string):never{throw new ExtractionProtocolError(`multimodal_claim_${reason}`);}
function exact(value:unknown,keys:readonly string[]):Row{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('|')!==[...keys].sort().join('|'))fail('structure_invalid');
 return value as Row;
}
function text(value:unknown,max=8192):value is string{return typeof value==='string'&&value.trim().length>0&&[...value].length<=max;}
/** 只收拢已观察到的无语义空槽及唯一末尾闭合缺失；语义字段和额外非空信息不删改。 */
function argumentsEnvelope(blocks:readonly unknown[]):{value:Record<string,unknown>;repairs:string[]}{
 const repairs:string[]=[];let value:Record<string,unknown>;
 try{value=readExtractionToolArguments(blocks,'SourceVerificationOutput',{repair:false,drop_stray_closers:true}).value;}
 catch(error){
  if(!(error instanceof ExtractionArgumentsError))throw error;
  const calls=blocks.filter((block):block is Row=>!!block&&typeof block==='object'&&(block as Row).type==='tool-call');
  if(calls.length!==1||calls[0]!.name!=='SourceVerificationOutput'||typeof calls[0]!.arguments!=='string'
   ||Buffer.byteLength(calls[0]!.arguments,'utf8')>256*1024||!/\}\]\}\s*$/u.test(calls[0]!.arguments))throw error;
  // 仅有这一种位置：最后一条结果对象与results数组的结束处，不搜索或补造正文中的括号。
  const fixed=calls[0]!.arguments.replace(/\]\}(\s*)$/u,'}]}$1');
  value=readExtractionToolArguments([{...calls[0],arguments:fixed}],'SourceVerificationOutput',{repair:false}).value;
  repairs.push('missing_terminal_object_closure');
 }
 if(Array.isArray(value.results))for(const result of value.results){
  const claim=result?.claim_check;
  if(!claim||typeof claim!=='object'||Array.isArray(claim))continue;
  for(const name of ['body','temporal_and_modality']){
   const facet=claim[name];
   if(facet&&typeof facet==='object'&&!Array.isArray(facet)&&Object.hasOwn(facet,'explanation_note')&&facet.explanation_note===null){delete facet.explanation_note;repairs.push('empty_facet_explanation_note');}
  }
  if(Object.hasOwn(claim,'issues')&&Array.isArray(claim.issues)&&claim.issues.length===0){delete claim.issues;repairs.push('empty_claim_issues');}
 }
 return {value,repairs:[...new Set(repairs)]};
}
function payload(window:ExtractionWindow,facts:readonly ExtractedFact[],format:'nested-v1'|'flat-fields-v2'='flat-fields-v2'){
 return {policy:policyId,...(format==='flat-fields-v2'?{check_format:format}:{}),owner_id:window.owner_id,contact_id:window.contact_id,target_message_ids:window.target_message_ids??window.messages.map(m=>m.message_id),
  messages:window.messages.map(m=>({message_id:m.message_id,sender:m.sender,occurred_at:m.occurred_at,...(m.image?{content_kind:'image',image_id:m.image.id,file_id:m.image.file_id,sha256:m.image.sha256,mime_type:m.image.mime_type,media_generation:m.image.media_generation}:{content_kind:'text',text:m.text})})),
  candidates:facts.map((fact,candidate_index)=>({candidate_index,...fact}))};
}
function facetStatus(value:unknown,evidenceCount:number,empty=false):typeof supports[number]{
 const row=exact(value,['verdict','evidence_indices','explanation']);
 if(!supports.includes(row.verdict)||!text(row.explanation,2000)||!Array.isArray(row.evidence_indices)||row.evidence_indices.length>60
  ||new Set(row.evidence_indices).size!==row.evidence_indices.length||row.evidence_indices.some((n:unknown)=>!Number.isSafeInteger(n)||Number(n)<0||Number(n)>=evidenceCount)
  ||row.verdict==='supported'&&!empty&&!row.evidence_indices.length)fail('facet_invalid');
 return row.verdict;
}
function evidence(value:unknown,window:ExtractionWindow,fact:ExtractedFact):ContentEvidence[]{
 if(!Array.isArray(value)||!value.length||value.length>60)fail('evidence_invalid');
 const seen=new Set<string>();
 return value.map(raw=>{
  const ref=exact(raw,['message_id','kind','quote','file_id','sha256','description']),message=window.messages.find(m=>uuid(m.message_id)===ref.message_id);
  if(!message||!fact.source_message_ids.includes(ref.message_id))fail('evidence_scope_invalid');
  if(ref.kind==='text'){
   if(message.image||!text(ref.quote)||ref.file_id!==null||ref.sha256!==null||ref.description!==null)fail('text_evidence_invalid');
   const index=message.text.indexOf(ref.quote);if(index<0||message.text.indexOf(ref.quote,index+1)>=0)fail('text_evidence_unlocated');
  }else if(ref.kind==='image'){
   if(!message.image||ref.quote!==null||ref.file_id!==message.image.file_id||ref.sha256!==message.image.sha256||!text(ref.description))fail('image_evidence_invalid');
  }else fail('evidence_kind_invalid');
  const key=digest(ref);if(seen.has(key))fail('evidence_duplicate');seen.add(key);return ref as ContentEvidence;
 });
}
function decodeNested(raw:unknown,window:ExtractionWindow,facts:readonly ExtractedFact[],fingerprint:string):VerificationAdmission[]{
 const root=exact(raw,['request_fingerprint','results']);
 if(root.request_fingerprint!==fingerprint||!Array.isArray(root.results)||root.results.length!==facts.length)fail('response_binding_invalid');
 const indices=new Set<number>();
 return root.results.map((value:unknown)=>{
  const row=exact(value,['candidate_index','verdict','issues','evidence','claim_check']);
  if(!Number.isSafeInteger(row.candidate_index)||row.candidate_index<0||row.candidate_index>=facts.length||indices.has(row.candidate_index))fail('candidate_invalid');
  indices.add(row.candidate_index);const fact=facts[row.candidate_index]!;
  if(!supports.includes(row.verdict)||!Array.isArray(row.issues)||row.issues.length>30||row.issues.some((s:unknown)=>!text(s,200)))fail('verdict_invalid');
  const references=evidence(row.evidence,window,fact),claim=exact(row.claim_check,['version',...facets,'field_checks']);
  if(claim.version!==1)fail('claim_invalid');
  const attribution=exact(claim.attribution,['verdict','evidence_indices','explanation','scope_subject','actor_kind','resolution']);
  if(!['self','contact','unknown'].includes(attribution.scope_subject)||!['self','contact','shared','third_party','unknown'].includes(attribution.actor_kind)||!['explicit','unique_context','unresolved'].includes(attribution.resolution))fail('attribution_invalid');
  const statuses=facets.map(name=>facetStatus(name==='attribution'?{verdict:attribution.verdict,evidence_indices:attribution.evidence_indices,explanation:attribution.explanation}:claim[name],references.length));
  if(attribution.scope_subject!==(fact.subject==='self'?'self':'contact')||attribution.resolution==='unresolved'||attribution.actor_kind==='unknown'
   ||fact.subject==='self'&&attribution.actor_kind!=='self'||fact.subject==='shared'&&attribution.actor_kind!=='shared'
   ||fact.subject==='contact'&&attribution.actor_kind==='self')statuses.push('uncertain');
  const checks=exact(claim.field_checks,fields);let eventSupport:typeof supports[number]='supported';
  for(const field of fields){const v=field==='scene_name'?fact._scene_name:fact[field];const status=facetStatus(checks[field],references.length,v===null||Array.isArray(v)&&v.length===0);if(field==='event')eventSupport=status;else statuses.push(status);}
  const covered=fact.source_message_ids.every(id=>references.some(ref=>ref.message_id===id));
  const support=row.verdict==='unsupported'||statuses.includes('unsupported')?'unsupported':row.verdict==='uncertain'||statuses.includes('uncertain')||!covered?'uncertain':'supported';
  const result:SourceVerificationResult={candidate_index:row.candidate_index,verdict:support,issues:[...row.issues,...(!covered?['insufficient_evidence']:[])],
   evidence:references.filter(ref=>ref.kind==='text').map(ref=>({message_id:ref.message_id,quote:ref.quote!})),content_evidence:references,
   verification_mode:policyId,model_verdict:row.verdict,model_issues:[...row.issues],event:eventSupport==='supported'?fact.event:null,conditions:fact.conditions,
   proof:null,proof_verification:null,model_claim_check:structuredClone(claim),
   ...(fact.event&&eventSupport!=='supported'?{time_unverified:true}:{}),
   claim_validation:{status:'checked',policy_fingerprint:fingerprint,reason:support==='supported'?'supported':'semantic_not_supported',semantic_support:support}};
  return {candidate_index:row.candidate_index,admitted:support==='supported',result};
 }).sort((a:VerificationAdmission,b:VerificationAdmission)=>a.candidate_index-b.candidate_index);
}
/** field是明确的协议标识；只映射完整唯一的扁平检查，不修复或抬升错误嵌套。 */
function decodeFlat(raw:unknown,window:ExtractionWindow,facts:readonly ExtractedFact[],fingerprint:string):VerificationAdmission[]{
 const root=exact(raw,['request_fingerprint','results']);
 if(!Array.isArray(root.results))fail('structure_invalid');
 const rows=root.results.map((entry:unknown)=>{
  const row=exact(entry,['candidate_index','verdict','issues','evidence','scope_subject','actor_kind','resolution','checks']);
  if(!Array.isArray(row.checks)||row.checks.length!==checkNames.length)fail('checks_incomplete');
  const checks=new Map<string,Row>();
  for(const value of row.checks){
   const check=exact(value,['field','verdict','evidence_indices','explanation']);
   if(!checkNames.includes(check.field)||checks.has(check.field))fail('checks_incomplete');
   checks.set(check.field,{verdict:check.verdict,evidence_indices:check.evidence_indices,explanation:check.explanation});
  }
  if(checkNames.some(name=>!checks.has(name)))fail('checks_incomplete');
  return {candidate_index:row.candidate_index,verdict:row.verdict,issues:row.issues,evidence:row.evidence,
   claim_check:{version:1,attribution:{...checks.get('attribution'),scope_subject:row.scope_subject,actor_kind:row.actor_kind,resolution:row.resolution},
    body:checks.get('body'),temporal_and_modality:checks.get('temporal_and_modality'),field_checks:Object.fromEntries(fields.map(name=>[name,checks.get(name)]))}};
 });
 return decodeNested({request_fingerprint:root.request_fingerprint,results:rows},window,facts,fingerprint);
}

export function assertMultimodalAdmission(window:ExtractionWindow,fact:ExtractedFact,result:SourceVerificationResult):void{
 const bound=boundResults.get(result);if(!bound||bound.window!==digest(window)||bound.fact!==digest(fact)||bound.result!==digest(result))fail('unbound_admission');
}
export function replayMultimodalVerification(window:ExtractionWindow,facts:readonly ExtractedFact[],blocks:readonly unknown[],fingerprint:string,requestBody:unknown):VerificationAdmission[]{
 validateExtractionWindow(window);
 const format=requestBody&&typeof requestBody==='object'?(requestBody as Row).check_format:undefined;
 if(format!==undefined&&format!=='flat-fields-v2')fail('stored_request_mismatch');
 if(digest(requestBody)!==digest({...payload(window,facts,format??'nested-v1'),request_fingerprint:fingerprint}))fail('stored_request_mismatch');
 return format==='flat-fields-v2'?decodeFlat(readExtractionToolArguments(blocks,'SourceVerificationOutput',{repair:false,drop_stray_closers:true}).value,window,facts,fingerprint):
  decodeNested(argumentsEnvelope(blocks).value,window,facts,fingerprint);
}
export function prepareMultimodalVerification(options:{window:ExtractionWindow;facts:readonly ExtractedFact[];images:NonNullable<ExtractionInvocation['images']>;ruleVersion?:string;requireCurrent():Promise<void>;record?(event:{stage:string;payload:unknown}):Promise<void>}):PreparedVerification{
 const window=structuredClone(options.window),facts=structuredClone([...options.facts]);validateExtractionWindow(window);
 const images=structuredClone(options.images),expected=window.messages.flatMap(message=>message.image?[message.image]:[]);
 if(!expected.length||expected.length!==images.length||new Set(images.map(image=>image.id)).size!==images.length
  ||expected.some(image=>!images.some(actual=>actual.id===image.id&&actual.mimeType===image.mime_type&&sha256(Buffer.from(actual.dataBase64,'base64'))===image.sha256)))fail('images_missing');
 const system=prompt;
 const body=payload(window,facts),fingerprint=digest({policy:policyId,rule_version:options.ruleVersion??null,window,facts,prompt:system,schema});
 const requestBody={...body,request_fingerprint:fingerprint};
 let responseSha:string|undefined;
 const decodeResponse=async(blocks:readonly unknown[])=>{
  await options.requireCurrent();const raw=readExtractionToolArguments(blocks,'SourceVerificationOutput',{repair:false,drop_stray_closers:true}).value;
  const sha=digest(raw);if(responseSha&&sha!==responseSha)fail('response_changed');responseSha=sha;
  const items=decodeFlat(raw,window,facts,fingerprint);
  for(const item of items)if(item.admitted&&item.result){const fact=facts[item.candidate_index]!;boundResults.set(item.result,{window:digest(window),fact:digest({...fact,event:item.result.event,conditions:item.result.conditions}),result:digest(item.result)});}
  return {items};
 };
 return {fingerprint,selection:facts.map((_,index)=>index),request:facts.length?{purpose:'verification',system,user:JSON.stringify(requestBody),images,tool:{name:'SourceVerificationOutput',description:'核验固定图文来源与完整候选。',parameters:structuredClone(schema)},validateOutput:async blocks=>{await decodeResponse(blocks);}}:null,decode:decodeResponse};
}
