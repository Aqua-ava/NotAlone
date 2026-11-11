import {DiagnosticBuffer,diagnosticOverflow,diagnosticTransportLimit} from './buffer.mjs';
import {checkedDiagnosticEvent, type DiagnosticEvent} from './unified-contract.mjs';
import {diagnose} from './context.ts';

/** Worker 不持有日志写者；宿主只接收有界、再次核验的安全事件。 */
export function publishStorageDiagnostics(input:unknown,traceId?:string):void {
 try {
  if(!Array.isArray(input))return;
  const buffer=new DiagnosticBuffer();
  for(const raw of input.slice(0,diagnosticTransportLimit*2)){
   const event=checkedDiagnosticEvent(raw);
   if(event)buffer.push({...event,...(!event.traceId&&traceId?{traceId}:{})});
  }
  const batch=buffer.take();for(const event of [...batch.items,...batch.notices])diagnose(event);
  const dropped=batch.dropped+Math.max(0,input.length-diagnosticTransportLimit*2);if(dropped)diagnose(diagnosticOverflow('diagnostic_transport',dropped,traceId));
 }catch{ /* 诊断协议失败不改变动作回执。 */ }
}
