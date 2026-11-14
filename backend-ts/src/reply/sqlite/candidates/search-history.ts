import type {StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {savedSourceScopeCTE,currentSourcePredicate} from '../../../history/sqlite/current-scope.ts';
import {rankReplyRetrieval} from '../../../retrieval/sqlite/search.ts';
import {decode} from '../requests.ts';
import {messageTimePrefix,sources,type FrozenReplyInput} from './input.ts';
import type {ReplySearchAttempt} from './search.ts';

export interface ReplyHistoryBoundary {displayNo:bigint;dataGeneration:bigint}
interface Budget {historyCount:number;historyTokens:number;historyTimeoutMs:number}
interface LegacyAnchor {id:string;recordId:string;acceptedRevision:bigint;senderRole:string;sentAt:bigint|null}
export class ReplyHistorySearchTimeout extends Error {}

/** 共享索引召回只产出身份；本事务物化入选原文并复验来源，保持作者、时间与完整消息预算。 */
export function searchAllReplyHistory(tx:StorageTransaction,i:ReplySearchAttempt,query:string,boundary:ReplyHistoryBoundary,budget:Budget,clock:()=>number,queryVector?:readonly number[],legacy?:readonly LegacyAnchor[]){
 const deadline=clock()+budget.historyTimeoutMs,check=()=>{if(clock()>=deadline)throw new ReplyHistorySearchTimeout();};
 const prior=tx.all("SELECT identity_json,text_body FROM reply_candidate_input WHERE owner_id=? AND context_id=? AND kind='message'",[i.ownerId,i.contextId]);
 const retrieved=prior.filter(row=>decode<Record<string,unknown>>(String(row.identity_json)).retrieved===true);
 let count=retrieved.length,tokens=retrieved.reduce((sum,row)=>sum+Buffer.byteLength(String(row.text_body),'utf8'),0);
 const items:Omit<FrozenReplyInput,'itemNo'>[]=[];
 if(count>=budget.historyCount||tokens>=budget.historyTokens)return {items,strategy:'bm25' as const,indexIncomplete:false};
 const used=new Set(tx.all(`SELECT s.message_id FROM reply_candidate_input_source s JOIN reply_candidate_input x
  ON x.owner_id=s.owner_id AND x.context_id=s.context_id AND x.item_no=s.item_no WHERE s.owner_id=? AND s.context_id=? AND x.kind='message'`,[i.ownerId,i.contextId]).map(row=>String(row.message_id)));
 check();
 const result=rankReplyRetrieval(tx,{ownerId:i.ownerId,contactId:i.contactId,kind:'history',query,queryVector,
  scope:{kind:'history',...boundary,...(legacy?{messageIds:legacy.map(item=>item.id)}:{})},excludeIds:[...used],limit:(budget.historyCount-count)*3,check});
 check();const legacyById=new Map(legacy?.map(item=>[item.id,item]));
 for(const hit of result.hits){
  check();if(count>=budget.historyCount)break;
  const row=tx.get(`WITH ${savedSourceScopeCTE} SELECT m.text_body,m.sender_role,m.sent_at,m.interpretation_revision,
   (SELECT r.id FROM capture_record r INDEXED BY capture_record_message JOIN sync_capture c ON c.owner_id=r.owner_id AND c.contact_id=r.contact_id AND c.id=r.capture_id
    JOIN read_goal g ON g.owner_id=c.owner_id AND g.contact_id=c.contact_id AND g.id=c.goal_id
    WHERE r.owner_id=m.owner_id AND r.contact_id=m.contact_id AND r.message_id=m.id AND m.binding_id=g.binding_id
     AND g.accepted_data_generation<=? AND r.state='normalized' AND r.availability='available' AND ${currentSourcePredicate()} ORDER BY r.id LIMIT 1) record_id
   FROM message m WHERE m.owner_id=? AND m.contact_id=? AND m.id=? AND m.kind='text' AND m.availability='available' AND length(m.text_body)>0
    AND EXISTS(SELECT 1 FROM source_proof p WHERE p.owner_id=m.owner_id AND p.contact_id=m.contact_id AND p.state='ok')
    AND NOT EXISTS(SELECT 1 FROM history_message_quarantine q WHERE q.owner_id=m.owner_id AND q.contact_id=m.contact_id AND q.message_id=m.id)
    AND record_id IS NOT NULL`,[i.ownerId,i.contactId,i.contactId,boundary.dataGeneration,i.ownerId,i.contactId,hit.id]);
  if(!row)continue;
  const anchor=legacyById.get(hit.id);
  if(legacy&&(!anchor||row.interpretation_revision!==anchor.acceptedRevision||row.sender_role!==anchor.senderRole||row.sent_at!==anchor.sentAt))continue;
  const senderRole=String(row.sender_role),author=senderRole==='owner'?'我':senderRole==='contact'?'对方':senderRole==='system'?'系统':'未知作者';
  const text=messageTimePrefix(row.sent_at)+author+'：'+String(row.text_body),size=Buffer.byteLength(text,'utf8');
  if(tokens+size>budget.historyTokens)continue;
  const recordId=anchor?.recordId??String(row.record_id),acceptedRevision=row.interpretation_revision as bigint;
  const refs=[{contactId:i.contactId,messageId:hit.id,recordId,acceptedRevision}];sources(tx,i.ownerId,refs);
  items.push({kind:'message',identity:{retrieved:true,messageId:hit.id,recordId,acceptedRevision,senderRole,sentAt:row.sent_at},text,sources:refs});count++;tokens+=size;
 }
 check();return {items,strategy:result.strategy,indexIncomplete:result.indexIncomplete};
}
