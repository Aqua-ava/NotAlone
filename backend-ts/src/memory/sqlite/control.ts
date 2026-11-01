import type {StorageRow,StorageTransaction} from '../../storage/sqlite/contracts.ts';
import {assertTaskContributions,fail,textId} from './qualification.ts';
import {setRunSchedulePaused,resumeRunSchedule} from './documents/later-schedule.ts';

/** 轮次控制投影：只读派生，不新增业务状态，也不把数量换算成百分比。 */
export type ControlStatus='waiting'|'processing'|'paused'|'blocked'|'completed';
export type ControlAction='pause'|'continue';
export type LaterStagesState='pending'|'scheduled'|'running'|'unknown'|'completed'|'failed'|'revoked';

/** 通用模型配置故障；单人资料失败不在其中，不能据此暂停整轮。 */
export const sharedFailureCodes=new Set([
 'extraction_model_unconfigured',
 'extraction_model_configuration_invalid',
 'extraction_model_credentials_unavailable',
 'extraction_model_authentication_failed',
 'extraction_model_provider_unavailable',
 'extraction_model_scope_invalid',
 'memory_extraction_model_configuration_invalid',
 'document_model_unconfigured',
 'document_model_configuration_invalid',
 'document_model_credentials_unavailable',
 'document_model_scope_invalid',
]);
export const isSharedFailure=(code:unknown):boolean=>typeof code==='string'&&sharedFailureCodes.has(code);

export interface ControlCallSummary {prepared:number;sending:number;succeeded:number;failed:number;unknown:number}
export interface ControlProjection {
 status:ControlStatus;statusReason:string|null;actions:ControlAction[];controlVersion:number;
 pending:number;revoked:number;sharedFaultCode:string|null;calls:ControlCallSummary;
}
export interface ControlInput {ownerId:string;runId:string;action:ControlAction;actionVersion?:number;operationId?:string}

