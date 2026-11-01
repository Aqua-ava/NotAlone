import {randomUUID} from 'node:crypto';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import type {SqliteStorage} from '../../storage/sqlite/client.ts';
import {ActiveHolders} from '../../storage/sqlite/deletion/holders.ts';
import type {HistoryClearChannelFactory,HistoryClearContactGateway} from './clear.ts';
import type {HistoryChannel,HistoryScope,HistorySupportReport} from './contracts.ts';
import {assertSupport,serializeSupport} from './actions.ts';
import {normalUseContinuity} from './continuity.ts';

export interface HistoryRecertifyView {
 contact_id:string;request_key:string|null;state:'none'|'running'|'completed'|'failed'|'interrupted';
 stage:'none'|'metadata'|'history'|'activation'|'completed';completed:boolean;failure_code:string|null;
 message_count:number;non_text_count:number;page_count:number;preserved_message_count:number;started_at:number|null;finished_at:number|null;
}
interface InternalView extends HistoryRecertifyView {id:string|null;goalState:string|null;goalFailure:string|null}
const fail=(code:string):never=>{throw new StorageFailure(code);};
export const projectRecertifyStatus=(value:HistoryRecertifyView):HistoryRecertifyView=>Object.fromEntries(
 ['contact_id','request_key','state','stage','completed','failure_code','message_count','non_text_count','page_count','preserved_message_count','started_at','finished_at'].map(key=>[key,value[key as keyof HistoryRecertifyView]])) as unknown as HistoryRecertifyView;

