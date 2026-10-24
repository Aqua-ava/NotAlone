/** 单批 A 段：原 direct E → 确定性解析 → 同窗一次 V；此处不采纳或推进水位。 */
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {DIRECT_EXTRACTION_PROMPT,DIRECT_EXTRACTION_SCHEMA} from './extraction-prompts.ts';
import {readExtractionToolArguments,ExtractionArgumentsError} from './extraction-arguments.ts';
import {parseDirectExtraction,parseSourceVerification,ExtractionProtocolError,validateExtractionWindow} from './extraction-protocol.ts';
import {buildSourceVerificationContract,buildSourceVerificationPayload,sourceCalendarPayload} from './extraction-protocol-contract.ts';
import type {ExtractionWindow,ExtractedFact,SourceVerificationResult} from './extraction-protocol.ts';

export interface ExtractionInvocation {
 purpose:'extraction'|'verification';system:string;user:string;tool:{name:string;description:string;parameters:Record<string,unknown>};
 validateOutput(blocks:readonly unknown[]):void;
}
export interface ExtractionFlowOutcome {
 accepted:ExtractedFact[];rejected_count:number;extraction_completed:boolean;
 candidate_trace_ids:string[];
 failure_kind:'invalid_output'|'unavailable'|null;failure_reason:string|null;
 verification:{fact:ExtractedFact;result:SourceVerificationResult}[];
}
export interface ExtractionFlowOptions {
 window:ExtractionWindow;signal:AbortSignal;mode?:'legacy'|'bounded-runtime-v1';max_retries?:number;retry_delay_ms?:number;
 requireCurrent():Promise<void>;
 /** 外部模型端口；每次调用必须独立许可和记账，同批身份由调用者绑定。 */
 invoke(request:ExtractionInvocation,signal:AbortSignal):Promise<{blocks:readonly unknown[]}>;
 /** 专用可删除追踪，不得接普通日志。追踪失败直接阻止本批提交。 */
 record(event:{stage:string;payload:unknown;candidate_trace_id?:string}):Promise<void>;
}
function pythonISO(raw:string|null):string {
 if(raw===null)return 'unknown';
 const match=raw.match(/^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d)(:\d\d)?(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/);
 if(!match)throw new ExtractionProtocolError();
 const micros=(match[4]??'').slice(0,6).padEnd(6,'0');
 return `${match[1]}T${match[2]}${match[3]??':00'}${Number(micros)?'.'+micros:''}${match[5]==='Z'?'+00:00':match[5]}`;
}
export function extractionWindowText(window:ExtractionWindow):string {
 validateExtractionWindow(window);
 const targets=new Set(window.target_message_ids??window.messages.map(message=>message.message_id));
 return window.messages.map((message,index)=>`${index+1}. [${targets.has(message.message_id)?'target':'context'}] [message_id=${message.message_id}] occurred_at=${pythonISO(message.occurred_at)} sender=${message.sender}: ${message.text}`
  +`\n[calendar message_id=${message.message_id}] source_calendar_at=${sourceCalendarPayload(message)} text_length=${Array.from(message.text).length}`).join('\n');
}
const directFields=Object.keys(DIRECT_EXTRACTION_SCHEMA.properties.scenes.items.properties.memories.items.properties);
function invocation(purpose:ExtractionInvocation['purpose'],prompt:string,schema:Record<string,any>,user:string,validateOutput:ExtractionInvocation['validateOutput']):ExtractionInvocation {
 return {purpose,system:prompt,user,tool:{name:schema.title,description:schema.description??'',parameters:schema},validateOutput};
}
function failure(kind:ExtractionFlowOutcome['failure_kind'],completed:boolean,rejected:number):ExtractionFlowOutcome {
 return {accepted:[],candidate_trace_ids:[],rejected_count:rejected,extraction_completed:completed,failure_kind:kind,
  failure_reason:kind==='invalid_output'?'模型输出未通过提取或来源核验，本批未写入记忆。':'模型调用不可用，本批保留待恢复。',verification:[]};
}
function invalid(error:unknown):boolean{return error instanceof ExtractionArgumentsError||error instanceof ExtractionProtocolError||Boolean(error&&typeof error==='object'&&'code' in error&&error.code==='extraction_model_validation_failed');}
function modelFailure(error:unknown):boolean{return Boolean(error&&typeof error==='object'&&'code' in error&&String(error.code).startsWith('extraction_model_'));}
function safeTransient(error:unknown):boolean {
 // 调用端必须明确证明已知失败且允许重试；未知 dispatch 或 ACK 绝不盲重放。
 const value=error as {retryable?:unknown;receipt?:{outcome?:unknown}};
 return value?.retryable===true&&value.receipt?.outcome==='failed';
}
function reviewable(fact:ExtractedFact):boolean{return fact.speech_act!=='question'&&!['joke','sarcasm','hyperbole'].includes(fact.figurative_type);}
function rawCandidates(payload:unknown){
 return (payload as {scenes:unknown[]}).scenes.flatMap(scene=>{
  const row=scene as Record<string,any>|null;
  if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.scene_name!=='string'||!row.scene_name.trim()||!Array.isArray(row.memories)){
   return [{candidate_trace_id:randomUUID(),fields:{_invalid_scene:scene} as Record<string,unknown>,payload:{scenes:[scene]}}];
  }
  return row.memories.map((memory:unknown)=>({candidate_trace_id:randomUUID(),
   fields:memory&&typeof memory==='object'&&!Array.isArray(memory)?{...memory,_scene_name:row.scene_name,_requires_all_sources:true}:{_invalid:memory},
   payload:{scenes:[{scene_name:row.scene_name,memories:[memory]}]}}));
 });
}

