import type {SqliteStorage} from '../../../storage/sqlite/client.ts';
import {StorageFailure} from '../../../storage/sqlite/contracts.ts';
import type {ActiveHolders} from '../../../storage/sqlite/deletion/holders.ts';
import type {MemoryScope} from '../management/contracts.ts';
import type {LaterScheduleSnapshot} from './later-schedule.ts';
import type {ModelTaskClaim} from '../../../platform/models/model-permit-server.ts';
import type {ModelLedgerReceipt} from '../../../platform/models/model-ledger-contract.ts';
import type {SqliteExtractionModelPreparation} from '../model-port.ts';
import {DEFAULT_L2_SCENARIO_BUDGET,L2ScenarioDocumentWorkspace,runScenarioDocumentAgent,verifyScenarioProposal,type ScenarioDocumentCallPort} from '../../scenarios/workspace.ts';
import {L3ProfileWorkspace,runProfileDocumentAgent,verifyProfileProposal} from '../../profiles/workspace.ts';
import type {DocumentClaim} from './stages.ts';

export interface DocumentRequest {system:string;user:string;messages:any[];tools:any[];validateOutput(blocks:readonly unknown[]):void;}
export interface DocumentModelPort {
 prepare(request:DocumentRequest,input:{scope:{owner_id:string;contact_id:string|null};signal:AbortSignal;requireCurrent():Promise<void>}):Promise<SqliteExtractionModelPreparation>;
 invoke(request:DocumentRequest,input:{requestId:string;attemptId:string;scope:{owner_id:string;contact_id:string|null};claim:ModelTaskClaim;signal:AbortSignal;requireCurrent():Promise<void>;onReceipt(receipt:ModelLedgerReceipt):Promise<void>}):Promise<{blocks:readonly unknown[]}>;
 close?():Promise<void>;
}
/** 一个owner的文档处理服务；输入由真实任务及存储事务产生。 */
export class SqliteMemoryDocuments {
 private readonly storage:SqliteStorage;readonly ownerId:string;private readonly model:DocumentModelPort|undefined;private readonly holders:ActiveHolders;
 private readonly stop=new AbortController();private pending=new Set<Promise<unknown>>();private active=new Map<string,Promise<unknown>>();private closing?:Promise<void>;
 constructor(storage:SqliteStorage,ownerId:string,model:DocumentModelPort|undefined,holders:ActiveHolders){this.storage=storage;this.ownerId=ownerId;this.model=model;this.holders=holders;}
 async initialize(){
  await this.storage.execute('memoryDocuments.recover',{ownerId:this.ownerId});
  const runs=await this.storage.execute<string[]>('memoryDocuments.recoverableLaterRuns',{ownerId:this.ownerId});
  for(const runId of runs)await this.publishRun(runId);
 }
 enrollRun(runId:string):Promise<boolean>{return this.storage.execute('memoryDocuments.enrollRun',{ownerId:this.ownerId,runId});}
 scheduleMemoryChange(scope:MemoryScope,changedAt=Date.now(),runId?:string):Promise<LaterScheduleSnapshot|null>{return this.storage.execute('memoryDocuments.scheduleMemoryChange',{ownerId:this.ownerId,scope,changedAt,runId});}
 readSchedule(scope:MemoryScope):Promise<LaterScheduleSnapshot>{return this.storage.execute('memoryDocuments.readSchedule',{ownerId:this.ownerId,scope});}
 queueSummary():Promise<{pending:number;nextDueAt:number|null;stage:'document_scene'|'document_profile'|null}>{return this.storage.execute('memoryDocuments.queueSummary',{ownerId:this.ownerId});}
 nextDueAt():Promise<number|null>{return this.storage.execute('memoryDocuments.nextDueAt',{ownerId:this.ownerId});}
 async runDueStages(now=Date.now()):Promise<unknown[]> {
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
 }
 publishRun(runId:string):Promise<unknown>{
  if(this.stop.signal.aborted)return Promise.reject(new StorageFailure('document_service_closed'));
  const prior=this.active.get(runId);if(prior)return prior;
  const work=this.run(runId);this.active.set(runId,work);this.pending.add(work);void work.then(()=>{this.pending.delete(work);this.active.delete(runId);},()=>{this.pending.delete(work);this.active.delete(runId);});return work;
 }
 private async run(runId:string){
  const tasks=await this.storage.execute<string[]>('memoryDocuments.tasks',{ownerId:this.ownerId,runId});const results=[];
  for(const taskId of tasks){
   if(this.stop.signal.aborted)break;
   try{
    const claim=await this.storage.execute<DocumentClaim|null>('memoryDocuments.claimScene',{ownerId:this.ownerId,taskId});
    if(!claim){
     // 已冻结且场景成功的任务可能停在暂停/中断的小批边界；继续时单独领取画像，不重新整理主题。
     const view=await this.readTask(taskId),stages=Array.isArray(view?.stages)?view.stages as {kind:string;status:string}[]:[];
     const sceneDone=stages.some(stage=>stage.kind==='scene'&&stage.status==='succeeded'),profileDone=stages.some(stage=>stage.kind==='profile');
     if(view?.laterStage==='document_scene'&&sceneDone&&!view.publicationId){
      const result=await this.storage.execute('memoryDocuments.publish',{ownerId:this.ownerId,taskId,now:view.scheduleNow??undefined});
      await this.storage.execute('memoryDocuments.settle',{ownerId:this.ownerId,runId}).catch(()=>false);results.push(result);continue;
     }
     if(view?.laterStage==='document_profile'||sceneDone&&!profileDone){
      const profileClaim=await this.storage.execute<DocumentClaim|null>('memoryDocuments.claimProfile',{ownerId:this.ownerId,taskId});
      if(profileClaim){const result=await this.processTask(profileClaim);results.push(result);if(result.errorCode==='document_model_unconfigured')break;continue;}
     }
     if(view?.laterStage&&stages.some(stage=>stage.status==='succeeded')&&!view.publicationId){
      const result=await this.storage.execute('memoryDocuments.publish',{ownerId:this.ownerId,taskId,now:view.scheduleNow??undefined});
      await this.storage.execute('memoryDocuments.settle',{ownerId:this.ownerId,runId}).catch(()=>false);results.push(result);continue;
     }
     results.push(view);await this.storage.execute('memoryDocuments.settle',{ownerId:this.ownerId,runId}).catch(()=>false);continue;
    }
    const result=await this.processTask(claim);results.push(result);
    if(result.errorCode==='document_model_unconfigured')break;
   }catch(error){
    if(this.stop.signal.aborted){results.push({taskId,outcome:'incomplete',errorCode:'runtime_interrupted'});break;}
    const code=this.errorCode(error);await this.storage.execute('memoryDocuments.noteFailure',{ownerId:this.ownerId,taskId,code}).catch(()=>{});
    results.push({taskId,outcome:'incomplete',errorCode:code});
   }
  }
  return results;
 }
 private errorCode(error:unknown):string{return typeof (error as {code?:unknown})?.code==='string'?String((error as {code:string}).code):'document_stage_failed';}
 private async processTask(initial:DocumentClaim):Promise<{taskId:string;outcome:string;errorCode?:string}>{
  const controller=new AbortController(),signal=AbortSignal.any([this.stop.signal,controller.signal]);let finish!:()=>void;const done=new Promise<void>(resolve=>finish=resolve),releases:(()=>Promise<void>)[]=[];
  let active:DocumentClaim=initial;
  try{
   const contacts=await this.storage.execute<{contactId:string;generation:string}[]>('memoryDocuments.holders',{ownerId:this.ownerId,attemptId:initial.attemptId});
   for(const contact of contacts)releases.push(this.holders.register({key:`memoryDocuments:${initial.attemptId}_${contact.contactId}`,ownerId:this.ownerId,contactId:contact.contactId,coversAllSources:true,generation:BigInt(contact.generation),close:async()=>{controller.abort();await done;}}));
   let scene:{scenarios:any[]};
   if(initial.kind==='document_scene'){
    scene=await this.processScene(initial,signal);
    signal.throwIfAborted();
    if(initial.laterStage==='document_scene'){
     const result=await this.storage.execute<{taskId:string;outcome:string}>('memoryDocuments.publish',{ownerId:this.ownerId,taskId:initial.taskId,now:initial.scheduleNow??undefined});
     await this.storage.execute('memoryDocuments.settle',{ownerId:this.ownerId,runId:initial.runId}).catch(()=>false);return result;
    }
    // 场景批次收尾后如已请求普通暂停，不再领取画像小批；任务保持可继续而不是失败。
    if(await this.storage.execute<boolean>('memoryDocuments.runPaused',{ownerId:this.ownerId,runId:initial.runId}))return {taskId:initial.taskId,outcome:'incomplete'};
    active=await this.storage.execute<DocumentClaim>('memoryDocuments.claimProfile',{ownerId:this.ownerId,taskId:initial.taskId});
    if(!active)throw new StorageFailure('document_stage_incomplete');
   }else{
    // 暂停/中断后继续：画像小批单独领取，使用本轮已保存的主题版本。
    scene={scenarios:initial.scenarios};
    active=initial;
   }
   await this.processProfile(active,scene,signal);
   signal.throwIfAborted();
   const result=await this.storage.execute<{taskId:string;outcome:string}>('memoryDocuments.publish',{ownerId:this.ownerId,taskId:initial.taskId,now:initial.scheduleNow??undefined});
   signal.throwIfAborted();
   await this.storage.execute('memoryDocuments.settle',{ownerId:this.ownerId,runId:initial.runId}).catch(()=>false);
   return result;
  }catch(error){
   if(this.stop.signal.aborted)return {taskId:initial.taskId,outcome:'incomplete',errorCode:'runtime_interrupted'};
   const code=this.errorCode(error);
   await this.storage.execute('memoryDocuments.fail',{ownerId:this.ownerId,attemptId:active.attemptId,code}).catch(()=>{});
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
  const port=this.port(claim,signal),options=this.options(claim,port,signal),workspace=new L2ScenarioDocumentWorkspace(claim.memories,claim.scenarios,DEFAULT_L2_SCENARIO_BUDGET);
  const proposal=await runScenarioDocumentAgent({...options,workspace});
  const checked=await verifyScenarioProposal({...options,scenarios:proposal.scenarios,memories:claim.memories});
  const verificationEventId=checked.receipts.at(-1);if(!verificationEventId)throw new StorageFailure('document_verification_unbound');
  return this.storage.execute<{scenarios:any[]}>('memoryDocuments.saveScene',{ownerId:this.ownerId,attemptId:claim.attemptId,scenarios:proposal.scenarios,verificationEventId});
 }
 private async processProfile(claim:DocumentClaim,scene:{scenarios:any[]},signal:AbortSignal){
  const port=this.port(claim,signal),options=this.options(claim,port,signal),scenarios=scene.scenarios,workspace=new L3ProfileWorkspace(claim.profile,scenarios,claim.memories,DEFAULT_L2_SCENARIO_BUDGET);
  const oldIds=new Set(claim.scenarios.map(s=>s.version_id)),newIds=new Set(scenarios.map(s=>s.version_id));
  const changed=scenarios.filter(s=>!oldIds.has(s.version_id)),removed=claim.scenarios.filter(s=>!newIds.has(s.version_id)).map(s=>s.version_id);
  const proposal=await runProfileDocumentAgent({...options,workspace,existing:claim.profile,scenarios,memories:claim.memories,changedScenarios:changed,removedScenarioVersionIds:removed,baseProfileVersionId:claim.profile?.version_id??null,corrections:[],remainingCalls:DEFAULT_L2_SCENARIO_BUDGET.max_model_calls});
  const checked=await verifyProfileProposal({...options,entries:proposal.proposal.entries,memories:claim.memories,scenarios,budget:DEFAULT_L2_SCENARIO_BUDGET,corrections:[],remainingCalls:Math.max(0,DEFAULT_L2_SCENARIO_BUDGET.max_model_calls-proposal.calls)});
  const verificationEventId=checked.receipts.at(-1);if(!verificationEventId)throw new StorageFailure('document_verification_unbound');
  await this.storage.execute('memoryDocuments.saveProfile',{ownerId:this.ownerId,attemptId:claim.attemptId,entries:proposal.proposal.entries,verificationEventId});
 }
 readTask(taskId:string){return this.storage.execute<any>('memoryDocuments.readTask',{ownerId:this.ownerId,taskId});}
 read(scope:MemoryScope){return this.storage.execute<any>('memoryDocuments.read',{ownerId:this.ownerId,scope});}
 close():Promise<void>{return this.closing??=(async()=>{this.stop.abort();await Promise.allSettled([...this.pending]);await this.model?.close?.();})().catch(error=>{this.closing=undefined;throw error;});}
}
