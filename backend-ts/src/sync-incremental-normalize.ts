/** 微信 CLI 事件的确定性解析与规范化；授权、消息 UUID 和去重由写入端负责。 */
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
// 加载时固化实际规则字节摘要；后续处理不再访问磁盘。
const ruleVersion=createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
import {parseJson, stringifyJson} from './host-json.ts';

export interface IncrementalProcessingRecord {record_id:string; locator:string; payload_json:string}
export interface IncrementalCliEvent {
  message_id:{local_id:number|bigint|string; talker:string; server_id_str:string|null};
  text:string; kind:string; sender:string|null; sender_wxid:string|null; is_from_me:boolean;
  create_time:number|bigint|null; time:string|null; time_iso:string|null;
  processing_record?:IncrementalProcessingRecord|null;
}
export interface NormalizedIncrementalMessage {
  source_locator:string; speaker:'user'|'contact'; message_type:'text'; text_content:string;
  media_placeholder:null; occurred_at:string|null;
  wechat_metadata:{external_local_id:string; external_server_id:string|null; external_talker:string; source_create_time:number|null; raw_payload_json:string};
  processing_record:IncrementalProcessingRecord;
}
export interface IncrementalTailResult {
  events:IncrementalCliEvent[]; cursor:string|null; last_local_id:string|null; event_count:number;
  non_text_count:number; freshness_confirmed:boolean; filtered_records:IncrementalProcessingRecord[];
  has_more:boolean; local_history_state:string|null;
}
export class IncrementalCliError extends Error {
  code:string;
  failure_record:IncrementalProcessingRecord|null = null;
  constructor(code:string, message:string) {super(message); this.name='IncrementalCliError'; this.code=code;}
}
type Obj=Record<string,unknown>;
const object=(v:unknown):v is Obj=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const fail=(message='微信 CLI 返回了无效事件。', code='cli_output_invalid'):never=>{throw new IncrementalCliError(code,message);};
const text=(v:unknown,field:string):string=>typeof v==='string'&&v.trim()?v:fail(`微信 CLI 字段 ${field} 无效。`);
const optionalText=(v:unknown):string|null=>v==null?null:typeof v==='string'?v:fail('微信 CLI 文本字段无效。');
const optionalInt=(v:unknown):number|bigint|null=>v==null?null:typeof v==='bigint'||typeof v==='number'&&Number.isSafeInteger(v)?v:fail('微信 CLI 时间字段无效。');
function localId(v:unknown):string {
  if(typeof v==='bigint'&&v>0n)return v.toString();
  if(typeof v==='number'&&Number.isSafeInteger(v)&&v>0)return String(v);
  if(typeof v==='string'&&/^[1-9]\d*$/.test(v))return v;
  return fail('微信 CLI 消息 ID 无效。');
}
const capture=(locator:string,payload:Obj):IncrementalProcessingRecord=>({record_id:randomUUID(),locator,payload_json:stringifyJson(payload)});
const extend=(r:IncrementalProcessingRecord,fields:Obj):IncrementalProcessingRecord=>({...r,payload_json:stringifyJson({...parseJson(r.payload_json) as Obj,...fields})});
// 收据沿用旧实现：记录实际处理规则字节摘要，仅读取本模块代码。
const execution=(start:string,status='succeeded')=>({started_at:start,finished_at:new Date().toISOString(),status,rule_version:ruleVersion});
function occurredAt(event:IncrementalCliEvent):string|null {
  if(event.create_time!==null){
    const n=Number(event.create_time);
    if(!Number.isSafeInteger(n)||n < -62135596800 || n > 253402300799)fail('CLI 消息原始时间无法解析。','cli_normalization_failed');
    return new Date(n*1000).toISOString().replace('.000Z','+00:00');
  }
  if(event.time_iso===null)return null;
  return parseIncrementalISO(event.time_iso);
}
export function normalizeCliEvents(events:Iterable<IncrementalCliEvent>,options:{processingReceipts?:IncrementalProcessingRecord[]}={}):NormalizedIncrementalMessage[]{
  const result:NormalizedIncrementalMessage[]=[]; let expected:string|undefined;
  for(const event of events){
    const started=new Date().toISOString();
    if(expected!==undefined&&event.message_id.talker!==expected)fail('一次观察批次只能包含同一会话的消息。','cli_normalization_failed');
    expected=event.message_id.talker;
    const locator=`cli:${event.message_id.local_id}`;
    if(event.kind!=='text'){
      options.processingReceipts?.push(capture(locator,{capture_layer:'metadata_only',record_text:null,parsed:{id:event.message_id,kind:event.kind},outcome:'non_text_filtered',normalize:execution(started,'filtered'),filter_rule:'text_only'}));continue;
    }
    const {processing_record:prior,...projection}=event;
    if(!event.text.trim()){
      options.processingReceipts?.push(extend(prior??capture(locator,{capture_layer:'parsed_only',record_text:null,parsed:projection,parse:{status:'not_observed'}}),{outcome:'empty_text_filtered',normalize:execution(started,'filtered'),filter_rule:'nonblank_text'}));continue;
    }
    let id:string;
    try{id=localId(event.message_id.local_id);}catch{fail('CLI 消息缺少稳定的本地 ID。','cli_normalization_failed');}
    if(typeof event.is_from_me!=='boolean')fail('CLI 消息说话人标记无效。','cli_normalization_failed');
    let occurred:string|null;
    try{occurred=occurredAt(event);}catch(error){
      if(error instanceof IncrementalCliError)error.failure_record=capture(locator,{capture_layer:'metadata_only',capture_status:'withheld_invalid_input',record_text:null,parsed:null,stage:'normalize',normalize:execution(started,'failed'),error_code:'invalid_message_time',outcome:'input_rejected'});
      throw error;
    }
    const snapshot={speaker:event.is_from_me?'user' as const:'contact' as const,message_type:'text' as const,text_content:event.text,media_placeholder:null,occurred_at:occurred};
    const record=extend(prior??capture(locator,{capture_layer:'parsed_only',record_text:null,parsed:projection,parse:{status:'not_observed',started_at:null,finished_at:null,rule_version:null}}),{
      converted:snapshot,normalize:execution(started),outcome:'normalized',transformations:{speaker:{rule:'is_from_me',input:event.is_from_me,output:snapshot.speaker},time:{rule:event.create_time!==null?'epoch_to_utc':event.time_iso!==null?'time_iso_assume_utc_if_naive':'missing_preserved',input:{create_time:event.create_time,time_iso:event.time_iso},output:occurred},body:{rule:'unchanged_text',output_field:'text_content'}}});
    result.push({...snapshot,source_locator:locator,wechat_metadata:{external_local_id:id!,external_server_id:event.message_id.server_id_str,external_talker:event.message_id.talker.trim(),source_create_time:event.create_time===null?null:Number(event.create_time),raw_payload_json:stringifyJson(projection)},processing_record:record});
    options.processingReceipts?.push(record);
  }
  return result;
}

