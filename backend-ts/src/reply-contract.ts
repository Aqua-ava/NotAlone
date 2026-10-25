/** 回复边界只校验数据结构，不让模型决定联系人或确认事实。 */
import {createHash} from 'node:crypto';
import type {AuthenticatedContinuation} from './reply-assistant-guards.ts';
export class ReplyError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status=409) { super(code); this.code=code; this.status=status; }
}
export type ReplyContent = Record<string, unknown> & {type:'reply_to_message'|'rewrite_draft'|'initiate_conversation'};
export interface ReplyRequestInput {
  contact_id:string; idempotency_key:string; content:ReplyContent;
  continued_from_candidate_id:string|null; skill_version_id:string|null;
  suggestion:{task_id:string;input_version:string;suggestion_id:string}|null;
  allow_incomplete_history:boolean; skill_disabled:boolean; scene:string|null;
  expected_input_version_id?:string;
}
export interface ReplyCandidateInput {text:string;basis:string;citation_ids:string[];risk_notes:string[];messages:string[]}
export const record=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const count=(v:string)=>[...v].length;
const nonblank=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0;
/** 只识别可信内部的完整累计值；真正的A身份、metadata及digest仍由事务守卫授权。 */
function accumulatedInstruction(value:unknown,authenticated?:AuthenticatedContinuation):boolean {
  const requirements=authenticated?.continuation?.effective_requirements;
  return typeof value==='string'&&Array.isArray(requirements)&&requirements.length>0
    &&requirements.every(nonblank)&&value===requirements.join('；');
}
// 与 Python UUID 接受的 canonical、hex、URN 和括号表示保持一致。
export function replyUuid(v:unknown):string {
  if(typeof v!=='string')throw new ReplyError('reply_request_invalid',400);
  let text=v.replace('urn:','').replace('uuid:','').replace(/^\{+|\}+$/g,'').replaceAll('-','');
  if(!/^[0-9a-fA-F]{32}$/.test(text))throw new ReplyError('reply_request_invalid',400);
  text=text.toLowerCase();return `${text.slice(0,8)}-${text.slice(8,12)}-${text.slice(12,16)}-${text.slice(16,20)}-${text.slice(20)}`;
}
export function parseReplyRequest(value:unknown,authenticated?:AuthenticatedContinuation):ReplyRequestInput {
  const invalid=():never=>{throw new ReplyError('reply_request_invalid',400);};
  if(!record(value)||!record(value.content))return invalid();
  // 只有已认证的内部08接缝可以建立续写/讨论资格，公开正文不能自证。
  if(['continuation','continuation_reference','assistant_discussion','assistant_discussion_snapshot'].some(key=>key in value))return invalid();
  const source=value.content,c={...source} as ReplyContent;
  if(c.type==='rewrite_draft') {
    c.input_kind??='draft';c.include_relationship_context??=false;c.excluded_message_ids??=[];
    if(typeof c.draft_text!=='string'||typeof c.include_relationship_context!=='boolean'||!['draft','current_chat','workspace'].includes(c.input_kind as string)||c.user_instruction!=null&&!nonblank(c.user_instruction))return invalid();
    if(!Array.isArray(c.excluded_message_ids)||c.excluded_message_ids.length>500)return invalid();
    c.excluded_message_ids=c.excluded_message_ids.map(replyUuid);
    if(c.input_kind==='workspace') {
      if(!['express','suggest'].includes(c.workspace_action as string)||c.workspace_action==='express'&&!nonblank(c.draft_text)||c.pasted_direction!=null||c.context_text!=null&&(typeof c.context_text!=='string'||count(c.context_text)>65536))return invalid();
    } else if(!nonblank(c.draft_text)||c.workspace_action!=null||c.context_text!=null||(c.excluded_message_ids as string[]).length|| (c.input_kind==='draft'?c.pasted_direction!=null:!nonblank(c.pasted_direction)||count(c.pasted_direction)>4096))return invalid();
  } else if(c.type==='reply_to_message'||c.type==='initiate_conversation') {
    const field=c.type==='reply_to_message'?'direction':'purpose';
    if(!nonblank(c[field]))return invalid();
    if(c.type==='reply_to_message')c.target_message_id=replyUuid(c.target_message_id);
    else if(count(c.purpose as string)>4096||c.target_message_id!=null)return invalid();
    const sourceField=`${field}_source`;
    if(c.type==='reply_to_message'&&!['direct_input','confirmed_suggestion'].includes(c[sourceField] as string))c[sourceField]='direct_input';
    c[sourceField]??='direct_input';
    if(!['direct_input','confirmed_suggestion'].includes(c[sourceField] as string))return invalid();
    for(const key of ['understanding_correction','user_instruction','clarification_answer']) {
      const accumulated=key==='user_instruction'&&accumulatedInstruction(c[key],authenticated);
      if(c[key]!=null&&(typeof c[key]!=='string'||count(c[key] as string)>4096&&!accumulated))return invalid();
      c[key]=typeof c[key]==='string'?accumulated?c[key]:(c[key] as string).trim()||null:null;
    }
  } else return invalid();
  const optional=(key:string)=>value[key]==null?null:replyUuid(value[key]);
  const allow=value.allow_incomplete_history??false,disabled=value.skill_disabled??false,scene=value.scene??null;
  const skill=optional('skill_version_id');
  if(typeof allow!=='boolean'||typeof disabled!=='boolean'||disabled&&skill!==null||scene!==null&&(!nonblank(scene)||count(scene)>256||scene!==scene.trim()))return invalid();
  let suggestion:ReplyRequestInput['suggestion']=null;
  if(value.suggestion!=null) {
    if(!record(value.suggestion)||Object.keys(value.suggestion).sort().join(',')!=='input_version,suggestion_id,task_id')return invalid();
    suggestion={task_id:replyUuid(value.suggestion.task_id),input_version:replyUuid(value.suggestion.input_version),suggestion_id:replyUuid(value.suggestion.suggestion_id)};
  }
  return {contact_id:replyUuid(value.contact_id),idempotency_key:replyUuid(value.idempotency_key),content:c,
    continued_from_candidate_id:optional('continued_from_candidate_id'),skill_version_id:skill,suggestion,
    allow_incomplete_history:allow,skill_disabled:disabled,scene:scene as string|null,
    ...('expected_input_version_id'in value?{expected_input_version_id:replyUuid(value.expected_input_version_id)}:{})};
}
export function validateReplyCandidates(value:unknown,evidenceIds:ReadonlySet<string>,candidateLimit=3):ReplyCandidateInput[] {
  const rejected=():never=>{throw new ReplyError('reply_candidates_rejected');};
  if(!record(value)||!Array.isArray(value.candidates)||value.candidates.length<1||value.candidates.length>candidateLimit)return rejected();
  return value.candidates.map(raw=>{
    if(!record(raw)||!nonblank(raw.text)||count(raw.text)>65536||!nonblank(raw.basis)||!Array.isArray(raw.citation_ids)||!raw.citation_ids.length||!Array.isArray(raw.risk_notes)||raw.risk_notes.some(v=>!nonblank(v)))return rejected();
    let citations:string[];
    try {citations=raw.citation_ids.map(replyUuid);}catch{return rejected();}
    if(citations.some(id=>!evidenceIds.has(id)))return rejected();
    const messages=raw.messages??[];
    if(!Array.isArray(messages))return rejected();
    const group=messages.length?messages:[raw.text];
    if(group.length>8||group.some(v=>!nonblank(v)||count(v.trim())>(group.length===1?65536:8192))||group.join('\n\n')!==raw.text)return rejected();
    return {text:raw.text,basis:raw.basis,citation_ids:citations,risk_notes:raw.risk_notes as string[],messages:messages as string[]};
  });
}
/** 与既有 Python sort_keys/ensure_ascii=False 指纹兼容，不因语言切换重复生成。 */
export function normalizeReplyInput(input:ReplyRequestInput):string {
  const c=input.content;
  const payload:Record<string,unknown>={mode:c.type};
  if(c.type==='rewrite_draft') {
    Object.assign(payload,{draft_text:(c.draft_text as string).trim(),user_instruction:typeof c.user_instruction==='string'?c.user_instruction.trim():null,include_relationship_context:c.include_relationship_context});
    if(c.input_kind==='workspace')Object.assign(payload,{input_kind:'workspace',workspace_action:c.workspace_action,context_text:c.context_text??null,excluded_message_ids:[...new Set(c.excluded_message_ids as string[])].sort()});
    if(c.input_kind==='current_chat')Object.assign(payload,{input_kind:'current_chat',pasted_direction:(c.pasted_direction as string).trim()});
  } else {
    const key=c.type==='reply_to_message'?'direction':'purpose';
    payload[key]=(c[key] as string).trim();payload[`${key}_source`]=c[`${key}_source`];
    if(c.type==='reply_to_message')payload.target_message_id=c.target_message_id;
    if(input.suggestion)payload.suggestion=input.suggestion;
    for(const name of ['understanding_correction','user_instruction','clarification_answer'])if(c[name])payload[name]=(c[name] as string).trim();
  }
  payload.continued_from_candidate_id=input.continued_from_candidate_id;
  payload.skill=input.skill_version_id?`user_choice:${input.skill_version_id}`:input.skill_disabled?'disabled':'auto';
  if(input.allow_incomplete_history)Object.assign(payload,{allow_incomplete_history:true,history_coverage_warning:'历史覆盖不完整：用户选择基于已同步部分继续，不能据此声称拥有完整语境。'});
  if(input.scene!==null)payload.scene=input.scene;
  const sort=(value:unknown):unknown=>Array.isArray(value)?value.map(sort):record(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sort(value[key])])):value;
  const normalized=JSON.stringify(sort(payload));
  return input.suggestion&&c.type!=='rewrite_draft'?`suggestion-sha256:${createHash('sha256').update(normalized).digest('hex')}`:normalized;
}
