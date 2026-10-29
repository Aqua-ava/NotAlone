/** E/V单次模型调用：复用唯一ModelHost；不增加仲裁、隐式重试或业务提交。 */
import type {Context} from '@deepseek-ai/cordis';
import {LlmError,ReasoningEffortId, type GenerateOptions, type ContentBlock,type LlmFailure} from '@deepseek-ai/dsh-llm';
import {SessionId} from '@deepseek-ai/dsh-session';
import {createConnection} from 'node:net';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import type {installModelProvider} from '../../platform/models/model-provider.ts';
import {modelLedgerInputBudget, validateModelLedgerReceipt, type ModelLedgerReceipt, type ModelLedgerCost, type ModelLedgerUsage} from '../../platform/models/model-ledger.ts';
import type {MessagesBudgetBinding, MessagesBudgetProfile} from '../../platform/models/model-input-budget.ts';
import type {ModelTaskClaim} from '../../platform/models/model-permit-server.ts';
import {DEEPSEEK_STRICT_VERIFICATION_TOOL} from './verification/deepseek-strict.ts';
export interface ExtractionPermitEndpoint {path:string;token:string}
type State={state:string;reason?:string;permit_id?:string;request_ids?:string[];next_cursor?:string|null};
export interface ExtractionProviderFailure {name:'LlmError'|'LlmFailure';code:string;status?:number;}
function providerFailureSnapshot(failure:LlmFailure,name:ExtractionProviderFailure['name']):ExtractionProviderFailure {
  return {name,code:/^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code)?failure.code:'PROVIDER_ERROR',
    ...(failure.status===undefined?{}:{status:failure.status})};
}
export class ExtractionModelError extends Error {
  readonly code:string;readonly receipt:ModelLedgerReceipt|null;
  readonly retryable:boolean;readonly provider_failure:ExtractionProviderFailure|null;
  constructor(code:string, receipt:ModelLedgerReceipt|null=null,providerFailure:ExtractionProviderFailure|null=null){
    super(code);this.code=code;this.receipt=receipt;
    this.provider_failure=providerFailure?Object.freeze({...providerFailure}):null;
    const status=providerFailure?.status;
    this.retryable=code==='extraction_model_call_failed'&&receipt?.outcome==='failed'&&receipt.dispatch==='response_observed'
      &&status!==undefined&&(status===408||status===429||status>=500);
  }
}
function connect(endpoint:ExtractionPermitEndpoint, signal?:AbortSignal) {
  let cancellable=true;
  const socket=createConnection(endpoint.path), lines=createInterface({input:socket})[Symbol.asyncIterator]();
  // error由迭代器处理；不允许认证/连接失败退回本地许可。
  socket.on('error',()=>{});
  const abort=()=>socket.destroy(); signal?.addEventListener('abort',abort,{once:true});
  async function exchange(value:unknown,timeout=10000):Promise<State> {
    if(cancellable&&signal?.aborted)throw new ExtractionModelError('extraction_model_cancelled');
    socket.write(JSON.stringify(value)+'\n');
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const item=await Promise.race([lines.next(),new Promise<never>((_,reject)=>{if(timeout)timer=setTimeout(()=>{socket.destroy();reject(new ExtractionModelError('extraction_model_ack_unknown'));},timeout);})]);
      if(item.done||Buffer.byteLength(item.value)>4096)throw new ExtractionModelError('extraction_model_ack_unknown');
      return JSON.parse(item.value);
    } catch {throw new ExtractionModelError('extraction_model_ack_unknown');}
    finally {clearTimeout(timer);}
  }
  return {socket,exchange,detachCancellation(){cancellable=false;signal?.removeEventListener('abort',abort);},close(){signal?.removeEventListener('abort',abort);socket.destroy();}};
}
/** 仅重发同一精确receipt的记账ACK；不得据PG已知解除journal未知或重发模型。 */
export async function recordExtractionModelReceipt(endpoint:ExtractionPermitEndpoint,receipt:ModelLedgerReceipt):Promise<void> {
  validateModelLedgerReceipt(receipt);
  const connection=connect(endpoint);
  try {const state=await connection.exchange({op:'record',token:endpoint.token,receipt});
    if(state.state==='accounting_rejected'&&state.reason==='scope_deleted')throw new ExtractionModelError('extraction_model_scope_deleted',receipt);
    if(state.state!=='recorded')throw new ExtractionModelError('extraction_model_ack_unknown',receipt);
  } catch(error) {if(error instanceof ExtractionModelError&&error.receipt)throw error;throw new ExtractionModelError('extraction_model_ack_unknown',receipt);}
  finally {connection.close();}
}
/** 消费者恢复必须同时询问宿主journal/孤儿；PG known不足以证明可重放。 */
export async function extractionUnconfirmedRequests(endpoint:ExtractionPermitEndpoint,scope:{owner_id:string;contact_id:string|null}):Promise<string[]> {
  const result:string[]=[];let after:string|undefined;
  do {const connection=connect(endpoint);let state:State;
    try{state=await connection.exchange({op:'unconfirmed_requests',token:endpoint.token,owner_id:scope.owner_id,contact_id:scope.contact_id,...(after?{after}:{})});}finally{connection.close();}
    const ids=state.request_ids;
    if(state.state!=='unconfirmed_requests'||!Array.isArray(ids)||ids.length>64||ids.some(id=>typeof id!=='string'||!uuid.test(id)||after!==undefined&&id<=after)||ids.join()!==[...new Set(ids)].sort().join()||state.next_cursor!==null&&(!ids.length||state.next_cursor!==ids.at(-1)))throw new ExtractionModelError('extraction_model_recovery_unknown');
    result.push(...ids);after=state.next_cursor??undefined;
  }while(after);
  return result;
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface ExtractionModelInput {
  /** 由原task/batch UUIDv5计算；每次物理调用另传新attempt_id。 */
  request_id:string;attempt_id:string;owner_id:string;contact_id:string|null;ledger_entry_id?:string;
  claim:ModelTaskClaim;binding:MessagesBudgetBinding;profile:MessagesBudgetProfile;
  messages:GenerateOptions['messages'];system?:GenerateOptions['system'];tools?:GenerateOptions['tools'];signal:AbortSignal;requireCurrent():Promise<void>;
  /** 原stream退出后、terminal receipt前校验；仅显式invalid_output记原010校验拒绝。 */
  validateOutput?(blocks:readonly ContentBlock[]):void|Promise<void>;
  costForUsage?(usage:ModelLedgerUsage):ModelLedgerCost;
  /** 原PG确认receipt后持久化最小关联；回调成功前不settle，失败保留journal未知。 */
  onReceipt?(receipt:ModelLedgerReceipt):Promise<void>;
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
      if(!text||input.messages[0].content.some(block=>block.type!=='text'))throw new ExtractionModelError('extraction_model_tool_invalid');
      return text;
    })():null;
    const config={...input.binding,reasoningEffort:ReasoningEffortId(input.binding.reasoningEffort),stop:input.binding.stop?[...input.binding.stop]:undefined};
    const prepared=strictVerification?null:await options.ctx.llm.prepareCall(config,input.signal);
    const connection=connect(options.permit,input.signal);let receipt:ModelLedgerReceipt|null=null;
    let uncertain=false,reserved=false,call:ReturnType<typeof options.provider.beginCall>|undefined;
    let strictCall:ReturnType<typeof options.provider.beginStrictVerificationCall>|undefined;
    const started=Date.now();const blocks:ContentBlock[]=[];let text='',usage:ModelLedgerUsage|null=null,success=false,failure=false,validationRejected=false;
    let providerFailure:ExtractionProviderFailure|null=null;
    try {
      const granted=await connection.exchange({op:'acquire',token:options.permit.token,kind:'background',attempt_id:input.attempt_id,worker:{pid:process.pid,parentPid:process.ppid,executable:process.execPath}},0);
      if(granted.state!=='granted'||!granted.permit_id||!uuid.test(granted.permit_id))throw new ExtractionModelError('extraction_model_permit_unavailable');
      connection.detachCancellation();
      const sessionId=SessionId(randomUUID());
      // 预约只保存110物理身份；确认HTTP后的终态才由既有账本事务建立010外键。
      const base:ModelLedgerReceipt={attempt_id:input.attempt_id,permit_id:granted.permit_id,request_id:input.request_id,owner_id:input.owner_id,contact_id:input.contact_id,scope_kind:input.contact_id===null?'owner_memory':'contact',provider:input.binding.provider,model:input.binding.model,called_at:new Date(started).toISOString(),latency_ms:null,dispatch:'authorized_unconfirmed',outcome:'pending',usage:null,cost:{status:'unknown',amount:null,currency:null,pricing_version:null}};
      const registration={sessionId,attempt_id:input.attempt_id,permit_id:granted.permit_id,binding:input.binding,profile:input.profile,requireCurrent:input.requireCurrent,beforeDispatch:async(value:{attempt_id:string;permit_id:string;budget:Parameters<typeof modelLedgerInputBudget>[0];dispatch:'authorized_unconfirmed'})=>{
        receipt={...base,input_budget:modelLedgerInputBudget(value.budget)};
        uncertain=true;const state=await connection.exchange({op:'reserve',receipt,claim:input.claim});
        if(state.state!=='reserved'){uncertain=false;throw new ExtractionModelError('extraction_model_reservation_rejected');}
        uncertain=false;reserved=true;
        input.signal.throwIfAborted();await input.requireCurrent();input.signal.throwIfAborted();
      }};
      call=strictVerification?undefined:options.provider.beginCall(registration);
      strictCall=strictVerification?options.provider.beginStrictVerificationCall(registration):undefined;
      try {
        if(strictCall&&strictVerification&&strictUser!==null){
          const result=await strictCall.send({system:input.system??'',user:strictUser,
            tool:{name:DEEPSEEK_STRICT_VERIFICATION_TOOL,description:strictVerification.description,parameters:strictVerification.parameters},signal:input.signal});
          blocks.push(...structuredClone(result.blocks) as ContentBlock[]);
          text=result.blocks.filter(block=>block.type==='text').map(block=>block.text).join('');
          usage=result.usage;success=result.success;failure=!success;
        }else if(prepared){
          for await(const chunk of prepared.stream({...prepared.config,sessionId,messages:input.messages,system:input.system,tools:input.tools,signal:input.signal})) {
            if(chunk.type==='block-end')blocks.push(structuredClone(chunk.block));
            if(chunk.type==='text-delta')text+=chunk.text;
            if(chunk.type==='usage')usage={input_tokens:chunk.usage.inputTokens+(chunk.usage.cacheReadTokens??0)+(chunk.usage.cacheWriteTokens??0),output_tokens:chunk.usage.outputTokens,cache_read_tokens:chunk.usage.cacheReadTokens??null,cache_write_tokens:chunk.usage.cacheWriteTokens??null};
            if(chunk.type==='finish'){
              success=['stop','tool-calls'].includes(chunk.reason.kind);failure=!success;
              if(chunk.reason.kind==='error'||chunk.reason.kind==='aborted')providerFailure=providerFailureSnapshot(chunk.reason.failure,'LlmFailure');
            }
          }
        }else throw new ExtractionModelError('extraction_model_call_failed');
      } catch(error) {
        failure=true;
        // 官方adapter在非2xx时不会accept；LlmError的结构化status仍证明已观察HTTP响应。
        // 只保留稳定分类，不把上游message、cause或requestId带入业务错误。
        if(error instanceof LlmError)providerFailure=providerFailureSnapshot(error.failure,'LlmError');
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
        receipt={...reservedReceipt,...(responseObserved&&input.ledger_entry_id?{ledger_entry_id:input.ledger_entry_id}:{}),latency_ms:Date.now()-started,
          dispatch:responseObserved?'response_observed':observation.dispatch==='not_authorized'?'not_sent':'authorized_unconfirmed',
          outcome:validationRejected?'failed':success?'succeeded':responseObserved&&failure?'failed':observation.dispatch==='not_authorized'?'cancelled':'unknown',
          usage,...(validationRejected?{legacy_outcome:'rejected_by_validation' as const}:{}),cost:usage&&input.costForUsage?input.costForUsage(usage):base.cost};
        uncertain=true;
        try {await recordExtractionModelReceipt(options.permit,receipt);uncertain=false;}
        catch(error) {
          if(error instanceof ExtractionModelError&&error.code==='extraction_model_scope_deleted'){
            uncertain=false;const state=await connection.exchange({op:'settled'});
            if(state.state!=='settled')throw new ExtractionModelError('extraction_model_ack_unknown',receipt);
          }
          throw error;
        }
      }
      if(uncertain)throw new ExtractionModelError('extraction_model_ack_unknown',receipt);
      if(receipt)await input.onReceipt?.(structuredClone(receipt));
      const state=await connection.exchange({op:'settled'});if(state.state!=='settled')throw new ExtractionModelError('extraction_model_ack_unknown',receipt);
      if(outputError!==undefined)throw outputError;
      if(validationRejected)throw new ExtractionModelError('extraction_model_validation_failed',receipt);
      if(!success||!receipt){
        const rejection=(strictCall??call)?.observation().budget_rejection;
        throw new ExtractionModelError(input.signal.aborted?'extraction_model_cancelled':rejection?.code==='reply_budget_exceeded'?'extraction_model_budget_exceeded':rejection?'extraction_model_budget_unavailable':'extraction_model_call_failed',receipt,providerFailure);
      }
      input.signal.throwIfAborted();await input.requireCurrent();
      return {text,blocks,receipt};
    } catch(error) {
      if(error instanceof ExtractionModelError&&!error.receipt&&receipt)throw new ExtractionModelError(error.code,receipt,error.provider_failure);
      throw error;
    } finally {call?.close();strictCall?.close();connection.close();}
  }};
}
