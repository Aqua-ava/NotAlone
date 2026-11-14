import type {SqliteStorage} from '../../../storage/sqlite/client.ts';
import type {StorageReader} from '../../../storage/sqlite/contracts.ts';
import type {ReplyGenerationPhase,ReplyGenerationStatus} from './contracts.ts';
export class SqliteReplyCandidateService {
 private readonly storage:SqliteStorage;private readonly reader:Pick<StorageReader,'execute'>;readonly ownerId:string;
 private readonly phases=new Map<string,ReplyGenerationPhase>();
 private readonly preparationFailures=new Map<string,ReplyGenerationStatus>();
 constructor(storage:SqliteStorage,ownerId:string,reader:Pick<StorageReader,'execute'>=storage){this.storage=storage;this.reader=reader;this.ownerId=ownerId;}
 begin(input:{contactId:string;discussionId:string;requestKey:string;text:string;identity:{kind:'manual';confirmationId:string}|{kind:'binding';bindingId:string;verificationId:string};acceptIncomplete?:boolean;carriedSelectionId?:string;includeRelationshipContext?:boolean;workspaceFingerprint?:string}){
  return this.storage.execute<any>('reply.begin',{...input,ownerId:this.ownerId,expectedDiscussionId:input.discussionId,at:Date.now()});
 }
 view(contactId:string,discussionId:string,options:{includeSkillText?:boolean;limit?:number}={}){return this.reader.execute<any[]>('reply.view',{ownerId:this.ownerId,contactId,discussionId,...options});}
 skillInputs(input:{contactId:string;discussionId:string;requestId:string;offset:number}){return this.reader.execute<any>('reply.skillInputs',{...input,ownerId:this.ownerId});}
 inputMaterials(input:{contactId:string;discussionId:string;requestId:string;offset:number}){return this.reader.execute<any>('reply.inputs',{...input,ownerId:this.ownerId});}
 phase(contactId:string,discussionId:string,requestKey:string,phase:ReplyGenerationPhase|null):void{
  const key=JSON.stringify([contactId,discussionId,requestKey]);if(phase===null)this.phases.delete(key);else this.phases.set(key,phase);
 }
 /** 仅保存尚未进入模型执行的失败回执；死存储不能写入时供原请求核对，重启后由持久恢复结算。 */
 preparationFailed(input:{contactId:string;discussionId:string;requestKey:string;startedAt:number},errorCode:'discussion_preparation_timeout'|'discussion_storage_interrupted'):void{
  const key=JSON.stringify([input.contactId,input.discussionId,input.requestKey]);
  this.preparationFailures.set(key,{requestKey:input.requestKey,phase:'failed',sent:false,abandoned:false,errorCode,retryable:true,startedAt:input.startedAt,finishedAt:Date.now()});
  if(this.preparationFailures.size>64)this.preparationFailures.delete(this.preparationFailures.keys().next().value!);
 }
 async status(contactId:string,discussionId:string,requestKey:string):Promise<ReplyGenerationStatus>{
  const failure=this.preparationFailures.get(JSON.stringify([contactId,discussionId,requestKey]));
  if(failure&&this.storage.failureDiagnostic)return {...failure};
  const status=await this.reader.execute<ReplyGenerationStatus>('reply.status',{ownerId:this.ownerId,contactId,discussionId,requestKey});
  const phase=this.phases.get(JSON.stringify([contactId,discussionId,requestKey]));
  return status.phase==='preparing'&&phase?{...status,phase}:status;
 }
 version(input:{contactId:string;discussionId:string;candidateId:string;versionNo:number}){return this.reader.execute<any>('reply.version',{...input,ownerId:this.ownerId});}
 edit(input:{contactId:string;discussionId:string;candidateId:string;versionNo:number;parts:string[]}){return this.storage.execute<any>('reply.edit',{...input,ownerId:this.ownerId});}
 select(input:{contactId:string;discussionId:string;candidateId:string;versionNo:number}){return this.storage.execute<any>('reply.select',{...input,ownerId:this.ownerId});}
}
