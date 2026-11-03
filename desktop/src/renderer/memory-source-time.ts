import type {MemorySource,MemoryView} from '../shared/sqlite-memory-management';

export interface MemorySourceTime {start:number;end:number;complete:boolean}

/** 只使用直接来源消息时间；决定、保存和旧版本的时间不补作当前聊天日期。 */
export function memorySourceTime(sources:readonly MemorySource[]):MemorySourceTime|null {
 const times=sources.map(source=>{
  if(typeof source.sentAt!=='string'||!/^\d+$/.test(source.sentAt))return null;
  const value=Number(source.sentAt);
  return Number.isSafeInteger(value)&&Number.isFinite(new Date(value).getTime())?value:null;
 });
 const known=times.filter((value):value is number=>value!==null);
 return known.length?{start:Math.min(...known),end:Math.max(...known),complete:known.length===sources.length}:null;
}

export function memoriesBySourceTime(memories:readonly MemoryView[]):MemoryView[] {
 return memories.map((memory,index)=>({memory,index,time:memorySourceTime(memory.current?.sources??[])?.end??null}))
  .sort((left,right)=>left.time===right.time?left.index-right.index:left.time===null?1:right.time===null?-1:right.time-left.time)
  .map(item=>item.memory);
}

export function memorySourceDateLabel(time:MemorySourceTime,timeZone?:string):string {
 const format=new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'long',day:'numeric',...(timeZone?{timeZone}:{})});
 const start=format.format(time.start),end=format.format(time.end);
 return start===end?start:`${start} — ${end}`;
}
