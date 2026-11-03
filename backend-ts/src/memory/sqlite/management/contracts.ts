import type {MemoryTimeEligibility} from './temporal.ts';
export interface MemoryScope {scopeKind:'self'|'contact';contactId:string|null}
// sentAt 沿用来源消息的 epoch 毫秒；timePrecision 表示来源精度，不是事件发生时间。
export interface MemorySource {contactId:string;messageId:string;recordId:string;acceptedRevision:string;sentAt:string|null;timePrecision:'second'|'millisecond'|null;quote:string;contentKind?:'image';contentRef?:{file_id:string;sha256:string;mime_type:string;media_generation:string};description?:string}
export interface MergedParentSnapshot {memoryId:string;versionNo:string;headRevision:string}
export interface MemoryDecisionRequest {
 requestKey:string;action:'accept'|'edit_accept'|'reject'|'correct'|'change'|'restore'|'withdraw'|'protect'|'unprotect'|'manual';
 candidateIds?:string[];candidateRevisions?:string[];memoryId?:string;expectedVersionNo?:string;expectedHeadRevision?:string;
 restoredFromVersionNo?:string;expectedMergedParents?:MergedParentSnapshot[];body?:string;scope?:MemoryScope;
}
export interface MemoryCandidateView extends MemoryScope {verificationState:'verified'|'pending';id:string;body:string;state:'pending'|'adopted'|'rejected'|'duplicate';stateRevision:string;eventId:string;contributingContactIds:string[];sources:MemorySource[]}
export interface MemoryVersionView {timeStatus:MemoryTimeEligibility;mergeParents:MergedParentSnapshot[];mergeParentCount:number;verificationState:'verified'|'pending';versionNo:string;body:string|null;formationKind:string;adoptionMode:string;previousVersionNo:string|null;restoredFromVersionNo:string|null;contentState:string;provenanceState:string;decisionId:string;contributingContactIds:string[];sources:MemorySource[]}
export interface MemoryView extends MemoryScope {id:string;headRevision:string;state:string;manualProtection:boolean;current:MemoryVersionView|null;versions:MemoryVersionView[];decisions:{id:string;action:string;actorKind:string;createdAt:string;expectedHeadRevision:string|null;expectedVersionNo:string|null;outcome:string}[]}
export interface MemoryManagementView {candidates:MemoryCandidateView[];memories:MemoryView[]}
export interface MemoryDecisionResult {decisionId:string;memoryId:string|null;versionNo:string|null;action:string}