export async function runExtractionFlow(options:ExtractionFlowOptions):Promise<ExtractionFlowOutcome>{
 const retries=options.max_retries??5,retryDelay=options.retry_delay_ms??30000;
 if(!Number.isSafeInteger(retries)||retries<0||retries>5||!Number.isSafeInteger(retryDelay)||retryDelay<0||retryDelay>30000)throw new ExtractionProtocolError();
 if(options.mode!==undefined&&options.mode!=='legacy')throw new ExtractionProtocolError('显式历史协议尚未迁移，不允许自动改用默认提取。');
 validateExtractionWindow(options.window);options.signal.throwIfAborted();await options.requireCurrent();
 const user=extractionWindowText(options.window);let candidates:ReturnType<typeof rawCandidates>=[];
 for(let attempt=0;attempt<=retries;attempt++){
  let error:unknown,raw:readonly unknown[]|undefined;
  try{
   options.signal.throwIfAborted();await options.requireCurrent();
   raw=(await options.invoke(invocation('extraction',DIRECT_EXTRACTION_PROMPT,DIRECT_EXTRACTION_SCHEMA,user,blocks=>{
    const decoded=readExtractionToolArguments(blocks,DIRECT_EXTRACTION_SCHEMA.title,{repair:true,field_names:[...directFields,'scenes','scene_name','memories']});
    if(!Array.isArray(decoded.value.scenes))throw new ExtractionArgumentsError();
   }),options.signal)).blocks;
   const decoded=readExtractionToolArguments(raw,DIRECT_EXTRACTION_SCHEMA.title,{repair:true,field_names:[...directFields,'scenes','scene_name','memories']});
   if(!Array.isArray(decoded.value.scenes))throw new ExtractionArgumentsError();candidates=rawCandidates(decoded.value);
   await options.record({stage:'extraction_return',payload:{blocks:raw,repaired:decoded.repaired,
    payloads:candidates.map(candidate=>candidate.fields),candidate_trace_ids:candidates.map(candidate=>candidate.candidate_trace_id)}});
   break;
  }catch(caught){
   // 专用追踪故障不能被当作模型坏输出；其错误不属于这里的两种可重试类型。
   error=caught;
  }
  options.signal.throwIfAborted();
  const retryable=invalid(error)||safeTransient(error);
  if(!retryable&&!modelFailure(error))throw error;
  await options.record({stage:'extraction_recovery',payload:{attempt:attempt+1,raw:raw??null,will_retry:retryable&&attempt<retries,
   failure_kind:invalid(error)?'invalid_output':'unavailable'}});
  if(!retryable||attempt===retries){
   return failure(invalid(error)?'invalid_output':'unavailable',false,0);
  }
  // 退避发生在模型端口已经结算和释放许可之后。
  await delay(retryDelay,undefined,{signal:options.signal});
 }
 for(const [index,candidate] of candidates.entries())await options.record({stage:'candidate_raw',
  candidate_trace_id:candidate.candidate_trace_id,payload:{index,fields:candidate.fields}});
 const facts:ExtractedFact[]=[],traceIds=new Map<ExtractedFact,string>();let parsedRejections=0;
 for(const candidate of candidates){
  const parsed=parseDirectExtraction(candidate.payload,options.window),fact=parsed.accepted[0];
  parsedRejections+=parsed.rejected_count;
  await options.record({stage:'parse',candidate_trace_id:candidate.candidate_trace_id,payload:fact?
   {status:'accepted',before:candidate.fields,after:fact}:
   {status:'rejected',disposition:'structure_rejected',not_executed:['verification','adoption','write']}});
  if(fact){facts.push(fact);traceIds.set(fact,candidate.candidate_trace_id);}
 }
 const review=facts.filter(reviewable);
 if(review.length>60)return failure('invalid_output',true,parsedRejections);
 if(!review.length)return {accepted:facts,candidate_trace_ids:facts.map(fact=>traceIds.get(fact)!),rejected_count:parsedRejections,
  extraction_completed:true,failure_kind:null,failure_reason:null,verification:[]};
 await options.record({stage:'verification_input',payload:{window:options.window,facts:review,candidate_trace_ids:review.map(fact=>traceIds.get(fact)!)}});
 const contract=buildSourceVerificationContract(review),request=invocation('verification',contract.prompt,contract.schema,
  JSON.stringify(buildSourceVerificationPayload(options.window,review)),blocks=>{
   const decoded=readExtractionToolArguments(blocks,contract.schema.title);
   parseSourceVerification(decoded.value,options.window,review,{isolate_items:true});
  });
 let results:SourceVerificationResult[];
 try{
  options.signal.throwIfAborted();await options.requireCurrent();
  const raw=(await options.invoke(request,options.signal)).blocks;
  await options.record({stage:'verification_return',payload:{blocks:raw}});
  const decoded=readExtractionToolArguments(raw,contract.schema.title);
  results=parseSourceVerification(decoded.value,options.window,review,{isolate_items:true});
 }catch(error){
  options.signal.throwIfAborted();
  if(invalid(error))return failure('invalid_output',true,parsedRejections);
  if(modelFailure(error))return failure('unavailable',true,parsedRejections);
  throw error;
 }
 await options.requireCurrent();options.signal.throwIfAborted();
 const checked=new Map(review.map((fact,index)=>[fact,results.find(result=>result.candidate_index===index)!]));
 const accepted:ExtractedFact[]=[],candidate_trace_ids:string[]=[],verification:ExtractionFlowOutcome['verification']=[];let rejected=parsedRejections;
 for(const fact of facts){
  const candidate_trace_id=traceIds.get(fact)!;
  const result=checked.get(fact);if(!result){accepted.push(fact);candidate_trace_ids.push(candidate_trace_id);continue;}
  await options.record({stage:'verification',candidate_trace_id,payload:{status:'validated',result,before:fact,
   disposition:result.verdict==='unsupported'?'unsupported_rejected':'continue'}});
  if(result.verdict==='unsupported'){rejected++;continue;}
  const prepared={...fact,event:result.event,conditions:result.conditions,
   risk_flags:result.verdict==='uncertain'?[...new Set([...fact.risk_flags,...result.issues.map(issue=>`semantic:${issue}`)])]:fact.risk_flags};
  accepted.push(prepared);candidate_trace_ids.push(candidate_trace_id);verification.push({fact:prepared,result});
 }
 await options.record({stage:'verification_contract',payload:{results,rejected_count:rejected}});
 return {accepted,candidate_trace_ids,rejected_count:rejected,extraction_completed:true,failure_kind:null,failure_reason:null,verification};
}
