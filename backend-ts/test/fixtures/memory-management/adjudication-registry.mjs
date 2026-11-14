import {registry as base} from './registry.mjs';
import {projectCitations} from '../../../src/memory/sqlite/management/evidence.ts';
import {frozenContributingContactIds} from '../../../src/memory/sqlite/management/dependencies.ts';

/** 只读观察正式流水线；候选、决定、版本、执行和账本均由生产动作写入。 */
/** 观察版本闭包递归查询的真实执行计划；SQL 与参数由生产函数发出，这里只追加 EXPLAIN。 */
const versionClosurePlans={name:'fixture.versionClosurePlans',mode:'read',retryBusy:false,execute(tx,{ownerId,memoryId,versionNo}){
 const plans=[],spy={run:(sql,values)=>tx.run(sql,values),get:(sql,values)=>tx.get(sql,values),all(sql,values){
  if(/^\s*WITH RECURSIVE versions/.test(sql))plans.push(tx.all(`EXPLAIN QUERY PLAN ${sql}`,values).map(r=>String(r.detail)));
  return tx.all(sql,values);
 }};
 const parent={memoryId,versionNo:BigInt(versionNo)};
 projectCitations(spy,ownerId,parent,[]);frozenContributingContactIds(spy,ownerId,parent);
 return plans;
}};
export const registry={...base,actions:[...base.actions,versionClosurePlans,{
 name:'fixture.oldAdjudicationPolicy',mode:'write',retryBusy:false,execute(tx,{ownerId,runId}){
  tx.run("UPDATE execution_event SET payload=json_remove(payload,'$.policyRevision') WHERE owner_id=? AND kind='adjudication_basis' AND step_attempt_id IN (SELECT a.id FROM step_attempt a JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE t.owner_id=? AND t.run_id=?)",[ownerId,ownerId,runId]);return true;
 }
},{
 name:'fixture.adjudicationLeaseState',mode:'read',retryBusy:false,execute(tx,{ownerId,attemptIds}){
  return tx.all(`SELECT id,lease_expires_at FROM step_attempt WHERE owner_id=? AND id IN (${attemptIds.map(()=>'?').join(',')}) ORDER BY id`,[ownerId,...attemptIds]);
 }
},{
 name:'fixture.alterAdjudicationLease',mode:'write',retryBusy:false,execute(tx,{ownerId,attemptId,fault}){
  const context=tx.get('SELECT a.step_id,s.task_id,t.run_id FROM step_attempt a JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE a.owner_id=? AND a.id=?',[ownerId,attemptId]);
  if(!context)throw new Error('合成租约不存在');
  if(fault==='expired')tx.run('UPDATE step_attempt SET lease_expires_at=0 WHERE owner_id=? AND id=?',[ownerId,attemptId]);
  else if(fault==='runtime')tx.run("UPDATE step_attempt SET runtime_token='synthetic-other-runtime' WHERE owner_id=? AND id=?",[ownerId,attemptId]);
  else if(fault==='generation')tx.run('UPDATE processing_task SET resume_no=resume_no+1 WHERE owner_id=? AND id=?',[ownerId,context.task_id]);
  else if(fault==='control')tx.run('UPDATE processing_task SET control_revision=control_revision+1 WHERE owner_id=? AND id=?',[ownerId,context.task_id]);
  else if(fault==='paused')tx.run("UPDATE processing_run SET pause_requested_at=?,state='paused' WHERE owner_id=? AND id=?",[Date.now(),ownerId,context.run_id]);
  else if(fault==='unknown')tx.run("UPDATE model_call SET state='unknown',settlement_state='unknown' WHERE owner_id=? AND step_attempt_id=?",[ownerId,attemptId]);
  else if(fault==='sealed')tx.run("UPDATE model_operation SET state='sealed',commit_forbidden_at=? WHERE owner_id=? AND memory_step_id=?",[Date.now(),ownerId,context.step_id]);
  else if(fault==='source')tx.run("INSERT OR IGNORE INTO history_message_quarantine(owner_id,contact_id,message_id,reason) SELECT DISTINCT owner_id,source_contact_id,message_id,'synthetic_lease_source' FROM step_input WHERE owner_id=? AND step_id=? AND kind='message'",[ownerId,context.step_id]);
  else if(fault==='future')tx.run('UPDATE step_attempt SET lease_expires_at=? WHERE owner_id=? AND id=?',[Date.now()+600000,ownerId,attemptId]);
  else throw new Error('合成租约故障无效');return true;
 }
},{
 name:'fixture.ageAdjudicationLeases',mode:'write',retryBusy:false,execute(tx,{ownerId,milliseconds}){
  if(!Number.isSafeInteger(milliseconds)||milliseconds<0||milliseconds>600000)throw new Error('合成租约时间无效');
  tx.run("UPDATE step_attempt SET lease_expires_at=lease_expires_at-? WHERE owner_id=? AND state='running' AND step_id IN (SELECT id FROM processing_step WHERE owner_id=? AND kind IN ('adjudication','relation_verification','merge_verification'))",[milliseconds,ownerId,ownerId]);return true;
 }
},{
 name:'fixture.adjudicationTrace',mode:'read',retryBusy:false,execute(tx,{ownerId}){
  return {
   steps:tx.all("SELECT s.*,a.id AS attempt_id,a.state AS attempt_state,a.error_code FROM processing_step s LEFT JOIN step_attempt a ON a.owner_id=s.owner_id AND a.step_id=s.id WHERE s.owner_id=? AND s.kind<>'extraction_verification' ORDER BY s.task_id,s.step_no",[ownerId]),
   calls:tx.all("SELECT c.*,o.purpose,o.state AS operation_state,o.commit_forbidden_at FROM model_call c JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id WHERE c.owner_id=? AND o.purpose IN ('adjudication','relation_verification','merge_verification') ORDER BY c.rowid",[ownerId]).map(c=>({...c,receipt:c.receipt===null?null:JSON.parse(c.receipt)})),
   events:tx.all("SELECT e.*,s.kind AS step_kind FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id WHERE e.owner_id=? AND s.kind<>'extraction_verification' ORDER BY e.rowid",[ownerId]).map(e=>({...e,payload:JSON.parse(e.payload)})),
   inputs:tx.all("SELECT i.* FROM step_input i JOIN processing_step s ON s.owner_id=i.owner_id AND s.id=i.step_id WHERE i.owner_id=? AND s.kind<>'extraction_verification' ORDER BY i.step_id,i.input_no",[ownerId]),
   eventInputs:tx.all("SELECT e.kind AS event_kind,i.event_id,i.input_no,i.planned_step_id,i.planned_input_no,s.kind,s.candidate_id,s.memory_id,s.source_contact_id,s.message_id,s.record_id FROM execution_input i JOIN execution_event e ON e.owner_id=i.owner_id AND e.id=i.event_id JOIN step_input s ON s.owner_id=i.owner_id AND s.step_id=i.planned_step_id AND s.input_no=i.planned_input_no WHERE i.owner_id=? AND e.kind IN ('adjudication_basis','adjudication_input','adjudication_output') ORDER BY i.event_id,i.input_no",[ownerId]),
   decisions:tx.all('SELECT * FROM memory_decision WHERE owner_id=? ORDER BY rowid',[ownerId]),
   memories:tx.all('SELECT * FROM memory WHERE owner_id=? ORDER BY id',[ownerId]),
   items:tx.all('SELECT effect_kind,state,count(*) AS n FROM operation_item WHERE owner_id=? GROUP BY effect_kind,state ORDER BY effect_kind,state',[ownerId]),
  };
 },
 },{ name:'fixture.extractionTrace',mode:'read',retryBusy:false,execute(tx,{ownerId}){
  // 提取核验事件单独回传：验证 time_unverified 等候选层证据时不需要放宽主追踪过滤。
  return tx.all("SELECT e.kind,e.payload FROM execution_event e JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id WHERE e.owner_id=? AND s.kind='extraction_verification' ORDER BY e.rowid",[ownerId]).map(e=>({...e,payload:JSON.parse(e.payload)}));
 }},{
 // 状态注入：把某条记忆的全部来源消息隔离，使其引用不再是当前有效来源（如旧绑定副本退出后的真实状态）。
 name:'fixture.quarantineMemorySources',mode:'write',retryBusy:false,execute(tx,{ownerId,memoryId}){
  return tx.run("INSERT OR IGNORE INTO history_message_quarantine(owner_id,contact_id,message_id,reason) SELECT DISTINCT owner_id,source_contact_id,message_id,'fixture_stale_source' FROM memory_citation WHERE owner_id=? AND memory_id=?",[ownerId,memoryId]);
 },
},{
 // 状态注入：解除上面的来源隔离，模拟来源恢复为当前有效。
 name:'fixture.releaseMemorySources',mode:'write',retryBusy:false,execute(tx,{ownerId,memoryId}){
  return tx.run("DELETE FROM history_message_quarantine WHERE owner_id=? AND reason='fixture_stale_source' AND message_id IN (SELECT message_id FROM memory_citation WHERE owner_id=? AND memory_id=?)",[ownerId,ownerId,memoryId]);
 },
},{
 // 状态注入：把提取核验步骤置为 unknown，用来验证放弃动作只处理裁决类未知。
 name:'fixture.markExtractionStepUnknown',mode:'write',retryBusy:false,execute(tx,{ownerId,runId}){
  return tx.run("UPDATE processing_step SET state='unknown' WHERE owner_id=? AND kind='extraction_verification' AND id=(SELECT s.id FROM processing_step s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE s.owner_id=? AND t.run_id=? AND s.kind='extraction_verification' ORDER BY s.step_no LIMIT 1)",[ownerId,ownerId,runId]);
 },
}]};
