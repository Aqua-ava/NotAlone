import type {StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {savedSourceScopeCTE,currentSourcePredicate} from '../../../history/sqlite/current-scope.ts';
import {messageTimePrefix,sources,type FrozenReplyInput} from './input.ts';

export interface HistoryEvidenceBoundary {displayNo:bigint;dataGeneration:bigint}
interface Scope {ownerId:string;contactId:string}
export interface HistoryEvidenceMessage {
 id:string;bindingId:string;recordId:string;acceptedRevision:bigint;senderRole:string;sentAt:bigint|null;text:string;
}
export type HistoryContextPosition='before'|'after'|'same_time';
export interface HistoryContextMessage {message:HistoryEvidenceMessage;position:HistoryContextPosition}
const NEARBY_WINDOW_MS=180000n;
const MAX_CANDIDATES_PER_SIDE=16;

/** 统一物化命中和邻近原话：候选身份有界，正文始终经当前来源资格过滤后才读取。 */
export function createHistoryEvidenceReader(tx:StorageTransaction,scope:Scope,boundary:HistoryEvidenceBoundary,check:()=>void){
 const cache=new Map<string,HistoryEvidenceMessage|null>();
 const read=(id:string):HistoryEvidenceMessage|null=>{
  check();if(cache.has(id))return cache.get(id)!;
  const row=tx.get(`WITH ${savedSourceScopeCTE} SELECT m.id,m.binding_id,m.text_body,m.sender_role,m.sent_at,m.interpretation_revision,
   (SELECT r.id FROM capture_record r INDEXED BY capture_record_message JOIN sync_capture c ON c.owner_id=r.owner_id AND c.contact_id=r.contact_id AND c.id=r.capture_id
    JOIN read_goal g ON g.owner_id=c.owner_id AND g.contact_id=c.contact_id AND g.id=c.goal_id
    WHERE r.owner_id=m.owner_id AND r.contact_id=m.contact_id AND r.message_id=m.id AND m.binding_id=g.binding_id
     AND g.accepted_data_generation<=? AND r.state='normalized' AND r.availability='available' AND ${currentSourcePredicate()} ORDER BY r.id LIMIT 1) record_id
   FROM message m WHERE m.owner_id=? AND m.contact_id=? AND m.id=? AND m.display_no<=?
    AND m.kind='text' AND m.availability='available' AND length(m.text_body)>0
    AND EXISTS(SELECT 1 FROM source_proof p WHERE p.owner_id=m.owner_id AND p.contact_id=m.contact_id AND p.state='ok')
    AND NOT EXISTS(SELECT 1 FROM history_message_quarantine q WHERE q.owner_id=m.owner_id AND q.contact_id=m.contact_id AND q.message_id=m.id)
    AND record_id IS NOT NULL`,[scope.ownerId,scope.contactId,scope.contactId,boundary.dataGeneration,scope.ownerId,scope.contactId,id,boundary.displayNo]);
  check();
  const value=row?{id:String(row.id),bindingId:String(row.binding_id??''),recordId:String(row.record_id),acceptedRevision:row.interpretation_revision as bigint,senderRole:String(row.sender_role),sentAt:row.sent_at as bigint|null,
   text:messageTimePrefix(row.sent_at)+(row.sender_role==='owner'?'我':row.sender_role==='contact'?'对方':row.sender_role==='system'?'系统':'未知作者')+'：'+String(row.text_body)}:null;
  cache.set(id,value);return value;
 };
 const nearby=(anchor:HistoryEvidenceMessage,excluded:ReadonlySet<string>,limit:number):HistoryContextMessage[]=>{
  const anchorTime=anchor.sentAt,count=Number.isSafeInteger(limit)?Math.max(0,Math.min(MAX_CANDIDATES_PER_SIDE,limit)):0;
  if(anchorTime===null||!anchor.bindingId||!count)return [];
  const selected=new Set([anchor.id,...excluded]);
  const side=(before:boolean):string[]=>{
   check();
   // display_no只作同时间候选的稳定取样键；同时间返回时明确标记顺序未核验。
   const ids=tx.all(`SELECT id FROM message WHERE owner_id=? AND contact_id=? AND binding_id=? AND id<>? AND display_no<=?
    AND kind='text' AND availability='available' AND sent_at>=? AND sent_at<=? AND sent_at${before?'<=':'>='}?
    ORDER BY sent_at ${before?'DESC':'ASC'},display_no ${before?'DESC':'ASC'} LIMIT ?`,
    [scope.ownerId,scope.contactId,anchor.bindingId,anchor.id,boundary.displayNo,anchorTime-NEARBY_WINDOW_MS,anchorTime+NEARBY_WINDOW_MS,anchorTime,count]);
   check();return ids.map(row=>String(row.id));
  };
  const before=side(true),after=side(false),result:HistoryContextMessage[]=[];
  // 前后交替核对，让剩余总预算覆盖一个较连贯的有界片段，不固定压成两条碎片。
  for(let index=0;index<Math.max(before.length,after.length)&&result.length<count;index++)for(const side of [before,after]){
   check();const id=side[index];if(id===undefined||selected.has(id)||result.length>=count)continue;
   const message=read(id);if(!message||message.sentAt===null)continue;
   result.push({message,position:message.sentAt===anchorTime?'same_time':message.sentAt<anchorTime?'before':'after'});selected.add(id);
  }
  return result;
 };
 return {read,nearby};
}

/** 每条邻近语境使用独立材料编号和精确来源，预算仍按完整消息正文计算。 */
export function freezeHistoryEvidence(tx:StorageTransaction,scope:Scope,message:HistoryEvidenceMessage,evidence:{group:number;position?:HistoryContextPosition}):Omit<FrozenReplyInput,'itemNo'>{
 const refs=[{contactId:scope.contactId,messageId:message.id,recordId:message.recordId,acceptedRevision:message.acceptedRevision}];
 sources(tx,scope.ownerId,refs);
 return {kind:'message',identity:{retrieved:true,messageId:message.id,recordId:message.recordId,acceptedRevision:message.acceptedRevision,senderRole:message.senderRole,sentAt:message.sentAt,
  evidenceRole:evidence.position?'context':'match',evidenceGroup:evidence.group,...(evidence.position?{contextPosition:evidence.position}:{})},text:message.text,sources:refs};
}
