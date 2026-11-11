/** E/V单次模型调用：复用唯一ModelHost；不增加仲裁、隐式重试或业务提交。 */
import type {Context} from '@deepseek-ai/cordis';
import {LlmError,ReasoningEffortId, type GenerateOptions, type ContentBlock,type LlmFailure} from '@deepseek-ai/dsh-llm';
import {SessionId} from '@deepseek-ai/dsh-session';
import {randomUUID} from 'node:crypto';
import type {ModelTransportCategory,installModelProvider} from '../../platform/models/model-provider.ts';
import type {ModelImageManifest} from '../../platform/models/model-images.ts';
import {modelLedgerInputBudget, validateModelLedgerReceipt, type ModelLedgerReceipt, type ModelLedgerCost, type ModelLedgerUsage} from '../../platform/models/model-ledger-contract.ts';
import type {MessagesBudgetBinding, MessagesBudgetProfile} from '../../platform/models/model-input-budget.ts';
import type {ModelTaskClaim,ModelPermitPort,ModelPermitLease} from '../../platform/models/model-permit-port.ts';
import {ModelLedgerError} from '../../platform/models/model-ledger-contract.ts';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import {DEEPSEEK_STRICT_VERIFICATION_TOOL} from './verification/deepseek-strict.ts';
export type ExtractionPermitEndpoint=ModelPermitPort;
export interface ExtractionProviderFailure {name:'LlmError'|'LlmFailure';code:string;status?:number;transport_category?:ModelTransportCategory;stage?:'before_send'|'awaiting_response'|'response_received';elapsed_ms?:number;request_bytes?:number;image_count?:number;}
function providerFailureSnapshot(failure:LlmFailure,name:ExtractionProviderFailure['name']):ExtractionProviderFailure {
  return {name,code:/^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code)?failure.code:'PROVIDER_ERROR',
    ...(failure.status===undefined?{}:{status:failure.status})};
}
/** 仅在端侧来源事件中保留校验拒绝的有界输出；不作为可重试或准入证明。 */
export interface RejectedExtractionOutput {
 readonly blocks:readonly ContentBlock[];readonly truncated:boolean;
 readonly originalBlockCount:number;readonly originalBytes:number;
}
function rejectedOutputSnapshot(blocks:readonly ContentBlock[]):RejectedExtractionOutput {
 const snapshot={blocks:[] as ContentBlock[],truncated:blocks.length>16,
  originalBlockCount:blocks.length,originalBytes:Buffer.byteLength(JSON.stringify(blocks))};
 const fits=()=>Buffer.byteLength(JSON.stringify(snapshot))<=256*1024;
 for(const block of blocks.slice(0,16)){
  const copy=structuredClone(block);snapshot.blocks.push(copy);
  if(fits())continue;
  snapshot.truncated=true;snapshot.blocks.pop();
  const field=copy.type==='tool-call'?'arguments':copy.type==='text'||copy.type==='reasoning'?'text':null;
  if(field===null)continue;
  const row=copy as unknown as Record<string,unknown>,original=row[field];
  if(typeof original!=='string')continue;
  const characters=Array.from(original);row[field]='';snapshot.blocks.push(copy);
  if(!fits()){snapshot.blocks.pop();continue;}
  let low=0,high=characters.length;
  while(low<high){
   const middle=Math.ceil((low+high)/2);row[field]=characters.slice(0,middle).join('');
   if(fits())low=middle;else high=middle-1;
  }
  row[field]=characters.slice(0,low).join('');
 }
 return Object.freeze({...snapshot,blocks:Object.freeze(snapshot.blocks.map(block=>Object.freeze(block)))});
}
export class ExtractionModelError extends Error {
  readonly code:string;readonly receipt:ModelLedgerReceipt|null;
  readonly retryable:boolean;readonly provider_failure:ExtractionProviderFailure|null;
  declare readonly rejectedOutput:RejectedExtractionOutput|undefined;
  constructor(code:string, receipt:ModelLedgerReceipt|null=null,providerFailure:ExtractionProviderFailure|null=null,rejectedBlocks?:readonly ContentBlock[]){
    super(code);this.code=code;this.receipt=receipt;
    if(code==='extraction_model_validation_failed'&&rejectedBlocks)Object.defineProperty(this,'rejectedOutput',{value:rejectedOutputSnapshot(rejectedBlocks),enumerable:false});
    this.provider_failure=providerFailure?Object.freeze({...providerFailure}):null;
    const status=providerFailure?.status;
    this.retryable=code==='extraction_model_call_failed'&&receipt?.outcome==='failed'&&receipt.dispatch==='response_observed'
      &&status!==undefined&&(status===408||status===429||status>=500);
  }
}
/** 同一精确回执仍由持久账本确认；错误类型只暴露允许的删除原因。 */
export async function recordExtractionModelReceipt(endpoint:ExtractionPermitEndpoint,receipt:ModelLedgerReceipt):Promise<void> {
  validateModelLedgerReceipt(receipt);
  try{await endpoint.recordReserved(receipt);}
  catch(error){throw new ExtractionModelError(error instanceof ModelLedgerError&&error.code==='model_ledger_scope_deleted'
    ?'extraction_model_scope_deleted':'extraction_model_ack_unknown',receipt);}
}
/** 恢复只询问 SQLite 的权威未知调用，不再维护第二份 journal。 */
export async function extractionUnconfirmedRequests(endpoint:ExtractionPermitEndpoint,scope:{owner_id:string;contact_id:string|null}):Promise<string[]> {
  let ids:string[];try{ids=await endpoint.unconfirmedRequests(scope);}catch{throw new ExtractionModelError('extraction_model_recovery_unknown');}
  if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!uuid.test(id)))throw new ExtractionModelError('extraction_model_recovery_unknown');
  return [...new Set(ids)].sort();
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 领域拒绝发生在预约事务提交前；工作线程失联或超时仍可能已经提交，不能据异常释放许可。
function reservationWasRejected(error:unknown):boolean {
  return error instanceof ModelLedgerError || error instanceof StorageFailure
    && (error.code.startsWith('memory_') || error.code==='history_source_not_available'
      || error.code==='stale_lease' || error.code==='storage_busy');
}
export interface ExtractionModelInput {
  /** 由原task/batch UUIDv5计算；每次物理调用另传新attempt_id。 */
  request_id:string;attempt_id:string;owner_id:string;contact_id:string|null;ledger_entry_id?:string;
  claim:ModelTaskClaim;binding:MessagesBudgetBinding;profile:MessagesBudgetProfile;
  messages:GenerateOptions['messages'];system?:GenerateOptions['system'];tools?:GenerateOptions['tools'];signal:AbortSignal;requireCurrent():Promise<void>;
  /** 原stream退出后、terminal receipt前校验；仅显式invalid_output记原010校验拒绝。 */
  validateOutput?(blocks:readonly ContentBlock[]):void|Promise<void>;
  costForUsage?(usage:ModelLedgerUsage):ModelLedgerCost;
  /** 存储确认receipt后持久化最小关联；回调成功前不settle，失败保留许可未知。 */
  onReceipt?(receipt:ModelLedgerReceipt):Promise<void>;
  onImageInputs?(images:readonly ModelImageManifest[]):Promise<void>;
}
export function createExtractionModelCaller(options:{ctx:Context;provider:ReturnType<typeof installModelProvider>;permit:ExtractionPermitEndpoint}) {
  return {async call(input:ExtractionModelInput):Promise<{text:string;blocks:ContentBlock[];receipt:ModelLedgerReceipt}> {
    input={...input,claim:structuredClone(input.claim),binding:structuredClone(input.binding),profile:structuredClone(input.profile),messages:structuredClone(input.messages),tools:structuredClone(input.tools)};
    const keys=['task_id','step_id','step_name','worker_id','lease_generation'];
    if(!input.claim||Object.keys(input.claim).sort().join()!==keys.sort().join()||['task_id','step_id','worker_id'].some(key=>!uuid.test(String(input.claim[key as keyof ModelTaskClaim])))||!input.claim.step_name||!Number.isSafeInteger(input.claim.lease_generation)||input.claim.lease_generation<0)throw new ExtractionModelError('extraction_model_claim_invalid');
    for(const id of [input.request_id,input.attempt_id,input.owner_id,...(input.contact_id===null?[]:[input.contact_id]),...(input.ledger_entry_id?[input.ledger_entry_id]:[])])if(!uuid.test(id))throw new ExtractionModelError('extraction_model_identity_invalid');
    input.signal.throwIfAborted();await input.requireCurrent();
    if((await extractionUnconfirmedRequests(options.permit,input)).includes(input.request_id))throw new ExtractionModelError('extraction_model_recovery_unknown');
    const selectedTools=input.tools??[],verificationTools=selectedTools.filter(tool=>tool.name===DEEPSEEK_STRICT_VERIFICATION_TOOL);
    if(verificationTools.length>0&&(selectedTools.length!==1||verificationTools.length!==1))
      throw new ExtractionModelError('extraction_model_tool_invalid');
    const strictVerification=verificationTools.length===1?verificationTools[0]:null;
    const strictUser=strictVerification?(()=>{
      if(input.messages.length!==1||input.messages[0]?.role!=='user'||!Array.isArray(input.messages[0].content))
        throw new ExtractionModelError('extraction_model_tool_invalid');
      const text=input.messages[0].content.filter(block=>block.type==='text').map(block=>block.text).join('');
      if(!text||input.messages[0].content.some(block=>block.type!=='text'&&block.type!=='image'))throw new ExtractionModelError('extraction_model_tool_invalid');
      return text;
    })():null;
    const config={...input.binding,reasoningEffort:ReasoningEffortId(input.binding.reasoningEffort),stop:input.binding.stop?[...input.binding.stop]:undefined};
    const prepared=strictVerification?null:await options.ctx.llm.prepareCall(config,input.signal);
    let permit:ModelPermitLease|undefined,receipt:ModelLedgerReceipt|null=null;
    let uncertain=false,reserved=false,reservationRejected=false,call:ReturnType<typeof options.provider.beginCall>|undefined;
    let strictCall:ReturnType<typeof options.provider.beginStrictVerificationCall>|undefined;
    const started=Date.now();const blocks:ContentBlock[]=[];let text='',usage:ModelLedgerUsage|null=null,success=false,failure=false,validationRejected=false;
    let providerFailure:ExtractionProviderFailure|null=null;
    try {
      try{permit=await options.permit.acquire(input.signal,input.attempt_id);}
      catch{throw new ExtractionModelError(input.signal.aborted?'extraction_model_cancelled':'extraction_model_permit_unavailable');}
      const sessionId=SessionId(randomUUID());
      // 预约只保存110物理身份；确认HTTP后的终态才由既有账本事务建立010外键。
      const base:ModelLedgerReceipt={attempt_id:input.attempt_id,permit_id:permit.id,request_id:input.request_id,owner_id:input.owner_id,contact_id:input.contact_id,scope_kind:input.contact_id===null?'owner_memory':'contact',provider:input.binding.provider,model:input.binding.model,called_at:new Date(started).toISOString(),latency_ms:null,dispatch:'authorized_unconfirmed',outcome:'pending',usage:null,cost:{status:'unknown',amount:null,currency:null,pricing_version:null}};
      const registration={sessionId,attempt_id:input.attempt_id,permit_id:permit.id,binding:input.binding,profile:input.profile,requireCurrent:input.requireCurrent,onImageInputs:input.onImageInputs,beforeDispatch:async(value:{attempt_id:string;permit_id:string;budget:Parameters<typeof modelLedgerInputBudget>[0];dispatch:'authorized_unconfirmed'})=>{
        receipt={...base,input_budget:modelLedgerInputBudget(value.budget)};
        uncertain=true;try{await permit!.reserve(receipt,input.claim);}
        catch(error){
          if(reservationWasRejected(error)){uncertain=false;reservationRejected=true;}
          throw new ExtractionModelError('extraction_model_reservation_rejected');
        }
        uncertain=false;reserved=true;
        input.signal.throwIfAborted();await input.requireCurrent();input.signal.throwIfAborted();
      }};
      call=strictVerification?undefined:options.provider.beginCall(registration);
      strictCall=strictVerification?options.provider.beginStrictVerificationCall(registration):undefined;
      try {
        if(strictCall&&strictVerification&&strictUser!==null){
          const result=await strictCall.send({system:input.system??'',user:strictUser,images:input.messages[0]!.content.filter(block=>block.type==='image'),
            tool:{name:DEEPSEEK_STRICT_VERIFICATION_TOOL,description:strictVerification.description,parameters:strictVerification.parameters},signal:input.signal});
          blocks.push(...structuredClone(result.blocks) as ContentBlock[]);
          text=result.blocks.filter(block=>block.type==='text').map(block=>block.text).join('');
          usage=result.usage;success=result.success;failure=!success;
        }else if(prepared){
          const consume=async()=>{for await(const chunk of prepared.stream({...prepared.config,sessionId,messages:input.messages,system:input.system,tools:input.tools,signal:input.signal})) {
            if(chunk.type==='block-end')blocks.push(structuredClone(chunk.block));
            if(chunk.type==='text-delta')text+=chunk.text;
            if(chunk.type==='usage')usage={input_tokens:chunk.usage.inputTokens+(chunk.usage.cacheReadTokens??0)+(chunk.usage.cacheWriteTokens??0),output_tokens:chunk.usage.outputTokens,cache_read_tokens:chunk.usage.cacheReadTokens??null,cache_write_tokens:chunk.usage.cacheWriteTokens??null};
            if(chunk.type==='finish'){
              success=['stop','tool-calls'].includes(chunk.reason.kind);failure=!success;
              if(chunk.reason.kind==='error'||chunk.reason.kind==='aborted')providerFailure=providerFailureSnapshot(chunk.reason.failure,'LlmFailure');
            }
          }};
          await (call?.runWithDispatchObservation?call.runWithDispatchObservation(consume):consume());
        }else throw new ExtractionModelError('extraction_model_call_failed');
      } catch(error) {
        failure=true;
        // 官方adapter在非2xx时不会accept；LlmError的结构化status仍证明已观察HTTP响应。
        // 只保留稳定分类，不把上游message、cause或requestId带入业务错误。
        if(error instanceof LlmError)providerFailure=providerFailureSnapshot(error.failure,'LlmError');
      }
      if(reservationRejected){
        receipt=null;permit?.settle();permit=undefined;
        throw new ExtractionModelError('extraction_model_reservation_rejected');
      }
      let outputError:unknown;
      if(success&&reserved&&input.validateOutput){
        try{await input.validateOutput(structuredClone(blocks));}
        catch(error){
          if(error&&typeof error==='object'&&'failure_kind' in error&&error.failure_kind==='invalid_output')validationRejected=true;
          else outputError=error;
        }
      }
      const reservedReceipt=receipt as ModelLedgerReceipt|null;
      if(reserved&&reservedReceipt) {
        const observation=(strictCall??call)!.observation();
        const responseObserved=observation.dispatch==='http_accepted'||providerFailure?.status!==undefined;
        if(providerFailure)providerFailure={...providerFailure,transport_category:observation.transport_category??'other',
          stage:responseObserved?'response_received':observation.fetch_started===false||observation.dispatch==='not_authorized'?'before_send':'awaiting_response',
          elapsed_ms:Date.now()-started,request_bytes:observation.request_bytes??observation.budget?.serialized_bytes??0,
          image_count:observation.image_count??input.messages.flatMap(message=>message.content).filter(block=>block.type==='image').length};
        const notSent=!responseObserved&&(observation.fetch_started===false||observation.dispatch==='not_authorized');
        const terminalTransport=!responseObserved&&!notSent&&!input.signal.aborted&&observation.terminal_transport_failure===true
          &&providerFailure?.code==='TRANSPORT'&&input.claim.step_name==='extraction_verification'
          &&input.messages.some(message=>message.content.some(block=>block.type==='image'));
        receipt={...reservedReceipt,...(responseObserved&&input.ledger_entry_id?{ledger_entry_id:input.ledger_entry_id}:{}),latency_ms:Date.now()-started,
          dispatch:responseObserved?'response_observed':notSent?'not_sent':'authorized_unconfirmed',
          outcome:validationRejected?'failed':success?'succeeded':responseObserved&&failure||terminalTransport?'failed':notSent?'cancelled':'unknown',
          ...(terminalTransport?{terminal_failure:'transport' as const}:{}),
          usage,...(validationRejected?{legacy_outcome:'rejected_by_validation' as const}:{}),cost:usage&&input.costForUsage?input.costForUsage(usage):base.cost};
        uncertain=true;
        try {await recordExtractionModelReceipt(options.permit,receipt);uncertain=false;}
        catch(error) {
          if(error instanceof ExtractionModelError&&error.code==='extraction_model_scope_deleted'){
            uncertain=false;permit.settle();permit=undefined;
          }
          throw error;
        }
      }
      if(uncertain)throw new ExtractionModelError('extraction_model_ack_unknown',receipt);
      if(receipt)await input.onReceipt?.(structuredClone(receipt));
      if(receipt?.outcome==='unknown'||receipt?.outcome==='pending'){permit?.orphan();permit=undefined;}
      else{permit?.settle();permit=undefined;}
      if(outputError!==undefined)throw outputError;
      if(validationRejected)throw new ExtractionModelError('extraction_model_validation_failed',receipt,null,blocks);
      if(!success||!receipt){
        const rejection=(strictCall??call)?.observation().budget_rejection;
        throw new ExtractionModelError(input.signal.aborted?'extraction_model_cancelled':rejection?.code==='reply_budget_exceeded'?'extraction_model_budget_exceeded':rejection?'extraction_model_budget_unavailable':'extraction_model_call_failed',receipt,providerFailure);
      }
      input.signal.throwIfAborted();await input.requireCurrent();
      return {text,blocks,receipt};
    } catch(error) {
      if(error instanceof ExtractionModelError&&!error.receipt&&receipt)throw new ExtractionModelError(error.code,receipt,error.provider_failure);
      throw error;
    } finally {call?.close();strictCall?.close();permit?.orphan();}
  }};
}
