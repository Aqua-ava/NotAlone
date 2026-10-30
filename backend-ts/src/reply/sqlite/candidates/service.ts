import type {SqliteStorage} from '../../../storage/sqlite/client.ts';
export class SqliteReplyCandidateService {
 private readonly storage:SqliteStorage;readonly ownerId:string;
 constructor(storage:SqliteStorage,ownerId:string){this.storage=storage;this.ownerId=ownerId;}
 begin(input:{contactId:string;discussionId:string;requestKey:string;text:string;identity:{kind:'manual';confirmationId:string}|{kind:'binding';bindingId:string;verificationId:string};acceptIncomplete?:boolean;carriedSelectionId?:string}){
  return this.storage.execute<any>('reply.begin',{...input,ownerId:this.ownerId,expectedDiscussionId:input.discussionId,at:Date.now()});
 }
 view(contactId:string,discussionId:string){return this.storage.execute<any[]>('reply.view',{ownerId:this.ownerId,contactId,discussionId});}
 version(input:{contactId:string;discussionId:string;candidateId:string;versionNo:number}){return this.storage.execute<any>('reply.version',{...input,ownerId:this.ownerId});}
 edit(input:{contactId:string;discussionId:string;candidateId:string;versionNo:number;parts:string[]}){return this.storage.execute<any>('reply.edit',{...input,ownerId:this.ownerId});}
 select(input:{contactId:string;discussionId:string;candidateId:string;versionNo:number}){return this.storage.execute<any>('reply.select',{...input,ownerId:this.ownerId});}
}