const count=(value:unknown):number=>{
 if(typeof value!=='bigint'||value<0n||value>BigInt(Number.MAX_SAFE_INTEGER))return fail('memory_extraction_count_invalid');
 return Number(value);
};
/** 与快照一致的动态撤销：只看当前授权/资料代次，不信任历史任务状态字段。 */
export function currentTaskStates(tx:StorageTransaction,ownerId:string,runId:string):Map<string,string>{
 const states=new Map<string,string>();
 for(const task of tx.all('SELECT * FROM processing_task WHERE owner_id=? AND run_id=?',[ownerId,runId])){
  let state=String(task.state);
  try{assertTaskContributions(tx,ownerId,runId,String(task.id));}catch{state='revoked';}
  states.set(String(task.id),state);
 }
 return states;
}
/** 中断只保留“已发出/结果未知”的未知；同一步骤全部回执已知时可按失败重试并复用既有回执。 */
function resolvableStep(tx:StorageTransaction,ownerId:string,stepId:string):boolean{
 const calls=tx.all('SELECT c.state FROM model_call c WHERE c.owner_id=? AND c.step_attempt_id IN (SELECT id FROM step_attempt WHERE owner_id=? AND step_id=?)',[ownerId,ownerId,stepId]);
 return calls.length>0&&calls.every(call=>call.state==='succeeded'||call.state==='failed');
}
function unknownSteps(tx:StorageTransaction,ownerId:string,runId:string,contactId?:string):StorageRow[]{
 return tx.all(`SELECT s.* FROM processing_step s JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
  WHERE t.owner_id=? AND t.run_id=? AND s.state='unknown' AND t.state<>'revoked'${contactId===undefined?'':" AND t.scope_kind='contact' AND t.contact_id=?"}`,contactId===undefined?[ownerId,runId]:[ownerId,runId,contactId]);
}
/** 用户手动继续时，只有全部相关回执已知的中断才允许恢复为可重试；真实未知保持原状。 */
export function reconcileKnownInterruptions(tx:StorageTransaction,ownerId:string,runId:string):number{
 let reconciled=0;
 for(const step of unknownSteps(tx,ownerId,runId)){
  if(!resolvableStep(tx,ownerId,String(step.id)))continue;
  tx.run("UPDATE processing_step SET state='failed' WHERE owner_id=? AND id=? AND state='unknown'",[ownerId,step.id]);
  tx.run("UPDATE processing_task SET state='failed' WHERE owner_id=? AND id=? AND state='unknown'",[ownerId,step.task_id]);
  reconciled++;
 }
 return reconciled;
}
function targetClasses(tx:StorageTransaction,ownerId:string,runId:string,taskStates:Map<string,string>,contactId?:string):{states:string[];pending:number;revoked:number}{
 const tasks=tx.all('SELECT id,scope_kind,contact_id FROM processing_task WHERE owner_id=? AND run_id=?',[ownerId,runId]);
 const contactTask=new Map<string,{id:string;revoked:boolean}>();
 for(const task of tasks)if(task.scope_kind==='contact')contactTask.set(String(task.contact_id),{id:String(task.id),revoked:taskStates.get(String(task.id))==='revoked'});
 const resolvedUnknownSteps=new Set(unknownSteps(tx,ownerId,runId,contactId).filter(step=>resolvableStep(tx,ownerId,String(step.id))).map(step=>String(step.id)));
 const rows=tx.all(`SELECT i.input_no,i.source_contact_id,i.item_id,s.id AS step_id,s.state AS step_state,s.step_no,s.task_id
  FROM run_input i JOIN step_input si ON si.owner_id=i.owner_id AND si.run_id=i.run_id AND si.run_input_no=i.input_no
  JOIN processing_step s ON s.owner_id=si.owner_id AND s.id=si.step_id
  JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
  WHERE i.owner_id=? AND i.run_id=? AND i.role='target'${contactId===undefined?'':" AND t.scope_kind='contact' AND t.contact_id=?"}`,contactId===undefined?[ownerId,runId]:[ownerId,runId,contactId]);
 const latest=new Map<string,StorageRow>();
 for(const row of rows){const key=String(row.input_no),prior=latest.get(key);if(!prior||(row.step_no as bigint)>(prior.step_no as bigint))latest.set(key,row);}
 const states:string[]=[];let pending=0,revoked=0;
 for(const input of tx.all(`SELECT input_no,source_contact_id,item_id FROM run_input WHERE owner_id=? AND run_id=? AND role='target'${contactId===undefined?'':' AND source_contact_id=?'}`,contactId===undefined?[ownerId,runId]:[ownerId,runId,contactId])){
  const task=contactTask.get(String(input.source_contact_id));
  if(!task||task.revoked){revoked++;states.push('revoked');continue;}
  const row=latest.get(String(input.input_no));
  let state=row?String(row.step_state):'pending';
  if(state==='unknown'&&resolvedUnknownSteps.has(String(row!.step_id)))state='failed';
  if(state==='succeeded')states.push('succeeded');
  else if(state==='unknown')states.push('unknown');
  else if(state==='failed')states.push('failed');
  else{pending++;states.push('pending');}
 }
 return {states,pending,revoked};
}
function calls(tx:StorageTransaction,ownerId:string,runId:string,contactId?:string):ControlCallSummary{
 const summary:ControlCallSummary={prepared:0,sending:0,succeeded:0,failed:0,unknown:0};
 for(const row of tx.all(`SELECT c.state,count(*) AS n FROM model_call c
  JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id
  JOIN processing_step s ON s.owner_id=o.owner_id AND s.id=o.memory_step_id
  JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id
  WHERE t.owner_id=? AND t.run_id=?${contactId===undefined?'':" AND t.scope_kind='contact' AND t.contact_id=?"} GROUP BY c.state`,contactId===undefined?[ownerId,runId]:[ownerId,runId,contactId])){
  const state=String(row.state);if(state in summary)summary[state as keyof ControlCallSummary]=count(row.n);
 }
 return summary;
}
function tasks(tx:StorageTransaction,ownerId:string,runId:string):StorageRow[]{return tx.all('SELECT * FROM processing_task WHERE owner_id=? AND run_id=? ORDER BY scope_kind,contact_id',[ownerId,runId]);}
function resumable(tx:StorageTransaction,ownerId:string,runId:string,rows:StorageRow[],taskStates:Map<string,string>):boolean{
 const pendingByContact=new Map<string,number>();
 for(const row of tx.all(`SELECT i.source_contact_id,i.input_no FROM run_input i WHERE i.owner_id=? AND i.run_id=? AND i.role='target'
  AND NOT EXISTS(SELECT 1 FROM step_input si JOIN processing_step s ON s.owner_id=si.owner_id AND s.id=si.step_id
   WHERE si.owner_id=i.owner_id AND si.run_id=i.run_id AND si.run_input_no=i.input_no AND s.state IN ('succeeded','unknown'))`,[ownerId,runId]))pendingByContact.set(String(row.source_contact_id),(pendingByContact.get(String(row.source_contact_id))??0)+1);
 for(const task of rows){
  const state=taskStates.get(String(task.id)),code=task.error_code===null?null:String(task.error_code);
  if(state==='revoked')continue;
  if(state==='failed'||state==='paused')return true;
  if(state==='pending'&&(task.scope_kind==='self'||(pendingByContact.get(String(task.contact_id))??0)>0))return true;
  if(state==='running')return true;
  if(state==='incomplete'&&code!=='targets_completed_elsewhere')return true;
 }
 return false;
}
/** 只读投影；后续阶段由09的 laterStagesState 提供，未合并时视为尚未完成。 */
export function projectControl(tx:StorageTransaction,ownerId:string,run:StorageRow,options:{laterStages?:LaterStagesState;taskStates?:Map<string,string>;contactId?:string}={}):ControlProjection{
 const runId=String(run.id),state=String(run.state),pauseRequested=run.pause_requested_at!==null;
 const taskStates=options.taskStates??currentTaskStates(tx,ownerId,runId);
 const taskRows=tasks(tx,ownerId,runId).filter(task=>options.contactId===undefined||task.scope_kind==='contact'&&task.contact_id===options.contactId),callsSummary=calls(tx,ownerId,runId,options.contactId),classes=targetClasses(tx,ownerId,runId,taskStates,options.contactId);
 const laterStages:LaterStagesState=options.laterStages??(state==='completed'?'completed':'pending');
 const activeTasks=taskRows.filter(task=>taskStates.get(String(task.id))!=='revoked');
 const failedTasks=activeTasks.filter(task=>taskStates.get(String(task.id))==='failed');
 const sharedFault=activeTasks.map(task=>task.error_code===null?null:String(task.error_code)).find(code=>isSharedFailure(code))??null;
 const callUnknown=callsSummary.unknown>0;
 const classUnknown=classes.states.includes('unknown');
 const taskUnknown=[...taskStates.values()].includes('unknown');
 const anyUnknown=callUnknown||classUnknown;
 const interruptedKnown=!anyUnknown&&(taskUnknown||unknownSteps(tx,ownerId,runId,options.contactId).length>0);
 const canResume=resumable(tx,ownerId,runId,taskRows,taskStates);
 const retryable=failedTasks.length>0||classes.pending>0;
 const controlVersion=count(run.intent_revision);
 const base={controlVersion,pending:classes.pending,revoked:classes.revoked,sharedFaultCode:sharedFault,calls:callsSummary};
 if(state==='revoked')return {...base,status:'blocked',statusReason:'run_revoked',actions:[]};
 if(laterStages==='unknown')return {...base,status:'blocked',statusReason:'model_receipt_unknown',actions:[]};
 if(laterStages==='completed'&&(pauseRequested||state==='paused'))return {...base,status:'paused',statusReason:null,actions:['continue']};
 if(state==='completed'||laterStages==='completed')return {...base,status:'completed',statusReason:null,actions:[]};
 if(anyUnknown)return {...base,status:'blocked',statusReason:'model_receipt_unknown',actions:retryable?['continue']:[]};
 if(interruptedKnown)return {...base,status:'blocked',statusReason:'interrupted_known_receipts',actions:['continue']};
 if(sharedFault)return {...base,status:'blocked',statusReason:sharedFault,actions:retryable?['continue']:[]};
 if(!taskRows.length)return {...base,status:'blocked',statusReason:'no_pending_inputs',actions:[]};
 if(!activeTasks.length)return {...base,status:'blocked',statusReason:'scope_revoked',actions:[]};
 if(pauseRequested||state==='paused')return {...base,status:'paused',statusReason:null,actions:['continue']};
 if(failedTasks.length)return {...base,status:'blocked',statusReason:activeTasks.length&&failedTasks.length===activeTasks.length?'round_failed':'contact_failed',actions:retryable?['continue']:[]};
 if(state==='failed')return {...base,status:'blocked',statusReason:'round_failed',actions:retryable?['continue']:[]};
 if(state==='incomplete'){
  const extractionDone=classes.pending===0&&classes.states.every(value=>value==='succeeded'||value==='revoked')
   &&activeTasks.filter(task=>task.scope_kind==='contact').every(task=>['succeeded','incomplete'].includes(taskStates.get(String(task.id))??''))
   &&activeTasks.filter(task=>task.scope_kind==='self').every(task=>['succeeded','awaiting_decision'].includes(taskStates.get(String(task.id))??'succeeded'));
  const selfTask=activeTasks.find(task=>task.scope_kind==='self');
  const revokedContact=taskRows.some(task=>task.scope_kind==='contact'&&taskStates.get(String(task.id))==='revoked');
  const ownerUnfinished=(!selfTask&&revokedContact)||(!!selfTask&&!['succeeded','awaiting_decision'].includes(taskStates.get(String(selfTask.id))??'succeeded'));
  if(extractionDone&&laterStages==='scheduled')return {...base,status:'waiting',statusReason:'later_stages_scheduled',actions:[]};
  if(extractionDone&&laterStages==='running')return {...base,status:'processing',statusReason:null,actions:['pause']};
  if(extractionDone&&laterStages==='pending')return {...base,status:'blocked',statusReason:ownerUnfinished?'owner_contribution_pending':'later_stages_pending',actions:[]};
  if(extractionDone&&laterStages==='failed')return {...base,status:'blocked',statusReason:'later_stages_failed',actions:['continue']};
  return {...base,status:'blocked',statusReason:'round_incomplete',actions:retryable?['continue']:[]};
 }
 if(state==='pending'||state==='running')return {...base,status:'processing',statusReason:null,actions:['pause']};
 return {...base,status:'waiting',statusReason:null,actions:[]};
}
/** 正常暂停只阻止新小批，不撤销执行中的合法小批；取消/删除由资料代次另行撤销提交资格。 */
export function applyControl(tx:StorageTransaction,input:unknown):{ownerId:string;runId:string;replayed:boolean}{
 const i=input as Partial<ControlInput>,ownerId=textId(i?.ownerId),runId=textId(i?.runId);
 if(i?.action!=='pause'&&i?.action!=='continue')fail('memory_extraction_input_invalid');
 const found=tx.get('SELECT * FROM processing_run WHERE owner_id=? AND id=?',[ownerId,runId]);if(!found)fail('memory_extraction_not_found');
 const run=found!;
 const internal=i.actionVersion===undefined;
 if(!internal&&(!Number.isSafeInteger(i.actionVersion)||(i.actionVersion as number)<0))fail('memory_extraction_input_invalid');
 if(!internal&&i.operationId!==undefined&&typeof i.operationId!=='string')fail('memory_extraction_input_invalid');
 if(!internal&&BigInt(i.actionVersion as number)!==(run.intent_revision as bigint))fail('memory_extraction_control_conflict');
 const state=String(run.state);
 if(i.action==='continue'&&tx.get('SELECT 1 FROM processing_run WHERE owner_id=? AND start_request_key=?',[ownerId,`policy-recovery:${runId}`]))fail('memory_extraction_control_conflict');
 if(i.action==='pause'){
  if(state==='revoked'||state==='completed')fail('memory_extraction_control_conflict');
  if(state==='paused'||run.pause_requested_at!==null)return {ownerId,runId,replayed:true};
  if(state==='incomplete'&&setRunSchedulePaused(tx,ownerId,runId,true)){
   tx.run("UPDATE processing_run SET pause_requested_at=?,state='paused',intent_revision=intent_revision+1 WHERE owner_id=? AND id=?",[Date.now(),ownerId,runId]);
   return {ownerId,runId,replayed:false};
  }
  // 已结束轮次没有可暂停的小批；按幂等空操作返回，不把暂停请求伪造成执行状态。
  if(!['preparing','pending','running'].includes(state))return {ownerId,runId,replayed:true};
  tx.run("UPDATE processing_run SET pause_requested_at=?,state='paused',intent_revision=intent_revision+1 WHERE owner_id=? AND id=? AND state IN ('preparing','pending','running')",[Date.now(),ownerId,runId]);
  setRunSchedulePaused(tx,ownerId,runId,true);
  return {ownerId,runId,replayed:false};
 }
 if(state==='revoked'||state==='completed'||state==='preparing')fail('memory_extraction_control_conflict');
 // 已知回执的中断可以安全重试（复用既有回执）；真实未知任务保持 unknown，不重发也不清除。
 reconcileKnownInterruptions(tx,ownerId,runId);
 setRunSchedulePaused(tx,ownerId,runId,false);
 resumeRunSchedule(tx,ownerId,runId);
 if(!['paused','failed','incomplete'].includes(state)&&run.pause_requested_at===null)return {ownerId,runId,replayed:true};
 tx.run("UPDATE processing_run SET pause_requested_at=NULL,state='pending',intent_revision=intent_revision+1 WHERE owner_id=? AND id=?",[ownerId,runId]);
 // 只恢复失败/暂停任务并推进控制修订；unknown 任务保持原样，不能靠继续刷新资格。
 tx.run("UPDATE processing_task SET state='pending',control_revision=control_revision+1,resume_no=resume_no+1,error_code=NULL WHERE owner_id=? AND run_id=? AND state IN ('failed','paused')",[ownerId,runId]);
 return {ownerId,runId,replayed:false};
}
/** 租约到期不证明未发送：保守收尾已发出的调用为 unknown，仅确定未发送的准备中调用记为失败。 */
export function interruptAttempt(tx:StorageTransaction,ownerId:string,attempt:StorageRow,code:string):void{
 tx.run("UPDATE model_call SET state='unknown',settlement_state='unknown' WHERE owner_id=? AND step_attempt_id=? AND state='sending'",[ownerId,attempt.id]);
 tx.run("UPDATE model_call SET state='failed',settlement_state='settled',error_code='not_dispatched' WHERE owner_id=? AND step_attempt_id=? AND state='prepared'",[ownerId,attempt.id]);
 const unknown=!!tx.get("SELECT 1 FROM model_call WHERE owner_id=? AND step_attempt_id=? AND state='unknown'",[ownerId,attempt.id]);
 for(const call of tx.all('SELECT operation_id,state FROM model_call WHERE owner_id=? AND step_attempt_id=?',[ownerId,attempt.id])){
  tx.run("UPDATE model_operation SET state=? WHERE owner_id=? AND id=? AND state<>'sealed'",[call.state==='unknown'?'unknown':'failed',ownerId,call.operation_id]);
  for(const table of ['operation_item','operation_scope'])tx.run(`UPDATE ${table} SET state=? WHERE owner_id=? AND operation_id=?`,[call.state==='unknown'?'unknown':'released',ownerId,call.operation_id]);
 }
 tx.run('UPDATE step_attempt SET state=?,finished_at=?,error_code=? WHERE owner_id=? AND id=?',[unknown?'unknown':'aborted',Date.now(),code,ownerId,attempt.id]);
 tx.run('UPDATE processing_step SET state=? WHERE owner_id=? AND id=?',[unknown?'unknown':'failed',ownerId,attempt.step_id]);
 tx.run("UPDATE processing_task SET state=?,error_code=? WHERE owner_id=? AND id=(SELECT task_id FROM processing_step WHERE owner_id=? AND id=?) AND state<>'revoked'",[unknown?'unknown':'paused',code,ownerId,ownerId,attempt.step_id]);
}
/** 领取前接替过期租约：旧执行者迟到回调会因租约/状态失配被拒绝；返回是否可继续领取。 */
export function takeOverExpiredAttempt(tx:StorageTransaction,ownerId:string,taskId:string):boolean{
 const running=tx.get("SELECT a.* FROM step_attempt a JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id WHERE a.owner_id=? AND a.state='running' AND s.task_id=?",[ownerId,taskId]);
 if(!running)return true;
 if(BigInt(Date.now())<=(running.lease_expires_at as bigint))return false;
 interruptAttempt(tx,ownerId,running,'lease_expired');
 return true;
}
