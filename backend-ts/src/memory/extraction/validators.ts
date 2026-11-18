import type {EvidencePosition,ExtractedFact,ExtractionWindow} from './protocol.ts';
/** 抽取协议的确定性字段校验原语；protocol.ts 与 calendar.ts 共用，避免两者互相导入。 */
export class ExtractionProtocolError extends Error {
  readonly failure_kind='invalid_output';
  constructor(message='来源核验结果不符合证据契约。'){super(message);this.name='ExtractionProtocolError';}
}
export function object(value:unknown):Record<string,any> {
  if(value===null||typeof value!=='object'||Array.isArray(value))throw new ExtractionProtocolError();
  return value as Record<string,any>;
}
export function requireValid(ok:unknown):asserts ok {if(!ok)throw new ExtractionProtocolError();}
export function uuid(value:unknown):string {
  requireValid(typeof value==='string');
  const clean=value.replace(/^urn:uuid:/i,'').replace(/^\{|\}$/g,'').replace(/-/g,'');
  requireValid(/^[0-9a-f]{32}$/i.test(clean));
  return clean.toLowerCase().replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,'$1-$2-$3-$4-$5');
}
export function text(value:unknown):string {requireValid(typeof value==='string'&&value.trim());return value;}
export function choices(value:unknown,allowed:readonly string[]):string {requireValid(typeof value==='string'&&allowed.includes(value));return value;}
export function stringArray(value:unknown):string[] {requireValid(Array.isArray(value));return value.map(text);}
export function when(value:unknown):string|null {
  if(value===null)return null;
  requireValid(typeof value==='string'&&/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value)));
  const parts=value.match(/^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d))?/)!;
  const year=Number(parts[1]),month=Number(parts[2]),day=Number(parts[3]);
  const check=new Date(0);check.setUTCFullYear(year,month-1,day);
  requireValid(year>=1&&year<=9999&&check.getUTCMonth()===month-1&&check.getUTCDate()===day&&Number(parts[4])<24&&Number(parts[5])<60&&Number(parts[6]??0)<60);
  return value;
}
/** 与Python datetime相同保留六位微秒，避免JS毫秒截断改变来源等值或排序。 */
export function instantMicros(value:string):bigint {
  const fraction=value.match(/\.(\d+)/)?.[1]??'';
  return BigInt(Date.parse(value.replace(/\.\d+/,'')))*1000n+BigInt(fraction.slice(0,6).padEnd(6,'0'));
}
export function exactFields(value:Record<string,any>,fields:string[]):void {
  requireValid(Object.keys(value).length===fields.length&&fields.every(key=>Object.hasOwn(value,key)));
}
export function positions(value:unknown):EvidencePosition[] {
  requireValid(Array.isArray(value)&&value.length<=8);
  return value.map(item=>{const ref=object(item);exactFields(ref,['message_id','char_start','char_end']);
    requireValid(Number.isInteger(ref.char_start)&&Number.isInteger(ref.char_end)&&0<=ref.char_start&&ref.char_start<ref.char_end&&ref.char_end<=100000);
    return {message_id:uuid(ref.message_id),char_start:ref.char_start,char_end:ref.char_end};});
}
export function sourcePositions(refs:EvidencePosition[],fact:Pick<ExtractedFact,'source_message_ids'>,window:ExtractionWindow):void {
  for(const ref of refs){const message=window.messages.find(m=>uuid(m.message_id)===ref.message_id);
    requireValid(fact.source_message_ids.includes(ref.message_id)&&message&&message.text_representation==='text'&&ref.char_end<=Array.from(message.text).length);}
}
