export interface MemoryScope {scopeKind:'self'|'contact';contactId:string|null}
export interface MemorySource {contactId:string;messageId:string;recordId:string;acceptedRevision:string;quote:string}
export interface MemoryDecisionRequest {
 requestKey:string;action:'accept'|'edit_accept'|'reject'|'correct'|'change'|'restore'|'withdraw'|'protect'|'unprotect'|'manual';
 candidateIds?:string[];candidateRevisions?:string[];memoryId?:string;expectedVersionNo?:string;expectedHeadRevision?:string;
 restoredFromVersionNo?:string;body?:string;scope?:MemoryScope;
}
export interface MemoryCandidateView extends MemoryScope {id:string;body:string;state:string;stateRevision:string;eventId:string;sources:MemorySource[]}
export interface MemoryVersionView {versionNo:string;body:string|null;formationKind:string;adoptionMode:string;previousVersionNo:string|null;restoredFromVersionNo:string|null;contentState:string;provenanceState:string;decisionId:string;sources:MemorySource[]}
export interface MemoryView extends MemoryScope {id:string;headRevision:string;state:string;manualProtection:boolean;current:MemoryVersionView|null;versions:MemoryVersionView[];decisions:{id:string;action:string;actorKind:string;createdAt:string;expectedHeadRevision:string|null;expectedVersionNo:string|null;outcome:string}[]}
export interface MemoryManagementView {candidates:MemoryCandidateView[];memories:MemoryView[]}
export interface MemoryDecisionResult {decisionId:string;memoryId:string|null;versionNo:string|null;action:string}
