import {isUuid} from '../uuid';
import {isRecord} from './result-read';
import type {SavedAssistantTurn,SavedAssistantInput} from '../../shared/assistant-session';
import type {SqliteDiscussionEntry,SqliteRuntimeRecovery} from '../../shared/sqlite-discussion';
function invalid():never{throw new Error('已保存讨论暂不可用。');}
/** 正文资格失败时整个新快照拒绝，不把历史候选拼成模型发言。 */
export function readSqliteDiscussion(value:unknown,sessionId:string,generation:number){
 if(!isRecord(value)||value.mode!=='sqlite'||value.session_id!==sessionId||!Array.isArray(value.entries)
  ||Object.keys(value).length!==4||!['none','ready','blocked'].includes(value.runtime_recovery as string))invalid();
 let last=0n;const known=new Set<string>();
 const entries:SqliteDiscussionEntry[]=value.entries.map((item:unknown)=>{
  if(!isRecord(item)||Object.keys(item).length!==7||!isUuid(item.entry_id)||!isUuid(item.request_id)
   ||!['user','assistant'].includes(item.role as string)||typeof item.position!=='string'||!/^[1-9][0-9]{0,30}$/.test(item.position)
   ||!['available','cleared'].includes(item.content_state as string)||known.has(item.entry_id))invalid();
  const position=BigInt(item.position);if(position<=last)invalid();last=position;known.add(item.entry_id);
  if(item.role==='user'||item.content_state==='cleared'?item.call_id!==null:!isUuid(item.call_id))invalid();
  if(item.content_state==='available'?typeof item.text!=='string'||!item.text.trim():item.text!==null)invalid();
  return {entryId:item.entry_id,position:item.position,role:item.role as SqliteDiscussionEntry['role'],text:item.text as string|null,requestId:item.request_id,callId:item.call_id as string|null,contentState:item.content_state as SqliteDiscussionEntry['contentState']};
 });
 return {sessionId,turns:[] as SavedAssistantTurn[],inputs:[] as SavedAssistantInput[],currentInputVersionId:null,generation,discussionEntries:entries,runtimeRecovery:value.runtime_recovery as SqliteRuntimeRecovery};
}
