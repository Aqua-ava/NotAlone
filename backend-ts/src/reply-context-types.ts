import type {Client} from 'pg';
import type {ReplyContinuationBasis} from './reply-assistant-guards.ts';
import type {LayeredMaterial} from './reply-context-layered.ts';
import type {ReplyRequestInput} from './reply-contract.ts';
import type {ReplyStoreEvidence} from './reply-store.ts';
export type ContextScope={owner_id:string;contact_id:string};
export type ContextMetadata=Record<string,any>;
export interface ReplyContextEvidence extends ReplyStoreEvidence {
 scope:ContextScope; valid_at:string|null; invalid_at:string|null; revision:number|null;
 timing:ContextMetadata; event:ContextMetadata|null; conditions:ContextMetadata|null; evolution:ContextMetadata|null;
 speaker_role:'owner'|'contact'|'system'|'unknown';model_visible:boolean;navigation:ContextMetadata|null;
 /** 仅复验使用，不进入模型payload；绑定原始行与活动来源。 */
 freshness_sha256?:string;
}
export interface ReplyContextBuildInput extends ContextScope {
 reply_request_id:string;request:Pick<ReplyRequestInput,'contact_id'|'content'|'continued_from_candidate_id'>;
 history_message_ids?:string[]|null;
 conversation_binding_id?:string;
}
export interface ReplyContextOptions {
 overview?:boolean;
 readContinuationBasis?(client:Client,scope:ContextScope,binding:string,candidateId:string):Promise<ReplyContinuationBasis>;
}
export interface BuiltReplyContext {
 overview_read_failed?:boolean;conversation_binding_id?:string;continuation_basis?:ReplyContinuationBasis|null;
 reply_request_id:string;scope:ContextScope;command:ReplyContextBuildInput['request'];current_text:string;
 direction:{text:string;source:string}|null;evidence:ReplyContextEvidence[];risk_notes:string[];
 memory_revision:number;index_revision:number|null;history_message_ids:string[]|null;
 layered_scenario_reads?:ContextMetadata[];owner_layered_scenario_reads?:ContextMetadata[];
 layered_context?:LayeredMaterial|null;owner_layered_context?:LayeredMaterial|null;
 layered_status?:'loaded'|'unavailable'|'not_allowed'|'budget_omitted';owner_layered_status?:'loaded'|'unavailable'|'not_allowed'|'budget_omitted';
 layered_read_failed?:boolean;owner_layered_read_failed?:boolean;
 retrieval?:ContextMetadata|null;tool_calls?:ContextMetadata[];navigation_dependency_ids?:string[];
}
export class ReplyContextError extends Error {
 readonly code='reply_context_unavailable';readonly status=409;
 constructor(message='回复上下文已变化或不可用。'){super(`reply_context_unavailable：${message}`);}
}
export const UNKNOWN_CURRENT_REASON='当前未核实；原话和保存时间不能证明状态现在仍成立。';
export const PENDING_REASON='未确认候选、仅供参考、不得当作事实。';
export const HISTORICAL_REASON='历史资料，仅用于追溯；当前未核实，不得当作当前事实。';
export const blankTiming=():ContextMetadata=>({recorded_at:null,source_started_at:null,source_ended_at:null,source_time_complete:false,current_status:'current_unverified',current_status_reason:UNKNOWN_CURRENT_REASON});
