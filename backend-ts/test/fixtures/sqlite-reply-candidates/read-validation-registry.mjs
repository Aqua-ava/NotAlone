import {registry as base} from './document-registry.mjs';
import {withReplyValidation,requireFrozenReplyKnowledge,requireReplyValidation} from '../../../src/reply/sqlite/candidates/validation.ts';
import {replyLocalKnowledgeReader} from '../../../src/memory/sqlite/documents/knowledge.ts';
import {decode} from '../../../src/reply/sqlite/requests.ts';

const actions=new Map(base.actions.map(action=>[action.name,action]));
export const registry={...base,actions:[...base.actions,{
 name:'fixture.measureCandidateRead',mode:'read',retryBusy:false,
 execute(tx,input,lease){
  const action=actions.get({view:'reply.view',version:'reply.version',inputs:'reply.inputs'}[input.action]);
  if(!action)throw new Error('合成候选读取动作无效');
  const metrics={queries:0,verificationInputReads:0,verificationOutputReads:0,sourceQueries:0,dependencyChecks:0,contextChecks:0};
  const counted={...tx};for(const method of ['get','all','run'])counted[method]=(sql,values)=>{
   metrics.queries++;
   if(sql==="SELECT payload FROM execution_event WHERE owner_id=? AND originated_call_id=? AND kind='model_input'")metrics.verificationInputReads++;
   if(sql==="SELECT payload FROM execution_event WHERE owner_id=? AND originated_call_id=? AND kind='model_output'")metrics.verificationOutputReads++;
   if(sql.includes('wanted AS ('))metrics.sourceQueries++;
   if(sql==='SELECT state,request_id,contact_id,discussion_id FROM reply_context WHERE owner_id=? AND id=?')metrics.dependencyChecks++;
   if(sql==="SELECT * FROM reply_context WHERE owner_id=? AND id=? AND contact_id=? AND discussion_id=? AND state='active'")metrics.contextChecks++;
   return tx[method](sql,values);
  };
  const started=performance.now(),value=action.execute(counted,input,lease);
  return {value,...metrics,elapsedMs:performance.now()-started};
 },
},{
 name:'fixture.recheckCandidateRead',mode:'write',retryBusy:false,
 execute(tx,input,lease){
  const source=tx.get('SELECT s.* FROM reply_candidate_input_source s JOIN reply_context c ON c.owner_id=s.owner_id AND c.id=s.context_id WHERE s.owner_id=? AND c.discussion_id=? LIMIT 1',[input.ownerId,input.discussionId]);
  const count=scoped=>actions.get('reply.view').execute(scoped,input,lease).flatMap(row=>row.candidates).length;
  const mutated={...tx,flushDerived(){tx.run("UPDATE source_proof SET state='needs_confirmation' WHERE owner_id=? AND contact_id=?",[input.ownerId,input.contactId]);}};
  return withReplyValidation(mutated,scoped=>{
   scoped.run('SAVEPOINT candidate_read_mutation');const before=count(scoped);
   if(input.mutation==='revision')scoped.run('UPDATE message SET interpretation_revision=interpretation_revision+1 WHERE owner_id=? AND contact_id=? AND id=?',[input.ownerId,input.contactId,source.message_id]);
   else if(input.mutation==='delete')scoped.run("UPDATE capture_record SET availability='deleting' WHERE owner_id=? AND contact_id=? AND id=?",[input.ownerId,input.contactId,source.record_id]);
   else if(input.mutation==='revoke')scoped.run("UPDATE conversation_binding SET state='revoked' WHERE owner_id=? AND contact_id=?",[input.ownerId,input.contactId]);
   else if(input.mutation==='flush')scoped.flushDerived();
   else throw new Error('合成失效方式无效');
   const after=count(scoped);scoped.run('ROLLBACK TO candidate_read_mutation');scoped.run('RELEASE candidate_read_mutation');
   return {before,after,restored:count(scoped)};
  });
 },
},{
 name:'fixture.writeDuringCandidateValidation',mode:'write',retryBusy:false,
 execute(tx,input,lease){return withReplyValidation(tx,scoped=>{
  const source=tx.get('SELECT s.*,c.request_id FROM reply_candidate_input_source s JOIN reply_context c ON c.owner_id=s.owner_id AND c.id=s.context_id WHERE s.owner_id=? AND c.discussion_id=? LIMIT 1',[input.ownerId,input.discussionId]);
  const count=()=>actions.get('reply.view').execute(scoped,input,lease).flatMap(row=>row.candidates).length;
  scoped.run('SAVEPOINT candidate_validation_epoch');let before;
  requireReplyValidation(scoped,replyLocalKnowledgeReader,input,'request',String(source.request_id),()=>{
   before=count();
   scoped.run("UPDATE capture_record SET availability='deleting' WHERE owner_id=? AND contact_id=? AND id=?",[input.ownerId,input.contactId,source.record_id]);
  });
  const after=count();scoped.run('ROLLBACK TO candidate_validation_epoch');scoped.run('RELEASE candidate_validation_epoch');
  return {before,after,restored:count()};
 });},
},{
 name:'fixture.invalidateCandidateReadSource',mode:'write',retryBusy:false,
 execute(tx,input){
  const source=tx.get('SELECT s.* FROM reply_candidate_input_source s JOIN reply_context c ON c.owner_id=s.owner_id AND c.id=s.context_id WHERE s.owner_id=? AND c.discussion_id=? LIMIT 1',[input.ownerId,input.discussionId]);
  if(input.mutation==='revision')tx.run('UPDATE message SET interpretation_revision=interpretation_revision+1 WHERE owner_id=? AND contact_id=? AND id=?',[input.ownerId,input.contactId,source.message_id]);
  else if(input.mutation==='delete')tx.run("UPDATE capture_record SET availability='deleting' WHERE owner_id=? AND contact_id=? AND id=?",[input.ownerId,input.contactId,source.record_id]);
  else if(input.mutation==='revoke')tx.run("UPDATE conversation_binding SET state='revoked' WHERE owner_id=? AND contact_id=?",[input.ownerId,input.contactId]);
  else throw new Error('合成失效方式无效');
 },
},{
 name:'fixture.checkFrozenCandidateIdentity',mode:'read',retryBusy:false,
 execute(tx,input,lease){return withReplyValidation(tx,scoped=>{
  actions.get('reply.view').execute(scoped,input,lease);
  const row=tx.get("SELECT identity_json FROM reply_candidate_input x JOIN reply_context c ON c.owner_id=x.owner_id AND c.id=x.context_id WHERE x.owner_id=? AND c.discussion_id=? AND x.kind='document' LIMIT 1",[input.ownerId,input.discussionId]);
  const original=decode(String(row.identity_json)),failures=[];
  const attempt=(scope,item)=>{try{requireFrozenReplyKnowledge(scoped,scope,[item],replyLocalKnowledgeReader);failures.push(null);}catch(error){failures.push(error.code);}};
  for(const item of [{...original,text:'伪造的合成资料'},{...original,publicationId:'missing-publication'},{...original,sources:[]},{...original,versionNo:original.versionNo+1n},{...original,projection:{...original.projection,blockCount:99}}])attempt(input,item);
  attempt({...input,contactId:input.otherContactId},original);attempt({...input,ownerId:input.otherOwnerId},original);
  // 失败不能登记成功；同一坏快照再次验证仍须拒绝。
  attempt(input,{...original,text:'伪造的合成资料'});
  requireFrozenReplyKnowledge(scoped,input,[original],replyLocalKnowledgeReader);
  return failures;
 });},
}]};
