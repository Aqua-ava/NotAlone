import type {SqliteStorage} from '../../../storage/sqlite/client.ts';
import {StorageFailure} from '../../../storage/sqlite/contracts.ts';
import type {MemoryDecisionRequest,MemoryDecisionResult,MemoryManagementView,MemoryScope,MemoryManagementQuery,MemoryHistoryView} from './contracts.ts';
/** 不持有正文缓存；owner仅由已认证宿主构造，不接受页面指定。 */
export class SqliteMemoryManagement {
 private storage:SqliteStorage;readonly ownerId:string;
 constructor(storage:SqliteStorage,ownerId:string){this.storage=storage;this.ownerId=ownerId;}
 importRun(runId:string){return this.storage.execute<{candidateIds:string[]}>('memory.importRun',{ownerId:this.ownerId,runId});}
 publishRun(runId:string){return this.storage.execute<{candidateIds:string[];decisions:MemoryDecisionResult[]}>('memory.publishRun',{ownerId:this.ownerId,runId});}
 async read(scope:MemoryScope,query:MemoryManagementQuery={},options:{signal?:AbortSignal}={}){
  const current=()=>{if(options.signal?.aborted)throw new StorageFailure('memory_read_cancelled');};current();
  if(query.memoryId===undefined&&query.candidateId===undefined){
   const deadline=Date.now()+2000;
   do{
    const progress=await this.storage.execute<{ready:boolean}>('memory.prepareTimeline',{ownerId:this.ownerId,scope});current();
    if(progress.ready)break;
   }while(Date.now()<deadline);
  }
  current();return this.storage.execute<MemoryManagementView>('memory.read',{ownerId:this.ownerId,scope,...query});
 }
 readHistory(scope:MemoryScope,memoryId:string,query:Pick<MemoryManagementQuery,'cursor'|'displayContactId'>={}){return this.storage.execute<MemoryHistoryView>('memory.history',{ownerId:this.ownerId,scope,memoryId,...query});}
 decide(request:MemoryDecisionRequest){return this.storage.execute<MemoryDecisionResult>('memory.applyDecision',{ownerId:this.ownerId,request});}
 /** 系统入口不开放给HTTP或Tool；仍从真实候选producer复验，不能传正文。 */
 automatic(request:{requestKey:string;action:'auto_accept'|'auto_update';candidateIds:string[];candidateRevisions:string[];memoryId?:string;expectedVersionNo?:string;expectedHeadRevision?:string}){return this.storage.execute<MemoryDecisionResult>('memory.applyAutomaticDecision',{ownerId:this.ownerId,request});}
}
