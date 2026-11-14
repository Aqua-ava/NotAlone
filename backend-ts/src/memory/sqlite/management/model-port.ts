/** SQLite 记忆裁决的独立模型端口；复用宿主唯一 provider、许可和物理账本。 */
import type {Context} from '@deepseek-ai/cordis';
import {sha256} from '../../../platform/sha256.ts';
import type {HostReplyConfiguration} from '../../../host/host-reply-config.ts';
import type {ModelLedgerReceipt} from '../../../platform/models/model-ledger-contract.ts';
import type {ModelTaskClaim} from '../../../platform/models/model-permit-port.ts';
import type {installModelProvider} from '../../../platform/models/model-provider.ts';
import type {ModelImageInput,ModelImageManifest} from '../../../platform/models/model-images.ts';
import {createExtractionModelCaller,type ExtractionPermitEndpoint} from '../../extraction/model.ts';
import type {SqliteExtractionModelPreparation} from '../model-port.ts';

export type SqliteAdjudicationModelPurpose='adjudication'|'relation_verification'|'merge_verification';
export interface SqliteAdjudicationModelRequest {
  purpose:SqliteAdjudicationModelPurpose;
  system:string;user:string;
  images?:readonly ModelImageInput[];
  tool:{name:string;description:string;parameters:Record<string,unknown>};
  validateOutput(blocks:readonly unknown[]):void|Promise<void>;
}
export interface SqliteAdjudicationModelScope {owner_id:string;contact_id:string|null;}
export interface SqliteAdjudicationModelInvocation {
  requestId:string;attemptId:string;scope:SqliteAdjudicationModelScope;claim:ModelTaskClaim;
  signal:AbortSignal;
  requireCurrent():Promise<void>;
  onReceipt(receipt:ModelLedgerReceipt):Promise<void>;
  onImageInputs?(images:readonly ModelImageManifest[]):Promise<void>;
}
export type SqliteAdjudicationModelPreparation=SqliteExtractionModelPreparation;
export interface SqliteAdjudicationModelPortOptions {
  ctx:Context;configuration:HostReplyConfiguration;permit:ExtractionPermitEndpoint;
  /** 生命周期由宿主在所有业务端口排空后结束，本端口不得重新注册或释放。 */
  provider:ReturnType<typeof installModelProvider>;
  /** 宿主核验同一 owner 的真实用途与本轮资料资格。 */
  authorizePurpose(input:{purpose:SqliteAdjudicationModelPurpose;scope:SqliteAdjudicationModelScope},signal:AbortSignal):Promise<void>;
}
export class SqliteAdjudicationModelPortError extends Error {
  readonly code:string;
  constructor(code:string){super(code);this.code=code;}
}
const fail=(code:string):never=>{throw new SqliteAdjudicationModelPortError(code);};
const toolNames={adjudication:'BatchMemoryAdjudicationOutput',relation_verification:'BatchMemoryRelationVerificationOutput',merge_verification:'MergedMemoryVerificationOutput'} as const;

function snapshot(request:SqliteAdjudicationModelRequest):SqliteAdjudicationModelRequest {
  if(!request||!Object.hasOwn(toolNames,request.purpose)||typeof request.system!=='string'
    ||typeof request.user!=='string'||!request.user.trim()||!request.tool
    ||request.tool.name!==toolNames[request.purpose])fail('adjudication_model_purpose_invalid');
  const schema=request.tool.parameters;
  if(typeof request.tool.description!=='string'||!request.tool.description.trim()||!schema
    ||typeof schema!=='object'||Array.isArray(schema)||schema.title!==request.tool.name||schema.type!=='object'
    ||typeof request.validateOutput!=='function')fail('adjudication_model_schema_invalid');
  if(request.images!==undefined&&!Array.isArray(request.images))fail('adjudication_model_image_invalid');
  return {...request,tool:structuredClone(request.tool),...(request.images?{images:structuredClone(request.images)}:{})};
}

