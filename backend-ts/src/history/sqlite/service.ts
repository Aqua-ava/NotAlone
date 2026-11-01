import { ActiveHolders } from '../../storage/sqlite/deletion/holders.ts';
import { randomUUID } from 'node:crypto';
import { StorageFailure } from '../../storage/sqlite/contracts.ts';
import type { SqliteStorage } from '../../storage/sqlite/client.ts';
import type { ReadEligibility } from '../../contacts/sqlite/contracts.ts';
import type { HistoryChannel, HistorySource, HistoryCoverage, HistoryImageMedia, HistoryRead, HistoryScope, HistoryTarget, HistorySupportReport, HistoryPage, HistoryTailPage } from './contracts.ts';
import { assertSupport, serializeSupport } from './actions.ts';
import { isSourceContinuityLost } from './continuity.ts';
import { isPartitionGrowthTargetChange } from '../partition-growth.ts';
import {SqliteQuoteStore} from './quote-store.ts';
export const quoteParserVersion='wechat-quote-v2';
interface PendingGoal { id:string; target:HistoryTarget; cursor:string|null }
export interface HistoryContactGateway {
 readonly ownerId:string;
 eligibility(contactId:string):Promise<ReadEligibility>;
 validate(token:ReadEligibility):Promise<unknown>;
}
interface ActiveHistoryRead { controller:AbortController; done:Promise<void>; stop():Promise<void> }
interface RetainedGuard {channel:HistoryChannel; token:ReadEligibility; report?:HistorySupportReport; target?:HistoryTarget; guardId:string; failed:boolean; sourceLost:boolean; normalUse:boolean; bodyVerified:boolean; release:()=>Promise<void>}
interface GuardProof {report:HistorySupportReport;target:HistoryTarget}
interface GuardResult {guardId?:string;revalidated:boolean}
type MessageChangeKind='created'|'updated';
type AcceptedPage=HistoryCoverage&{createdMessageIds?:string[];updatedMessageIds?:string[]};
const bodyCapabilities=['programVersion','exactSchema','declaredLocalKey','automaticAllocation','statusColumn','statusSemantics','sourceLifecycle','restartContinuity','recoveryMapping','snapshotBarrier','partitionCoverage','normalHistory','incrementalTail'] as const;
export const historyReaderHolderKey=(contactId:string,generation:string):string=>`history:read_${contactId}_${generation}`;
/** 可认证的渠道跨批次保留守卫；删除、停读及finally等待真实读者释放。 */
export class SqliteHistoryService {
 private readonly storage:SqliteStorage;
 private readonly contacts:HistoryContactGateway;
 private readonly createChannel:()=>HistoryChannel;
 readonly holders:ActiveHolders;
 private readonly onMessageChange?: (contactId:string,messageId:string,kind:MessageChangeKind)=>void;
 private readonly onAcceptedPage?: (contactId:string)=>void;
 private firstHistoryWake?: (contactId:string)=>void;
 private readonly active=new Map<string,ActiveHistoryRead>();
 private readonly guards=new Map<string,RetainedGuard>();
 private closed=false;
 constructor(storage:SqliteStorage,contacts:HistoryContactGateway,channel:HistoryChannel|(()=>HistoryChannel),holders:ActiveHolders=new ActiveHolders(),onMessageChange?:(contactId:string,messageId:string,kind:MessageChangeKind)=>void,onAcceptedPage?:(contactId:string)=>void){
  this.storage=storage;this.contacts=contacts;this.createChannel=typeof channel==='function'?channel:()=>channel;this.holders=holders;this.onMessageChange=onMessageChange;this.onAcceptedPage=onAcceptedPage;
 }
 setFirstHistoryWake(callback:(contactId:string)=>void):void {this.firstHistoryWake=callback;}
 private wakeFirstHistory(contactId:string):void {try{this.firstHistoryWake?.(contactId);}catch{/* 唤醒失败不回滚已持久化的历史目标。 */}}
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
 private async withChannel<T>(contactId:string,signal:AbortSignal|undefined,run:(scope:HistoryScope,channel:HistoryChannel,controller:AbortController,registerGoal:(goalId:string)=>void,armGuard:(proof?:GuardProof)=>Promise<GuardResult>,metadataRevalidation:boolean,retainedGuardAvailable:boolean,releaseNormalUseGuard:()=>void)=>Promise<T>):Promise<T>{
  if(this.closed)throw new StorageFailure('history_closed');
  if(this.active.has(contactId))throw new StorageFailure('history_already_running');
  const controller=new AbortController();
  let finishWork!:()=>void;const workDone=new Promise<void>(resolve=>{finishWork=resolve;});
  let finishAll!:()=>void;const done=new Promise<void>(resolve=>{finishAll=resolve;});
  let channel:HistoryChannel|undefined;let closing:Promise<void>|undefined;let retained:RetainedGuard|undefined;let finished=false;let successful=false;let releaseGuardAfterSuccess=false;
  const closeChannel=():Promise<void>=>{
   if(!channel)return Promise.resolve();
   return closing??=(async()=>{try{await channel!.close?.();}catch(error){closing=undefined;throw error;}})();
  };
  const stop=async()=>{if(finished)return;controller.abort();if(retained)await retained.release();else await closeChannel();await workDone;};
  this.active.set(contactId,{controller,done,stop});
  const releases:(()=>Promise<void>)[]=[];
  const abort=()=>{controller.abort();void (retained?retained.release():closeChannel()).catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  try{
   const previous=this.guards.get(contactId);if(previous?.failed)await previous.release();
   const token=await this.contacts.eligibility(contactId);const scope=await this.storage.execute<HistoryScope>('history.scope',{token});
   const metadataRevalidation=await this.storage.execute<boolean>('history.normalUseRevalidationCandidate',{token});
   if(!metadataRevalidation&&!await this.storage.execute<boolean>('history.preflightGeneration',{token}))throw new StorageFailure('history_source_continuity_unverified');
   await this.check(scope,controller);retained=this.guards.get(contactId);
   if(retained&&JSON.stringify(retained.token)!==JSON.stringify(token)){await retained.release();throw new StorageFailure('history_source_continuity_unverified');}
   channel=retained?.channel??this.createChannel();
   const register=(key:string,coversAllSources=false)=>releases.push(this.holders.register({key,ownerId:token.owner_id,contactId,generation:BigInt(token.data_generation),coversAllSources,close:stop}));
   // target会打开固定快照；没有goal之前也必须先登记实际读者。
   register(historyReaderHolderKey(contactId,token.data_generation),true);
   const armGuard=async(proof?:GuardProof):Promise<GuardResult>=>{
    if(retained){if(retained.failed||!await this.storage.execute<boolean>('history.guardCheck',{token,guardId:retained.guardId}))throw new StorageFailure('history_source_continuity_unverified');
    if(proof){const checked=await this.storage.execute<{ok:boolean;revalidated:boolean}>('history.prepareNormalUseGuard',{token,target:proof.target,report:proof.report,guardId:retained.guardId});if(!checked.ok)throw new StorageFailure('history_source_continuity_unverified');retained.report=structuredClone(proof.report);retained.target=structuredClone(proof.target);return {guardId:retained.guardId,revalidated:checked.revalidated};}
     return {guardId:retained.guardId,revalidated:false};}
    if(!channel?.guardSession){if(proof)throw new StorageFailure('history_guard_invalid');return {revalidated:false};}
    const guardSession=channel.guardSession;
    if(!(guardSession.loss instanceof Promise))throw new StorageFailure('history_guard_invalid');
    const guardId=randomUUID();let revalidated=false;
    if(proof){const prepared=await this.storage.execute<{ok:boolean;revalidated:boolean}>('history.prepareNormalUseGuard',{token,target:proof.target,report:proof.report,guardId});if(!prepared.ok)throw new StorageFailure('history_source_continuity_unverified');revalidated=prepared.revalidated;}
    else if(!await this.storage.execute<boolean>('history.guardAcquire',{token,guardId}))throw new StorageFailure('history_source_continuity_unverified');
    const entry:RetainedGuard={channel,token,...(proof?{report:structuredClone(proof.report),target:structuredClone(proof.target)}:{}),guardId,failed:false,sourceLost:false,normalUse:proof!==undefined,bodyVerified:false,release:async()=>{}};
    let leaseReleased=false,releaseFailed=false,storageClosed=false;
    try{entry.release=this.holders.register({key:`history:guard_${contactId}_${token.data_generation}`,ownerId:token.owner_id,contactId,generation:BigInt(token.data_generation),coversAllSources:true,close:async()=>{
     entry.failed=true;this.active.get(contactId)?.controller.abort();
     let failure:unknown;
     if(!leaseReleased&&!releaseFailed)try{
      if(!await this.storage.execute<boolean>('history.guardRelease',{token,guardId,normalUse:entry.normalUse,sourceLost:entry.sourceLost}))throw new StorageFailure('history_source_continuity_unverified');
      leaseReleased=true;
     }catch(error){releaseFailed=true;failure=error;}
     // 持久失证失败后先使存储失能；重试只排空尚未确认关闭的资源，不再访问旧库。
     if(releaseFailed&&!storageClosed)try{await this.storage.close();storageClosed=true;}catch(error){failure??=error;}
     try{await entry.channel.close?.();}catch(error){failure??=error;}
     if(failure)throw failure;
     if(this.guards.get(contactId)===entry)this.guards.delete(contactId);
    }});}catch(error){await this.storage.execute('history.guardRelease',{token,guardId,normalUse:entry.normalUse,sourceLost:entry.sourceLost});throw error;}
    this.guards.set(contactId,entry);retained=entry;
    const lost=()=>{if(!entry.failed){entry.failed=true;this.active.get(contactId)?.controller.abort();
     const code=guardSession.failureCode?.();entry.sourceLost=typeof code==='string'&&isSourceContinuityLost(new StorageFailure(code));
     const release=async()=>{if(entry.sourceLost)await this.storage.execute('history.markContinuityLost',{token});await entry.release();};void release().catch(()=>{});}};
    void guardSession.loss.then(lost,lost);
    return {guardId,revalidated};
   };
   const releaseNormalUseGuard=()=>{if(retained?.normalUse&&!retained.failed&&!retained.sourceLost)releaseGuardAfterSuccess=true;};
   try{const result=await run(scope,channel,controller,goalId=>register(`history:${goalId}`),armGuard,metadataRevalidation,Boolean(retained),releaseNormalUseGuard);if(retained?.failed)throw new StorageFailure('history_source_continuity_unverified');successful=true;return result;}
   catch(error){if(isSourceContinuityLost(error))await this.storage.execute('history.markContinuityLost',{token});throw error;}
  }finally{
   let cleanupError:unknown;
   const intentionalRelease=successful&&releaseGuardAfterSuccess&&Boolean(retained?.normalUse&&!retained.failed&&!retained.sourceLost);
   try{if(retained&&(!successful||retained.failed||intentionalRelease))await retained.release();else if(!retained)await closeChannel();if(successful&&retained?.failed&&!intentionalRelease)cleanupError=new StorageFailure('history_source_continuity_unverified');}catch(error){cleanupError=error;}
   finished=true;finishWork();
   try{for(const release of releases.reverse())await release();}catch(error){cleanupError??=error;}
   finally{this.active.delete(contactId);signal?.removeEventListener('abort',abort);finishAll();}
   if(cleanupError)throw cleanupError;
  }
 }
 private async check(scope:HistoryScope,controller:AbortController):Promise<void>{
  if(controller.signal.aborted||this.closed)throw new StorageFailure('history_interrupted');
  await this.contacts.validate(scope.token);
 }
 /** 状态查询只复验已存在的活守卫与授权，不创建渠道、不读取微信正文。 */
 async bodyAvailable(contactIds:readonly string[]):Promise<boolean>{
  if(this.closed)return false;
  for(const contactId of contactIds){
   const guard=this.guards.get(contactId);
   if(!guard||guard.failed||!guard.bodyVerified)continue;
   try{
    await this.contacts.validate(guard.token);
    if(await this.storage.execute<boolean>('history.guardCheck',{token:guard.token,guardId:guard.guardId})
      &&!this.closed&&!guard.failed&&this.guards.get(contactId)===guard)return true;
   }catch{/* 资格或守卫已失效时保持不可用，不因状态查询恢复读取。 */}
  }
  return false;
 }
 private rememberBodySupport(contactId:string,report:HistorySupportReport):void{
  const guard=this.guards.get(contactId);
  if(guard)guard.bodyVerified=report.status==='supported'&&bodyCapabilities.every(key=>report.capabilities?.[key]==='supported');
 }
 support(contactId:string):Promise<HistorySupportReport>{return this.withChannel(contactId,undefined,async(scope,channel,controller)=>{const report=await channel.inspect(scope,controller.signal);await this.check(scope,controller);return report;});}
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
  return this.withChannel(contactId,signal,async(scope,channel,controller,_register,armGuard)=>{
   if(!channel.readQuote)return {processed:0,more:false};
   const report=await channel.inspect(scope,controller.signal);await this.check(scope,controller);assertSupport(report);
   if(report.accountKey!==scope.accountKey||report.conversationKey!==scope.conversationKey||report.sourceGeneration!==scope.token.source_generation)throw new StorageFailure('history_external_scope_changed');
   const normalUse=report.continuity==='same-source-instances-normal-use-v1',guard=this.guards.get(contactId);
   // 引用只借用普通同步已认证的固定目标，不重新建立目标或改写文字检查点。
   if(normalUse&&(!guard?.bodyVerified||!guard.target||!guard.report||serializeSupport(guard.report)!==serializeSupport(report)))return {processed:0,more:false};
   const target=normalUse?guard!.target!:await channel.target(scope,controller.signal);await this.check(scope,controller);
   await armGuard();let processed=0;
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
 }
 async imageMedia(contactId:string,messageIds:readonly string[]):Promise<ReadonlyMap<string,HistoryImageMedia>>{
  if(this.closed)throw new StorageFailure('history_closed');
  const rows=await this.storage.execute<{message_id:string;media_state:string|null;attempt_state:string|null;error_code:string|null;file_id:string|null;mime_type:string|null;image_quality:string|null}[]>(
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
   summaries.set(row.message_id,{state:row.image_quality==='original'?'original':'available',fileId:row.file_id,mimeType:row.mime_type});continue;
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
 waitForReadIdle(contactId:string):Promise<void>{return this.active.get(contactId)?.done??Promise.resolve();}
 coverage(contactId:string):Promise<HistoryCoverage>{return this.storage.execute('history.coverage',{ownerId:this.contacts.ownerId,contactId});}
 private async resumeOrTarget(scope:HistoryScope,channel:HistoryChannel,report:HistorySupportReport,signal:AbortSignal):Promise<HistoryTarget>{
  if(channel.resumeTarget&&report.capabilities?.durableIncremental==='supported'){
   const checkpoint=await this.storage.execute<{target:HistoryTarget;cursor:string}|null>('history.resumeCheckpoint',{token:scope.token,report});
   if(checkpoint){const resumed=await channel.resumeTarget(scope,checkpoint.target,checkpoint.cursor,signal);await this.contacts.validate(scope.token);if(resumed)return resumed;}
  }
  return channel.target(scope,signal);
 }
 coverages(contactIds:readonly string[]):Promise<HistoryCoverage[]>{
  if(contactIds.length>16)throw new StorageFailure('history_request_invalid');
  return this.storage.execute('history.coverages',{ownerId:this.contacts.ownerId,contactIds});
 }
 async synchronize(contactId:string,signal?:AbortSignal):Promise<HistoryCoverage>{
  let wakeGrowth=false;
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
   const retainedReport=retainedGuardAvailable?this.guards.get(contactId)?.report:undefined;
   const reportGrowth=retainedReport?isPartitionGrowthTargetChange(retainedReport,report)
    :await this.storage.execute<boolean>('history.partitionGrowthCandidate',{token:scope.token,report});
   if(normalUse&&retainedGuardAvailable&&!metadataRevalidation){
    const coverage=await this.coverage(contactId);
    // 未核验旧行不使已经交接的固定快照复活；后续变化由独立增量目标跟进。
    if(coverage.failureCode==='history_identity_quarantined'&&coverage.traversalComplete&&coverage.incremental?.cursorPresent
      &&['ready','incomplete'].includes(coverage.incremental.phase)){
     const armed=await armGuard();await check();await this.storage.execute('history.guardAuthorize',{token:scope.token,guardId:armed.guardId});
     this.rememberBodySupport(contactId,report);return coverage;
    }
   }
   const pendingOnRetainedGuard=normalUse&&retainedGuardAvailable&&!metadataRevalidation&&!reportGrowth
    ?await this.storage.execute<PendingGoal|null>('history.pending',{token:scope.token,report})??undefined:undefined;
   const freshTarget=normalUse&&!pendingOnRetainedGuard?await this.resumeOrTarget(scope,channel,report,controller.signal):undefined;
   if(freshTarget)await check();
   const armed=await armGuard(normalUse&&!pendingOnRetainedGuard?{report,target:freshTarget!}:undefined),guardId=armed.guardId;
   await check();await this.storage.execute('history.guardAuthorize',{token:scope.token,guardId});this.rememberBodySupport(contactId,report);
   goal=armed.revalidated||reportGrowth?undefined:pendingOnRetainedGuard??await this.storage.execute<PendingGoal|null>('history.pending',{token:scope.token,report})??undefined;
   if(!goal){const target=freshTarget??await channel.target(scope,controller.signal);await check();
    if(!await this.storage.execute<boolean>('history.preflightContinuity',{token:scope.token,target,report}))throw new StorageFailure('history_source_continuity_unverified');
    goal=await this.storage.execute('history.begin',{token:scope.token,target,report,id:randomUUID(),at:Date.now()});}
   if(!await this.storage.execute<boolean>('history.preflightContinuity',{token:scope.token,target:goal!.target,report}))throw new StorageFailure('history_source_continuity_unverified');
   registerGoal(goal!.id);
   for(let index=0;index<1000;index++){
    await check();if(guardId&&!await this.storage.execute<boolean>('history.guardCheck',{token:scope.token,guardId}))throw new StorageFailure('history_source_continuity_unverified');const page=await channel.page(scope,goal!.target,goal!.cursor,controller.signal);
    await this.quarantinePageStates(contactId,scope,goal!,page);
    await check();
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
 async synchronizeIncremental(contactId:string,signal?:AbortSignal):Promise<HistoryCoverage>{
  let wakeGrowth=false;
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
   if(emptyCandidate&&!isPartitionGrowthTargetChange(emptyCandidate.report,report)){
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
   const retainedReport=retainedGuardAvailable?this.guards.get(contactId)?.report:undefined;
   const reportGrowth=retainedReport?isPartitionGrowthTargetChange(retainedReport,report)
    :await this.storage.execute<boolean>('history.partitionGrowthCandidate',{token:scope.token,report});
   const freshTarget=normalUse&&(!retainedGuardAvailable||metadataRevalidation||reportGrowth)?await this.resumeOrTarget(scope,channel,report,controller.signal):undefined;
   if(freshTarget)await check();
   const armed=await armGuard(freshTarget?{report,target:freshTarget}:undefined),guardId=armed.guardId;
   await check();await this.storage.execute('history.guardAuthorize',{token:scope.token,guardId});this.rememberBodySupport(contactId,report);
   if(armed.revalidated||freshTarget){
    await this.storage.execute('history.begin',{token:scope.token,target:freshTarget,report,id:randomUUID(),at:Date.now()});
    if(reportGrowth)wakeGrowth=true;
    return await this.storage.execute<HistoryCoverage>('history.coverage',{ownerId:this.contacts.ownerId,contactId});
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
 async stop(contactId?:string):Promise<void>{const entries=[...this.active.entries()].filter(([id])=>!contactId||id===contactId).map(([,entry])=>entry);const guards=[...this.guards.entries()].filter(([id])=>!contactId||id===contactId).map(([,entry])=>entry);await Promise.all([...entries.map(entry=>entry.stop()),...guards.map(entry=>entry.release())]);await Promise.all(entries.map(entry=>entry.done));}
 async close():Promise<void>{this.closed=true;await this.stop();}
}
