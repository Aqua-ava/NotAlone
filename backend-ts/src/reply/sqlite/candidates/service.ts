import type {SqliteStorage} from '../../../storage/sqlite/client.ts';
import type {StorageReader} from '../../../storage/sqlite/contracts.ts';
import type {ReplyGenerationPhase,ReplyGenerationStatus} from './contracts.ts';
export class SqliteReplyCandidateService {
 private readonly storage:SqliteStorage;private readonly reader:Pick<StorageReader,'execute'>;readonly ownerId:string;
 private readonly phases=new Map<string,ReplyGenerationPhase>();
 constructor(storage:SqliteStorage,ownerId:string,reader:Pick<StorageReader,'execute'>=storage){this.storage=storage;this.reader=reader;this.ownerId=ownerId;}
 begin(input:{contactId:string;discussionId:string;requestKey:string;text:string;identity:{kind:'manual';confirmationId:string}|{kind:'binding';bindingId:string;verificationId:string};acceptIncomplete?:boolean;carriedSelectionId?:string;includeRelationshipContext?:boolean;workspaceFingerprint?:string}){
  return this.storage.execute<any>('reply.begin',{...input,ownerId:this.ownerId,expectedDiscussionId:input.discussionId,at:Date.now()});
 }
 view(contactId:string,discussionId:string){return this.reader.execute<any[]>('reply.view',{ownerId:this.ownerId,contactId,discussionId});}
 recentHistory(contactId:string){return this.reader.execute<any>('history.readRecent',{ownerId:this.ownerId,contactId,limit:50});}
 phase(contactId:string,discussionId:string,requestKey:string,phase:ReplyGenerationPhase|null):void{
  const key=JSON.stringify([contactId,discussionId,requestKey]);if(phase===null)this.phases.delete(key);else this.phases.set(key,phase);
 }
 async status(contactId:string,discussionId:string,requestKey:string):Promise<ReplyGenerationStatus>{
  const status=await this.reader.execute<ReplyGenerationStatus>('reply.status',{ownerId:this.ownerId,contactId,discussionId,requestKey});
  const phase=this.phases.get(JSON.stringify([contactId,discussionId,requestKey]));
  return status.phase==='preparing'&&phase?{...status,phase}:status;
 }
 version(input:{contactId:string;discussionId:string;candidateId:string;versionNo:number}){return this.reader.execute<any>('reply.version',{...input,ownerId:this.ownerId});}
 edit(input:{contactId:string;discussionId:string;candidateId:string;versionNo:number;parts:string[]}){return this.storage.execute<any>('reply.edit',{...input,ownerId:this.ownerId});}
 select(input:{contactId:string;discussionId:string;candidateId:string;versionNo:number}){return this.storage.execute<any>('reply.select',{...input,ownerId:this.ownerId});}
}
