import {projectReplyEvidence} from './reply-evidence-payload.ts';
/** 生成输入的显式投影；来源资格由同事务上下文守卫验证，不把内部快照直接发送给模型。 */
import {stringifyJson} from './host-json.ts';
import {ReplyError,type ReplyRequestInput} from './reply-contract.ts';
import type {BuiltReplyContext} from './reply-context-types.ts';
import {assistantDiscussionPayload,continuationReferencePayload,type ReplyDiscussionContext} from './reply-discussion-context.ts';
import {replyCandidateAdmissibility} from './reply-candidate-admissibility.ts';
import {aliasReplyEvidenceReferences,type EvidenceAliases} from './reply-evidence-alias.ts';
import type {AuthenticatedContinuation} from './reply-assistant-guards.ts';
export interface ReplyPayloadInput {
 request:ReplyRequestInput;
 context:BuiltReplyContext;
 preferences?:readonly {preference_id:string;revision:number|bigint;text:string;scope:{contact_id:string|null;reply_mode:string|null}}[];
 discussion?:ReplyDiscussionContext|null;
 /** 只能来自08可信接缝，公开解析器拒绝这些字段。 */
 authenticated?:AuthenticatedContinuation;
 aliases?:EvidenceAliases;
}

const unavailable=():never=>{throw new ReplyError('reply_context_unavailable');};
function sourceTime(value:unknown):bigint|null {
 if(value==null)return null;
 if(typeof value!=='string')return unavailable();
 const millis=Date.parse(value);if(!Number.isFinite(millis))return unavailable();
 // Date只保留毫秒；旧Python按微秒排序，同一毫秒内不能倒置消息。
 const fraction=value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1]??'';
 return BigInt(millis)*1000n+BigInt(fraction.padEnd(6,'0').slice(3,6));
}
export function replyFidelityContract(payload:Record<string,unknown>){
 const mode=payload.input_mode as string;
 const source:Record<string,string>={workspace:'draft_text',rewrite_draft:'draft_text',reply_to_message:'confirmed_direction',reply_to_pasted_text:'confirmed_direction',initiate_conversation:'confirmed_purpose'};
 const field=source[mode],exploring=mode==='workspace'&&payload.workspace_action==='suggest';
 if(!exploring&&(!field||typeof payload[field]!=='string'||!(payload[field] as string).trim()))return unavailable();
 return {version:'fidelity-v3',current_intent:payload[field]&&!exploring?{source:field,text:payload[field]}:null,
 priority:['current_explicit_intent','expression_instruction','history_and_memory','skill_strategy'],
 instruction_scope:exploring?'suggest_options_for_user_selection':mode==='workspace'?'compose_recipient_text_from_intent':'expression_only',
 conflict_action:'preserve_current_intent_and_explain',content_boundary:{
 output_scope:['candidate_text','basis','risk_notes'],current_user_statement:'user_declared_not_externally_verified',
 source_statement:'limited_to_sourced_content_and_time',conditional_advice:'not_a_user_fact_or_commitment',
 unknown:'retain_unknown_without_filling_in',historical_state:'not_automatically_current',
 missing_history:'does_not_establish_contact_gap_or_motive',citation_validity:'does_not_prove_semantic_support',
 candidate_admissibility:'rewrite_or_omit_known_conflicts_before_return',
 known_value_confirmation:'ask_with_latest_sourced_value_without_claiming_current_truth',
 multiple_confirmations:'include_latest_sourced_value_for_each_known_item_not_just_one',
 recipient_text:'exclude_internal_selection_and_composition_instructions'}};
}
export function buildReplyPayload({request,context,preferences=[],discussion=null,authenticated,aliases}:ReplyPayloadInput){
 const c=request.content;
 if(request.contact_id!==context.scope.contact_id)return unavailable();
 const continuation=context.continuation_basis;
 if(request.continued_from_candidate_id&&(!continuation||continuation.candidate_id!==request.continued_from_candidate_id
   ||continuation.scope.owner_id!==context.scope.owner_id||continuation.scope.contact_id!==context.scope.contact_id
   ||continuation.conversation_binding_id!==context.conversation_binding_id
   ||!context.evidence.some(e=>e.kind==='continued_candidate'&&e.evidence_id===continuation.candidate_id&&e.text===continuation.text)))return unavailable();
 if(c.type==='rewrite_draft'&&!c.include_relationship_context&&context.evidence.some(e=>['message','confirmed_memory','owner_memory','pending_candidate'].includes(e.kind)))return unavailable();
 const payload:Record<string,unknown>={};
 if(c.type==='reply_to_message')Object.assign(payload,{input_mode:c.type,current_text:context.current_text,confirmed_direction:c.direction,direction_source:c.direction_source});
 else if(c.type==='initiate_conversation')Object.assign(payload,{input_mode:c.type,confirmed_purpose:c.purpose,purpose_source:c.purpose_source});
 else {
  Object.assign(payload,{input_mode:c.type,draft_text:c.draft_text,user_instruction:c.user_instruction??null,include_relationship_context:c.include_relationship_context});
  if(c.input_kind==='workspace')Object.assign(payload,{input_mode:'workspace',workspace_action:c.workspace_action,context_text:c.context_text??null});
  if(c.input_kind==='current_chat'){
   delete payload.draft_text;Object.assign(payload,{input_mode:'reply_to_pasted_text',current_text:c.draft_text,confirmed_direction:c.pasted_direction,direction_source:'direct_input'});
  }
 }
 if(c.type!=='rewrite_draft')Object.assign(payload,{understanding_correction:c.understanding_correction??null,user_instruction:c.user_instruction??null,clarification_answer:c.clarification_answer??null});
 payload.skill_selection=request.skill_version_id?{mode:'user',version_id:aliases?.skillFor(request.skill_version_id)??'k1'}:{mode:request.skill_disabled?'disabled':'auto'};
 if(request.allow_incomplete_history)payload.history_coverage_warning='历史覆盖不完整：用户选择基于已同步部分继续，不能据此声称拥有完整语境。';
 Object.assign(payload,{expression_actor:'owner',recipient_role:'contact',message_order:'known_times_ascending_unknown_last_equal_unordered'});
 const visible=context.evidence.filter(e=>e.model_visible);
 const messages=visible.filter(e=>e.kind==='message').map(e=>({e,time:sourceTime(e.timing.source_started_at)})).sort((a,b)=>a.time===b.time?0:a.time===null?1:b.time===null?-1:a.time<b.time?-1:1);
 let index=0;
 const ordered=visible.map(original=>original.kind==='message'?messages[index++].e:original);
 if(aliases)for(const e of ordered)aliases.aliasFor(e.evidence_id);
 const evidence=ordered.map(e=>projectReplyEvidence(e,continuation?.candidate_id===e.evidence_id?continuation.basis_changes:[],aliases));
 const fidelity_contract=replyFidelityContract(payload);
 if(preferences.length){
  payload.expression_preferences=preferences.map(e=>({preference_id:aliases?.referenceFor(e.preference_id)??'r1',revision:e.revision,text:e.text,
   scope:{contact_id:e.scope.contact_id?aliases?.referenceFor(e.scope.contact_id)??'r1':null,reply_mode:e.scope.reply_mode},factual_role:'expression_preference',priority:'below_current_intent'}));
  fidelity_contract.priority.splice(2,0,'long_term_expression_preference');
 }
 if(discussion&&(discussion.scope.owner_id!==context.scope.owner_id||discussion.scope.contact_id!==context.scope.contact_id||discussion.request_key!==request.idempotency_key))return unavailable();
 const reference=continuationReferencePayload(discussion,context.scope,request.continued_from_candidate_id,{type:c.type,...typeof c.draft_text==='string'?{draft_text:c.draft_text}:{}},authenticated);
 if(reference)payload.continuation_reference=aliases?aliasReplyEvidenceReferences(reference,aliases):reference;
 const recentOnly=c.type==='rewrite_draft'&&c.input_kind==='workspace'&&Array.isArray(c.excluded_message_ids)&&c.excluded_message_ids.length>0;
 if(discussion&&!recentOnly){
  const projected=assistantDiscussionPayload(discussion);
  payload.assistant_discussion=aliases?aliasReplyEvidenceReferences(projected,aliases):projected;
 }
 return {...payload,evidence,citation_policy:{allowed_evidence_ids:evidence.map(e=>e.evidence_id),additional_evidence_ids:'successful_history_tool_evidence_only',references_are_not_citations:true},fidelity_contract,risk_notes:[...context.risk_notes]};
}
export function replyPayloadText(input:ReplyPayloadInput):string{
 const {limit,unknowns}=replyCandidateAdmissibility(input.context);
 const unknown=limit===1?`\n本轮明确未知（不得在候选正文中填写成事实、原因、心理、间隔、动作或安排）：${unknowns.join('；')}。只返回一条不依赖这些未知的候选。`:'';
 return stringifyJson(buildReplyPayload(input))+`\n\n本轮候选数量上限是 ${limit} 条。${unknown}`;
}
