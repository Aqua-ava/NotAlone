import {buildQueryTokens,RELEVANCE_THRESHOLD} from '../../../retrieval/retrieval-lexical.ts';
import {rankMemories} from '../../../retrieval/retrieval-ranking.ts';
import type {ReplyKnowledgeHeader,ReplyKnowledgeItem,ReplyKnowledgeReader} from './contracts.ts';
import type {StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import type {DiscussionScope} from '../contracts.ts';
import {DENSE_WEIGHT,HYBRID_THRESHOLD,SPARSE_WEIGHT,semanticKey} from './memory-semantics.ts';
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
/** semantic 存在时联系人／本人记忆走混合检索（ADR-182）：综合分 = 0.8×语义余弦 + 0.2×词法覆盖率，不低于门槛才入选并按综合分排序；缺省为纯词法（0.15 覆盖率门槛）。 */
export function selectReplyKnowledge(input:readonly ReplyKnowledgeItem[]|ReplyKnowledgeSource,query:string,semantic?:ReadonlyMap<string,number>):ReplyKnowledgeItem[]{
 const source=Array.isArray(input)?eagerKnowledgeSource(input):input as ReplyKnowledgeSource;
 const tokens=buildQueryTokens(query),selected:ReplyKnowledgeItem[]=[];
 for(const scopeKind of ['contact','owner','candidate'] as const){
  let chars=0,count=0;const maxCount=scopeKind==='candidate'?RELATIONSHIP_BUDGET.candidateCount:scopeKind==='contact'?RELATIONSHIP_BUDGET.contactCount:RELATIONSHIP_BUDGET.ownerCount,maxChars=scopeKind==='candidate'?RELATIONSHIP_BUDGET.candidateChars:Infinity;
  const candidates=source.memories.filter(item=>scopeKind==='candidate'?item.kind==='memory_candidate':item.kind==='memory'&&item.scopeKind===scopeKind);
  const ranked=candidates.length&&tokens.length?rankMemories(candidates.map(item=>({
   item,text:item.text,...(item.kind==='memory_candidate'?{candidate_id:item.id}:{memory_id:item.id}),
   adoption_method:item.qualification==='confirmed'?'manual':'auto',confidence:0,valid_at:null,
  })),tokens,candidates.length):[];
  const hybrid=semantic!==undefined&&scopeKind!=='candidate';
  let order:{item:ReplyKnowledgeHeader}[]=ranked.filter(row=>row.relevance_score>=RELEVANCE_THRESHOLD);
  if(hybrid){
   // 稠密为主、稀疏为辅合成一个分数；没有语义得分的记忆（检索期间被修订）不入选；无词法 token 时词法分按 0 计。
   const lexical=new Map(ranked.map(row=>[row.item,row.relevance_score]));
   order=candidates.flatMap(item=>{
    const cosine=semantic.get(semanticKey(item.id,item.versionNo));
    if(cosine===undefined)return [];
    const score=DENSE_WEIGHT*cosine+SPARSE_WEIGHT*(lexical.get(item)??0);
    return score>=HYBRID_THRESHOLD?[{item,score}]:[];
   }).sort((a,b)=>b.score-a.score||(b.item.qualification==='confirmed'?1:0)-(a.item.qualification==='confirmed'?1:0)||(a.item.id<b.item.id?-1:1));
  }
  for(const {item} of order){
   if(count>=maxCount)break;
   const size=Array.from(item.text).length;
   if(chars+size>maxChars)continue;
   // 排序与预算只依赖正文；来源核验推迟到真正可能入选时，失效条目被跳过且不占预算。
   const opened=source.open(item);
   if(!opened)continue;
   selected.push(opened);count++;chars+=size;
  }
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
