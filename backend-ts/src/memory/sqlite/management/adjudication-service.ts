/** 逐候选建立新快照；每个真实用途使用独立step/attempt和共享ModelHost。 */
import type {SqliteStorage} from '../../../storage/sqlite/client.ts';
import {StorageFailure} from '../../../storage/sqlite/contracts.ts';
import {ActiveHolders} from '../../../storage/sqlite/deletion/holders.ts';
import {DshMemoryAdjudicationRuntime,type StructuredAdjudicationCallInput} from '../../adoption/adjudication-dsh.ts';
import type {SqliteAdjudicationModelPort,SqliteAdjudicationModelRequest} from './model-port.ts';
import {type AdjudicationClaim} from './adjudication-actions.ts';
import {adjudicationPages} from '../../adoption/pages.ts';
import {SqliteMemoryManagement} from './service.ts';
import {createBuiltinMemoryContentRegistry} from '../../content/builtins.ts';
import type {MemoryContentRegistry,MemoryContentResources,FrozenMemoryContent} from '../../content/registry.ts';
import type {ContentCitation} from '../../content/evidence.ts';
import type {StorageRow} from '../../../storage/sqlite/contracts.ts';
import {sha256} from '../../../platform/sha256.ts';
/** 只取供应商失败的稳定分类（名称、码、HTTP 状态），不带上游消息、cause 或请求标识。 */
function providerFailureOf(error:unknown):{name:string;code:string;status?:number}|undefined {
 const source=(error as {cause?:{provider_failure?:unknown}}|null)?.cause?.provider_failure??(error as {provider_failure?:unknown}|null)?.provider_failure;
 const v=source as {name?:unknown;code?:unknown;status?:unknown}|null|undefined;
 if(!v||typeof v!=='object'||typeof v.name!=='string'||typeof v.code!=='string')return undefined;
 return {name:v.name,code:v.code,...(typeof v.status==='number'?{status:v.status}:{})};
}
export class SqliteMemoryAdjudication {
 private readonly stopped=new AbortController();private active=new Map<string,{contactId:string|undefined;retryKnownFailures:boolean;work:Promise<unknown>}>();private closing?:Promise<void>;
 private storage:SqliteStorage;readonly ownerId:string;private port:SqliteAdjudicationModelPort|undefined;private holders:ActiveHolders;private content:{registry:MemoryContentRegistry;resources?:MemoryContentResources};
 constructor(storage:SqliteStorage,ownerId:string,port:SqliteAdjudicationModelPort|undefined,holders:ActiveHolders,content:{registry:MemoryContentRegistry;resources?:MemoryContentResources}={registry:createBuiltinMemoryContentRegistry()}){this.storage=storage;this.ownerId=ownerId;this.port=port;this.holders=holders;this.content=content;}
 async initialize(){const attempts=await this.storage.execute<string[]>('memoryAdjudication.interrupted',{ownerId:this.ownerId});if(attempts.length)await this.storage.execute('memoryAdjudication.fail',{ownerId:this.ownerId,attemptIds:attempts,code:'runtime_interrupted'});}
 /** 显式联系人只处理该范围的候选；省略时保持整轮裁决，同轮在途工作不得借重复请求更换范围。 */
 publishRun(runId:string,contactId?:string,options:{retryKnownFailures?:boolean}={}):Promise<unknown>{
  if(this.stopped.signal.aborted)return Promise.reject(new StorageFailure('memory_adjudication_closed'));
  const retryKnownFailures=options.retryKnownFailures===true;
  if(retryKnownFailures&&!contactId)return Promise.reject(new StorageFailure('memory_adjudication_scope_invalid'));
  const prior=this.active.get(runId);if(prior)return prior.contactId===contactId&&prior.retryKnownFailures===retryKnownFailures?prior.work:Promise.reject(new StorageFailure('memory_adjudication_run_busy'));
  const work=this.publish(runId,contactId,retryKnownFailures);this.active.set(runId,{contactId,retryKnownFailures,work});void work.then(()=>this.active.delete(runId),()=>this.active.delete(runId));return work;
 }
 private async publish(runId:string,contactId?:string,retryKnownFailures=false){
  const imported=await new SqliteMemoryManagement(this.storage,this.ownerId).importRun(runId,contactId),results:unknown[]=[];
  for(const candidateId of imported.candidateIds){
   if(this.stopped.signal.aborted)break;
   let first:AdjudicationClaim|null;
   try{first=await this.storage.execute('memoryAdjudication.claim',{ownerId:this.ownerId,candidateId,...(contactId?{contactId}:{}),...(retryKnownFailures?{retryKnownFailures:true}:{})});}
   catch(error){
    if(error instanceof StorageFailure&&['memory_candidate_stale','memory_source_stale','memory_extraction_scope_stale','memory_extraction_source_stale','memory_extraction_output_not_eligible'].includes(error.code))continue;
    // 未知回执尚未核实：本轮裁决整体停止，不再为其余候选制造注定失败的尝试；候选保持待处理。
    if(error instanceof StorageFailure&&error.code==='memory_adjudication_receipt_unknown')break;
    throw error;
   }
   if(!first)continue;
   const claims=[first],controller=new AbortController(),signal=AbortSignal.any([controller.signal,this.stopped.signal]);
   let done!:()=>void;const drained=new Promise<void>(r=>done=r);const releases:(()=>Promise<void>)[]=[];
   try{
    // 本人任务的每位冻结贡献者及历史pool依赖均注册；删除会先终止模型并等待排空。
    const generations=await this.storage.execute<{contactId:string;generation:string}[]>('memoryAdjudication.holders',{ownerId:this.ownerId,attemptId:first.attemptId});
    for(const c of generations)releases.push(this.holders.register({ownerId:this.ownerId,key:`memory-adjudication:${first.attemptId}:${c.contactId}`,contactId:c.contactId,coversAllSources:true,generation:BigInt(c.generation),close:async()=>{controller.abort();await drained;}}));
    if(first.basis.item.similar.length){
     if(!this.port)throw new StorageFailure('adjudication_model_unconfigured');
     const pages=adjudicationPages(first.basis.item);
     for(const [pageIndex,pageItem] of pages.entries()){
      const runtime=new DshMemoryAdjudicationRuntime({batchKey:`${first.attemptId}:${pageIndex}`,port:{call:async input=>{
       const purpose=input.purpose;if(!purpose)throw new StorageFailure('memory_adjudication_purpose_invalid');
       const stage=purpose==='adjudication'&&pageIndex===0?first!:await this.storage.execute<AdjudicationClaim>('memoryAdjudication.stage',{ownerId:this.ownerId,attemptId:first!.attemptId,purpose,pageIndex});if(stage!==first)claims.push(stage);
       return this.call(input,stage,signal,claims);
      }}});
      const decisions=await runtime.adjudicate([pageItem],signal);
      await runtime.verifyRelations([pageItem],decisions,signal);
      if(decisions[0]?.action==='merge')await runtime.verifyMerge(pageItem,decisions[0],[...new Set([...pageItem.candidate.source_message_ids,...pageItem.similar.filter(p=>decisions[0]!.merged_memory_ids?.includes(p.memory_id)).flatMap(p=>p.source_message_ids)])],pageItem.relation_source_receipt,signal);
     }
    }
    signal.throwIfAborted();results.push(await this.storage.execute('memoryAdjudication.finish',{ownerId:this.ownerId,attemptIds:claims.map(c=>c.attemptId)}));
   }catch(error){
    const code=typeof (error as any)?.code==='string'?(error as any).code:'memory_adjudication_failed';
    const providerFailure=providerFailureOf(error);
    await this.storage.execute('memoryAdjudication.fail',{ownerId:this.ownerId,attemptIds:claims.map(c=>c.attemptId),code,...(providerFailure?{providerFailure}:{})});
    if(code==='adjudication_model_unconfigured')break;
   }finally{done();await Promise.all(releases.map(release=>release()));}
  }
  return {candidateIds:imported.candidateIds,decisions:results};
 }
 private async call(input:StructuredAdjudicationCallInput,stage:AdjudicationClaim,signal:AbortSignal,claims:readonly AdjudicationClaim[]){
  const request:SqliteAdjudicationModelRequest={purpose:input.purpose!,system:input.system,user:input.user,tool:{name:String(input.schema.title),description:'按固定结构返回记忆裁决与真实来源核验。',parameters:input.schema},validateOutput:input.validateOutput};
  const scope={owner_id:this.ownerId,contact_id:stage.basis.contactId};
  const requireCurrent=async()=>{signal.throwIfAborted();await this.storage.execute('memoryAdjudication.current',{ownerId:this.ownerId,attemptId:stage.attemptId});};
  const materials=await this.storage.execute<{contactId:string;message:StorageRow;frozen:FrozenMemoryContent;citation:ContentCitation}[]>('memoryAdjudication.materials',{ownerId:this.ownerId,attemptId:stage.attemptId,sources:input.sources??[]});
  const images=new Map<string,NonNullable<SqliteAdjudicationModelRequest['images']>[number]>();
  for(const material of materials){
   const prepared=await this.content.registry.prepareCitation({ownerId:this.ownerId,...material,resources:this.content.resources,signal,requireCurrent});
   for(const image of prepared.images??[]){const prior=images.get(image.id);if(prior&&prior.dataBase64!==image.dataBase64)throw new StorageFailure('memory_content_source_stale');images.set(image.id,image);}
  }
  if(images.size)request.images=[...images.values()];
  const prepared=await this.port!.prepare(request,{scope,signal,requireCurrent});
  const call=await this.storage.execute<{callId:string;requestId:string}>('memoryAdjudication.prepareCall',{ownerId:this.ownerId,attemptId:stage.attemptId,purpose:request.purpose,request:{purpose:request.purpose,system:request.system,user:request.user,tool:request.tool,...(request.images?.length?{images:request.images.map(image=>({id:image.id,mimeType:image.mimeType,sourceSha256:image.sourceSha256??sha256(Buffer.from(image.dataBase64,'base64')),requestSha256:sha256(Buffer.from(image.dataBase64,'base64')),bytes:Buffer.byteLength(image.dataBase64,'base64')}))}:{})},provider:prepared.provider,model:prepared.model,configurationId:prepared.configurationId,inputCap:prepared.maxInputTokens,outputCap:prepared.maxOutputTokens});
  const result=await this.port!.invoke(request,{scope,signal,requireCurrent,claim:stage.claim,requestId:call.requestId,attemptId:call.callId,onImageInputs:async images=>{await this.storage.execute('memoryAdjudication.imageInputs',{ownerId:this.ownerId,attemptId:stage.attemptId,callId:call.callId,images});},onReceipt:async receipt=>{await this.storage.execute('memoryExtraction.receipt',{receipt});}});
  await requireCurrent();await this.storage.execute('memoryAdjudication.output',{ownerId:this.ownerId,attemptId:stage.attemptId,callId:call.callId,blocks:result.blocks});
  signal.throwIfAborted();await this.storage.execute('memoryAdjudication.renew',{ownerId:this.ownerId,attemptIds:claims.map(claim=>claim.attemptId),progressCallId:call.callId});return result;
 }
 close():Promise<void>{return this.closing??=(async()=>{this.stopped.abort();await Promise.allSettled([...this.active.values()].map(entry=>entry.work));await this.port?.close();})().catch(error=>{this.closing=undefined;throw error;});}
}
