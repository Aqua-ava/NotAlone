import {object, positions, sourcePositions, requireValid, choices, when, uuid,instantMicros} from './validators.ts';
import type {ExtractionMessage, ExtractionWindow, ExtractedFact, MemoryEvent} from './protocol.ts';

type LocalAnchor={epoch:number;offset:number};
type Calendar={precision:string;start:string;end:string|null};
function offset(raw:string):number {
  if(raw.endsWith('Z'))return 0;
  const match=raw.match(/([+-])(\d\d):(\d\d)$/)!;
  return (match[1]==='-'?-1:1)*(Number(match[2])*60+Number(match[3]));
}
/** 原来源快照必须完整，且每条原 ISO 时刻与规范消息相等、原偏移一致。 */
export function sourceCalendar(message:ExtractionMessage):LocalAnchor|null {
  if(message.occurred_at===null||!message.source_snapshots?.length)return null;
  let result:LocalAnchor|null=null;
  for(const row of message.source_snapshots){
    if(!['source_ref_id','source_id','source_kind','locator','raw_payload','source_content_sha256'].every(k=>Object.hasOwn(row,k))||
      !['source_document','local_wechat_observation'].includes(row.source_kind as string)||typeof row.locator!=='string'||!row.locator.trim()||
      row.source_kind==='source_document'&&!/^[a-f0-9]{64}$/.test(row.source_content_sha256 as string))return null;
    try{const raw=object(row.raw_payload).time_iso;requireValid(when(raw)!==null);const value={epoch:Date.parse(raw),offset:offset(raw)};
      if(instantMicros(raw)!==instantMicros(message.occurred_at)||result&&result.offset!==value.offset)return null;
      result=value;
    }catch{return null;}
  }
  return result;
}
function iso(local:number,minutes:number):string {
  const date=new Date(local).toISOString().slice(0,19),sign=minutes<0?'-':'+';
  return `${date}${sign}${String(Math.floor(Math.abs(minutes)/60)).padStart(2,'0')}:${String(Math.abs(minutes)%60).padStart(2,'0')}`;
}
function date(year:number,month:number,day:number,hour=0,minute=0,second=0):number {
  requireValid(year>=1&&year<=9999&&month>=1&&month<=12&&day>=1&&day<=31&&hour>=0&&hour<24&&minute>=0&&minute<60&&second>=0&&second<60);
  const value=new Date(0);value.setUTCFullYear(year,month-1,day);value.setUTCHours(hour,minute,second,0);
  requireValid(value.getUTCMonth()===month-1&&value.getUTCDate()===day);return value.getTime();
}
export function calendar(expression:string|null,anchor:LocalAnchor|null):Calendar|null {
  if(!expression)return null;
  if(expression.includes('T'))try{const instant=when(expression);if(instant)return {precision:'instant',start:instant,end:null};}catch{}
  const range=expression.split(/到|至|—|~/);
  if(range.length===2&&range.every(Boolean)){const first=calendar(range[0].trim(),anchor),last=calendar(range[1].trim(),anchor),end=last?.precision==='instant'?last.start:last?.end;
    if(first&&last&&end&&first.precision===last.precision&&Date.parse(end)>Date.parse(first.start))return {...first,end};}
  if(!anchor)return null;
  const activity=expression.match(/^(\d{4}年(?:\d{1,2}月(?:\d{1,2}日)?)?)(?:的)?[^\d年月日周季旬前后至到起从或初末半上下约不没未无，。；]{1,24}期间$/);
  if(activity)return calendar(activity[1],anchor);
  const local=new Date(anchor.epoch+anchor.offset*60000),year=local.getUTCFullYear(),month=local.getUTCMonth()+1,day=local.getUTCDate();
  const midnight=date(year,month,day),dayMs=86400000;
  const make=(precision:string,start:number,end:number|null):Calendar=>({precision,start:iso(start,anchor.offset),end:end===null?null:iso(end,anchor.offset)});
  const relativeClock=expression.match(/^(前天|昨天|今天|明天|后天)(?:上午|下午|晚上)?(\d{1,2})(?:[:：]|点)(\d{2})?(?:分)?$/);
  if(relativeClock){const base=calendar(relativeClock[1],anchor)!;let hour=Number(relativeClock[2]);if(/下午|晚上/.test(expression)&&hour<12)hour+=12;
    requireValid(hour<24&&Number(relativeClock[3]??0)<60);
    return make('instant',Date.parse(base.start)+anchor.offset*60000+hour*3600000+Number(relativeClock[3]??0)*60000,null);}
  const explicit=expression.match(/^(\d{4})(?:年|-)(\d{1,2})(?:月|-)(\d{1,2})日?(?:[ T]?(\d{1,2})(?:[:：]|点)(\d{2})?(?:分)?(?::(\d{2}))?(?:到|至|—|~)?(?:(\d{1,2})(?:[:：]|点)(\d{2})?(?:分)?(?::(\d{2}))?)?)?$/);
  if(explicit){const [,y,m,d,h,min,sec,eh,emin,esec]=explicit,start=date(Number(y),Number(m),Number(d),Number(h??0),Number(min??0),Number(sec??0));
    if(h===undefined)return make('day',start,start+dayMs);
    const end=eh===undefined?null:date(Number(y),Number(m),Number(d),Number(eh),Number(emin??0),Number(esec??0));
    return end!==null&&end<=start?null:make('instant',start,end);}
  const offsets:Record<string,number>={'前天':-2,'昨天':-1,'今天':0,'明天':1,'后天':2};
  if(Object.hasOwn(offsets,expression)){const start=midnight+offsets[expression]*dayMs;return make('day',start,start+dayMs);}
  const years:Record<string,number>={'去年':-1,'今年':0,'明年':1};
  if(Object.hasOwn(years,expression)){const y=year+years[expression];return make('year',date(y,1,1),date(y+1,1,1));}
  const months:Record<string,number>={'上月':-1,'上个月':-1,'本月':0,'这个月':0,'下月':1,'下个月':1};
  if(Object.hasOwn(months,expression)){const number=year*12+month-1+months[expression];return make('month',date(Math.floor(number/12),number%12+1,1),date(Math.floor((number+1)/12),(number+1)%12+1,1));}
  const weeks:Record<string,number>={'上周':-1,'本周':0,'这周':0,'下周':1};
  if(Object.hasOwn(weeks,expression)){const start=midnight+(-(local.getUTCDay()+6)%7+7*weeks[expression])*dayMs;return make('day',start,start+7*dayMs);}
  const absolute=expression.match(/^(\d{4})年(?:(\d{1,2})月(?:(\d{1,2})日)?)?$/);
  if(absolute){const y=Number(absolute[1]),m=Number(absolute[2]??1),d=Number(absolute[3]??1),start=date(y,m,d);
    if(absolute[3])return make('day',start,start+dayMs);
    if(absolute[2])return make('month',start,date(y+(m===12?1:0),m%12+1,1));
    return make('year',start,date(y+1,1,1));}
  return null;
}
function sameTime(left:string|null,right:string|null):boolean {
  return left===null||right===null?left===right:instantMicros(left)===instantMicros(right)&&offset(left)===offset(right);
}
/** 补偏移仅取候选自己的合法来源；闭区间末秒仅在日历可证明等价时规范化。 */
export function groundedEventProposal(payload:Record<string,any>,window:ExtractionWindow):Record<string,any> {
  const raw=payload.event;
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||raw.version!==2)return payload;
  const message=window.messages.find(m=>m.message_id===raw.anchor_message_id&&Array.isArray(payload.source_message_ids)&&payload.source_message_ids.includes(m.message_id));
  const actual=message?sourceCalendar(message):null,expression=raw.occurrence_expression;
  const grounded=message&&typeof expression==='string'&&expression.trim()&&Array.isArray(raw.occurrence_evidence)&&raw.occurrence_evidence.some((ref:any)=>
    ref&&ref.message_id===raw.anchor_message_id&&Number.isInteger(ref.char_start)&&Number.isInteger(ref.char_end)&&0<=ref.char_start&&ref.char_start<ref.char_end&&ref.char_end<=Array.from(message.text).length&&Array.from(message.text).slice(ref.char_start,ref.char_end).join('').includes(expression));
  const changed:Record<string,any>={};
  for(const key of ['occurrence_start','occurrence_end'])if(typeof raw[key]==='string'&&!/(?:Z|[+-]\d\d:\d\d)$/.test(raw[key])){
    requireValid(/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(raw[key])&&Number.isFinite(Date.parse(raw[key]+'Z')));
    when(raw[key]+'Z');
    changed[key]=actual?raw[key]+iso(0,actual.offset).slice(-6):null;
  }
  if(!actual){if(Object.keys(changed).length)Object.assign(changed,{occurrence_start:null,occurrence_end:null,occurrence_precision:'unknown'});}
  else {
    let expected:Calendar|null;try{expected=grounded?calendar(expression,actual):null;}catch{expected=null;}
    const proposal={...raw,...changed};
    if(expected&&['year','month','day'].includes(expected.precision)&&proposal.occurrence_precision===expected.precision&&sameTime(proposal.occurrence_start,expected.start)&&
      proposal.occurrence_end&&expected.end&&offset(proposal.occurrence_end)===offset(expected.end)&&Date.parse(proposal.occurrence_end)===Date.parse(expected.end)-1000)changed.occurrence_end=expected.end;
  }
  return Object.keys(changed).length?{...payload,event:{...raw,...changed}}:payload;
}
export function groundedValidity(fact:ExtractedFact,window:ExtractionWindow):ExtractedFact {
  if(!fact.requires_all_sources||fact.valid_at===null&&fact.invalid_at===null)return fact;
  const relevant=window.messages.filter(m=>fact.source_message_ids.includes(uuid(m.message_id)));
  if(relevant.some(m=>/\d{1,4}(?:年|月|日|号|[-/:])/.test(m.text)))return fact;
  const found:Calendar[]=[];
  for(const message of relevant)for(const match of message.text.matchAll(/(?:前天|昨天|今天|明天|后天|去年|今年|明年|上个月|这个月|下个月|上月|本月|下月|上周|本周|这周|下周)(?![一二三四五六日天])/g)){
    if(/说|表示|转述/.test(message.text.slice(0,message.text.indexOf(match[0]))))continue;
    try{const value=calendar(match[0],sourceCalendar(message));if(value)found.push(value);}catch{}
  }
  return found.length===1&&sameTime(fact.valid_at,found[0].start)&&sameTime(fact.invalid_at,found[0].end)?fact:{...fact,valid_at:null,invalid_at:null};
}
function unknown(event:MemoryEvent):MemoryEvent {return {...event,occurrence_start:null,occurrence_end:null,occurrence_precision:'unknown',occurrence_verified:false};}
export function checkedEventCalendar(event:MemoryEvent,window:ExtractionWindow,sourceIds:string[]):MemoryEvent {
  if(event.version===1)return event;
  const anchor=window.messages.find(m=>uuid(m.message_id)===event.anchor_message_id),expression=event.occurrence_expression;
  if(!anchor||!sourceIds.includes(uuid(anchor.message_id))){requireValid(event.anchor_message_id===null&&expression===null);return unknown(event);}
  const original=Array.from(anchor.text),matches=event.occurrence_evidence.filter(ref=>ref.message_id===uuid(anchor.message_id)).flatMap(ref=>{
    const fragment=original.slice(ref.char_start,ref.char_end).join(''),index=expression?fragment.indexOf(expression):-1;
    return index<0?[]:[ref.char_start+Array.from(fragment.slice(0,index)).length];});
  // 时间表达没有可定位的原话证据时按“发生时间未知”收口；逐条拒绝属于内容结果，不能升级为契约异常。
  if(!expression||matches.length===0)return unknown(event);
  if(matches.some(index=>/(说|表示|告诉|提到|转述|问)/.test(original.slice(0,index).join('').split(/[。！？；;\n]/).at(-1)!)))return unknown(event);
  let expected:Calendar|null;try{expected=calendar(expression,sourceCalendar(anchor));}catch{expected=null;}
  if(!expected||!event.occurrence_verified||event.occurrence_precision!==expected.precision||!sameTime(event.occurrence_start,expected.start)||!sameTime(event.occurrence_end,expected.end))return unknown(event);
  return event;
}
export function verifyEvent(raw:unknown,fact:ExtractedFact,window:ExtractionWindow):MemoryEvent|null {
  const event=fact.event;
  if(raw==null)return event?.version===2?checkedEventCalendar(event,window,fact.source_message_ids):event;
  // 没有时间提案时忽略多余的 event_verification 槽：时间本就不入库，不能因此拒绝正文候选。
  if(event===null)return null;
  const payload=object(raw);
  requireValid(Object.keys(payload).length===4&&['stage_verdict','occurrence_verdict','stage_evidence','occurrence_evidence'].every(k=>Object.hasOwn(payload,k)));
  const check=(kind:string)=>{const verdict=choices(payload[kind+'_verdict'],['supported','uncertain','unsupported']),refs=positions(payload[kind+'_evidence']);
    sourcePositions(refs,fact,window);requireValid(verdict!=='supported'||refs.length>0);return {verified:verdict==='supported',refs};};
  const stage=check('stage'),occurrence=check('occurrence');
  requireValid(!stage.verified||event.stage!=='unknown');requireValid(!occurrence.verified||event.occurrence_start!==null);
  return checkedEventCalendar({...event,stage_verified:stage.verified,stage_evidence:stage.refs,occurrence_verified:occurrence.verified,occurrence_evidence:occurrence.refs},window,fact.source_message_ids);
}
