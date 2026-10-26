/** 质量case的单次物理调用；只复用已安装provider、原许可与PG回执。 */
import type {Context} from '@deepseek-ai/cordis';
import {LlmError,ReasoningEffortId,type ContentBlock,type LlmFailure} from '@deepseek-ai/dsh-llm';
import {SessionId} from '@deepseek-ai/dsh-session';
import {randomUUID} from 'node:crypto';
import {createConnection} from 'node:net';
import {createInterface} from 'node:readline';
import type {installModelProvider} from '../platform/models/model-provider.ts';
import {modelLedgerInputBudget,type ModelLedgerReceipt,type ModelLedgerUsage} from '../platform/models/model-ledger.ts';
import {extractionUnconfirmedRequests,recordExtractionModelReceipt,ExtractionModelError,type ExtractionPermitEndpoint} from '../memory/extraction/model.ts';
import {validateQualityModelClaim,qualityModelRequestId} from './quality-model-authorization.ts';
import {OrganizationQualityError} from './organization-quality-contract.ts';
import type {OrganizationQualityModelInput,OrganizationQualityModelResult} from './organization-quality-runtime.ts';

export class QualityModelError extends Error {
  readonly code:string;readonly receipt:ModelLedgerReceipt|null;
  constructor(code:string,receipt:ModelLedgerReceipt|null=null,cause?:unknown){
    super(code,cause===undefined?undefined:{cause});this.code=code;this.receipt=receipt;
  }
}
interface PermitState{state:string;permit_id?:string;}
function connect(endpoint:ExtractionPermitEndpoint,signal:AbortSignal){
  const socket=createConnection(endpoint.path),reader=createInterface({input:socket}),lines=reader[Symbol.asyncIterator]();
  socket.on('error',()=>{});let cancellable=true;
  const abort=()=>socket.destroy();signal.addEventListener('abort',abort,{once:true});
  return {
    async exchange(value:unknown,timeout=10_000):Promise<PermitState>{
      if(cancellable)signal.throwIfAborted();
      socket.write(`${JSON.stringify(value)}\n`);let timer:ReturnType<typeof setTimeout>|undefined;
      let closed:()=>void=()=>{};
      try{
        const item=await Promise.race([lines.next(),new Promise<never>((_,reject)=>{
          closed=()=>reject(new QualityModelError('quality_model_ack_unknown'));
          socket.once('close',closed);
          if(timeout)timer=setTimeout(()=>{socket.destroy();reject(new QualityModelError('quality_model_ack_unknown'));},timeout);
        })]);
        if(item.done||Buffer.byteLength(item.value)>4096)throw new QualityModelError('quality_model_ack_unknown');
        return JSON.parse(item.value) as PermitState;
      }catch(error){if(error instanceof QualityModelError)throw error;throw new QualityModelError('quality_model_ack_unknown',null,error);}
      finally{clearTimeout(timer);socket.off('close',closed);}
    },
    detachCancellation(){cancellable=false;signal.removeEventListener('abort',abort);},
    close(){signal.removeEventListener('abort',abort);reader.close();socket.destroy();},
  };
}
function failureValue(error:LlmError|LlmFailure):LlmFailure {
  return error instanceof LlmError?error.failure:error;
}
function stale(error:unknown):boolean {
  return error instanceof OrganizationQualityError&&['quality_input_changed','quality_evidence_not_found'].includes(error.code);
}

