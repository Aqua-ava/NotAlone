import {randomUUID} from 'node:crypto';
import {StorageFailure,type StorageTransaction,type StorageRow} from '../../storage/sqlite/contracts.ts';
import {requireSkillRun} from '../../skills/sqlite/storage.ts';
import type {SkillRunRevision} from '../../skills/sqlite/contracts.ts';
import {requireDiscussionContact} from './actions.ts';
import {hasCurrentReplyDependencies} from './provenance.ts';
import {encode} from './requests.ts';

function fail(code:string):never{throw new StorageFailure(code);}
/** 只核验非Skill资料；精确记忆／文档资格由reply.dropSkill的正式reader先复验。 */
export function requireSkillFallbackSources(tx:StorageTransaction,i:any,context:StorageRow):void{
 const contact=requireDiscussionContact(tx,i.ownerId,i.contactId),owner=tx.get('SELECT * FROM owner WHERE owner_id=?',[i.ownerId])!;
 if(context.preference_revision!==owner.preference_revision||context.owner_memory_revision!==owner.memory_revision||context.contact_memory_revision!==contact.memory_revision)fail('discussion_source_unavailable');
 if(!hasCurrentReplyDependencies(tx,{ownerId:i.ownerId,requestIds:[i.requestId]}))fail('discussion_source_unavailable');
 for(const item of tx.all('SELECT * FROM reply_context_item WHERE owner_id=? AND context_id=?',[i.ownerId,i.contextId])){
  if(item.kind==='entry'){
   const entry=tx.get("SELECT e.origin_request_id FROM discussion_entry e JOIN reply_request r ON r.owner_id=e.owner_id AND r.id=e.origin_request_id WHERE e.owner_id=? AND e.contact_id=? AND e.discussion_id=? AND e.id=? AND e.content_state='available' AND r.state<>'invalidated'",[i.ownerId,i.contactId,i.discussionId,item.entry_id]);
   if(!entry)fail('discussion_source_unavailable');
  }
 }
}

/** 旧运行副本先实际销毁，再原子建立无Skill上下文；不放宽不可变快照的数据库约束。 */
export function dropSkillContext(tx:StorageTransaction,i:any,context:StorageRow):{contextId:string;newRevision:SkillRunRevision}{
 requireSkillFallbackSources(tx,i,context);
 if(tx.get("SELECT 1 FROM execution_event WHERE owner_id=? AND reply_attempt_id=? AND kind='skill_unavailable'",[i.ownerId,i.attemptId]))fail('discussion_skill_fallback_used');
 if(tx.get('SELECT 1 FROM runtime_context WHERE owner_id=? AND context_id=?',[i.ownerId,i.contextId]))fail('discussion_skill_runtime_not_discarded');
 const newRevision:SkillRunRevision={packages:tx.all('SELECT id,head_revision FROM skill_package WHERE owner_id=? ORDER BY directory_name',[i.ownerId]).map(p=>({id:String(p.id),headRevision:p.head_revision as bigint})),eligible:[]};
 requireSkillRun(tx,i.ownerId,newRevision);
 const contextId=randomUUID();
 tx.run(`INSERT INTO reply_context SELECT owner_id,?,contact_id,discussion_id,origin_kind,attempt_id,request_id,preference_revision,
  (SELECT skill_revision FROM owner WHERE owner_id=?),owner_memory_revision,contact_memory_revision,?,frozen_at,state FROM reply_context WHERE owner_id=? AND id=?`,[contextId,i.ownerId,encode(newRevision),i.ownerId,i.contextId]);
 tx.run("INSERT INTO reply_context_item SELECT owner_id,?,item_no,kind,role,presentation_no,source_contact_id,message_id,record_id,accepted_revision,entry_id,package_id,package_revision_no FROM reply_context_item WHERE owner_id=? AND context_id=? AND kind<>'skill'",[contextId,i.ownerId,i.contextId]);
 const candidate=tx.get('SELECT 1 FROM reply_candidate_context WHERE owner_id=? AND context_id=?',[i.ownerId,i.contextId]);
 if(candidate){
  tx.run('INSERT INTO reply_candidate_context SELECT owner_id,?,owner_memory_revision,contact_memory_revision,owner_document_revision,contact_document_revision FROM reply_candidate_context WHERE owner_id=? AND context_id=?',[contextId,i.ownerId,i.contextId]);
  tx.run('INSERT INTO reply_candidate_input SELECT owner_id,?,item_no,kind,identity_json,text_body FROM reply_candidate_input WHERE owner_id=? AND context_id=?',[contextId,i.ownerId,i.contextId]);
  tx.run('INSERT INTO reply_candidate_input_source SELECT owner_id,?,item_no,source_contact_id,record_id,message_id,accepted_revision FROM reply_candidate_input_source WHERE owner_id=? AND context_id=?',[contextId,i.ownerId,i.contextId]);
 }
 // 选择目录、正文、工具结果都可能出现在完整请求中；保留每次物理调用的无正文预算与回执。
 tx.run("DELETE FROM execution_event WHERE owner_id=? AND reply_attempt_id=? AND kind IN ('skill_selection','skill_input','model_request')",[i.ownerId,i.attemptId]);
 tx.run('UPDATE model_call SET reply_context_id=? WHERE owner_id=? AND reply_attempt_id=? AND reply_context_id=?',[contextId,i.ownerId,i.attemptId,i.contextId]);
 if(candidate){
  tx.run('DELETE FROM reply_candidate_input_source WHERE owner_id=? AND context_id=?',[i.ownerId,i.contextId]);
  tx.run('DELETE FROM reply_candidate_input WHERE owner_id=? AND context_id=?',[i.ownerId,i.contextId]);
  tx.run('DELETE FROM reply_candidate_context WHERE owner_id=? AND context_id=?',[i.ownerId,i.contextId]);
 }
 tx.run('DELETE FROM reply_context_item WHERE owner_id=? AND context_id=?',[i.ownerId,i.contextId]);
 tx.run('DELETE FROM reply_context WHERE owner_id=? AND id=?',[i.ownerId,i.contextId]);
 return {contextId,newRevision};
}
