import type {FinishReason} from '@deepseek-ai/dsh-llm';

const codes=new Set(['ABORTED','AUTH','PERMISSION','RATE_LIMIT','QUOTA','ACCOUNT_QUOTA','MISSING_CREDENTIAL','INVALID_CREDENTIAL',
 'INVALID_REQUEST','CONTEXT_WINDOW_EXCEEDED','SERVER','TRANSPORT','INVALID_RESPONSE','MALFORMED_RESPONSE','EMPTY_RESPONSE',
 'UNSUPPORTED_CONTENT','UNSUPPORTED_MODEL','UNSUPPORTED_REASONING_EFFORT','REQUEST_EXTENSION','TIMEOUT','NO_ADAPTER',
 'INVALID_ARGS','INTERNAL','MAX_TOKENS','TOOL_CALLS','UNKNOWN']);
export interface DiscussionFailureEvidence {kind:string;code:string;status?:number;dispatch:string}

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
