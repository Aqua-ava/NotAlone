import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import type {HistoryQuoteContent} from '../sqlite/contracts.ts';

export interface WechatQuoteSourceIdentity {partition:string;table:string;localId:string;serverId:string;sentAt:string|null}
export interface WechatQuotePayload extends HistoryQuoteContent,WechatQuoteSourceIdentity {
 format:'wechat-quote-message-v1';accountKey:string;conversationKey:string;sourceGeneration:string;contentSha256:string;
}
const fail=():never=>{throw new StorageFailure('history_quote_association_unverified');};
const nullableText=(value:unknown,maximum:number):boolean=>value===null||typeof value==='string'&&value.isWellFormed()&&Buffer.byteLength(value,'utf8')<=maximum&&!value.includes('\0');
const exactId=(value:unknown):boolean=>typeof value==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(value)&&BigInt(value)<=18446744073709551615n;

/** 只接受当前守卫、会话及精确消息的有界结构，不让渠道身份或XML进入展示层。 */
export function readWechatQuotePayload(value:unknown,scope:{accountKey:string;conversationKey:string;sourceGeneration:string},source:WechatQuoteSourceIdentity):WechatQuotePayload {
 if(!value||typeof value!=='object'||Array.isArray(value))return fail();
 const row=value as Record<string,unknown>,keys=['format','accountKey','conversationKey','sourceGeneration','partition','table','localId','serverId','sentAt','replyText','referencedText','referencedSender','referencedSenderRole','referencedType','referencedServerId','contentSha256'];
 if(Object.keys(row).length!==keys.length||keys.some(key=>!Object.hasOwn(row,key))||row.format!=='wechat-quote-message-v1'
  ||row.accountKey!==scope.accountKey||row.conversationKey!==scope.conversationKey||row.sourceGeneration!==scope.sourceGeneration
  ||Object.keys(source).some(key=>row[key]!==source[key as keyof WechatQuoteSourceIdentity])
  ||typeof row.replyText!=='string'||!row.replyText.trim()||!nullableText(row.replyText,65_536)||!nullableText(row.referencedText,65_536)
  ||!nullableText(row.referencedSender,255)||!['owner','contact','unknown'].includes(row.referencedSenderRole as string)
  ||!(row.referencedType===null||exactId(row.referencedType))||!(row.referencedServerId===null||exactId(row.referencedServerId))
  ||typeof row.contentSha256!=='string'||!/^[a-f0-9]{64}$/.test(row.contentSha256))return fail();
 return row as unknown as WechatQuotePayload;
}
