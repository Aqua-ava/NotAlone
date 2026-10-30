/** 固定范围提取的模型端口；沿正式 DSH provider 和许可合同，不连接 PG。 */
import type {Context} from '@deepseek-ai/cordis';
import {createHash} from 'node:crypto';
import type {HostReplyConfiguration} from '../../host/host-reply-config.ts';
import type {ModelLedgerReceipt} from '../../platform/models/model-ledger-contract.ts';
import type {ModelTaskClaim} from '../../platform/models/model-permit-server.ts';
import {installModelProvider,type ModelProviderConfiguration} from '../../platform/models/model-provider.ts';
import type {ExtractionInvocation} from '../extraction/flow.ts';
import {createExtractionModelCaller,type ExtractionPermitEndpoint} from '../extraction/model.ts';
import {DIRECT_EXTRACTION_SCHEMA} from '../extraction/prompts.ts';
import {DEEPSEEK_STRICT_VERIFICATION_TOOL} from '../extraction/verification/deepseek-strict.ts';

export interface SqliteExtractionModelScope {owner_id:string;contact_id:string;}
export interface SqliteExtractionModelInvocation {
  requestId:string;attemptId:string;scope:SqliteExtractionModelScope;claim:ModelTaskClaim;
  signal:AbortSignal;
  requireCurrent():Promise<void>;
  /** SQLite 已有预约的回执持久化；成功前正常 caller 不会释放为已结算。 */
  onReceipt(receipt:ModelLedgerReceipt):Promise<void>;
}
export interface SqliteExtractionModelPreparation {
  provider:string;model:string;configurationId:string;
  /** 配置上界；实际请求用 provider 的最终序列化测量，不把这里当实测。 */
  maxInputTokens:number;maxOutputTokens:number;contextWindowTokens:number;safetyMarginTokens:number;
}
export interface SqliteExtractionModelPortOptions {
  ctx:Context;
  configuration:HostReplyConfiguration;
  permit:ExtractionPermitEndpoint;
  resolveUserId?:ModelProviderConfiguration['resolveUserId'];
  /** 受信任宿主可注入唯一provider；其生命周期由宿主在所有业务排空后结束。 */
  provider?:ReturnType<typeof installModelProvider>;
  /** 业务层核验本轮用途、文本范围及授权；不能只凭配置存在即授权。 */
  authorizePurpose(input:{purpose:ExtractionInvocation['purpose'];scope:SqliteExtractionModelScope},signal:AbortSignal):Promise<void>;
}
export class SqliteExtractionModelPortError extends Error {
  readonly code:string;
  constructor(code:string){super(code);this.code=code;}
}
const fail=(code:string):never=>{throw new SqliteExtractionModelPortError(code);};

