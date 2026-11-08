import type {SourceRecoveryPlan} from './source-recovery.ts';
import type {HistoryRecoveryResult} from './contracts.ts';
import type {SharedWechatClient} from '../wechat/shared-client.ts';
import { ActiveHolders } from '../../storage/sqlite/deletion/holders.ts';
import { randomUUID } from 'node:crypto';
import { StorageFailure } from '../../storage/sqlite/contracts.ts';
import type { SqliteStorage } from '../../storage/sqlite/client.ts';
import type { ReadEligibility } from '../../contacts/sqlite/contracts.ts';
import type { HistoryChannel, HistorySource, HistoryCoverage, HistoryImageMedia, HistoryRead, HistoryScope, HistoryTarget, HistorySupportReport, HistoryPage, HistoryTailPage } from './contracts.ts';
import { assertSupport, serializeSupport } from './actions.ts';
import { isSourceContinuityLost, normalUseContinuity } from './continuity.ts';
import { isPartitionGrowthTargetChange } from '../partition-growth.ts';
import {SqliteQuoteStore,quoteParserVersion} from './quote-store.ts';
export {quoteParserVersion};
// 只用于进程内调度，不进入覆盖状态的 JSON，也不覆盖真实隔离原因。
export const resumableHistorySlice=Symbol('resumable-history-slice');
type HistorySynchronization=HistoryCoverage&{[resumableHistorySlice]?:true};
interface PendingGoal { id:string; target:HistoryTarget; cursor:string|null }
export interface HistoryContactGateway {
 readonly ownerId:string;
 eligibility(contactId:string):Promise<ReadEligibility>;
 validate(token:ReadEligibility):Promise<unknown>;
}
interface ActiveHistoryRead { done:Promise<void>; stop():Promise<void> }
interface GuardProof {report:HistorySupportReport;target:HistoryTarget}
interface GuardResult {guardId?:string;revalidated:boolean}
interface RetainedEntry {channel:HistoryChannel;contactId:string;token:ReadEligibility;digest:string;parked:boolean;failed:boolean;normalUse:boolean;bodyVerified:boolean;
 report?:HistorySupportReport;target?:HistoryTarget;guardId?:string;sourceLost?:boolean;deferVerification?:boolean;holderRelease?:()=>Promise<void>;releaseFailed?:boolean;storageClosed?:boolean;releaseError?:unknown;failedCode?:string|null;close:()=>Promise<void>}
type MessageChangeKind='created'|'updated';
type AcceptedPage=HistoryCoverage&{createdMessageIds?:string[];updatedMessageIds?:string[]};
const bodyCapabilities=['programVersion','exactSchema','declaredLocalKey','automaticAllocation','statusColumn','statusSemantics','sourceLifecycle','restartContinuity','recoveryMapping','snapshotBarrier','partitionCoverage','normalHistory','incrementalTail'] as const;
const recoverableGuardFailures=new Set(['history_native_timeout','history_native_unavailable','history_source_unverified','history_native_cancelled','history_snapshot_closed','history_snapshot_unavailable','history_snapshot_window_changed']);
function waitForSourceReader(done:Promise<void>,signal:AbortSignal,remaining:number):Promise<void>{
 if(signal.aborted)return Promise.reject(new StorageFailure('history_native_cancelled'));
 if(remaining<=0)return Promise.reject(new StorageFailure('history_native_timeout'));
 return new Promise((resolve,reject)=>{
  const finish=(error?:unknown)=>{clearTimeout(timer);signal.removeEventListener('abort',abort);if(error)reject(error);else resolve();};
  const abort=()=>finish(new StorageFailure('history_native_cancelled'));
  const timer=setTimeout(()=>finish(new StorageFailure('history_native_timeout')),remaining);
  signal.addEventListener('abort',abort,{once:true});done.then(()=>finish(),finish);
 });
}
export const historyReaderHolderKey=(contactId:string,generation:string):string=>`history:read_${contactId}_${generation}`;
 /** 原生快照守卫只保护本次独占读取，逐租约核验并释放；共享进程与已核验选择在租约间保留，失败与停读才收尾。 */
