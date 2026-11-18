import type {Context} from '@deepseek-ai/cordis';
import type {GenerateOptions} from '@deepseek-ai/dsh-llm';
import type {HostReplyConfiguration} from '../../../host/host-reply-config.ts';
import type {installModelProvider} from '../../../platform/models/model-provider.ts';
import {createExtractionModelCaller,type ExtractionPermitEndpoint} from '../../extraction/model.ts';
import type {DocumentModelPort,DocumentRequest} from './service.ts';
import {StorageFailure} from '../../../storage/sqlite/contracts.ts';
import {hasModelCredential,modelPreparation,modelSnapshot,ownedCalls} from '../model-port-core.ts';

/** 复用宿主唯一provider和许可服务；本领域只排空自己的调用，不释放共享资源。 */
export function createSqliteDocumentsModelPort(options:{ctx:Context;configuration:HostReplyConfiguration;provider:ReturnType<typeof installModelProvider>;permit:ExtractionPermitEndpoint;ownerId:string}):DocumentModelPort {
 const configuration=options.configuration;if(configuration.status!=='configured')throw new StorageFailure('document_model_unconfigured');
 const modelConfig=modelSnapshot(configuration),{provider,model,binding,profile}=modelConfig;
 if(!options.provider||provider.provider!==binding.provider||!Number.isSafeInteger(binding.maxTokens)||binding.maxTokens<1||!Number.isSafeInteger(profile.context_window_tokens)||!Number.isSafeInteger(profile.safety_margin_tokens)||profile.context_window_tokens<=binding.maxTokens+profile.safety_margin_tokens||!Number.isSafeInteger(model.deadline_ms)||model.deadline_ms<1)throw new StorageFailure('document_model_configuration_invalid');
 const preparation=modelPreparation(modelConfig);
 const caller=createExtractionModelCaller({ctx:options.ctx,provider:options.provider,permit:options.permit}),calls=ownedCalls(model.deadline_ms);
 async function prepare(request:DocumentRequest,input:Parameters<DocumentModelPort['prepare']>[1]){
  if(calls.closed)throw new StorageFailure('document_model_closed');
  if(input.scope.owner_id!==options.ownerId||!request.system||!Array.isArray(request.messages)||!Array.isArray(request.tools)||!request.tools.length)throw new StorageFailure('document_model_scope_invalid');
  input.signal.throwIfAborted();await input.requireCurrent();
  const auth=await provider.resolveAuth(provider.connection);
  if(!hasModelCredential(auth))throw new StorageFailure('document_model_credentials_unavailable');
  input.signal.throwIfAborted();return {...preparation};
 }
 return {
  prepare:(request,input)=>calls.track(prepare(request,{...input,signal:calls.signalFor(input.signal)})),
  invoke:(request,input)=>calls.track((async()=>{
   const signal=calls.signalFor(input.signal),snapshot=structuredClone({system:request.system,messages:request.messages,tools:request.tools});
   await prepare(request,{scope:input.scope,signal,requireCurrent:input.requireCurrent});
   return caller.call({request_id:input.requestId,attempt_id:input.attemptId,...input.scope,claim:input.claim,binding,profile,signal,
    requireCurrent:input.requireCurrent,onReceipt:input.onReceipt,system:snapshot.system,messages:snapshot.messages as GenerateOptions['messages'],tools:snapshot.tools as GenerateOptions['tools']});
  })()),
  close:()=>calls.close(),
 };
}
