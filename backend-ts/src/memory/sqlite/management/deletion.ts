import {sha256StableJson,sortedEntries} from '../../../platform/stable-json.ts';
import type {StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import type {DeletionDomain,DeletionOperation,RowDeletionTarget,CheckResult} from '../../../storage/sqlite/deletion/contracts.ts';
import {identityDeletionAuthority} from '../../../contacts/sqlite/deletion.ts';
import {isMediaDeletionScope,mediaDeletionAuthority} from '../../../media/sqlite/deletion.ts';
import {fail} from './qualification.ts';
import {memoryDeletionImpact} from '../deletion-impact.ts';
import {scheduleMemoryChange} from '../documents/later-schedule.ts';
import {deletionTargetKey} from '../../../storage/sqlite/deletion/actions.ts';
const domain='memory_management';
const rowKinds:DeletionDomain['rowKinds']={memory_candidate:{keys:['owner_id','id'],ownerKey:'owner_id'},memory_version:{keys:['owner_id','memory_id','version_no'],ownerKey:'owner_id'},memory:{keys:['owner_id','id'],ownerKey:'owner_id'},memory_decision:{keys:['owner_id','id'],ownerKey:'owner_id'}};
const allowed=(op:DeletionOperation)=>isMediaDeletionScope(op.scope)||['source','contact_history','contact','account'].includes(op.scope.kind);
const verifyFence=(tx:StorageTransaction,op:DeletionOperation)=>isMediaDeletionScope(op.scope)?mediaDeletionAuthority.verify(tx,op):identityDeletionAuthority.verify(tx,op);
/** 身份=[domain,kind,键值对数组]；键集合为本域 rowKinds 固定 ASCII 列名，键码点序与既有 localeCompare 序在全部真实键集合上逐字节一致。 */
export const identity=(kind:string,key:Record<string,string>)=>sha256StableJson([domain,kind,sortedEntries(key)]);
function target(rowKind:string,key:Record<string,string>):RowDeletionTarget{return {kind:'row',domain,rowKind,key,identity:identity(rowKind,key),holderKeys:[]};}
function collect(tx:StorageTransaction,op:DeletionOperation):RowDeletionTarget[]{
 if(!allowed(op))return [];
 const impact=memoryDeletionImpact(tx,op),ownerId=op.ownerId,result:RowDeletionTarget[]=[],memories=new Set(impact.memories);
 for(const id of impact.candidates)if(tx.get("SELECT 1 FROM memory_candidate WHERE owner_id=? AND id=? AND state<>'deleted'",[ownerId,id]))result.push(target('memory_candidate',{owner_id:ownerId,id}));
 for(const {memoryId,versionNo} of impact.versions)if(!memories.has(memoryId)&&tx.get("SELECT 1 FROM memory_version WHERE owner_id=? AND memory_id=? AND version_no=? AND content_state='present'",[ownerId,memoryId,versionNo]))result.push(target('memory_version',{owner_id:ownerId,memory_id:memoryId,version_no:String(versionNo)}));
 for(const id of impact.memories)if(tx.get('SELECT 1 FROM memory WHERE owner_id=? AND id=?',[ownerId,id]))result.push(target('memory',{owner_id:ownerId,id}));
 for(const id of impact.decisions)if(tx.get("SELECT 1 FROM memory_decision WHERE owner_id=? AND id=? AND (outcome<>'redacted' OR execution_id IS NOT NULL OR request_seal IS NOT NULL)",[ownerId,id]))result.push(target('memory_decision',{owner_id:ownerId,id}));
 return result;
}
function redactDecision(tx:StorageTransaction,ownerId:string,decisionId:string):void{tx.run("UPDATE memory_decision SET execution_id=NULL,request_seal=NULL,outcome='redacted' WHERE owner_id=? AND id=?",[ownerId,decisionId]);}
/** 管理域先于执行域擦除；只释放同操作已撤销并计划的typed消费者，后续清理仍幂等。 */
function releaseTypedConsumers(tx:StorageTransaction,op:DeletionOperation,parent:{candidateId?:string;memoryId?:string;versionNo?:bigint}):void{
 if(!tx.get("SELECT 1 FROM pragma_table_info('step_input') WHERE name='kind'"))return;
 const predicate=parent.candidateId?'candidate_id=?':parent.versionNo===undefined?'memory_id=?':'memory_id=? AND memory_version_no=?';
 const values=parent.candidateId?[op.ownerId,parent.candidateId]:parent.versionNo===undefined?[op.ownerId,parent.memoryId!]:[op.ownerId,parent.memoryId!,parent.versionNo];
 const steps=tx.all(`SELECT DISTINCT step_id FROM step_input WHERE owner_id=? AND ${predicate}`,values);
 const plannedSteps=new Set(tx.all("SELECT target_payload FROM deletion_target WHERE operation_id=? AND domain='memory_extraction' AND row_kind='processing_step' AND target_payload IS NOT NULL",[op.operationId]).map(r=>(JSON.parse(String(r.target_payload)) as RowDeletionTarget).key.id));
 for(const {step_id:stepId} of steps){
  const step=tx.get('SELECT kind,state FROM processing_step WHERE owner_id=? AND id=?',[op.ownerId,stepId]);
  if(step&&['document_scene','document_profile'].includes(String(step.kind))&&step.state==='succeeded'){
   const unused=tx.all(`SELECT input_no FROM step_input i WHERE i.owner_id=? AND i.step_id=? AND ${predicate}
    AND NOT EXISTS(SELECT 1 FROM execution_input x WHERE x.owner_id=i.owner_id AND x.planned_step_id=i.step_id AND x.planned_input_no=i.input_no)`,[op.ownerId,stepId,...values.slice(1)]);
   for(const row of unused)tx.run('DELETE FROM step_input WHERE owner_id=? AND step_id=? AND input_no=?',[op.ownerId,stepId,row.input_no]);
   if(!tx.get(`SELECT 1 FROM step_input WHERE owner_id=? AND step_id=? AND ${predicate} LIMIT 1`,[op.ownerId,stepId,...values.slice(1)]))continue;
  }
  if(!plannedSteps.has(String(stepId))||!tx.get("SELECT 1 FROM processing_step WHERE owner_id=? AND id=? AND state='revoked'",[op.ownerId,stepId]))fail('memory_typed_consumer_not_fenced');
  const events=`SELECT e.id FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id WHERE a.owner_id=? AND a.step_id=?`;
  tx.run(`DELETE FROM execution_input WHERE owner_id=? AND (planned_step_id=? OR event_id IN (${events}) OR producer_event_id IN (${events}))`,[op.ownerId,stepId,op.ownerId,stepId,op.ownerId,stepId]);
  tx.run(`DELETE FROM event_source WHERE owner_id=? AND event_id IN (${events})`,[op.ownerId,op.ownerId,stepId]);
  tx.run(`DELETE FROM execution_event WHERE owner_id=? AND id IN (${events}) AND NOT EXISTS(SELECT 1 FROM memory_candidate c WHERE c.owner_id=execution_event.owner_id AND c.event_id=execution_event.id)`,[op.ownerId,op.ownerId,stepId]);
  // 原候选仍引用的事件待该管理目标脱敏后由执行域删除，先去除敏感payload。
  tx.run(`UPDATE execution_event SET payload='{}' WHERE owner_id=? AND id IN (${events})`,[op.ownerId,op.ownerId,stepId]);
  tx.run('DELETE FROM step_input WHERE owner_id=? AND step_id=?',[op.ownerId,stepId]);
 }
}
function eraseVersion(tx:StorageTransaction,op:DeletionOperation,memoryId:string,versionNo:bigint):void{
 const ownerId=op.ownerId;releaseTypedConsumers(tx,op,{memoryId,versionNo});
 const v=tx.get('SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,memoryId,versionNo]);if(!v)return;
 const head=tx.get('SELECT scope_kind,contact_id,current_version_no,state FROM memory WHERE owner_id=? AND id=?',[ownerId,memoryId]);
 tx.run('DELETE FROM memory_citation WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,memoryId,versionNo]);tx.run('DELETE FROM memory_required_message WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,memoryId,versionNo]);
 if(v.content_state==='present')tx.run("UPDATE memory_version SET body=NULL,content_state='redacted',provenance_state='invalidated' WHERE owner_id=? AND memory_id=? AND version_no=?",[ownerId,memoryId,versionNo]);
 redactDecision(tx,ownerId,String(v.decision_id));
 tx.run("UPDATE memory SET state='invalidated',head_revision=head_revision+1 WHERE owner_id=? AND id=? AND current_version_no=? AND state<>'invalidated'",[ownerId,memoryId,versionNo]);
 // 来源／历史删除后的正式资料确实失效，留下重整要求；删除联系人或账号时不创建新工作。
 if(head?.state==='active'&&head.current_version_no===versionNo&&(isMediaDeletionScope(op.scope)||['source','contact_history'].includes(op.scope.kind))){
  const scope={scopeKind:head.scope_kind as 'self'|'contact',contactId:head.contact_id as string|null};
  if(scope.scopeKind==='self')tx.run('UPDATE owner SET memory_revision=memory_revision+1 WHERE owner_id=?',[ownerId]);
  else tx.run('UPDATE contact SET memory_revision=memory_revision+1 WHERE owner_id=? AND id=?',[ownerId,scope.contactId]);
  scheduleMemoryChange(tx,ownerId,scope);
 }
}
export const memoryManagementDeletionDomain:DeletionDomain={id:domain,rowKinds,
 fence(tx,op){
  const targets=collect(tx,op),keys=new Set<string>();
  for(const t of targets){
   if(t.rowKind==='memory_decision'){const d=tx.get('SELECT request_key FROM memory_decision WHERE owner_id=? AND id=?',[op.ownerId,t.key.id]);if(d)keys.add(String(d.request_key));}
   else if(t.rowKind==='memory_candidate')for(const d of tx.all('SELECT d.request_key FROM memory_decision d JOIN decision_candidate c ON c.owner_id=d.owner_id AND c.decision_id=d.id WHERE c.owner_id=? AND c.candidate_id=?',[op.ownerId,t.key.id]))keys.add(String(d.request_key));
   else for(const d of tx.all('SELECT request_key FROM memory_decision WHERE owner_id=? AND target_memory_id=?',[op.ownerId,t.key.memory_id??t.key.id]))keys.add(String(d.request_key));
  }
  return [...keys].map(key=>({namespace:'memory.applyDecision',key}));
 },collect,
 clearRow(tx,op,t){
  if(!allowed(op)||t.domain!==domain||!Object.hasOwn(rowKinds,t.rowKind)||t.key.owner_id!==op.ownerId||Object.keys(t.key).sort().join()!==[...rowKinds[t.rowKind].keys].sort().join()||t.identity!==identity(t.rowKind,t.key))fail('memory_deletion_target_invalid');
  if(verifyFence(tx,op).result!=='passed'||!tx.get('SELECT 1 FROM deletion_target WHERE operation_id=? AND domain=? AND target_key=?',[op.operationId,domain,deletionTargetKey(t)]))fail('memory_deletion_not_fenced');
  const ownerId=op.ownerId;
  if(t.rowKind==='memory_decision')redactDecision(tx,ownerId,t.key.id);
  else if(t.rowKind==='memory_candidate'){
   releaseTypedConsumers(tx,op,{candidateId:t.key.id});
   for(const d of tx.all('SELECT decision_id FROM decision_candidate WHERE owner_id=? AND candidate_id=?',[ownerId,t.key.id]))redactDecision(tx,ownerId,String(d.decision_id));
   tx.run('DELETE FROM memory_citation WHERE owner_id=? AND candidate_id=?',[ownerId,t.key.id]);tx.run('DELETE FROM memory_required_message WHERE owner_id=? AND candidate_id=?',[ownerId,t.key.id]);
   tx.run("UPDATE memory_candidate SET state='deleted',state_revision=state_revision+1,proposed_body=NULL,event_id=NULL,produced_attempt_id=NULL WHERE owner_id=? AND id=? AND state<>'deleted'",[ownerId,t.key.id]);
   if(op.scope.kind==='account'||op.scope.kind==='contact'&&tx.get('SELECT 1 FROM memory_candidate WHERE owner_id=? AND id=? AND contact_id=?',[ownerId,t.key.id,op.scope.contactId])){
    tx.run('DELETE FROM decision_candidate WHERE owner_id=? AND candidate_id=?',[ownerId,t.key.id]);tx.run('DELETE FROM memory_candidate WHERE owner_id=? AND id=?',[ownerId,t.key.id]);
   }
  }else if(t.rowKind==='memory_version')eraseVersion(tx,op,t.key.memory_id,BigInt(t.key.version_no));
  else{
   const memoryId=t.key.id;
   for(const v of tx.all('SELECT version_no FROM memory_version WHERE owner_id=? AND memory_id=?',[ownerId,memoryId]))eraseVersion(tx,op,memoryId,v.version_no as bigint);
   tx.run('DELETE FROM decision_candidate WHERE owner_id=? AND decision_id IN (SELECT id FROM memory_decision WHERE owner_id=? AND target_memory_id=?)',[ownerId,ownerId,memoryId]);
   tx.run('DELETE FROM memory_version WHERE owner_id=? AND memory_id=?',[ownerId,memoryId]);tx.run('DELETE FROM memory_decision WHERE owner_id=? AND target_memory_id=?',[ownerId,memoryId]);tx.run('DELETE FROM memory WHERE owner_id=? AND id=?',[ownerId,memoryId]);
  }
 },authorizeFile(){fail('memory_management_has_no_files');},fileCleared(){fail('memory_management_has_no_files');},
 verify(tx,op){const check:CheckResult=!allowed(op)?{result:'not_applicable',proof:'memory_scope_not_owned'}:{result:collect(tx,op).length===0?'passed':'blocked',proof:'memory_content_and_dependencies_cleared'};return {database_rows:check,derived_eligibility:check,trace_payloads:check,request_replay:check,scope_suppression:check};},
};
