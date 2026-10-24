/** 仅核对显式采集证据的内部一致性；哈希及声明时间不能认证历史采集或远端真实性。 */
import {createHash} from 'node:crypto';
import {validateReplyCandidates} from './reply-contract.ts';
type Row=Record<string,any>;
export interface ReplyRuntimeSourceAudit {
 status:'verified'|'undetermined';reason?:string;binding_sha256:string|null;output_scope:'complete_http_result'|'legacy_four_field_fixture'|'undetermined';
 allowed_citation_ids:string[];attempt_count:number;request_id:string|null;attempt_ids:string[];attempt_observations:Row[];
}
const INPUT=['current_intent','available_facts','unknowns','allowed_changes','current_message','recent_context'];
const ORACLE=['forbidden_additions','tags','split'];
const object=(value:unknown):value is Row=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
function invalid(reason:string):never{throw Error('reply_comparison_invalid:runtime_'+reason);}
function canonical(value:any):string {
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(object(value))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
 return invalid('non_json_value');
}
const digest=(value:any)=>createHash('sha256').update(typeof value==='string'?value:canonical(value)).digest('hex');
const equal=(actual:any,expected:any,reason:string)=>{if(canonical(actual)!==canonical(expected))invalid(reason);};
function scope(value:unknown):Row {
 if(!object(value)||!['owner_id','contact_id','conversation_binding_id'].every(key=>uuid(value[key]))||value.confirmation!=='manual'||Object.keys(value).sort().join(',')!=='confirmation,contact_id,conversation_binding_id,owner_id')invalid('scope');
 return value;
}
function time(value:unknown):number {
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)||!Number.isFinite(Date.parse(value)))return invalid('timestamp');
 return Date.parse(value);
}
/** SDK实际请求可把payload嵌在JSON文本里；递归遍历且只接受唯一业务payload。 */
function payloadOf(body:Row,excludedFields:string[]):Row {
 const found:Row[]=[];
 const visit=(value:any)=>{
  if(Array.isArray(value)){value.forEach(visit);return;}
  if(object(value)){
   if(Object.keys(value).some(key=>excludedFields.includes(key)))invalid('oracle_field_leak');
   if(Array.isArray(value.evidence)&&object(value.fidelity_contract))found.push(value);
   Object.values(value).forEach(visit);return;
  }
  if(typeof value!=='string')return;
  let decoded:any;
  try{decoded=JSON.parse(value);}catch{const first=value.indexOf('{'),last=value.lastIndexOf('}');if(first<0||last<=first)return;try{decoded=JSON.parse(value.slice(first,last+1));}catch{return;}}
  if(decoded!==value)visit(decoded);
 };
 visit(body);if(found.length!==1)invalid('unique_payload');return found[0];
}
const hashString=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const observations=(attempts:unknown[]):Row[]=>attempts.map(value=>{const attempt=object(value)?value:{},request=object(attempt.request)?attempt.request:{};return {attempt_id:uuid(attempt.attempt_id)?attempt.attempt_id:null,request_sha256:hashString(request.sha256)?request.sha256:null,request_hash_kind:request.hash_kind==='wire_utf8_sha256'||request.hash_kind==='canonical_json_sha256'?request.hash_kind:null,catalog_sha256:hashString(attempt.catalog_sha256)?attempt.catalog_sha256:null,response_started_at:typeof attempt.response_started_at==='string'?attempt.response_started_at:null};});
const pending=(reason:string,attempts:unknown[]=[]):ReplyRuntimeSourceAudit=>({status:'undetermined',reason,binding_sha256:null,output_scope:'undetermined',allowed_citation_ids:[],attempt_count:attempts.length,request_id:null,attempt_ids:[],attempt_observations:observations(attempts)});
/** 单物理请求合同；多请求需累积来源关系证明，当前明确未定且不丢弃原观测。 */
export function auditReplyRuntimeSources(member:Row,row:Row,output:Row,mode:'model_run'|'reporter_fixture'='model_run'):ReplyRuntimeSourceAudit {
 const evidence=row.runtime_sources;
 if(evidence===null||evidence===undefined)return pending('runtime_sources_missing');
 if(!object(evidence)||evidence.schema_version!=='reply-runtime-sources-v1'||!Array.isArray(evidence.attempts))invalid('sources_structure');
 if(evidence.attempts.length!==row.physical_calls)invalid('physical_attempt_count');
 if(evidence.attempts.length!==1)return pending('runtime_multiple_attempts_unsupported',evidence.attempts);
 const actualScope=scope(evidence.scope);equal(scope(row.scope),actualScope,'record_scope');
 if(!uuid(evidence.request_id))invalid('request_id');
 const attempt=evidence.attempts[0];
 if(!object(attempt)||!uuid(attempt.attempt_id)||attempt.attempt_id_kind!=='collector_http_observation_not_ledger_id'||!object(attempt.request)||!object(attempt.request.body))invalid('attempt');
 const request=attempt.request;
 if(!['wire_utf8_sha256','canonical_json_sha256'].includes(request.hash_kind))invalid('request_hash_kind');
 if(request.hash_kind==='wire_utf8_sha256'){
  if(typeof request.raw_utf8!=='string')invalid('request_wire_missing');
  let parsed:unknown;try{parsed=JSON.parse(request.raw_utf8);}catch{return invalid('request_wire_json');}
  equal(parsed,request.body,'request_wire_body');
  if(digest(request.raw_utf8)!==request.sha256)invalid('request_wire_hash');
 }else if(digest(request.body)!==request.sha256||request.raw_utf8!==undefined)invalid('request_canonical_hash');
 if(row.request_sha256!==request.sha256)invalid('record_request_hash');
 const payload=payloadOf(request.body,Object.keys(member).filter(key=>!INPUT.includes(key)));
 equal(Object.keys(payload).sort(),['input_mode','draft_text','user_instruction','include_relationship_context','workspace_action','context_text','skill_selection','expression_actor','recipient_role','message_order','evidence','citation_policy','fidelity_contract','risk_notes'].sort(),'payload_fields');
 const input=Object.fromEntries(INPUT.filter(key=>key in member).map(key=>[key,member[key]]));
 const context=Object.fromEntries(['available_facts','current_message','recent_context'].filter(key=>key in member).map(key=>[key,member[key]]));
 const strategy=Object.fromEntries(['unknowns','allowed_changes'].filter(key=>key in member).map(key=>[key,member[key]]));
 if(payload.input_mode!=='workspace'||payload.workspace_action!=='express'||payload.expression_actor!=='owner'||payload.recipient_role!=='contact'||payload.include_relationship_context!==true)invalid('workspace_projection');
 equal(payload.skill_selection,{mode:'disabled'},'unexpected_skill');
 if(payload.draft_text!==member.current_intent||payload.context_text!==canonical(context)||payload.user_instruction!==canonical(strategy))invalid('generation_input_projection');
 equal({current_intent:payload.draft_text,...JSON.parse(payload.context_text),...JSON.parse(payload.user_instruction)},input,'generation_input_roundtrip');
 const catalog=attempt.catalog;
 if(!object(catalog)||catalog.schema_version!=='reply-runtime-source-catalog-v1'||digest(catalog)!==attempt.catalog_sha256)invalid('catalog_hash');
 for(const key of ['case_id','repeat','arm','case_sha256','input_sha256'])if(catalog[key]!==row[key])invalid('catalog_'+key);
 if(catalog.case_sha256!==digest(member)||catalog.input_sha256!==digest(input)||catalog.request_id!==evidence.request_id||catalog.request_sha256!==request.sha256||catalog.request_hash_kind!==request.hash_kind)invalid('catalog_binding');
 equal(scope(catalog.scope),actualScope,'catalog_scope');
 if(catalog.capture_boundary!=='request_received_before_supplier_response'||catalog.stored_evidence_verified_after_completion!==false)invalid('catalog_pre_response');
 const captured=time(catalog.captured_at),responded=time(attempt.response_started_at),started=time(row.started_at),ended=time(row.ended_at);
 if(!(started<=captured&&captured<=responded&&responded<=ended))invalid('capture_response_order');
 equal(catalog.covered_input_fields,Object.keys(input).sort(),'covered_input_fields');
 equal(catalog.oracle_fields_excluded,ORACLE,'oracle_field_declaration');
 equal(catalog.strategy_fields,{payload_field:'user_instruction',fields:strategy,citable:false},'strategy_projection');
 const sources=payload.evidence;
 if(!Array.isArray(sources)||sources.length!==3||!sources.every(object)||new Set(sources.map(source=>source.evidence_id)).size!==3||new Set(sources.map(source=>source.kind)).size!==3)invalid('payload_sources');
 const expectedEntries:Row[]=sources.map(source=>{
  if(!uuid(source.evidence_id)||source.status!=='user_input')invalid('source_identity_or_status');
  let fields:string[],role:string,body:string,origin:string;
  switch(source.kind){
   case 'user_purpose':fields=[];role='current_user_intent';body='帮我表达';origin='explicit_workspace_action';break;
   case 'user_draft':fields=['current_intent'];role='current_user_statement';body=member.current_intent;origin='frozen_case_manual_input';break;
   case 'user_current_chat':fields=Object.keys(context);role='user_provided_contact_text';body=canonical(context);origin='frozen_case_manual_input';break;
   default:return invalid('source_kind');
  }
  if(source.factual_role!==role||source.text!==body)invalid('source_role_or_text');
  return {...source,text_sha256:digest(body),case_fields:fields,origin,source_ids:[],not_confirmed_memory:true};
 });
 equal(catalog.entries,expectedEntries,'catalog_entries');
 const ids=sources.map(source=>source.evidence_id);
 equal(payload.citation_policy,{allowed_evidence_ids:ids,additional_evidence_ids:'successful_history_tool_evidence_only',references_are_not_citations:true},'payload_citation_policy');
 const persisted=evidence.persistence;
 if(persisted===null||persisted===undefined)return pending('runtime_persistence_missing',evidence.attempts);
 if(!object(persisted)||persisted.verified_after_completion!==true||persisted.catalog_sha256!==attempt.catalog_sha256||persisted.request_id!==evidence.request_id)invalid('persistence_binding');
 equal(scope(persisted.scope),actualScope,'persistence_scope');
 if(time(persisted.observed_at)<ended)invalid('persistence_order');
 const snapshot=expectedEntries.map(entry=>({evidence_id:entry.evidence_id,kind:entry.kind,evidence_text:entry.text,owner_id:actualScope.owner_id,contact_id:actualScope.contact_id,conversation_binding_id:actualScope.conversation_binding_id,source_ids:[]}));
 if(digest(persisted.snapshot)!==persisted.snapshot_sha256)invalid('persistence_snapshot_hash');
 equal(persisted.snapshot,snapshot,'persistence_sources');
 const legacy=mode==='reporter_fixture'&&Object.keys(output).join(',')==='candidates'&&output.candidates.every((candidate:Row)=>Object.keys(candidate).sort().join(',')==='basis,candidate_id,citation_ids,text');
 const complete=['reply_request_id','context_receipt','used_skill'].every(key=>key in output)&&output.candidates.every((candidate:Row)=>'risk_notes'in candidate&&'messages'in candidate);
 if(!legacy&&!complete)return pending('runtime_complete_output_missing',evidence.attempts);
 if(!legacy){
  if(Object.keys(output).some(key=>!['reply_request_id','candidates','context_receipt','used_skill','basis_changes','input_budget'].includes(key))||output.reply_request_id!==evidence.request_id||!object(output.context_receipt)||output.used_skill!==null)invalid('complete_output_structure');
  for(const candidate of output.candidates){
   equal(Object.keys(candidate).sort(),['candidate_id','text','basis','citation_ids','risk_notes','messages'].sort(),'complete_candidate_fields');
   if(!uuid(candidate.candidate_id)||!Array.isArray(candidate.risk_notes)||candidate.risk_notes.some((note:unknown)=>typeof note!=='string'||!note.trim())||!Array.isArray(candidate.messages)||candidate.messages.length<1||candidate.messages.length>8)invalid('complete_candidate_structure');
   for(const message of candidate.messages){
    if(!object(message)||!uuid(message.message_id)||typeof message.text!=='string'||!message.text.trim())invalid('complete_message_structure');
    equal(Object.keys(message).sort(),['message_id','text'],'complete_message_fields');
   }
   if(new Set(candidate.messages.map((message:Row)=>message.message_id)).size!==candidate.messages.length)invalid('complete_message_identity');
   if(candidate.messages.map((message:Row)=>message.text).join('\n\n')!==candidate.text)invalid('complete_message_text');
  }
  // DTO消息ID另验；正文、basis、风险说明、引用及分组限制复用产品纯结构合同。
  try{validateReplyCandidates({candidates:output.candidates.map((candidate:Row)=>({...candidate,messages:candidate.messages.map((message:Row)=>message.text)}))},new Set(ids));}catch{return invalid('complete_candidate_structure');}
  const receipt=output.context_receipt;
  equal(Object.keys(receipt).sort(),['evidence_ids','expression_preference_ids','expression_preferences','layered_read_failed','owner_layered_read_failed','overview_read_failed'].sort(),'context_receipt_fields');
  if(!Array.isArray(receipt.evidence_ids)||receipt.evidence_ids.some((id:unknown)=>!uuid(id))||new Set(receipt.evidence_ids).size!==receipt.evidence_ids.length)invalid('context_receipt_evidence');
  // 公开回执描述候选实际引用的集合；不同实现的集合遍历顺序不构成差异。
  equal([...receipt.evidence_ids].sort(),[...new Set(output.candidates.flatMap((candidate:Row)=>candidate.citation_ids))].sort(),'context_receipt_evidence');
  // 当前已核payload没有表达偏好；禁用Skill本身不代表表达偏好不存在。
  equal(receipt.expression_preference_ids,[],'context_receipt_preferences');
  equal(receipt.expression_preferences,[],'context_receipt_preferences');
  if(['layered_read_failed','owner_layered_read_failed','overview_read_failed'].some(key=>typeof receipt[key]!=='boolean'))invalid('context_receipt_flags');
  if(persisted.candidate_snapshot==null||persisted.request_snapshot==null)return pending('runtime_complete_persistence_missing',evidence.attempts);
  const scopeIds=Object.fromEntries(['owner_id','contact_id','conversation_binding_id'].map(key=>[key,actualScope[key]]));
  equal(persisted.candidate_snapshot,output.candidates.map((candidate:Row)=>({...candidate,...scopeIds,reply_request_id:evidence.request_id})),'persistence_candidates');
  // 本合同只支持明确禁用Skill的合成输入，PG原字段必须实际为空。
  equal(persisted.request_snapshot,{id:evidence.request_id,...scopeIds,skill_id:null,skill_version_id:null,skill_name:null,skill_selection_method:null,skill_selection_reason:null,skill_load_state:null,skill_loaded_resources:null},'persistence_request_skill');
 }
 if(persisted.output_sha256!==digest(persisted.output)||persisted.output_sha256!==digest(output))invalid('persistence_output_hash');
 equal(persisted.output,output,'persistence_output');
 return {status:'verified',output_scope:legacy?'legacy_four_field_fixture':'complete_http_result',binding_sha256:digest(evidence),allowed_citation_ids:ids,attempt_count:1,request_id:evidence.request_id,attempt_ids:[attempt.attempt_id],attempt_observations:observations(evidence.attempts)};
}
