import {buildQueryTokens,RELEVANCE_THRESHOLD} from '../../../retrieval/retrieval-lexical.ts';
import {rankMemories} from '../../../retrieval/retrieval-ranking.ts';
import type {ReplyKnowledgeHeader,ReplyKnowledgeItem,ReplyKnowledgeReader} from './contracts.ts';
import type {StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import type {DiscussionScope} from '../contracts.ts';
/** 完整条目预算：联系人／本人记忆只限条数、不设字符上限，未确认候选保留条数与字符上限；最终请求仍经过provider完整输入预算。 */
export const RELATIONSHIP_BUDGET={contactCount:5,ownerCount:3,candidateCount:3,candidateChars:300,directoryCount:12,directoryChars:1600,profileCount:8,profileChars:1200,documentReadCount:2,documentBlocks:3,documentChars:1800} as const;
/**
 * 选取输入：记忆／候选以头部参与排序，只有入选前才用 open 核验来源并物化；文档整体读取。
 * 未提供 list/open 的读者退化为整体读取（open 即恒等），行为与逐条核验后再排序完全一致。
 */
export interface ReplyKnowledgeSource {
 memories:readonly ReplyKnowledgeHeader[];
 open(header:ReplyKnowledgeHeader):ReplyKnowledgeItem|null;
 documents:readonly ReplyKnowledgeItem[];
}
export function eagerKnowledgeSource(items:readonly ReplyKnowledgeItem[]):ReplyKnowledgeSource{
 return {memories:items.filter(item=>item.kind!=='document'),open:header=>header as ReplyKnowledgeItem,documents:items.filter(item=>item.kind==='document')};
}
/** 读者支持按需核验时只做低成本列表；否则整体读取。每次回复只在事务内调用一次。 */
export function readReplyKnowledgeSource(tx:StorageTransaction,scope:DiscussionScope,reader:ReplyKnowledgeReader):ReplyKnowledgeSource{
 const {list,open,readDocuments}=reader;
 if(!list||!open)return eagerKnowledgeSource(reader.read(tx,scope));
 // 只有记忆的读者没有文档；同时产出文档的读者必须提供 readDocuments。
 return {memories:list.call(reader,tx,scope),open:header=>open.call(reader,tx,scope,header),documents:readDocuments?readDocuments.call(reader,tx,scope):[]};
}
/** 正式记忆消费检索层已排序的精确版本锚点；未传锚点时保留词法兼容，未确认候选始终独立走词法路径。 */
export function selectReplyKnowledge(input:readonly ReplyKnowledgeItem[]|ReplyKnowledgeSource,query:string,ranked?:readonly {id:string;versionNo:bigint;score:number}[]):ReplyKnowledgeItem[]{
 const source=Array.isArray(input)?eagerKnowledgeSource(input):input as ReplyKnowledgeSource;
 const tokens=buildQueryTokens(query),selected:ReplyKnowledgeItem[]=[];
 const lexical=(candidates:readonly ReplyKnowledgeHeader[]):ReplyKnowledgeHeader[]=>candidates.length&&tokens.length?rankMemories(candidates.map(item=>({
   item,text:item.text,...(item.kind==='memory_candidate'?{candidate_id:item.id}:{memory_id:item.id}),
   adoption_method:item.qualification==='confirmed'?'manual':'auto',confidence:0,valid_at:null,
  })),tokens,candidates.length).filter(row=>row.relevance_score>=RELEVANCE_THRESHOLD).map(row=>row.item):[];
 const memories=source.memories.filter(item=>item.kind==='memory'),byId=new Map(memories.map(item=>[item.id,item])),seen=new Set<string>();
 const order=ranked===undefined?(['contact','owner'] as const).flatMap(scopeKind=>lexical(memories.filter(item=>item.scopeKind===scopeKind))):ranked.flatMap(anchor=>{
  const item=byId.get(anchor.id);
  if(!item||item.versionNo!==anchor.versionNo||seen.has(item.id))return [];
  seen.add(item.id);return [item];
 });
 const counts={contact:0,owner:0};
 for(const item of order){
  const maxCount=item.scopeKind==='contact'?RELATIONSHIP_BUDGET.contactCount:RELATIONSHIP_BUDGET.ownerCount;
  if(counts[item.scopeKind]>=maxCount)continue;
  // 来源失效不占预算，沿检索顺序继续补位；记忆始终保留完整正文。
  const opened=source.open(item);if(!opened)continue;
  selected.push(opened);counts[item.scopeKind]++;
 }
 let candidateChars=0,candidateCount=0;
 for(const item of lexical(source.memories.filter(item=>item.kind==='memory_candidate'))){
  if(candidateCount>=RELATIONSHIP_BUDGET.candidateCount)break;
  const size=Array.from(item.text).length;
  if(candidateChars+size>RELATIONSHIP_BUDGET.candidateChars)continue;
  const opened=source.open(item);if(!opened)continue;
  selected.push(opened);candidateCount++;candidateChars+=size;
 }
 let directoryChars=0,directoryCount=0,profileChars=0;
 for(const item of source.documents){
  const size=Array.from(item.text).length;
  if(item.projection?.kind==='directory'){
   if(directoryCount>=RELATIONSHIP_BUDGET.directoryCount||directoryChars+size>RELATIONSHIP_BUDGET.directoryChars)continue;
   directoryCount++;directoryChars+=size;
  }else{
   if(profileChars+size>RELATIONSHIP_BUDGET.profileChars)continue;
   profileChars+=size;
  }
  selected.push(item);
 }
 return selected;
}
