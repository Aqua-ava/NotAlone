import {randomUUID} from 'node:crypto';
import type {SqliteStorage} from '../../storage/sqlite/client.ts';
import type {Discussion} from './contracts.ts';
/** 回看/继续/新开均不触发模型；生成受理端才调用forRequest。 */
export class SqliteDiscussionService {
 private readonly storage:SqliteStorage;readonly ownerId:string;private readonly clock:()=>number;
 constructor(storage:SqliteStorage,ownerId:string,clock:()=>number=Date.now){this.storage=storage;this.ownerId=ownerId;this.clock=clock;}
 private execute<T=any>(name:string,input:object):Promise<T>{return this.storage.execute(`discussion.${name}`,{ownerId:this.ownerId,at:this.clock(),...input});}
 trace(contactId:string,discussionId:string,requestId:string){return this.execute('trace',{contactId,discussionId,requestId});}
 list(contactId:string){return this.execute<{currentDiscussionId:string|null;discussions:Discussion[]}>('list',{contactId});}
 view(contactId:string,discussionId:string){return this.execute('view',{contactId,discussionId});}
 newDiscussion(contactId:string){return this.execute<Discussion>('new',{contactId,id:randomUUID()});}
 forRequest(contactId:string){return this.execute<{discussion:Discussion;segmented:boolean}>('forRequest',{contactId,id:randomUUID()});}
 begin(contactId:string,requestKey:string,text:string,identity:{kind:'manual';confirmationId:string}|{kind:'binding';bindingId:string;verificationId:string}){return this.execute('begin',{contactId,requestKey,text,identity,discussionId:randomUUID(),requestId:randomUUID(),entryId:randomUUID(),attemptId:randomUUID(),leaseToken:randomUUID()});}
 continueDiscussion(contactId:string,discussionId:string){return this.execute<Discussion>('continue',{contactId,discussionId});}
}
