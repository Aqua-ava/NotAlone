import type {StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {savedSourceScopeCTE,currentSourcePredicate} from '../../../history/sqlite/current-scope.ts';
import {buildQueryTokens,scoreTokens,RELEVANCE_THRESHOLD} from '../../../retrieval/retrieval-lexical.ts';
import {decode} from '../requests.ts';
import {messageTimePrefix,sources,type FrozenReplyInput} from './input.ts';
import type {ReplySearchAttempt} from './search.ts';

export interface ReplyHistoryBoundary {displayNo:bigint;dataGeneration:bigint}
interface Budget {historyCount:number;historyTokens:number;historyTimeoutMs:number}
interface Candidate {id:string;recordId:string;acceptedRevision:bigint;senderRole:string;sentAt:bigint|null;text:string;score:number;size:number}
export class ReplyHistorySearchTimeout extends Error {}
const pageSize=128;
const compare=(a:Candidate,b:Candidate)=>b.score-a.score||a.id.localeCompare(b.id);

/** 遍历接纳边界内全部历史；分页只约束单批工作量，不截断可搜索消息集合。 */
export function searchAllReplyHistory(tx:StorageTransaction,i:ReplySearchAttempt,query:string,boundary:ReplyHistoryBoundary,budget:Budget,clock:()=>number):Omit<FrozenReplyInput,'itemNo'>[]{
 const deadline=clock()+budget.historyTimeoutMs,check=()=>{if(clock()>=deadline)throw new ReplyHistorySearchTimeout();};
 const prior=tx.all("SELECT identity_json,text_body FROM reply_candidate_input WHERE owner_id=? AND context_id=? AND kind='message'",[i.ownerId,i.contextId]);
 const retrieved=prior.filter(row=>decode<Record<string,unknown>>(String(row.identity_json)).retrieved===true);
 let count=retrieved.length,tokens=retrieved.reduce((sum,row)=>sum+Buffer.byteLength(String(row.text_body),'utf8'),0);
 if(count>=budget.historyCount||tokens>=budget.historyTokens)return [];
 const used=new Set(tx.all(`SELECT s.message_id FROM reply_candidate_input_source s JOIN reply_candidate_input x
  ON x.owner_id=s.owner_id AND x.context_id=s.context_id AND x.item_no=s.item_no WHERE s.owner_id=? AND s.context_id=? AND x.kind='message'`,[i.ownerId,i.contextId]).map(row=>String(row.message_id)));
 const terms=buildQueryTokens(query);if(!terms.length)return [];
 // 每种完整字节长度只需保留最多剩余条数；同长度中更低排名的条目不可能优先入选。
 // 按长度分桶，避免大量较长高分消息挤掉仍能放入剩余预算的短消息；内存不随历史量增长。
 const buckets=new Map<number,Candidate[]>(),slots=budget.historyCount-count,remaining=budget.historyTokens-tokens;
 let cursor=0n;
 while(cursor<boundary.displayNo){
  check();
  const ids=tx.all(`SELECT id,display_no FROM message WHERE owner_id=? AND contact_id=? AND display_no>? AND display_no<=?
   AND kind='text' AND availability='available' ORDER BY display_no LIMIT ?`,[i.ownerId,i.contactId,cursor,boundary.displayNo,pageSize]);
  if(!ids.length)break;cursor=ids.at(-1)!.display_no as bigint;
  check();
  // 只为本批定向身份核验来源；获准且仍有效时才读取正文。
  const rows=tx.all(`WITH ${savedSourceScopeCTE} SELECT m.id,m.text_body,m.sender_role,m.sent_at,m.interpretation_revision,
   (SELECT r.id FROM capture_record r JOIN sync_capture c ON c.owner_id=r.owner_id AND c.contact_id=r.contact_id AND c.id=r.capture_id
    JOIN read_goal g ON g.owner_id=c.owner_id AND g.contact_id=c.contact_id AND g.id=c.goal_id
    WHERE r.owner_id=m.owner_id AND r.contact_id=m.contact_id AND r.message_id=m.id AND m.binding_id=g.binding_id
     AND g.accepted_data_generation<=? AND r.state='normalized' AND r.availability='available' AND ${currentSourcePredicate()} ORDER BY r.id LIMIT 1) record_id
   FROM message m WHERE m.owner_id=? AND m.contact_id=? AND m.id IN (${ids.map(()=>'?').join(',')})
    AND m.kind='text' AND m.availability='available' AND length(m.text_body)>0
    AND EXISTS(SELECT 1 FROM source_proof p WHERE p.owner_id=m.owner_id AND p.contact_id=m.contact_id AND p.state='ok')
    AND NOT EXISTS(SELECT 1 FROM history_message_quarantine q WHERE q.owner_id=m.owner_id AND q.contact_id=m.contact_id AND q.message_id=m.id)
    AND record_id IS NOT NULL`,[i.ownerId,i.contactId,i.contactId,boundary.dataGeneration,i.ownerId,i.contactId,...ids.map(row=>row.id)]);
  check();
  for(const row of rows){
   check();if(used.has(String(row.id)))continue;
   const senderRole=String(row.sender_role),author=senderRole==='owner'?'我':senderRole==='contact'?'对方':senderRole==='system'?'系统':'未知作者';
   const text=messageTimePrefix(row.sent_at)+author+'：'+String(row.text_body),size=Buffer.byteLength(text,'utf8');
   if(size>remaining)continue;
   const score=scoreTokens(terms,String(row.text_body)).score;if(score<RELEVANCE_THRESHOLD)continue;
   const candidate:Candidate={id:String(row.id),recordId:String(row.record_id),acceptedRevision:row.interpretation_revision as bigint,senderRole,sentAt:row.sent_at as bigint|null,text,score,size};
   const bucket=buckets.get(size)??[];bucket.push(candidate);bucket.sort(compare);if(bucket.length>slots)bucket.pop();buckets.set(size,bucket);
  }
 }
 const ranked=[...buckets.values()].flat().sort(compare),selected:Omit<FrozenReplyInput,'itemNo'>[]=[];
 for(const row of ranked){
  check();if(count>=budget.historyCount)break;if(tokens+row.size>budget.historyTokens)continue;
  const refs=[{contactId:i.contactId,messageId:row.id,recordId:row.recordId,acceptedRevision:row.acceptedRevision}];
  sources(tx,i.ownerId,refs);
  selected.push({kind:'message',identity:{retrieved:true,messageId:row.id,recordId:row.recordId,acceptedRevision:row.acceptedRevision,senderRole:row.senderRole,sentAt:row.sentAt},text:row.text,sources:refs});count++;tokens+=row.size;
 }
 check();return selected;
}