export function createSqliteAdjudicationModelPort(options:SqliteAdjudicationModelPortOptions) {
  const configuration=options.configuration;
  if(configuration.status!=='configured')throw new SqliteAdjudicationModelPortError('adjudication_model_unconfigured');
  const providerConfiguration={...configuration.provider,connection:structuredClone(configuration.provider.connection)};
  const model=structuredClone(configuration.model);
  const binding={provider:model.provider,model:model.model,maxTokens:model.maxTokens,
    temperature:model.temperature,reasoningEffort:model.reasoningEffort};
  const profile=structuredClone(model.budgetProfile);
  const positive=(value:number)=>Number.isSafeInteger(value)&&value>0;
  if(!options.provider||typeof options.authorizePurpose!=='function'||!positive(binding.maxTokens)
    ||!positive(profile.context_window_tokens)||!positive(profile.safety_margin_tokens)
    ||profile.context_window_tokens<=binding.maxTokens+profile.safety_margin_tokens
    ||providerConfiguration.provider!==binding.provider||!positive(model.deadline_ms))fail('adjudication_model_configuration_invalid');
  const preparation:SqliteAdjudicationModelPreparation={provider:binding.provider,model:binding.model,
    configurationId:sha256(JSON.stringify({binding,profile,
      baseURL:providerConfiguration.connection.baseURL,deadline:model.deadline_ms})),
    maxInputTokens:profile.context_window_tokens-binding.maxTokens-profile.safety_margin_tokens,
    maxOutputTokens:binding.maxTokens,contextWindowTokens:profile.context_window_tokens,safetyMarginTokens:profile.safety_margin_tokens};
  const caller=createExtractionModelCaller({ctx:options.ctx,provider:options.provider,permit:options.permit});
  const stopped=new AbortController(),active=new Set<Promise<unknown>>();
  let closing:Promise<void>|undefined;
  const signalFor=(signal:AbortSignal)=>AbortSignal.any([signal,stopped.signal,AbortSignal.timeout(model.deadline_ms)]);
  function track<T>(work:Promise<T>):Promise<T>{active.add(work);void work.then(()=>active.delete(work),()=>active.delete(work));return work;}
  async function prepareCurrent(request:SqliteAdjudicationModelRequest,input:Pick<SqliteAdjudicationModelInvocation,'scope'|'signal'|'requireCurrent'>):Promise<SqliteAdjudicationModelPreparation> {
    if(stopped.signal.aborted)fail('adjudication_model_closed');
    input.signal.throwIfAborted();await input.requireCurrent();
    if(request.images?.length&&!providerConfiguration.connection.models.find(entry=>entry.id===binding.model)?.inputModalities?.includes('image'))
      fail('adjudication_model_image_unsupported');
    await options.authorizePurpose({purpose:request.purpose,scope:{...input.scope}},input.signal);
    const auth=await providerConfiguration.resolveAuth(providerConfiguration.connection);
    if(!auth?.headers||!Object.entries(auth.headers).some(([name,value])=>
      ['x-api-key','authorization'].includes(name.toLowerCase())&&typeof value==='string'&&value.trim()&&!/[\r\n]/.test(value)))
      fail('adjudication_model_credentials_unavailable');
    input.signal.throwIfAborted();return {...preparation};
  }
  return {
    prepare(request:SqliteAdjudicationModelRequest,input:Pick<SqliteAdjudicationModelInvocation,'scope'|'signal'|'requireCurrent'>):Promise<SqliteAdjudicationModelPreparation> {
      return track((async()=>{
        if(stopped.signal.aborted)fail('adjudication_model_closed');
        return prepareCurrent(snapshot(request),{scope:{...input.scope},signal:signalFor(input.signal),requireCurrent:input.requireCurrent});
      })());
    },
    invoke(request:SqliteAdjudicationModelRequest,input:SqliteAdjudicationModelInvocation) {
      return track((async()=>{
        if(stopped.signal.aborted)fail('adjudication_model_closed');
        const frozenRequest=snapshot(request),scope={...input.scope},claim={...input.claim};
        const {requestId,attemptId,requireCurrent,onReceipt,onImageInputs}=input,signal=signalFor(input.signal);
        const current=async()=>{
          signal.throwIfAborted();await requireCurrent();
          await options.authorizePurpose({purpose:frozenRequest.purpose,scope:{...scope}},signal);signal.throwIfAborted();
        };
        await prepareCurrent(frozenRequest,{scope,signal,requireCurrent});
        const invoke=(images:Parameters<Parameters<typeof options.provider.withImages>[2]>[0])=>caller.call({request_id:requestId,attempt_id:attemptId,...scope,claim,binding,profile,
          signal,requireCurrent:current,onReceipt,onImageInputs,system:frozenRequest.system,
          messages:[{role:'user',content:[{type:'text',text:frozenRequest.user},...images]}],tools:[frozenRequest.tool],validateOutput:frozenRequest.validateOutput});
        return frozenRequest.images?.length?options.provider.withImages(frozenRequest.images,signal,invoke):invoke([]);
      })());
    },
    close():Promise<void>{return closing??=(async()=>{stopped.abort();await Promise.allSettled([...active]);})();},
  };
}
export type SqliteAdjudicationModelPort=ReturnType<typeof createSqliteAdjudicationModelPort>;
