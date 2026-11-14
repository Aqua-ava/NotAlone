import {randomUUID} from 'node:crypto';
import {sha256} from '../../../platform/sha256.ts';
import {StorageFailure,type StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {searchAllReplyHistory,ReplyHistorySearchTimeout,type ReplyHistoryBoundary} from './search-history.ts';
import {REPLY_SEARCH_BUDGET,type RelationshipSearchKind} from '../retrieval-policy.ts';
import {buildQueryTokens,scoreTokens,RELEVANCE_THRESHOLD} from '../../../retrieval/retrieval-lexical.ts';
import type {DiscussionAttempt} from '../contracts.ts';
import {requireAttempt,encode,decode} from '../requests.ts';
import type {ReplyKnowledgeHeader,ReplyKnowledgeItem,ReplyKnowledgeReader,ReplySource} from './contracts.ts';
import {selectReplyKnowledge} from './knowledge-budget.ts';
import {readSemanticScores,type SemanticMemory} from './memory-semantics.ts';
import {requireReplyInput,messageTimePrefix,memorySourceTimeLabel,sources,knowledge,type FrozenReplyInput} from './input.ts';

export {REPLY_SEARCH_BUDGET} from '../retrieval-policy.ts';
export type ReplySearchKind=RelationshipSearchKind;
export type ReplySearchAttempt=DiscussionAttempt&{contextId:string};
interface MemoryAnchor {id:string;versionNo:bigint;textSeal:string}
interface HistoryAnchor {id:string;recordId:string;acceptedRevision:bigint;senderRole:string;sentAt:bigint|null}
interface LegacySearchScope {phase:'scope';version:1;contextId:string;memories:MemoryAnchor[];history:HistoryAnchor[]}
interface FullSearchScope {phase:'scope';version:2;contextId:string;memories:MemoryAnchor[];historyBoundary:ReplyHistoryBoundary}
type SearchScope=LegacySearchScope|FullSearchScope;
interface SearchBegin {phase:'begin';kind:ReplySearchKind;querySeal:string;scopeId:string;memories:MemoryAnchor[]}
interface SearchEvent {id:string;payload:Record<string,unknown>}
export interface ReplySearchResult {status:'ok'|'empty'|'error'|'rejected';kind:ReplySearchKind;scope:'frozen_l1'|'frozen_contact_history';items:FrozenReplyInput[];code?:string}
export type ReplySearchTicket={status:'accepted';ticketId:string;kind:ReplySearchKind;query:string;pool:SemanticMemory[]}|ReplySearchResult;
const fail=(code:string):never=>{throw new StorageFailure(code);};
const resultScope=(kind:ReplySearchKind)=>kind==='memory'?'frozen_l1' as const:'frozen_contact_history' as const;
const anchorKey=(value:{id:string;versionNo:bigint})=>encode([value.id,value.versionNo]);
function events(tx:StorageTransaction,i:ReplySearchAttempt):SearchEvent[]{
 return tx.all(`SELECT e.id,e.payload FROM execution_event e JOIN reply_attempt a ON a.owner_id=e.owner_id AND a.id=e.reply_attempt_id
  WHERE a.owner_id=? AND a.request_id=? AND e.kind='reply_search' ORDER BY a.attempt_no,e.event_no`,[i.ownerId,i.requestId]).map(row=>({id:String(row.id),payload:decode(String(row.payload))}));
}
function record(tx:StorageTransaction,i:ReplySearchAttempt,payload:object):string{
 const id=randomUUID(),next=tx.get('SELECT COALESCE(MAX(event_no),0)+1 n FROM execution_event WHERE owner_id=? AND reply_attempt_id=?',[i.ownerId,i.attemptId])!.n;
 tx.run('INSERT INTO execution_event(owner_id,id,reply_attempt_id,event_no,kind,payload,created_at) VALUES(?,?,?,?,?,?,?)',[i.ownerId,id,i.attemptId,next,'reply_search',encode(payload),Date.now()]);return id;
}
function reject(tx:StorageTransaction,i:ReplySearchAttempt,kind:ReplySearchKind,code:string,extra:object={}):ReplySearchResult{
 record(tx,i,{phase:'rejected',kind,code,...extra});return {status:'rejected',kind,scope:resultScope(kind),items:[],code};
}
function context(tx:StorageTransaction,i:ReplySearchAttempt,reader:ReplyKnowledgeReader):void{
 requireAttempt(tx,i);requireReplyInput(tx,i,i.contextId,reader);
 if(!tx.get("SELECT 1 FROM reply_context WHERE owner_id=? AND id=? AND request_id=? AND attempt_id=? AND contact_id=? AND discussion_id=? AND state='active'",[i.ownerId,i.contextId,i.requestId,i.attemptId,i.contactId,i.discussionId]))fail('discussion_context_invalid');
}
function backgroundEnabled(tx:StorageTransaction,i:ReplySearchAttempt):boolean{
 return !tx.all("SELECT identity_json FROM reply_candidate_input WHERE owner_id=? AND context_id=? AND kind='entry'",[i.ownerId,i.contextId]).some(row=>{const identity=decode<Record<string,unknown>>(String(row.identity_json));return identity.workspaceItem==='request'&&identity.includeRelationshipContext===false;});
}
const headers=(tx:StorageTransaction,i:ReplySearchAttempt,reader:ReplyKnowledgeReader)=>reader.list?reader.list(tx,i):reader.read(tx,i);
function memoryAnchor(item:ReplyKnowledgeHeader):MemoryAnchor{return {id:item.id,versionNo:item.versionNo,textSeal:sha256(item.text)};}
function frozenScope(rows:SearchEvent[]):{id:string;scope:SearchScope}|null{
 const row=rows.find(row=>row.payload.phase==='scope'&&(row.payload.version===1||row.payload.version===2));
 return row?{id:row.id,scope:row.payload as unknown as SearchScope}:null;
}
/** 与初始材料同事务冻结只读检索范围；元数据不作为已读正文或实际来源依赖。 */
export function initializeReplySearch(tx:StorageTransaction,i:ReplySearchAttempt,reader:ReplyKnowledgeReader):void{
 context(tx,i,reader);if(!backgroundEnabled(tx,i)||frozenScope(events(tx,i)))return;
 const memories=headers(tx,i,reader).filter(item=>item.kind==='memory'&&(item.scopeKind==='owner'&&item.contactId===null||item.scopeKind==='contact'&&item.contactId===i.contactId)).map(memoryAnchor);
 // 只保存接纳序号与资料代次，不复制逐条历史身份或正文。
 const displayNo=tx.get('SELECT COALESCE(MAX(display_no),0) n FROM message WHERE owner_id=? AND contact_id=?',[i.ownerId,i.contactId])!.n as bigint;
 const dataGeneration=tx.get('SELECT data_generation FROM contact WHERE owner_id=? AND id=?',[i.ownerId,i.contactId])!.data_generation as bigint;
 record(tx,i,{phase:'scope',version:2,contextId:i.contextId,memories,historyBoundary:{displayNo,dataGeneration}} satisfies FullSearchScope);
}
/** 旧输入没有冻结范围时不补造历史资格；Skill降级沿原请求找到同一范围。 */
export function hasReplySearchScope(tx:StorageTransaction,i:ReplySearchAttempt,reader:ReplyKnowledgeReader):boolean{
 context(tx,i,reader);return backgroundEnabled(tx,i)&&frozenScope(events(tx,i))!==null;
}
/** 占用一次请求级尝试；只返回供本机评分的临时正文，不持久化查询或候选池正文。 */
export function beginReplySearch(tx:StorageTransaction,i:ReplySearchAttempt&{kind:ReplySearchKind;query:string},reader:ReplyKnowledgeReader):ReplySearchTicket{
 context(tx,i,reader);const kind=i.kind==='history'?'history':'memory',rows=events(tx,i),frozen=frozenScope(rows);
 if(!['memory','history'].includes(i.kind)||typeof i.query!=='string'||!i.query.trim()||Array.from(i.query).length>REPLY_SEARCH_BUDGET.queryChars)return reject(tx,i,kind,'reply_search_query_invalid');
 if(!backgroundEnabled(tx,i)||!frozen)return reject(tx,i,kind,'reply_search_unavailable');
 const query=i.query.trim(),querySeal=sha256(query);
 if(rows.some(row=>row.payload.phase==='begin'&&row.payload.kind===kind&&row.payload.querySeal===querySeal))return reject(tx,i,kind,'reply_search_duplicate',{querySeal});
 if(rows.filter(row=>row.payload.phase==='begin').length>=REPLY_SEARCH_BUDGET.attempts)return reject(tx,i,kind,'reply_search_budget_exceeded',{querySeal});
 const allowed=new Map(frozen.scope.memories.map(item=>[anchorKey(item),item]));
 const pool=kind==='memory'?headers(tx,i,reader).filter(item=>item.kind==='memory'&&allowed.get(anchorKey(item))?.textSeal===sha256(item.text)):[];
 const ticketId=record(tx,i,{phase:'begin',kind,querySeal,scopeId:frozen.id,memories:pool.map(memoryAnchor)} satisfies SearchBegin);
 return {status:'accepted',ticketId,kind,query,pool:pool.map(item=>({id:item.id,versionNo:item.versionNo,text:item.text}))};
}
function append(tx:StorageTransaction,i:ReplySearchAttempt,item:Omit<FrozenReplyInput,'itemNo'>):FrozenReplyInput{
 const itemNo=Number(tx.get('SELECT COALESCE(MAX(item_no),0)+1 n FROM reply_candidate_input WHERE owner_id=? AND context_id=?',[i.ownerId,i.contextId])!.n);
 tx.run('INSERT INTO reply_candidate_input VALUES(?,?,?,?,?,?)',[i.ownerId,i.contextId,itemNo,item.kind,encode(item.identity),item.text]);
 for(const source of item.sources)tx.run('INSERT INTO reply_candidate_input_source VALUES(?,?,?,?,?,?,?)',[i.ownerId,i.contextId,itemNo,source.contactId,source.recordId,source.messageId,source.acceptedRevision]);
 return {...item,itemNo};
}
function memories(tx:StorageTransaction,i:ReplySearchAttempt,query:string,ticket:SearchBegin,reader:ReplyKnowledgeReader,semantic:unknown):Omit<FrozenReplyInput,'itemNo'>[]{
 const prior=tx.all("SELECT identity_json FROM reply_candidate_input WHERE owner_id=? AND context_id=? AND kind='memory'",[i.ownerId,i.contextId]).map(row=>decode<ReplyKnowledgeItem>(String(row.identity_json)));
 const used=new Set(prior.map(item=>item.id)),remaining={contact:Math.max(0,REPLY_SEARCH_BUDGET.contactMemories-prior.filter(item=>item.scopeKind==='contact').length),owner:Math.max(0,REPLY_SEARCH_BUDGET.ownerMemories-prior.filter(item=>item.scopeKind==='owner').length)};
 const allowed=new Map(ticket.memories.map(item=>[anchorKey(item),item])),candidates=headers(tx,i,reader).filter(item=>item.kind==='memory'&&!used.has(item.id)&&allowed.get(anchorKey(item))?.textSeal===sha256(item.text));
 const selected=selectReplyKnowledge({memories:candidates,documents:[],open(header){
  if(!remaining[header.scopeKind])return null;
  const item=reader.open?reader.open(tx,i,header):reader.read(tx,i).find(item=>item.kind===header.kind&&item.id===header.id&&item.versionNo===header.versionNo)??null;
  if(!item)return null;knowledge(tx,i,[item],reader);remaining[header.scopeKind]--;return item;
 }},query,readSemanticScores(semantic,query));
 return selected.map(item=>({kind:'memory',identity:item,text:item.text+memorySourceTimeLabel(tx,i.ownerId,(item as ReplyKnowledgeItem&{citationSources?:ReplySource[]}).citationSources??item.sources,Date.now()),sources:item.sources}));
}
function history(tx:StorageTransaction,i:ReplySearchAttempt,query:string,scope:LegacySearchScope):Omit<FrozenReplyInput,'itemNo'>[]{
 const prior=tx.all("SELECT identity_json,text_body FROM reply_candidate_input WHERE owner_id=? AND context_id=? AND kind='message'",[i.ownerId,i.contextId]);
 const used=new Set(tx.all(`SELECT s.message_id FROM reply_candidate_input_source s JOIN reply_candidate_input x
  ON x.owner_id=s.owner_id AND x.context_id=s.context_id AND x.item_no=s.item_no
  WHERE s.owner_id=? AND s.context_id=? AND x.kind='message'`,[i.ownerId,i.contextId]).map(row=>String(row.message_id)));
 const retrieved=prior.filter(row=>decode<Record<string,unknown>>(String(row.identity_json)).retrieved===true);
 let count=retrieved.length,tokens=retrieved.reduce((sum,row)=>sum+Buffer.byteLength(String(row.text_body),'utf8'),0);
 const queryTokens=buildQueryTokens(query),ranked=scope.history.flatMap(anchor=>{
  if(used.has(anchor.id))return [];
  const row=tx.get("SELECT text_body,sender_role,sent_at,interpretation_revision FROM message WHERE owner_id=? AND contact_id=? AND id=? AND kind='text' AND availability='available'",[i.ownerId,i.contactId,anchor.id]);
  if(!row||row.interpretation_revision!==anchor.acceptedRevision||row.sender_role!==anchor.senderRole||row.sent_at!==anchor.sentAt)return [];
  const score=scoreTokens(queryTokens,String(row.text_body)).score;return score>=RELEVANCE_THRESHOLD?[{anchor,text:String(row.text_body),score}]:[];
 }).sort((a,b)=>b.score-a.score||a.anchor.id.localeCompare(b.anchor.id));
 const selected:Omit<FrozenReplyInput,'itemNo'>[]=[];
 for(const candidate of ranked){
  if(count>=REPLY_SEARCH_BUDGET.historyCount)break;
  const {anchor}=candidate,author=anchor.senderRole==='owner'?'我':anchor.senderRole==='contact'?'对方':anchor.senderRole==='system'?'系统':'未知作者';
  const text=messageTimePrefix(anchor.sentAt)+author+'：'+candidate.text,size=Buffer.byteLength(text,'utf8');
  if(tokens+size>REPLY_SEARCH_BUDGET.historyTokens)continue;
  const refs=[{contactId:i.contactId,messageId:anchor.id,recordId:anchor.recordId,acceptedRevision:anchor.acceptedRevision}];
  try{sources(tx,i.ownerId,refs);}catch(error){if(error instanceof StorageFailure)continue;throw error;}
  selected.push({kind:'message',identity:{retrieved:true,messageId:anchor.id,recordId:anchor.recordId,acceptedRevision:anchor.acceptedRevision,senderRole:anchor.senderRole,sentAt:anchor.sentAt},text,sources:refs});count++;tokens+=size;
 }
 return selected;
}
/** 不接受外层传入正文或结果ID；按持久ticket的冻结成员重新读取、核验并原子追加。 */
export function finishReplySearch(tx:StorageTransaction,i:ReplySearchAttempt&{ticketId:string;query:string;semantic?:unknown;error?:'timeout'|'failed'},reader:ReplyKnowledgeReader,options:{clock?:()=>number}={}):ReplySearchResult{
 context(tx,i,reader);const rows=events(tx,i),event=rows.find(row=>row.id===i.ticketId&&row.payload.phase==='begin'),ticket=event?.payload as unknown as SearchBegin|undefined,kind=ticket?.kind??'memory';
 if(!ticket||typeof i.query!=='string'||sha256(i.query.trim())!==ticket.querySeal)return reject(tx,i,kind,'reply_search_ticket_invalid');
 if(rows.some(row=>row.payload.phase==='finish'&&row.payload.ticketId===i.ticketId))return reject(tx,i,kind,'reply_search_ticket_finished',{ticketId:i.ticketId});
 const frozen=rows.find(row=>row.id===ticket.scopeId&&row.payload.phase==='scope');
 if(!frozen||!backgroundEnabled(tx,i))return reject(tx,i,kind,'reply_search_unavailable',{ticketId:i.ticketId});
 if(i.error!==undefined){
  if(!['timeout','failed'].includes(i.error))return reject(tx,i,kind,'reply_search_result_invalid',{ticketId:i.ticketId});
  record(tx,i,{phase:'finish',ticketId:i.ticketId,kind,status:'error',code:i.error});return {status:'error',kind,scope:resultScope(kind),items:[],code:i.error};
 }
 let selected:Omit<FrozenReplyInput,'itemNo'>[];
 try{
  const scope=frozen.payload as unknown as SearchScope;
  selected=kind==='memory'?memories(tx,i,i.query.trim(),ticket,reader,i.semantic):scope.version===1?history(tx,i,i.query.trim(),scope)
   :searchAllReplyHistory(tx,i,i.query.trim(),scope.historyBoundary,REPLY_SEARCH_BUDGET,options.clock??(()=>performance.now()));
 }catch(error){
  if(!(error instanceof ReplyHistorySearchTimeout))throw error;
  record(tx,i,{phase:'finish',ticketId:i.ticketId,kind,status:'error',code:'timeout'});
  return {status:'error',kind,scope:resultScope(kind),items:[],code:'reply_search_timeout'};
 }
 const items=selected.map(item=>append(tx,i,item));requireReplyInput(tx,i,i.contextId,reader);
 const status=items.length?'ok':'empty';record(tx,i,{phase:'finish',ticketId:i.ticketId,kind,status,itemNos:items.map(item=>item.itemNo)});
 return {status,kind,scope:resultScope(kind),items};
}
