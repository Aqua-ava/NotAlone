import type { HistoryRecord, HistoryTarget } from './contracts.ts';
const exactInteger=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v)&&BigInt(v)<=18446744073709551615n;
const label=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=512;
const kinds=new Set(['text','image','voice','video','file','sticker','other']);
export interface PreparedRecord { raw: string; localKey: string | null; serverKey: string | null; reason: string | null; value: HistoryRecord }
/** 只保留来源证明所需字段；非文字输入的任何正文或媒体字段不落盘。 */
export function prepareRecord(input:HistoryRecord,sourceGeneration:string,target:HistoryTarget):PreparedRecord {
 const r:HistoryRecord={partition:input?.partition,table:input?.table,localId:input?.localId,serverId:input?.serverId,
  sender:input?.sender,kind:input?.kind,text:input?.kind==='text'&&input?.stateAssurance==='verified'?input.text:null,originalType:input?.originalType,
  sentAt:input?.sentAt,timePrecision:input?.timePrecision,orderScheme:input?.orderScheme,orderKey:input?.orderKey,...(input?.status!==undefined?{status:input.status}:{}),stateAssurance:input?.stateAssurance};
 const identityValid=label(r.partition)&&target.partitions.includes(r.partition)&&label(r.table)&&exactInteger(r.localId)&&target.tables.some(t=>t.partition===r.partition&&t.instance===r.table);
 let reason:string|null=null;
 if(!label(r.partition)||!target.partitions.includes(r.partition)||!label(r.table)||!exactInteger(r.localId))reason='message_identity_insufficient';
 else if(!target.tables.some(t=>t.partition===r.partition&&t.instance===r.table))reason='message_table_unverified';
 else if(r.stateAssurance!=='verified')reason='message_state_unverified';
 else if(r.status!==undefined&&r.status!==null&&(typeof r.status!=='string'||!/^-?(0|[1-9][0-9]{0,18})$/.test(r.status)||BigInt(r.status)<-9223372036854775808n||BigInt(r.status)>9223372036854775807n))reason='message_status_invalid';
 else if(r.serverId!==null&&!exactInteger(r.serverId))reason='message_alias_invalid';
 else if(!['owner','contact'].includes(r.sender)||!kinds.has(r.kind)||!label(r.originalType)||r.kind==='text'&&(typeof r.text!=='string'||r.text.length>1_000_000))reason='message_content_unverified';
 else if((r.sentAt===null)!==(r.timePrecision===null)||r.sentAt!==null&&(!exactInteger(r.sentAt)||BigInt(r.sentAt)>253402300799999n)||r.timePrecision!==null&&!['second','millisecond'].includes(r.timePrecision))reason='message_time_invalid';
 else if((r.orderScheme===null)!==(r.orderKey===null)||r.orderScheme!==null&&(!label(r.orderScheme)||!exactInteger(r.orderKey)))reason='message_order_invalid';
 return {raw:JSON.stringify(r),value:r,localKey:identityValid&&(!reason||reason==='message_state_unverified')?JSON.stringify([sourceGeneration,r.partition,r.table,r.localId]):null,serverKey:r.serverId&&r.serverId!=='0'&&exactInteger(r.serverId)?r.serverId:null,reason};
}
