/** 提取、裁决与文档三个记忆模型端口共用的配置快照、凭据检查与在途调用管理；错误码前缀由各端口自行抛出。 */
import {sha256} from '../../platform/sha256.ts';
import type {HostReplyConfiguration} from '../../host/host-reply-config.ts';

/** 克隆已配置模型：端口只持有自己的快照，之后修改配置对象不会改变已授权的绑定、预算与出站地址。 */
export function modelSnapshot(configuration:Extract<HostReplyConfiguration,{status:'configured'}>) {
  const provider={...configuration.provider,connection:structuredClone(configuration.provider.connection)};
  const model=structuredClone(configuration.model);
  const binding={provider:model.provider,model:model.model,maxTokens:model.maxTokens,
    temperature:model.temperature,reasoningEffort:model.reasoningEffort};
  const profile=structuredClone(model.budgetProfile);
  return {provider,model,binding,profile};
}
export type ModelSnapshot=ReturnType<typeof modelSnapshot>;

const positive=(value:number)=>Number.isSafeInteger(value)&&value>0;
/** 提取与裁决端口的严格预算与供应商一致性校验；文档端口沿用自己的校验。 */
export const validBudget=({provider,model,binding,profile}:ModelSnapshot)=>positive(binding.maxTokens)
  &&positive(profile.context_window_tokens)&&positive(profile.safety_margin_tokens)
  &&profile.context_window_tokens>binding.maxTokens+profile.safety_margin_tokens
  &&provider.provider===binding.provider&&positive(model.deadline_ms);

/** 预算身份只取决于绑定、预算档案、出站地址和期限；配置变化即得到不同的 configurationId。 */
export function modelPreparation({provider,model,binding,profile}:ModelSnapshot) {
  return {provider:binding.provider,model:binding.model,
    configurationId:sha256(JSON.stringify({binding,profile,baseURL:provider.connection.baseURL,deadline:model.deadline_ms})),
    maxInputTokens:profile.context_window_tokens-binding.maxTokens-profile.safety_margin_tokens,
    maxOutputTokens:binding.maxTokens,contextWindowTokens:profile.context_window_tokens,safetyMarginTokens:profile.safety_margin_tokens};
}

/** 模型声明支持图片输入才允许带图；不支持时由调用方拒绝，不降级成文字描述。 */
export const acceptsImages=({provider,binding}:ModelSnapshot)=>
  !!provider.connection.models.find(entry=>entry.id===binding.model)?.inputModalities?.includes('image');

/** 鉴权头必须含非空且不带换行的 x-api-key 或 authorization；缺失时由调用方以本端口的错误码拒绝。 */
export const hasModelCredential=(auth:{headers?:object}|null|undefined)=>!!auth?.headers
  &&Object.entries(auth.headers).some(([name,value])=>
    ['x-api-key','authorization'].includes(name.toLowerCase())&&typeof value==='string'&&!!value.trim()&&!/[\r\n]/.test(value));

/** 端口自己的在途调用：close 先取消并排空自己的调用，不释放共享 provider；失败后可重试同一关闭。 */
export function ownedCalls(deadlineMs:number) {
  const stopped=new AbortController(),active=new Set<Promise<unknown>>();
  let closing:Promise<void>|undefined;
  return {
    get closed(){return stopped.signal.aborted;},
    signalFor:(signal:AbortSignal)=>AbortSignal.any([signal,stopped.signal,AbortSignal.timeout(deadlineMs)]),
    track<T>(work:Promise<T>):Promise<T> {active.add(work);void work.then(()=>active.delete(work),()=>active.delete(work));return work;},
    close(afterDrain?:()=>Promise<void>):Promise<void> {
      return closing??=(async()=>{stopped.abort();await Promise.allSettled([...active]);if(afterDrain)await afterDrain();})()
        .catch(error=>{closing=undefined;throw error;});
    },
  };
}
