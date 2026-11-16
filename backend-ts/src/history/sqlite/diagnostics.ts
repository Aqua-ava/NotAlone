import {currentDiagnosticTrace,diagnose,newTraceId} from '../../diagnostics/context.ts';

type SyncState={contactId:string;phase:string;lastError:string|null};
const observed=new WeakMap<object,number>();
const states:Record<string,string>={complete:'completed',caught_up:'ready',waiting_new_messages:'waiting',degraded:'partial'};
/** 只投影分类后的固定原因；异常正文、渠道定位及原生路径均不进入诊断。 */
export function syncReason(code:string|null,phase:string):string {
 if(code==='read_not_authorized'||code==='read_eligibility_stale')return 'authorization_revoked';
 if(code==='history_native_timeout')return 'timeout';
 if(code==='history_source_temporarily_unavailable')return 'failed';
 if(code==='history_native_cancelled'||code==='history_interrupted'||code==='history_incremental_interrupted')return 'aborted';
 if(code==='history_page_budget_exhausted'||code==='history_tail_baseline_too_large')return 'budget_exhausted';
 if(code&&/source|scope|account|identity|suppression/.test(code))return 'source_changed';
 if(code)return 'failed';
 return phase==='complete'||phase==='caught_up'?'completed':phase==='stopped'?'cancelled':phase==='running'?'started':phase==='queued'?'retry':phase==='waiting_new_messages'?'waiting_window':'degraded';
}
export function recordSyncState(previous:SyncState|undefined,next:SyncState,caller:'history_first'|'history_incremental'):void {
 try{
  const now=performance.now(),started=previous&&observed.get(previous);
  observed.set(next,previous?.phase===next.phase&&previous.lastError===next.lastError?started??now:now);
  if(previous?.phase===next.phase&&previous.lastError===next.lastError)return;
  diagnose({event:'sync.state_changed',caller,reasonCode:syncReason(next.lastError,next.phase),traceId:currentDiagnosticTrace()??newTraceId(),
   ...(/^[a-f0-9]{8}/.test(next.contactId)?{contactPrefix:next.contactId.slice(0,8)}:{}),
   fromState:states[previous?.phase??'idle']??previous?.phase??'idle',toState:states[next.phase]??next.phase,
   ...(started===undefined?{}:{durationMs:Math.max(0,now-started)})});
 }catch{/* 诊断不参与同步状态或授权决策。 */}
}
