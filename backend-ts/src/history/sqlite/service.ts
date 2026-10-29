import { ActiveHolders } from '../../storage/sqlite/deletion/holders.ts';
import { randomUUID } from 'node:crypto';
import { StorageFailure } from '../../storage/sqlite/contracts.ts';
import type { SqliteStorage } from '../../storage/sqlite/client.ts';
import type { SqliteContactService } from '../../contacts/sqlite/service.ts';
import type { HistoryChannel, HistorySource, HistoryCoverage, HistoryRead, HistoryScope, HistoryTarget, HistorySupportReport } from './contracts.ts';
import { assertSupport, serializeSupport } from './actions.ts';
interface PendingGoal { id:string; target:HistoryTarget; cursor:string|null }
/** 渠道I/O始终在事务外；每次读取前后与原子接收时分别复验当前资格。 */
export class SqliteHistoryService {
 private readonly storage:SqliteStorage;
 private readonly contacts:SqliteContactService;
 private readonly channel:HistoryChannel;
 readonly holders:ActiveHolders;
 private readonly active=new Map<string,{controller:AbortController;done:Promise<void>}>();
 private closed=false;
 constructor(storage:SqliteStorage,contacts:SqliteContactService,channel:HistoryChannel,holders:ActiveHolders=new ActiveHolders()){this.storage=storage;this.contacts=contacts;this.channel=channel;this.holders=holders;}
 private async scope(contactId:string):Promise<HistoryScope>{
  if(this.closed)throw new StorageFailure('history_closed');
  const token=await this.contacts.eligibility(contactId);
  return this.storage.execute('history.scope',{token});
 }
 async support(contactId:string):Promise<HistorySupportReport>{const scope=await this.scope(contactId);const report=await this.channel.inspect(scope);await this.contacts.validate(scope.token);return report;}
 read(contactId:string,options:{limit?:number;before?:string}={}):Promise<HistoryRead>{
  if(this.closed)throw new StorageFailure('history_closed');
  return this.storage.execute('history.read',{ownerId:this.contacts.ownerId,contactId,limit:options.limit??101,before:options.before});
 }
 source(contactId:string,recordId:string):Promise<HistorySource>{return this.storage.execute('history.source',{ownerId:this.contacts.ownerId,contactId,recordId});}
 coverage(contactId:string):Promise<HistoryCoverage>{return this.storage.execute('history.coverage',{ownerId:this.contacts.ownerId,contactId});}
 async synchronize(contactId:string,signal?:AbortSignal):Promise<HistoryCoverage>{
  if(this.active.has(contactId))throw new StorageFailure('history_already_running');
  let finished!:()=>void;const done=new Promise<void>(resolve=>{finished=resolve;});
  let completed!:()=>void;const completion=new Promise<void>(resolve=>{completed=resolve;});
  const controller=new AbortController();this.active.set(contactId,{controller,done:completion});
  let release:(()=>Promise<void>)|undefined;
  const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  let scope:HistoryScope|undefined;let goal:PendingGoal|undefined;
  const check=async()=>{if(controller.signal.aborted||this.closed)throw new StorageFailure('history_interrupted');await this.contacts.validate(scope!.token);};
  try{
   scope=await this.scope(contactId);await check();
   const inspect=async()=>{
    const evidence=await this.channel.inspect(scope!,controller.signal);await check();assertSupport(evidence);
    if(evidence.accountKey!==scope!.accountKey||evidence.conversationKey!==scope!.conversationKey||evidence.sourceGeneration!==scope!.token.source_generation)throw new StorageFailure('history_external_scope_changed');
    return evidence;
   };
   const report=await inspect();
   goal=await this.storage.execute<PendingGoal|null>('history.pending',{token:scope.token,report})??undefined;
   if(!goal){const target=await this.channel.target(scope,controller.signal);await check();
    goal=await this.storage.execute('history.begin',{token:scope.token,target,report,id:randomUUID(),at:Date.now()});}
   release=this.holders.register({key:`history:${goal!.id}`,ownerId:scope.token.owner_id,contactId,generation:BigInt(scope.token.data_generation),close:async()=>{controller.abort();await done;}});
   // 有界处理；达到预算只留下可恢复缺口，不能把部分页数当作完整。
   for(let index=0;index<1000;index++){
    await check();const page=await this.channel.page(scope,goal!.target,goal!.cursor,controller.signal);await check();
    if(serializeSupport(await inspect())!==serializeSupport(report))throw new StorageFailure('history_support_changed');
    const coverage=await this.storage.execute<HistoryCoverage>('history.acceptPage',{token:scope.token,goalId:goal!.id,captureId:randomUUID(),page,at:Date.now(),runtimeToken:this.storage.status.runtimeId});
    if(page.exhausted)return coverage;goal!.cursor=page.cursorOut;
   }
   return await this.storage.execute('history.interrupt',{token:scope.token,goalId:goal!.id,code:'history_page_budget_exhausted'});
  }catch(error){
   if(scope&&goal){try{await this.storage.execute('history.interrupt',{token:scope.token,goalId:goal.id,code:error instanceof StorageFailure?error.code:'history_read_interrupted'});}catch{/* 旧资格不允许推进覆盖；原事务已保留缺口。 */}}
   throw error;
  }finally{finished();try{if(release)await release();}finally{this.active.delete(contactId);signal?.removeEventListener('abort',abort);completed();}}
 }
 async stop(contactId?:string):Promise<void>{const entries=[...this.active.entries()].filter(([id])=>!contactId||id===contactId).map(([,entry])=>entry);for(const entry of entries)entry.controller.abort();await Promise.all(entries.map(entry=>entry.done));}
 async close():Promise<void>{this.closed=true;for(const entry of this.active.values())entry.controller.abort();await this.channel.close?.();await Promise.all([...this.active.values()].map(entry=>entry.done));}
}