export function createSqliteExtractionModelPort(options:SqliteExtractionModelPortOptions) {
  const configuration=options.configuration;
  if(configuration.status!=='configured')throw new SqliteExtractionModelPortError('extraction_model_unconfigured');
  const providerConfiguration={...configuration.provider,connection:structuredClone(configuration.provider.connection)};
  const model=structuredClone(configuration.model);
  const binding={provider:model.provider,model:model.model,maxTokens:model.maxTokens,
    temperature:model.temperature,reasoningEffort:model.reasoningEffort};
  const profile=structuredClone(model.budgetProfile);
  const positive=(n:number)=>Number.isSafeInteger(n)&&n>0;
  if(!positive(binding.maxTokens)||!positive(profile.context_window_tokens)||!positive(profile.safety_margin_tokens)
    ||profile.context_window_tokens<=binding.maxTokens+profile.safety_margin_tokens
    ||providerConfiguration.provider!==binding.provider||!positive(model.deadline_ms)
    ||typeof options.authorizePurpose!=='function'||!options.provider&&typeof options.resolveUserId!=='function')fail('extraction_model_configuration_invalid');
  const preparation:SqliteExtractionModelPreparation={provider:binding.provider,model:binding.model,
    configurationId:createHash('sha256').update(JSON.stringify({binding,profile,
      baseURL:providerConfiguration.connection.baseURL,deadline:model.deadline_ms})).digest('hex'),
    maxInputTokens:profile.context_window_tokens-binding.maxTokens-profile.safety_margin_tokens,
    maxOutputTokens:binding.maxTokens,contextWindowTokens:profile.context_window_tokens,safetyMarginTokens:profile.safety_margin_tokens};
  const ownsProvider=!options.provider;
  const provider=options.provider??installModelProvider(options.ctx,{...providerConfiguration,resolveUserId:options.resolveUserId!});
  const caller=createExtractionModelCaller({ctx:options.ctx,provider,permit:options.permit});
  const stopped=new AbortController();
  const active=new Set<Promise<unknown>>();
  let closing:Promise<void>|undefined;
  async function prepare(request:ExtractionInvocation,input:Pick<SqliteExtractionModelInvocation,'scope'|'signal'|'requireCurrent'>):Promise<SqliteExtractionModelPreparation> {
    if(stopped.signal.aborted)fail('extraction_model_closed');
    input.signal.throwIfAborted();
    if(!request||!['extraction','verification'].includes(request.purpose)||typeof request.system!=='string'
      ||typeof request.user!=='string'||!request.user.trim()||!request.tool
      ||request.tool.name!==(request.purpose==='extraction'?DIRECT_EXTRACTION_SCHEMA.title:DEEPSEEK_STRICT_VERIFICATION_TOOL))
      fail('extraction_model_purpose_invalid');
    await input.requireCurrent();
    await options.authorizePurpose({purpose:request.purpose,scope:{...input.scope}},input.signal);
    const auth=await providerConfiguration.resolveAuth(providerConfiguration.connection);
    if(!auth||!auth.headers||!Object.entries(auth.headers).some(([name,value])=>
      ['x-api-key','authorization'].includes(name.toLowerCase())&&typeof value==='string'&&value.trim()&&!/[\r\n]/.test(value)))
      fail('extraction_model_credentials_unavailable');
    input.signal.throwIfAborted();
    if(stopped.signal.aborted)fail('extraction_model_closed');
    return {...preparation};
  }
  function invoke(request:ExtractionInvocation,input:SqliteExtractionModelInvocation) {
    // 同一发送沿固定请求副本；后续 UI 或调用者更改对象不会扩大已授权输入。
    const frozenRequest={...request,tool:structuredClone(request.tool)};
    const scope={...input.scope},claim={...input.claim};
    const {requestId,attemptId,requireCurrent,onReceipt}=input;
    const signal=AbortSignal.any([input.signal,stopped.signal,AbortSignal.timeout(model.deadline_ms)]);
    const current=async()=>{
      signal.throwIfAborted();await requireCurrent();
      await options.authorizePurpose({purpose:frozenRequest.purpose,scope:{...scope}},signal);signal.throwIfAborted();
    };
    const work=(async()=>{
      await prepare(frozenRequest,{scope,signal,requireCurrent});
      return caller.call({request_id:requestId,attempt_id:attemptId,...scope,claim,binding,profile,
        signal,requireCurrent:current,onReceipt,
        messages:[{role:'user',content:[{type:'text',text:frozenRequest.user}]}],system:frozenRequest.system,
        tools:[frozenRequest.tool],validateOutput:frozenRequest.validateOutput});
    })();
    active.add(work);void work.then(()=>active.delete(work),()=>active.delete(work));
    return work;
  }
  return {
    prepare,invoke,
    close():Promise<void>{
      return closing??=(async()=>{stopped.abort();await Promise.allSettled([...active]);if(ownsProvider)await provider.dispose();})().catch(error=>{closing=undefined;throw error;});
    },
  };
}

export type SqliteExtractionModelPort=ReturnType<typeof createSqliteExtractionModelPort>;
