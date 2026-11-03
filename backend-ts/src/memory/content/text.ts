import {createHash} from 'node:crypto';
import type {MemoryContentPlugin} from './registry.ts';
export const textMemoryContent:MemoryContentPlugin={
 id:'notalone.text',version:'1',kinds:['text'],
 modelInputCost:()=>({images:0,bytes:0}),
 snapshot(_tx,{message}){return typeof message.text_body==='string'&&message.text_body.trim()?{sha256:createHash('sha256').update(message.text_body).digest('hex')}:null;},
 async prepare({message}){return {message:{message_id:String(message.id),text:String(message.text_body),sender:message.sender_role==='owner'?'self':'contact',
  occurred_at:message.sent_at===null?null:new Date(Number(message.sent_at)).toISOString(),text_representation:'text',content_kind:'text'}};},
};
