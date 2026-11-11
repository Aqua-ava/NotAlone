/** SQLite记忆裁决与DSH适配共用的纯数据合同。 */
import type {ExtractedFact,MemoryConditions,MemoryEvent} from '../extraction/protocol.ts';

export type AdoptionAction='add'|'update'|'noop'|'keep'|'merge';
export type EvolutionKind='supplement'|'state_change'|'error_correction'|'historical_supplement'|'unresolved_conflict'|'independent';
export interface AdoptionScope {owner_id:string;contact_id:string}
export interface AdoptionFact extends ExtractedFact {
 dimension_evidence:Record<string,unknown>|null;
 verified_source_receipt:readonly [string,string,'any'|'all',boolean]|null;
}
export interface AdoptionFactInput {fact:AdoptionFact;candidate_trace_id?:string|null}
export interface ModelUsage {
 call_id?:string|null;
 model_name?:string|null;
 input_tokens?:number|null;
 output_tokens?:number|null;
 purpose?:'adjudication'|'relation_verification'|'merge_verification';
}
export interface AdjudicationRelation {
 kind:EvolutionKind;
 related_memory_ids:string[];
 explanation:string;
 evidence:{message_id:string;quote:string}[];
 claim_changed:boolean;
 condition_changed:boolean;
}
export interface AdjudicationDecision {
 candidate_index:number;
 action:AdoptionAction;
 replaced_memory_id?:string|null;
 merged_memory_ids?:string[];
 merged_text?:string|null;
 duplicate_memory_id?:string|null;
 relation?:AdjudicationRelation|null;
 usage?:ModelUsage|null;
}
export interface RelationVerification {
 candidate_index:number;
 supported:boolean;
 source_receipt:string;
 evidence:{message_id:string;quote:string}[];
 claim_changed:boolean;
 condition_changed:boolean;
 usage?:ModelUsage|null;
}
export interface MergeVerification {
 candidate_index:number;
 supported:boolean;
 text:string;
 source_message_ids:string[];
 source_receipt:string;
 evidence:{message_id:string;quote:string}[];
 usage?:ModelUsage|null;
}
/** 图片描述是已经核验的观察记录，不是可作逐字引文的聊天原文。 */
export interface AdjudicationSource {
 message_id:string;text:string|null;occurred_at:string|null;
 content_kind?:'image';
 content_ref?:{file_id:string;sha256:string;mime_type:string;media_generation:string};
 observation?:{kind:'model_observation';text:string};
}
export interface SimilarMemory {
 memory_id:string;
 revision:number|string;
 text:string;
 category:string;
 topic:string;
 subject:string;
 adoption_method:'auto'|'manual';
 source_message_ids:string[];
 source_texts:AdjudicationSource[];
 statement_time:string|null;
 valid_at:string|null;
 invalid_at:string|null;
 event:MemoryEvent|null;
 conditions:MemoryConditions|null;
 source_receipt:string|null;
 source_dependency_mode:'any'|'all';
 requires_all_sources:boolean;
}
export interface AdjudicationItem {
 candidate_index:number;
 candidate:AdoptionFact;
 candidate_source_receipt:string;
 candidate_source_texts:AdjudicationSource[];
 relation_source_receipt:string;
 similar:SimilarMemory[];
}
export interface AdjudicationRuntime {
 adjudicate(items:readonly AdjudicationItem[],signal:AbortSignal):Promise<readonly AdjudicationDecision[]>;
 verifyRelations(items:readonly AdjudicationItem[],decisions:readonly AdjudicationDecision[],signal:AbortSignal):Promise<readonly RelationVerification[]>;
 verifyMerge(item:AdjudicationItem,decision:AdjudicationDecision,source_ids:readonly string[],source_receipt:string,signal:AbortSignal):Promise<MergeVerification>;
}
export interface AdoptionBatchInput {
 contact_id:string;
 trace_id?:string|null;
 batch_key?:string|null;
 facts:readonly AdoptionFactInput[];
 signal:AbortSignal;
}
export type AdoptionDisposition='adopted'|'updated'|'merged'|'pending'|'skipped_duplicate'|'skipped_deleted'|'skipped_noop'|'failed';
export interface AdoptionResult {
 candidate_index:number;
 disposition:AdoptionDisposition;
 candidate_id:string|null;
 memory_id:string|null;
 parent_memory_ids:string[];
 decision:AdoptionAction|null;
 reason:string|null;
}
export interface AdoptionStats {
 adopted:number;
 updated:number;
 merged:number;
 pending:number;
 skipped_duplicate:number;
 skipped_deleted:number;
 skipped_noop:number;
 failed:number;
 results:AdoptionResult[];
 usages:ModelUsage[];
}
