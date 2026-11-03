import type {StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import type {DiscussionScope} from '../contracts.ts';
export interface ReplySource {contactId:string;messageId:string;recordId:string;acceptedRevision:bigint}
/** 08/09只读消费者合同；读取及复验均在短事务内，不接受页面提供正文或资格。 */
export interface ReplyKnowledgeItem {
 kind:'memory'|'memory_candidate'|'document';id:string;versionNo:bigint;
 scopeKind:'owner'|'contact';contactId:string|null;publicationId:string|null;
 text:string;qualification:'confirmed'|'auto'|'unconfirmed'|'published';sources:ReplySource[];
}
export interface ReplyKnowledgeReader {
 read(tx:StorageTransaction,scope:DiscussionScope):ReplyKnowledgeItem[];
 /** 核验精确版本、来源、保护修订及发布成员，不以替换来源延续旧证明。 */
 requireFrozen?(tx:StorageTransaction,scope:DiscussionScope,item:ReplyKnowledgeItem):void;
 requireCurrent(tx:StorageTransaction,scope:DiscussionScope,item:ReplyKnowledgeItem):void;
}
export const emptyReplyKnowledge:ReplyKnowledgeReader={read:()=>[],requireCurrent(){throw new Error('reply_knowledge_unavailable');}};
export interface ReplyCandidateVersion {
 candidateId:string;versionNo:number;origin:'model'|'manual';parentVersionNo:number|null;
 parts:string[];basis:{itemNo:number;kind:string;text:string;verification:'actual_input'|'inherited_unverified'}[];
}
export interface ReplyCandidateView extends DiscussionScope {
 requestId:string;coverageWarning:string|null;candidates:ReplyCandidateVersion[];
 selections:{id:string;candidateId:string;versionNo:number;selectionNo:number}[];
}
export type ReplyGenerationPhase='not_found'|'preparing'|'queued'|'generating'|'saving'|'committed'|'failed'|'unknown';
export interface ReplyGenerationStatus {
 requestKey:string;phase:ReplyGenerationPhase;sent:boolean;errorCode:string|null;retryable:boolean;startedAt:number|null;finishedAt:number|null;
}
