import type {SqliteStorage} from '../../storage/sqlite/client.ts';
import type {StorageRow} from '../../storage/sqlite/contracts.ts';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import {ActiveHolders} from '../../storage/sqlite/deletion/holders.ts';
import {createExtractionPolicyVersion,type ExtractionPolicyVersion} from '../extraction/policy-version.ts';
import {runExtractionFlow,type ExtractionInvocation} from '../extraction/flow.ts';
import {assertCompleteClaimAdmission} from '../extraction/verification/complete-claim.ts';
import {isSharedFailure,sharedFailureCodes} from './control.ts';
import type {CandidateVerificationReference} from './management/admission.ts';
import type {ExtractionWindow} from '../extraction/protocol.ts';
import type {ModelPermitAccounting,ModelTaskClaim} from '../../platform/models/model-permit-server.ts';
import type {SqliteExtractionModelInvocation,SqliteExtractionModelPreparation} from './model-port.ts';
export interface ExtractionModelPort {
 prepare(request:ExtractionInvocation,input:Pick<SqliteExtractionModelInvocation,'scope'|'signal'|'requireCurrent'>):Promise<SqliteExtractionModelPreparation>;
 invoke(request:ExtractionInvocation,input:SqliteExtractionModelInvocation):Promise<{blocks:readonly unknown[]}>;
 close?():Promise<void>;
}
interface ClaimedStep {attemptId:string;stepId:string;taskId:string;runId:string;contactId:string;rows:StorageRow[];policyConfig:unknown;claim:ModelTaskClaim}
export class SqliteMemoryExtraction {
 private afterRunSettled?:((runId:string)=>Promise<unknown>);
 private readonly ensureSourceReady?:((contactId:string)=>Promise<void>);
 private storage:SqliteStorage;readonly ownerId:string;private model:ExtractionModelPort;readonly holders:ActiveHolders;
 private policy?:Promise<ExtractionPolicyVersion>;private initialized?:Promise<void>;private stopped=false;
 private closing?:Promise<void>;private pending=new Set<Promise<unknown>>();
 private runs=new Map<string,Promise<void>>();private active=new Map<string,{abort:AbortController;done:Promise<void>}>();
 readonly accounting:ModelPermitAccounting;
 constructor(storage:SqliteStorage,ownerId:string,model:ExtractionModelPort,holders=new ActiveHolders(),afterRunSettled?:((runId:string)=>Promise<unknown>),ensureSourceReady?:((contactId:string)=>Promise<void>)){
  this.storage=storage;this.ownerId=ownerId;this.model=model;this.holders=holders;this.afterRunSettled=afterRunSettled;this.ensureSourceReady=ensureSourceReady;
  this.accounting={reserve:async(receipt,claim)=>{await this.storage.execute(claim?.step_name==='extraction_verification'?'memoryExtraction.reserve':claim?.step_name==='document_scene'||claim?.step_name==='document_profile'?'memoryDocuments.reserve':'memoryAdjudication.reserve',{receipt,claim});},recordReserved:async receipt=>{await this.storage.execute('memoryExtraction.receipt',{receipt});},unconfirmedRequests:scope=>this.storage.execute('memoryExtraction.unconfirmed',scope)};
 }
 private version(){return this.policy??=createExtractionPolicyVersion();}
 initialize(){this.available();return this.initialized??=this.admit(async()=>{await this.storage.execute('memoryExtraction.recover',{ownerId:this.ownerId});});}
 private available(){if(this.stopped)throw new StorageFailure('memory_extraction_closed');}
 /** 关闭也等待已受理但尚未进入run的SQLite工作，防止宿主先释放存储。 */
 private admit<T>(work:()=>Promise<T>):Promise<T>{
  this.available();const pending=Promise.resolve().then(()=>{this.available();return work();});this.pending.add(pending);
  void pending.then(()=>this.pending.delete(pending),()=>this.pending.delete(pending));return pending;
 }
 async start(requestKey:string){
  return this.admit(async()=>{
  await this.initialize();const policy=await this.version();await policy.assertCurrent();this.available();
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
 /** 页面只读队列摘要；pending包含被同联系人阻碍而暂不能自动建轮的增量目标。 */
 readSchedule(now=Date.now()):Promise<{pending:number;nextDueAt:number|null;blockedContacts:number}>{this.available();return this.storage.execute('memoryExtraction.readSchedule',{ownerId:this.ownerId,now});}
 /** 内部按单联系人建立一个固定增量轮；此方法不暴露给HTTP。 */
 async startContact(contactId:string,requestKey:string,now=Date.now()){
  return this.admit(async()=>{
   await this.initialize();const policy=await this.version();await policy.assertCurrent();this.available();
   const prior=await this.storage.execute<any>('memoryExtraction.findRequest',{ownerId:this.ownerId,requestKey});this.available();
   if(prior)return prior;
   const run=await this.storage.execute<any>('memoryExtraction.startContact',{ownerId:this.ownerId,contactId,requestKey,now,
    policyConfig:policy.newTaskConfig(),followupStages:this.afterRunSettled!==undefined});
   if(run)this.launch(run.runId);return run;
  });
 }
 /** 用户显式初始化当前联系人的已保存文字，沿正常提取、核验和后续整理链执行。 */
 async startHistory(contactId:string,requestKey:string){
  return this.admit(async()=>{
   await this.initialize();const policy=await this.version();await policy.assertCurrent();this.available();
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
 /** 重启时只恢复持久标记为pending且L1已安全结束的后续登记，不再领取提取目标。 */
 async resumeFollowups():Promise<number>{
  this.available();if(!this.afterRunSettled)return 0;
  await this.initialize();this.available();
  const runIds=await this.storage.execute<string[]>('memoryExtraction.pendingFollowups',{ownerId:this.ownerId});let started=0;
  for(const runId of runIds)if(this.launchFollowup(runId))started++;
  return started;
 }
 private launchFollowup(runId:string):boolean{
  if(this.runs.has(runId)||this.stopped||!this.afterRunSettled)return false;
  const work=this.executeFollowup(runId).finally(()=>this.runs.delete(runId));this.runs.set(runId,work);void work.catch(()=>{});return true;
 }
 private async executeFollowup(runId:string,recovering=true):Promise<void>{
  if(this.stopped||!this.afterRunSettled)return;
  // 启动恢复必须整轮安全；本次正常收尾仍由各领域门禁隔离单联系人失败。
  const eligible=!recovering||await this.storage.execute<boolean>('memoryExtraction.followupEligible',{ownerId:this.ownerId,runId});
  if(!eligible||this.stopped)return;
  try{await this.afterRunSettled(runId);}
  finally{if(!this.stopped)await this.storage.execute('memoryExtraction.finishLater',{ownerId:this.ownerId,runId});}
 }
 read(runId?:string){this.available();return this.storage.execute<any>('memoryExtraction.read',{ownerId:this.ownerId,runId});}
 /** 当前联系人的独立进度与队列；不启动任务，也不包含本人或其他联系人的资料。 */
 readContact(contactId:string){this.available();return this.storage.execute<any>('memoryExtraction.readContact',{ownerId:this.ownerId,contactId});}
 trace(taskId:string){this.available();return this.storage.execute<any>('memoryExtraction.trace',{ownerId:this.ownerId,taskId});}
 /** 用户暂停带控制修订CAS；共享故障的宿主内暂停不带版本，仍走同一事务状态机。 */
 async pause(runId:string,actionVersion?:number,operationId?:string){return this.admit(()=>this.storage.execute<any>('memoryExtraction.control',{ownerId:this.ownerId,runId,action:'pause',...(actionVersion===undefined?{}:{actionVersion,operationId})}));}
 async continue(runId:string,actionVersion:number,operationId:string){return this.admit(async()=>{
  await this.initialize();this.available();const policy=await this.version();await policy.assertCurrent();
  const oldPolicy=await this.storage.execute<unknown>('memoryExtraction.readPolicy',{ownerId:this.ownerId,runId});
  try{policy.resolve(oldPolicy);}catch(error){
   if((error as {code?:string}).code!=='extraction_policy_source_unavailable')throw error;
   const next=await this.storage.execute<any>('memoryExtraction.restartPolicy',{ownerId:this.ownerId,runId,actionVersion,policyConfig:policy.newTaskConfig()});
   if(next.launchRunId)this.launch(next.launchRunId);return next.run;
  }
  const run=await this.storage.execute<any>('memoryExtraction.control',{ownerId:this.ownerId,runId,action:'continue',actionVersion,operationId});this.launch(runId);return run;
 });}
 private launch(runId:string){if(this.runs.has(runId)||this.stopped)return;const work=this.executeRun(runId).finally(()=>this.runs.delete(runId));this.runs.set(runId,work);void work.catch(()=>{});}
 async waitForIdle(runId?:string){if(runId!==undefined){await this.runs.get(runId);return;}await Promise.all([...this.runs.values()]);}
 private async executeRun(runId:string){
  const before=await this.read(runId);
  for(const task of before.tasks.filter((t:any)=>t.scopeKind==='contact')){
   if(this.stopped)break;
   while(!this.stopped){
    let batch:ClaimedStep|null;
    try{batch=await this.storage.execute('memoryExtraction.claim',{ownerId:this.ownerId,runId,taskId:task.taskId});}catch(error){if(error instanceof StorageFailure&&error.code==='memory_extraction_scope_stale')break;throw error;}
    if(!batch)break;
    const controller=new AbortController();let finish!:()=>void;const completed=new Promise<void>(r=>finish=r);
    const generation=BigInt((await this.storage.execute<any>('memoryExtraction.contactGeneration',{ownerId:this.ownerId,contactId:batch.contactId})).generation);
    let release:undefined|(()=>Promise<void>);
    try{
     if(this.stopped)controller.abort();
     release=this.holders.register({ownerId:this.ownerId,key:`memory:${task.taskId}`,contactId:batch.contactId,generation,close:async()=>{controller.abort();await completed;}});
     this.active.set(task.taskId,{abort:controller,done:completed});
     await this.process(batch,controller.signal);
    }catch(error){
     const code=error instanceof StorageFailure?error.code:typeof (error as any)?.code==='string'&&/^(?:extraction_model_|extraction_policy_|extraction_runtime_)/.test((error as any).code)?(error as any).code:'memory_extraction_failed';
     await this.storage.execute('memoryExtraction.fail',{ownerId:this.ownerId,attemptId:batch.attemptId,code});
     if(isSharedFailure(code))await this.pause(runId);
     break;
    }finally{this.active.delete(task.taskId);finish();await release?.();}
   }
  }
  if(!this.stopped){
   // 后续文档阶段的暂停边界由09在领取动作内复验；提取层只保证不自动重试失败模型。
   await this.storage.execute('memoryExtraction.settleRun',{ownerId:this.ownerId,runId,laterWork:!!this.afterRunSettled});
   if(this.afterRunSettled&&!this.stopped)await this.executeFollowup(runId,false);
  }
 }
 private async process(batch:ClaimedStep,signal:AbortSignal){
  const policy=await this.version();const resolved=policy.resolve(batch.policyConfig);
  const requireCurrent=async()=>{signal.throwIfAborted();await policy.assertCurrent();await this.storage.execute('memoryExtraction.current',{ownerId:this.ownerId,attemptId:batch.attemptId});};
  const rows=[...batch.rows].sort((a,b)=>a.sent_at!==null&&b.sent_at!==null?(a.sent_at as bigint)<(b.sent_at as bigint)?-1:(a.sent_at as bigint)>(b.sent_at as bigint)?1:Number(a.input_no)-Number(b.input_no):Number(a.input_no)-Number(b.input_no));
  const actualNos=rows.map(row=>Number(row.input_no));
  const window:ExtractionWindow={owner_id:this.ownerId,contact_id:batch.contactId,target_message_ids:rows.filter(r=>r.role==='target').map(r=>String(r.message_id)),messages:rows.map(r=>({message_id:String(r.message_id),text:String(r.text_body),sender:r.sender_role==='owner'?'self':'contact',occurred_at:r.sent_at===null?null:new Date(Number(r.sent_at)).toISOString(),text_representation:'text'}))};
  let commonFailure:string|null=null;let modelFailure:string|null=null;
  let verificationInputEventId:string|null=null,verificationCall:{callId:string;reused:boolean}|null=null;
  const verificationEvents=new Map<string,string>();
  const commonCodes=[...sharedFailureCodes];
  const outcome=await runExtractionFlow({window,signal,mode:resolved.mode,verificationPolicy:resolved.verification,max_retries:0,requireCurrent,
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
    const serial={purpose:request.purpose,system:request.system,user:request.user,tool:request.tool};
    const call=await this.storage.execute<any>('memoryExtraction.prepareCall',{ownerId:this.ownerId,attemptId:batch.attemptId,purpose:request.purpose,request:serial,provider:prepared.provider,model:prepared.model,configurationId:prepared.configurationId,inputCap:prepared.maxInputTokens,outputCap:prepared.maxOutputTokens,inputNos:actualNos});
    if(request.purpose==='verification')verificationCall={callId:call.callId,reused:call.reused};
    if(call.reused){await this.storage.execute('memoryExtraction.event',{ownerId:this.ownerId,attemptId:batch.attemptId,kind:'model_reused',payload:{state:'known_result'},reuseId:call.callId,inputNos:actualNos});return {blocks:call.blocks};}
    let result:{blocks:readonly unknown[]};
    try{result=await this.model.invoke(request,{requestId:call.requestId,attemptId:call.callId,scope,claim:batch.claim,signal,requireCurrent,onReceipt:async receipt=>{await this.storage.execute('memoryExtraction.receipt',{receipt});}});}
    catch(error){
     const value=error as {code?:unknown;provider_failure?:{code?:unknown;status?:unknown}};
     const code=typeof value?.code==='string'&&/^extraction_model_[a-z_]+$/.test(value.code)?value.code:'extraction_model_unavailable';
     const status=typeof value?.provider_failure?.status==='number'?value.provider_failure.status:null;
     const providerCode=typeof value?.provider_failure?.code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(value.provider_failure.code)?value.provider_failure.code:null;
     modelFailure=code;if(status===401||status===403)commonFailure='extraction_model_authentication_failed';else if(status===429||status!==null&&status>=500)commonFailure='extraction_model_provider_unavailable';
     await this.storage.execute('memoryExtraction.event',{ownerId:this.ownerId,attemptId:batch.attemptId,kind:'model_failure',payload:{code,providerCode,status},callId:call.callId,inputNos:actualNos});throw error;
    }
    await this.storage.execute('memoryExtraction.event',{ownerId:this.ownerId,attemptId:batch.attemptId,kind:'model_output',payload:{blocks:result.blocks},callId:call.callId,inputNos:actualNos});return result;
   }});
  await requireCurrent();
  if(commonFailure)throw new StorageFailure(commonFailure);
  if(outcome.failure_kind!==null||!outcome.extraction_completed)throw new StorageFailure(modelFailure??'memory_extraction_protocol_incomplete');
  if(outcome.rejected_count>0&&outcome.accepted.length===0)throw new StorageFailure('memory_extraction_source_insufficient');
  const verificationRefs:(CandidateVerificationReference|null)[]=outcome.accepted.map((fact,index)=>{
   const checked=outcome.verification.find(v=>v.fact===fact),candidateTraceId=outcome.candidate_trace_ids[index]!,eventId=verificationEvents.get(candidateTraceId);
   if(resolved.verification.id!=='complete-claim-v1'||!checked||!eventId||!verificationInputEventId||!verificationCall)return null;
   assertCompleteClaimAdmission(window,fact,checked.result);
   return {eventId,candidateTraceId,inputEventId:verificationInputEventId,callId:verificationCall.callId,policyFingerprint:checked.result.claim_validation!.policy_fingerprint};
  });
  await this.storage.execute('memoryExtraction.finish',{ownerId:this.ownerId,attemptId:batch.attemptId,outcome,verificationRefs,inputNos:actualNos});
 }
 close():Promise<void>{return this.closing??=(async()=>{this.stopped=true;for(const entry of this.active.values())entry.abort.abort();await Promise.allSettled([...this.pending]);await Promise.allSettled([...this.runs.values()]);await this.model.close?.();})().catch(error=>{this.closing=undefined;throw error;});}
}
