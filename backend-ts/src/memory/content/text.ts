import {sha256} from '../../platform/sha256.ts';
import type {MemoryContentPlugin} from './registry.ts';
// ECMAScript trim 的完整空白集合；用非空字符串比较保留 NUL 等有效正文。
const trimCharacters='\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
export const textMemoryContent:MemoryContentPlugin={
 id:'notalone.text',version:'1',kinds:['text'],
 modelInputCost:()=>({images:0,bytes:0}),
 snapshot(_tx,{message}){return typeof message.text_body==='string'&&message.text_body.trim()?{sha256:sha256(message.text_body)}:null;},
 availableMany(tx,{ownerId,contactId,messages}){
  const rows=tx.all(`SELECT id FROM message WHERE owner_id=? AND contact_id=? AND kind='text'
   AND typeof(text_body)='text' AND trim(text_body,?)<>'' AND id IN (SELECT value FROM json_each(?))`,
   [ownerId,contactId,trimCharacters,JSON.stringify(messages.map(message=>String(message.id)))]);
  return new Set(rows.map(row=>String(row.id)));
 },
 async prepare({message}){return {message:{message_id:String(message.id),text:String(message.text_body),sender:message.sender_role==='owner'?'self':'contact',
  occurred_at:message.sent_at===null?null:new Date(Number(message.sent_at)).toISOString(),text_representation:'text',content_kind:'text'}};},
};
