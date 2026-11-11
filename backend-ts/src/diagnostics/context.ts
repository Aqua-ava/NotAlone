import {DiagnosticBuffer,diagnosticOverflow} from './buffer.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import type {UnifiedDiagnosticLog} from './unified-log.mjs';
import {checkedDiagnosticEvent,type DiagnosticEvent} from './unified-contract.mjs';
const traces=new AsyncLocalStorage<string>();
let current:UnifiedDiagnosticLog|undefined,opening:Promise<void>|undefined;
const pending=new DiagnosticBuffer<{event:DiagnosticEvent;observedAt:number}>();
export const newTraceId=():string=>randomUUID();
export const currentDiagnosticTrace=():string|undefined=>traces.getStore();
export function withDiagnosticTrace<T>(traceId:string|undefined,work:()=>T):T {
 return traceId&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(traceId)?traces.run(traceId,work):work();
}
export function registerDiagnosticLog(log:UnifiedDiagnosticLog,publishObserved:(event:DiagnosticEvent,observedAt:number)=>void):void {current=log;const batch=pending.take();for(const item of batch.items)publishObserved(item.event,item.observedAt);for(const notice of batch.notices)publishObserved(notice,Date.now());if(batch.dropped)publishObserved(diagnosticOverflow('diagnostic_lazy',batch.dropped),Date.now());}
export function diagnosticLog():UnifiedDiagnosticLog|undefined{return current;}
/** 普通业务只依赖轻量上下文；后台首次需要写盘时异步加载写者并有界暂存。 */
export function diagnose(event:DiagnosticEvent):void {
 try{
  const observedAt=Date.now();
  const traced={...event,...(!event.traceId&&currentDiagnosticTrace()?{traceId:currentDiagnosticTrace()}:{})};
  if(current){current.diagnose(traced);return;}
  const safe=checkedDiagnosticEvent(traced);if(!safe)return;
  const root=process.env.NOTALONE_DIAGNOSTIC_ROOT;if(!root)return;
  pending.push(safe,{event:safe,observedAt});
  opening??=import('./unified.ts').then(({configureDiagnosticLog})=>{if(!current)configureDiagnosticLog(root,{proc:'backend',development:process.env.NOTALONE_DIAGNOSTIC_LEVEL==='debug'});}).catch(()=>{pending.reset();});
 }catch{ /* 诊断不可用不改变业务结果。 */ }
}
