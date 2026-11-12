import type {FinishReason} from '@deepseek-ai/dsh-llm';

const codes=new Set(['ABORTED','AUTH','PERMISSION','RATE_LIMIT','QUOTA','ACCOUNT_QUOTA','MISSING_CREDENTIAL','INVALID_CREDENTIAL',
 'INVALID_REQUEST','CONTEXT_WINDOW_EXCEEDED','SERVER','TRANSPORT','INVALID_RESPONSE','MALFORMED_RESPONSE','EMPTY_RESPONSE',
 'UNSUPPORTED_CONTENT','UNSUPPORTED_MODEL','UNSUPPORTED_REASONING_EFFORT','REQUEST_EXTENSION','TIMEOUT','NO_ADAPTER',
 'INVALID_ARGS','INTERNAL','MAX_TOKENS','TOOL_CALLS','UNKNOWN']);
export interface DiscussionFailureEvidence {kind:string;code:string;status?:number;dispatch:string}
const executionCodes=new Set(['discussion_generation_timeout','discussion_generation_cancelled','discussion_generation_failed','discussion_call_failed','discussion_call_limit',
 'discussion_identity_required','discussion_request_stale','discussion_source_unavailable','discussion_runtime_invalidated','history_source_not_available',
 'reply_source_unavailable','reply_sources_not_ready','reply_input_stale','reply_output_invalid','reply_content_invalid','reply_basis_not_actual_input','reply_knowledge_unavailable','memory_knowledge_stale','skill_run_invalidated','discussion_skill_unavailable','discussion_call_budget_invalid',
 'discussion_preparation_timeout','discussion_storage_interrupted','runtime_interrupted']);
/** 进度接口仅暴露固定本地原因码，供应商文本不能成为错误分类。 */
export function sanitizeDiscussionErrorCode(value:unknown):string{return typeof value==='string'&&executionCodes.has(value)?value:'discussion_generation_failed';}

/** 只保存固定分类、HTTP状态和本地发送阶段；拒绝供应商正文、请求编号、路径及任意错误文本。 */
export function sanitizeDiscussionFailure(value:unknown):DiscussionFailureEvidence|undefined{
 if(!value||typeof value!=='object'||Array.isArray(value))return;
 const input=value as Record<string,unknown>;
 const status=typeof input.status==='number'&&Number.isInteger(input.status)&&input.status>=100&&input.status<=599?input.status:undefined;
 const code=typeof input.code==='string'&&(codes.has(input.code)||status!==undefined&&input.code===`HTTP_${status}`)?input.code:'UNKNOWN';
 return {kind:['error','aborted','max-tokens','tool-calls'].includes(String(input.kind))?String(input.kind):'other',code,
  ...(status===undefined?{}:{status}),dispatch:['not_authorized','authorized_unconfirmed','http_accepted'].includes(String(input.dispatch))?String(input.dispatch):'unknown'};
}

/** 官方LlmRuntime将适配器异常规范化为终止finish；必须在业务边界拒绝前保留安全分类。 */
export function discussionFinishFailure(reason:FinishReason,dispatch:unknown):DiscussionFailureEvidence|undefined{
 if(reason.kind==='stop')return;
 const failure=reason.kind==='error'||reason.kind==='aborted'?reason.failure:undefined;
 return sanitizeDiscussionFailure({kind:reason.kind,code:failure?.code??(reason.kind==='max-tokens'?'MAX_TOKENS':reason.kind==='tool-calls'?'TOOL_CALLS':'UNKNOWN'),status:failure?.status,dispatch});
}