export function createQualityModelCaller(options:{ctx:Context;provider:ReturnType<typeof installModelProvider>;permit:ExtractionPermitEndpoint}) {
  const diagnosticProblemBudgetBound=options.provider.diagnosticProblemBudgetBound===true;
  return {get diagnosticProblemBudgetBound():boolean{return diagnosticProblemBudgetBound;},
    async call(input:OrganizationQualityModelInput):Promise<OrganizationQualityModelResult>{
    const claim=validateQualityModelClaim({kind:'quality_case',run_id:input.run_id,case_id:input.case_id,execution_token:input.execution_token,phase:input.phase});
    if(input.request_id!==qualityModelRequestId(input.run_id,input.case_id,input.phase))throw new QualityModelError('quality_model_request_invalid');
    input.signal.throwIfAborted();await input.requireCurrent();input.signal.throwIfAborted();
    if((await extractionUnconfirmedRequests(options.permit,input)).includes(input.request_id))throw new QualityModelError('quality_model_recovery_unknown');
    const prepared=await options.ctx.llm.prepareCall({...input.binding,stop:input.binding.stop?[...input.binding.stop]:undefined,
      reasoningEffort:ReasoningEffortId(input.binding.reasoningEffort)},input.signal);
    const connection=connect(options.permit,input.signal),started=Date.now(),sessionId=SessionId(randomUUID());
    let call:ReturnType<typeof options.provider.beginCall>|undefined,receipt:ModelLedgerReceipt|null=null;
    let held=false,reserved=false,settled=false,rejected=false,success=false,scopeStale=false,pgReservationStarted=false;
    let dispatchFailure:unknown;
    let observedFailure:LlmFailure|undefined,caught:unknown,usage:ModelLedgerUsage|null=null;
    const blocks:ContentBlock[]=[];
    try{
      const granted=await connection.exchange({op:'acquire',token:options.permit.token,kind:'background',attempt_id:input.attempt_id,
        worker:{pid:process.pid,parentPid:process.ppid,executable:process.execPath}},0);
      if(granted.state!=='granted'||!granted.permit_id)throw new QualityModelError('quality_model_permit_unavailable');
      held=true;connection.detachCancellation();
      const base:ModelLedgerReceipt={attempt_id:input.attempt_id,permit_id:granted.permit_id,request_id:input.request_id,
        owner_id:input.owner_id,contact_id:input.contact_id,scope_kind:input.contact_id===null?'owner_memory':'contact',
        provider:input.binding.provider,model:input.binding.model,called_at:new Date(started).toISOString(),latency_ms:null,
        dispatch:'authorized_unconfirmed',outcome:'pending',usage:null,cost:{status:'unknown',amount:null,currency:null,pricing_version:null}};
      call=options.provider.beginCall({sessionId,attempt_id:input.attempt_id,permit_id:granted.permit_id,binding:input.binding,
        profile:input.profile,requireCurrent:input.requireCurrent,beforeDispatch:async value=>{
          receipt={...base,input_budget:modelLedgerInputBudget(value.budget)};
          // 官方adapter拥有最终序列化；语义输入与实际wire摘要分别保存，不冒充原始HTTP包。
          try{await input.onDispatch({request_payload:{model:input.binding.model,messages:input.messages,
            ...(input.system===undefined?{}:{system:input.system}),...(input.tools===undefined?{}:{tools:input.tools}),
            controls:{maxTokens:input.binding.maxTokens,temperature:input.binding.temperature,reasoningEffort:input.binding.reasoningEffort,stop:input.binding.stop}},
            request_route:input.binding.provider,measurements:{request_sha256:value.budget.request_sha256,
              serialized_bytes:value.budget.serialized_bytes,measurement_id:value.budget.measurement_id,
              request_entity_characters:value.request_entity_characters,request_payload_kind:'normalized_generate_options'}});}
          catch(error){dispatchFailure=error;throw error;}
          input.signal.throwIfAborted();await input.requireCurrent();input.signal.throwIfAborted();
          pgReservationStarted=true;
          const response=await connection.exchange({op:'reserve_quality',receipt,quality_claim:claim});
          if(response.state!=='reserved'){rejected=true;throw new QualityModelError('quality_model_reservation_rejected');}
          reserved=true;input.signal.throwIfAborted();await input.requireCurrent();input.signal.throwIfAborted();
        }});
      for await(const chunk of prepared.stream({...prepared.config,sessionId,messages:input.messages,system:input.system,tools:input.tools,signal:input.signal})){
        if(chunk.type==='block-end')blocks.push(structuredClone(chunk.block));
        if(chunk.type==='usage')usage={input_tokens:chunk.usage.inputTokens+(chunk.usage.cacheReadTokens??0)+(chunk.usage.cacheWriteTokens??0),
          output_tokens:chunk.usage.outputTokens,cache_read_tokens:chunk.usage.cacheReadTokens??null,cache_write_tokens:chunk.usage.cacheWriteTokens??null};
        if(chunk.type==='finish'){
          success=['stop','tool-calls'].includes(chunk.reason.kind);
          if(chunk.reason.kind==='error'||chunk.reason.kind==='aborted')observedFailure=failureValue(chunk.reason.failure);
        }
      }
    }catch(error){caught=error;if(error instanceof LlmError)observedFailure=failureValue(error);}
    finally{
      try{
        if(reserved&&receipt){
          const current=receipt as ModelLedgerReceipt,observation=call!.observation();
          const responseObserved=observation.dispatch==='http_accepted'||observedFailure?.status!==undefined;
          receipt={...current,latency_ms:Date.now()-started,
            dispatch:responseObserved?'response_observed':observation.dispatch==='not_authorized'?'not_sent':'authorized_unconfirmed',
            outcome:success?'succeeded':input.signal.aborted||observation.dispatch==='not_authorized'?'cancelled':responseObserved?'failed':'unknown',usage};
          try{await recordExtractionModelReceipt(options.permit,receipt);}
          catch(error){
            if(error instanceof ExtractionModelError&&error.code==='extraction_model_scope_deleted')scopeStale=true;
            else throw new QualityModelError('quality_model_ack_unknown',receipt,error);
          }
          if(!scopeStale){
            try{
              await input.requireCurrent();
              await input.onReceipt(structuredClone(receipt),{response_payload:responseObserved?{content:blocks,usage}:undefined,
                measurements:{response_payload_kind:'normalized_stream',response_model_status:'unknown',system_fingerprint_status:'unknown',
                  ...(observedFailure?{failure_code:observedFailure.code}:{}),model_receipt:structuredClone(receipt)}});
            }catch(error){if(stale(error))scopeStale=true;else throw new QualityModelError('quality_model_ack_unknown',receipt,error);}
          }
          const state=await connection.exchange({op:'settled'});
          if(state.state!=='settled')throw new QualityModelError('quality_model_ack_unknown',receipt);
          settled=true;
        // 质量回调可能已进入，但只有本地代码尚未开始Unix预约才可证明没有PG授权。
        // 一旦开始exchange，即使原observation仍not_authorized，也必须保留丢失ACK的未知。
        }else if(held&&(rejected||!pgReservationStarted||call?.observation().before_dispatch_started===false)){
          const state=await connection.exchange({op:'settled'});
          if(state.state!=='settled')throw new QualityModelError('quality_model_ack_unknown',receipt);
          settled=true;
        }
      }finally{call?.close();connection.close();}
    }
    if(held&&!settled)throw new QualityModelError('quality_model_ack_unknown',receipt,caught);
    if(scopeStale)throw new QualityModelError('quality_model_scope_stale',receipt);
    if(dispatchFailure instanceof OrganizationQualityError)throw dispatchFailure;
    if(!success||!receipt)throw new QualityModelError(input.signal.aborted?'quality_model_cancelled':
      rejected?'quality_model_reservation_rejected':caught instanceof QualityModelError?caught.code:'quality_model_failed',receipt,caught);
    input.signal.throwIfAborted();await input.requireCurrent();
    return {blocks,receipt,response_payload:{content:blocks,usage}};
  }};
}
