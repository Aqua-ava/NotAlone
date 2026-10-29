import type {MemoryDecisionRequest,MemoryDecisionResult,MemoryManagementView,MemoryScope} from '../../../backend-ts/src/memory/sqlite/management/contracts';
export type {MemoryCandidateView,MemoryDecisionRequest,MemoryDecisionResult,MemoryManagementView,MemoryScope,MemorySource,MemoryVersionView,MemoryView} from '../../../backend-ts/src/memory/sqlite/management/contracts';
/** 页面范围仍跟随顶部联系人；本人资料按完整贡献与来源双重复验，不以语义引句推断任务范围。 */
export interface MemoryManagementRead {scope:MemoryScope;displayContactId:string;scopeRevision:number}
export interface MemoryManagementSnapshot {connectionGeneration:number;scope:MemoryScope;view:MemoryManagementView}
export interface MemoryManagementDecision extends MemoryManagementRead {connectionGeneration:number;request:MemoryDecisionRequest}
export type MemoryManagementOutcome = {status:'applied';result:MemoryDecisionResult}|{status:'conflict'|'source_stale'|'protected'|'unavailable'};
export interface SqliteMemoryManagementBridge {
 read(request:MemoryManagementRead):Promise<MemoryManagementSnapshot>;
 decide(request:MemoryManagementDecision):Promise<MemoryManagementOutcome>;
 release():Promise<void>;
 onInvalidated(listener:()=>void):()=>void;
}