export class SqliteHistoryService {
 private readonly storage:SqliteStorage;
 private readonly contacts:HistoryContactGateway;
 private readonly createChannel:()=>HistoryChannel;
 readonly holders:ActiveHolders;
 private readonly onMessageChange?: (contactId:string,messageId:string,kind:MessageChangeKind)=>void;
 private readonly onAcceptedPage?: (contactId:string)=>void;
 private firstHistoryWake?: (contactId:string)=>void;
 private readonly active=new Map<string,ActiveHistoryRead>();
 private readonly bodySupport=new Map<string,ReadEligibility>();
 /** 每联系人保留的通道与进程；守卫仍逐租约释放，空闲进程只承载轻量证明订阅。 */
 private readonly retained=new Map<string,RetainedEntry>();
 /** 停读时通道关闭失败、待下次停读或来源准备重试排空的保留条目。 */
 private readonly closePendings=new Map<string,RetainedEntry>();
 private readonly recoveries=new WeakMap<HistoryTarget,{planDigest:string;recovery:HistoryRecoveryResult}>();
 private readonly resumedTargets=new WeakSet<HistoryTarget>();
 private closed=false;
 private readonly shared?:SharedWechatClient;
 private readonly queued=new Map<string,{controller:AbortController;done:Promise<void>}>();
 private readonly sourcePreparations=new Set<{contactId:string;controller:AbortController;done:Promise<void>}>();
 constructor(storage:SqliteStorage,contacts:HistoryContactGateway,channel:HistoryChannel|(()=>HistoryChannel),holders:ActiveHolders=new ActiveHolders(),onMessageChange?:(contactId:string,messageId:string,kind:MessageChangeKind)=>void,onAcceptedPage?:(contactId:string)=>void,shared?:SharedWechatClient){
  this.storage=storage;this.contacts=contacts;this.createChannel=typeof channel==='function'?channel:()=>channel;this.holders=holders;this.onMessageChange=onMessageChange;this.onAcceptedPage=onAcceptedPage;this.shared=shared;
 }
 setFirstHistoryWake(callback:(contactId:string)=>void):void {this.firstHistoryWake=callback;}
 private wakeFirstHistory(contactId:string):void {try{this.firstHistoryWake?.(contactId);}catch{/* 唤醒失败不回滚已持久化的历史目标。 */}}
 /** 空闲守卫的瞬时失效也须接回历史协调器；真实围栏和授权变化不进入自动恢复。 */
 async requestFirstHistoryRecovery(contactId:string):Promise<void>{
  if(this.closed||!this.firstHistoryWake)return;
  const token=await this.contacts.eligibility(contactId);
  if(await this.storage.execute<boolean>('history.normalUseRevalidationCandidate',{token}))this.wakeFirstHistory(contactId);
 }
 private publishMessageChanges(contactId:string,ids:readonly string[]|undefined,kind:MessageChangeKind):void{
  if(this.onMessageChange)for(const messageId of ids??[])try{this.onMessageChange(contactId,messageId,kind);}catch{/* 通知失败不能回滚已提交的历史页。 */}
 }
 private publishAcceptedMessages(contactId:string,accepted:AcceptedPage,includeCreated:boolean):HistoryCoverage{
  const {createdMessageIds,updatedMessageIds,...coverage}=accepted;
  if(includeCreated)this.publishMessageChanges(contactId,createdMessageIds,'created');
  const created=new Set(createdMessageIds??[]);
  this.publishMessageChanges(contactId,updatedMessageIds?.filter(messageId=>!created.has(messageId)),'updated');
  try{this.onAcceptedPage?.(contactId);}catch{/* 图片同步失败不回滚已保存的消息和覆盖。 */}
  return coverage;
 }
 private async quarantinePageStates(contactId:string,scope:HistoryScope,goal:PendingGoal|{id:string;target:HistoryTarget;cursor:string},page:HistoryPage|HistoryTailPage):Promise<void>{
  if(!page.records?.some(record=>record?.stateAssurance!=='verified'||record?.originalType==='10000'&&record?.kind==='other'))return;
  const changed=await this.storage.execute<{updatedMessageIds?:string[]}>('history.quarantinePageStates',{token:scope.token,goalId:goal.id,page});
  this.publishMessageChanges(contactId,changed.updatedMessageIds,'updated');
 }
 private async withChannel<T>(contactId:string,signal:AbortSignal|undefined,run:(scope:HistoryScope,channel:HistoryChannel,controller:AbortController,registerGoal:(goalId:string)=>void,armGuard:(proof?:GuardProof)=>Promise<GuardResult>,metadataRevalidation:boolean,retainedGuardAvailable:boolean,releaseNormalUseGuard:()=>void)=>Promise<T>,options:{retain?:boolean}={}):Promise<T>{
  if(!this.shared)return this.withExclusiveChannel(contactId,signal,run,options);
  if(this.closed)throw new StorageFailure('history_closed');
  if(this.queued.has(contactId))throw new StorageFailure('history_already_running');
  const controller=new AbortController();let finish!:()=>void;const done=new Promise<void>(resolve=>{finish=resolve;});this.queued.set(contactId,{controller,done});
  const combined=signal?AbortSignal.any([controller.signal,signal]):controller.signal;
  // 下一个联系人取得进程前，释放本联系人的选择：正常使用停车保留通道，其余整体收尾。
  try{return await this.shared.run(contactId,()=>this.withExclusiveChannel(contactId,combined,run,options),async()=>{
   const previous=this.retained.get(contactId);if(!previous)return;
   if(previous.normalUse&&!previous.failed&&previous.channel.park){
    try{await previous.channel.park();previous.parked=true;}catch(error){previous.failed=true;void this.retireEntry(previous).catch(()=>{});throw error;}
   }
   else{this.retained.delete(contactId);previous.failed=true;await this.retireEntry(previous).catch(()=>{});}
  },combined);}
  finally{this.queued.delete(contactId);finish();}
 }
 private async withExclusiveChannel<T>(contactId:string,signal:AbortSignal|undefined,run:(scope:HistoryScope,channel:HistoryChannel,controller:AbortController,registerGoal:(goalId:string)=>void,armGuard:(proof?:GuardProof)=>Promise<GuardResult>,metadataRevalidation:boolean,retainedGuardAvailable:boolean,releaseNormalUseGuard:()=>void)=>Promise<T>,options:{retain?:boolean}={}):Promise<T>{
  if(this.closed)throw new StorageFailure('history_closed');
  if(this.active.has(contactId))throw new StorageFailure('history_already_running');
  const controller=new AbortController(),work=Promise.withResolvers<void>();
  let workFinished=false,leaseSettled=false,successful=false,bodyVerified=false,normalUse=false;
  let channel:HistoryChannel|undefined,token:ReadEligibility|undefined,guardId:string|undefined,lossCode:string|undefined;
  // 守卫失联归因：确证来源连续性错误时持久围栏；共享进程整体停止的空闲守卫先降级，由完整重验裁决。
  let sourceLost=false,deferVerification=false;
  let closing:Promise<void>|undefined,releasing:Promise<void>|undefined,releaseFailed=false,storageClosed=false,intentionalClose=false;
  let holder:Parameters<ActiveHolders['register']>[0]|undefined;
  let entry:RetainedEntry|undefined;
  const releases:(()=>Promise<void>)[]=[];
  let cleanupDone=false,gracefulRelease=false;
  const closeChannel=()=>{
   if(!channel)return Promise.resolve();
   intentionalClose=true;
   return closing??=Promise.resolve(channel.close?.()).catch(error=>{closing=undefined;throw error;});
  };
  const releaseGuard=()=>releasing??=(async()=>{
   try{
    if(guardId&&token&&!releaseFailed){
     try{if(!await this.storage.execute<boolean>('history.guardRelease',{token,guardId,normalUse:entry?.normalUse===true,sourceLost:sourceLost===true,deferVerification:deferVerification===true}))throw new StorageFailure('history_source_continuity_unverified');guardId=undefined;}
     catch(error){releaseFailed=true;throw error;}
    }
   }finally{if(releaseFailed&&!storageClosed){await this.storage.close();storageClosed=true;}}
  })().catch(error=>{releasing=undefined;throw error;});
  const cleanup=async()=>{
   if(cleanupDone){await work.promise;return;}
   cleanupDone=true;
   let failure:unknown;
   try{for(const release of releases.reverse())await release();}catch(error){failure??=error;}
   // 探测轮等显式要求时，正常结果的租约也整体收尾（守卫+通道+条目），保留表清除；
   // 非保留租约与失败租约同此；其余正常完成的保留租约把活守卫与通道留给条目统一收尾。
   if(gracefulRelease&&entry&&token){void this.retireEntry(entry).catch(()=>{});this.retained.delete(contactId);}
   if(!successful||options.retain===false)try{await releaseGuard();}catch(error){failure=error;}
   try{if(!successful||options.retain===false)await closeChannel();}catch(error){failure??=error;}
   // 与基线一致：只有确实武装（或复用）了活守卫的成功租约才保留通道；无守卫的一次性租约照常关闭。
   if(successful&&options.retain!==false&&entry&&token&&guardId){
    entry.normalUse=normalUse;entry.bodyVerified=bodyVerified;
    if(!entry.holderRelease){
     const resource:Parameters<ActiveHolders['register']>[0]={key:`history:guard_${contactId}_${token.data_generation}`,ownerId:token.owner_id,contactId,generation:BigInt(token.data_generation),coversAllSources:true,close:async()=>{
      // 本轮确有守卫释放尝试失败才按首个错误上报；记录仅供诊断，后续轮次不重复抛出。
      let reported:unknown;
      try{await this.releaseEntryGuard(entry!);}catch(error){reported??=error;entry!.releaseError??=error;}
      let closeError:unknown;
      try{await entry!.close();}catch(error){closeError=error;}
      if(this.retained.get(contactId)===entry)this.retained.delete(contactId);
      resource.releasedOnFailure=true;
      if(reported)throw reported;
      if(closeError)throw closeError;
     }};
     try{entry.holderRelease=this.holders.register(resource);}
     catch{/* 已被围栏的删除键不再重复登记；条目照常保留，删除时按通道状态核对。 */}
    }
    this.retained.set(contactId,entry);
   }
   else if(entry&&this.retained.get(contactId)===entry){entry.failed=true;this.retained.delete(contactId);void this.retireEntry(entry).catch(()=>{});}
   else if(successful&&!guardId)try{await closeChannel();}catch(error){failure??=error;}
   // 关闭尚未确认时保留holder，停读或删除可重试真实排空。
   if((!releaseFailed||storageClosed)&&closing){try{await closing;this.active.delete(contactId);if(holder)holder.releasedOnFailure=true;}catch{/* 关闭失败已记录。 */}}
   else this.active.delete(contactId);
   if(failure)throw failure;
  };
  const stop=async()=>{
   if(!workFinished){controller.abort();try{await closeChannel();}catch{/* cleanup保留失败资源供下一次停读。 */}await work.promise;}
   await cleanup();
  };
  let releaseHolder:(()=>Promise<void>)|undefined;const done=Promise.withResolvers<void>();
  this.active.set(contactId,{done:done.promise,stop:async()=>releaseHolder?releaseHolder():stop()});
  const abort=()=>{controller.abort();void closeChannel().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  try{
   token=await this.contacts.eligibility(contactId);const scope=await this.storage.execute<HistoryScope>('history.scope',{token});
   const {ok,metadataRevalidation}=await this.storage.execute<{ok:boolean;metadataRevalidation:boolean}>('history.readPreflight',{token});
   if(!ok)throw new StorageFailure('history_source_continuity_unverified');
   await this.check(scope,controller);
   // 先排空上一轮关闭失败的条目，再决定通道来源；失败只上报，不阻塞当前读取。
   const pending=this.closePendings.get(contactId);
   if(pending){this.closePendings.delete(contactId);try{await this.retireEntry(pending);}catch(error){this.closePendings.set(contactId,pending);}}
   const retireOld=async(old:RetainedEntry)=>{
    this.retained.delete(contactId);old.failed=true;
    await this.retireEntry(old).catch(()=>{});
   };
   let existing=this.retained.get(contactId);
   if(existing&&existing.failed){await retireOld(existing);existing=undefined;}
   else if(existing&&(options.retain===false||existing.digest!==JSON.stringify(token))){await retireOld(existing);existing=undefined;}
   entry=existing;
   let freshChannel=false;
   channel=entry&&!entry.parked?entry.channel:(freshChannel=true,this.createChannel());
   if(process.env.NOTALONE_DBG==='1')console.error('DBG_LEASE',contactId.slice(0,8),'entry='+Boolean(entry),'parked='+Boolean(entry&&entry.parked),'fresh='+freshChannel);
   if(!entry){const created:RetainedEntry={channel:channel!,contactId,token,digest:JSON.stringify(token),parked:false,failed:false,normalUse:false,bodyVerified:false,close:()=>Promise.resolve(created.channel.close?.())};entry=created;}
   entry.token=token;entry.digest=JSON.stringify(token);
   // 保留通道失联归因：在途读者按自身错误围栏；空闲守卫整体释放（守卫置 lost）并请求首次恢复，完整重验后才判围栏。
   if(freshChannel&&channel.guardSession)void channel.guardSession.loss.then(()=>{
    this.bodySupport.delete(contactId);
    const lostEntry=this.retained.get(contactId);
    if(lostEntry&&lostEntry.channel===channel){
     lostEntry.failed=true;lostEntry.failedCode=channel.guardSession?.failureCode?.()??null;
     // 归因：确证连续性错误才按来源失联围栏；共享进程整体停止时未在读取的守卫只降级，由完整重验裁决。
     const code=lostEntry.failedCode;
     if(code&&isSourceContinuityLost(new StorageFailure(code))){lostEntry.sourceLost=true;lostEntry.deferVerification=Boolean(this.shared)&&!this.active.has(contactId);}
     if(!this.active.has(contactId)){
      // 失联即整体释放：守卫置 lost 使候选可验；首次恢复由协调器轮询或下一次读取发起，不在此重复唤醒。
      void this.retireEntry(lostEntry).catch(()=>{});
     }
    }
   });
   holder={key:historyReaderHolderKey(contactId,token.data_generation),ownerId:token.owner_id,contactId,generation:BigInt(token.data_generation),coversAllSources:true,close:stop};
   releaseHolder=this.holders.register(holder);
   releases.push(releaseHolder);
   // 每任务一条易失reader；与读者holder同租约生命周期，任务完成后统一释放。
   const register=(key:string,coversAllSources=false)=>{const release=this.holders.register({key,ownerId:token!.owner_id,contactId,generation:BigInt(token!.data_generation),coversAllSources,close:stop});releases.push(release);return release;};
   const registerGoal=(goalId:string)=>register(`history:${goalId}`);
   const armGuard=async(proof?:GuardProof):Promise<GuardResult>=>{
    if(proof)normalUse=true;
    if(!channel?.guardSession){if(proof)throw new StorageFailure('history_guard_invalid');return {revalidated:false};}
    if(guardId)throw new StorageFailure('history_guard_invalid');
    const session=channel.guardSession;if(!(session.loss instanceof Promise))throw new StorageFailure('history_guard_invalid');
    // 已停车的保留守卫换用本租约的新通道（选择在租约开始完成）；停车时旧通道已释放选择，幂等收尾静默。
    if(entry&&entry.parked&&entry.channel!==channel){
     const parkedChannel=entry.channel;entry.channel=channel;entry.parked=false;
     void parkedChannel.close?.().catch(()=>{});
    }
    let candidateId:string;
    if(entry&&entry.channel===channel&&entry.guardId&&!entry.failed&&!entry.parked&&entry.digest===JSON.stringify(token)
     &&await this.storage.execute<boolean>('history.guardCheck',{token,guardId:entry.guardId})){
     // 保留守卫仍活守卫:同来源换代表述不换代,旧行不因重验而失效。
     candidateId=entry.guardId;
     if(proof){
      const recovery=this.recoveries.get(proof.target);
      const checked=await this.storage.execute<{ok:boolean;revalidated:boolean}>(recovery?'history.prepareRecoveredGuard':'history.prepareNormalUseGuard',{token,target:proof.target,report:proof.report,guardId:candidateId,...recovery});
      if(!checked.ok)throw new StorageFailure('history_source_continuity_unverified');
      entry.report=structuredClone(proof.report);entry.target=structuredClone(proof.target);
      guardId=candidateId;
      const lost=()=>{if(intentionalClose||leaseSettled)return;const code=session.failureCode?.()??'history_source_unverified';lossCode=code;
// 归因：确证连续性错误才视为来源失联；共享进程整体停止时未在读取的守卫只降级（完整重验裁决）。
if(isSourceContinuityLost(new StorageFailure(code))){sourceLost=true;deferVerification=Boolean(this.shared)&&!this.active.has(contactId);}
controller.abort();this.bodySupport.delete(contactId);void releaseGuard().catch(()=>{});};
      void session.loss.then(lost,lost);return {guardId,revalidated:checked.revalidated};
    // 保留条目失联观察：租约结束后守卫失联仍按条目归因（确证才围栏；共享空闲只降级）。
    void session.loss.then(()=>{if(intentionalClose||leaseSettled)return;const code=session.failureCode?.()??'history_source_unverified';if(isSourceContinuityLost(new StorageFailure(code))){entry!.sourceLost=true;entry!.deferVerification=Boolean(this.shared)&&!this.active.has(contactId);}},()=>{});
     }
     guardId=candidateId;
     const lost=()=>{if(intentionalClose||leaseSettled)return;const code=session.failureCode?.()??'history_source_unverified';lossCode=code;
// 归因：确证连续性错误才视为来源失联；共享进程整体停止时未在读取的守卫只降级（完整重验裁决）。
if(isSourceContinuityLost(new StorageFailure(code))){sourceLost=true;deferVerification=Boolean(this.shared)&&!this.active.has(contactId);}
controller.abort();this.bodySupport.delete(contactId);void releaseGuard().catch(()=>{});};
     void session.loss.then(lost,lost);return {guardId,revalidated:false};
    void session.loss.then(()=>{if(intentionalClose||leaseSettled)return;const code=session.failureCode?.()??'history_source_unverified';if(isSourceContinuityLost(new StorageFailure(code))){entry!.sourceLost=true;entry!.deferVerification=Boolean(this.shared)&&!this.active.has(contactId);}},()=>{});
    }
    const recovery=proof?this.recoveries.get(proof.target):undefined;
    const candidateId2=randomUUID();
    const prepared=proof?await this.storage.execute<{ok:boolean;revalidated:boolean}>(recovery?'history.prepareRecoveredGuard':'history.prepareNormalUseGuard',{token,target:proof.target,report:proof.report,guardId:candidateId2,...recovery})
     :{ok:await this.storage.execute<boolean>('history.guardAcquire',{token,guardId:candidateId2}),revalidated:false};
    if(!prepared.ok)throw new StorageFailure('history_source_continuity_unverified');
    guardId=candidateId2;
    if(entry&&entry.channel===channel){entry.guardId=guardId;if(proof){entry.report=structuredClone(proof.report);entry.target=structuredClone(proof.target);}
     // 与基线一致：armGuard 装配成功即在保留表登记当前条目，后续停车/检查点路径可按联系人命中。
     this.retained.set(contactId,entry);}
    const lost=()=>{if(intentionalClose||leaseSettled)return;const code=session.failureCode?.()??'history_source_unverified';lossCode=code;
// 归因：确证连续性错误才视为来源失联；共享进程整体停止时未在读取的守卫只降级（完整重验裁决）。
if(isSourceContinuityLost(new StorageFailure(code))){sourceLost=true;deferVerification=Boolean(this.shared)&&!this.active.has(contactId);}
controller.abort();this.bodySupport.delete(contactId);void releaseGuard().catch(()=>{});};
    void session.loss.then(lost,lost);
    return {guardId,revalidated:prepared.revalidated};
    void session.loss.then(()=>{if(intentionalClose||leaseSettled)return;const code=session.failureCode?.()??'history_source_unverified';if(isSourceContinuityLost(new StorageFailure(code))){entry!.sourceLost=true;entry!.deferVerification=Boolean(this.shared)&&!this.active.has(contactId);}},()=>{});
   };
   const retainedAvailable=Boolean(entry&&!entry.parked);
   const result=await run(scope,channel,controller,registerGoal,armGuard,metadataRevalidation,retainedAvailable,()=>{if(entry&&!entry.failed)gracefulRelease=true;});
   if(lossCode)throw new StorageFailure(lossCode);
   successful=true;bodyVerified=Boolean(this.bodySupport.get(contactId));
   return result;
  }catch(error){
   this.bodySupport.delete(contactId);
   const actual=lossCode&&!signal?.aborted&&!this.closed?new StorageFailure(lossCode):error;
   // 归因补齐：租约内抛出确证连续性错误同样按失联围栏路径传递（共享空闲守卫只降级）。
   if(actual instanceof StorageFailure&&isSourceContinuityLost(actual)&&!sourceLost){sourceLost=true;deferVerification=Boolean(this.shared)&&!this.active.has(contactId);}
   if(entry&&entry.channel===channel){
    entry.failed=true;
    if(this.retained.get(contactId)===entry)this.retained.delete(contactId);
    void this.releaseEntryGuard(entry).catch(()=>{});
   }
   if(token&&isSourceContinuityLost(actual))await this.storage.execute('history.markContinuityLost',{token,errorCode:actual instanceof StorageFailure?actual.code:undefined});
   throw actual;
  }finally{
   leaseSettled=true;
   signal?.removeEventListener('abort',abort);workFinished=true;work.resolve();
   // 工作先声明结束再统一收尾：holder 释放回调的 stop 不再等待在途工作，避免与 releases 循环互等。
   try{await cleanup();}finally{done.resolve();}
  }
 }
 private async check(scope:HistoryScope,controller:AbortController):Promise<void>{
  if(controller.signal.aborted||this.closed)throw new StorageFailure('history_interrupted');
  await this.contacts.validate(scope.token);
 }
 private async inspectCurrent(scope:HistoryScope,channel:HistoryChannel,controller:AbortController):Promise<HistorySupportReport>{
  const report=await channel.inspect(scope,controller.signal);await this.check(scope,controller);assertSupport(report);
  if(report.accountKey!==scope.accountKey||report.conversationKey!==scope.conversationKey||report.sourceGeneration!==scope.token.source_generation)throw new StorageFailure('history_external_scope_changed');
  return report;
 }
 private async verifyPage(scope:HistoryScope,channel:HistoryChannel,controller:AbortController,report:HistorySupportReport,goal:PendingGoal,page:HistoryPage|HistoryTailPage):Promise<void>{
  // 已返回页先保护未核验旧行；随后检查停读和来源变化，才允许接受新页。
  await this.quarantinePageStates(scope.token.contact_id,scope,goal,page);await this.check(scope,controller);
  const current=await this.inspectCurrent(scope,channel,controller);
  if(serializeSupport(current)!==serializeSupport(report))throw new StorageFailure(isPartitionGrowthTargetChange(report,current)?'history_target_growth_required':'history_support_changed');
 }
 private async readHistoryGoal(scope:HistoryScope,channel:HistoryChannel,controller:AbortController,report:HistorySupportReport,goal:PendingGoal,guardId?:string):Promise<HistorySynchronization>{
  const normalUse=report.continuity===normalUseContinuity,checkpointable=normalUse&&report.capabilities?.durableHistory==='supported'&&report.capabilities?.durableIncremental==='supported';
  const started=performance.now(),contactId=scope.token.contact_id;
  for(let index=0;normalUse||index<1000;index++){
   await this.check(scope,controller);
   if(guardId&&!await this.storage.execute<boolean>('history.guardCheck',{token:scope.token,guardId}))throw new StorageFailure('history_source_continuity_unverified');
   const checkpoint=checkpointable&&(index>=31||performance.now()-started>=1000);
   const page=await channel.page(scope,goal.target,goal.cursor,controller.signal,checkpoint?{checkpoint:true}:undefined);
   await this.verifyPage(scope,channel,controller,report,goal,page);
   if(checkpoint&&!page.exhausted&&!page.checkpointCursor)throw new StorageFailure('history_page_invalid');
   const accepted=await this.storage.execute<AcceptedPage>('history.acceptPage',{token:scope.token,goalId:goal.id,captureId:randomUUID(),page,at:Date.now(),runtimeToken:this.storage.status.runtimeId,guardId,notifyMessageChanges:true});
   const coverage=this.publishAcceptedMessages(contactId,accepted,false);
   if(page.exhausted)return coverage;
   if(checkpoint)return Object.defineProperty(coverage,resumableHistorySlice,{value:true});
   goal.cursor=page.cursorOut;
   if((index+1)%1000===0)await new Promise<void>(resolve=>setImmediate(resolve));
  }
  return this.storage.execute('history.interrupt',{token:scope.token,goalId:goal.id,code:'history_page_budget_exhausted'});
 }
 /** 只查询当前授权和已核验能力，不创建通道，也不恢复来源资格。 */
 async bodyAvailable(contactIds:readonly string[]):Promise<boolean>{
  if(this.closed)return false;
  for(const contactId of contactIds){
   const token=this.bodySupport.get(contactId);if(!token)continue;
   const entry=this.retained.get(contactId);
   // 原生进程已失联的保留通道只结束轻量守卫；已保存覆盖与来源事实不动，正文须重核验。
   if(entry&&entry.failed)continue;
   try{await this.contacts.validate(token);if(await this.storage.execute<boolean>('history.bodyAvailable',{token}))return true;}catch{/* 停读、删除和真实来源失证均保持不可用。 */}
  }return false;
 }
 private rememberBodySupport(contactId:string,report:HistorySupportReport,token:ReadEligibility):void{
  if(report.status==='supported'&&bodyCapabilities.every(key=>report.capabilities?.[key]==='supported'))this.bodySupport.set(contactId,token);
  else this.bodySupport.delete(contactId);
 }
 /** 同联系人读者结束后，用新通道复验来源元数据，不重读正文。 */
 /** 读者工作已结束但真实关闭失败时，先按停读入口重试真实排空，不循环等待已结束的工作。 */
 private async waitForDrainedReader(contactId:string,pending:Promise<void>,combined:AbortSignal,deadline:number):Promise<void>{
  await waitForSourceReader(pending,combined,deadline-Date.now());
  const leftover=this.active.get(contactId);
  if(leftover)await leftover.stop();
 }
 async prepareSource(contactId:string,signal?:AbortSignal):Promise<void>{
  if(this.closed)throw new StorageFailure('history_closed');
  const controller=new AbortController(),combined=signal?AbortSignal.any([controller.signal,signal]):controller.signal;
  let finish!:()=>void;const done=new Promise<void>(resolve=>{finish=resolve;});
  const preparation={contactId,controller,done};this.sourcePreparations.add(preparation);
  const deadline=Date.now()+15000;
  let timedOut=false;const timeout=setTimeout(()=>{timedOut=true;controller.abort();},15000);
  const check=()=>{if(this.closed)throw new StorageFailure('history_closed');if(timedOut||Date.now()>=deadline)throw new StorageFailure('history_native_timeout');if(combined.aborted)throw new StorageFailure('history_native_cancelled');};
  try{
   for(;;){
    check();
    // 保留守卫仍有效时直接复用，不重开读者；正文资格由读取入口另行核对（与基线一致）。
    const token=await this.contacts.eligibility(contactId);check();
    const entry=this.retained.get(contactId);
    if(entry&&!entry.failed&&!entry.parked&&entry.guardId&&entry.digest===JSON.stringify(token)){
     if(await this.storage.execute<boolean>('history.guardCheck',{token:entry.token,guardId:entry.guardId})){check();return;}
    }
    const pending=this.queued.get(contactId)?.done??this.active.get(contactId)?.done;
    if(pending){await this.waitForDrainedReader(contactId,pending,combined,deadline);continue;}
    try{await this.ensureSourceReady(contactId,combined);check();return;}
    catch(error){
     if(!(error instanceof StorageFailure)||error.code!=='history_already_running')throw error;
     const raced=this.queued.get(contactId)?.done??this.active.get(contactId)?.done;
     if(!raced)throw error;
     await this.waitForDrainedReader(contactId,raced,combined,deadline);
    }
   }
  }catch(error){if(timedOut)throw new StorageFailure('history_native_timeout');throw error;}
  finally{clearTimeout(timeout);this.sourcePreparations.delete(preparation);finish();}
 }
 /**
  * 记忆等派生处理只重验来源元数据，不读取历史页或推进同步目标。
  * 默认保留通道与守卫并在共享读取器上重新停车；来源准备等一次性流程传 retain:false，
  * 逐轮新开通道并在租约结束即释放。
  */
 async ensureSourceReady(contactId:string,signal?:AbortSignal,options:{retain?:boolean}={}):Promise<void>{
  const revalidated=await this.withChannel(contactId,signal,async(scope,channel,controller,_registerGoal,armGuard,_metadataRevalidation,_retainedGuardAvailable,_releaseNormalUseGuard)=>{
   const report=await this.inspectCurrent(scope,channel,controller);
   const normalUse=report.continuity===normalUseContinuity;
   const target=await channel.target(scope,controller.signal);await this.check(scope,controller);
   const armed=await armGuard(normalUse?{report,target}:undefined);
   if(!await this.storage.execute<boolean>('history.preflightContinuity',{token:scope.token,target,report}))throw new StorageFailure('history_source_continuity_unverified');
   await this.check(scope,controller);await this.storage.execute('history.guardAuthorize',{token:scope.token,guardId:armed.guardId});
   // 记忆来源重验完成后把共享读取器停回轻量停车；后续同联系人读取按其检查点重建目标与守卫。
   return armed.revalidated;
  });
  if(options.retain!==false&&this.shared){
   const parked=this.retained.get(contactId);
   if(parked&&typeof parked.channel.park==='function'&&parked.normalUse&&!parked.failed){await parked.channel.park();parked.parked=true;}
  }
  // 成功重验会使旧未完目标失效；释放租约后再交回首次历史，失败不派发完成唤醒。
  if(revalidated&&!(await this.coverage(contactId)).traversalComplete)this.wakeFirstHistory(contactId);
 }
 support(contactId:string):Promise<HistorySupportReport>{return this.withChannel(contactId,undefined,async(scope,channel,controller,_registerGoal,armGuard,_metadataRevalidation,_retainedGuardAvailable)=>{const report=await channel.inspect(scope,controller.signal);await this.check(scope,controller);return report;});}
 read(contactId:string,options:{limit?:number;before?:string}={}):Promise<HistoryRead>{
  if(this.closed)throw new StorageFailure('history_closed');
  return this.storage.execute('history.read',{ownerId:this.contacts.ownerId,contactId,limit:options.limit??101,before:options.before});
 }
 readChat(contactId:string,options:{limit?:number;before?:string}={}):Promise<HistoryRead>{
  if(this.closed)throw new StorageFailure('history_closed');
  return this.storage.execute('history.readChat',{ownerId:this.contacts.ownerId,contactId,limit:options.limit??101,before:options.before});
 }
 async synchronizeQuotes(contactId:string,signal?:AbortSignal):Promise<{processed:number;more:boolean}>{
  const store=new SqliteQuoteStore(this.storage,this.contacts.ownerId),limit=10;
  const targets=await store.candidates(contactId,quoteParserVersion,limit);
  if(!targets.length)return {processed:0,more:false};
  let revalidated=false;
  const result=await this.withChannel(contactId,signal,async(scope,channel,controller,_registerGoal,armGuard,_metadataRevalidation,_retainedGuardAvailable,_releaseNormalUseGuard)=>{
   if(!channel.readQuote)return {processed:0,more:false};
   const report=await this.inspectCurrent(scope,channel,controller);assertSupport(report);
   if(report.accountKey!==scope.accountKey||report.conversationKey!==scope.conversationKey||report.sourceGeneration!==scope.token.source_generation)throw new StorageFailure('history_external_scope_changed');
   const normalUse=report.continuity===normalUseContinuity,entry=this.retained.get(contactId);
   // 共享进程切回联系人后重新证明来源；不借用另一联系人目标，也不推进文字检查点。
   if(normalUse&&!this.shared&&(!entry?.bodyVerified||!entry.target||!entry.report||serializeSupport(entry.report)!==serializeSupport(report)))return {processed:0,more:false};
   const reusable=normalUse&&entry?.bodyVerified&&entry.target&&entry.report&&serializeSupport(entry.report)===serializeSupport(report);
   const target=reusable?entry.target!:await channel.target(scope,controller.signal);await this.check(scope,controller);
   const armed=await armGuard(normalUse&&!reusable?{report,target}:undefined);revalidated=armed.revalidated;
   if(normalUse&&!reusable&&!await this.storage.execute<boolean>('history.preflightContinuity',{token:scope.token,target,report}))throw new StorageFailure('history_source_continuity_unverified');
   this.rememberBodySupport(contactId,report,scope.token);let processed=0;
   for(const item of targets){
    await this.check(scope,controller);
    const source=await this.source(contactId,item.recordId);
    if(source.messageId!==item.messageId)throw new StorageFailure('history_quote_association_unverified');
    const input={token:scope.token,recordId:item.recordId,messageId:item.messageId,version:quoteParserVersion};
    try{
     const {proofDigest,...content}=await channel.readQuote(scope,target,source,controller.signal);
     await this.check(scope,controller);await store.save({...input,content,proofDigest});
    }catch(error){
     if(controller.signal.aborted)throw error;
     if(!(error instanceof StorageFailure)||!['history_quote_unavailable','history_quote_metadata_invalid','history_quote_too_large','history_quote_state_unverified','history_quote_association_unverified','history_quote_read_failed'].includes(error.code))throw error;
     await this.check(scope,controller);await store.fail({...input,errorCode:error.code});
    }
    processed++;this.publishMessageChanges(contactId,[item.messageId],'updated');
   }
   return {processed,more:targets.length===limit};
  });
  // 引用来源重验也可能使未完历史目标失效；成功释放读取器后再接回首次历史。
  if(revalidated&&!(await this.coverage(contactId)).traversalComplete)this.wakeFirstHistory(contactId);
  return result;
 }
 async imageMedia(contactId:string,messageIds:readonly string[]):Promise<ReadonlyMap<string,HistoryImageMedia>>{
  if(this.closed)throw new StorageFailure('history_closed');
  const rows=await this.storage.execute<{message_id:string;media_state:string|null;attempt_state:string|null;error_code:string|null;file_id:string|null;mime_type:string|null}[]>(
   'history.imageMedia',{ownerId:this.contacts.ownerId,contactId,messageIds:[...messageIds]});
  const summaries=new Map<string,HistoryImageMedia>();
  for(const row of rows){
   if(row.media_state==='cleared'||row.media_state==='deleting'){
    summaries.set(row.message_id,{state:'cleared',fileId:null,mimeType:null});continue;
   }
   if(row.media_state==='invalidated'){
    summaries.set(row.message_id,{state:'unavailable',fileId:null,mimeType:null,errorCode:'media_source_invalidated'});continue;
   }
   if(row.file_id&&typeof row.mime_type==='string'&&row.mime_type.startsWith('image/')){
   summaries.set(row.message_id,{state:'available',fileId:row.file_id,mimeType:row.mime_type});continue;
   }
   const errorCode=typeof row.error_code==='string'&&/^[-a-z0-9_]{1,80}$/.test(row.error_code)?row.error_code:null;
   if(row.attempt_state==='pending'||row.attempt_state==='running'||!row.attempt_state){
    summaries.set(row.message_id,{state:'pending',fileId:null,mimeType:null,...(errorCode?{errorCode}:{})});continue;
   }
   if(errorCode==='media_thumbnail_only'){
    summaries.set(row.message_id,{state:'thumbnail_only',fileId:null,mimeType:null,errorCode});continue;
   }
   if(errorCode==='media_local_file_missing'||errorCode==='media_original_unavailable'){
    summaries.set(row.message_id,{state:'unavailable',fileId:null,mimeType:null,errorCode});continue;
   }
   summaries.set(row.message_id,{state:'failed',fileId:null,mimeType:null,...(errorCode?{errorCode}:{})});
  }
  return summaries;
 }
 source(contactId:string,recordId:string):Promise<HistorySource>{return this.storage.execute('history.source',{ownerId:this.contacts.ownerId,contactId,recordId});}
 waitForReadIdle(contactId:string):Promise<void>{return this.queued.get(contactId)?.done??this.active.get(contactId)?.done??Promise.resolve();}
 coverage(contactId:string):Promise<HistoryCoverage>{return this.storage.execute('history.coverage',{ownerId:this.contacts.ownerId,contactId});}
 private async resumeOrTarget(scope:HistoryScope,channel:HistoryChannel,report:HistorySupportReport,signal:AbortSignal):Promise<HistoryTarget>{
  let plan=await this.storage.execute<SourceRecoveryPlan|null>('history.sourceRecoveryPlan',{token:scope.token,report});
  if(plan&&plan.target.tables.length===0&&plan.anchors.length===0){
   const target=await channel.target(scope,signal);await this.contacts.validate(scope.token);signal.throwIfAborted();
   this.recoveries.set(target,{planDigest:plan.digest,recovery:{target,cursor:null,anchors:[]}});return target;
  }
  if(plan){
   if(!channel.recoverTarget||report.capabilities?.recoverFromLocalIds!=='supported')throw new StorageFailure('history_source_recovery_unsupported');
   const recovery=await channel.recoverTarget(scope,plan.target,plan.positions,signal);await this.contacts.validate(scope.token);signal.throwIfAborted();
   this.recoveries.set(recovery.target,{planDigest:plan.digest,recovery});return recovery.target;
  }
  if(channel.resumeTarget||report.capabilities?.durableIncremental==='supported'){
   const checkpoint=await this.storage.execute<{target:HistoryTarget;cursor:string}|null>('history.resumeCheckpoint',{token:scope.token,report});
   if(checkpoint){
    const resumed=channel.resumeTarget?await channel.resumeTarget(scope,checkpoint.target,checkpoint.cursor,signal):null;
    await this.contacts.validate(scope.token);
    if(resumed){this.resumedTargets.add(resumed);return resumed;}
   }
  }
  if(channel.recoverTarget&&report.capabilities?.recoverFromLocalIds==='supported'){
   plan=await this.storage.execute<SourceRecoveryPlan|null>('history.sourceRecoveryPlan',{token:scope.token,report,allowUnfenced:true});
   if(plan){const recovery=await channel.recoverTarget(scope,plan.target,plan.positions,signal);await this.contacts.validate(scope.token);signal.throwIfAborted();this.recoveries.set(recovery.target,{planDigest:plan.digest,recovery});return recovery.target;}
  }
  return channel.target(scope,signal);
 }
 coverages(contactIds:readonly string[]):Promise<HistoryCoverage[]>{
  if(contactIds.length>16)throw new StorageFailure('history_request_invalid');
  return this.storage.execute('history.coverages',{ownerId:this.contacts.ownerId,contactIds});
 }
 async synchronize(contactId:string,signal?:AbortSignal):Promise<HistorySynchronization>{  let wakeGrowth=false;
  try{return await this.withChannel(contactId,signal,async(scope,channel,controller,registerGoal,armGuard,metadataRevalidation,retainedGuardAvailable)=>{
  let goal:PendingGoal|undefined;
  const check=()=>this.check(scope,controller);
  try{
   const inspect=async()=>{
    const evidence=await channel.inspect(scope,controller.signal);await check();assertSupport(evidence);
    if(evidence.accountKey!==scope.accountKey||evidence.conversationKey!==scope.conversationKey||evidence.sourceGeneration!==scope.token.source_generation)throw new StorageFailure('history_external_scope_changed');
    return evidence;
   };
   const report=await inspect();
   const normalUse=report.continuity==='same-source-instances-normal-use-v1';
   const retainedReport=retainedGuardAvailable?this.retained.get(contactId)?.report:undefined;
   const reportGrowth=retainedReport?isPartitionGrowthTargetChange(retainedReport,report)
    :await this.storage.execute<boolean>('history.partitionGrowthCandidate',{token:scope.token,report});
   if(normalUse&&retainedGuardAvailable&&!metadataRevalidation){
    const coverage=await this.coverage(contactId);
    // 未核验旧行不使已经交接的固定快照复活；后续变化由独立增量目标跟进。
    if(coverage.failureCode==='history_identity_quarantined'&&coverage.traversalComplete&&coverage.incremental?.cursorPresent
      &&['ready','incomplete'].includes(coverage.incremental.phase)){
     const armed=await armGuard();await check();await this.storage.execute('history.guardAuthorize',{token:scope.token,guardId:armed.guardId});
     this.rememberBodySupport(contactId,report,scope.token);return coverage;
    }
   }
   const retainedPending=normalUse&&retainedGuardAvailable&&!metadataRevalidation&&!reportGrowth
    ?await this.storage.execute<PendingGoal|null>('history.pending',{token:scope.token,report})??undefined:undefined;
   const retainedTarget=retainedPending?this.retained.get(contactId)?.target:undefined;
   // 持久任务只有与当前原生目标完全相同时才能接续；来源准备也可能已替换保留守卫的目标。
   const pendingOnRetainedGuard=retainedPending&&retainedTarget&&JSON.stringify(retainedPending.target)===JSON.stringify(retainedTarget)
    ?retainedPending:undefined;
   const freshTarget=normalUse&&!pendingOnRetainedGuard
    ?retainedTarget??await this.resumeOrTarget(scope,channel,report,controller.signal):undefined;
   if(freshTarget)await check();
   const armed=await armGuard(normalUse&&!pendingOnRetainedGuard?{report,target:freshTarget!}:undefined),guardId=armed.guardId;
   await check();await this.storage.execute('history.guardAuthorize',{token:scope.token,guardId});this.rememberBodySupport(contactId,report,scope.token);
   // 新原生目标必须建立对应历史任务，不能再从数据库取回已经被替换的旧目标。
   goal=armed.revalidated||reportGrowth||freshTarget?undefined:pendingOnRetainedGuard??await this.storage.execute<PendingGoal|null>('history.pending',{token:scope.token,report})??undefined;
   if(!goal){const target=freshTarget??await channel.target(scope,controller.signal);await check();
    if(!await this.storage.execute<boolean>('history.preflightContinuity',{token:scope.token,target,report}))throw new StorageFailure('history_source_continuity_unverified');
    goal=await this.storage.execute('history.begin',{token:scope.token,target,report,id:randomUUID(),at:Date.now(),recoveryCursor:this.recoveries.get(target)?.recovery.cursor});}
   if(!await this.storage.execute<boolean>('history.preflightContinuity',{token:scope.token,target:goal!.target,report}))throw new StorageFailure('history_source_continuity_unverified');
   registerGoal(goal!.id);
   // 旧读取器的未完成页只能保留当前快照；新能力在有界片段末页取得并接受持久恢复证明。
   const retainSnapshot=normalUse&&Boolean(this.shared)&&typeof channel.park==='function';
   const resumableSlice=retainSnapshot&&report.capabilities?.durableHistory==='supported'&&report.capabilities?.durableIncremental==='supported';
   const sliceStarted=performance.now();
   for(let index=0;retainSnapshot||index<1000;index++){
    await check();if(guardId&&!await this.storage.execute<boolean>('history.guardCheck',{token:scope.token,guardId}))throw new StorageFailure('history_source_continuity_unverified');
    const checkpoint=resumableSlice&&(index>=31||performance.now()-sliceStarted>=1000);
    const page=await channel.page(scope,goal!.target,goal!.cursor,controller.signal,checkpoint?{checkpoint:true}:undefined);
    // 已返回页先保护被观察为未知状态的旧资料；停读后仍不接纳新正文或推进游标。
    await this.quarantinePageStates(contactId,scope,goal!,page);
    await check();
    if(checkpoint&&!page.exhausted&&!page.checkpointCursor)throw new StorageFailure('history_page_invalid');
    const currentReport=await inspect();
    if(serializeSupport(currentReport)!==serializeSupport(report)){
     if(isPartitionGrowthTargetChange(report,currentReport)){
      wakeGrowth=true;return await this.storage.execute('history.interrupt',{token:scope.token,goalId:goal!.id,code:'history_target_growth_required'});
     }
     throw new StorageFailure('history_support_changed');
    }
    await check();
    const accepted=await this.storage.execute<AcceptedPage>('history.acceptPage',{token:scope.token,goalId:goal!.id,captureId:randomUUID(),page,at:Date.now(),runtimeToken:this.storage.status.runtimeId,guardId,notifyMessageChanges:true});
    const coverage=this.publishAcceptedMessages(contactId,accepted,false);
    if(page.exhausted)return coverage;goal!.cursor=page.cursorOut;
    if(checkpoint){
     // 与基线一致：停车所标记的正是当前保留条目（armGuard 已在保留表登记）。
     await channel.park!();const guardEntry=this.retained.get(contactId);if(guardEntry&&guardEntry.channel===channel)guardEntry.parked=true;
     return Object.defineProperty(coverage,resumableHistorySlice,{value:true});
    }
    // 每1000页只让出事件循环；下一页照常核对取消、授权和守卫，不释放未完成的原生快照。
    if(retainSnapshot&&(index+1)%1000===0)await new Promise<void>(resolve=>setImmediate(resolve));
   }
   return await this.storage.execute('history.interrupt',{token:scope.token,goalId:goal!.id,code:'history_page_budget_exhausted'});
  }catch(error){
   if(error instanceof StorageFailure&&error.code==='history_target_growth_required'){
    wakeGrowth=true;
    if(goal)return await this.storage.execute('history.interrupt',{token:scope.token,goalId:goal.id,code:error.code});
    return await this.coverage(contactId);
   }
   if(goal){try{await this.storage.execute('history.interrupt',{token:scope.token,goalId:goal.id,code:error instanceof StorageFailure?error.code:'history_read_interrupted'});}catch{/* 旧资格不允许推进覆盖。 */}}
   throw error;
  }
  });}finally{if(wakeGrowth)this.wakeFirstHistory(contactId);}
 }

 /** 增量只从已证明的完整作用域检查点续读；每页接受前由存储动作复验资格、代次与删除状态。 */
 /** 默认把手交回首次协调器，不打断来源准备等调用方；同租约交接仅由接续增量的调用方显式开启。 */
 async synchronizeIncremental(contactId:string,signal?:AbortSignal,options:{followHistoryHandoff?:boolean}={}):Promise<HistoryCoverage>{  let wakeGrowth=false;
  try{return await this.withChannel(contactId,signal,async(scope,channel,controller,registerGoal,armGuard,metadataRevalidation,retainedGuardAvailable,releaseNormalUseGuard)=>{
  let goal:{id:string;target:HistoryTarget;cursor:string}|undefined;
  const check=()=>this.check(scope,controller);
  try{
   const inspect=async()=>{
    const evidence=await channel.inspect(scope,controller.signal);await check();assertSupport(evidence);
    if(evidence.accountKey!==scope.accountKey||evidence.conversationKey!==scope.conversationKey||evidence.sourceGeneration!==scope.token.source_generation)throw new StorageFailure('history_external_scope_changed');
    return evidence;
   };
   let report=await inspect();
   const emptyCandidate=await this.storage.execute<{goalId:string;report:HistorySupportReport;target:HistoryTarget}|null>('history.emptyTargetProbeCandidate',{token:scope.token});
   // 正常失守卫后报告变化须先走当前目标与守卫重验；报告未变时仍只探测空目标元数据。
   const emptyReportNeedsRevalidation=metadataRevalidation&&emptyCandidate&&serializeSupport(report)!==serializeSupport(emptyCandidate.report);
   if(emptyCandidate&&!emptyReportNeedsRevalidation&&!isPartitionGrowthTargetChange(emptyCandidate.report,report)){
    if(serializeSupport(report)!==serializeSupport(emptyCandidate.report))throw new StorageFailure('history_support_changed');
    const emptyTarget=await channel.target(scope,controller.signal);await check();
    const afterTarget=await inspect();
    if(serializeSupport(afterTarget)!==serializeSupport(report)){
     if(!isPartitionGrowthTargetChange(report,afterTarget))throw new StorageFailure('history_support_changed');
     report=afterTarget;
    }else{
     const verified=await this.storage.execute<boolean>('history.emptyTargetProbeVerify',{token:scope.token,goalId:emptyCandidate.goalId,report,target:emptyTarget});
     if(!verified)throw new StorageFailure('history_source_continuity_unverified');
     await check();releaseNormalUseGuard();
     return await this.coverage(contactId);
    }
   }
   const normalUse=report.continuity==='same-source-instances-normal-use-v1';
   const retainedReport=retainedGuardAvailable?this.retained.get(contactId)?.report:undefined;
   const reportGrowth=retainedReport?isPartitionGrowthTargetChange(retainedReport,report)
    :await this.storage.execute<boolean>('history.partitionGrowthCandidate',{token:scope.token,report});
   const freshTarget=normalUse&&(!retainedGuardAvailable||metadataRevalidation||reportGrowth)?await this.resumeOrTarget(scope,channel,report,controller.signal):undefined;
   if(freshTarget)await check();
   const armed=await armGuard(freshTarget?{report,target:freshTarget}:undefined),guardId=armed.guardId;
   await check();await this.storage.execute('history.guardAuthorize',{token:scope.token,guardId});this.rememberBodySupport(contactId,report,scope.token);
   if(armed.revalidated||freshTarget){
    const handoff=await this.storage.execute<PendingGoal>('history.begin',{token:scope.token,target:freshTarget,report,id:randomUUID(),at:Date.now(),recoveryCursor:freshTarget?this.recoveries.get(freshTarget)?.recovery.cursor:undefined});
    // 多联系人切换会不断产生新快照；已证明的恢复点须在本次租约内交接并读增量，不能每轮只留给首次协调器。
    const provedResume=freshTarget&&(this.resumedTargets.has(freshTarget)||Boolean(this.recoveries.get(freshTarget)?.recovery.cursor));
    // 有界交接会在预算耗尽时释放租约；旧读取器仍由首次路径持有快照直到终页。
    const durableHandoff=report.capabilities?.durableHistory==='supported'&&report.capabilities?.durableIncremental==='supported';
    if(!options.followHistoryHandoff||!provedResume||!durableHandoff){wakeGrowth=true;return await this.coverage(contactId);}
    registerGoal(handoff.id);
    try{
     for(let index=0;index<32;index++){
      await check();if(!await this.storage.execute<boolean>('history.guardCheck',{token:scope.token,guardId}))throw new StorageFailure('history_source_continuity_unverified');
      const checkpoint=index===31&&report.capabilities?.durableHistory==='supported';
      const page=await channel.page(scope,handoff.target,handoff.cursor,controller.signal,checkpoint?{checkpoint:true}:undefined);
      if(checkpoint&&!page.exhausted&&!page.checkpointCursor)throw new StorageFailure('history_page_invalid');
      await this.quarantinePageStates(contactId,scope,handoff,page);await check();
      const currentReport=await inspect();
      if(serializeSupport(currentReport)!==serializeSupport(report))throw new StorageFailure(isPartitionGrowthTargetChange(report,currentReport)?'history_target_growth_required':'history_support_changed');
      const accepted=await this.storage.execute<AcceptedPage>('history.acceptPage',{token:scope.token,goalId:handoff.id,captureId:randomUUID(),page,at:Date.now(),runtimeToken:this.storage.status.runtimeId,guardId,notifyMessageChanges:true});
      const coverage=this.publishAcceptedMessages(contactId,accepted,false);
      if(page.exhausted){
       if(!coverage.traversalComplete||!coverage.incremental?.cursorPresent||!['ready','incomplete'].includes(coverage.incremental.phase)){wakeGrowth=true;return coverage;}
       break;
      }
      handoff.cursor=page.cursorOut;
      if(index===31){wakeGrowth=true;return coverage;}
     }
    }catch(error){
     try{await this.storage.execute('history.interrupt',{token:scope.token,goalId:handoff.id,code:error instanceof StorageFailure?error.code:'history_read_interrupted'});}catch{/* 撤权或删除后的旧资格不能再更新任务。 */}throw error;
    }
   }
   if(typeof channel.tail!=='function')throw new StorageFailure('history_tail_unsupported');
   // 只有支持档明确声明增量能力才继续；仅存在方法不等于认证通过。
   if(report.capabilities?.incrementalTail!=='supported')throw new StorageFailure('history_tail_unsupported');
   const continuityTarget=await this.storage.execute<HistoryTarget|null>('history.incrementalContinuityTarget',{token:scope.token,report});
   if(continuityTarget&&!await this.storage.execute<boolean>('history.preflightContinuity',{token:scope.token,target:continuityTarget,report}))throw new StorageFailure('history_source_continuity_unverified');
   goal=await this.storage.execute<typeof goal|null>('history.incrementalPending',{token:scope.token,report})??undefined;
   if(!goal)goal=await this.storage.execute('history.beginIncremental',{token:scope.token,report,id:randomUUID(),at:Date.now()});
   if(!await this.storage.execute<boolean>('history.preflightContinuity',{token:scope.token,target:goal!.target,report}))throw new StorageFailure('history_source_continuity_unverified');
   registerGoal(goal!.id);
   for(let index=0;index<200;index++){
    await check();if(guardId&&!await this.storage.execute<boolean>('history.guardCheck',{token:scope.token,guardId}))throw new StorageFailure('history_source_continuity_unverified');const page=await channel.tail(scope,goal!.target,goal!.cursor,controller.signal);
    await this.quarantinePageStates(contactId,scope,goal!,page);
    await check();
    const currentReport=await inspect();
    if(serializeSupport(currentReport)!==serializeSupport(report)){
     if(isPartitionGrowthTargetChange(report,currentReport)){
      wakeGrowth=true;return await this.storage.execute('history.incrementalInterrupt',{ownerId:this.contacts.ownerId,contactId,goalId:goal!.id,code:'history_target_growth_required'});
     }
     throw new StorageFailure('history_support_changed');
    }
    await check();
    const accepted=await this.storage.execute<AcceptedPage>('history.acceptIncrementalPage',{token:scope.token,goalId:goal!.id,captureId:randomUUID(),page,at:Date.now(),runtimeToken:this.storage.status.runtimeId,guardId,notifyMessageChanges:true});
    const coverage=this.publishAcceptedMessages(contactId,accepted,true);
    if(page.caughtUp)return coverage;goal!.cursor=page.cursorOut;
   }
   return await this.storage.execute('history.incrementalInterrupt',{ownerId:this.contacts.ownerId,contactId,goalId:goal!.id,code:'history_page_budget_exhausted'});
  }catch(error){
   if(error instanceof StorageFailure&&error.code==='history_target_growth_required'){
    wakeGrowth=true;
    if(goal)return await this.storage.execute('history.incrementalInterrupt',{ownerId:this.contacts.ownerId,contactId,goalId:goal.id,code:error.code});
    return await this.coverage(contactId);
   }
   if(goal){try{await this.storage.execute('history.incrementalInterrupt',{ownerId:this.contacts.ownerId,contactId,goalId:goal.id,code:error instanceof StorageFailure?error.code:'history_incremental_interrupted'});}catch{/* 旧资格不允许推进水位。 */}}
   throw error;
  }
  });}finally{if(wakeGrowth)this.wakeFirstHistory(contactId);}
 }

 /** 保留条目的守卫释放：写失败后不再重写守卫；存储关闭未确认成功前每轮重试，成功只上报首个失败。 */
 private async releaseEntryGuard(entry:RetainedEntry):Promise<void>{
  if(entry.releaseFailed){
   // 已失败过：不重复守卫写入；每次重试仍须把存储关闭到确认，失败保持在先的首个错误。
   if(!entry.storageClosed){try{await this.storage.close();entry.storageClosed=true;}catch{/* 已上报的守卫释放失败继续作为首个错误。 */}}
   return;
  }
  const guardId=entry.guardId;entry.guardId=undefined;
  if(!guardId)return;
  try{
   if(!await this.storage.execute<boolean>('history.guardRelease',{token:entry.token,guardId,normalUse:entry.normalUse===true,sourceLost:entry.sourceLost===true,deferVerification:entry.deferVerification===true}))throw new StorageFailure('history_source_continuity_unverified');
  }catch(error){
   entry.releaseFailed=true;entry.guardId=guardId;
   if(!entry.storageClosed){try{await this.storage.close();entry.storageClosed=true;}catch{/* 首个失败已保留，存储关闭未确认的细节不再覆盖。 */}}
   throw error;
  }
 }
 /** 保留条目规范排空：经已登记 holder 的 close 关闭通道并清除各队列；无 holder 时直接释放并关闭。 */
 private async retireEntry(entry:RetainedEntry):Promise<void>{
  if(entry.holderRelease){await entry.holderRelease();return;}
  await this.releaseEntryGuard(entry);
  await entry.close();
 }
 async stop(contactId?:string):Promise<void>{
  if(contactId)this.bodySupport.delete(contactId);else this.bodySupport.clear();
  const preparations=[...this.sourcePreparations].filter(entry=>!contactId||entry.contactId===contactId);for(const entry of preparations)entry.controller.abort();
  const queued=[...this.queued.entries()].filter(([id])=>!contactId||id===contactId).map(([,entry])=>entry);for(const entry of queued)entry.controller.abort();
  const entries=[...this.active.entries()].filter(([id])=>!contactId||id===contactId).map(([,entry])=>entry);
  // 停读连停车任务也一并结束；守卫释放在首位，失败清空的条目留待下次停读重试，已尝试释放的其余逐项排空。
  const leased=[...this.retained.entries()].filter(([id])=>!contactId||id===contactId);
  const closable=[...this.closePendings.entries()].filter(([id])=>!contactId||id===contactId);
  for(const [id,entry] of leased){this.retained.delete(id);entry.failed=true;}
  for(const [id] of closable)this.closePendings.delete(id);
  const aims=[...closable.map(([,entry])=>entry),...leased.map(([,entry])=>entry)];
  await Promise.all(entries.map(entry=>entry.stop()));await Promise.all([...queued.map(entry=>entry.done),...preparations.map(entry=>entry.done)]);
  // 守卫释放失败在规范排空中按首个错误上报；通道关闭失败保留条目，下轮停读或来源准备先排空。
  let failure:unknown;
  for(const entry of aims){
   try{await this.retireEntry(entry);}
   catch(error){failure??=error;this.closePendings.set(entry.contactId,entry);continue;}
   this.closePendings.delete(entry.contactId);
  }
  if(failure)throw failure;
 }
 async close():Promise<void>{this.closed=true;await this.stop();}
}
