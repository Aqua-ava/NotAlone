import {diagnose} from '../../diagnostics/context.ts';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
export type ReplyDiagnosticPhase='preparing'|'ready'|'queued'|'generating'|'saving'|'completed'|'failed'|'blocked';
export function replyFailureReason(error:unknown):string {
 try{
  if(error instanceof StorageFailure){const code=error.code;
   if(/budget|call_limit|context_limit/.test(code))return 'budget_exhausted';
   if(/cancel|interrupt/.test(code))return 'aborted';
   if(/source|context_stale|invalidated|knowledge_stale/.test(code))return 'source_stale';
   if(/identity|required|input_invalid|content_invalid/.test(code))return 'rejected';
   if(/model_unavailable/.test(code))return 'model_unavailable';
   if(/runtime_closed/.test(code))return 'shutdown';
   if(/unknown/.test(code))return 'receipt_unknown';
  }
  if((error as {name?:unknown}|null)?.name==='AbortError')return 'aborted';
 }catch{/* 任意异常getter失败不能替换业务异常或进入日志。 */}
 return 'failed';
}
export function observeReply(contactId:string):(phase:ReplyDiagnosticPhase,reasonCode?:string)=>void {
 let previous='idle',started=performance.now();
 return (phase,reasonCode=phase==='completed'?'completed':phase==='failed'?'failed':'started')=>{
  try{const now=performance.now();diagnose({event:'reply.state_changed',caller:'reply_generate',reasonCode,fromState:previous,toState:phase,durationMs:Math.max(0,now-started),...(/^[a-f0-9]{8}/.test(contactId)?{contactPrefix:contactId.slice(0,8)}:{})});previous=phase;started=now;}catch{}
 };
}
