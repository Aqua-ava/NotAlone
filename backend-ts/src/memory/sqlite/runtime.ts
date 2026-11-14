import {MemoryContentRegistry,memoryContentPlugin,type MemoryContentResources} from '../content/registry.ts';
import {builtinMemoryContentPlugins} from '../content/builtins.ts';
import {randomUUID} from 'node:crypto';
import {SqliteMemoryAdjudication} from './management/adjudication-service.ts';
import {createSqliteAdjudicationModelPort} from './management/model-port.ts';
import {getOrCreateAnonymousUserId} from '@deepseek-ai/dsh-anonymous-user-id';
import {mkdir,lstat} from 'node:fs/promises';
import type {Context} from '@deepseek-ai/cordis';
import type {IncomingMessage} from 'node:http';
import type {SqliteStorage} from '../../storage/sqlite/client.ts';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import {ActiveHolders} from '../../storage/sqlite/deletion/holders.ts';
import {resolveHostReplyConfiguration,type HostReplyConfiguration} from '../../host/host-reply-config.ts';
import {startModelHost} from '../../platform/models/model-host.ts';
import type {installModelProvider} from '../../platform/models/model-provider.ts';
import type {ExtractionPermitEndpoint} from '../extraction/model.ts';
import {createSqliteExtractionModelPort} from './model-port.ts';
import {SqliteMemoryExtraction,type ExtractionModelPort} from './service.ts';
import {SqliteMemoryExtractionHttp} from './http.ts';
import {SqliteMemoryDocuments} from './documents/service.ts';
import {createSqliteDocumentsModelPort} from './documents/model-port.ts';
import {SqliteMemoryL1Scheduler} from './scheduler.ts';
import {SqliteMemoryLaterWorker} from './later-worker.ts';
/** 只消费共享host的许可端点；关闭能力继续由唯一宿主持有。 */
export interface SqliteMemorySharedModel {
 configuration:HostReplyConfiguration;
 permit:ExtractionPermitEndpoint;
 provider:ReturnType<typeof installModelProvider>;
 /** 匿名身份已绑定在共享provider上；记忆分支不另建目录或生成身份。 */
 resolveUserId:()=>string;
}
/** environment须由宿主安全加载env文件；configuration可复用该宿主已冻结的同一解析结果。 */
export async function createSqliteMemoryRuntime(options:{ctx:Context;contentResources?:MemoryContentResources;contentRegistry?:MemoryContentRegistry;storage:SqliteStorage;ownerId:string;userData:string;businessHome:string;infoPath:string;envFilePath:string;environment:Readonly<NodeJS.ProcessEnv>;sharedModel?:SqliteMemorySharedModel;holders:ActiveHolders;authorize(req:IncomingMessage):boolean;afterRunSettled?:(runId:string)=>Promise<unknown>;adjudicationEnabled?:boolean;ensureSourceReady?:(contactId:string)=>Promise<void>}){
 const contentRegistry=options.contentRegistry??new MemoryContentRegistry();
 if(!options.contentRegistry)await options.ctx.plugin(memoryContentPlugin,{registry:contentRegistry,plugins:builtinMemoryContentPlugins});
 const configuration=options.sharedModel?.configuration??resolveHostReplyConfiguration(options.environment,{purpose:'memory'});
 let service:SqliteMemoryExtraction;let adjudication:SqliteMemoryAdjudication|undefined;let documents:SqliteMemoryDocuments|undefined;
 let l1Scheduler:SqliteMemoryL1Scheduler|undefined;let laterWorker:SqliteMemoryLaterWorker|undefined;let schedulingStarted=false;let incrementalAdmissionAll=false;
 const incrementalAdmissionContacts=new Set<string>();
 const incrementalAdmissionDue=new Map<string,number>();
 const markAdmissionDirty=(contactId?:string)=>{if(contactId===undefined)incrementalAdmissionAll=true;else incrementalAdmissionContacts.add(contactId);};
 const scheduleContacts=async()=>{
  const contacts=await service.scheduleContacts(),active=new Set(contacts);
  for(const contactId of incrementalAdmissionDue.keys())if(!active.has(contactId))incrementalAdmissionDue.delete(contactId);
  return contacts;
 };
 const scanSchedule=async(now:number,contactIds:string[])=>{
  const snapshot=await service.scanSchedule(now,contactIds);
  for(const contactId of contactIds)incrementalAdmissionDue.delete(contactId);
  for(const row of snapshot.contacts)if(row.incrementalDueAt!==null)incrementalAdmissionDue.set(row.contactId,row.incrementalDueAt);
  return snapshot;
 };
 let modelHost:Awaited<ReturnType<typeof startModelHost>>|undefined;
 let port:ExtractionModelPort={prepare:async()=>{throw new StorageFailure('extraction_model_unconfigured');},invoke:async()=>{throw new StorageFailure('extraction_model_unconfigured');}};
 try{
  if(configuration.status==='configured'){
   let resolveUserId:Parameters<typeof createSqliteExtractionModelPort>[0]['resolveUserId'];
   if(!options.sharedModel){
   modelHost=await startModelHost({runtimeEnvironment:{...options.environment,NOTALONE_MANAGED_USER_DATA:options.userData},businessHome:options.businessHome,infoPath:options.infoPath,envFilePath:options.envFilePath,
    accounting:{reserve:async(r,c)=>{await service.accounting.reserve(r,c);},recordReserved:async r=>{await service.accounting.recordReserved(r);},unconfirmedRequests:s=>service.accounting.unconfirmedRequests!(s)}});
   const identityHome=modelHost.identityHome;await mkdir(identityHome,{recursive:true,mode:0o700});const identity=await lstat(identityHome);if(!identity.isDirectory()||(identity.mode&0o077)!==0||process.getuid&&identity.uid!==process.getuid())throw new StorageFailure('memory_model_identity_not_private');const anonymousId=getOrCreateAnonymousUserId({env:{DSH_HOME:identityHome}});
   resolveUserId=()=>anonymousId;
   }
   port=createSqliteExtractionModelPort({ctx:options.ctx,configuration,permit:options.sharedModel?.permit??modelHost!.permit,resolveUserId,
    ...(options.sharedModel?{provider:options.sharedModel.provider}:{}),
    authorizePurpose:async({purpose,scope},signal)=>{signal.throwIfAborted();if(scope.owner_id!==options.ownerId||!['extraction','verification'].includes(purpose))throw new StorageFailure('memory_extraction_model_scope_invalid');}});
  }
  if(options.adjudicationEnabled){
   const adjudicationPort=options.sharedModel&&configuration.status==='configured'?createSqliteAdjudicationModelPort({ctx:options.ctx,configuration,provider:options.sharedModel.provider,permit:options.sharedModel.permit,authorizePurpose:async({scope},signal)=>{signal.throwIfAborted();if(scope.owner_id!==options.ownerId)throw new StorageFailure('memory_adjudication_scope_invalid');}}):undefined;
   adjudication=new SqliteMemoryAdjudication(options.storage,options.ownerId,adjudicationPort,options.holders,{registry:contentRegistry,resources:options.contentResources});await adjudication.initialize();
   const documentPort=options.sharedModel&&configuration.status==='configured'?createSqliteDocumentsModelPort({ctx:options.ctx,configuration,provider:options.sharedModel.provider,permit:options.sharedModel.permit,ownerId:options.ownerId}):undefined;
   documents=new SqliteMemoryDocuments(options.storage,options.ownerId,documentPort,options.holders);await documents.initialize();
  }
  service=new SqliteMemoryExtraction(options.storage,options.ownerId,port,options.holders,adjudication?async(runId,contactIds,followup)=>{
   if(followup?.onlyContactId){
    await adjudication!.publishRun(runId,followup.onlyContactId,{retryKnownFailures:followup.retryKnownFailures});
    await documents!.enrollRun(runId,followup.onlyContactId);
    if(followup.completeDocuments)await documents!.publishRun(runId,followup.onlyContactId,{retryKnownFailures:followup.retryKnownFailures});
    return;
   }
   await adjudication!.publishRun(runId);await documents!.enrollRun(runId);
   // 只安排持久队列，不同步等候一小时／一天的后续阶段。
   if(schedulingStarted)laterWorker?.wake();
   if(contactIds?.length)for(const contactId of contactIds){markAdmissionDirty(contactId);void l1Scheduler?.wake(contactId);}
   else{markAdmissionDirty();void l1Scheduler?.wake();}
  }:options.afterRunSettled,options.ensureSourceReady,async()=>{
   // 历史轮等待模型期间没有新的timer；已知到期联系人也须在步骤间重新读库准入。
   const now=Date.now();
   for(const [contactId,dueAt] of incrementalAdmissionDue)if(dueAt<=now)incrementalAdmissionContacts.add(contactId);
   if(!schedulingStarted||!service.automaticEnabled||!l1Scheduler||!incrementalAdmissionAll&&!incrementalAdmissionContacts.size)return;
   const all=incrementalAdmissionAll,dirty=[...incrementalAdmissionContacts];
   incrementalAdmissionAll=false;incrementalAdmissionContacts.clear();
   // 不等待scheduler.scan或新轮结束：当前scan可能正等本历史轮，等待会形成自锁。
   try{
    const contacts=all?await scheduleContacts():dirty;
    for(let offset=0;offset<contacts.length&&schedulingStarted;offset+=32){
     const now=Date.now(),snapshot=await scanSchedule(now,contacts.slice(offset,offset+32)),attempted:string[]=[];
     for(const row of snapshot.contacts){
      if(!schedulingStarted)break;
      if(row.incrementalDueAt===null||row.incrementalDueAt>now)continue;
      attempted.push(row.contactId);
      try{await service.startContact(row.contactId,randomUUID(),now);}catch{/* 单人资格变化不阻断其他已到期联系人。 */}
     }
     if(attempted.length&&schedulingStarted)await scanSchedule(Date.now(),attempted);
    }
   }catch(error){
    if(all)incrementalAdmissionAll=true;for(const contactId of dirty)incrementalAdmissionContacts.add(contactId);
    throw error;
   }
  },{registry:contentRegistry,resources:options.contentResources});await service.initialize();
  if(adjudication&&documents){
   l1Scheduler=new SqliteMemoryL1Scheduler({
    recoverBacklog:()=>service.recoverBacklog({wait:false}),
    scheduleContacts,scanSchedule,
    // 步骤和裁决由service的FIFO串行；等待自己轮次不阻止既有大轮在步骤间让出。
    startContact:async(contactId,requestKey,now)=>{const run=await service.startContact(contactId,requestKey,now);if(run)await service.waitForIdle(run.runId);return run;},
    startHistoryBatch:async(contactId,requestKey,now)=>{const run=await service.startHistoryBatch(contactId,requestKey,now);if(run)await service.waitForIdle(run.runId);return run;},
   },{enabled:()=>service.automaticEnabled});
   // 总开关关闭时主题／概览整理同样不发起模型调用；到期事实留在持久队列，开启后重新唤醒。
   laterWorker=new SqliteMemoryLaterWorker({
    nextDueAt:()=>service.automaticEnabled?documents!.nextDueAt():Promise.resolve(null),
    runDueStages:now=>service.automaticEnabled?documents!.runDueStages(now):Promise.resolve(null),
   },()=>console.error('MEMORY_LATER_SCHEDULER_FAILED'));
  }
  service.setAutomaticListener(enabled=>{
   if(!schedulingStarted)return;
   if(!enabled)return;
   // 开启后沿原进度续跑：恢复可安全续跑的积压与后续登记，再唤醒调度与后续整理。
   markAdmissionDirty();
   void service.recoverBacklog({wait:false}).then(()=>service.resumeFollowups()).catch(()=>console.error('MEMORY_FOLLOWUP_RECOVERY_FAILED')).finally(()=>{void l1Scheduler?.wake();laterWorker?.wake();});
  });
  const http=new SqliteMemoryExtractionHttp(service,options.authorize,async()=>({...await service.readSchedule(),automatic:service.automaticEnabled,...(documents?{later:await documents.queueSummary()}:{})}));let closing:Promise<void>|undefined;
  return {service,http,documents,configurationState:configuration.status,
   startScheduling(){if(schedulingStarted)return;schedulingStarted=true;void service.recoverBacklog({wait:false}).then(()=>service.resumeFollowups()).catch(()=>console.error('MEMORY_FOLLOWUP_RECOVERY_FAILED')).finally(()=>{if(schedulingStarted){void l1Scheduler?.start();laterWorker?.start();}});},
   wake(contactId?:string){if(!schedulingStarted)return;markAdmissionDirty(contactId);void l1Scheduler?.wake(contactId);laterWorker?.wake();},
   close:()=>closing??=(async()=>{
   // 自有许可先停领；业务释放失败时保留host，重试成功后才关闭其账本与socket。
   schedulingStarted=false;modelHost?.arbiter.stop();await Promise.all([l1Scheduler?.close(),laterWorker?.close(),service.close(),adjudication?.close(),documents?.close()]);if(modelHost)await modelHost.close(async()=>{});
  })().catch(error=>{closing=undefined;throw error;})};
 }catch(error){await documents?.close();await adjudication?.close();await port.close?.();await modelHost?.shutdown();throw error;}
}