export interface IncrementalFollowItem {cursor:string; local_id:string; event:IncrementalCliEvent|null; processing_record:IncrementalProcessingRecord}
function jsonLine(line:string):unknown {try{return parseJson(line);}catch{return fail();}}
export function parseIncrementalFollowLine(line:string,expectedTalker:string,inputPosition:number|null=null):IncrementalFollowItem|null {
  const started=new Date().toISOString(), value=jsonLine(line);
  if(!object(value)||value.type!=='message')return null;
  const cursor=text(value.cursor,'cursor'), message=value.message;
  if(!object(message)||!object(message.id))return fail();
  // 原生 CLI 的 local_id 必须为 JSON 整数，拒绝字符串伪装。
  if(typeof message.id.local_id!=='number'&&typeof message.id.local_id!=='bigint')return fail('微信 CLI 消息 ID 无效。');
  const id=localId(message.id.local_id), talker=text(message.id.talker,'message.id.talker');
  if(talker!==expectedTalker)return fail('微信 CLI 返回了其他会话的消息。');
  const kind=text(message.kind,'message.kind'), locator=`cli:${id}`;
  if(kind!=='text')return {cursor,local_id:id,event:null,processing_record:capture(locator,{capture_layer:'metadata_only',input_position:inputPosition,record_text:null,parsed:{type:'message',cursor,message:{id:{local_id:message.id.local_id,talker},kind}},parse:execution(started,'filtered'),outcome:'non_text_filtered',filter_rule:'text_only'})};
  const body=text(message.text,'message.text');
  if(typeof message.is_from_me!=='boolean')return fail('微信 CLI 说话人标记无效。');
  const record=capture(locator,{capture_layer:'cli_event_text',input_position:inputPosition,record_text:line,parsed:value,parse:execution(started)});
  return {cursor,local_id:id,processing_record:record,event:{message_id:{local_id:message.id.local_id as number|bigint,talker,server_id_str:optionalText(message.id.server_id_str)},text:body,kind,sender:optionalText(message.sender),sender_wxid:optionalText(message.sender_wxid),is_from_me:message.is_from_me,create_time:optionalInt(message.create_time),time:optionalText(message.time),time_iso:optionalText(message.time_iso),processing_record:record}};
}
export function parseIncrementalTail(stdout:string,expectedTalker:string,options:{history?:boolean}={}):IncrementalTailResult {
  const result:IncrementalTailResult={events:[],cursor:null,last_local_id:null,event_count:0,non_text_count:0,freshness_confirmed:false,filtered_records:[],has_more:false,local_history_state:null};
  let envelope:unknown;try{envelope=parseJson(stdout);}catch{envelope=null;}
  let ordered=false, pageCursor:unknown=null;
  if(object(envelope)&&'ok' in envelope){
    const data=envelope.data;
    if(envelope.ok!==true||!object(data)||!Array.isArray(data.events))return fail('微信 CLI 查询结果无效。');
    const freshness=data.freshness, query=data.query;
    if(!object(freshness)||freshness.message_source!=='live_message_db'||!object(query)||query.chat!==expectedTalker||typeof query.has_more!=='boolean'||options.history&&query.history!==true||truthy(envelope.warnings)||truthy(envelope.error)||truthy(data.warnings)||truthy(data.error))return fail('微信 CLI 未确认当前会话的实时读取结果。','cli_freshness_unknown');
    result.has_more=query.has_more;ordered=true;pageCursor=data.cursor;
    if(!data.events.length){if(query.has_more)return fail('微信 CLI 后续页没有可推进的事件。');result.freshness_confirmed=true;return result;}
    stdout=data.events.map(v=>stringifyJson(v)).join('\n');
  }
  // 保留行结束符，来源收据与 JSONL 原始行一致。
  const lines=stdout.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)??[];
  for(let index=0;index<lines.length;index++){
    const line=lines[index];if(!line.trim())continue;
    let item:IncrementalFollowItem|null;
    try{item=parseIncrementalFollowLine(line,expectedTalker,index+1);if(!item)fail('微信 CLI 返回了不支持的事件。');}
    catch(error){if(error instanceof IncrementalCliError)error.failure_record=capture(`cli_event:${index+1}`,{capture_layer:'metadata_only',capture_status:'withheld_invalid_input',record_text:null,parsed:null,stage:'parse',parse:execution(new Date().toISOString(),'failed'),error_code:error.code,outcome:'input_rejected'});throw error;}
    result.event_count++;
    if(ordered||result.last_local_id===null||BigInt(item!.local_id)>BigInt(result.last_local_id)){result.last_local_id=item!.local_id;result.cursor=item!.cursor;}
    if(item!.event)result.events.push(item!.event);else{result.non_text_count++;result.filtered_records.push(item!.processing_record);}
  }
  if(ordered&&pageCursor!=null&&pageCursor!==result.cursor)return fail('微信 CLI 页游标与最后事件不一致。');
  result.freshness_confirmed=result.event_count>0;return result;
}
function truthy(v:unknown):boolean {return Array.isArray(v)?v.length>0:object(v)?Object.keys(v).length>0:Boolean(v);}
export function parseIncrementalSessionLine(line:string):{cursor:string;conversation_locator:string}|null {
  const value=jsonLine(line);
  if(object(value)&&value.ok===false)return fail('微信 CLI 会话流失败。','cli_command_failed');
  if(!object(value)||!['session','unread'].includes(value.type as string))return null;
  const cursor=text(value.cursor,'cursor'), candidates:unknown[]=[];
  for(const field of ['session','conversation','data']){const nested=value[field];if(object(nested))for(const key of ['username','talker','conversation_locator','locator'])candidates.push(nested[key]);}
  for(const key of ['username','talker','conversation_locator'])candidates.push(value[key]);
  const locator=candidates.find(v=>typeof v==='string'&&v.trim());
  if(typeof locator!=='string')return fail('微信 CLI 会话事件缺少定位标识。');
  return {cursor,conversation_locator:locator};
}

