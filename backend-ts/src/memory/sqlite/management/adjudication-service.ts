/** 逐候选建立新快照；每个真实用途使用独立step/attempt和共享ModelHost。 */
import type {SqliteStorage} from '../../../storage/sqlite/client.ts';
import {StorageFailure} from '../../../storage/sqlite/contracts.ts';
import {ActiveHolders} from '../../../storage/sqlite/deletion/holders.ts';
import {DshMemoryAdjudicationRuntime,type StructuredAdjudicationCallInput} from '../../adoption/adjudication-dsh.ts';
import type {SqliteAdjudicationModelPort,SqliteAdjudicationModelRequest} from './model-port.ts';
import {requiresMultimodalRelationReview,type AdjudicationClaim} from './adjudication-actions.ts';
import {SqliteMemoryManagement} from './service.ts';
export class SqliteMemoryAdjudication {
 private readonly stopped=new AbortController();private pending=new Set<Promise<unknown>>();private active=new Map<string,Promise<unknown>>();private closing?:Promise<void>;
 private storage:SqliteStorage;readonly ownerId:string;private port:SqliteAdjudicationModelPort|undefined;private holders:ActiveHolders;
 constructor(storage:SqliteStorage,ownerId:string,port:SqliteAdjudicationModelPort|undefined,holders:ActiveHolders){this.storage=storage;this.ownerId=ownerId;this.port=port;this.holders=holders;}
 async initialize(){const attempts=await this.storage.execute<string[]>('memoryAdjudication.interrupted',{ownerId:this.ownerId});if(attempts.length)await this.storage.execute('memoryAdjudication.fail',{ownerId:this.ownerId,attemptIds:attempts,code:'runtime_interrupted'});}
 publishRun(runId:string):Promise<unknown>{
  if(this.stopped.signal.aborted)return Promise.reject(new StorageFailure('memory_adjudication_closed'));
  const prior=this.active.get(runId);if(prior)return prior;
  const work=this.publish(runId);this.active.set(runId,work);this.pending.add(work);void work.finally(()=>{this.active.delete(runId);this.pending.delete(work);}).catch(()=>{});return work;
 }
 private async publish(runId:string){
  const imported=await new SqliteMemoryManagement(this.storage,this.ownerId).importRun(runId),results:unknown[]=[];
  for(const candidateId of imported.candidateIds){
   if(this.stopped.signal.aborted)break;
   let first:AdjudicationClaim|null;
   try{first=await this.storage.execute('memoryAdjudication.claim',{ownerId:this.ownerId,candidateId});}
   catch(error){if(error instanceof StorageFailure&&['memory_candidate_stale','memory_source_stale','memory_extraction_scope_stale','memory_extraction_source_stale','memory_extraction_output_not_eligible'].includes(error.code))continue;throw error;}
   if(!first)continue;
   const claims=[first],controller=new AbortController(),signal=AbortSignal.any([controller.signal,this.stopped.signal]);
   let done!:()=>void;const drained=new Promise<void>(r=>done=r);const releases:(()=>Promise<void>)[]=[];
   try{
    // 本人任务的每位冻结贡献者及历史pool依赖均注册；删除会先终止模型并等待排空。
    const generations=await this.storage.execute<{contactId:string;generation:string}[]>('memoryAdjudication.holders',{ownerId:this.ownerId,attemptId:first.attemptId});
    for(const c of generations)releases.push(this.holders.register({ownerId:this.ownerId,key:`memory-adjudication:${first.attemptId}:${c.contactId}`,contactId:c.contactId,coversAllSources:true,generation:BigInt(c.generation),close:async()=>{controller.abort();await drained;}}));
    if(first.basis.item.similar.length&&!requiresMultimodalRelationReview(first.basis.item)){
     if(!this.port)throw new StorageFailure('adjudication_model_unconfigured');
     for(let pageIndex=0;pageIndex<Math.ceil(first.basis.item.similar.length/8);pageIndex++){
      const pageItem={...first.basis.item,similar:first.basis.item.similar.slice(pageIndex*8,pageIndex*8+8)};
      const runtime=new DshMemoryAdjudicationRuntime({batchKey:`${first.attemptId}:${pageIndex}`,port:{call:async input=>{
       const purpose=input.purpose;if(!purpose)throw new StorageFailure('memory_adjudication_purpose_invalid');
       const stage=purpose==='adjudication'&&pageIndex===0?first!:await this.storage.execute<AdjudicationClaim>('memoryAdjudication.stage',{ownerId:this.ownerId,attemptId:first!.attemptId,purpose,pageIndex});if(stage!==first)claims.push(stage);
       return this.call(input,stage,signal);
      }}});
      const decisions=await runtime.adjudicate([pageItem],signal);
      await runtime.verifyRelations([pageItem],decisions,signal);
      if(decisions[0]?.action==='merge')await runtime.verifyMerge(pageItem,decisions[0],[...new Set([...pageItem.candidate.source_message_ids,...pageItem.similar.filter(p=>decisions[0]!.merged_memory_ids?.includes(p.memory_id)).flatMap(p=>p.source_message_ids)])],pageItem.relation_source_receipt,signal);
     }
    }
    signal.throwIfAborted();results.push(await this.storage.execute('memoryAdjudication.finish',{ownerId:this.ownerId,attemptIds:claims.map(c=>c.attemptId)}));
   }catch(error){
    const code=typeof (error as any)?.code==='string'?(error as any).code:'memory_adjudication_failed';
    await this.storage.execute('memoryAdjudication.fail',{ownerId:this.ownerId,attemptIds:claims.map(c=>c.attemptId),code});
    if(code==='adjudication_model_unconfigured')break;
   }finally{done();await Promise.all(releases.map(release=>release()));}
  }
  return {candidateIds:imported.candidateIds,decisions:results};
 }
 private async call(input:StructuredAdjudicationCallInput,stage:AdjudicationClaim,signal:AbortSignal){
  const request:SqliteAdjudicationModelRequest={purpose:input.purpose!,system:input.system,user:input.user,tool:{name:String(input.schema.title),description:'按固定结构返回记忆裁决与逐字来源核验。',parameters:input.schema},validateOutput:input.validateOutput};
  const scope={owner_id:this.ownerId,contact_id:stage.basis.contactId};
  const requireCurrent=async()=>{signal.throwIfAborted();await this.storage.execute('memoryAdjudication.current',{ownerId:this.ownerId,attemptId:stage.attemptId});};
  const prepared=await this.port!.prepare(request,{scope,signal,requireCurrent});
  const call=await this.storage.execute<{callId:string;requestId:string}>('memoryAdjudication.prepareCall',{ownerId:this.ownerId,attemptId:stage.attemptId,purpose:request.purpose,request:{purpose:request.purpose,system:request.system,user:request.user,tool:request.tool},provider:prepared.provider,model:prepared.model,configurationId:prepared.configurationId,inputCap:prepared.maxInputTokens,outputCap:prepared.maxOutputTokens});
  const result=await this.port!.invoke(request,{scope,signal,requireCurrent,claim:stage.claim,requestId:call.requestId,attemptId:call.callId,onReceipt:async receipt=>{await this.storage.execute('memoryExtraction.receipt',{receipt});}});
  await requireCurrent();await this.storage.execute('memoryAdjudication.output',{ownerId:this.ownerId,attemptId:stage.attemptId,callId:call.callId,blocks:result.blocks});return result;
 }
 close():Promise<void>{return this.closing??=(async()=>{this.stopped.abort();await Promise.allSettled([...this.pending]);await this.port?.close();})().catch(error=>{this.closing=undefined;throw error;});}
}
