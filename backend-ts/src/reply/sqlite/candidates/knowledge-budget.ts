import {buildQueryTokens,RELEVANCE_THRESHOLD} from '../../../retrieval/retrieval-lexical.ts';
import {rankMemories} from '../../../retrieval/retrieval-ranking.ts';
import type {ReplyKnowledgeItem} from './contracts.ts';
/** 完整条目预算；最终请求仍经过provider完整输入预算。 */
export const RELATIONSHIP_BUDGET={contactCount:5,contactChars:600,ownerCount:3,ownerChars:240,candidateCount:3,candidateChars:300,directoryCount:12,directoryChars:1600,profileCount:8,profileChars:1200,documentReadCount:2,documentBlocks:3,documentChars:1800} as const;
export function selectReplyKnowledge(items:ReplyKnowledgeItem[],query:string):ReplyKnowledgeItem[]{
 const tokens=buildQueryTokens(query),selected:ReplyKnowledgeItem[]=[];
 for(const scopeKind of ['contact','owner','candidate'] as const){
  let chars=0,count=0;const maxCount=scopeKind==='candidate'?RELATIONSHIP_BUDGET.candidateCount:scopeKind==='contact'?RELATIONSHIP_BUDGET.contactCount:RELATIONSHIP_BUDGET.ownerCount,maxChars=scopeKind==='candidate'?RELATIONSHIP_BUDGET.candidateChars:scopeKind==='contact'?RELATIONSHIP_BUDGET.contactChars:RELATIONSHIP_BUDGET.ownerChars;
  const candidates=items.filter(item=>scopeKind==='candidate'?item.kind==='memory_candidate':item.kind==='memory'&&item.scopeKind===scopeKind);
  for(const {item,relevance_score} of candidates.length&&tokens.length?rankMemories(candidates.map(item=>({item,text:item.text,memory_id:item.id,confidence:0,valid_at:null})),tokens,candidates.length):[]){
   const size=Array.from(item.text).length;
   if(relevance_score<RELEVANCE_THRESHOLD||count>=maxCount||chars+size>maxChars)continue;
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
