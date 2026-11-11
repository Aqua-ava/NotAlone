import {checkedDiagnosticEvent, type DiagnosticEvent} from './unified-contract.mjs';
import {diagnose} from './context.ts';

/** Worker 不持有日志写者；宿主只接收有界、再次核验的安全事件。 */
export function publishStorageDiagnostics(input:unknown,traceId?:string):void {
 try {
  if(!Array.isArray(input))return;
  for(const raw of input.slice(0,256)){
   const event=checkedDiagnosticEvent(raw);
   if(event)diagnose({...event,...(!event.traceId&&traceId?{traceId}:{})});
  }
 }catch{ /* 诊断协议失败不改变动作回执。 */ }
}
