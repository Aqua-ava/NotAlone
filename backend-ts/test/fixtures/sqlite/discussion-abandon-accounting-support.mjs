import {randomUUID} from 'node:crypto';
import {fixture,owner} from '../memory-sqlite/support.mjs';
import {SqliteDiscussionService} from '../../../src/reply/sqlite/service.ts';
export async function accountingFixture(t){
 const f=await fixture(t,{registryModule:new URL('./discussion-abandon-accounting-registry.mjs',import.meta.url).href});
 const contactId=f.saved[0].contact_id;
 await f.service.synchronize(contactId);await f.contacts.setReading(false);
 t.after(async()=>{await f.service.close();await f.contacts.close();});
 return {...f,owner,contactId,discussions:new SqliteDiscussionService(f.storage,owner)};
}
/** 合成发送授权与失联，不接触外部模型或真实聊天。 */
export async function failAuthorizedDiscussion(f){
 const {contactId}=f,requestKey=randomUUID();
 const confirmationId=await f.contacts.manualConfirm(contactId,requestKey);
 const {attempt}=await f.discussions.begin(contactId,requestKey,'合成的未知调用',{kind:'manual',confirmationId});
 const input={...attempt,contextId:randomUUID(),callId:randomUUID()},operationId=randomUUID();
 const ids=await f.storage.execute('discussion.localMessages',{...input,limit:10});
 const message=(await f.storage.execute('discussion.messages',{...input,messageIds:[ids[0].id]}))[0];
 await f.storage.execute('discussion.freezeContext',{...input,skillRun:{packages:[],eligible:[]},items:[{kind:'message',sourceContactId:contactId,messageId:message.id,recordId:message.record_id,acceptedRevision:message.interpretation_revision}],at:Date.now()});
 await f.storage.execute('discussion.prepareCall',{...input,operationId,provider:'synthetic-no-network',model:'synthetic',configurationId:'a'.repeat(64),inputCap:1024,outputCap:128,requestKey:input.callId,inputSeal:'b'.repeat(64)});
 await f.storage.execute('discussionTest.markSending',{ownerId:f.owner,callId:input.callId});
 await f.storage.execute('discussion.failCall',{...input,dispatched:true,code:'discussion_generation_timeout',failure:{kind:'error',code:'TIMEOUT',dispatch:'authorized_unconfirmed'}});
 return {input,operationId,message};
}
