import {diagnosticEvents} from './unified-contract.mjs';

export const diagnosticDecisionLimit=4096;
export const diagnosticDetailLimit=128;
export const diagnosticByteLimit=8*1024*1024;
export const diagnosticNoticeLimit=64;
export const diagnosticTransportLimit=diagnosticDecisionLimit+diagnosticDetailLimit+diagnosticNoticeLimit+6;
const noticeCallers=new Set(['diagnostic_transaction','diagnostic_transport','diagnostic_lazy','diagnostic_writer','sqlite_worker','sqlite_readonly_worker']);
const reservedBytes=(diagnosticNoticeLimit+6)*2048;
const observed=(event,value)=>value?{...value,...(event.contactPrefix?{contactPrefix:event.contactPrefix}:{})}:undefined;
function combineObservation(a,b){
 if(!a||!b)return undefined;
 return {observedAt:Math.min(a.observedAt,b.observedAt),observedNs:a.observedNs<b.observedNs?a.observedNs:b.observedNs,
  ...(a.contactPrefix===b.contactPrefix&&a.contactPrefix?{contactPrefix:a.contactPrefix}:{}),
  ...(a.ambiguousPrefix||b.ambiguousPrefix||a.contactPrefix!==b.contactPrefix?{ambiguousPrefix:true}:{})};
}
function combineNotice(previous,event,observation){
 const combined={...event,count:Math.min(Number.MAX_SAFE_INTEGER,(previous?.event.count??0)+(event.count??1))};
 if(previous&&previous.event.traceId!==event.traceId)delete combined.traceId;
 if(previous&&previous.event.contactPrefix!==event.contactPrefix)delete combined.contactPrefix;
 return {event:combined,observation:previous?combineObservation(previous.observation,observation):observation};
}
/** 决策和细节分预算；丢失提示另有保留槽，不会被调试洪峰挤掉。 */
export class DiagnosticBuffer {
 constructor(){this.reset();}
 reset(){this.items=[];this.counts={decision:0,detail:0};this.bytes=0;this.dropped=0;this.notices=new Map();this.noticeRemainders=new Map();this.droppedObservation=undefined;}
 reject(observation,event){this.droppedObservation=this.dropped?combineObservation(this.droppedObservation,observed(event??{},observation)):observed(event??{},observation);this.dropped++;return false;}
 reserve(bytes,observation,event){if(this.bytes+bytes>diagnosticByteLimit-reservedBytes)return this.reject(observation,event);this.bytes+=bytes;return true;}
 push(event,value=event,bytes=0,observation){
  if(event.event==='diagnostics.error'&&event.reasonCode==='budget_exhausted'&&noticeCallers.has(event.caller)){
   const stamp=observed(event,observation),key=`${event.caller}:${stamp?.observedNs??''}`;
   const previous=this.notices.get(key);
   if(previous||this.notices.size<diagnosticNoticeLimit)this.notices.set(key,combineNotice(previous,event,stamp));
   // 贡献槽封顶后只保留每阶段一个保守余量。跨清除边界无法拆分时整组舍弃，绝不挪成新时刻。
   else this.noticeRemainders.set(event.caller,combineNotice(this.noticeRemainders.get(event.caller),event,stamp));
   return true;
  }
  const group=diagnosticEvents[event.event]?.level==='debug'?'detail':'decision';
  const limit=group==='decision'?diagnosticDecisionLimit:diagnosticDetailLimit;
  if(this.counts[group]>=limit)return this.reject(observation,event);
  if(!this.reserve(bytes,observation,event))return false;
  this.counts[group]++;this.items.push(value);return true;
 }
 take(){const noticeEntries=[...this.notices.values(),...this.noticeRemainders.values()],result={items:this.items,dropped:this.dropped,droppedObservation:this.droppedObservation,noticeEntries,notices:noticeEntries.map(row=>row.event)};this.reset();return result;}
}
export function diagnosticOverflow(caller,count,traceId){return {event:'diagnostics.error',module:'diagnostics',caller,reasonCode:'budget_exhausted',count,...(traceId?{traceId}:{})};}
