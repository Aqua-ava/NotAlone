/** 仅核对显式采集证据的内部一致性；哈希及声明时间不能认证历史采集或远端真实性。 */
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {validateReplyCandidates} from '../reply/generation/reply-contract.ts';
type Row=Record<string,any>;
export interface ReplyRuntimeSourceAudit {
 status:'verified'|'undetermined';reason?:string;binding_sha256:string|null;output_scope:'complete_http_result'|'legacy_four_field_fixture'|'undetermined';
 allowed_citation_ids:string[];attempt_count:number;request_id:string|null;attempt_ids:string[];attempt_observations:Row[];
 contract_scope?:'constant_workspace_noSkill_read_denied_v1';derived_proof?:Row;
}
export interface ReplyRuntimeSourceSubjectBinding {runtime_sources_sha256:string;runtime_source_proof_sha256?:string}
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
const commitHash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
export interface ReplyComparisonCollectorBinding {source_commit:string;source_tree_sha256:string;workspace_clean:boolean;argv_sha256:string}
export interface ReplyRuntimeSourceCaptureInput {
 member:Row;body:Row;request:{request_id:string;hash_kind:'wire_utf8_sha256'|'canonical_json_sha256';sha256:string;raw_utf8?:string};
 scope:Row;case_id:string;repeat:number;arm:'old'|'new';attempt_id:string;started_at:string;captured_at:string;response_started_at:string;
 persisted_sources:readonly Row[];collector_binding:ReplyComparisonCollectorBinding;
}
const SOURCE_PATHS=['backend-ts/src','backend-ts/profile','backend-ts/package.json','backend-ts/pnpm-lock.yaml'];
/** collector 只把实际源码树、工作树状态、argv摘要与提交绑定进 attempt；不写本机路径原值。 */
export function replyComparisonCollectorBinding(repositoryRoot:string,argv:readonly string[]=process.argv.slice(2),sourcePaths:readonly string[]=SOURCE_PATHS):ReplyComparisonCollectorBinding {
 if(typeof repositoryRoot!=='string'||!repositoryRoot||!Array.isArray(argv)||argv.some(value=>typeof value!=='string'))return invalid('collector_arguments');
 if(!Array.isArray(sourcePaths)||!sourcePaths.length||sourcePaths.some(value=>typeof value!=='string'||!value||value.startsWith('/')||value.split('/').includes('..')))invalid('collector_source_paths');
 let sourceCommit:string,files:string[],status:string;
 try{
  sourceCommit=execFileSync('git',['rev-parse','--verify','HEAD^{commit}'],{cwd:repositoryRoot,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  files=execFileSync('git',['ls-files','-z','--',...sourcePaths],{cwd:repositoryRoot,encoding:'utf8',stdio:['ignore','pipe','ignore']}).split('\0').filter(Boolean).sort();
  status=execFileSync('git',['status','--porcelain','--untracked-files=no','--',...sourcePaths],{cwd:repositoryRoot,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
 }
 catch{return invalid('collector_source_commit');}
 if(!commitHash(sourceCommit)||!files.length)invalid('collector_source_commit');
 const sourceTree=files.map(path=>[path,createHash('sha256').update(readFileSync(join(repositoryRoot,path))).digest('hex')]);
 return {source_commit:sourceCommit,source_tree_sha256:digest(sourceTree),workspace_clean:status.length===0,argv_sha256:digest([...argv])};
}
function captureProjection(member:Row,body:Row):{payload:Row;input:Row;context:Row;strategy:Row} {
 const payload=payloadOf(body,Object.keys(member).filter(key=>!INPUT.includes(key)));
 equal(Object.keys(payload).sort(),['input_mode','draft_text','user_instruction','include_relationship_context','workspace_action','context_text','skill_selection','expression_actor','recipient_role','message_order','evidence','citation_policy','fidelity_contract','risk_notes'].sort(),'payload_fields');
 const input=Object.fromEntries(INPUT.filter(key=>key in member).map(key=>[key,member[key]]));
 const context=Object.fromEntries(['available_facts','current_message','recent_context'].filter(key=>key in member).map(key=>[key,member[key]]));
 const strategy=Object.fromEntries(['unknowns','allowed_changes'].filter(key=>key in member).map(key=>[key,member[key]]));
 if(payload.input_mode!=='workspace'||payload.workspace_action!=='express'||payload.expression_actor!=='owner'||payload.recipient_role!=='contact'||payload.include_relationship_context!==true)invalid('workspace_projection');
 equal(payload.skill_selection,{mode:'disabled'},'unexpected_skill');
 if(payload.draft_text!==member.current_intent||payload.context_text!==canonical(context)||payload.user_instruction!==canonical(strategy))invalid('generation_input_projection');
 equal({current_intent:payload.draft_text,...JSON.parse(payload.context_text),...JSON.parse(payload.user_instruction)},input,'generation_input_roundtrip');
 return {payload,input,context,strategy};
}
/** 从实际请求与完成后的PG真实来源构造v2 catalog和独立mapping；不接收预置alias映射。 */
export function captureReplyRuntimeSourceAttempt(input:ReplyRuntimeSourceCaptureInput):{catalog:Row;catalog_sha256:string;model_alias_mapping:Row[];attempt:Row} {
 if(!object(input)||!object(input.member)||!object(input.body)||!object(input.request)||!object(input.scope)||!Array.isArray(input.persisted_sources))return invalid('capture_shape');
 const actualScope=scope(input.scope),binding=input.collector_binding;
 if(!object(binding)||Object.keys(binding).sort().join(',')!=='argv_sha256,source_commit,source_tree_sha256,workspace_clean'
   ||!commitHash(binding.source_commit)||!hashString(binding.source_tree_sha256)||typeof binding.workspace_clean!=='boolean'||!hashString(binding.argv_sha256))invalid('collector_source_binding');
 if(!uuid(input.request.request_id)||!uuid(input.attempt_id)||typeof input.case_id!=='string'||![1,2,3].includes(input.repeat)||!['old','new'].includes(input.arm))invalid('capture_identity');
 const request=input.request;
 if(!['wire_utf8_sha256','canonical_json_sha256'].includes(request.hash_kind)||!hashString(request.sha256))invalid('request_hash_kind');
 if(request.hash_kind==='wire_utf8_sha256'){
  if(typeof request.raw_utf8!=='string')invalid('request_wire_missing');
  let parsed:unknown;try{parsed=JSON.parse(request.raw_utf8);}catch{return invalid('request_wire_json');}
  equal(parsed,input.body,'request_wire_body');
  if(digest(request.raw_utf8)!==request.sha256)invalid('request_wire_hash');
 }else if(digest(input.body)!==request.sha256||request.raw_utf8!==undefined)invalid('request_canonical_hash');
 const {payload,input:projectedInput,context,strategy}=captureProjection(input.member,input.body);
 const sources=payload.evidence;
 if(!Array.isArray(sources)||sources.length!==3||!sources.every(object)
   ||sources.some((source,index)=>source.evidence_id!==`c${index+1}`)
   ||new Set(sources.map(source=>source.kind)).size!==3)invalid('payload_sources');
 if(input.persisted_sources.length!==sources.length)invalid('persisted_source_count');
 const modelAliasMapping:Row[]=[],entries:Row[]=[];
 for(const [index,source]of sources.entries()){
  const stored=input.persisted_sources[index];
  if(!object(stored)||!uuid(stored.evidence_id)||stored.kind!==source.kind||stored.evidence_text!==source.text
    ||stored.owner_id!==actualScope.owner_id||stored.contact_id!==actualScope.contact_id
    ||stored.conversation_binding_id!==actualScope.conversation_binding_id||canonical(stored.source_ids)!=='[]')invalid('persisted_source_identity');
  if(modelAliasMapping.some(entry=>entry.evidence_id===stored.evidence_id))invalid('persisted_source_duplicate');
  let fields:string[],role:string,body:string,origin:string;
  switch(source.kind){
   case 'user_purpose':fields=[];role='current_user_intent';body='帮我表达';origin='explicit_workspace_action';break;
   case 'user_draft':fields=['current_intent'];role='current_user_statement';body=input.member.current_intent;origin='frozen_case_manual_input';break;
   case 'user_current_chat':fields=Object.keys(context);role='user_provided_contact_text';body=canonical(context);origin='frozen_case_manual_input';break;
   default:return invalid('source_kind');
  }
  if(source.factual_role!==role||source.text!==body||source.status!=='user_input')invalid('source_role_or_text');
  modelAliasMapping.push({model_evidence_id:source.evidence_id,evidence_id:stored.evidence_id});
  entries.push({...structuredClone(source),evidence_id:stored.evidence_id,text_sha256:digest(body),case_fields:fields,origin,source_ids:[],not_confirmed_memory:true});
 }
 if(!(time(input.started_at)<=time(input.captured_at)&&time(input.captured_at)<=time(input.response_started_at)))invalid('capture_response_order');
 const catalog:Row={schema_version:'reply-runtime-source-catalog-v2',case_id:input.case_id,repeat:input.repeat,arm:input.arm,
  case_sha256:digest(input.member),input_sha256:digest(projectedInput),request_sha256:request.sha256,request_hash_kind:request.hash_kind,
  scope:structuredClone(actualScope),request_id:request.request_id,entries,strategy_fields:{payload_field:'user_instruction',fields:strategy,citable:false},
  covered_input_fields:Object.keys(projectedInput).sort(),oracle_fields_excluded:ORACLE,
  captured_at:input.captured_at,capture_boundary:'request_received_before_supplier_response',stored_evidence_verified_after_completion:false};
 const catalogSha256=digest(catalog),attempt={attempt_id:input.attempt_id,attempt_id_kind:'collector_http_observation_not_ledger_id',
  request:{body:structuredClone(input.body),hash_kind:request.hash_kind,sha256:request.sha256,...request.raw_utf8!==undefined?{raw_utf8:request.raw_utf8}:{}},
  response_started_at:input.response_started_at,catalog,catalog_sha256:catalogSha256,
  model_alias_mapping:modelAliasMapping,source_binding:{...structuredClone(binding),
   attempt_binding_sha256:digest({source_commit:binding.source_commit,source_tree_sha256:binding.source_tree_sha256,workspace_clean:binding.workspace_clean,
    argv_sha256:binding.argv_sha256,request_sha256:request.sha256,catalog_sha256:catalogSha256})}};
 return {catalog,catalog_sha256:catalogSha256,model_alias_mapping:modelAliasMapping,attempt};
}
const observations=(attempts:unknown[]):Row[]=>attempts.map(value=>{const attempt=object(value)?value:{},request=object(attempt.request)?attempt.request:{};return {attempt_id:uuid(attempt.attempt_id)?attempt.attempt_id:null,request_sha256:hashString(request.sha256)?request.sha256:null,request_hash_kind:request.hash_kind==='wire_utf8_sha256'||request.hash_kind==='canonical_json_sha256'?request.hash_kind:null,catalog_sha256:hashString(attempt.catalog_sha256)?attempt.catalog_sha256:null,response_started_at:typeof attempt.response_started_at==='string'?attempt.response_started_at:null};});
const pending=(reason:string,attempts:unknown[]=[]):ReplyRuntimeSourceAudit=>({status:'undetermined',reason,binding_sha256:null,output_scope:'undetermined',allowed_citation_ids:[],attempt_count:attempts.length,request_id:null,attempt_ids:[],attempt_observations:observations(attempts)});
interface AttemptAudit {attempt:Row;request:Row;payload:Row;catalog:Row;expectedEntries:Row[];ids:string[];captured:number;responded:number;ended:number}
/** 每次实际发送分别复用完整输入/来源/时间合同；不修改原采集。 */
function auditAttempt(member:Row,row:Row,evidence:Row,attempt:Row,actualScope:Row,single:boolean):AttemptAudit {
 if(!object(attempt)||!uuid(attempt.attempt_id)||attempt.attempt_id_kind!=='collector_http_observation_not_ledger_id'||!object(attempt.request)||!object(attempt.request.body))invalid('attempt');
 const request=attempt.request;
 if(!['wire_utf8_sha256','canonical_json_sha256'].includes(request.hash_kind))invalid('request_hash_kind');
 if(request.hash_kind==='wire_utf8_sha256'){
  if(typeof request.raw_utf8!=='string')invalid('request_wire_missing');
  let parsed:unknown;try{parsed=JSON.parse(request.raw_utf8);}catch{return invalid('request_wire_json');}
  equal(parsed,request.body,'request_wire_body');
  if(digest(request.raw_utf8)!==request.sha256)invalid('request_wire_hash');
 }else if(digest(request.body)!==request.sha256||request.raw_utf8!==undefined)invalid('request_canonical_hash');
 if(single&&row.request_sha256!==request.sha256)invalid('record_request_hash');
 const {payload,input,context,strategy}=captureProjection(member,request.body);
 const catalog=attempt.catalog;
 const catalogVersion=object(catalog)?catalog.schema_version:null;
 if(!object(catalog)||!['reply-runtime-source-catalog-v1','reply-runtime-source-catalog-v2'].includes(catalogVersion)||digest(catalog)!==attempt.catalog_sha256)invalid('catalog_hash');
 const aliased=catalogVersion==='reply-runtime-source-catalog-v2';
 if(aliased&&(!object(attempt.source_binding)||Object.keys(attempt.source_binding).sort().join(',')!=='argv_sha256,attempt_binding_sha256,source_commit,source_tree_sha256,workspace_clean'
   ||!commitHash(attempt.source_binding.source_commit)||attempt.source_binding.source_commit!==row.commit
   ||!hashString(attempt.source_binding.source_tree_sha256)||typeof attempt.source_binding.workspace_clean!=='boolean'
   ||!hashString(attempt.source_binding.argv_sha256)||!hashString(attempt.source_binding.attempt_binding_sha256)
   ||attempt.source_binding.attempt_binding_sha256!==digest({source_commit:attempt.source_binding.source_commit,source_tree_sha256:attempt.source_binding.source_tree_sha256,
    workspace_clean:attempt.source_binding.workspace_clean,argv_sha256:attempt.source_binding.argv_sha256,request_sha256:request.sha256,catalog_sha256:attempt.catalog_sha256})))invalid('collector_source_binding');
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
 const modelIds=sources.map(source=>source.evidence_id);
 if(aliased?modelIds.some((id,index)=>id!==`c${index+1}`):modelIds.some(id=>!uuid(id)))invalid('source_identity_or_status');
 const mapping=aliased?attempt.model_alias_mapping:null;
 if(aliased&&(!Array.isArray(mapping)||mapping.length!==sources.length
   ||mapping.some((entry,index)=>!object(entry)||Object.keys(entry).sort().join(',')!=='evidence_id,model_evidence_id'
     ||entry.model_evidence_id!==`c${index+1}`||!uuid(entry.evidence_id))
   ||new Set(mapping.map(entry=>entry.evidence_id)).size!==mapping.length))invalid('model_alias_mapping');
 const expectedEntries:Row[]=sources.map((source,index)=>{
  const mapped=aliased?catalog.entries?.[index]:null,mappingEntry=aliased?mapping[index]:null;
  if(aliased&&(!object(mapped)||!uuid(mapped.evidence_id)||'model_evidence_id'in mapped||mappingEntry.evidence_id!==mapped.evidence_id)||!aliased&&source.status!=='user_input'||aliased&&source.status!=='user_input')invalid('source_identity_or_status');
  let fields:string[],role:string,body:string,origin:string;
  switch(source.kind){
   case 'user_purpose':fields=[];role='current_user_intent';body='帮我表达';origin='explicit_workspace_action';break;
   case 'user_draft':fields=['current_intent'];role='current_user_statement';body=member.current_intent;origin='frozen_case_manual_input';break;
   case 'user_current_chat':fields=Object.keys(context);role='user_provided_contact_text';body=canonical(context);origin='frozen_case_manual_input';break;
   default:return invalid('source_kind');
  }
  if(source.factual_role!==role||source.text!==body)invalid('source_role_or_text');
  return {...source,...aliased?{evidence_id:mapped!.evidence_id}:{},text_sha256:digest(body),case_fields:fields,origin,source_ids:[],not_confirmed_memory:true};
 });
 if(aliased&&new Set(expectedEntries.map(entry=>entry.evidence_id)).size!==expectedEntries.length)invalid('source_identity_or_status');
 equal(catalog.entries,expectedEntries,'catalog_entries');
 const ids=expectedEntries.map(source=>source.evidence_id);
 equal(payload.citation_policy,{allowed_evidence_ids:modelIds,additional_evidence_ids:'successful_history_tool_evidence_only',references_are_not_citations:true},'payload_citation_policy');
 return {attempt,request,payload,catalog,expectedEntries,ids,captured,responded,ended};
}
/** 最终结果只核验一次；多次恒定来源以原首catalog为PG锚。 */
function auditPersistence(evidence:Row,actualScope:Row,anchor:AttemptAudit,output:Row,mode:'model_run'|'reporter_fixture'):'complete_http_result'|'legacy_four_field_fixture'|ReplyRuntimeSourceAudit {
 const {attempt,expectedEntries,ids,ended}=anchor;
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
 return legacy?'legacy_four_field_fixture':'complete_http_result';
}
const MULTI_SCOPE='constant_workspace_noSkill_read_denied_v1' as const;
const DENIED='[Skill 不可用]';
const nonempty=(value:unknown):value is string=>typeof value==='string'&&!!value.trim();
const keysEqual=(value:unknown,keys:string[])=>object(value)&&canonical(Object.keys(value).sort())===canonical([...keys].sort());
/** 当前分支只认识原workspace声明状态；恒定相等不能证明新增状态或失效授权。 */
function narrowSourceState(sources:Row[]):boolean {
 return sources.every(source=>keysEqual(source,['evidence_id','kind','factual_role','text','status','selection_reason','timing','event','conditions','evolution','valid_at','invalid_at'])
  &&nonempty(source.selection_reason)&&['event','conditions','evolution','valid_at','invalid_at'].every(key=>source[key]===null)
  &&keysEqual(source.timing,['recorded_at','source_started_at','source_ended_at','source_time_complete','current_status','current_status_reason'])
  &&['recorded_at','source_started_at','source_ended_at'].every(key=>source.timing[key]===null)
  &&source.timing.source_time_complete===false&&source.timing.current_status==='current_unverified'&&nonempty(source.timing.current_status_reason));
}
/** 只认识当前read_file拒绝过渡；成功资料或其它工具不合并进来源。 */
function deniedTransition(row:Row,evidence:Row,audits:AttemptAudit[],output:Row):Row|null {
 const [first,second]=audits,initial=first.request.body,later=second.request.body;
 if(!Array.isArray(initial.messages)||!Array.isArray(later.messages)||later.messages.length!==initial.messages.length+2)return null;
 const plainText=(message:unknown,role:string,allowString=false)=>object(message)&&keysEqual(message,['role','content'])&&message.role===role
  &&(allowString&&nonempty(message.content)||Array.isArray(message.content)&&message.content.length>0&&message.content.every((block:unknown)=>object(block)&&keysEqual(block,['type','text'])&&block.type==='text'&&nonempty(block.text)));
 if(row.arm==='new'?(initial.messages.length!==1||!plainText(initial.messages[0],'user')):(initial.messages.length!==2||!plainText(initial.messages[0],'system')||!plainText(initial.messages[1],'user',true)))return null;
 equal(later.messages.slice(0,-2),initial.messages,'multi_prior_messages_changed');
 const configuration=(body:Row)=>Object.fromEntries(Object.entries(body).filter(([key])=>key!=='messages'));
 equal(configuration(later),configuration(initial),'multi_request_configuration_changed');
 const [assistant,result]=later.messages.slice(-2);let call:Row,args:Row,toolResult:unknown;
 if(row.arm==='new'){
  if(!keysEqual(assistant,['role','content'])||assistant.role!=='assistant'||!Array.isArray(assistant.content)||assistant.content.length!==1)return null;
  call=assistant.content[0];
  if(!keysEqual(call,['type','id','name','input'])||call.type!=='tool_use'||call.name!=='read_file')return null;
  args=call.input;
  if(!keysEqual(result,['role','content'])||result.role!=='user'||!Array.isArray(result.content)||result.content.length!==1)return null;
  const block=result.content[0];
  if(!keysEqual(block,['type','tool_use_id','content','is_error'])||block.type!=='tool_result'||block.is_error!==false)return null;
  if(!nonempty(call.id)||call.id!==block.tool_use_id)invalid('multi_tool_call_binding');
  if(canonical(block.content)!==canonical([{type:'text',text:DENIED}]))return null;
  toolResult=block.content;
 }else if(row.arm==='old'){
  if(!keysEqual(assistant,['content','role','tool_calls'])||assistant.role!=='assistant'||assistant.content!==null||!Array.isArray(assistant.tool_calls)||assistant.tool_calls.length!==1)return null;
  call=assistant.tool_calls[0];
  if(!keysEqual(call,['type','id','function'])||call.type!=='function'||!keysEqual(call.function,['name','arguments'])||call.function.name!=='read_file'||typeof call.function.arguments!=='string')return null;
  try{args=JSON.parse(call.function.arguments);}catch{return invalid('multi_tool_arguments');}
  if(!keysEqual(result,['content','role','tool_call_id'])||result.role!=='tool')return null;
  if(!nonempty(call.id)||call.id!==result.tool_call_id)invalid('multi_tool_call_binding');
  if(result.content!==DENIED)return null;
  toolResult=result.content;
 }else return null;
 if(!object(args)||!nonempty(args.file_path)||Object.keys(args).some(key=>!['file_path','offset','limit'].includes(key))||['offset','limit'].some(key=>args[key]!==undefined&&!Number.isSafeInteger(args[key])))return null;
 if(!Array.isArray(initial.tools))return null;
 const tools=initial.tools.map((tool:Row)=>row.arm==='old'?tool.function:tool),readers=tools.filter((tool:Row)=>object(tool)&&tool.name==='read_file');
 if(readers.length!==1)return null;
 const schema=row.arm==='old'?readers[0].parameters:readers[0].input_schema;
 equal(schema,{properties:{file_path:{type:'string'},offset:{default:0,type:'integer'},limit:{default:1000,type:'integer'}},required:['file_path'],type:'object'},'multi_read_file_schema');
 const partial=row.partial_observations;let observation:unknown;
 if(!object(partial)||!Array.isArray(partial.events))return null;
 if(!object(row.actual)||row.actual.status!=='succeeded'||!object(row.actual.result))return null;
 equal(row.actual.result,output,'multi_actual_result');
 if(row.arm==='new'){
  const knownEvents=['business_service_start','queue_acquire_start','queue_acquire_end','model_stream_start','model_stream_chunk','model_stream_end','business_service_returned_after_persistence'];
  // host HTTP request ID与持久reply_request_id属于不同域；只校验原host观察自身一致。
  if(partial.clock!=='host_request_relative_monotonic'||partial.events.some((event:unknown)=>!object(event)||!knownEvents.includes(event.type)||!uuid(event.request_id)||event.clock!==partial.clock))return null;
  if(new Set(partial.events.map((event:Row)=>event.request_id)).size!==1)return null;
  let prior=-1;
  for(const event of partial.events){if(typeof event.at_ms!=='number'||!Number.isFinite(event.at_ms)||event.at_ms<0||event.at_ms<prior)return null;prior=event.at_ms;}
  const toolEvents=partial.primary_tool_events;
  if(!Array.isArray(toolEvents)||toolEvents.length!==1)return null;
  const denied=toolEvents[0];
  if(!keysEqual(denied,['tool','outcome','scope'])||denied.tool!=='read_file'||denied.outcome!=='actual_runtime_scope_denied'||!keysEqual(denied.scope,['ownerId','contactId','scene']))return null;
  equal(denied.scope,{ownerId:evidence.scope.owner_id,contactId:evidence.scope.contact_id,scene:''},'multi_tool_scope');
  observation=denied;
 }else{
  if(!object(row.actual)||canonical(row.actual.partial_observations)!==canonical(partial))return null;
  const knownEvents=['business_service_start','context_build_start','context_build_end','context_validate_start','context_validate_end','sdk_complete_message','tool_start_read_file','actual_read_file_scope_denied','store_save_start','store_save_committed','business_service_returned_after_persistence'];
  // 原callback只观测type/at_ms；新增范围、工具或结果字段不能被已知type掩盖。
  if(partial.clock!=='python_service_relative_monotonic'||partial.events.some((event:unknown)=>!object(event)||!keysEqual(event,['type','at_ms'])||!knownEvents.includes(event.type)))return null;
  const starts=partial.events.filter((event:Row)=>event.type==='tool_start_read_file'),denials=partial.events.filter((event:Row)=>event.type==='actual_read_file_scope_denied');
  if(starts.length!==1||denials.length!==1)return null;
  let prior=-1;
  for(const event of partial.events){if(typeof event.at_ms!=='number'||!Number.isFinite(event.at_ms)||event.at_ms<0||event.at_ms<prior)return null;prior=event.at_ms;}
  const started=partial.events.indexOf(starts[0]),ended=partial.events.indexOf(denials[0]);
  if(started>=ended||!partial.events.slice(0,started).some((event:Row)=>event.type==='sdk_complete_message')||!partial.events.slice(ended+1).some((event:Row)=>event.type==='sdk_complete_message'))return null;
  observation={start:starts[0],denial:denials[0],clock:partial.clock};
 }
 if(!Array.isArray(row.physical_attempts)||row.physical_attempts.length!==2)return null;
 for(const [index,trace]of row.physical_attempts.entries()){
  const audited=audits[index];
  if(!object(trace)||trace.attempt_id!==audited.attempt.attempt_id||trace.attempt_identity_kind!==audited.attempt.attempt_id_kind||trace.case_id!==row.case_id||trace.repeat!==row.repeat||trace.arm!==row.arm)invalid('multi_physical_trace_binding');
  equal(trace.request,audited.request.body,'multi_physical_request');
  equal(trace.evidence,audited.payload.evidence,'multi_physical_sources');
  equal(trace.source_catalog,audited.catalog,'multi_physical_catalog');
  if(trace.request_sha256!==audited.request.sha256||trace.request_hash_kind!==audited.request.hash_kind||trace.source_catalog_sha256!==audited.attempt.catalog_sha256||trace.response_started_at!==audited.attempt.response_started_at)invalid('multi_physical_hash_binding');
  if(!(audited.captured<=time(trace.supplier_received_at)&&time(trace.supplier_received_at)<=audited.responded))invalid('multi_physical_order');
  if(audited.request.hash_kind==='wire_utf8_sha256'&&trace.raw_utf8!==audited.request.raw_utf8)invalid('multi_physical_wire');
 }
 const proof={schema_version:'reply-multi-attempt-derived-proof-v1',contract_scope:MULTI_SCOPE,internal_consistency_only:true,derived_after_capture:true,
  runtime_sources_sha256:digest(evidence),attempt_bundle:audits.map(audit=>({attempt_id:audit.attempt.attempt_id,request_sha256:audit.request.sha256,catalog_sha256:audit.attempt.catalog_sha256})),
  transition_sha256:digest({call_id:call.id,tool:'read_file',arguments:args,result:toolResult,observation}),partial_observations_sha256:digest(partial),actual_result_sha256:digest(row.actual.result),physical_trace_sha256:digest(row.physical_attempts),
  real_model_quality_verified:false,production_switch_approved:false};
 return {...proof,sha256:digest(proof)};
}
/** 保留单attempt合同；只为两次恒定workspace/noSkill拒绝过渡增加内部一致性分支。 */
export function auditReplyRuntimeSources(member:Row,row:Row,output:Row,mode:'model_run'|'reporter_fixture'='model_run'):ReplyRuntimeSourceAudit {
 const evidence=row.runtime_sources;
 if(evidence===null||evidence===undefined)return pending('runtime_sources_missing');
 if(!object(evidence)||evidence.schema_version!=='reply-runtime-sources-v1'||!Array.isArray(evidence.attempts))invalid('sources_structure');
 if(evidence.attempts.length!==row.physical_calls)invalid('physical_attempt_count');
 if(![1,2].includes(evidence.attempts.length))return pending('runtime_multiple_attempts_unsupported',evidence.attempts);
 const multiple=evidence.attempts.length===2;
 // 没有窄合同所需的原业务观察和物理trace，沿用原多attempt未定结果。
 if(multiple&&(!object(row.actual)||!object(row.partial_observations)||!Array.isArray(row.physical_attempts)))return pending('runtime_multiple_attempts_unsupported',evidence.attempts);
 if(multiple&&((row.terminal_status??row.actual?.status)!=='succeeded'||row.actual?.status!==undefined&&row.actual.status!=='succeeded'))return pending('runtime_multi_terminal_unsupported',evidence.attempts);
 if(multiple&&row.request_sha256!==null)invalid('multi_record_request_hash');
 const actualScope=scope(evidence.scope);equal(scope(row.scope),actualScope,'record_scope');
 if(!uuid(evidence.request_id))invalid('request_id');
 const audits:AttemptAudit[]=evidence.attempts.map((attempt:Row)=>auditAttempt(member,row,evidence,attempt,actualScope,!multiple));
 let derived:Row|null=null;
 if(multiple){
  if(new Set(audits.map(audit=>audit.attempt.attempt_id)).size!==2)invalid('multi_attempt_reused');
  if(audits[0].responded>audits[1].captured)invalid('multi_attempt_order');
  equal(audits[1].expectedEntries,audits[0].expectedEntries,'multi_sources_changed');
  if(!narrowSourceState(audits[0].payload.evidence))return pending('runtime_multi_source_state_unsupported',evidence.attempts);
  derived=deniedTransition(row,evidence,audits,output);
  if(!derived)return pending('runtime_multi_transition_unsupported',evidence.attempts);
 }
 const outputScope=auditPersistence(evidence,actualScope,audits[0],output,mode);
 if(typeof outputScope!=='string')return outputScope;
 if(multiple&&outputScope!=='complete_http_result')return pending('runtime_multi_complete_output_required',evidence.attempts);
 return {status:'verified',output_scope:outputScope,binding_sha256:digest(evidence),allowed_citation_ids:audits[0].ids,attempt_count:audits.length,request_id:evidence.request_id,attempt_ids:audits.map(audit=>audit.attempt.attempt_id),attempt_observations:observations(evidence.attempts),
  ...derived?{contract_scope:MULTI_SCOPE,derived_proof:derived}:{}};
}
/** 只为已完成来源审计构造公共subject片段；摘要不认证采集历史。单attempt字段保持原样。 */
export function replyRuntimeSourceSubjectBinding(audit:ReplyRuntimeSourceAudit):ReplyRuntimeSourceSubjectBinding|null {
 if(audit.status!=='verified')return null;
 if(!hashString(audit.binding_sha256))invalid('subject_runtime_hash');
 const binding={runtime_sources_sha256:audit.binding_sha256};
 if(audit.attempt_count===1){if(audit.contract_scope!==undefined||audit.derived_proof!==undefined)invalid('subject_single_proof');return binding;}
 const proof=audit.derived_proof;
 if(audit.attempt_count!==2||audit.contract_scope!==MULTI_SCOPE||!object(proof)||!keysEqual(proof,['schema_version','contract_scope','internal_consistency_only','derived_after_capture','runtime_sources_sha256','attempt_bundle','transition_sha256','partial_observations_sha256','actual_result_sha256','physical_trace_sha256','real_model_quality_verified','production_switch_approved','sha256']))invalid('subject_derived_proof');
 if(proof.schema_version!=='reply-multi-attempt-derived-proof-v1'||proof.contract_scope!==MULTI_SCOPE||proof.internal_consistency_only!==true||proof.derived_after_capture!==true||proof.real_model_quality_verified!==false||proof.production_switch_approved!==false||proof.runtime_sources_sha256!==audit.binding_sha256)invalid('subject_proof_contract');
 const {sha256,...originalProof}=proof;
 if(!hashString(sha256)||digest(originalProof)!==sha256||['transition_sha256','partial_observations_sha256','actual_result_sha256','physical_trace_sha256'].some(key=>!hashString(proof[key])))invalid('subject_proof_hash');
 if(!Array.isArray(proof.attempt_bundle)||proof.attempt_bundle.length!==2||audit.attempt_ids.length!==2||audit.attempt_observations.length!==2)invalid('subject_attempt_bundle');
 for(const [index,attempt]of proof.attempt_bundle.entries()){
  if(!keysEqual(attempt,['attempt_id','request_sha256','catalog_sha256'])||!uuid(attempt.attempt_id)||!hashString(attempt.request_sha256)||!hashString(attempt.catalog_sha256)||attempt.attempt_id!==audit.attempt_ids[index]||attempt.attempt_id!==audit.attempt_observations[index].attempt_id||attempt.request_sha256!==audit.attempt_observations[index].request_sha256||attempt.catalog_sha256!==audit.attempt_observations[index].catalog_sha256)invalid('subject_attempt_binding');
 }
 return {...binding,runtime_source_proof_sha256:sha256};
}
