import {diagnosticEvents} from './unified-contract.mjs';

export const diagnosticDecisionLimit=4096;
export const diagnosticDetailLimit=128;
export const diagnosticByteLimit=8*1024*1024;
export const diagnosticTransportLimit=diagnosticDecisionLimit+diagnosticDetailLimit+9;
const noticeCallers=new Set(['diagnostic_transaction','diagnostic_transport','diagnostic_lazy','diagnostic_writer','sqlite_worker','sqlite_readonly_worker']);
/** 决策和细节分预算；丢失提示另有保留槽，不会被调试洪峰挤掉。 */
export class DiagnosticBuffer {
 constructor(){this.reset();}
 reset(){this.items=[];this.counts={decision:0,detail:0};this.bytes=0;this.dropped=0;this.notices=new Map();}
 push(event,value=event,bytes=0){
  if(event.event==='diagnostics.error'&&event.reasonCode==='budget_exhausted'&&noticeCallers.has(event.caller)){
   const previous=this.notices.get(event.caller),combined={...event,count:(previous?.count??0)+(event.count??1)};
   if(previous&&previous.traceId!==event.traceId)delete combined.traceId;
   combined.count=Math.min(Number.MAX_SAFE_INTEGER,combined.count);this.notices.set(event.caller,combined);return true;
  }
  const group=diagnosticEvents[event.event]?.level==='debug'?'detail':'decision';
  const limit=group==='decision'?diagnosticDecisionLimit:diagnosticDetailLimit;
  // 固定六个阶段的提示最多占12KiB，预留16KiB保证总内存队列不超8MiB。
  if(this.counts[group]>=limit||this.bytes+bytes>diagnosticByteLimit-16384){this.dropped++;return false;}
  this.counts[group]++;this.bytes+=bytes;this.items.push(value);return true;
 }
 take(){const result={items:this.items,dropped:this.dropped,notices:[...this.notices.values()]};this.reset();return result;}
}
export function diagnosticOverflow(caller,count,traceId){return {event:'diagnostics.error',module:'diagnostics',caller,reasonCode:'budget_exhausted',count,...(traceId?{traceId}:{})};}
