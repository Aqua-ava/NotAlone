/** 官方DeepSeekAdapter的业务装配；不实现协议转换、HTTP、SSE或重试。 */
import type { Context } from '@deepseek-ai/cordis';
import { DeepSeekAdapter, type DeepSeekConnectionOptions, type DeepSeekAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek';
import { measureSerializedMessages, ModelInputBudgetError, type MessagesBudgetBinding, type MessagesBudgetProfile, type MessagesBudgetReceipt } from './model-input-budget.ts';
export interface ModelProviderCall {
  sessionId: string; attempt_id: string; permit_id: string;
  binding: MessagesBudgetBinding; profile: MessagesBudgetProfile;
  requireCurrent(): Promise<void>;
  /** HTTP发送前强制持久化授权。此时发送仍可能被signal阻止，不能记成已发。 */
  beforeDispatch(value: {attempt_id:string;permit_id:string;budget:MessagesBudgetReceipt;dispatch:'authorized_unconfirmed'}): Promise<void>;
}
export interface ModelProviderObservation {
  attempt_id: string; permit_id: string;
  dispatch: 'not_authorized'|'authorized_unconfirmed'|'http_accepted';
  budget: MessagesBudgetReceipt | null;
  budget_rejection:{code:ModelInputBudgetError['code'];receipt:MessagesBudgetReceipt|null}|null;
}
export interface ModelProviderConfiguration {
  provider: string;
  connection: DeepSeekConnectionOptions;
  resolveAuth: DeepSeekAdapterOptions['resolveAuth'];
  resolveUserId: DeepSeekAdapterOptions['resolveUserId'];
}
function freeze<T>(value:T):T {
  if(value&&typeof value==='object') {for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;
}
export function installModelProvider(ctx: Context, configuration: ModelProviderConfiguration) {
  if(!configuration.provider.trim()||configuration.connection.retryPolicy.mode!=='normal'||configuration.connection.retryPolicy.maxRetries!==0)throw new Error('model_provider_retry_policy_invalid');
  const connection=freeze(structuredClone(configuration.connection));
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
      await current.call.beforeDispatch({attempt_id:current.call.attempt_id,permit_id:current.call.permit_id,budget,dispatch:'authorized_unconfirmed'});
      current.observation.budget=budget;
      current.observation.dispatch='authorized_unconfirmed';
      request.signal.throwIfAborted();
      return {fields:{},accept:async()=>{current.observation.dispatch='http_accepted';}};
    },
  });
  const dispose=ctx.llm.registerAdapter([configuration.provider],adapter);
  return {
    beginCall(call: ModelProviderCall) {
      if(!call.sessionId||!call.attempt_id||!call.permit_id||call.binding.provider!==configuration.provider||calls.has(call.sessionId))throw new Error('model_provider_call_conflict');
      const registered={call:{...call,binding:freeze(structuredClone(call.binding)),profile:freeze(structuredClone(call.profile))},
        observation:{attempt_id:call.attempt_id,permit_id:call.permit_id,dispatch:'not_authorized' as ModelProviderObservation['dispatch'],budget:null as MessagesBudgetReceipt|null,budget_rejection:null as ModelProviderObservation['budget_rejection']},prepared:false};
      calls.set(call.sessionId,registered);
      return {
        observation:()=>structuredClone(registered.observation),
        /** 在实际官方stream退出后释放session，取消等待者不能提前解绑在途调用。 */
        close() { if(calls.get(call.sessionId)===registered)calls.delete(call.sessionId); },
      };
    },
    async dispose() {
      if(calls.size)throw new Error('model_provider_calls_not_settled');
      await dispose();
    },
  };
}
