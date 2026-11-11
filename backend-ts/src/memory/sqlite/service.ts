import {currentDiagnosticTrace,newTraceId,withDiagnosticTrace,diagnose} from '../../diagnostics/context.ts';
import {createBuiltinMemoryContentRegistry} from '../content/builtins.ts';
import type {MemoryContentRegistry,MemoryContentResources,FrozenMemoryContent,PreparedMemoryContent} from '../content/registry.ts';
import {assertMultimodalAdmission} from '../extraction/multimodal.ts';
import type {SqliteStorage} from '../../storage/sqlite/client.ts';
import type {MemoryScheduleSnapshot} from './scheduler.ts';
import type {StorageRow} from '../../storage/sqlite/contracts.ts';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import {ActiveHolders} from '../../storage/sqlite/deletion/holders.ts';
import {createExtractionPolicyVersion,type ExtractionPolicyVersion} from '../extraction/policy-version.ts';
import {runExtractionFlow,type ExtractionInvocation,type ExtractionFlowOutcome} from '../extraction/flow.ts';
import {recoverImageTargets,type ImageRecoveryAttempt} from '../extraction/image-recovery.ts';
import {assertCompleteClaimAdmission} from '../extraction/verification/complete-claim.ts';
import {isSharedFailure,sharedFailureCodes} from './control.ts';
import type {CandidateVerificationReference} from './management/admission.ts';
import type {ExtractionWindow} from '../extraction/protocol.ts';
import {sha256} from '../../platform/sha256.ts';
import {MODEL_IMAGE_LIMITS,normalizeModelImageInput,ModelImageNormalizationError} from '../../platform/models/image-normalization.ts';
import {ExtractionModelError} from '../extraction/model.ts';
import type {ModelPermitAccounting,ModelTaskClaim} from '../../platform/models/model-permit-port.ts';
import type {SqliteExtractionModelInvocation,SqliteExtractionModelPreparation} from './model-port.ts';
export interface ExtractionModelPort {
 prepare(request:ExtractionInvocation,input:Pick<SqliteExtractionModelInvocation,'scope'|'signal'|'requireCurrent'>):Promise<SqliteExtractionModelPreparation>;
 invoke(request:ExtractionInvocation,input:SqliteExtractionModelInvocation):Promise<{blocks:readonly unknown[]}>;
 close?():Promise<void>;
}
interface ClaimedStep {attemptId:string;stepId:string;taskId:string;runId:string;contactId:string;rows:StorageRow[];policyConfig:unknown;claim:ModelTaskClaim}
export class SqliteMemoryExtraction {
 private afterRunSettled?:((runId:string,contactIds?:readonly string[])=>Promise<unknown>);
 private readonly ensureSourceReady?:((contactId:string)=>Promise<void>);
 private readonly content:{registry:MemoryContentRegistry;resources?:MemoryContentResources};
 private readonly afterStepSettled?:()=>Promise<void>;
 private storage:SqliteStorage;readonly ownerId:string;private model:ExtractionModelPort;readonly holders:ActiveHolders;
 private policy?:Promise<ExtractionPolicyVersion>;private initialized?:Promise<void>;private stopped=false;
 private automatic=false;private readonly pausedBySwitch=new Set<string>();private onAutomaticChanged?:(enabled:boolean)=>void;
 private closing?:Promise<void>;private pending=new Set<Promise<unknown>>();
 private turnTail:Promise<void>=Promise.resolve();
 private runs=new Map<string,Promise<void>>();private active=new Map<string,{abort:AbortController;done:Promise<void>}>();
 readonly accounting:ModelPermitAccounting;
 constructor(storage:SqliteStorage,ownerId:string,model:ExtractionModelPort,holders=new ActiveHolders(),afterRunSettled?:((runId:string,contactIds?:readonly string[])=>Promise<unknown>),ensureSourceReady?:((contactId:string)=>Promise<void>),afterStepSettled?:()=>Promise<void>,content?:{registry:MemoryContentRegistry;resources?:MemoryContentResources}){
  this.content=content??{registry:createBuiltinMemoryContentRegistry()};
  this.storage=storage;this.ownerId=ownerId;this.model=model;this.holders=holders;this.afterRunSettled=afterRunSettled;this.ensureSourceReady=ensureSourceReady;this.afterStepSettled=afterStepSettled;
  this.accounting={reserve:async(receipt,claim)=>{await this.storage.execute(claim?.step_name==='extraction_verification'?'memoryExtraction.reserve':claim?.step_name==='document_scene'||claim?.step_name==='document_profile'?'memoryDocuments.reserve':'memoryAdjudication.reserve',{receipt,claim});},recordReserved:async receipt=>{await this.storage.execute('memoryExtraction.receipt',{receipt});},unconfirmedRequests:scope=>this.storage.execute('memoryExtraction.unconfirmed',scope)};
 }
 /** 仅补同一来源的元数据续证，不换输入、预算或模型操作；第二次失败按原原因保留。 */
 private async withSourceReady<T>(contactId:string,work:()=>Promise<T>):Promise<T>{
  try{return await work();}catch(error){
   if(!(error instanceof StorageFailure)||error.code!=='history_source_not_available'||!this.ensureSourceReady)throw error;
   await this.ensureSourceReady(contactId);this.available();return work();
  }
 }
 /** 每次只执行一个提取步骤或一次后续裁决；原轮次在步骤间按FIFO让出，不重置输入和预算。 */
 private turn<T>(work:()=>Promise<T>):Promise<T>{
  const next=this.turnTail.then(work);this.turnTail=next.then(()=>{},()=>{});return next;
 }
 private version(){return this.policy??=createExtractionPolicyVersion();}
 initialize(){this.available();return this.initialized??=this.admit(async()=>{
  await this.storage.execute('memoryExtraction.recover',{ownerId:this.ownerId});
  this.automatic=(await this.storage.execute<{enabled:boolean}>('memoryExtraction.readAutomatic',{ownerId:this.ownerId})).enabled;
 });}
 /** 记忆自动处理总开关的内存镜像；真实值在库内，调度与领取入口都以它为门。 */
 get automaticEnabled():boolean{return this.automatic;}
 /** 宿主登记开关变化后的唤醒回调（重扫调度、后续整理）；只唤醒，不在回调内同步建轮。 */
 setAutomaticListener(listener:(enabled:boolean)=>void):void{this.onAutomaticChanged=listener;}
 private requireAutomatic(){if(!this.automatic){diagnose({event:'processing.control_changed',caller:'memory_processing',toState:'disabled',reasonCode:'disabled'});throw new StorageFailure('memory_auto_processing_disabled');}}
 readAutomatic():{enabled:boolean}{this.available();return {enabled:this.automatic};}
 /**
  * 关闭：不再建轮、不领取新步骤，并把正在执行的轮次按用户暂停语义停在步骤边界；
  * 开启：只继续由关闭动作本身暂停的轮次，用户手动暂停和中断状态保持原样。
  */
 async setAutomatic(enabled:boolean):Promise<{enabled:boolean}>{
  if(typeof enabled!=='boolean')throw new StorageFailure('memory_extraction_request_invalid');
  return this.admit(async()=>{
   await this.initialize();this.available();
   const was=this.automatic;
   const result=await this.storage.execute<{enabled:boolean}>('memoryExtraction.setAutomatic',{ownerId:this.ownerId,enabled});
   this.automatic=result.enabled;
   if(was&&!result.enabled){
    for(const runId of [...this.runs.keys()]){
     try{const paused=await this.storage.execute<{replayed:boolean}>('memoryExtraction.control',{ownerId:this.ownerId,runId,action:'pause'});if(!paused.replayed)this.pausedBySwitch.add(runId);}
     catch{/* 已结束或不可暂停的轮次保持原状；不影响开关本身。 */}
    }
   }else if(!was&&result.enabled){
    for(const runId of [...this.pausedBySwitch]){
     this.pausedBySwitch.delete(runId);
     try{await this.storage.execute('memoryExtraction.control',{ownerId:this.ownerId,runId,action:'continue'});this.launch(runId);}
     catch{/* 状态已被用户或其他动作改变时不强行继续。 */}
    }
   }
   try{this.onAutomaticChanged?.(result.enabled);}catch{/* 唤醒失败由持久调度的周期重扫兜底。 */}
   return {enabled:result.enabled};
  });
 }
 private available(){if(this.stopped)throw new StorageFailure('memory_extraction_closed');}
 /** 关闭也等待已受理但尚未进入run的SQLite工作，防止宿主先释放存储。 */
 private admit<T>(work:()=>Promise<T>):Promise<T>{
  this.available();const pending=Promise.resolve().then(()=>{this.available();return withDiagnosticTrace(currentDiagnosticTrace()??newTraceId(),work);});this.pending.add(pending);
  void pending.then(()=>this.pending.delete(pending),()=>this.pending.delete(pending));return pending;
 }
 async start(requestKey:string){
  return this.admit(async()=>{
  await this.initialize();this.requireAutomatic();const policy=await this.version();await policy.assertCurrent();this.available();
  const prior=await this.storage.execute<any>('memoryExtraction.findRequest',{ownerId:this.ownerId,requestKey});
  this.available();
  if(prior)return prior;
  const run=await this.storage.execute<any>('memoryExtraction.start',{ownerId:this.ownerId,requestKey,policyConfig:policy.newTaskConfig(),followupStages:this.afterRunSettled!==undefined});
  this.launch(run.runId);return run;
  });
 }
 /** 自动增量调度的只读入口；返回下一次最早到期时刻（Unix毫秒），不执行处理。 */
 nextDueAt(now=Date.now()):Promise<number|null>{this.available();return this.storage.execute('memoryExtraction.nextDueAt',{ownerId:this.ownerId,now});}
 /** 当前已满足阈值且安全门放行的联系人；实际建轮仍须在写事务内重新复验。 */
 dueContacts(now=Date.now()):Promise<string[]>{this.available();return this.storage.execute('memoryExtraction.dueContacts',{ownerId:this.ownerId,now});}
 /** 调度只取有效联系人和有界摘要，不读取候选正文。 */
 scheduleContacts():Promise<string[]>{return this.admit(()=>this.storage.execute('memoryExtraction.scheduleContacts',{ownerId:this.ownerId}));}
 scanSchedule(now:number,contactIds:string[]):Promise<MemoryScheduleSnapshot>{return this.admit(()=>this.storage.execute('memoryExtraction.scanSchedule',{ownerId:this.ownerId,now,contactIds}));}
 /** 页面只读队列摘要；pending包含被同联系人阻碍而暂不能自动建轮的增量目标。 */
 readSchedule(now=Date.now()):Promise<{pending:number;nextDueAt:number|null;blockedContacts:number}>{this.available();return this.storage.execute('memoryExtraction.readSchedule',{ownerId:this.ownerId,now});}
 /** 内部按单联系人建立一个固定增量轮；此方法不暴露给HTTP。 */
 async startContact(contactId:string,requestKey:string,now=Date.now()){
  return this.admit(async()=>{
   await this.initialize();if(!this.automatic)return null;const policy=await this.version();await policy.assertCurrent();this.available();
   const prior=await this.storage.execute<any>('memoryExtraction.findRequest',{ownerId:this.ownerId,requestKey});this.available();
   if(prior)return prior;
   const run=await this.withSourceReady(contactId,()=>this.storage.execute<any>('memoryExtraction.startContact',{ownerId:this.ownerId,contactId,requestKey,now,
    policyConfig:policy.newTaskConfig(),followupStages:this.afterRunSettled!==undefined}));
   if(run)this.launch(run.runId);return run;
  });
 }
 /** 历史与增量各自筛选，建轮事务再次核验来源和原任务状态。 */
 dueHistoryContacts(now=Date.now()):Promise<string[]>{this.available();return this.storage.execute('memoryExtraction.dueHistoryContacts',{ownerId:this.ownerId,now});}
 nextHistoryDueAt(now=Date.now()):Promise<number|null>{this.available();return this.storage.execute('memoryExtraction.nextHistoryDueAt',{ownerId:this.ownerId,now});}
 async startHistoryBatch(contactId:string,requestKey:string,now=Date.now()){
  return this.admit(async()=>{
   await this.initialize();if(!this.automatic)return null;const policy=await this.version();await policy.assertCurrent();this.available();
   const start=()=>this.storage.execute<any>('memoryExtraction.startHistoryBatch',{ownerId:this.ownerId,contactId,requestKey,now,policyConfig:policy.newTaskConfig(),followupStages:this.afterRunSettled!==undefined});
   let run;
   try{run=await start();}catch(error){
    if(!(error instanceof StorageFailure)||error.code!=='history_source_not_available'||!this.ensureSourceReady)throw error;
    await this.ensureSourceReady(contactId);this.available();run=await start();
   }
   if(run)this.launch(run.runId);return run;
  });
 }
 /** 已知失败只自动恢复一次；次数沿原任务持久保存，暂停和未知调用不受理。 */
 async recoverBacklog(options:{wait?:boolean}={}):Promise<number>{
  return this.admit(async()=>{
   await this.initialize();if(!this.automatic)return 0;const policy=await this.version();await policy.assertCurrent();
   const candidates=await this.storage.execute<{runId:string;controlVersion:number}[]>('memoryExtraction.recoverableBacklog',{ownerId:this.ownerId});let recovered=0;
   for(const candidate of candidates){
    if(this.stopped||recovered>0)break;
    try{
     const snapshot=await this.read(candidate.runId);
     if(this.ensureSourceReady)for(const task of snapshot.tasks.filter((t:any)=>t.scopeKind==='contact'))await this.ensureSourceReady(task.contactId);
     const old=await this.storage.execute('memoryExtraction.readPolicy',{ownerId:this.ownerId,runId:candidate.runId});
     try{policy.resolve(old);}catch(error){
      if((error as {code?:string}).code!=='extraction_policy_source_unavailable')throw error;
      const next=await this.storage.execute<any>('memoryExtraction.restartPolicy',{ownerId:this.ownerId,...candidate,actionVersion:candidate.controlVersion,automatic:true,policyConfig:policy.newTaskConfig()});
      if(next.launchRunId){this.launch(next.launchRunId);if(options.wait!==false)await this.waitForIdle(next.launchRunId);recovered++;}continue;
     }
     const accepted=await this.storage.execute<any>('memoryExtraction.autoContinue',{ownerId:this.ownerId,...candidate});
     if(accepted){this.launch(candidate.runId);if(options.wait!==false)await this.waitForIdle(candidate.runId);recovered++;}
    }catch{/* 单个旧轮不安全或配置仍失败时保留状态，继续检查其他联系人。 */}
   }
   return recovered;
  });
 }
 /** 用户显式初始化当前联系人的已保存文字，沿正常提取、核验和后续整理链执行。 */
 async startHistory(contactId:string,requestKey:string){
  return this.admit(async()=>{
   await this.initialize();this.requireAutomatic();const policy=await this.version();await policy.assertCurrent();this.available();
   const start=()=>this.storage.execute<any>('memoryExtraction.startHistory',{ownerId:this.ownerId,contactId,requestKey,policyConfig:policy.newTaskConfig(),followupStages:this.afterRunSettled!==undefined});
   let result;
   try{result=await start();}catch(error){
    // 正常认证会关闭读取守卫；先通过原渠道续证，再由同一事务合同重验，不能直接放行旧来源。
    if(!(error instanceof StorageFailure)||error.code!=='history_source_not_available'||!this.ensureSourceReady)throw error;
    await this.ensureSourceReady(contactId);this.available();result=await start();
   }
   if(result.launchRunId)this.launch(result.launchRunId);return result.view;
  });
 }
 /**
  * 用户显式让当前联系人遗留的待处理候选重新进入裁决：沿该轮已有的后续链执行，不新建提取轮、不领取提取目标，
  * 也不触碰其他联系人。后续链异步执行，调用方通过联系人视图观察进度；与自动处理一样受总开关约束。
  */
 async readjudicate(contactId:string){
  return this.admit(async()=>{
   await this.initialize();this.requireAutomatic();this.available();
   if(!this.afterRunSettled)throw new StorageFailure('memory_extraction_unavailable');
   const runId=await this.storage.execute<string|null>('memoryExtraction.pendingAdjudicationRun',{ownerId:this.ownerId,contactId});
   if(!runId)throw new StorageFailure('memory_extraction_no_pending_adjudication');
   if(this.runs.has(runId))throw new StorageFailure('memory_extraction_contact_busy');
   const work=this.executeFollowup(runId,false,[contactId]).finally(()=>this.runs.delete(runId));this.runs.set(runId,work);void work.catch(()=>{});
   return this.readContact(contactId);
  });
 }
 /** 重启时只恢复持久标记为pending且L1已安全结束的后续登记，不再领取提取目标。 */
 async resumeFollowups():Promise<number>{
  this.available();if(!this.afterRunSettled)return 0;
  await this.initialize();this.available();if(!this.automatic)return 0;
  const runIds=await this.storage.execute<string[]>('memoryExtraction.pendingFollowups',{ownerId:this.ownerId});let started=0;
  for(const runId of runIds)if(this.launchFollowup(runId))started++;
  return started;
 }
 private launchFollowup(runId:string):boolean{
  if(this.runs.has(runId)||this.stopped||!this.afterRunSettled||!this.automatic)return false;
  const work=this.executeFollowup(runId).finally(()=>this.runs.delete(runId));this.runs.set(runId,work);void work.catch(()=>{});return true;
 }
 private async executeFollowup(runId:string,recovering=true,contactIds?:readonly string[]):Promise<void>{
  await this.turn(async()=>{
   if(this.stopped||!this.afterRunSettled||!this.automatic)return;
   // 启动恢复必须整轮安全；本次正常收尾仍由各领域门禁隔离单联系人失败。
   const eligible=!recovering||await this.storage.execute<boolean>('memoryExtraction.followupEligible',{ownerId:this.ownerId,runId});
   if(!eligible||this.stopped)return;
   try{await this.afterRunSettled(runId,contactIds);}
   finally{if(!this.stopped)await this.storage.execute('memoryExtraction.finishLater',{ownerId:this.ownerId,runId});}
  });
 }
 read(runId?:string){this.available();return this.storage.execute<any>('memoryExtraction.read',{ownerId:this.ownerId,runId});}
 /** 当前联系人的独立进度与队列；不启动任务，也不包含本人或其他联系人的资料。 */
 readContact(contactId:string){this.available();return this.storage.execute<any>('memoryExtraction.readContact',{ownerId:this.ownerId,contactId});}
 trace(taskId:string){this.available();return this.storage.execute<any>('memoryExtraction.trace',{ownerId:this.ownerId,taskId});}
 /** 用户暂停带控制修订CAS；共享故障的宿主内暂停不带版本，仍走同一事务状态机。 */
 async pause(runId:string,actionVersion?:number,operationId?:string){return this.admit(()=>this.storage.execute<any>('memoryExtraction.control',{ownerId:this.ownerId,runId,action:'pause',...(actionVersion===undefined?{}:{actionVersion,operationId})}));}
 async continue(runId:string,actionVersion:number,operationId:string){return this.admit(async()=>{
  await this.initialize();this.available();this.requireAutomatic();const policy=await this.version();await policy.assertCurrent();
  const oldPolicy=await this.storage.execute<unknown>('memoryExtraction.readPolicy',{ownerId:this.ownerId,runId});
  try{policy.resolve(oldPolicy);}catch(error){
   if((error as {code?:string}).code!=='extraction_policy_source_unavailable')throw error;
   const next=await this.storage.execute<any>('memoryExtraction.restartPolicy',{ownerId:this.ownerId,runId,actionVersion,policyConfig:policy.newTaskConfig()});
   if(next.launchRunId)this.launch(next.launchRunId);return next.run;
  }
  const run=await this.storage.execute<any>('memoryExtraction.control',{ownerId:this.ownerId,runId,action:'continue',actionVersion,operationId});this.launch(runId);return run;
 });}
 /** 仅重试本轮已隔离图片，仍受自动处理开关、来源、待确认及未知回执门槛保护。 */
 async retryImages(runId:string,actionVersion:number,operationId:string){return this.admit(async()=>{
  await this.initialize();this.available();this.requireAutomatic();
  const run=await this.storage.execute<any>('memoryExtraction.retryImages',{ownerId:this.ownerId,runId,actionVersion,operationId});
  this.launch(runId);return run;
 });}
 /** 用户放弃裁决类未知调用后重试：账本成本仍记未知，原请求不重发；其余候选重新裁决。 */
 async abandonUnknown(runId:string,actionVersion:number,operationId:string){return this.admit(async()=>{
  await this.initialize();this.available();this.requireAutomatic();
  const run=await this.storage.execute<any>('memoryExtraction.abandonUnknown',{ownerId:this.ownerId,runId,actionVersion,operationId});
  this.launch(runId);return run;
 });}
 private launch(runId:string){if(this.runs.has(runId)||this.stopped||!this.automatic)return;const work=this.executeRun(runId).finally(()=>this.runs.delete(runId));this.runs.set(runId,work);void work.catch(()=>{});}
 async waitForIdle(runId?:string){if(runId!==undefined){await this.runs.get(runId);return;}await Promise.all([...this.runs.values()]);}
 private async executeRun(runId:string){
  const before=await this.read(runId);
  for(const task of before.tasks.filter((t:any)=>t.scopeKind==='contact')){
   if(this.stopped)break;
   while(!this.stopped){
    const more=await this.turn(async()=>{
     if(this.stopped)return false;
     let batch:ClaimedStep|null;
     try{batch=await this.withSourceReady(task.contactId,()=>this.storage.execute('memoryExtraction.claim',{ownerId:this.ownerId,runId,taskId:task.taskId}));}catch(error){
      const code=this.stopped?'memory_extraction_interrupted':error instanceof StorageFailure?error.code:'memory_extraction_claim_failed';
      await this.storage.execute('memoryExtraction.blockClaim',{ownerId:this.ownerId,runId,taskId:task.taskId,code});return false;
     }
     if(!batch)return false;
     const controller=new AbortController();let finish!:()=>void;const completed=new Promise<void>(r=>finish=r);
     const generation=BigInt((await this.storage.execute<any>('memoryExtraction.contactGeneration',{ownerId:this.ownerId,contactId:batch.contactId})).generation);
     let release:undefined|(()=>Promise<void>);
     try{
      if(this.stopped)controller.abort();
      release=this.holders.register({ownerId:this.ownerId,key:`memory:${task.taskId}`,contactId:batch.contactId,generation,close:async()=>{controller.abort();await completed;}});
      this.active.set(task.taskId,{abort:controller,done:completed});
      await this.process(batch,controller.signal);
     }catch(error){
      const code=this.stopped?'memory_extraction_interrupted':error instanceof StorageFailure?error.code:typeof (error as any)?.code==='string'&&/^(?:extraction_model_|extraction_policy_|extraction_runtime_)/.test((error as any).code)?(error as any).code:'memory_extraction_failed';
      await this.storage.execute('memoryExtraction.fail',{ownerId:this.ownerId,attemptId:batch.attemptId,code});
      if(isSharedFailure(code))await this.pause(runId);
      return false;
     }finally{this.active.delete(task.taskId);finish();await release?.();}
     return true;
    });
    if(!more)break;
    // 已提交并释放本步后先完成增量准入，再领取下一历史步；回调只建轮，不等待模型。
    if(!this.stopped)try{await this.afterStepSettled?.();}catch{/* 短暂扫描失败由下一步或持久调度重查，不回滚已成功步骤。 */}
   }
  }
  if(!this.stopped){
   // 后续文档阶段的暂停边界由09在领取动作内复验；提取层只保证不自动重试失败模型。
   await this.turn(async()=>{if(!this.stopped)await this.storage.execute('memoryExtraction.settleRun',{ownerId:this.ownerId,runId,laterWork:!!this.afterRunSettled});});
   if(this.afterRunSettled&&!this.stopped)await this.executeFollowup(runId,false,before.tasks.filter((task:any)=>task.scopeKind==='contact').map((task:any)=>String(task.contactId)));
  }
 }
 private async process(batch:ClaimedStep,signal:AbortSignal){
  const policy=await this.version();const resolved=policy.resolve(batch.policyConfig);
  const requireCurrent=async()=>{signal.throwIfAborted();await policy.assertCurrent();await this.withSourceReady(batch.contactId,()=>this.storage.execute('memoryExtraction.current',{ownerId:this.ownerId,attemptId:batch.attemptId}));};
  const rows=[...batch.rows].sort((a,b)=>a.sent_at!==null&&b.sent_at!==null&&a.sent_at!==b.sent_at?Number((a.sent_at as bigint)-(b.sent_at as bigint)):a.display_no!==undefined&&b.display_no!==undefined?Number((a.display_no as bigint)-(b.display_no as bigint)):Number(a.input_no)-Number(b.input_no));
  const prepared=new Map<number,PreparedMemoryContent>();
  const isolate=async(row:StorageRow)=>{
   const result=await this.storage.execute<{paused:boolean}>('memoryExtraction.isolateImage',{ownerId:this.ownerId,attemptId:batch.attemptId,inputNo:Number(row.input_no)});
   if(result.paused)throw new StorageFailure('memory_image_input_circuit_open');
  };
  for(const row of rows){
   const frozen:FrozenMemoryContent=row.identity_json?{pluginId:String(row.plugin_id),pluginVersion:String(row.plugin_version),kind:String(row.content_kind),identity:JSON.parse(String(row.identity_json))}:
    {pluginId:'notalone.text',pluginVersion:'1',kind:'text',identity:{}};
   try{prepared.set(Number(row.input_no),await this.content.registry.prepare({ownerId:this.ownerId,contactId:batch.contactId,message:{...row,id:row.message_id,kind:row.message_kind??'text'},frozen,resources:this.content.resources,signal,requireCurrent}));}
   catch(error){
    if(!(error instanceof ModelImageNormalizationError)||frozen.kind!=='image')throw error;
    await requireCurrent();
    if(row.role==='target')await isolate(row);
    else await this.storage.execute('memoryExtraction.event',{ownerId:this.ownerId,attemptId:batch.attemptId,kind:'image_context_omitted',payload:{reason:'media_model_input_unavailable'},inputNos:[Number(row.input_no)]});
   }
  }
  const activeRows=rows.filter(row=>prepared.has(Number(row.input_no))),unchangedVariants=new Set<number>();
  const hasImage=(row:StorageRow)=>!!prepared.get(Number(row.input_no))?.images?.length;
  const groupRows=(targets:readonly StorageRow[],includeImageContext:boolean)=>activeRows.filter(row=>targets.includes(row)||row.role==='context'&&(includeImageContext||!hasImage(row)));
  const runGroup=async(targets:readonly StorageRow[],attempt:ImageRecoveryAttempt)=>{
  const selected=groupRows(targets,attempt.includeImageContext),actualNos=selected.map(row=>Number(row.input_no));
  const contents=await Promise.all(selected.map(async row=>{
   const part=prepared.get(Number(row.input_no))!;
   try{return attempt.tier==='degraded'&&part.images?.length?{...part,images:await Promise.all(part.images.map(image=>normalizeModelImageInput(image,{tier:'degraded',signal})))}:part;}
   catch(error){if(error instanceof ModelImageNormalizationError&&error.code==='extraction_model_image_variant_unchanged')unchangedVariants.add(attempt.slot);throw error;}
  }));
  const images=contents.flatMap(part=>part.images??[]);
  if(images.length>MODEL_IMAGE_LIMITS.maxImagesPerMessage||images.reduce((total,image)=>total+Buffer.byteLength(image.dataBase64,'base64'),0)>MODEL_IMAGE_LIMITS.maxMessageImageBytes)throw new StorageFailure('memory_content_input_too_large');
  const window:ExtractionWindow={owner_id:this.ownerId,contact_id:batch.contactId,target_message_ids:targets.map(row=>String(row.message_id)),messages:contents.map(part=>part.message)};
  let commonFailure:string|null=null;let modelFailure:string|null=null;
  let lastModelFailure:unknown;
  let verificationInputEventId:string|null=null,verificationCall:{callId:string;reused:boolean}|null=null;
  const verificationEvents=new Map<string,string>();
  const commonCodes=[...sharedFailureCodes];
  const outcome=await runExtractionFlow({window,images,signal,mode:resolved.mode,verificationPolicy:resolved.verification,max_retries:0,requireCurrent,
   record:async e=>{
    const isVerification=e.stage==='verification';
    const eventId=await this.storage.execute<string>('memoryExtraction.event',{ownerId:this.ownerId,attemptId:batch.attemptId,kind:e.stage,
     payload:{...e.payload as object,...(e.candidate_trace_id?{candidateTraceId:e.candidate_trace_id}:{}),...(isVerification?{verificationInputEventId}: {})},
     ...(isVerification&&verificationCall?verificationCall.reused?{reuseId:verificationCall.callId}:{callId:verificationCall.callId}:{}),inputNos:actualNos});
    if(e.stage==='verification_input')verificationInputEventId=eventId;
    if(isVerification&&e.candidate_trace_id)verificationEvents.set(e.candidate_trace_id,eventId);
   },
   invoke:async request=>{
    const scope={owner_id:this.ownerId,contact_id:batch.contactId};
    let prepared:SqliteExtractionModelPreparation;try{prepared=await this.model.prepare(request,{scope,signal,requireCurrent});}catch(error){if(commonCodes.includes((error as any)?.code))commonFailure=(error as any).code;throw error;}
    const serial={purpose:request.purpose,system:request.system,user:request.user,tool:request.tool,...(request.images?.length?{images:request.images.map(image=>({id:image.id,mimeType:image.mimeType,sourceSha256:image.sourceSha256??sha256(Buffer.from(image.dataBase64,'base64')),requestSha256:sha256(Buffer.from(image.dataBase64,'base64')),originalBytes:image.originalBytes??Buffer.byteLength(image.dataBase64,'base64'),bytes:Buffer.byteLength(image.dataBase64,'base64'),normalizationTier:image.normalizationTier??null}))}:{})};
    const call=await this.storage.execute<any>('memoryExtraction.prepareCall',{ownerId:this.ownerId,attemptId:batch.attemptId,purpose:request.purpose,request:serial,provider:prepared.provider,model:prepared.model,configurationId:prepared.configurationId,inputCap:prepared.maxInputTokens,outputCap:prepared.maxOutputTokens,inputNos:actualNos,slot:attempt.slot});
    if(request.purpose==='verification')verificationCall={callId:call.callId,reused:call.reused};
    if(call.reused){await this.storage.execute('memoryExtraction.event',{ownerId:this.ownerId,attemptId:batch.attemptId,kind:'model_reused',payload:{state:'known_result'},reuseId:call.callId,inputNos:actualNos});return {blocks:call.blocks};}
    let result:{blocks:readonly unknown[]};
    try{result=await this.model.invoke(request,{requestId:call.requestId,attemptId:call.callId,scope,claim:batch.claim,signal,requireCurrent,onImageInputs:async manifests=>{await this.storage.execute('memoryExtraction.event',{ownerId:this.ownerId,attemptId:batch.attemptId,kind:'image_inputs',payload:{purpose:request.purpose,images:manifests},callId:call.callId,inputNos:actualNos});},onReceipt:async receipt=>{await this.storage.execute('memoryExtraction.receipt',{receipt});}});}
    catch(error){
     const value=error as {code?:unknown;provider_failure?:{code?:unknown;status?:unknown}};
     const code=typeof value?.code==='string'&&/^extraction_model_[a-z_]+$/.test(value.code)?value.code:'extraction_model_unavailable';
     const status=typeof value?.provider_failure?.status==='number'?value.provider_failure.status:null;
     const providerCode=typeof value?.provider_failure?.code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(value.provider_failure.code)?value.provider_failure.code:null;
     // 校验拒绝仍保存有界原始输出及来源关联；只供本机排错，绝不作为成功回执复用。
     if(error instanceof ExtractionModelError&&error.rejectedOutput)await this.storage.execute('memoryExtraction.event',{ownerId:this.ownerId,attemptId:batch.attemptId,kind:'model_output_rejected',payload:{purpose:request.purpose,...error.rejectedOutput},callId:call.callId,inputNos:actualNos});
     modelFailure=code;lastModelFailure=error;if(status===401||status===403)commonFailure='extraction_model_authentication_failed';else if(status===429||status!==null&&status>=500)commonFailure='extraction_model_provider_unavailable';
     const failure=error instanceof ExtractionModelError?error.provider_failure:null;
     await this.storage.execute('memoryExtraction.event',{ownerId:this.ownerId,attemptId:batch.attemptId,kind:'model_failure',payload:{code,providerCode,status,
      transport_category:failure?.transport_category??null,stage:failure?.stage??null,elapsed_ms:failure?.elapsed_ms??null,request_bytes:failure?.request_bytes??null,image_count:failure?.image_count??images.length},callId:call.callId,inputNos:actualNos});throw error;
    }
    await this.storage.execute('memoryExtraction.event',{ownerId:this.ownerId,attemptId:batch.attemptId,kind:'model_output',payload:{blocks:result.blocks},callId:call.callId,inputNos:actualNos});return result;
   }});
  await requireCurrent();
  if(commonFailure)throw new StorageFailure(commonFailure);
  if(outcome.failure_kind!==null||!outcome.extraction_completed)throw lastModelFailure??new StorageFailure(modelFailure??'memory_extraction_protocol_incomplete');
  // 逐条拒绝是内容结果：目标按“已处理、无新增”收尾并继续后续批次，不能升级为整批失败或整轮受阻。
  const verificationRefs:(CandidateVerificationReference|null)[]=outcome.accepted.map((fact,index)=>{
   const checked=outcome.verification.find(v=>v.fact===fact),candidateTraceId=outcome.candidate_trace_ids[index]!,eventId=verificationEvents.get(candidateTraceId);
   if(!checked||!eventId||!verificationInputEventId||!verificationCall)return null;
   if(checked.result.verification_mode==='multimodal-claim-v1')assertMultimodalAdmission(window,fact,checked.result);
   else if(resolved.verification.id==='complete-claim-v1')assertCompleteClaimAdmission(window,fact,checked.result);else return null;
   return {eventId,candidateTraceId,inputEventId:verificationInputEventId,callId:verificationCall.callId,policyFingerprint:checked.result.claim_validation!.policy_fingerprint};
  });
  if(images.length)await this.storage.execute('memoryExtraction.event',{ownerId:this.ownerId,attemptId:batch.attemptId,kind:'image_input_recovered',payload:{slot:attempt.slot},inputNos:actualNos});
  return {outcome,verificationRefs,inputNos:actualNos};
  };
  const prior=await this.storage.execute<number[]>('memoryExtraction.imageRecoveryPlan',{ownerId:this.ownerId,attemptId:batch.attemptId});
  const targets=activeRows.filter(row=>row.role==='target');
  const recovered=targets.length?await recoverImageTargets({targets,isImage:hasImage,signal,previouslyDegraded:new Set(prior),run:runGroup,
   canRecover:error=>error instanceof ExtractionModelError&&error.receipt?.outcome==='failed'&&error.receipt.terminal_failure==='transport'
    ||error instanceof ModelImageNormalizationError&&error.code==='extraction_model_image_variant_unchanged',
   supersede:attempt=>this.storage.execute('memoryExtraction.supersedeImageInput',{ownerId:this.ownerId,attemptId:batch.attemptId,slot:attempt.slot,
    unchangedVariant:unchangedVariants.has(attempt.slot),inputNos:groupRows(attempt.targets,attempt.includeImageContext).map(row=>Number(row.input_no))}).then(()=>{}),
   isolate:row=>isolate(row),
  }):{results:[]};
  const parts=recovered.results.map(result=>result.value);
  const outcome:ExtractionFlowOutcome={accepted:parts.flatMap(part=>part.outcome.accepted),rejected_count:parts.reduce((sum,part)=>sum+part.outcome.rejected_count,0),extraction_completed:true,
   candidate_trace_ids:parts.flatMap(part=>part.outcome.candidate_trace_ids),failure_kind:null,failure_reason:null,verification:parts.flatMap(part=>part.outcome.verification)};
  await this.withSourceReady(batch.contactId,()=>this.storage.execute('memoryExtraction.finish',{ownerId:this.ownerId,attemptId:batch.attemptId,outcome,
   verificationRefs:parts.flatMap(part=>part.verificationRefs),candidateInputNos:parts.flatMap(part=>part.outcome.accepted.map(()=>part.inputNos)),
   inputNos:rows.map(row=>Number(row.input_no)),completedGroups:recovered.results.map(result=>({slot:result.slot,inputNos:result.value.inputNos}))}));
 }
 close():Promise<void>{return this.closing??=(async()=>{this.stopped=true;for(const entry of this.active.values())entry.abort.abort();await Promise.allSettled([...this.pending]);await Promise.allSettled([...this.runs.values()]);await this.model.close?.();})().catch(error=>{this.closing=undefined;throw error;});}
}
