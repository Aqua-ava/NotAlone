import {DiagnosticBuffer,diagnosticOverflow,type DiagnosticObservation} from './buffer.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import type {UnifiedDiagnosticLog} from './unified-log.mjs';
import {checkedDiagnosticEvent,type DiagnosticEvent} from './unified-contract.mjs';
import {isUuid} from '../platform/uuid.ts';
const traces=new AsyncLocalStorage<string>();
let current:UnifiedDiagnosticLog|undefined,opening:Promise<void>|undefined;
type ObservedPublisher=(event:DiagnosticEvent,observedAt:number,observedNs:bigint,protection?:DiagnosticObservation)=>void;
let publishCurrent:ObservedPublisher|undefined;
const pending=new DiagnosticBuffer<{event:DiagnosticEvent;observedAt:number;observedNs:bigint}>();
export const newTraceId=():string=>randomUUID();
export const currentDiagnosticTrace=():string|undefined=>traces.getStore();
export function withDiagnosticTrace<T>(traceId:string|undefined,work:()=>T):T {
 return isUuid(traceId)?traces.run(traceId,work):work();
}
export function registerDiagnosticLog(log:UnifiedDiagnosticLog,publishObserved:ObservedPublisher):void {
 current=log;publishCurrent=publishObserved;const batch=pending.take();
 for(const item of batch.items)publishObserved(item.event,item.observedAt,item.observedNs);
 for(const entry of batch.noticeEntries)if(entry.observation)publishObserved(entry.event,entry.observation.observedAt,entry.observation.observedNs,entry.observation);
 if(batch.dropped&&batch.droppedObservation)publishObserved(diagnosticOverflow('diagnostic_lazy',batch.dropped),batch.droppedObservation.observedAt,batch.droppedObservation.observedNs,batch.droppedObservation);
}
export function diagnosticLog():UnifiedDiagnosticLog|undefined{return current;}
/** 删除前先停止旧图片调用；擦除惰性队列和已有统一日志中的该文件身份，失败如实返回。 */
export async function eraseModelImageDiagnostic(imageId:string):Promise<boolean>{
 if(!isUuid(imageId))return false;
 const buffered=pending.take();
 for(const item of buffered.items)if(item.event.event!=='processing.model_image'||item.event.imageId!==imageId)pending.push(item.event,item,Buffer.byteLength(JSON.stringify(item.event)),{observedAt:item.observedAt,observedNs:item.observedNs});
 for(const entry of buffered.noticeEntries)pending.push(entry.event,undefined,0,entry.observation);
 if(buffered.dropped)pending.push(diagnosticOverflow('diagnostic_lazy',buffered.dropped),undefined,0,buffered.droppedObservation);
 try{
  if(!current){
   const root=process.env.NOTALONE_DIAGNOSTIC_ROOT;if(!root)return true;
   const {configureDiagnosticLog}=await import('./unified.ts');
   if(!current)configureDiagnosticLog(root,{proc:'backend',development:process.env.NOTALONE_DIAGNOSTIC_LEVEL==='debug'});
  }
  return await current!.eraseModelImage(imageId);
 }catch{return false;}
}
/** 普通业务只依赖轻量上下文；后台首次需要写盘时异步加载写者并有界暂存。 */
export function diagnose(event:DiagnosticEvent):void {
 try{diagnoseObserved(event,Date.now(),process.hrtime.bigint());}catch{/* 捕获时钟失败也不离开普通诊断的静默边界。 */}
}
/** @internal 仅限可信worker完成回执/本进程lazy队列，不接收HTTP或公共事件提供的时刻。 */
export function diagnoseObserved(event:DiagnosticEvent,observedAt:number,observedNs:bigint):void {
 try{
  if(!Number.isSafeInteger(observedAt)||observedAt<0||observedAt>8640000000000000||typeof observedNs!=='bigint'||observedNs<0n||observedNs>18446744073709551615n)return;
  const traced={...event,...(!event.traceId&&currentDiagnosticTrace()?{traceId:currentDiagnosticTrace()}:{})};
  if(current&&publishCurrent){publishCurrent(traced,observedAt,observedNs);return;}
  const safe=checkedDiagnosticEvent(traced);if(!safe)return;
  const root=process.env.NOTALONE_DIAGNOSTIC_ROOT;if(!root)return;
  pending.push(safe,{event:safe,observedAt,observedNs},Buffer.byteLength(JSON.stringify(safe)),{observedAt,observedNs});
  opening??=import('./unified.ts').then(({configureDiagnosticLog})=>{if(!current)configureDiagnosticLog(root,{proc:'backend',development:process.env.NOTALONE_DIAGNOSTIC_LEVEL==='debug'});}).catch(()=>{pending.reset();});
 }catch{ /* 诊断不可用不改变业务结果。 */ }
}
