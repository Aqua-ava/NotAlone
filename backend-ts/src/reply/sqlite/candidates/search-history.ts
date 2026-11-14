import type {StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {rankReplyRetrieval} from '../../../retrieval/sqlite/search.ts';
import {decode} from '../requests.ts';
import type {FrozenReplyInput} from './input.ts';
import {createHistoryEvidenceReader,freezeHistoryEvidence,type HistoryEvidenceBoundary,type HistoryEvidenceMessage,type HistoryContextPosition} from './history-evidence.ts';
import type {ReplySearchAttempt} from './search.ts';

export type ReplyHistoryBoundary=HistoryEvidenceBoundary;
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
 check();const legacyById=new Map(legacy?.map(item=>[item.id,item])),reader=createHistoryEvidenceReader(tx,i,boundary,check);
 const anchors:{message:HistoryEvidenceMessage;group:number}[]=[];
 const append=(message:HistoryEvidenceMessage,evidence:{group:number;position?:HistoryContextPosition}):boolean=>{
  check();if(used.has(message.id)||count>=budget.historyCount)return false;
  const size=Buffer.byteLength(message.text,'utf8');if(tokens+size>budget.historyTokens)return false;
  items.push(freezeHistoryEvidence(tx,i,message,evidence));used.add(message.id);count++;tokens+=size;return true;
 };
 const readHit=(id:string):HistoryEvidenceMessage|null=>{
  let message=reader.read(id);if(!message)return null;
  const anchor=legacyById.get(id);
  if(legacy&&(!anchor||message.acceptedRevision!==anchor.acceptedRevision||message.senderRole!==anchor.senderRole||message.sentAt!==anchor.sentAt))return null;
  if(anchor)message={...message,recordId:anchor.recordId};
  return message;
 };
 for(const hit of result.hits){
  check();if(count>=budget.historyCount)break;
  const message=readHit(hit.id);if(!message)continue;
  const group=anchors.length+1;if(append(message,{group}))anchors.push({message,group});
  // 旧冻结身份集合继续原有行为；新请求优先保留三个命中，为各自语境共同留出预算。
  if(!legacy&&anchors.length>=3)break;
 }
 if(!legacy&&count<budget.historyCount&&tokens<budget.historyTokens){
  // 先保证最高命中有较连贯的语境；余量再补后续片段，避免每组只有两三句碎片。
  for(const anchor of anchors){
   check();if(count>=budget.historyCount||tokens>=budget.historyTokens)break;
   for(const row of reader.nearby(anchor.message,used,budget.historyCount-count))append(row.message,{group:anchor.group,position:row.position});
  }
 }
 // 语境预留不是命中条数上限；仍有预算时继续接纳同一排名中的合法匹配项。
 if(!legacy)for(const hit of result.hits){
  check();if(count>=budget.historyCount)break;if(used.has(hit.id))continue;
  const message=readHit(hit.id);if(!message)continue;
  const group=anchors.length+1;if(append(message,{group}))anchors.push({message,group});
 }
 check();return {items,strategy:result.strategy,indexIncomplete:result.indexIncomplete};
}
