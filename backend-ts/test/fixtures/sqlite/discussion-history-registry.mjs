import {registry as discussionRegistry} from './discussion-registry.mjs';

export const registry={
 ...discussionRegistry,
 actions:[...discussionRegistry.actions,
  {name:'discussionHistory.snapshot',mode:'read',retryBusy:false,execute(tx,i){return {
   discussions:tx.all('SELECT id,is_current,last_activity_at,current_runtime_id,state FROM assistant_discussion WHERE owner_id=? AND contact_id=? ORDER BY id',[i.ownerId,i.contactId]),
   runtimeCopies:tx.all('SELECT id,discussion_id,state FROM runtime_copy WHERE owner_id=? AND contact_id=? ORDER BY id',[i.ownerId,i.contactId]),
   requestCount:tx.get('SELECT COUNT(*) count FROM reply_request WHERE owner_id=? AND contact_id=?',[i.ownerId,i.contactId]).count,
   modelCallCount:tx.get('SELECT COUNT(*) count FROM model_call WHERE owner_id=?',[i.ownerId]).count,
  };}},
  {name:'discussionHistory.seedRuntimeForTest',mode:'write',retryBusy:false,execute(tx,i){
   const contact=tx.get("SELECT data_generation,source_revision FROM contact WHERE owner_id=? AND id=? AND state='active'",[i.ownerId,i.contactId]);
   if(!contact||!tx.get("SELECT 1 FROM assistant_discussion WHERE owner_id=? AND contact_id=? AND id=? AND state='active'",[i.ownerId,i.contactId,i.discussionId]))throw new Error('合成运行副本缺少真实讨论范围');
   tx.run("INSERT INTO runtime_copy(owner_id,id,contact_id,discussion_id,sdk_instance_id,managed_locator,address_json,write_generation,accepted_data_generation,source_revision,state) VALUES(?,?,?,?,?,?,NULL,0,?,?,'blocked')",[i.ownerId,i.copyId,i.contactId,i.discussionId,`sdk-${i.copyId}`,`synthetic/${i.copyId}`,contact.data_generation,contact.source_revision]);
   tx.run('UPDATE assistant_discussion SET current_runtime_id=? WHERE owner_id=? AND contact_id=? AND id=?',[i.copyId,i.ownerId,i.contactId,i.discussionId]);
  }},
  {name:'discussionHistory.invalidateSourceForTest',mode:'write',retryBusy:false,execute(tx,i){
   const request=tx.get('SELECT id FROM reply_request WHERE owner_id=? AND contact_id=? AND discussion_id=? AND id=?',[i.ownerId,i.contactId,i.discussionId,i.requestId]);
   if(!request)throw new Error('合成来源失效缺少真实讨论请求');
   tx.run("UPDATE reply_attempt SET state='invalidated',error_code='source_deleted',finished_at=? WHERE owner_id=? AND request_id=? AND state<>'invalidated'",[i.at,i.ownerId,i.requestId]);
   tx.run("UPDATE reply_request SET state='invalidated' WHERE owner_id=? AND id=?",[i.ownerId,i.requestId]);
   tx.run("UPDATE discussion_entry SET body=NULL,content_state='cleared',origin_call_id=NULL,origin_event_id=NULL WHERE owner_id=? AND origin_request_id=? AND content_state='available'",[i.ownerId,i.requestId]);
  }},
 ]};
