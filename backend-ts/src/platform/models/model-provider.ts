/** 普通调用沿用官方DeepSeekAdapter；来源核验另用同供应商的专用strict Beta传输。 */
import type { Context } from '@deepseek-ai/cordis';
import {AsyncLocalStorage} from 'node:async_hooks';
import {channel} from 'node:diagnostics_channel';
import {LlmError,type ImageBlock,type TextBlock,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm';
import {bindDiagnosticProblemBudget} from '../../diagnostics/diagnostic-problem-budget.ts';
import {currentDiagnosticTrace,newTraceId} from '../../diagnostics/context.ts';
import {recordImageCallDiagnostic,type ImageCallDiagnosticImage,type ImageCallFailureCategory} from './image-call-diagnostics.ts';
import { DeepSeekAdapter, DeepSeekFileStore,resolveRequestImageTarget, PUBLIC_BASE_URL, type DeepSeekConnectionOptions, type DeepSeekAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek';
import {ModelImageAttachments,type ModelImageInput,type ModelImageManifest} from './model-images.ts';
import {
  prepareBoundMessagesRequest,measureSerializedMessages,measureSerializedStrictChatCompletion,ModelInputBudgetError,
  type MessagesBudgetBinding,type MessagesBudgetProfile,type MessagesBudgetReceipt,
} from './model-input-budget.ts';
import {
  buildDeepSeekStrictVerificationRequest,decodeDeepSeekStrictVerificationResponse,
  DEEPSEEK_STRICT_VERIFICATION_ENDPOINT,type DeepSeekStrictVerificationResponse,
} from './deepseek-strict.ts';
export interface ModelProviderCall {
  sessionId: string; attempt_id: string; permit_id: string;
  contactPrefix?: string;
  binding: MessagesBudgetBinding; profile: MessagesBudgetProfile;
  requireCurrent(): Promise<void>;
  onImageInputs?(images:readonly ModelImageManifest[]):Promise<void>;
  /** HTTP发送前强制持久化授权。此时发送仍可能被signal阻止，不能记成已发。 */
  beforeDispatch(value: {attempt_id:string;permit_id:string;budget:MessagesBudgetReceipt;dispatch:'authorized_unconfirmed';
    /** 最终序列化HTTP实体的Unicode字符数；不携带正文。 */
    request_entity_characters?:number}): Promise<void>;
}
export type ModelTransportCategory='socket_closed'|'reset'|'timeout'|'tls'|'dns'|'other';
export interface ModelProviderObservation {
  attempt_id: string; permit_id: string;
  dispatch: 'not_authorized'|'authorized_unconfirmed'|'http_accepted';
  /** 显式 false 才能证明尚未进入原预约回调；旧观测缺省时仍按未知处理。 */
  before_dispatch_started?: boolean;
  /** 仅显式false证明未到物理fetch前门；缺省或true均不能证明未发送。 */
  fetch_started?:boolean;
  request_bytes?:number;image_count?:number;
  /** 原生Undici请求身份及实际HTTP头观测；缺省不证明尚未收到响应。 */
  http_request_observed?:boolean;headers_received?:boolean;http_status?:number;
  transport_category?:ModelTransportCategory;
  /** 仅来自实际adapter/strict fetch的终端传输失败；首响应前官方TIMEOUT可纳入，取消不属于此类。 */
  terminal_transport_failure?:boolean;
  failure_category?:ImageCallFailureCategory;response_status?:number;terminal_outcome?:'succeeded'|'failed';
  budget: MessagesBudgetReceipt | null;
  budget_rejection:{code:ModelInputBudgetError['code'];receipt:MessagesBudgetReceipt|null}|null;
}
export interface ModelProviderConfiguration {
  provider: string;
  connection: DeepSeekConnectionOptions;
  resolveAuth: DeepSeekAdapterOptions['resolveAuth'];
  resolveUserId: DeepSeekAdapterOptions['resolveUserId'];
  /** 同一接收方的 DeepSeek strict Beta Chat Completions；官方 Messages 根可省略并按固定规则推导。 */
  strictVerificationEndpoint?: string;
}
export interface StrictVerificationSendInput {
  system:string;user:string;tool:{name:'SourceVerificationOutput';description:string;parameters:Record<string,unknown>};
  images?:readonly ImageBlock[];
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
/** 只投影稳定枚举；底层异常和cause链不会保存到观测或账本。 */
function transportCategory(error:unknown):ModelTransportCategory {
  const seen=new Set<unknown>();let value=error;
  for(let depth=0;value&&typeof value==='object'&&depth<8&&!seen.has(value);depth++){
    seen.add(value);const row=value as {code?:unknown;name?:unknown;cause?:unknown;failure?:{code?:unknown}};
    if(row.name==='TimeoutError')return 'timeout';
    const code=typeof row.code==='string'?row.code:row.failure?.code;
    if(code==='UND_ERR_SOCKET')return 'socket_closed';
    if(code==='ECONNRESET'||code==='EPIPE')return 'reset';
    if(code==='ENOTFOUND'||code==='EAI_AGAIN')return 'dns';
    if(typeof code==='string'&&(/^(?:ERR_TLS_|ERR_SSL_|CERT_)/.test(code)||['DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE','SELF_SIGNED_CERT_IN_CHAIN'].includes(code)))return 'tls';
    if(typeof code==='string'&&['TIMEOUT','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(code))return 'timeout';
    value=row.cause;
  }
  return 'other';
}
function observeTransportFailure(observation:ModelProviderObservation,error:unknown,signal?:AbortSignal):void {
  if(!(error instanceof LlmError)||!['TRANSPORT','TIMEOUT','ABORTED'].includes(error.failure.code))return;
  observation.transport_category=transportCategory(error);
  const awaitingImageResponse=error.failure.code==='TIMEOUT'&&observation.fetch_started===true&&observation.http_request_observed===true
    &&observation.headers_received!==true&&observation.http_status===undefined
    &&observation.dispatch==='authorized_unconfirmed'&&observation.response_status===undefined&&(observation.image_count??0)>0;
  observation.terminal_transport_failure=!signal?.aborted&&(error.failure.code==='TRANSPORT'||awaitingImageResponse);
}
function diagnosticFailureCategory(error:unknown,signal?:AbortSignal):ImageCallFailureCategory {
 if(signal?.aborted||error instanceof LlmError&&error.failure.code==='ABORTED')return 'cancelled';
 let current=error;const seen=new Set<unknown>();
 for(let depth=0;current&&typeof current==='object'&&depth<8&&!seen.has(current);depth++){
  seen.add(current);const row=current as {code?:unknown;message?:unknown;cause?:unknown};
  if(row.code==='extraction_model_image_budget_exceeded'||row.message==='extraction_model_image_budget_exceeded')return 'image_budget';
  if(row.code==='extraction_model_image_invalid'||row.message==='extraction_model_image_invalid')return 'image_invalid';
  if(typeof row.code==='string'&&row.code.startsWith('reply_budget_'))return 'model_budget';
  current=row.cause;
 }
 return transportCategory(error);
}
function observeProviderFailure(observation:ModelProviderObservation,error:unknown,signal?:AbortSignal):void {
 observeTransportFailure(observation,error,signal);observation.terminal_outcome='failed';
 observation.failure_category=diagnosticFailureCategory(error,signal);
 if(error instanceof LlmError&&error.failure.status!==undefined)observation.response_status=error.failure.status;
}
interface RegisteredCall {
 call:ModelProviderCall;observation:ModelProviderObservation;prepared:boolean;
 traceId:string;startedAt:number;images:ImageCallDiagnosticImage[];
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
  const calls=new Map<string,RegisteredCall>();
  const dispatchContext=new AsyncLocalStorage<{observation:ModelProviderObservation}>();
  const nativeRequests=new WeakMap<object,ModelProviderObservation>();
  const requestCreated=channel('undici:request:create'),responseHeaders=channel('undici:request:headers');
  // Node 24 / Undici 7.30.1公开channel：仅按请求对象关联，不读取URL、请求头或正文。
  // https://github.com/nodejs/undici/blob/v7.30.1/docs/docs/api/DiagnosticsChannel.md
  const observeRequestCreated=(message:unknown):void=>{
    try{
      const current=dispatchContext.getStore();
      if(!current||current.observation.fetch_started!==true||!message||typeof message!=='object')return;
      const request=(message as {request?:unknown}).request;if(!request||typeof request!=='object')return;
      nativeRequests.set(request,current.observation);current.observation.http_request_observed=true;
    }catch{/* 观测不足时保留未知，不影响实际请求。 */}
  };
  const observeResponseHeaders=(message:unknown):void=>{
    try{
      if(!message||typeof message!=='object')return;
      const value=message as {request?:unknown;response?:{statusCode?:unknown}};
      if(!value.request||typeof value.request!=='object')return;
      const observation=nativeRequests.get(value.request);if(!observation)return;
      observation.headers_received=true;
      const status=value.response?.statusCode;
      if(typeof status==='number'&&Number.isInteger(status)&&status>=100&&status<=999)observation.http_status=status;
    }catch{/* 已收到头的标记先保留；不能因状态读取失败推定没有响应。 */}
  };
  const imageScopes=new AsyncLocalStorage<readonly ImageCallDiagnosticImage[]>();
  let images:ModelImageAttachments|undefined;
  // 官方store的公开transport接点强制零上传HTTP，触发官方inline fallback；不产生远端文件与重试。
  const inlineFiles=new DeepSeekFileStore({fetch:async()=>{throw new Error('model_image_files_disabled');}});
  // 沿官方公开prepareCall/stream包装异常；宿主转换finish后仍能保留脱敏传输分类。
  async function* observeStream(stream:AsyncIterable<StreamChunk>,options:GenerateOptions):AsyncGenerator<StreamChunk>{
    try{for await(const chunk of stream){
      const current=options.sessionId?calls.get(String(options.sessionId)):undefined;
      if(current&&chunk.type==='finish'){
        current.observation.terminal_outcome=['stop','tool-calls'].includes(chunk.reason.kind)?'succeeded':'failed';
        if(chunk.reason.kind==='error'||chunk.reason.kind==='aborted'){
          current.observation.failure_category=chunk.reason.kind==='aborted'?'cancelled':current.observation.transport_category??'other';
          if(chunk.reason.failure.status!==undefined)current.observation.response_status=chunk.reason.failure.status;
        }
      }
      yield chunk;
    }}catch(error){
      const current=options.sessionId?calls.get(String(options.sessionId)):undefined;
      if(current)observeProviderFailure(current.observation,error,options.signal);
      throw error;
    }
  }
  class ObservedDeepSeekAdapter extends DeepSeekAdapter {
    override async prepareCall(provider:string,model:string,signal?:AbortSignal){
      const prepared=await super.prepareCall(provider,model,signal);
      return {...prepared,stream:(options:GenerateOptions)=>observeStream(prepared.stream(options),options)};
    }
    override stream(options:GenerateOptions):AsyncIterable<StreamChunk>{return observeStream(super.stream(options),options);}
  }
  const adapter=new ObservedDeepSeekAdapter({
    options:()=>connection,
    resolveAuth:configuration.resolveAuth,
    resolveUserId:()=>{
      // 锁定官方adapter只在构造fetch请求头时调用此钩子；标记后仍保守视为可能已发送。
      const current=dispatchContext.getStore();if(current)current.observation.fetch_started=true;
      return configuration.resolveUserId();
    },
    resolveAttachments:()=>images,
    resolveFiles:()=>inlineFiles,
    prepareExtensions:async request=>{
      const current=request.sessionId ? calls.get(request.sessionId) : undefined;
      if(!current||request.purpose!==undefined||current.prepared)throw new Error('model_provider_call_not_authorized');
      current.prepared=true;
      request.signal.throwIfAborted();
      await current.call.requireCurrent();
      request.signal.throwIfAborted();
      let budget:MessagesBudgetReceipt;
      const prepared=prepareBoundMessagesRequest(request.body,current.call.binding);
      const imageInputs=images?.manifest()??[];
      observeImageInputs(current,imageInputs);
      current.observation.request_bytes=Buffer.byteLength(JSON.stringify(prepared.body),'utf8');current.observation.image_count=imageInputs.length;
      try{budget=measureSerializedMessages(prepared.body,current.call.binding,current.call.profile,imageInputs);}
      catch(error){if(error instanceof ModelInputBudgetError)current.observation.budget_rejection={code:error.code,receipt:error.receipt};throw error;}
      if(imageInputs.length)await current.call.onImageInputs?.(imageInputs);
      const checkDiagnosticDispatch=diagnosticBudget?.reserve();
      current.observation.before_dispatch_started=true;
      await current.call.beforeDispatch({attempt_id:current.call.attempt_id,permit_id:current.call.permit_id,budget,dispatch:'authorized_unconfirmed',
        request_entity_characters:[...JSON.stringify(prepared.body)].length});
      checkDiagnosticDispatch?.();
      current.observation.budget=budget;
      current.observation.dispatch='authorized_unconfirmed';
      request.signal.throwIfAborted();
      return {fields:prepared.fields,accept:async()=>{current.observation.dispatch='http_accepted';}};
    },
  });
  const dispose=ctx.llm.registerAdapter([configuration.provider],adapter);
  requestCreated.subscribe(observeRequestCreated);responseHeaders.subscribe(observeResponseHeaders);
  function observeImageInputs(current:RegisteredCall,manifests:readonly ModelImageManifest[]):void {
    current.images=manifests.map(image=>({id:image.id,originalBytes:image.originalBytes??current.images.find(input=>input.id===image.id)?.originalBytes??image.bytes,
      sentBytes:image.bytes,width:image.width,height:image.height,mimeType:image.requestMimeType}));
  }
  function close(registered:RegisteredCall):void {
    if(calls.get(registered.call.sessionId)!==registered)return;
    calls.delete(registered.call.sessionId);
    const observation=registered.observation;
    recordImageCallDiagnostic({callId:registered.call.attempt_id,traceId:registered.traceId,contactPrefix:registered.call.contactPrefix,
      images:registered.images,requestBytes:observation.request_bytes??observation.budget?.serialized_bytes??0,
      durationMs:Math.max(0,Date.now()-registered.startedAt),stage:observation.headers_received===true||observation.http_status!==undefined||observation.dispatch==='http_accepted'||observation.response_status!==undefined?'response_received'
        :observation.fetch_started===false||observation.dispatch==='not_authorized'?'before_send':'awaiting_response',
      failureCategory:observation.failure_category??(observation.terminal_outcome==='succeeded'?'none':observation.transport_category??'other'),
      outcome:observation.terminal_outcome??'unknown'});
  }
  function register(call:ModelProviderCall){
    if(!call.sessionId||!call.attempt_id||!call.permit_id||call.binding.provider!==configuration.provider||calls.has(call.sessionId))throw new Error('model_provider_call_conflict');
    const registered={call:{...call,binding:freeze(structuredClone(call.binding)),profile:freeze(structuredClone(call.profile))},
      observation:{attempt_id:call.attempt_id,permit_id:call.permit_id,dispatch:'not_authorized' as ModelProviderObservation['dispatch'],before_dispatch_started:false,budget:null as MessagesBudgetReceipt|null,budget_rejection:null as ModelProviderObservation['budget_rejection']} as ModelProviderObservation,
      prepared:false,traceId:currentDiagnosticTrace()??newTraceId(),startedAt:Date.now(),images:[...(imageScopes.getStore()??[])]};
    calls.set(call.sessionId,registered);
    return registered;
  }
  return {
    withImages<T>(input:readonly ModelImageInput[],signal:AbortSignal,work:(blocks:(TextBlock|ImageBlock)[])=>Promise<T>):Promise<T>{
      // 附件是该provider内部的调用适配，不改变整个profile的可选依赖树。
      return (images??=new ModelImageAttachments(ctx.isolate('attachments'))).withImages(input,signal,blocks=>{
        const refs=blocks.filter((block):block is ImageBlock=>block.type==='image');
        const metadata=input.map((image,index)=>({id:image.id,originalBytes:image.originalBytes??Buffer.byteLength(image.dataBase64,'base64'),
          sentBytes:0,width:refs[index]?.attachment.width,height:refs[index]?.attachment.height,mimeType:refs[index]?.attachment.mediaType}));
        return imageScopes.run(metadata,()=>work(blocks));
      });
    },
    /** 只反映安装时成功绑定；不表示尚有额度，不暴露账本身份或重读env。 */
    get diagnosticProblemBudgetBound():boolean {return diagnosticBudget!==null;},
    beginCall(call: ModelProviderCall) {
      const registered=register(call);
      return {
        runWithDispatchObservation<T>(work:()=>Promise<T>):Promise<T>{
          if(registered.observation.fetch_started===undefined)registered.observation.fetch_started=false;
          return dispatchContext.run(registered,work);
        },
        observation:():ModelProviderObservation=>structuredClone(registered.observation),
        /** 在实际官方stream退出后释放session，取消等待者不能提前解绑在途调用。 */
        close() { close(registered); },
      };
    },
    beginStrictVerificationCall(call:ModelProviderCall){
      const registered=register(call);registered.observation.fetch_started=false;
      return {
        observation:():ModelProviderObservation=>structuredClone(registered.observation),
        async send(input:StrictVerificationSendInput):Promise<DeepSeekStrictVerificationResponse>{
          try{
          if(registered.prepared)throw new LlmError('DeepSeek strict call was already prepared.','INVALID_REQUEST');
          registered.prepared=true;
          input.signal.throwIfAborted();
          await registered.call.requireCurrent();input.signal.throwIfAborted();
          if(!strictEndpoint)throw new LlmError('DeepSeek strict endpoint is not configured for this route.','INVALID_REQUEST');
          const model=connection.models.find(model=>model.id===registered.call.binding.model);
          if(input.images?.length&&model?.inputModalities?.includes('image')!==true)throw new LlmError('This model has no declared image input.','UNSUPPORTED_CONTENT');
          const encoded=[];
          for(const image of input.images??[]){
            const version=await images!.readImageRequest(image.attachment,resolveRequestImageTarget(model!,image.attachment),input.signal);
            encoded.push({mimeType:version.mediaType,dataBase64:Buffer.from(version.data).toString('base64')});
          }
          const request=buildDeepSeekStrictVerificationRequest({
            model:registered.call.binding.model,system:input.system,user:input.user,tool:input.tool,
            maxTokens:registered.call.binding.maxTokens,temperature:registered.call.binding.temperature,
            reasoningEffort:registered.call.binding.reasoningEffort,endpoint:strictEndpoint,images:encoded,
          });
          let budget:MessagesBudgetReceipt;
          const imageInputs=images?.manifest()??[];
          observeImageInputs(registered,imageInputs);
          registered.observation.request_bytes=Buffer.byteLength(JSON.stringify(request.body),'utf8');registered.observation.image_count=imageInputs.length;
          try{budget=measureSerializedStrictChatCompletion(request.body,registered.call.binding,registered.call.profile,imageInputs);}
          catch(error){
            if(error instanceof ModelInputBudgetError)registered.observation.budget_rejection={code:error.code,receipt:error.receipt};
            throw error;
          }
          if(imageInputs.length)await registered.call.onImageInputs?.(imageInputs);
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
          registered.observation.fetch_started=true;
          try{response=await fetch(request.endpoint,{method:'POST',headers,body:JSON.stringify(request.body),
            redirect:'error',signal:input.signal});}
          catch(error){const failure=new LlmError('DeepSeek strict transport failed.',input.signal.aborted||error instanceof Error&&error.name==='AbortError'?'ABORTED':'TRANSPORT',{cause:error});observeTransportFailure(registered.observation,failure,input.signal);throw failure;}
          if(!response.ok)throw httpFailure(response.status);
          registered.observation.dispatch='http_accepted';
          let payload:unknown;
          try{payload=JSON.parse(await boundedResponseText(response));}
          catch(error){throw new LlmError('DeepSeek strict response was not valid JSON.','INVALID_RESPONSE',{cause:error});}
          try{const result=decodeDeepSeekStrictVerificationResponse(payload);registered.observation.terminal_outcome=result.success?'succeeded':'failed';return result;}
          catch(error){throw new LlmError('DeepSeek strict response did not match the tool envelope.','INVALID_RESPONSE',{cause:error});}
          }catch(error){observeProviderFailure(registered.observation,error,input.signal);throw error;}
        },
        close() { close(registered); },
      };
    },
    async dispose() {
      if(calls.size)throw new Error('model_provider_calls_not_settled');
      images?.assertIdle();
      await dispose();
      requestCreated.unsubscribe(observeRequestCreated);responseHeaders.unsubscribe(observeResponseHeaders);
    },
  };
}
