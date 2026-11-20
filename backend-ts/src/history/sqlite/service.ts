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
import { isSourceContinuityLost, normalUseContinuity, type ResumedCheckpoint } from './continuity.ts';
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
interface HistoryReadActivity {
 request?:{controller:AbortController;done:Promise<void>};
 // 请求可能已返回，关闭失败的实际租约仍须保留供排空重试。
 releaseLease?:()=>Promise<void>;
}
interface GuardProof {report:HistorySupportReport;target:HistoryTarget}
interface GuardResult {guardId?:string;revalidated:boolean;resumedGoalId?:string}
interface HistoryLease {
 scope:HistoryScope;channel:HistoryChannel;controller:AbortController;metadataRevalidation:boolean;
 registerGoal(goalId:string):void;armGuard(proof?:GuardProof):Promise<GuardResult>;
 retireCheckpoint(goalId:string,checkpoint:ResumedCheckpoint):void;
}
type MessageChangeKind='created'|'updated';
type AcceptedPage=HistoryCoverage&{createdMessageIds?:string[];updatedMessageIds?:string[]};
const bodyCapabilities=['programVersion','exactSchema','declaredLocalKey','automaticAllocation','statusColumn','statusSemantics','sourceLifecycle','restartContinuity','recoveryMapping','snapshotBarrier','partitionCoverage','normalHistory','incrementalTail'] as const;
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
 private readonly reads=new Map<string,HistoryReadActivity>();
 private readonly bodySupport=new Map<string,ReadEligibility>();
 private readonly recoveries=new WeakMap<HistoryTarget,{planDigest:string;recovery:HistoryRecoveryResult}>();
 private readonly resumedTargets=new WeakMap<HistoryTarget,ResumedCheckpoint>();
 private closed=false;
 private readonly shared?:SharedWechatClient;
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
 private async withChannel<T>(contactId:string,signal:AbortSignal|undefined,run:(lease:HistoryLease)=>Promise<T>):Promise<T>{
  if(this.closed)throw new StorageFailure('history_closed');
  const activity=this.reads.get(contactId)??{};
  if(activity.request)throw new StorageFailure('history_already_running');
  const controller=new AbortController(),finished=Promise.withResolvers<void>();
  activity.request={controller,done:finished.promise};this.reads.set(contactId,activity);
  const combined=signal?AbortSignal.any([controller.signal,signal]):controller.signal;
  try{
   if(!this.shared)return await this.withExclusiveChannel(contactId,activity,combined,run);
   return await this.shared.run(contactId,async()=>{
    // 上轮真实关闭失败时先重试排空，再允许同一共享进程进入下一轮。
    const previousLeases=[...this.reads.values()].flatMap(read=>read.releaseLease?[read.releaseLease]:[]);
    for(const release of previousLeases)await release();
    return this.withExclusiveChannel(contactId,activity,combined,run);
   },undefined,combined);
  }
  finally{activity.request=undefined;this.forgetReleasedRead(contactId,activity);finished.resolve();}
 }
 private forgetReleasedRead(contactId:string,activity:HistoryReadActivity):void{
  if(!activity.request&&!activity.releaseLease)this.reads.delete(contactId);
 }
 /** 守卫、渠道与删除持有者属于本轮租约；释放失败时保留排空操作。 */
 private async withExclusiveChannel<T>(contactId:string,activity:HistoryReadActivity,signal:AbortSignal,run:(lease:HistoryLease)=>Promise<T>):Promise<T>{
  if(this.closed)throw new StorageFailure('history_closed');
  if(activity.releaseLease)throw new StorageFailure('history_already_running');
  const controller=new AbortController(),work=Promise.withResolvers<void>();
  let workFinished=false,workSucceeded=false,leaseSettled=false,intentionalClose=false,sourceLost=false;
  let channel:HistoryChannel|undefined,token:ReadEligibility|undefined,guardId:string|undefined,lossCode:string|undefined;
  let channelClosed=false,releaseFailed=false,storageClosed=false;
  let channelClosing:Promise<void>|undefined,releasing:Promise<void>|undefined,cleaning:Promise<void>|undefined;
  const releases:(()=>Promise<void>)[]=[];
  const retiredCheckpoints=new Map<string,ResumedCheckpoint>();
  const drained=()=>channelClosed&&(!guardId||releaseFailed&&storageClosed);
  const closeChannel=()=>{
   intentionalClose=true;
   if(!channel){channelClosed=true;return Promise.resolve();}
   return channelClosing??=Promise.resolve().then(()=>channel!.close?.()).then(()=>{channelClosed=true;}).catch(error=>{channelClosing=undefined;throw error;});
  };
  const releaseGuard=()=>releasing??=(async()=>{
   if(releaseFailed){if(!storageClosed){await this.storage.close();storageClosed=true;}return;}
   if(!guardId||!token)return;
   try{
    if(!await this.storage.execute<boolean>('history.guardRelease',{token,guardId,sourceLost}))throw new StorageFailure('history_source_continuity_unverified');
    guardId=undefined;
   }catch(error){
    releaseFailed=true;
    try{await this.storage.close();storageClosed=true;}catch{/* 首个释放失败先上报；停读仍须重试尚未确认的存储关闭。 */}
    throw error;
   }
  })().catch(error=>{releasing=undefined;throw error;});
  const cleanup=()=>cleaning??=(async()=>{
   let failure:unknown;
   try{await releaseGuard();}catch(error){failure=error;}
   try{await closeChannel();}catch(error){failure??=error;}
   if(drained()){
    activity.releaseLease=undefined;
    this.forgetReleasedRead(contactId,activity);
   }
   if(failure)throw failure;
  })().catch(error=>{cleaning=undefined;throw error;});
  const stop=async()=>{
   if(!workFinished){controller.abort();void closeChannel().catch(()=>{});await work.promise;}
   await cleanup();
  };
  const register=(key:string,coversAllSources=false)=>{
   const resource:Parameters<ActiveHolders['register']>[0]={key,ownerId:token!.owner_id,contactId,generation:BigInt(token!.data_generation),coversAllSources,close:async()=>{
    try{await stop();}catch(error){if(drained())resource.releasedOnFailure=true;throw error;}
   }};
   const release=this.holders.register(resource);releases.push(release);return release;
  };
  let releaseReader:(()=>Promise<void>)|undefined;
  activity.releaseLease=()=>releaseReader?releaseReader():stop();
  const abort=()=>{controller.abort();void closeChannel().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  try{
   token=await this.contacts.eligibility(contactId);const scope=await this.storage.execute<HistoryScope>('history.scope',{token});
   const {ok,metadataRevalidation}=await this.storage.execute<{ok:boolean;metadataRevalidation:boolean}>('history.readPreflight',{token});
   if(!ok)throw new StorageFailure('history_source_continuity_unverified');
   await this.check(scope,controller);
   channel=this.createChannel();channelClosed=false;releaseReader=register(historyReaderHolderKey(contactId,token.data_generation),true);
   const armGuard=async(proof?:GuardProof):Promise<GuardResult>=>{
    if(!channel!.guardSession){if(proof)throw new StorageFailure('history_guard_invalid');return {revalidated:false};}
    if(guardId||!(channel!.guardSession.loss instanceof Promise))throw new StorageFailure('history_guard_invalid');
    const session=channel!.guardSession,recovery=proof?this.recoveries.get(proof.target):undefined,candidateId=randomUUID();
    const prepared=proof?await this.storage.execute<{ok:boolean;revalidated:boolean;resumedGoalId?:string}>(recovery?'history.prepareRecoveredGuard':'history.prepareNormalUseGuard',{token,target:proof.target,report:proof.report,guardId:candidateId,...recovery,...(!recovery&&this.resumedTargets.has(proof.target)?{resumedCheckpoint:this.resumedTargets.get(proof.target)}:{})})
     :{ok:await this.storage.execute<boolean>('history.guardAcquire',{token,guardId:candidateId}),revalidated:false};
    if(!prepared.ok)throw new StorageFailure('history_source_continuity_unverified');
    guardId=candidateId;
    const lost=()=>{
     if(intentionalClose||leaseSettled)return;
     const code=session.failureCode?.()??'history_source_unverified';lossCode=code;
     if(isSourceContinuityLost(new StorageFailure(code)))sourceLost=true;
     controller.abort();this.bodySupport.delete(contactId);void releaseGuard().catch(()=>{});
    };
    void session.loss.then(lost,lost);return {guardId,revalidated:prepared.revalidated,...('resumedGoalId' in prepared&&prepared.resumedGoalId?{resumedGoalId:prepared.resumedGoalId}:{})};
   };
   const result=await run({scope,channel,controller,metadataRevalidation,registerGoal:goalId=>{register(`history:${goalId}`);},armGuard,retireCheckpoint:(goalId,checkpoint)=>{retiredCheckpoints.set(goalId,checkpoint);}});
   if(lossCode)throw new StorageFailure(lossCode);
   workSucceeded=true;
   return result;
  }catch(error){
   this.bodySupport.delete(contactId);
   const actual=lossCode&&!signal?.aborted&&!this.closed?new StorageFailure(lossCode):error;
   if(isSourceContinuityLost(actual)){
    sourceLost=true;
    if(token)await this.storage.execute('history.markContinuityLost',{token,errorCode:actual instanceof StorageFailure?actual.code:undefined});
   }
   throw actual;
  }finally{
   leaseSettled=true;signal?.removeEventListener('abort',abort);workFinished=true;work.resolve();
   if(releases.length){const results=await Promise.allSettled(releases.reverse().map(release=>release()));const failure=results.find(result=>result.status==='rejected');if(failure?.status==='rejected')throw failure.reason;}
   else await cleanup();
   // 新恢复点已接受且真实读者已关闭后，才退役本轮替换的空事实；失败与取消保留原恢复点。
   if(workSucceeded&&!controller.signal.aborted)for(const [goalId,checkpoint] of retiredCheckpoints)await this.storage.execute('history.retireResumedEmptyGoals',{token,replacementGoalId:goalId,checkpoint});
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
 private async readHistoryGoal(scope:HistoryScope,channel:HistoryChannel,controller:AbortController,report:HistorySupportReport,goal:PendingGoal,guardId?:string,onCheckpoint?:()=>void):Promise<HistorySynchronization>{
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
   if(page.checkpointCursor||page.exhausted&&page.resumeCursor)onCheckpoint?.();
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
   try{await this.contacts.validate(token);if(await this.storage.execute<boolean>('history.bodyAvailable',{token}))return true;}catch{/* 停读、删除和真实来源失证均保持不可用。 */}
  }return false;
 }
 private rememberBodySupport(contactId:string,report:HistorySupportReport,token:ReadEligibility):void{
  if(report.status==='supported'&&bodyCapabilities.every(key=>report.capabilities?.[key]==='supported'))this.bodySupport.set(contactId,token);
  else this.bodySupport.delete(contactId);
 }
 /** 同联系人请求结束且实际租约排空后，再用新通道核对来源元数据。 */
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
    const activity=this.reads.get(contactId);
    if(activity?.request){await waitForSourceReader(activity.request.done,combined,deadline-Date.now());continue;}
    if(activity?.releaseLease){await activity.releaseLease();continue;}
    try{await this.ensureSourceReady(contactId,combined);check();return;}
    catch(error){
     if(!(error instanceof StorageFailure)||error.code!=='history_already_running')throw error;
     if(!this.reads.has(contactId))throw error;
    }
   }
  }catch(error){if(timedOut)throw new StorageFailure('history_native_timeout');throw error;}
  finally{clearTimeout(timeout);this.sourcePreparations.delete(preparation);finish();}
 }
 /** 记忆等派生处理只重验来源元数据；本次独占读取结束即释放守卫和渠道。 */
 async ensureSourceReady(contactId:string,signal?:AbortSignal):Promise<void>{
  const revalidated=await this.withChannel(contactId,signal,async({scope,channel,controller,armGuard})=>{
   const report=await this.inspectCurrent(scope,channel,controller);
   const normalUse=report.continuity===normalUseContinuity;
   const target=normalUse?await this.resumeOrTarget(scope,channel,report,controller.signal):await channel.target(scope,controller.signal);await this.check(scope,controller);
   const armed=await armGuard(normalUse?{report,target}:undefined);
   if(!await this.storage.execute<boolean>('history.preflightContinuity',{token:scope.token,target,report}))throw new StorageFailure('history_source_continuity_unverified');
   await this.check(scope,controller);await this.storage.execute('history.guardAuthorize',{token:scope.token,guardId:armed.guardId});
   return armed.revalidated;
  });
  // 成功重验会使旧未完目标失效；释放租约后再交回首次历史，失败不派发完成唤醒。
  if(revalidated&&!(await this.coverage(contactId)).traversalComplete)this.wakeFirstHistory(contactId);
 }
 support(contactId:string):Promise<HistorySupportReport>{return this.withChannel(contactId,undefined,async({scope,channel,controller})=>{const report=await channel.inspect(scope,controller.signal);await this.check(scope,controller);return report;});}
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
  const result=await this.withChannel(contactId,signal,async({scope,channel,controller,armGuard})=>{
   if(!channel.readQuote)return {processed:0,more:false};
   const report=await this.inspectCurrent(scope,channel,controller);assertSupport(report);
   if(report.accountKey!==scope.accountKey||report.conversationKey!==scope.conversationKey||report.sourceGeneration!==scope.token.source_generation)throw new StorageFailure('history_external_scope_changed');
   const normalUse=report.continuity===normalUseContinuity;
   const target=await channel.target(scope,controller.signal);await this.check(scope,controller);
   const armed=await armGuard(normalUse?{report,target}:undefined);revalidated=armed.revalidated;
   if(normalUse&&!await this.storage.execute<boolean>('history.preflightContinuity',{token:scope.token,target,report}))throw new StorageFailure('history_source_continuity_unverified');
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
 waitForReadIdle(contactId:string):Promise<void>{return this.reads.get(contactId)?.request?.done??Promise.resolve();}
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
   const checkpoint=await this.storage.execute<ResumedCheckpoint&{target:HistoryTarget}|null>('history.resumeCheckpoint',{token:scope.token,report});
   if(checkpoint){
    const resumed=channel.resumeTarget?await channel.resumeTarget(scope,checkpoint.target,checkpoint.cursor,signal):null;
    await this.contacts.validate(scope.token);
    if(resumed){this.resumedTargets.set(resumed,{goalId:checkpoint.goalId,cursor:checkpoint.cursor,target:checkpoint.target});return resumed;}
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
  try{return await this.withChannel(contactId,signal,async({scope,channel,controller,registerGoal,armGuard,retireCheckpoint})=>{
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
   const reportGrowth=await this.storage.execute<boolean>('history.partitionGrowthCandidate',{token:scope.token,report});
   const freshTarget=normalUse?await this.resumeOrTarget(scope,channel,report,controller.signal):undefined;
   if(freshTarget)await check();
   const armed=await armGuard(normalUse?{report,target:freshTarget!}:undefined),guardId=armed.guardId;
   await check();await this.storage.execute('history.guardAuthorize',{token:scope.token,guardId});this.rememberBodySupport(contactId,report,scope.token);
   // 新原生目标必须建立对应历史任务，不能再从数据库取回已经被替换的旧目标。
   goal=armed.revalidated||reportGrowth||freshTarget?undefined:await this.storage.execute<PendingGoal|null>('history.pending',{token:scope.token,report})??undefined;
   if(!goal){const target=freshTarget??await channel.target(scope,controller.signal);await check();
    if(!await this.storage.execute<boolean>('history.preflightContinuity',{token:scope.token,target,report}))throw new StorageFailure('history_source_continuity_unverified');
    goal=await this.storage.execute('history.begin',{token:scope.token,target,report,id:randomUUID(),at:Date.now(),recoveryCursor:this.recoveries.get(target)?.recovery.cursor});}
   if(!await this.storage.execute<boolean>('history.preflightContinuity',{token:scope.token,target:goal!.target,report}))throw new StorageFailure('history_source_continuity_unverified');
   registerGoal(goal!.id);
   const resumed=freshTarget&&armed.resumedGoalId?this.resumedTargets.get(freshTarget):undefined;
   return await this.readHistoryGoal(scope,channel,controller,report,goal!,guardId,resumed?()=>retireCheckpoint(goal!.id,resumed):undefined);
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
 async synchronizeIncremental(contactId:string,signal?:AbortSignal):Promise<HistoryCoverage>{  let wakeGrowth=false;
  try{return await this.withChannel(contactId,signal,async({scope,channel,controller,registerGoal,armGuard,metadataRevalidation,retireCheckpoint})=>{
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
     await check();
     return await this.coverage(contactId);
    }
   }
   const normalUse=report.continuity==='same-source-instances-normal-use-v1';
   const freshTarget=normalUse?await this.resumeOrTarget(scope,channel,report,controller.signal):undefined;
   if(freshTarget)await check();
   const armed=await armGuard(freshTarget?{report,target:freshTarget}:undefined),guardId=armed.guardId;
   await check();await this.storage.execute('history.guardAuthorize',{token:scope.token,guardId});this.rememberBodySupport(contactId,report,scope.token);
   if(armed.revalidated||freshTarget){
    const handoff=await this.storage.execute<PendingGoal>('history.begin',{token:scope.token,target:freshTarget,report,id:randomUUID(),at:Date.now(),recoveryCursor:freshTarget?this.recoveries.get(freshTarget)?.recovery.cursor:undefined});
    // 多联系人切换会不断产生新快照；已证明的恢复点须在本次租约内交接并读增量，不能每轮只留给首次协调器。
    const provedResume=freshTarget&&(this.resumedTargets.has(freshTarget)||Boolean(this.recoveries.get(freshTarget)?.recovery.cursor));
    // 有界交接会在预算耗尽时释放租约；旧读取器仍由首次路径持有快照直到终页。
    const durableHandoff=report.capabilities?.durableIncremental==='supported';
    if(!provedResume||!durableHandoff){wakeGrowth=true;return await this.coverage(contactId);}
    registerGoal(handoff.id);
    try{
     const resumed=freshTarget&&armed.resumedGoalId?this.resumedTargets.get(freshTarget):undefined;
     const coverage=await this.readHistoryGoal(scope,channel,controller,report,handoff,guardId,resumed?()=>retireCheckpoint(handoff.id,resumed):undefined);
     if(!coverage.traversalComplete||!coverage.incremental?.cursorPresent||!['ready','incomplete'].includes(coverage.incremental.phase)){wakeGrowth=true;return coverage;}
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

 /** 停止本轮读者、排队租约和来源准备；等待真实关闭，失败条目仍可再次停读。 */
 async stop(contactId?:string):Promise<void>{
  if(contactId)this.bodySupport.delete(contactId);else this.bodySupport.clear();
  const preparations=[...this.sourcePreparations].filter(entry=>!contactId||entry.contactId===contactId);for(const entry of preparations)entry.controller.abort();
  const reads=[...this.reads.entries()].filter(([id])=>!contactId||id===contactId).map(([,activity])=>activity);
  for(const activity of reads)activity.request?.controller.abort();
  const results=await Promise.allSettled([
   ...reads.map(activity=>activity.releaseLease?.()),...reads.map(activity=>activity.request?.done),...preparations.map(entry=>entry.done),
  ]);
  const failure=results.find(result=>result.status==='rejected');if(failure?.status==='rejected')throw failure.reason;
 }
 async close():Promise<void>{this.closed=true;await this.stop();}
}
