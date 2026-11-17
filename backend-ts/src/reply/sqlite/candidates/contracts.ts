import type {StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import type {DiscussionScope} from '../contracts.ts';
import type {InputMaterialMetadata} from './input-material-metadata.ts';
export interface ReplySource {contactId:string;messageId:string;recordId:string;acceptedRevision:bigint}
/** 08/09只读消费者合同；读取及复验均在短事务内，不接受页面提供正文或资格。 */
export interface ReplyKnowledgeItem {
 kind:'memory'|'memory_candidate'|'document';id:string;versionNo:bigint;
 scopeKind:'owner'|'contact';contactId:string|null;publicationId:string|null;
 projection?:{kind:'directory';blockCount:number}|{kind:'profile';statementNos:number[]}|{kind:'blocks';startBlock:number;blockCount:number};
 text:string;qualification:'confirmed'|'auto'|'unconfirmed'|'published';sources:ReplySource[];
}
/** 排序所需的低成本字段：正文、版本、范围与资格类型；不含来源，也未核验来源资格。 */
export type ReplyKnowledgeHeader=Pick<ReplyKnowledgeItem,'kind'|'id'|'versionNo'|'scopeKind'|'contactId'|'text'|'qualification'>;
export interface ReplyKnowledgeValidation {
 /** 核验精确版本、来源、保护修订及发布成员，不以替换来源延续旧证明。 */
 requireFrozen?(tx:StorageTransaction,scope:DiscussionScope,item:ReplyKnowledgeItem):void;
 requireCurrent(tx:StorageTransaction,scope:DiscussionScope,item:ReplyKnowledgeItem):void;
 /** 仅共享本次调用内的完整集合资格，仍逐条复验投影；结果不缓存到下一次调用。 */
 requireCurrentBatch?(tx:StorageTransaction,scope:DiscussionScope,items:readonly ReplyKnowledgeItem[]):void;
 requireFrozenBatch?(tx:StorageTransaction,scope:DiscussionScope,items:readonly ReplyKnowledgeItem[]):void;
}
export interface ReplyMemoryReader extends ReplyKnowledgeValidation {
 /** 只列出头部，尚未核验来源；正式检索始终在入选前按需物化，不退化为整池核验。 */
 list(tx:StorageTransaction,scope:DiscussionScope):ReplyKnowledgeHeader[];
 /** 核验并物化精确头部；资格已失效或版本已变则返回 null。 */
 open(tx:StorageTransaction,scope:DiscussionScope,header:ReplyKnowledgeHeader):ReplyKnowledgeItem|null;
}
export interface ReplyKnowledgeReader extends ReplyMemoryReader {
 /** 只读取当前发布集合的文档；初始材料不读取正式记忆或待确认候选。 */
 readDocuments(tx:StorageTransaction,scope:DiscussionScope):ReplyKnowledgeItem[];
 readDocument?(tx:StorageTransaction,scope:DiscussionScope,item:ReplyKnowledgeItem,range:{startBlock:number;blockCount:number}):ReplyKnowledgeItem;
}
export const emptyReplyKnowledge:ReplyKnowledgeReader={list:()=>[],open:()=>null,readDocuments:()=>[],requireCurrent(){throw new Error('reply_knowledge_unavailable');}};
export interface ReplyCandidateVersion {
 candidateId:string;versionNo:number;origin:'model'|'manual';parentVersionNo:number|null;
 parts:string[];basis:({itemNo:number;kind:string;text:string;verification:'actual_input'|'inherited_unverified'}&InputMaterialMetadata)[];
}
export interface ReplyCandidateView extends DiscussionScope {
 requestId:string;coverageWarning:string|null;candidates:ReplyCandidateVersion[];
 selections:{id:string;candidateId:string;versionNo:number;selectionNo:number}[];
}
export type ReplyGenerationPhase='not_found'|'preparing'|'queued'|'generating'|'saving'|'committed'|'failed'|'unknown';
export interface ReplyGenerationStatus {
 requestKey:string;phase:ReplyGenerationPhase;sent:boolean;/** 已发出但未收到结果、被本机自动放弃的未知调用（ADR-183）；已收到响应的失败不属于此类。 */abandoned:boolean;errorCode:string|null;retryable:boolean;startedAt:number|null;finishedAt:number|null;
}
