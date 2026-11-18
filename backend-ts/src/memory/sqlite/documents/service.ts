import {currentDiagnosticTrace,newTraceId,withDiagnosticTrace} from '../../../diagnostics/context.ts';
import type {SqliteStorage} from '../../../storage/sqlite/client.ts';
import {StorageFailure} from '../../../storage/sqlite/contracts.ts';
import type {ActiveHolders} from '../../../storage/sqlite/deletion/holders.ts';
import type {MemoryScope} from '../management/contracts.ts';
import type {LaterScheduleSnapshot} from './later-schedule.ts';
import type {ModelTaskClaim} from '../../../platform/models/model-permit-port.ts';
import type {ModelLedgerReceipt} from '../../../platform/models/model-ledger-contract.ts';
import type {SqliteExtractionModelPreparation} from '../model-port.ts';
import {DEFAULT_L2_SCENARIO_BUDGET,L2ScenarioError,L2ScenarioVerificationError,L2ScenarioDocumentWorkspace,runScenarioDocumentAgent,scenarioVerificationFeedback,verifyScenarioProposal,type ScenarioDocumentCallPort} from '../../scenarios/index.ts';
import {L3ProfileWorkspace,runProfileDocumentAgent,verifyProfileProposal} from '../../profiles/index.ts';
import type {DocumentClaim,DocumentWork} from './stages.ts';

