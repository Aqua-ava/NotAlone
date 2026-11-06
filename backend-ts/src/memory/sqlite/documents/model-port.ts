import {sha256} from '../../../platform/sha256.ts';
import type {Context} from '@deepseek-ai/cordis';
import type {GenerateOptions} from '@deepseek-ai/dsh-llm';
import type {HostReplyConfiguration} from '../../../host/host-reply-config.ts';
import type {installModelProvider} from '../../../platform/models/model-provider.ts';
import {createExtractionModelCaller,type ExtractionPermitEndpoint} from '../../extraction/model.ts';
import type {DocumentModelPort,DocumentRequest} from './service.ts';
import {StorageFailure} from '../../../storage/sqlite/contracts.ts';

/** 复用宿主唯一provider和许可服务；本领域只排空自己的调用，不释放共享资源。 */
export function createSqliteDocumentsModelPort(options:{ctx:Context;configuration:HostReplyConfiguration;provider:ReturnType<typeof installModelProvider>;permit:ExtractionPermitEndpoint;ownerId:string}):DocumentModelPort {
 const configuration=options.configuration;if(configuration.status!=='configured')throw new StorageFailure('document_model_unconfigured');
 const provider={...configuration.provider,connection:structuredClone(configuration.provider.connection)},model=structuredClone(configuration.model);
 const binding={provider:model.provider,model:model.model,maxTokens:model.maxTokens,temperature:model.temperature,reasoningEffort:model.reasoningEffort};
 const profile=structuredClone(model.budgetProfile);
 if(!options.provider||provider.provider!==binding.provider||!Number.isSafeInteger(binding.maxTokens)||binding.maxTokens<1||!Number.isSafeInteger(profile.context_window_tokens)||!Number.isSafeInteger(profile.safety_margin_tokens)||profile.context_window_tokens<=binding.maxTokens+profile.safety_margin_tokens||!Number.isSafeInteger(model.deadline_ms)||model.deadline_ms<1)throw new StorageFailure('document_model_configuration_invalid');
 const preparation={provider:binding.provider,model:binding.model,configurationId:sha256(JSON.stringify({binding,profile,baseURL:provider.connection.baseURL,deadline:model.deadline_ms})),maxInputTokens:profile.context_window_tokens-binding.maxTokens-profile.safety_margin_tokens,maxOutputTokens:binding.maxTokens,contextWindowTokens:profile.context_window_tokens,safetyMarginTokens:profile.safety_margin_tokens};
 const caller=createExtractionModelCaller({ctx:options.ctx,provider:options.provider,permit:options.permit}),stopped=new AbortController(),active=new Set<Promise<unknown>>();let closing:Promise<void>|undefined;
 const track=<T>(work:Promise<T>)=>{active.add(work);void work.then(()=>active.delete(work),()=>active.delete(work));return work;};
 const signalFor=(signal:AbortSignal)=>AbortSignal.any([signal,stopped.signal,AbortSignal.timeout(model.deadline_ms)]);
 async function prepare(request:DocumentRequest,input:Parameters<DocumentModelPort['prepare']>[1]){
  if(stopped.signal.aborted)throw new StorageFailure('document_model_closed');
  if(input.scope.owner_id!==options.ownerId||!request.system||!Array.isArray(request.messages)||!Array.isArray(request.tools)||!request.tools.length)throw new StorageFailure('document_model_scope_invalid');
  input.signal.throwIfAborted();await input.requireCurrent();
  const auth=await provider.resolveAuth(provider.connection);
  if(!auth?.headers||!Object.entries(auth.headers).some(([name,value])=>['x-api-key','authorization'].includes(name.toLowerCase())&&typeof value==='string'&&value.trim()&&!/[\r\n]/.test(value)))throw new StorageFailure('document_model_credentials_unavailable');
  input.signal.throwIfAborted();return {...preparation};
 }
 return {
  prepare:(request,input)=>track(prepare(request,{...input,signal:signalFor(input.signal)})),
  invoke:(request,input)=>track((async()=>{
   const signal=signalFor(input.signal),snapshot=structuredClone({system:request.system,messages:request.messages,tools:request.tools});
   await prepare(request,{scope:input.scope,signal,requireCurrent:input.requireCurrent});
   return caller.call({request_id:input.requestId,attempt_id:input.attemptId,...input.scope,claim:input.claim,binding,profile,signal,
    requireCurrent:input.requireCurrent,onReceipt:input.onReceipt,system:snapshot.system,messages:snapshot.messages as GenerateOptions['messages'],tools:snapshot.tools as GenerateOptions['tools']});
  })()),
  close:()=>closing??=(async()=>{stopped.abort();await Promise.allSettled([...active]);})(),
 };
}
