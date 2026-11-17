import type {ReplyKnowledgeHeader,ReplyKnowledgeItem} from './contracts.ts';

/** L2/L3 使用各自容量；正式记忆额度由 REPLY_SEARCH_BUDGET 决定并按整轮剩余额度传入。 */
export const REPLY_DOCUMENT_BUDGET={directoryCount:12,directoryChars:1600,profileCount:8,profileChars:1200,documentReadCount:2,documentBlocks:3,documentChars:1800} as const;
export interface ReplyMemorySource {
 memories:readonly ReplyKnowledgeHeader[];
 open(header:ReplyKnowledgeHeader):ReplyKnowledgeItem|null;
}
export interface ReplyMemoryBudget {contact:number;owner:number}

/** 只消费共享检索给出的精确版本和顺序；失效项不占预算，不重排或回退到另一套相关性规则。 */
export function selectRankedReplyMemories(source:ReplyMemorySource,ranked:readonly {id:string;versionNo:bigint}[],budget:ReplyMemoryBudget):ReplyKnowledgeItem[]{
 const byId=new Map(source.memories.filter(item=>item.kind==='memory').map(item=>[item.id,item]));
 const seen=new Set<string>(),remaining={...budget},selected:ReplyKnowledgeItem[]=[];
 for(const anchor of ranked){
  const item=byId.get(anchor.id);
  if(!item||item.versionNo!==anchor.versionNo||seen.has(item.id))continue;
  seen.add(item.id);
  if(remaining[item.scopeKind]<=0)continue;
  const opened=source.open(item);if(!opened)continue;
  selected.push(opened);remaining[item.scopeKind]--;
 }
 return selected;
}

/** 初始输入只挑选完整文档投影；目录和长期背景各自计量，不引入记忆或待确认候选。 */
export function selectReplyDocuments(documents:readonly ReplyKnowledgeItem[]):ReplyKnowledgeItem[]{
 const selected:ReplyKnowledgeItem[]=[];
 let directoryChars=0,directoryCount=0,profileChars=0;
 for(const item of documents){
  if(item.kind!=='document')continue;
  const size=Array.from(item.text).length;
  if(item.projection?.kind==='directory'){
   if(directoryCount>=REPLY_DOCUMENT_BUDGET.directoryCount||directoryChars+size>REPLY_DOCUMENT_BUDGET.directoryChars)continue;
   directoryCount++;directoryChars+=size;
  }else{
   if(profileChars+size>REPLY_DOCUMENT_BUDGET.profileChars)continue;
   profileChars+=size;
  }
  selected.push(item);
 }
 return selected;
}
