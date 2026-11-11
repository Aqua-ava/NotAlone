import {currentDiagnosticTrace,diagnose,newTraceId,withDiagnosticTrace} from './context.ts';
import type {DiagnosticModule} from './unified-contract.mjs';

export function checkedTraceId(input:unknown):string|undefined {
 return typeof input==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(input)?input.toLowerCase():undefined;
}
export function requestDiagnosticModule(path:string,method?:string):DiagnosticModule {
 if(method==='DELETE'&&(path==='/api/account'||/^\/api\/contacts\/[^/?]+(?:\/(?:sources|assistant-sessions)\/[^/?]+)?$/.test(path)))return 'deletion';
 if(/^\/api\/tasks\/status(?:\?|$)/.test(path))return 'deletion';
 if(/^\/api\/(?:memory-management|memory-documents)/.test(path))return 'memory.management';
 if(/^\/api\/(?:memory-processing|memory-runs)/.test(path))return 'memory.processing';
 if(/\/(?:media|images|avatars)(?:\/|\?|$)/.test(path))return 'media';
 if(/^\/api\/sync\/foreground(?:\/|\?|$)/.test(path))return 'foreground';
 if(/^\/api\/(?:sync|history)/.test(path))return 'history.sync';
 if(/\/(?:deletions|delete|clear)(?:\/|\?|$)/.test(path))return 'deletion';
 if(/\/(?:assistant|reply|replies)/.test(path))return 'reply';
 if(/^\/api\/contacts/.test(path))return 'contacts';
 return 'startup';
}
export function requestFailureReason(error:unknown):string {
 try{
  const value=error as {code?:unknown;kind?:unknown;name?:unknown}|null;
  if(value?.code==='request_timeout'||value?.code==='assistant_preparation_timeout')return 'request_timeout';
  if(value?.kind==='cancelled'||value?.name==='AbortError')return 'request_aborted';
 }catch{ /* 未知异常的 getter 失败也不能替换原业务异常。 */ }
 return 'request_failed';
}
/** 对请求只记录固定分类；不接收正文、参数或URL作为日志字段。 */
export function tracedRequest<T>(traceId:string|undefined,module:DiagnosticModule,caller:string,work:()=>Promise<T>):Promise<T> {
 return withDiagnosticTrace(checkedTraceId(traceId)??currentDiagnosticTrace()??newTraceId(),async()=>{
  const started=performance.now();diagnose({event:'request.started',module,caller,reasonCode:'request_started'});
  try{
   const value=await work(),durationMs=Math.max(0,performance.now()-started);
   diagnose({event:'request.finished',module,caller,durationMs,reasonCode:'request_completed'});
   if(durationMs>=1000)diagnose({event:'request.slow',module,caller,durationMs,reasonCode:'request_slow',count:1});
   return value;
  }catch(error){diagnose({event:'request.failed',module,caller,durationMs:Math.max(0,performance.now()-started),reasonCode:requestFailureReason(error)});throw error;}
 });
}
