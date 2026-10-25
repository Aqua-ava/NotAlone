/** 公开运输只按持久授权选择范围；公开正文不能声明已验证身份。 */
import type {HostStorage} from './host-storage.ts';
import type {VerifiedReplyScope} from './reply-scope.ts';
import {ReplyError} from './reply-contract.ts';
import {AsyncLocalStorage} from 'node:async_hooks';
import type {Client} from 'pg';
import {AssistantDiscussionError,type AssistantDiscussionScope} from './assistant-discussion-service.ts';
const requestScope=new AsyncLocalStorage<{scope:Readonly<VerifiedReplyScope>;active:boolean}>();
/** 只保存已认证且已核验的范围；callback结束后不把身份留作后台缺省值。 */
export function withPublicReplyScope<T>(scope:VerifiedReplyScope,work:()=>Promise<T>):Promise<T>{
 const context={scope:Object.freeze({...scope}),active:true};
 return requestScope.run(context,async()=>{try{return await work();}finally{context.active=false;}});
}
export function withoutPublicReplyScope<T>(work:()=>Promise<T>):Promise<T>{return requestScope.exit(work);}
export async function resolveRequestBinding(client:Client,scope:AssistantDiscussionScope,allowManual=true):Promise<string>{
 const context=requestScope.getStore(),current=context?.active?context.scope:undefined;
 if(current&&(current.owner_id!==scope.owner_id||current.contact_id!==scope.contact_id))throw new AssistantDiscussionError('conflict','binding_changed');
 const manual=allowManual&&current?.confirmation==='manual';
 const rows=manual
  ?(await client.query('SELECT id FROM manual_contact_confirmation WHERE owner_id=$1 AND contact_id=$2 FOR SHARE',[scope.owner_id,scope.contact_id])).rows
  :(await client.query("SELECT id FROM conversation_binding WHERE owner_id=$1 AND contact_id=$2 AND status='active' FOR SHARE",[scope.owner_id,scope.contact_id])).rows;
 if(rows.length>1)throw new AssistantDiscussionError('conflict','binding_ambiguous');
 if(current&&(allowManual||current.confirmation==='desktop')){
  if(rows.length!==1||rows[0].id!==current.conversation_binding_id)throw new AssistantDiscussionError('conflict',manual?'manual_contact_unconfirmed':'binding_changed');
  return rows[0].id;
 }
 if(rows.length===1)return rows[0].id;
 if(!allowManual)throw new AssistantDiscussionError('conflict','no_active_binding');
 const fallback=(await client.query('SELECT id FROM manual_contact_confirmation WHERE owner_id=$1 AND contact_id=$2 FOR SHARE',[scope.owner_id,scope.contact_id])).rows;
 if(fallback.length!==1)throw new AssistantDiscussionError('conflict','no_active_binding');
 return fallback[0].id;
}
export async function resolvePublicReplyScope(storage:HostStorage,contact:string,manual=false):Promise<VerifiedReplyScope>{
 const owner=storage.runtimeOwnerId;
 if(!owner)throw new ReplyError('owner_uninitialized',503);
 const rows=await storage.businessReadTransaction(async client=>{
  return manual
   ?(await client.query('SELECT id FROM manual_contact_confirmation WHERE owner_id=$1 AND contact_id=$2',[owner,contact])).rows
   :(await client.query("SELECT id FROM conversation_binding WHERE owner_id=$1 AND contact_id=$2 AND status='active'",[owner,contact])).rows;
 });
 if(rows.length!==1)throw Object.assign(new ReplyError('reply_rejected',409),{reason:manual?'manual_contact_unconfirmed':rows.length?'binding_ambiguous':'no_active_binding'});
 return {owner_id:owner,contact_id:contact,conversation_binding_id:rows[0].id,confirmation:manual?'manual':'desktop'};
}
