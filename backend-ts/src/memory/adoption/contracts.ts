/** SQLite记忆裁决与DSH适配共用的纯数据合同。 */
import type {ExtractedFact,MemoryConditions,MemoryEvent} from '../extraction/protocol.ts';
import type {ContentEvidence,ContentSource} from '../content/evidence.ts';
export type {ContentEvidence} from '../content/evidence.ts';

export type AdoptionAction='add'|'update'|'noop'|'keep'|'merge';
export type EvolutionKind='supplement'|'state_change'|'error_correction'|'historical_supplement'|'unresolved_conflict'|'independent';
export interface AdoptionFact extends ExtractedFact {
 dimension_evidence:Record<string,unknown>|null;
 verified_source_receipt:readonly [string,string,'any'|'all',boolean]|null;
}
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
 evidence:ContentEvidence[];
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
 evidence:ContentEvidence[];
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
 evidence:ContentEvidence[];
 usage?:ModelUsage|null;
}
/** 内容模块统一提供真实文字或视觉来源，原生消息类型不影响裁决流程。 */
export type AdjudicationSource=ContentSource;
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
