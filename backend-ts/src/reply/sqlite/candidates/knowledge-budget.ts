import {buildQueryTokens,RELEVANCE_THRESHOLD} from '../../../retrieval/retrieval-lexical.ts';
import {rankMemories} from '../../../retrieval/retrieval-ranking.ts';
import type {ReplyKnowledgeItem} from './contracts.ts';
import {DENSE_WEIGHT,HYBRID_THRESHOLD,SPARSE_WEIGHT,semanticKey} from './memory-semantics.ts';
/** 完整条目预算：联系人／本人记忆只限条数、不设字符上限，未确认候选保留条数与字符上限；最终请求仍经过provider完整输入预算。 */
export const RELATIONSHIP_BUDGET={contactCount:5,ownerCount:3,candidateCount:3,candidateChars:300,directoryCount:12,directoryChars:1600,profileCount:8,profileChars:1200,documentReadCount:2,documentBlocks:3,documentChars:1800} as const;
/** semantic 存在时联系人／本人记忆走混合检索（ADR-182）：综合分 = 0.8×语义余弦 + 0.2×词法覆盖率，不低于门槛才入选并按综合分排序；缺省为纯词法（0.15 覆盖率门槛）。 */
export function selectReplyKnowledge(items:ReplyKnowledgeItem[],query:string,semantic?:ReadonlyMap<string,number>):ReplyKnowledgeItem[]{
 const tokens=buildQueryTokens(query),selected:ReplyKnowledgeItem[]=[];
 for(const scopeKind of ['contact','owner','candidate'] as const){
  let chars=0,count=0;const maxCount=scopeKind==='candidate'?RELATIONSHIP_BUDGET.candidateCount:scopeKind==='contact'?RELATIONSHIP_BUDGET.contactCount:RELATIONSHIP_BUDGET.ownerCount,maxChars=scopeKind==='candidate'?RELATIONSHIP_BUDGET.candidateChars:Infinity;
  const candidates=items.filter(item=>scopeKind==='candidate'?item.kind==='memory_candidate':item.kind==='memory'&&item.scopeKind===scopeKind);
  const ranked=candidates.length&&tokens.length?rankMemories(candidates.map(item=>({
   item,text:item.text,...(item.kind==='memory_candidate'?{candidate_id:item.id}:{memory_id:item.id}),
   adoption_method:item.qualification==='confirmed'?'manual':'auto',confidence:0,valid_at:null,
  })),tokens,candidates.length):[];
  const hybrid=semantic!==undefined&&scopeKind!=='candidate';
  let order:{item:ReplyKnowledgeItem}[]=ranked.filter(row=>row.relevance_score>=RELEVANCE_THRESHOLD);
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
   const size=Array.from(item.text).length;
   if(count>=maxCount||chars+size>maxChars)continue;
   selected.push(item);count++;chars+=size;
  }
 }
 let directoryChars=0,directoryCount=0,profileChars=0;
 for(const item of items.filter(item=>item.kind==='document')){
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
