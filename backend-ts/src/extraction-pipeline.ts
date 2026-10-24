/** 提取流水线：有界并行执行 E/V，采纳、追踪及水位只由同一个按序提交口负责。 */
import {createHash} from 'node:crypto';

export interface ExtractionScope {owner_id:string;contact_id:string;}
export interface ExtractionMessage extends ExtractionScope {
 message_id:string;occurred_at:string|null;
}
export interface ExtractionBatch<M extends ExtractionMessage> {
 readonly index:number;
 readonly scope:ExtractionScope;
 readonly batch_key:string;
 readonly target_count:number;
 readonly previous_watermark:string|null;
 readonly next_watermark:string|null;
 readonly window:{owner_id:string;contact_id:string;messages:readonly M[];target_message_ids:readonly string[]};
}
export class ExtractionPipelineError extends Error {
 readonly code:string;
 constructor(code:string){super(code);this.code=code;}
}
function invalid():never{throw new ExtractionPipelineError('extraction_plan_invalid');}
function integer(value:number,min:number,max:number){if(!Number.isSafeInteger(value)||value<min||value>max)invalid();}
function frozenCopy<T>(value:T):T {
 if(value===null||typeof value!=='object')return value;
 // 来源数字保留已有 StoredNumber 原型，structuredClone 会丢失其无损 JSON 语义。
 const copy=Array.isArray(value)?[]:Object.create(Object.getPrototypeOf(value));
 for(const [key,child] of Object.entries(value))Object.defineProperty(copy,key,{value:frozenCopy(child),enumerable:true});
 return Object.freeze(copy) as T;
}

/** 输入已按原存储顺序冻结；目标批次键与 Python 的 SHA256('|'.join(ids)) 相同。 */
export function planExtractionBatches<M extends ExtractionMessage>(options:{
 scope:ExtractionScope;messages:readonly M[];target_message_ids:readonly string[];
 initial_watermark?:string|null;batch_size?:number;context_before?:number;context_after?:number;
}):ExtractionBatch<M>[] {
 const {scope}=options,batchSize=options.batch_size??10,before=options.context_before??5,after=options.context_after??0;
 integer(batchSize,1,20);integer(before,0,20);integer(after,0,20);
 if(!scope.owner_id||!scope.contact_id||options.target_message_ids.length>200)invalid();
 const ids=new Map<string,number>();
 options.messages.forEach((message,index)=>{
  if(!message.message_id||ids.has(message.message_id)||message.owner_id!==scope.owner_id||message.contact_id!==scope.contact_id)invalid();
  ids.set(message.message_id,index);
 });
 const positions=options.target_message_ids.map(id=>ids.get(id)??invalid());
 if(positions.some((position,index)=>index>0&&position<=positions[index-1]!))invalid();
 const plans:ExtractionBatch<M>[]=[],messages=frozenCopy(options.messages);
 let previous=options.initial_watermark??null;
 for(let offset=0;offset<positions.length;offset+=batchSize){
  const batchPositions=positions.slice(offset,offset+batchSize),first=batchPositions[0]!,last=batchPositions.at(-1)!;
  const targetIds=options.target_message_ids.slice(offset,offset+batchSize);
  const targets=batchPositions.map(position=>messages[position]!);
  const next=[...targets].reverse().find(message=>message.occurred_at!==null)?.message_id??previous;
  plans.push({index:plans.length,scope:{...scope},batch_key:createHash('sha256').update(targetIds.join('|')).digest('hex'),
   target_count:targets.length,previous_watermark:previous,next_watermark:next,
   window:{...scope,messages:[...messages.slice(Math.max(0,first-before),first),...targets,...messages.slice(last+1,last+1+after)],target_message_ids:targetIds}});
  previous=next;
 }
 return frozenCopy(plans);
}
export interface ExtractionCommit {
 status:'succeeded'|'skipped'|'model_failed';
 watermark:string|null;
 processed_messages:number;
}
export interface ExtractionPipelineOptions<M extends ExtractionMessage,T> {
 plans:readonly ExtractionBatch<M>[];
 concurrency:number;
 signal:AbortSignal;
 requireCurrent(plan:ExtractionBatch<M>):Promise<void>;
 extract(plan:ExtractionBatch<M>,signal:AbortSignal):Promise<T>;
 /** 同一个持久化边界完成 B 段；不得把采纳、追踪和水位拆成无关异步工作。 */
 commit(plan:ExtractionBatch<M>,outcome:T,signal:AbortSignal):Promise<ExtractionCommit>;
 /** 已启动的后批必须排空并收尾追踪，不能因取消而假定物理调用未发生。 */
 stopped(plan:ExtractionBatch<M>,watermark:string|null,reason:'cancelled'|'aborted_after_batch_failure'):Promise<void>;
}
export interface ExtractionPipelineResult {
 status:'succeeded'|'failed'|'stopped';
 watermark:string|null;processed_messages:number;committed_batches:number;skipped_batches:number;
}
type Attempt<T>={ok:true;outcome:T}|{ok:false;error:unknown};

