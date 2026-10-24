/** 只处理显式提供的合成采集；哈希只能证明内部一致性，不能认证历史采集。 */
import {createHash,createHmac} from 'node:crypto';
import {auditReplyRuntimeSources} from '../src/reply-comparison-sources.ts';
const INPUT=['current_intent','available_facts','unknowns','allowed_changes','current_message','recent_context'];
const SOURCE_FIELDS=['evidence_id','kind','factual_role','text','status','selection_reason','timing','event','conditions','evolution','valid_at','invalid_at','text_sha256','case_fields','origin','source_ids','not_confirmed_memory'];
const TIME_FIELDS=['recorded_at','source_started_at','source_ended_at','source_time_complete','current_status','current_status_reason'];
const DIMENSIONS=[['evidence_correctness','依据正确性'],['intent_preservation','当前意图保持'],['no_unsupported_content','无新增事实或承诺'],['relationship_fit','关系适配'],['chinese_usability','中文可编辑可用性']];
const ID_FIELDS=new Set(['owner_id','contact_id','conversation_binding_id','synthetic_scope_id','case_id','request_id','reply_request_id','request_key','attempt_id','physical_attempt_id','blind_id','original_blind_id','candidate_id','message_id','anchor_message_id','excluded_message_ids','evidence_id','evidence_ids','allowed_evidence_ids','source_id','source_ids','citation_ids','permit_id','permit_ids','reservation_id','ledger_id','ledger_entry_id','call_id','model_call_id','session_id','skill_id','skill_version_id','used_skill_version_id','expression_preference_ids','measurement_id','model_id','ownerId','contactId','conversationBindingId','requestId','attemptId','blindId','candidateId','messageId','sourceId','permitId','ledgerId','ledgerEntryId']);
const ID_CONTAINERS=new Set(['request','requests','reply_request','request_snapshot','attempt','attempts','physical_attempt','physical_attempts','permit','permits','model_permit','model_call_permit','ledger','ledger_entry','ledger_entries','model_call','model_calls','candidate','candidates','message','messages','source','sources','evidence','tool_calls','response']);
const SDK_ID_FIELDS=new Set(['tool_use_id','tool_call_id','toolUseId','toolCallId','_request_id','response_id','responseId','requestID','sdk_request_id']);
const SDK_REQUEST_ID_HEADERS=new Set(['request-id','x-request-id']);
const SDK_RESPONSE_OBJECTS=new Set(['chat.completion','chat.completion.chunk','response']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function fail(reason){throw Error('blind_packet_invalid:'+reason);}
export function canonical(value){
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(object(value))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
 return fail('non_json_value');
}
export const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const same=(a,b,reason)=>{if(canonical(a)!==canonical(b))fail(reason);};
const exactKeys=(value,keys,reason)=>{if(!object(value))fail(reason);same(Object.keys(value).sort(),[...keys].sort(),reason);};
/** 先汇总全部记录的真实身份字段；不把正文中的普通UUID或JSON文本当身份声明。 */
function protectedIdentities(records){
 const found=new Set();
 const add=value=>{
  if(value===null||value===undefined)return;
  if(Array.isArray(value)){value.forEach(add);return;}
  // SDK工具schema会以同名键描述类型；它不是实际身份值，仍继续递归查其子节点。
  if(typeof value==='string'&&value.length)found.add(value);
 };
 const visit=(value,container)=>{
  if(Array.isArray(value)){value.forEach(item=>visit(item,container));return;}
  if(!object(value))return;
  // Anthropic结构化内容块的调用身份；不解析text/input等正文字符串。
  if(container==='content'&&['tool_use','server_tool_use'].includes(value.type))add(value.id);
  // 只认明确的SDK响应envelope，不把普通正文或schema对象按id猜测身份。
  if(value.type==='message'&&Array.isArray(value.content)||SDK_RESPONSE_OBJECTS.has(value.object))add(value.id);
  for(const [key,child] of Object.entries(value)){
   if(ID_FIELDS.has(key)||SDK_ID_FIELDS.has(key)||SDK_REQUEST_ID_HEADERS.has(key.toLowerCase())||key==='id'&&ID_CONTAINERS.has(container))add(child);
   visit(child,key);
  }
 };
 visit(records,'records');return [...found];
}
function sourcesFor(row){
 return row.runtime_sources.attempts[0].catalog.entries.map((source,index)=>{
  exactKeys(source,SOURCE_FIELDS,'source_fields_unknown');
  exactKeys(source.timing,TIME_FIELDS,'source_time_fields_unknown');
  if(source.source_ids.length!==0)fail('source_dependencies_unsupported');
  // 来源的语义时间与状态属于评分依据；采集时间、运行ID和环境时序不进入此投影。
  return {source_id:'S'+(index+1),kind:source.kind,factual_role:source.factual_role,text:source.text,status:source.status,selection_reason:source.selection_reason,timing:structuredClone(source.timing),event:structuredClone(source.event),conditions:structuredClone(source.conditions),evolution:structuredClone(source.evolution),valid_at:source.valid_at,invalid_at:source.invalid_at,not_confirmed_memory:source.not_confirmed_memory};
 });
}
/** 显式私密种子控制每对A/B、跨对顺序及不含臂名称的ID；种子不得交给评审者。 */
export function createBlindPacket({capture,dataset,seed}){
 if(typeof seed!=='string'||!/^[a-f0-9]{64}$/.test(seed))fail('private_seed_required');
 if(capture.schema_version!=='reply-local-paired-collector-v1'||capture.protocol_version!=='migration-comparison-v1'||capture.evidence_kind!=='localhost_fake_provider_actual_business_pipelines'||capture.synthetic_only!==true||capture.real_model_quality_verified!==false||capture.production_switch_approved!==false||!Array.isArray(capture.records)||capture.records.length===0||!Array.isArray(dataset.cases))fail('synthetic_capture_required');
 const rawIdentities=protectedIdentities(capture.records);
 const secret=value=>createHmac('sha256',Buffer.from(seed,'hex')).update(canonical(value)).digest('hex');
 const members=new Map(dataset.cases.map(member=>[member.case_id,member]));
 if(members.size!==dataset.cases.length)fail('duplicate_case');
 const pairs=new Map(),recordKeys=new Set(),rawBlindIds=new Set(),requestIds=new Set(),attemptIds=new Set();
 const prepared=capture.records.map(row=>{
  const member=members.get(row.case_id),key=canonical([row.case_id,row.repeat,row.arm]);
  if(!member||!['old','new'].includes(row.arm)||![1,2,3].includes(row.repeat)||recordKeys.has(key)||typeof row.blind_id!=='string'||!row.blind_id||rawBlindIds.has(row.blind_id))fail('record_identity');
  recordKeys.add(key);rawBlindIds.add(row.blind_id);
  if(Object.keys(member).some(key=>![...INPUT,'case_id','split','tags','forbidden_additions'].includes(key)))fail('case_semantics_unknown');
  const input=Object.fromEntries(INPUT.filter(key=>key in member).map(key=>[key,member[key]]));
  if(row.case_sha256!==digest(member)||row.input_sha256!==digest(input))fail('material_binding');
  if(row.actual?.status!=='succeeded'||row.logical_calls!==1)fail('non_success_requires_separate_failure_review');
  same(row.output,row.actual.result,'raw_output_disagreement');
  if(!Array.isArray(row.output.candidates)||new Set(row.output.candidates.map(candidate=>candidate.candidate_id)).size!==row.output.candidates.length)fail('duplicate_candidate_identity');
  if(row.output.basis_changes!==undefined&&(!Array.isArray(row.output.basis_changes)||row.output.basis_changes.length!==0))fail('basis_changes_semantics_unsupported');
  const audit=auditReplyRuntimeSources(member,row,row.output);
  if(audit.status!=='verified'||audit.output_scope!=='complete_http_result')fail('complete_source_audit_required:'+audit.reason);
  if(requestIds.has(audit.request_id)||audit.attempt_ids.some(id=>attemptIds.has(id)))fail('cross_record_identity_reused');
  requestIds.add(audit.request_id);audit.attempt_ids.forEach(id=>attemptIds.add(id));
  if(row.deterministic_checks?.status!=='passed'||row.deterministic_checks.output_sha256!==digest(row.output)||row.deterministic_checks.source_binding_sha256!==row.input_sha256||row.deterministic_checks.runtime_sources_sha256!==audit.binding_sha256)fail('deterministic_binding');
  const sources=sourcesFor(row),originalSources=row.runtime_sources.attempts[0].catalog.entries;
  const sourceMap=new Map(originalSources.map((source,index)=>[source.evidence_id,sources[index].source_id]));
  const candidateMap=[],messageMap=[];
  const candidates=row.output.candidates.map((candidate,index)=>{
   const candidate_id='C'+(index+1);candidateMap.push({alias:candidate_id,original:candidate.candidate_id});
   return {candidate: candidate_id,text:candidate.text,basis:candidate.basis,risk_notes:structuredClone(candidate.risk_notes),messages:candidate.messages.map((message,m)=>{
    const message_id=candidate_id+'M'+(m+1);messageMap.push({candidate:candidate_id,alias:message_id,original:message.message_id});return {message:message_id,text:message.text};
   }),citation_ids:candidate.citation_ids.map(id=>{if(!sourceMap.has(id))fail('citation_missing_source');return sourceMap.get(id);})};
  });
  const pair=canonical([row.case_id,row.repeat]);
  if(!pairs.has(pair))pairs.set(pair,[]);pairs.get(pair).push(row.arm);
  const pair_id='P'+secret(['pair',pair]).slice(0,24),blind_id='R'+secret(['record',key]).slice(0,24);
  const first=secret(['label',pair]).slice(0,8),aArm=parseInt(first,16)%2===0?'old':'new';
  const semantic={pair_id,blind_id,label:row.arm===aArm?'A':'B',input:structuredClone(input),case_constraints:{forbidden_additions:structuredClone(member.forbidden_additions??[])},candidates,sources};
  const raw_output_sha256=digest(row.output);
  const review_subject_sha256=digest({semantic,raw_output_sha256,runtime_sources_sha256:audit.binding_sha256,case_sha256:row.case_sha256,input_sha256:row.input_sha256});
  const visible={...semantic,review_subject_sha256};
  // 任一记录的身份都不能经当前输入、候选或来源原文泄漏；命中时拒绝，不删改原文。
  const semanticText=canonical(semantic);
  if(rawIdentities.some(id=>semanticText.includes(id)))fail('raw_identity_in_semantic_text');
  const reporter_subject_sha256=digest({blind_id:row.blind_id,case_sha256:row.case_sha256,input_sha256:row.input_sha256,output:row.output,runtime_sources_sha256:audit.binding_sha256,request_sha256:row.request_sha256});
  return {sort:secret(['shuffle',key]),visible,binding:{blind_id,pair_id,label:visible.label,original_blind_id:row.blind_id,case_id:row.case_id,repeat:row.repeat,arm:row.arm,case_sha256:row.case_sha256,input_sha256:row.input_sha256,raw_output_sha256,runtime_sources_sha256:audit.binding_sha256,request_sha256:row.request_sha256,reporter_subject_sha256,review_subject_sha256,visible_sha256:digest(visible),aliases:{candidates:candidateMap,messages:messageMap,sources:[...sourceMap].map(([original,alias])=>({alias,original}))}}};
 });
 for(const arms of pairs.values())if(arms.length!==2||new Set(arms).size!==2)fail('complete_pair_required');
 prepared.sort((a,b)=>a.sort.localeCompare(b.sort));
 const visible={schema_version:'reply-blind-packet-v1',protocol_version:'migration-comparison-v1',synthetic_only:true,fake_supplier_response:true,real_model_quality_verified:false,production_switch_approved:false,
  instructions:{language:'中文',independence:'两位独立审阅者分别评全部候选；不要查看运行记录或绑定清单。分歧交第三位复核。',reviewer_identity:'记录实际 reviewer_type、reviewer_model、reviewer_version，Agent 不记成人工。',binding:'每条评审必须绑定 blind_id、review_subject_sha256 和候选别名。未知写 null 并解释。',coverage:'本包仅呈现显式提供的完整成功对，不包含全量分母或资格判定。失败或不成对输入整体拒绝，不能用本包替代完整报告。',scores:{dimensions:DIMENSIONS.map(([key,label])=>({key,label})),scale:{0:'不可用或错误',1:'需要实质改写',2:'可小改使用'},group_pass:'全部候选前三维均为2，后两维均无0且逐维组内均分至少1.5；严重假事、错人、无依据承诺新增数为0。'},source_caution:'本次意图和一次性策略不能冒充关系事实；来源引用有效不代表内容语义已核验。',qualification:'这是合成本机替身的呈现练习，不认证真实模型质量、历史采集真实性或切换资格。'},items:prepared.map(row=>row.visible)};
 const binding={schema_version:'reply-blind-binding-v1',reviewer_visible:false,seed,synthetic_only:true,fake_supplier_response:true,capture_canonical_sha256:digest(capture),dataset_canonical_sha256:digest(dataset),visible_sha256:digest(visible),internal_consistency_only:true,real_model_quality_verified:false,production_switch_approved:false,items:prepared.map(row=>row.binding)};
 return {visible,binding};
}
/** 交付或回收评审前重建全部绑定；删字段、换正文或换原始DTO均明确拒绝。 */
export function verifyBlindPacket({visible,binding,capture,dataset}){
 const expected=createBlindPacket({capture,dataset,seed:binding.seed});
 same(visible,expected.visible,'visible_packet_changed');same(binding,expected.binding,'private_binding_changed');
 return {status:'verified_internal_consistency_only',items:visible.items.length,real_model_quality_verified:false,production_switch_approved:false};
}
/** 只恢复调用者已提交评审的对象绑定；不生成评分，也不认证评审者是否实际独立。 */
export function bindSubmittedReview({visible,binding,capture,dataset,review}){
 verifyBlindPacket({visible,binding,capture,dataset});
 const item=visible.items.find(item=>item.blind_id===review?.blind_id),row=binding.items.find(item=>item.blind_id===review?.blind_id);
 if(!item||!row||review.subject_sha256!==item.review_subject_sha256||review.independent!==true||review.blinded!==true||!['human','agent'].includes(review.reviewer_type))fail('submitted_review_binding');
 if(!Array.isArray(review.candidates)||review.candidates.length!==item.candidates.length||new Set(review.candidates.map(candidate=>candidate.candidate)).size!==item.candidates.length)fail('submitted_review_candidates');
 const candidates=review.candidates.map(candidate=>{
  const original=row.aliases.candidates.find(entry=>entry.alias===candidate.candidate);
  if(!original||'candidate_id'in candidate)fail('submitted_review_candidate_alias');
  const {candidate:alias,...submitted}=candidate;return {...structuredClone(submitted),candidate_id:original.original};
 });
 return {...structuredClone(review),blind_id:row.original_blind_id,subject_sha256:row.reporter_subject_sha256,candidates};
}
