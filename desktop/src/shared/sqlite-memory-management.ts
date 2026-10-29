import type {MemoryCandidateView,MemoryDecisionRequest,MemoryDecisionResult,MemoryManagementView,MemoryScope,MemoryVersionView,MemoryView} from '../../../backend-ts/src/memory/sqlite/management/contracts';
export type {MemoryCandidateView,MemoryDecisionRequest,MemoryDecisionResult,MemoryManagementView,MemoryScope,MemorySource,MemoryVersionView,MemoryView} from '../../../backend-ts/src/memory/sqlite/management/contracts';
/** 核验状态与用户采纳方式分别展示；可查看原话不代表来源已核验。 */
export type MemoryVerificationState=MemoryCandidateView['verificationState'];
export type MemoryMergeParent=MemoryVersionView['mergeParents'][number];
/** 撤回资料只能借具备有效来源的最新历史版调整保护，不赋予单独恢复或编辑能力。 */
export function withdrawnProtectionVersion(memory:MemoryView):MemoryVersionView|null{
 if(memory.state!=='withdrawn'||memory.current!==null)return null;
 return memory.versions.filter(v=>v.body!==null&&v.contentState==='present'&&v.provenanceState==='eligible').reduce<MemoryVersionView|null>((latest,v)=>latest===null||BigInt(v.versionNo)>BigInt(latest.versionNo)?v:latest,null);
}
/** 页面范围仍跟随顶部联系人；本人资料按完整贡献与来源双重复验，不以语义引句推断任务范围。 */
export interface MemoryManagementRead {scope:MemoryScope;displayContactId:string;scopeRevision:number}
export interface MemoryManagementSnapshot {connectionGeneration:number;scope:MemoryScope;view:MemoryManagementView}
export type MemoryDocumentsStatus='idle'|'processing'|'conflict'|'needs_revalidation'|'completed';
export interface MemoryDocumentReference {memoryId:string;versionNo:number;level:'owner'|'contact';provenanceKind:'manual_entry'|'source_supported';memoryText:string}
export interface MemoryDocumentStatement {
 text:string;kind:'fact'|'inference'|'contradiction';basis:string|null;section:string|null;uncertainty:string|null;temporalStatus:string|null;
 leftClaim:string|null;rightClaim:string|null;resolutionState:'unresolved'|'resolved'|null;resolutionText:string|null;references:MemoryDocumentReference[];
}
export interface MemoryDocumentView extends MemoryScope {id:string;versionNo:string;kind:'scene'|'profile';title:string;statements:MemoryDocumentStatement[]}
export interface MemoryDocumentsView {status:MemoryDocumentsStatus;publication:{id:string;members:{documentId:string;versionNo:string}[]}|null;documents:MemoryDocumentView[]}
export interface MemoryDocumentsSnapshot {connectionGeneration:number;scope:MemoryScope;view:MemoryDocumentsView}
export interface MemoryManagementDecision extends MemoryManagementRead {connectionGeneration:number;request:MemoryDecisionRequest}
export type MemoryManagementOutcome = {status:'applied';result:MemoryDecisionResult}|{status:'conflict'|'source_stale'|'protected'|'unavailable'};
export interface SqliteMemoryManagementBridge {
 read(request:MemoryManagementRead):Promise<MemoryManagementSnapshot>;
 readDocuments(request:MemoryManagementRead):Promise<MemoryDocumentsSnapshot>;
 decide(request:MemoryManagementDecision):Promise<MemoryManagementOutcome>;
 release():Promise<void>;
 onInvalidated(listener:()=>void):()=>void;
}

/** 重复资料已完成裁决，但未由该候选生成正式版本。 */
export const memoryCandidateStates=['pending','adopted','rejected','duplicate'] as const;
