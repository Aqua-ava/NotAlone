import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import type {UnifiedDiagnosticLog} from './unified-log.mjs';
import {checkedDiagnosticEvent,type DiagnosticEvent} from './unified-contract.mjs';
const traces=new AsyncLocalStorage<string>();
let current:UnifiedDiagnosticLog|undefined,opening:Promise<void>|undefined;
const pending:DiagnosticEvent[]=[];
export const newTraceId=():string=>randomUUID();
export const currentDiagnosticTrace=():string|undefined=>traces.getStore();
export function withDiagnosticTrace<T>(traceId:string|undefined,work:()=>T):T {
 return traceId&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(traceId)?traces.run(traceId,work):work();
}
export function registerDiagnosticLog(log:UnifiedDiagnosticLog):void {current=log;for(const event of pending.splice(0))current.diagnose(event);}
export function diagnosticLog():UnifiedDiagnosticLog|undefined{return current;}
/** 普通业务只依赖轻量上下文；后台首次需要写盘时异步加载写者并有界暂存。 */
export function diagnose(event:DiagnosticEvent):void {
 try{
  const traced={...event,...(!event.traceId&&currentDiagnosticTrace()?{traceId:currentDiagnosticTrace()}:{})};
  if(current){current.diagnose(traced);return;}
  const safe=checkedDiagnosticEvent(traced);if(!safe)return;
  const root=process.env.NOTALONE_DIAGNOSTIC_ROOT;if(!root)return;
  if(pending.length<128)pending.push(safe);
  opening??=import('./unified.ts').then(({configureDiagnosticLog})=>{if(!current)configureDiagnosticLog(root,{proc:'backend',development:process.env.NOTALONE_DIAGNOSTIC_LEVEL==='debug'});}).catch(()=>{pending.length=0;});
 }catch{ /* 诊断不可用不改变业务结果。 */ }
}