/** datetime.fromisoformat 的确定性日历/周日期兼容；保留原始时区和微秒。 */
function parseIncrementalISO(input:string):string {
  const invalid=():never=>{return fail('CLI 消息原始时间无法解析。','cli_normalization_failed');};
  const date=/^(\d{4})(?:(-?)W(\d{2})(?:\2([1-7]))?|(-?)(\d{2})\5(\d{2}))/u.exec(input);
  if(!date)return invalid();
  let y=+date[1], month:number, day:number;
  if(y<1)return invalid();
  const utc=(year:number,mo:number,d:number)=>{const v=new Date(0);v.setUTCFullYear(year,mo-1,d);v.setUTCHours(0,0,0,0);return v;};
  if(date[3]){
    const week=+date[3], dow=+(date[4]??1), jan4=utc(y,1,4), jan4day=(jan4.getUTCDay()+6)%7;
    const v=new Date(+jan4+((week-1)*7+dow-1-jan4day)*86400000);
    const thursday=new Date(+v+(3-(v.getUTCDay()+6)%7)*86400000);
    if(week<1||week>53||thursday.getUTCFullYear()!==y)return invalid();
    y=v.getUTCFullYear();month=v.getUTCMonth()+1;day=v.getUTCDate();
    if(y<1||y>9999)return invalid();
  }else{
    month=+date[6];day=+date[7];const v=utc(y,month,day);
    if(v.getUTCFullYear()!==y||v.getUTCMonth()!==month-1||v.getUTCDate()!==day)return invalid();
  }
  const rest=input.slice(date[0].length);
  let hour=0,minute=0,second=0,fraction='',zone='+00:00';
  if(rest){
    // Python 接受单个 Unicode 字符作为日期/时间分隔符。
    const time=Array.from(rest).slice(1).join('');
    const m=/^(\d{2})(?:(:?)(\d{2})(?:\2(\d{2}))?)?(?:[.,](\d+))?(Z|[+-].+)?$/u.exec(time);
    if(!m)return invalid();
    hour=+m[1];minute=+(m[3]??0);second=+(m[4]??0);fraction=(m[5]??'').slice(0,6).padEnd(6,'0');
    if(hour>23||minute>59||second>59)return invalid();
    if(m[6]&&m[6]!=='Z'){
      const z=/^([+-])(\d{2})(?:(:?)(\d{2})(?:\3(\d{2}))?)?(?:[.,](\d+))?$/u.exec(m[6]);
      if(!z)return invalid();
      const total=+z[2]*3600+ +(z[4]??0)*60+ +(z[5]??0), zfrac=(z[6]??'').slice(0,6).padEnd(6,'0');
      if(total>=86400)return invalid();
      if(total!==0){
        zone=`${z[1]}${String(Math.floor(total/3600)).padStart(2,'0')}:${String(Math.floor(total/60)%60).padStart(2,'0')}`;
        if(total%60||+zfrac)zone+=`:${String(total%60).padStart(2,'0')}${+zfrac?'.'+zfrac:''}`;
      }
    }
  }
  const pad=(n:number)=>String(n).padStart(2,'0');
  return `${String(y).padStart(4,'0')}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}${+fraction?'.'+fraction:''}${zone}`;
}