interface ActiveRecertify {
 id:string;contactId:string;requestKey:string;controller:AbortController;done:Promise<void>;finish:()=>void;
 workDone:Promise<void>;finishWork:()=>void;release?:()=>Promise<void>;channel?:HistoryChannel;channelClose?:Promise<void>;
 intentionalClose:boolean;prepared:boolean;finalized:boolean;stage:string;stopCode?:string;guardFailure?:string;
 lossWrite?:Promise<unknown>;lossError?:unknown;storageDisabled:boolean;error?:unknown;result?:HistoryRecertifyView;
}
/** 显式认证的持久接纳与后台执行分离，HTTP断开不撤销已接纳任务。 */
export class SqliteHistoryRecertifyService {
 private readonly active=new Map<string,ActiveRecertify>();
 private readonly admissions=new Map<string,Promise<void>>();
 private closed=false;
 private uncertainClose:unknown;
 private readonly initialized:Promise<unknown>;
 private readonly storage:SqliteStorage;
 private readonly contacts:HistoryClearContactGateway;
 private readonly createChannel:HistoryClearChannelFactory;
 private readonly holders:ActiveHolders;
 private readonly options:{stopHistory?:(id:string)=>Promise<void>;maxPages?:number};
 constructor(storage:SqliteStorage,contacts:HistoryClearContactGateway,createChannel:HistoryClearChannelFactory,
  holders:ActiveHolders=new ActiveHolders(),options:{stopHistory?:(id:string)=>Promise<void>;maxPages?:number}={}) {
  this.storage=storage;this.contacts=contacts;this.createChannel=createChannel;this.holders=holders;this.options=options;
  this.initialized=storage.execute('history.recertifyInterruptStale',{ownerId:contacts.ownerId,at:Date.now()});
 }
 private key(value:unknown):asserts value is string {if(typeof value!=='string'||!/^[A-Za-z0-9_.:@-]{1,200}$/.test(value))fail('history_request_invalid');}
 private read(contactId:string,requestKey?:string){return this.storage.execute<InternalView>('history.recertifyStatus',{ownerId:this.contacts.ownerId,contactId,...(requestKey?{requestKey}:{})});}
 async status(contactId:string,requestKey?:string):Promise<HistoryRecertifyView>{await this.initialized;if(requestKey!==undefined)this.key(requestKey);return projectRecertifyStatus(await this.read(contactId,requestKey));}
 private async inspect(channel:HistoryChannel,scope:HistoryScope,signal:AbortSignal):Promise<HistorySupportReport>{
  signal.throwIfAborted();await this.contacts.validate(scope.token);
  if(!channel.guardSession||!(channel.guardSession.loss instanceof Promise))fail('history_recertify_guard_required');
  const report=await channel.inspect(scope,signal);assertSupport(report);
  if(report.continuity!==normalUseContinuity||report.accountKey!==scope.accountKey||report.conversationKey!==scope.conversationKey||report.sourceGeneration!==scope.token.source_generation)fail('history_recertify_source_changed');
  await this.contacts.validate(scope.token);signal.throwIfAborted();return report;
 }
 private async serialized<T>(contactId:string,work:()=>Promise<T>):Promise<T>{
  const previous=this.admissions.get(contactId)??Promise.resolve();let unlock!:()=>void;
  const lock=new Promise<void>(resolve=>{unlock=resolve;});this.admissions.set(contactId,lock);
  await previous;try{return await work();}finally{unlock();if(this.admissions.get(contactId)===lock)this.admissions.delete(contactId);}
 }
 private closeChannel(job:ActiveRecertify):Promise<void>{return job.channelClose??=Promise.resolve().then(()=>job.channel?.close?.());}
 private stopJob(job:ActiveRecertify,code:string):void {
  if(job.finalized)return;job.stopCode??=code;job.intentionalClose=true;job.controller.abort();
  // 关闭结果由工作段统一等待，不把取消请求当作停读完成。
  void this.closeChannel(job).catch(()=>{});
 }
 private async persist(job:ActiveRecertify,name:string,input:unknown):Promise<void>{
  try{await this.storage.execute(name,input);}catch(error){job.storageDisabled=true;await this.storage.close();throw error;}
 }
 async admit(contactId:string,options:{requestKey:string;signal?:AbortSignal}):Promise<HistoryRecertifyView>{
  await this.initialized;this.key(options?.requestKey);
  return this.serialized(contactId,async()=>{
   if(this.closed)fail('history_closed');options.signal?.throwIfAborted();
   const prior=await this.read(contactId,options.requestKey);if(prior.state!=='none')return projectRecertifyStatus(prior);
   if(this.active.has(contactId))fail('history_recertify_already_running');
   const token=await this.contacts.eligibility(contactId);options.signal?.throwIfAborted();
   let finish!:()=>void,finishWork!:()=>void;
   const job:ActiveRecertify={id:randomUUID(),contactId,requestKey:options.requestKey,controller:new AbortController(),done:new Promise(resolve=>{finish=resolve;}),finish:()=>finish(),workDone:new Promise(resolve=>{finishWork=resolve;}),finishWork:()=>finishWork(),intentionalClose:false,prepared:false,finalized:false,stage:'metadata',storageDisabled:false};
   this.active.set(contactId,job);
   try{
    job.release=this.holders.register({key:`history:recertify_${job.id}`,ownerId:token.owner_id,contactId,coversAllSources:true,generation:BigInt(token.data_generation),close:async()=>{this.stopJob(job,'history_recertify_scope_changed');await this.closeChannel(job);await job.workDone;}});
    options.signal?.throwIfAborted();
    job.prepared=await this.storage.execute<boolean>('history.recertifyPrepare',{token,id:job.id,requestKey:job.requestKey,at:Date.now()});
    const initial=projectRecertifyStatus(await this.read(contactId,job.requestKey));
    if(!job.prepared){job.finishWork();await job.release();this.active.delete(contactId);job.finish();return initial;}
    // 接纳之后仅服务生命周期控制任务；旧reader排空属于后台工作。
    void this.run(job,token).catch(error=>{job.error=error;}).finally(()=>{if(this.active.get(contactId)===job)this.active.delete(contactId);job.finish();});
    return initial;
   }catch(error){
    try{if(job.prepared)await this.persist(job,'history.recertifyFail',{ownerId:this.contacts.ownerId,id:job.id,code:'history_recertify_failed',stage:job.stage,at:Date.now()});}
    finally{job.finishWork();try{await job.release?.();}finally{this.active.delete(contactId);job.finish();}}
    throw error;
   }
  });
 }
 /** 本地测试及内部等待入口；HTTP只调用admit。 */
 async recertify(contactId:string,options:{requestKey:string;signal?:AbortSignal}):Promise<HistoryRecertifyView>{
  const admitted=await this.admit(contactId,options),job=this.active.get(contactId);
  if(job?.requestKey!==options.requestKey)return admitted;
  await job.done;if(job.error)throw job.error;return job.result??admitted;
 }
 async cancel(contactId:string,options:{requestKey:string}):Promise<HistoryRecertifyView>{
  await this.initialized;this.key(options?.requestKey);
  await this.storage.execute('history.recertifyCancel',{ownerId:this.contacts.ownerId,contactId,requestKey:options.requestKey,at:Date.now()});
  const job=this.active.get(contactId);if(job?.requestKey===options.requestKey)this.stopJob(job,'history_recertify_cancelled');
  return projectRecertifyStatus(await this.read(contactId,options.requestKey));
 }
 private async run(job:ActiveRecertify,token:HistoryScope['token']):Promise<void>{
  const signal=job.controller.signal;let failure:unknown;
  try{
   signal.throwIfAborted();await this.options.stopHistory?.(job.contactId);signal.throwIfAborted();
   const oldScope=await this.storage.execute<HistoryScope>('history.scope',{token});
   job.channel=this.createChannel();job.channelClose=undefined;
   const preview=await this.inspect(job.channel,oldScope,signal),previewTarget=await job.channel.target(oldScope,signal);
   await this.closeChannel(job);job.channel=undefined;job.channelClose=undefined;signal.throwIfAborted();
   await this.storage.execute('history.recertifyRotate',{token,id:job.id,target:previewTarget,report:preview,bindingId:randomUUID(),verificationId:randomUUID(),grantId:randomUUID(),at:Date.now()});
   const current=await this.contacts.eligibility(job.contactId),scope=await this.storage.execute<HistoryScope>('history.scope',{token:current});
   signal.throwIfAborted();job.channel=this.createChannel();job.channelClose=undefined;const actual=job.channel,guardId=randomUUID();
   const lost=()=>{if(job.intentionalClose||job.finalized)return;job.guardFailure=actual.guardSession?.failureCode?.()??'history_source_continuity_unverified';job.controller.abort();
    job.lossWrite=this.persist(job,'history.recertifyNoteFailure',{ownerId:this.contacts.ownerId,id:job.id,code:job.guardFailure,at:Date.now()}).catch(error=>{job.lossError=error;});};
   actual.guardSession?.loss.then(lost,lost);
   const report=await this.inspect(actual,scope,signal),target=await actual.target(scope,signal);
   if(serializeSupport(report)!==serializeSupport(preview))fail('history_recertify_source_changed');
   const checkpoint=async()=>{await this.contacts.validate(current);signal.throwIfAborted();if(job.guardFailure)fail(job.guardFailure);};
   await checkpoint();await this.storage.execute('history.recertifyGuard',{token:current,id:job.id,target,report,guardId,at:Date.now()});job.stage='history';
   const goal=await this.storage.execute<{id:string}>('history.begin',{token:current,id:randomUUID(),target,report,guardId,recertifyId:job.id,at:Date.now()});
   await this.storage.execute('history.recertifyAttach',{token:current,id:job.id,guardId,goalId:goal.id,at:Date.now()});
   let cursor:string|null=null,complete=false;
   for(let pageNo=0;pageNo<(this.options.maxPages??10000);pageNo++){
    await checkpoint();const page=await actual.page(scope,target,cursor,signal);await checkpoint();
    await this.storage.execute('history.acceptPage',{token:current,goalId:goal.id,page,captureId:randomUUID(),runtimeToken:guardId,guardId,recertifyId:job.id,at:Date.now()});
    if(page.exhausted){const status=await this.read(job.contactId,job.requestKey);if(status.goalState!=='complete')fail(status.goalFailure??'history_recertify_incomplete');complete=true;break;}cursor=page.cursorOut;
   }
   if(!complete)fail('history_recertify_page_limit');
   const finalReport=await this.inspect(actual,scope,signal);if(serializeSupport(finalReport)!==serializeSupport(report))fail('history_support_changed');await checkpoint();job.stage='activation';
   await this.storage.execute('history.recertifyActivate',{token:current,id:job.id,guardId,target,at:Date.now()});await checkpoint();
   if(!await this.storage.execute('history.guardRelease',{token:current,guardId,normalUse:true,sourceLost:false}))fail('history_source_continuity_unverified');
   await checkpoint();job.intentionalClose=true;await this.closeChannel(job);const closeCode=actual.guardSession?.failureCode?.();if(closeCode&&closeCode!=='history_native_closed')fail(closeCode);await job.lossWrite;if(job.lossError)throw job.lossError;await checkpoint();
   await this.storage.execute('history.recertifyFinalize',{token:current,id:job.id,guardId,at:Date.now()});job.finalized=true;
  }catch(error){failure=error;}
  finally{
   job.intentionalClose=true;
   try{
    // 异步读者只在真正停读以后看到失败/中断；不开放任何暂存页。
    try{await this.closeChannel(job);}catch(error){failure??=error;this.uncertainClose=error;job.storageDisabled=true;await this.storage.close();throw error;}
    await job.lossWrite;if(job.lossError)throw job.lossError;
    if(failure&&!job.finalized){const code=job.stopCode??job.guardFailure??(failure instanceof StorageFailure?failure.code:signal.aborted?'history_recertify_interrupted':'history_recertify_failed');
     await this.persist(job,'history.recertifyFail',{ownerId:this.contacts.ownerId,id:job.id,code,stage:job.stage,interrupted:Boolean(job.stopCode)||code==='history_recertify_interrupted'||code==='history_recertify_cancelled',at:Date.now()});}
    if(!job.storageDisabled)job.result=projectRecertifyStatus(await this.read(job.contactId,job.requestKey));
   }finally{job.finishWork();await job.release?.();}
  }
 }
 async stop(contactId?:string){const jobs=[...this.active.values()].filter(job=>!contactId||job.contactId===contactId);for(const job of jobs)this.stopJob(job,'history_recertify_interrupted');await Promise.all(jobs.map(job=>job.done));if(this.uncertainClose)throw this.uncertainClose;}
 async close(){this.closed=true;await Promise.all([...this.admissions.values()]);await this.stop();await this.initialized;}
}
