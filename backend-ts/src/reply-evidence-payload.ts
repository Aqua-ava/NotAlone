/** 生成模型实际证据投影，供窗口计量与出站共同使用。 */
import {ReplyError} from './reply-contract.ts';
import type {ReplyContextEvidence} from './reply-context-types.ts';
const roles:Record<string,string>={user_draft:'current_user_statement',user_current_chat:'user_provided_contact_text',message:'source_message_statement',confirmed_memory:'sourced_contact_memory',owner_memory:'sourced_owner_memory',pending_candidate:'unconfirmed_reference',continued_candidate:'previous_assistant_candidate',user_purpose:'current_user_intent'};
export function projectReplyEvidence(e:ReplyContextEvidence,basisChanges:readonly Record<string,unknown>[]=[]){
 if(!roles[e.kind])throw new ReplyError('reply_context_unavailable');
 return {evidence_id:e.evidence_id,kind:e.kind,factual_role:roles[e.kind],text:e.text,
  ...(e.kind==='message'?{speaker_role:e.speaker_role}:{}),status:e.status,selection_reason:e.selection_reason,
  timing:structuredClone(e.timing),event:structuredClone(e.event),conditions:structuredClone(e.conditions),evolution:structuredClone(e.evolution),valid_at:e.valid_at,invalid_at:e.invalid_at,
  ...(e.kind==='continued_candidate'&&basisChanges.length?{basis_changes:structuredClone(basisChanges)}:{})};
}
