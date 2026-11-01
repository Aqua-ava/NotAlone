import type { HistoryQuoteErrorCode,HistoryRecord,HistoryTarget } from './contracts.ts';
const exactInteger=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v)&&BigInt(v)<=18446744073709551615n;
const label=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=512;
const kinds=new Set(['text','image','voice','video','file','sticker','other']);
export interface PreparedRecord {
 raw: string; localKey: string | null; serverKey: string | null; reason: string | null; value: HistoryRecord;
 quote?:HistoryRecord['quote'];quoteErrorCode?:HistoryQuoteErrorCode;
}
const quoteErrors=new Set<HistoryQuoteErrorCode>(['history_quote_unavailable','history_quote_metadata_invalid','history_quote_too_large',
 'history_quote_state_unverified','history_quote_association_unverified','history_quote_read_failed']);
export function verifiedTerminalReason(record:HistoryRecord):'source_recalled'|'source_absent'|null{
 if(record?.stateAssurance!=='verified'||record.kind!=='other'||record.text!==null)return null;
 return record.messageState==='recalled'?'source_recalled':record.messageState==='absent'?'source_absent':null;
}
/** 只保留来源证明所需字段；非文字输入的任何正文或媒体字段不落盘。 */
export function prepareRecord(input:HistoryRecord,sourceGeneration:string,target:HistoryTarget):PreparedRecord {
 const r:HistoryRecord={partition:input?.partition,table:input?.table,localId:input?.localId,serverId:input?.serverId,
  sender:input?.sender,kind:input?.kind,text:input?.kind==='text'&&input?.stateAssurance==='verified'?input.text:null,originalType:input?.originalType,
  sentAt:input?.sentAt,timePrecision:input?.timePrecision,orderScheme:input?.orderScheme,orderKey:input?.orderKey,...(input?.status!==undefined?{status:input.status}:{}),stateAssurance:input?.stateAssurance,...(input?.metadataOnly!==undefined?{metadataOnly:input.metadataOnly}:{}),...(input?.messageState!==undefined?{messageState:input.messageState}:{})};
 const metadataOnly=r.metadataOnly===true&&r.stateAssurance==='unverified'&&r.messageState===undefined&&r.kind!=='text'&&input.text===null&&exactInteger(r.originalType)&&((BigInt(r.originalType)&0xffffffffn)!==1n);
 const quote=input?.quote;
 const quoteErrorCode=input?.quoteErrorCode;
 const quoteCarrier=r.kind==='other'&&r.text===null&&r.originalType==='244813135921'&&r.metadataOnly===true
  &&r.stateAssurance==='unverified'&&r.messageState===undefined;
 const quoteContentValid=quoteErrorCode===undefined&&quote!==undefined&&quoteCarrier&&typeof quote==='object'&&quote!==null
  &&typeof quote.replyText==='string'&&quote.replyText.trim().length>0&&quote.replyText.length<=1_000_000
  &&(quote.referencedText===null||typeof quote.referencedText==='string'&&quote.referencedText.length<=1_000_000)
  &&(quote.referencedSender===null||typeof quote.referencedSender==='string'&&quote.referencedSender.length<=255)
  &&['owner','contact','unknown'].includes(quote.referencedSenderRole)
  &&(quote.referencedType===null||typeof quote.referencedType==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(quote.referencedType)&&BigInt(quote.referencedType)<=18446744073709551615n)
  &&(quote.referencedServerId===null||exactInteger(quote.referencedServerId))&&/^[a-f0-9]{64}$/.test(quote.proofDigest);
 const quoteErrorValid=quoteErrorCode!==undefined&&quote===undefined&&quoteCarrier&&quoteErrors.has(quoteErrorCode);
 const quoteFieldsValid=quote===undefined&&quoteErrorCode===undefined||quoteContentValid||quoteErrorValid;
 const identityValid=label(r.partition)&&target.partitions.includes(r.partition)&&label(r.table)&&exactInteger(r.localId)&&target.tables.some(t=>t.partition===r.partition&&t.instance===r.table);
 const terminalReason=verifiedTerminalReason(input);
 let reason:string|null=null;
 if(!label(r.partition)||!target.partitions.includes(r.partition)||!label(r.table)||!exactInteger(r.localId))reason='message_identity_insufficient';
 else if(!target.tables.some(t=>t.partition===r.partition&&t.instance===r.table))reason='message_table_unverified';
 else if(terminalReason)reason=terminalReason;
 else if(r.messageState!==undefined&&!['sent','received'].includes(r.messageState))reason='message_state_unverified';
 else if(r.metadataOnly!==undefined&&!metadataOnly)reason='message_content_unverified';
 else if(!quoteFieldsValid)reason='message_content_unverified';
 else if(r.stateAssurance!=='verified'&&!metadataOnly)reason='message_state_unverified';
 else if(r.status!==undefined&&r.status!==null&&(typeof r.status!=='string'||!/^-?(0|[1-9][0-9]{0,18})$/.test(r.status)||BigInt(r.status)<-9223372036854775808n||BigInt(r.status)>9223372036854775807n))reason='message_status_invalid';
 else if(r.serverId!==null&&!exactInteger(r.serverId))reason='message_alias_invalid';
 else if(!['owner','contact',...(metadataOnly?['unknown']:[])].includes(r.sender)||!kinds.has(r.kind)||!label(r.originalType)||r.kind==='text'&&(typeof r.text!=='string'||r.text.length>1_000_000))reason='message_content_unverified';
 else if((r.sentAt===null)!==(r.timePrecision===null)||r.sentAt!==null&&(!exactInteger(r.sentAt)||BigInt(r.sentAt)>253402300799999n)||r.timePrecision!==null&&!['second','millisecond'].includes(r.timePrecision))reason='message_time_invalid';
 else if((r.orderScheme===null)!==(r.orderKey===null)||r.orderScheme!==null&&(!label(r.orderScheme)||!exactInteger(r.orderKey)))reason='message_order_invalid';
 else if(metadataOnly&&(r.sender==='unknown'||r.originalType==='10000'))reason='metadata_only';
 return {raw:JSON.stringify(r),value:r,localKey:identityValid&&(!reason||reason==='message_state_unverified'||reason==='source_recalled'||reason==='source_absent'||reason==='metadata_only')?JSON.stringify([sourceGeneration,r.partition,r.table,r.localId]):null,
  serverKey:r.serverId&&r.serverId!=='0'&&exactInteger(r.serverId)?r.serverId:null,reason,
  ...(quoteContentValid?{quote}:{}),...(quoteErrorValid?{quoteErrorCode}:{})};
}