export interface DocumentRequest {system:string;user:string;messages:any[];tools:any[];validateOutput(blocks:readonly unknown[]):void;}
export interface DocumentModelPort {
 prepare(request:DocumentRequest,input:{scope:{owner_id:string;contact_id:string|null};signal:AbortSignal;requireCurrent():Promise<void>}):Promise<SqliteExtractionModelPreparation>;
 invoke(request:DocumentRequest,input:{requestId:string;attemptId:string;scope:{owner_id:string;contact_id:string|null};claim:ModelTaskClaim;signal:AbortSignal;requireCurrent():Promise<void>;onReceipt(receipt:ModelLedgerReceipt):Promise<void>}):Promise<{blocks:readonly unknown[]}>;
 close?():Promise<void>;
}
/** 一个owner的文档处理服务；输入由真实任务及存储事务产生。 */
export class SqliteMemoryDocuments {
 private readonly storage:SqliteStorage;readonly ownerId:string;private readonly model:DocumentModelPort|undefined;private readonly holders:ActiveHolders;
 private readonly stop=new AbortController();private active=new Map<string,{contactId:string|undefined;retryKnownFailures:boolean;work:Promise<unknown>}>();private closing?:Promise<void>;
 constructor(storage:SqliteStorage,ownerId:string,model:DocumentModelPort|undefined,holders:ActiveHolders){this.storage=storage;this.ownerId=ownerId;this.model=model;this.holders=holders;}
 async initialize(){
  await this.storage.execute('memoryDocuments.recover',{ownerId:this.ownerId});
  const runs=await this.storage.execute<string[]>('memoryDocuments.recoverableLaterRuns',{ownerId:this.ownerId});
  for(const runId of runs)await this.publishRun(runId);
 }
 enrollRun(runId:string,contactId?:string):Promise<boolean>{return this.storage.execute('memoryDocuments.enrollRun',{ownerId:this.ownerId,runId,...(contactId===undefined?{}:{contactId})});}
 scheduleMemoryChange(scope:MemoryScope,changedAt=Date.now(),runId?:string):Promise<LaterScheduleSnapshot|null>{return this.storage.execute('memoryDocuments.scheduleMemoryChange',{ownerId:this.ownerId,scope,changedAt,runId});}
 readSchedule(scope:MemoryScope):Promise<LaterScheduleSnapshot>{return this.storage.execute('memoryDocuments.readSchedule',{ownerId:this.ownerId,scope});}
 queueSummary():Promise<{pending:number;nextDueAt:number|null;stage:'document_scene'|'document_profile'|null}>{return this.storage.execute('memoryDocuments.queueSummary',{ownerId:this.ownerId});}
 nextDueAt():Promise<number|null>{return this.storage.execute('memoryDocuments.nextDueAt',{ownerId:this.ownerId});}
 async runDueStages(now=Date.now()):Promise<unknown[]> {
  return withDiagnosticTrace(currentDiagnosticTrace()??newTraceId(),async()=>{
  const results:unknown[]=[];if(this.stop.signal.aborted)return results;
  for(let index=0;index<32&&!this.stop.signal.aborted;index++){
   const job=await this.storage.execute<any>('memoryDocuments.claimDue',{ownerId:this.ownerId,now});
   if(!job)break;
   if(job.failed){results.push(job);break;}
   const runResults=await this.publishRun(String(job.runId));
   const state=await this.readSchedule(job.scope as MemoryScope);
   results.push({stage:job.stage,generation:job.generation,runId:job.runId,taskId:job.taskId,results:runResults,state:job.stage==='document_scene'?state.scene?.state:state.profile?.state});
   const finalState=job.stage==='document_scene'?state.scene?.state:state.profile?.state;
   if(finalState==='failed'||finalState==='unknown')break;
  }
  return results;
  });
 }
 /** 同轮重复请求只复用相同范围，不能把另一联系人的在途工作当作本次完成。 */
 publishRun(runId:string,contactId?:string,options:{retryKnownFailures?:boolean}={}):Promise<unknown>{
  if(this.stop.signal.aborted)return Promise.reject(new StorageFailure('document_service_closed'));
  const retryKnownFailures=options.retryKnownFailures===true;
  if(retryKnownFailures&&!contactId)return Promise.reject(new StorageFailure('document_scope_invalid'));
  const prior=this.active.get(runId);if(prior)return prior.contactId===contactId&&prior.retryKnownFailures===retryKnownFailures?prior.work:Promise.reject(new StorageFailure('document_run_busy'));
  const work=withDiagnosticTrace(currentDiagnosticTrace()??newTraceId(),()=>this.run(runId,contactId,retryKnownFailures));this.active.set(runId,{contactId,retryKnownFailures,work});void work.then(()=>this.active.delete(runId),()=>this.active.delete(runId));return work;
 }
 private async run(runId:string,contactId?:string,retryKnownFailures=false){
  const tasks=await this.storage.execute<string[]>('memoryDocuments.tasks',{ownerId:this.ownerId,runId,...(contactId===undefined?{}:{contactId})});const results=[];
  for(const taskId of tasks){
   if(this.stop.signal.aborted)break;
   try{
    let result:any;
    while(!this.stop.signal.aborted){
     const work=await this.storage.execute<DocumentWork>('memoryDocuments.claim',{ownerId:this.ownerId,taskId,...(contactId===undefined?{}:{contactId}),...(retryKnownFailures?{retryKnownFailures:true}:{})});
     if(!work||work.kind==='publication'){
      result=work?await this.storage.execute('memoryDocuments.publish',{ownerId:this.ownerId,taskId,now:work.scheduleNow??undefined}):await this.readTask(taskId);
      await this.storage.execute('memoryDocuments.settle',{ownerId:this.ownerId,runId}).catch(()=>false);break;
     }
     result=await this.processStage(work);
     if(result.outcome!=='stage_completed')break;
    }
    results.push(result??{taskId,outcome:'incomplete',errorCode:'runtime_interrupted'});
    if(result?.errorCode==='document_model_unconfigured')break;
   }catch(error){
    if(this.stop.signal.aborted){results.push({taskId,outcome:'incomplete',errorCode:'runtime_interrupted'});break;}
    const code=this.errorCode(error);await this.storage.execute('memoryDocuments.noteFailure',{ownerId:this.ownerId,taskId,code}).catch(()=>{});
    results.push({taskId,outcome:'incomplete',errorCode:code});
   }
  }
  return results;
 }
 private errorCode(error:unknown):string{return typeof (error as {code?:unknown})?.code==='string'?String((error as {code:string}).code):'document_stage_failed';}
 private async processStage(initial:DocumentClaim):Promise<{taskId:string;outcome:string;errorCode?:string}>{
  const controller=new AbortController(),signal=AbortSignal.any([this.stop.signal,controller.signal]);let finish!:()=>void;const done=new Promise<void>(resolve=>finish=resolve),releases:(()=>Promise<void>)[]=[];
  try{
   const contacts=await this.storage.execute<{contactId:string;generation:string}[]>('memoryDocuments.holders',{ownerId:this.ownerId,attemptId:initial.attemptId});
   for(const contact of contacts)releases.push(this.holders.register({key:`memoryDocuments:${initial.attemptId}_${contact.contactId}`,ownerId:this.ownerId,contactId:contact.contactId,coversAllSources:true,generation:BigInt(contact.generation),close:async()=>{controller.abort();await done;}}));
   if(initial.kind==='document_scene')await this.processScene(initial,signal);
   else await this.processProfile(initial,signal);
   signal.throwIfAborted();
   return {taskId:initial.taskId,outcome:'stage_completed'};
  }catch(error){
   if(this.stop.signal.aborted)return {taskId:initial.taskId,outcome:'incomplete',errorCode:'runtime_interrupted'};
   const code=this.errorCode(error);
   await this.storage.execute('memoryDocuments.fail',{ownerId:this.ownerId,attemptId:initial.attemptId,code}).catch(()=>{});
   await this.storage.execute('memoryDocuments.noteFailure',{ownerId:this.ownerId,taskId:initial.taskId,code}).catch(()=>{});
   return {taskId:initial.taskId,outcome:'incomplete',errorCode:code};
  }finally{finish();await Promise.all(releases.map(release=>release()));}
 }
 private port(claim:DocumentClaim,signal:AbortSignal):ScenarioDocumentCallPort{
  if(!this.model)throw new StorageFailure('document_model_unconfigured');
  return {call:async input=>{
   const requireCurrent=async()=>{signal.throwIfAborted();await this.storage.execute('memoryDocuments.current',{ownerId:this.ownerId,attemptId:claim.attemptId});};
   const request:DocumentRequest={system:input.system,user:JSON.stringify(input.messages),messages:input.messages as any[],tools:input.tools as any[],validateOutput:()=>{}};
   const scope={owner_id:this.ownerId,contact_id:claim.contactId},prepared=await this.model!.prepare(request,{scope,signal,requireCurrent});
   const call=await this.storage.execute<{callId:string;requestId:string}>('memoryDocuments.prepareCall',{ownerId:this.ownerId,attemptId:claim.attemptId,request:{system:request.system,messages:request.messages,tools:request.tools},provider:prepared.provider,model:prepared.model,configurationId:prepared.configurationId,inputCap:prepared.maxInputTokens,outputCap:prepared.maxOutputTokens});
   const result=await this.model!.invoke(request,{scope,signal,requireCurrent,claim:claim.claim,requestId:call.requestId,attemptId:call.callId,onReceipt:async receipt=>{await this.storage.execute('memoryExtraction.receipt',{receipt});}});
   await requireCurrent();const eventId=await this.storage.execute<string>('memoryDocuments.output',{ownerId:this.ownerId,attemptId:claim.attemptId,callId:call.callId,blocks:result.blocks});
   return {blocks:result.blocks as any,receipt_id:eventId};
  }};
 }
 private options(claim:DocumentClaim,port:ScenarioDocumentCallPort,signal:AbortSignal){return {port,claim:{...claim.claim,step_name:'organize_memory' as const},owner_id:this.ownerId,contact_id:claim.contactId,batch_id:claim.attemptId,
  binding:{provider:'configured',model:'configured',maxTokens:1024,temperature:0,reasoningEffort:'off' as const},profile:{context_window_tokens:128_000,safety_margin_tokens:512},signal,requireCurrent:async()=>{signal.throwIfAborted();await this.storage.execute('memoryDocuments.current',{ownerId:this.ownerId,attemptId:claim.attemptId});}};}
 private async processScene(claim:DocumentClaim,signal:AbortSignal){
  const originalPort=this.port(claim,signal);let calls=0;
  const port:ScenarioDocumentCallPort={call:async input=>{if(calls>=DEFAULT_L2_SCENARIO_BUDGET.max_model_calls)throw new L2ScenarioError('l2_scenario_budget_exceeded');calls++;return originalPort.call(input);}};
  const options=this.options(claim,port,signal),workspace=new L2ScenarioDocumentWorkspace(claim.memories,claim.scenarios,DEFAULT_L2_SCENARIO_BUDGET);
  let proposal=await runScenarioDocumentAgent({...options,workspace,remainingCalls:DEFAULT_L2_SCENARIO_BUDGET.max_model_calls-calls}),checked;
  try{checked=await verifyScenarioProposal({...options,scenarios:proposal.scenarios,memories:claim.memories});}
  catch(error){
   if(!(error instanceof L2ScenarioVerificationError))throw error;
   const feedback=scenarioVerificationFeedback(error,proposal.scenarios,claim.memories);
   if(!feedback||DEFAULT_L2_SCENARIO_BUDGET.max_model_calls-calls<2)throw error;
   // 同一授权、快照和暂存区只修正一次；原核验输出已留痕，修正后仍须独立核验。
   proposal=await runScenarioDocumentAgent({...options,workspace,verificationFeedback:feedback,remainingCalls:DEFAULT_L2_SCENARIO_BUDGET.max_model_calls-calls});
   checked=await verifyScenarioProposal({...options,scenarios:proposal.scenarios,memories:claim.memories});
  }
  const verificationEventId=checked.receipts.at(-1);if(!verificationEventId)throw new StorageFailure('document_verification_unbound');
  return this.storage.execute<{scenarios:any[]}>('memoryDocuments.saveScene',{ownerId:this.ownerId,attemptId:claim.attemptId,scenarios:proposal.scenarios,verificationEventId});
 }
 private async processProfile(claim:DocumentClaim,signal:AbortSignal){
  const port=this.port(claim,signal),options=this.options(claim,port,signal),scenarios=claim.scenarios,workspace=new L3ProfileWorkspace(claim.profile,scenarios,claim.memories,DEFAULT_L2_SCENARIO_BUDGET);
  const proposal=await runProfileDocumentAgent({...options,workspace,changedScenarioIds:claim.changedScenarioIds,removedScenarioVersionIds:claim.removedScenarioVersionIds,corrections:[],remainingCalls:DEFAULT_L2_SCENARIO_BUDGET.max_model_calls});
  const checked=await verifyProfileProposal({...options,entries:proposal.proposal.entries,memories:claim.memories,scenarios,budget:DEFAULT_L2_SCENARIO_BUDGET,corrections:[],remainingCalls:Math.max(0,DEFAULT_L2_SCENARIO_BUDGET.max_model_calls-proposal.calls)});
  const verificationEventId=checked.receipts.at(-1);if(!verificationEventId)throw new StorageFailure('document_verification_unbound');
  await this.storage.execute('memoryDocuments.saveProfile',{ownerId:this.ownerId,attemptId:claim.attemptId,entries:proposal.proposal.entries,verificationEventId});
 }
 readTask(taskId:string){return this.storage.execute<any>('memoryDocuments.readTask',{ownerId:this.ownerId,taskId});}
 read(scope:MemoryScope){return this.storage.execute<any>('memoryDocuments.read',{ownerId:this.ownerId,scope});}
 close():Promise<void>{return this.closing??=(async()=>{this.stop.abort();await Promise.allSettled([...this.active.values()].map(entry=>entry.work));await this.model?.close?.();})().catch(error=>{this.closing=undefined;throw error;});}
}
