import type {SqliteStorage} from '../../../storage/sqlite/client.ts';
import type {MemoryDecisionRequest,MemoryDecisionResult,MemoryManagementView,MemoryScope} from './contracts.ts';
/** 不持有正文缓存；owner仅由已认证宿主构造，不接受页面指定。 */
export class SqliteMemoryManagement {
 private storage:SqliteStorage;readonly ownerId:string;
 constructor(storage:SqliteStorage,ownerId:string){this.storage=storage;this.ownerId=ownerId;}
 importRun(runId:string){return this.storage.execute<{candidateIds:string[]}>('memory.importRun',{ownerId:this.ownerId,runId});}
 read(scope:MemoryScope){return this.storage.execute<MemoryManagementView>('memory.read',{ownerId:this.ownerId,scope});}
 decide(request:MemoryDecisionRequest){return this.storage.execute<MemoryDecisionResult>('memory.applyDecision',{ownerId:this.ownerId,request});}
 /** 系统入口不开放给HTTP或Tool；仍从真实候选producer复验，不能传正文。 */
 automatic(request:{requestKey:string;action:'auto_accept'|'auto_update';candidateIds:string[];candidateRevisions:string[];memoryId?:string;expectedVersionNo?:string;expectedHeadRevision?:string}){return this.storage.execute<MemoryDecisionResult>('memory.applyAutomaticDecision',{ownerId:this.ownerId,request});}
}
