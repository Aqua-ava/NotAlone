/** 普通调用沿用官方DeepSeekAdapter；来源核验另用同供应商的专用strict Beta传输。 */
import type { Context } from '@deepseek-ai/cordis';
import {LlmError} from '@deepseek-ai/dsh-llm';
import {bindDiagnosticProblemBudget} from '../../diagnostics/diagnostic-problem-budget.ts';
import { DeepSeekAdapter, PUBLIC_BASE_URL, type DeepSeekConnectionOptions, type DeepSeekAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek';
import {
  measureSerializedMessages,measureSerializedStrictChatCompletion,ModelInputBudgetError,
  type MessagesBudgetBinding,type MessagesBudgetProfile,type MessagesBudgetReceipt,
} from './model-input-budget.ts';
import {
  buildDeepSeekStrictVerificationRequest,decodeDeepSeekStrictVerificationResponse,
  DEEPSEEK_STRICT_VERIFICATION_ENDPOINT,type DeepSeekStrictVerificationResponse,
} from '../../memory/extraction/deepseek-strict-verification.ts';
export interface ModelProviderCall {
  sessionId: string; attempt_id: string; permit_id: string;
  binding: MessagesBudgetBinding; profile: MessagesBudgetProfile;
  requireCurrent(): Promise<void>;
  /** HTTP发送前强制持久化授权。此时发送仍可能被signal阻止，不能记成已发。 */
  beforeDispatch(value: {attempt_id:string;permit_id:string;budget:MessagesBudgetReceipt;dispatch:'authorized_unconfirmed';
    /** 最终序列化HTTP实体的Unicode字符数；不携带正文。 */
    request_entity_characters?:number}): Promise<void>;
}
export interface ModelProviderObservation {
  attempt_id: string; permit_id: string;
  dispatch: 'not_authorized'|'authorized_unconfirmed'|'http_accepted';
  /** 显式 false 才能证明尚未进入原预约回调；旧观测缺省时仍按未知处理。 */
  before_dispatch_started?: boolean;
  budget: MessagesBudgetReceipt | null;
  budget_rejection:{code:ModelInputBudgetError['code'];receipt:MessagesBudgetReceipt|null}|null;
}
export interface ModelProviderConfiguration {
  provider: string;
  connection: DeepSeekConnectionOptions;
  resolveAuth: DeepSeekAdapterOptions['resolveAuth'];
  resolveUserId: DeepSeekAdapterOptions['resolveUserId'];
  /** 仅可指向官方 DeepSeek strict Beta Chat Completions；官方 Messages 根可省略并按固定规则推导。 */
  strictVerificationEndpoint?: string;
}
export interface StrictVerificationSendInput {
  system:string;user:string;tool:{name:'SourceVerificationOutput';description:string;parameters:Record<string,unknown>};
  signal:AbortSignal;
}
function freeze<T>(value:T):T {
  if(value&&typeof value==='object') {for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;
}
async function boundedResponseText(response:Response):Promise<string>{
  if(!response.body)return '';
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  for(;;){const item=await reader.read();if(item.done)break;bytes+=item.value.byteLength;
    if(bytes>2*1024*1024){await reader.cancel();throw new LlmError('DeepSeek strict response exceeded the bounded body limit.','INVALID_RESPONSE');}
    chunks.push(item.value);
  }
  const joined=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.byteLength;}
  return new TextDecoder('utf-8',{fatal:true}).decode(joined);
}
function httpFailure(status:number):LlmError{
  const code=status===401||status===403?'AUTH':status===402?'QUOTA':status===429?'RATE_LIMIT'
    :status>=500?'SERVER':status===400||status===413?'INVALID_REQUEST':`HTTP_${status}`;
  return new LlmError(`DeepSeek strict request failed (HTTP ${status}).`,code,{status});
}
export function installModelProvider(ctx: Context, configuration: ModelProviderConfiguration) {
  if(!configuration.provider.trim()||configuration.connection.retryPolicy.mode!=='normal'||configuration.connection.retryPolicy.maxRetries!==0)throw new Error('model_provider_retry_policy_invalid');
  const diagnosticBudget=bindDiagnosticProblemBudget();
  const connection=freeze(structuredClone(configuration.connection));
  const strictEndpoint=configuration.strictVerificationEndpoint
    ??(connection.baseURL===PUBLIC_BASE_URL?DEEPSEEK_STRICT_VERIFICATION_ENDPOINT:undefined);
  if(strictEndpoint!==undefined){
    let parsed:URL;
    try{parsed=new URL(strictEndpoint);}catch{throw new Error('model_provider_strict_endpoint_invalid');}
    if(!['https:','http:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.search||parsed.hash)
      throw new Error('model_provider_strict_endpoint_invalid');
  }
  const calls=new Map<string,{call:ModelProviderCall;observation:ModelProviderObservation;prepared:boolean}>();
  const adapter=new DeepSeekAdapter({
    options:()=>connection,
    resolveAuth:configuration.resolveAuth,
    resolveUserId:configuration.resolveUserId,
    // 不挂载attachment/files resolver：当前业务只允许文字，禁止文件重试扩大物理次数。
    prepareExtensions:async request=>{
      const current=request.sessionId ? calls.get(request.sessionId) : undefined;
      if(!current||request.purpose!==undefined||current.prepared)throw new Error('model_provider_call_not_authorized');
      current.prepared=true;
      request.signal.throwIfAborted();
      await current.call.requireCurrent();
      request.signal.throwIfAborted();
      let budget:MessagesBudgetReceipt;
      try{budget=measureSerializedMessages(request.body,current.call.binding,current.call.profile);}
      catch(error){if(error instanceof ModelInputBudgetError)current.observation.budget_rejection={code:error.code,receipt:error.receipt};throw error;}
      const checkDiagnosticDispatch=diagnosticBudget?.reserve();
      current.observation.before_dispatch_started=true;
      await current.call.beforeDispatch({attempt_id:current.call.attempt_id,permit_id:current.call.permit_id,budget,dispatch:'authorized_unconfirmed',
        request_entity_characters:[...JSON.stringify(request.body)].length});
      checkDiagnosticDispatch?.();
      current.observation.budget=budget;
      current.observation.dispatch='authorized_unconfirmed';
      request.signal.throwIfAborted();
      return {fields:{},accept:async()=>{current.observation.dispatch='http_accepted';}};
    },
  });
  const dispose=ctx.llm.registerAdapter([configuration.provider],adapter);
  function register(call:ModelProviderCall){
    if(!call.sessionId||!call.attempt_id||!call.permit_id||call.binding.provider!==configuration.provider||calls.has(call.sessionId))throw new Error('model_provider_call_conflict');
    const registered={call:{...call,binding:freeze(structuredClone(call.binding)),profile:freeze(structuredClone(call.profile))},
      observation:{attempt_id:call.attempt_id,permit_id:call.permit_id,dispatch:'not_authorized' as ModelProviderObservation['dispatch'],before_dispatch_started:false,budget:null as MessagesBudgetReceipt|null,budget_rejection:null as ModelProviderObservation['budget_rejection']},prepared:false};
    calls.set(call.sessionId,registered);
    return registered;
  }
  return {
    /** 只反映安装时成功绑定；不表示尚有额度，不暴露账本身份或重读env。 */
    get diagnosticProblemBudgetBound():boolean {return diagnosticBudget!==null;},
    beginCall(call: ModelProviderCall) {
      const registered=register(call);
      return {
        observation:():ModelProviderObservation=>structuredClone(registered.observation),
        /** 在实际官方stream退出后释放session，取消等待者不能提前解绑在途调用。 */
        close() { if(calls.get(call.sessionId)===registered)calls.delete(call.sessionId); },
      };
    },
    beginStrictVerificationCall(call:ModelProviderCall){
      const registered=register(call);
      return {
        observation:():ModelProviderObservation=>structuredClone(registered.observation),
        async send(input:StrictVerificationSendInput):Promise<DeepSeekStrictVerificationResponse>{
          if(registered.prepared)throw new LlmError('DeepSeek strict call was already prepared.','INVALID_REQUEST');
          registered.prepared=true;
          input.signal.throwIfAborted();
          await registered.call.requireCurrent();input.signal.throwIfAborted();
          if(!strictEndpoint)throw new LlmError('DeepSeek strict endpoint is not configured for this route.','INVALID_REQUEST');
          const request=buildDeepSeekStrictVerificationRequest({
            model:registered.call.binding.model,system:input.system,user:input.user,tool:input.tool,
            maxTokens:registered.call.binding.maxTokens,temperature:registered.call.binding.temperature,
            reasoningEffort:registered.call.binding.reasoningEffort,endpoint:strictEndpoint,
          });
          let budget:MessagesBudgetReceipt;
          try{budget=measureSerializedStrictChatCompletion(request.body,registered.call.binding,registered.call.profile);}
          catch(error){
            if(error instanceof ModelInputBudgetError)registered.observation.budget_rejection={code:error.code,receipt:error.receipt};
            throw error;
          }
          const auth=await configuration.resolveAuth(connection),headers:Record<string,string>={
            'content-type':'application/json','accept':'application/json',
            'x-deepseek-harness-user-id':configuration.resolveUserId(),
            'x-deepseek-harness-session-id':String(registered.call.sessionId),
          };
          for(const [name,value] of Object.entries(auth.headers)){
            if(name.toLowerCase()==='x-api-key')headers.authorization=`Bearer ${value}`;
            else headers[name]=value;
          }
          const checkDiagnosticDispatch=diagnosticBudget?.reserve();
          registered.observation.before_dispatch_started=true;
          await registered.call.beforeDispatch({attempt_id:registered.call.attempt_id,permit_id:registered.call.permit_id,
            budget,dispatch:'authorized_unconfirmed',request_entity_characters:[...JSON.stringify(request.body)].length});
          checkDiagnosticDispatch?.();
          registered.observation.budget=budget;registered.observation.dispatch='authorized_unconfirmed';
          input.signal.throwIfAborted();
          let response:Response;
          try{response=await fetch(request.endpoint,{method:'POST',headers,body:JSON.stringify(request.body),
            redirect:'error',signal:input.signal});}
          catch(error){throw new LlmError('DeepSeek strict transport failed.',error instanceof Error&&error.name==='AbortError'?'ABORTED':'TRANSPORT',{cause:error});}
          if(!response.ok)throw httpFailure(response.status);
          registered.observation.dispatch='http_accepted';
          let payload:unknown;
          try{payload=JSON.parse(await boundedResponseText(response));}
          catch(error){throw new LlmError('DeepSeek strict response was not valid JSON.','INVALID_RESPONSE',{cause:error});}
          try{return decodeDeepSeekStrictVerificationResponse(payload);}
          catch(error){throw new LlmError('DeepSeek strict response did not match the tool envelope.','INVALID_RESPONSE',{cause:error});}
        },
        close() { if(calls.get(call.sessionId)===registered)calls.delete(call.sessionId); },
      };
    },
    async dispose() {
      if(calls.size)throw new Error('model_provider_calls_not_settled');
      await dispose();
    },
  };
}