export async function runExtractionPipeline<M extends ExtractionMessage,T>(options:ExtractionPipelineOptions<M,T>):Promise<ExtractionPipelineResult>{
 integer(options.concurrency,1,4);
 const plans=frozenCopy(options.plans);
 if(plans.some((p,i)=>p.index!==i||i>0&&(p.previous_watermark!==plans[i-1]!.next_watermark
   ||p.scope.owner_id!==plans[0]!.scope.owner_id||p.scope.contact_id!==plans[0]!.scope.contact_id)))invalid();
 const stop=new AbortController(),signal=AbortSignal.any([options.signal,stop.signal]);
 const attempts=new Map<number,Promise<Attempt<T>>>();
 const result:ExtractionPipelineResult={status:'succeeded',watermark:plans[0]?.previous_watermark??null,
  processed_messages:0,committed_batches:0,skipped_batches:0};
 let next=0,error:unknown;
 const launch=()=>{
  while(next<plans.length&&attempts.size<options.concurrency&&!signal.aborted){
   const plan=plans[next++]!;
   // 包装失败以保留后批异常，直到前批完成；拒绝不会成为未处理的 Promise。
   attempts.set(plan.index,Promise.resolve().then(async():Promise<Attempt<T>>=>{
    try{signal.throwIfAborted();await options.requireCurrent(plan);signal.throwIfAborted();
     return {ok:true,outcome:await options.extract(plan,signal)};
    }catch(error){return {ok:false,error};}
   }));
  }
 };
 launch();
 try{
  for(const plan of plans){
   const work=attempts.get(plan.index);
   if(!work){result.status='stopped';break;}
   const attempt=await work;
   if(signal.aborted){result.status='stopped';break;}
   if(!attempt.ok)throw attempt.error;
   await options.requireCurrent(plan);signal.throwIfAborted();
   const receipt=await options.commit(plan,attempt.outcome,signal);
   if(receipt.watermark!==(receipt.status==='model_failed'?result.watermark:plan.next_watermark)
    ||receipt.processed_messages!==plan.target_count)throw new ExtractionPipelineError('extraction_commit_invalid');
   attempts.delete(plan.index);
   result.processed_messages+=receipt.processed_messages;
   if(receipt.status==='model_failed'){result.status='failed';stop.abort();break;}
   result.watermark=receipt.watermark;result.committed_batches++;
   if(receipt.status==='skipped')result.skipped_batches++;
   launch();
  }
 }catch(failure){error=failure;result.status=options.signal.aborted?'stopped':'failed';stop.abort();}
 if(result.status!=='succeeded'||signal.aborted){
  stop.abort();
  const cleanup=await Promise.allSettled([...attempts].map(async([index,work])=>{
   await work;
   await options.stopped(plans[index]!,result.watermark,options.signal.aborted?'cancelled':'aborted_after_batch_failure');
  }));
  error??=cleanup.find((entry):entry is PromiseRejectedResult=>entry.status==='rejected')?.reason;
 }
 if(error!==undefined&&!options.signal.aborted)throw error;
 return result;
}
