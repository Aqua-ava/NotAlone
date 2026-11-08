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
 // 状态注入：把提取核验步骤置为 unknown，用来验证放弃动作只处理裁决类未知。
 name:'fixture.markExtractionStepUnknown',mode:'write',retryBusy:false,execute(tx,{ownerId,runId}){
  return tx.run("UPDATE processing_step SET state='unknown' WHERE owner_id=? AND kind='extraction_verification' AND id=(SELECT s.id FROM processing_step s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id WHERE s.owner_id=? AND t.run_id=? AND s.kind='extraction_verification' ORDER BY s.step_no LIMIT 1)",[ownerId,ownerId,runId]);
 },
}]};
